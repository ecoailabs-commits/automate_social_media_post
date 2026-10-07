import { all, one, getSetting, setSetting } from '../db.js';
import { config } from '../config.js';
import { changeStatus } from './lifecycle.js';
import { syncMetrics } from './metrics.js';
import { evaluateRules } from './rules.js';
import { generateSuggestions } from './optimizer.js';
import { notify } from '../notify.js';

let running = false;
const lastAttempt = new Map(); // campaignId → ms of last failed activation, for retry backoff
const RETRY_MS = 15 * 60e3;

const minutesSince = (sqlTs) => (sqlTs ? (Date.now() - new Date(sqlTs + 'Z').getTime()) / 60e3 : Infinity);

async function tick() {
  if (running) return; // never overlap ticks
  running = true;
  try {
    const now = new Date().toISOString();

    // 1. Flight end: stop anything past its end time (platforms also hold an end date as a backstop).
    for (const c of all(`SELECT id FROM campaigns WHERE status IN ('active','paused','scheduled') AND end_at <= ?`, now)) {
      if (Date.now() - (lastAttempt.get(c.id) ?? 0) < RETRY_MS) continue;
      try {
        await changeStatus(c.id, 'ended', null, 'Scheduled end time reached');
        lastAttempt.delete(c.id);
      } catch (e) {
        lastAttempt.set(c.id, Date.now());
        console.error('[scheduler] end', c.id, e.message);
      }
    }

    // 2. Flight start: activate scheduled campaigns whose start time has arrived.
    for (const c of all(`SELECT id FROM campaigns WHERE status = 'scheduled' AND start_at <= ?`, now)) {
      if (Date.now() - (lastAttempt.get(c.id) ?? 0) < RETRY_MS) continue;
      try {
        await changeStatus(c.id, 'active', null, 'Scheduled start time reached');
        lastAttempt.delete(c.id);
      } catch (e) {
        lastAttempt.set(c.id, Date.now());
        console.error('[scheduler] start', c.id, e.message);
      }
    }

    // 3. Monitoring: sync real metrics, then evaluate pause/end rules.
    for (const c of all(`SELECT id, last_synced_at FROM campaigns WHERE status IN ('active','paused')`)) {
      if (minutesSince(c.last_synced_at) < config.scheduler.metricsSyncMinutes) continue;
      try {
        await syncMetrics(c.id);
        await evaluateRules(c.id);
      } catch (e) {
        console.error('[scheduler] monitor', c.id, e.message);
      }
    }

    // 4. AI optimisation on a slower cadence (only when there is real data).
    if (config.anthropic.apiKey) {
      for (const c of all(`SELECT id, last_optimized_at FROM campaigns WHERE status = 'active'`)) {
        if (minutesSince(c.last_optimized_at) < config.scheduler.optimizeHours * 60) continue;
        if (!one('SELECT 1 FROM metrics WHERE campaign_id = ? AND impressions > 0 LIMIT 1', c.id)) continue;
        await generateSuggestions(c.id).catch((e) => console.error('[scheduler] optimize', c.id, e.message));
      }
    }

    // 5. Token health: warn before a Meta long-lived token expires (once per day).
    const today = now.slice(0, 10);
    if (getSetting('token_check_day') !== today) {
      setSetting('token_check_day', today);
      for (const c of all(`SELECT platform, token_expires_at FROM connections WHERE token_expires_at IS NOT NULL AND refresh_token_enc IS NULL`)) {
        const days = (new Date(c.token_expires_at) - Date.now()) / 864e5;
        if (days < 7) await notify('warning', `${c.platform} connection ${days < 0 ? 'has expired' : `expires in ${Math.ceil(days)} days`}`,'Reconnect it on the Connections page to keep campaigns manageable.');
      }
    }
  } catch (e) {
    console.error('[scheduler] tick failed', e);
  } finally {
    running = false;
  }
}

export function startScheduler() {
  setTimeout(tick, 5_000);
  setInterval(tick, config.scheduler.tickSeconds * 1000);
  console.log(`[scheduler] running every ${config.scheduler.tickSeconds}s`);
}
