import { Router } from 'express';
import multer from 'multer';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { all, one, run, tx, getSetting } from '../db.js';
import { requireRole } from '../auth.js';
import { audit } from '../audit.js';
import { getConnection, requireAccount } from '../platforms/connections.js';
import { PLATFORM_NAMES } from '../platforms/index.js';
import { previewVariation } from '../platforms/meta.js';
import { generateCampaignCopy, regenerateVariation } from '../ai/generate.js';
import { renderCreatives, storeUploadedCreative, creativePath, UPLOAD_DIR } from '../ai/creative.js';
import { getCampaign, getVariations, validateCampaignInput, validateVariationEdit } from '../services/campaigns.js';
import { deployCampaign, changeStatus, setVariationLive, updateDailyBudget, preflight, metaMinDaily } from '../services/lifecycle.js';
import { syncMetrics, summary } from '../services/metrics.js';
import { addDefaultRules, evaluateRules, RULE_TYPES } from '../services/rules.js';
import { generateSuggestions, applySuggestion } from '../services/optimizer.js';
import { h, httpError, intParam } from './util.js';

const r = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });

const EDITABLE = ['draft', 'generated', 'approved'];
const loadCampaign = (req) => {
  const c = getCampaign(intParam(req.params.id));
  if (!c) throw httpError(404, 'Campaign not found');
  return c;
};
const loadVariation = (c, vid) => {
  const v = getVariations(c.id).find((x) => x.id === intParam(vid));
  if (!v) throw httpError(404, 'Variation not found');
  return v;
};

/** Any content change after approval sends the campaign back for re-approval. */
function invalidateApproval(req, c, why) {
  if (!EDITABLE.includes(c.status)) throw httpError(409, `Campaign is ${c.status}; its ads can no longer be edited`);
  if (c.status === 'approved') {
    run(`UPDATE campaigns SET status = 'generated', approved_by = NULL, approved_at = NULL, updated_at = datetime('now') WHERE id = ?`, c.id);
    audit(req, 'campaign.approval.revoked', 'campaign', c.id, { why });
  }
}

function aiInput(c) {
  const days = Math.max(1, Math.ceil((new Date(c.end_at) - new Date(c.start_at)) / 864e5));
  const locationText = Object.values(c.locations).flat().map((l) => l.name).filter((v, i, a) => a.indexOf(v) === i).join('; ');
  return { ...c, days, locationText };
}

function renderFor(c, v) {
  if (!v.design) return {};
  return renderCreatives(v.design, v.cta, { brand: c.product.slice(0, 40), productImage: c.product_image });
}

/** Deletes creative files that no variation references any more. */
function removeCreativeFiles(...files) {
  for (const f of files.filter(Boolean)) {
    if (one('SELECT 1 FROM variations WHERE creative_square = ? OR creative_landscape = ? LIMIT 1', f, f)) continue;
    try { fs.rm(creativePath(f), { force: true }, () => {}); } catch { /* invalid name: nothing to delete */ }
  }
}

// ---------- Uploads ----------
r.post('/uploads/product', requireRole('editor'), upload.single('file'), h((req) => {
  const f = req.file;
  if (!f) throw httpError(400, 'No file');
  const isPng = f.buffer.subarray(0, 4).toString('hex') === '89504e47';
  const isJpg = f.buffer.subarray(0, 3).toString('hex') === 'ffd8ff';
  if (!isPng && !isJpg) throw httpError(400, 'Only PNG or JPEG images are accepted');
  const name = `prod_${crypto.randomBytes(8).toString('hex')}.${isPng ? 'png' : 'jpg'}`;
  fs.writeFileSync(path.join(UPLOAD_DIR, name), f.buffer);
  audit(req, 'upload.product', 'upload', name, { bytes: f.size });
  return { file: name };
}));

// ---------- Campaign CRUD ----------
r.get('/campaigns', requireRole('editor'), h(() => all(`
  SELECT c.id, c.name, c.product, c.objective, c.platforms, c.status, c.total_budget, c.daily_budget, c.currency, c.start_at, c.end_at, c.last_error, c.created_at,
         COALESCE(SUM(m.spend),0) AS spend, COALESCE(SUM(m.impressions),0) AS impressions, COALESCE(SUM(m.clicks),0) AS clicks, COALESCE(SUM(m.conversions),0) AS conversions
  FROM campaigns c LEFT JOIN metrics m ON m.campaign_id = c.id
  GROUP BY c.id ORDER BY c.created_at DESC`).map((c) => ({ ...c, platforms: JSON.parse(c.platforms) }))));

