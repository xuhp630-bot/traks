import type { EvidenceEvent } from './quality';
import type { GrowthAccumulator } from './quality-growth';

export const AI_SOURCE_PROVIDERS = ['chatgpt', 'perplexity', 'claude', 'copilot'] as const;
export type AiSourceProvider = (typeof AI_SOURCE_PROVIDERS)[number];
export const AI_SOURCE_PROVIDER_LABELS: Record<AiSourceProvider, string> = {
  chatgpt: 'ChatGPT',
  perplexity: 'Perplexity',
  claude: 'Claude',
  copilot: 'Bing / Copilot',
};
type AiSourceEvidence = 'referrer' | 'utm_source' | 'referrer_and_utm';
type Observation = {
  provider: AiSourceProvider | null;
  evidence: AiSourceEvidence | null;
  status: 'recognized' | 'unclassified' | 'conflict' | 'invalid';
};
export interface AiSourceObservation {
  native: Observation;
  producer: Observation;
}

export interface AiSourceGroup {
  provider: AiSourceProvider;
  sessions: number;
  pageviews: number;
  toolSuccessSessions: number | null;
  resultUseSessions: number | null;
  goalCoverage: 'known_calculator_signals_only' | 'not_applicable';
  goalEligibleSessions: number;
  provenance: {
    producerDeclaredSessions: number;
    derivedFromNativeSessions: number;
  };
  evidence: {
    referrerSessions: number;
    utmSourceSessions: number;
    referrerAndUtmSessions: number;
  };
}
export interface AiSourceReport {
  format: 'traks-ai-source-observations/v1';
  status: 'available' | 'partial' | 'unavailable';
  denominatorSessions: number;
  attribution: 'first_observed_native_pageview_with_producer_declarations_separate';
  citationStatus: 'not_connected';
  citations: null;
  groups: AiSourceGroup[];
  coverage: {
    recognizedSessions: number;
    unclassifiedSessions: number;
    conflictSessions: number;
    invalidMetadataSessions: number;
    missingPageviewSessions: number;
    lateSourceChangeSessions: number;
    nativeSourceSessions: number;
    producerDeclaredSessions: number;
    unknownVersionSessions: number;
    sourceObservationUnavailableSessions: number;
  };
  limitations: string[];
}

// Do not reuse the broad legacy AI_ASSISTANTS list: company sites and generic
// Google/Bing/Apple search hosts do not demonstrate an AI answer-engine visit.
const HOSTS: ReadonlyArray<readonly [string, AiSourceProvider]> = [
  ['chatgpt.com', 'chatgpt'],
  ['chat.openai.com', 'chatgpt'],
  ['perplexity.ai', 'perplexity'],
  ['claude.ai', 'claude'],
  ['claude.com', 'claude'],
  ['copilot.microsoft.com', 'copilot'],
];
const noObservation = (): Observation => ({
  provider: null,
  evidence: null,
  status: 'unclassified',
});
function nativeProvider(value: unknown, referrer: boolean): AiSourceProvider | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  if (!referrer && AI_SOURCE_PROVIDERS.includes(normalized as AiSourceProvider))
    return normalized as AiSourceProvider;
  // Native referrer_hostname is already a hostname; never parse complete URLs,
  // credentials, campaign substrings or arbitrary text from telemetry.
  if (
    normalized.length > 253 ||
    !normalized.split('.').every(part => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(part))
  )
    return null;
  return (
    HOSTS.find(([host]) =>
      referrer
        ? normalized === host || normalized.endsWith(`.${host}`)
        : normalized === host || normalized === `www.${host}`
    )?.[1] ?? null
  );
}

export function normalizeAiSourceObservation(
  row: Record<string, unknown>,
  props: Record<string, unknown>,
  malformedMetadata = false
): AiSourceObservation {
  let native = noObservation();
  if (row.event_type === 'pageview') {
    const referrer = nativeProvider(row.referrer_hostname, true);
    const utm = nativeProvider(row.utm_source, false);
    if (referrer && utm && referrer !== utm)
      native = { provider: null, evidence: null, status: 'conflict' };
    else if (referrer || utm)
      native = {
        provider: referrer ?? utm,
        evidence: referrer ? (utm ? 'referrer_and_utm' : 'referrer') : 'utm_source',
        status: 'recognized',
      };
  }
  let producer = noObservation();
  const hasSource = Object.hasOwn(props, 'ai_source');
  const hasEvidence = Object.hasOwn(props, 'ai_source_evidence');
  if (malformedMetadata) producer = { provider: null, evidence: null, status: 'invalid' };
  else if (hasSource || hasEvidence) {
    if (!hasSource && props.ai_source_evidence === 'conflict')
      producer = { provider: null, evidence: null, status: 'conflict' };
    else if (
      typeof props.ai_source === 'string' &&
      AI_SOURCE_PROVIDERS.includes(props.ai_source as AiSourceProvider) &&
      ['referrer', 'utm_source', 'referrer_and_utm'].includes(String(props.ai_source_evidence)) &&
      typeof props.ai_source_evidence === 'string'
    )
      producer = {
        provider: props.ai_source as AiSourceProvider,
        evidence: props.ai_source_evidence as AiSourceEvidence,
        status: 'recognized',
      };
    else producer = { provider: null, evidence: null, status: 'invalid' };
  }
  return { native, producer };
}

