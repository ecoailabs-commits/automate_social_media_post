// AI Automated Ads — single-page frontend (no build step). All API calls go to the same-origin backend;
// no platform credentials ever reach the browser.

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const PF = { meta: 'Meta', google: 'Google' };
const PF_FULL = { meta: 'Meta Ads', google: 'Google Ads' };
const CTA_LABEL = { LEARN_MORE: 'Learn more', SHOP_NOW: 'Shop now', SIGN_UP: 'Sign up', CONTACT_US: 'Contact us', GET_QUOTE: 'Get quote', DOWNLOAD: 'Download', APPLY_NOW: 'Apply now', SUBSCRIBE: 'Subscribe' };
const RANK = { editor: 1, manager: 2, admin: 3 };
const state = { user: null };
const can = (role) => state.user && RANK[state.user.role] >= RANK[role];

// ---------- helpers ----------
async function api(path, { method = 'GET', body, form } = {}) {
  const init = { method, headers: { 'X-Requested-With': 'ads-app' }, credentials: 'same-origin' };
  if (form) init.body = form;
  else if (body !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body); }
  const idempotent = !['POST', 'PUT', 'DELETE', 'PATCH'].includes(method);
  for (let attempt = 0; ; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 30000);
    try {
      const res = await fetch(`/api${path}`, { ...init, signal: ctrl.signal });
      clearTimeout(timer);
      const data = res.headers.get('content-type')?.includes('json') ? await res.json() : null;
      if (res.status === 401 && path !== '/auth/login' && path !== '/auth/me') { state.user = null; render(); }
      if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`);
      return data;
    } catch (e) {
      clearTimeout(timer);
      const netFail = e.name === 'AbortError' || e.name === 'TypeError' || /NetworkError|fetch failed|Failed to fetch/i.test(String(e.message));
      if (netFail && idempotent && attempt < 2) { await new Promise((r) => setTimeout(r, 1500)); continue; } // transient: server restarting / one-off timeout
      throw new Error(netFail
        ? 'Server ka jawab nahi aaya (server band hai ya abhi restart hua). 2–3 sec baad dobara try karo; agar bar-bar aaye to mujhe batao.'
        : e.message);
    }
  }
}

function toast(msg, level = 'info', ms = 6000) {
  const el = document.createElement('div');
  el.className = `toast ${level}`;
  el.textContent = msg;
  $('#toasts').append(el);
  setTimeout(() => el.remove(), ms);
}

async function busy(btn, fn, label) {
  const old = btn?.innerHTML;
  if (btn) { btn.disabled = true; btn.innerHTML = `<span class="spinner"></span> ${esc(label ?? 'Working…')}`; }
  try { return await fn(); } catch (e) { toast(e.message, 'error', 12000); throw e; } finally { if (btn && btn.isConnected) { btn.disabled = false; btn.innerHTML = old; } }
}

const money = (n, cur = '') => `${cur ? cur + ' ' : ''}${Number(n ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const num = (n) => Number(n ?? 0).toLocaleString();
const pct = (n) => `${Number(n ?? 0).toFixed(2)}%`;
const dt = (s) => (s ? new Date(/Z|[+-]\d\d:?\d\d$/.test(s) ? s : s.replace(' ', 'T') + 'Z').toLocaleString() : '—');
const badge = (s) => `<span class="badge ${esc(s)}">${esc(String(s).replace(/_/g, ' '))}</span>`;
const pfTag = (p) => `<span class="pf ${p}">${PF[p]}</span>`;
const toLocalInput = (d) => { const x = new Date(d); x.setMinutes(x.getMinutes() - x.getTimezoneOffset()); return x.toISOString().slice(0, 16); };

function lineChart(rows, { y1 = 'spend', y2 = 'clicks', c1 = '#4f46e5', c2 = '#059669' } = {}) {
  if (!rows.length) return '<div class="empty">No data yet</div>';
  const W = 800, H = 220, P = 34;
  const max1 = Math.max(...rows.map((r) => r[y1]), 1), max2 = Math.max(...rows.map((r) => r[y2]), 1);
  const x = (i) => P + (rows.length === 1 ? (W - 2 * P) / 2 : (i * (W - 2 * P)) / (rows.length - 1));
  const bw = Math.max(2, (W - 2 * P) / rows.length * 0.6);
  const bars = rows.map((r, i) => { const h = (r[y1] / max1) * (H - 2 * P); return `<rect x="${x(i) - bw / 2}" y="${H - P - h}" width="${bw}" height="${h}" fill="${c1}" opacity=".75"><title>${esc(r.date)}: ${y1} ${r[y1]}</title></rect>`; }).join('');
  const line = rows.map((r, i) => `${i ? 'L' : 'M'}${x(i)},${H - P - (r[y2] / max2) * (H - 2 * P)}`).join(' ');
  const step = Math.ceil(rows.length / 8);
  const labels = rows.map((r, i) => (i % step === 0 ? `<text x="${x(i)}" y="${H - 10}" text-anchor="middle">${esc(r.date.slice(5))}</text>` : '')).join('');
  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Daily ${y1} and ${y2}">
    <line class="axis" x1="${P}" y1="${H - P}" x2="${W - P}" y2="${H - P}"/>
    <text x="${P}" y="14">${esc(y1)} max ${Number(max1).toFixed(2)}</text><text x="${W - P}" y="14" text-anchor="end">${esc(y2)} max ${num(max2)}</text>
    ${bars}<path d="${line}" fill="none" stroke="${c2}" stroke-width="2.5"/>${labels}</svg>
    <div class="legend"><span><i style="background:${c1}"></i>${esc(y1)}</span><span><i style="background:${c2}"></i>${esc(y2)}</span></div>`;
}

// ---------- shell & router ----------
const NAV = [
  ['#/dashboard', 'Dashboard'], ['#/campaigns/new', 'New campaign'], ['#/page-post', 'Page post'], ['#/connections', 'Connections'],
  ['#/notifications', 'Notifications'], ['#/audit', 'Audit log', 'manager'], ['#/settings', 'Settings'],
];

function shell(active) {
  $('#app').innerHTML = `<div class="layout">
    <aside class="side">
      <div class="brand">AI <span>Automated</span> Ads</div>
      <nav class="nav">${NAV.filter(([, , r]) => !r || can(r)).map(([h, l]) => `<a href="${h}" class="${active === h ? 'active' : ''}">${l}${h === '#/notifications' ? '<span id="unread"></span>' : ''}</a>`).join('')}</nav>
      <div class="me"><div><b>${esc(state.user.name)}</b></div><div class="muted">${esc(state.user.email)} · ${esc(state.user.role)}</div><a href="#" id="logout">Sign out</a></div>
    </aside>
    <main id="main"><div class="empty"><span class="spinner"></span></div></main>
  </div>`;
  $('#logout').onclick = async (e) => { e.preventDefault(); await api('/auth/logout', { method: 'POST' }); state.user = null; render(); };
  api('/notifications?limit=1').then((d) => { if (d.unread) $('#unread').innerHTML = `<span class="badge error">${d.unread}</span>`; }).catch(() => {});
}

async function render() {
  if (!state.user) {
    try { state.user = await api('/auth/me'); } catch { return loginView(); }
  }
  const [path, query] = (location.hash || '#/dashboard').split('?');
  const params = new URLSearchParams(query);
  const m = path.match(/^#\/campaigns\/(\d+)$/);
  const em = path.match(/^#\/campaigns\/(\d+)\/(edit|copy)$/);
  const active = m || em ? '#/dashboard' : path;
  shell(active);
  const main = $('#main');
  try {
    if (path === '#/campaigns/new') await newCampaignView(main);
    else if (em) await newCampaignView(main, await api(`/campaigns/${em[1]}`).then((d) => ({ ...d.campaign, metaMinDaily: d.metaMinDaily })), em[2]);
    else if (m) await campaignView(main, Number(m[1]), params);
    else if (path === '#/connections') await connectionsView(main, params);
    else if (path === '#/page-post') await pagePostView(main);
    else if (path === '#/notifications') await notificationsView(main);
    else if (path === '#/audit') await auditView(main);
    else if (path === '#/settings') await settingsView(main);
    else await dashboardView(main);
  } catch (e) {
    main.innerHTML = `<div class="banner err">${esc(e.message)}</div>`;
  }
}
window.addEventListener('hashchange', render);

function loginView() {
  $('#app').innerHTML = `<div class="login card">
    <h1>AI Automated Ads</h1><p class="muted">Sign in to manage campaigns.</p>
    <form id="lf"><div class="field"><label>Email</label><input name="email" type="email" required autocomplete="username"></div>
    <div class="field"><label>Password</label><input name="password" type="password" required autocomplete="current-password"></div>
    <button class="primary" type="submit">Sign in</button></form></div>`;
  $('#lf').onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    await busy(e.submitter, async () => {
      state.user = await api('/auth/login', { method: 'POST', body: { email: f.get('email'), password: f.get('password') } });
      render();
    }, 'Signing in…').catch(() => {});
  };
}

// ---------- dashboard ----------
async function dashboardView(main) {
  const [d, list] = await Promise.all([api('/dashboard'), api('/campaigns')]);
  const t = d.totals;
  main.innerHTML = `
    <div class="head"><div><h1>Dashboard</h1><div class="muted">Live data from your connected ad accounts</div></div>
      <div class="actions"><a class="btn primary" href="#/campaigns/new" style="background:var(--primary);color:#fff">+ New AI campaign</a></div></div>
    ${d.aiConfigured ? '' : '<div class="banner warn">No AI key is set on the server (GROQ_API_KEY or ANTHROPIC_API_KEY) — AI generation and optimisation are disabled.</div>'}
    <div class="grid g5">
      ${[['Spend (all)', money(t.spend)], ['Impressions', num(t.impressions)], ['Clicks', num(t.clicks)], ['CTR', pct(t.ctr)], ['Conversions', num(t.conversions)]]
        .map(([l, v]) => `<div class="card kpi"><div class="l">${l}</div><div class="v">${v}</div></div>`).join('')}
    </div>
    <div class="grid g2">
      <div class="card chart"><h2>Last 30 days</h2>${lineChart(d.last30)}</div>
      <div class="card"><h2>Status</h2>
        <div class="actions">${['draft', 'generated', 'approved', 'scheduled', 'active', 'paused', 'ended'].map((s) => `<span>${badge(s)} ${d.counts[s] ?? 0}</span>`).join('')}</div>
        <p class="muted">${d.openSuggestions} open AI suggestion(s) · ${d.unread} unread notification(s)</p>
        <h3>By platform</h3>
        <table><tr><th>Platform</th><th class="num">Spend</th><th class="num">Clicks</th><th class="num">CTR</th></tr>
        ${d.byPlatform.map((p) => `<tr><td>${pfTag(p.platform)}</td><td class="num">${money(p.spend)}</td><td class="num">${num(p.clicks)}</td><td class="num">${pct(p.ctr)}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">No delivery yet</td></tr>'}</table>
      </div>
    </div>
    <div class="card"><h2>Campaigns</h2>
      ${list.length ? `<table><tr><th>Name</th><th>Platforms</th><th>Status</th><th>Flight</th><th class="num">Budget</th><th class="num">Spend</th><th class="num">Clicks</th><th class="num">Conv.</th></tr>
      ${list.map((c) => `<tr class="click" data-href="#/campaigns/${c.id}"><td><b>${esc(c.name)}</b><div class="muted small">${esc(c.objective)}${c.last_error ? ' · <span style="color:var(--err)">error</span>' : ''}</div></td>
        <td>${c.platforms.map(pfTag).join('')}</td><td>${badge(c.status)}</td><td class="small">${dt(c.start_at)}<br>${dt(c.end_at)}</td>
        <td class="num">${money(c.total_budget, c.currency)}</td><td class="num">${money(c.spend)}</td><td class="num">${num(c.clicks)}</td><td class="num">${num(c.conversions)}</td></tr>`).join('')}</table>`
        : '<div class="empty">No campaigns yet. <a href="#/campaigns/new">Create your first AI campaign</a>.</div>'}
    </div>`;
  $$('tr[data-href]', main).forEach((tr) => (tr.onclick = () => (location.hash = tr.dataset.href)));
}

// ---------- location picker ----------
function locationPicker(container, platform, selected) {
  container.innerHTML = `<div class="dropdown"><input placeholder="Search ${PF[platform]} locations (city, region, country)…" data-pf="${platform}"><div class="menu" hidden></div></div><div class="chips"></div>`;
  const input = $('input', container), menu = $('.menu', container), chips = $('.chips', container);
  const draw = () => {
    chips.innerHTML = selected.map((l, i) => `<span class="chip">${esc(l.name)} <span class="muted small">${esc(l.type)}</span><button type="button" data-i="${i}" aria-label="Remove">×</button></span>`).join('');
    $$('button', chips).forEach((b) => (b.onclick = () => { selected.splice(Number(b.dataset.i), 1); draw(); }));
  };
  let timer;
  input.oninput = () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 2) { menu.hidden = true; return; }
    timer = setTimeout(async () => {
      try {
        const res = await api(`/connections/${platform}/locations?q=${encodeURIComponent(q)}`);
        menu.innerHTML = res.length ? res.map((l, i) => `<div data-i="${i}">${esc(l.name)} <span class="muted small">${esc(l.type)}</span></div>`).join('') : '<div class="muted">No matches</div>';
        menu.hidden = false;
        $$('div[data-i]', menu).forEach((d) => (d.onclick = () => {
          const l = res[Number(d.dataset.i)];
          if (!selected.some((s) => s.key === l.key)) selected.push(l);
          menu.hidden = true; input.value = ''; draw();
        }));
      } catch (e) { toast(e.message, 'error'); }
    }, 300);
  };
  input.onblur = () => setTimeout(() => (menu.hidden = true), 200);
  draw();
}

// ---------- new / edit / duplicate campaign ----------
// mode: undefined = new, 'edit' = change an undeployed campaign, 'copy' = new campaign prefilled from `src`.
async function newCampaignView(main, src = null, mode) {
  const conns = await api('/connections');
  const connected = conns.filter((c) => c.status === 'connected');
  const editing = mode === 'edit';
  if (editing && !['draft', 'generated', 'approved'].includes(src.status)) {
    main.innerHTML = `<div class="banner warn">This campaign is ${esc(src.status)} and already on the platforms, so its settings can't be edited. <a href="#/campaigns/${src.id}/copy">Duplicate it with new settings</a> instead, or change the daily budget on the Rules &amp; budget tab.</div>`;
    return;
  }
  // An edit keeps its dates unless they have expired; a copy gets fresh ones.
  const keepDates = editing && new Date(src.end_at) > new Date();
  const now = keepDates ? new Date(src.start_at) : new Date(Date.now() + 60 * 60e3);
  const end = keepDates ? new Date(src.end_at) : new Date(Date.now() + 15 * 864e5);
  const locations = { meta: [...(src?.locations?.meta ?? [])], google: [...(src?.locations?.google ?? [])] };
  const title = editing ? `Edit “${esc(src.name)}”` : src ? `Duplicate “${esc(src.name)}”` : 'New AI campaign';
  const intro = editing
    ? 'Fix any setting that stopped the ads from running (budget, dates, locations, ages, objective, platforms…). Existing ads are kept unless you choose to regenerate them.'
    : "Describe what you're advertising — AI writes the copy, headlines, CTAs and creatives. Nothing goes live until it's approved and deployed.";

  main.innerHTML = `
    <div class="head"><div>${src ? `<a href="#/campaigns/${src.id}" class="small">← Back to campaign</a>` : ''}<h1>${title}</h1><div class="muted">${intro}</div></div></div>
    ${connected.length ? '' : '<div class="banner warn">No ad platforms are connected yet. <a href="#/connections">Connect Meta or Google</a> before creating a campaign.</div>'}
    ${editing && src.status === 'approved' ? '<div class="banner warn">This campaign is approved. Saving changes revokes the approval, so a manager will need to approve it again before deploying.</div>' : ''}
    ${src?.last_error ? `<div class="banner err"><b>Last error:</b> ${esc(src.last_error)}</div>` : ''}
    <form id="cf">
      <div class="card"><h2>1 · What are you promoting?</h2>
        <div class="grid g2">
          <div class="field"><label>Product / service *</label><input name="product" required maxlength="200" placeholder="e.g. Doorstep car servicing in Gurgaon"></div>
          <div class="field"><label>Campaign name</label><input name="name" maxlength="120" placeholder="Defaults to product name"></div>
        </div>
        <div class="field"><label>Details, offer, differentiators</label><textarea name="description" placeholder="Prices, offers, USPs, proof points. AI will only use facts you give here."></textarea></div>
        <div class="grid g2">
          <div class="field"><label>Landing page URL *</label><input name="landing_url" type="url" required placeholder="https://"></div>
          <div class="field"><label>Product photo (optional, used in creatives)</label><input type="file" id="pimg" accept="image/png,image/jpeg"><input type="hidden" name="product_image"></div>
        </div>
        <div class="grid g3">
          <div class="field"><label>Brand tone</label><input name="tone" placeholder="e.g. friendly, premium, urgent"></div>
          <div class="field"><label>Copy language</label><input name="language" value="English"></div>
          <div class="field"><label>Variations to generate</label><select name="variation_count"><option>2</option><option selected>3</option><option>4</option><option>5</option></select></div>
        </div>
      </div>
      <div class="card"><h2>2 · Who should see it?</h2>
        <div class="field"><label>Target audience *</label><textarea name="audience" required placeholder="e.g. Car owners aged 28-50, working professionals, value convenience"></textarea></div>
        <div class="grid g3"><div class="field"><label>Objective *</label><select name="objective">
          <option value="traffic">Website traffic</option><option value="leads">Leads</option><option value="sales">Sales</option><option value="awareness">Awareness</option><option value="engagement">Engagement</option></select>
          <div class="hint">Leads/Sales on Meta need a Pixel selected on Connections.</div></div>
          <div class="field"><label>Age min</label><input name="age_min" type="number" min="18" max="65" value="18"></div>
          <div class="field"><label>Age max</label><input name="age_max" type="number" min="18" max="65" value="65"></div>
        </div>
      </div>
      <div class="card"><h2>3 · Platforms & locations</h2>
        <div class="field">${conns.map((c) => `<label class="check"><input type="checkbox" name="pf" value="${c.platform}" ${c.status === 'connected' ? '' : 'disabled'}> ${PF_FULL[c.platform]} ${c.status === 'connected' ? `<span class="muted small">(${esc(c.accountName)}, ${esc(c.currency)})</span>` : '<span class="muted small">(not connected)</span>'}</label>`).join('')}</div>
        <div id="locs"></div>
      </div>
      <div class="card"><h2>4 · Budget & schedule</h2>
        <div class="grid g3">
          <div class="field"><label>Total budget *</label><input name="total_budget" type="number" min="1" step="0.01" required></div>
          <div class="field"><label>Start *</label><input name="start_at" type="datetime-local" value="${toLocalInput(now)}" required></div>
          <div class="field"><label>End *</label><input name="end_at" type="datetime-local" value="${toLocalInput(end)}" required></div>
        </div>
        <div id="split"></div>
        <div class="hint" id="budgetHint"></div>
      </div>
      ${editing ? `<div class="actions"><button class="primary" type="submit">Save changes</button><label class="check"><input type="checkbox" name="regen" ${src.status === 'draft' ? 'checked' : ''}> Regenerate ads with AI after saving</label><a href="#/campaigns/${src.id}" class="small">Cancel</a></div>`
        : `<div class="actions"><button class="primary" type="submit">Create & generate with AI</button><span class="muted small">You'll review every ad before anything is deployed.</span></div>`}
    </form>`;

  const form = $('#cf');
  if (src) {
    for (const n of ['product', 'name', 'description', 'landing_url', 'tone', 'language', 'audience', 'objective', 'age_min', 'age_max', 'total_budget', 'product_image']) {
      if (src[n] != null && form[n]) form[n].value = src[n];
    }
    form.variation_count.value = String(src.variation_count ?? 3);
    if (!editing) form.name.value = `${src.name} (copy)`.slice(0, 120);
    $$('input[name=pf]', form).forEach((i) => (i.checked = src.platforms.includes(i.value) && !i.disabled));
  }
  const selectedPfs = () => $$('input[name=pf]:checked', form).map((i) => i.value);
  const drawPlatforms = () => {
    const pfs = selectedPfs();
    $('#locs').innerHTML = pfs.map((p) => `<div class="field"><label>${PF_FULL[p]} locations *</label><div data-loc="${p}"></div></div>`).join('') || '<div class="muted">Select at least one platform.</div>';
    pfs.forEach((p) => locationPicker($(`[data-loc=${p}]`), p, locations[p]));
    const even = pfs.length ? Math.floor(100 / pfs.length) : 0;
    $('#split').innerHTML = pfs.length > 1 ? `<label>Budget split (%)</label><div class="grid g3">${pfs.map((p, i) => `<div>${pfTag(p)}<input type="number" min="0" max="100" data-split="${p}" value="${src?.budget_split?.[p] ?? (i === 0 ? 100 - even * (pfs.length - 1) : even)}"></div>`).join('')}</div>` : '';
    updateHint();
  };
  // Meta reports its minimum daily ad set budget in the deploy error ("must be more than ₹96.73").
  const metaMinDaily = src?.metaMinDaily || Number((src?.last_error?.match(/budget must be more than\D*([\d,]+(?:\.\d+)?)/) ?? [])[1]?.replace(/,/g, '')) || 0;
  const updateHint = () => {
    const total = Number(form.total_budget.value), s = new Date(form.start_at.value), e = new Date(form.end_at.value);
    const days = Math.max(1, Math.ceil((e - s) / 864e5));
    const hint = $('#budgetHint');
    hint.textContent = total > 0 && e > s ? `≈ ${money(total / days)} per day over ${days} day(s). Spend is hard-stopped when the total is reached.` : '';
    hint.style.color = '';
    if (!metaMinDaily || !selectedPfs().includes('meta') || !(e > s)) return;
    const share = (selectedPfs().length > 1 ? Number($('[data-split=meta]')?.value) || 0 : 100) / 100;
    if (share > 0 && (total / days) * share > metaMinDaily) return;
    // Round up a little above Meta's minimum so small rounding never trips it again.
    const needed = share > 0 ? Math.ceil((metaMinDaily * 1.03 * days) / share / 10) * 10 : 0;
    hint.style.color = 'var(--err)';
    hint.innerHTML = `⚠ Meta needs more than ${esc(money(metaMinDaily))} per day. For ${days} day(s) set the total budget to at least <b>${esc(money(needed))}</b>, or shorten the dates.
      <button type="button" id="fixBudget">Set total to ${esc(money(needed))}</button>`;
    $('#fixBudget').onclick = () => { form.total_budget.value = needed; updateHint(); };
  };
  $$('input[name=pf]', form).forEach((i) => (i.onchange = drawPlatforms));
  ['total_budget', 'start_at', 'end_at'].forEach((n) => form[n].addEventListener('input', updateHint));
  form.addEventListener('input', (e) => { if (e.target.dataset.split) updateHint(); });
  drawPlatforms();

  $('#pimg').onchange = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    const fd = new FormData(); fd.append('file', f);
    try { const r = await api('/uploads/product', { method: 'POST', form: fd }); form.product_image.value = r.file; toast('Photo uploaded', 'success'); }
    catch (err) { toast(err.message, 'error'); e.target.value = ''; }
  };

  form.onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(form);
    const pfs = selectedPfs();
    const budget_split = {};
    pfs.forEach((p) => (budget_split[p] = pfs.length === 1 ? 100 : Number($(`[data-split=${p}]`).value)));
    const body = {
      ...Object.fromEntries(f.entries()),
      platforms: pfs, budget_split,
      locations: Object.fromEntries(pfs.map((p) => [p, locations[p]])),
      start_at: new Date(f.get('start_at')).toISOString(), end_at: new Date(f.get('end_at')).toISOString(),
    };
    if (editing) {
      const regen = form.regen.checked;
      delete body.regen;
      await busy(e.submitter, async () => {
        await api(`/campaigns/${src.id}`, { method: 'PUT', body });
        toast(src.status === 'approved' ? 'Saved — approval revoked, re-approve before deploying' : 'Changes saved', 'success');
        if (regen) {
          try {
            const g = await api(`/campaigns/${src.id}/generate`, { method: 'POST', body: {} });
            if (g.warnings?.length) toast(`AI notes:\n${g.warnings.join('\n')}`, 'warning', 12000);
          } catch (err) { toast(`Generation failed: ${err.message}. You can retry from the campaign page.`, 'error', 12000); }
        }
        location.hash = `#/campaigns/${src.id}`;
      }, regen ? 'Saving & regenerating (≈30–90s)…' : 'Saving…').catch(() => {});
      return;
    }
    await busy(e.submitter, async () => {
      const c = await api('/campaigns', { method: 'POST', body });
      toast('Campaign created. Generating ads with AI…');
      try {
        const g = await api(`/campaigns/${c.id}/generate`, { method: 'POST', body: {} });
        if (g.warnings?.length) toast(`AI notes:\n${g.warnings.join('\n')}`, 'warning', 12000);
      } catch (err) { toast(`Generation failed: ${err.message}. You can retry from the campaign page.`, 'error', 12000); }
      location.hash = `#/campaigns/${c.id}`;
    }, 'Creating & generating (≈30–90s)…').catch(() => {});
  };
}

