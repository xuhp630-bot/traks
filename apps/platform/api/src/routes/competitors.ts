import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { HTTPException } from 'hono/http-exception';
import { createId } from '@paralleldrive/cuid2';
import {
  workspaceCompetitorInput,
  competitorCategoryInput,
  competitorResearchGroupInput,
  competitorFilters,
  competitorUpdate,
  competitorResearchFilters,
  competitorResearchDraftInput,
  competitorResearchIntakeInput,
  competitorResearchRegenerateInput,
  competitorResearchInput,
  competitorResearchLinksInput,
  competitorResearchUpdate,
  competitorPreResearchActionInput,
  competitorPreResearchFilters,
  competitorPreResearchRunInput,
  competitorPreResearchStageInput,
  COMPETITOR_LIMITS,
} from '@traks/shared';
import type { z } from 'zod';
import type { Bindings, Variables } from '../types';
import { requireAuth } from '../middleware/auth';
import { getMembership, getSiteAccess } from '../lib/workspaces';
import { roleAllows } from '../lib/permissions';
import { validate } from '../lib/validate';
import { publicPageUrl, CompetitorFetchError } from '../lib/competitor-fetch';
import {
  checkCompetitor,
  competitorHistory,
  competitorReport,
  competitorCategories,
  competitorScope,
  nextCompetitorCheck,
  type CompetitorScope,
} from '../lib/competitors';
import {
  competitorResearchGroups,
  competitorResearchReport,
  replaceResearchCategoryLinks,
  replaceResearchMonitorLinks,
  replaceResearchSiteLinks,
  researchGroupExists,
  researchProfileExists,
} from '../lib/competitor-research';
import {
  competitorPreResearchDetail,
  competitorPreResearchReport,
  keywordHarvesterJobId,
  preResearchRunExists,
} from '../lib/competitor-pre-research';
import {
  generateCompetitorResearchDraft,
  generateCompetitorResearchIntake,
} from '../lib/competitor-research-draft';

type Ctx = Context<{ Bindings: Bindings; Variables: Variables }>;
type Access = {
  scope: CompetitorScope;
  workspaceId: string | null;
  siteId: string | null;
  canManage: boolean;
};

async function access(c: Ctx, write = false): Promise<Access | Response> {
  const workspaceId = c.req.param('workspaceId');
  let result: Access;
  if (workspaceId) {
    if (c.get('tokenWorkspaceId') && c.get('tokenWorkspaceId') !== workspaceId)
      return c.json({ error: 'Workspace not found' }, 404);
    const membership = await getMembership(c.get('db')!, workspaceId, c.get('userId')!);
    if (!membership) return c.json({ error: 'Workspace not found' }, 404);
    result = {
      workspaceId,
      siteId: null,
      scope: { workspaceId },
      canManage: membership.role === 'owner',
    };
  } else {
    const site = await getSiteAccess(
      c.get('db')!,
      c.get('userId')!,
      c.req.param('siteId') ?? '',
      c.get('tokenWorkspaceId')
    );
    if (!site) return c.json({ error: 'Site not found' }, 404);
    result = {
      workspaceId: site.site.workspaceId,
      siteId: site.site.id,
      scope: site.site.id,
      canManage: roleAllows(site.role, { site: ['configure'] }),
    };
  }
  result.canManage &&= c.get('tokenScope') !== 'read';
  if (write && !result.canManage)
    return c.json({ error: 'Only workspace owners can configure or check competitors' }, 403);
  return result;
}

async function validateReferences(
  c: Ctx,
  workspaceId: string | null,
  siteId: string | null,
  categoryId: string | null
): Promise<Response | null> {
  if (siteId) {
    const site = await getSiteAccess(
      c.get('db')!,
      c.get('userId')!,
      siteId,
      c.get('tokenWorkspaceId')
    );
    if (!site || site.site.workspaceId !== workspaceId)
      return c.json({ error: 'Site not found in this workspace' }, 404);
  }
  if (categoryId) {
    const category = await c.env.DB.prepare(
      'SELECT id FROM competitor_categories WHERE id = ? AND workspace_id = ?'
    )
      .bind(categoryId, workspaceId)
      .first();
    if (!category) return c.json({ error: 'Category not found in this workspace' }, 404);
  }
  return null;
}

async function validateResearchGroup(
  c: Ctx,
  workspaceId: string | null,
  groupId: string | null
): Promise<Response | null> {
  if (!groupId) return null;
  if (!(await researchGroupExists(c.env.DB, workspaceId!, groupId)))
    return c.json({ error: 'Root-term group not found in this workspace' }, 404);
  return null;
}

async function createMonitor(
  c: Ctx,
  scope: Access,
  input: z.infer<typeof workspaceCompetitorInput>
): Promise<Response> {
  if (typeof scope.scope === 'string' && input.siteId !== null)
    return c.json({ error: 'Use the workspace route to assign a site' }, 400);
  const siteId = scope.siteId ?? input.siteId;
  const invalid = await validateReferences(c, scope.workspaceId, siteId, input.categoryId);
  if (invalid) return invalid;
  let url: URL;
  try {
    url = publicPageUrl(input.url);
  } catch (error) {
    return c.json(
      { error: error instanceof CompetitorFetchError ? error.code : 'Invalid URL' },
      400
    );
  }
  const target = competitorScope(siteId ?? { workspaceId: scope.workspaceId!, siteId: 'unlinked' });
  const workspace = competitorScope(
    scope.workspaceId ? { workspaceId: scope.workspaceId } : scope.scope
  );
  const id = createId();
  const now = Date.now();
  const created = await c.env.DB.prepare(
    `INSERT INTO competitor_monitors (id, site_id, workspace_id, category_id, name, url, hostname, selector, cadence, created_at, next_check_at) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE (SELECT count(*) FROM competitor_monitors WHERE ${target.sql}) < ? AND (SELECT count(*) FROM competitor_monitors WHERE ${workspace.sql}) < ? AND (? IS NULL OR EXISTS (SELECT 1 FROM competitor_categories WHERE id = ? AND workspace_id = ?)) ON CONFLICT DO NOTHING RETURNING id`
  )
    .bind(
      id,
      siteId,
      siteId ? null : scope.workspaceId,
      input.categoryId,
      input.name,
      url.href,
      url.hostname,
      input.selector,
      input.cadence,
      now,
      input.cadence === 'manual' ? null : now,
      ...target.values,
      siteId ? COMPETITOR_LIMITS.site : COMPETITOR_LIMITS.unlinked,
      ...workspace.values,
      COMPETITOR_LIMITS.workspace,
      input.categoryId,
      input.categoryId,
      scope.workspaceId
    )
    .first();
  if (!created)
    return c.json(
      {
        error:
          'Duplicate URL, changed category or page limit reached (20/site, 20/unlinked, 100/workspace)',
      },
      409
    );
  return c.json({ data: { id } }, 201);
}

