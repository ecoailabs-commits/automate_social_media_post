import { config } from './config.js';
import { one, run } from './db.js';
import { hashPassword, randomToken, sign, unsign } from './crypto.js';

const COOKIE = 'ads_sid';
const SESSION_DAYS = 7;
const ROLE_RANK = { editor: 1, manager: 2, admin: 3 };

export function bootstrapAdmin() {
  const count = one('SELECT COUNT(*) AS n FROM users').n;
  if (count > 0) return;
  const { email, password } = config.bootstrapAdmin;
  if (!email || !password) return;
  if (password.length < 12) throw new Error('ADMIN_PASSWORD must be at least 12 characters');
  run('INSERT INTO users (email, name, password_hash, role) VALUES (?, ?, ?, ?)', email.toLowerCase(), 'Administrator', hashPassword(password), 'admin');
}

function parseCookies(header = '') {
  return Object.fromEntries(
    header.split(';').map((c) => c.trim()).filter(Boolean).map((c) => {
      const i = c.indexOf('=');
      return [c.slice(0, i), decodeURIComponent(c.slice(i + 1))];
    }),
  );
}

export function createSession(res, userId) {
  const sid = randomToken();
  const expires = new Date(Date.now() + SESSION_DAYS * 864e5);
  run('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)', sid, userId, expires.toISOString());
  res.cookie(COOKIE, sign(sid), {
    // 'lax' (not 'strict') so the cookie survives the top-level OAuth redirect back from the ad platforms.
    httpOnly: true, sameSite: 'lax', secure: config.isProd, expires, path: '/',
  });
}

export function destroySession(req, res) {
  const sid = unsign(parseCookies(req.headers.cookie)[COOKIE] ?? '');
  if (sid) run('DELETE FROM sessions WHERE id = ?', sid);
  res.clearCookie(COOKIE, { path: '/' });
}

/** Attaches req.user when a valid session cookie is present. */
export function sessionMiddleware(req, _res, next) {
  const sid = unsign(parseCookies(req.headers.cookie)[COOKIE] ?? '');
  if (sid) {
    const row = one(
      `SELECT u.id, u.email, u.name, u.role, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?`, sid,
    );
    if (row && new Date(row.expires_at) > new Date()) {
      req.user = { id: row.id, email: row.email, name: row.name, role: row.role };
    } else if (row) {
      run('DELETE FROM sessions WHERE id = ?', sid);
    }
  }
  next();
}

export function requireRole(minRole = 'editor') {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Not signed in' });
    if (ROLE_RANK[req.user.role] < ROLE_RANK[minRole]) return res.status(403).json({ error: `Requires ${minRole} role` });
    next();
  };
}

/**
 * CSRF defence for cookie-authenticated mutations: SameSite=lax cookie plus a
 * required custom header, which cross-site forms cannot set without a CORS preflight.
 */
export function csrfGuard(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.get('X-Requested-With') !== 'ads-app') return res.status(403).json({ error: 'Missing CSRF header' });
  next();
}

// Naive in-memory login throttle: 10 attempts per 15 minutes per IP+email.
const attempts = new Map();
export function loginThrottle(key) {
  const now = Date.now();
  const rec = attempts.get(key) ?? { n: 0, reset: now + 15 * 60e3 };
  if (now > rec.reset) { rec.n = 0; rec.reset = now + 15 * 60e3; }
  rec.n += 1;
  attempts.set(key, rec);
  return rec.n <= 10;
}
