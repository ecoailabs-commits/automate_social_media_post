import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';

fs.mkdirSync(config.dataDir, { recursive: true });
fs.mkdirSync(path.join(config.dataDir, 'creatives'), { recursive: true });

export const db = new DatabaseSync(path.join(config.dataDir, 'ads.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','manager','editor')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);

-- One row per connected ad platform. Tokens are AES-256-GCM encrypted.
CREATE TABLE IF NOT EXISTS connections (
  platform TEXT PRIMARY KEY CHECK (platform IN ('meta','google','linkedin')),
  access_token_enc TEXT,
  refresh_token_enc TEXT,
  token_expires_at TEXT,
  account_id TEXT,          -- Meta act id / Google customer id
  account_name TEXT,
  currency TEXT,
  extra TEXT NOT NULL DEFAULT '{}', -- page_id, pixel_id, login_customer_id ...
  connected_by INTEGER REFERENCES users(id),
  connected_at TEXT,
  status TEXT NOT NULL DEFAULT 'disconnected',
  last_error TEXT
);

CREATE TABLE IF NOT EXISTS oauth_states (
  state TEXT PRIMARY KEY,
  platform TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS campaigns (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  product TEXT NOT NULL,
  description TEXT,
  landing_url TEXT NOT NULL,
  audience TEXT NOT NULL,
  locations TEXT NOT NULL DEFAULT '{}',   -- per-platform resolved location targets
  objective TEXT NOT NULL CHECK (objective IN ('awareness','traffic','engagement','leads','sales')),
  platforms TEXT NOT NULL,                -- JSON array
  budget_split TEXT NOT NULL,             -- JSON {platform: percent}
  total_budget REAL NOT NULL,
  daily_budget REAL NOT NULL,
  currency TEXT NOT NULL,
  start_at TEXT NOT NULL,
  end_at TEXT NOT NULL,
  age_min INTEGER, age_max INTEGER,
  status TEXT NOT NULL DEFAULT 'draft',
  -- draft → generated → approved → deploying → scheduled → active ⇄ paused → ended ; failed
  approved_by INTEGER REFERENCES users(id),
  approved_at TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_synced_at TEXT,
  last_optimized_at TEXT,
  last_error TEXT,
  ai_strategy TEXT,                        -- JSON: keywords, interests, rationale
  product_image TEXT,                      -- uploaded product photo used in creatives
  tone TEXT,
  language TEXT NOT NULL DEFAULT 'English',
  variation_count INTEGER NOT NULL DEFAULT 3
);

CREATE TABLE IF NOT EXISTS variations (
  id INTEGER PRIMARY KEY,
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  angle TEXT,
  primary_text TEXT NOT NULL,
  headlines TEXT NOT NULL,       -- JSON array (Google RSA needs 3-15)
  descriptions TEXT NOT NULL,    -- JSON array
  cta TEXT NOT NULL,             -- canonical CTA key (LEARN_MORE, SIGN_UP ...)
  design TEXT,                   -- JSON creative design spec from the AI (editable)
  creative_square TEXT,          -- file name in data/creatives
  creative_landscape TEXT,
  selected INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Every object created on an ad platform, so retries/cleanup/status changes are exact.
CREATE TABLE IF NOT EXISTS platform_objects (
  id INTEGER PRIMARY KEY,
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  platform TEXT NOT NULL,
  kind TEXT NOT NULL,            -- campaign, adset, budget, ad_group, ad, creative
  external_id TEXT NOT NULL,
  variation_id INTEGER REFERENCES variations(id) ON DELETE SET NULL,
  status TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS deployments (
  id INTEGER PRIMARY KEY,
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  platform TEXT NOT NULL,
  status TEXT NOT NULL,          -- pending, deploying, deployed, failed, rolled_back
  error TEXT,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT
);

CREATE TABLE IF NOT EXISTS metrics (
  id INTEGER PRIMARY KEY,
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  platform TEXT NOT NULL,
  variation_id INTEGER NOT NULL DEFAULT 0, -- 0 = not attributable to a variation
  date TEXT NOT NULL,            -- YYYY-MM-DD
  impressions INTEGER NOT NULL DEFAULT 0,
  clicks INTEGER NOT NULL DEFAULT 0,
  spend REAL NOT NULL DEFAULT 0,
  conversions REAL NOT NULL DEFAULT 0,
  reach INTEGER,
  fetched_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (campaign_id, platform, variation_id, date)
);

CREATE TABLE IF NOT EXISTS rules (
  id INTEGER PRIMARY KEY,
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('max_total_spend','max_daily_spend','max_cpc','min_ctr','max_cpa','end_after_conversions')),
  threshold REAL NOT NULL,
  min_impressions INTEGER NOT NULL DEFAULT 0,
  action TEXT NOT NULL CHECK (action IN ('pause_campaign','pause_variation','end_campaign','notify')),
  enabled INTEGER NOT NULL DEFAULT 1,
  last_triggered_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS suggestions (
  id INTEGER PRIMARY KEY,
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  detail TEXT NOT NULL,
  action TEXT NOT NULL,          -- none, pause_variation, adjust_daily_budget, shift_budget
  params TEXT NOT NULL DEFAULT '{}',
  priority TEXT NOT NULL DEFAULT 'medium',
  status TEXT NOT NULL DEFAULT 'open', -- open, applied, dismissed, failed
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_by INTEGER, resolved_at TEXT
);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY,
  level TEXT NOT NULL,           -- info, success, warning, error
  title TEXT NOT NULL,
  body TEXT,
  campaign_id INTEGER,
  read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY,
  user_id INTEGER,
  actor TEXT NOT NULL,           -- user email or 'system'
  action TEXT NOT NULL,
  entity_type TEXT,
  entity_id TEXT,
  details TEXT,
  ip TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Append-only: block edits and deletes of audit history at the database level.
CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit_logs BEGIN SELECT RAISE(ABORT, 'audit_logs is append-only'); END;
CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit_logs BEGIN SELECT RAISE(ABORT, 'audit_logs is append-only'); END;

CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE INDEX IF NOT EXISTS idx_metrics_campaign ON metrics(campaign_id, date);
CREATE INDEX IF NOT EXISTS idx_objects_campaign ON platform_objects(campaign_id, platform);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at);
`);

export const one = (sql, ...params) => db.prepare(sql).get(...params);
export const all = (sql, ...params) => db.prepare(sql).all(...params);
export const run = (sql, ...params) => db.prepare(sql).run(...params);

export function tx(fn) {
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export const parseJSON = (s, fallback = null) => {
  try { return s == null ? fallback : JSON.parse(s); } catch { return fallback; }
};

export function getSetting(key, fallback = null) {
  const r = one('SELECT value FROM settings WHERE key = ?', key);
  return r ? parseJSON(r.value, fallback) : fallback;
}
export function setSetting(key, value) {
  run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, JSON.stringify(value));
}
