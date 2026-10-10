import { Router } from 'express';
import fs from 'node:fs';
import multer from 'multer';
import { all, one, run, getSetting, setSetting } from '../db.js';
import { config } from '../config.js';
import { requireRole } from '../auth.js';
import { audit } from '../audit.js';
import { creativePath, uploadPath } from '../ai/creative.js';
import { pagePublishStatus, postToPage, listPagePosts, editPagePost } from '../platforms/meta.js';
import { portfolio } from '../services/metrics.js';
import { budgetCaps } from '../services/campaigns.js';
import { h, httpError } from './util.js';

const r = Router();
const pageUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });

r.get('/dashboard', requireRole('editor'), h(() => ({
  ...portfolio(),
  counts: Object.fromEntries(all('SELECT status, COUNT(*) AS n FROM campaigns GROUP BY status').map((x) => [x.status, x.n])),
  unread: one('SELECT COUNT(*) AS n FROM notifications WHERE read = 0').n,
  openSuggestions: one(`SELECT COUNT(*) AS n FROM suggestions WHERE status = 'open'`).n,
  aiConfigured: config.ai.configured,
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

// ---------- Facebook Page organic posts (free, no ad budget) ----------
r.get('/meta/page-status', requireRole('editor'), h(() => pagePublishStatus()));

r.get('/meta/page-posts', requireRole('editor'), h(() => listPagePosts(10)));

r.put('/meta/page-posts/:postId', requireRole('editor'), h(async (req) => {
  const message = String(req.body.message ?? '').trim();
  if (!message) throw httpError(400, 'Message cannot be empty');
  if (message.length > 5000) throw httpError(400, 'Message is too long (max 5000 characters)');
  const out = await editPagePost(req.params.postId, message);
  audit(req, 'page.post.edit', 'page', out.id, { message: message.slice(0, 120) });
  return out;
}));

r.post('/meta/page-post', requireRole('editor'), pageUpload.single('file'), h(async (req) => {
  const message = String(req.body.message ?? '').trim();
  const link = String(req.body.link ?? '').trim();
  const f = req.file;
  if (!message && !f) throw httpError(400, 'Write a message or attach an image');
  if (message.length > 5000) throw httpError(400, 'Message is too long (max 5000 characters)');
  let imageType;
  if (f) {
    const isPng = f.buffer.subarray(0, 4).toString('hex') === '89504e47';
    const isJpg = f.buffer.subarray(0, 3).toString('hex') === 'ffd8ff';
    if (!isPng && !isJpg) throw httpError(400, 'Only PNG or JPEG images are accepted');
    imageType = isPng ? 'image/png' : 'image/jpeg';
  }

  const status = await pagePublishStatus();
  if (!status.connected || !status.pageId) throw httpError(409, 'No Facebook Page selected. Open Connections → Meta → Select account first.');
  // Only block on a positive answer — if the scope check itself failed, let the real call explain.
  if (status.scopes.length && !status.canPublish) {
    throw httpError(409, 'Meta must be reconnected with posting permission: Connections → Meta → Reconnect.');
  }

  try {
    const out = await postToPage({ message, link, image: f?.buffer, imageType });
    audit(req, 'page.post', 'page', out.id, { message: message.slice(0, 120), image: !!f, link: link || null });
    return out;
  } catch (e) {
    if (/pages_manage_posts|publish_pages|\(200\)|code 200/i.test(String(e.message))) {
      throw httpError(409, 'Meta refused: this login is missing posting permission. Connections → Meta → Reconnect.');
    }
    throw e;
  }
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
