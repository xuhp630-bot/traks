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
import type {
  CompetitorCheck,
  CompetitorSnapshot,
  CompetitorCategory,
  CompetitorMonitor,
  CompetitorResearchProfile,
  CompetitorResearchStatus,
} from '@traks/shared';
import { api } from '@/lib/api';
import { useWorkspace } from '@/lib/workspace';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

export const Route = createLazyFileRoute('/portal/competitors')({ component: CompetitorsPage });
const controlClass = 'min-h-11 w-full rounded-lg border border-[#E3E2E6] bg-white px-3 text-sm';
type OwnedSite = { id: string; name: string; domain: string };
type MonitorAction = { suffix: string; method: 'POST' | 'PATCH' | 'DELETE'; body?: object };
type ResearchAction = { suffix: string; method: 'POST' | 'PATCH' | 'PUT'; body?: object };
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
const researchStatusLabels: Record<CompetitorResearchStatus, string> = {
  inbox: '待整理',
  focus: '重点关注',
  watch: '持续观察',
  parked: '暂缓',
  discarded: '放弃',
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
  const sites = useQuery({
    queryKey: ['sites', current?.id],
    queryFn: () => api.getSites(current!.id),
    enabled: !!current,
  });
  const siteRows = (sites.data?.data ?? []) as OwnedSite[];
  return (
    <main className="mx-auto max-w-6xl space-y-6 px-4 py-8 sm:px-6">
      <div className="flex flex-col justify-between gap-5 sm:flex-row sm:items-end">
        <div>
          <p className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-widest text-[#6F6D7A]">
            <Radar size={16} /> Competitive intelligence
          </p>
          <h1 className="text-3xl font-semibold tracking-tight text-[#3D3B4F]">竞品分析与监控</h1>
          <p className="mt-2 max-w-xl text-sm leading-6 text-[#6F6D7A]">
            按业务分类整理，或关联自己的站点；两个维度可以组合筛选。不必先建己方网站，也能独立监控公开竞品页面。
          </p>
        </div>
        <p className="min-w-0 break-words text-sm text-[#6F6D7A]">
          工作区 · {current?.name ?? '正在加载'}
        </p>
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
      ) : !current ? (
        <p className="rounded-2xl border bg-white p-8 text-sm">
          暂无可访问工作区，请检查登录状态或联系工作区拥有者。
        </p>
      ) : (
        <MonitorPanel key={current.id} workspaceId={current.id} sites={siteRows} />
      )}
    </main>
  );
}

