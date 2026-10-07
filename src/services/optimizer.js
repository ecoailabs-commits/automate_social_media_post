import { one, run, parseJSON } from '../db.js';
import { analyseCampaign } from '../ai/optimize.js';
import { getCampaign } from './campaigns.js';
import { summary } from './metrics.js';
import { budgetCaps } from './campaigns.js';
import { notify } from '../notify.js';
import { audit } from '../audit.js';
import { setVariationLive, updateDailyBudget } from './lifecycle.js';

/** Runs AI analysis on real metrics and stores suggestions. Requires some delivery data. */
export async function generateSuggestions(campaignId, req = null) {
  const campaign = getCampaign(campaignId);
  const s = summary(campaignId);
  if (s.totals.impressions === 0) {
    throw Object.assign(new Error('No delivery data yet. Suggestions are generated from real performance once the campaign has impressions.'), { status: 409 });
  }
  const caps = budgetCaps();
  const result = await analyseCampaign({
    campaign,
    totals: s.totals,
    byPlatform: s.byPlatform,
    byVariation: s.byVariation,
    daily: s.daily.slice(-14),
    caps: { maxDaily: caps.maxDaily, remaining: Math.max(0, campaign.total_budget - s.totals.spend) },
  });

  run(`UPDATE suggestions SET status = 'dismissed' WHERE campaign_id = ? AND status = 'open'`, campaignId);
  for (const sg of result.suggestions) {
    const params = { platform: sg.platform, variation_id: sg.variation_id || null, new_daily_budget: sg.new_daily_budget || null };
    run('INSERT INTO suggestions (campaign_id, title, detail, action, params, priority) VALUES (?, ?, ?, ?, ?, ?)',
      campaignId, sg.title, sg.detail, sg.action, JSON.stringify(params), sg.priority);
  }
  run(`UPDATE campaigns SET last_optimized_at = datetime('now') WHERE id = ?`, campaignId);
  audit(req, 'ai.optimize', 'campaign', campaignId, { count: result.suggestions.length });
  if (result.suggestions.some((x) => x.priority === 'high')) {
    await notify('info', `New AI suggestions: ${campaign.name}`, result.summary, campaignId);
  }
  return result;
}

/** Applies a suggestion's action after a human clicks Apply — the AI never changes live campaigns by itself. */
export async function applySuggestion(suggestionId, req) {
  const sg = one('SELECT * FROM suggestions WHERE id = ?', suggestionId);
  if (!sg || sg.status !== 'open') throw Object.assign(new Error('Suggestion not found or already resolved'), { status: 404 });
  const p = parseJSON(sg.params, {});
  try {
    if (sg.action === 'pause_variation') {
      if (!p.variation_id) throw new Error('Suggestion has no variation');
      await setVariationLive(sg.campaign_id, p.variation_id, false, req, `AI suggestion #${sg.id}`);
    } else if (sg.action === 'adjust_daily_budget') {
      const campaign = getCampaign(sg.campaign_id);
      const remainingDays = Math.max(1, Math.ceil((new Date(campaign.end_at) - Date.now()) / 864e5));
      const spent = summary(sg.campaign_id).totals.spend;
      // Never let a budget change push projected spend past the approved total.
      const maxAffordable = Math.max(0, (campaign.total_budget - spent) / remainingDays);
      const target = Math.min(Number(p.new_daily_budget), maxAffordable);
      if (!(target > 0)) throw new Error('No remaining budget to allocate');
      await updateDailyBudget(sg.campaign_id, Math.round(target * 100) / 100, req, `AI suggestion #${sg.id}`);
    }
    run(`UPDATE suggestions SET status = 'applied', resolved_by = ?, resolved_at = datetime('now') WHERE id = ?`, req.user.id, sg.id);
    audit(req, 'suggestion.apply', 'suggestion', sg.id, { action: sg.action, params: p });
  } catch (e) {
    run(`UPDATE suggestions SET status = 'failed', resolved_by = ?, resolved_at = datetime('now') WHERE id = ?`, req.user.id, sg.id);
    audit(req, 'suggestion.apply.failed', 'suggestion', sg.id, { error: e.message });
    throw e;
  }
}
