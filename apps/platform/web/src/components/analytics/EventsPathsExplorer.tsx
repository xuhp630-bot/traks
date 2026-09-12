import { useMemo, useState, type ReactElement } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  AlertCircle,
  BarChart3,
  ChevronRight,
  Clock,
  FileText,
  Layers,
  MapPin,
  MousePointer2,
  RefreshCw,
  Search,
  Sparkles,
} from 'lucide-react';
import type { Period } from '@traks/shared';
import { CheckCircle2, CircleDashed, ListFilter, Route, TriangleAlert } from 'lucide-react';
import { cn, formatNumber } from '@/lib/utils';
import { Input } from '@/components/ui/input';
import { api, type AnalyticsFilters } from '@/lib/api';

interface EventRow {
  name: string;
  count: number;
  totalValue: number;
}

interface EventCatalogItem {
  id?: string;
  eventName: string;
  category: string;
  description?: string | null;
  sourcePath?: string | null;
  aliases: string[];
  wave?: string | null;
  journeyStage?: string | null;
  createdAt?: number | string | null;
  updatedAt?: number | string | null;
}

type EventCoverage = 'received' | 'missing' | 'uncataloged';

interface EventDisplayRow {
  key: string;
  name: string;
  category: string;
  status: EventCoverage;
  count: number;
  totalValue: number;
  receivedAs: string[];
  aliases: string[];
  description: string;
  sourcePath: string;
  wave: string;
  journeyStage: string;
}

interface EventPageRow {
  name: string;
  pathname: string;
  count: number;
  totalValue: number;
}

interface EventPropRow {
  key: string;
  value: string;
  events: number;
}

interface SessionSummary {
  sessionId: string;
  visitorId: string;
  startedAt: number;
  lastAt: number;
  pageviews: number;
  events: number;
  entryPath: string;
  exitPath: string;
  country: string;
  city: string;
  browser: string;
  os: string;
  deviceType: string;
  referrerHostname: string;
  utmSource: string;
  utmMedium: string;
  utmCampaign: string;
}

interface JourneyStep {
  ts: number;
  eventType: 'pageview' | 'event';
  pathname: string;
  eventName: string;
  eventMeta: string;
  eventValue: number;
  country: string;
  city: string;
  browser: string;
  os: string;
  deviceType: string;
}

interface PathFlowRow {
  kind: 'entry' | 'transition' | 'sequence';
  fromPath: string;
  toPath: string;
  thirdPath: string;
  sessions: number;
}

type ExplorerView = 'events' | 'paths';

const GRANULAR_ENGAGEMENT_WAVE = 'Granular engagement';
const WAVE_ORDER = [GRANULAR_ENGAGEMENT_WAVE, 'Commerce and forms', 'Controls and errors'];
const STAGE_ORDER = ['Arrival', 'Discovery', 'Engagement', 'Intent', 'Conversion', 'Retention'];
const DEEP_ENGAGEMENT_EVENTS = [
  {
    name: 'concrete_workflow_section_viewed',
    label: 'Section visible',
    flow: 'A visitor reaches a tracked page section.',
  },
  {
    name: 'concrete_workflow_section_engagement',
    label: 'Section deep read',
    flow: 'A visible section reaches a sustained dwell milestone.',
  },
  {
    name: 'concrete_workflow_content_selected',
    label: 'Content selected',
    flow: 'A visitor selects useful page or result content.',
  },
  {
    name: 'concrete_workflow_result_engagement',
    label: 'Result dwell',
    flow: 'The calculator result panel stays visible over time.',
  },
  {
    name: 'concrete_workflow_scroll_backtrack',
    label: 'Scroll backtrack',
    flow: 'A visitor moves back up to compare or reconsider.',
  },
  {
    name: 'concrete_workflow_field_completed',
    label: 'Field completed',
    flow: 'A non-sensitive field is completed, without its value.',
  },
  {
    name: 'concrete_workflow_form_abandoned',
    label: 'Form abandoned',
    flow: 'A touched form is left before successful submission.',
  },
  {
    name: 'concrete_workflow_exit_intent',
    label: 'Exit intent',
    flow: 'A desktop pointer exits through the top viewport edge.',
  },
] as const;

