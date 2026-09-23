import { useState, type FormEvent, type ReactElement } from 'react';
import { createLazyFileRoute } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid } from 'recharts';
import {
  Radar,
  ExternalLink,
  RefreshCw,
  Plus,
  Trash2,
  ShieldCheck,
  AlertTriangle,
} from 'lucide-react';
import type { CompetitorCheck, CompetitorSnapshot } from '@traks/shared';
import { api } from '@/lib/api';
import { useWorkspace } from '@/lib/workspace';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

export const Route = createLazyFileRoute('/portal/competitors')({ component: CompetitorsPage });
const controlClass = 'min-h-11 w-full rounded-lg border border-[#E3E2E6] bg-white px-3 text-sm';
const formatTime = (timestamp: number | null): string =>
  timestamp ? new Date(timestamp).toLocaleString() : '尚未检查';
const labels: Record<keyof CompetitorSnapshot, string> = {
  title: '标题',
  h1: 'H1',
  description: '页面描述',
  canonical: 'Canonical',
  robots: 'Meta robots',
  regionText: '区域摘录（最多600字符）',
  contentHash: '区域正文指纹',
  contentCharacters: '区域字符数',
};
const statusLabels = {
  baseline: '首次基线',
  unchanged: '未见变化',
  changed: '发现变化',
  error: '检查失败',
};
const errors: Record<string, string> = {
  host_not_approved: '主机尚未获管理员批准',
  robots_denied: 'robots.txt 不允许抓取',
  robots_unavailable: 'robots.txt 不可读或跳转，已停止',
  crawl_delay_requires_external_service: '此站要求 crawl-delay，请使用支持该规则的外部监控服务',
  selector_missing_or_empty: '所选区域缺失或为空，未生成比较',
  redirect_not_followed: '目标跳转，未自动跟随，请人工核实最终URL',
  rate_limited: '目标限流，未自动重试',
  http_error: '目标返回HTTP错误',
  html_required: '不是HTML页面',
  response_too_large: '页面超过读取上限',
  dns_non_public: 'DNS包含非公网地址，已阻止',
  dns_unavailable: '无法确认公网DNS',
  network_or_parse_error: '网络、超时或解析失败，未覆盖成功基线',
};

function ErrorNotice({ error }: { error: unknown }): ReactElement {
  return (
    <p role="alert" className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800">
      {error instanceof Error ? error.message : '读取失败，请重试。'}
    </p>
  );
}