// ---------- campaign detail ----------
const FLOW = [['generated', 'Preview'], ['approved', 'Approved'], ['scheduled', 'Deployed'], ['active', 'Live'], ['ended', 'Ended']];
const FLOW_INDEX = { draft: -1, generated: 0, approved: 1, deploying: 1, scheduled: 2, active: 3, paused: 3, ended: 4 };

async function campaignView(main, id, params) {
  const d = await api(`/campaigns/${id}`);
  const c = d.campaign;
  const tab = params.get('tab') || (['active', 'paused', 'ended'].includes(c.status) ? 'analytics' : 'ads');
  const deployed = d.objects.length > 0;
  const fi = FLOW_INDEX[c.status] ?? -1;

  const btns = [];
  if (['draft', 'generated', 'approved'].includes(c.status)) btns.push(`<button data-act="generate">${c.status === 'draft' ? '✨ Generate ads with AI' : '↻ Regenerate all'}</button>`);
  if (c.status === 'generated' && can('manager')) btns.push('<button class="ok" data-act="approve">✓ Approve</button>');
  if (c.status === 'approved' && can('manager')) btns.push('<button data-act="unapprove">Revoke approval</button>', '<button class="primary" data-act="deploy">🚀 Deploy to platforms</button>');
  if (c.status === 'scheduled' && can('manager')) btns.push('<button class="primary" data-act="status" data-s="active">Go live now</button>');
  if (c.status === 'paused' && can('manager')) btns.push('<button class="primary" data-act="status" data-s="active">Resume</button>');
  if (['active', 'scheduled'].includes(c.status) && can('manager')) btns.push('<button data-act="status" data-s="paused">Pause</button>');
  if (['active', 'paused', 'scheduled'].includes(c.status) && can('manager')) btns.push('<button class="danger" data-act="status" data-s="ended">End campaign</button>');
  if (['draft', 'generated', 'approved'].includes(c.status)) btns.push(`<a class="btn" href="#/campaigns/${id}/edit">✎ Edit settings</a>`);
  else btns.push(`<a class="btn" href="#/campaigns/${id}/copy">⧉ Duplicate &amp; edit</a>`);
  if (!deployed && can('manager')) btns.push('<button class="danger" data-act="delete">Delete</button>');

  main.innerHTML = `
    <div class="head"><div><a href="#/dashboard" class="small">← Dashboard</a><h1>${esc(c.name)} ${badge(c.status)}</h1>
      <div class="muted">${c.platforms.map(pfTag).join('')} ${esc(c.objective)} · ${money(c.total_budget, c.currency)} total (${money(c.daily_budget)}/day) · ${dt(c.start_at)} → ${dt(c.end_at)}</div></div>
      <div class="actions">${btns.join('')}</div></div>
    <div class="flow">${FLOW.map(([, l], i) => `<div class="step ${i < fi ? 'done' : i === fi ? 'now' : ''}">${i < fi ? '✓ ' : ''}${l}</div>`).join('')}</div>
    ${c.last_error ? `<div class="banner err"><b>Last error:</b> ${esc(c.last_error)} ${['draft', 'generated', 'approved'].includes(c.status) ? `<a href="#/campaigns/${id}/edit">Edit settings</a>` : `<a href="#/campaigns/${id}/copy">Duplicate &amp; edit</a>`}</div>` : ''}
    ${d.preflight.length && c.status !== 'draft' ? `<div class="banner warn"><b>Fix before approval/deploy:</b><br>${d.preflight.map(esc).join('<br>')}</div>` : ''}
    ${d.approver ? `<div class="banner info">Approved by ${esc(d.approver.name)} (${esc(d.approver.email)}) at ${dt(c.approved_at)}. Any edit revokes approval.</div>` : ''}
    ${c.status === 'scheduled' ? `<div class="banner info">Deployed and paused on all platforms. Goes live automatically at ${dt(c.start_at)}.</div>` : ''}
    <div class="tabs">${[['ads', 'Ads & preview'], ['strategy', 'Targeting'], ['analytics', 'Analytics'], ['rules', 'Rules & budget'], ['ai', 'AI suggestions'], ['activity', 'Activity']]
      .map(([k, l]) => `<button data-tab="${k}" class="${tab === k ? 'on' : ''}">${l}</button>`).join('')}</div>
    <div id="tab"></div>`;

  $$('[data-tab]', main).forEach((b) => (b.onclick = () => (location.hash = `#/campaigns/${id}?tab=${b.dataset.tab}`)));
  const reload = () => render();

  $$('[data-act]', main.querySelector('.head')).forEach((b) => (b.onclick = async () => {
    const act = b.dataset.act;
    if (act === 'generate') {
      if (c.status !== 'draft' && !confirm('Replace all current variations with new AI-generated ones?')) return;
      await busy(b, async () => { const g = await api(`/campaigns/${id}/generate`, { method: 'POST', body: {} }); if (g.warnings?.length) toast(g.warnings.join('\n'), 'warning'); toast('Ads generated', 'success'); reload(); }, 'Generating (≈30–90s)…').catch(() => {});
    } else if (act === 'approve') {
      if (!confirm(`Approve "${c.name}" for deployment with a total budget of ${money(c.total_budget, c.currency)}?`)) return;
      await busy(b, async () => { await api(`/campaigns/${id}/approve`, { method: 'POST' }); toast('Approved', 'success'); reload(); }).catch(() => {});
    } else if (act === 'unapprove') {
      await busy(b, async () => { await api(`/campaigns/${id}/unapprove`, { method: 'POST' }); reload(); }).catch(() => {});
    } else if (act === 'deploy') {
      if (!confirm(`Deploy to ${c.platforms.map((p) => PF_FULL[p]).join(', ')}?\n\nThis creates REAL campaigns in your ad accounts. They are created paused and go live at ${dt(c.start_at)}. Spend up to ${money(c.total_budget, c.currency)} will be charged by the platforms.`)) return;
      await busy(b, async () => { await api(`/campaigns/${id}/deploy`, { method: 'POST' }); toast('Deployed successfully', 'success'); reload(); }, 'Deploying…').catch(() => reload());
    } else if (act === 'status') {
      const s = b.dataset.s;
      if (s === 'ended' && !confirm('End this campaign on all platforms? This cannot be undone.')) return;
      if (s === 'active' && !confirm('Start delivering (and spending) now?')) return;
      await busy(b, async () => { await api(`/campaigns/${id}/status`, { method: 'POST', body: { status: s } }); toast(`Campaign ${s}`, 'success'); reload(); }).catch(() => reload());
    } else if (act === 'delete') {
      if (!confirm('Delete this campaign permanently?')) return;
      await busy(b, async () => { await api(`/campaigns/${id}`, { method: 'DELETE' }); location.hash = '#/dashboard'; }).catch(() => {});
    }
  }));

  const el = $('#tab');
  ({ ads: adsTab, strategy: strategyTab, analytics: analyticsTab, rules: rulesTab, ai: aiTab, activity: activityTab }[tab] ?? adsTab)(el, d, reload);
}