async function validateResearchFilters(
  c: Ctx,
  workspaceId: string,
  filters: z.infer<typeof competitorResearchFilters>
): Promise<Response | null> {
  const group = await validateResearchGroup(c, workspaceId, filters.groupId ?? null);
  if (group) return group;
  const category = await validateReferences(c, workspaceId, null, filters.categoryId ?? null);
  if (category) return category;
  const site = await validateReferences(c, workspaceId, filters.siteId ?? null, null);
  if (site) return site;
  if (filters.monitorId) {
    const scope = competitorScope({ workspaceId });
    const monitor = await c.env.DB.prepare(
      `SELECT id FROM competitor_monitors WHERE id = ? AND ${scope.sql}`
    )
      .bind(filters.monitorId, ...scope.values)
      .first();
    if (!monitor) return c.json({ error: 'Monitor not found in this workspace' }, 404);
  }
  return null;
}

async function validateResearchLinks(
  c: Ctx,
  workspaceId: string,
  kind: 'categories' | 'sites' | 'monitors',
  ids: string[]
): Promise<Response | null> {
  if (!ids.length) return null;
  const placeholders = ids.map(() => '?').join(',');
  let rows: { results: { id: string }[] };
  if (kind === 'categories') {
    rows = await c.env.DB.prepare(
      `SELECT id FROM competitor_categories WHERE workspace_id = ? AND id IN (${placeholders})`
    )
      .bind(workspaceId, ...ids)
      .all<{ id: string }>();
  } else if (kind === 'sites') {
    rows = await c.env.DB.prepare(
      `SELECT id FROM sites WHERE workspace_id = ? AND id IN (${placeholders})`
    )
      .bind(workspaceId, ...ids)
      .all<{ id: string }>();
  } else {
    const scope = competitorScope({ workspaceId });
    rows = await c.env.DB.prepare(
      `SELECT id FROM competitor_monitors WHERE id IN (${placeholders}) AND ${scope.sql}`
    )
      .bind(...ids, ...scope.values)
      .all<{ id: string }>();
  }
  if (rows.results.length !== ids.length)
    return c.json({ error: `One or more ${kind} are outside this workspace` }, 404);
  return null;
}

function pastedResearchUrl(rawInput: string): string | null {
  const labeled = rawInput.match(/(?:^|\n)\s*URL\s*:\s*(.+)/i)?.[1];
  const candidate =
    labeled?.match(/https?:\/\/[^\s)\]>]+/)?.[0] ?? rawInput.match(/https?:\/\/[^\s)\]>]+/)?.[0];
  return candidate?.replace(/[.,;]+$/, '') ?? null;
}

function researchSources(rawInput: string, homepageUrl: URL, researchMode: string) {
  const urls = [homepageUrl.href];
  for (const match of rawInput.matchAll(/https?:\/\/[^\s)\]>"']+/gi)) {
    const candidate = match[0].replace(/[.,;]+$/, '');
    try {
      const url = new URL(candidate);
      if (url.protocol === 'https:' || url.protocol === 'http:') urls.push(url.href);
    } catch {
      continue;
    }
  }
  return [...new Set(urls)].slice(0, 20).map(url => {
    const pathname = new URL(url).pathname.toLowerCase();
    const kind = /checkout|billing|payment/.test(pathname)
      ? 'checkout'
      : /pricing|plan/.test(pathname)
        ? 'pricing'
        : url === homepageUrl.href
          ? 'landing'
          : 'manual';
    return {
      url,
      kind,
      note:
        researchMode !== 'pasted_site_research'
          ? '来自 Codex 深度研究导入，未由 Traks 抓取。'
          : '用户粘贴的网站资料，未自动抓取。',
    };
  });
}

function providerFailureDetail(
  attempts: { provider: string; outcome: string; reason?: string }[]
): string {
  const details = attempts
    .filter(attempt => attempt.outcome !== 'succeeded')
    .map(attempt => `${attempt.provider}:${attempt.reason ?? attempt.outcome}`);
  return details.length ? ` (${details.join(', ')})` : '';
}

function researchGenerationFailureMessage(
  attempts: { provider: string; outcome: string; reason?: string }[]
): string {
  if (attempts.some(attempt => attempt.reason === 'truncated_response'))
    return `AI research generation returned an incomplete response after an automatic compact retry. The configured model could not finish this input; keep only the relevant title, URL, headings, pricing, and payment evidence, then try again.${providerFailureDetail(attempts)}`;
  return `AI research generation is unavailable. Configure the GLM API key, or an authorized OpenAI-compatible Terra API bridge.${providerFailureDetail(attempts)}`;
}

