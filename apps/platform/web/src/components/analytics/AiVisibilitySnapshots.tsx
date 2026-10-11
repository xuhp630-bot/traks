import { useId, useState, type ReactElement } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AI_VISIBILITY_MAX_BYTES,
  AI_VISIBILITY_QUERY_KEY,
  aiVisibilityInputSchema,
  aiVisibilityReportSchema,
  aiVisibilitySnapshotReadSchema,
  aiVisibilityRowSum,
  type AiVisibilityInput,
  type AiVisibilityReport,
  type AiVisibilitySnapshot,
  type AiVisibilitySnapshotRead,
} from '@traks/shared';
import { api, ApiError } from '@/lib/api';

export const aiVisibilityQueryKey = (siteId: string): readonly string[] => [
  AI_VISIBILITY_QUERY_KEY,
  siteId,
];

type JsonFile = Pick<File, 'name' | 'size' | 'text'>;
type PendingImport = { snapshotId: string; acceptedAt: string };
export const AI_VISIBILITY_PREVIOUS_CURSOR_LIMIT = 16;
export type AiVisibilityExactRead = AiVisibilitySnapshotRead;

/** Reject old whole-history contracts and incorrectly scoped records. */
export function compatibleAiVisibilityReport(
  value: unknown,
  siteId: string
): value is AiVisibilityReport {
  const parsed = aiVisibilityReportSchema.safeParse(value);
  return parsed.success && parsed.data.snapshots.every(snapshot => snapshot.siteId === siteId);
}

export function compatibleAiVisibilityExactRead(
  value: unknown,
  siteId: string,
  snapshotId: string
): value is AiVisibilityExactRead {
  const parsed = aiVisibilitySnapshotReadSchema.safeParse(value);
  return (
    parsed.success &&
    parsed.data.snapshot.siteId === siteId &&
    parsed.data.snapshot.snapshotId === snapshotId
  );
}

class AiVisibilityCapabilityError extends Error {}

const count = (value: number | null): string =>
  value === null ? '未知' : value.toLocaleString('en-US');

const dated = (value: string | null): string => {
  if (!value) return '未知';
  const date = new Date(value);
  return Number.isFinite(date.valueOf()) ? date.toISOString().replace('T', ' ') : '未知';
};

/** JSON only: validate in memory before the owner-authorized POST. */
export async function readAiVisibilityJsonFile(file: JsonFile): Promise<AiVisibilityInput> {
  if (!file.name.toLowerCase().endsWith('.json')) {
    throw new Error('请选择 .json 快照文件；此入口不解析 ZIP、CSV 或 Excel。');
  }
  if (file.size === 0 || file.size > AI_VISIBILITY_MAX_BYTES) {
    throw new Error(`快照文件必须非空，且不超过 ${AI_VISIBILITY_MAX_BYTES / 1024} KiB。`);
  }
  const text = await file.text();
  if (new TextEncoder().encode(text).byteLength > AI_VISIBILITY_MAX_BYTES) {
    throw new Error('快照内容超过允许大小，尚未提交。');
  }
  let input: unknown;
  try {
    input = JSON.parse(text);
  } catch {
    throw new Error('JSON 解析失败，尚未提交；请检查快照文件格式。');
  }
  const parsed = aiVisibilityInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new Error(
      '快照不符合 ai-visibility-snapshot/v1 合同，尚未提交；请核对平台、属性、日期、指标和完整性字段。'
    );
  }
  return parsed.data;
}

/** Export every retained row in the same validated import shape. */
export function serializeAiVisibilitySnapshot(snapshot: AiVisibilitySnapshot): string {
  const { snapshotId: _snapshotId, siteId: _siteId, origin: _origin, ...input } = snapshot;
  return JSON.stringify(input, null, 2);
}

