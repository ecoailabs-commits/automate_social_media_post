import { all, run, one } from '../db.js';
import { adapter, PLATFORM_NAMES } from '../platforms/index.js';
import { audit } from '../audit.js';
import { notify } from '../notify.js';
import { getCampaign, getVariations, platformDailyBudget, budgetCaps } from './campaigns.js';
import { validateVariation as validateGoogle } from '../platforms/google.js';

const locks = new Set();
/** Per-campaign mutex so the scheduler and a user can't run conflicting platform calls at once. */
async function withLock(campaignId, fn) {
  if (locks.has(campaignId)) {
    const e = new Error('Another operation is in progress for this campaign. Try again in a moment.');
    e.status = 409;
    throw e;
  }
  locks.add(campaignId);
  try { return await fn(); } finally { locks.delete(campaignId); }
}

const setStatus = (id, status, error = null) =>
  run(`UPDATE campaigns SET status = ?, last_error = ?, updated_at = datetime('now') WHERE id = ?`, status, error, id);

/** Pre-flight checks so we fail before creating anything on any platform. */
export function preflight(campaign, variations) {
  const problems = [];
  if (!variations.length) problems.push('Select at least one variation');
  for (const v of variations) {
    if (campaign.platforms.includes('meta') && !v.creative_square) problems.push(`"${v.label}" has no square creative`);
    if (campaign.platforms.includes('google')) {
      const { problems: g } = validateGoogle(v);
      g.forEach((p) => problems.push(`"${v.label}" (Google): ${p}`));
    }
  }
  const caps = budgetCaps();
  if (campaign.daily_budget > caps.maxDaily) problems.push(`Daily budget exceeds the hard cap (${caps.maxDaily})`);
  if (new Date(campaign.end_at) <= new Date()) problems.push('Campaign end date has passed');
  return problems;
}

/**
 * Deploys an approved campaign to every selected platform. All-or-nothing: if any platform
 * fails, objects already created on every platform are removed so nothing half-built can spend.
 * Everything is created PAUSED; activation happens at start time.
 */
export async function deployCampaign(campaignId, req) {
  return withLock(campaignId, async () => {
    const campaign = getCampaign(campaignId);
    if (!campaign) throw Object.assign(new Error('Campaign not found'), { status: 404 });
    if (campaign.status !== 'approved') throw Object.assign(new Error(`Campaign must be approved before deploying (status: ${campaign.status})`), { status: 409 });
    const variations = getVariations(campaignId, { selectedOnly: true });
    const problems = preflight(campaign, variations);
    if (problems.length) throw Object.assign(new Error(problems.join('. ')), { status: 400 });

    setStatus(campaignId, 'deploying');
    audit(req, 'campaign.deploy.start', 'campaign', campaignId, { platforms: campaign.platforms });
    const done = [];
    try {
      for (const platform of campaign.platforms) {
        const dep = run('INSERT INTO deployments (campaign_id, platform, status) VALUES (?, ?, ?)', campaignId, platform, 'deploying').lastInsertRowid;
        const record = (kind, externalId, variationId = null, status = null) => {
          run('INSERT INTO platform_objects (campaign_id, platform, kind, external_id, variation_id, status) VALUES (?, ?, ?, ?, ?, ?)',
            campaignId, platform, kind, String(externalId), variationId, status);
        };
        try {
          const result = await adapter(platform).deploy({ campaign, variations, dailyBudget: platformDailyBudget(campaign, platform), record });
          run(`UPDATE deployments SET status = 'deployed', finished_at = datetime('now') WHERE id = ?`, dep);
          done.push(platform);
          audit(req, 'platform.deploy.success', 'campaign', campaignId, { platform, ...result });
        } catch (e) {
          run(`UPDATE deployments SET status = 'failed', error = ?, finished_at = datetime('now') WHERE id = ?`, e.message, dep);
          throw e;
        }
      }
    } catch (e) {
      // Roll back every platform touched in this attempt (including the one that failed mid-way).
      for (const platform of campaign.platforms) {
        if (!one('SELECT 1 FROM platform_objects WHERE campaign_id = ? AND platform = ? LIMIT 1', campaignId, platform)) continue;
        await adapter(platform).cleanup(campaignId).catch(() => {});
        run('DELETE FROM platform_objects WHERE campaign_id = ? AND platform = ?', campaignId, platform);
        run(`UPDATE deployments SET status = 'rolled_back' WHERE campaign_id = ? AND platform = ? AND status = 'deployed'`, campaignId, platform);
      }
      setStatus(campaignId, 'approved', e.message);
      audit(req, 'campaign.deploy.failed', 'campaign', campaignId, { error: e.message, rolledBack: done });
      await notify('error', `Deploy failed: ${campaign.name}`, `${e.message}\n\nAll created platform objects were rolled back. Fix the issue and deploy again.`, campaignId);
      throw e;
    }

    setStatus(campaignId, 'scheduled');
    audit(req, 'campaign.deploy.success', 'campaign', campaignId, { platforms: done });
    await notify('success', `Deployed: ${campaign.name}`, `Created on ${done.map((p) => PLATFORM_NAMES[p]).join(', ')} (paused). Goes live ${new Date(campaign.start_at).toLocaleString()}.`, campaignId);
    return getCampaign(campaignId);
  }).then(async (c) => {
    // Start immediately if the flight has already begun. A failure here is already notified
    // and leaves the campaign 'scheduled', so the scheduler will retry on its next tick.
    if (new Date(c.start_at) <= new Date()) {
      await changeStatus(campaignId, 'active', null, 'Start time reached at deploy').catch(() => {});
    }
    return getCampaign(campaignId);
  });
}