function preResearchRoutes() {
  return new Hono<{ Bindings: Bindings; Variables: Variables }>()
    .get('/', validate('query', competitorPreResearchFilters), async c => {
      const scope = await access(c);
      if (scope instanceof Response) return scope;
      return c.json({
        data: await competitorPreResearchReport(
          c.env.DB,
          scope.workspaceId!,
          c.req.valid('query'),
          scope.canManage
        ),
      });
    })
    .get('/:runId', async c => {
      const scope = await access(c);
      if (scope instanceof Response) return scope;
      const data = await competitorPreResearchDetail(
        c.env.DB,
        scope.workspaceId!,
        c.req.param('runId')
      );
      if (!data) return c.json({ error: 'Pre-research run not found' }, 404);
      return c.json({ data });
    })
    .post('/', validate('json', competitorPreResearchRunInput), async c => {
      const scope = await access(c, true);
      if (scope instanceof Response) return scope;
      const body = c.req.valid('json');
      const now = Date.now();
      const id = createId();
      const created = await c.env.DB.prepare(
        'INSERT INTO competitor_pre_research_runs (id,workspace_id,source,source_job_id,source_job_url,source_version,title,current_query,harvest_status,stage,seed_keywords,summary,source_thread_url,created_at,updated_at) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE (SELECT count(*) FROM competitor_pre_research_runs WHERE workspace_id = ?) < ? ON CONFLICT DO NOTHING RETURNING id'
      )
        .bind(
          id,
          scope.workspaceId,
          'keyword_harvester',
          keywordHarvesterJobId(body.sourceJobUrl),
          body.sourceJobUrl,
          body.sourceVersion,
          body.title,
          body.currentQuery,
          body.harvestStatus,
          'imported',
          JSON.stringify(body.seedKeywords),
          body.summary,
          body.sourceThreadUrl,
          now,
          now,
          scope.workspaceId,
          COMPETITOR_LIMITS.preResearchRuns
        )
        .first();
      if (!created)
        return c.json(
          { error: 'This harvest job already exists or the 500-run workspace limit was reached' },
          409
        );
      return c.json({ data: { id } }, 201);
    })
    .patch('/:runId/stage', validate('json', competitorPreResearchStageInput), async c => {
      const scope = await access(c, true);
      if (scope instanceof Response) return scope;
      const updated = await c.env.DB.prepare(
        'UPDATE competitor_pre_research_runs SET stage = ?, updated_at = ? WHERE id = ? AND workspace_id = ? RETURNING id'
      )
        .bind(c.req.valid('json').stage, Date.now(), c.req.param('runId'), scope.workspaceId)
        .first();
      if (!updated) return c.json({ error: 'Pre-research run not found' }, 404);
      return c.json({ data: updated });
    })
    .post('/:runId/actions', validate('json', competitorPreResearchActionInput), async c => {
      const scope = await access(c, true);
      if (scope instanceof Response) return scope;
      const runId = c.req.param('runId');
      if (!(await preResearchRunExists(c.env.DB, scope.workspaceId!, runId)))
        return c.json({ error: 'Pre-research run not found' }, 404);
      const body = c.req.valid('json');
      const id = createId();
      const created = await c.env.DB.prepare(
        'INSERT INTO competitor_pre_research_actions (id,run_id,kind,outcome,title,detail,"references",occurred_at) SELECT ?,?,?,?,?,?,?,? WHERE (SELECT count(*) FROM competitor_pre_research_actions WHERE run_id = ?) < ? RETURNING id'
      )
        .bind(
          id,
          runId,
          body.kind,
          body.outcome,
          body.title,
          body.detail,
          JSON.stringify(body.references),
          body.occurredAt ?? Date.now(),
          runId,
          COMPETITOR_LIMITS.preResearchActions
        )
        .first();
      if (!created)
        return c.json({ error: 'The 200-action limit for this pre-research run was reached' }, 409);
      await c.env.DB.prepare(
        'UPDATE competitor_pre_research_runs SET updated_at = ? WHERE id = ? AND workspace_id = ?'
      )
        .bind(Date.now(), runId, scope.workspaceId)
        .run();
      return c.json({ data: { id } }, 201);
    });
}

function researchGroupRoutes() {
  return new Hono<{ Bindings: Bindings; Variables: Variables }>()
    .get('/', async c => {
      const scope = await access(c);
      if (scope instanceof Response) return scope;
      return c.json({
        data: {
          workspaceId: scope.workspaceId,
          canManage: scope.canManage,
          groups: await competitorResearchGroups(c.env.DB, scope.workspaceId!),
          limit: COMPETITOR_LIMITS.researchGroups,
        },
      });
    })
    .post('/', validate('json', competitorResearchGroupInput), async c => {
      const scope = await access(c, true);
      if (scope instanceof Response) return scope;
      const { name, rootTerm } = c.req.valid('json');
      const id = createId();
      const created = await c.env.DB.prepare(
        'INSERT INTO competitor_research_groups (id,workspace_id,name,name_key,root_term,root_term_key,created_at) SELECT ?,?,?,?,?,?,? WHERE (SELECT count(*) FROM competitor_research_groups WHERE workspace_id = ?) < ? ON CONFLICT DO NOTHING RETURNING id'
      )
        .bind(
          id,
          scope.workspaceId,
          name,
          name.normalize('NFKC').toLowerCase(),
          rootTerm,
          rootTerm.normalize('NFKC').toLowerCase(),
          Date.now(),
          scope.workspaceId,
          COMPETITOR_LIMITS.researchGroups
        )
        .first();
      if (!created)
        return c.json({ error: 'Duplicate root-term group or 100-group limit reached' }, 409);
      return c.json({ data: { id } }, 201);
    })
    .patch('/:groupId', validate('json', competitorResearchGroupInput), async c => {
      const scope = await access(c, true);
      if (scope instanceof Response) return scope;
      const { name, rootTerm } = c.req.valid('json');
      const id = c.req.param('groupId');
      const nameKey = name.normalize('NFKC').toLowerCase();
      const rootTermKey = rootTerm.normalize('NFKC').toLowerCase();
      const result = await c.env.DB.prepare(
        'UPDATE competitor_research_groups SET name = ?, name_key = ?, root_term = ?, root_term_key = ? WHERE id = ? AND workspace_id = ? AND NOT EXISTS (SELECT 1 FROM competitor_research_groups WHERE workspace_id = ? AND root_term_key = ? AND name_key = ? AND id != ?) RETURNING id'
      )
        .bind(
          name,
          nameKey,
          rootTerm,
          rootTermKey,
          id,
          scope.workspaceId,
          scope.workspaceId,
          rootTermKey,
          nameKey,
          id
        )
        .first();
      if (!result) return c.json({ error: 'Root-term group missing or duplicate' }, 409);
      return c.json({ data: result });
    })
    .delete('/:groupId', async c => {
      const scope = await access(c, true);
      if (scope instanceof Response) return scope;
      const result = await c.env.DB.prepare(
        'DELETE FROM competitor_research_groups WHERE id = ? AND workspace_id = ? RETURNING id'
      )
        .bind(c.req.param('groupId'), scope.workspaceId)
        .first();
      if (!result) return c.json({ error: 'Root-term group not found' }, 404);
      return c.json({ data: result });
    });
}