function CompetitorsPage(): ReactElement {
  const { current, isLoading } = useWorkspace();
  const [selection, setSelection] = useState('');
  const sites = useQuery({
    queryKey: ['sites', current?.id],
    queryFn: () => api.getSites(current!.id),
    enabled: !!current,
  });
  const siteRows = (sites.data?.data ?? []) as { id: string; name: string; domain: string }[];
  const selected = siteRows.find(site => site.id === selection)?.id ?? siteRows[0]?.id;
  return (
    <main className="mx-auto max-w-6xl space-y-6 px-4 py-8 sm:px-6">
      <div className="flex flex-col justify-between gap-5 sm:flex-row sm:items-end">
        <div>
          <p className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-widest text-[#6F6D7A]">
            <Radar size={16} /> Competitive intelligence
          </p>
          <h1 className="text-3xl font-semibold tracking-tight text-[#3D3B4F]">竞品监控</h1>
          <p className="mt-2 max-w-xl text-sm leading-6 text-[#6F6D7A]">
            看清公开页面发生了什么变化，再决定自己的下一步。与本站埋点、流量及转化数据独立。
          </p>
        </div>
        <label className="w-full text-xs text-[#6F6D7A] sm:w-64">
          归属己方站点
          <select
            aria-label="归属己方站点"
            className={`${controlClass} mt-2`}
            value={selected ?? ''}
            onChange={event => setSelection(event.target.value)}
            disabled={!siteRows.length}
          >
            {!siteRows.length && <option value="">暂无站点</option>}
            {siteRows.map(site => (
              <option key={site.id} value={site.id}>
                {site.name} · {site.domain}
              </option>
            ))}
          </select>
        </label>
      </div>
      {isLoading || sites.isLoading ? (
        <p role="status">正在加载站点…</p>
      ) : sites.error ? (
        <>
          <ErrorNotice error={sites.error} />
          <Button variant="outline" onClick={() => void sites.refetch()}>
            重试站点列表
          </Button>
        </>
      ) : !selected ? (
        <p className="rounded-2xl border bg-white p-8 text-sm">
          请先在 Sites 添加自己的站点，再建立独立竞品清单。不要给竞品安装本站追踪脚本。
        </p>
      ) : (
        <MonitorPanel key={`${current?.id}:${selected}`} siteId={selected} />
      )}
    </main>
  );
}

function MonitorPanel({ siteId }: { siteId: string }): ReactElement {
  const client = useQueryClient();
  const report = useQuery({
    queryKey: ['competitors', siteId],
    queryFn: () => api.getCompetitors(siteId),
    retry: false,
  });
  const [active, setActive] = useState('');
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [selector, setSelector] = useState('main');
  const [cadence, setCadence] = useState('manual');
  const mutation = useMutation({
    mutationFn: (action: { suffix: string; method: 'POST' | 'PATCH' | 'DELETE'; body?: object }) =>
      api.mutateCompetitor(siteId, action.suffix, action.method, action.body),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['competitors', siteId] });
      void client.invalidateQueries({ queryKey: ['competitor-history', siteId] });
    },
  });
  const data = report.data?.data;
  const selected = data?.monitors.find(monitor => monitor.id === active) ?? data?.monitors[0];
  const history = useQuery({
    queryKey: ['competitor-history', siteId, selected?.id],
    queryFn: () => api.getCompetitorHistory(siteId, selected!.id),
    enabled: !!selected,
    retry: false,
  });
  const refresh = (): void => {
    void report.refetch();
    if (selected) void history.refetch();
  };
  const add = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    try {
      await mutation.mutateAsync({
        suffix: '',
        method: 'POST',
        body: { name, url, selector, cadence },
      });
      setName('');
      setUrl('');
    } catch {
      return;
    }
  };
  const totals = data?.trend.reduce(
    (sum, day) => ({
      checks: sum.checks + day.checks,
      changes: sum.changes + (day.changes ?? 0),
      failures: sum.failures + (day.failures ?? 0),
    }),
    { checks: 0, changes: 0, failures: 0 }
  );
  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-[#6F6D7A]">
        <span>
          公开HTML观察 · 不含竞品访问量、客户名单或转化率{' '}
          {data && `· 数据读取 ${formatTime(data.generatedAt)}`}
        </span>
        <Button
          variant="outline"
          onClick={refresh}
          disabled={report.isFetching || history.isFetching}
        >
          <RefreshCw size={14} className="mr-2" />
          刷新已有证据
        </Button>
      </div>
      {report.error && <ErrorNotice error={report.error} />}
      {mutation.error && <ErrorNotice error={mutation.error} />}
      {mutation.isPending && (
        <p role="status" className="text-sm text-[#6F6D7A]">
          正在执行操作，请勿重复提交。页面检查通常需要数秒，网络读取上限20秒。
        </p>
      )}
      {report.isLoading && <p role="status">正在读取监控清单…</p>}
      {data && (
        <>
          <section
            className="overflow-hidden rounded-2xl border border-[#E3E2E6] bg-white p-5 sm:p-6"
            aria-label="竞品变化趋势"
          >
            <div className="mb-6 flex flex-wrap items-start justify-between gap-5">
              <div>
                <h2 className="text-lg font-semibold text-[#3D3B4F]">最近30日 · 变化与读取健康</h2>
                <p className="mt-1 text-xs text-[#6F6D7A]">
                  UTC，含今天部分日；每页仅保留60次。无观测的日期不是“无变化”。
                </p>
              </div>
              <div className="flex gap-7">
                {[
                  ['检查', totals?.checks],
                  ['变化', totals && totals.checks > totals.failures ? totals.changes : '—'],
                  ['失败', totals?.failures],
                ].map(([label, count]) => (
                  <div key={label}>
                    <p className="text-xs text-[#6F6D7A]">{label}</p>
                    <p className="mt-1 text-2xl font-semibold">{totals?.checks ? count : '—'}</p>
                  </div>
                ))}
              </div>
            </div>
            {totals?.checks ? (
              <div className="h-52 w-full min-w-0">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={data.trend}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} />
                    <XAxis
                      dataKey="date"
                      tickFormatter={value => String(value).slice(5)}
                      minTickGap={28}
                      fontSize={11}
                    />
                    <YAxis allowDecimals={false} width={26} fontSize={11} />
                    <Tooltip />
                    <Bar dataKey="changes" name="变化检查数" fill="#6b8ead" radius={[3, 3, 0, 0]} />
                    <Bar
                      dataKey="failures"
                      name="失败检查数"
                      fill="#e07a5f"
                      radius={[3, 3, 0, 0]}
                    />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            ) : (
              <div className="flex h-36 items-center justify-center rounded-xl bg-[#F9F8F6] text-sm text-[#6F6D7A]">
                还没有观测记录。先添加页面，再完成一次获准检查。
              </div>
            )}
          </section>
          <div className="grid gap-4 text-sm md:grid-cols-2">
            <div className="flex gap-3 rounded-xl border border-[#E3E2E6] bg-white p-4">
              <ShieldCheck className="shrink-0 text-[#6b8ead]" size={20} />
              <div>
                <p className="font-medium">受控公开采集</p>
                <p className="mt-1 break-words text-xs leading-5 text-[#6F6D7A]">
                  {data.allowedHosts.length
                    ? `已批准主机：${data.allowedHosts.join('、')}`
                    : '尚未批准采集主机。可先建清单；管理员需配置 COMPETITOR_ALLOWED_HOSTS，才会读取目标页面。'}
                </p>
              </div>
            </div>
            <div className="flex gap-3 rounded-xl border border-[#E3E2E6] bg-white p-4">
              <AlertTriangle className="shrink-0 text-[#e07a5f]" size={20} />
              <div>
                <p className="font-medium">自动执行{data.schedulerEnabled ? '已启用' : '未启用'}</p>
                <p className="mt-1 text-xs leading-5 text-[#6F6D7A]">
                  {data.schedulerEnabled
                    ? '按记录频率与现有cron处理到期页面，不保证固定时间。'
                    : '每日/每周设置只有在管理员开启调度后生效。'}{' '}
                  同域15分钟冷却，不发送邮件。{!data.canManage && ' 当前账号仅可读取。'}
                </p>
              </div>
            </div>
          </div>
          {data.canManage && (
            <form
              onSubmit={event => void add(event)}
              className="rounded-2xl border border-[#E3E2E6] bg-white p-5"
            >
              <h2 className="mb-4 font-semibold">
                添加公开页面{' '}
                <span className="text-xs font-normal text-[#6F6D7A]">
                  {data.monitors.length}/20
                </span>
              </h2>
              <fieldset
                disabled={mutation.isPending || data.monitors.length >= 20}
                className="grid items-end gap-3 sm:grid-cols-2 lg:grid-cols-5"
              >
                <label className="text-xs">
                  竞品 / 页面名称
                  <Input
                    className="mt-2 min-h-11"
                    value={name}
                    onChange={event => setName(event.target.value)}
                    required
                    maxLength={80}
                    placeholder="品牌 · 定价页"
                  />
                </label>
                <label className="text-xs lg:col-span-2">
                  公开 HTTPS URL
                  <Input
                    className="mt-2 min-h-11"
                    value={url}
                    onChange={event => setUrl(event.target.value)}
                    required
                    maxLength={500}
                    type="url"
                    placeholder="https://competitor.example.com/pricing"
                  />
                </label>
                <label className="text-xs">
                  SSR 区域
                  <Input
                    className="mt-2 min-h-11"
                    value={selector}
                    onChange={event => setSelector(event.target.value)}
                    required
                    maxLength={80}
                    placeholder="main / .pricing / #plans"
                  />
                </label>
                <label className="text-xs">
                  检查频率
                  <select
                    className={`${controlClass} mt-2`}
                    value={cadence}
                    onChange={event => setCadence(event.target.value)}
                  >
                    <option value="manual">手动</option>
                    <option value="daily">每日</option>
                    <option value="weekly">每周</option>
                  </select>
                </label>
                <div className="sm:col-span-2 lg:col-span-5 flex flex-wrap items-center justify-between gap-3">
                  <p className="text-xs leading-5 text-[#6F6D7A]">
                    填写公开页面URL，不是sitemap.xml；Sitemap目前只用于选页，不自动订阅。不要输入个人信息、登录/支付页或带凭据参数的URL。首个成功样本只建立基线。
                  </p>
                  <Button type="submit">
                    <Plus size={16} className="mr-2" />
                    添加监控
                  </Button>
                </div>
              </fieldset>
            </form>
          )}
          <div className="grid gap-5 lg:grid-cols-[minmax(0,340px)_minmax(0,1fr)]">
            <section aria-label="监控页面" className="min-w-0 space-y-3">
              <h2 className="font-semibold">页面清单</h2>
              {!data.monitors.length && (
                <p className="rounded-xl border bg-white p-6 text-sm text-[#6F6D7A]">
                  尚未添加竞品页面。
                </p>
              )}
              {data.monitors.map(monitor => (
                <article
                  key={monitor.id}
                  className={`rounded-xl border bg-white p-4 ${selected?.id === monitor.id ? 'border-[#6b8ead] ring-1 ring-[#6b8ead]/20' : 'border-[#E3E2E6]'}`}
                >
                  <button
                    type="button"
                    className="w-full break-words text-left font-semibold"
                    onClick={() => setActive(monitor.id)}
                    aria-pressed={selected?.id === monitor.id}
                  >
                    {monitor.name}
                  </button>
                  <a
                    className="mt-2 flex items-center gap-1 break-all text-xs text-[#6F6D7A]"
                    href={monitor.url}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {monitor.url}
                    <ExternalLink size={12} className="shrink-0" />
                  </a>
                  <p className="mt-3 text-xs">
                    {monitor.latest ? statusLabels[monitor.latest.status] : '未检查'} ·{' '}
                    {formatTime(monitor.lastCheckedAt)}
                  </p>
                  <p className="mt-1 text-xs text-[#6F6D7A]">
                    区域 {monitor.selector} · 保留 {monitor.retainedChecks}/60 次
                    {monitor.nextCheckAt ? ` · 计划不早于 ${formatTime(monitor.nextCheckAt)}` : ''}
                  </p>
                  {data.canManage && (
                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={
                          mutation.isPending || !data.allowedHosts.includes(monitor.hostname)
                        }
                        onClick={() =>
                          mutation.mutate({
                            suffix: `/${encodeURIComponent(monitor.id)}/check`,
                            method: 'POST',
                          })
                        }
                      >
                        检查一次
                      </Button>
                      <select
                        aria-label={`${monitor.name}检查频率`}
                        value={monitor.cadence}
                        disabled={mutation.isPending}
                        onChange={event =>
                          mutation.mutate({
                            suffix: `/${encodeURIComponent(monitor.id)}`,
                            method: 'PATCH',
                            body: { cadence: event.target.value },
                          })
                        }
                        className="min-h-9 rounded-md border px-2 text-xs"
                      >
                        <option value="manual">手动</option>
                        <option value="daily">每日</option>
                        <option value="weekly">每周</option>
                      </select>
                      <button
                        type="button"
                        aria-label={`删除${monitor.name}`}
                        disabled={mutation.isPending}
                        onClick={() => {
                          if (window.confirm(`删除“${monitor.name}”及全部保留快照？`))
                            mutation.mutate({
                              suffix: `/${encodeURIComponent(monitor.id)}`,
                              method: 'DELETE',
                            });
                        }}
                        className="min-h-9 rounded-md p-2 text-[#9B9590] hover:text-red-700"
                      >
                        <Trash2 size={15} />
                      </button>
                    </div>
                  )}
                </article>
              ))}
            </section>
            <section className="min-w-0 space-y-3" aria-label="变化证据">
              <h2 className="font-semibold">
                {selected ? `${selected.name} · 证据记录` : '证据记录'}
              </h2>
              {history.error && <ErrorNotice error={history.error} />}
              {history.isFetching && (
                <p role="status" className="text-sm text-[#6F6D7A]">
                  正在读取证据…
                </p>
              )}
              {!history.isLoading && !history.error && !history.data?.data.checks.length && (
                <p className="rounded-xl border bg-white p-6 text-sm text-[#6F6D7A]">
                  尚无证据。失败不会被解释成竞品删除页面或零流量。
                </p>
              )}
              {history.data?.data.checks.map(check => (
                <CheckCard key={check.id} check={check} />
              ))}
            </section>
          </div>
          <p className="text-xs leading-6 text-[#6F6D7A]">
            观察盲区：不执行页面JS，不测真实访问量、转化率或用户性能。动态文案、地区、时间和A/B版本可造成差异；核实来源后再提出优化需求。价格变化需人工确认币种、周期与适用条件。MCP：get_competitor_monitors
            / get_competitor_history（只读，不触发抓取）。
          </p>
        </>
      )}
    </>
  );
}

