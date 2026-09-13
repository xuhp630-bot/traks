import type { EvidenceEvent } from './quality';

export type OperationName = 'calculate' | 'copy' | 'pdf' | 'save' | 'checkout';
type Phase = 'attempt' | 'success' | 'failure' | 'blocked' | 'invalid';
const OPERATIONS: Record<string, [OperationName, Phase]> = {
  calculator_submit_click: ['calculate', 'attempt'],
  calculator_submit_success: ['calculate', 'success'],
  calculator_submit_error: ['calculate', 'failure'],
  calculator_validation_error: ['calculate', 'invalid'],
  calculator_copy_attempt: ['copy', 'attempt'],
  calculator_copy_success: ['copy', 'success'],
  calculator_copy_error: ['copy', 'failure'],
  export_pdf_click: ['pdf', 'attempt'],
  export_pdf_success: ['pdf', 'success'],
  export_pdf_error: ['pdf', 'failure'],
  export_pdf_login_prompt: ['pdf', 'blocked'],
  export_pdf_upgrade_required: ['pdf', 'blocked'],
  save_project_click: ['save', 'attempt'],
  save_project_success: ['save', 'success'],
  save_project_error: ['save', 'failure'],
  save_project_login_prompt: ['save', 'blocked'],
  save_project_limit_hit: ['save', 'blocked'],
  checkout_started: ['checkout', 'attempt'],
  checkout_success: ['checkout', 'success'],
  checkout_error: ['checkout', 'failure'],
};

export interface OperationMetrics {
  path: string;
  version: string;
  locale: string;
  device: string;
  calculator: string;
  operation: OperationName;
  attemptSignals: number;
  attemptedSessions: number;
  successSessions: number;
  failureSessions: number;
  blockedSessions: number;
  cancelledSessions: number;
  invalidSessions: number;
  retrySessions: number;
  recoveredSessions: number;
  pendingSessions: number;
  unlinkedSessions: number;
}

type Metric = Exclude<
  keyof OperationMetrics,
  'path' | 'version' | 'locale' | 'device' | 'calculator' | 'operation'
>;
type PageState = { pending?: number; failedAt?: number; retrying: boolean; ambiguous: boolean };
type SessionState = { metrics: Set<Metric>; attempts: number; pages: Map<string, PageState> };
type OperationGroup = {
  identity: Pick<
    OperationMetrics,
    'path' | 'version' | 'locale' | 'device' | 'calculator' | 'operation'
  >;
  sessions: Map<string, SessionState>;
};

export interface BehaviorMetrics {
  path: string;
  version: string;
  locale: string;
  device: string;
  searchSessions: number;
  zeroResultSessions: number;
  unknownResultSessions: number;
  correctedFieldSessions: number;
}
type BehaviorMetric =
  | 'searchSessions'
  | 'zeroResultSessions'
  | 'unknownResultSessions'
  | 'correctedFieldSessions';

export class ActionAccumulator {
  private groups = new Map<string, OperationGroup>();
  private behavior = new Map<
    string,
    {
      identity: Pick<BehaviorMetrics, 'path' | 'version' | 'locale' | 'device'>;
      sessions: Map<string, Set<BehaviorMetric>>;
    }
  >();