function researchRoutes() {
  return new Hono<{ Bindings: Bindings; Variables: Variables }>()
    .route('/groups', researchGroupRoutes())
    .route('/pre-research', preResearchRoutes())
    .post('/draft', validate('json', competitorResearchDraftInput), async c => {
      const scope = await access(c, true);
      if (scope instanceof Response) return scope;
      const body = c.req.valid('json');
      let url: URL;
      try {
        url = publicPageUrl(body.homepageUrl);
      } catch (error) {
        return c.json(
          { error: error instanceof CompetitorFetchError ? error.code : 'Invalid URL' },
          400
        );
      }
      const result = await generateCompetitorResearchDraft(c.env, {
        ...body,
        homepageUrl: url.href,
      });
      if (!result.ok)
        return c.json(
          {
            error: `AI draft generation is unavailable. Configure the GLM API key, or an authorized OpenAI-compatible Terra API bridge.${providerFailureDetail(result.attempts)}`,
            attempts: result.attempts,
          },
          503
        );
      return c.json({ data: result.data });
    })
    .post('/intake', validate('json', competitorResearchIntakeInput), async c => {
      const scope = await access(c, true);
      if (scope instanceof Response) return scope;
      const body = c.req.valid('json');
      const invalidGroup = await validateResearchGroup(c, scope.workspaceId, body.primaryGroupId);
      if (invalidGroup) return invalidGroup;
      const rawUrl = pastedResearchUrl(body.rawInput);
      if (!rawUrl) return c.json({ error: 'Pasted research must include a public HTTPS URL' }, 400);
      let url: URL;
      try {
        url = publicPageUrl(rawUrl);
      } catch (error) {
        return c.json(
          { error: error instanceof CompetitorFetchError ? error.code : 'Invalid URL' },
          400
        );
      }
      const existing = await c.env.DB.prepare(
        'SELECT id FROM competitor_research_profiles WHERE workspace_id = ? AND homepage_url = ?'
      )
        .bind(scope.workspaceId, url.href)
        .first<{ id: string }>();
      if (existing)
        return c.json({
          data: {
            source: 'existing_research_profile',
            profileId: existing.id,
            existing: true,
            limitations: [
              'An existing research profile already uses this homepage URL; no model request was made and no saved data was changed.',
              'Use the explicit regeneration action to apply the current input while preserving its root-term grouping, links, sources, and notes.',
              'No competitor monitor or scheduler was created or changed.',
            ],
          },
        });
      const generated = await generateCompetitorResearchIntake(c.env, body, {
        modelPreference: body.modelPreference,
      });
      if (!generated.ok)
        return c.json(
          {
            error: researchGenerationFailureMessage(generated.attempts),
            attempts: generated.attempts,
          },
          503
        );
      const id = createId();
      const created = await c.env.DB.prepare(
        'INSERT INTO competitor_research_profiles (id,workspace_id,brand_name,homepage_url,hostname,page_title,product_summary,lifecycle_status,primary_group_id,seed_keywords,payment_providers,sources,source_thread_url,raw_input,analysis,created_at,updated_at) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE (SELECT count(*) FROM competitor_research_profiles WHERE workspace_id = ?) < ? ON CONFLICT DO NOTHING RETURNING id'
      )
        .bind(
          id,
          scope.workspaceId,
          generated.data.draft.brandName,
          url.href,
          url.hostname,
          generated.data.draft.pageTitle,
          generated.data.draft.productSummary,
          body.lifecycleStatus,
          body.primaryGroupId,
          JSON.stringify(generated.data.draft.seedKeywords),
          JSON.stringify(generated.data.draft.paymentProviders),
          JSON.stringify(researchSources(body.rawInput, url, body.researchMode)),
          body.sourceThreadUrl,
          body.rawInput,
          JSON.stringify({
            researchMode: body.researchMode,
            localCapabilityId:
              body.localCapabilityId ??
              (body.researchMode === 'codex_competitor_analysis' ? 'competitor-analysis' : null),
            workflow: generated.data.workflow,
            provider: generated.data.provider,
            model: generated.data.model,
            generatedAt: generated.data.generatedAt,
            detailedAnalysis: generated.data.draft.detailedAnalysis,
            suggestedCategories: generated.data.draft.suggestedCategories,
            evidenceGaps: generated.data.draft.evidenceGaps,
          }),
          generated.data.generatedAt,
          generated.data.generatedAt,
          scope.workspaceId,
          COMPETITOR_LIMITS.researchProfiles
        )
        .first();
      if (!created) {
        const concurrent = await c.env.DB.prepare(
          'SELECT id FROM competitor_research_profiles WHERE workspace_id = ? AND homepage_url = ?'
        )
          .bind(scope.workspaceId, url.href)
          .first<{ id: string }>();
        if (concurrent)
          return c.json({
            data: {
              source: 'existing_research_profile',
              profileId: concurrent.id,
              existing: true,
              limitations: [
                'Another request saved this homepage URL first; no existing research data was overwritten.',
                'Use the explicit regeneration action to apply the current input while preserving its root-term grouping, links, sources, and notes.',
                'No competitor monitor or scheduler was created or changed.',
              ],
            },
          });
        return c.json({ error: '500-profile workspace limit reached' }, 409);
      }
      return c.json(
        {
          data: {
            source: body.researchMode,
            profileId: id,
            provider: generated.data.provider,
            model: generated.data.model,
            savedAt: generated.data.generatedAt,
            limitations: [
              body.researchMode !== 'pasted_site_research'
                ? 'Only the Codex research text and its listed public source URLs were imported; Traks did not fetch the target website.'
                : 'Only the text pasted in this form was analyzed and saved; no target website was fetched.',
              'Suggested categories and payment evidence remain unverified until manually reviewed.',
              'No competitor monitor or scheduler was created.',
            ],
          },
        },
        201
      );
    })
    .get('/', validate('query', competitorResearchFilters), async c => {
      const scope = await access(c);
      if (scope instanceof Response) return scope;
      const filters = c.req.valid('query');
      const invalid = await validateResearchFilters(c, scope.workspaceId!, filters);
      if (invalid) return invalid;
      return c.json({
        data: await competitorResearchReport(
          c.env.DB,
          scope.workspaceId!,
          filters,
          scope.canManage
        ),
      });
    })
    .post('/', validate('json', competitorResearchInput), async c => {
      const scope = await access(c, true);
      if (scope instanceof Response) return scope;
      const body = c.req.valid('json');
      if (!body.primaryGroupId)
        return c.json({ error: 'A root-term group is required for new research profiles' }, 400);
      const invalidGroup = await validateResearchGroup(c, scope.workspaceId, body.primaryGroupId);
      if (invalidGroup) return invalidGroup;
      let url: URL;
      try {
        url = publicPageUrl(body.homepageUrl);
      } catch (error) {
        return c.json(
          { error: error instanceof CompetitorFetchError ? error.code : 'Invalid URL' },
          400
        );
      }
      const now = Date.now();
      const id = createId();
      const created = await c.env.DB.prepare(
        'INSERT INTO competitor_research_profiles (id,workspace_id,brand_name,homepage_url,hostname,page_title,product_summary,lifecycle_status,primary_group_id,seed_keywords,payment_providers,sources,source_thread_url,notes,created_at,updated_at) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE (SELECT count(*) FROM competitor_research_profiles WHERE workspace_id = ?) < ? ON CONFLICT DO NOTHING RETURNING id'
      )
        .bind(
          id,
          scope.workspaceId,
          body.brandName,
          url.href,
          url.hostname,
          body.pageTitle,
          body.productSummary,
          body.lifecycleStatus,
          body.primaryGroupId,
          JSON.stringify(body.seedKeywords),
          JSON.stringify(body.paymentProviders),
          JSON.stringify(body.sources),
          body.sourceThreadUrl,
          body.notes,
          now,
          now,
          scope.workspaceId,
          COMPETITOR_LIMITS.researchProfiles
        )
        .first();
      if (!created)
        return c.json(
          { error: 'Duplicate homepage URL or 500-profile workspace limit reached' },
          409
        );
      return c.json({ data: { id } }, 201);
    })
    .patch('/:profileId', validate('json', competitorResearchUpdate), async c => {
      const scope = await access(c, true);
      if (scope instanceof Response) return scope;
      const id = c.req.param('profileId');
      if (!(await researchProfileExists(c.env.DB, scope.workspaceId!, id)))
        return c.json({ error: 'Research profile not found' }, 404);
      const body = c.req.valid('json');
      if (body.primaryGroupId !== undefined) {
        const invalidGroup = await validateResearchGroup(c, scope.workspaceId, body.primaryGroupId);
        if (invalidGroup) return invalidGroup;
      }
      const assignments: string[] = [];
      const values: (string | number | null)[] = [];
      if (body.brandName !== undefined) {
        assignments.push('brand_name = ?');
        values.push(body.brandName);
      }
      if (body.primaryGroupId !== undefined) {
        assignments.push('primary_group_id = ?');
        values.push(body.primaryGroupId);
      }
      if (body.homepageUrl !== undefined) {
        let url: URL;
        try {
          url = publicPageUrl(body.homepageUrl);
        } catch (error) {
          return c.json(
            { error: error instanceof CompetitorFetchError ? error.code : 'Invalid URL' },
            400
          );
        }
        assignments.push('homepage_url = ?', 'hostname = ?');
        values.push(url.href, url.hostname);
      }
      const fields = [
        ['pageTitle', 'page_title'],
        ['productSummary', 'product_summary'],
        ['lifecycleStatus', 'lifecycle_status'],
        ['sourceThreadUrl', 'source_thread_url'],
        ['notes', 'notes'],
      ] as const;
      for (const [key, column] of fields) {
        if (body[key] !== undefined) {
          assignments.push(`${column} = ?`);
          values.push(body[key] as string | null);
        }
      }
      for (const [key, column] of [
        ['seedKeywords', 'seed_keywords'],
        ['paymentProviders', 'payment_providers'],
        ['sources', 'sources'],
      ] as const) {
        if (body[key] !== undefined) {
          assignments.push(`${column} = ?`);
          values.push(JSON.stringify(body[key]));
        }
      }
      if (body.rawInput !== undefined) {
        assignments.push('raw_input = ?');
        values.push(body.rawInput);
      }
      const result = await c.env.DB.prepare(
        `UPDATE competitor_research_profiles SET ${assignments.join(', ')}, updated_at = ? WHERE id = ? AND workspace_id = ? RETURNING id`
      )
        .bind(...values, Date.now(), id, scope.workspaceId)
        .first();
      if (!result)
        return c.json({ error: 'Research profile changed or duplicate homepage URL' }, 409);
      return c.json({ data: result });
    })
    .post(
      '/:profileId/regenerate',
      validate('json', competitorResearchRegenerateInput),
      async c => {
        const scope = await access(c, true);
        if (scope instanceof Response) return scope;
        const id = c.req.param('profileId');
        const body = c.req.valid('json');
        const profile = await c.env.DB.prepare(
          'SELECT raw_input AS rawInput, analysis FROM competitor_research_profiles WHERE id = ? AND workspace_id = ?'
        )
          .bind(id, scope.workspaceId)
          .first<{ rawInput: string | null; analysis: string | null }>();
        if (!profile) return c.json({ error: 'Research profile not found' }, 404);
        const rawInput = body.rawInput ?? profile.rawInput;
        if (!rawInput)
          return c.json(
            {
              error:
                'This research profile has no saved input. Add source material before regenerating.',
            },
            400
          );
        const generated = await generateCompetitorResearchIntake(
          c.env,
          {
            rawInput,
          },
          {
            modelPreference: body.modelPreference,
          }
        );
        if (!generated.ok)
          return c.json(
            {
              error: researchGenerationFailureMessage(generated.attempts),
              attempts: generated.attempts,
            },
            503
          );
        let previousAnalysis: {
          researchMode?: string;
          localCapabilityId?: string | null;
          workflow?: string;
        } = {};
        if (profile.analysis) {
          try {
            const parsed: unknown = JSON.parse(profile.analysis);
            if (parsed && typeof parsed === 'object') {
              const source = parsed as Record<string, unknown>;
              previousAnalysis = {
                ...(typeof source.researchMode === 'string'
                  ? { researchMode: source.researchMode }
                  : {}),
                ...(typeof source.localCapabilityId === 'string' ||
                source.localCapabilityId === null
                  ? { localCapabilityId: source.localCapabilityId }
                  : {}),
                ...(typeof source.workflow === 'string' ? { workflow: source.workflow } : {}),
              };
            }
          } catch {
            previousAnalysis = {};
          }
        }
        const updated = await c.env.DB.prepare(
          'UPDATE competitor_research_profiles SET brand_name = ?, page_title = ?, product_summary = ?, seed_keywords = ?, payment_providers = ?, raw_input = ?, analysis = ?, updated_at = ? WHERE id = ? AND workspace_id = ? RETURNING id'
        )
          .bind(
            generated.data.draft.brandName,
            generated.data.draft.pageTitle,
            generated.data.draft.productSummary,
            JSON.stringify(generated.data.draft.seedKeywords),
            JSON.stringify(generated.data.draft.paymentProviders),
            rawInput,
            JSON.stringify({
              ...previousAnalysis,
              workflow: generated.data.workflow,
              provider: generated.data.provider,
              model: generated.data.model,
              generatedAt: generated.data.generatedAt,
              detailedAnalysis: generated.data.draft.detailedAnalysis,
              suggestedCategories: generated.data.draft.suggestedCategories,
              evidenceGaps: generated.data.draft.evidenceGaps,
            }),
            generated.data.generatedAt,
            id,
            scope.workspaceId
          )
          .first();
        if (!updated)
          return c.json({ error: 'Research profile changed before regeneration completed' }, 409);
        return c.json({
          data: {
            id,
            provider: generated.data.provider,
            model: generated.data.model,
            regeneratedAt: generated.data.generatedAt,
            limitations: [
              'Only the saved input was analyzed; no target website, browser extension, Cookie, or Codex task was accessed.',
              'Existing root-term grouping, manual categories, linked sites, linked monitors, sources, and notes were preserved.',
              'No competitor monitor or scheduler was created or changed.',
            ],
          },
        });
      }
    )
    .delete('/:profileId', async c => {
      const scope = await access(c, true);
      if (scope instanceof Response) return scope;
      const id = c.req.param('profileId');
      const deleted = await c.env.DB.prepare(
        'DELETE FROM competitor_research_profiles WHERE id = ? AND workspace_id = ? RETURNING id'
      )
        .bind(id, scope.workspaceId)
        .first();
      if (!deleted) return c.json({ error: 'Research profile not found' }, 404);
      return c.json({
        data: {
          id,
          limitations: [
            'Only this research profile and its classification or association links were deleted.',
            'Independent competitor monitors, their history, and owned sites were preserved.',
          ],
        },
      });
    })
    .put('/:profileId/categories', validate('json', competitorResearchLinksInput), async c => {
      const scope = await access(c, true);
      if (scope instanceof Response) return scope;
      const id = c.req.param('profileId');
      if (!(await researchProfileExists(c.env.DB, scope.workspaceId!, id)))
        return c.json({ error: 'Research profile not found' }, 404);
      const { ids } = c.req.valid('json');
      if (ids.length > COMPETITOR_LIMITS.researchCategoryLinks)
        return c.json({ error: 'Too many research category links' }, 400);
      const invalid = await validateResearchLinks(c, scope.workspaceId!, 'categories', ids);
      if (invalid) return invalid;
      await replaceResearchCategoryLinks(c.env.DB, id, ids);
      return c.json({ data: { id, categoryIds: ids } });
    })
    .put('/:profileId/sites', validate('json', competitorResearchLinksInput), async c => {
      const scope = await access(c, true);
      if (scope instanceof Response) return scope;
      const id = c.req.param('profileId');
      if (!(await researchProfileExists(c.env.DB, scope.workspaceId!, id)))
        return c.json({ error: 'Research profile not found' }, 404);
      const { ids } = c.req.valid('json');
      if (ids.length > COMPETITOR_LIMITS.researchSiteLinks)
        return c.json({ error: 'Too many owned-site links' }, 400);
      const invalid = await validateResearchLinks(c, scope.workspaceId!, 'sites', ids);
      if (invalid) return invalid;
      await replaceResearchSiteLinks(c.env.DB, id, ids);
      return c.json({ data: { id, siteIds: ids } });
    })
    .put('/:profileId/monitors', validate('json', competitorResearchLinksInput), async c => {
      const scope = await access(c, true);
      if (scope instanceof Response) return scope;
      const id = c.req.param('profileId');
      if (!(await researchProfileExists(c.env.DB, scope.workspaceId!, id)))
        return c.json({ error: 'Research profile not found' }, 404);
      const { ids } = c.req.valid('json');
      if (ids.length > COMPETITOR_LIMITS.researchMonitorLinks)
        return c.json({ error: 'Too many monitor links' }, 400);
      const invalid = await validateResearchLinks(c, scope.workspaceId!, 'monitors', ids);
      if (invalid) return invalid;
      await replaceResearchMonitorLinks(c.env.DB, id, ids);
      return c.json({ data: { id, monitorIds: ids } });
    });
}