function downloadSnapshot(snapshot: AiVisibilitySnapshot): void {
  const blob = new Blob([serializeAiVisibilitySnapshot(snapshot)], {
    type: 'application/json',
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `ai-visibility-${snapshot.provider}-${snapshot.snapshotId}.json`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Revoking after the click preserves the browser's download opportunity.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function SnapshotCard({
  snapshot,
  onExport,
}: {
  snapshot: AiVisibilitySnapshot;
  onExport?: (snapshot: AiVisibilitySnapshot) => void;
}): ReactElement {
  const google = snapshot.provider === 'google_search_ai';
  const pageSum = aiVisibilityRowSum(snapshot.pageRows);
  const dateSum = aiVisibilityRowSum(snapshot.dateRows);
  const groupingDiffers =
    snapshot.total.value !== null &&
    [pageSum, dateSum].some(value => value !== null && value !== snapshot.total.value);
  return (
    <article className="min-w-0 rounded-xl border border-[#E6E4DE] p-4 text-xs sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-base font-semibold text-[#3D3B4F]">
          {google ? 'Google Search AI · 曝光快照' : 'Bing AI surfaces · 引用快照'}
        </h3>
        <button
          type="button"
          disabled={!onExport}
          onClick={() => onExport?.(snapshot)}
          className="min-h-11 rounded-lg border border-[#E6E4DE] bg-white px-3 text-xs font-medium text-[#3D3B4F] disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#467B64]"
        >
          导出完整快照 JSON
        </button>
      </div>
      <dl className="mt-4 grid gap-3 sm:grid-cols-2">
        {[
          [
            '官方来源',
            google ? 'Google Search Console AI report' : 'Bing Webmaster AI Performance',
          ],
          ['属性', snapshot.property],
          ['来源捕获时间', dated(snapshot.capturedAt)],
          ['数据窗口（包含首尾日期）', `${snapshot.window.startDate} → ${snapshot.window.endDate}`],
          [
            '源报表时区',
            snapshot.window.timezone === 'provider_unspecified'
              ? '平台未指定'
              : snapshot.window.timezone,
          ],
          ['完整截至', snapshot.window.completeThrough ?? '未知'],
          [
            '数据状态',
            snapshot.window.dataState === 'final'
              ? '最终数据（来源声明）'
              : snapshot.window.dataState === 'preliminary'
                ? '初步数据'
                : '未知',
          ],
          ['快照来源', String(snapshot.origin)],
        ].map(([label, value]) => (
          <div key={label} className="min-w-0">
            <dt className="text-[#6E6C7C]">{label}</dt>
            <dd className="mt-1 break-words font-medium text-[#3D3B4F]">{value}</dd>
          </div>
        ))}
      </dl>
      <dl className="mt-4 grid grid-cols-1 gap-3 rounded-xl bg-[#F7F7F3] p-3 sm:grid-cols-3">
        {[
          [`属性总计 · ${snapshot.total.metric}`, count(snapshot.total.value)],
          ['已导出页面分组合计', count(pageSum)],
          ['已导出日期分组合计', count(dateSum)],
        ].map(([label, value]) => (
          <div key={label}>
            <dt className="text-[#6E6C7C]">{label}</dt>
            <dd className="mt-1 text-xl font-semibold tabular-nums text-[#3D3B4F]">{value}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-3 leading-relaxed text-[#6E6C7C]">
        {google
          ? '单位为 impressions（曝光），不是引用、点击、CTR、查询数或访问者。'
          : '单位为 citations（引用）；不是点击、访问、AI 排名或任务完成数。'}
        页面、日期与属性总计是不同聚合；空值或缺行不补 0，也不拼成匿名会话漏斗。
      </p>
      {groupingDiffers && (
        <p role="status" className="mt-3 rounded-lg bg-amber-50 p-3 leading-relaxed text-amber-900">
          分组合计与属性总计存在差异，按各自来源保留；可能与聚合或导出范围有关，不能擅自改总计或视为数据损坏。
        </p>
      )}
      <details className="mt-4 rounded-lg border border-[#E6E4DE] p-3">
        <summary className="min-h-11 cursor-pointer py-3 font-semibold text-[#3D3B4F] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#467B64]">
          导出覆盖与来源归档
        </summary>
        <dl className="mt-2 grid gap-3 sm:grid-cols-2">
          {[
            [
              '本次可用导出是否完整',
              snapshot.coverage.availableExportComplete ? '是（来源声明）' : '否 / 部分导出',
            ],
            ['平台全量行数是否已知', '否；本次完整不证明平台全量完整'],
            [
              '页面行：UI / 已导出',
              `${count(snapshot.coverage.uiPageRows)} / ${snapshot.coverage.exportedPageRows}`,
            ],
            [
              '日期行：UI / 已导出',
              `${count(snapshot.coverage.uiDateRows)} / ${snapshot.coverage.exportedDateRows}`,
            ],
            ['平台行上限', count(snapshot.coverage.platformRowLimit)],
            [
              '导出 0 的空值歧义',
              snapshot.coverage.nullsExportedAsZero
                ? '可能存在；无法从 0 还原原始空值'
                : '未声明此项风险（不证明 0 一定真实）',
            ],
          ].map(([label, value]) => (
            <div key={label}>
              <dt className="text-[#6E6C7C]">{label}</dt>
              <dd className="mt-1 break-words font-medium text-[#3D3B4F]">{value}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-3 break-all leading-relaxed text-[#6E6C7C]">
          归档 SHA-256：{snapshot.sourceArchiveSha256}
          <br />
          快照 ID：{snapshot.snapshotId}
        </p>
      </details>
      <details className="mt-3 rounded-lg border border-[#E6E4DE] p-3">
        <summary className="min-h-11 cursor-pointer py-3 font-semibold text-[#3D3B4F] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#467B64]">
          页面 / 日期行预览 · 完整 JSON 不截断
        </summary>
        <p className="mt-2 leading-relaxed text-[#6E6C7C]">
          每类最多预览 10 行；已保存页面 {snapshot.pageRows.length} 行、日期{' '}
          {snapshot.dateRows.length} 行。导出包含全部保留行。
        </p>
        <div className="mt-3 grid min-w-0 gap-4 lg:grid-cols-2">
          <div className="min-w-0 overflow-x-auto">
            <table className="w-full text-left text-xs">
              <caption className="pb-2 text-left font-semibold text-[#3D3B4F]">页面分组</caption>
              <thead>
                <tr>
                  <th className="py-2 pr-3">页面</th>
                  <th>{snapshot.total.metric}</th>
                </tr>
              </thead>
              <tbody>
                {snapshot.pageRows.slice(0, 10).map((row, index) => (
                  <tr key={index} className="border-t border-[#E6E4DE]">
                    <td className="max-w-56 break-all py-2 pr-3 text-[#6E6C7C]">{row.page}</td>
                    <td className="py-2 tabular-nums">{count(row.value)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!snapshot.pageRows.length && (
              <p className="py-2 text-[#6E6C7C]">未提供页面行；合计未知。</p>
            )}
          </div>
          <div className="min-w-0 overflow-x-auto">
            <table className="w-full text-left text-xs">
              <caption className="pb-2 text-left font-semibold text-[#3D3B4F]">日期分组</caption>
              <thead>
                <tr>
                  <th className="py-2 pr-3">日期</th>
                  <th>{snapshot.total.metric}</th>
                </tr>
              </thead>
              <tbody>
                {snapshot.dateRows.slice(0, 10).map((row, index) => (
                  <tr key={index} className="border-t border-[#E6E4DE]">
                    <td className="py-2 pr-3 text-[#6E6C7C]">{row.date}</td>
                    <td className="py-2 tabular-nums">{count(row.value)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!snapshot.dateRows.length && (
              <p className="py-2 text-[#6E6C7C]">未提供日期行；合计未知。</p>
            )}
          </div>
        </div>
      </details>
    </article>
  );
}

export interface AiVisibilitySnapshotsViewProps {
  siteId: string;
  report?: AiVisibilityReport;
  isFetching?: boolean;
  isError?: boolean;
  statusCode?: number;
  isOwner: boolean;
  isImporting?: boolean;
  importError?: string | null;
  pendingImport?: PendingImport | null;
  exactRead?: AiVisibilityExactRead;
  exactReadError?: boolean;
  exactReadStatusCode?: number;
  isExactFetching?: boolean;
  incompatibleReport?: boolean;
  pageNumber?: number;
  canPrevious?: boolean;
  onPrevious?: () => void;
  onNext?: () => void;
  onResetHistory?: () => void;
  onRefresh?: () => void;
  onFile?: (file: File) => void;
  onExport?: (snapshot: AiVisibilitySnapshot) => void;
}

/** Pure presentation exported for isolated SSR/state tests. */
export function AiVisibilitySnapshotsView({
  siteId,
  report,
  isFetching = false,
  isError = false,
  statusCode,
  isOwner,
  isImporting = false,
  importError,
  pendingImport,
  exactRead,
  exactReadError = false,
  exactReadStatusCode,
  isExactFetching = false,
  incompatibleReport = false,
  pageNumber = 1,
  canPrevious = false,
  onPrevious,
  onNext,
  onResetHistory,
  onRefresh,
  onFile,
  onExport,
}: AiVisibilitySnapshotsViewProps): ReactElement {
  const fileId = useId();
  const currentReport = compatibleAiVisibilityReport(report, siteId) ? report : undefined;
  const badCapability = incompatibleReport || (!!report && !currentReport);
  const snapshots = currentReport?.snapshots ?? [];
  const capabilityMissing = !currentReport && statusCode === 404;
  const canImport = isOwner && currentReport?.canManage === true && !isError && !badCapability;
  const currentExactRead =
    pendingImport && compatibleAiVisibilityExactRead(exactRead, siteId, pendingImport.snapshotId)
      ? exactRead
      : undefined;
  const wrongExactRead = !!exactRead && !currentExactRead;
  const pendingVerified = !!pendingImport && !!currentExactRead && !exactReadError;
  const extraExactSnapshot =
    currentExactRead &&
    !snapshots.some(snapshot => snapshot.snapshotId === currentExactRead.snapshot.snapshotId)
      ? currentExactRead.snapshot
      : undefined;
  return (
    <section
      aria-label="AI 曝光与引用快照"
      className="min-w-0 space-y-4 rounded-2xl border border-[#CEDDCF] bg-white p-4 sm:p-6"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-widest text-[#467B64]">
            独立官方报表 · 人工快照
          </p>
          <h2 className="mt-2 text-lg font-semibold text-[#3D3B4F]">AI 曝光与引用快照</h2>
        </div>
        <button
          type="button"
          disabled={isFetching || isExactFetching || !onRefresh}
          onClick={onRefresh}
          className="min-h-11 rounded-lg border border-[#E6E4DE] bg-white px-3 text-xs font-medium text-[#3D3B4F] disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#467B64]"
        >
          {isFetching || isExactFetching ? '正在重读快照…' : '刷新已保存快照'}
        </button>
      </div>
      <p className="text-xs leading-relaxed text-[#6E6C7C]">
        持续官方 API · 未连接。此处只读取 Traks 保存的 Google / Bing
        人工快照，不向官方平台刷新或持续同步。
        每份快照使用自己的源报表窗口，不受上方访问统计日期、渠道、流量或页面筛选影响；不与访问/任务完成混算。
        来源由站主按授权导出登记；格式校验与归档哈希不会自动核实官方报表真伪。
      </p>
      {isFetching && (
        <p role="status" className="text-xs text-[#6E6C7C]">
          正在读取后端当前历史页；未知不显示为 0。
        </p>
      )}
      {badCapability && (
        <p
          role="alert"
          className="rounded-xl bg-amber-50 p-3 text-xs leading-relaxed text-amber-900"
        >
          报告版本、分页合同或站点范围不兼容，快照能力尚待接入。未展示不兼容记录，也不会把旧版全列表当完整历史或补成
          0。
        </p>
      )}
      {isError && (
        <p
          role={capabilityMissing ? 'status' : 'alert'}
          className="rounded-xl bg-amber-50 p-3 text-xs leading-relaxed text-amber-900"
        >
          {capabilityMissing
            ? '当前后端快照能力或访问不可用（404），尚未接通；曝光和引用数未知，不是 0。'
            : `快照读取失败${statusCode ? `（${statusCode}）` : ''}。${currentReport ? `保留上次 ${dated(currentReport.readAt)} 读回的当前页数据，当前状态未验证。` : '尚无可核验当前页；曝光和引用未知。'}请刷新或返回首批重试；没有清空已有证据。`}
        </p>
      )}
      {currentReport && (
        <p className="text-xs leading-relaxed text-[#6E6C7C]">
          后端当前页读回：{dated(currentReport.readAt)} · 第 {pageNumber} 页 · 本页{' '}
          {currentReport.coverage.snapshotCount} 份快照（每页最多 {currentReport.coverage.pageSize}{' '}
          份）。 当前页读取完整；
          {currentReport.coverage.historyComplete
            ? '本次首批页覆盖当前可读的全部保存历史。'
            : '全历史未完整读取；本页数量不是历史总量。'}
          KV 最终一致性可能延迟约 {currentReport.coverage.visibilityDelaySeconds}{' '}
          秒；保存历史完整也不证明官方平台全量完整，翻页计数与指标不累加为历史总量。
          这仅是当前可用目录枚举，不是冻结或强一致的 KV 历史；翻页期间新写入可能需返回首批重查。
        </p>
      )}
      {!isFetching && !isError && !badCapability && !snapshots.length && (
        <p
          role="status"
          className="rounded-xl bg-[#F7F7F3] p-3 text-xs leading-relaxed text-[#6E6C7C]"
        >
          {currentReport
            ? currentReport.status === 'history_page_empty'
              ? '当前历史页暂无记录；请返回首批或刷新，不能据此判断所有保存历史为空。曝光与引用未知，不是 0。'
              : '本页尚无可核验快照；曝光与引用未知，不是 0。'
            : '快照能力尚未接通，不能用来源访问补算曝光或引用。'}
        </p>
      )}
      {snapshots.map(snapshot => (
        <SnapshotCard key={snapshot.snapshotId} snapshot={snapshot} onExport={onExport} />
      ))}
      <nav
        aria-label="快照历史分页"
        className="flex flex-wrap items-center gap-3 text-xs text-[#3D3B4F]"
      >
        <button
          type="button"
          onClick={onPrevious}
          disabled={!canPrevious || isFetching || !onPrevious}
          className="min-h-11 rounded-lg border border-[#E6E4DE] bg-white px-3 disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#467B64]"
        >
          上一页快照
        </button>
        <button
          type="button"
          onClick={onNext}
          disabled={
            !currentReport?.coverage.hasMore || isError || badCapability || isFetching || !onNext
          }
          className="min-h-11 rounded-lg border border-[#E6E4DE] bg-white px-3 disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#467B64]"
        >
          下一页快照
        </button>
        <button
          type="button"
          onClick={onResetHistory}
          disabled={pageNumber === 1 || isFetching || !onResetHistory}
          className="min-h-11 rounded-lg border border-[#E6E4DE] bg-white px-3 disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#467B64]"
        >
          返回首批快照
        </button>
      </nav>
      {currentReport &&
        !currentReport.coverage.hasMore &&
        !currentReport.coverage.historyComplete && (
          <p role="status" className="text-xs text-[#6E6C7C]">
            当前页已到列表末尾，但此前页未累计读取为完整历史。
          </p>
        )}
      {pageNumber > AI_VISIBILITY_PREVIOUS_CURSOR_LIMIT && (
        <p className="text-xs text-[#6E6C7C]">
          仅保留最近 {AI_VISIBILITY_PREVIOUS_CURSOR_LIMIT}{' '}
          次导航游标；更早记录请返回首批查看，不在浏览器累积历史快照。
        </p>
      )}
      {pendingImport && (
        <p
          role="status"
          className="rounded-xl bg-[#F0F5EF] p-3 text-xs leading-relaxed text-[#3D3B4F]"
        >
          {pendingVerified
            ? `snapshot_verified · 已按本站快照 ID 精确读回（${dated(currentExactRead!.readAt)}）；只证明此人工快照保存与读回，不证明完整历史、持续官方连接或全部引用。`
            : `stored_pending_readback · 后端已接收（${dated(pendingImport.acceptedAt)}），尚待按 ID 精确读回。KV 可能延迟约 60 秒，请稍后刷新；不能把 POST 成功或未出现在本页当引用接入验收。`}
        </p>
      )}
      {pendingImport && isExactFetching && (
        <p role="status" className="text-xs text-[#6E6C7C]">
          正在精确读回本次导入；不依赖历史第一页位置。
        </p>
      )}
      {pendingImport && (exactReadError || wrongExactRead) && (
        <p
          role="alert"
          className="rounded-xl bg-amber-50 p-3 text-xs leading-relaxed text-amber-900"
        >
          本次导入精确读回
          {wrongExactRead
            ? '范围或版本不匹配'
            : `失败${exactReadStatusCode ? `（${exactReadStatusCode}）` : ''}`}
          ；尚未验证，保留已接收状态，不填 0。历史页读取与本次精确读回是两个独立状态。
        </p>
      )}
      {extraExactSnapshot && (
        <div className="min-w-0 space-y-2">
          <p className="text-xs text-[#6E6C7C]">
            本次导入的精确读回快照（不属于当前历史页；不计入本页数量）。精确读取时间：
            {dated(currentExactRead!.readAt)}。
            {exactReadError ? '当前重读失败，以下为上次有日期的读回证据。' : ''}
          </p>
          <SnapshotCard snapshot={extraExactSnapshot} onExport={onExport} />
        </div>
      )}
      {isOwner && (
        <fieldset
          disabled={!canImport || isFetching || isImporting}
          className="rounded-xl border border-[#E6E4DE] p-3 disabled:opacity-70 sm:p-4"
        >
          <legend className="px-1 text-xs font-semibold text-[#3D3B4F]">站主导入人工快照</legend>
          <label htmlFor={fileId} className="block text-xs font-medium text-[#3D3B4F]">
            选择经过核对的快照 JSON
          </label>
          <input
            id={fileId}
            type="file"
            accept=".json,application/json"
            className="mt-2 block min-h-11 w-full max-w-full text-xs file:mr-3 file:min-h-11 file:rounded-lg file:border file:border-[#E6E4DE] file:bg-white file:px-3 file:text-xs file:text-[#3D3B4F]"
            onChange={event => {
              const file = event.currentTarget.files?.[0];
              event.currentTarget.value = '';
              if (canImport && file) onFile?.(file);
            }}
          />
          <p className="mt-2 text-xs leading-relaxed text-[#6E6C7C]">
            只接受 ai-visibility-snapshot/v1 JSON，最大 {AI_VISIBILITY_MAX_BYTES / 1024}{' '}
            KiB；先做内存校验，再经本站权限提交。不会解析 ZIP/CSV、保存到
            localStorage，或自动访问官方服务。新快照不可变，不覆盖历史证据。
          </p>
          {!canImport && (
            <p className="mt-2 text-xs text-[#6E6C7C]">
              导入需本站站主权限、兼容后端和成功读取的授权状态。
            </p>
          )}
        </fieldset>
      )}
      {isImporting && (
        <p role="status" className="text-xs text-[#6E6C7C]">
          正在校验或提交快照；尚未完成后端读回。
        </p>
      )}
      {importError && (
        <p
          role="alert"
          className="rounded-xl bg-amber-50 p-3 text-xs leading-relaxed text-amber-900"
        >
          {importError}
        </p>
      )}
      <p className="text-xs leading-relaxed text-[#6E6C7C]">
        ChatGPT、Perplexity、Claude、Apple
        的本站官方引用总量仍未接通，保持未知；四类来源观测报告中的 citations=null 不因快照自动改写。
      </p>
    </section>
  );
}

export function AiVisibilitySnapshots({
  siteId,
  isOwner,
}: {
  siteId: string;
  isOwner: boolean;
}): ReactElement {
  const queryClient = useQueryClient();
  const [isParsing, setIsParsing] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [pendingImport, setPendingImport] = useState<PendingImport | null>(null);
  const [pageCursor, setPageCursor] = useState<string | null>(null);
  const [previousCursors, setPreviousCursors] = useState<(string | null)[]>([]);
  const [pageNumber, setPageNumber] = useState(1);
  const query = useQuery({
    queryKey: [...aiVisibilityQueryKey(siteId), 'history', pageCursor],
    queryFn: async ({ signal }) => {
      const response = await api.getAiVisibilitySnapshots(siteId, signal, pageCursor ?? undefined);
      if (!compatibleAiVisibilityReport(response.data, siteId))
        throw new AiVisibilityCapabilityError('AI visibility history capability is incompatible');
      if (response.data.coverage.nextCursor === pageCursor && pageCursor !== null)
        throw new AiVisibilityCapabilityError('AI visibility cursor did not advance');
      return response;
    },
    retry: false,
    staleTime: 60_000,
    gcTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const exact = useQuery({
    queryKey: [...aiVisibilityQueryKey(siteId), 'snapshot', pendingImport?.snapshotId],
    queryFn: async ({ signal }) => {
      const response = await api.getAiVisibilitySnapshot(siteId, pendingImport!.snapshotId, signal);
      if (!compatibleAiVisibilityExactRead(response.data, siteId, pendingImport!.snapshotId))
        throw new AiVisibilityCapabilityError('AI visibility exact read scope is incompatible');
      return response;
    },
    enabled: !!pendingImport,
    retry: false,
    staleTime: 60_000,
    gcTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const mutation = useMutation({
    mutationFn: (input: AiVisibilityInput) => api.importAiVisibilitySnapshot(siteId, input),
    gcTime: 0,
    onSuccess: async response => {
      setPendingImport({
        snapshotId: response.data.snapshot.snapshotId,
        acceptedAt: response.data.acceptedAt,
      });
      await queryClient.invalidateQueries({ queryKey: aiVisibilityQueryKey(siteId) });
    },
  });
  const report = query.data?.data;
  const importFile = async (file: File): Promise<void> => {
    if (!isOwner || report?.canManage !== true || query.isError || isParsing || mutation.isPending)
      return;
    setIsParsing(true);
    setImportError(null);
    try {
      const input = await readAiVisibilityJsonFile(file);
      await mutation.mutateAsync(input);
    } catch (error) {
      setImportError(
        error instanceof ApiError
          ? `快照提交失败（${error.status}）；没有完成后端读回。请核对权限、属性与格式，再重新选择文件。`
          : error instanceof Error
            ? error.message
            : '快照读取或校验失败，尚未完成提交。'
      );
    } finally {
      // Keep only the receipt ID, not another full POST snapshot in the cache.
      mutation.reset();
      setIsParsing(false);
    }
  };
  return (
    <AiVisibilitySnapshotsView
      siteId={siteId}
      report={report}
      isFetching={query.isFetching}
      isError={query.isError}
      statusCode={query.error instanceof ApiError ? query.error.status : undefined}
      isOwner={isOwner}
      isImporting={isParsing || mutation.isPending}
      importError={importError}
      pendingImport={pendingImport}
      exactRead={exact.data?.data}
      exactReadError={exact.isError}
      exactReadStatusCode={exact.error instanceof ApiError ? exact.error.status : undefined}
      isExactFetching={exact.isFetching}
      incompatibleReport={
        query.error instanceof AiVisibilityCapabilityError ||
        (query.error instanceof ApiError && query.error.status === 501)
      }
      pageNumber={pageNumber}
      canPrevious={previousCursors.length > 0}
      onPrevious={() => {
        if (query.isFetching || !previousCursors.length) return;
        setPageCursor(previousCursors[previousCursors.length - 1]);
        setPreviousCursors(previousCursors.slice(0, -1));
        setPageNumber(value => Math.max(1, value - 1));
      }}
      onNext={() => {
        const nextCursor = report?.coverage.nextCursor;
        if (query.isFetching || query.isError || !nextCursor || nextCursor === pageCursor) return;
        setPreviousCursors(
          [...previousCursors, pageCursor].slice(-AI_VISIBILITY_PREVIOUS_CURSOR_LIMIT)
        );
        setPageCursor(nextCursor);
        setPageNumber(value => value + 1);
      }}
      onResetHistory={() => {
        setPageCursor(null);
        setPreviousCursors([]);
        setPageNumber(1);
      }}
      onRefresh={() => {
        void query.refetch();
        if (pendingImport) void exact.refetch();
      }}
      onFile={file => void importFile(file)}
      onExport={downloadSnapshot}
    />
  );
}
