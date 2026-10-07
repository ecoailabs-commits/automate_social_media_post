import { Router } from 'express';
import { config } from '../config.js';
import { one, run } from '../db.js';
import { randomToken } from '../crypto.js';
import { requireRole } from '../auth.js';
import { audit } from '../audit.js';
import { adapter, PLATFORM_NAMES } from '../platforms/index.js';
import { PLATFORMS, publicConnection, saveTokens, selectAccount, disconnect, getConnection, markError } from '../platforms/connections.js';
import { listPixels } from '../platforms/meta.js';
import { h, httpError } from './util.js';

const r = Router();
const redirectUri = (p) => `${config.publicUrl}/api/oauth/${p}/callback`;
const checkPlatform = (p) => { if (!PLATFORMS.includes(p)) throw httpError(404, 'Unknown platform'); return p; };

r.get('/connections', requireRole('editor'), h(() => PLATFORMS.map(publicConnection)));

r.post('/connections/:platform/oauth/start', requireRole('manager'), h((req) => {
  const p = checkPlatform(req.params.platform);
  if (!publicConnection(p).appConfigured) throw httpError(400, `${PLATFORM_NAMES[p]} app credentials are not configured on the server (.env).`);
  const state = randomToken(24);
  run(`DELETE FROM oauth_states WHERE created_at < datetime('now','-15 minutes')`);
  run('INSERT INTO oauth_states (state, platform, user_id) VALUES (?, ?, ?)', state, p, req.user.id);
  return { url: adapter(p).oauthUrl(state, redirectUri(p)) };
}));

// OAuth redirect target. Validates the one-time state bound to the user who started the flow.
r.get('/oauth/:platform/callback', async (req, res) => {
  const p = req.params.platform;
  const back = (q) => res.redirect(`/#/connections?${new URLSearchParams(q)}`);
  try {
    checkPlatform(p);
    const st = one(`SELECT * FROM oauth_states WHERE state = ? AND platform = ? AND created_at >= datetime('now','-15 minutes')`, String(req.query.state ?? ''), p);
    run('DELETE FROM oauth_states WHERE state = ?', String(req.query.state ?? ''));
    if (!st || !req.user || req.user.id !== st.user_id) return back({ error: 'OAuth state invalid or expired. Start the connection again.' });
    if (req.query.error) return back({ error: String(req.query.error_description || req.query.error) });
    const tokens = await adapter(p).exchangeCode(String(req.query.code), redirectUri(p));
    saveTokens(p, { ...tokens, userId: req.user.id });
    audit(req, 'connection.oauth', 'connection', p);
    back({ connected: p });
  } catch (e) {
    console.error('[oauth]', p, e.message);
    back({ error: e.message });
  }
});

r.get('/connections/:platform/accounts', requireRole('manager'), h(async (req) => {
  const p = checkPlatform(req.params.platform);
  try {
    return await adapter(p).listAccounts();
  } catch (e) {
    markError(p, e.message);
    throw e;
  }
}));

r.get('/connections/meta/pixels', requireRole('manager'), h((req) => listPixels(String(req.query.account ?? '').replace(/\D/g, ''))));

r.post('/connections/:platform/account', requireRole('manager'), h(async (req) => {
  const p = checkPlatform(req.params.platform);
  // Re-fetch the account list server-side so the client can't select an account it has no access to.
  const { accounts, pages } = await adapter(p).listAccounts();
  const acct = accounts.find((a) => a.id === String(req.body.accountId));
  if (!acct) throw httpError(400, 'Account not accessible with this connection');
  const extra = {};
  if (p === 'meta') {
    const page = pages.find((pg) => pg.id === String(req.body.pageId));
    if (!page) throw httpError(400, 'Select a Facebook Page you manage');
    extra.page_id = page.id; extra.page_name = page.name;
    if (req.body.pixelId) {
      const pixels = await listPixels(acct.id);
      const px = pixels.find((x) => x.id === String(req.body.pixelId));
      if (!px) throw httpError(400, 'Pixel not found on this ad account');
      extra.pixel_id = px.id; extra.pixel_name = px.name;
    }
  }
  if (p === 'google') extra.login_customer_id = acct.loginCustomerId;
  selectAccount(p, { accountId: acct.id, accountName: acct.name, currency: acct.currency, extra });
  audit(req, 'connection.account.select', 'connection', p, { accountId: acct.id, name: acct.name, ...extra });
  return publicConnection(p);
}));

r.delete('/connections/:platform', requireRole('admin'), h((req) => {
  const p = checkPlatform(req.params.platform);
  disconnect(p);
  audit(req, 'connection.disconnect', 'connection', p);
}));

r.get('/connections/:platform/locations', requireRole('editor'), h(async (req) => {
  const p = checkPlatform(req.params.platform);
  const q = String(req.query.q ?? '').trim();
  if (q.length < 2) return [];
  if (!getConnection(p)) throw httpError(400, `${PLATFORM_NAMES[p]} is not connected`);
  return adapter(p).searchLocations(q);
}));

export default r;
