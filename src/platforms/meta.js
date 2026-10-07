import crypto from 'node:crypto';
import fs from 'node:fs';
import { config } from '../config.js';
import { all } from '../db.js';
import { PlatformError, request } from './http.js';
import { getAccessToken, requireAccount } from './connections.js';
import { creativePath } from '../ai/creative.js';
import { toMinorUnits } from './money.js';

const P = 'meta';
const graph = () => `https://graph.facebook.com/${config.meta.apiVersion}`;
const extractError = (d) => d?.error && `${d.error.message}${d.error.error_user_msg ? ` — ${d.error.error_user_msg}` : ''} (code ${d.error.code}${d.error.error_subcode ? `/${d.error.error_subcode}` : ''})`;

async function call(method, path, params = {}) {
  const token = await getAccessToken(P);
  const proof = crypto.createHmac('sha256', config.meta.appSecret).update(token).digest('hex');
  const encoded = new URLSearchParams();
  for (const [k, v] of Object.entries({ ...params, access_token: token, appsecret_proof: proof })) {
    if (v === undefined || v === null) continue;
    encoded.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
  }
  const url = path.startsWith('http') ? path : `${graph()}${path}`;
  if (method === 'GET' || method === 'DELETE') {
    return request(P, `${url}${url.includes('?') ? '&' : '?'}${encoded}`, { method, extractError });
  }
  return request(P, url, {
    method, extractError,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: encoded,
  });
}

async function paged(path, params) {
  const out = [];
  let res = await call('GET', path, params);
  out.push(...(res.data ?? []));
  while (res.paging?.next && out.length < 5000) {
    res = await request(P, res.paging.next, { extractError });
    out.push(...(res.data ?? []));
  }
  return out;
}

// ---------- OAuth ----------
export function oauthUrl(state, redirectUri) {
  const q = new URLSearchParams({
    client_id: config.meta.appId, redirect_uri: redirectUri, state, response_type: 'code',
    scope: 'ads_management,ads_read,business_management,pages_show_list,pages_read_engagement',
  });
  return `https://www.facebook.com/${config.meta.apiVersion}/dialog/oauth?${q}`;
}

export async function exchangeCode(code, redirectUri) {
  const short = await request(P, `${graph()}/oauth/access_token?${new URLSearchParams({
    client_id: config.meta.appId, client_secret: config.meta.appSecret, redirect_uri: redirectUri, code,
  })}`, { extractError });
  // Swap for a long-lived (~60 day) user token.
  const long = await request(P, `${graph()}/oauth/access_token?${new URLSearchParams({
    grant_type: 'fb_exchange_token', client_id: config.meta.appId, client_secret: config.meta.appSecret, fb_exchange_token: short.access_token,
  })}`, { extractError });
  return {
    accessToken: long.access_token,
    expiresAt: long.expires_in ? new Date(Date.now() + long.expires_in * 1000).toISOString() : null,
  };
}

// ---------- Account setup ----------
export async function listAccounts() {
  const accounts = await paged('/me/adaccounts', { fields: 'account_id,name,currency,account_status', limit: 200 });
  const pages = await paged('/me/accounts', { fields: 'id,name', limit: 200 });
  return {
    accounts: accounts.map((a) => ({ id: a.account_id, name: a.name, currency: a.currency, active: a.account_status === 1 })),
    pages: pages.map((p) => ({ id: p.id, name: p.name })),
  };
}

export async function listPixels(accountId) {
  const px = await paged(`/act_${accountId}/adspixels`, { fields: 'id,name', limit: 100 });
  return px.map((p) => ({ id: p.id, name: p.name }));
}

export async function searchLocations(q) {
  const res = await call('GET', '/search', { type: 'adgeolocation', q, location_types: ['country', 'region', 'city'], limit: 15 });
  return (res.data ?? []).map((l) => ({
    key: l.key, type: l.type, name: [l.name, l.region, l.country_name].filter(Boolean).join(', '), country: l.country_code,
  }));
}

async function resolveInterests(names = []) {
  const found = [];
  for (const name of names.slice(0, 8)) {
    const res = await call('GET', '/search', { type: 'adinterest', q: name, limit: 1 });
    const hit = res.data?.[0];
    if (hit && !found.some((f) => f.id === hit.id)) found.push({ id: hit.id, name: hit.name });
  }
  return found;
}

