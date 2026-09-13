# Traffic quality and requirement triage

The dashboard keeps its existing trend-first overview. The **Traffic quality &
requirements** section is a separate, explicitly scoped analysis surface. Its
default is **Labelled production**, not all traffic and not a claim of organic or
human visitors. The legacy overview and Top-N diagnostics retain their original
population; their numbers are not interchangeable with this section.

## Instrumentation contract

Concrete Estimator Hub adds these allowlisted properties to workflow events:

| Property           | Meaning                                                       |
| ------------------ | ------------------------------------------------------------- |
| `traffic_type`     | `production`, `qa` or `internal`                              |
| `tracking_version` | `cw-v3`, the measurement contract                             |
| `release_version`  | `quality-v3`, an instrumentation release label, not a Git SHA |
| `locale`           | `en`, `es` or `fr`                                            |

Use `?analytics_traffic=qa` or the existing `utm_source=release-qa` for controlled
QA. Use `?analytics_traffic=internal` for internal checks. Localhost is internal.
Within a tab's 30-minute active session, classification can promote to QA/internal
but cannot downgrade to production. Use a fresh browser session after QA. Storage
failure falls back to document memory; cross-document continuity cannot be
guaranteed when the browser denies session storage. No classification is inferred
from identity, IP addresses, email or typed inputs. DNT/GPC still short-circuit
tracking before these properties are prepared.

Increment the release label for future instrumentation releases and the contract
version when measurement semantics change. Keep a release receipt mapping these
labels to Git/Worker versions. Neither label is a human identity or authorization
token. The collector's bot filtering is unchanged. Absence of a known version or
traffic label is **unknown**, never retroactively production.

Session classification considers every observed event in the window:
QA > internal > labelled production > unknown. A late QA marker excludes the
whole observed session from the production view, including earlier events.
Historical `release-qa` pageviews also provide explicit QA evidence.

Unknown sessions remain unknown, but the complete export reports a diagnostic
reason without relabelling history: `pageview_only_unknown` (no custom workflow
evidence), `legacy_custom_unknown` (custom events without a valid version), or
`missing_context_unknown` (versioned custom events that do not provide a valid
production/qa/internal label). Pageview-only traffic must not be interpreted as
verified human visitors or user churn.

Diagnostic reasons are monotonic: versioned missing-context evidence takes
precedence over legacy custom events regardless of arrival order. A later legacy
event cannot erase the diagnostic. Explicit QA/internal promotion still applies
to the whole observed session; this does not reclassify unknown history as users.

## Complete reads and session export

`GET /api/analytics/:siteId/stats/quality-evidence?period=…&cursor=…` uses the existing
authentication and site-access checks on every page. Dashboard dimension filters
select matching sessions; evidence then includes their whole observed window so
a page filter cannot hide that session's QA marker on another page.

- Today uses the existing live SQLite Durable Object. Historical periods use
  existing R2 SQL. A failed source is not silently replaced with a different or
  shorter window.
- Each request groups identical rows while preserving their multiplicity, orders
  by all grouping columns and returns at most 500 groups. Window totals are
  calculated before pagination. There is no 100-session or 500-event export cap.
- The aggregate endpoint uses internal batches of 5,000 groups to reduce repeated
  historical SQL round trips. Public evidence pages remain 500. Both scans retain
  duplicate multiplicity and fixed bounds; aggregate scans reject changed totals,
  invalid order, missing advancement and mismatched final event counts. Very large
  windows can still time out; use complete cursor paging, not partial insights.
- Cursors bind site, timezone, period, filters and fixed window bounds. They
  expire after 30 minutes. The current edge is delayed by five seconds (live) or
  90 seconds (historical). Late pipeline ingestion can invalidate a historical
  scan; changed group/event totals cause HTTP 409 and require a restart.
- This is a bounded-time, append-only evidence scan, not a transactional database
  snapshot or a full-session-lifetime export. Very large windows require more
  queries and client memory; cancel or choose a shorter period if needed. All
  periods remain explicit and no paid resources are provisioned by this feature.
- The client validates page advancement, totals, ordering, scope and final event
  counts. Partial/cancelled/failed scans do not expose result tables or complete
  export buttons. Scans do not automatically repeat on focus/reconnect.
- The CSV contains **every session summary in the selected traffic scope and
  reporting window**, not raw event payloads. Paging the visible list (50 rows)
  does not limit export. Formula-like CSV values are escaped. Events without a
  valid opaque session ID are counted and explicitly excluded from session
  analysis; this is not silently presented as universal coverage.

## Calculator funnel semantics

Group by collector session + calculator pathname + tracking/release version +
locale + device. Each session contributes at most once to a stage within that
group. Summing calculator groups is not a sitewide distinct-session count.

1. Versioned `page_viewed` on a calculator owner (including the homepage).
2. `field_completed` from `form_kind=calculator`, with `is_valid=true`,
   `was_changed=true` and `completion_state=filled`.
