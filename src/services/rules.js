import { all, run } from '../db.js';
import { audit } from '../audit.js';
import { notify } from '../notify.js';
import { getCampaign } from './campaigns.js';
import { summary } from './metrics.js';
import { changeStatus, setVariationLive } from './lifecycle.js';

export const RULE_TYPES = {
  max_total_spend: 'Total spend reaches',
  max_daily_spend: "Today's spend reaches",
  max_cpc: 'Cost per click exceeds',
  min_ctr: 'CTR (%) falls below',
  max_cpa: 'Cost per conversion exceeds',
  end_after_conversions: 'Conversions reach',
};

/** Default guard-rails added to every new campaign. */
export function addDefaultRules(campaignId, totalBudget) {
  run(`INSERT INTO rules (campaign_id, type, threshold, action) VALUES (?, 'max_total_spend', ?, 'end_campaign')`, campaignId, totalBudget);
}

function check(rule, m) {
  if (m.impressions < rule.min_impressions) return null;
  switch (rule.type) {
    case 'max_total_spend':
    case 'max_daily_spend': return m.spend >= rule.threshold ? `spend ${m.spend} ≥ ${rule.threshold}` : null;
    case 'max_cpc': return m.cpc != null && m.cpc > rule.threshold ? `CPC ${m.cpc} > ${rule.threshold}` : null;
    case 'min_ctr': return m.impressions > 0 && m.ctr < rule.threshold ? `CTR ${m.ctr}% < ${rule.threshold}%` : null;
    case 'max_cpa':
      if (m.conversions > 0) return m.cpa > rule.threshold ? `CPA ${m.cpa} > ${rule.threshold}` : null;
      return m.spend > rule.threshold ? `spend ${m.spend} with 0 conversions (> CPA cap ${rule.threshold})` : null;
    case 'end_after_conversions': return m.conversions >= rule.threshold ? `${m.conversions} conversions ≥ ${rule.threshold}` : null;
    default: return null;
  }
}

/** Evaluates enabled rules for a live campaign against freshly synced metrics and acts on them. */
export async function evaluateRules(campaignId) {
  const campaign = getCampaign(campaignId);
  if (!['active', 'scheduled'].includes(campaign.status)) return;
  const s = summary(campaignId);
  const rules = all('SELECT * FROM rules WHERE campaign_id = ? AND enabled = 1', campaignId);

  // Built-in, non-removable budget guard: never exceed the approved total budget.
  if (s.totals.spend >= campaign.total_budget) {
    await changeStatus(campaignId, 'ended', null, `Budget guard: total spend ${s.totals.spend} reached approved budget ${campaign.total_budget}`);
    return;
  }

  for (const rule of rules) {
    if (rule.action === 'pause_variation') {
      // Variation-scoped: evaluate each variation's combined metrics independently.
      const perVar = new Map();
      for (const r of s.byVariation) {
        if (!r.variation_id) continue;
        const a = perVar.get(r.variation_id) ?? { label: r.label, impressions: 0, clicks: 0, spend: 0, conversions: 0 };
        a.impressions += r.impressions; a.clicks += r.clicks; a.spend += r.spend; a.conversions += r.conversions;
        perVar.set(r.variation_id, a);
      }
      const paused = new Set(all(`SELECT variation_id FROM platform_objects WHERE campaign_id = ? AND kind = 'ad' AND status = 'PAUSED_BY_RULE'`, campaignId).map((r) => r.variation_id));
      for (const [vid, a] of perVar) {
        if (paused.has(vid)) continue;
        const m = { ...a, ctr: a.impressions ? 100 * a.clicks / a.impressions : 0, cpc: a.clicks ? a.spend / a.clicks : null, cpa: a.conversions ? a.spend / a.conversions : null };
        const hit = check(rule, m);
        if (!hit) continue;
        try {
          await setVariationLive(campaignId, vid, false, null, `Rule #${rule.id}: ${hit}`);
          await notify('warning', `Variation paused by rule: ${a.label}`, `${campaign.name}: ${RULE_TYPES[rule.type]} ${rule.threshold} (${hit}).`, campaignId);
        } catch (e) {
          await notify('error', `Rule action failed: ${campaign.name}`, e.message, campaignId);
        }
        run(`UPDATE rules SET last_triggered_at = datetime('now') WHERE id = ?`, rule.id);
      }
      continue;
    }

    const metricsForRule = rule.type === 'max_daily_spend' ? s.today : s.totals;
    const hit = check(rule, metricsForRule);
    if (!hit) continue;
    // Notify-only rules re-fire at most once per 24h.
    if (rule.action === 'notify' && rule.last_triggered_at && Date.now() - new Date(rule.last_triggered_at + 'Z').getTime() < 864e5) continue;

    run(`UPDATE rules SET last_triggered_at = datetime('now') WHERE id = ?`, rule.id);
    audit(null, 'rule.triggered', 'rule', rule.id, { campaignId, hit, action: rule.action });
    const reason = `Rule #${rule.id}: ${RULE_TYPES[rule.type]} ${rule.threshold} (${hit})`;
    try {
      if (rule.action === 'pause_campaign') { await changeStatus(campaignId, 'paused', null, reason); return; }
      if (rule.action === 'end_campaign') { await changeStatus(campaignId, 'ended', null, reason); return; }
      await notify('warning', `Rule alert: ${campaign.name}`, reason, campaignId);
    } catch (e) {
      await notify('error', `Rule action failed: ${campaign.name}`, `${reason}\n${e.message}`, campaignId);
    }
  }
}