// ---------- Mapping ----------
const OBJECTIVES = {
  awareness: { objective: 'OUTCOME_AWARENESS', optimization_goal: 'REACH' },
  traffic: { objective: 'OUTCOME_TRAFFIC', optimization_goal: 'LINK_CLICKS', destination_type: 'WEBSITE' },
  engagement: { objective: 'OUTCOME_ENGAGEMENT', optimization_goal: 'POST_ENGAGEMENT', destination_type: 'ON_POST' },
  leads: { objective: 'OUTCOME_LEADS', optimization_goal: 'OFFSITE_CONVERSIONS', destination_type: 'WEBSITE', event: 'LEAD', needsPixel: true },
  sales: { objective: 'OUTCOME_SALES', optimization_goal: 'OFFSITE_CONVERSIONS', destination_type: 'WEBSITE', event: 'PURCHASE', needsPixel: true },
};
const CTA = {
  LEARN_MORE: 'LEARN_MORE', SHOP_NOW: 'SHOP_NOW', SIGN_UP: 'SIGN_UP', CONTACT_US: 'CONTACT_US',
  GET_QUOTE: 'GET_QUOTE', DOWNLOAD: 'DOWNLOAD', APPLY_NOW: 'APPLY_NOW', SUBSCRIBE: 'SUBSCRIBE',
};

function buildTargeting(campaign, interests) {
  const locs = campaign.locations.meta ?? [];
  if (!locs.length) throw new PlatformError(P, 'No Meta locations selected for this campaign.');
  const geo = {};
  for (const l of locs) {
    if (l.type === 'country') (geo.countries ??= []).push(l.key);
    else if (l.type === 'region') (geo.regions ??= []).push({ key: l.key });
    else if (l.type === 'city') (geo.cities ??= []).push({ key: l.key });
  }
  const t = {
    geo_locations: geo,
    age_min: Math.max(18, campaign.age_min ?? 18),
    age_max: Math.min(65, campaign.age_max ?? 65),
    targeting_automation: { advantage_audience: 0 },
  };
  if (interests.length) t.flexible_spec = [{ interests }];
  return t;
}

function storySpec(campaign, v, pageId, imageHash) {
  return {
    page_id: pageId,
    link_data: {
      link: campaign.landing_url,
      message: v.primary_text,
      name: v.headlines[0],
      description: v.descriptions[0],
      image_hash: imageHash,
      call_to_action: { type: CTA[v.cta] ?? 'LEARN_MORE', value: { link: campaign.landing_url } },
    },
  };
}

async function uploadImage(accountId, file) {
  const bytes = fs.readFileSync(creativePath(file)).toString('base64');
  const res = await call('POST', `/act_${accountId}/adimages`, { bytes });
  const img = Object.values(res.images ?? {})[0];
  if (!img?.hash) throw new PlatformError(P, 'Image upload returned no hash');
  return img.hash;
}

// ---------- Preview (real Meta-rendered preview, creates nothing billable) ----------
export async function previewVariation(campaign, v) {
  const conn = requireAccount(P);
  if (!conn.extra.page_id) throw new PlatformError(P, 'Select a Facebook Page on the Connections page first.');
  if (!v.creative_square) throw new PlatformError(P, 'Variation has no creative image yet.');
  const hash = await uploadImage(conn.account_id, v.creative_square);
  const res = await call('GET', `/act_${conn.account_id}/generatepreviews`, {
    ad_format: 'MOBILE_FEED_STANDARD',
    creative: { object_story_spec: storySpec(campaign, v, conn.extra.page_id, hash) },
  });
  return res.data?.[0]?.body ?? null; // iframe HTML from Meta
}