  add(event: EvidenceEvent, action: string): void {
    const identity = {
      path: event.path,
      version: event.version,
      locale: event.locale,
      device: event.device,
    };
    if (
      action === 'calculator_search_results_viewed' ||
      (action === 'field_validation_recovered' && event.formKind === 'calculator')
    ) {
      const key = JSON.stringify(identity);
      const group = this.behavior.get(key) ?? {
        identity,
        sessions: new Map<string, Set<BehaviorMetric>>(),
      };
      const metrics = group.sessions.get(event.sessionId) ?? new Set<BehaviorMetric>();
      if (action === 'field_validation_recovered') metrics.add('correctedFieldSessions');
      else {
        metrics.add('searchSessions');
        if (event.searchResultCount === 0) metrics.add('zeroResultSessions');
        if (event.searchResultCount === null) metrics.add('unknownResultSessions');
      }
      group.sessions.set(event.sessionId, metrics);
      this.behavior.set(key, group);
    }
    if (!Object.hasOwn(OPERATIONS, action)) return;
    const [operation, phase] = OPERATIONS[action];
    const groupIdentity = { ...identity, calculator: event.calculator, operation };
    const key = JSON.stringify(groupIdentity);
    const group = this.groups.get(key) ?? {
      identity: groupIdentity,
      sessions: new Map<string, SessionState>(),
    };
    const session = group.sessions.get(event.sessionId) ?? {
      metrics: new Set<Metric>(),
      attempts: 0,
      pages: new Map<string, PageState>(),
    };
    group.sessions.set(event.sessionId, session);
    this.groups.set(key, group);
    const page = session.pages.get(event.pageId) ?? { retrying: false, ambiguous: false };
    session.pages.set(event.pageId, page);
    const linkable = Boolean(event.pageId) && event.version !== 'unknown';
    if (phase === 'attempt') {
      session.attempts += event.count;
      session.metrics.add('attemptedSessions');
      if (page.pending !== undefined || event.count > 1) page.ambiguous = true;
      page.retrying =
        linkable && !page.ambiguous && page.failedAt !== undefined && event.ts > page.failedAt;
      if (page.retrying) session.metrics.add('retrySessions');
      page.pending = event.ts;
      if (!linkable || page.ambiguous) session.metrics.add('unlinkedSessions');
      return;
    }
    const matched =
      linkable &&
      !page.ambiguous &&
      page.pending !== undefined &&
      event.ts > page.pending &&
      event.count === 1;
    if (!matched) session.metrics.add('unlinkedSessions');
    if (phase === 'success') {
      if (matched) {
        session.metrics.add('successSessions');
        if (page.retrying) session.metrics.add('recoveredSessions');
      }
      page.failedAt = undefined;
    } else {
      const outcome = event.failureOutcome;
      const metric =
        phase === 'blocked' || outcome === 'blocked'
          ? 'blockedSessions'
          : phase === 'invalid' || outcome === 'invalid'
            ? 'invalidSessions'
            : outcome === 'cancelled'
              ? 'cancelledSessions'
              : 'failureSessions';
      session.metrics.add(metric);
      if (matched) page.failedAt = event.ts;
    }
    page.pending = undefined;
    page.retrying = false;
  }

  report(sessionIds: Set<string>): {
    operations: OperationMetrics[];
    behaviors: BehaviorMetrics[];
  } {
    const operations: OperationMetrics[] = [];
    for (const group of this.groups.values()) {
      const result: OperationMetrics = {
        ...group.identity,
        attemptSignals: 0,
        attemptedSessions: 0,
        successSessions: 0,
        failureSessions: 0,
        blockedSessions: 0,
        cancelledSessions: 0,
        invalidSessions: 0,
        retrySessions: 0,
        recoveredSessions: 0,
        pendingSessions: 0,
        unlinkedSessions: 0,
      };
      let included = false;
      for (const [sessionId, state] of group.sessions) {
        if (!sessionIds.has(sessionId)) continue;
        included = true;
        result.attemptSignals += state.attempts;
        for (const metric of state.metrics) result[metric] += 1;
        if ([...state.pages.values()].some(page => page.pending !== undefined))
          result.pendingSessions += 1;
      }
      if (included) operations.push(result);
    }
    const behaviors: BehaviorMetrics[] = [];
    for (const group of this.behavior.values()) {
      const result: BehaviorMetrics = {
        ...group.identity,
        searchSessions: 0,
        zeroResultSessions: 0,
        unknownResultSessions: 0,
        correctedFieldSessions: 0,
      };
      let included = false;
      for (const [sessionId, metrics] of group.sessions) {
        if (!sessionIds.has(sessionId)) continue;
        included = true;
        for (const metric of metrics) result[metric] += 1;
      }
      if (included) behaviors.push(result);
    }
    return { operations, behaviors };
  }
}
