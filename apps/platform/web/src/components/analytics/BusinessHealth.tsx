import { AlertCircle, RefreshCw } from 'lucide-react';
import type { ReactElement } from 'react';
import type { buildAnalysisPackage } from '@traks/shared';

type BusinessReport = ReturnType<typeof buildAnalysisPackage>;
const CONTROL =
  'min-h-11 rounded-md border border-[#E6E4DE] bg-white px-3 py-2 text-base sm:text-sm text-[#3D3B4F] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#467B64] disabled:cursor-not-allowed disabled:opacity-50';
const OUTCOMES: Record<string, string> = {
  failed: '失败信号',
  blocked: '业务受限',
  cancelled: '取消操作',
  invalid: '输入校验',
};
const REASONS: Record<string, string> = {
  unknown: '原因未知',
  operation_cancelled: '操作取消',
  timeout: '请求超时',
  offline: '离线',
  network_unresolved: '网络返回未完成',
  permission_denied: '权限不足',
  quota_exceeded: '浏览器配额不足',
  clipboard_unavailable: '剪贴板不可用',
  insecure_context: '非安全页面环境',
  validation_rejected: '输入校验未通过',
  required: '必填项缺失',
  format: '格式不符',
  range: '超出范围',
  step: '步长不符',
  length: '长度不符',
  bad_input: '输入无效',
  login_required: '需要登录',
  upgrade_required: '需要升级权限',
  limit_reached: '业务额度已满',
  auth_rejected: '认证被拒绝',
  verification_required: '需要验证',
  not_found: '资源不存在',
  rate_limited: '请求受限',
  server_error: '服务端返回错误',
  http_rejected: 'HTTP 请求被拒绝',
  invalid_response: '响应格式无效',
  missing_result: '没有可用结果',
  resource_load: '资源加载失败',
  type_error: '类型错误',
  range_error: '运行范围错误',
  reference_error: '引用错误',
  syntax_error: '语法错误',
};

export function formatBusinessTimestamp(value: string | number | null | undefined): string {
  if (typeof value !== 'string' && typeof value !== 'number') return '未知';
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? `${date.toISOString().replace('T', ' ').slice(0, 19)} UTC`
    : '未知';
}

const count = (value: unknown): string =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value.toLocaleString('en-US')
    : '未知';

export function BusinessReadStatus({
  label,
  hasData,
  isFetching,
  isError,
  lastUpdatedAt,
  statusCode,
  onRetry,
}: {
  label: string;
  hasData: boolean;
  isFetching: boolean;
  isError: boolean;
  lastUpdatedAt: number;
  statusCode?: number;
  onRetry?: () => void;
}): ReactElement {
  const decisionError = statusCode !== undefined && [401, 403, 404].includes(statusCode);
  const errorMessage =
    statusCode === 401
      ? '登录状态已过期，请重新登录后读取。'
      : statusCode === 403
        ? '当前账号无权读取此统计。'
        : statusCode === 404
          ? '站点不存在或当前账号无法访问。'
          : statusCode === 409
            ? '完整统计窗口暂未就绪或证据已变化，请重新读取。'
            : statusCode === 400
              ? '所选统计窗口不受支持，请核对日期范围。'
              : `${label}暂不可用，请重试。`;
  return (
    <div className="space-y-2 text-base sm:text-sm" aria-busy={isFetching}>
      <p
        role={isError && !isFetching ? 'alert' : 'status'}
        className={`flex items-start gap-2 ${isError && !isFetching ? 'text-[#8A503A]' : 'text-[#6E6C7C]'}`}
      >
        {isFetching ? (
          <RefreshCw
            aria-hidden="true"
            className="mt-0.5 size-4 shrink-0 animate-spin motion-reduce:animate-none"
          />
        ) : isError ? (
          <AlertCircle aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
        ) : null}
        <span>
          {isFetching
            ? hasData
              ? `${label}更新中，保留上次完整读数。`
              : `正在读取${label}…`
            : isError
              ? `${errorMessage} ${hasData ? '下方仅为上次完整读数。' : ''}未将读取失败记为零。`
              : hasData
                ? `${label}读取完成。`
                : `${label}尚未读取，数据未知。`}
        </span>
      </p>
      {hasData && lastUpdatedAt > 0 && (
        <p className="text-xs text-[#6E6C7C]">
          上次成功读取：{formatBusinessTimestamp(lastUpdatedAt)}，不是最新事件时间。
        </p>
      )}
      {isError && onRetry && !decisionError && (
        <button type="button" className={CONTROL} onClick={onRetry} disabled={isFetching}>
          {isFetching ? `正在读取${label}…` : `重试${label}`}
        </button>
      )}
    </div>
  );
}

