import { issueDiagnosis, type QualityAccumulator, type TrafficSelection } from './quality';

export type QualityReport = ReturnType<QualityAccumulator['report']>;
export interface AnalysisScope {
  siteId: string;
  period: string;
  traffic: TrafficSelection;
  from: number;
  to: number;
  source: 'live' | 'historical';
  totalGroups: number;
  totalEvents: number;
  cohortFilterKeys: string[];
}
export interface OptimizationCandidate {
  category: string;
  path: string;
  version: string;
  dimension: string;
  observed: string;
  hypothesis: string;
  action: string;
  verification: string;
  metric: string;
}

export function optimizationCandidates(report: QualityReport): OptimizationCandidate[] {
  const candidates: OptimizationCandidate[] = report.issues.map(issue => {
    const diagnosis = issueDiagnosis(issue);
    return {
      category:
        issue.outcome === 'blocked'
          ? '业务前提与恢复路径'
          : issue.outcome === 'cancelled'
            ? '取消行为核查'
            : issue.outcome === 'invalid'
              ? '输入校验体验'
              : '失败路径复现',
      path: issue.path,
      version: issue.version,
      dimension: `${issue.locale} / ${issue.browser} / ${issue.kind} / ${issue.reason}`,
      observed: `${issue.sessions}个会话、${issue.events}个信号。${diagnosis.evidence}`,
      hypothesis: '原因分类是线索，不是根因；请补复现步骤、反证和具体修改假设。',
      action: diagnosis.nextCheck,
      verification:
        '使用QA会话复现原路径；验证成功、失败、业务限制、取消及重试。不能通过绕过权限或删除埋点来“消除错误”。',
      metric:
        '相同页面/版本/语言/设备范围内的受影响会话；另看操作尝试、关联成功、重试后成功和无法关联的信号。',
    };
  });
  for (const operation of report.operations) {
    if (operation.unlinkedSessions)
      candidates.push({
        category: '先核对数据口径',
        path: operation.path,
        version: operation.version,
        dimension: `${operation.locale} / ${operation.device} / ${operation.calculator} / ${operation.operation}`,
        observed: `${operation.unlinkedSessions}个会话有无法关联的操作证据。`,
        hypothesis:
          '可能缺少开始事件、页面标识，或存在相同时间戳、重复/并发、跨窗口及旧埋点；不是失败率。',
        action: '在QA中核对开始与返回事件，保留页面/版本对应关系；历史缺失证据不回填猜测值。',
        verification: '完整读取结束后检查结果；并发/重复/同时间戳不能被强行拼成成功恢复。',
        metric: '无法关联会话数；观察它是否影响尝试分母和成功解释。',
      });
    if (operation.pendingSessions)
      candidates.push({
        category: '操作返回路径核查',
        path: operation.path,
        version: operation.version,
        dimension: `${operation.locale} / ${operation.device} / ${operation.calculator} / ${operation.operation}`,
        observed: `${operation.pendingSessions}个会话在本窗口内有尝试但未见对应返回。`,
        hypothesis: '可能尚未完成、返回在窗口外、离开页面或丢失上报；不等于永久流失。',
        action:
          '复现慢网、取消、跳转和重复点击；确认是否需要等待提示、防重复提交或重试入口，再决定改动。',
        verification: '验证正常完成与失败返回都可解释；保留取消和窗口外结果的边界。',
        metric: '未见返回、取消、重试与后续成功会话；同时检查错误和无法关联信号。',
      });
  }
  for (const behavior of report.behaviors) {
    if (behavior.zeroResultSessions)
      candidates.push({
        category: '站内工具发现',
        path: behavior.path,
        version: behavior.version,
        dimension: `${behavior.locale} / ${behavior.device}`,
        observed: `${behavior.searchSessions}个已观测搜索会话中，${behavior.zeroResultSessions}个曾展示零结果。`,
        hypothesis: '未采集搜索原文，不能从这里推断用户具体找什么，也不能直接当成新工具需求。',
        action:
          '用已知工具名和常见别名进行QA，核对标题、翻译、检索规则和无结果替代入口；新增页面另走需求研究。',
        verification:
          '分别测试空输入、已有工具、无匹配、快速关闭及选择结果；不能把普通搜索框误算为工具目录零结果。',
        metric: '真实搜索结果展示会话、零结果会话、未知结果会话；单看零结果下降不证明转化改善。',
      });
  }
  return candidates;
}

