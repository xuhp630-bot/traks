import { useMemo, useState, type ReactElement } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Activity,
  AlertCircle,
  ChevronRight,
  Clock,
  FileText,
  MapPin,
  MousePointer2,
  RefreshCw,
} from 'lucide-react';
import type { Period } from '@traks/shared';
import { cn } from '@/lib/utils';
import { api, type AnalyticsFilters } from '@/lib/api';

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
    // Fall through to raw meta.
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

function JourneyTimeline({ steps }: { steps: JourneyStep[] }): ReactElement {
  if (steps.length === 0) {
    return (
      <div className="flex items-center gap-2 rounded-xl bg-muted px-4 py-3 text-[12px] text-[#9B9590]">
        <FileText className="h-4 w-4" /> This session has no pageviews or events in the selected
        range.
      </div>
    );
  }

  return (
    <ol className="space-y-0">
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

export function JourneyExplorer({
  siteId,
  period,
  filters,
  enabled,
}: {
  siteId: string;
  period: Period;
  filters?: AnalyticsFilters;
  enabled: boolean;
}): ReactElement {
  const [selectedSession, setSelectedSession] = useState<SessionSummary | null>(null);

  const sessionsQ = useQuery({
    queryKey: ['site-analytics', siteId, 'sessions', period, filters],
    queryFn: async () => api.getSessions(siteId, period, filters),
    staleTime: period === 'today' ? 15_000 : 60_000,
    refetchInterval: period === 'today' ? 15_000 : false,
    enabled,
  });

  const journeyQ = useQuery({
    queryKey: ['site-analytics', siteId, 'session-journey', period, selectedSession?.sessionId],
    queryFn: async () =>
      api.getSessionJourney(siteId, period, selectedSession?.sessionId ?? '', filters),
    enabled: enabled && selectedSession !== null,
  });

  const sessions = useMemo(
    () => (sessionsQ.data as { data?: SessionSummary[] } | undefined)?.data ?? [],
    [sessionsQ.data]
  );
  const steps = useMemo(
    () => (journeyQ.data as { data?: JourneyStep[] } | undefined)?.data ?? [],
    [journeyQ.data]
  );

  return (
    <div className="rounded-[20px] bg-white p-6 shadow-float">
      <div className="mb-5 flex items-center justify-between gap-3">
        <div>
          <h3 className="text-[15px] font-bold tracking-[-0.01em] text-[#3D3B4F]">User Paths</h3>
          <p className="mt-0.5 text-[12px] text-[#9B9590]">
            Click a session to replay its pageview and event timeline.
          </p>
        </div>
        <button
          onClick={() => {
            void sessionsQ.refetch();
            void journeyQ.refetch();
          }}
          className="flex h-8 w-8 items-center justify-center rounded-full bg-muted text-[#6E6C7C] transition-colors hover:bg-[#E6E4DE]"
          title="Refresh sessions"
        >
          <RefreshCw className={cn('h-3.5 w-3.5', sessionsQ.isFetching && 'animate-spin')} />
        </button>
      </div>

      {sessionsQ.isError || journeyQ.isError ? (
        <div className="flex min-h-[14rem] flex-col items-center justify-center">
          <AlertCircle className="mb-2 h-5 w-5 text-[#e07a5f]/60" strokeWidth={1.5} />
          <p className="text-[13px] text-[#e07a5f]">Couldn&rsquo;t load user paths</p>
        </div>
      ) : sessionsQ.isLoading || !sessionsQ.data ? (
        <div className="space-y-2.5">
          {[95, 78, 62, 48].map((w, i) => (
            <div
              key={i}
              className="h-10 animate-pulse rounded-lg bg-muted"
              style={{ width: `${w}%` }}
            />
          ))}
        </div>
      ) : selectedSession === null ? (
        sessions.length === 0 ? (
          <div className="flex min-h-[14rem] flex-col items-center justify-center">
            <Activity className="mb-2 h-5 w-5 text-[#B5B0AA]" strokeWidth={1.5} />
            <p className="text-[13px] font-medium text-[#9B9590]">No sessions yet</p>
            <p className="mt-1 text-[12px] text-[#B5B0AA]">
              Paths will appear once visitors arrive
            </p>
          </div>
        ) : (
          <div className="divide-y divide-[#F2F1ED]">
            {sessions.map(session => (
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
        )
      ) : (
        <div>
          <button
            onClick={() => setSelectedSession(null)}
            className="mb-4 rounded-full bg-muted px-3 py-1 text-[11px] font-semibold text-[#3D3B4F] transition-colors hover:bg-[#E6E4DE]"
          >
            ← All sessions
          </button>
          <div className="mb-4 rounded-2xl bg-[#F9F8F6] px-4 py-3">
            <div className="flex items-center gap-2">
              <span className="truncate text-[13px] font-semibold text-[#3D3B4F]">
                {selectedSession.entryPath || '/'}
              </span>
              <span className="text-[#B5B0AA]">→</span>
              <span className="truncate text-[13px] text-[#6E6C7C]">
                {selectedSession.exitPath || '/'}
              </span>
            </div>
            <SessionMeta session={selectedSession} />
          </div>
          {journeyQ.isLoading ? (
            <div className="space-y-2.5">
              {[85, 70, 55, 42].map((w, i) => (
                <div
                  key={i}
                  className="h-9 animate-pulse rounded-lg bg-muted"
                  style={{ width: `${w}%` }}
                />
              ))}
            </div>
          ) : (
            <JourneyTimeline steps={steps} />
          )}
        </div>
      )}
    </div>
  );
}