function currencyFor(platforms) {
  const currencies = new Set();
  for (const p of platforms) {
    const conn = getConnection(p);
    if (!conn || conn.status !== 'connected') throw httpError(400, `${PLATFORM_NAMES[p]} is not connected. Connect it first on the Connections page.`);
    currencies.add(conn.currency);
  }
  if (currencies.size > 1) throw httpError(400, `Selected ad accounts use different currencies (${[...currencies].join(', ')}). Create one campaign per currency.`);
  return [...currencies][0];
}

r.post('/campaigns', requireRole('editor'), h((req) => {
  const v = validateCampaignInput(req.body);
  const currency = currencyFor(v.platforms);
  const id = tx(() => {
    const id = run(`INSERT INTO campaigns (name, product, description, landing_url, audience, locations, objective, platforms, budget_split, total_budget, daily_budget, currency,
        start_at, end_at, age_min, age_max, created_by, product_image, tone, language, variation_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      v.name, v.product, v.description, v.landing_url, v.audience, JSON.stringify(v.locations), v.objective, JSON.stringify(v.platforms),
      JSON.stringify(v.budget_split), v.total_budget, v.daily_budget, currency, v.start_at.toISOString(), v.end_at.toISOString(),
      v.age_min, v.age_max, req.user.id, v.product_image, v.tone, v.language, v.variation_count).lastInsertRowid;
    addDefaultRules(id, v.total_budget);
    return id;
  });
  audit(req, 'campaign.create', 'campaign', id, { name: v.name, platforms: v.platforms, total_budget: v.total_budget, currency });
  return getCampaign(id);
}));

r.put('/campaigns/:id', requireRole('editor'), h((req) => {
  const c = loadCampaign(req);
  invalidateApproval(req, c, 'campaign settings edited');
  const v = validateCampaignInput({ ...c, ...req.body, start_at: req.body.start_at ?? c.start_at, end_at: req.body.end_at ?? c.end_at });
  const currency = currencyFor(v.platforms);
  run(`UPDATE campaigns SET name=?, product=?, description=?, landing_url=?, audience=?, locations=?, objective=?, platforms=?, budget_split=?, total_budget=?, daily_budget=?,
      currency=?, start_at=?, end_at=?, age_min=?, age_max=?, product_image=?, tone=?, language=?, variation_count=?, last_error=NULL, updated_at=datetime('now') WHERE id=?`,
    v.name, v.product, v.description, v.landing_url, v.audience, JSON.stringify(v.locations), v.objective, JSON.stringify(v.platforms), JSON.stringify(v.budget_split),
    v.total_budget, v.daily_budget, currency, v.start_at.toISOString(), v.end_at.toISOString(), v.age_min, v.age_max, v.product_image, v.tone, v.language, v.variation_count, c.id);
  run(`UPDATE rules SET threshold = ? WHERE campaign_id = ? AND type = 'max_total_spend' AND action = 'end_campaign' AND threshold = ?`, v.total_budget, c.id, c.total_budget);
  audit(req, 'campaign.update', 'campaign', c.id, { changes: Object.keys(req.body) });
  return getCampaign(c.id);
}));

r.delete('/campaigns/:id', requireRole('manager'), h((req) => {
  const c = loadCampaign(req);
  if (one('SELECT 1 FROM platform_objects WHERE campaign_id = ? LIMIT 1', c.id)) throw httpError(409, 'Deployed campaigns cannot be deleted; end them instead.');
  const files = getVariations(c.id).flatMap((v) => [v.creative_square, v.creative_landscape]);
  run('DELETE FROM campaigns WHERE id = ?', c.id);
  removeCreativeFiles(...files);
  audit(req, 'campaign.delete', 'campaign', c.id, { name: c.name });
}));

r.get('/campaigns/:id', requireRole('editor'), h((req) => {
  const c = loadCampaign(req);
  const variations = getVariations(c.id);
  return {
    campaign: c,
    variations,
    preflight: EDITABLE.includes(c.status) && variations.length ? preflight(c, variations.filter((v) => v.selected)) : [],
    rules: all('SELECT * FROM rules WHERE campaign_id = ? ORDER BY id', c.id),
    ruleTypes: RULE_TYPES,
    suggestions: all(`SELECT * FROM suggestions WHERE campaign_id = ? ORDER BY CASE status WHEN 'open' THEN 0 ELSE 1 END, created_at DESC LIMIT 30`, c.id),
    deployments: all('SELECT * FROM deployments WHERE campaign_id = ? ORDER BY id DESC LIMIT 20', c.id),
    objects: all('SELECT platform, kind, external_id, variation_id, status FROM platform_objects WHERE campaign_id = ? ORDER BY id', c.id),
    metrics: summary(c.id),
    audit: all(`SELECT * FROM audit_logs WHERE (entity_type = 'campaign' AND entity_id = ?) ORDER BY id DESC LIMIT 50`, String(c.id)),
    approver: c.approved_by ? one('SELECT name, email FROM users WHERE id = ?', c.approved_by) : null,
    metaMinDaily: metaMinDaily(c.currency),
  };
}));

// ---------- AI generation ----------
r.post('/campaigns/:id/generate', requireRole('editor'), h(async (req) => {
  const c = loadCampaign(req);
  invalidateApproval(req, c, 'regenerated');
  const count = Math.min(5, Math.max(2, Number(req.body.count) || c.variation_count || 3));
  const out = await generateCampaignCopy(aiInput(c), count);

  const rendered = out.variations.map((v) => ({ v, files: renderFor(c, v) }));
  const old = getVariations(c.id).flatMap((v) => [v.creative_square, v.creative_landscape]);
  tx(() => {
    run('DELETE FROM variations WHERE campaign_id = ?', c.id);
    for (const { v, files } of rendered) {
      run(`INSERT INTO variations (campaign_id, label, angle, primary_text, headlines, descriptions, cta, design, creative_square, creative_landscape)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        c.id, v.label, v.angle, v.primary_text, JSON.stringify(v.headlines), JSON.stringify(v.descriptions), v.cta, JSON.stringify(v.design), files.square ?? null, files.landscape ?? null);
    }
    run(`UPDATE campaigns SET ai_strategy = ?, status = 'generated', last_error = NULL, updated_at = datetime('now') WHERE id = ?`, JSON.stringify(out.strategy), c.id);
  });
  removeCreativeFiles(...old);
  audit(req, 'ai.generate', 'campaign', c.id, { variations: rendered.length, model: process.env.ANTHROPIC_MODEL || 'claude-opus-5-5', warnings: out.warnings });
  return { warnings: out.warnings };
}));

