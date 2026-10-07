import { config } from '../config.js';
import { one, run, parseJSON } from '../db.js';
import { decrypt, encrypt } from '../crypto.js';
import { PlatformError, request } from './http.js';

export const PLATFORMS = ['meta', 'google'];

export function getConnection(platform) {
  const row = one('SELECT * FROM connections WHERE platform = ?', platform);
  if (!row) return null;
  return { ...row, extra: parseJSON(row.extra, {}) };
}

/** Safe view for the frontend — never includes tokens. */
export function publicConnection(platform) {
  const c = getConnection(platform);
  const appConfigured = {
    meta: !!(config.meta.appId && config.meta.appSecret),
    google: !!(config.google.clientId && config.google.clientSecret && config.google.developerToken),
  }[platform];
  return {
    platform,
    appConfigured,
    status: c?.status ?? 'disconnected',
    accountId: c?.account_id ?? null,
    accountName: c?.account_name ?? null,
    currency: c?.currency ?? null,
    extra: c?.extra ?? {},
    connectedAt: c?.connected_at ?? null,
    tokenExpiresAt: c?.token_expires_at ?? null,
    lastError: c?.last_error ?? null,
  };
}

const googleTokenCache = { token: null, exp: 0 };

export function saveTokens(platform, { accessToken, refreshToken, expiresAt, userId }) {
  if (platform === 'google') { googleTokenCache.token = null; googleTokenCache.exp = 0; }
  run(
    `INSERT INTO connections (platform, access_token_enc, refresh_token_enc, token_expires_at, connected_by, connected_at, status, last_error)
     VALUES (?, ?, ?, ?, ?, datetime('now'), 'needs_account', NULL)
     ON CONFLICT(platform) DO UPDATE SET
       access_token_enc = excluded.access_token_enc,
       refresh_token_enc = COALESCE(excluded.refresh_token_enc, connections.refresh_token_enc),
       token_expires_at = excluded.token_expires_at,
       connected_by = excluded.connected_by,
       connected_at = excluded.connected_at,
       status = CASE WHEN connections.account_id IS NULL THEN 'needs_account' ELSE 'connected' END,
       last_error = NULL`,
    platform, encrypt(accessToken), refreshToken ? encrypt(refreshToken) : null, expiresAt ?? null, userId,
  );
}

export function selectAccount(platform, { accountId, accountName, currency, extra }) {
  run(
    `UPDATE connections SET account_id = ?, account_name = ?, currency = ?, extra = ?, status = 'connected', last_error = NULL WHERE platform = ?`,
    accountId, accountName, currency, JSON.stringify(extra ?? {}), platform,
  );
}

export function markError(platform, message) {
  run(`UPDATE connections SET last_error = ? WHERE platform = ?`, message, platform);
}

export function disconnect(platform) {
  if (platform === 'google') { googleTokenCache.token = null; googleTokenCache.exp = 0; }
  run('DELETE FROM connections WHERE platform = ?', platform);
}

/** Returns a valid access token, refreshing when the platform supports it. */
export async function getAccessToken(platform) {
  const c = getConnection(platform);
  if (!c?.access_token_enc && !c?.refresh_token_enc) throw new PlatformError(platform, 'Not connected. Connect it on the Connections page.');

  if (platform === 'google') {
    if (googleTokenCache.token && Date.now() < googleTokenCache.exp - 60_000) return googleTokenCache.token;
    const refresh = decrypt(c.refresh_token_enc);
    if (!refresh) throw new PlatformError('google', 'No refresh token stored; reconnect Google Ads.');
    const data = await request('google', 'https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: config.google.clientId, client_secret: config.google.clientSecret,
        refresh_token: refresh, grant_type: 'refresh_token',
      }),
      extractError: (d) => d.error_description || d.error,
    });
    googleTokenCache.token = data.access_token;
    googleTokenCache.exp = Date.now() + data.expires_in * 1000;
    return data.access_token;
  }

  if (platform === 'meta' && c.token_expires_at && new Date(c.token_expires_at) < new Date()) {
    throw new PlatformError('meta', 'Meta access token expired; reconnect Meta.');
  }
  return decrypt(c.access_token_enc);
}

export function requireAccount(platform) {
  const c = getConnection(platform);
  if (!c || c.status !== 'connected' || !c.account_id) {
    throw new PlatformError(platform, 'No ad account selected. Finish connecting it on the Connections page.');
  }
  return c;
}