function adPreviews(c, v) {
  const h = v.headlines, ds = v.descriptions;
  const host = (() => { try { return new URL(c.landing_url).host; } catch { return c.landing_url; } })();
  const img = (f) => (f ? `<img src="/api/files/creatives/${encodeURIComponent(f)}" alt="Creative" loading="lazy">` : '<div class="empty">No creative</div>');
  const parts = [];
  if (c.platforms.includes('meta')) parts.push(`<div><div class="pv-label">Meta feed</div><div class="pv">
    <div class="pv-top"><div class="avatar"></div><div><div class="name">${esc(c.product.slice(0, 40))}</div><div class="sp">Sponsored</div></div></div>
    <div class="body">${esc(v.primary_text)}</div>${img(v.creative_square)}
    <div class="foot"><div><div class="sp">${esc(host.toUpperCase())}</div><div class="h">${esc(h[0])}</div><div class="d">${esc(ds[0])}</div></div><div class="cta">${CTA_LABEL[v.cta]}</div></div></div></div>`);
  if (c.platforms.includes('google')) parts.push(`<div><div class="pv-label">Google search</div><div class="pv g">
    <div class="sp"><b>Sponsored</b> · ${esc(host)}</div><div class="gh">${esc(h.slice(0, 3).join(' | '))}</div><div class="gd">${esc(ds.slice(0, 2).join(' '))}</div>
    <div class="sp" style="margin-top:8px;color:#70757a">Google rotates ${h.length} headlines × ${ds.length} descriptions</div></div></div>`);
  return `<div class="previews">${parts.join('')}</div>`;
}