r.put('/campaigns/:id/strategy', requireRole('editor'), h((req) => {
  const c = loadCampaign(req);
  invalidateApproval(req, c, 'targeting strategy edited');
  const list = (x, max) => (Array.isArray(x) ? x.map((s) => String(s).trim()).filter(Boolean).slice(0, max) : []);
  const strategy = {
    ...(c.ai_strategy ?? {}),
    meta_interests: list(req.body.meta_interests, 10),
    google_keywords: list(req.body.google_keywords, 20),
    negative_keywords: list(req.body.negative_keywords, 20),
  };
  run(`UPDATE campaigns SET ai_strategy = ?, updated_at = datetime('now') WHERE id = ?`, JSON.stringify(strategy), c.id);
  audit(req, 'campaign.strategy.update', 'campaign', c.id);
  return strategy;
}));

r.put('/campaigns/:id/variations/:vid', requireRole('editor'), h((req) => {
  const c = loadCampaign(req);
  const existing = loadVariation(c, req.params.vid);
  invalidateApproval(req, c, `variation ${existing.id} edited`);
  const v = validateVariationEdit(req.body);
  const design = req.body.design && typeof req.body.design === 'object' ? { ...existing.design, ...req.body.design } : existing.design;
  const files = renderFor(c, { ...v, design });
  run(`UPDATE variations SET label=?, primary_text=?, headlines=?, descriptions=?, cta=?, design=?, creative_square=COALESCE(?, creative_square), creative_landscape=COALESCE(?, creative_landscape) WHERE id=?`,
    v.label, v.primary_text, JSON.stringify(v.headlines), JSON.stringify(v.descriptions), v.cta, JSON.stringify(design), files.square ?? null, files.landscape ?? null, existing.id);
  if (files.square) removeCreativeFiles(existing.creative_square, existing.creative_landscape);
  audit(req, 'variation.update', 'campaign', c.id, { variation: existing.id });
  return loadVariation(c, existing.id);
}));

