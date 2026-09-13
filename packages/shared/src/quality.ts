import { ActionAccumulator } from './quality-actions';
import { GrowthAccumulator } from './quality-growth';

export type TrafficClass = 'production' | 'qa' | 'internal' | 'unknown';
export type TrafficSelection = TrafficClass | 'all';
export type UnknownClass =
  | 'pageview_only_unknown'
  | 'legacy_custom_unknown'
  | 'missing_context_unknown';

const FAILURE_REASONS = [
  'unknown',
  'operation_cancelled',
  'timeout',
  'offline',
  'network_unresolved',
  'permission_denied',
  'quota_exceeded',
  'clipboard_unavailable',
  'insecure_context',
  'validation_rejected',
  'required',
  'format',
  'range',
  'step',
  'length',
  'bad_input',
  'login_required',
  'upgrade_required',
  'limit_reached',
  'auth_rejected',
  'verification_required',
  'not_found',
  'rate_limited',
  'server_error',
  'http_rejected',
  'invalid_response',
  'missing_result',
  'resource_load',
  'type_error',
  'range_error',
  'reference_error',
  'syntax_error',
] as const;
type FailureReason = (typeof FAILURE_REASONS)[number];
type FailureOutcome = 'failed' | 'blocked' | 'cancelled' | 'invalid';
const VALIDATION_REASONS = [
  'required',
  'format',
  'range',
  'step',
  'length',
  'bad_input',
  'validation_rejected',
];

function failureOutcome(reason: FailureReason): FailureOutcome {
  if (reason === 'operation_cancelled') return 'cancelled';
  if (
    [
      'login_required',
      'upgrade_required',
      'limit_reached',
      'auth_rejected',
      'verification_required',
      'missing_result',
    ].includes(reason)
  )
    return 'blocked';
  if (VALIDATION_REASONS.includes(reason)) return 'invalid';
  return 'failed';
}

export interface EvidenceEvent {
  channelSource: string;
  channelMedium: string;
  channelCampaign: string;
  leadAccepted: boolean;
  replyPermission: 'granted' | 'not_granted' | 'unknown';
  sessionId: string;
  pageId: string;
  calculator: string;
  searchResultCount: number | null;
  failureOutcome: FailureOutcome;
  ts: number;
  path: string;
  eventType: string;
  eventName: string;
  count: number;
  traffic: TrafficClass;
  version: string;
  locale: string;
  device: string;
  browser: string;
  validInput: boolean;
  errorKind: string;
  failureReason: FailureReason;
  httpStatus: number;
  validationReasons: string;
  formKind: string;
  resourceKind: string;
  quoteHandoff: boolean;
}

export interface EvidencePage {
  data: EvidenceEvent[];
  nextCursor: string | null;
  totalGroups: number;
  totalEvents: number;
  scannedGroups: number;
  from: number;
  to: number;
  source: 'live' | 'historical';
}

export const EVIDENCE_PAGE_SIZE = 500;
export const INSIGHT_BATCH_SIZE = 5000;
const EVIDENCE_COLUMNS = [
  'ts',
  'session_id',
  'pathname',
  'event_type',
  'event_name',
  'event_meta',
  'device_type',
  'browser',
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'referrer_hostname',
].join(', ');

export function buildEvidenceSelect(
  sourceSql: string,
  offset: number,
  limit = EVIDENCE_PAGE_SIZE
): string {
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid evidence offset');
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > INSIGHT_BATCH_SIZE)
    throw new Error('Invalid evidence limit');
  return `WITH evidence_source AS (${sourceSql}), evidence_groups AS (
    SELECT ${EVIDENCE_COLUMNS}, COUNT(*) AS event_count
    FROM evidence_source GROUP BY ${EVIDENCE_COLUMNS}
  ), evidence_ranked AS (
    SELECT *, COUNT(*) OVER () AS total_groups,
      SUM(event_count) OVER () AS total_events,
      ROW_NUMBER() OVER (ORDER BY ${EVIDENCE_COLUMNS}) AS evidence_row
    FROM evidence_groups
  ) SELECT * FROM evidence_ranked WHERE evidence_row > ${offset}
    ORDER BY evidence_row LIMIT ${limit + 1}`;
}

