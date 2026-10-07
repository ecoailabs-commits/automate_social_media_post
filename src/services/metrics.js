import { all, run, tx, one } from '../db.js';
import { adapter, PLATFORM_NAMES } from '../platforms/index.js';
import { getCampaign, getVariations } from './campaigns.js';
import { notify } from '../notify.js';
import { audit } from '../audit.js';

const ymd = (d) => new Date(d).toISOString().slice(0, 10);

/** Pulls real platform reporting for the campaign's flight to date and replaces stored rows. */
export async function syncMetrics(campaignId) {
  const campaign = getCampaign(campaignId);
  const deployed = all('SELECT DISTINCT platform FROM platform_objects WHERE campaign_id = ?', campaignId).map((r) => r.platform);
  const since = ymd(campaign.start_at);
  const until = ymd(Math.min(Date.now(), new Date(campaign.end_at).getTime() + 864e5));
  if (since > until) return { synced: [], errors: [] };

  const synced = [], errors = [];
  for (const platform of deployed) {
    try {
      const rows = await adapter(platform).fetchMetrics(campaignId, since, until);
      // Several platform rows can map to the same (date, variation) — aggregate before storing.
      const agg = new Map();
      for (const r of rows) {
        const k = `${r.date}|${r.variation_id ?? 0}`;
        const a = agg.get(k) ?? { date: r.date, variation_id: r.variation_id ?? 0, impressions: 0, clicks: 0, spend: 0, conversions: 0, reach: null };
        a.impressions += r.impressions; a.clicks += r.clicks; a.spend += r.spend; a.conversions += r.conversions;
        if (r.reach != null) a.reach = (a.reach ?? 0) + r.reach;
        agg.set(k, a);
      }
      tx(() => {
        run('DELETE FROM metrics WHERE campaign_id = ? AND platform = ? AND date BETWEEN ? AND ?', campaignId, platform, since, until);
        for (const a of agg.values()) {
          run(`INSERT INTO metrics (campaign_id, platform, variation_id, date, impressions, clicks, spend, conversions, reach) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            campaignId, platform, a.variation_id, a.date, a.impressions, a.clicks, Math.round(a.spend * 100) / 100, a.conversions, a.reach);
        }
      });
      synced.push(platform);
    } catch (e) {
      errors.push(`${PLATFORM_NAMES[platform]}: ${e.message}`);
    }
  }
  run(`UPDATE campaigns SET last_synced_at = datetime('now') WHERE id = ?`, campaignId);
  if (errors.length) {
    audit(null, 'metrics.sync.failed', 'campaign', campaignId, { errors });
    await notify('warning', `Metrics sync issue: ${campaign.name}`, errors.join('\n'), campaignId);
  }
  return { synced, errors };
}

const derive = (m) => ({
  ...m,
  spend: Math.round(m.spend * 100) / 100,
  ctr: m.impressions ? +(100 * m.clicks / m.impressions).toFixed(2) : 0,
  cpc: m.clicks ? +(m.spend / m.clicks).toFixed(2) : null,
  cpm: m.impressions ? +(1000 * m.spend / m.impressions).toFixed(2) : null,
  cpa: m.conversions ? +(m.spend / m.conversions).toFixed(2) : null,
});

const SUMS = 'COALESCE(SUM(impressions),0) AS impressions, COALESCE(SUM(clicks),0) AS clicks, COALESCE(SUM(spend),0) AS spend, COALESCE(SUM(conversions),0) AS conversions';

export function summary(campaignId) {
  const totals = derive(one(`SELECT ${SUMS} FROM metrics WHERE campaign_id = ?`, campaignId));
  const today = derive(one(`SELECT ${SUMS} FROM metrics WHERE campaign_id = ? AND date = ?`, campaignId, ymd(Date.now())));
  const byPlatform = all(`SELECT platform, ${SUMS} FROM metrics WHERE campaign_id = ? GROUP BY platform`, campaignId).map(derive);
  const labels = new Map(getVariations(campaignId).map((v) => [v.id, v.label]));
  const byVariation = all(`SELECT variation_id, platform, ${SUMS} FROM metrics WHERE campaign_id = ? GROUP BY variation_id, platform`, campaignId)
    .map((r) => derive({ ...r, label: labels.get(r.variation_id) ?? 'Unattributed' }));
  const daily = all(`SELECT date, ${SUMS} FROM metrics WHERE campaign_id = ? GROUP BY date ORDER BY date`, campaignId).map(derive);
  return { totals, today, byPlatform, byVariation, daily };
}

/** Portfolio-level KPIs for the dashboard. */
export function portfolio() {
  const totals = derive(one(`SELECT ${SUMS} FROM metrics`));
  const last30 = all(`SELECT date, ${SUMS} FROM metrics WHERE date >= date('now','-30 day') GROUP BY date ORDER BY date`).map(derive);
  const byPlatform = all(`SELECT platform, ${SUMS} FROM metrics GROUP BY platform`).map(derive);
  return { totals, last30, byPlatform };
}
