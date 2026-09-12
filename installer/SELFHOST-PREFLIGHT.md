# Traks self-host preflight

Date: 2026-09-10
Repository: https://github.com/shivamanupadi/traks
Baseline: `1793b48cbbb40a2a0057080e10d233c5c1bf0dd3` / `v0.1.41`

## Decision

Deploy one isolated, self-owned Traks instance into Cloudflare account
`33a4755db3c77ef93b7e5bf75f13b711`, but do not install its tracker on any
production site yet. This proves ownership, data path, provisioning, and
dashboard health before a site is selected. The first tracked site must be
non-critical and must remain pending until the user names it.

## Requirements Brief

- Analytics owner: `xuhp630@gmail.com` Cloudflare account owner.
- Target site: pending. No tracker may be installed until selected.
- Current analytics stack: not supplied; no migration or replacement claim is
  made yet.
- Privacy constraints: user wants a full-source self-deployment where the
  author's `traks.dev` service is not in the runtime data path.
- Acceptance criteria: local release builds and checks pass; Cloudflare
  resources deploy under explicit account/instance names; owner claim is
  protected; dashboard/config/tracker endpoints pass production smoke; after
  a site is selected, realtime, today, and one historical query must match an
  independently generated test event.

## Demand Evidence

Confirmed demand is ownership and isolation: run the complete MIT source in
the user's own Cloudflare account and avoid `traks.dev` as a deployment or
runtime dependency. Cost and analytics-gap evidence cannot be finalized
because the current stack and target site have not been supplied. This does
not block an empty-instance deployment, but does block claiming product or
migration validation.

## Competitor Matrix

| Option | Public ownership/data-path position | Pricing signal | Fit / migration cost |
| --- | --- | --- | --- |
| Traks self-host | Full source in user's Cloudflare account; README says no third-party services in the analytics data path and dashboard calls no third party | Software free/MIT; README estimates about $5/month Workers Paid base for 100k pageviews | Highest ownership/control; highest operations and beta-dependency burden |
| Plausible Cloud | Vendor-hosted, EU infrastructure; no cookies or cross-site/device tracking | Public homepage showed $9/month annual billing for up to 10k monthly pageviews | Low operations; less infrastructure control and recurring SaaS fee |
| Umami Cloud / self-host | Open source; cloud FAQ says self-hosting is free and cloud handles infrastructure/updates | Cloud is usage-based; exact current tier prices not captured | Good self-host alternative, but typically server/database operations rather than this all-Cloudflare path |
| PostHog Cloud | Product analytics suite with web analytics, replay, flags, experiments, warehouse | Public pricing page lists 1M analytics events/month free; paid usage beyond allowances | Much broader product surface than Traks; heavier data/model and SDK implications |
| Cloudflare Web Analytics | Same Cloudflare vendor/account ecosystem | Cloudflare account plans/features; current Traks-specific free-tier evidence not captured | Lowest friction, but less independent open-source control and not the same self-hosted event/history architecture |
| GA4 | Google-controlled analytics and product ecosystem | Generally free core usage, subject to Google terms/capacity | Highest ecosystem lock-in and privacy/consent surface; no self-host data ownership |

This is a selection matrix, not proof that Traks outperforms every option for
the still-unnamed site. Current-workflow insufficiency remains pending.

## Open-Source Reuse Matrix

- License: MIT.
- Baseline: release `v0.1.41`, latest GitHub release observed on 2026-09-10.
- Activity: latest commit pushed 2026-09-10; releases observed from `v0.1.34`
  through `v0.1.41`; repository is not archived.
- Signal check: 25 GitHub stars and 1 open issue. This is a young/low-adoption
  project, so production use requires commit pinning and staged rollout.
- Hygiene: `README.md`, `SECURITY.md`, `CONTRIBUTING.md`, and CI are present;
  CI runs `yarn check:ci`. No independent security audit was found or claimed.
- Cloudflare dependencies: Workers, Durable Objects, D1, KV, Pipelines, R2
  Data Catalog, and R2 SQL. README identifies Pipelines, Catalog, and R2 SQL
  as open beta in Sep 2026 and states that billing is live.
- Cost risk: Workers Paid base plus billed Pipelines/Catalog/R2 SQL usage.
  README estimates about $5/month for a 100k-pageview side project.
- Update risk: future upstream changes may change bindings, migrations, or
  beta APIs. Re-run local checks and review release notes before updating.

## MVP Scope

Must, empty instance: local artifact validation, correct Cloudflare bindings,
migrations, durable secrets, first-run claim protection, health/config smoke,
and collect script availability.