function CheckCard({ check }: { check: CompetitorCheck }): ReactElement {
  return (
    <article className="overflow-hidden rounded-xl border border-[#E3E2E6] bg-white p-4">
      <div className="flex flex-wrap justify-between gap-2">
        <span
          className={`text-sm font-semibold ${check.status === 'error' ? 'text-red-700' : check.status === 'changed' ? 'text-[#537695]' : 'text-[#3D3B4F]'}`}
        >
          {statusLabels[check.status]}
        </span>
        <span className="text-xs text-[#6F6D7A]">
          {formatTime(check.checkedAt)} {check.httpStatus && `· HTTP ${check.httpStatus}`}
        </span>
      </div>
      {check.errorCode && (
        <p className="mt-3 break-words text-sm text-red-700">
          {errors[check.errorCode] ?? check.errorCode}
        </p>
      )}
      {check.snapshot && (
        <p className="mt-2 break-words text-sm text-[#6F6D7A]">
          {check.snapshot.title || '无标题'} · 区域 {check.snapshot.contentCharacters} 字符
        </p>
      )}
      {check.status === 'baseline' && (
        <p className="mt-2 text-xs text-[#6F6D7A]">已建立首次成功基线，不计作变化。</p>
      )}
      {check.snapshot && (
        <details className="mt-3 text-xs">
          <summary className="cursor-pointer py-2 text-[#537695]">查看本次公开摘要</summary>
          <dl className="space-y-2 rounded-lg bg-[#F9F8F6] p-3">
            {(Object.keys(labels) as (keyof CompetitorSnapshot)[])
              .filter(field => field !== 'contentHash')
              .map(field => (
                <div key={field} className="break-words">
                  <dt className="font-medium">{labels[field]}</dt>
                  <dd className="mt-1 text-[#6F6D7A]">
                    {String(check.snapshot?.[field] ?? '') || '（空）'}
                  </dd>
                </div>
              ))}
          </dl>
        </details>
      )}
      {check.changes.length > 0 && (
        <dl className="mt-4 space-y-3">
          {check.changes.map(field => (
            <div key={field} className="rounded-lg bg-[#F9F8F6] p-3">
              <dt className="mb-2 text-xs font-semibold">{labels[field]}</dt>
              {field === 'contentHash' ? (
                <dd className="text-xs text-[#6F6D7A]">
                  规范化区域文本指纹不同，请核实原页面；不自动推断新增功能或涨价。
                </dd>
              ) : (
                <dd className="grid gap-2 text-xs sm:grid-cols-2">
                  <div className="min-w-0 break-words">
                    <span className="block pb-1 text-[#9B9590]">
                      上次成功 · {formatTime(check.previousCheckedAt)}
                    </span>
                    {String(check.previous?.[field] ?? '—') || '（空）'}
                  </div>
                  <div className="min-w-0 break-words">
                    <span className="block pb-1 text-[#537695]">本次观察</span>
                    {String(check.snapshot?.[field] ?? '—') || '（空）'}
                  </div>
                </dd>
              )}
            </div>
          ))}
        </dl>
      )}
    </article>
  );
}
