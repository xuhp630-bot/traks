import { z } from 'zod';

export const competitorCadence = z.enum(['manual', 'daily', 'weekly']);
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
