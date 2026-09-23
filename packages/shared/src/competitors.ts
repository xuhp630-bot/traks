import { z } from 'zod';

export const competitorCadence = z.enum(['manual', 'daily', 'weekly']);
export const competitorResearchStatus = z.enum([
  'inbox',
  'focus',
  'watch',
  'parked',
  'discarded',
]);
const competitorId = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/);
export const competitorCategoryInput = z
  .object({ name: z.string().trim().min(1).max(40) })
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
    seedKeywords: z.array(researchKeyword).max(50).default([]),
    paymentProviders: z.array(competitorResearchPayment).max(12).default([]),
    sources: z.array(competitorResearchSource).max(20).default([]),
    sourceThreadUrl: z.string().trim().min(1).max(2048).nullable().default(null),
    notes: z.string().trim().max(4000).nullable().default(null),
  })
  .strict();
export const competitorResearchInput = competitorResearchFields
  .refine(value => distinctIds(value.seedKeywords.map(keyword => keyword.normalize('NFKC').toLowerCase())), {
    message: 'Seed keywords must be unique',
    path: ['seedKeywords'],
  })
  .refine(value => distinctIds(value.paymentProviders.map(item => item.provider.normalize('NFKC').toLowerCase())), {
    message: 'Payment providers must be unique',
    path: ['paymentProviders'],
  });
export const competitorResearchUpdate = competitorResearchFields
  .partial()
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
      distinctIds(value.paymentProviders.map(item => item.provider.normalize('NFKC').toLowerCase())),
    { message: 'Payment providers must be unique', path: ['paymentProviders'] }
  );
export const competitorResearchFilters = z
  .object({
    lifecycleStatus: competitorResearchStatus.optional(),
    categoryId: competitorId.optional(),
    siteId: competitorId.optional(),
    monitorId: competitorId.optional(),
  })
  .strict();
export const competitorResearchLinksInput = z
  .object({ ids: z.array(competitorId).max(100).refine(distinctIds, 'Link ids must be unique') })
  .strict();
export type CompetitorResearchFilters = z.infer<typeof competitorResearchFilters>;
export type CompetitorResearchStatus = z.infer<typeof competitorResearchStatus>;
export interface CompetitorCategory {
  id: string;
  name: string;
  monitorCount: number;
}

export const COMPETITOR_LIMITS = {
  workspace: 100,
  site: 20,
  unlinked: 20,
  categories: 30,
  researchProfiles: 500,
  researchCategoryLinks: 30,
  researchSiteLinks: 100,
  researchMonitorLinks: 100,
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
  createdAt: number;
  updatedAt: number;
  categories: Pick<CompetitorCategory, 'id' | 'name'>[];
  sites: { id: string; name: string; domain: string }[];
  monitors: Pick<CompetitorMonitor, 'id' | 'name' | 'url'>[];
}

export interface CompetitorResearchReport {
  source: 'manual_research_library';
  generatedAt: number;
  canManage: boolean;
  scope: { workspaceId: string; lifecycleStatus?: CompetitorResearchStatus; categoryId?: string; siteId?: string; monitorId?: string };
  limits: Pick<
    typeof COMPETITOR_LIMITS,
    'researchProfiles' | 'researchCategoryLinks' | 'researchSiteLinks' | 'researchMonitorLinks'
  >;
  profiles: CompetitorResearchProfile[];
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
