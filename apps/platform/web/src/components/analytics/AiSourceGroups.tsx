import type { ReactElement } from 'react';
import {
  AI_SOURCE_PROVIDER_LABELS,
  type AiSourceReport,
  type EvidencePage,
  type TrafficSelection,
} from '@traks/shared';

export type AiSourceWindow = Pick<EvidencePage, 'from' | 'to' | 'source'>;

const PROVIDERS = {
  ...AI_SOURCE_PROVIDER_LABELS,
  copilot: 'Bing / Copilot（明确 AI 来源）',
} as const;
const TRAFFIC = {
  production: 'Labelled production',
  qa: 'QA',
  internal: 'Internal',
  unknown: 'Historical / unknown',
  all: 'All traffic',
} as const;
const count = (value: unknown): string =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value.toLocaleString('en-US')
    : '未知';
const timestamp = (value: unknown): string => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '时间未知';
  const date = new Date(value);
  return Number.isFinite(date.valueOf())
    ? date.toISOString().replace('T', ' ').replace('.000Z', ' UTC')
    : '时间未知';
};

export function AiSourceGroups({
  summary,
  traffic,
  evidenceWindow,
}: {
  summary?: AiSourceReport;
  traffic?: TrafficSelection;
  evidenceWindow?: AiSourceWindow;
}): ReactElement {
  if (
    !summary ||
    summary.format !== 'traks-ai-source-observations/v1' ||
    !['available', 'partial'].includes(summary.status)
  )
    return (
      <section aria-label="AI 来源观测" className="rounded-2xl border border-[#E6E4DE] p-4">
        <h4 className="text-sm font-semibold text-[#3D3B4F]">AI 来源观测 · 能力待接入</h4>
        <p role="status" className="mt-2 text-xs leading-relaxed text-[#6E6C7C]">
          当前报告未提供兼容、可用的 AI 来源观测，不能把缺字段当作 0，也不能用普通渠道列表补算引用。
        </p>
      </section>
    );

  const coverage = summary.coverage;
  const empty = summary.denominatorSessions === 0;
  return (
    <section
      aria-label="AI 来源观测"
      className="min-w-0 rounded-2xl border border-[#CEDDCF] p-4 sm:p-6"
    >
      <p className="text-xs font-semibold uppercase tracking-widest text-[#467B64]">
        完整窗口 · 来源观测
      </p>
      <h4 className="mt-2 text-lg font-semibold text-[#3D3B4F]">
        AI 引用、带来访问与计算结果，分别核对
      </h4>
      <p className="mt-2 break-words text-xs leading-relaxed text-[#6E6C7C]">
        流量：{traffic ? (TRAFFIC[traffic] ?? '流量选择未知') : '流量选择未提供'} · 数据源：
        {evidenceWindow?.source === 'live'
          ? 'Live collector'
          : evidenceWindow?.source === 'historical'
            ? 'Historical collector'
            : '读取来源未知'}
        <br />
        {evidenceWindow
          ? `${timestamp(evidenceWindow.from)} → ${timestamp(evidenceWindow.to)}`
          : '窗口未提供，不能代入其他日期的观测。'}
      </p>
      <p className="mt-2 text-xs leading-relaxed text-[#6E6C7C]">
        首次已观测原生 pageview 的来源与 producer 声明分开保留；以下为选定全会话人群，
        不是独立用户、多触点归因或严格顺序漏斗。生产标签不证明是真人。其他页签的页面/版本文本筛选不影响这些分组。
      </p>
      {summary.status === 'partial' && (
        <p
          role="status"
          className="mt-3 rounded-xl bg-amber-50 p-3 text-xs leading-relaxed text-amber-900"
        >
          报告已完整读取，但 {count(coverage?.sourceObservationUnavailableSessions)}{' '}
          个选定会话缺少兼容来源观测。 以下来源计数仅覆盖已观测证据，不是完整 AI 流量；缺失不填
          0，也不归入“未知 AI”。
        </p>
      )}

      <div className="mt-4 rounded-xl bg-[#F0F5EF] p-3 sm:p-4">
        <h5 className="text-sm font-semibold text-[#3D3B4F]">独立引用 / 曝光证据 · 未接入</h5>
        <p className="mt-2 text-xs leading-relaxed text-[#6E6C7C]">
          ChatGPT、Perplexity、Claude、Bing / Copilot 的独立引用证据，Google AI Overview / AI Mode
          官方报表，以及 Apple 生态搜索展示尚未连接到此报告；均为未知，不是 0。
          来源访问或爬虫成功抓取都不证明被引用，现有 GSC / Bing 数据也不会自动并入。
        </p>
      </div>

      <dl className="mt-4 grid gap-3 sm:grid-cols-3">
        {Object.entries({
          选定collector会话: summary.denominatorSessions,
          明确AI来源会话: coverage?.recognizedSessions,
          '非AI / 未归因会话': coverage?.unclassifiedSessions,
        }).map(([label, value]) => (
          <div key={label} className="min-w-0 rounded-xl bg-[#F7F7F3] p-3">
            <dt className="text-xs text-[#6E6C7C]">{label}</dt>
            <dd className="mt-1 text-xl font-semibold tabular-nums text-[#3D3B4F]">
              {count(value)}
            </dd>
          </div>
        ))}
      </dl>
      {empty ? (
        <p
          role="status"
          className="mt-4 rounded-xl border border-[#E6E4DE] p-3 text-xs leading-relaxed text-[#6E6C7C]"
        >
          当前完整读取的选定流量没有 collector 会话。没有可展示的来源分组或结果分母；
          不表示六个搜索入口没有展示、引用或客户。
        </p>
      ) : (
        <div className="mt-4 grid gap-3 lg:grid-cols-2">
          {Object.entries(PROVIDERS).map(([provider, label]) => {
            const group = summary.groups?.find(item => item.provider === provider);
            const knownCalculator = group?.goalCoverage === 'known_calculator_signals_only';
            const goalCount = (value: unknown): string =>
              knownCalculator && value !== null ? count(value) : '不适用 / 未知';
            return (
              <article
                key={provider}
                className="min-w-0 rounded-xl border border-[#E6E4DE] p-4 text-xs"
              >
                <h5 className="break-words font-semibold text-[#3D3B4F]">{label}</h5>
                <dl className="mt-3 grid grid-cols-2 gap-3">
                  {Object.entries({
                    '来源访问（会话）': count(group?.sessions),
                    '原生页面访问（PV）': count(group?.pageviews),
                    '已观测计算成功（会话）': goalCount(group?.toolSuccessSessions),
                    '已观测使用结果（会话）': goalCount(group?.resultUseSessions),
                  }).map(([metric, value]) => (
                    <div key={metric} className="min-w-0">
                      <dt className="text-[11px] leading-relaxed text-[#6E6C7C]">{metric}</dt>
                      <dd className="mt-1 font-semibold tabular-nums text-[#3D3B4F]">{value}</dd>
                    </div>
                  ))}
                </dl>
                <p className="mt-3 text-[11px] leading-relaxed text-[#6E6C7C]">
                  {knownCalculator
                    ? `已知计算器上下文覆盖 ${count(group?.goalEligibleSessions)} / ${count(group?.sessions)} 会话。结果仅覆盖这些版本化信号，不是本组所有访问者或其他网站的通用业务目标。`
                    : '未观测到已知计算器上下文；其他工具的真实任务结果需单独适配，不能填 0。'}
                </p>
                <details className="mt-3">
                  <summary className="min-h-11 cursor-pointer rounded-lg py-3 font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#467B64]">
                    {label} 来源证据
                  </summary>
                  <dl className="mt-1 grid gap-2 sm:grid-cols-2">
                    {Object.entries({
                      producer声明会话: group?.provenance?.producerDeclaredSessions,
                      原生来源推导会话: group?.provenance?.derivedFromNativeSessions,
                      referrer证据会话: group?.evidence?.referrerSessions,
                      UTM来源证据会话: group?.evidence?.utmSourceSessions,
                      'referrer + UTM会话': group?.evidence?.referrerAndUtmSessions,
                    }).map(([metric, value]) => (
                      <div key={metric}>
                        <dt className="text-[#6E6C7C]">{metric}</dt>
                        <dd className="mt-0.5 font-semibold tabular-nums">{count(value)}</dd>
                      </div>
                    ))}
                  </dl>
                  <p className="mt-2 leading-relaxed text-[#6E6C7C]">
                    UTM 和 producer 声明不是平台官方核实引用；各类证据可能重叠，不能相加为人数。
                  </p>
                </details>
              </article>
            );
          })}
        </div>
      )}

      <details className="mt-4 rounded-xl bg-[#F7F7F3] p-3 text-xs sm:p-4">
        <summary className="min-h-11 cursor-pointer rounded-lg py-3 font-semibold text-[#3D3B4F] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#467B64]">
          观测覆盖与归因限制
        </summary>
        <dl className="mt-2 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {Object.entries({
            缺兼容来源观测会话: coverage?.sourceObservationUnavailableSessions,
            来源冲突会话: coverage?.conflictSessions,
            元数据不合法会话: coverage?.invalidMetadataSessions,
            缺原生pageview会话: coverage?.missingPageviewSessions,
            后续来源变化会话: coverage?.lateSourceChangeSessions,
            原生来源证据会话: coverage?.nativeSourceSessions,
            producer声明会话: coverage?.producerDeclaredSessions,
            版本未知会话: coverage?.unknownVersionSessions,
          }).map(([label, value]) => (
            <div key={label}>
              <dt className="text-[#6E6C7C]">{label}</dt>
              <dd className="mt-0.5 font-semibold tabular-nums">{count(value)}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-3 leading-relaxed text-[#6E6C7C]">
          非 AI / 未归因包含普通 Google、Bing、Apple、直达和无法解析的渠道，不能称为“未知 AI 流量”。
          google.com 不自动等于 AI Overview，bing.com 不自动等于 Copilot，Apple 来源不自动等于 AI
          或转化。 覆盖计数可重叠，不求和；缺来源或当前窗口外的访问不会补猜或回填。
        </p>
        {!!summary.limitations?.length && (
          <ul className="mt-3 list-disc space-y-1 break-words pl-5 text-[#6E6C7C]">
            {summary.limitations.map((limitation, index) => (
              <li key={index}>{limitation}</li>
            ))}
          </ul>
        )}
      </details>
      <p className="mt-3 text-[11px] leading-relaxed text-[#6E6C7C]">
        JSON / Markdown 导出保留全部来源分组与盲区，不受界面预览条数影响。
        成功、失败和未观测结果应结合任务证据读取，不能由来源汇总推断因果改善。
      </p>
    </section>
  );
}
