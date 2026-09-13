import { useMemo, useState, type ReactElement } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertCircle, Download, RefreshCw, ShieldCheck } from 'lucide-react';
import {
  FUNNEL_LABELS,
  MIN_RATE_SAMPLE,
  issueMarkdown,
  issueDiagnosis,
  buildAnalysisPackage,
  analysisMarkdown,
  loadCompleteEvidence,
  sessionsCsv,
  type EvidencePage,
  type Period,
  type QualityIssue,
  type TrafficSelection,
} from '@traks/shared';
import { api, type AnalyticsFilters } from '@/lib/api';
import { QualityReadingGuide, QualityWorkflow } from './QualityWorkflow';

const CONTROL =
  'min-h-11 rounded-xl border border-[#E6E4DE] bg-white px-3 py-2 text-sm text-[#3D3B4F] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#467B64] disabled:cursor-not-allowed disabled:opacity-50';
const TRAFFIC = {
  production: 'Labelled production',
  qa: 'QA',
  internal: 'Internal',
  unknown: 'Historical / unknown',
  all: 'All traffic',
} as const;
const REVIEWS = {
  unverified: 'Not rechecked',
  reproduced: 'Reproduced manually',
  fixed: 'Fix manually verified',
  recheck: 'New evidence — recheck',
} as const;
type Review = { state: 'unverified' | 'reproduced' | 'fixed'; at: number };
const date = (timestamp: number): string =>
  new Date(timestamp).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';

function download(contents: string, filename: string, type: string): void {
  const url = URL.createObjectURL(new Blob([contents], { type }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function IssueCard({
  issue,
  traffic,
  siteId,
}: {
  issue: QualityIssue;
  traffic: TrafficSelection;
  siteId: string;
}): ReactElement {
  const storageKey = `traks-quality-review:${siteId}:${traffic}:${issue.key}`;
  const [storageError, setStorageError] = useState(false);
  const [review, setReview] = useState<Review>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) || 'null') as Review | null;
      if (
        saved &&
        ['unverified', 'reproduced', 'fixed'].includes(saved.state) &&
        Number.isFinite(saved.at) &&
        saved.at <= Date.now()
      )
        return saved;
    } catch {
      return { state: 'unverified', at: 0 };
    }
    return { state: 'unverified', at: 0 };
  });
  const status = review.state === 'fixed' && issue.lastAt > review.at ? 'recheck' : review.state;
  const diagnosis = issueDiagnosis(issue);
  return (
    <article className="min-w-0 rounded-2xl border border-[#E6E4DE] p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-sm font-semibold text-[#3D3B4F]">{issue.kind}</h4>
        <span className="rounded-full bg-[#F6EEE8] px-2 py-1 text-[11px] text-[#8A503A]">
          {REVIEWS[status]}
        </span>
      </div>
      <p className="mt-2 break-all text-xs font-medium">{issue.path}</p>
      <p className="mt-1 break-all text-[11px] text-[#6E6C7C]">
        {issue.version} · {issue.locale} · {issue.browser}
      </p>
      <p className="mt-3 text-sm">
        {issue.sessions} affected sessions · {issue.events} signals
      </p>
      <div className="mt-3 rounded-xl bg-[#F7F6F2] p-3 text-xs leading-relaxed">
        <p className="font-semibold break-words">
          {issue.outcome} · {issue.reason}
          {issue.httpStatus ? ` · HTTP ${issue.httpStatus}` : ''}
        </p>
        {issue.formKind !== 'unknown' && <p>Form: {issue.formKind}</p>}
        <p className="mt-2">原因线索（非根因结论）：{diagnosis.evidence}</p>
        <p className="mt-2 text-[#6E6C7C]">建议核查：{diagnosis.nextCheck}</p>
      </div>
      <p className="mt-1 text-[11px] text-[#6E6C7C]">
        First: {date(issue.firstAt)}
        <br />
        Last: {date(issue.lastAt)}
      </p>
      <label className="mt-3 block text-xs">
        Manual review (this browser only)
        <select
          className={`${CONTROL} mt-1 w-full`}
          value={review.state}
          onChange={event => {
            const next: Review = { state: event.target.value as Review['state'], at: Date.now() };
            setReview(next);
            try {
              localStorage.setItem(storageKey, JSON.stringify(next));
              setStorageError(false);
            } catch {
              setStorageError(true);
            }
          }}
        >
          <option value="unverified">Not rechecked</option>
          <option value="reproduced">Reproduced manually</option>
          <option value="fixed">Fix manually verified</option>
        </select>
      </label>
      {storageError && (
        <p role="status" className="mt-1 text-xs text-red-700">
          Storage unavailable; review is temporary.
        </p>
      )}
      <button
        className={`${CONTROL} mt-3 flex w-full items-center justify-center gap-2`}
        onClick={() =>
          download(
            issueMarkdown(issue, traffic, REVIEWS[status], review.at || undefined),
            'analytics-requirement.md',
            'text/markdown;charset=utf-8'
          )
        }
      >
        <Download className="h-3.5 w-3.5" />
        Export requirement
      </button>
    </article>
  );
}

