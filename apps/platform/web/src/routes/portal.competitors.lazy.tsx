import { useState, type FormEvent, type ReactElement } from 'react';
import { createLazyFileRoute } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid } from 'recharts';
import {
  Radar,
  ExternalLink,
  RefreshCw,
  Plus,
  Sparkles,
  Trash2,
  ShieldCheck,
  AlertTriangle,
} from 'lucide-react';
import type {
  CompetitorCheck,
  CompetitorSnapshot,
  CompetitorCategory,
  CompetitorMonitor,
  CompetitorPreResearchAction,
  CompetitorPreResearchDetail,
  CompetitorPreResearchRun,
  CompetitorPreResearchStage,
  CompetitorResearchProfile,
  CompetitorResearchDraft,
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
const preResearchStageLabels: Record<CompetitorPreResearchStage, string> = {
  imported: '已导入',
  reviewing: '分析中',
  verified: '已核验',
  archived: '已归档',
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
  const [view, setView] = useState<'research' | 'monitoring'>('research');
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
          <h1 className="text-3xl font-semibold tracking-tight text-[#3D3B4F]">
            {view === 'research' ? '竞品分析' : '竞品监控'}
          </h1>
          <p className="mt-2 max-w-xl text-sm leading-6 text-[#6F6D7A]">
            {view === 'research'
              ? '先归档预调研与人工结论，再按需要手动建立监控。分析不会自动读取目标站或启动调度。'
              : '仅查看公开页面的受控变化记录。监控不等于竞品流量、客户或转化数据。'}
          </p>
        </div>
        <p className="min-w-0 break-words text-sm text-[#6F6D7A]">
          工作区 · {current?.name ?? '正在加载'}
        </p>
      </div>
      <div
        role="tablist"
        aria-label="竞品功能"
        className="inline-flex rounded-xl border border-[#E3E2E6] bg-white p-1"
      >
        <button
          type="button"
          role="tab"
          aria-selected={view === 'research'}
          onClick={() => setView('research')}
          className={`rounded-lg px-4 py-2 text-sm font-medium ${view === 'research' ? 'bg-[#3D3B4F] text-white' : 'text-[#6F6D7A] hover:bg-[#F9F8F6]'}`}
        >
          竞品分析
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={view === 'monitoring'}
          onClick={() => setView('monitoring')}
          className={`rounded-lg px-4 py-2 text-sm font-medium ${view === 'monitoring' ? 'bg-[#3D3B4F] text-white' : 'text-[#6F6D7A] hover:bg-[#F9F8F6]'}`}
        >
          竞品监控
        </button>
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
      ) : view === 'research' ? (
        <ResearchPanel key={`research:${current.id}`} workspaceId={current.id} sites={siteRows} />
      ) : (
        <MonitorPanel key={`monitoring:${current.id}`} workspaceId={current.id} sites={siteRows} />
      )}
    </main>
  );
}

