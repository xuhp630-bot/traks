import {
  sqliteTable,
  text,
  integer,
  uniqueIndex,
  index,
  check,
  primaryKey,
} from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
import { createId } from '@paralleldrive/cuid2';
import type { FunnelStep, SegmentFilters } from '@traks/shared';

// ============ Users (owned by Better Auth; app fields alongside) ============
export const users = sqliteTable(
  'users',
  {
    id: text('id').primaryKey(),
    email: text('email').notNull(),
    emailVerified: integer('email_verified', { mode: 'boolean' }).default(false).notNull(),
    name: text('name'),
    imageUrl: text('image_url'),
    plan: text('plan').$type<'free' | 'pro' | 'business'>().default('free').notNull(),
    siteLimit: integer('site_limit').default(5).notNull(),
    /** True only for the user who claimed the instance. Members lose their
     *  account when they lose their last workspace; the owner never does. */
    isInstanceOwner: integer('is_instance_owner', { mode: 'boolean' }).default(false).notNull(),
    // Dodo Payments linkage
    dodoCustomerId: text('dodo_customer_id'),
    dodoSubscriptionId: text('dodo_subscription_id'),
    createdAt: integer('created_at', { mode: 'timestamp' }).$defaultFn(() => new Date()),
    updatedAt: integer('updated_at', { mode: 'timestamp' }).$defaultFn(() => new Date()),
  },
  table => [uniqueIndex('users_email_idx').on(table.email)]
);

// ============ Auth (Better Auth core tables) ============
export const sessions = sqliteTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    token: text('token').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    /** Better Auth organization plugin session field. */
    activeOrganizationId: text('active_organization_id'),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
  },
  table => [
    uniqueIndex('sessions_token_idx').on(table.token),
    index('sessions_user_id_idx').on(table.userId),
  ]
);

export const accounts = sqliteTable(
  'accounts',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: integer('access_token_expires_at', { mode: 'timestamp' }),
    refreshTokenExpiresAt: integer('refresh_token_expires_at', { mode: 'timestamp' }),
    scope: text('scope'),
    password: text('password'),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
  },
  table => [index('accounts_user_id_idx').on(table.userId)]
);

export const verifications = sqliteTable('verifications', {
  id: text('id').primaryKey(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }),
  updatedAt: integer('updated_at', { mode: 'timestamp' }),
});

// ============ Workspaces (a workspace groups sites; members join per-workspace) ============
// Storage for Better Auth's organization plugin (model "organization" is
// mapped onto this table in lib/auth.ts) - slug/logo/metadata are its fields.
export const workspaces = sqliteTable(
  'workspaces',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => createId()),
    name: text('name').notNull(),
    slug: text('slug').notNull().default(''),
    logo: text('logo'),
    metadata: text('metadata'),
    createdAt: integer('created_at', { mode: 'timestamp' }).$defaultFn(() => new Date()),
    updatedAt: integer('updated_at', { mode: 'timestamp' }).$defaultFn(() => new Date()),
  },
  table => [uniqueIndex('workspaces_slug_idx').on(table.slug)]
);

export const workspaceMembers = sqliteTable(
  'workspace_members',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => createId()),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role').$type<'owner' | 'member'>().notNull().default('member'),
    createdAt: integer('created_at', { mode: 'timestamp' }).$defaultFn(() => new Date()),
  },
  table => [
    uniqueIndex('workspace_members_ws_user_idx').on(table.workspaceId, table.userId),
    index('workspace_members_user_id_idx').on(table.userId),
  ]
);

// ============ Workspace invitations (org plugin model "invitation") ============
// Link-based delivery (instances cannot send email): the row id doubles as
// the invite-URL token, generated by Better Auth. Always email-pinned.
export const workspaceInvitations = sqliteTable(
  'workspace_invitations',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    role: text('role').notNull().default('member'),
    status: text('status')
      .$type<'pending' | 'accepted' | 'canceled' | 'rejected'>()
      .notNull()
      .default('pending'),
    invitedBy: text('invited_by')
      .notNull()
      .references(() => users.id),
    expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
    createdAt: integer('created_at', { mode: 'timestamp' }).$defaultFn(() => new Date()),
  },
  table => [index('workspace_invitations_workspace_id_idx').on(table.workspaceId)]
);