export function qualityPath(value: unknown): string {
  if (typeof value !== 'string') return '/:unknown';
  try {
    const url = new URL(value, 'https://analytics.invalid');
    if (!['http:', 'https:'].includes(url.protocol)) return '/:unknown';
    const path = url.pathname
      .replace(
        /^(\/(?:es\/|fr\/)?(?:dashboard|settings|admin|share|invite))(?:\/.*)?$/,
        '$1/:redacted'
      )
      .replace(/^(\/(?:es\/|fr\/)?auth\/[^/]+)\/.*$/, '$1/:redacted');
    return path
      .split('/')
      .map(segment => {
        const decoded = decodeURIComponent(segment);
        if (decoded.length > 48 || /@|\d{8,}|^[a-f0-9-]{24,}$/i.test(decoded)) return ':redacted';
        return encodeURIComponent(decoded).replace(/%3A/gi, ':');
      })
      .join('/')
      .slice(0, 256);
  } catch {
    return '/:unknown';
  }
}

function label(value: unknown, fallback = 'unknown', maxLength = 48): string {
  return typeof value === 'string' &&
    value.length <= maxLength &&
    /^[a-z][a-z0-9_.-]*$/i.test(value)
    ? value
    : fallback;
}

function channelLabel(value: unknown, fallback: string): string {
  if (value === '' || value === null || value === undefined) return fallback;
  if (typeof value !== 'string' || /\d{8,}|^[a-f0-9-]{24,}$/i.test(value)) return 'redacted';
  return label(value.toLowerCase(), 'redacted');
}