export function buildAnalysisPackage(report: QualityReport, scope: AnalysisScope) {
  const allowedKeys = [
    'page',
    'source',
    'utmSource',
    'utmMedium',
    'utmCampaign',
    'country',
    'region',
    'city',
    'browser',
    'os',
    'device',
  ];
  return {
    format: 'traks-optimization-evidence/v1',
    generatedAt: new Date().toISOString(),
    scope: {
      siteId: /^[a-z0-9_-]{1,128}$/i.test(scope.siteId) ? scope.siteId : 'redacted',
      period: /^[a-z0-9_-]{1,24}$/i.test(scope.period) ? scope.period : 'custom',
      traffic: scope.traffic,
      from: new Date(scope.from).toISOString(),
      to: new Date(scope.to).toISOString(),
      source: scope.source,
      complete: true,
      cohortFilterKeys: [
        ...new Set(scope.cohortFilterKeys.filter(key => allowedKeys.includes(key))),
      ].sort(),
      filterValuesOmitted: true,
      includesAllViewRows: true,
    },
    population: {
      selectedSessions: report.sessions.length,
      wholeCohortClassification: report.classification,
      wholeCohortUnknownClassification: report.unknownClassification,
      wholeCohortGroups: scope.totalGroups,
      wholeCohortEvents: scope.totalEvents,
      wholeCohortUnassociatedEvents: report.unassociatedEvents,
      selectedLimitedSessions: report.sessions.filter(session => session.diagnosticsLimited).length,
    },
    limitations: [
      '仅导出完整读取后的聚合证据；不含原始会话/页面标识、输入、报错原文或筛选值。',
      '页面/版本文本筛选仅影响部分视图，本分析包包含当前流量范围全部分组；上层筛选选择的是匹配会话及其整个观测窗口。',
      '筛选值未导出，比较前须在后台重新核对原筛选；有筛选时不可冒充全站分析。',
      '同一会话可出现在多个页面/操作/失败组，不能把分组求和作为全站独立用户数。',
      '关联采用同一会话、页面访问、版本、语言、设备、计算器/操作以及严格递增的接收时间；缺标识、相同时间戳、重复/并发不强行关联。',
      '后续成功只是操作级恢复信号，不证明相同输入、相同付款或网站改动导致改善；checkout_success不是支付成功。',
      '未见返回、窗口外、取消、上报缺失和未标记历史不等于真实流失；小样本不足以做因果结论。',
      '页面诊断有防刷上限；无错误不代表无故障；人工复核状态不包含在本分析包。',
    ],
    funnels: report.funnels,
    acquisition: report.acquisition,
    growthCoverage: {
      attribution: 'first_observed_pageview_per_collector_session',
      confirmation: 'browser_observed_server_response_not_independently_verified',
      contactAcceptance: 'email_provider_accepted_not_delivery_or_qualified_lead',
      replyPermission: 'this_contact_request_only_not_marketing_consent',
      qualifiedLeads: null,
      deliveredFollowups: null,
      customerReplies: null,
      crossDayRetention: null,
      crmConnected: false,
    },
    operations: report.operations,
    behaviors: report.behaviors,
    issues: report.issues.map(({ key: _key, ...issue }) => issue),
    candidates: optimizationCandidates(report),
  };
}

export function analysisMarkdown(pack: ReturnType<typeof buildAnalysisPackage>): string {
  const scope = pack.scope;
  const blocks = [
    '# 网站数据读取与优化行动单',
    `格式：${pack.format}；生成：${pack.generatedAt}`,
    `站点标识：${scope.siteId}；窗口：${scope.from} → ${scope.to}；来源：${scope.source}；流量：${scope.traffic}；选定会话：${pack.population.selectedSessions}。`,
    `上层筛选键：${scope.cohortFilterKeys.join(', ') || '无'}（不含值，比较前必须核对）；${pack.population.selectedLimitedSessions}个选定会话达到诊断上限。`,
    '## 如何使用',
    '1. 先核对站点、完整时间窗、流量和筛选；QA/internal/unknown不能混当真实生产用户。\n2. 把配套聚合JSON和本行动单交给分析者，不发送Cookie、令牌或含用户原文的日志。\n3. 先核查数据缺口，再选一条可复现问题；以下均是需求候选，不是自动批准修改。',
    '## 必须保留的解释边界',
    ...pack.limitations.map(value => `- ${value}`),
    `## 需求候选（${pack.candidates.length}项，全部导出）`,
  ];
  for (const [index, candidate] of pack.candidates.entries())
    blocks.push(
      `### ${index + 1}. ${candidate.category} · ${candidate.path}`,
      `版本/维度：${candidate.version} / ${candidate.dimension}`,
      `观察事实：${candidate.observed}\n\n待验证假设：${candidate.hypothesis}\n\n建议动作：${candidate.action}\n\n验收：${candidate.verification}\n\n观察指标：${candidate.metric}`,
      '执行记录：状态=待复现；负责人=待填；需求链接=待填；基线文件=待填；目标页面=待确认；具体改动=待确认；反证=待补；QA结果=待填；上线时间/提交/Worker版本=未上线；复查日期=上线后按下述窗口填写。'
    );
  if (!pack.candidates.length)
    blocks.push('当前没有可生成的候选，可能是样本/覆盖不足；不等于网站没有问题。');
  blocks.push(
    '## 渠道与联系请求（会话去重）',
    '首次已观测原生pageview归因，不是完整多触点归因；受理是浏览器观测的服务端邮件受理响应，不证明送达、合格线索或成交。回复许可仅限本次请求；CRM、实际跟进、客户回复和长期留存未接通。',
    ...pack.acquisition.map(
      group =>
        `${group.channelSource} / ${group.channelMedium} / ${group.channelCampaign} · ${group.path} · ${group.locale}/${group.device}: ${group.sessions}会话，${group.toolSuccessSessions}计算成功，${group.resultUseSessions}使用结果，${group.contactSubmittedSessions}联系提交，${group.contactFailedSessions}失败/校验，${group.acceptedRequestSessions}受理，${group.replyAuthorizedSessions}受理且允许回复，${group.unconfirmedContactSessions}旧成功未确认。`
    )
  );
  blocks.push(
    '## 后续优化与复查',
    '- 每次只验证一个明确假设，先保存本包作为基线；不要只为了事件数字好看而改埋点。\n- QA使用独立会话并显式标记analytics_traffic=qa；验证成功、错误、业务限制、取消、重试与隐私退出。\n- 发布需另行授权，并记录真实Git/Worker与埋点标签的对应关系。\n- 上线当天先做功能QA；之后比较相同星期构成、时区、页面、语言、设备、流量及筛选的完整7天窗口；样本不足延长到14/28天并保留“无法判断”。\n- 同看操作成功、失败、取消、重试、无法关联和采集上限；前后对比不是随机实验，不宣称因果改善。\n- 涉及SEO内容/结构时另核GSC页面和查询证据，工程通过不等于搜索恢复。\n- 到复查日期后手动重新导出；本流程未创建后台监控或自动改站。'
  );
  return blocks.join('\n\n') + '\n';
}
