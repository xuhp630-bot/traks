import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { HTTPException } from 'hono/http-exception';
import { createId } from '@paralleldrive/cuid2';
import {
  workspaceCompetitorInput,
  competitorCategoryInput,
  competitorFilters,
  competitorUpdate,
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
  console.error('competitor_request_failed');
  return c.json({ error: 'Unable to read or update competitor data' }, 500);
});
app.use('*', requireAuth);
app.use(
  '*',
  bodyLimit({ maxSize: 2048, onError: c => c.json({ error: 'Request too large' }, 413) })
);
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
  .route('/workspaces/:workspaceId', monitorRoutes())
  .route('/:siteId', monitorRoutes());