function monitorRoutes() {
  return new Hono<{ Bindings: Bindings; Variables: Variables }>()
    .get('/', validate('query', competitorFilters), async c => {
      const scope = await access(c);
      if (scope instanceof Response) return scope;
      const filters = c.req.valid('query');
      if (typeof scope.scope === 'string' && Object.keys(filters).length)
        return c.json({ error: 'Use the workspace route for filters' }, 400);
      const invalid = await validateReferences(
        c,
        scope.workspaceId,
        filters.siteId && filters.siteId !== 'unlinked' ? filters.siteId : null,
        filters.categoryId && filters.categoryId !== 'uncategorized' ? filters.categoryId : null
      );
      if (invalid) return invalid;
      return c.json({
        data: await competitorReport(
          c.env,
          typeof scope.scope === 'string' ? scope.scope : { ...scope.scope, ...filters },
          scope.canManage
        ),
      });
    })
    .post('/', validate('json', workspaceCompetitorInput), async c => {
      const scope = await access(c, true);
      if (scope instanceof Response) return scope;
      return createMonitor(c, scope, c.req.valid('json'));
    })
    .get('/:monitorId/history', async c => {
      const scope = await access(c);
      if (scope instanceof Response) return scope;
      const filter = competitorScope(scope.scope);
      const found = await c.env.DB.prepare(
        `SELECT id FROM competitor_monitors WHERE id = ? AND ${filter.sql}`
      )
        .bind(c.req.param('monitorId'), ...filter.values)
        .first();
      if (!found) return c.json({ error: 'Monitor not found' }, 404);
      return c.json({
        data: {
          source: 'public_html_observation',
          retentionPerMonitor: 60,
          checks: await competitorHistory(c.env.DB, c.req.param('monitorId')),
        },
      });
    })
    .patch('/:monitorId', validate('json', competitorUpdate), async c => {
      const scope = await access(c, true);
      if (scope instanceof Response) return scope;
      const body = c.req.valid('json');
      if (typeof scope.scope === 'string' && body.siteId !== undefined)
        return c.json({ error: 'Use the workspace route to reassign a site' }, 400);
      const filter = competitorScope(scope.scope);
      const id = c.req.param('monitorId');
      const current = await c.env.DB.prepare(
        `SELECT site_id AS siteId, category_id AS categoryId, cadence, url FROM competitor_monitors WHERE id = ? AND ${filter.sql}`
      )
        .bind(id, ...filter.values)
        .first<{
          siteId: string | null;
          categoryId: string | null;
          cadence: string;
          url: string;
        }>();
      if (!current) return c.json({ error: 'Monitor not found' }, 404);
      const siteId = body.siteId === undefined ? current.siteId : body.siteId;
      const categoryId = body.categoryId === undefined ? current.categoryId : body.categoryId;
      const invalid = await validateReferences(c, scope.workspaceId, siteId, categoryId);
      if (invalid) return invalid;
      const target = competitorScope(
        siteId ?? { workspaceId: scope.workspaceId!, siteId: 'unlinked' }
      );
      const moving = siteId !== current.siteId;
      const result = await c.env.DB.prepare(
        `UPDATE competitor_monitors SET site_id = ?, workspace_id = ?, category_id = ?, cadence = ?, next_check_at = CASE WHEN ? THEN ? ELSE next_check_at END WHERE id = ? AND ${filter.sql} AND lease_until <= ? AND site_id IS ? AND category_id IS ? AND cadence = ? AND (? = 0 OR ((SELECT count(*) FROM competitor_monitors WHERE ${target.sql} AND id != ?) < ? AND NOT EXISTS (SELECT 1 FROM competitor_monitors WHERE ${target.sql} AND url = ? AND id != ?))) AND (? IS NULL OR EXISTS (SELECT 1 FROM competitor_categories WHERE id = ? AND workspace_id = ?)) RETURNING id`
      )
        .bind(
          siteId,
          siteId ? null : scope.workspaceId,
          categoryId,
          body.cadence ?? current.cadence,
          body.cadence !== undefined ? 1 : 0,
          nextCompetitorCheck(body.cadence ?? current.cadence, Date.now()),
          id,
          ...filter.values,
          Date.now(),
          current.siteId,
          current.categoryId,
          current.cadence,
          moving ? 1 : 0,
          ...target.values,
          id,
          siteId ? COMPETITOR_LIMITS.site : COMPETITOR_LIMITS.unlinked,
          ...target.values,
          current.url,
          id,
          categoryId,
          categoryId,
          scope.workspaceId
        )
        .first();
      if (!result)
        return c.json(
          {
            error:
              'Monitor changed, check in progress, duplicate URL or destination page limit reached',
          },
          409
        );
      return c.json({ data: result });
    })
    .post('/:monitorId/check', async c => {
      const scope = await access(c, true);
      if (scope instanceof Response) return scope;
      const filter = competitorScope(scope.scope);
      const id = c.req.param('monitorId');
      const found = await c.env.DB.prepare(
        `SELECT id FROM competitor_monitors WHERE id = ? AND ${filter.sql}`
      )
        .bind(id, ...filter.values)
        .first();
      if (!found) return c.json({ error: 'Monitor not found' }, 404);
      const result = await checkCompetitor(c.env, id, scope.scope);
      if (!result)
        return c.json({ error: 'Check in progress or host cooling down (15 minutes)' }, 409);
      return c.json({ data: result });
    })
    .delete('/:monitorId', async c => {
      const scope = await access(c, true);
      if (scope instanceof Response) return scope;
      const filter = competitorScope(scope.scope);
      const removed = await c.env.DB.prepare(
        `DELETE FROM competitor_monitors WHERE id = ? AND ${filter.sql} AND lease_until <= ? RETURNING id`
      )
        .bind(c.req.param('monitorId'), ...filter.values, Date.now())
        .first();
      if (!removed) return c.json({ error: 'Monitor missing or check in progress' }, 409);
      return c.json({ data: removed });
    });
}

const categoryRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()
  .get('/', async c => {
    const scope = await access(c);
    if (scope instanceof Response) return scope;
    return c.json({
      data: {
        workspaceId: scope.workspaceId,
        canManage: scope.canManage,
        categories: await competitorCategories(c.env.DB, scope.workspaceId!),
        limit: COMPETITOR_LIMITS.categories,
      },
    });
  })
  .post('/', validate('json', competitorCategoryInput), async c => {
    const scope = await access(c, true);
    if (scope instanceof Response) return scope;
    const { name } = c.req.valid('json');
    const id = createId();
    const created = await c.env.DB.prepare(
      'INSERT INTO competitor_categories (id, workspace_id, name, name_key, created_at) SELECT ?, ?, ?, ?, ? WHERE (SELECT count(*) FROM competitor_categories WHERE workspace_id = ?) < ? ON CONFLICT DO NOTHING RETURNING id'
    )
      .bind(
        id,
        scope.workspaceId,
        name,
        name.normalize('NFKC').toLowerCase(),
        Date.now(),
        scope.workspaceId,
        COMPETITOR_LIMITS.categories
      )
      .first();
    if (!created)
      return c.json({ error: 'Duplicate category name or 30-category limit reached' }, 409);
    return c.json({ data: { id } }, 201);
  })
  .patch('/:categoryId', validate('json', competitorCategoryInput), async c => {
    const scope = await access(c, true);
    if (scope instanceof Response) return scope;
    const { name } = c.req.valid('json');
    const id = c.req.param('categoryId');
    const nameKey = name.normalize('NFKC').toLowerCase();
    const result = await c.env.DB.prepare(
      'UPDATE competitor_categories SET name = ?, name_key = ? WHERE id = ? AND workspace_id = ? AND NOT EXISTS (SELECT 1 FROM competitor_categories WHERE workspace_id = ? AND name_key = ? AND id != ?) RETURNING id'
    )
      .bind(name, nameKey, id, scope.workspaceId, scope.workspaceId, nameKey, id)
      .first();
    if (!result) return c.json({ error: 'Category missing or duplicate name' }, 409);
    return c.json({ data: result });
  })
  .delete('/:categoryId', async c => {
    const scope = await access(c, true);
    if (scope instanceof Response) return scope;
    const result = await c.env.DB.prepare(
      'DELETE FROM competitor_categories WHERE id = ? AND workspace_id = ? RETURNING id'
    )
      .bind(c.req.param('categoryId'), scope.workspaceId)
      .first();
    if (!result) return c.json({ error: 'Category not found' }, 404);
    return c.json({ data: result });
  });

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
app.onError((error, c) => {
  if (error instanceof HTTPException && error.status === 400)
    return c.json({ error: 'Invalid request body' }, 400);
  const message = error instanceof Error ? error.message : '';
  const code =
    error instanceof CompetitorFetchError
      ? error.code
      : /D1|SQLITE|database/i.test(message)
        ? 'storage_failure'
        : /JSON|parse/i.test(message)
          ? 'response_parse_failure'
          : 'unexpected_failure';
  console.error(
    JSON.stringify({
      event: 'competitor_request_failed',
      path: c.req.path,
      code,
      errorName: error instanceof Error ? error.name : 'UnknownError',
      errorMessage: message.slice(0, 180),
    })
  );
  return c.json({ error: `Competitor request failed (${code})` }, 500);
});
app.use('*', requireAuth);
app.use('*', async (c, next) => {
  const maxSize = c.req.path.includes('/research/intake')
    ? 16 * 1024
    : c.req.path.includes('/research/pre-research') || c.req.path.includes('/research/draft')
      ? 12 * 1024
      : 2048;
  await bodyLimit({ maxSize, onError: c => c.json({ error: 'Request too large' }, 413) })(c, next);
});
app.use('*', async (c, next) => {
  c.header('Cache-Control', 'private, no-store');
  if (
    c.req.method !== 'GET' &&
    c.req.header('origin') &&
    c.req.header('origin') !== new URL(c.req.url).origin
  )
    return c.json({ error: 'Origin not allowed' }, 403);
  if (c.req.raw.body) {
    try {
      await c.req.text();
    } catch (error) {
      return c.json(
        { error: 'Invalid or oversized request body' },
        error instanceof Error && error.name === 'BodyLimitError' ? 413 : 400
      );
    }
  }
  await next();
});

export const competitorsRoute = app
  .get('/workspaces', async c => {
    const tokenWorkspace = c.get('tokenWorkspaceId');
    const rows = await c.env.DB.prepare(
      `SELECT workspaces.id, workspaces.name, workspace_members.role FROM workspaces INNER JOIN workspace_members ON workspace_members.workspace_id = workspaces.id WHERE workspace_members.user_id = ? ${tokenWorkspace ? 'AND workspaces.id = ?' : ''} ORDER BY workspaces.id`
    )
      .bind(c.get('userId')!, ...(tokenWorkspace ? [tokenWorkspace] : []))
      .all();
    return c.json({ data: rows.results });
  })
  .route('/workspaces/:workspaceId/categories', categoryRoutes)
  .route('/workspaces/:workspaceId/research', researchRoutes())
  .route('/workspaces/:workspaceId', monitorRoutes())
  .route('/:siteId', monitorRoutes());
