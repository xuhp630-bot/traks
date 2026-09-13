import { useState, type ReactElement } from 'react';
import { optimizationCandidates, type QualityReport } from '@traks/shared';

const OPERATION_NAMES = {
  calculate: '计算提交',
  copy: '复制结果',
  pdf: 'PDF导出',
  save: '保存项目',
  checkout: '创建结账链接（非付款）',
};

export function QualityReadingGuide(): ReactElement {
  return (
    <details className="mt-4 rounded-xl border border-[#E6E4DE] p-3 text-xs leading-relaxed">
      <summary className="cursor-pointer font-semibold text-[#3D3B4F]">
        如何读取数据并继续优化网站
      </summary>
      <ol className="mt-3 list-decimal space-y-2 pl-5 text-[#6E6C7C]">
        <li>
          先在站点页选择日期，确认目标站点。原概览曲线包含QA/历史流量，不要直接当作真实用户漏斗。
        </li>
        <li>
          在这里选择 Labelled production；点 Load complete window，等到 Complete。无数据时检查
          Historical / unknown，不要把缺数据理解为零流失。
        </li>
        <li>
          Sessions导出会话摘要；Calculator funnels看顺序；Error
          requirements看失败类别；“优化闭环”看尝试、重试及后续成功。
        </li>
        <li>
          从“优化闭环”导出聚合JSON和行动单，交给分析者或上传到当前任务。不发送登录Cookie、令牌或用户输入。
        </li>
        <li>
          保存基线 → 人工复现 → 确认一个修改假设 → QA隔离验证 → 经授权上线 →
          按相同范围导出完整7天对照。小样本延长观察，不自动判定流失。
        </li>
      </ol>
    </details>
  );
}