export function BusinessHealth({
  report,
  onInspectQuality,
}: {
  report: BusinessReport;
  onInspectQuality?: () => void;
}): ReactElement {
  const issues = Array.isArray(report.issues) ? report.issues : null;
  const recent = issues ? [...issues].sort((a, b) => b.lastAt - a.lastAt).slice(0, 5) : [];
  return (
    <section
      aria-label="当前窗口质量观测"
      className="min-w-0 rounded-xl border border-[#E6E4DE] bg-white p-4 sm:p-5"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-base font-semibold">当前窗口质量观测</h3>
        {onInspectQuality && (
          <button type="button" className={CONTROL} onClick={onInspectQuality}>
            查看质量明细
          </button>
        )}
      </div>
      <p className="mt-3 break-words text-base text-[#6E6C7C] sm:text-sm">
        {report.scope.cohortFilterKeys.length ? '当前筛选会话窗口' : '当前站点统计窗口'} ·
        {report.scope.source === 'live' ? '实时库' : '历史库'} ·
        {report.scope.complete ? '完整读取' : '覆盖未知'} · production 标记口径，非已验证真人
      </p>
      <dl className="mt-3 space-y-1 break-words text-xs text-[#6E6C7C]">
        <div>
          <dt className="inline">窗口开始：</dt>
          <dd className="inline">{formatBusinessTimestamp(report.scope.from)}</dd>
        </div>
        <div>
          <dt className="inline">数据截止：</dt>
          <dd className="inline">{formatBusinessTimestamp(report.scope.to)}</dd>
        </div>
        <div>
          <dt className="inline">报告生成：</dt>
          <dd className="inline">{formatBusinessTimestamp(report.generatedAt)}</dd>
        </div>
      </dl>
      <dl className="mt-5 grid gap-4 border-y border-[#E6E4DE] py-4 sm:grid-cols-3">
        {[
          ['生产标记问题分组', issues?.length],
          ['生产标记诊断受限会话', report.population.selectedLimitedSessions],
          ['全窗口未关联事件', report.population.wholeCohortUnassociatedEvents],
        ].map(([label, value]) => (
          <div key={String(label)}>
            <dt className="text-base text-[#6E6C7C] sm:text-sm">{label}</dt>
            <dd className="mt-1 text-xl font-semibold tabular-nums">{count(value)}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-3 text-base text-[#6E6C7C] sm:text-sm">
        未关联事件来自全窗口（含 QA、内部与未知流量），不是生产失败数；诊断受限表示信号可能不完整。
      </p>
      {!issues ? (
        <p className="mt-4 text-base sm:text-sm">异常覆盖未知，不能按零解释。</p>
      ) : issues.length === 0 ? (
        <p className="mt-4 text-base sm:text-sm">此窗口未观测到已分类异常，不等于没有故障。</p>
      ) : (
        <div className="mt-4">
          <h4 className="text-base font-semibold sm:text-sm">
            最近 {recent.length} 组 · 共 {issues.length} 组
          </h4>
          <ul className="mt-2 divide-y divide-[#E6E4DE]">
            {recent.map((issue, index) => (
              <li key={index} className="space-y-1 py-3 text-base sm:text-sm">
                <p className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="font-medium">{OUTCOMES[issue.outcome] ?? '分类未知'}</span>
                  <span className="text-[#6E6C7C]">
                    {count(issue.sessions)} 个分组会话 · {count(issue.events)} 个信号
                  </span>
                </p>
                <p className="break-all">{issue.path}</p>
                <p className="break-words text-[#6E6C7C]">
                  {issue.kind} · {REASONS[issue.reason] ?? '原因未知'}
                  {issue.httpStatus ? ` · HTTP ${issue.httpStatus}` : ''}
                </p>
                <p className="break-words text-base text-[#6E6C7C] sm:text-sm">
                  {issue.version} · {issue.locale} · {issue.browser}
                </p>
                <p className="break-words text-xs text-[#6E6C7C]">
                  最近观测：{formatBusinessTimestamp(issue.lastAt)}
                </p>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-base text-[#6E6C7C] sm:text-sm">
            分组可重叠，分组会话数不能相加为独立人数；原因线索，非根因。
          </p>
        </div>
      )}
      <p className="mt-4 text-base text-[#6E6C7C] sm:text-sm">
        仅展示当前读取的窗口证据，不提供独立可用性探测或后台告警。未见后续不等于真实流失；当前未提供同口径经营趋势。
      </p>
    </section>
  );
}