Must, first non-critical site: install the documented tracker only after site
selection, send one controlled real visit/event, verify realtime view, today
view, and one historical query, then schedule a 48-hour accuracy review.

Not in first deployment: critical-site rollout, bulk migration, custom domain,
MCP integrations, multi-user access, historical backfill, or billing optimization.

## Test Strategy

- Local: `yarn traks:build`, `yarn lint`, `yarn type-check`,
  `node --check installer/local-provision.mjs`, `git diff --check`, and
  `TRAKS_VALIDATE_ONLY=1` release validation all passed on 2026-09-10.
- Artifact size: about 3017 KiB API Worker and 263 KiB collect Worker Total
  Upload; 295 dashboard assets. Well below the current Cloudflare Workers
  64 MiB Total Upload decision threshold.
- Deployment: record every created resource; fail on incomplete provisioning,
  migration, binding, secret, or smoke step.
- Production smoke: `/api/health` must return `"ok"`; `/api/config` must
  expose the collect URL; collect `/t.js` must load and contain `traks`.
- Site acceptance: pending until a non-critical target site is selected and a
  controlled event is observed across realtime, today, and history.
- Review window: 48 hours after first real tracker installation.

## Runtime Privacy And Data Path

`installer/local-provision.mjs` reads local release artifacts and calls
Cloudflare APIs directly. It does not call `traks.dev`. After deployment,
browser/dashboard traffic goes to the user's Cloudflare Workers; tracker data
goes from the selected site to the user's collect Worker. README states that
Traks stores no raw IP, uses no tracking cookie, and derives a daily-rotating
HMAC visitor hash. Those source-backed claims are separate from a real-site
cookie/network audit, which remains pending until a site is connected.

## Operational Notes

- Cloudflare API token is stored only in macOS Keychain as generic password
  `traks-selfhost` for account `chenhuaping`; never store the token in Git.
- Instance name: `traks-selfhost`.
- Rollback for a tracked site: remove the tracker snippet.
- Full uninstall is not one-command in this local path. Do not manually delete
  Iceberg bucket objects; they are table state. A future uninstall script must
  remove Workers, Pipelines pipeline/sink/stream, catalog registration/catalog,
  bucket, D1, and KV in a reviewed order.

## Pending Evidence

- Target production or staging site.
- Current analytics stack and concrete pain it fails to solve.
- First-run owner claim completion.
- Real-site tracker load, event request, realtime/today/history agreement.
- Cookie/network privacy audit against the selected site.
- 48-hour data-accuracy review.

## Deployment Checkpoint

### 2026-09-10 deployment complete

At 23:04 Asia/Shanghai, `traks-selfhost` v0.1.41 finished provisioning in
Cloudflare account `33a4755db3c77ef93b7e5bf75f13b711`.

Created/reused resources:

- Workers: `traks-selfhost-api`, `traks-selfhost-collect`
- D1: `traks-selfhost-db`
- KV: `traks-selfhost-r2sql-cache`
- R2/Catalog: `traks-selfhost-events`
- Pipelines stream/sink/pipeline: `traks_selfhost_events_stream`,
  `traks_selfhost_events_sink`, `traks_selfhost_events`

Production smoke passed independently after deployment:

- `https://traks-selfhost-api.xuhp630.workers.dev/api/health` returned HTTP 200
  with status `ok` and version `0.1.41`.
- `/api/config` returned the dedicated collect Worker URL.
- `https://traks-selfhost-collect.xuhp630.workers.dev/t.js` returned HTTP 200
  and loaded the tracker script.

The first-owner claim URL is intentionally not recorded here. The deployer can
regenerate it by rerunning the idempotent `yarn traks:selfhost` command only
while the instance remains unclaimed. If needed, rotate or replace the
`CLAIM_TOKEN` Worker secret before sharing a claim URL.

### 2026-09-10 earlier checkpoint

At 21:49 Asia/Shanghai, the first local provisioning run stopped before
Workers/Pipelines creation. `traks-selfhost-db`, D1 migrations,
`traks-selfhost-r2sql-cache`, `traks-selfhost-events`, and the active R2
Catalog configuration were created successfully. Workers and Pipelines were
absent at that point.

Cloudflare rejected Pipelines list calls with HTTP 403 for both the saved
custom API token and a refreshed Wrangler OAuth token before Workers Paid was
fully active. After purchase/feature activation propagated, the same token
verified as `187f3597327af7ae127b51ec57239d62`, Pipelines operations succeeded,
and no resources were renamed or recreated.