function ResearchPanel({
  workspaceId,
  sites,
}: {
  workspaceId: string;
  sites: OwnedSite[];
}): ReactElement {
  const groups = useQuery({
    queryKey: ['competitor-categories', workspaceId],
    queryFn: () => api.getCompetitorCategories(workspaceId),
    retry: false,
  });
  const categories = groups.data?.data.categories ?? [];
  return (
    <>
      <section className="rounded-2xl border border-[#E3E2E6] bg-white p-5 sm:p-6">
        <h2 className="text-lg font-semibold text-[#3D3B4F]">先粘贴资料预调研，再决定是否监控</h2>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-[#6F6D7A]">
          粘贴公开网站资料即可生成并保存详细研究档案；也可导入 Keyword Harvester
          任务摘要与行动路径。所有分类、关联和监控均需人工确认，不会自动读取目标网站或启动调度。
        </p>
      </section>
      {groups.error && <ErrorNotice error={groups.error} />}
      {!groups.error && (
        <>
          <ResearchLibrary workspaceId={workspaceId} sites={sites} categories={categories} />
          <PreResearchLibrary workspaceId={workspaceId} />
        </>
      )}
    </>
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

const splitList = (value: string): string[] => [
  ...new Set(
    value
      .split(/[\n,]/)
      .map(item => item.trim())
      .filter(Boolean)
  ),
];

function parsePaymentProviders(value: string): CompetitorResearchProfile['paymentProviders'] {
  const valid = new Set(['confirmed', 'evidence_only', 'disabled', 'unknown']);
  return splitList(value).map(item => {
    const [provider, rawStatus] = item.split(':', 2).map(part => part.trim());
    return {
      provider,
      status: valid.has(rawStatus)
        ? (rawStatus as CompetitorResearchProfile['paymentProviders'][number]['status'])
        : 'unknown',
    };
  });
}

function formatPaymentProviders(
  providers: CompetitorResearchDraft['draft']['paymentProviders']
): string {
  return providers.map(provider => `${provider.provider}:${provider.status}`).join('\n');
}

type ResearchTextSection = { title: string | null; content: string };

const analysisSectionLabel =
  /^(产品类别与定位|可见工具(?:\/类别)?覆盖|可能的用户任务(?:（[^）]{0,40}）)?|关键词角度|支付(?:网关|证据|方式)?|(?:待补|缺失)证据|品牌(?:与产品)?|目标用户|商业模式|页面内容|优势(?:与差异)?|竞争定位)\s*[：:]/;

function sentenceSections(value: string): ResearchTextSection[] {
  const sentences = value
    .match(/[^。！？]+[。！？]?/gu)
    ?.map(sentence => sentence.trim())
    .filter(Boolean) ?? [value];
  const sections: ResearchTextSection[] = [];
  for (let index = 0; index < sentences.length; index += 3)
    sections.push({ title: null, content: sentences.slice(index, index + 3).join('') });
  return sections;
}

function detailedAnalysisSections(value: string): ResearchTextSection[] {
  const paragraphs = value
    .trim()
    .split(/\n\s*\n+/)
    .flatMap(paragraph =>
      paragraph.split(
        /(?=产品类别与定位\s*[：:]|可见工具(?:\/类别)?覆盖\s*[：:]|可能的用户任务(?:（[^）]{0,40}）)?\s*[：:]|关键词角度\s*[：:]|支付(?:网关|证据|方式)?\s*[：:]|(?:待补|缺失)证据\s*[：:]|品牌(?:与产品)?\s*[：:]|目标用户\s*[：:]|商业模式\s*[：:]|页面内容\s*[：:]|优势(?:与差异)?\s*[：:]|竞争定位\s*[：:])/
      )
    )
    .map(paragraph => paragraph.trim())
    .filter(Boolean);
  const sections = paragraphs.map(paragraph => {
    const boundary = paragraph.match(/^([^：:\n]{1,80})\s*[：:]\s*([\s\S]+)$/);
    return boundary && analysisSectionLabel.test(paragraph)
      ? { title: boundary[1].trim(), content: boundary[2].trim() }
      : { title: null, content: paragraph };
  });
  return sections.length > 1 || sections[0]?.title ? sections : sentenceSections(value);
}

function keyFinding(profile: CompetitorResearchProfile): string | null {
  if (profile.productSummary?.trim()) return profile.productSummary.trim();
  if (!profile.analysis) return null;
  const sections = detailedAnalysisSections(profile.analysis.detailedAnalysis);
  return (
    sections.find(section => section.title === '产品类别与定位')?.content ??
    sections[0]?.content ??
    null
  );
}

function paymentFinding(
  profile: CompetitorResearchProfile,
  analysisSections: ResearchTextSection[]
): string {
  const analysis = analysisSections.find(section => section.title?.includes('支付'))?.content;
  if (analysis) return analysis;
  const evidence = profile.paymentProviders
    .map(provider => provider.evidence)
    .filter((value): value is string => Boolean(value))
    .join('；');
  if (evidence) return evidence;
  if (profile.paymentProviders.length)
    return `已记录待核验服务商：${profile.paymentProviders.map(provider => provider.provider).join('、')}。`;
  return (
    profile.analysis?.evidenceGaps.find(gap => /支付|定价|结账/.test(gap)) ??
    '未识别可确认的支付网关；需要补充公开价格、结账页或支付服务商证据。'
  );
}

function preResearchCopyText(
  run: CompetitorPreResearchRun,
  detail: CompetitorPreResearchDetail | undefined
): string {
  const actionLines = (detail?.actions ?? []).map(
    (action: CompetitorPreResearchAction) =>
      `- [${action.outcome}] ${action.kind}: ${action.title}${action.detail ? `\n  ${action.detail}` : ''}${action.references.length ? `\n  ${action.references.join(' · ')}` : ''}`
  );
  return [
    `# ${run.title}`,
    `来源任务：${run.sourceJobUrl}`,
    `插件版本：${run.sourceVersion} · 采集状态：${run.harvestStatus} · 调研阶段：${preResearchStageLabels[run.stage]}`,
    run.currentQuery ? `当前查询：${run.currentQuery}` : '',
    run.seedKeywords.length ? `种子词：${run.seedKeywords.join('、')}` : '',
    run.sourceThreadUrl ? `Codex 来源：${run.sourceThreadUrl}` : '',
    run.summary ?? '',
    actionLines.length ? `\n## 行动路径\n${actionLines.join('\n')}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

function PreResearchLibrary({ workspaceId }: { workspaceId: string }): ReactElement {
  const client = useQueryClient();
  const [filter, setFilter] = useState<CompetitorPreResearchStage | ''>('');
  const [activeId, setActiveId] = useState('');
  const [showImport, setShowImport] = useState(false);
  const [sourceJobUrl, setSourceJobUrl] = useState('');
  const [sourceVersion, setSourceVersion] = useState('0.7.15');
  const [title, setTitle] = useState('');
  const [currentQuery, setCurrentQuery] = useState('');
  const [harvestStatus, setHarvestStatus] = useState('unknown');
  const [seedKeywords, setSeedKeywords] = useState('');
  const [summary, setSummary] = useState('');
  const [sourceThreadUrl, setSourceThreadUrl] = useState('');
  const [actionKind, setActionKind] = useState('note');
  const [actionOutcome, setActionOutcome] = useState('completed');
  const [actionTitle, setActionTitle] = useState('');
  const [actionDetail, setActionDetail] = useState('');
  const [actionReferences, setActionReferences] = useState('');
  const [notice, setNotice] = useState('');
  const runs = useQuery({
    queryKey: ['competitor-pre-research', workspaceId, filter],
    queryFn: () => api.getCompetitorPreResearch(workspaceId, filter ? { stage: filter } : {}),
    retry: false,
  });
  const list = runs.data?.data.runs ?? [];
  const selectedId = showImport ? '' : activeId || list[0]?.id || '';
  const detail = useQuery({
    queryKey: ['competitor-pre-research-detail', workspaceId, selectedId],
    queryFn: () => api.getCompetitorPreResearchDetail(workspaceId, selectedId),
    enabled: !!selectedId,
    retry: false,
  });
  const mutation = useMutation({
    mutationFn: (action: ResearchAction) =>
      api.mutateCompetitor(
        { workspaceId },
        `/research/pre-research${action.suffix}`,
        action.method,
        action.body
      ),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['competitor-pre-research', workspaceId] });
      void client.invalidateQueries({ queryKey: ['competitor-pre-research-detail', workspaceId] });
    },
  });
  const create = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    try {
      const result = (await mutation.mutateAsync({
        suffix: '',
        method: 'POST',
        body: {
          sourceJobUrl,
          sourceVersion,
          title,
          currentQuery: currentQuery || null,
          harvestStatus,
          seedKeywords: splitList(seedKeywords),
          summary: summary || null,
          sourceThreadUrl: sourceThreadUrl || null,
        },
      })) as { data?: { id?: string } };
      setActiveId(result.data?.id ?? '');
      setShowImport(false);
      setSourceJobUrl('');
      setTitle('');
      setCurrentQuery('');
      setHarvestStatus('unknown');
      setSeedKeywords('');
      setSummary('');
      setSourceThreadUrl('');
      setNotice('预调研任务已归档；尚未创建竞品档案或监控。');
    } catch {
      return;
    }
  };
  const appendAction = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (!selectedId) return;
    try {
      await mutation.mutateAsync({
        suffix: `/${encodeURIComponent(selectedId)}/actions`,
        method: 'POST',
        body: {
          kind: actionKind,
          outcome: actionOutcome,
          title: actionTitle,
          detail: actionDetail || null,
          references: splitList(actionReferences),
        },
      });
      setActionTitle('');
      setActionDetail('');
      setActionReferences('');
      setNotice('行动步骤已加入当前预调研记录。');
    } catch {
      return;
    }
  };
  const updateStage = async (stage: CompetitorPreResearchStage): Promise<void> => {
    if (!selectedId) return;
    try {
      await mutation.mutateAsync({
        suffix: `/${encodeURIComponent(selectedId)}/stage`,
        method: 'PATCH',
        body: { stage },
      });
      setNotice('预调研阶段已更新。');
    } catch {
      return;
    }
  };
  const selected = list.find(run => run.id === selectedId);
  return (
    <section
      className="rounded-2xl border border-[#E3E2E6] bg-white p-5 sm:p-6"
      aria-label="竞品预调研"
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold text-[#3D3B4F]">竞品预调研</h2>
          <p className="mt-1 max-w-3xl text-xs leading-5 text-[#6F6D7A]">
            录入 Keyword Harvester 任务的摘要和后续行动，而非读取插件本地存储。每条记录可引用 Codex
            任务，行动路径可单独查看和复制。
          </p>
        </div>
        <label className="min-w-40 text-xs">
          调研阶段
          <select
            className={`${controlClass} mt-2`}
            value={filter}
            onChange={event => setFilter(event.target.value as CompetitorPreResearchStage | '')}
          >
            <option value="">全部阶段</option>
            {Object.entries(preResearchStageLabels).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        {runs.data?.data.canManage && (
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              setActiveId('');
              setShowImport(true);
            }}
          >
            <Plus size={16} className="mr-2" />
            导入预调研
          </Button>
        )}
      </div>
      {runs.error && (
        <div className="mt-4">
          <ErrorNotice error={runs.error} />
          <Button className="mt-3" variant="outline" onClick={() => void runs.refetch()}>
            重试读取预调研
          </Button>
        </div>
      )}
      {mutation.error && (
        <div className="mt-4">
          <ErrorNotice error={mutation.error} />
        </div>
      )}
      {notice && (
        <p role="status" className="mt-4 text-sm text-[#537695]">
          {notice}
        </p>
      )}
      <div className="mt-5 grid gap-4 xl:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
        <div className="space-y-3">
          {runs.isLoading ? (
            <p role="status" className="text-sm text-[#6F6D7A]">
              正在读取预调研…
            </p>
          ) : !list.length ? (
            <p className="rounded-xl bg-[#F9F8F6] p-4 text-sm text-[#6F6D7A]">
              尚无预调研。空列表不代表没有竞品或关键词机会。
            </p>
          ) : (
            list.map(run => (
              <button
                key={run.id}
                type="button"
                onClick={() => {
                  setActiveId(run.id);
                  setShowImport(false);
                }}
                className={`w-full rounded-xl border p-4 text-left ${run.id === selectedId ? 'border-[#537695] bg-[#F4F8FB]' : 'border-[#E3E2E6] bg-white hover:bg-[#F9F8F6]'}`}
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <span className="font-semibold text-[#3D3B4F]">{run.title}</span>
                  <span className="rounded-full bg-white px-2 py-1 text-xs text-[#6F6D7A]">
                    {preResearchStageLabels[run.stage]}
                  </span>
                </div>
                <p className="mt-2 break-words text-xs text-[#6F6D7A]">
                  {run.currentQuery ?? '未记录当前查询'} · {run.actionCount} 个行动步骤
                </p>
                {run.seedKeywords.length > 0 && (
                  <p className="mt-2 line-clamp-2 text-xs text-[#6F6D7A]">
                    {run.seedKeywords.join(' · ')}
                  </p>
                )}
              </button>
            ))
          )}
        </div>
        {selected ? (
          <div className="space-y-4 rounded-xl bg-[#F9F8F6] p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h3 className="font-semibold text-[#3D3B4F]">{selected.title}</h3>
                <p className="mt-1 break-all text-xs text-[#6F6D7A]">{selected.sourceJobUrl}</p>
              </div>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() =>
                  void navigator.clipboard
                    .writeText(preResearchCopyText(selected, detail.data?.data))
                    .then(() => setNotice('已复制预调研与当前行动路径。'))
                    .catch(() => setNotice('无法访问剪贴板，请手动复制。'))
                }
              >
                复制记录
              </Button>
            </div>
            <dl className="grid gap-3 text-xs sm:grid-cols-2">
              <div>
                <dt className="text-[#6F6D7A]">插件版本 / 采集状态</dt>
                <dd className="mt-1 break-words">
                  {selected.sourceVersion} · {selected.harvestStatus}
                </dd>
              </div>
              <div>
                <dt className="text-[#6F6D7A]">当前查询</dt>
                <dd className="mt-1 break-words">{selected.currentQuery ?? '未记录'}</dd>
              </div>
            </dl>
            {selected.summary && (
              <p className="whitespace-pre-wrap break-words text-sm leading-6 text-[#555163]">
                {selected.summary}
              </p>
            )}
            {selected.seedKeywords.length > 0 && (
              <p className="break-words text-xs text-[#6F6D7A]">
                种子词：{selected.seedKeywords.join(' · ')}
              </p>
            )}
            {selected.sourceThreadUrl && (
              <a className="block break-all text-xs text-[#537695]" href={selected.sourceThreadUrl}>
                来源任务：{selected.sourceThreadUrl}
              </a>
            )}
            {runs.data?.data.canManage && (
              <label className="block text-xs">
                调研阶段
                <select
                  className={`${controlClass} mt-2`}
                  value={selected.stage}
                  disabled={mutation.isPending}
                  onChange={event =>
                    void updateStage(event.target.value as CompetitorPreResearchStage)
                  }
                >
                  {Object.entries(preResearchStageLabels).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {detail.isLoading ? (
              <p role="status" className="text-sm text-[#6F6D7A]">
                正在读取行动路径…
              </p>
            ) : detail.error ? (
              <ErrorNotice error={detail.error} />
            ) : (
              <div className="space-y-3">
                <h4 className="font-medium">行动路径</h4>
                {detail.data?.data.actions.length ? (
                  detail.data.data.actions.map(action => (
                    <article
                      key={action.id}
                      className="rounded-lg border border-[#E3E2E6] bg-white p-3"
                    >
                      <p className="text-sm font-medium">{action.title}</p>
                      <p className="mt-1 text-xs text-[#6F6D7A]">
                        {action.kind} · {action.outcome} · {formatTime(action.occurredAt)}
                      </p>
                      {action.detail && (
                        <p className="mt-2 whitespace-pre-wrap break-words text-xs leading-5 text-[#6F6D7A]">
                          {action.detail}
                        </p>
                      )}
                      {action.references.length > 0 && (
                        <p className="mt-2 break-words text-xs text-[#537695]">
                          {action.references.join(' · ')}
                        </p>
                      )}
                    </article>
                  ))
                ) : (
                  <p className="rounded-lg bg-white p-3 text-sm text-[#6F6D7A]">
                    尚未记录行动步骤。
                  </p>
                )}
              </div>
            )}
            {runs.data?.data.canManage && (
              <form
                onSubmit={event => void appendAction(event)}
                className="rounded-lg border border-[#E3E2E6] bg-white p-3"
              >
                <h4 className="font-medium">追加行动步骤</h4>
                <fieldset disabled={mutation.isPending} className="mt-3 grid gap-3">
                  <div className="grid gap-3 sm:grid-cols-2">
                    <label className="text-xs">
                      类型
                      <select
                        className={`${controlClass} mt-2`}
                        value={actionKind}
                        onChange={event => setActionKind(event.target.value)}
                      >
                        <option value="harvest">采集</option>
                        <option value="review">查阅</option>
                        <option value="analysis">分析</option>
                        <option value="classification">分类</option>
                        <option value="handoff">交接</option>
                        <option value="note">备注</option>
                      </select>
                    </label>
                    <label className="text-xs">
                      结果
                      <select
                        className={`${controlClass} mt-2`}
                        value={actionOutcome}
                        onChange={event => setActionOutcome(event.target.value)}
                      >
                        <option value="completed">完成</option>
                        <option value="partial">部分完成</option>
                        <option value="failed">失败</option>
                        <option value="skipped">跳过</option>
                      </select>
                    </label>
                  </div>
                  <label className="text-xs">
                    步骤标题
                    <Input
                      className="mt-2 min-h-11"
                      value={actionTitle}
                      onChange={event => setActionTitle(event.target.value)}
                      required
                      maxLength={160}
                      placeholder="例如：核验定价页支付证据"
                    />
                  </label>
                  <label className="text-xs">
                    结论 / 原因（可选）
                    <textarea
                      className={`${controlClass} mt-2 min-h-20 py-2`}
                      value={actionDetail}
                      onChange={event => setActionDetail(event.target.value)}
                      maxLength={1000}
                    />
                  </label>
                  <label className="text-xs">
                    证据链接（逗号或换行分隔，可选）
                    <textarea
                      className={`${controlClass} mt-2 min-h-20 py-2`}
                      value={actionReferences}
                      onChange={event => setActionReferences(event.target.value)}
                      maxLength={1600}
                      placeholder="https://example.com/pricing"
                    />
                  </label>
                  <Button type="submit">
                    <Plus size={16} className="mr-2" />
                    保存行动步骤
                  </Button>
                </fieldset>
              </form>
            )}
          </div>
        ) : runs.data?.data.canManage ? (
          <form onSubmit={event => void create(event)} className="rounded-xl bg-[#F9F8F6] p-4">
            <h3 className="font-semibold">导入预调研</h3>
            <fieldset disabled={mutation.isPending} className="mt-4 grid gap-3">
              <label className="text-xs">
                Keyword Harvester 任务 URL
                <Input
                  className="mt-2 min-h-11"
                  value={sourceJobUrl}
                  onChange={event => setSourceJobUrl(event.target.value)}
                  required
                  maxLength={2048}
                  placeholder="chrome-extension://…/harvest.html?job=…"
                />
              </label>
              <label className="text-xs">
                插件版本
                <Input
                  className="mt-2 min-h-11"
                  value={sourceVersion}
                  onChange={event => setSourceVersion(event.target.value)}
                  required
                  maxLength={40}
                />
              </label>
              <label className="text-xs">
                任务名称
                <Input
                  className="mt-2 min-h-11"
                  value={title}
                  onChange={event => setTitle(event.target.value)}
                  required
                  maxLength={160}
                  placeholder="例如：image to prompt 递归采集"
                />
              </label>
              <label className="text-xs">
                当前 / 主查询（可选）
                <Input
                  className="mt-2 min-h-11"
                  value={currentQuery}
                  onChange={event => setCurrentQuery(event.target.value)}
                  maxLength={200}
                />
              </label>
              <label className="text-xs">
                采集状态
                <select
                  className={`${controlClass} mt-2`}
                  value={harvestStatus}
                  onChange={event => setHarvestStatus(event.target.value)}
                >
                  <option value="unknown">未知</option>
                  <option value="active">进行中</option>
                  <option value="completed">已完成</option>
                  <option value="paused">已暂停</option>
                  <option value="partial">部分完成</option>
                </select>
              </label>
              <label className="text-xs">
                种子词（逗号或换行分隔）
                <textarea
                  className={`${controlClass} mt-2 min-h-20 py-2`}
                  value={seedKeywords}
                  onChange={event => setSeedKeywords(event.target.value)}
                  maxLength={5000}
                />
              </label>
              <label className="text-xs">
                插件摘要 / 已知边界（可选）
                <textarea
                  className={`${controlClass} mt-2 min-h-20 py-2`}
                  value={summary}
                  onChange={event => setSummary(event.target.value)}
                  maxLength={1000}
                />
              </label>
              <label className="text-xs">
                Codex 来源任务（可选）
                <Input
                  className="mt-2 min-h-11"
                  value={sourceThreadUrl}
                  onChange={event => setSourceThreadUrl(event.target.value)}
                  maxLength={2048}
                  placeholder="codex://threads/..."
                />
              </label>
              <Button type="submit">
                <Plus size={16} className="mr-2" />
                归档预调研
              </Button>
            </fieldset>
          </form>
        ) : (
          <p className="rounded-xl bg-[#F9F8F6] p-4 text-sm text-[#6F6D7A]">
            当前账号只读，可查看已归档的预调研与行动路径。
          </p>
        )}
      </div>
    </section>
  );
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
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<10 | 20>(10);
  const [selectedProfileId, setSelectedProfileId] = useState('');
  const [rawInput, setRawInput] = useState('');
  const [intakeStatus, setIntakeStatus] = useState<CompetitorResearchStatus>('inbox');
  const [newCategoryName, setNewCategoryName] = useState('');
  const [brandName, setBrandName] = useState('');
  const [homepageUrl, setHomepageUrl] = useState('');
  const [pageTitle, setPageTitle] = useState('');
  const [summary, setSummary] = useState('');
  const [keywords, setKeywords] = useState('');
  const [payments, setPayments] = useState('');
  const [sources, setSources] = useState('');
  const [threadUrl, setThreadUrl] = useState('');
  const [notes, setNotes] = useState('');
  const [newStatus, setNewStatus] = useState<CompetitorResearchStatus>('inbox');
  const [notice, setNotice] = useState('');
  const [generatedDraft, setGeneratedDraft] = useState<CompetitorResearchDraft | null>(null);
  const research = useQuery({
    queryKey: ['competitor-research', workspaceId, filter, page, pageSize],
    queryFn: () =>
      api.getCompetitorResearch(workspaceId, {
        ...(filter ? { lifecycleStatus: filter } : {}),
        page,
        pageSize,
      }),
  });
  const monitors = useQuery({
    queryKey: ['competitors', workspaceId, 'research-link-options'],
    queryFn: () => api.getCompetitors({ workspaceId }),
  });
  const mutation = useMutation({
    mutationFn: (action: ResearchAction) =>
      api.mutateCompetitor(
        { workspaceId },
        `/research${action.suffix}`,
        action.method,
        action.body
      ),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['competitor-research', workspaceId] });
    },
  });
  const draftMutation = useMutation({
    mutationFn: () =>
      api.generateCompetitorResearchDraft(workspaceId, {
        homepageUrl,
        brandName: brandName || null,
        pageTitle: pageTitle || null,
        productSummary: summary || null,
        seedKeywords: splitList(keywords),
      }),
    onSuccess: result => {
      setGeneratedDraft(result.data);
      setNotice(
        result.data.provider === 'glm'
          ? `已由 ${result.data.model} 生成待核验草稿，尚未保存。`
          : `GLM 未成功，本次由 Terra 后备 ${result.data.model} 生成待核验草稿，尚未保存。`
      );
    },
  });
  const intakeMutation = useMutation({
    mutationFn: () =>
      api.intakeCompetitorResearch(workspaceId, {
        rawInput,
        lifecycleStatus: intakeStatus,
      }),
    onSuccess: result => {
      setRawInput('');
      setFilter(intakeStatus);
      setPage(1);
      setSelectedProfileId(result.data.profileId);
      setNotice(`已由 ${result.data.model} 分析并保存完整预调研记录，尚未创建监控。`);
      void client.invalidateQueries({ queryKey: ['competitor-research', workspaceId] });
    },
  });
  const categoryMutation = useMutation({
    mutationFn: () =>
      api.mutateCompetitor({ workspaceId }, '/categories', 'POST', { name: newCategoryName }),
    onSuccess: () => {
      setNewCategoryName('');
      void client.invalidateQueries({ queryKey: ['competitor-categories', workspaceId] });
    },
  });
  const generateDraft = async (): Promise<void> => {
    if (!homepageUrl.trim()) {
      setNotice('请先填写公开 HTTPS URL，再生成草稿。');
      return;
    }
    try {
      await draftMutation.mutateAsync();
    } catch {
      return;
    }
  };
  const applyDraft = (): void => {
    if (!generatedDraft) return;
    setBrandName(generatedDraft.draft.brandName);
    setPageTitle(generatedDraft.draft.pageTitle ?? '');
    setSummary(generatedDraft.draft.productSummary ?? '');
    setKeywords(generatedDraft.draft.seedKeywords.join('\n'));
    if (!payments.trim() && generatedDraft.draft.paymentProviders.length)
      setPayments(formatPaymentProviders(generatedDraft.draft.paymentProviders));
    setGeneratedDraft(null);
    setNotice('草稿已回填到表单；请人工核验证据后再保存研究档案。');
  };
  const create = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    try {
      await mutation.mutateAsync({
        suffix: '',
        method: 'POST',
        body: {
          brandName,
          homepageUrl,
          pageTitle: pageTitle || null,
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
      setPageTitle('');
      setSummary('');
      setKeywords('');
      setPayments('');
      setSources('');
      setThreadUrl('');
      setNotes('');
      setGeneratedDraft(null);
      setNewStatus('inbox');
    } catch {
      return;
    }
  };
  const saveIntake = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (!rawInput.trim()) return;
    try {
      await intakeMutation.mutateAsync();
    } catch {
      return;
    }
  };
  const createCategory = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (!newCategoryName.trim()) return;
    try {
      await categoryMutation.mutateAsync();
    } catch {
      return;
    }
  };
  const profiles = research.data?.data.profiles ?? [];
  const selectedProfile =
    profiles.find(profile => profile.id === selectedProfileId) ?? profiles[0] ?? null;
  const canManage = research.data?.data.canManage ?? false;
  const pagination = research.data?.data.pagination;
  return (
    <section
      className="rounded-2xl border border-[#E3E2E6] bg-white p-5 sm:p-6"
      aria-label="竞品研究库"
    >
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
            onChange={event => {
              setFilter(event.target.value as CompetitorResearchStatus | '');
              setPage(1);
            }}
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
      {canManage && (
        <div className="mt-5 grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(17rem,0.42fr)]">
          <form
            onSubmit={event => void saveIntake(event)}
            className="rounded-xl border border-[#C9D9E6] bg-[#F4F8FB] p-4 sm:p-5"
          >
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[#537695]">
                  Step 1 · 输入资料
                </p>
                <h3 className="mt-1 font-semibold text-[#3D3B4F]">
                  粘贴网站资料，生成并保存预调研
                </h3>
                <p className="mt-1 max-w-3xl text-xs leading-5 text-[#6F6D7A]">
                  粘贴 Title、URL、H1/H2/H3、定价或支付证据等公开资料。GLM
                  仅分析这段文字；原文、完整分析、品牌、种子词和支付判断会一起保存。
                </p>
              </div>
              <label className="min-w-32 text-xs">
                初始标记
                <select
                  className={`${controlClass} mt-2`}
                  value={intakeStatus}
                  disabled={intakeMutation.isPending}
                  onChange={event =>
                    setIntakeStatus(event.target.value as CompetitorResearchStatus)
                  }
                >
                  {Object.entries(researchStatusLabels).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <label className="mt-4 block text-xs">
              网站资料
              <textarea
                className={`${controlClass} mt-2 min-h-56 py-3 font-mono text-xs leading-5`}
                value={rawInput}
                onChange={event => setRawInput(event.target.value)}
                disabled={intakeMutation.isPending}
                required
                maxLength={12000}
                placeholder={
                  'Title: ...\nURL: https://example.com/\nH1: ...\nH2: ...\nPayment: ...'
                }
              />
            </label>
            <p className="mt-2 text-xs leading-5 text-[#6F6D7A]">
              必须包含公开 HTTPS
              URL。模型建议的业务分类和支付结论均待人工核验；不会访问目标网站或创建监控。
            </p>
            <Button type="submit" className="mt-3" disabled={intakeMutation.isPending}>
              <Sparkles size={16} className="mr-2" />
              {intakeMutation.isPending ? '正在分析并保存…' : '分析并保存预调研'}
            </Button>
            {intakeMutation.error && <ErrorNotice error={intakeMutation.error} />}
          </form>
          <form
            onSubmit={event => void createCategory(event)}
            className="h-fit rounded-xl border border-[#E3E2E6] bg-[#F9F8F6] p-4 sm:p-5"
          >
            <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[#6F6D7A]">
              可选整理
            </p>
            <h3 className="font-semibold text-[#3D3B4F]">人工分类</h3>
            <p className="mt-2 text-xs leading-5 text-[#6F6D7A]">
              新建分类后，可在每条研究档案的“手动划分与关联”中勾选；不会自动采纳模型建议。
            </p>
            <Input
              className="mt-3 min-h-11"
              value={newCategoryName}
              onChange={event => setNewCategoryName(event.target.value)}
              disabled={categoryMutation.isPending}
              required
              maxLength={40}
              placeholder="例如：AI 视频工具"
            />
            <Button
              type="submit"
              className="mt-3"
              variant="outline"
              disabled={categoryMutation.isPending}
            >
              <Plus size={16} className="mr-2" />
              新建分类
            </Button>
            {categoryMutation.error && <ErrorNotice error={categoryMutation.error} />}
          </form>
        </div>
      )}
      {notice && (
        <p
          role="status"
          className="mt-4 rounded-xl border border-[#B8DEC9] bg-[#F2FBF6] px-4 py-3 text-sm text-[#356848]"
        >
          {notice}
        </p>
      )}
      {research.error && (
        <div className="mt-4">
          <ErrorNotice error={research.error} />
          <Button className="mt-3" variant="outline" onClick={() => void research.refetch()}>
            重试读取研究库
          </Button>
        </div>
      )}
      {mutation.error && (
        <div className="mt-4">
          <ErrorNotice error={mutation.error} />
        </div>
      )}
      {research.isLoading ? (
        <p role="status" className="mt-5 text-sm text-[#6F6D7A]">
          正在读取研究档案…
        </p>
      ) : (
        <div className="mt-5 grid gap-4 xl:grid-cols-[minmax(18rem,0.58fr)_minmax(0,1.42fr)]">
          <section
            className="h-fit rounded-xl border border-[#E3E2E6] bg-[#F9F8F6] p-3 xl:sticky xl:top-5"
            aria-label="已保存分析结果"
          >
            <div className="flex flex-wrap items-baseline justify-between gap-2 px-1">
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[#6F6D7A]">
                  Step 2 · 结果列表
                </p>
                <h3 className="mt-1 text-sm font-semibold text-[#3D3B4F]">已保存分析结果</h3>
              </div>
              {pagination && (
                <span className="rounded-full bg-white px-2 py-1 text-xs text-[#6F6D7A]">
                  {pagination.total} 条
                </span>
              )}
            </div>
            {!profiles.length && (
              <p className="mt-3 rounded-lg bg-white p-4 text-sm text-[#6F6D7A]">
                当前筛选没有研究档案。空列表不代表市场没有竞品。
              </p>
            )}
            <ul className="mt-3 space-y-2" aria-label="研究结果列表">
              {profiles.map((profile, index) => {
                const selected = profile.id === selectedProfile?.id;
                return (
                  <li key={`${profile.id}:${profile.updatedAt}`}>
                    <button
                      type="button"
                      aria-pressed={selected}
                      onClick={() => setSelectedProfileId(profile.id)}
                      className={`w-full rounded-lg border p-3 text-left transition ${
                        selected
                          ? 'border-[#537695] bg-[#F4F8FB] shadow-sm ring-1 ring-[#C9D9E6]'
                          : 'border-[#E3E2E6] bg-white hover:border-[#9BB7CD]'
                      }`}
                    >
                      <span className="flex items-start justify-between gap-3">
                        <span className="flex min-w-0 items-start gap-2">
                          <span className="mt-0.5 shrink-0 text-[11px] font-semibold text-[#9B99A6]">
                            {String(((pagination?.page ?? 1) - 1) * pageSize + index + 1).padStart(
                              2,
                              '0'
                            )}
                          </span>
                          <span className="min-w-0 break-words text-sm font-semibold text-[#3D3B4F]">
                            {profile.brandName}
                          </span>
                        </span>
                        <span className="shrink-0 rounded-full bg-[#F9F8F6] px-2 py-0.5 text-[11px] text-[#6F6D7A]">
                          {researchStatusLabels[profile.lifecycleStatus]}
                        </span>
                      </span>
                      <span className="mt-1 block truncate text-xs text-[#537695]">
                        {profile.hostname}
                      </span>
                      {profile.productSummary && (
                        <span className="mt-2 block text-xs leading-5 text-[#6F6D7A]">
                          {profile.productSummary}
                        </span>
                      )}
                      <span className="mt-2 flex flex-wrap gap-x-2 gap-y-1 text-[11px] text-[#6F6D7A]">
                        <span>{profile.seedKeywords.length} 个种子词</span>
                        <span>{profile.paymentProviders.length} 条支付证据</span>
                        <span>{formatTime(profile.updatedAt)}</span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
            {pagination && (
              <nav
                aria-label="竞品研究库分页"
                className="mt-3 flex flex-wrap items-end justify-between gap-3 rounded-lg bg-white p-3 text-xs text-[#6F6D7A]"
              >
                <label className="min-w-28">
                  每页
                  <select
                    className="ml-2 rounded border bg-white px-2 py-1"
                    value={pageSize}
                    onChange={event => {
                      setPageSize(Number(event.target.value) as 10 | 20);
                      setPage(1);
                    }}
                  >
                    <option value={10}>10</option>
                    <option value={20}>20</option>
                  </select>
                </label>
                <span>
                  第 {pagination.page} / {pagination.totalPages} 页 · 共 {pagination.total} 条
                </span>
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={pagination.page <= 1}
                    onClick={() => setPage(1)}
                  >
                    首页
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={pagination.page <= 1}
                    onClick={() => setPage(current => Math.max(1, current - 1))}
                  >
                    上一页
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={pagination.page >= pagination.totalPages}
                    onClick={() => setPage(current => Math.min(pagination.totalPages, current + 1))}
                  >
                    下一页
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={pagination.page >= pagination.totalPages}
                    onClick={() => setPage(pagination.totalPages)}
                  >
                    末页
                  </Button>
                </div>
              </nav>
            )}
          </section>
          <div className="space-y-4">
            {selectedProfile ? (
              <ResearchProfileCard
                key={`${selectedProfile.id}:${selectedProfile.updatedAt}`}
                profile={selectedProfile}
                categories={categories}
                sites={sites}
                monitors={monitors.data?.data.monitors ?? []}
                canManage={canManage}
                pending={mutation.isPending}
                onAction={action => mutation.mutateAsync(action)}
              />
            ) : (
              <p className="rounded-xl border border-[#E3E2E6] bg-white p-4 text-sm text-[#6F6D7A]">
                从左侧列表选择一条结果查看完整资料。
              </p>
            )}
            {canManage ? (
              <details className="h-fit rounded-xl border border-[#E3E2E6] bg-[#F9F8F6] p-4">
                <summary className="cursor-pointer text-sm font-semibold text-[#3D3B4F]">
                  手动补充研究档案
                </summary>
                <p className="mt-2 text-xs leading-5 text-[#6F6D7A]">
                  仅在无法粘贴完整资料时使用。可先生成待核验草稿；只发送本表的
                  URL、标题、摘要和种子词；不会读取目标站、插件数据、Cookie 或 Codex
                  任务，也不会自动保存或创建监控。
                </p>
                <form onSubmit={event => void create(event)}>
                  <Button
                    type="button"
                    className="mt-3"
                    variant="outline"
                    disabled={draftMutation.isPending}
                    onClick={() => void generateDraft()}
                  >
                    <Sparkles size={16} className="mr-2" />
                    {draftMutation.isPending ? '正在生成草稿…' : '生成待核验草稿'}
                  </Button>
                  {draftMutation.error && <ErrorNotice error={draftMutation.error} />}
                  {generatedDraft && (
                    <aside className="mt-4 rounded-xl border border-[#C9D9E6] bg-[#F4F8FB] p-4 text-sm">
                      <p className="font-medium text-[#3D3B4F]">
                        {generatedDraft.provider === 'glm' ? 'GLM 优先模型' : 'Terra 后备模型'} ·{' '}
                        {generatedDraft.model}
                      </p>
                      <p className="mt-2 whitespace-pre-wrap break-words leading-6 text-[#555163]">
                        {generatedDraft.draft.productSummary ?? '未生成产品摘要'}
                      </p>
                      {generatedDraft.draft.seedKeywords.length > 0 && (
                        <p className="mt-2 break-words text-xs text-[#6F6D7A]">
                          建议种子词：{generatedDraft.draft.seedKeywords.join(' · ')}
                        </p>
                      )}
                      {generatedDraft.draft.paymentProviders.length > 0 && (
                        <p className="mt-2 break-words text-xs text-[#6F6D7A]">
                          待核验支付候选：
                          {generatedDraft.draft.paymentProviders
                            .map(item => item.provider)
                            .join(' · ')}
                        </p>
                      )}
                      {generatedDraft.draft.evidenceGaps.length > 0 && (
                        <p className="mt-2 break-words text-xs text-[#6F6D7A]">
                          待补证据：{generatedDraft.draft.evidenceGaps.join(' · ')}
                        </p>
                      )}
                      <p className="mt-3 text-xs leading-5 text-[#6F6D7A]">
                        {generatedDraft.limitations[1]}
                      </p>
                      <div className="mt-3 flex flex-wrap gap-2">
                        <Button type="button" size="sm" onClick={applyDraft}>
                          应用到表单
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={() => setGeneratedDraft(null)}
                        >
                          丢弃草稿
                        </Button>
                      </div>
                    </aside>
                  )}
                  <fieldset disabled={mutation.isPending} className="mt-4 grid gap-3">
                    <label className="text-xs">
                      品牌 / 网站名称
                      <Input
                        className="mt-2 min-h-11"
                        value={brandName}
                        onChange={event => setBrandName(event.target.value)}
                        required
                        maxLength={100}
                        placeholder="例如 OpenSourceGen"
                      />
                    </label>
                    <label className="text-xs">
                      首页公开 HTTPS URL
                      <Input
                        className="mt-2 min-h-11"
                        type="url"
                        value={homepageUrl}
                        onChange={event => setHomepageUrl(event.target.value)}
                        required
                        maxLength={500}
                        placeholder="https://example.com/"
                      />
                    </label>
                    <label className="text-xs">
                      页面标题 / 已知文案（可选）
                      <Input
                        className="mt-2 min-h-11"
                        value={pageTitle}
                        onChange={event => setPageTitle(event.target.value)}
                        maxLength={200}
                        placeholder="例如 AI Image Generator for Creators"
                      />
                    </label>
                    <label className="text-xs">
                      初始状态
                      <select
                        className={`${controlClass} mt-2`}
                        value={newStatus}
                        onChange={event =>
                          setNewStatus(event.target.value as CompetitorResearchStatus)
                        }
                      >
                        {Object.entries(researchStatusLabels).map(([value, label]) => (
                          <option key={value} value={value}>
                            {label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="text-xs">
                      产品 / 品类结论
                      <textarea
                        className={`${controlClass} mt-2 min-h-22 py-2`}
                        value={summary}
                        onChange={event => setSummary(event.target.value)}
                        maxLength={4000}
                        placeholder="例如：开源模型聚合的图片与视频生成工具"
                      />
                    </label>
                    <label className="text-xs">
                      种子词（逗号或换行分隔）
                      <textarea
                        className={`${controlClass} mt-2 min-h-20 py-2`}
                        value={keywords}
                        onChange={event => setKeywords(event.target.value)}
                        maxLength={5000}
                        placeholder="AI image generator, AI video generator"
                      />
                    </label>
                    <label className="text-xs">
                      支付网关（`名称:状态`，状态为 confirmed / evidence_only / disabled / unknown）
                      <Input
                        className="mt-2 min-h-11"
                        value={payments}
                        onChange={event => setPayments(event.target.value)}
                        maxLength={1200}
                        placeholder="Stripe:confirmed, PayPal:evidence_only"
                      />
                    </label>
                    <label className="text-xs">
                      证据来源 URL（逗号或换行分隔）
                      <textarea
                        className={`${controlClass} mt-2 min-h-20 py-2`}
                        value={sources}
                        onChange={event => setSources(event.target.value)}
                        maxLength={5000}
                        placeholder="https://example.com/pricing"
                      />
                    </label>
                    <label className="text-xs">
                      来源任务 / 备注链接（可选）
                      <Input
                        className="mt-2 min-h-11"
                        value={threadUrl}
                        onChange={event => setThreadUrl(event.target.value)}
                        maxLength={2048}
                        placeholder="codex://threads/..."
                      />
                    </label>
                    <label className="text-xs">
                      研究备注（可选）
                      <textarea
                        className={`${controlClass} mt-2 min-h-20 py-2`}
                        value={notes}
                        onChange={event => setNotes(event.target.value)}
                        maxLength={4000}
                      />
                    </label>
                    <Button type="submit">
                      <Plus size={16} className="mr-2" />
                      保存研究档案
                    </Button>
                  </fieldset>
                </form>
              </details>
            ) : (
              <p className="rounded-xl bg-[#F9F8F6] p-4 text-sm text-[#6F6D7A]">
                当前账号只读，可查看研究结论和关联关系。
              </p>
            )}
          </div>
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
  const saveLinks = async (
    kind: 'categories' | 'sites' | 'monitors',
    ids: string[]
  ): Promise<void> => {
    try {
      await onAction({
        suffix: `/${encodeURIComponent(profile.id)}/${kind}`,
        method: 'PUT',
        body: { ids },
      });
    } catch {
      return;
    }
  };
  const selected = (event: FormEvent<HTMLSelectElement>): string[] =>
    Array.from(event.currentTarget.selectedOptions, option => option.value);
  const primaryFinding = keyFinding(profile);
  const analysisSections = profile.analysis
    ? detailedAnalysisSections(profile.analysis.detailedAnalysis)
    : [];
  const paymentConclusion = paymentFinding(profile, analysisSections);
  return (
    <article className="rounded-xl border border-[#E3E2E6] bg-white p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="break-words font-semibold text-[#3D3B4F]">{profile.brandName}</h3>
          <a
            className="mt-1 block break-all text-xs text-[#537695]"
            href={profile.homepageUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            {profile.homepageUrl}
          </a>
        </div>
        {canManage ? (
          <select
            aria-label={`${profile.brandName}研究状态`}
            className="min-h-9 rounded-lg border px-2 text-xs"
            value={status}
            disabled={pending}
            onChange={event => {
              const next = event.target.value as CompetitorResearchStatus;
              setStatus(next);
              void onAction({
                suffix: `/${encodeURIComponent(profile.id)}`,
                method: 'PATCH',
                body: { lifecycleStatus: next },
              }).catch(() => {
                setStatus(profile.lifecycleStatus);
              });
            }}
          >
            {Object.entries(researchStatusLabels).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        ) : (
          <span className="rounded-full bg-[#F9F8F6] px-2 py-1 text-xs">
            {researchStatusLabels[profile.lifecycleStatus]}
          </span>
        )}
      </div>
      {profile.productSummary && (
        <p className="mt-3 whitespace-pre-wrap break-words text-sm leading-6 text-[#555163]">
          {profile.productSummary}
        </p>
      )}
      <ResearchChips label="种子词" values={profile.seedKeywords} />
      <ResearchChips
        label="支付"
        values={profile.paymentProviders.map(item => `${item.provider} · ${item.status}`)}
      />
      <ResearchChips label="业务分类" values={profile.categories.map(category => category.name)} />
      <ResearchChips label="关联站点" values={profile.sites.map(site => site.name)} />
      <ResearchChips label="关联监控" values={profile.monitors.map(monitor => monitor.name)} />
      {profile.sources.length > 0 && (
        <p className="mt-3 break-words text-xs leading-5 text-[#6F6D7A]">
          证据来源：{profile.sources.map(source => source.url).join(' · ')}
        </p>
      )}
      {profile.notes && (
        <p className="mt-3 whitespace-pre-wrap break-words text-xs leading-5 text-[#6F6D7A]">
          备注：{profile.notes}
        </p>
      )}
      {(profile.analysis || profile.rawInput) && (
        <section className="mt-5 border-t border-[#E3E2E6] pt-5" aria-label="预调研输入与结果">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[#537695]">
                输入 → 结果
              </p>
              <h4 className="mt-1 text-sm font-semibold text-[#3D3B4F]">预调研记录</h4>
            </div>
            {profile.analysis && (
              <p className="text-xs text-[#6F6D7A]">
                {profile.analysis.provider === 'glm' ? 'GLM' : 'Terra'} · {profile.analysis.model} ·{' '}
                {formatTime(profile.analysis.generatedAt)}
              </p>
            )}
          </div>
          <div className="mt-3 grid gap-3 xl:grid-cols-2">
            <section className="rounded-xl border border-[#C9D9E6] bg-[#F4F8FB] p-3">
              <h5 className="text-sm font-semibold text-[#3D3B4F]">输入资料</h5>
              <p className="mt-1 text-xs leading-5 text-[#6F6D7A]">
                已保存的公开资料原文，可直接复制；不会在此处修改原始记录。
              </p>
              <textarea
                aria-label={`${profile.brandName}原始输入资料`}
                className={`${controlClass} mt-3 h-[34rem] resize-y py-3 font-mono text-xs leading-5 text-[#555163]`}
                readOnly
                value={profile.rawInput ?? ''}
                placeholder="未保存原始输入。"
              />
            </section>
            <section className="rounded-xl border border-[#C9D9E6] bg-white p-3">
              <h5 className="text-sm font-semibold text-[#3D3B4F]">分析结果</h5>
              <dl className="mt-3 overflow-hidden rounded-lg border border-[#E3E2E6]">
                <div className="grid grid-cols-[5rem_minmax(0,1fr)] gap-4 border-b border-[#E3E2E6] bg-[#F9F8F6] px-3 py-2 text-xs font-semibold text-[#3D3B4F]">
                  <dt>项目</dt>
                  <dd>结论</dd>
                </div>
                <div className="grid grid-cols-[5rem_minmax(0,1fr)] gap-4 border-b border-[#E3E2E6] px-3 py-3">
                  <dt className="text-sm font-semibold text-[#3D3B4F]">品类</dt>
                  <dd className="whitespace-pre-wrap break-words text-sm font-medium leading-6 text-[#2F2D3A]">
                    {primaryFinding ?? '未保存品类结论。'}
                  </dd>
                </div>
                <div className="grid grid-cols-[5rem_minmax(0,1fr)] gap-4 border-b border-[#E3E2E6] px-3 py-3">
                  <dt className="text-sm font-semibold text-[#3D3B4F]">种子词</dt>
                  <dd className="flex flex-wrap gap-1.5">
                    {profile.seedKeywords.length ? (
                      profile.seedKeywords.map(keyword => (
                        <span
                          key={keyword}
                          className="rounded-full bg-[#EFF0F2] px-2 py-1 font-mono text-xs leading-4 text-[#3D3B4F]"
                        >
                          {keyword}
                        </span>
                      ))
                    ) : (
                      <span className="text-sm text-[#6F6D7A]">未保存种子词。</span>
                    )}
                  </dd>
                </div>
                <div className="grid grid-cols-[5rem_minmax(0,1fr)] gap-4 px-3 py-3">
                  <dt className="text-sm font-semibold text-[#3D3B4F]">支付网关</dt>
                  <dd className="whitespace-pre-wrap break-words text-sm leading-6 text-[#2F2D3A]">
                    {paymentConclusion}
                  </dd>
                </div>
              </dl>
              <p className="mt-3 text-xs leading-5 text-[#6F6D7A]">
                结论仅基于左侧输入；品类与支付状态仍需人工核验。
              </p>
            </section>
          </div>
        </section>
      )}
      {canManage && (
        <details className="mt-4 rounded-lg bg-[#F9F8F6] p-3">
          <summary className="cursor-pointer text-sm font-medium">手动划分与关联</summary>
          <div className="mt-4 grid gap-3">
            <ResearchLinkSelect
              label="业务分类（多选）"
              value={categoryIds}
              options={categories.map(category => ({ id: category.id, label: category.name }))}
              disabled={pending}
              onChange={event => setCategoryIds(selected(event))}
              onSave={() => void saveLinks('categories', categoryIds)}
            />
            <ResearchLinkSelect
              label="己方网站（多选）"
              value={siteIds}
              options={sites.map(site => ({ id: site.id, label: `${site.name} · ${site.domain}` }))}
              disabled={pending}
              onChange={event => setSiteIds(selected(event))}
              onSave={() => void saveLinks('sites', siteIds)}
            />
            <ResearchLinkSelect
              label="已有监控（多选）"
              value={monitorIds}
              options={monitors.map(monitor => ({
                id: monitor.id,
                label: `${monitor.name} · ${monitor.url}`,
              }))}
              disabled={pending}
              onChange={event => setMonitorIds(selected(event))}
              onSave={() => void saveLinks('monitors', monitorIds)}
            />
            <p className="text-xs leading-5 text-[#6F6D7A]">
              研究档案不会新增监控。需监控时先在下方“添加公开页面”中手动创建，并保持手动频率；再回到这里关联该已有记录。
            </p>
          </div>
        </details>
      )}
    </article>
  );
}

function ResearchChips({
  label,
  values,
}: {
  label: string;
  values: string[];
}): ReactElement | null {
  if (!values.length) return null;
  return (
    <p className="mt-3 break-words text-xs text-[#6F6D7A]">
      <span className="mr-2">{label}</span>
      {values.join(' · ')}
    </p>
  );
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
      <select
        multiple
        className={`${controlClass} mt-2 min-h-24 py-2`}
        value={value}
        disabled={disabled}
        onChange={onChange}
      >
        {options.map(option => (
          <option key={option.id} value={option.id}>
            {option.label}
          </option>
        ))}
      </select>
      <Button
        type="button"
        className="mt-2"
        size="sm"
        variant="outline"
        disabled={disabled}
        onClick={onSave}
      >
        保存关联
      </Button>
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
