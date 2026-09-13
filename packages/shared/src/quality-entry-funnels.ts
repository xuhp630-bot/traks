import type { EvidenceEvent } from './quality';

export const ENTRY_FUNNEL_STAGES = ['Entry', 'Tool visit', 'Submit', 'Success', 'Result use'];
export type EntryKind = 'article' | 'tool_direct' | 'directory' | 'other' | 'unknown';
export interface EntryFunnel {
  entry: EntryKind;
  stages: number[];
  completionRate: number | null;
}

export function isToolPath(path: string): boolean {
  const canonical = path.replace(/^\/(es|fr)(?=\/|$)/, '') || '/';
  return canonical === '/' || /^\/[a-z0-9-]+-(?:calculator|estimator)$/.test(canonical);
}

function entryKind(path: string): EntryKind {
  const canonical = path.replace(/^\/(es|fr)(?=\/|$)/, '') || '/';
  if (canonical.startsWith('/blog/')) return 'article';
  if (canonical === '/concrete-calculators') return 'directory';
  if (isToolPath(canonical)) return 'tool_direct';
  return 'other';
}

type Flow = { phase: number; reached: number; at: number; calculator: string };
type Session = { entry: EntryKind; hasEntry: boolean; flows: Map<string, Flow> };

export class EntryFunnelAccumulator {
  private sessions = new Map<string, Session>();

  add(event: EvidenceEvent, action: string): void {
    if (!event.sessionId) return;
    const session: Session = this.sessions.get(event.sessionId) ?? {
      entry: 'unknown',
      hasEntry: false,
      flows: new Map<string, Flow>(),
    };
    this.sessions.set(event.sessionId, session);
    if (event.eventType === 'pageview' && !session.hasEntry) {
      session.entry = entryKind(event.path);
      session.hasEntry = true;
    }
    if (
      !session.hasEntry ||
      !event.pageId ||
      event.version === 'unknown' ||
      !isToolPath(event.path)
    )
      return;
    const key = JSON.stringify([
      event.pageId,
      event.path,
      event.version,
      event.locale,
      event.device,
    ]);
    const flow = session.flows.get(key);
    if (action === 'page_viewed' && !flow && event.count === 1) {
      session.flows.set(key, { phase: 1, reached: 1, at: event.ts, calculator: 'unknown' });
      return;
    }
    if (!flow) return;
    if (event.ts === flow.at && action === 'calculator_submit_click') {
      flow.phase = 0;
      return;
    }
    if (event.ts <= flow.at) return;
    // Grouped attempts cannot establish a one-to-one success sequence.
    if (event.count !== 1 && action.startsWith('calculator_submit_')) {
      flow.phase = 1;
      flow.at = event.ts;
      return;
    }
    if (action === 'calculator_submit_click') {
      flow.phase = flow.phase === 2 || flow.phase === 0 ? 0 : 2;
      flow.calculator = event.calculator;
    } else if (action === 'calculator_submit_success' && flow.phase === 2) {
      flow.phase = flow.calculator !== 'unknown' && event.calculator === flow.calculator ? 3 : 0;
    } else if (
      (['calculator_copy_success', 'export_pdf_success', 'save_project_success'].includes(action) ||
        event.quoteHandoff) &&
      flow.phase === 3 &&
      event.count === 1 &&
      (event.calculator === flow.calculator ||
        (action !== 'calculator_copy_success' && event.calculator === 'unknown'))
    )
      flow.phase = 4;
    else if (
      ['calculator_reset', 'calculator_submit_error', 'calculator_validation_error'].includes(
        action
      )
    )
      flow.phase = 1;
    else return;
    flow.reached = Math.max(flow.reached, flow.phase);
    flow.at = event.ts;
  }

  report(selected: Set<string>): EntryFunnel[] {
    const groups = new Map<EntryKind, EntryFunnel>();
    for (const id of selected) {
      const session = this.sessions.get(id);
      const entry = session?.entry ?? 'unknown';
      const group: EntryFunnel = groups.get(entry) ?? {
        entry,
        stages: [0, 0, 0, 0, 0],
        completionRate: null,
      };
      group.stages[0]++;
      let reached = 0;
      for (const flow of session?.flows.values() ?? []) reached = Math.max(reached, flow.reached);
      for (let index = 1; index <= reached; index++) group.stages[index]++;
      group.completionRate = group.stages[4] / group.stages[0];
      groups.set(entry, group);
    }
    return [...groups.values()].sort((a, b) => a.entry.localeCompare(b.entry));
  }
}
