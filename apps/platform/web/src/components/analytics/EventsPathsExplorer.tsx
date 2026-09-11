import { useMemo, useState, type ReactElement } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Activity,
  AlertCircle,
  BarChart3,
  ChevronRight,
  Clock,
  FileText,
  MapPin,
  MousePointer2,
  RefreshCw,
  Search,
} from 'lucide-react';
import type { Period } from '@traks/shared';
import { cn, formatNumber } from '@/lib/utils';
import { Input } from '@/components/ui/input';
import { api, type AnalyticsFilters } from '@/lib/api';

interface EventRow {
  name: string;
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

type ExplorerView = 'events' | 'paths';

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
        const title = isPage ? step.pathname || '/' : step.eventName || 'Event';
        const detail = isPage ? '' : step.pathname;
        const meta = parseMeta(step.eventMeta);
        return (
          <li key={`${step.ts}-${index}`} className="relative flex gap-3 pb-5 last:pb-0">
            <div className="flex flex-col items-center">
              <span
                className={cn(
                  'mt-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-full',
                  isPage ? 'bg-[#F2F1ED] text-[#6E6C7C]' : 'bg-[#3D3B4F] text-white'
                )}
              >
                {isPage ? <FileText className="h-3 w-3" /> : <MousePointer2 className="h-3 w-3" />}
              </span>
              {index < steps.length - 1 && <span className="mt-1 w-px flex-1 bg-[#E6E4DE]" />}
            </div>
            <div className="min-w-0 flex-1 pt-0.5">
              <div className="flex items-baseline justify-between gap-3">
                <p className="truncate text-[13px] font-medium text-[#3D3B4F]">{title}</p>
                <span className="shrink-0 text-[11px] tabular-nums text-[#B5B0AA]">
                  {formatTime(step.ts)}
                </span>
              </div>
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
}: {
  siteId: string;
  period: Period;
  filters: AnalyticsFilters;
  filterKey: string;
}): ReactElement {
  const [query, setQuery] = useState('');
  const [selectedEvent, setSelectedEvent] = useState<string | null>(null);

  const eventsQ = useQuery({
    queryKey: ['site-analytics', siteId, 'events-page', period, filterKey],
    queryFn: async () => api.getEvents(siteId, period, filters),
    staleTime: period === 'today' ? 15_000 : 60_000,
    refetchInterval: period === 'today' ? 15_000 : false,
  });

  const propsQ = useQuery({
    queryKey: ['site-analytics', siteId, 'events-page-props', period, filterKey, selectedEvent],
    queryFn: async () => api.getEventProps(siteId, period, selectedEvent!, filters),
    enabled: selectedEvent !== null,
    staleTime: period === 'today' ? 15_000 : 60_000,
  });

  const allEvents = useMemo(
    () => (eventsQ.data as { data?: EventRow[] } | undefined)?.data ?? [],
    [eventsQ.data]
  );
  const filteredEvents = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return allEvents;
    return allEvents.filter(event => event.name.toLowerCase().includes(needle));
  }, [allEvents, query]);
  const props = useMemo(
    () => (propsQ.data as { data?: EventPropRow[] } | undefined)?.data ?? [],
    [propsQ.data]
  );

  if (selectedEvent !== null) {
    return (
      <div className="rounded-[20px] bg-white p-6 shadow-float">
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <h3 className="truncate text-[15px] font-bold tracking-[-0.01em] text-[#3D3B4F]">
              {selectedEvent}
            </h3>
            <p className="mt-0.5 text-[12px] text-[#9B9590]">
              Property values for this custom event.
            </p>
          </div>
          <button
            onClick={() => setSelectedEvent(null)}
            className="rounded-full bg-muted px-3 py-1 text-[11px] font-semibold text-foreground transition-colors hover:bg-[#E6E4DE]"
          >
            ← All events
          </button>
        </div>
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

  return (
    <div className="rounded-[20px] bg-white p-6 shadow-float">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-[15px] font-bold tracking-[-0.01em] text-[#3D3B4F]">
            All Custom Events
          </h3>
          <p className="mt-0.5 text-[12px] text-[#9B9590]">
            {allEvents.length} event names · click any event to inspect properties.
          </p>
        </div>
        <div className="relative w-full sm:w-72">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[#B5B0AA]" />
          <Input
            value={query}
            onChange={event => setQuery(event.target.value)}
            placeholder="Search events"
            className="h-9 pl-9 text-[13px]"
          />
        </div>
      </div>
      {eventsQ.isError ? (
        <div className="flex min-h-[18rem] flex-col items-center justify-center">
          <AlertCircle className="mb-2 h-5 w-5 text-[#e07a5f]/60" strokeWidth={1.5} />
          <p className="text-[13px] text-[#e07a5f]">Couldn&rsquo;t load custom events</p>
        </div>
      ) : eventsQ.isLoading ? (
        <EventSkeleton />
      ) : filteredEvents.length === 0 ? (
        <EmptyState label={query ? 'No matching events' : 'No custom events yet'} />
      ) : (
        <Rows
          header="Event"
          valueHeader="Count"
          secondaryHeader="Total value"
          rows={filteredEvents.map(event => ({
            name: event.name,
            value: event.count,
            secondary: event.totalValue,
            detail: undefined,
          }))}
          onClick={item => setSelectedEvent(item.name)}
        />
      )}
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

function EmptyState({ label }: { label: string }): ReactElement {
  return (
    <div className="flex min-h-[18rem] flex-col items-center justify-center">
      <BarChart3 className="mb-2 h-5 w-5 text-[#B5B0AA]" strokeWidth={1.5} />
      <p className="text-[13px] font-medium text-[#9B9590]">{label}</p>
      <p className="mt-1 text-[12px] text-[#B5B0AA]">Data will appear once visitors arrive</p>
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
      <div className="inline-flex rounded-full border border-[#E6E4DE] bg-white p-1">
        {[
          { key: 'events', label: 'All Events' },
          { key: 'paths', label: 'User Paths' },
        ].map(option => (
          <button
            key={option.key}
            onClick={() => setView(option.key as ExplorerView)}
            className={cn(
              'rounded-full px-4 py-1.5 text-[12px] font-medium transition-all cursor-pointer',
              view === option.key
                ? 'bg-[#3D3B4F] text-white font-semibold'
                : 'text-[#9B9590] hover:text-[#6b6560]'
            )}
          >
            {option.label}
          </button>
        ))}
      </div>
      {view === 'events' ? (
        <EventsView siteId={siteId} period={period} filters={filters} filterKey={filterKey} />
      ) : (
        <PathsView siteId={siteId} period={period} filters={filters} filterKey={filterKey} />
      )}
    </div>
  );
}
