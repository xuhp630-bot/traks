import { z } from 'zod';

export const competitorCadence = z.enum(['manual', 'daily', 'weekly']);
export const competitorResearchStatus = z.enum(['inbox', 'focus', 'watch', 'parked', 'discarded']);
export const competitorResearchIntakeMode = z.enum([
  'pasted_site_research',
  'codex_competitor_analysis',
  'codex_local_handoff',
]);
export const competitorResearchLocalCapability = z.enum([
  'competitor-analysis',
  'competitor-profiling',
  'assess-market-competition',
  'competitive-battlecard',
  '30x-seo-sitemap',
  '30x-seo-technical',
  '30x-seo-keywords',
  'design-review',
]);
export const competitorPreResearchStage = z.enum(['imported', 'reviewing', 'verified', 'archived']);
export const competitorPreResearchActionKind = z.enum([
  'harvest',
  'review',
  'analysis',
  'classification',
  'handoff',
  'note',
]);
export const competitorPreResearchOutcome = z.enum(['completed', 'partial', 'failed', 'skipped']);
const competitorId = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/);
export const competitorCategoryInput = z
  .object({ name: z.string().trim().min(1).max(40) })
  .strict();
export const competitorResearchGroupInput = z
  .object({
    name: z.string().trim().min(1).max(80),
    rootTerm: z.string().trim().min(1).max(120),
  })
  .strict();
