import { config } from '../config.js';
import { all } from '../db.js';
import { PlatformError, request } from './http.js';
import { getAccessToken, getConnection, requireAccount } from './connections.js';
import { fromMicros, toMicros } from './money.js';

const P = 'google';
const base = () => `https://googleads.googleapis.com/${config.google.apiVersion}`;

const extractError = (d) => {
  const e = d?.error;
  if (!e) return null;
  const detailed = (e.details ?? []).flatMap((x) => x.errors ?? []).map((x) => {
    const field = x.location?.fieldPathElements?.map((f) => f.fieldName).join('.');
    return `${x.message}${field ? ` (${field})` : ''}`;
  });
  return detailed.length ? detailed.join('; ') : e.message;
};

async function call(path, { method = 'POST', json, loginCustomerId } = {}) {
  const token = await getAccessToken(P);
  const headers = { Authorization: `Bearer ${token}`, 'developer-token': config.google.developerToken };
  const login = loginCustomerId ?? getConnection(P)?.extra?.login_customer_id ?? config.google.loginCustomerId;
  if (login) headers['login-customer-id'] = login;
  return request(P, `${base()}${path}`, { method, headers, json, extractError });
}

async function search(customerId, query, loginCustomerId) {
  const rows = [];
  let pageToken;
  do {
    const res = await call(`/customers/${customerId}/googleAds:search`, { json: { query, ...(pageToken && { pageToken }) }, loginCustomerId });
    rows.push(...(res.results ?? []));
    pageToken = res.nextPageToken;
  } while (pageToken);
  return rows;
}

const mutate = (cid, resource, operations) => call(`/customers/${cid}/${resource}:mutate`, { json: { operations } });

// ---------- OAuth ----------
export function oauthUrl(state, redirectUri) {
  const q = new URLSearchParams({
    client_id: config.google.clientId, redirect_uri: redirectUri, response_type: 'code', state,
    scope: 'https://www.googleapis.com/auth/adwords', access_type: 'offline', prompt: 'consent',
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${q}`;
}

export async function exchangeCode(code, redirectUri) {
  const d = await request(P, 'https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code, client_id: config.google.clientId, client_secret: config.google.clientSecret,
      redirect_uri: redirectUri, grant_type: 'authorization_code',
    }),
    extractError: (x) => x.error_description || x.error,
  });
  if (!d.refresh_token) throw new PlatformError(P, 'Google did not return a refresh token. Remove the app from your Google account permissions and connect again.');
  return { accessToken: d.access_token, refreshToken: d.refresh_token, expiresAt: null };
}

// ---------- Account setup ----------
export async function listAccounts() {
  const res = await call('/customers:listAccessibleCustomers', { method: 'GET', loginCustomerId: '' });
  const out = [];
  for (const rn of res.resourceNames ?? []) {
    const id = rn.split('/')[1];
    try {
      const [row] = await search(id, 'SELECT customer.id, customer.descriptive_name, customer.currency_code, customer.manager FROM customer LIMIT 1', id);
      if (!row) continue;
      if (row.customer.manager) {
        // Expand manager (MCC) accounts to their direct client accounts.
        const clients = await search(id, `SELECT customer_client.id, customer_client.descriptive_name, customer_client.currency_code, customer_client.manager
          FROM customer_client WHERE customer_client.level = 1 AND customer_client.status = 'ENABLED'`, id);
        for (const c of clients) {
          if (c.customerClient.manager) continue;
          out.push({ id: String(c.customerClient.id), name: c.customerClient.descriptiveName ?? String(c.customerClient.id), currency: c.customerClient.currencyCode, loginCustomerId: id, active: true });
        }
      } else {
        out.push({ id: String(row.customer.id), name: row.customer.descriptiveName ?? id, currency: row.customer.currencyCode, loginCustomerId: id, active: true });
      }
    } catch {}
  }
  const seen = new Set();
  return { accounts: out.filter((a) => (seen.has(a.id) ? false : seen.add(a.id))) };
}

export async function searchLocations(q) {
  const res = await call('/geoTargetConstants:suggest', { json: { locale: 'en', locationNames: { names: [q] } } });
  return (res.geoTargetConstantSuggestions ?? []).slice(0, 15).map((s) => ({
    key: s.geoTargetConstant.resourceName,
    type: String(s.geoTargetConstant.targetType ?? '').toLowerCase(),
    name: s.geoTargetConstant.canonicalName ?? s.geoTargetConstant.name,
    country: s.geoTargetConstant.countryCode,
  }));
}

// ---------- Validation (Google rejects RSA assets over these limits) ----------
export function validateVariation(v) {
  const problems = [];
  const hs = [...new Set(v.headlines.map((h) => h.trim()).filter(Boolean))];
  const ds = [...new Set(v.descriptions.map((d) => d.trim()).filter(Boolean))];
  if (hs.length < 3) problems.push('needs at least 3 unique headlines');
  if (ds.length < 2) problems.push('needs at least 2 unique descriptions');
  hs.forEach((h) => h.length > 30 && problems.push(`headline over 30 chars: "${h}"`));
  ds.forEach((d) => d.length > 90 && problems.push(`description over 90 chars: "${d}"`));
  return { problems, headlines: hs.slice(0, 15), descriptions: ds.slice(0, 4) };
}

// ---------- Deploy ----------
export async function deploy({ campaign, variations, dailyBudget, record }) {
  const conn = requireAccount(P);
  const cid = conn.account_id;
  const locs = campaign.locations.google ?? [];
  if (!locs.length) throw new PlatformError(P, 'No Google Ads locations selected for this campaign.');
  const keywords = (campaign.ai_strategy?.google_keywords ?? []).slice(0, 20);
  if (!keywords.length) throw new PlatformError(P, 'No keywords available. Regenerate the AI strategy.');
  const ads = variations.slice(0, 3); // Google allows at most 3 enabled RSAs per ad group.
  for (const v of ads) {
    const { problems } = validateVariation(v);
    if (problems.length) throw new PlatformError(P, `Variation "${v.label}": ${problems.join('; ')}`);
  }

  const budget = await mutate(cid, 'campaignBudgets', [{
    create: { name: `${campaign.name} budget #${campaign.id}-${Date.now()}`, amountMicros: String(toMicros(dailyBudget)), deliveryMethod: 'STANDARD', explicitlyShared: false },
  }]);
  const budgetRn = budget.results[0].resourceName;
  record('budget', budgetRn);

  const bidding = ['leads', 'sales'].includes(campaign.objective) ? { maximizeConversions: {} } : { targetSpend: {} };
  const camp = await mutate(cid, 'campaigns', [{
    create: {
      name: `${campaign.name} #${campaign.id}`,
      status: 'PAUSED',
      advertisingChannelType: 'SEARCH',
      campaignBudget: budgetRn,
      ...bidding,
      networkSettings: { targetGoogleSearch: true, targetSearchNetwork: true, targetContentNetwork: false, targetPartnerSearchNetwork: false },
      geoTargetTypeSetting: { positiveGeoTargetType: 'PRESENCE' },
      containsEuPoliticalAdvertising: 'DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING',
    },
  }]);
  const campRn = camp.results[0].resourceName;
  record('campaign', campRn);

  await mutate(cid, 'campaignCriteria', locs.map((l) => ({ create: { campaign: campRn, location: { geoTargetConstant: l.key } } })));

  const ag = await mutate(cid, 'adGroups', [{ create: { name: `${campaign.name} — ad group`, campaign: campRn, status: 'ENABLED', type: 'SEARCH_STANDARD' } }]);
  const agRn = ag.results[0].resourceName;
  record('ad_group', agRn);

  await mutate(cid, 'adGroupCriteria', keywords.map((k) => ({
    create: { adGroup: agRn, status: 'ENABLED', keyword: { text: k.slice(0, 80), matchType: 'PHRASE' } },
  })));

  for (const v of ads) {
    const { headlines, descriptions } = validateVariation(v);
    const res = await mutate(cid, 'adGroupAds', [{
      create: {
        adGroup: agRn, status: 'ENABLED',
        ad: {
          finalUrls: [campaign.landing_url],
          responsiveSearchAd: { headlines: headlines.map((text) => ({ text })), descriptions: descriptions.map((text) => ({ text })) },
        },
      },
    }]);
    record('ad', res.results[0].resourceName, v.id, 'ENABLED');
  }
  return { skippedVariations: variations.length - ads.length };
}