// ---------- Deploy: everything is created PAUSED; the scheduler activates at start time ----------
export async function deploy({ campaign, variations, dailyBudget, record }) {
  const conn = requireAccount(P);
  const acct = conn.account_id;
  const pageId = conn.extra.page_id;
  if (!pageId) throw new PlatformError(P, 'Select a Facebook Page on the Connections page before deploying.');
  const obj = OBJECTIVES[campaign.objective];
  if (obj.needsPixel && !conn.extra.pixel_id) {
    throw new PlatformError(P, `The "${campaign.objective}" objective needs a Meta Pixel. Select one on the Connections page.`);
  }

  const interests = await resolveInterests(campaign.ai_strategy?.meta_interests ?? []);

  const c = await call('POST', `/act_${acct}/campaigns`, {
    name: campaign.name,
    objective: obj.objective,
    status: 'PAUSED',
    special_ad_categories: [],
    is_adset_budget_sharing_enabled: false,
  });
  record('campaign', c.id);

  const now = Date.now();
  const start = new Date(Math.max(new Date(campaign.start_at).getTime(), now + 5 * 60e3));
  const adset = {
    name: `${campaign.name} — ad set`,
    campaign_id: c.id,
    daily_budget: toMinorUnits(dailyBudget, conn.currency),
    billing_event: 'IMPRESSIONS',
    optimization_goal: obj.optimization_goal,
    bid_strategy: 'LOWEST_COST_WITHOUT_CAP',
    targeting: buildTargeting(campaign, interests),
    start_time: start.toISOString(),
    // Hard stop on Meta's side too, so spend ends even if this server is down.
    end_time: new Date(campaign.end_at).toISOString(),
    status: 'PAUSED',
  };
  if (obj.destination_type) adset.destination_type = obj.destination_type;
  if (obj.needsPixel) adset.promoted_object = { pixel_id: conn.extra.pixel_id, custom_event_type: obj.event };
  const as = await call('POST', `/act_${acct}/adsets`, adset);
  record('adset', as.id);

  for (const v of variations) {
    if (!v.creative_square) throw new PlatformError(P, `Variation "${v.label}" has no creative image.`);
    const hash = await uploadImage(acct, v.creative_square);
    const cr = await call('POST', `/act_${acct}/adcreatives`, {
      name: `${campaign.name} — ${v.label}`,
      object_story_spec: storySpec(campaign, v, pageId, hash),
    });
    record('creative', cr.id, v.id);
    const ad = await call('POST', `/act_${acct}/ads`, {
      name: `${campaign.name} — ${v.label}`, adset_id: as.id, creative: { creative_id: cr.id }, status: 'PAUSED',
    });
    record('ad', ad.id, v.id, 'PAUSED');
  }
  return { interests };
}

const objects = (campaignId, kind) => all('SELECT * FROM platform_objects WHERE campaign_id = ? AND platform = ? AND kind = ?', campaignId, P, kind);

export async function setCampaignStatus(campaignId, status) {
  const [camp] = objects(campaignId, 'campaign');
  if (!camp) throw new PlatformError(P, 'Campaign not deployed');
  if (status === 'ACTIVE') {
    // Activate children first so delivery starts the moment the campaign flips.
    for (const ad of objects(campaignId, 'ad')) if (ad.status !== 'PAUSED_BY_RULE') await call('POST', `/${ad.external_id}`, { status: 'ACTIVE' });
    for (const s of objects(campaignId, 'adset')) await call('POST', `/${s.external_id}`, { status: 'ACTIVE' });
    await call('POST', `/${camp.external_id}`, { status: 'ACTIVE' });
  } else {
    await call('POST', `/${camp.external_id}`, { status: status === 'ENDED' ? 'ARCHIVED' : 'PAUSED' });
  }
}

export async function setVariationStatus(campaignId, variationId, status) {
  const ad = objects(campaignId, 'ad').find((o) => o.variation_id === variationId);
  if (!ad) return false;
  await call('POST', `/${ad.external_id}`, { status });
  return ad.id;
}

export async function updateDailyBudget(campaignId, amount) {
  const conn = requireAccount(P);
  for (const s of objects(campaignId, 'adset')) await call('POST', `/${s.external_id}`, { daily_budget: toMinorUnits(amount, conn.currency) });
}

const CONVERSION_ACTIONS = new Set(['lead', 'purchase', 'offsite_conversion.fb_pixel_lead', 'offsite_conversion.fb_pixel_purchase', 'onsite_conversion.lead_grouped', 'complete_registration']);

export async function fetchMetrics(campaignId, since, until) {
  const [camp] = objects(campaignId, 'campaign');
  if (!camp) return [];
  const adToVariation = new Map(objects(campaignId, 'ad').map((o) => [o.external_id, o.variation_id]));
  const rows = await paged(`/${camp.external_id}/insights`, {
    level: 'ad', fields: 'ad_id,impressions,clicks,spend,reach,actions',
    time_range: { since, until }, time_increment: 1, limit: 500,
  });
  return rows.map((r) => ({
    date: r.date_start,
    variation_id: adToVariation.get(r.ad_id) ?? null,
    impressions: Number(r.impressions ?? 0),
    clicks: Number(r.clicks ?? 0),
    spend: Number(r.spend ?? 0),
    reach: Number(r.reach ?? 0),
    conversions: (r.actions ?? []).filter((a) => CONVERSION_ACTIONS.has(a.action_type)).reduce((s, a) => s + Number(a.value), 0),
  }));
}

/** Best-effort removal after a failed deploy. Deleting the campaign cascades to ad sets and ads. */
export async function cleanup(campaignId) {
  for (const c of objects(campaignId, 'campaign')) {
    try { await call('DELETE', `/${c.external_id}`); } catch (e) { console.error('[meta] cleanup failed', e.message); }
  }
}