export const competitorInput = z
  .object({
    name: z.string().trim().min(1).max(80),
    url: z.string().trim().url().max(500),
    selector: z
      .string()
      .trim()
      .max(80)
      .regex(/^(?:[a-z][a-z0-9-]*|[.#][A-Za-z_][\w-]*)$/)
      .default('main'),
    cadence: competitorCadence.default('manual'),
  })
  .strict();

export const workspaceCompetitorInput = competitorInput.extend({
  siteId: competitorId.nullable().default(null),
  categoryId: competitorId.nullable().default(null),
});
export const competitorUpdate = z
  .object({
    cadence: competitorCadence.optional(),
    siteId: competitorId.nullable().optional(),
    categoryId: competitorId.nullable().optional(),
  })
  .strict()
  .refine(value => Object.keys(value).length > 0, 'At least one change is required');
export const competitorFilters = z
  .object({
    siteId: competitorId.optional(),
    categoryId: competitorId.optional(),
  })
  .strict();
export type CompetitorFilters = z.infer<typeof competitorFilters>;

const researchKeyword = z.string().trim().min(1).max(100);
const keywordHarvesterJobUrl = z
  .string()
  .trim()
  .min(1)
  .max(2048)
  .refine(value => {
    try {
      const url = new URL(value);
      return (
        url.protocol === 'chrome-extension:' &&
        url.hostname === 'dpconkblakejdpcjkbapgpaajbcfbhlk' &&
        url.pathname === '/harvest.html' &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          url.searchParams.get('job') ?? ''
        )
      );
    } catch {
      return false;
    }
  }, 'Expected a Keyword Harvester harvest.html URL with a job id');
const sourceReferenceUrl = z
  .string()
  .trim()
  .min(1)
  .max(2048)
  .refine(value => {
    try {
      const url = new URL(value);
      return ['https:', 'http:', 'codex:', 'chrome-extension:'].includes(url.protocol);
    } catch {
      return false;
    }
  }, 'Expected an http(s), codex, or chrome-extension URL');
export const competitorResearchPayment = z
  .object({
    provider: z.string().trim().min(1).max(80),
    status: z.enum(['confirmed', 'evidence_only', 'disabled', 'unknown']).default('unknown'),
    evidence: z.string().trim().max(500).optional(),
  })
  .strict();
export const competitorResearchSource = z
  .object({
    url: z.string().trim().min(1).max(2048),
    kind: z.enum(['landing', 'pricing', 'checkout', 'manual', 'other']).default('manual'),
    note: z.string().trim().max(500).optional(),
  })
  .strict();
const distinctIds = (value: string[]): boolean => new Set(value).size === value.length;
const competitorResearchFields = z
  .object({
    brandName: z.string().trim().min(1).max(100),
    homepageUrl: z.string().trim().url().max(500),
    pageTitle: z.string().trim().max(200).nullable().default(null),
    productSummary: z.string().trim().max(4000).nullable().default(null),
    lifecycleStatus: competitorResearchStatus.default('inbox'),
    primaryGroupId: competitorId.nullable().default(null),
    seedKeywords: z.array(researchKeyword).max(50).default([]),
    paymentProviders: z.array(competitorResearchPayment).max(12).default([]),
    sources: z.array(competitorResearchSource).max(20).default([]),
    sourceThreadUrl: z.string().trim().min(1).max(2048).nullable().default(null),
    notes: z.string().trim().max(4000).nullable().default(null),
  })
  .strict();
export const competitorResearchInput = competitorResearchFields
  .refine(value => Boolean(value.primaryGroupId), {
    message: 'A root-term group is required for new research profiles',
    path: ['primaryGroupId'],
  })
  .refine(
    value =>
      distinctIds(value.seedKeywords.map(keyword => keyword.normalize('NFKC').toLowerCase())),
    {
      message: 'Seed keywords must be unique',
      path: ['seedKeywords'],
    }
  )
  .refine(
    value =>
      distinctIds(
        value.paymentProviders.map(item => item.provider.normalize('NFKC').toLowerCase())
      ),
    {
      message: 'Payment providers must be unique',
      path: ['paymentProviders'],
    }
  );
export const competitorResearchUpdate = competitorResearchFields
  .partial()
  .extend({
    rawInput: z.string().trim().min(20).max(12_000).nullable().optional(),
  })
  .strict()
  .refine(value => Object.keys(value).length > 0, 'At least one change is required')
  .refine(
    value =>
      !value.seedKeywords ||
      distinctIds(value.seedKeywords.map(keyword => keyword.normalize('NFKC').toLowerCase())),
    { message: 'Seed keywords must be unique', path: ['seedKeywords'] }
  )
  .refine(
    value =>
      !value.paymentProviders ||
      distinctIds(
        value.paymentProviders.map(item => item.provider.normalize('NFKC').toLowerCase())
      ),
    { message: 'Payment providers must be unique', path: ['paymentProviders'] }
  );
export const competitorResearchFilters = z
  .object({
    lifecycleStatus: competitorResearchStatus.optional(),
    groupId: competitorId.optional(),
    categoryId: competitorId.optional(),
    siteId: competitorId.optional(),
    monitorId: competitorId.optional(),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce
      .number()
      .int()
      .refine(value => value === 10 || value === 20, {
        message: 'Page size must be 10 or 20',
      })
      .default(10),
  })
  .strict();
export const competitorResearchDraftInput = z
  .object({
    homepageUrl: z.string().trim().url().max(500),
    brandName: z.string().trim().min(1).max(100).nullable().default(null),
    pageTitle: z.string().trim().min(1).max(200).nullable().default(null),
    productSummary: z.string().trim().min(1).max(4000).nullable().default(null),
    seedKeywords: z.array(researchKeyword).max(50).default([]),
  })
  .strict()
  .refine(
    value =>
      distinctIds(value.seedKeywords.map(keyword => keyword.normalize('NFKC').toLowerCase())),
    {
      message: 'Seed keywords must be unique',
      path: ['seedKeywords'],
    }
  );
export const competitorResearchIntakeInput = z
  .object({
    rawInput: z.string().trim().min(20).max(12_000),
    lifecycleStatus: competitorResearchStatus.default('inbox'),
    primaryGroupId: competitorId,
    researchMode: competitorResearchIntakeMode.default('pasted_site_research'),
    localCapabilityId: competitorResearchLocalCapability.nullable().default(null),
    sourceThreadUrl: sourceReferenceUrl.nullable().default(null),
  })
  .strict()
  .refine(
    value => value.researchMode === 'pasted_site_research' || Boolean(value.sourceThreadUrl),
    {
      message: 'A Codex task URL is required for local research imports',
      path: ['sourceThreadUrl'],
    }
  )
  .refine(
    value => value.researchMode !== 'codex_local_handoff' || Boolean(value.localCapabilityId),
    {
      message: 'A local capability id is required for local skill handoffs',
      path: ['localCapabilityId'],
    }
  );
export const competitorResearchLinksInput = z
  .object({ ids: z.array(competitorId).max(100).refine(distinctIds, 'Link ids must be unique') })
  .strict();
export const competitorPreResearchRunInput = z
  .object({
    sourceJobUrl: keywordHarvesterJobUrl,
    sourceVersion: z.string().trim().min(1).max(40),
    title: z.string().trim().min(1).max(160),
    currentQuery: z.string().trim().min(1).max(200).nullable().default(null),
    harvestStatus: z
      .enum(['active', 'completed', 'paused', 'partial', 'unknown'])
      .default('unknown'),
    seedKeywords: z.array(researchKeyword).max(50).default([]),
    summary: z.string().trim().max(1000).nullable().default(null),
    sourceThreadUrl: sourceReferenceUrl.nullable().default(null),
  })
  .strict()
  .refine(
    value =>
      distinctIds(value.seedKeywords.map(keyword => keyword.normalize('NFKC').toLowerCase())),
    {
      message: 'Seed keywords must be unique',
      path: ['seedKeywords'],
    }
  );
export const competitorPreResearchActionInput = z
  .object({
    kind: competitorPreResearchActionKind.default('note'),
    outcome: competitorPreResearchOutcome.default('completed'),
    title: z.string().trim().min(1).max(160),
    detail: z.string().trim().max(1000).nullable().default(null),
    references: z
      .array(sourceReferenceUrl)
      .max(4)
      .refine(distinctIds, 'References must be unique')
      .default([]),
    occurredAt: z.number().int().min(0).max(4_102_444_800_000).optional(),
  })
  .strict();
export const competitorPreResearchStageInput = z
  .object({ stage: competitorPreResearchStage })
  .strict();
export const competitorPreResearchFilters = z
  .object({ stage: competitorPreResearchStage.optional() })
  .strict();
export type CompetitorResearchFilters = z.input<typeof competitorResearchFilters>;
export type CompetitorResearchDraftInput = z.infer<typeof competitorResearchDraftInput>;
export type CompetitorResearchStatus = z.infer<typeof competitorResearchStatus>;
export type CompetitorResearchIntakeInput = z.infer<typeof competitorResearchIntakeInput>;
export type CompetitorResearchIntakeMode = z.infer<typeof competitorResearchIntakeMode>;
export type CompetitorResearchLocalCapability = z.infer<typeof competitorResearchLocalCapability>;
export type CompetitorPreResearchStage = z.infer<typeof competitorPreResearchStage>;
export type CompetitorPreResearchActionKind = z.infer<typeof competitorPreResearchActionKind>;
export type CompetitorPreResearchOutcome = z.infer<typeof competitorPreResearchOutcome>;
export type CompetitorPreResearchFilters = z.infer<typeof competitorPreResearchFilters>;
export interface CompetitorCategory {
  id: string;
  name: string;
  monitorCount: number;
}

export interface CompetitorResearchGroup {
  id: string;
  name: string;
  rootTerm: string;
  profileCount: number;
}

export const COMPETITOR_LIMITS = {
  workspace: 100,
  site: 20,
  unlinked: 20,
  categories: 30,
  researchGroups: 100,
  researchProfiles: 500,
  researchCategoryLinks: 30,
  researchSiteLinks: 100,
  researchMonitorLinks: 100,
  preResearchRuns: 500,
  preResearchActions: 200,
} as const;

export interface CompetitorSnapshot {
  title: string;
  h1: string;
  description: string;
  canonical: string;
  robots: string;
  regionText: string;
  contentHash: string;
  contentCharacters: number;
}

export interface CompetitorCheck {
  id: string;
  checkedAt: number;
  status: 'baseline' | 'unchanged' | 'changed' | 'error';
  errorCode: string | null;
  httpStatus: number | null;
  snapshot: CompetitorSnapshot | null;
  previous: CompetitorSnapshot | null;
  previousCheckedAt: number | null;
  changes: (keyof CompetitorSnapshot)[];
}

export interface CompetitorMonitor {
  id: string;
  siteId: string | null;
  workspaceId: string | null;
  categoryId: string | null;
  name: string;
  url: string;
  hostname: string;
  selector: string;
  cadence: z.infer<typeof competitorCadence>;
  nextCheckAt: number | null;
  lastCheckedAt: number | null;
  retainedChecks: number;
  latest: CompetitorCheck | null;
}

export interface CompetitorResearchPayment {
  provider: string;
  status: z.infer<typeof competitorResearchPayment>['status'];
  evidence?: string;
}

export interface CompetitorResearchSource {
  url: string;
  kind: z.infer<typeof competitorResearchSource>['kind'];
  note?: string;
}

export interface CompetitorResearchAnalysis {
  researchMode?: CompetitorResearchIntakeMode;
  localCapabilityId?: CompetitorResearchLocalCapability | null;
  provider: 'glm' | 'terra';
  model: string;
  generatedAt: number;
  detailedAnalysis: string;
  suggestedCategories: string[];
  evidenceGaps: string[];
}

export interface CompetitorResearchProfile {
  id: string;
  workspaceId: string;
  brandName: string;
  homepageUrl: string;
  hostname: string;
  pageTitle: string | null;
  productSummary: string | null;
  lifecycleStatus: CompetitorResearchStatus;
  seedKeywords: string[];
  paymentProviders: CompetitorResearchPayment[];
  sources: CompetitorResearchSource[];
  sourceThreadUrl: string | null;
  notes: string | null;
  rawInput: string | null;
  analysis: CompetitorResearchAnalysis | null;
  primaryGroup: Pick<CompetitorResearchGroup, 'id' | 'name' | 'rootTerm'> | null;
  createdAt: number;
  updatedAt: number;
  categories: Pick<CompetitorCategory, 'id' | 'name'>[];
  sites: { id: string; name: string; domain: string }[];
  monitors: Pick<CompetitorMonitor, 'id' | 'name' | 'url'>[];
}

export interface CompetitorResearchDraft {
  source: 'ai_research_draft';
  provider: 'glm' | 'terra';
  model: string;
  generatedAt: number;
  draft: {
    brandName: string;
    pageTitle: string | null;
    productSummary: string | null;
    seedKeywords: string[];
    paymentProviders: CompetitorResearchPayment[];
    evidenceGaps: string[];
  };
  attempts: {
    provider: 'glm' | 'terra';
    model: string;
    outcome: 'succeeded' | 'failed' | 'skipped';
    reason?:
      | 'not_configured'
      | 'invalid_configuration'
      | 'timeout'
      | 'upstream_rejected'
      | 'unavailable'
      | 'invalid_response'
      | 'truncated_response';
  }[];
  limitations: string[];
}

export interface CompetitorResearchIntakeResult {
  source: CompetitorResearchIntakeMode;
  profileId: string;
  provider: 'glm' | 'terra';
  model: string;
  savedAt: number;
  limitations: string[];
}

export const competitorResearchLocalCapabilityMetadata: Record<
  CompetitorResearchLocalCapability,
  { label: string; description: string }
> = {
  'competitor-analysis': {
    label: '竞品分析',
    description: '市场范围、竞品集合、定位、定价与差异化机会。',
  },
  'competitor-profiling': {
    label: '竞品档案',
    description: '基于公开来源的产品、定价、SEO 与市场档案。',
  },
  'assess-market-competition': {
    label: '市场竞争评估',
    description: '饱和度、进入壁垒、竞争等级与下一步验证。',
  },
  'competitive-battlecard': {
    label: '竞争战卡',
    description: '与己方产品对比的销售定位、异议与竞争策略。',
  },
  '30x-seo-sitemap': {
    label: '竞品 Sitemap 审计',
    description: '公开 sitemap、发现面与 URL 结构证据。',
  },
  '30x-seo-technical': {
    label: '竞品技术 SEO 审计',
    description: '可抓取性、索引、渲染、性能与结构化数据证据。',
  },
  '30x-seo-keywords': {
    label: '竞品关键词研究',
    description: '种子词、需求、难度与内容缺口的外部数据结果。',
  },
  'design-review': {
    label: '竞品体验评审',
    description: '公开界面的层级、一致性、可用性与可访问性观察。',
  },
};

export interface CompetitorResearchReport {
  source: 'manual_research_library';
  generatedAt: number;
  canManage: boolean;
  scope: {
    workspaceId: string;
    lifecycleStatus?: CompetitorResearchStatus;
    categoryId?: string;
    siteId?: string;
    monitorId?: string;
  };
  pagination: {
    page: number;
    pageSize: 10 | 20;
    total: number;
    totalPages: number;
  };
  limits: Pick<
    typeof COMPETITOR_LIMITS,
    'researchProfiles' | 'researchCategoryLinks' | 'researchSiteLinks' | 'researchMonitorLinks'
  >;
  profiles: CompetitorResearchProfile[];
  limitations: string[];
}

export interface CompetitorPreResearchAction {
  id: string;
  kind: CompetitorPreResearchActionKind;
  outcome: CompetitorPreResearchOutcome;
  title: string;
  detail: string | null;
  references: string[];
  occurredAt: number;
}

export interface CompetitorPreResearchRun {
  id: string;
  workspaceId: string;
  source: 'keyword_harvester';
  sourceJobId: string;
  sourceJobUrl: string;
  sourceVersion: string;
  title: string;
  currentQuery: string | null;
  harvestStatus: 'active' | 'completed' | 'paused' | 'partial' | 'unknown';
  stage: CompetitorPreResearchStage;
  seedKeywords: string[];
  summary: string | null;
  sourceThreadUrl: string | null;
  actionCount: number;
  latestActionAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface CompetitorPreResearchDetail extends CompetitorPreResearchRun {
  actions: CompetitorPreResearchAction[];
}

export interface CompetitorPreResearchReport {
  source: 'keyword_harvester_import';
  generatedAt: number;
  canManage: boolean;
  scope: { workspaceId: string; stage?: CompetitorPreResearchStage };
  limits: Pick<typeof COMPETITOR_LIMITS, 'preResearchRuns' | 'preResearchActions'>;
  runs: CompetitorPreResearchRun[];
  limitations: string[];
}

export interface CompetitorReport {
  source: 'public_html_observation';
  generatedAt: number;
  canManage: boolean;
  schedulerEnabled: boolean;
  allowedHosts: string[];
  retentionPerMonitor: number;
  scope: { workspaceId: string | null; siteId?: string; categoryId?: string };
  categories: CompetitorCategory[];
  workspaceMonitorCount: number;
  limits: typeof COMPETITOR_LIMITS;
  monitors: CompetitorMonitor[];
  trend: { date: string; checks: number; changes: number | null; failures: number | null }[];
  limitations: string[];
}