r.post('/campaigns/:id/variations/:vid/regenerate', requireRole('editor'), h(async (req) => {
  const c = loadCampaign(req);
  const existing = loadVariation(c, req.params.vid);
  invalidateApproval(req, c, `variation ${existing.id} regenerated`);
  const v = await regenerateVariation(aiInput(c), { label: existing.label, primary_text: existing.primary_text, headlines: existing.headlines, descriptions: existing.descriptions, cta: existing.cta, design: existing.design }, String(req.body.guidance ?? '').slice(0, 500));
  const files = renderFor(c, v);
  run(`UPDATE variations SET label=?, angle=?, primary_text=?, headlines=?, descriptions=?, cta=?, design=?, creative_square=?, creative_landscape=? WHERE id=?`,
    v.label, v.angle, v.primary_text, JSON.stringify(v.headlines), JSON.stringify(v.descriptions), v.cta, JSON.stringify(v.design), files.square ?? null, files.landscape ?? null, existing.id);
  removeCreativeFiles(existing.creative_square, existing.creative_landscape);
  audit(req, 'ai.regenerate_variation', 'campaign', c.id, { variation: existing.id, guidance: req.body.guidance ?? null });
  return loadVariation(c, existing.id);
}));

r.post('/campaigns/:id/variations/:vid/creative', requireRole('editor'), upload.single('file'), h((req) => {
  const c = loadCampaign(req);
  const v = loadVariation(c, req.params.vid);
  const slot = 'creative_square';
  if (!req.file) throw httpError(400, 'No file');
  invalidateApproval(req, c, `creative uploaded for variation ${v.id}`);
  let file;
  try { file = storeUploadedCreative(req.file.buffer); } catch (e) { throw httpError(400, e.message); }
  run(`UPDATE variations SET ${slot} = ? WHERE id = ?`, file, v.id);
  removeCreativeFiles(v[slot]);
  audit(req, 'variation.creative.upload', 'campaign', c.id, { variation: v.id, slot });
  return loadVariation(c, v.id);
}));

r.post('/campaigns/:id/variations/:vid/select', requireRole('editor'), h((req) => {
  const c = loadCampaign(req);
  const v = loadVariation(c, req.params.vid);
  invalidateApproval(req, c, `variation ${v.id} selection changed`);
  run('UPDATE variations SET selected = ? WHERE id = ?', req.body.selected ? 1 : 0, v.id);
  audit(req, 'variation.select', 'campaign', c.id, { variation: v.id, selected: !!req.body.selected });
}));

r.get('/campaigns/:id/variations/:vid/meta-preview', requireRole('editor'), h(async (req) => {
  const c = loadCampaign(req);
  const v = loadVariation(c, req.params.vid);
  requireAccount('meta');
  return { html: await previewVariation(c, v) };
}));

// ---------- Approval & deployment ----------
r.post('/campaigns/:id/approve', requireRole('manager'), h((req) => {
  const c = loadCampaign(req);
  if (c.status !== 'generated') throw httpError(409, `Only generated campaigns can be approved (status: ${c.status})`);
  if (getSetting('require_separate_approver', false) && c.created_by === req.user.id) {
    throw httpError(403, 'Four-eyes policy: the campaign creator cannot approve it. Ask another manager.');
  }
  const problems = preflight(c, getVariations(c.id, { selectedOnly: true }));
  if (problems.length) throw httpError(400, problems.join('. '));
  for (const p of c.platforms) requireAccount(p);
  run(`UPDATE campaigns SET status = 'approved', approved_by = ?, approved_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`, req.user.id, c.id);
  audit(req, 'campaign.approve', 'campaign', c.id, { total_budget: c.total_budget, daily_budget: c.daily_budget, platforms: c.platforms });
  return getCampaign(c.id);
}));

r.post('/campaigns/:id/unapprove', requireRole('manager'), h((req) => {
  const c = loadCampaign(req);
  if (c.status !== 'approved') throw httpError(409, 'Campaign is not approved');
  invalidateApproval(req, c, 'manually revoked');
}));

r.post('/campaigns/:id/deploy', requireRole('manager'), h((req) => deployCampaign(loadCampaign(req).id, req)));