export function QualityConsole({
  siteId,
  period,
  filters,
}: {
  siteId: string;
  period: Period;
  filters?: AnalyticsFilters;
}): ReactElement {
  const [run, setRun] = useState(0);
  const [traffic, setTraffic] = useState<TrafficSelection>('production');
  const [tab, setTab] = useState<'sessions' | 'funnels' | 'issues' | 'actions'>('actions');
  const [progress, setProgress] = useState<EvidencePage | null>(null);
  const [page, setPage] = useState(0);
  const [pathFilter, setPathFilter] = useState('');
  const [versionFilter, setVersionFilter] = useState('all');
  const queryClient = useQueryClient();
  const queryKey = ['quality-evidence', siteId, period, filters, run];
  const scan = useQuery({
    queryKey,
    queryFn: ({ signal }) =>
      loadCompleteEvidence(
        cursor => api.getQualityEvidence(siteId, period, filters, cursor, signal),
        evidence => setProgress({ ...evidence, data: [] }),
        signal
      ),
    enabled: run > 0,
    retry: false,
    gcTime: 0,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const report = useMemo(() => scan.data?.accumulator.report(traffic), [scan.data, traffic]);
  const ready = !!report && !scan.isFetching && !scan.isError;
  const versions = [...new Set(report?.funnels.map(funnel => funnel.version) ?? [])];
  const visibleFunnels =
    report?.funnels.filter(
      funnel =>
        funnel.path.includes(pathFilter) &&
        (versionFilter === 'all' || funnel.version === versionFilter)
    ) ?? [];
  const visibleIssues =
    report?.issues.filter(
      issue =>
        issue.path.includes(pathFilter) &&
        (versionFilter === 'all' || issue.version === versionFilter)
    ) ?? [];
  const start = (): void => {
    setProgress(null);
    setPage(0);
    setVersionFilter('all');
    setRun(value => value + 1);
  };

  return (
    <section
      aria-label="Traffic quality and requirements"
      className="min-w-0 rounded-[20px] bg-white p-4 shadow-float sm:p-6"
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-[#467B64]">
            <ShieldCheck className="h-3.5 w-3.5" />
            Evidence before decisions
          </p>
          <h3 className="mt-1 text-lg font-bold tracking-tight text-[#3D3B4F]">
            Traffic quality & requirements
          </h3>
          <p className="mt-1 max-w-2xl text-xs leading-relaxed text-[#6E6C7C]">
            Isolate QA, export every session, inspect ordered calculator funnels and turn error
            signals into requirements.
          </p>
        </div>
        <button
          className={`${CONTROL} flex items-center gap-2`}
          disabled={scan.isFetching}
          onClick={start}
        >
          <RefreshCw className={`h-3.5 w-3.5 ${scan.isFetching ? 'animate-spin' : ''}`} />
          {run ? 'Refresh full window' : 'Load complete window'}
        </button>
      </div>
      <p className="mt-4 rounded-xl bg-[#F5F5F0] px-3 py-2 text-[11px] leading-relaxed text-[#6E6C7C]">
        This section has its own traffic filter. The overview, trends and legacy diagnostics keep
        their original population (including QA / unknown). Dashboard filters select matching
        sessions; this analysis reads their whole observed window. Production labels do not prove
        human or organic traffic.
      </p>
      <QualityReadingGuide />
      <div className="mt-4 flex flex-wrap items-end gap-3">
        <label className="text-xs">
          Traffic scope
          <select
            aria-label="Quality traffic scope"
            className={`${CONTROL} ml-2`}
            value={traffic}
            onChange={event => {
              setTraffic(event.target.value as TrafficSelection);
              setPage(0);
              setVersionFilter('all');
            }}
          >
            {Object.entries(TRAFFIC).map(([value, title]) => (
              <option key={value} value={value}>
                {title}
              </option>
            ))}
          </select>
        </label>
        <span className="text-[11px] text-[#6E6C7C]">
          Unknown history is never silently relabelled production.
        </span>
      </div>

      {scan.isFetching && (
        <div className="mt-4" role="status" aria-live="polite">
          <div className="flex items-center justify-between gap-2 text-xs">
            <span>
              Reading {progress?.scannedGroups ?? 0} / {progress?.totalGroups ?? '…'} evidence
              groups. Not complete yet.
            </span>
            <button
              className={CONTROL}
              onClick={() => void queryClient.cancelQueries({ queryKey, exact: true })}
            >
              Cancel scan
            </button>
          </div>
          <progress
            className="mt-2 h-2 w-full accent-[#467B64]"
            max={progress?.totalGroups || 1}
            value={progress?.scannedGroups || 0}
            aria-label="Evidence scan progress"
          />
        </div>
      )}
      {scan.isError && (
        <p
          role="alert"
          className="mt-4 flex items-start gap-2 rounded-xl bg-red-50 p-3 text-xs text-red-800"
        >
          <AlertCircle className="h-4 w-4 shrink-0" />
          {scan.error.message} No partial export is available.
        </p>
      )}
      {!scan.isFetching && !ready && !scan.isError && (
        <p className="mt-5 text-sm text-[#6E6C7C]">
          {run
            ? 'Scan is incomplete or cancelled. Restart to enable results and exports.'
            : 'Load the full reporting window before drawing conclusions. Historical windows use the existing R2 SQL service; each page is a read query.'}
        </p>
      )}

      {ready && report && scan.data && (
        <>
          <div className="mt-5 grid grid-cols-2 gap-2 lg:grid-cols-4">
            {(['production', 'qa', 'internal', 'unknown'] as const).map(kind => (
              <div key={kind} className="rounded-xl bg-[#F7F7F3] p-3">
                <p className="text-[10px] text-[#6E6C7C]">{TRAFFIC[kind]}</p>
                <p className="mt-1 text-xl font-semibold tabular-nums text-[#3D3B4F]">
                  {report.classification[kind]}
                </p>
              </div>
            ))}
          </div>
          <p className="mt-3 break-words text-[11px] leading-relaxed text-[#6E6C7C]">
            Complete: {scan.data.totalGroups} groups / {scan.data.totalEvents} events. Window:{' '}
            {date(scan.data.window.from)} → {date(scan.data.window.to)} ({scan.data.window.source}).{' '}
            {report.unassociatedEvents} events without session IDs are excluded from session
            analysis. Export covers observed session summaries in this window, not entire lifetime
            histories.
          </p>
          <div
            className="mt-5 flex flex-wrap gap-2"
            role="group"
            aria-label="Quality analysis views"
          >
            {(['actions', 'issues', 'funnels', 'sessions'] as const).map(value => (
              <button
                key={value}
                aria-pressed={tab === value}
                className={`${CONTROL} ${tab === value ? '!border-[#467B64] !bg-[#EAF2EC] font-semibold' : ''}`}
                onClick={() => setTab(value)}
              >
                {value === 'sessions'
                  ? 'Sessions & export'
                  : value === 'funnels'
                    ? 'Calculator funnels'
                    : value === 'issues'
                      ? 'Error requirements'
                      : '优化闭环'}
              </button>
            ))}
          </div>
          {report.sessions.some(session => session.diagnosticsLimited) && (
            <p role="status" className="mt-3 rounded-xl bg-amber-50 p-3 text-xs text-amber-900">
              Diagnostic rate limit reached in{' '}
              {report.sessions.filter(session => session.diagnosticsLimited).length} sessions. Error
              counts are lower bounds; complete export means retained observations, not every
              browser failure.
            </p>
          )}
          {tab === 'actions' ? (
            <QualityWorkflow
              key={traffic}
              report={report}
              onExport={format => {
                const pack = buildAnalysisPackage(report, {
                  siteId,
                  period,
                  traffic,
                  ...scan.data.window,
                  totalGroups: scan.data.totalGroups,
                  totalEvents: scan.data.totalEvents,
                  cohortFilterKeys: Object.keys(filters ?? {}),
                });
                download(
                  format === 'json' ? JSON.stringify(pack, null, 2) : analysisMarkdown(pack),
                  format === 'json'
                    ? 'website-optimization-evidence.json'
                    : 'website-optimization-actions.md',
                  format === 'json'
                    ? 'application/json;charset=utf-8'
                    : 'text/markdown;charset=utf-8'
                );
              }}
            />
          ) : tab === 'sessions' ? (
            <div className="mt-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-xs">
                  Showing {report.sessions.length ? page * 50 + 1 : 0}–
                  {Math.min((page + 1) * 50, report.sessions.length)} of {report.sessions.length}{' '}
                  {TRAFFIC[traffic].toLowerCase()} sessions.
                </p>
                <button
                  className={`${CONTROL} flex items-center gap-2`}
                  onClick={() =>
                    download(
                      sessionsCsv(report.sessions),
                      `sessions-${traffic}-${period}.csv`,
                      'text/csv;charset=utf-8'
                    )
                  }
                >
                  <Download className="h-3.5 w-3.5" />
                  Export all {report.sessions.length} sessions
                </button>
              </div>
              {!report.sessions.length && (
                <p className="my-6 text-sm text-[#6E6C7C]">
                  No sessions in this scope. Select Historical / unknown to inspect unlabelled
                  history; this is not evidence of user churn.
                </p>
              )}
              <ul className="mt-3 divide-y divide-[#E6E4DE]">
                {report.sessions.slice(page * 50, (page + 1) * 50).map(session => (
                  <li
                    key={session.sessionId}
                    className="flex flex-wrap justify-between gap-2 py-3 text-xs"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="break-all font-medium">
                        {session.entryPath} → {session.exitPath}
                      </p>
                      <p className="mt-1 break-all text-[11px] text-[#6E6C7C]">
                        {date(session.startedAt)} ·{' '}
                        {session.versions.join(' / ') || 'Version unknown'}
                      </p>
                    </div>
                    <p className="shrink-0 tabular-nums">
                      {session.pageviews} PV · {session.events} events
                    </p>
                  </li>
                ))}
              </ul>
              <div className="mt-3 flex gap-2">
                <button
                  className={CONTROL}
                  disabled={page === 0}
                  onClick={() => setPage(value => value - 1)}
                >
                  Previous 50
                </button>
                <button
                  className={CONTROL}
                  disabled={(page + 1) * 50 >= report.sessions.length}
                  onClick={() => setPage(value => value + 1)}
                >
                  Next 50
                </button>
              </div>
            </div>
          ) : (
            <div className="mt-4">
              <div className="flex flex-wrap gap-3">
                <label className="text-xs">
                  Calculator / path
                  <input
                    className={`${CONTROL} ml-2 max-w-full`}
                    value={pathFilter}
                    onChange={event => setPathFilter(event.target.value)}
                    placeholder="/concrete-…"
                  />
                </label>
                <label className="text-xs">
                  Version
                  <select
                    className={`${CONTROL} ml-2`}
                    value={versionFilter}
                    onChange={event => setVersionFilter(event.target.value)}
                  >
                    <option value="all">All versions (separate groups)</option>
                    {[...new Set([...versions, ...report.issues.map(issue => issue.version)])].map(
                      version => (
                        <option key={version}>{version}</option>
                      )
                    )}
                  </select>
                </label>
              </div>
              {tab === 'funnels' ? (
                <>
                  <p className="my-3 text-[11px] leading-relaxed text-[#6E6C7C]">
                    Ordered within each session + calculator + version + language + device. Defaults
                    submitted without a recorded valid edit do not pass the input stage. Missing
                    stages, validation errors and abandonment are not permanent churn. Rates require
                    at least {MIN_RATE_SAMPLE} visits (a display threshold, not statistical
                    significance). Unknown-version history is excluded.
                  </p>
                  <div className="space-y-3">
                    {visibleFunnels.map(funnel => (
                      <article
                        key={JSON.stringify([funnel.path, funnel.version, funnel.device])}
                        className="rounded-2xl border border-[#E6E4DE] p-4"
                      >
                        <h4 className="break-all text-xs font-semibold">{funnel.path}</h4>
                        <p className="mt-1 text-[11px] text-[#6E6C7C]">
                          {funnel.version} · {funnel.locale} · {funnel.device}
                        </p>
                        <ol className="mt-3 space-y-2">
                          {FUNNEL_LABELS.map((title, index) => (
                            <li key={title}>
                              <div className="flex justify-between gap-2 text-xs">
                                <span>{title}</span>
                                <span className="tabular-nums">
                                  {funnel.stages[index]}
                                  {funnel.stages[0] >= MIN_RATE_SAMPLE
                                    ? ` · ${Math.round((funnel.stages[index] / funnel.stages[0]) * 100)}%`
                                    : ''}
                                </span>
                              </div>
                              <div className="mt-1 h-1.5 rounded bg-[#F2F1ED]">
                                <div
                                  className="h-full rounded bg-[#6C957A]"
                                  style={{
                                    width: `${funnel.stages[0] ? (funnel.stages[index] / funnel.stages[0]) * 100 : 0}%`,
                                  }}
                                />
                              </div>
                            </li>
                          ))}
                        </ol>
                        <p className="mt-3 text-[11px] leading-relaxed text-[#6E6C7C]">
                          {funnel.validationSessions} sessions with validation signals ·{' '}
                          {funnel.abandonedSessions} with abandonment · {funnel.failedSessions} with
                          failure · {funnel.blockedSessions} with business blockers ·{' '}
                          {funnel.cancelledSessions} with cancellation ·{' '}
                          {funnel.incompleteSuccessSessions} with success missing earlier evidence.{' '}
                          {funnel.stages[0] < MIN_RATE_SAMPLE &&
                            'Insufficient sample — counts only.'}
                        </p>
                      </article>
                    ))}
                  </div>
                  {!visibleFunnels.length && (
                    <p className="my-6 text-sm text-[#6E6C7C]">
                      No versioned calculator evidence in this scope. This is not a 0% conversion
                      rate.
                    </p>
                  )}
                </>
              ) : (
                <>
                  <p className="my-3 text-[11px] leading-relaxed text-[#6E6C7C]">
                    Historical signals are not automatically current defects. No raw input, error
                    messages, URL queries or session IDs enter requirement cards. Reviews are
                    manual, local to this browser and never inferred from HTTP 200. Failure,
                    validation, business blockers and cancellation stay separate. Signals are not
                    unique failure attempts; later success does not erase failures.
                  </p>
                  <div className="grid gap-3 lg:grid-cols-2">
                    {visibleIssues.map(issue => (
                      <IssueCard
                        key={`${traffic}:${issue.key}`}
                        issue={issue}
                        traffic={traffic}
                        siteId={siteId}
                      />
                    ))}
                  </div>
                  {!visibleIssues.length && (
                    <p className="my-6 text-sm text-[#6E6C7C]">
                      No observed error signals in this scope — not proof that no defects exist.
                    </p>
                  )}
                </>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}
