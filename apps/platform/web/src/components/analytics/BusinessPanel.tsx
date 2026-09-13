import { useQuery } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import type { ReactElement } from 'react';
import { ENTRY_FUNNEL_STAGES, MIN_RATE_SAMPLE, type Period } from '@traks/shared';
import { api, type AnalyticsFilters } from '@/lib/api';

const goals: Record<string, string> = {
  toolSuccessSessions: '计算成功',
  copySuccessSessions: '复制成功',
  saveSuccessSessions: '保存成功',
  pdfSuccessSessions: 'PDF 导出成功',
  quoteHandoffSessions: '报价交接',
  acceptedRequestSessions: '联系受理',
};
const entries: Record<string, string> = {
  article: '文章进入',
  tool_direct: '工具直达',
  directory: '工具目录',
  other: '其他入口',
  unknown: '入口未知',
};
const stages: Record<string, string> = {
  Entry: '入口会话',
  'Tool visit': '工具访问',
  Submit: '提交',
  Success: '计算成功',
  'Result use': '结果使用',
};

export function BusinessPanel({
  siteId,
  period,
  filters,
}: {
  siteId: string;
  period: Period;
  filters?: AnalyticsFilters;
}): ReactElement {
  const query = useQuery({
    queryKey: ['site-business', siteId, period, filters],
    queryFn: ({ signal }) => api.getQualityInsights(siteId, period, filters, signal),
    staleTime: 60_000,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const report = query.data?.data;
  const crmAllowed = !!report && Date.parse(report.scope.from) >= Date.now() - 90 * 86_400_000;
  const crm = useQuery({
    queryKey: [
      'site-business-crm',
      siteId,
      report?.scope.from,
      report?.scope.to,
      query.dataUpdatedAt,
    ],
    queryFn: ({ signal }) =>
      api.getCrmQuality(siteId, report!.scope.from, report!.scope.to, signal),
    enabled: crmAllowed,
    retry: false,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
  const registrations = crm.data && 'registrations' in crm.data ? crm.data.registrations : null;
  return (
    <section aria-label="经营统计" className="min-w-0 space-y-6 py-4 text-[#3D3B4F]">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">经营统计</h2>
        <button
          title="刷新经营统计"
          aria-label="刷新经营统计"
          disabled={query.isFetching || crm.isFetching}
          onClick={() => {
            void query.refetch();
          }}
          className="flex size-11 shrink-0 items-center justify-center rounded-md border bg-white disabled:opacity-50"
        >
          <RefreshCw className={query.isFetching ? 'size-4 animate-spin' : 'size-4'} />
        </button>
      </div>
      {query.isError ? (
        <p role="alert">统计暂不可用，请重试。未将读取失败记为零。</p>
      ) : !report ? (
        <p role="status">正在读取完整统计窗口…</p>
      ) : (
        <>
          <p className="break-words text-xs text-[#6E6C7C]">
            {report.scope.from} 至 {report.scope.to} · {report.scope.source} · production
            标记口径，非已验证真人
          </p>
          <dl className="grid grid-cols-2 gap-4 border-y py-4 sm:grid-cols-4">
            {Object.entries(report.population.wholeCohortClassification).map(([key, count]) => (
              <div key={key}>
                <dt className="text-xs text-[#6E6C7C]">
                  {
                    {
                      production: '生产标记会话',
                      qa: 'QA 会话',
                      internal: '内部会话',
                      unknown: '未分类会话',
                    }[key]
                  }
                </dt>
                <dd className="mt-1 text-xl font-semibold">{count}</dd>
              </div>
            ))}
          </dl>
          <p className="text-sm">
            生产浏览量 {report.business.pageviews} · 自定义事件 {report.business.customEvents} ·
            会话分母 {report.business.sessions}
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <caption className="pb-3 text-left font-semibold">生产标记目标</caption>
              <thead>
                <tr>
                  <th className="py-2">目标</th>
                  <th>观测会话</th>
                  <th>占所选会话</th>
                </tr>
              </thead>
              <tbody>
                {report.business.goals.map(goal => (
                  <tr key={goal.key} className="border-t">
                    <td className="py-3">{goals[goal.key]}</td>
                    <td>
                      {goal.sessions} / {goal.denominator}
                    </td>
                    <td>{goal.rate === null ? '无分母' : `${(goal.rate * 100).toFixed(1)}%`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {report.business.sessions < MIN_RATE_SAMPLE && (
            <p className="text-sm text-[#6E6C7C]">样本不足，比例仅作观测，尚不能判断优化效果。</p>
          )}
          <div className="overflow-x-auto">
            <table className="w-full min-w-[540px] text-left text-sm">
              <caption className="pb-3 text-left font-semibold">
                入口漏斗 · 同一页面访问内有序完成
              </caption>
              <thead>
                <tr>
                  <th className="py-2">入口</th>
                  {ENTRY_FUNNEL_STAGES.map(stage => (
                    <th key={stage}>{stages[stage]}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {report.entryFunnels.map(funnel => (
                  <tr key={funnel.entry} className="border-t">
                    <td className="py-3">{entries[funnel.entry]}</td>
                    {funnel.stages.map((value, index) => (
                      <td key={index}>{value}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            {!report.entryFunnels.length && (
              <p className="py-3 text-sm">此窗口暂无生产标记入口证据。</p>
            )}
          </div>
          <p className="text-xs text-[#6E6C7C]">
            目标为独立观测；漏斗要求同一会话、页面标识及版本的递增时序。缺失、并发或相同时间戳不强行关联，未见后续不等于真实流失。
          </p>
        </>
      )}
      <div className="space-y-3 border-t pt-5">
        <h3 className="font-semibold">注册与业务记录</h3>
        {crm.isError ? (
          <p role="alert">业务数据暂不可用，不能按零解释。</p>
        ) : !crmAllowed ? (
          <p className="text-sm">等待统计窗口；业务聚合仅支持最近 90 天。</p>
        ) : crm.isPending ? (
          <p role="status">正在读取业务聚合…</p>
        ) : (
          <>
            {registrations ? (
              <>
                <p className="text-xs text-[#6E6C7C]">
                  当前数据库快照 · {registrations.asOf} · 包含站主、测试和封禁账号，不是已验证真人数
                </p>
                <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                  {[
                    ['注册账号总数', registrations.total],
                    ['站主账号', registrations.ownerAccounts],
                    ['其他账号', registrations.otherAccounts],
                    ['窗口内注册', registrations.createdInWindow],
                    ['已验证账号', registrations.verifiedAccounts],
                    ['未验证账号', registrations.unverifiedAccounts],
                    ['封禁账号', registrations.bannedAccounts],
                  ].map(([label, value]) => (
                    <div key={label}>
                      <dt className="text-xs text-[#6E6C7C]">{label}</dt>
                      <dd className="mt-1 text-xl font-semibold">{value}</dd>
                    </div>
                  ))}
                </dl>
              </>
            ) : (
              <p className="text-sm">注册聚合未接通，人数未知。</p>
            )}
            {crm.data?.status === 'connected' && (
              <p className="text-sm">
                生产标记联系请求 {crm.data.counts.requests} · 站主确认有效请求{' '}
                {crm.data.counts.ownerQualified} · 跟进发送
                {crm.data.followupSendingEnabled ? '已开启' : '关闭'}
              </p>
            )}
            <p className="text-xs text-[#6E6C7C]">
              业务记录与匿名会话不做身份关联，不受页面/渠道筛选影响。已删除账号不在当前快照内；零请求不代表零注册。
            </p>
          </>
        )}
      </div>
    </section>
  );
}