r.post('/campaigns/:id/status', requireRole('manager'), h(async (req) => {
  const c = loadCampaign(req);
  const target = req.body.status;
  if (!['active', 'paused', 'ended'].includes(target)) throw httpError(400, 'Invalid status');
  return changeStatus(c.id, target, req, `Manual ${target} by ${req.user.email}`);
}));

r.put('/campaigns/:id/budget', requireRole('manager'), h(async (req) => {
  const c = loadCampaign(req);
  const daily = Number(req.body.daily_budget);
  if (['draft', 'generated', 'approved'].includes(c.status)) throw httpError(409, 'Edit the total budget in campaign settings before deployment');
  await updateDailyBudget(c.id, daily, req, 'Manual budget change');
  return getCampaign(c.id);
}));

r.post('/campaigns/:id/variations/:vid/status', requireRole('manager'), h(async (req) => {
  const c = loadCampaign(req);
  const v = loadVariation(c, req.params.vid);
  await setVariationLive(c.id, v.id, !!req.body.live, req, 'Manual');
}));

// ---------- Monitoring ----------
r.post('/campaigns/:id/sync', requireRole('editor'), h(async (req) => {
  const c = loadCampaign(req);
  if (!one('SELECT 1 FROM platform_objects WHERE campaign_id = ? LIMIT 1', c.id)) throw httpError(409, 'Campaign is not deployed');
  const res = await syncMetrics(c.id);
  await evaluateRules(c.id);
  audit(req, 'metrics.sync', 'campaign', c.id, res);
  return res;
}));

r.post('/campaigns/:id/rules', requireRole('manager'), h((req) => {
  const c = loadCampaign(req);
  const { type, action } = req.body;
  const threshold = Number(req.body.threshold);
  const minImpr = Math.max(0, Number(req.body.min_impressions) || 0);
  if (!RULE_TYPES[type]) throw httpError(400, 'Invalid rule type');
  if (!['pause_campaign', 'pause_variation', 'end_campaign', 'notify'].includes(action)) throw httpError(400, 'Invalid action');
  if (!(threshold >= 0)) throw httpError(400, 'Invalid threshold');
  if (action === 'pause_variation' && ['max_total_spend', 'max_daily_spend', 'end_after_conversions'].includes(type)) throw httpError(400, 'Variation-level pausing supports CPC, CTR and CPA rules');
  const id = run('INSERT INTO rules (campaign_id, type, threshold, min_impressions, action) VALUES (?, ?, ?, ?, ?)', c.id, type, threshold, minImpr, action).lastInsertRowid;
  audit(req, 'rule.create', 'campaign', c.id, { rule: id, type, threshold, action, minImpr });
  return { id };
}));

r.patch('/rules/:rid', requireRole('manager'), h((req) => {
  const rule = one('SELECT * FROM rules WHERE id = ?', intParam(req.params.rid));
  if (!rule) throw httpError(404, 'Rule not found');
  run('UPDATE rules SET enabled = ? WHERE id = ?', req.body.enabled ? 1 : 0, rule.id);
  audit(req, 'rule.toggle', 'campaign', rule.campaign_id, { rule: rule.id, enabled: !!req.body.enabled });
}));

r.delete('/rules/:rid', requireRole('manager'), h((req) => {
  const rule = one('SELECT * FROM rules WHERE id = ?', intParam(req.params.rid));
  if (!rule) throw httpError(404, 'Rule not found');
  run('DELETE FROM rules WHERE id = ?', rule.id);
  audit(req, 'rule.delete', 'campaign', rule.campaign_id, { rule });
}));

// ---------- AI optimisation ----------
r.post('/campaigns/:id/optimize', requireRole('editor'), h(async (req) => {
  const c = loadCampaign(req);
  return generateSuggestions(c.id, req);
}));

r.post('/suggestions/:sid/apply', requireRole('manager'), h((req) => applySuggestion(intParam(req.params.sid), req)));

r.post('/suggestions/:sid/dismiss', requireRole('editor'), h((req) => {
  const sg = one('SELECT * FROM suggestions WHERE id = ?', intParam(req.params.sid));
  if (!sg) throw httpError(404, 'Not found');
  run(`UPDATE suggestions SET status = 'dismissed', resolved_by = ?, resolved_at = datetime('now') WHERE id = ?`, req.user.id, sg.id);
  audit(req, 'suggestion.dismiss', 'suggestion', sg.id);
}));

export default r;
