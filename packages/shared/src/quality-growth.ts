import type { EvidenceEvent } from './quality';

type GrowthSignal =
  | 'toolSuccessSessions'
  | 'resultUseSessions'
  | 'copySuccessSessions'
  | 'saveSuccessSessions'
  | 'pdfSuccessSessions'
  | 'quoteHandoffSessions'
  | 'contactStartedSessions'
  | 'contactSubmittedSessions'
  | 'contactFailedSessions'
  | 'acceptedRequestSessions'
  | 'replyAuthorizedSessions'
  | 'unconfirmedContactSessions';

type Entry = Pick<
  EvidenceEvent,
  'path' | 'locale' | 'device' | 'channelSource' | 'channelMedium' | 'channelCampaign'
>;
type GrowthSession = {
  entry?: Entry;
  signals: Set<GrowthSignal>;
  versions: Set<string>;
  calculatorObserved: boolean;
  calculatorSignals: Set<GrowthSignal>;
};
export type GrowthGroup = Entry &
  Record<GrowthSignal, number> & {
    sessions: number;
    versions: string[];
  };

export class GrowthAccumulator {
  private sessions = new Map<string, GrowthSession>();

  add(event: EvidenceEvent, action: string) {
    if (!event.sessionId) return;
    const session: GrowthSession = this.sessions.get(event.sessionId) ?? {
      signals: new Set<GrowthSignal>(),
      versions: new Set<string>(),
      calculatorObserved: false,
      calculatorSignals: new Set<GrowthSignal>(),
    };
    this.sessions.set(event.sessionId, session);
    if (event.eventType === 'pageview' && !session.entry) {
      session.entry = {
        path: event.path,
        locale: event.locale,
        device: event.device,
        channelSource: event.channelSource,
        channelMedium: event.channelMedium,
        channelCampaign: event.channelCampaign,
      };
    }
    if (event.version === 'unknown') return;
    session.versions.add(event.version);
    if (event.calculator !== 'unknown' && event.eventType !== 'pageview') {
      session.calculatorObserved = true;
      if (action === 'calculator_submit_success')
        session.calculatorSignals.add('toolSuccessSessions');
      if (
        ['calculator_copy_success', 'export_pdf_success', 'save_project_success'].includes(action)
      )
        session.calculatorSignals.add('resultUseSessions');
    }
    if (action === 'calculator_submit_success') session.signals.add('toolSuccessSessions');
    if (['calculator_copy_success', 'export_pdf_success', 'save_project_success'].includes(action))
      session.signals.add('resultUseSessions');
    if (action === 'calculator_copy_success') session.signals.add('copySuccessSessions');
    if (action === 'save_project_success') session.signals.add('saveSuccessSessions');
    if (action === 'export_pdf_success') session.signals.add('pdfSuccessSessions');
    if (event.quoteHandoff) session.signals.add('quoteHandoffSessions');
    if (event.formKind !== 'contact') return;
    if (action === 'form_started') session.signals.add('contactStartedSessions');
    if (action === 'form_submitted') session.signals.add('contactSubmittedSessions');
    if (['form_error', 'form_validation_failed'].includes(action))
      session.signals.add('contactFailedSessions');
    if (action === 'form_success') session.signals.add('unconfirmedContactSessions');
    if (action === 'lead_request_accepted' && event.leadAccepted) {
      session.signals.add('acceptedRequestSessions');
      if (event.replyPermission === 'granted') session.signals.add('replyAuthorizedSessions');
    }
  }

  calculatorObservation(sessionId: string) {
    const session = this.sessions.get(sessionId);
    return {
      applicable: session?.calculatorObserved ?? false,
      toolSuccess: session?.calculatorSignals.has('toolSuccessSessions') ?? false,
      resultUse: session?.calculatorSignals.has('resultUseSessions') ?? false,
    };
  }

  report(selected: Set<string>): GrowthGroup[] {
    const groups = new Map<string, GrowthGroup>();
    for (const [sessionId, session] of this.sessions) {
      if (!selected.has(sessionId)) continue;
      const entry = session.entry ?? {
        path: '/:unknown',
        locale: 'unknown',
        device: 'unknown',
        channelSource: 'unknown',
        channelMedium: 'unknown',
        channelCampaign: 'unknown',
      };
      const key = JSON.stringify(entry);
      const group = groups.get(key) ?? {
        ...entry,
        sessions: 0,
        versions: [],
        toolSuccessSessions: 0,
        resultUseSessions: 0,
        copySuccessSessions: 0,
        saveSuccessSessions: 0,
        pdfSuccessSessions: 0,
        quoteHandoffSessions: 0,
        contactStartedSessions: 0,
        contactSubmittedSessions: 0,
        contactFailedSessions: 0,
        acceptedRequestSessions: 0,
        replyAuthorizedSessions: 0,
        unconfirmedContactSessions: 0,
      };
      group.sessions++;
      for (const signal of session.signals) {
        if (
          signal === 'unconfirmedContactSessions' &&
          session.signals.has('acceptedRequestSessions')
        )
          continue;
        group[signal]++;
      }
      group.versions = [...new Set([...group.versions, ...session.versions])].sort();
      groups.set(key, group);
    }
    return [...groups.values()].sort((first, second) => second.sessions - first.sessions);
  }
}