// ============ Sites ============
export const sites = sqliteTable(
  'sites',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => createId()),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    /** Nullable during rollout (expand-contract); app code backfills into the
     *  creator's default workspace and treats membership as the access rule. */
    workspaceId: text('workspace_id').references(() => workspaces.id),
    name: text('name').notNull(),
    domain: text('domain').notNull(),
    /** Site favicon as a data URL, fetched server-side on create/domain
     *  change (never from the browser - no third-party favicon services). */
    favicon: text('favicon'),
    timezone: text('timezone').default('UTC').notNull(),
    public: integer('public', { mode: 'boolean' }).default(false).notNull(),
    createdAt: integer('created_at', { mode: 'timestamp' }).$defaultFn(() => new Date()),
    updatedAt: integer('updated_at', { mode: 'timestamp' }).$defaultFn(() => new Date()),
  },
  table => [
    index('sites_user_id_idx').on(table.userId),
    index('sites_workspace_id_idx').on(table.workspaceId),
    uniqueIndex('sites_domain_idx').on(table.domain),
  ]
);

// ============ API Keys ============
export const apiKeys = sqliteTable(
  'api_keys',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => createId()),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    name: text('name').notNull().default('Default'),
    key: text('key').notNull(), // "pb_live_xxxx"
    lastUsedAt: integer('last_used_at', { mode: 'timestamp' }),
    createdAt: integer('created_at', { mode: 'timestamp' }).$defaultFn(() => new Date()),
    revokedAt: integer('revoked_at', { mode: 'timestamp' }),
  },
  table => [
    uniqueIndex('api_keys_key_idx').on(table.key),
    index('api_keys_site_id_idx').on(table.siteId),
    index('api_keys_user_id_idx').on(table.userId),
  ]
);

// ============ Personal API tokens (MCP / management API) ============
export const apiTokens = sqliteTable(
  'api_tokens',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => createId()),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** The single workspace this token can reach. Tokens never span the
     *  owner's other workspaces - mint one per workspace instead. */
    workspaceId: text('workspace_id').references(() => workspaces.id, { onDelete: 'cascade' }),
    /** SHA-256 hex of the secret - the secret itself is shown exactly once. */
    tokenHash: text('token_hash').notNull(),
    /** Last 4 characters of the secret, for display in the token list. */
    suffix: text('suffix').notNull(),
    /** 'read' = stats only (GET); 'manage' = also create/update/delete config. */
    scope: text('scope').$type<'read' | 'manage'>().default('manage').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp' }).$defaultFn(() => new Date()),
    lastUsedAt: integer('last_used_at', { mode: 'timestamp' }),
  },
  table => [
    uniqueIndex('api_tokens_hash_idx').on(table.tokenHash),
    index('api_tokens_user_id_idx').on(table.userId),
  ]
);

// ============ Goals (conversion targets: a custom event name or a pathname) ============
export const goals = sqliteTable(
  'goals',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => createId()),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    type: text('type').$type<'event' | 'page'>().notNull(),
    /** event_name for 'event' goals, pathname for 'page' goals (a trailing
     *  '/*' makes it a section prefix). */
    target: text('target').notNull(),
    /** Optional event-prop exact-match condition (both set or both null). */
    propKey: text('prop_key'),
    propValue: text('prop_value'),
    createdAt: integer('created_at', { mode: 'timestamp' }).$defaultFn(() => new Date()),
  },
  table => [index('goals_site_id_idx').on(table.siteId)]
);

// ============ Segments (named saved filter sets) ============
export const segments = sqliteTable(
  'segments',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => createId()),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** Filter dimensions to apply together, validated by createSegmentSchema. */
    filters: text('filters', { mode: 'json' }).$type<SegmentFilters>().notNull(),
    createdAt: integer('created_at', { mode: 'timestamp' }).$defaultFn(() => new Date()),
  },
  table => [index('segments_site_id_idx').on(table.siteId)]
);

