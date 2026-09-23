import type {
  CompetitorResearchFilters,
  CompetitorResearchProfile,
  CompetitorResearchReport,
  CompetitorResearchSource,
  CompetitorResearchPayment,
} from '@traks/shared';
import { COMPETITOR_LIMITS } from '@traks/shared';

type StoredProfile = Omit<
  CompetitorResearchProfile,
  'seedKeywords' | 'paymentProviders' | 'sources' | 'categories' | 'sites' | 'monitors'
> & {
  seedKeywords: string;
  paymentProviders: string;
  sources: string;
};

const PROFILE_COLUMNS =
  'id, workspace_id AS workspaceId, brand_name AS brandName, homepage_url AS homepageUrl, hostname, page_title AS pageTitle, product_summary AS productSummary, lifecycle_status AS lifecycleStatus, seed_keywords AS seedKeywords, payment_providers AS paymentProviders, sources, source_thread_url AS sourceThreadUrl, notes, created_at AS createdAt, updated_at AS updatedAt';

function json<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export async function researchProfileExists(
  db: D1Database,
  workspaceId: string,
  profileId: string
): Promise<boolean> {
  return Boolean(
    await db
      .prepare('SELECT id FROM competitor_research_profiles WHERE id = ? AND workspace_id = ?')
      .bind(profileId, workspaceId)
      .first()
  );
}

export async function replaceResearchCategoryLinks(
  db: D1Database,
  profileId: string,
  categoryIds: string[]
): Promise<void> {
  await db.batch([
    db.prepare('DELETE FROM competitor_research_category_links WHERE profile_id = ?').bind(profileId),
    ...categoryIds.map(categoryId =>
      db
        .prepare('INSERT INTO competitor_research_category_links (profile_id, category_id) VALUES (?, ?)')
        .bind(profileId, categoryId)
    ),
  ]);
}

export async function replaceResearchSiteLinks(
  db: D1Database,
  profileId: string,
  siteIds: string[]
): Promise<void> {
  await db.batch([
    db.prepare('DELETE FROM competitor_research_site_links WHERE profile_id = ?').bind(profileId),
    ...siteIds.map(siteId =>
      db
        .prepare('INSERT INTO competitor_research_site_links (profile_id, site_id) VALUES (?, ?)')
        .bind(profileId, siteId)
    ),
  ]);
}

export async function replaceResearchMonitorLinks(
  db: D1Database,
  profileId: string,
  monitorIds: string[]
): Promise<void> {
  await db.batch([
    db.prepare('DELETE FROM competitor_research_monitor_links WHERE profile_id = ?').bind(profileId),
    ...monitorIds.map(monitorId =>
      db
        .prepare('INSERT INTO competitor_research_monitor_links (profile_id, monitor_id) VALUES (?, ?)')
        .bind(profileId, monitorId)
    ),
  ]);
}

