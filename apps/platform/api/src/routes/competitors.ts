import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { createId } from '@paralleldrive/cuid2';
import { competitorInput, competitorCadence } from '@traks/shared';
import type { Bindings, Variables } from '../types';
import { requireAuth } from '../middleware/auth';
import { getSiteAccess } from '../lib/workspaces';
import { roleAllows } from '../lib/permissions';
import { validate } from '../lib/validate';
import { publicPageUrl, CompetitorFetchError } from '../lib/competitor-fetch';
import {
  checkCompetitor,
  competitorHistory,
  competitorReport,
  nextCompetitorCheck,
} from '../lib/competitors';

type Ctx = Context<{ Bindings: Bindings; Variables: Variables }>;
async function access(c: Ctx, write = false) {
  const result = await getSiteAccess(
    c.get('db')!,
    c.get('userId')!,
    c.req.param('siteId') ?? '',
    c.get('tokenWorkspaceId')
  );
  if (!result) return c.json({ error: 'Site not found' }, 404);
  if (write && !roleAllows(result.role, { site: ['configure'] }))
    return c.json({ error: 'Only workspace owners can configure or check competitors' }, 403);
  return result;
}

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
  .get('/:siteId', async c => {
    const scope = await access(c);
    if (scope instanceof Response) return scope;
    return c.json({
      data: await competitorReport(
        c.env,
        scope.site.id,
        c.get('tokenScope') !== 'read' && roleAllows(scope.role, { site: ['configure'] })
      ),
    });
  })
  .post('/:siteId', validate('json', competitorInput), async c => {
    const scope = await access(c, true);
    if (scope instanceof Response) return scope;
    const body = c.req.valid('json');
    let url: URL;
    try {
      url = publicPageUrl(body.url);
    } catch (error) {
      return c.json(
        { error: error instanceof CompetitorFetchError ? error.code : 'Invalid URL' },
        400
      );
    }
    const now = Date.now();
    const id = createId();
    const created = await c.env.DB.prepare(
      'INSERT INTO competitor_monitors (id, site_id, name, url, hostname, selector, cadence, created_at, next_check_at) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE (SELECT count(*) FROM competitor_monitors WHERE site_id = ?) < 20 ON CONFLICT(site_id, url) DO NOTHING RETURNING id'
    )
      .bind(
        id,
        scope.site.id,
        body.name,
        url.href,
        url.hostname,
        body.selector,
        body.cadence,
        now,
        body.cadence === 'manual' ? null : now,
        scope.site.id
      )
      .first();
    if (!created) return c.json({ error: 'Duplicate URL or 20-page site limit reached' }, 409);
    return c.json({ data: { id } }, 201);
  })
  .get('/:siteId/:monitorId/history', async c => {
    const scope = await access(c);
    if (scope instanceof Response) return scope;
    const monitor = await c.env.DB.prepare(
      'SELECT id FROM competitor_monitors WHERE id = ? AND site_id = ?'
    )
      .bind(c.req.param('monitorId'), scope.site.id)
      .first();
    if (!monitor) return c.json({ error: 'Monitor not found' }, 404);
    return c.json({
      data: {
        source: 'public_html_observation',
        retentionPerMonitor: 60,
        checks: await competitorHistory(c.env.DB, c.req.param('monitorId')),
      },
    });
  })
  .patch(
    '/:siteId/:monitorId',
    validate('json', z.object({ cadence: competitorCadence }).strict()),
    async c => {
      const scope = await access(c, true);
      if (scope instanceof Response) return scope;
      const cadence = c.req.valid('json').cadence;
      const result = await c.env.DB.prepare(
        'UPDATE competitor_monitors SET cadence = ?, next_check_at = ? WHERE id = ? AND site_id = ? AND lease_until <= ? RETURNING id'
      )
        .bind(
          cadence,
          nextCompetitorCheck(cadence, Date.now()),
          c.req.param('monitorId'),
          scope.site.id,
          Date.now()
        )
        .first();
      if (!result) return c.json({ error: 'Monitor missing or check in progress' }, 409);
      return c.json({ data: result });
    }
  )
  .post('/:siteId/:monitorId/check', async c => {
    const scope = await access(c, true);
    if (scope instanceof Response) return scope;
    const row = await c.env.DB.prepare(
      'SELECT id FROM competitor_monitors WHERE id = ? AND site_id = ?'
    )
      .bind(c.req.param('monitorId'), scope.site.id)
      .first();
    if (!row) return c.json({ error: 'Monitor not found' }, 404);
    const result = await checkCompetitor(c.env, c.req.param('monitorId'), scope.site.id);
    if (!result)
      return c.json({ error: 'Check in progress or host cooling down (15 minutes)' }, 409);
    return c.json({ data: result });
  })
  .delete('/:siteId/:monitorId', async c => {
    const scope = await access(c, true);
    if (scope instanceof Response) return scope;
    const removed = await c.env.DB.prepare(
      'DELETE FROM competitor_monitors WHERE id = ? AND site_id = ? AND lease_until <= ? RETURNING id'
    )
      .bind(c.req.param('monitorId'), scope.site.id, Date.now())
      .first();
    if (!removed) return c.json({ error: 'Monitor missing or check in progress' }, 409);
    return c.json({ data: removed });
  });