// ============ Funnels (ordered conversion steps over pages/events) ============
export const funnels = sqliteTable(
  'funnels',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => createId()),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** Ordered steps (2-8), validated by createFunnelSchema at the API edge. */
    steps: text('steps', { mode: 'json' }).$type<FunnelStep[]>().notNull(),
    createdAt: integer('created_at', { mode: 'timestamp' }).$defaultFn(() => new Date()),
  },
  table => [index('funnels_site_id_idx').on(table.siteId)]
);

// ============ Event catalogs (tracking plan: expected custom events) ============
export const eventCatalogs = sqliteTable(
  'event_catalogs',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => createId()),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    eventName: text('event_name').notNull(),
    category: text('category').notNull(),
    description: text('description'),
    sourcePath: text('source_path'),
    aliases: text('aliases', { mode: 'json' }).$type<string[]>().notNull().default([]),
    /** Tracking-wave metadata supplied by the site's generated catalog. */
    wave: text('wave'),
    /** Position in the monitored visitor journey (arrival, discovery, ...). */
    journeyStage: text('journey_stage'),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .$defaultFn(() => new Date())
      .notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp' })
      .$defaultFn(() => new Date())
      .notNull(),
  },
  table => [
    uniqueIndex('event_catalogs_site_event_idx').on(table.siteId, table.eventName),
    index('event_catalogs_site_id_idx').on(table.siteId),
  ]
);

export const competitorCategories = sqliteTable(
  'competitor_categories',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    nameKey: text('name_key').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  table => [uniqueIndex('competitor_category_name_idx').on(table.workspaceId, table.nameKey)]
);

