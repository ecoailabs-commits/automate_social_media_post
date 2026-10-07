import { Router } from 'express';
import { one, all, run } from '../db.js';
import { hashPassword, verifyPassword } from '../crypto.js';
import { createSession, destroySession, loginThrottle, requireRole } from '../auth.js';
import { audit } from '../audit.js';
import { h, httpError, intParam } from './util.js';

const r = Router();

r.post('/auth/login', h((req, res) => {
  const email = String(req.body.email ?? '').toLowerCase().trim();
  if (!loginThrottle(`${req.ip}|${email}`)) throw httpError(429, 'Too many attempts. Try again in 15 minutes.');
  const user = one('SELECT * FROM users WHERE email = ?', email);
  if (!user || !verifyPassword(String(req.body.password ?? ''), user.password_hash)) {
    audit({ ip: req.ip, user: { email } }, 'auth.login.failed');
    throw httpError(401, 'Invalid email or password');
  }
  createSession(res, user.id);
  req.user = user;
  audit(req, 'auth.login');
  return { id: user.id, email: user.email, name: user.name, role: user.role };
}));

r.post('/auth/logout', h((req, res) => {
  if (req.user) audit(req, 'auth.logout');
  destroySession(req, res);
}));

r.get('/auth/me', h((req) => {
  if (!req.user) throw httpError(401, 'Not signed in');
  return req.user;
}));

r.get('/users', requireRole('admin'), h(() => all('SELECT id, email, name, role, created_at FROM users ORDER BY id')));

r.post('/users', requireRole('admin'), h((req) => {
  const { email, name, password, role } = req.body;
  if (!/^[^@\s]+@[^@\s]+$/.test(email ?? '')) throw httpError(400, 'Valid email required');
  if (String(password ?? '').length < 12) throw httpError(400, 'Password must be at least 12 characters');
  if (!['admin', 'manager', 'editor'].includes(role)) throw httpError(400, 'Invalid role');
  if (one('SELECT 1 FROM users WHERE email = ?', email.toLowerCase())) throw httpError(409, 'User already exists');
  const id = run('INSERT INTO users (email, name, password_hash, role) VALUES (?, ?, ?, ?)', email.toLowerCase(), name || email, hashPassword(password), role).lastInsertRowid;
  audit(req, 'user.create', 'user', id, { email, role });
  return { id };
}));

r.delete('/users/:id', requireRole('admin'), h((req) => {
  const id = intParam(req.params.id);
  if (id === req.user.id) throw httpError(400, 'You cannot delete yourself');
  run('DELETE FROM users WHERE id = ?', id);
  audit(req, 'user.delete', 'user', id);
}));

r.post('/auth/password', requireRole('editor'), h((req) => {
  const user = one('SELECT * FROM users WHERE id = ?', req.user.id);
  if (!verifyPassword(String(req.body.current ?? ''), user.password_hash)) throw httpError(400, 'Current password is wrong');
  if (String(req.body.next ?? '').length < 12) throw httpError(400, 'New password must be at least 12 characters');
  run('UPDATE users SET password_hash = ? WHERE id = ?', hashPassword(req.body.next), user.id);
  run('DELETE FROM sessions WHERE user_id = ?', user.id);
  audit(req, 'user.password.change', 'user', user.id);
}));

export default r;