3. `calculator_submit_click` after that input.
4. `calculator_submit_success` after submission.
5. `calculator_copy_success`, `export_pdf_success`, or a result CTA to quote
   review / contractor bid comparison after success.

The recorded collector order supplies sequence evidence. Equal timestamps have
a deterministic database tie order, not proof of distinct browser timings;
out-of-order delivery or missing instrumentation can therefore produce missing
stage evidence. Default-value submissions without an observed edit do not pass
the input stage. Result impressions, copy attempts, print requests, login prompts
and unrelated success events do not imply completion. No cross-calculator or
cross-version conversion joining occurs. Validation and abandonment are separate
session signals, not permanently lost users. Earlier failures remain visible if
a later attempt succeeds.

Below 30 visit sessions, show counts only and “Insufficient sample.” This is a
display guard, not a statistical significance test. Even larger samples do not
justify causal churn claims. Unknown-version history is not reconstructed into
this new funnel.

## Error requirements

Cards aggregate 404, runtime/rejection/boundary, validation, calculator submit,
resource, copy, PDF, project-save, checkout and handled form errors by path,
version, locale, browser, kind, reason, HTTP status, form and resource category. They contain first/last timestamps, total
signals and distinct affected sessions, but no raw error text, query values,
user inputs or session IDs. Paths and private/dynamic segments are sanitized at
the API boundary, including historical metadata.

Manual statuses are stored only in this browser, scoped by site and traffic
selection; storage errors are visible. A newer error after a locally verified fix
requires rechecking. Status is never inferred from an HTTP 200 or a deployment.
Markdown export produces a requirement candidate with evidence, missing
reproduction steps and acceptance criteria. It does not open an issue, send a
notification, fetch the reported URL or claim to have reproduced the error.

## Unsuccessful operations and diagnosis

Success-only funnel stages do **not** discard failed attempts. Failures are
retained even when the same session later succeeds. Funnel cards separately count
sessions with failures, validation, business blockers and cancellations; counts
overlap and must not be summed into a unique failure total. Non-calculator forms
do not contaminate calculator validation, failure or abandonment counters.

| Capture surface                           | Evidence / limits                                                                                                                                                                                                                                  |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 13 calculator submit handlers             | Synchronous exceptions emit `calculator_submit_error` and rethrow the original error; a shared error-object guard prevents duplicate global/boundary reporting. Native form rejection remains separate from a submit click.                        |
| Clipboard                                 | Success/error plus permission, secure-context, unavailable-API or unknown categories. No clipboard text. Pads/piers also use the common contract.                                                                                                  |
| Native validation                         | Deduplicated fields and `required`, `format`, `range`, `step`, `length`, `bad_input` rule categories; no values. Custom calculator validation reports rejection, not a guessed rule.                                                               |
| PDF                                       | HTTP status/business codes; transport offline/unresolved/abort/timeout categories. HTTP 200 with non-PDF or empty content is rejected instead of becoming a success. Download initiation is observed, not proof the user saved or opened the file. |
| Save / checkout / public forms            | Existing catch/callback paths retain safe status/error categories. Login, upgrade and project limits are business blockers, not automatically bugs. Authentication does not export raw provider messages/codes.                                    |
| Global error / rejection / route boundary | Safe exception classes; no raw message or stack. Unknown errors remain unknown and require reproduction.                                                                                                                                           |
| Resource loading                          | Capture-phase listener observes non-bubbling errors on image/script/link/media/source elements; records tag only, no asset URL.                                                                                                                    |

The collector API independently allowlists `failure_reason`, validity flags,
status, form and resource categories. It derives the outcome (`failed`, `invalid`,
`blocked`, `cancelled`) rather than trusting a supplied outcome. Requirement cards
include **observed reason hints**, a scoped follow-up checklist and acceptance
criteria; they never claim a category establishes the root cause. `AbortError`
does not prove user intent; unresolved network failures do not prove CORS/DNS or
ad-blocking. Historical errors without structured evidence stay unknown.

Global runtime, rejection and resource diagnostics each allow ten signals per
page visit. The next occurrence emits `diagnostic_limit_reached` once for that
category; the dashboard warns that error counts are lower bounds and the session
CSV includes `diagnostics_limited`. A noisy resource must not consume the runtime
budget. Multiple signals can describe one operation; signal count is not a count
of independent incidents. Summaries export every **retained observation** in the
selected window, not an assertion that every possible failure was collected.

DNT/GPC and private-target/route exclusions remain in place. No global fetch
monkey-patch, request/response body logging, input recording or new error service
is introduced. Arbitrary third-party requests, errors before the analytics bundle
loads, crashes preventing delivery, blocked trackers, uninstrumented business
paths and server-only failures are outside this capture guarantee. Production R2
compatibility and real-world causes still need a separately authorized release
and real evidence; synthetic QA must not be mixed into production analysis.

## Reading-to-optimization extension