export const competitorResearchProfiles = sqliteTable(
  'competitor_research_profiles',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    brandName: text('brand_name').notNull(),
    homepageUrl: text('homepage_url').notNull(),
    hostname: text('hostname').notNull(),
    pageTitle: text('page_title'),
    productSummary: text('product_summary'),
    lifecycleStatus: text('lifecycle_status').notNull().default('inbox'),
    seedKeywords: text('seed_keywords').notNull().default('[]'),
    paymentProviders: text('payment_providers').notNull().default('[]'),
    sources: text('sources').notNull().default('[]'),
    sourceThreadUrl: text('source_thread_url'),
    notes: text('notes'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  table => [
    uniqueIndex('competitor_research_workspace_url_idx').on(table.workspaceId, table.homepageUrl),
    index('competitor_research_workspace_status_idx').on(table.workspaceId, table.lifecycleStatus),
    index('competitor_research_hostname_idx').on(table.hostname),
  ]
);

export const competitorResearchCategoryLinks = sqliteTable(
  'competitor_research_category_links',
  {
    profileId: text('profile_id')
      .notNull()
      .references(() => competitorResearchProfiles.id, { onDelete: 'cascade' }),
    categoryId: text('category_id')
      .notNull()
      .references(() => competitorCategories.id, { onDelete: 'cascade' }),
  },
  table => [
    primaryKey({ columns: [table.profileId, table.categoryId] }),
    index('competitor_research_category_profile_idx').on(table.categoryId, table.profileId),
  ]
);

export const competitorResearchSiteLinks = sqliteTable(
  'competitor_research_site_links',
  {
    profileId: text('profile_id')
      .notNull()
      .references(() => competitorResearchProfiles.id, { onDelete: 'cascade' }),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
  },
  table => [
    primaryKey({ columns: [table.profileId, table.siteId] }),
    index('competitor_research_site_profile_idx').on(table.siteId, table.profileId),
  ]
);

export const competitorPreResearchRuns = sqliteTable(
  'competitor_pre_research_runs',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    source: text('source').notNull().default('keyword_harvester'),
    sourceJobId: text('source_job_id').notNull(),
    sourceJobUrl: text('source_job_url').notNull(),
    sourceVersion: text('source_version').notNull(),
    title: text('title').notNull(),
    currentQuery: text('current_query'),
    harvestStatus: text('harvest_status').notNull().default('unknown'),
    stage: text('stage').notNull().default('imported'),
    seedKeywords: text('seed_keywords').notNull().default('[]'),
    summary: text('summary'),
    sourceThreadUrl: text('source_thread_url'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  table => [
    uniqueIndex('competitor_pre_research_workspace_job_idx').on(
      table.workspaceId,
      table.sourceJobId
    ),
    index('competitor_pre_research_workspace_stage_idx').on(
      table.workspaceId,
      table.stage,
      table.updatedAt
    ),
  ]
);

export const competitorPreResearchActions = sqliteTable(
  'competitor_pre_research_actions',
  {
    id: text('id').primaryKey(),
    runId: text('run_id')
      .notNull()
      .references(() => competitorPreResearchRuns.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    outcome: text('outcome').notNull(),
    title: text('title').notNull(),
    detail: text('detail'),
    references: text('references').notNull().default('[]'),
    occurredAt: integer('occurred_at').notNull(),
  },
  table => [index('competitor_pre_research_action_run_time_idx').on(table.runId, table.occurredAt)]
);

export const competitorMonitors = sqliteTable(
  'competitor_monitors',
  {
    id: text('id').primaryKey(),
    siteId: text('site_id').references(() => sites.id, { onDelete: 'cascade' }),
    workspaceId: text('workspace_id').references(() => workspaces.id, { onDelete: 'cascade' }),
    categoryId: text('category_id').references(() => competitorCategories.id, {
      onDelete: 'set null',
    }),
    name: text('name').notNull(),
    url: text('url').notNull(),
    hostname: text('hostname').notNull(),
    selector: text('selector').notNull(),
    cadence: text('cadence').notNull().default('manual'),
    createdAt: integer('created_at').notNull(),
    nextCheckAt: integer('next_check_at'),
    lastCheckedAt: integer('last_checked_at'),
    lastSuccessAt: integer('last_success_at'),
    lastSuccessSnapshot: text('last_success_snapshot'),
    leaseUntil: integer('lease_until').notNull().default(0),
  },
  table => [
    check(
      'competitor_owner_check',
      sql`(${table.siteId} IS NOT NULL AND ${table.workspaceId} IS NULL) OR (${table.siteId} IS NULL AND ${table.workspaceId} IS NOT NULL)`
    ),
    uniqueIndex('competitor_site_url_idx').on(table.siteId, table.url),
    uniqueIndex('competitor_workspace_url_idx').on(table.workspaceId, table.url),
    index('competitor_category_idx').on(table.categoryId),
    index('competitor_due_idx').on(table.nextCheckAt),
    index('competitor_host_check_idx').on(table.hostname, table.lastCheckedAt),
  ]
);

export const competitorResearchMonitorLinks = sqliteTable(
  'competitor_research_monitor_links',
  {
    profileId: text('profile_id')
      .notNull()
      .references(() => competitorResearchProfiles.id, { onDelete: 'cascade' }),
    monitorId: text('monitor_id')
      .notNull()
      .references(() => competitorMonitors.id, { onDelete: 'cascade' }),
  },
  table => [
    primaryKey({ columns: [table.profileId, table.monitorId] }),
    uniqueIndex('competitor_research_monitor_once_idx').on(table.monitorId),
  ]
);

export const competitorSnapshots = sqliteTable(
  'competitor_snapshots',
  {
    id: text('id').primaryKey(),
    monitorId: text('monitor_id')
      .notNull()
      .references(() => competitorMonitors.id, { onDelete: 'cascade' }),
    checkedAt: integer('checked_at').notNull(),
    status: text('status').notNull(),
    errorCode: text('error_code'),
    httpStatus: integer('http_status'),
    snapshot: text('snapshot'),
    previous: text('previous'),
    previousCheckedAt: integer('previous_checked_at'),
    changes: text('changes').notNull(),
  },
  table => [index('competitor_snapshot_monitor_time_idx').on(table.monitorId, table.checkedAt)]
);
