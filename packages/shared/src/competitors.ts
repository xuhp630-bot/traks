import { z } from 'zod';

export const competitorCadence = z.enum(['manual', 'daily', 'weekly']);
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
  monitors: CompetitorMonitor[];
  trend: { date: string; checks: number; changes: number | null; failures: number | null }[];
  limitations: string[];
}
