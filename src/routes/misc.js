import { Router } from 'express';
import fs from 'node:fs';
import { all, one, run, getSetting, setSetting } from '../db.js';
import { config } from '../config.js';
import { requireRole } from '../auth.js';
import { audit } from '../audit.js';
import { creativePath, uploadPath } from '../ai/creative.js';
import { portfolio } from '../services/metrics.js';
import { budgetCaps } from '../services/campaigns.js';
import { h, httpError } from './util.js';

const r = Router();

r.get('/dashboard', requireRole('editor'), h(() => ({
  ...portfolio(),
  counts: Object.fromEntries(all('SELECT status, COUNT(*) AS n FROM campaigns GROUP BY status').map((x) => [x.status, x.n])),
  unread: one('SELECT COUNT(*) AS n FROM notifications WHERE read = 0').n,
  openSuggestions: one(`SELECT COUNT(*) AS n FROM suggestions WHERE status = 'open'`).n,
  aiConfigured: !!config.anthropic.apiKey,
})));

r.get('/notifications', requireRole('editor'), h((req) => {
  const limit = Math.min(200, Number(req.query.limit) || 50);
  return {
    items: all('SELECT * FROM notifications ORDER BY id DESC LIMIT ?', limit),
    unread: one('SELECT COUNT(*) AS n FROM notifications WHERE read = 0').n,
  };
}));

r.post('/notifications/read-all', requireRole('editor'), h(() => { run('UPDATE notifications SET read = 1 WHERE read = 0'); }));

r.get('/audit', requireRole('manager'), h((req) => {
  const limit = Math.min(500, Number(req.query.limit) || 100);
  const offset = Math.max(0, Number(req.query.offset) || 0);
  const q = req.query.q ? `%${String(req.query.q)}%` : null;
  const where = q ? 'WHERE action LIKE ? OR actor LIKE ? OR details LIKE ? OR entity_id = ?' : '';
  const params = q ? [q, q, q, String(req.query.q)] : [];
  return {
    items: all(`SELECT * FROM audit_logs ${where} ORDER BY id DESC LIMIT ? OFFSET ?`, ...params, limit, offset),
    total: one(`SELECT COUNT(*) AS n FROM audit_logs ${where}`, ...params).n,
  };
}));

r.get('/settings', requireRole('editor'), h(() => ({
  caps: budgetCaps(),
  envCaps: { maxDaily: config.budget.maxDailyPerCampaign, maxTotal: config.budget.maxTotalPerCampaign },
  requireSeparateApprover: getSetting('require_separate_approver', false),
  notifications: { email: !!(config.notify.smtpUrl && config.notify.emailTo), slack: !!config.notify.slackWebhook },
  scheduler: config.scheduler,
})));

r.put('/settings', requireRole('admin'), h((req) => {
  const maxDaily = Number(req.body.maxDaily), maxTotal = Number(req.body.maxTotal);
  if (!(maxDaily > 0) || !(maxTotal > 0)) throw httpError(400, 'Caps must be positive numbers');
  // Admin settings can only tighten the env hard caps, never raise them.
  setSetting('budget_caps', { maxDaily: Math.min(maxDaily, config.budget.maxDailyPerCampaign), maxTotal: Math.min(maxTotal, config.budget.maxTotalPerCampaign) });
  setSetting('require_separate_approver', !!req.body.requireSeparateApprover);
  audit(req, 'settings.update', 'settings', null, req.body);
}));

// Authenticated file serving for generated creatives and product photos.
r.get('/files/creatives/:file', requireRole('editor'), (req, res) => {
  try {
    const p = creativePath(req.params.file);
    if (!fs.existsSync(p)) return res.status(404).end();
    res.type('png').set('Cache-Control', 'private, max-age=86400').sendFile(p);
  } catch { res.status(400).end(); }
});
r.get('/files/uploads/:file', requireRole('editor'), (req, res) => {
  try {
    const p = uploadPath(req.params.file);
    if (!fs.existsSync(p)) return res.status(404).end();
    res.set('Cache-Control', 'private, max-age=86400').sendFile(p);
  } catch { res.status(400).end(); }
});

export default r;
