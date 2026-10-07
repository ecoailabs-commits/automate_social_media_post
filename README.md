# AI Automated Ads

A self-hosted system that **generates, previews, approves, deploys, schedules, monitors and optimises** real ad campaigns on **Meta Ads and Google Ads**. It uses Claude for copy and strategy.

Nothing here is simulated. Campaigns are created through the official platform APIs in your own ad accounts. Analytics come from the platforms' reporting APIs, and if a platform call fails, you see the platform's real error.

## Workflow

```
Brief ──► AI generates ──► Preview & edit ──► Approve ──► Deploy (paused) ──► Auto-start ──► Monitor ──► Auto-end
          strategy +        (local mocks +     (manager)    all-or-nothing     at start       sync, rules,   at end time
          N variations       live Meta preview)              with rollback      time           AI suggestions or budget cap
```

1. **Brief**: product or service, details/offer, landing URL, audience, ages, objective, platforms, locations (resolved through each platform's geo search), total budget, start/end, tone, language and an optional product photo.
2. **AI generation**: Claude (`claude-opus-5-5`) returns a targeting strategy (Meta interests, Google keywords, negatives) and 2–5 variations. Each variation has primary text, 5–10 headlines (≤30 chars), 2–4 descriptions (≤90 chars), a CTA and a creative design. Platform length limits are validated, and a repair pass runs automatically when a limit is broken.
3. **Creatives**: the AI design is rendered into real PNGs at 1080×1080 for Meta, optionally over your product photo. You can also upload your own finished PNG.
4. **Preview**: there are in-app feed and search previews for every platform, plus a **live Meta preview** rendered by Meta itself (nothing is published).
5. **Approve**: managers approve with an explicit budget confirmation. Any later edit revokes the approval. Optional four-eyes rule: the creator can't approve their own campaign.
6. **Deploy**: objects are created **paused** on every platform. If any platform fails, everything created in that attempt is rolled back and the campaign stays approved, so you can fix the problem and retry.
7. **Schedule**: the server scheduler activates the campaign at start time and ends it at end time. Meta ad sets also carry the end date natively, as a backstop if this server is down.
8. **Monitor**: metrics sync every 30 minutes (configurable). Rules then pause or end the campaign, pause a weak variation, or just notify. A built-in guard ends the campaign once spend reaches the approved total.
9. **Optimise**: Claude analyses the real metrics and proposes actions (pause a variation, change the daily budget). A **manager must click Apply**; the AI never changes live campaigns by itself. Budget changes are clamped so they can't exceed the approved total.
10. **Notifications**: in-app, plus optional email (SMTP) and Slack.
11. **Audit log**: an append-only log (enforced by database triggers) of every user and system action.

### What gets created on each platform

| | Meta | Google Ads |
|---|---|---|
| Container | Campaign (ODAX objective) | Campaign budget + Search campaign |
| Targeting | Ad set: locations, ages, AI interests (resolved to real IDs) | Location criteria + phrase-match keywords |
| Ads | Image link ad per variation (Page identity) | One responsive search ad per variation (max 3) |
| Pause / End | PAUSED / ARCHIVED | PAUSED / PAUSED (history kept) |

Objective mapping: awareness, traffic, engagement, leads and sales map to each platform's equivalent objective. **Leads and Sales on Meta require a Pixel**, which you select on the Connections page.

## Setup

Requires **Node.js 22.13+**; it uses the built-in `node:sqlite`, so no native builds are needed.

```bash
npm install
cp .env.example .env      # then fill it in (see below)
npm start                 # http://localhost:3000
```

Minimum `.env` to start: `SESSION_SECRET`, `ENCRYPTION_KEY` (64 hex chars each), `ADMIN_EMAIL`, `ADMIN_PASSWORD` (12+ characters) and `ANTHROPIC_API_KEY`.

### Connecting the ad platforms

Each platform needs a developer app, and its keys go in `.env` (server only). Users then click **Connect** on the Connections page and pick an ad account. The redirect URI to register is `{PUBLIC_URL}/api/oauth/{meta|google}/callback`.

| Platform | What you need | Notes |
|---|---|---|
| **Meta** | App with the Marketing API product, plus Facebook Login with the redirect URI. Scopes requested: `ads_management, ads_read, business_management, pages_show_list, pages_read_engagement` | Needs **Advanced Access** for `ads_management` to manage accounts you don't own. The token is long-lived (~60 days); you're warned 7 days before it expires. |
| **Google Ads** | OAuth client (Web) in Google Cloud with the Google Ads API enabled, plus a **developer token** from your manager account | A test-level developer token only works on test accounts; apply for Basic access for real ones. Manager (MCC) accounts are expanded to their client accounts automatically. |

API versions are configurable (`META_API_VERSION`, `GOOGLE_ADS_API_VERSION`) so you can follow each platform's deprecation schedule without code changes.

## Security

- Platform OAuth tokens are encrypted at rest with **AES-256-GCM** (`ENCRYPTION_KEY`) and never sent to the browser. Meta calls include `appsecret_proof`.
- Sessions use signed httpOnly cookies. Mutations require a custom header (CSRF guard). Login attempts are throttled.
- OAuth `state` is one-time, expires after 15 minutes and is bound to the user who started the flow.
- Account selection is re-verified server-side against what the token can actually access.
- Roles: **editor** (create, generate, edit), **manager** (approve, deploy, pause/end, budgets, rules, apply suggestions), **admin** (users, settings, disconnect).
- Hard budget caps per campaign live in `.env`. Admin settings can only tighten them, never raise them.
- A strict CSP is applied, uploads are validated by magic bytes, and creative and upload file access is authenticated with path-traversal checks.
- Run behind HTTPS in production (`NODE_ENV=production` enables secure cookies and HSTS).

## Project layout

```
src/
  server.js              Express app, security headers, static frontend
  config.js  db.js       env config; SQLite schema (node:sqlite)
  auth.js crypto.js      sessions, roles, CSRF; AES-GCM, scrypt, HMAC
  audit.js notify.js     append-only audit log; in-app/email/Slack notifications
  ai/                    claude.js (structured outputs), generate.js, optimize.js, creative.js (SVG→PNG)
  platforms/             meta.js, google.js (+ connections/OAuth, http retry, money units)
  services/              campaigns, lifecycle (deploy/rollback/status), metrics, rules, optimizer, scheduler
  routes/                REST API
public/                  single-page UI (no build step)
data/                    SQLite DB, creatives, uploads (git-ignored)
```

## Operational notes

- Run a **single instance**: the scheduler and the per-campaign locks are in-process.
- Back up `data/` and keep `ENCRYPTION_KEY` safe. Losing the key means reconnecting every platform.
- Google Search campaigns have no end date set on Google's side. The scheduler pauses them at end time, and the total-spend guard also applies.
- Before the first real campaign, verify each connection with a small budget and a near-term schedule.
