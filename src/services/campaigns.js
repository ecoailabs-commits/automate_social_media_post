import { config } from '../config.js';
import { all, one, parseJSON, getSetting } from '../db.js';
import { CTAS } from '../ai/generate.js';

export const OBJECTIVES = ['awareness', 'traffic', 'engagement', 'leads', 'sales'];
export const PLATFORMS = ['meta', 'google'];

export function getCampaign(id) {
  const c = one('SELECT * FROM campaigns WHERE id = ?', id);
  if (!c) return null;
  return {
    ...c,
    platforms: parseJSON(c.platforms, []),
    budget_split: parseJSON(c.budget_split, {}),
    locations: parseJSON(c.locations, {}),
    ai_strategy: parseJSON(c.ai_strategy, null),
  };
}

export function getVariations(campaignId, { selectedOnly = false } = {}) {
  return all(`SELECT * FROM variations WHERE campaign_id = ? ${selectedOnly ? 'AND selected = 1' : ''} ORDER BY id`, campaignId).map((v) => ({
    ...v,
    headlines: parseJSON(v.headlines, []),
    descriptions: parseJSON(v.descriptions, []),
    design: parseJSON(v.design, null),
    selected: !!v.selected,
  }));
}

export function platformDailyBudget(campaign, platform) {
  return Math.round(campaign.daily_budget * (campaign.budget_split[platform] ?? 0)) / 100;
}

/** Effective caps: env hard caps, optionally tightened by admin settings. */
export function budgetCaps() {
  const s = getSetting('budget_caps', {});
  return {
    maxDaily: Math.min(config.budget.maxDailyPerCampaign, s.maxDaily ?? Infinity),
    maxTotal: Math.min(config.budget.maxTotalPerCampaign, s.maxTotal ?? Infinity),
  };
}

const isUrl = (u) => { try { const x = new URL(u); return x.protocol === 'https:' || x.protocol === 'http:'; } catch { return false; } };

/** Validates and normalises campaign input; throws an Error with a user-facing message. */
export function validateCampaignInput(b) {
  const errors = [];
  const s = (v) => (typeof v === 'string' ? v.trim() : '');
  const out = {
    name: s(b.name) || s(b.product).slice(0, 80),
    product: s(b.product),
    description: s(b.description),
    landing_url: s(b.landing_url),
    audience: s(b.audience),
    objective: b.objective,
    platforms: Array.isArray(b.platforms) ? [...new Set(b.platforms)].filter((p) => PLATFORMS.includes(p)) : [],
    budget_split: b.budget_split ?? {},
    total_budget: Number(b.total_budget),
    start_at: new Date(b.start_at),
    end_at: new Date(b.end_at),
    age_min: b.age_min ? Number(b.age_min) : 18,
    age_max: b.age_max ? Number(b.age_max) : 65,
    locations: b.locations ?? {},
    locationText: s(b.locationText),
    tone: s(b.tone),
    language: s(b.language) || 'English',
    variation_count: Math.min(5, Math.max(2, Number(b.variation_count) || 3)),
    product_image: b.product_image ? String(b.product_image) : null,
  };

  if (!out.product) errors.push('Product/service is required');
  if (out.product.length > 200) errors.push('Product name too long');
  if (!isUrl(out.landing_url)) errors.push('A valid landing page URL is required');
  if (!out.audience) errors.push('Target audience is required');
  if (!OBJECTIVES.includes(out.objective)) errors.push('Invalid objective');
  if (!out.platforms.length) errors.push('Select at least one platform');
  if (Number.isNaN(out.start_at.getTime()) || Number.isNaN(out.end_at.getTime())) errors.push('Valid start and end dates are required');
  if (out.end_at <= out.start_at) errors.push('End must be after start');
  if (out.end_at < new Date()) errors.push('End date is in the past');
  if (!(out.total_budget > 0)) errors.push('Total budget must be positive');
  if (out.age_min < 18 || out.age_max > 65 || out.age_min > out.age_max) errors.push('Age range must be within 18–65');

  for (const p of out.platforms) {
    if (!Array.isArray(out.locations[p]) || !out.locations[p].length) errors.push(`Select at least one location for ${p}`);
  }
  for (const p of Object.keys(out.locations)) if (!out.platforms.includes(p)) delete out.locations[p];

  const split = {};
  let sum = 0;
  for (const p of out.platforms) {
    split[p] = Number(out.budget_split[p] ?? 100 / out.platforms.length);
    sum += split[p];
  }
  if (Math.abs(sum - 100) > 0.5) errors.push('Budget split must add up to 100%');
  out.budget_split = split;

  const days = Math.max(1, Math.ceil((out.end_at - out.start_at) / 864e5));
  out.days = days;
  out.daily_budget = Math.round((out.total_budget / days) * 100) / 100;
  const caps = budgetCaps();
  if (out.total_budget > caps.maxTotal) errors.push(`Total budget exceeds the hard cap of ${caps.maxTotal}`);
  if (out.daily_budget > caps.maxDaily) errors.push(`Daily budget (${out.daily_budget}) exceeds the hard cap of ${caps.maxDaily}; extend the duration or lower the budget`);

  if (errors.length) {
    const e = new Error(errors.join('. '));
    e.status = 400;
    throw e;
  }
  return out;
}

export function validateVariationEdit(b) {
  const arr = (x) => (Array.isArray(x) ? x.map((s) => String(s).trim()).filter(Boolean) : []);
  const v = {
    label: String(b.label ?? '').trim().slice(0, 60) || 'Variation',
    primary_text: String(b.primary_text ?? '').trim(),
    headlines: arr(b.headlines),
    descriptions: arr(b.descriptions),
    cta: CTAS.includes(b.cta) ? b.cta : 'LEARN_MORE',
  };
  const errors = [];
  if (!v.primary_text) errors.push('Primary text is required');
  if (v.primary_text.length > 600) errors.push('Primary text must be 600 characters or fewer');
  if (v.headlines.length < 3) errors.push('At least 3 headlines are required');
  v.headlines.forEach((h) => h.length > 30 && errors.push(`Headline over 30 characters: "${h}"`));
  if (v.descriptions.length < 2) errors.push('At least 2 descriptions are required');
  v.descriptions.forEach((d) => d.length > 90 && errors.push(`Description over 90 characters: "${d}"`));
  if (errors.length) {
    const e = new Error(errors.join('. '));
    e.status = 400;
    throw e;
  }
  return v;
}