export async function competitorResearchReport(
  db: D1Database,
  workspaceId: string,
  filters: CompetitorResearchFilters,
  canManage: boolean
): Promise<CompetitorResearchReport> {
  const clauses = ['profile.workspace_id = ?'];
  const values: string[] = [workspaceId];
  if (filters.lifecycleStatus) {
    clauses.push('profile.lifecycle_status = ?');
    values.push(filters.lifecycleStatus);
  }
  if (filters.categoryId) {
    clauses.push(
      'EXISTS (SELECT 1 FROM competitor_research_category_links AS link WHERE link.profile_id = profile.id AND link.category_id = ?)'
    );
    values.push(filters.categoryId);
  }
  if (filters.siteId) {
    clauses.push(
      'EXISTS (SELECT 1 FROM competitor_research_site_links AS link WHERE link.profile_id = profile.id AND link.site_id = ?)'
    );
    values.push(filters.siteId);
  }
  if (filters.monitorId) {
    clauses.push(
      'EXISTS (SELECT 1 FROM competitor_research_monitor_links AS link WHERE link.profile_id = profile.id AND link.monitor_id = ?)'
    );
    values.push(filters.monitorId);
  }
  const rows = await db
    .prepare(
      `SELECT ${PROFILE_COLUMNS} FROM competitor_research_profiles AS profile WHERE ${clauses.join(' AND ')} ORDER BY CASE lifecycle_status WHEN 'focus' THEN 0 WHEN 'watch' THEN 1 WHEN 'inbox' THEN 2 WHEN 'parked' THEN 3 ELSE 4 END, updated_at DESC, id DESC`
    )
    .bind(...values)
    .all<StoredProfile>();
  const profileIds = rows.results.map(profile => profile.id);
  const categories = new Map<string, CompetitorResearchProfile['categories']>();
  const sites = new Map<string, CompetitorResearchProfile['sites']>();
  const monitors = new Map<string, CompetitorResearchProfile['monitors']>();
  if (profileIds.length) {
    const placeholders = profileIds.map(() => '?').join(',');
    const [categoryRows, siteRows, monitorRows] = await Promise.all([
      db
        .prepare(
          `SELECT link.profile_id AS profileId, category.id, category.name FROM competitor_research_category_links AS link INNER JOIN competitor_categories AS category ON category.id = link.category_id WHERE link.profile_id IN (${placeholders}) ORDER BY category.name_key, category.id`
        )
        .bind(...profileIds)
        .all<{ profileId: string; id: string; name: string }>(),
      db
        .prepare(
          `SELECT link.profile_id AS profileId, site.id, site.name, site.domain FROM competitor_research_site_links AS link INNER JOIN sites AS site ON site.id = link.site_id WHERE link.profile_id IN (${placeholders}) ORDER BY site.name, site.id`
        )
        .bind(...profileIds)
        .all<{ profileId: string; id: string; name: string; domain: string }>(),
      db
        .prepare(
          `SELECT link.profile_id AS profileId, monitor.id, monitor.name, monitor.url FROM competitor_research_monitor_links AS link INNER JOIN competitor_monitors AS monitor ON monitor.id = link.monitor_id WHERE link.profile_id IN (${placeholders}) ORDER BY monitor.name, monitor.id`
        )
        .bind(...profileIds)
        .all<{ profileId: string; id: string; name: string; url: string }>(),
    ]);
    for (const row of categoryRows.results) {
      const linked = categories.get(row.profileId) ?? [];
      linked.push({ id: row.id, name: row.name });
      categories.set(row.profileId, linked);
    }
    for (const row of siteRows.results) {
      const linked = sites.get(row.profileId) ?? [];
      linked.push({ id: row.id, name: row.name, domain: row.domain });
      sites.set(row.profileId, linked);
    }
    for (const row of monitorRows.results) {
      const linked = monitors.get(row.profileId) ?? [];
      linked.push({ id: row.id, name: row.name, url: row.url });
      monitors.set(row.profileId, linked);
    }
  }
  return {
    source: 'manual_research_library',
    generatedAt: Date.now(),
    canManage,
    scope: { workspaceId, ...filters },
    limits: {
      researchProfiles: COMPETITOR_LIMITS.researchProfiles,
      researchCategoryLinks: COMPETITOR_LIMITS.researchCategoryLinks,
      researchSiteLinks: COMPETITOR_LIMITS.researchSiteLinks,
      researchMonitorLinks: COMPETITOR_LIMITS.researchMonitorLinks,
    },
    profiles: rows.results.map(profile => ({
      ...profile,
      seedKeywords: json<string[]>(profile.seedKeywords, []),
      paymentProviders: json<CompetitorResearchPayment[]>(profile.paymentProviders, []),
      sources: json<CompetitorResearchSource[]>(profile.sources, []),
      categories: categories.get(profile.id) ?? [],
      sites: sites.get(profile.id) ?? [],
      monitors: monitors.get(profile.id) ?? [],
    })),
    limitations: [
      'Only user-entered structured research and linked public-page records are stored.',
      'No full-page HTML, checkout payload, credentials, competitor traffic or customer data is collected.',
      'A linked monitor remains manual until an owner explicitly changes its cadence and approves its host.',
    ],
  };
}