type Declaration = { path: string; observation: Observation; unknownVersion: boolean };
type SourceSession = {
  entry?: {
    ts: number;
    path: string;
    native: Observation;
    nativeEvidence: Set<AiSourceEvidence>;
  };
  pageviews: number;
  producer?: Observation;
  pendingDeclaration?: Declaration;
  firstPageClosed: boolean;
  conflict: boolean;
  invalidMetadata: boolean;
  unknownVersion: boolean;
  lateChange: boolean;
  hasSourceObservation: boolean;
  sourceObservationUnavailable: boolean;
};
function observationDiffers(first: Observation, next: Observation): boolean {
  return (
    next.status === 'conflict' || (next.status === 'recognized' && first.provider !== next.provider)
  );
}

export class AiSourceAccumulator {
  private sessions = new Map<string, SourceSession>();

  private addProducer(session: SourceSession, declaration: Declaration) {
    const observation = declaration.observation;
    if (declaration.unknownVersion) {
      session.unknownVersion = true;
      return;
    }
    if (observation.status === 'conflict') {
      session.conflict = true;
      return;
    }
    if (observation.status !== 'recognized') return;
    if (
      (session.entry?.native.provider && session.entry.native.provider !== observation.provider) ||
      (session.producer?.provider && session.producer.provider !== observation.provider)
    )
      session.conflict = true;
    session.producer ??= observation;
  }

  add(event: EvidenceEvent) {
    if (!event.sessionId) return;
    const session: SourceSession = this.sessions.get(event.sessionId) ?? {
      pageviews: 0,
      firstPageClosed: false,
      conflict: false,
      invalidMetadata: false,
      unknownVersion: false,
      lateChange: false,
      hasSourceObservation: false,
      sourceObservationUnavailable: false,
    };
    this.sessions.set(event.sessionId, session);
    const observation = event.aiSource;
    if (observation) session.hasSourceObservation = true;
    else session.sourceObservationUnavailable = true;
    if (observation?.producer.status === 'invalid') session.invalidMetadata = true;
    if (event.eventType === 'pageview') {
      session.pageviews += event.count;
      const native = observation?.native ?? noObservation();
      if (!session.entry) {
        session.entry = {
          ts: event.ts,
          path: event.path,
          native,
          nativeEvidence: new Set(native.evidence ? [native.evidence] : []),
        };
        if (native.status === 'conflict') session.conflict = true;
        if (session.pendingDeclaration) {
          if (session.pendingDeclaration.path === event.path)
            this.addProducer(session, session.pendingDeclaration);
          else session.lateChange = true;
          session.pendingDeclaration = undefined;
        }
      } else if (session.entry.ts === event.ts) {
        // SQL groups with equal timestamps do not establish which page was
        // first. Preserve ambiguity rather than choose a provider by row order.
        if (
          session.entry.path !== event.path ||
          session.entry.native.provider !== native.provider ||
          native.status === 'conflict'
        )
          session.conflict = true;
        else if (native.evidence)
          // Compatible ties retain each observed enum, not whichever SQL row
          // happened to be first. Separate referrer/UTM rows do not fabricate
          // a referrer_and_utm observation or any extra collector session.
          session.entry.nativeEvidence.add(native.evidence);
      } else {
        session.firstPageClosed = true;
        if (observationDiffers(session.entry.native, native)) session.lateChange = true;
      }
    }
    const producer = observation?.producer;
    if (!producer || !['recognized', 'conflict'].includes(producer.status)) return;
    const declaration = {
      path: event.path,
      observation: producer,
      unknownVersion: event.version === 'unknown',
    };
    if (declaration.unknownVersion) {
      session.unknownVersion = true;
      return;
    }
    if (!session.entry) {
      if (
        session.pendingDeclaration &&
        session.pendingDeclaration.observation.provider !== producer.provider
      )
        session.conflict = true;
      session.pendingDeclaration ??= declaration;
    } else if (!session.firstPageClosed && session.entry.path === event.path)
      this.addProducer(session, declaration);
    else if (observationDiffers(session.producer ?? session.entry.native, producer))
      session.lateChange = true;
  }