export function QualityWorkflow({
  report,
  onExport,
}: {
  report: QualityReport;
  onExport: (format: 'json' | 'markdown') => void;
}): ReactElement {
  const candidates = optimizationCandidates(report);
  const [operationLimit, setOperationLimit] = useState(12);
  const [behaviorLimit, setBehaviorLimit] = useState(12);
  const [candidateLimit, setCandidateLimit] = useState(6);
  const [growthLimit, setGrowthLimit] = useState(12);
  return (
    <div className="mt-4 space-y-4">
      <div className="rounded-2xl border border-[#CEDDCF] bg-[#F0F5EF] p-4 sm:p-6">
        <p className="text-xs font-semibold uppercase tracking-widest text-[#467B64]">
          数据已完整读取 · 下一步
        </p>
        <h4 className="mt-2 text-xl font-semibold tracking-tight text-[#3D3B4F]">
          把观察事实，变成可验证的改动
        </h4>
        <ol className="my-4 grid gap-2 text-sm text-[#3D3B4F] sm:grid-cols-3">
          {['01 核对范围与样本', '02 复现并确认假设', '03 导出行动单与复查'].map(step => (
            <li key={step} className="rounded-lg border border-[#CEDDCF] bg-white/70 px-3 py-3">
              {step}
            </li>
          ))}
        </ol>
        <p className="mt-2 text-xs leading-relaxed text-[#6E6C7C]">
          以下是当前流量范围全部分组，不受其他页签的页面/版本文本筛选影响。导出只含聚合数据和候选动作，不含会话ID、输入或原始报错。失败后成功不等于网站改动的因果效果。
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            className="min-h-11 rounded-xl bg-[#467B64] px-4 py-3 text-sm font-medium text-white hover:bg-[#36624F] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#467B64]"
            onClick={() => onExport('json')}
          >
            导出聚合分析 JSON
          </button>
          <button
            className="min-h-11 rounded-xl border border-[#467B64] bg-white px-4 py-3 text-sm text-[#3D3B4F] hover:bg-[#EAF2EC] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#467B64]"
            onClick={() => onExport('markdown')}
          >
            导出优化行动单 Markdown
          </button>
        </div>
      </div>
      <dl className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {Object.entries({
          选定范围会话: report.sessions.length,
          操作分组: report.operations.length,
          问题分组: report.issues.length,
        }).map(([label, count]) => (
          <div key={label} className="rounded-xl border border-[#E6E4DE] px-4 py-3">
            <dt className="text-xs text-[#6E6C7C]">{label}</dt>
            <dd className="mt-1 text-2xl font-semibold tabular-nums text-[#3D3B4F]">{count}</dd>
          </div>
        ))}
      </dl>
      <section aria-label="渠道与联系请求">
        <h4 className="text-sm font-semibold">渠道 → 有效操作 → 联系受理与回复许可</h4>
        <p className="mt-2 text-xs leading-relaxed text-[#6E6C7C]">
          首次已观测页面访问归因，按会话去重；不是多触点归因或完整获客漏斗。受理是浏览器观测的服务端响应，
          不等于送达、合格商机或成交。许可只限本次联系，不是营销订阅。CRM跟进、实际回复和长期留存尚未接通，不填零。
        </p>
        <div className="mt-3 grid gap-3 lg:grid-cols-2">
          {report.acquisition.slice(0, growthLimit).map(group => (
            <article
              key={JSON.stringify([
                group.path,
                group.locale,
                group.device,
                group.channelSource,
                group.channelMedium,
                group.channelCampaign,
              ])}
              className="min-w-0 rounded-2xl border border-[#E6E4DE] p-4 text-xs"
            >
              <h5 className="break-words font-semibold">
                {group.channelSource} / {group.channelMedium} / {group.channelCampaign}
              </h5>
              <p className="mt-1 break-all">
                {group.path} · {group.locale} / {group.device}
              </p>
              <p className="mt-1 break-words text-[#6E6C7C]">
                版本：{group.versions.join(', ') || 'unknown'}
              </p>
              <dl className="mt-3 grid grid-cols-2 gap-2 tabular-nums">
                {Object.entries({
                  会话: group.sessions,
                  计算成功: group.toolSuccessSessions,
                  使用结果: group.resultUseSessions,
                  联系开始: group.contactStartedSessions,
                  联系提交: group.contactSubmittedSessions,
                  失败或校验: group.contactFailedSessions,
                  已观测受理: group.acceptedRequestSessions,
                  受理且允许回复: group.replyAuthorizedSessions,
                  旧成功未确认: group.unconfirmedContactSessions,
                }).map(([label, count]) => (
                  <div key={label}>
                    <dt className="text-[#6E6C7C]">{label}</dt>
                    <dd className="font-semibold">{count}</dd>
                  </div>
                ))}
              </dl>
            </article>
          ))}
        </div>
        {growthLimit < report.acquisition.length && (
          <button
            className="mt-3 min-h-11 rounded-xl border border-[#E6E4DE] px-4 text-sm"
            onClick={() => setGrowthLimit(limit => limit + 12)}
          >
            显示更多渠道分组
          </button>
        )}
        {!report.acquisition.length && (
          <p className="mt-3 text-xs text-[#6E6C7C]">
            没有可分析的渠道会话；不等于没有客户或业务结果。
          </p>
        )}
      </section>
      <div>
        <h4 className="text-sm font-semibold">操作结果与重试信号</h4>
        <p className="mt-1 text-xs leading-relaxed text-[#6E6C7C]">
          按会话、页面访问、版本、语言、设备、计算器/操作保守关联。相同接收时间、缺标识、重复和并发归为“无法关联”；未见返回可能还在窗口外，不是流失。各项会重叠，不能相加为独立用户数。
        </p>
        <p className="mt-2 text-[11px] text-[#6E6C7C]">
          已显示 {Math.min(operationLimit, report.operations.length)} / {report.operations.length}{' '}
          组；JSON包含全部。
        </p>
        <div className="mt-3 grid gap-3 lg:grid-cols-2">
          {report.operations.slice(0, operationLimit).map(operation => (
            <article
              key={JSON.stringify([
                operation.path,
                operation.version,
                operation.locale,
                operation.device,
                operation.calculator,
                operation.operation,
              ])}
              className="min-w-0 rounded-2xl border border-[#E6E4DE] p-4 text-xs"
            >
              <h5 className="font-semibold">{OPERATION_NAMES[operation.operation]}</h5>
              <p className="mt-1 break-all">{operation.path}</p>
              <p className="mt-1 break-words text-[11px] text-[#6E6C7C]">
                {operation.version} · {operation.locale} · {operation.device} ·{' '}
                {operation.calculator}
              </p>
              <dl className="mt-3 grid grid-cols-2 gap-2 tabular-nums">
                {Object.entries({
                  尝试会话: operation.attemptedSessions,
                  关联成功会话: operation.successSessions,
                  失败会话: operation.failureSessions,
                  校验拒绝会话: operation.invalidSessions,
                  业务阻塞会话: operation.blockedSessions,
                  取消会话: operation.cancelledSessions,
                  重试会话: operation.retrySessions,
                  重试后成功会话: operation.recoveredSessions,
                  未见返回会话: operation.pendingSessions,
                  无法关联会话: operation.unlinkedSessions,
                }).map(([label, count]) => (
                  <div key={label}>
                    <dt className="text-[11px] text-[#6E6C7C]">{label}</dt>
                    <dd className="mt-0.5 text-base font-semibold">{count}</dd>
                  </div>
                ))}
              </dl>
            </article>
          ))}
        </div>
        {operationLimit < report.operations.length && (
          <button
            className="mt-3 min-h-11 rounded-xl border border-[#E6E4DE] px-4 text-sm hover:bg-[#F7F7F3]"
            onClick={() => setOperationLimit(limit => limit + 12)}
          >
            显示更多操作分组
          </button>
        )}
        {!report.operations.length && (
          <p className="mt-3 text-xs text-[#6E6C7C]">暂无操作证据，不能把它显示为0%成功率。</p>
        )}
      </div>
      {!!report.behaviors.length && (
        <div>
          <h4 className="text-sm font-semibold">搜索与输入纠正</h4>
          <p className="mt-1 text-xs text-[#6E6C7C]">
            只认实际工具搜索结果展示；未采集搜索原文，不能据此猜测具体需求。输入纠正不等于已完成计算。已显示
            {Math.min(behaviorLimit, report.behaviors.length)}/{report.behaviors.length}
            组，导出包含全部。
          </p>
          {report.behaviors.slice(0, behaviorLimit).map(behavior => (
            <p
              key={JSON.stringify([
                behavior.path,
                behavior.version,
                behavior.locale,
                behavior.device,
              ])}
              className="mt-2 break-words rounded-xl border border-[#E6E4DE] p-3 text-xs leading-relaxed"
            >
              {behavior.path} · {behavior.version} · {behavior.locale} · {behavior.device}
              <br />
              搜索会话 {behavior.searchSessions} · 曾展示零结果 {behavior.zeroResultSessions} ·
              结果数未知 {behavior.unknownResultSessions} · 校验后纠正{' '}
              {behavior.correctedFieldSessions}
            </p>
          ))}
          {behaviorLimit < report.behaviors.length && (
            <button
              className="mt-3 min-h-11 rounded-xl border border-[#E6E4DE] px-4 text-sm hover:bg-[#F7F7F3]"
              onClick={() => setBehaviorLimit(limit => limit + 12)}
            >
              显示更多搜索分组
            </button>
          )}
        </div>
      )}
      <div>
        <h4 className="text-sm font-semibold">优化候选：先验证，再决定</h4>
        <p className="mt-1 text-xs text-[#6E6C7C]">
          已显示 {Math.min(candidateLimit, candidates.length)} / {candidates.length}{' '}
          项；行动单包含全部及发布/复查记录模板，不会自动改站或创建需求。
        </p>
        {candidates.slice(0, candidateLimit).map((candidate, index) => (
          <article
            key={index}
            className="mt-3 rounded-2xl border border-[#E6E4DE] p-4 text-xs leading-relaxed"
          >
            <h5 className="font-semibold">{candidate.category}</h5>
            <p className="mt-1 break-words">
              {candidate.path} · {candidate.version} · {candidate.dimension}
            </p>
            <p className="mt-2">已观察：{candidate.observed}</p>
            <p className="mt-2 text-[#6E6C7C]">待验证：{candidate.hypothesis}</p>
            <p className="mt-2">动作：{candidate.action}</p>
            <p className="mt-2 text-[#6E6C7C]">验收：{candidate.verification}</p>
          </article>
        ))}
        {candidateLimit < candidates.length && (
          <button
            className="mt-3 min-h-11 rounded-xl border border-[#E6E4DE] px-4 text-sm hover:bg-[#F7F7F3]"
            onClick={() => setCandidateLimit(limit => limit + 6)}
          >
            显示更多优化候选
          </button>
        )}
        {!candidates.length && (
          <p className="mt-3 text-xs text-[#6E6C7C]">暂无候选，可能是样本不足；不表示没有问题。</p>
        )}
      </div>
    </div>
  );
}