const TRANSITIONS = {
  active: { from: ['scheduled', 'paused'], platformStatus: 'ACTIVE', verb: 'Activated' },
  paused: { from: ['active', 'scheduled'], platformStatus: 'PAUSED', verb: 'Paused' },
  ended: { from: ['active', 'paused', 'scheduled'], platformStatus: 'ENDED', verb: 'Ended' },
};

/**
 * Moves a deployed campaign between active / paused / ended on every platform.
 * Pause and end are applied to every platform even if one fails, then the failure is surfaced.
 */
export async function changeStatus(campaignId, target, req, reason = '') {
  return withLock(campaignId, async () => {
    const campaign = getCampaign(campaignId);
    const t = TRANSITIONS[target];
    if (!campaign || !t) throw Object.assign(new Error('Invalid campaign or status'), { status: 400 });
    if (!t.from.includes(campaign.status)) throw Object.assign(new Error(`Cannot move from ${campaign.status} to ${target}`), { status: 409 });
    if (target === 'active' && new Date(campaign.end_at) <= new Date()) throw Object.assign(new Error('Flight has ended; cannot activate'), { status: 409 });

    const deployed = all('SELECT DISTINCT platform FROM platform_objects WHERE campaign_id = ?', campaignId).map((r) => r.platform);
    const failures = [];
    for (const platform of deployed) {
      try {
        await adapter(platform).setCampaignStatus(campaignId, t.platformStatus);
      } catch (e) {
        failures.push(`${PLATFORM_NAMES[platform]}: ${e.message}`);
      }
    }

    if (failures.length && target === 'active') {
      // Don't leave a campaign half-live: pause whatever did turn on.
      for (const platform of deployed) await adapter(platform).setCampaignStatus(campaignId, 'PAUSED').catch(() => {});
      setStatus(campaignId, campaign.status, failures.join(' | '));
      audit(req, 'campaign.activate.failed', 'campaign', campaignId, { failures, reason });
      await notify('error', `Activation failed: ${campaign.name}`, failures.join('\n'), campaignId);
      throw Object.assign(new Error(failures.join(' | ')), { status: 502 });
    }

    // On partial failure keep the previous status so the scheduler (or the user) retries;
    // re-pausing a platform that already paused is harmless.
    setStatus(campaignId, failures.length ? campaign.status : target, failures.length ? failures.join(' | ') : null);
    audit(req, `campaign.${target}${failures.length ? '.partial' : ''}`, 'campaign', campaignId, { reason, failures });
    await notify(failures.length ? 'error' : target === 'active' ? 'success' : 'info',
      `${t.verb}${failures.length ? ' with errors' : ''}: ${campaign.name}`,
      [reason, ...failures].filter(Boolean).join('\n'), campaignId);
    if (failures.length) throw Object.assign(new Error(`Some platforms failed: ${failures.join(' | ')}`), { status: 502 });
    return getCampaign(campaignId);
  });
}

export async function setVariationLive(campaignId, variationId, live, req, reason = '') {
  return withLock(campaignId, async () => {
    const campaign = getCampaign(campaignId);
    const failures = [];
    for (const platform of campaign.platforms) {
      try {
        const objId = await adapter(platform).setVariationStatus(campaignId, variationId, live ? 'ACTIVE' : 'PAUSED');
        if (objId) run('UPDATE platform_objects SET status = ? WHERE id = ?', live ? 'ACTIVE' : 'PAUSED_BY_RULE', objId);
      } catch (e) {
        failures.push(`${PLATFORM_NAMES[platform]}: ${e.message}`);
      }
    }
    audit(req, live ? 'variation.resume' : 'variation.pause', 'variation', variationId, { campaignId, reason, failures });
    if (failures.length) throw Object.assign(new Error(failures.join(' | ')), { status: 502 });
  });
}

export async function updateDailyBudget(campaignId, newDaily, req, reason = '') {
  return withLock(campaignId, async () => {
    const campaign = getCampaign(campaignId);
    const caps = budgetCaps();
    if (!(newDaily > 0)) throw Object.assign(new Error('Daily budget must be positive'), { status: 400 });
    if (newDaily > caps.maxDaily) throw Object.assign(new Error(`Exceeds daily hard cap of ${caps.maxDaily}`), { status: 400 });
    const failures = [];
    const deployed = all('SELECT DISTINCT platform FROM platform_objects WHERE campaign_id = ?', campaignId).map((r) => r.platform);
    for (const platform of deployed) {
      const share = Math.round(newDaily * (campaign.budget_split[platform] ?? 0)) / 100;
      try { await adapter(platform).updateDailyBudget(campaignId, share); } catch (e) { failures.push(`${PLATFORM_NAMES[platform]}: ${e.message}`); }
    }
    if (!failures.length) run(`UPDATE campaigns SET daily_budget = ?, updated_at = datetime('now') WHERE id = ?`, newDaily, campaignId);
    audit(req, 'campaign.budget.update', 'campaign', campaignId, { from: campaign.daily_budget, to: newDaily, reason, failures });
    if (failures.length) throw Object.assign(new Error(failures.join(' | ')), { status: 502 });
    await notify('info', `Daily budget changed: ${campaign.name}`, `${campaign.daily_budget} → ${newDaily} ${campaign.currency}. ${reason}`, campaignId);
  });
}