function formatTime(ms: number): string {
  if (!ms) return '-';
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatDate(ms: number): string {
  if (!ms) return '-';
  return new Date(ms).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function parseMeta(meta: string): string {
  if (!meta) return '';
  try {
    const parsed = JSON.parse(meta) as unknown;
    if (parsed && typeof parsed === 'object') {
      return Object.entries(parsed as Record<string, unknown>)
        .map(([key, value]) => `${key}: ${String(value)}`)
        .join(' · ');
    }
  } catch {
    // Raw meta can be a single string rather than JSON.
  }
  return meta;
}

function SessionMeta({ session }: { session: SessionSummary }): ReactElement {
  const location = [session.city, session.country].filter(Boolean).join(', ');
  const device = [session.deviceType, session.browser, session.os].filter(Boolean).join(' · ');
  const source = session.referrerHostname || session.utmSource || session.utmCampaign || 'Direct';
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-[#9B9590]">
      <span className="flex items-center gap-1">
        <Clock className="h-3 w-3" /> {formatTime(session.startedAt)}
      </span>
      {location && (
        <span className="flex items-center gap-1">
          <MapPin className="h-3 w-3" /> {location}
        </span>
      )}
      <span className="truncate">{device}</span>
      {source !== 'Direct' && <span className="truncate">via {source}</span>}
    </div>
  );
}

function Timeline({ steps }: { steps: JourneyStep[] }): ReactElement {
  if (steps.length === 0) {
    return (
      <div className="flex items-center gap-2 rounded-xl bg-muted px-4 py-3 text-[12px] text-[#9B9590]">
        <FileText className="h-4 w-4" /> No pageviews or events in this range.
      </div>
    );
  }

  return (
    <ol>
      {steps.map((step, index) => {
        const isPage = step.eventType === 'pageview';
        const deepSignal = DEEP_ENGAGEMENT_EVENTS.find(signal => signal.name === step.eventName);
        const isDeepSignal = Boolean(deepSignal);
        const title = isPage
          ? step.pathname || '/'
          : deepSignal?.label || step.eventName || 'Event';
        const detail = isPage ? '' : step.pathname;
        const meta = parseMeta(step.eventMeta);
        return (
          <li key={`${step.ts}-${index}`} className="relative flex gap-3 pb-5 last:pb-0">
            <div className="flex flex-col items-center">
              <span
                className={cn(
                  'mt-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-full',
                  isPage
                    ? 'bg-[#F2F1ED] text-[#6E6C7C]'
                    : isDeepSignal
                      ? 'bg-[#4338CA] text-white'
                      : 'bg-[#3D3B4F] text-white'
                )}
              >
                {isPage ? (
                  <FileText className="h-3 w-3" />
                ) : isDeepSignal ? (
                  <Sparkles className="h-3 w-3" />
                ) : (
                  <MousePointer2 className="h-3 w-3" />
                )}
              </span>
              {index < steps.length - 1 && <span className="mt-1 w-px flex-1 bg-[#E6E4DE]" />}
            </div>
            <div className="min-w-0 flex-1 pt-0.5">
              <div className="flex items-baseline justify-between gap-3">
                <div className="flex min-w-0 items-center gap-2">
                  <p className="truncate text-[13px] font-medium text-[#3D3B4F]">{title}</p>
                  {isDeepSignal && (
                    <span className="shrink-0 rounded-full bg-[#EEF2FF] px-2 py-0.5 text-[9px] font-bold uppercase tracking-wide text-[#4338CA]">
                      Deep signal
                    </span>
                  )}
                </div>
                <span className="shrink-0 text-[11px] tabular-nums text-[#B5B0AA]">
                  {formatTime(step.ts)}
                </span>
              </div>
              {isDeepSignal && (
                <p className="mt-0.5 truncate font-mono text-[10px] text-[#6366F1]">
                  {step.eventName}
                </p>
              )}
              {detail && <p className="mt-0.5 truncate text-[12px] text-[#9B9590]">{detail}</p>}
              {meta && <p className="mt-1 truncate text-[12px] text-[#6E6C7C]">{meta}</p>}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function EventsView({
  siteId,
  period,
  filters,
  filterKey,
  onOpenPaths,
}: {
  siteId: string;
  period: Period;
  filters: AnalyticsFilters;
  filterKey: string;
  onOpenPaths: () => void;
}): ReactElement {
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | EventCoverage>('all');
  const [categoryFilter, setCategoryFilter] = useState('all');
  const [waveFilter, setWaveFilter] = useState('all');
  const [stageFilter, setStageFilter] = useState('all');
  const [selectedEvent, setSelectedEvent] = useState<EventDisplayRow | null>(null);

  const eventsQ = useQuery({
    queryKey: ['site-analytics', siteId, 'events-page', period, filterKey],
    queryFn: async () => api.getEvents(siteId, period, filters),
    staleTime: period === 'today' ? 15_000 : 60_000,
    refetchInterval: period === 'today' ? 15_000 : false,
  });
  const eventPagesQ = useQuery({
    queryKey: ['site-analytics', siteId, 'event-pages', period, filterKey],
    queryFn: async () => api.getEventPages(siteId, period, filters),
    staleTime: period === 'today' ? 15_000 : 60_000,
    refetchInterval: period === 'today' ? 15_000 : false,
  });
  const catalogQ = useQuery({
    queryKey: ['site-analytics', siteId, 'event-catalog'],
    queryFn: async () => api.getEventCatalog(siteId),
    staleTime: 60_000,
  });
  const propsQ = useQuery({
    queryKey: [
      'site-analytics',
      siteId,
      'events-page-props',
      period,
      filterKey,
      selectedEvent?.key,
    ],
    queryFn: async () => {
      const names =
        selectedEvent!.receivedAs.length > 0 ? selectedEvent!.receivedAs : [selectedEvent!.name];
      const groups = await Promise.all(
        names.map(name => api.getEventProps(siteId, period, name, filters))
      );
      return groups.flatMap(group =>
        ((group as { data?: EventPropRow[] }).data ?? []).map(prop => prop)
      );
    },
    enabled: selectedEvent !== null,
    staleTime: period === 'today' ? 15_000 : 60_000,
  });

  const receivedEvents = useMemo(
    () => (eventsQ.data as { data?: EventRow[] } | undefined)?.data ?? [],
    [eventsQ.data]
  );
  const eventPages = useMemo(
    () => (eventPagesQ.data as { data?: EventPageRow[] } | undefined)?.data ?? [],
    [eventPagesQ.data]
  );
  const catalog = useMemo(
    () => (catalogQ.data as { data?: EventCatalogItem[] } | undefined)?.data ?? [],
    [catalogQ.data]
  );

  const rows = useMemo(() => {
    const catalogByAnyName = new Map<string, EventCatalogItem>();
    for (const item of catalog) {
      catalogByAnyName.set(item.eventName, item);
      for (const alias of item.aliases || []) catalogByAnyName.set(alias, item);
    }

    const merged = new Map<string, EventDisplayRow>();
    for (const item of catalog) {
      merged.set(item.eventName, {
        key: item.eventName,
        name: item.eventName,
        category: item.category,
        status: 'missing',
        count: 0,
        totalValue: 0,
        receivedAs: [],
        aliases: item.aliases || [],
        description: item.description || '',
        sourcePath: item.sourcePath || '',
        wave: item.wave || 'Foundation',
        journeyStage: item.journeyStage || 'Unclassified',
      });
    }

    for (const event of receivedEvents) {
      const item = catalogByAnyName.get(event.name);
      if (!item) {
        merged.set(event.name, {
          key: event.name,
          name: event.name,
          category: 'Uncataloged',
          status: 'uncataloged',
          count: event.count,
          totalValue: event.totalValue,
          receivedAs: [event.name],
          aliases: [],
          description: 'Received in this period but absent from the catalog.',
          sourcePath: '',
          wave: 'Uncataloged',
          journeyStage: 'Unclassified',
        });
        continue;
      }

      const row = merged.get(item.eventName)!;
      row.status = 'received';
      row.count += event.count;
      row.totalValue += event.totalValue;
      row.receivedAs.push(event.name);
    }

    return Array.from(merged.values());
  }, [catalog, receivedEvents]);

  const categories = useMemo(
    () => Array.from(new Set(rows.map(row => row.category))).sort((a, b) => a.localeCompare(b)),
    [rows]
  );
  const waves = useMemo(
    () =>
      Array.from(new Set(rows.map(row => row.wave))).sort((a, b) => {
        const aIndex = WAVE_ORDER.indexOf(a);
        const bIndex = WAVE_ORDER.indexOf(b);
        return (
          (aIndex === -1 ? WAVE_ORDER.length : aIndex) -
            (bIndex === -1 ? WAVE_ORDER.length : bIndex) || a.localeCompare(b)
        );
      }),
    [rows]
  );
  const stages = useMemo(
    () =>
      Array.from(new Set(rows.map(row => row.journeyStage))).sort(
        (a, b) => STAGE_ORDER.indexOf(a) - STAGE_ORDER.indexOf(b) || a.localeCompare(b)
      ),
    [rows]
  );
  const stats = useMemo(() => {
    const catalogRows = rows.filter(row => row.status !== 'uncataloged');
    const received = catalogRows.filter(row => row.status === 'received').length;
    return {
      total: catalogRows.length,
      received,
      missing: catalogRows.length - received,
      uncataloged: rows.length - catalogRows.length,
      coverage: catalogRows.length === 0 ? 0 : received / catalogRows.length,
    };
  }, [rows]);
  const filteredEvents = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return rows.filter(row => {
      if (statusFilter !== 'all' && row.status !== statusFilter) return false;
      if (categoryFilter !== 'all' && row.category !== categoryFilter) return false;
      if (waveFilter !== 'all' && row.wave !== waveFilter) return false;
      if (stageFilter !== 'all' && row.journeyStage !== stageFilter) return false;
      if (!needle) return true;
      return [
        row.name,
        row.category,
        row.wave,
        row.journeyStage,
        row.description,
        row.sourcePath,
        ...row.aliases,
        ...row.receivedAs,
      ]
        .filter(Boolean)
        .some(value => value.toLowerCase().includes(needle));
    });
  }, [rows, query, statusFilter, categoryFilter, waveFilter, stageFilter]);

  const props = useMemo(() => (propsQ.data as EventPropRow[] | undefined) ?? [], [propsQ.data]);

  if (selectedEvent !== null) {
    return (
      <div className="rounded-[20px] bg-white p-6 shadow-float">
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <h3 className="truncate text-[15px] font-bold text-[#3D3B4F]">{selectedEvent.name}</h3>
            <p className="mt-0.5 text-[12px] text-[#9B9590]">
              {selectedEvent.status === 'uncataloged'
                ? 'Uncataloged event properties'
                : `${selectedEvent.category} · ${selectedEvent.journeyStage} · ${formatNumber(selectedEvent.count)} events this period`}
            </p>
          </div>
          <button
            onClick={() => setSelectedEvent(null)}
            className="rounded-full bg-muted px-3 py-1 text-[11px] font-semibold text-foreground transition-colors hover:bg-[#E6E4DE]"
          >
            &larr; All events
          </button>
        </div>
        {selectedEvent.aliases.length > 0 && (
          <div className="mb-4 rounded-lg bg-[#F9F8F6] px-3 py-2 text-[12px] text-[#6E6C7C]">
            Alias merge: {selectedEvent.aliases.join(', ')}
            {selectedEvent.receivedAs.length > 0 && (
              <> · received as {selectedEvent.receivedAs.join(', ')}</>
            )}
          </div>
        )}
        {selectedEvent.wave !== 'Foundation' && (
          <div className="mb-4 rounded-lg border border-[#C7D2FE] bg-[#EEF2FF] px-3 py-2 text-[12px] font-medium text-[#4338CA]">
            {selectedEvent.wave} · {selectedEvent.journeyStage}
          </div>
        )}
        {propsQ.isError ? (
          <div className="flex min-h-[16rem] flex-col items-center justify-center">
            <AlertCircle className="mb-2 h-5 w-5 text-[#e07a5f]/60" strokeWidth={1.5} />
            <p className="text-[13px] text-[#e07a5f]">Couldn&rsquo;t load event properties</p>
          </div>
        ) : propsQ.isLoading ? (
          <EventSkeleton />
        ) : props.length === 0 ? (
          <EmptyState label="No properties on this event" />
        ) : (
          <Rows
            header="Property"
            valueHeader="Events"
            rows={props.map(prop => ({
              name: `${prop.key}: ${prop.value}`,
              value: prop.events,
              detail: undefined,
            }))}
          />
        )}
      </div>
    );
  }

  const statusOptions: { key: 'all' | EventCoverage; label: string; count: number }[] = [
    { key: 'all', label: 'All', count: rows.length },
    { key: 'received', label: 'Received', count: stats.received },
    { key: 'missing', label: 'No data yet', count: stats.missing },
    { key: 'uncataloged', label: 'Uncataloged', count: stats.uncataloged },
  ];
  const coverageSegments = [
    { label: 'Received', value: stats.received, className: 'bg-emerald-500' },
    { label: 'No data yet', value: stats.missing, className: 'bg-[#DAD7CF]' },
    { label: 'Uncataloged', value: stats.uncataloged, className: 'bg-amber-500' },
  ];

  return (
    <div className="space-y-4">
      <NewTrackingWavesPanel
        rows={rows}
        waves={waves}
        catalogTotal={stats.total}
        onOpenPaths={onOpenPaths}
        onWaveFilter={wave => {
          setWaveFilter(wave);
          setStatusFilter(wave === 'all' ? 'all' : 'missing');
        }}
      />
      <JourneyStageCoverage
        rows={rows}
        onStageFilter={stage => {
          setStageFilter(stage);
          setStatusFilter('all');
        }}
      />
      <PageEventCoveragePanel
        rows={rows}
        eventPages={eventPages}
        isError={eventPagesQ.isError}
        isLoading={eventPagesQ.isLoading}
        onEventSelect={event => {
          setWaveFilter('all');
          setStageFilter('all');
          setCategoryFilter('all');
          setStatusFilter('all');
          setSelectedEvent(event);
        }}
      />
      <div className="rounded-[20px] bg-white p-6 shadow-float">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h3 className="text-[15px] font-bold text-[#3D3B4F]">Event Coverage</h3>
            <p className="mt-0.5 text-[12px] text-[#9B9590]">
              Catalog {stats.total} · received {stats.received} · no data yet {stats.missing}
            </p>
          </div>
          <div className="text-right">
            <div className="text-[28px] font-bold leading-none text-[#3D3B4F]">
              {Math.round(stats.coverage * 100)}%
            </div>
            <div className="text-[11px] uppercase tracking-wider text-[#B5B0AA]">Coverage</div>
          </div>
        </div>
        <div className="mt-4 flex h-3 overflow-hidden rounded-full bg-[#F2F1ED]">
          {coverageSegments.map(segment => {
            const width = rows.length === 0 ? 0 : (segment.value / rows.length) * 100;
            return (
              <div
                key={segment.label}
                className={cn('h-full transition-all', segment.className)}
                style={{ width: `${width}%` }}
                title={`${segment.label}: ${segment.value}`}
              />
            );
          })}
        </div>
        <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          <div className="rounded-lg border border-[#E6E4DE] p-3">
            <div className="text-[24px] font-bold leading-none tabular-nums text-[#3D3B4F]">
              {formatNumber(stats.total)}
            </div>
            <div className="mt-1 text-[11px] font-medium uppercase tracking-wider text-[#9B9590]">
              Catalog events
            </div>
          </div>
          <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3">
            <div className="text-[24px] font-bold leading-none tabular-nums text-emerald-700">
              {formatNumber(stats.received)}
            </div>
            <div className="mt-1 text-[11px] font-medium uppercase tracking-wider text-emerald-600">
              Received
            </div>
          </div>
          <div className="rounded-lg border border-[#E6E4DE] bg-[#FAFAF8] p-3">
            <div className="text-[24px] font-bold leading-none tabular-nums text-[#6E6C7C]">
              {formatNumber(stats.missing)}
            </div>
            <div className="mt-1 text-[11px] font-medium uppercase tracking-wider text-[#9B9590]">
              No data yet
            </div>
          </div>
          <div
            className={cn(
              'rounded-lg border p-3',
              stats.uncataloged > 0 ? 'border-amber-300 bg-amber-50' : 'border-[#E6E4DE]'
            )}
          >
            <div className="text-[24px] font-bold leading-none tabular-nums text-[#9A3412]">
              {formatNumber(stats.uncataloged)}
            </div>
            <div className="mt-1 text-[11px] font-medium uppercase tracking-wider text-amber-700">
              Uncataloged
            </div>
          </div>
        </div>
        {catalog.length === 0 && !catalogQ.isLoading && (
          <div className="mt-4 flex items-start gap-2 rounded-lg bg-[#FFF7ED] px-3 py-2 text-[12px] text-[#9A3412]">
            <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            No catalog is configured. Only received events can be shown.
          </div>
        )}
        <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          {categories.map(category => {
            const categoryRows = rows.filter(row => row.category === category);
            const hit = categoryRows.filter(row => row.status === 'received').length;
            const total = categoryRows.length;
            const coverage = total === 0 ? 0 : hit / total;
            return (
              <div key={category} className="rounded-lg border border-[#E6E4DE] p-3">
                <div className="flex items-center justify-between gap-2 text-[12px] font-medium text-[#3D3B4F]">
                  <span className="truncate">{category}</span>
                  <span className="shrink-0 tabular-nums text-[#9B9590]">
                    {hit}/{total}
                  </span>
                </div>
                <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-[#F2F1ED]">
                  <div
                    className="h-full rounded-full bg-[#6E6C7C]"
                    style={{ width: `${coverage * 100}%` }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <EventCoverageMatrix
        categories={categories}
        rows={filteredEvents}
        catalogTotal={stats.total}
        onSelect={event => setSelectedEvent(event)}
      />

      <div className="rounded-[20px] bg-white p-6 shadow-float">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-[15px] font-bold text-[#3D3B4F]">All Custom Events</h3>
            <p className="mt-0.5 text-[12px] text-[#9B9590]">
              {filteredEvents.length} of {rows.length} events · click a received event to inspect
              properties.
            </p>
          </div>
          <div className="relative w-full sm:w-72">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[#B5B0AA]" />
            <Input
              value={query}
              onChange={event => setQuery(event.target.value)}
              placeholder="Search name, alias, category or source"
              className="h-9 pl-9 text-[13px]"
            />
          </div>
        </div>
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <ListFilter className="h-3.5 w-3.5 text-[#B5B0AA]" />
          {statusOptions.map(option => (
            <button
              key={option.key}
              onClick={() => setStatusFilter(option.key)}
              className={cn(
                'rounded-full px-3 py-1 text-[11px] font-medium transition-colors',
                statusFilter === option.key
                  ? 'bg-[#3D3B4F] text-white'
                  : 'bg-[#F2F1ED] text-[#6E6C7C] hover:bg-[#E6E4DE]'
              )}
            >
              {option.label} {option.count}
            </button>
          ))}
          <select
            value={categoryFilter}
            onChange={event => setCategoryFilter(event.target.value)}
            className="h-7 rounded-full border border-[#E6E4DE] bg-white px-2 text-[11px] text-[#6E6C7C]"
          >
            <option value="all">All categories</option>
            {categories.map(category => (
              <option key={category} value={category}>
                {category}
              </option>
            ))}
          </select>
          <select
            value={waveFilter}
            onChange={event => setWaveFilter(event.target.value)}
            className="h-7 rounded-full border border-[#E6E4DE] bg-white px-2 text-[11px] text-[#6E6C7C]"
          >
            <option value="all">All waves</option>
            {waves.map(wave => (
              <option key={wave} value={wave}>
                {wave}
              </option>
            ))}
          </select>
          <select
            value={stageFilter}
            onChange={event => setStageFilter(event.target.value)}
            className="h-7 rounded-full border border-[#E6E4DE] bg-white px-2 text-[11px] text-[#6E6C7C]"
          >
            <option value="all">All journey stages</option>
            {stages.map(stage => (
              <option key={stage} value={stage}>
                {stage}
              </option>
            ))}
          </select>
        </div>
        {eventsQ.isError || catalogQ.isError ? (
          <div className="flex min-h-[18rem] flex-col items-center justify-center">
            <AlertCircle className="mb-2 h-5 w-5 text-[#e07a5f]/60" strokeWidth={1.5} />
            <p className="text-[13px] text-[#e07a5f]">Couldn&rsquo;t load custom events</p>
          </div>
        ) : eventsQ.isLoading || catalogQ.isLoading ? (
          <EventSkeleton />
        ) : filteredEvents.length === 0 ? (
          <EmptyState label={query ? 'No matching events' : 'No custom events yet'} />
        ) : (
          <div className="divide-y divide-[#F2F1ED]">
            {filteredEvents.map(event => (
              <button
                key={event.key}
                onClick={() => setSelectedEvent(event)}
                className="flex w-full items-start gap-3 px-2 py-3 text-left transition-colors hover:bg-[#F9F8F6]"
              >
                {event.status === 'received' ? (
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
                ) : event.status === 'missing' ? (
                  <CircleDashed className="mt-0.5 h-4 w-4 shrink-0 text-[#B5B0AA]" />
                ) : (
                  <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
                )}
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate font-mono text-[12px] font-medium text-[#3D3B4F]">
                      {event.name}
                    </span>
                    <span className="rounded-full bg-[#F2F1ED] px-2 py-0.5 text-[10px] font-medium text-[#6E6C7C]">
                      {event.category}
                    </span>
                    {event.wave !== 'Foundation' && (
                      <span className="rounded-full bg-[#EEF2FF] px-2 py-0.5 text-[10px] font-semibold text-[#4338CA]">
                        {event.wave}
                      </span>
                    )}
                    <span className="rounded-full border border-[#E6E4DE] px-2 py-0.5 text-[10px] font-medium text-[#6E6C7C]">
                      {event.journeyStage}
                    </span>
                    <span
                      className={cn(
                        'rounded-full px-2 py-0.5 text-[10px] font-semibold',
                        event.status === 'received'
                          ? 'bg-emerald-50 text-emerald-700'
                          : event.status === 'missing'
                            ? 'bg-[#F2F1ED] text-[#6E6C7C]'
                            : 'bg-amber-50 text-amber-700'
                      )}
                    >
                      {event.status === 'received'
                        ? 'Received'
                        : event.status === 'missing'
                          ? 'No data yet'
                          : 'Uncataloged'}
                    </span>
                  </div>
                  {(event.description || event.sourcePath || event.aliases.length > 0) && (
                    <p className="mt-1 truncate text-[11px] text-[#9B9590]">
                      {[
                        event.description,
                        event.sourcePath,
                        event.aliases.length > 0 ? `aliases: ${event.aliases.join(', ')}` : '',
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </p>
                  )}
                </div>
                <div className="shrink-0 text-right">
                  <div className="text-[13px] font-semibold tabular-nums text-[#3D3B4F]">
                    {formatNumber(event.count)}
                  </div>
                  <div className="text-[10px] uppercase tracking-wider text-[#B5B0AA]">Events</div>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function Rows({
  header,
  valueHeader,
  secondaryHeader,
  rows,
  onClick,
}: {
  header: string;
  valueHeader: string;
  secondaryHeader?: string;
  rows: { name: string; value: number; secondary?: number; detail?: string }[];
  onClick?: (item: { name: string }) => void;
}): ReactElement {
  const max = rows.length > 0 ? Math.max(...rows.map(row => row.value)) : 1;
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between px-2.5 pb-1 text-[11px] font-medium uppercase tracking-wider text-[#B5B0AA]">
        <span>{header}</span>
        <div className="flex shrink-0 gap-5">
          <span className="w-12 text-right">{valueHeader}</span>
          {secondaryHeader !== undefined && (
            <span className="w-16 text-right">{secondaryHeader}</span>
          )}
        </div>
      </div>
      {rows.map(row => {
        const clickable = Boolean(onClick);
        const Row = clickable ? 'button' : 'div';
        return (
          <Row
            key={row.name}
            onClick={clickable ? () => onClick!({ name: row.name }) : undefined}
            className={cn(
              'relative flex h-[34px] w-full items-center justify-between rounded-md px-2.5',
              clickable && 'cursor-pointer transition-colors hover:bg-[#E6E4DE]'
            )}
          >
            <div
              className="absolute inset-y-0 left-0 rounded-md bg-muted"
              style={{ width: `${(row.value / max) * 100}%` }}
            />
            <span className="relative z-10 min-w-0 truncate pr-4 text-[13px] text-[#3D3B4F]">
              {row.name}
            </span>
            <div className="relative z-10 flex shrink-0 gap-5 text-[13px] font-medium tabular-nums text-[#3D3B4F]">
              <span className="w-12 text-right">{formatNumber(row.value)}</span>
              {secondaryHeader !== undefined && (
                <span className="w-16 text-right text-[#9B9590]">
                  {formatNumber(row.secondary ?? 0)}
                </span>
              )}
            </div>
          </Row>
        );
      })}
    </div>
  );
}

function EventSkeleton(): ReactElement {
  return (
    <div className="space-y-2.5">
      {[95, 78, 62, 48, 36, 28, 20].map((width, index) => (
        <div key={index} className="flex items-center justify-between gap-4">
          <div className="h-6 animate-pulse rounded bg-muted" style={{ width: `${width}%` }} />
          <div className="h-6 w-10 shrink-0 animate-pulse rounded bg-muted" />
        </div>
      ))}
    </div>
  );
}

function JourneyStageCoverage({
  rows,
  onStageFilter,
}: {
  rows: EventDisplayRow[];
  onStageFilter: (stage: string) => void;
}): ReactElement | null {
  const stages = STAGE_ORDER.map(stage => ({
    stage,
    rows: rows.filter(row => row.journeyStage === stage),
  })).filter(stage => stage.rows.length > 0);

  if (stages.length === 0) return null;

  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
      {stages.map(({ stage, rows: stageRows }) => {
        const received = stageRows.filter(row => row.status === 'received').length;
        const coverage = stageRows.length === 0 ? 0 : received / stageRows.length;
        return (
          <button
            key={stage}
            onClick={() => onStageFilter(stage)}
            className="rounded-lg border border-[#C7D2FE] bg-[#FAFAF8] p-3 text-left transition-colors hover:border-[#4338CA] hover:bg-white"
            title={`Filter ${stage} events`}
          >
            <span className="text-[10px] font-semibold uppercase tracking-wider text-[#6366F1]">
              {stage}
            </span>
            <span className="mt-1 flex items-baseline gap-1">
              <span className="text-[18px] font-bold leading-none tabular-nums text-[#3D3B4F]">
                {received}
              </span>
              <span className="text-[11px] font-medium text-[#9B9590]">/ {stageRows.length}</span>
            </span>
            <span className="mt-2 block h-1.5 overflow-hidden rounded-full bg-[#EDEBE6]">
              <span
                className="block h-full rounded-full bg-emerald-500"
                style={{ width: `${coverage * 100}%` }}
              />
            </span>
          </button>
        );
      })}
    </div>
  );
}

function PageEventCoveragePanel({
  rows,
  eventPages,
  isError,
  isLoading,
  onEventSelect,
}: {
  rows: EventDisplayRow[];
  eventPages: EventPageRow[];
  isError: boolean;
  isLoading: boolean;
  onEventSelect: (event: EventDisplayRow) => void;
}): ReactElement {
  const rowByAnyName = useMemo(() => {
    const map = new Map<string, EventDisplayRow>();
    for (const row of rows) {
      map.set(row.name, row);
      for (const alias of row.aliases) map.set(alias, row);
    }
    return map;
  }, [rows]);

  const pages = useMemo(() => {
    const byPath = new Map<
      string,
      {
        pathname: string;
        events: number;
        newWaveEvents: number;
        distinctEvents: Map<string, { row: EventDisplayRow; count: number }>;
      }
    >();

    for (const eventPage of eventPages) {
      const pathname = eventPage.pathname || '/';
      const row = rowByAnyName.get(eventPage.name);
      if (!row || row.status === 'uncataloged') continue;
      const page = byPath.get(pathname) ?? {
        pathname,
        events: 0,
        newWaveEvents: 0,
        distinctEvents: new Map<string, { row: EventDisplayRow; count: number }>(),
      };
      const current = page.distinctEvents.get(row.name);
      page.events += eventPage.count;
      page.newWaveEvents +=
        row.wave !== 'Foundation' && row.wave !== 'Uncataloged' ? eventPage.count : 0;
      page.distinctEvents.set(row.name, {
        row,
        count: (current?.count ?? 0) + eventPage.count,
      });
      byPath.set(pathname, page);
    }

    return Array.from(byPath.values())
      .map(page => ({
        ...page,
        distinctEventRows: Array.from(page.distinctEvents.values()).sort((a, b) =>
          b.count === a.count ? a.row.name.localeCompare(b.row.name) : b.count - a.count
        ),
      }))
      .sort((a, b) => b.events - a.events || a.pathname.localeCompare(b.pathname));
  }, [eventPages, rowByAnyName]);

  const newWavePageCount = pages.filter(page => page.newWaveEvents > 0).length;

  return (
    <section className="rounded-[20px] bg-white p-6 shadow-float">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h3 className="text-[15px] font-bold text-[#3D3B4F]">Page Event Coverage</h3>
          <p className="mt-1 max-w-2xl text-[12px] text-[#9B9590]">
            Event volume grouped by the page where it fired. This connects the tracking catalog to
            the real visitor route.
          </p>
        </div>
        <div className="rounded-lg border border-[#C7D2FE] bg-[#EEF2FF] px-3 py-2 text-right">
          <div className="text-[20px] font-bold leading-none tabular-nums text-[#4338CA]">
            {newWavePageCount}
          </div>
          <div className="mt-1 text-[10px] font-semibold uppercase tracking-wider text-[#6366F1]">
            Pages with new waves
          </div>
        </div>
      </div>

      {isError ? (
        <div className="mt-4 flex items-center gap-2 rounded-lg bg-[#FFF7ED] px-3 py-2 text-[12px] text-[#9A3412]">
          <TriangleAlert className="h-3.5 w-3.5" /> Page event coverage is unavailable right now.
        </div>
      ) : isLoading ? (
        <div className="mt-4 space-y-2">
          {[92, 74, 58].map((width, index) => (
            <div
              key={index}
              className="h-12 animate-pulse rounded-lg bg-muted"
              style={{ width: `${width}%` }}
            />
          ))}
        </div>
      ) : pages.length === 0 ? (
        <div className="mt-4 rounded-lg border border-dashed border-[#E6E4DE] px-4 py-8 text-center text-[13px] text-[#9B9590]">
          No page-scoped custom events in this period yet.
        </div>
      ) : (
        <div className="mt-4 space-y-2">
          {pages.map(page => (
            <article
              key={page.pathname}
              className="rounded-lg border border-[#E6E4DE] bg-[#FAFAF8] p-3"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-2">
                  <MapPin className="h-3.5 w-3.5 shrink-0 text-[#6E6C7C]" />
                  <span className="min-w-0 truncate font-mono text-[12px] font-semibold text-[#3D3B4F]">
                    {page.pathname}
                  </span>
                </div>
                <div className="flex shrink-0 items-center gap-2 text-[11px] font-medium tabular-nums text-[#9B9590]">
                  <span>{formatNumber(page.events)} events</span>
                  <span className="text-[#B5B0AA]">|</span>
                  <span>{page.distinctEventRows.length} tracked actions</span>
                </div>
              </div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {page.distinctEventRows.map(({ row, count }) => (
                  <button
                    key={row.name}
                    onClick={() => onEventSelect(row)}
                    title={`${row.name}\n${row.category} · ${row.journeyStage}`}
                    className={cn(
                      'inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-full border px-2 py-1 text-left transition-colors',
                      row.wave !== 'Foundation' && row.wave !== 'Uncataloged'
                        ? 'border-[#C7D2FE] bg-[#EEF2FF] hover:border-[#4338CA]'
                        : 'border-[#E6E4DE] bg-white hover:border-[#C9C5BD]'
                    )}
                  >
                    <span
                      className={cn(
                        'h-1.5 w-1.5 shrink-0 rounded-full',
                        row.status === 'received' ? 'bg-emerald-500' : 'bg-[#DAD7CF]'
                      )}
                    />
                    <span className="min-w-0 truncate font-mono text-[10.5px] text-[#3D3B4F]">
                      {row.name}
                    </span>
                    <span className="shrink-0 text-[10px] font-semibold tabular-nums text-[#9B9590]">
                      {formatNumber(count)}
                    </span>
                  </button>
                ))}
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

function NewTrackingWavesPanel({
  rows,
  waves,
  catalogTotal,
  onOpenPaths,
  onWaveFilter,
}: {
  rows: EventDisplayRow[];
  waves: string[];
  catalogTotal: number;
  onOpenPaths: () => void;
  onWaveFilter: (wave: string) => void;
}): ReactElement | null {
  const newWaves = waves.filter(wave => wave !== 'Foundation' && wave !== 'Uncataloged');
  if (newWaves.length === 0) return null;
  const spotlightRows = rows
    .filter(row => newWaves.includes(row.wave))
    .sort((a, b) => {
      const statusOrder = a.status === 'received' ? 1 : 0;
      const waveOrder = newWaves.indexOf(a.wave) - newWaves.indexOf(b.wave);
      return (
        waveOrder || statusOrder - (b.status === 'received' ? 1 : 0) || a.name.localeCompare(b.name)
      );
    });
  const missingCount = spotlightRows.filter(row => row.status === 'missing').length;
  const receivedCount = spotlightRows.filter(row => row.status === 'received').length;
  const rowByName = new Map(rows.map(row => [row.name, row]));
  const granularRows = DEEP_ENGAGEMENT_EVENTS.map(signal => ({
    signal,
    row: rowByName.get(signal.name),
  }));
  const granularReceived = granularRows.filter(item => item.row?.status === 'received').length;
  const allEventsReceived = rows.filter(row => row.status === 'received').length;

  return (
    <section className="overflow-hidden rounded-[20px] bg-[#252434] text-white shadow-float">
      <div className="border-b border-white/10 px-6 py-5">
        <div className="flex flex-wrap items-start justify-between gap-5">
          <div className="max-w-3xl">
            <div className="flex flex-wrap items-center gap-2">
              <span className="inline-flex items-center gap-1.5 rounded-full bg-[#C7D2FE] px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.12em] text-[#312E81]">
                <Sparkles className="h-3 w-3" /> Latest instrumentation
              </span>
              <span className="rounded-full border border-white/15 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-[#C9C7D8]">
                Granular engagement
              </span>
            </div>
            <h3 className="mt-3 text-[20px] font-bold tracking-[-0.02em]">
              Deep engagement signals
            </h3>
            <p className="mt-1 max-w-2xl text-[12px] leading-5 text-[#B8B5C8]">
              Eight new production signals reveal what visitors read, compare, complete and abandon
              after they enter the site. Sensitive field values are never collected.
            </p>
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            <div className="min-w-[96px] rounded-lg bg-white/8 px-3 py-2.5">
              <div className="text-[24px] font-bold leading-none tabular-nums">{catalogTotal}</div>
              <div className="mt-1 text-[9px] font-semibold uppercase tracking-[0.12em] text-[#B8B5C8]">
                Tracked events
              </div>
            </div>
            <div className="min-w-[96px] rounded-lg bg-emerald-400/15 px-3 py-2.5">
              <div className="text-[24px] font-bold leading-none tabular-nums text-emerald-300">
                {granularReceived}
              </div>
              <div className="mt-1 text-[9px] font-semibold uppercase tracking-[0.12em] text-emerald-200/80">
                Deep live
              </div>
            </div>
            <div className="col-span-2 rounded-lg bg-white/8 px-3 py-2.5 sm:col-span-1">
              <div className="text-[24px] font-bold leading-none tabular-nums">
                {allEventsReceived}
              </div>
              <div className="mt-1 text-[9px] font-semibold uppercase tracking-[0.12em] text-[#B8B5C8]">
                Events received
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="px-6 py-5">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[#C9C7D8]">
              Visitor intent path
            </p>
            <p className="mt-1 text-[12px] text-[#918EA4]">
              Visibility → depth → comparison → completion → abandonment or exit
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              onClick={onOpenPaths}
              className="inline-flex h-8 items-center gap-1.5 rounded-full bg-white px-3 text-[11px] font-bold text-[#252434] transition-colors hover:bg-[#E9E7F4]"
            >
              <Route className="h-3.5 w-3.5" /> Open user paths
            </button>
            <button
              onClick={() => onWaveFilter(GRANULAR_ENGAGEMENT_WAVE)}
              className="inline-flex h-8 items-center gap-1.5 rounded-full border border-white/15 px-3 text-[11px] font-semibold text-white transition-colors hover:bg-white/10"
            >
              <ListFilter className="h-3.5 w-3.5" /> Filter catalog
            </button>
          </div>
        </div>

        <div className="grid gap-px overflow-hidden rounded-xl border border-white/10 bg-white/10 sm:grid-cols-2 xl:grid-cols-4">
          {granularRows.map(({ signal, row }, index) => {
            const received = row?.status === 'received';
            return (
              <button
                key={signal.name}
                onClick={() => row && onWaveFilter(GRANULAR_ENGAGEMENT_WAVE)}
                disabled={!row}
                title={`${signal.name}\n${row?.description || signal.flow}`}
                className={cn(
                  'group min-h-[118px] bg-[#2D2B3D] p-3.5 text-left transition-colors',
                  row && 'hover:bg-[#353348]'
                )}
              >
                <div className="flex items-start justify-between gap-2">
                  <span className="text-[10px] font-bold tabular-nums text-[#7D7A91]">
                    {String(index + 1).padStart(2, '0')}
                  </span>
                  <span
                    className={cn(
                      'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[9px] font-bold uppercase tracking-wide',
                      received ? 'bg-emerald-400/15 text-emerald-300' : 'bg-white/8 text-[#918EA4]'
                    )}
                  >
                    <span
                      className={cn(
                        'h-1.5 w-1.5 rounded-full',
                        received ? 'bg-emerald-400' : 'bg-[#6F6C82]'
                      )}
                    />
                    {received ? formatNumber(row?.count ?? 0) : 'Waiting'}
                  </span>
                </div>
                <div className="mt-3 text-[13px] font-bold text-white">{signal.label}</div>
                <div className="mt-1 text-[11px] leading-4 text-[#AAA7BA]">{signal.flow}</div>
                <div className="mt-2 truncate font-mono text-[9.5px] text-[#7D7A91]">
                  {signal.name}
                </div>
              </button>
            );
          })}
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-white/10 bg-black/10 px-6 py-3 text-[11px]">
        <span className="text-[#B8B5C8]">
          Catalog ready · {granularRows.length} deep signals · {catalogTotal} total events
        </span>
        <span className="flex items-center gap-2 text-[#918EA4]">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" /> Received {receivedCount} of{' '}
          {spotlightRows.length} newer-wave events
          {missingCount > 0 && ` · ${missingCount} waiting for first live trigger`}
        </span>
      </div>
    </section>
  );
}

function EventCoverageMatrix({
  categories,
  rows,
  catalogTotal,
  onSelect,
}: {
  categories: string[];
  rows: EventDisplayRow[];
  catalogTotal: number;
  onSelect: (event: EventDisplayRow) => void;
}): ReactElement {
  return (
    <div className="rounded-[20px] bg-white p-6 shadow-float">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h3 className="text-[15px] font-bold text-[#3D3B4F]">Event Coverage Matrix</h3>
          <p className="mt-0.5 text-[12px] text-[#9B9590]">
            All {catalogTotal} catalog events by category. Green means received in this period.
          </p>
        </div>
        <div className="flex items-center gap-3 text-[11px] text-[#6E6C7C]">
          <span className="flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-sm bg-emerald-500" /> Received
          </span>
          <span className="flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-sm bg-[#DAD7CF]" /> No data yet
          </span>
          <span className="flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-sm bg-amber-500" /> Uncataloged
          </span>
        </div>
      </div>
      <div className="space-y-4">
        {categories.map(category => {
          const categoryRows = rows.filter(row => row.category === category);
          const received = categoryRows.filter(row => row.status === 'received').length;
          return (
            <section key={category}>
              <div className="mb-2 flex items-center justify-between gap-3">
                <h4 className="truncate text-[12px] font-semibold text-[#3D3B4F]">{category}</h4>
                <span className="shrink-0 text-[11px] tabular-nums text-[#9B9590]">
                  {received}/{categoryRows.length} received
                </span>
              </div>
              <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
                {categoryRows.map(event => (
                  <button
                    key={event.key}
                    onClick={() => onSelect(event)}
                    title={`${event.name}\n${event.description || event.category}`}
                    className="flex h-8 min-w-0 items-center gap-2 rounded-md border border-[#EDEBE6] bg-[#FAFAF8] px-2 text-left transition-colors hover:border-[#C9C5BD] hover:bg-white"
                  >
                    <span
                      className={cn(
                        'h-2.5 w-2.5 shrink-0 rounded-sm',
                        event.status === 'received'
                          ? 'bg-emerald-500'
                          : event.status === 'missing'
                            ? 'bg-[#DAD7CF]'
                            : 'bg-amber-500'
                      )}
                    />
                    <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-[#3D3B4F]">
                      {event.name}
                    </span>
                    <span className="shrink-0 text-[10px] font-semibold tabular-nums text-[#9B9590]">
                      {event.status === 'received' ? formatNumber(event.count) : '-'}
                    </span>
                  </button>
                ))}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}

function EmptyState({ label }: { label: string }): ReactElement {
  return (
    <div className="flex min-h-[18rem] flex-col items-center justify-center">
      <BarChart3 className="mb-2 h-5 w-5 text-[#B5B0AA]" strokeWidth={1.5} />
      <p className="text-[13px] font-medium text-[#9B9590]">{label}</p>
      <p className="mt-1 text-[12px] text-[#B5B0AA]">Data will appear once visitors arrive</p>
    </div>
  );
}

function PathFlowsPanel({ rows }: { rows: PathFlowRow[] }): ReactElement {
  const groups = {
    entries: rows.filter(row => row.kind === 'entry'),
    transitions: rows.filter(row => row.kind === 'transition'),
    sequences: rows.filter(row => row.kind === 'sequence'),
  };

  const renderGroup = (
    title: string,
    groupRows: PathFlowRow[],
    paths: (row: PathFlowRow) => string[],
    compact = false
  ): ReactElement => {
    const max = groupRows.length > 0 ? Math.max(...groupRows.map(row => row.sessions)) : 1;
    const total = groupRows.reduce((sum, row) => sum + row.sessions, 0);
    return (
      <div className="flex min-h-[230px] flex-col rounded-lg border border-[#E6E4DE] bg-[#FAFAF8] p-4">
        <div className="mb-3 flex items-start justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <Route className="h-3.5 w-3.5 shrink-0 text-[#6E6C7C]" />
            <h4 className="truncate text-[13px] font-semibold text-[#3D3B4F]">{title}</h4>
          </div>
          <span className="shrink-0 text-[11px] font-medium tabular-nums text-[#9B9590]">
            {formatNumber(total)} sessions
          </span>
        </div>
        {groupRows.length === 0 ? (
          <p className="text-[12px] text-[#9B9590]">No paths in this period</p>
        ) : (
          <div className="flex flex-1 flex-col gap-2.5">
            {groupRows.map(row => {
              const rowPaths = paths(row);
              const width = max > 0 ? (row.sessions / max) * 100 : 0;
              return (
                <div
                  key={`${row.kind}-${row.fromPath}-${row.toPath}-${row.thirdPath}`}
                  className="rounded-md border border-[#EDEBE6] bg-white p-2.5"
                >
                  <div className="mb-1.5 flex items-center justify-between gap-2 text-[11px]">
                    <span className="min-w-0 truncate font-mono text-[#3D3B4F]">
                      {rowPaths[0] || '/'}
                    </span>
                    <span className="flex shrink-0 items-center gap-1.5">
                      <span className="font-semibold tabular-nums text-[#3D3B4F]">
                        {formatNumber(row.sessions)}
                      </span>
                      {total > 0 && (
                        <span className="text-[10px] font-medium tabular-nums text-[#9B9590]">
                          {Math.round(total > 0 ? (row.sessions / total) * 100 : 0)}%
                        </span>
                      )}
                    </span>
                  </div>
                  <div
                    className={cn(
                      'relative mt-2 overflow-hidden rounded-md border border-[#F2F1ED] bg-white',
                      compact ? 'h-8' : 'h-10'
                    )}
                  >
                    <div
                      className="h-full bg-[#6E6C7C]/15"
                      style={{ width: `${width}%` }}
                      aria-label={`${row.sessions} sessions`}
                    />
                    <div className="absolute inset-0 flex items-center gap-1 overflow-hidden px-2">
                      <span className="min-w-0 flex-1 truncate font-mono text-[11px] font-medium text-[#3D3B4F]">
                        {rowPaths[0] || '/'}
                      </span>
                      {rowPaths.slice(1).map((path, index) => (
                        <div
                          key={`${path}-${index}`}
                          className="flex min-w-0 flex-1 items-center gap-1"
                        >
                          <ChevronRight className="h-3 w-3 shrink-0 text-[#9B9590]" />
                          <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-[#6E6C7C]">
                            {path}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="mb-6 overflow-hidden rounded-xl bg-[#252434] text-white">
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-white/10 px-5 py-4">
        <div>
          <div className="flex items-center gap-2">
            <Route className="h-4 w-4 text-[#C7D2FE]" />
            <h3 className="text-[15px] font-bold text-white">User Route Corridors</h3>
          </div>
          <p className="mt-1 max-w-3xl text-[12px] leading-5 text-[#AAA7BA]">
            Follow the strongest corridors from entry page to next page and three-step sequence.
            Then open any session to replay its pageviews and deep engagement signals in exact
            order.
          </p>
        </div>
        <div className="flex gap-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-[#C9C7D8]">
          <span className="rounded-full border border-white/15 px-2.5 py-1">Entry</span>
          <span className="rounded-full border border-white/15 px-2.5 py-1">Transition</span>
          <span className="rounded-full border border-white/15 px-2.5 py-1">Sequence</span>
        </div>
      </div>
      <div className="grid gap-3 p-5 xl:grid-cols-3">
        {renderGroup('Top entry pages', groups.entries, row => [row.fromPath || '/'], true)}
        {renderGroup('Next-page transitions', groups.transitions, row =>
          [row.fromPath, row.toPath].filter(Boolean)
        )}
        {renderGroup('Three-step sequences', groups.sequences, row =>
          [row.fromPath, row.toPath, row.thirdPath].filter(Boolean)
        )}
      </div>
    </div>
  );
}

function PathsView({
  siteId,
  period,
  filters,
  filterKey,
}: {
  siteId: string;
  period: Period;
  filters: AnalyticsFilters;
  filterKey: string;
}): ReactElement {
  const [selectedSession, setSelectedSession] = useState<SessionSummary | null>(null);
  const [query, setQuery] = useState('');

  const sessionsQ = useQuery({
    queryKey: ['site-analytics', siteId, 'paths-page', period, filterKey],
    queryFn: async () => api.getSessions(siteId, period, filters),
    staleTime: period === 'today' ? 15_000 : 60_000,
    refetchInterval: period === 'today' ? 15_000 : false,
  });
  const flowsQ = useQuery({
    queryKey: ['site-analytics', siteId, 'path-flows', period, filterKey],
    queryFn: async () => api.getPathFlows(siteId, period, filters),
    staleTime: period === 'today' ? 15_000 : 60_000,
    refetchInterval: period === 'today' ? 15_000 : false,
  });
  const journeyQ = useQuery({
    queryKey: [
      'site-analytics',
      siteId,
      'paths-page-journey',
      period,
      filterKey,
      selectedSession?.sessionId,
    ],
    queryFn: async () =>
      api.getSessionJourney(siteId, period, selectedSession?.sessionId ?? '', filters),
    enabled: selectedSession !== null,
    staleTime: period === 'today' ? 15_000 : 60_000,
  });

  const sessions = useMemo(
    () => (sessionsQ.data as { data?: SessionSummary[] } | undefined)?.data ?? [],
    [sessionsQ.data]
  );
  const filteredSessions = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return sessions;
    return sessions.filter(session =>
      [session.entryPath, session.exitPath, session.country, session.city, session.referrerHostname]
        .filter(Boolean)
        .some(value => value!.toLowerCase().includes(needle))
    );
  }, [sessions, query]);
  const pathFlows = useMemo(
    () => (flowsQ.data as { data?: PathFlowRow[] } | undefined)?.data ?? [],
    [flowsQ.data]
  );
  const steps = useMemo(
    () => (journeyQ.data as { data?: JourneyStep[] } | undefined)?.data ?? [],
    [journeyQ.data]
  );

  const header = (
    <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
      <div>
        <h3 className="text-[15px] font-bold tracking-[-0.01em] text-[#3D3B4F]">User Paths</h3>
        <p className="mt-0.5 text-[12px] text-[#9B9590]">
          {sessions.length} sessions · click a session to replay its full pageview and event
          timeline.
        </p>
      </div>
      <div className="relative w-full sm:w-72">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[#B5B0AA]" />
        <Input
          value={query}
          onChange={event => setQuery(event.target.value)}
          placeholder="Search sessions"
          className="h-9 pl-9 text-[13px]"
        />
      </div>
    </div>
  );

  return (
    <div className="rounded-[20px] bg-white p-6 shadow-float">
      {selectedSession === null ? (
        <>
          <PathFlowsPanel rows={pathFlows} />
          {flowsQ.isError && (
            <div className="mb-4 flex items-center gap-2 rounded-lg bg-[#FFF7ED] px-3 py-2 text-[12px] text-[#9A3412]">
              <TriangleAlert className="h-3.5 w-3.5" /> Aggregated path flow is unavailable right
              now.
            </div>
          )}
          {header}
          {sessionsQ.isError ? (
            <div className="flex min-h-[18rem] flex-col items-center justify-center">
              <AlertCircle className="mb-2 h-5 w-5 text-[#e07a5f]/60" strokeWidth={1.5} />
              <p className="text-[13px] text-[#e07a5f]">Couldn&rsquo;t load user paths</p>
            </div>
          ) : sessionsQ.isLoading ? (
            <div className="space-y-2.5">
              {[95, 78, 62, 48].map((width, index) => (
                <div
                  key={index}
                  className="h-10 animate-pulse rounded-lg bg-muted"
                  style={{ width: `${width}%` }}
                />
              ))}
            </div>
          ) : filteredSessions.length === 0 ? (
            <EmptyState label={query ? 'No matching sessions' : 'No sessions yet'} />
          ) : (
            <div className="divide-y divide-[#F2F1ED]">
              {filteredSessions.map(session => (
                <button
                  key={session.sessionId}
                  onClick={() => setSelectedSession(session)}
                  className="group flex w-full items-center gap-4 rounded-xl px-3 py-3 text-left transition-colors hover:bg-[#F9F8F6]"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-[13px] font-medium text-[#3D3B4F]">
                        {session.entryPath || '/'}
                      </span>
                      {session.exitPath && session.exitPath !== session.entryPath && (
                        <>
                          <span className="text-[#B5B0AA]">→</span>
                          <span className="truncate text-[13px] text-[#6E6C7C]">
                            {session.exitPath}
                          </span>
                        </>
                      )}
                    </div>
                    <SessionMeta session={session} />
                  </div>
                  <div className="flex shrink-0 items-center gap-4 text-[12px] text-[#9B9590]">
                    <span className="text-[11px]">{formatDate(session.startedAt)}</span>
                    <span className="tabular-nums">
                      {session.pageviews} views · {session.events} events
                    </span>
                    <ChevronRight className="h-4 w-4 text-[#B5B0AA] transition-transform group-hover:translate-x-0.5" />
                  </div>
                </button>
              ))}
            </div>
          )}
        </>
      ) : (
        <>
          <div className="mb-5 flex items-center justify-between gap-3">
            <div className="min-w-0">
              <button
                onClick={() => setSelectedSession(null)}
                className="mb-3 rounded-full bg-muted px-3 py-1 text-[11px] font-semibold text-[#3D3B4F] transition-colors hover:bg-[#E6E4DE]"
              >
                ← All sessions
              </button>
              <h3 className="truncate text-[15px] font-bold tracking-[-0.01em] text-[#3D3B4F]">
                {selectedSession.entryPath || '/'} → {selectedSession.exitPath || '/'}
              </h3>
              <SessionMeta session={selectedSession} />
            </div>
            <button
              onClick={() => void journeyQ.refetch()}
              className="flex h-8 w-8 items-center justify-center rounded-full bg-muted text-[#6E6C7C] transition-colors hover:bg-[#E6E4DE]"
              title="Refresh timeline"
            >
              <RefreshCw className={cn('h-3.5 w-3.5', journeyQ.isFetching && 'animate-spin')} />
            </button>
          </div>
          {journeyQ.isError ? (
            <div className="flex min-h-[16rem] flex-col items-center justify-center">
              <AlertCircle className="mb-2 h-5 w-5 text-[#e07a5f]/60" strokeWidth={1.5} />
              <p className="text-[13px] text-[#e07a5f]">Couldn&rsquo;t load this session</p>
            </div>
          ) : journeyQ.isLoading ? (
            <div className="space-y-2.5">
              {[85, 70, 55, 42].map((width, index) => (
                <div
                  key={index}
                  className="h-9 animate-pulse rounded-lg bg-muted"
                  style={{ width: `${width}%` }}
                />
              ))}
            </div>
          ) : (
            <Timeline steps={steps} />
          )}
        </>
      )}
    </div>
  );
}

export function EventsPathsExplorer({
  siteId,
  period,
  filters,
}: {
  siteId: string;
  period: Period;
  filters: AnalyticsFilters;
}): ReactElement {
  const [view, setView] = useState<ExplorerView>('events');
  const filterKey = JSON.stringify(filters);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-[17px] font-bold tracking-[-0.01em] text-[#3D3B4F]">
          Journey Tracking
        </h2>
        <div className="inline-flex rounded-full border border-[#E6E4DE] bg-white p-1">
          {[
            { key: 'events', label: 'All Events', Icon: Layers },
            { key: 'paths', label: 'User Paths', Icon: Route },
          ].map(option => (
            <button
              key={option.key}
              onClick={() => setView(option.key as ExplorerView)}
              className={cn(
                'flex items-center gap-1.5 rounded-full px-4 py-1.5 text-[12px] font-medium transition-all cursor-pointer',
                view === option.key
                  ? 'bg-[#3D3B4F] text-white font-semibold'
                  : 'text-[#9B9590] hover:text-[#6b6560]'
              )}
            >
              <option.Icon className="h-3.5 w-3.5" />
              {option.label}
            </button>
          ))}
        </div>
      </div>
      {view === 'events' ? (
        <EventsView
          siteId={siteId}
          period={period}
          filters={filters}
          filterKey={filterKey}
          onOpenPaths={() => setView('paths')}
        />
      ) : (
        <PathsView siteId={siteId} period={period} filters={filters} filterKey={filterKey} />
      )}
    </div>
  );
}