const objects = (campaignId, kind) => all('SELECT * FROM platform_objects WHERE campaign_id = ? AND platform = ? AND kind = ?', campaignId, P, kind);

export async function setCampaignStatus(campaignId, status) {
  const conn = requireAccount(P);
  const [camp] = objects(campaignId, 'campaign');
  if (!camp) throw new PlatformError(P, 'Campaign not deployed');
  // "Ended" pauses rather than removes, so history stays queryable and the action is reversible by an admin.
  await mutate(conn.account_id, 'campaigns', [{ update: { resourceName: camp.external_id, status: status === 'ACTIVE' ? 'ENABLED' : 'PAUSED' }, updateMask: 'status' }]);
}

export async function setVariationStatus(campaignId, variationId, status) {
  const conn = requireAccount(P);
  const ad = objects(campaignId, 'ad').find((o) => o.variation_id === variationId);
  if (!ad) return false;
  await mutate(conn.account_id, 'adGroupAds', [{ update: { resourceName: ad.external_id, status: status === 'ACTIVE' ? 'ENABLED' : 'PAUSED' }, updateMask: 'status' }]);
  return ad.id;
}

export async function updateDailyBudget(campaignId, amount) {
  const conn = requireAccount(P);
  const [b] = objects(campaignId, 'budget');
  if (!b) throw new PlatformError(P, 'Budget not found');
  await mutate(conn.account_id, 'campaignBudgets', [{ update: { resourceName: b.external_id, amountMicros: String(toMicros(amount)) }, updateMask: 'amountMicros' }]);
}

export async function fetchMetrics(campaignId, since, until) {
  const conn = requireAccount(P);
  const [camp] = objects(campaignId, 'campaign');
  if (!camp) return [];
  const adToVariation = new Map(objects(campaignId, 'ad').map((o) => [o.external_id, o.variation_id]));
  const rows = await search(conn.account_id, `
    SELECT ad_group_ad.resource_name, segments.date, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions
    FROM ad_group_ad
    WHERE campaign.resource_name = '${camp.external_id}' AND segments.date BETWEEN '${since}' AND '${until}'`);
  return rows.map((r) => ({
    date: r.segments.date,
    variation_id: adToVariation.get(r.adGroupAd.resourceName) ?? null,
    impressions: Number(r.metrics.impressions ?? 0),
    clicks: Number(r.metrics.clicks ?? 0),
    spend: fromMicros(r.metrics.costMicros),
    conversions: Number(r.metrics.conversions ?? 0),
    reach: null,
  }));
}

export async function cleanup(campaignId) {
  const conn = getConnection(P);
  if (!conn?.account_id) return;
  for (const [kind, resource] of [['campaign', 'campaigns'], ['budget', 'campaignBudgets']]) {
    for (const o of objects(campaignId, kind)) {
      try { await mutate(conn.account_id, resource, [{ remove: o.external_id }]); } catch {}
    }
  }
}