function adsTab(el, d, reload) {
  const c = d.campaign;
  const editable = ['draft', 'generated', 'approved'].includes(c.status);
  const deployed = d.objects.length > 0;
  if (!d.variations.length) {
    el.innerHTML = `<div class="empty">No ads yet. Click <b>Generate ads with AI</b> above.</div>`;
    return;
  }
  el.innerHTML = d.variations.map((v) => {
    const obj = d.objects.find((o) => o.variation_id === v.id && o.status);
    const paused = obj?.status === 'PAUSED_BY_RULE';
    return `<div class="var ${v.selected ? '' : 'off'}" data-v="${v.id}">
      <div class="var-head"><div><b>${esc(v.label)}</b> ${paused ? badge('paused') : ''}<div class="muted small">${esc(v.angle ?? '')}</div></div>
        <div class="actions">
          ${editable ? `<label class="check"><input type="checkbox" data-sel ${v.selected ? 'checked' : ''}> Include</label>
          <button class="sm" data-edit>Edit</button><button class="sm" data-regen>✨ Rewrite</button>
          <label class="btn sm" style="margin:0">Upload creative (1080×1080 PNG)<input type="file" accept="image/png" data-up hidden></label>` : ''}
          ${c.platforms.includes('meta') && v.creative_square ? '<button class="sm" data-metaprev>Live Meta preview</button>' : ''}
          ${deployed && can('manager') && ['active', 'paused', 'scheduled'].includes(c.status) && v.selected ? `<button class="sm" data-live="${paused ? 1 : 0}">${paused ? 'Resume ad' : 'Pause ad'}</button>` : ''}
        </div></div>
      ${adPreviews(c, v)}
      <details style="margin-top:10px"><summary class="small muted">All headlines (${v.headlines.length}) & descriptions (${v.descriptions.length})</summary>
        <div class="grid g2" style="margin-top:8px"><ol class="small">${v.headlines.map((x) => `<li>${esc(x)} <span class="muted">(${x.length})</span></li>`).join('')}</ol>
        <ol class="small">${v.descriptions.map((x) => `<li>${esc(x)} <span class="muted">(${x.length})</span></li>`).join('')}</ol></div></details>
    </div>`;
  }).join('') + '<dialog id="dlg"></dialog>';

  for (const card of $$('[data-v]', el)) {
    const v = d.variations.find((x) => x.id === Number(card.dataset.v));
    const base = `/campaigns/${c.id}/variations/${v.id}`;
    $('[data-sel]', card)?.addEventListener('change', async (e) => { try { await api(`${base}/select`, { method: 'POST', body: { selected: e.target.checked } }); reload(); } catch (err) { toast(err.message, 'error'); } });
    $('[data-edit]', card)?.addEventListener('click', () => editDialog(c, v, reload));
    $('[data-regen]', card)?.addEventListener('click', async (e) => {
      const guidance = prompt('Optional guidance for the rewrite (e.g. "more urgency", "mention free pickup"):', '');
      if (guidance === null) return;
      await busy(e.target, async () => { await api(`${base}/regenerate`, { method: 'POST', body: { guidance } }); toast('Variation rewritten', 'success'); reload(); }, 'Rewriting…').catch(() => {});
    });
    $('[data-up]', card)?.addEventListener('change', async (e) => {
      const f = e.target.files[0]; if (!f) return;
      const fd = new FormData(); fd.append('file', f);
      try { await api(`${base}/creative`, { method: 'POST', form: fd }); toast('Creative uploaded', 'success'); reload(); } catch (err) { toast(err.message, 'error'); }
    });
    $('[data-metaprev]', card)?.addEventListener('click', async (e) => {
      await busy(e.target, async () => {
        const { html } = await api(`${base}/meta-preview`);
        const src = html && new DOMParser().parseFromString(html, 'text/html').querySelector('iframe')?.getAttribute('src');
        if (!src || !/^https:\/\/(www\.)?facebook\.com\//.test(src)) throw new Error('Meta returned no preview');
        const dlg = $('#dlg');
        dlg.innerHTML = `<h2>Live Meta preview</h2><p class="muted small">Rendered by Meta from your real ad account. Nothing is published.</p><iframe class="metaprev" src="${esc(src)}"></iframe><div class="actions"><button data-close>Close</button></div>`;
        $('[data-close]', dlg).onclick = () => dlg.close();
        dlg.showModal();
      }, 'Loading…').catch(() => {});
    });
    $('[data-live]', card)?.addEventListener('click', async (e) => {
      const live = e.target.dataset.live === '1';
      await busy(e.target, async () => { await api(`${base}/status`, { method: 'POST', body: { live } }); toast(live ? 'Ad resumed' : 'Ad paused', 'success'); reload(); }).catch(() => {});
    });
  }
}

function editDialog(c, v, reload) {
  const dlg = $('#dlg');
  const ds = v.design ?? {};
  const counter = (name, max) => `<span class="counter" data-count="${name}" data-max="${max}"></span>`;
  dlg.innerHTML = `<form id="ef"><h2>Edit "${esc(v.label)}"</h2>
    <div class="field"><label>Label</label><input name="label" value="${esc(v.label)}"></div>
    <div class="field"><label>Primary text ${counter('primary_text', 600)}</label><textarea name="primary_text" rows="4">${esc(v.primary_text)}</textarea></div>
    <div class="grid g2">
      <div class="field"><label>Headlines — one per line, max 30 chars each, min 3</label><textarea name="headlines" rows="7">${esc(v.headlines.join('\n'))}</textarea><div class="hint" data-lines="headlines" data-max="30"></div></div>
      <div class="field"><label>Descriptions — one per line, max 90 chars each, min 2</label><textarea name="descriptions" rows="7">${esc(v.descriptions.join('\n'))}</textarea><div class="hint" data-lines="descriptions" data-max="90"></div></div>
    </div>
    <div class="field"><label>Call to action</label><select name="cta">${Object.entries(CTA_LABEL).map(([k, l]) => `<option value="${k}" ${k === v.cta ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
    <h3>Creative design</h3>
    <div class="grid g3">
      <div class="field"><label>Image headline</label><input name="overlay_headline" value="${esc(ds.overlay_headline)}"></div>
      <div class="field"><label>Image subtext</label><input name="overlay_subtext" value="${esc(ds.overlay_subtext)}"></div>
      <div class="field"><label>Badge</label><input name="badge" value="${esc(ds.badge)}"></div>
      <div class="field"><label>Background from</label><input type="color" name="bg_from" value="${esc(ds.bg_from || '#1e3a8a')}"></div>
      <div class="field"><label>Background to</label><input type="color" name="bg_to" value="${esc(ds.bg_to || '#0f172a')}"></div>
      <div class="field"><label>Accent</label><input type="color" name="accent" value="${esc(ds.accent || '#f59e0b')}"></div>
      <div class="field"><label>Text colour</label><input type="color" name="text_color" value="${esc(ds.text_color || '#ffffff')}"></div>
      <div class="field"><label>Layout</label><select name="layout">${['left', 'center', 'bottom'].map((l) => `<option ${l === ds.layout ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
    </div>
    <div class="actions"><button class="primary" type="submit">Save & re-render</button><button type="button" data-close>Cancel</button></div></form>`;
  const f = $('#ef', dlg);
  const update = () => {
    $$('[data-count]', f).forEach((s) => { const n = f[s.dataset.count].value.length; s.textContent = `${n}/${s.dataset.max}`; s.classList.toggle('over', n > Number(s.dataset.max)); });
    $$('[data-lines]', f).forEach((s) => {
      const lines = f[s.dataset.lines].value.split('\n').map((x) => x.trim()).filter(Boolean);
      const over = lines.filter((x) => x.length > Number(s.dataset.max));
      s.innerHTML = `${lines.length} line(s)${over.length ? ` · <b style="color:var(--err)">${over.length} over limit</b>` : ''}`;
    });
  };
  f.addEventListener('input', update); update();
  $('[data-close]', dlg).onclick = () => dlg.close();
  f.onsubmit = async (e) => {
    e.preventDefault();
    const lines = (n) => f[n].value.split('\n').map((x) => x.trim()).filter(Boolean);
    const body = {
      label: f.label.value, primary_text: f.primary_text.value, headlines: lines('headlines'), descriptions: lines('descriptions'), cta: f.cta.value,
      design: Object.fromEntries(['overlay_headline', 'overlay_subtext', 'badge', 'bg_from', 'bg_to', 'accent', 'text_color', 'layout'].map((k) => [k, f[k].value])),
    };
    await busy(e.submitter, async () => { await api(`/campaigns/${c.id}/variations/${v.id}`, { method: 'PUT', body }); dlg.close(); toast('Saved', 'success'); reload(); }).catch(() => {});
  };
  dlg.showModal();
}

function strategyTab(el, d, reload) {
  const c = d.campaign, s = c.ai_strategy ?? {};
  const editable = ['draft', 'generated', 'approved'].includes(c.status);
  el.innerHTML = `<div class="card">
    ${s.summary ? `<h2>AI strategy</h2><p>${esc(s.summary)}</p><p class="muted">${esc(s.audience_insights ?? '')}</p>` : '<p class="muted">Generate ads to get an AI targeting strategy.</p>'}
    <div class="grid g3">
      <div class="field"><label>Meta interests (one per line)</label><textarea name="meta_interests" rows="8" ${editable ? '' : 'disabled'}>${esc((s.meta_interests ?? []).join('\n'))}</textarea><div class="hint">Resolved to real Meta interest IDs at deploy time.</div></div>
      <div class="field"><label>Google keywords (phrase match)</label><textarea name="google_keywords" rows="8" ${editable ? '' : 'disabled'}>${esc((s.google_keywords ?? []).join('\n'))}</textarea></div>
      <div class="field"><label>Negative keywords (reference)</label><textarea name="negative_keywords" rows="8" ${editable ? '' : 'disabled'}>${esc((s.negative_keywords ?? []).join('\n'))}</textarea></div>
    </div>
    <h3>Locations</h3>${Object.entries(c.locations).map(([p, ls]) => `<div>${pfTag(p)} ${ls.map((l) => esc(l.name)).join(' · ')}</div>`).join('')}
    <p class="muted small">Audience: ${esc(c.audience)} · Ages ${c.age_min}–${c.age_max}</p>
    ${editable ? '<button class="primary" id="saveS">Save targeting</button>' : ''}</div>`;
  $('#saveS', el)?.addEventListener('click', async (e) => {
    const lines = (n) => $(`[name=${n}]`, el).value.split('\n').map((x) => x.trim()).filter(Boolean);
    await busy(e.target, async () => { await api(`/campaigns/${c.id}/strategy`, { method: 'PUT', body: { meta_interests: lines('meta_interests'), google_keywords: lines('google_keywords'), negative_keywords: lines('negative_keywords') } }); toast('Saved', 'success'); reload(); }).catch(() => {});
  });
}

function analyticsTab(el, d, reload) {
  const c = d.campaign, m = d.metrics, t = m.totals;
  const deployed = d.objects.length > 0;
  const used = Math.min(100, (t.spend / c.total_budget) * 100);
  const labels = Object.fromEntries(d.variations.map((v) => [v.id, v.label]));
  el.innerHTML = `
    <div class="actions" style="margin-bottom:12px">${deployed ? '<button id="sync">⟳ Sync metrics now</button>' : ''}<span class="muted small">Last synced: ${dt(c.last_synced_at)} · auto-sync runs on the server schedule</span></div>
    ${deployed ? '' : '<div class="banner info">Analytics appear once the campaign is deployed and delivering. All figures come from the platforms\' reporting APIs.</div>'}
    <div class="grid g4">${[['Spend', money(t.spend, c.currency)], ['Impressions', num(t.impressions)], ['Clicks', num(t.clicks)], ['CTR', pct(t.ctr)], ['CPC', t.cpc == null ? '—' : money(t.cpc)], ['CPM', t.cpm == null ? '—' : money(t.cpm)], ['Conversions', num(t.conversions)], ['CPA', t.cpa == null ? '—' : money(t.cpa)]]
      .map(([l, v]) => `<div class="card kpi"><div class="l">${l}</div><div class="v">${v}</div></div>`).join('')}</div>
    <div class="card"><h3>Budget used: ${money(t.spend)} of ${money(c.total_budget, c.currency)} (${used.toFixed(1)}%) · today ${money(m.today.spend)}</h3>
      <div style="background:var(--border);border-radius:6px;height:10px"><div style="width:${used}%;background:${used > 90 ? 'var(--err)' : 'var(--primary)'};height:10px;border-radius:6px"></div></div></div>
    <div class="card chart"><h2>Daily performance</h2>${lineChart(m.daily)}</div>
    <div class="grid g2">
      <div class="card"><h2>By platform</h2><table><tr><th>Platform</th><th class="num">Spend</th><th class="num">Impr.</th><th class="num">Clicks</th><th class="num">CTR</th><th class="num">CPC</th><th class="num">Conv.</th></tr>
        ${m.byPlatform.map((p) => `<tr><td>${pfTag(p.platform)}</td><td class="num">${money(p.spend)}</td><td class="num">${num(p.impressions)}</td><td class="num">${num(p.clicks)}</td><td class="num">${pct(p.ctr)}</td><td class="num">${p.cpc == null ? '—' : money(p.cpc)}</td><td class="num">${num(p.conversions)}</td></tr>`).join('') || '<tr><td colspan="7" class="muted">No data</td></tr>'}</table></div>
      <div class="card"><h2>By variation</h2><table><tr><th>Variation</th><th class="num">Spend</th><th class="num">Clicks</th><th class="num">CTR</th><th class="num">CPC</th><th class="num">Conv.</th></tr>
        ${m.byVariation.map((r) => `<tr><td>${pfTag(r.platform)} ${esc(labels[r.variation_id] ?? r.label)}</td><td class="num">${money(r.spend)}</td><td class="num">${num(r.clicks)}</td><td class="num">${pct(r.ctr)}</td><td class="num">${r.cpc == null ? '—' : money(r.cpc)}</td><td class="num">${num(r.conversions)}</td></tr>`).join('') || '<tr><td colspan="6" class="muted">No data</td></tr>'}</table></div>
    </div>`;
  $('#sync', el)?.addEventListener('click', async (e) => {
    await busy(e.target, async () => { const r = await api(`/campaigns/${c.id}/sync`, { method: 'POST' }); if (r.errors.length) toast(r.errors.join('\n'), 'warning'); else toast('Metrics synced', 'success'); reload(); }, 'Syncing…').catch(() => {});
  });
}

const ACTION_LABEL = { pause_campaign: 'Pause campaign', pause_variation: 'Pause the variation', end_campaign: 'End campaign', notify: 'Notify only' };

function rulesTab(el, d, reload) {
  const c = d.campaign;
  const deployed = d.objects.length > 0;
  el.innerHTML = `
    <div class="card"><h2>Budget controls</h2>
      <p>Total budget <b>${money(c.total_budget, c.currency)}</b> · daily <b>${money(c.daily_budget, c.currency)}</b> · split ${Object.entries(c.budget_split).map(([p, v]) => `${pfTag(p)}${v}%`).join(' ')}</p>
      <p class="muted small">Built-in guard: the campaign is automatically ended on every platform once spend reaches the approved total. Meta ad sets also carry the end date natively.</p>
      ${deployed && can('manager') && ['active', 'paused', 'scheduled'].includes(c.status) ? `<div class="actions"><input id="nb" type="number" step="0.01" min="1" value="${c.daily_budget}" style="max-width:160px"><button id="setb">Update daily budget on platforms</button></div>` : ''}
    </div>
    <div class="card"><h2>Automation rules</h2>
      <p class="muted small">Evaluated after every metrics sync. Variation rules pause only the under-performing ad.</p>
      <table><tr><th>When</th><th class="num">Threshold</th><th class="num">Min. impressions</th><th>Then</th><th>Last triggered</th><th></th></tr>
      ${d.rules.map((r) => `<tr><td>${esc(d.ruleTypes[r.type])}</td><td class="num">${r.threshold}</td><td class="num">${num(r.min_impressions)}</td><td>${ACTION_LABEL[r.action]}</td><td class="small">${dt(r.last_triggered_at)}</td>
        <td class="right">${can('manager') ? `<label class="check"><input type="checkbox" data-tog="${r.id}" ${r.enabled ? 'checked' : ''}> on</label><button class="sm danger" data-del="${r.id}">Delete</button>` : (r.enabled ? 'on' : 'off')}</td></tr>`).join('') || '<tr><td colspan="6" class="muted">No rules</td></tr>'}</table>
      ${can('manager') ? `<form id="rf" class="grid g5" style="margin-top:14px;align-items:end">
        <div><label>When</label><select name="type">${Object.entries(d.ruleTypes).map(([k, l]) => `<option value="${k}">${esc(l)}</option>`).join('')}</select></div>
        <div><label>Threshold</label><input name="threshold" type="number" step="0.01" min="0" required></div>
        <div><label>Min. impressions</label><input name="min_impressions" type="number" min="0" value="1000"></div>
        <div><label>Then</label><select name="action">${Object.entries(ACTION_LABEL).map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select></div>
        <div><button class="primary" type="submit">Add rule</button></div></form>` : ''}
    </div>`;
  $('#setb', el)?.addEventListener('click', async (e) => {
    const v = Number($('#nb', el).value);
    if (!confirm(`Set daily budget to ${money(v, c.currency)} across platforms?`)) return;
    await busy(e.target, async () => { await api(`/campaigns/${c.id}/budget`, { method: 'PUT', body: { daily_budget: v } }); toast('Budget updated', 'success'); reload(); }).catch(() => {});
  });
  $$('[data-tog]', el).forEach((i) => (i.onchange = async () => { try { await api(`/rules/${i.dataset.tog}`, { method: 'PATCH', body: { enabled: i.checked } }); } catch (e) { toast(e.message, 'error'); } }));
  $$('[data-del]', el).forEach((b) => (b.onclick = async () => { if (!confirm('Delete rule?')) return; await busy(b, async () => { await api(`/rules/${b.dataset.del}`, { method: 'DELETE' }); reload(); }).catch(() => {}); }));
  $('#rf', el)?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target).entries());
    await busy(e.submitter, async () => { await api(`/campaigns/${c.id}/rules`, { method: 'POST', body: f }); toast('Rule added', 'success'); reload(); }).catch(() => {});
  });
}

function aiTab(el, d, reload) {
  const c = d.campaign;
  const labels = Object.fromEntries(d.variations.map((v) => [v.id, v.label]));
  el.innerHTML = `<div class="card"><div class="head" style="margin:0 0 10px"><div><h2>AI optimisation suggestions</h2>
      <div class="muted small">AI analyses the campaign's real platform metrics. Suggestions are never applied automatically — a manager must click Apply. Last run: ${dt(c.last_optimized_at)}</div></div>
      <button class="primary" id="opt">✨ Analyse now</button></div>
    ${d.suggestions.map((s) => {
      const p = JSON.parse(s.params || '{}');
      const detail = s.action === 'pause_variation' ? `Pause variation "${esc(labels[p.variation_id] ?? p.variation_id)}"` : s.action === 'adjust_daily_budget' ? `Set daily budget to ${money(p.new_daily_budget, c.currency)}` : '';
      return `<div class="var"><div class="var-head"><div>${badge(s.priority)} <b>${esc(s.title)}</b> ${s.status !== 'open' ? badge(s.status) : ''}</div>
        <div class="actions">${s.status === 'open' && s.action !== 'none' && can('manager') ? `<button class="sm ok" data-apply="${s.id}">Apply: ${detail}</button>` : ''}${s.status === 'open' ? `<button class="sm" data-dismiss="${s.id}">Dismiss</button>` : ''}</div></div>
        <div>${esc(s.detail)}</div><div class="muted small">${dt(s.created_at)}</div></div>`;
    }).join('') || '<div class="empty">No suggestions yet. They need real delivery data (impressions) to analyse.</div>'}</div>`;
  $('#opt', el).onclick = async (e) => { await busy(e.target, async () => { const r = await api(`/campaigns/${c.id}/optimize`, { method: 'POST' }); toast(r.summary, 'info', 10000); reload(); }, 'Analysing…').catch(() => {}); };
  $$('[data-apply]', el).forEach((b) => (b.onclick = async () => { if (!confirm('Apply this change to the live campaign?')) return; await busy(b, async () => { await api(`/suggestions/${b.dataset.apply}/apply`, { method: 'POST' }); toast('Applied', 'success'); reload(); }).catch(() => reload()); }));
  $$('[data-dismiss]', el).forEach((b) => (b.onclick = async () => { await busy(b, async () => { await api(`/suggestions/${b.dataset.dismiss}/dismiss`, { method: 'POST' }); reload(); }).catch(() => {}); }));
}

function activityTab(el, d) {
  el.innerHTML = `
    <div class="card"><h2>Deployments</h2><table><tr><th>Platform</th><th>Status</th><th>Started</th><th>Finished</th><th>Error</th></tr>
      ${d.deployments.map((x) => `<tr><td>${pfTag(x.platform)}</td><td>${badge(x.status)}</td><td class="small">${dt(x.started_at)}</td><td class="small">${dt(x.finished_at)}</td><td class="small">${esc(x.error ?? '')}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">Not deployed</td></tr>'}</table></div>
    <div class="card"><h2>Platform objects</h2><p class="muted small">IDs of the real objects created in your ad accounts.</p><table><tr><th>Platform</th><th>Type</th><th>External ID</th><th>Variation</th><th>Status</th></tr>
      ${d.objects.map((o) => `<tr><td>${pfTag(o.platform)}</td><td>${esc(o.kind)}</td><td class="mono">${esc(o.external_id)}</td><td>${o.variation_id ?? ''}</td><td>${esc(o.status ?? '')}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">None</td></tr>'}</table></div>
    <div class="card"><h2>Audit trail</h2><table><tr><th>When</th><th>Who</th><th>Action</th><th>Details</th></tr>
      ${d.audit.map((a) => `<tr><td class="small">${dt(a.created_at)}</td><td>${esc(a.actor)}</td><td class="mono">${esc(a.action)}</td><td class="mono small">${esc(a.details ?? '')}</td></tr>`).join('')}</table></div>`;
}

// ---------- connections ----------
async function connectionsView(main, params) {
  const conns = await api('/connections');
  main.innerHTML = `<div class="head"><div><h1>Ad platform connections</h1><div class="muted">OAuth tokens are stored encrypted on the server and never sent to the browser.</div></div></div>
    ${params.get('connected') ? `<div class="banner ok">${PF_FULL[params.get('connected')] ?? ''} authorised. Now select the ad account to use.</div>` : ''}
    ${params.get('error') ? `<div class="banner err">${esc(params.get('error'))}</div>` : ''}
    <div class="grid g3">${conns.map((c) => `<div class="card" data-pf="${c.platform}">
      <h2>${pfTag(c.platform)} ${PF_FULL[c.platform]} ${badge(c.status)}</h2>
      ${c.appConfigured ? '' : '<div class="banner warn">App credentials missing in server .env</div>'}
      ${c.accountId ? `<p><b>${esc(c.accountName)}</b><br><span class="muted mono">${esc(c.accountId)}</span> · ${esc(c.currency)}</p>` : ''}
      ${c.extra.page_name ? `<p class="small">Page: ${esc(c.extra.page_name)}${c.extra.pixel_name ? ` · Pixel: ${esc(c.extra.pixel_name)}` : ''}</p>` : ''}
      ${c.tokenExpiresAt ? `<p class="small muted">Token expires ${dt(c.tokenExpiresAt)}</p>` : ''}
      ${c.lastError ? `<div class="banner err small">${esc(c.lastError)}</div>` : ''}
      <div class="actions">
        ${can('manager') && c.appConfigured ? `<button class="${c.status === 'disconnected' ? 'primary' : ''}" data-connect>${c.status === 'disconnected' ? 'Connect' : 'Reconnect'}</button>` : ''}
        ${can('manager') && c.status !== 'disconnected' ? '<button data-pick>Select account</button>' : ''}
        ${can('admin') && c.status !== 'disconnected' ? '<button class="danger" data-disc>Disconnect</button>' : ''}
      </div><div data-picker></div></div>`).join('')}</div>`;

  for (const card of $$('[data-pf]', main)) {
    const p = card.dataset.pf;
    $('[data-connect]', card)?.addEventListener('click', async (e) => { await busy(e.target, async () => { const { url } = await api(`/connections/${p}/oauth/start`, { method: 'POST' }); location.href = url; }).catch(() => {}); });
    $('[data-disc]', card)?.addEventListener('click', async (e) => { if (!confirm('Disconnect? Deployed campaigns on this platform can no longer be managed until reconnected.')) return; await busy(e.target, async () => { await api(`/connections/${p}`, { method: 'DELETE' }); render(); }).catch(() => {}); });
    $('[data-pick]', card)?.addEventListener('click', async (e) => {
      await busy(e.target, async () => {
        const { accounts, pages } = await api(`/connections/${p}/accounts`);
        const box = $('[data-picker]', card);
        box.innerHTML = `<div class="field" style="margin-top:12px"><label>Ad account</label><select name="acct">${accounts.map((a) => `<option value="${esc(a.id)}">${esc(a.name)} (${esc(a.id)}, ${esc(a.currency)})${a.active ? '' : ' — inactive'}</option>`).join('')}</select></div>
          ${p === 'meta' ? `<div class="field"><label>Facebook Page (ads run as this page)</label><select name="page">${(pages ?? []).map((pg) => `<option value="${esc(pg.id)}">${esc(pg.name)}</option>`).join('')}</select></div>
          <div class="field"><label>Pixel (needed for Leads/Sales)</label><select name="pixel"><option value="">— none —</option></select></div>` : ''}
          <button class="primary" data-save>Save</button>`;
        if (!accounts.length) { box.innerHTML = '<div class="banner warn">No ad accounts accessible with this login.</div>'; return; }
        const loadPixels = async () => {
          if (p !== 'meta') return;
          const px = await api(`/connections/meta/pixels?account=${encodeURIComponent($('[name=acct]', box).value)}`).catch(() => []);
          $('[name=pixel]', box).innerHTML = '<option value="">— none —</option>' + px.map((x) => `<option value="${esc(x.id)}">${esc(x.name)}</option>`).join('');
        };
        $('[name=acct]', box).onchange = loadPixels; loadPixels();
        $('[data-save]', box).onclick = async (ev) => {
          await busy(ev.target, async () => {
            await api(`/connections/${p}/account`, { method: 'POST', body: { accountId: $('[name=acct]', box).value, pageId: $('[name=page]', box)?.value, pixelId: $('[name=pixel]', box)?.value || undefined } });
            toast('Account saved', 'success'); location.hash = '#/connections'; render();
          }).catch(() => {});
        };
      }, 'Loading accounts…').catch(() => {});
    });
  }
}

// ---------- organic Facebook Page post ----------
async function pagePostView(main) {
  const conns = await api('/connections');
  const meta = conns.find((c) => c.platform === 'meta');
  const [status, posts] = await Promise.all([
    api('/meta/page-status').catch(() => null),
    api('/meta/page-posts').catch(() => []),
  ]);
  const ready = meta?.status === 'connected' && status?.pageId;
  const needsReconnect = !!status?.connected && !!status?.pageId && !!status?.scopes?.length && !status.canPublish;

  const banners = [];
  if (meta?.status !== 'connected') banners.push('<div class="banner warn">Meta is not connected. <a href="#/connections">Connect Meta</a> first.</div>');
  else if (!status?.pageId) banners.push('<div class="banner warn">No Facebook Page selected. <a href="#/connections">Connections → Meta → Select account</a>.</div>');
  if (needsReconnect) banners.push('<div class="banner warn"><b>Posting permission missing.</b> Facebook ke saath dobara authorise karna hoga — niche wala button dabao. <button id="reconnect">Reconnect Meta</button></div>');
  if (status?.error) banners.push(`<div class="banner err small">${esc(status.error)}</div>`);

  main.innerHTML = `
    <div class="head"><div><a href="#/dashboard" class="small" id="ppBack">← Back</a><h1>Facebook page post</h1>
      <div class="muted">Free organic post straight to your connected Page — ye ad nahi hai, koi budget spend nahi hota.</div></div></div>
    ${banners.join('')}
    <form id="pp" class="card">
      <div class="field"><label>Posting as page</label>
        <div>${pfTag('meta')} <b>${esc(status?.pageName ?? '—')}</b></div></div>
      <div class="field"><label>Message *</label>
        <textarea name="message" rows="6" maxlength="5000" placeholder="Apna post yahan likho…"></textarea>
        <div class="hint"><span id="cl">0</span>/5000 characters</div></div>
      <div class="grid g2">
        <div class="field"><label>Link (optional)</label><input name="link" type="url" placeholder="https://"></div>
        <div class="field"><label>Image (optional — PNG/JPEG)</label><input type="file" name="file" accept="image/png,image/jpeg"></div>
      </div>
      <div class="actions">
        <button class="primary" type="submit" ${ready && !needsReconnect ? '' : 'disabled'}>Post to page</button>
        <span class="muted small">${ready && !needsReconnect ? 'Live Facebook par turant dikh jayega.' : 'Upar di gayi koi na koi condition poori karo.'}</span>
      </div>
    </form>
    <div class="card"><h2>Recent page posts</h2>
      ${posts.length ? posts.map((p, i) => `
        <div style="padding:10px 0;border-bottom:1px solid var(--border)" data-post="${i}">
          <div class="small muted">${dt(p.createdTime)}${p.permalink ? ` · <a href="${esc(p.permalink)}" target="_blank" rel="noopener">view on Facebook</a>` : ''}
            ${ready && !needsReconnect ? ' · <a href="#" data-edit>✎ Edit</a>' : ''}</div>
          <div data-view style="white-space:pre-wrap;margin-top:4px">${esc(p.message) || '<span class="muted">(no text)</span>'}</div>
          <form data-editor hidden style="margin-top:6px">
            <textarea name="message" rows="5" maxlength="5000"></textarea>
            <div class="actions"><button class="primary" type="submit">Save</button><button type="button" data-cancel>Cancel</button>
              <span class="muted small">Sirf text badlega. Image/link badalne ke liye naya post banana padega.</span></div>
          </form>
        </div>`).join('') : '<div class="empty">No posts found yet.</div>'}
    </div>`;

  $('#reconnect')?.addEventListener('click', async (e) => {
    await busy(e.target, async () => { const { url } = await api('/connections/meta/oauth/start', { method: 'POST' }); location.href = url; }).catch(() => {});
  });

  // Go back to wherever the user came from; fall back to the dashboard on a direct visit.
  $('#ppBack').onclick = (e) => { if (history.length > 1) { e.preventDefault(); history.back(); } };

  $$('[data-post]', main).forEach((row) => {
    const post = posts[Number(row.dataset.post)];
    const view = $('[data-view]', row), editor = $('[data-editor]', row);
    const open = (on) => { editor.hidden = !on; view.hidden = on; };
    $('[data-edit]', row)?.addEventListener('click', (e) => {
      e.preventDefault();
      editor.message.value = post.message;
      open(true);
      editor.message.focus();
    });
    $('[data-cancel]', row).onclick = () => open(false);
    editor.onsubmit = async (e) => {
      e.preventDefault();
      await busy(e.submitter, async () => {
        await api(`/meta/page-posts/${encodeURIComponent(post.id)}`, { method: 'PUT', body: { message: editor.message.value } });
        toast('Post updated on Facebook', 'success');
        await pagePostView(main);
      }, 'Saving…').catch(() => {});
    };
  });

  const ta = $('#pp textarea[name=message]');
  ta.oninput = () => { $('#cl').textContent = ta.value.length; };

  $('#pp').onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    await busy(e.submitter, async () => {
      const out = await api('/meta/page-post', { method: 'POST', form: f });
      toast(out.permalink ? `Posted — ${out.permalink}` : 'Posted to your Facebook page', 'success', 10000);
      await pagePostView(main);
    }, 'Posting to Facebook…').catch(() => {});
  };
}

// ---------- notifications / audit / settings ----------
async function notificationsView(main) {
  const d = await api('/notifications?limit=200');
  main.innerHTML = `<div class="head"><div><h1>Notifications</h1></div><button id="ra">Mark all read</button></div>
    <div class="card">${d.items.map((n) => `<div style="padding:10px 0;border-bottom:1px solid var(--border);${n.read ? 'opacity:.65' : ''}">
      ${badge(n.level)} <b>${esc(n.title)}</b> <span class="muted small">${dt(n.created_at)}</span>
      ${n.campaign_id ? ` <a class="small" href="#/campaigns/${n.campaign_id}">open campaign</a>` : ''}
      ${n.body ? `<div class="small" style="white-space:pre-wrap">${esc(n.body)}</div>` : ''}</div>`).join('') || '<div class="empty">Nothing yet</div>'}</div>`;
  $('#ra').onclick = async () => { await api('/notifications/read-all', { method: 'POST' }); render(); };
}

async function auditView(main) {
  let offset = 0, q = '';
  const load = async () => {
    const d = await api(`/audit?limit=100&offset=${offset}&q=${encodeURIComponent(q)}`);
    $('#al').innerHTML = `<table><tr><th>When</th><th>Who</th><th>Action</th><th>Entity</th><th>Details</th><th>IP</th></tr>
      ${d.items.map((a) => `<tr><td class="small">${dt(a.created_at)}</td><td>${esc(a.actor)}</td><td class="mono">${esc(a.action)}</td><td class="small">${esc(a.entity_type ?? '')} ${esc(a.entity_id ?? '')}</td><td class="mono small" style="max-width:420px;word-break:break-word">${esc(a.details ?? '')}</td><td class="small">${esc(a.ip ?? '')}</td></tr>`).join('')}</table>
      <div class="actions" style="margin-top:10px"><button id="prev" ${offset ? '' : 'disabled'}>← Newer</button><span class="muted small">${offset + 1}–${Math.min(offset + 100, d.total)} of ${d.total}</span><button id="next" ${offset + 100 < d.total ? '' : 'disabled'}>Older →</button></div>`;
    $('#prev').onclick = () => { offset = Math.max(0, offset - 100); load(); };
    $('#next').onclick = () => { offset += 100; load(); };
  };
  main.innerHTML = `<div class="head"><div><h1>Audit log</h1><div class="muted">Append-only record of every user and system action.</div></div>
    <input id="aq" placeholder="Search action, user, details or id…" style="max-width:320px"></div><div class="card" id="al"></div>`;
  let t; $('#aq').oninput = (e) => { clearTimeout(t); t = setTimeout(() => { q = e.target.value; offset = 0; load(); }, 300); };
  await load();
}

async function settingsView(main) {
  const s = await api('/settings');
  const users = can('admin') ? await api('/users') : [];
  main.innerHTML = `<div class="head"><div><h1>Settings</h1></div></div>
    <div class="grid g2">
      <div class="card"><h2>Budget safety caps</h2>
        <p class="muted small">Server hard caps (from .env): daily ${money(s.envCaps.maxDaily)}, total ${money(s.envCaps.maxTotal)} per campaign. Settings here can only tighten them.</p>
        <form id="sf"><div class="grid g2"><div class="field"><label>Max daily per campaign</label><input name="maxDaily" type="number" step="0.01" value="${s.caps.maxDaily}" ${can('admin') ? '' : 'disabled'}></div>
        <div class="field"><label>Max total per campaign</label><input name="maxTotal" type="number" step="0.01" value="${s.caps.maxTotal}" ${can('admin') ? '' : 'disabled'}></div></div>
        <label class="check"><input type="checkbox" name="sep" ${s.requireSeparateApprover ? 'checked' : ''} ${can('admin') ? '' : 'disabled'}> Four-eyes approval (creator can't approve own campaign)</label>
        ${can('admin') ? '<div style="margin-top:12px"><button class="primary" type="submit">Save</button></div>' : ''}</form></div>
      <div class="card"><h2>Automation & notifications</h2>
        <p>Scheduler tick: every ${s.scheduler.tickSeconds}s · metrics sync every ${s.scheduler.metricsSyncMinutes} min · AI analysis every ${s.scheduler.optimizeHours} h</p>
        <p>Email notifications: ${s.notifications.email ? badge('connected') : badge('disconnected')} · Slack: ${s.notifications.slack ? badge('connected') : badge('disconnected')}</p>
        <p class="muted small">Configure SMTP_URL / NOTIFY_EMAIL_TO / SLACK_WEBHOOK_URL in the server .env.</p>
        <h3>Change password</h3><form id="pf" class="grid g2"><input type="password" name="current" placeholder="Current" required><input type="password" name="next" placeholder="New (12+ chars)" minlength="12" required><button type="submit">Update password</button></form></div>
    </div>
    ${can('admin') ? `<div class="card"><h2>Users</h2><table><tr><th>Name</th><th>Email</th><th>Role</th><th>Created</th><th></th></tr>
      ${users.map((u) => `<tr><td>${esc(u.name)}</td><td>${esc(u.email)}</td><td>${badge(u.role)}</td><td class="small">${dt(u.created_at)}</td><td class="right">${u.id === state.user.id ? '' : `<button class="sm danger" data-du="${u.id}">Remove</button>`}</td></tr>`).join('')}</table>
      <form id="uf" class="grid g5" style="margin-top:12px;align-items:end"><input name="name" placeholder="Name"><input name="email" type="email" placeholder="Email" required><input name="password" type="password" placeholder="Temp password (12+)" minlength="12" required>
      <select name="role"><option value="editor">Editor — create & generate</option><option value="manager">Manager — approve, deploy, control</option><option value="admin">Admin — everything</option></select><button class="primary" type="submit">Add user</button></form></div>` : ''}`;
  $('#sf').onsubmit = async (e) => { e.preventDefault(); const f = e.target; await busy(e.submitter, async () => { await api('/settings', { method: 'PUT', body: { maxDaily: Number(f.maxDaily.value), maxTotal: Number(f.maxTotal.value), requireSeparateApprover: f.sep.checked } }); toast('Saved', 'success'); render(); }).catch(() => {}); };
  $('#pf').onsubmit = async (e) => { e.preventDefault(); const f = e.target; await busy(e.submitter, async () => { await api('/auth/password', { method: 'POST', body: { current: f.current.value, next: f.next.value } }); toast('Password changed — sign in again', 'success'); state.user = null; render(); }).catch(() => {}); };
  $('#uf')?.addEventListener('submit', async (e) => { e.preventDefault(); await busy(e.submitter, async () => { await api('/users', { method: 'POST', body: Object.fromEntries(new FormData(e.target).entries()) }); toast('User added', 'success'); render(); }).catch(() => {}); });
  $$('[data-du]', main).forEach((b) => (b.onclick = async () => { if (!confirm('Remove user?')) return; await busy(b, async () => { await api(`/users/${b.dataset.du}`, { method: 'DELETE' }); render(); }).catch(() => {}); }));
}

render();