  report(selected: Set<string>, growth: GrowthAccumulator): AiSourceReport {
    const groups: AiSourceGroup[] = AI_SOURCE_PROVIDERS.map(provider => ({
      provider,
      sessions: 0,
      pageviews: 0,
      toolSuccessSessions: null,
      resultUseSessions: null,
      goalCoverage: 'not_applicable',
      goalEligibleSessions: 0,
      provenance: { producerDeclaredSessions: 0, derivedFromNativeSessions: 0 },
      evidence: { referrerSessions: 0, utmSourceSessions: 0, referrerAndUtmSessions: 0 },
    }));
    const coverage = {
      recognizedSessions: 0,
      unclassifiedSessions: 0,
      conflictSessions: 0,
      invalidMetadataSessions: 0,
      missingPageviewSessions: 0,
      lateSourceChangeSessions: 0,
      nativeSourceSessions: 0,
      producerDeclaredSessions: 0,
      unknownVersionSessions: 0,
      sourceObservationUnavailableSessions: 0,
    };
    let observedSessions = 0;
    for (const sessionId of selected) {
      const session = this.sessions.get(sessionId);
      observedSessions += Number(session?.hasSourceObservation ?? false);
      coverage.sourceObservationUnavailableSessions += Number(
        !session || session.sourceObservationUnavailable
      );
      coverage.invalidMetadataSessions += Number(session?.invalidMetadata ?? false);
      coverage.lateSourceChangeSessions += Number(session?.lateChange ?? false);
      coverage.unknownVersionSessions += Number(session?.unknownVersion ?? false);
      if (!session?.entry) {
        coverage.missingPageviewSessions++;
        coverage.unclassifiedSessions++;
        continue;
      }
      if (session.conflict) {
        coverage.conflictSessions++;
        continue;
      }
      const native = session.entry.native;
      const source = native.provider ?? session.producer?.provider;
      const group = groups.find(group => group.provider === source);
      if (!group) {
        coverage.unclassifiedSessions++;
        continue;
      }
      coverage.recognizedSessions++;
      group.sessions++;
      group.pageviews += session.pageviews;
      const hasNative = native.provider === source;
      const hasProducer = session.producer?.provider === source;
      coverage.nativeSourceSessions += Number(hasNative);
      coverage.producerDeclaredSessions += Number(hasProducer);
      group.provenance.derivedFromNativeSessions += Number(hasNative);
      group.provenance.producerDeclaredSessions += Number(hasProducer);
      const evidence = new Set([...session.entry.nativeEvidence, session.producer?.evidence]);
      group.evidence.referrerSessions += Number(evidence.has('referrer'));
      group.evidence.utmSourceSessions += Number(evidence.has('utm_source'));
      group.evidence.referrerAndUtmSessions += Number(evidence.has('referrer_and_utm'));
      const goals = growth.calculatorObservation(sessionId);
      if (goals.applicable) {
        group.goalCoverage = 'known_calculator_signals_only';
        group.goalEligibleSessions++;
        group.toolSuccessSessions = (group.toolSuccessSessions ?? 0) + Number(goals.toolSuccess);
        group.resultUseSessions = (group.resultUseSessions ?? 0) + Number(goals.resultUse);
      }
    }
    const status =
      selected.size && !observedSessions
        ? 'unavailable'
        : coverage.sourceObservationUnavailableSessions
          ? 'partial'
          : 'available';
    return {
      format: 'traks-ai-source-observations/v1',
      status,
      denominatorSessions: selected.size,
      attribution: 'first_observed_native_pageview_with_producer_declarations_separate',
      citationStatus: 'not_connected',
      citations: null,
      groups: status === 'unavailable' ? [] : groups,
      coverage,
      limitations: [
        '仅基于选定观测窗口的collector会话；来源、结果和结果使用是会话级共现，不是顺序漏斗、独立用户、多触点归因或因果改善。',
        '原生首次pageview来源与producer白名单声明分别标记；UTM和producer声明均不是独立核验的推荐或引用。',
        '只识别四个已支持来源；普通Google、Bing、Apple、直接访问及其他未支持来源保持非AI/未归因，不能按来源缺失推断没有AI访问。',
        '首次pageview缺失、冲突、版本缺失和畸形声明保留覆盖诊断；后续页面来源变化不覆盖首次入口，不回填或修改历史存储。',
        '来源组的pageview数保留原生分组multiplicity；结果数是去重会话，不是计算次数、操作次数或已核实业务转化。',
        '计算成功及结果使用仅适用于已知版本化计算器观测；其他项目需自己的业务适配，无适配时保持null，不使用固定计算器漏斗冒充通用目标。',
        '覆盖诊断和来源证据子项可重叠，不可相加作为独立会话；引用数据未接通，引用次数为null而非0。',
        '旧版证据缺少来源观测字段时标记能力缺失，不把未提供字段当作已核实零AI访问；新旧部署混合时显示partial。',
      ],
    };
  }
}