The in-dashboard Chinese guide and **优化闭环** view explain how to read and act on
the retained evidence. The operating runbook is
[reading-optimization-guide.zh-CN.md](./reading-optimization-guide.zh-CN.md).
The same evidence is available over MCP with a read-only personal token:
`get_quality_evidence` returns one complete cursor page, and `get_quality_insights`
returns the privacy-preserving `traks-optimization-evidence/v1` aggregate package
after an internal complete scan. The aggregate endpoint rejects partial results
if source totals change. MCP clients must keep the period and filters unchanged
while paging `get_quality_evidence` until `nextCursor` is null; a summary is not a
substitute for that complete export when the task requires raw retained evidence.
The versioned `traks-optimization-evidence/v1` JSON and Markdown action brief are
available only after a complete successful scan. They export all selected-traffic
aggregate groups and candidates, never just the visible previews. They omit raw
session/page IDs, free-text filters, inputs, messages and local review states.
Whole-cohort counts and selected-traffic counts are explicitly distinguished.

Additional site events:

- `calculator_copy_attempt`: all 13 copy handlers, including no-result attempts;
  terminal success/error stays separate.
- `field_validation_recovered`: a non-sensitive calculator field with an observed
  native rejection becomes valid and changed on blur within the same page visit;
  once per observed rejection, not a calculator completion.
- `calculator_search_results_viewed`: a nonempty query's actual cmdk filtered
  count after 1.2 seconds; query text is not sent and early closure can remain
  unobserved. Generic `search_input` no longer borrows a document-wide calculator
  count and is not treated as zero-results evidence.

The analytics blur observer now reads `validity.valid` rather than calling
`checkValidity()`, avoiding self-generated rejection signals. The evidence API
accepts valid event names up to the collector's 240-character limit; its former
48-character metadata-label limit silently excluded longer event names.

Operation recovery is conservative: same collector session, page visit, version,
locale, device, calculator and operation, with strictly increasing collector
times. Missing start/page/version, tied times, grouped duplicates and overlapping
attempts are unlinked; a page with an overlapping operation is not forced back
into a recovery narrative. This is not transaction/attempt-ID tracing. All
outcome counts are session-deduplicated, may overlap and are not summed into a
sitewide distinct count. A later success does not erase failures or prove the
same input/checkout succeeded. `checkout_success` is checkout-link creation, not
payment. Unknown search counts never become zero. Rates are not synthesized for
these conservative operation groups.

Candidates distinguish observed facts, hypotheses, concrete verification actions
and guardrail metrics. The exported manual record has baseline, owner, scope,
release identity and post-release review fields. Nothing auto-files an issue,
changes a site, deploys, schedules work or claims causal lift. Comparisons require
matched, complete periods and filters; low-volume data can remain inconclusive.

## Verification / release scope

Use the site's existing unit tests for instrumentation and provider privacy.
Verify both query dialects and pagination with isolated synthetic fixtures,
including >100 sessions and >500 grouped events, duplicate counts, cancelled or
changed scans, unknown traffic, cross-calculator/version ordering and CSV safety.
Exercise the actual component on mobile and desktop with isolated API fixtures.
Mocks prove local behavior, not production data collection or R2 SQL dialect
compatibility. A subsequent authorized release must verify the versioned site
events, source reads and complete export against the actual production receiver.
No database migrations are required.

## Acquisition and request-only reply measurement

The aggregate JSON adds `acquisition` and `growthCoverage`. Each selected collector
session is assigned once to its first observed native pageview in this window:
safe UTM source/medium/campaign (referrer hostname when source is absent), entry
path, locale and device. No observed pageview means unknown attribution. Labels
reject emails, URLs, free text and long numeric/hex identifiers; campaigns must
use non-personal short slugs. This is not multi-touch or cross-day attribution.

Each signal is session-deduplicated: tool success, result use, contact start,
submit, failure, accepted request and accepted-with-reply-permission. These are
co-occurring signals, not a required ordered funnel or qualified leads. Versions
are listed per group; compare compatible releases. Earlier failure remains after
success, late QA/internal removes the entire session from production, and an old
`form_success` alone is explicitly unconfirmed. Do not infer missing signals as
zero business outcomes or add overlapping signals together.

`concrete_workflow_lead_request_accepted` requires contact form context,
`lead_confirmation=email_provider_accepted` and
`lead_observation=browser_response`. It observes the response to the existing
server email operation, not an independently verified server event or confirmed
delivery. `reply_permission=granted` applies only to that request. It is optional,
off by default, preserved in the support email with server time, and is never
marketing subscription consent. The event contains no name, email or message.

`growthCoverage` leaves qualified leads, delivered followups, customer replies
and cross-day retention as **null**, with `crmConnected=false`. CRM, delivery
webhooks, actual follow-up, opt-out handling and customer response telemetry need
a separately selected/authorized business integration. MCP is read-only and does
not send messages, collect contact lists or create consent.

`TRAKS_UPDATE_ONLY=1` now requires existing Workers, D1, KV and required secrets,
reads the migration ledger and stops if any migration is pending. It never
applies a migration, creates those resources or writes secrets/claim tokens.
Worker/assets uploads and the existing minute prewarm cron remain release writes.