function MonitorPanel({
  workspaceId,
  sites,
}: {
  workspaceId: string;
  sites: OwnedSite[];
}): ReactElement {
  const client = useQueryClient();
  const [siteFilter, setSiteFilter] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [newSite, setNewSite] = useState('');
  const [newCategory, setNewCategory] = useState('');
  const [notice, setNotice] = useState('');
  const groups = useQuery({
    queryKey: ['competitor-categories', workspaceId],
    queryFn: () => api.getCompetitorCategories(workspaceId),
    retry: false,
  });
  const categories = groups.data?.data.categories ?? [];
  const report = useQuery({
    queryKey: ['competitors', workspaceId, siteFilter, categoryFilter],
    queryFn: () =>
      api.getCompetitors({
        workspaceId,
        ...(siteFilter ? { siteId: siteFilter } : {}),
        ...(categoryFilter ? { categoryId: categoryFilter } : {}),
      }),
    retry: false,
  });
  const [active, setActive] = useState('');
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [selector, setSelector] = useState('main');
  const [cadence, setCadence] = useState('manual');
  const mutation = useMutation({
    mutationFn: (action: MonitorAction) =>
      api.mutateCompetitor({ workspaceId }, action.suffix, action.method, action.body),
    onMutate: () => setNotice(''),
    onSuccess: (_, action) => {
      if (action.method === 'DELETE' && action.suffix === `/categories/${categoryFilter}`)
        setCategoryFilter('');
      if (action.method === 'DELETE' && action.suffix === `/categories/${newCategory}`)
        setNewCategory('');
      setNotice('操作已保存。清单与趋势按当前筛选刷新；若记录不在此范围，请清除筛选查看。');
      void client.invalidateQueries({ queryKey: ['competitors', workspaceId] });
      void client.invalidateQueries({ queryKey: ['competitor-history', workspaceId] });
      void client.invalidateQueries({ queryKey: ['competitor-categories', workspaceId] });
    },
  });
  const data = report.error ? undefined : report.data?.data;
  const selected = data?.monitors.find(monitor => monitor.id === active) ?? data?.monitors[0];
  const history = useQuery({
    queryKey: ['competitor-history', workspaceId, selected?.id],
    queryFn: () => api.getCompetitorHistory({ workspaceId }, selected!.id),
    enabled: !!selected,
    retry: false,
  });
  const refresh = (): void => {
    void report.refetch();
    void groups.refetch();
    if (selected) void history.refetch();
  };
  const add = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    try {
      await mutation.mutateAsync({
        suffix: '',
        method: 'POST',
        body: {
          name,
          url,
          selector,
          cadence,
          siteId: newSite || null,
          categoryId: newCategory || null,
        },
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
      <section
        aria-label="竞品范围筛选"
        className="grid gap-4 rounded-2xl border border-[#E3E2E6] bg-white p-5 sm:grid-cols-[1fr_1fr_auto] sm:items-end"
      >
        <label className="min-w-0 text-xs">
          按分类查看
          <select
            aria-label="按分类查看"
            className={`${controlClass} mt-2`}
            value={categoryFilter}
            disabled={groups.isLoading || !!groups.error}
            onChange={event => {
              const value = event.target.value;
              setCategoryFilter(value);
              setNewCategory(value === 'uncategorized' ? '' : value);
              setActive('');
              mutation.reset();
            }}
          >
            <option value="">全部分类</option>
            <option value="uncategorized">未分类</option>
            {categories.map(category => (
              <option key={category.id} value={category.id}>
                {category.name}
              </option>
            ))}
            {categoryFilter &&
              categoryFilter !== 'uncategorized' &&
              !categories.some(category => category.id === categoryFilter) && (
                <option value={categoryFilter}>分类已失效，请清除筛选</option>
              )}
          </select>
        </label>
        <label className="min-w-0 text-xs">
          按己方网站查看
          <select
            aria-label="按己方网站查看"
            className={`${controlClass} mt-2`}
            value={siteFilter}
            onChange={event => {
              const value = event.target.value;
              setSiteFilter(value);
              setNewSite(value === 'unlinked' ? '' : value);
              setActive('');
              mutation.reset();
            }}
          >
            <option value="">全部网站与独立监控</option>
            <option value="unlinked">独立监控 · 未关联己方网站</option>
            {sites.map(site => (
              <option key={site.id} value={site.id}>
                {site.name} · {site.domain}
              </option>
            ))}
          </select>
        </label>
        <Button
          variant="outline"
          disabled={!siteFilter && !categoryFilter}
          onClick={() => {
            setSiteFilter('');
            setCategoryFilter('');
            setNewSite('');
            setNewCategory('');
            setActive('');
            mutation.reset();
          }}
        >
          清除筛选
        </Button>
        <p className="text-xs leading-5 text-[#6F6D7A] sm:col-span-3">
          分类与网站取交集；下方曲线、清单和证据来自同一范围。
          {!sites.length && ' 当前没有己方网站，仍可按分类添加独立竞品。'}
        </p>
      </section>
      {groups.error && (
        <>
          <ErrorNotice error={groups.error} />
          <Button variant="outline" onClick={() => void groups.refetch()}>
            重试分类列表
          </Button>
        </>
      )}
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
      {notice && (
        <p role="status" className="text-sm text-[#537695]">
          {notice}
        </p>
      )}
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
          {data.canManage && !groups.error && (
            <CategoryManager
              categories={categories}
              limit={data.limits.categories}
              pending={mutation.isPending}
              onAction={action => mutation.mutateAsync(action)}
            />
          )}
          {!groups.error && (
            <ResearchLibrary workspaceId={workspaceId} sites={sites} categories={categories} />
          )}
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
                  工作区 {data.workspaceMonitorCount}/{data.limits.workspace} · 当前范围{' '}
                  {data.monitors.length} 页
                </span>
              </h2>
              <fieldset
                disabled={mutation.isPending || data.workspaceMonitorCount >= data.limits.workspace}
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
                <label className="text-xs sm:col-span-1 lg:col-span-2">
                  所属分类（可选）
                  <select
                    aria-label="新增监控所属分类"
                    className={`${controlClass} mt-2`}
                    value={newCategory}
                    onChange={event => setNewCategory(event.target.value)}
                    disabled={groups.isLoading || !!groups.error}
                  >
                    <option value="">未分类</option>
                    {categories.map(category => (
                      <option key={category.id} value={category.id}>
                        {category.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="text-xs sm:col-span-1 lg:col-span-3">
                  关联己方网站（可选）
                  <select
                    aria-label="新增监控关联网站"
                    className={`${controlClass} mt-2`}
                    value={newSite}
                    onChange={event => setNewSite(event.target.value)}
                  >
                    <option value="">独立监控 · 不关联己方网站</option>
                    {sites.map(site => (
                      <option key={site.id} value={site.id}>
                        {site.name} · {site.domain}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="sm:col-span-2 lg:col-span-5 flex flex-wrap items-center justify-between gap-3">
                  <p className="text-xs leading-5 text-[#6F6D7A]">
                    每站最多20页，工作区独立监控最多20页。同范围同URL不能靠换分类重复添加。填写公开页面URL，不是sitemap.xml；Sitemap只用于选页，不自动订阅。不输入个人信息或登录/支付页。首个成功样本只建立基线。
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
                  当前范围没有竞品页面。可添加监控，或清除筛选查看全部；不代表竞品没有变化。
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
                  <p className="mt-2 break-words text-xs text-[#537695]">
                    {categories.find(category => category.id === monitor.categoryId)?.name ??
                      '未分类'}{' '}
                    · {sites.find(site => site.id === monitor.siteId)?.name ?? '独立监控'}
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
              {selected && data.canManage && !groups.error && (
                <AssignmentEditor
                  key={`${selected.id}:${selected.siteId}:${selected.categoryId}`}
                  monitor={selected}
                  sites={sites}
                  categories={categories}
                  pending={mutation.isPending}
                  onAction={action => mutation.mutateAsync(action)}
                />
              )}
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

function CategoryManager({
  categories,
  limit,
  pending,
  onAction,
}: {
  categories: CompetitorCategory[];
  limit: number;
  pending: boolean;
  onAction: (action: MonitorAction) => Promise<unknown>;
}): ReactElement {
  const [name, setName] = useState('');
  const create = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    try {
      await onAction({ suffix: '/categories', method: 'POST', body: { name } });
      setName('');
    } catch {
      return;
    }
  };
  return (
    <details className="rounded-2xl border border-[#E3E2E6] bg-white p-5">
      <summary className="cursor-pointer font-semibold">
        管理分类{' '}
        <span className="ml-2 text-xs font-normal text-[#6F6D7A]">
          工作区 {categories.length}/{limit}
        </span>
      </summary>
      <p className="mt-3 text-xs leading-5 text-[#6F6D7A]">
        例如 AI 视频、SEO
        工具。分类数和每类页数统计整个工作区；删除分类仅变为“未分类”，不会删除监控或历史。
      </p>
      <form onSubmit={event => void create(event)} className="mt-4">
        <fieldset
          disabled={pending || categories.length >= limit}
          className="flex flex-col gap-3 sm:flex-row sm:items-end"
        >
          <label className="min-w-0 flex-1 text-xs">
            新分类名称
            <Input
              aria-label="新分类名称"
              className="mt-2 min-h-11"
              value={name}
              onChange={event => setName(event.target.value)}
              required
              maxLength={40}
              placeholder="例如：AI 视频"
            />
          </label>
          <Button type="submit">添加分类</Button>
        </fieldset>
      </form>
      <div className="mt-4 space-y-3">
        {categories.map(category => (
          <CategoryRow
            key={`${category.id}:${category.name}`}
            category={category}
            pending={pending}
            onAction={onAction}
          />
        ))}
      </div>
    </details>
  );
}

const splitList = (value: string): string[] =>
  [...new Set(value.split(/[\n,]/).map(item => item.trim()).filter(Boolean))];

function parsePaymentProviders(value: string): CompetitorResearchProfile['paymentProviders'] {
  const valid = new Set(['confirmed', 'evidence_only', 'disabled', 'unknown']);
  return splitList(value).map(item => {
    const [provider, rawStatus] = item.split(':', 2).map(part => part.trim());
    return {
      provider,
      status: valid.has(rawStatus) ? (rawStatus as CompetitorResearchProfile['paymentProviders'][number]['status']) : 'unknown',
    };
  });
}

function ResearchLibrary({
  workspaceId,
  sites,
  categories,
}: {
  workspaceId: string;
  sites: OwnedSite[];
  categories: CompetitorCategory[];
}): ReactElement {
  const client = useQueryClient();
  const [filter, setFilter] = useState<CompetitorResearchStatus | ''>('');
  const [brandName, setBrandName] = useState('');
  const [homepageUrl, setHomepageUrl] = useState('');
  const [summary, setSummary] = useState('');
  const [keywords, setKeywords] = useState('');
  const [payments, setPayments] = useState('');
  const [sources, setSources] = useState('');
  const [threadUrl, setThreadUrl] = useState('');
  const [notes, setNotes] = useState('');
  const [newStatus, setNewStatus] = useState<CompetitorResearchStatus>('inbox');
  const research = useQuery({
    queryKey: ['competitor-research', workspaceId, filter],
    queryFn: () => api.getCompetitorResearch(workspaceId, filter ? { lifecycleStatus: filter } : {}),
  });
  const monitors = useQuery({
    queryKey: ['competitors', workspaceId, 'research-link-options'],
    queryFn: () => api.getCompetitors({ workspaceId }),
  });
  const mutation = useMutation({
    mutationFn: (action: ResearchAction) =>
      api.mutateCompetitor({ workspaceId }, `/research${action.suffix}`, action.method, action.body),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['competitor-research', workspaceId] });
    },
  });
  const create = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    try {
      await mutation.mutateAsync({
        suffix: '',
        method: 'POST',
        body: {
          brandName,
          homepageUrl,
          productSummary: summary || null,
          lifecycleStatus: newStatus,
          seedKeywords: splitList(keywords),
          paymentProviders: parsePaymentProviders(payments),
          sources: splitList(sources).map(url => ({ url, kind: 'manual' })),
          sourceThreadUrl: threadUrl || null,
          notes: notes || null,
        },
      });
      setBrandName('');
      setHomepageUrl('');
      setSummary('');
      setKeywords('');
      setPayments('');
      setSources('');
      setThreadUrl('');
      setNotes('');
      setNewStatus('inbox');
    } catch {
      return;
    }
  };
  const profiles = research.data?.data.profiles ?? [];
  const canManage = research.data?.data.canManage ?? false;
  return (
    <section className="rounded-2xl border border-[#E3E2E6] bg-white p-5 sm:p-6" aria-label="竞品研究库">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold text-[#3D3B4F]">竞品研究库</h2>
          <p className="mt-1 max-w-3xl text-xs leading-5 text-[#6F6D7A]">
            保存人工确认的品牌、产品定位、种子词、支付结论与来源。研究档案不会自动创建监控、读取目标网页或启用调度；先手动添加监控，再显式关联。
          </p>
        </div>
        <label className="min-w-40 text-xs">
          处理状态
          <select
            aria-label="筛选研究状态"
            className={`${controlClass} mt-2`}
            value={filter}
            onChange={event => setFilter(event.target.value as CompetitorResearchStatus | '')}
          >
            <option value="">全部状态</option>
            {Object.entries(researchStatusLabels).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
      </div>
      {research.error && (
        <div className="mt-4">
          <ErrorNotice error={research.error} />
          <Button className="mt-3" variant="outline" onClick={() => void research.refetch()}>
            重试读取研究库
          </Button>
        </div>
      )}
      {mutation.error && <div className="mt-4"><ErrorNotice error={mutation.error} /></div>}
      {research.isLoading ? (
        <p role="status" className="mt-5 text-sm text-[#6F6D7A]">正在读取研究档案…</p>
      ) : (
        <div className="mt-5 grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <div className="space-y-3">
            {!profiles.length && (
              <p className="rounded-xl bg-[#F9F8F6] p-4 text-sm text-[#6F6D7A]">
                当前筛选没有研究档案。空列表不代表市场没有竞品。
              </p>
            )}
            {profiles.map(profile => (
              <ResearchProfileCard
                key={`${profile.id}:${profile.updatedAt}`}
                profile={profile}
                categories={categories}
                sites={sites}
                monitors={monitors.data?.data.monitors ?? []}
                canManage={canManage}
                pending={mutation.isPending}
                onAction={action => mutation.mutateAsync(action)}
              />
            ))}
          </div>
          {canManage ? (
            <form onSubmit={event => void create(event)} className="h-fit rounded-xl bg-[#F9F8F6] p-4">
              <h3 className="font-semibold">保存研究结论</h3>
              <fieldset disabled={mutation.isPending} className="mt-4 grid gap-3">
                <label className="text-xs">
                  品牌 / 网站名称
                  <Input className="mt-2 min-h-11" value={brandName} onChange={event => setBrandName(event.target.value)} required maxLength={100} placeholder="例如 OpenSourceGen" />
                </label>
                <label className="text-xs">
                  首页公开 HTTPS URL
                  <Input className="mt-2 min-h-11" type="url" value={homepageUrl} onChange={event => setHomepageUrl(event.target.value)} required maxLength={500} placeholder="https://example.com/" />
                </label>
                <label className="text-xs">
                  初始状态
                  <select className={`${controlClass} mt-2`} value={newStatus} onChange={event => setNewStatus(event.target.value as CompetitorResearchStatus)}>
                    {Object.entries(researchStatusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                  </select>
                </label>
                <label className="text-xs">
                  产品 / 品类结论
                  <textarea className={`${controlClass} mt-2 min-h-22 py-2`} value={summary} onChange={event => setSummary(event.target.value)} maxLength={4000} placeholder="例如：开源模型聚合的图片与视频生成工具" />
                </label>
                <label className="text-xs">
                  种子词（逗号或换行分隔）
                  <textarea className={`${controlClass} mt-2 min-h-20 py-2`} value={keywords} onChange={event => setKeywords(event.target.value)} maxLength={5000} placeholder="AI image generator, AI video generator" />
                </label>
                <label className="text-xs">
                  支付网关（`名称:状态`，状态为 confirmed / evidence_only / disabled / unknown）
                  <Input className="mt-2 min-h-11" value={payments} onChange={event => setPayments(event.target.value)} maxLength={1200} placeholder="Stripe:confirmed, PayPal:evidence_only" />
                </label>
                <label className="text-xs">
                  证据来源 URL（逗号或换行分隔）
                  <textarea className={`${controlClass} mt-2 min-h-20 py-2`} value={sources} onChange={event => setSources(event.target.value)} maxLength={5000} placeholder="https://example.com/pricing" />
                </label>
                <label className="text-xs">
                  来源任务 / 备注链接（可选）
                  <Input className="mt-2 min-h-11" value={threadUrl} onChange={event => setThreadUrl(event.target.value)} maxLength={2048} placeholder="codex://threads/..." />
                </label>
                <label className="text-xs">
                  研究备注（可选）
                  <textarea className={`${controlClass} mt-2 min-h-20 py-2`} value={notes} onChange={event => setNotes(event.target.value)} maxLength={4000} />
                </label>
                <Button type="submit"><Plus size={16} className="mr-2" />保存研究档案</Button>
              </fieldset>
            </form>
          ) : (
            <p className="rounded-xl bg-[#F9F8F6] p-4 text-sm text-[#6F6D7A]">当前账号只读，可查看研究结论和关联关系。</p>
          )}
        </div>
      )}
    </section>
  );
}

function ResearchProfileCard({
  profile,
  categories,
  sites,
  monitors,
  canManage,
  pending,
  onAction,
}: {
  profile: CompetitorResearchProfile;
  categories: CompetitorCategory[];
  sites: OwnedSite[];
  monitors: CompetitorMonitor[];
  canManage: boolean;
  pending: boolean;
  onAction: (action: ResearchAction) => Promise<unknown>;
}): ReactElement {
  const [status, setStatus] = useState(profile.lifecycleStatus);
  const [categoryIds, setCategoryIds] = useState(profile.categories.map(category => category.id));
  const [siteIds, setSiteIds] = useState(profile.sites.map(site => site.id));
  const [monitorIds, setMonitorIds] = useState(profile.monitors.map(monitor => monitor.id));
  const saveLinks = async (kind: 'categories' | 'sites' | 'monitors', ids: string[]): Promise<void> => {
    try {
      await onAction({ suffix: `/${encodeURIComponent(profile.id)}/${kind}`, method: 'PUT', body: { ids } });
    } catch {
      return;
    }
  };
  const selected = (event: FormEvent<HTMLSelectElement>): string[] =>
    Array.from(event.currentTarget.selectedOptions, option => option.value);
  return (
    <article className="rounded-xl border border-[#E3E2E6] bg-white p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="break-words font-semibold text-[#3D3B4F]">{profile.brandName}</h3>
          <a className="mt-1 block break-all text-xs text-[#537695]" href={profile.homepageUrl} target="_blank" rel="noopener noreferrer">{profile.homepageUrl}</a>
        </div>
        {canManage ? (
          <select aria-label={`${profile.brandName}研究状态`} className="min-h-9 rounded-lg border px-2 text-xs" value={status} disabled={pending} onChange={event => {
            const next = event.target.value as CompetitorResearchStatus;
            setStatus(next);
            void onAction({ suffix: `/${encodeURIComponent(profile.id)}`, method: 'PATCH', body: { lifecycleStatus: next } }).catch(() => {
              setStatus(profile.lifecycleStatus);
            });
          }}>
            {Object.entries(researchStatusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        ) : <span className="rounded-full bg-[#F9F8F6] px-2 py-1 text-xs">{researchStatusLabels[profile.lifecycleStatus]}</span>}
      </div>
      {profile.productSummary && <p className="mt-3 whitespace-pre-wrap break-words text-sm leading-6 text-[#555163]">{profile.productSummary}</p>}
      <ResearchChips label="种子词" values={profile.seedKeywords} />
      <ResearchChips label="支付" values={profile.paymentProviders.map(item => `${item.provider} · ${item.status}`)} />
      <ResearchChips label="业务分类" values={profile.categories.map(category => category.name)} />
      <ResearchChips label="关联站点" values={profile.sites.map(site => site.name)} />
      <ResearchChips label="关联监控" values={profile.monitors.map(monitor => monitor.name)} />
      {profile.sources.length > 0 && <p className="mt-3 break-words text-xs leading-5 text-[#6F6D7A]">证据来源：{profile.sources.map(source => source.url).join(' · ')}</p>}
      {profile.notes && <p className="mt-3 whitespace-pre-wrap break-words text-xs leading-5 text-[#6F6D7A]">备注：{profile.notes}</p>}
      {canManage && (
        <details className="mt-4 rounded-lg bg-[#F9F8F6] p-3">
          <summary className="cursor-pointer text-sm font-medium">手动划分与关联</summary>
          <div className="mt-4 grid gap-3">
            <ResearchLinkSelect label="业务分类（多选）" value={categoryIds} options={categories.map(category => ({ id: category.id, label: category.name }))} disabled={pending} onChange={event => setCategoryIds(selected(event))} onSave={() => void saveLinks('categories', categoryIds)} />
            <ResearchLinkSelect label="己方网站（多选）" value={siteIds} options={sites.map(site => ({ id: site.id, label: `${site.name} · ${site.domain}` }))} disabled={pending} onChange={event => setSiteIds(selected(event))} onSave={() => void saveLinks('sites', siteIds)} />
            <ResearchLinkSelect label="已有监控（多选）" value={monitorIds} options={monitors.map(monitor => ({ id: monitor.id, label: `${monitor.name} · ${monitor.url}` }))} disabled={pending} onChange={event => setMonitorIds(selected(event))} onSave={() => void saveLinks('monitors', monitorIds)} />
            <p className="text-xs leading-5 text-[#6F6D7A]">研究档案不会新增监控。需监控时先在下方“添加公开页面”中手动创建，并保持手动频率；再回到这里关联该已有记录。</p>
          </div>
        </details>
      )}
    </article>
  );
}

function ResearchChips({ label, values }: { label: string; values: string[] }): ReactElement | null {
  if (!values.length) return null;
  return <p className="mt-3 break-words text-xs text-[#6F6D7A]"><span className="mr-2">{label}</span>{values.join(' · ')}</p>;
}

function ResearchLinkSelect({
  label,
  value,
  options,
  disabled,
  onChange,
  onSave,
}: {
  label: string;
  value: string[];
  options: { id: string; label: string }[];
  disabled: boolean;
  onChange: (event: FormEvent<HTMLSelectElement>) => void;
  onSave: () => void;
}): ReactElement {
  return (
    <label className="text-xs">
      {label}
      <select multiple className={`${controlClass} mt-2 min-h-24 py-2`} value={value} disabled={disabled} onChange={onChange}>
        {options.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
      </select>
      <Button type="button" className="mt-2" size="sm" variant="outline" disabled={disabled} onClick={onSave}>保存关联</Button>
    </label>
  );
}

function CategoryRow({
  category,
  pending,
  onAction,
}: {
  category: CompetitorCategory;
  pending: boolean;
  onAction: (action: MonitorAction) => Promise<unknown>;
}): ReactElement {
  const [name, setName] = useState(category.name);
  const rename = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    try {
      await onAction({
        suffix: `/categories/${encodeURIComponent(category.id)}`,
        method: 'PATCH',
        body: { name },
      });
    } catch {
      return;
    }
  };
  const remove = async (): Promise<void> => {
    if (
      !window.confirm(
        `删除分类“${category.name}”？${category.monitorCount}个监控将变为未分类；全部历史保留。`
      )
    )
      return;
    try {
      await onAction({
        suffix: `/categories/${encodeURIComponent(category.id)}`,
        method: 'DELETE',
      });
    } catch {
      return;
    }
  };
  return (
    <form onSubmit={event => void rename(event)}>
      <fieldset
        disabled={pending}
        className="flex flex-wrap items-center gap-2 rounded-lg bg-[#F9F8F6] p-3"
      >
        <Input
          aria-label={`分类名称：${category.name}`}
          className="min-w-0 basis-full sm:basis-0 sm:flex-1"
          value={name}
          onChange={event => setName(event.target.value)}
          required
          maxLength={40}
        />
        <span className="text-xs text-[#6F6D7A]">{category.monitorCount} 页</span>
        <Button type="submit" size="sm" variant="outline" disabled={name.trim() === category.name}>
          保存名称
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          aria-label={`删除分类${category.name}`}
          onClick={() => void remove()}
        >
          删除分类
        </Button>
      </fieldset>
    </form>
  );
}

function AssignmentEditor({
  monitor,
  sites,
  categories,
  pending,
  onAction,
}: {
  monitor: CompetitorMonitor;
  sites: OwnedSite[];
  categories: CompetitorCategory[];
  pending: boolean;
  onAction: (action: MonitorAction) => Promise<unknown>;
}): ReactElement {
  const [siteId, setSiteId] = useState(monitor.siteId ?? '');
  const [categoryId, setCategoryId] = useState(monitor.categoryId ?? '');
  const save = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    try {
      await onAction({
        suffix: `/${encodeURIComponent(monitor.id)}`,
        method: 'PATCH',
        body: { siteId: siteId || null, categoryId: categoryId || null },
      });
    } catch {
      return;
    }
  };
  return (
    <details className="rounded-xl border border-[#E3E2E6] bg-white p-4">
      <summary className="cursor-pointer text-sm font-medium">调整分类 / 关联网站</summary>
      <form onSubmit={event => void save(event)} className="mt-4">
        <fieldset disabled={pending} className="grid gap-3 sm:grid-cols-2">
          <label className="min-w-0 text-xs">
            所属分类
            <select
              aria-label="调整所属分类"
              className={`${controlClass} mt-2`}
              value={categoryId}
              onChange={event => setCategoryId(event.target.value)}
            >
              <option value="">未分类</option>
              {categories.map(category => (
                <option key={category.id} value={category.id}>
                  {category.name}
                </option>
              ))}
            </select>
          </label>
          <label className="min-w-0 text-xs">
            关联己方网站
            <select
              aria-label="调整关联网站"
              className={`${controlClass} mt-2`}
              value={siteId}
              onChange={event => setSiteId(event.target.value)}
            >
              <option value="">独立监控 · 不关联网站</option>
              {sites.map(site => (
                <option key={site.id} value={site.id}>
                  {site.name}
                </option>
              ))}
            </select>
          </label>
          <p className="text-xs leading-5 text-[#6F6D7A] sm:col-span-2">
            历史与成功基线保留，并随当前归属汇总，因此以往曲线也会重新归类。不能跨工作区移动；同范围URL去重与页数上限仍生效。
          </p>
          <Button
            type="submit"
            variant="outline"
            disabled={
              siteId === (monitor.siteId ?? '') && categoryId === (monitor.categoryId ?? '')
            }
          >
            保存归属
          </Button>
        </fieldset>
      </form>
    </details>
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
