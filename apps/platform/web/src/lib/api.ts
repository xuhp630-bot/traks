import { hc, type InferResponseType } from 'hono/client';
import type { AppType } from '@traks/platform-api';
import type { Period, EvidencePage } from '@traks/shared';
import type {
  CompetitorReport,
  CompetitorCheck,
  CompetitorCategory,
  CompetitorFilters,
  CompetitorPreResearchDetail,
  CompetitorPreResearchFilters,
  CompetitorPreResearchReport,
  CompetitorResearchDraft,
  CompetitorResearchDraftInput,
  CompetitorResearchFilters,
  CompetitorResearchReport,
} from '@traks/shared';
import type { buildAnalysisPackage } from '@traks/shared';
import { authClient } from '@/lib/auth-client';

/** Click-to-filter params, passed through to the analytics endpoints. */
export interface AnalyticsFilters {
  page?: string;
  source?: string;
  utmSource?: string;
  utmMedium?: string;
  utmCampaign?: string;
  country?: string;
  region?: string;
  city?: string;
  browser?: string;
  os?: string;
  device?: string;
}

// Same-origin: /api/* is served by the API worker via a zone route in prod
// and the vite proxy in dev, so the Access cookie is attached automatically.
const client = hc<AppType>('');
type CrmQualityResponse = InferResponseType<
  (typeof client.api.analytics)[':siteId']['stats']['crm-quality']['$get'],
  200
>;

/** API failure carrying the HTTP status, so callers can distinguish an
 *  expired session (401) or a missing site (404) from a transient 5xx. */
export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

/** 401/403/404/409 are decisions, not blips - retrying them just multiplies load. */
export const isRetryableError = (err: unknown): boolean =>
  !(err instanceof ApiError) || ![401, 403, 404, 409].includes(err.status);

async function assertOk(res: Response): Promise<void> {
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let message = `API error ${res.status}`;
    try {
      const parsed = JSON.parse(text) as { error?: unknown; message?: unknown };
      // Only take `error` when it is genuinely a sentence. Some validation
      // responses put an object there, which used to render as
      // "[object Object]" in place of the actual reason.
      const candidate = [parsed?.error, parsed?.message].find(v => typeof v === 'string' && v);
      if (candidate) message = candidate as string;
    } catch {
      if (text) message = `${message}: ${text}`;
    }
    // An expired session must land on /login rather than leaving every panel
    // showing "failed to load" against a dashboard the user can't refresh.
    if (res.status === 401 && !window.location.pathname.startsWith('/login')) {
      window.location.href = '/login';
    }
    throw new ApiError(res.status, message);
  }
}

/** Better Auth client calls return {data, error} - normalize to throwing
 *  ApiError so react-query error paths stay identical to the REST calls. */
function unwrap<T>(res: {
  data: T | null;
  error: { message?: string; status?: number } | null;
}): T {
  if (res.error) {
    throw new ApiError(res.error.status ?? 500, res.error.message || 'Request failed');
  }
  return res.data as T;
}

/** Org plugin requires a slug; derive one from the name, uniqued by suffix. */
function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30);
  return `${base || 'workspace'}-${Math.random().toString(36).slice(2, 8)}`;
}

type CompetitorScope = string | ({ workspaceId: string } & CompetitorFilters);
const competitorRoot = (scope: CompetitorScope): string =>
  typeof scope === 'string'
    ? `/api/competitors/${encodeURIComponent(scope)}`
    : `/api/competitors/workspaces/${encodeURIComponent(scope.workspaceId)}`;