export function normalizeEvidence(row: Record<string, unknown>): EvidenceEvent {
  let props: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(String(row.event_meta || '{}'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
      props = parsed as Record<string, unknown>;
  } catch {
    props = {};
  }
  const tracking = label(props.tracking_version);
  const release = label(props.release_version);
  const traffic: TrafficClass =
    props.traffic_type === 'qa' || row.utm_source === 'release-qa'
      ? 'qa'
      : props.traffic_type === 'internal'
        ? 'internal'
        : props.traffic_type === 'production' && tracking !== 'unknown' && release !== 'unknown'
          ? 'production'
          : 'unknown';
  const rawPath = typeof props.page_path === 'string' ? props.page_path : row.pathname;
  const path = qualityPath(rawPath);
  const timestamp = Number(row.ts);
  const reason = FAILURE_REASONS.includes(props.failure_reason as FailureReason)
    ? (props.failure_reason as FailureReason)
    : 'unknown';
  return {
    channelSource: channelLabel(row.utm_source || row.referrer_hostname, 'direct_or_unattributed'),
    channelMedium: channelLabel(row.utm_medium, 'unattributed'),
    channelCampaign: channelLabel(row.utm_campaign, 'unattributed'),
    leadAccepted:
      props.lead_confirmation === 'email_provider_accepted' &&
      props.lead_observation === 'browser_response',
    replyPermission:
      props.reply_permission === 'granted' || props.reply_permission === 'not_granted'
        ? props.reply_permission
        : 'unknown',
    pageId:
      typeof props.page_id === 'string' && /^p_[a-z0-9]{12,32}$/.test(props.page_id)
        ? props.page_id
        : '',
    calculator: [
      'steps',
      'bag',
      'column',
      'cost',
      'curb',
      'footing',
      'mix_ratio',
      'ramp',
      'slab',
      'volume',
      'wall',
      'post_hole',
      'pads_piers',
    ].includes(String(props.calculator_type))
      ? String(props.calculator_type)
      : 'unknown',
    searchResultCount:
      typeof props.result_count === 'number' &&
      Number.isSafeInteger(props.result_count) &&
      props.result_count >= 0 &&
      props.result_count <= 10000
        ? props.result_count
        : null,
    failureOutcome: failureOutcome(reason),
    sessionId: /^[a-z0-9_-]{1,128}$/i.test(String(row.session_id || ''))
      ? String(row.session_id)
      : '',
    ts: Number.isFinite(timestamp) ? timestamp : Date.parse(String(row.ts)),
    path,
    eventType: row.event_type === 'pageview' ? 'pageview' : 'event',
    eventName: row.event_name === '404' ? '404' : label(row.event_name, 'unrecognized_event', 240),
    count: Number(row.event_count),
    traffic,
    version: tracking === 'unknown' || release === 'unknown' ? 'unknown' : `${tracking}/${release}`,
    locale: path.match(/^\/(es|fr)(?:\/|$)/)?.[1] ?? 'en',
    device: label(row.device_type),
    browser: label(row.browser),
    validInput:
      props.form_kind === 'calculator' &&
      props.is_valid === true &&
      props.was_changed === true &&
      props.completion_state === 'filled',
    errorKind: [
      'runtime',
      'unhandled_rejection',
      'error_boundary',
      'validation',
      'network',
      'handled',
    ].includes(String(props.error_kind))
      ? String(props.error_kind)
      : 'unspecified',
    failureReason: FAILURE_REASONS.includes(props.failure_reason as FailureReason)
      ? (props.failure_reason as FailureReason)
      : 'unknown',
    httpStatus:
      typeof props.http_status === 'number' &&
      Number.isInteger(props.http_status) &&
      props.http_status >= 400 &&
      props.http_status <= 599
        ? props.http_status
        : 0,
    validationReasons:
      typeof props.validation_reasons === 'string'
        ? [
            ...new Set(
              props.validation_reasons
                .split(',')
                .filter(reason => VALIDATION_REASONS.includes(reason))
            ),
          ]
            .sort()
            .join(',')
        : '',
    formKind: [
      'calculator',
      'contact',
      'waitlist',
      'newsletter',
      'login',
      'register',
      'forgot_password',
      'reset_password',
      'social_login',
    ].includes(String(props.form_kind))
      ? String(props.form_kind)
      : 'unknown',
    resourceKind: ['img', 'script', 'link', 'video', 'audio', 'source'].includes(
      String(props.resource_kind)
    )
      ? String(props.resource_kind)
      : '',
    quoteHandoff:
      row.event_name === 'concrete_workflow_result_cta_click' &&
      ['/concrete-quote-reviewer', '/concrete-contractor-bid-comparison'].includes(
        qualityPath(props.href).replace(/^\/(es|fr)(?=\/)/, '')
      ),
  };
}

export interface QualitySession {
  sessionId: string;
  traffic: TrafficClass;
  unknownReason: UnknownClass | null;
  startedAt: number;
  lastAt: number;
  entryPath: string;
  exitPath: string;
  pageviews: number;
  events: number;
  versions: string[];
  diagnosticsLimited: boolean;
}

export interface CalculatorFunnel {
  path: string;
  version: string;
  locale: string;
  device: string;
  stages: number[];
  validationSessions: number;
  abandonedSessions: number;
  incompleteSuccessSessions: number;
  failedSessions: number;
  blockedSessions: number;
  cancelledSessions: number;
}

export interface QualityIssue {
  key: string;
  path: string;
  version: string;
  locale: string;
  browser: string;
  kind: string;
  reason: FailureReason;
  outcome: FailureOutcome;
  httpStatus: number;
  validationReasons: string;
  formKind: string;
  resourceKind: string;
  events: number;
  sessions: number;
  firstAt: number;
  lastAt: number;
}

interface SessionState {
  summary: QualitySession;
  funnels: Map<
    string,
    {
      group: Omit<
        CalculatorFunnel,
        | 'stages'
        | 'validationSessions'
        | 'abandonedSessions'
        | 'incompleteSuccessSessions'
        | 'failedSessions'
        | 'blockedSessions'
        | 'cancelledSessions'
      >;
      stage: number;
      validation: boolean;
      abandoned: boolean;
      unmatchedSuccess: boolean;
      failed: boolean;
      blocked: boolean;
      cancelled: boolean;
    }
  >;
  issues: Map<string, QualityIssue>;
}

const TRAFFIC_RANK: Record<TrafficClass, number> = {
  unknown: 0,
  production: 1,
  internal: 2,
  qa: 3,
};
export const FUNNEL_LABELS = [
  'Tool visit',
  'Valid input',
  'Submit',
  'Success',
  'Copy / export / quote',
];
export const MIN_RATE_SAMPLE = 30;

function calculatorPath(path: string): boolean {
  const canonical = path.replace(/^\/(es|fr)(?=\/|$)/, '') || '/';
  return (
    canonical === '/' ||
    /^\/(?:concrete-[a-z-]*(?:calculator|estimator)|ready-mix-vs-bags-calculator)$/.test(canonical)
  );
}

function failureSignal(
  event: EvidenceEvent,
  action: string
): { kind: string; reason: FailureReason; outcome: FailureOutcome } | null {
  const inferred: Record<string, FailureReason> = {
    '404': 'not_found',
    route_not_found: 'not_found',
    calculator_validation_error: 'validation_rejected',
    form_validation_failed: 'validation_rejected',
    export_pdf_login_prompt: 'login_required',
    save_project_login_prompt: 'login_required',
    export_pdf_upgrade_required: 'upgrade_required',
    save_project_limit_hit: 'limit_reached',
    resource_load_error: 'resource_load',
  };
  const known = Object.hasOwn(inferred, action);
  if (
    !known &&
    ![
      'journey_error',
      'form_error',
      'calculator_copy_error',
      'calculator_submit_error',
      'export_pdf_error',
      'save_project_error',
      'checkout_error',
    ].includes(action)
  )
    return null;
  const reason =
    event.failureReason !== 'unknown'
      ? event.failureReason
      : known
        ? inferred[action]
        : event.errorKind === 'validation'
          ? 'validation_rejected'
          : 'unknown';
  return {
    kind:
      action === 'journey_error'
        ? event.errorKind
        : action === 'calculator_validation_error' || action === 'form_validation_failed'
          ? 'validation'
          : action,
    reason,
    outcome: failureOutcome(reason),
  };
}

export class QualityAccumulator {
  private actions = new ActionAccumulator();
  private growth = new GrowthAccumulator();
  private sessions = new Map<string, SessionState>();
  private lastTimestamp = -Infinity;
  unassociatedEvents = 0;
  groups = 0;
  events = 0;

  add(rows: EvidenceEvent[]): void {
    for (const event of rows) {
      if (
        !Number.isFinite(event.ts) ||
        event.ts < this.lastTimestamp ||
        !Number.isSafeInteger(event.count) ||
        event.count < 1
      )
        throw new Error('Invalid or unordered evidence');
      this.lastTimestamp = event.ts;
      this.groups += 1;
      this.events += event.count;
      if (!event.sessionId) {
        this.unassociatedEvents += event.count;
        continue;
      }
      let state = this.sessions.get(event.sessionId);
      if (!state) {
        state = {
          summary: {
            sessionId: event.sessionId,
            traffic: 'unknown',
            unknownReason: 'pageview_only_unknown',
            startedAt: event.ts,
            lastAt: event.ts,
            entryPath: event.path,
            exitPath: event.path,
            pageviews: 0,
            events: 0,
            versions: [],
            diagnosticsLimited: false,
          },
          funnels: new Map(),
          issues: new Map(),
        };
        this.sessions.set(event.sessionId, state);
      }
      const session = state.summary;
      if (TRAFFIC_RANK[event.traffic] > TRAFFIC_RANK[session.traffic])
        session.traffic = event.traffic;
      if (session.traffic === 'unknown' && event.eventType !== 'pageview')
        session.unknownReason =
          event.version !== 'unknown' || session.unknownReason === 'missing_context_unknown'
            ? 'missing_context_unknown'
            : 'legacy_custom_unknown';
      session.lastAt = event.ts;
      if (event.eventType === 'pageview') {
        if (!session.pageviews) session.entryPath = event.path;
        session.exitPath = event.path;
        session.pageviews += event.count;
      } else session.events += event.count;
      if (event.version !== 'unknown' && !session.versions.includes(event.version))
        session.versions.push(event.version);
      const action = event.eventName.replace(/^concrete_workflow_/, '');
      this.actions.add(event, action);
      this.growth.add(event, action);
      if (action === 'diagnostic_limit_reached') session.diagnosticsLimited = true;
      const failure = failureSignal(event, action);
      if (calculatorPath(event.path) && event.version !== 'unknown') {
        const key = JSON.stringify([event.path, event.version, event.locale, event.device]);
        let funnel = state.funnels.get(key);
        if (!funnel) {
          funnel = {
            group: {
              path: event.path,
              version: event.version,
              locale: event.locale,
              device: event.device,
            },
            stage: 0,
            validation: false,
            abandoned: false,
            unmatchedSuccess: false,
            failed: false,
            blocked: false,
            cancelled: false,
          };
          state.funnels.set(key, funnel);
        }
        if (action === 'page_viewed') funnel.stage = Math.max(funnel.stage, 1);
        if (action === 'field_completed' && event.validInput && funnel.stage >= 1)
          funnel.stage = Math.max(funnel.stage, 2);
        if (action === 'calculator_submit_click' && funnel.stage >= 2)
          funnel.stage = Math.max(funnel.stage, 3);
        if (action === 'calculator_submit_success') {
          if (funnel.stage >= 3) funnel.stage = Math.max(funnel.stage, 4);
          else funnel.unmatchedSuccess = true;
        }
        if (
          (['calculator_copy_success', 'export_pdf_success'].includes(action) ||
            event.quoteHandoff) &&
          funnel.stage >= 4
        )
          funnel.stage = 5;
        if (
          failure?.outcome === 'invalid' &&
          (action === 'calculator_validation_error' || event.formKind === 'calculator')
        )
          funnel.validation = true;
        if (failure && (!action.startsWith('form_') || event.formKind === 'calculator')) {
          if (failure.outcome === 'failed') funnel.failed = true;
          if (failure.outcome === 'blocked') funnel.blocked = true;
          if (failure.outcome === 'cancelled') funnel.cancelled = true;
        }
        if (action === 'form_abandoned' && event.formKind === 'calculator') funnel.abandoned = true;
      }
      if (failure) {
        const key = JSON.stringify([
          event.path,
          event.version,
          event.locale,
          event.browser,
          failure.kind,
          failure.reason,
          event.httpStatus,
          event.validationReasons,
          event.formKind,
          event.resourceKind,
        ]);
        const issue = state.issues.get(key) ?? {
          key,
          path: event.path,
          version: event.version,
          locale: event.locale,
          browser: event.browser,
          ...failure,
          httpStatus: event.httpStatus,
          validationReasons: event.validationReasons,
          formKind: event.formKind,
          resourceKind: event.resourceKind,
          events: 0,
          sessions: 1,
          firstAt: event.ts,
          lastAt: event.ts,
        };
        issue.events += event.count;
        issue.lastAt = event.ts;
        state.issues.set(key, issue);
      }
    }
  }

  report(traffic: TrafficSelection = 'production') {
    const classification: Record<TrafficClass, number> = {
      production: 0,
      qa: 0,
      internal: 0,
      unknown: 0,
    };
    const unknownClassification: Record<UnknownClass, number> = {
      pageview_only_unknown: 0,
      legacy_custom_unknown: 0,
      missing_context_unknown: 0,
    };
    const sessions: QualitySession[] = [];
    const funnels = new Map<string, CalculatorFunnel>();
    const issues = new Map<string, QualityIssue>();
    for (const state of this.sessions.values()) {
      classification[state.summary.traffic] += 1;
      if (state.summary.traffic === 'unknown' && state.summary.unknownReason)
        unknownClassification[state.summary.unknownReason] += 1;
      if (traffic !== 'all' && state.summary.traffic !== traffic) continue;
      sessions.push(state.summary);
      for (const [key, funnel] of state.funnels) {
        const result = funnels.get(key) ?? {
          ...funnel.group,
          stages: [0, 0, 0, 0, 0],
          validationSessions: 0,
          abandonedSessions: 0,
          incompleteSuccessSessions: 0,
          failedSessions: 0,
          blockedSessions: 0,
          cancelledSessions: 0,
        };
        for (let index = 0; index < funnel.stage; index++) result.stages[index] += 1;
        result.validationSessions += Number(funnel.validation);
        result.failedSessions += Number(funnel.failed);
        result.blockedSessions += Number(funnel.blocked);
        result.cancelledSessions += Number(funnel.cancelled);
        result.abandonedSessions += Number(funnel.abandoned);
        result.incompleteSuccessSessions += Number(funnel.unmatchedSuccess);
        funnels.set(key, result);
      }
      for (const [key, issue] of state.issues) {
        const previous = issues.get(key);
        issues.set(
          key,
          previous
            ? {
                ...previous,
                events: previous.events + issue.events,
                sessions: previous.sessions + 1,
                firstAt: Math.min(previous.firstAt, issue.firstAt),
                lastAt: Math.max(previous.lastAt, issue.lastAt),
              }
            : { ...issue }
        );
      }
    }
    sessions.sort(
      (first, second) =>
        second.startedAt - first.startedAt || first.sessionId.localeCompare(second.sessionId)
    );
    return {
      classification,
      unknownClassification,
      sessions,
      acquisition: this.growth.report(new Set(sessions.map(session => session.sessionId))),
      ...this.actions.report(new Set(sessions.map(session => session.sessionId))),
      funnels: [...funnels.values()],
      issues: [...issues.values()].sort((first, second) => second.sessions - first.sessions),
      unassociatedEvents: this.unassociatedEvents,
    };
  }
}

export function sessionsCsv(sessions: QualitySession[]): string {
  const cell = (value: unknown) => {
    const text = String(value ?? '');
    return `"${(/^[\s]*[=+\-@]|^[\t\r\n]/.test(text) ? "'" : '') + text.replace(/"/g, '""')}"`;
  };
  return (
    '\uFEFF' +
    [
      [
        'session_id',
        'traffic',
        'unknown_reason',
        'started_at_utc',
        'last_at_utc',
        'entry_path',
        'exit_path',
        'pageviews',
        'events',
        'observed_versions',
        'diagnostics_limited',
      ].join(','),
      ...sessions.map(session =>
        [
          session.sessionId,
          session.traffic,
          session.unknownReason ?? '',
          new Date(session.startedAt).toISOString(),
          new Date(session.lastAt).toISOString(),
          session.entryPath,
          session.exitPath,
          session.pageviews,
          session.events,
          session.versions.join(';') || 'unknown',
          session.diagnosticsLimited ? 'true' : 'false',
        ]
          .map(cell)
          .join(',')
      ),
    ].join('\r\n')
  );
}

export function issueDiagnosis(issue: QualityIssue): { evidence: string; nextCheck: string } {
  const reason = issue.reason;
  if (issue.outcome === 'invalid')
    return {
      evidence: `输入被校验拒绝；规则分类：${issue.validationReasons || reason}。没有记录输入值。`,
      nextCheck:
        '按字段提示检查必填、格式、范围和步长；应用自定义校验须本地复现，不能据此断定用户填错。',
    };
  if (issue.outcome === 'blocked')
    return {
      evidence: `操作前提未满足（${reason}），不是已确认的系统故障。`,
      nextCheck:
        '核对登录状态、权限/套餐/数量限制及结果是否存在；验证提示和恢复操作，不要求绕过业务限制。',
    };
  if (issue.outcome === 'cancelled')
    return {
      evidence: '捕获到取消信号；无法判断是用户主动取消、导航还是程序取消。',
      nextCheck: '复现导航、重复操作及取消逻辑；不要将取消直接判为故障或流失。',
    };
  if (issue.httpStatus)
    return {
      evidence: `服务返回 HTTP ${issue.httpStatus}（${reason}），未采集响应正文。`,
      nextCheck: '按时间窗口核对服务端日志、权限、请求校验与限流；HTTP 状态本身不是根因。',
    };
  if (['clipboard_unavailable', 'insecure_context', 'permission_denied'].includes(reason))
    return {
      evidence: `浏览器能力或权限信号：${reason}。`,
      nextCheck: '检查 HTTPS、安全上下文、剪贴板权限、用户手势和嵌入限制，并验证手动复制替代路径。',
    };
  if (['offline', 'network_unresolved', 'timeout', 'resource_load'].includes(reason))
    return {
      evidence:
        reason === 'offline'
          ? '请求失败时浏览器报告离线。'
          : `传输/资源信号：${reason}${issue.resourceKind ? ` / ${issue.resourceKind}` : ''}。`,
      nextCheck:
        '使用对应版本检查网络、超时、资源响应和浏览器控制台；DNS、CORS、拦截器等仅是待排查项，非已确认原因。',
    };
  return {
    evidence:
      reason === 'unknown'
        ? '已捕获失败，但当前没有足够的结构化原因证据。'
        : `捕获到 ${reason} 类异常；这只是异常类别。`,
    nextCheck:
      '在对应页面、版本和浏览器补充脱敏复现步骤，核对本地堆栈或服务端日志；未知原因保持待复现。',
  };
}

export function issueMarkdown(
  issue: QualityIssue,
  traffic: TrafficSelection,
  review: string,
  reviewedAt?: number
): string {
  const diagnosis = issueDiagnosis(issue);
  return (
    `# 需求候选：${issue.kind} · ${issue.path}\n\n` +
    `- 状态：${review}（本机人工复核；非自动故障判定）\n- 复核时间：${reviewedAt ? new Date(reviewedAt).toISOString() : '未复核'}\n` +
    `- 流量范围：${traffic}\n- 版本：${issue.version}\n- 语言 / 浏览器：${issue.locale} / ${issue.browser}\n` +
    `- 结果分类：${issue.outcome}；原因分类：${issue.reason}；表单：${issue.formKind}\n` +
    `- 受影响会话：${issue.sessions}；事件：${issue.events}\n- 首次：${new Date(issue.firstAt).toISOString()}\n- 末次：${new Date(issue.lastAt).toISOString()}\n\n` +
    `## 原因线索（非根因结论）\n${diagnosis.evidence}\n\n## 建议核查\n${diagnosis.nextCheck}\n\n` +
    `## 待补复现\n1. 在对应版本与浏览器打开 ${issue.path}。\n2. 人工补充不含用户原文的操作步骤。\n3. 记录预期与实际结果；历史事件不证明当前仍有故障。\n\n` +
    `## 验收标准\n- 满足业务前提时原操作可完成；预期校验/权限/取消须有正确提示和恢复路径。\n- 成功与失败分别验证，重试成功不能抹掉先前的失败信号。\n- 新错误与旧版本信号分开；新事件晚于复核时间则重新核查。\n- 不采集输入原文、凭据或可识别个人信息。\n\n证据仅含脱敏聚合，不含会话原始标识；信号次数不等于独立故障次数。\n`
  );
}

export async function loadCompleteEvidence(
  fetchPage: (cursor?: string) => Promise<EvidencePage>,
  onProgress: (page: EvidencePage) => void,
  signal: AbortSignal
) {
  const accumulator = new QualityAccumulator();
  const seen = new Set<string>();
  let cursor: string | undefined;
  let first: EvidencePage | undefined;
  for (;;) {
    signal.throwIfAborted();
    const page = await fetchPage(cursor);
    signal.throwIfAborted();
    if (
      first &&
      (page.from !== first.from ||
        page.to !== first.to ||
        page.source !== first.source ||
        page.totalGroups !== first.totalGroups ||
        page.totalEvents !== first.totalEvents)
    )
      throw new Error('Evidence scope or totals changed. Restart the scan.');
    first ??= page;
    accumulator.add(page.data);
    if (accumulator.groups !== page.scannedGroups || accumulator.groups > page.totalGroups)
      throw new Error('Evidence page is incomplete or duplicated');
    onProgress(page);
    if (!page.nextCursor) {
      if (accumulator.groups !== page.totalGroups || accumulator.events !== page.totalEvents)
        throw new Error('Evidence scan stopped before completion');
      return {
        accumulator,
        window: { from: page.from, to: page.to, source: page.source },
        totalGroups: page.totalGroups,
        totalEvents: page.totalEvents,
      };
    }
    if (!page.data.length || seen.has(page.nextCursor))
      throw new Error('Evidence pagination did not advance');
    seen.add(page.nextCursor);
    cursor = page.nextCursor;
  }
}