export const api = {
  async getCompetitorCategories(
    workspaceId: string
  ): Promise<{ data: { categories: CompetitorCategory[]; canManage: boolean; limit: number } }> {
    const response = await fetch(`${competitorRoot({ workspaceId })}/categories`);
    await assertOk(response);
    return response.json();
  },
  async getCompetitors(scope: CompetitorScope): Promise<{ data: CompetitorReport }> {
    const filters = new URLSearchParams();
    if (typeof scope !== 'string') {
      if (scope.siteId) filters.set('siteId', scope.siteId);
      if (scope.categoryId) filters.set('categoryId', scope.categoryId);
    }
    const response = await fetch(`${competitorRoot(scope)}${filters.size ? `?${filters}` : ''}`);
    await assertOk(response);
    return response.json();
  },
  async getCompetitorResearch(
    workspaceId: string,
    filters: CompetitorResearchFilters = {}
  ): Promise<{ data: CompetitorResearchReport }> {
    const query = new URLSearchParams();
    if (filters.lifecycleStatus) query.set('lifecycleStatus', filters.lifecycleStatus);
    if (filters.categoryId) query.set('categoryId', filters.categoryId);
    if (filters.siteId) query.set('siteId', filters.siteId);
    if (filters.monitorId) query.set('monitorId', filters.monitorId);
    const response = await fetch(
      `${competitorRoot({ workspaceId })}/research${query.size ? `?${query}` : ''}`
    );
    await assertOk(response);
    return response.json();
  },
  async generateCompetitorResearchDraft(
    workspaceId: string,
    input: CompetitorResearchDraftInput
  ): Promise<{ data: CompetitorResearchDraft }> {
    const response = await fetch(`${competitorRoot({ workspaceId })}/research/draft`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    });
    await assertOk(response);
    return response.json();
  },
  async getCompetitorPreResearch(
    workspaceId: string,
    filters: CompetitorPreResearchFilters = {}
  ): Promise<{ data: CompetitorPreResearchReport }> {
    const query = new URLSearchParams();
    if (filters.stage) query.set('stage', filters.stage);
    const response = await fetch(
      `${competitorRoot({ workspaceId })}/research/pre-research${query.size ? `?${query}` : ''}`
    );
    await assertOk(response);
    return response.json();
  },
  async getCompetitorPreResearchDetail(
    workspaceId: string,
    runId: string
  ): Promise<{ data: CompetitorPreResearchDetail }> {
    const response = await fetch(
      `${competitorRoot({ workspaceId })}/research/pre-research/${encodeURIComponent(runId)}`
    );
    await assertOk(response);
    return response.json();
  },
  async getCompetitorHistory(
    scope: CompetitorScope,
    monitorId: string
  ): Promise<{ data: { checks: CompetitorCheck[] } }> {
    const response = await fetch(
      `${competitorRoot(scope)}/${encodeURIComponent(monitorId)}/history`
    );
    await assertOk(response);
    return response.json();
  },
  async mutateCompetitor(
    scope: CompetitorScope,
    suffix: string,
    method: 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    body?: object
  ): Promise<unknown> {
    const response = await fetch(`${competitorRoot(scope)}${suffix}`, {
      method,
      ...(body
        ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
        : {}),
    });
    await assertOk(response);
    return response.json();
  },
  async getQualityInsights(
    siteId: string,
    period: Period,
    filters: AnalyticsFilters | undefined,
    signal: AbortSignal
  ): Promise<{ data: ReturnType<typeof buildAnalysisPackage> }> {
    const response = await client.api.analytics[':siteId'].stats['quality-insights'].$get(
      { param: { siteId }, query: { period, ...filters } },
      { init: { signal } }
    );
    await assertOk(response);
    return (await response.json()) as { data: ReturnType<typeof buildAnalysisPackage> };
  },
  async getCrmQuality(
    siteId: string,
    from: string,
    to: string,
    signal: AbortSignal
  ): Promise<CrmQualityResponse> {
    const response = await client.api.analytics[':siteId'].stats['crm-quality'].$get(
      { param: { siteId }, query: { from, to } },
      { init: { signal } }
    );
    await assertOk(response);
    const value = await response.json();
    if ('error' in value) throw new Error('CRM unavailable');
    return value;
  },
  async getQualityEvidence(
    siteId: string,
    period: Period,
    filters: AnalyticsFilters | undefined,
    cursor: string | undefined,
    signal: AbortSignal
  ): Promise<EvidencePage> {
    const response = await client.api.analytics[':siteId'].stats['quality-evidence'].$get(
      {
        param: { siteId },
        query: { period, ...filters, cursor },
      },
      { init: { signal } }
    );
    await assertOk(response);
    return (await response.json()) as EvidencePage;
  },
  // Current user
  async getMe(): Promise<any> {
    const res = await client.api.me.$get();
    await assertOk(res);
    return res.json();
  },

  // Workspaces - reads come from the custom aggregation endpoint (role +
  // siteCount + bootstrap); lifecycle goes through the org plugin.
  async getWorkspaces(): Promise<any> {
    const res = await client.api.workspaces.$get();
    await assertOk(res);
    return res.json();
  },

  async createWorkspace(data: { name: string }): Promise<any> {
    const org = unwrap(
      await authClient.organization.create({ name: data.name, slug: slugify(data.name) })
    );
    return { data: org };
  },

  async updateWorkspace(workspaceId: string, data: { name: string }): Promise<any> {
    const org = unwrap(
      await authClient.organization.update({
        organizationId: workspaceId,
        data: { name: data.name },
      })
    );
    return { data: org };
  },

  async deleteWorkspace(workspaceId: string): Promise<any> {
    unwrap(await authClient.organization.delete({ organizationId: workspaceId }));
    return { ok: true };
  },

  // Members
  async getMembers(workspaceId: string): Promise<any> {
    const res = await client.api.workspaces[':id'].members.$get({ param: { id: workspaceId } });
    await assertOk(res);
    return res.json();
  },

  async removeMember(workspaceId: string, memberEmail: string): Promise<any> {
    unwrap(
      await authClient.organization.removeMember({
        organizationId: workspaceId,
        memberIdOrEmail: memberEmail,
      })
    );
    return { ok: true };
  },

  async leaveWorkspace(workspaceId: string): Promise<any> {
    unwrap(await authClient.organization.leave({ organizationId: workspaceId }));
    return { ok: true };
  },

  // Invitations - created/canceled/accepted via the org plugin; the row id
  // IS the invite-link token. Public preview stays a custom endpoint (the
  // plugin's getInvitation requires a session the invitee doesn't have).
  async createInvitation(
    workspaceId: string,
    data: { email: string; role?: 'owner' | 'member' }
  ): Promise<any> {
    const invitation = unwrap<{ id: string }>(
      await authClient.organization.inviteMember({
        organizationId: workspaceId,
        email: data.email,
        role: data.role ?? 'member',
      })
    );
    return { data: invitation, token: invitation.id };
  },

  async getInvitations(workspaceId: string): Promise<any> {
    const invitations = unwrap<
      { id: string; email: string; role: string; status: string; expiresAt: Date | string }[]
    >(await authClient.organization.listInvitations({ query: { organizationId: workspaceId } }));
    const pending = (invitations ?? []).filter(
      inv => inv.status === 'pending' && new Date(inv.expiresAt).getTime() > Date.now()
    );
    return { data: pending };
  },

  async revokeInvitation(_workspaceId: string, invitationId: string): Promise<any> {
    unwrap(await authClient.organization.cancelInvitation({ invitationId }));
    return { ok: true };
  },

  async getInvitation(token: string): Promise<any> {
    const res = await client.api.invitations[':token'].$get({ param: { token } });
    await assertOk(res);
    return res.json();
  },

  async acceptInvitation(token: string): Promise<any> {
    const accepted = unwrap<{ member: { organizationId: string } }>(
      await authClient.organization.acceptInvitation({ invitationId: token })
    );
    return { data: { workspaceId: accepted.member.organizationId } };
  },

  // Sites
  async getSites(workspaceId?: string): Promise<any> {
    const res = await client.api.sites.$get({
      query: workspaceId ? { workspaceId } : {},
    });
    await assertOk(res);
    return res.json();
  },

  async createSite(data: {
    name: string;
    domain: string;
    timezone?: string;
    workspaceId?: string;
  }): Promise<any> {
    const res = await client.api.sites.$post({ json: data });
    await assertOk(res);
    return res.json();
  },

  async getSite(siteId: string): Promise<any> {
    const res = await client.api.sites[':id'].$get({ param: { id: siteId } });
    await assertOk(res);
    return res.json();
  },

  async updateSite(
    siteId: string,
    data: { name: string; domain: string; timezone?: string }
  ): Promise<any> {
    const res = await client.api.sites[':id'].$patch({ param: { id: siteId }, json: data });
    await assertOk(res);
    return res.json();
  },

  async setAllSitesTimezone(timezone: string, workspaceId?: string): Promise<any> {
    const res = await client.api.sites.timezone.$post({ json: { timezone, workspaceId } });
    await assertOk(res);
    return res.json();
  },

  async deleteSite(siteId: string): Promise<any> {
    const res = await client.api.sites[':id'].$delete({ param: { id: siteId } });
    await assertOk(res);
    return res.json();
  },

  // Event catalog (expected events from the production tracking plan)
  async getEventCatalog(siteId: string): Promise<any> {
    const res = await client.api.sites[':id']['event-catalog'].$get({ param: { id: siteId } });
    await assertOk(res);
    return res.json();
  },

  async replaceEventCatalog(
    siteId: string,
    data: {
      events: {
        eventName: string;
        category: string;
        aliases?: string[];
        wave?: string;
        journeyStage?: string;
      }[];
    }
  ): Promise<any> {
    const res = await client.api.sites[':id']['event-catalog'].$put({
      param: { id: siteId },
      json: data,
    });
    await assertOk(res);
    return res.json();
  },

  // Goals
  async getGoals(siteId: string): Promise<any> {
    const res = await client.api.sites[':id'].goals.$get({ param: { id: siteId } });
    await assertOk(res);
    return res.json();
  },

  async createGoal(
    siteId: string,
    data: {
      name: string;
      type: 'event' | 'page';
      target: string;
      propKey?: string;
      propValue?: string;
    }
  ): Promise<any> {
    const res = await client.api.sites[':id'].goals.$post({ param: { id: siteId }, json: data });
    await assertOk(res);
    return res.json();
  },

  async updateGoal(
    siteId: string,
    goalId: string,
    data: {
      name: string;
      type: 'event' | 'page';
      target: string;
      propKey?: string;
      propValue?: string;
    }
  ): Promise<any> {
    const res = await client.api.sites[':id'].goals[':goalId'].$patch({
      param: { id: siteId, goalId },
      json: data,
    });
    await assertOk(res);
    return res.json();
  },

  async deleteGoal(siteId: string, goalId: string): Promise<any> {
    const res = await client.api.sites[':id'].goals[':goalId'].$delete({
      param: { id: siteId, goalId },
    });
    await assertOk(res);
    return res.json();
  },

  // Personal API tokens (MCP / coding-agent access)
  async getTokens(workspaceId?: string): Promise<any> {
    const res = await client.api.tokens.$get({ query: workspaceId ? { workspaceId } : {} });
    await assertOk(res);
    return res.json();
  },

  async createToken(data: {
    name: string;
    scope: 'read' | 'manage';
    workspaceId: string;
  }): Promise<any> {
    const res = await client.api.tokens.$post({ json: data });
    await assertOk(res);
    return res.json();
  },

  async revokeToken(tokenId: string): Promise<any> {
    const res = await client.api.tokens[':tokenId'].$delete({ param: { tokenId } });
    await assertOk(res);
    return res.json();
  },

  async getSegments(siteId: string): Promise<any> {
    const res = await client.api.sites[':id'].segments.$get({ param: { id: siteId } });
    await assertOk(res);
    return res.json();
  },

  async createSegment(
    siteId: string,
    data: { name: string; filters: Record<string, string> }
  ): Promise<any> {
    const res = await client.api.sites[':id'].segments.$post({
      param: { id: siteId },
      json: data,
    });
    await assertOk(res);
    return res.json();
  },

  async deleteSegment(siteId: string, segmentId: string): Promise<any> {
    const res = await client.api.sites[':id'].segments[':segmentId'].$delete({
      param: { id: siteId, segmentId },
    });
    await assertOk(res);
    return res.json();
  },

  async getFunnels(siteId: string): Promise<any> {
    const res = await client.api.sites[':id'].funnels.$get({ param: { id: siteId } });
    await assertOk(res);
    return res.json();
  },

  async createFunnel(
    siteId: string,
    data: {
      name: string;
      steps: { type: 'event' | 'page'; target: string; propKey?: string; propValue?: string }[];
    }
  ): Promise<any> {
    const res = await client.api.sites[':id'].funnels.$post({ param: { id: siteId }, json: data });
    await assertOk(res);
    return res.json();
  },

  async updateFunnel(
    siteId: string,
    funnelId: string,
    data: {
      name: string;
      steps: { type: 'event' | 'page'; target: string; propKey?: string; propValue?: string }[];
    }
  ): Promise<any> {
    const res = await client.api.sites[':id'].funnels[':funnelId'].$patch({
      param: { id: siteId, funnelId },
      json: data,
    });
    await assertOk(res);
    return res.json();
  },

  async deleteFunnel(siteId: string, funnelId: string): Promise<any> {
    const res = await client.api.sites[':id'].funnels[':funnelId'].$delete({
      param: { id: siteId, funnelId },
    });
    await assertOk(res);
    return res.json();
  },

  async getFunnelStats(
    siteId: string,
    funnelId: string,
    period: Period,
    filters?: AnalyticsFilters
  ): Promise<any> {
    const res = await client.api.analytics[':siteId'].stats.funnel[':funnelId'].$get({
      param: { siteId, funnelId },
      query: { period, ...filters },
    });
    await assertOk(res);
    return res.json();
  },

  async getGoalStats(siteId: string, period: Period, filters?: AnalyticsFilters): Promise<any> {
    const res = await client.api.analytics[':siteId'].stats.goals.$get({
      param: { siteId },
      query: { period, ...filters },
    });
    await assertOk(res);
    return res.json();
  },

  // Analytics
  async getBatchStats(period: Period, siteIds?: string[]): Promise<any> {
    const query: { period: Period; siteIds?: string } = { period };
    if (siteIds && siteIds.length > 0) {
      query.siteIds = siteIds.join(',');
    }
    const res = await client.api.analytics.batch.stats.$get({ query });
    await assertOk(res);
    return res.json();
  },

  async getAllStats(siteId: string, period: Period): Promise<any> {
    const res = await client.api.analytics[':siteId'].stats.all.$get({
      param: { siteId },
      query: { period },
    });
    await assertOk(res);
    return res.json();
  },

  async getMainStats(siteId: string, period: Period, filters?: AnalyticsFilters): Promise<any> {
    const res = await client.api.analytics[':siteId'].stats.main.$get({
      param: { siteId },
      query: { period, ...filters },
    });
    await assertOk(res);
    return res.json();
  },

  async getTimeseries(siteId: string, period: Period, filters?: AnalyticsFilters): Promise<any> {
    const res = await client.api.analytics[':siteId'].stats.timeseries.$get({
      param: { siteId },
      query: { period, ...filters },
    });
    await assertOk(res);
    return res.json();
  },

  async getTopPages(
    siteId: string,
    period: Period,
    type: 'top' | 'entry' | 'exit',
    filters?: AnalyticsFilters
  ): Promise<any> {
    const res = await client.api.analytics[':siteId'].stats.pages.$get({
      param: { siteId },
      query: { period, type, ...filters },
    });
    await assertOk(res);
    return res.json();
  },

  async getLinks(
    siteId: string,
    period: Period,
    type: 'outbound' | 'download',
    filters?: AnalyticsFilters
  ): Promise<any> {
    const res = await client.api.analytics[':siteId'].stats.links.$get({
      param: { siteId },
      query: { period, type, ...filters },
    });
    await assertOk(res);
    return res.json();
  },

  async getTopReferrers(siteId: string, period: Period, filters?: AnalyticsFilters): Promise<any> {
    const res = await client.api.analytics[':siteId'].stats.referrers.$get({
      param: { siteId },
      query: { period, ...filters },
    });
    await assertOk(res);
    return res.json();
  },

  async getAiSources(siteId: string, period: Period, filters?: AnalyticsFilters): Promise<any> {
    const res = await client.api.analytics[':siteId'].stats['ai-sources'].$get({
      param: { siteId },
      query: { period, ...filters },
    });
    await assertOk(res);
    return res.json();
  },

  async getUtm(
    siteId: string,
    period: Period,
    type: 'source' | 'medium' | 'campaign',
    filters?: AnalyticsFilters
  ): Promise<any> {
    const res = await client.api.analytics[':siteId'].stats.utm.$get({
      param: { siteId },
      query: { period, type, ...filters },
    });
    await assertOk(res);
    return res.json();
  },

  async getLocations(
    siteId: string,
    period: Period,
    type: 'country' | 'region' | 'city',
    filters?: AnalyticsFilters
  ): Promise<any> {
    const res = await client.api.analytics[':siteId'].stats.locations.$get({
      param: { siteId },
      query: { period, type, ...filters },
    });
    await assertOk(res);
    return res.json();
  },

  async getDevices(
    siteId: string,
    period: Period,
    type: 'browser' | 'os' | 'device' | 'size',
    filters?: AnalyticsFilters
  ): Promise<any> {
    const res = await client.api.analytics[':siteId'].stats.devices.$get({
      param: { siteId },
      query: { period, type, ...filters },
    });
    await assertOk(res);
    return res.json();
  },

  async getRealtime(siteId: string, filters?: AnalyticsFilters): Promise<any> {
    const res = await client.api.analytics[':siteId'].stats.realtime.$get({
      param: { siteId },
      query: { ...filters },
    });
    await assertOk(res);
    return res.json();
  },

  async getPathFlows(siteId: string, period: Period, filters?: AnalyticsFilters): Promise<any> {
    const res = await client.api.analytics[':siteId'].stats['path-flows'].$get({
      param: { siteId },
      query: { period, ...filters },
    });
    await assertOk(res);
    return res.json();
  },

  async getEvents(siteId: string, period: Period, filters?: AnalyticsFilters): Promise<any> {
    const res = await client.api.analytics[':siteId'].stats.events.$get({
      param: { siteId },
      query: { period, ...filters },
    });
    await assertOk(res);
    return res.json();
  },

  async getEventPages(siteId: string, period: Period, filters?: AnalyticsFilters): Promise<any> {
    const res = await client.api.analytics[':siteId'].stats['event-pages'].$get({
      param: { siteId },
      query: { period, ...filters },
    });
    await assertOk(res);
    return res.json();
  },

  async getWebmcp(siteId: string, period: Period, filters?: AnalyticsFilters): Promise<any> {
    const res = await client.api.analytics[':siteId'].stats.webmcp.$get({
      param: { siteId },
      query: { period, ...filters },
    });
    await assertOk(res);
    return res.json();
  },

  async getBots(siteId: string, period: Period, filters?: AnalyticsFilters): Promise<any> {
    const res = await client.api.analytics[':siteId'].stats.bots.$get({
      param: { siteId },
      query: { period, ...filters },
    });
    await assertOk(res);
    return res.json();
  },

  async getEventProps(
    siteId: string,
    period: Period,
    event: string,
    filters?: AnalyticsFilters
  ): Promise<any> {
    const res = await client.api.analytics[':siteId'].stats['event-props'].$get({
      param: { siteId },
      query: { period, event, ...filters },
    });
    await assertOk(res);
    return res.json();
  },

  async getSessions(siteId: string, period: Period, filters?: AnalyticsFilters): Promise<any> {
    const res = await client.api.analytics[':siteId'].stats.sessions.$get({
      param: { siteId },
      query: { period, ...filters },
    });
    await assertOk(res);
    return res.json();
  },

  async getSessionJourney(
    siteId: string,
    period: Period,
    sessionId: string,
    filters?: AnalyticsFilters
  ): Promise<any> {
    const res = await client.api.analytics[':siteId'].stats['session-journey'].$get({
      param: { siteId },
      query: { period, sessionId, ...filters },
    });
    await assertOk(res);
    return res.json();
  },
};
