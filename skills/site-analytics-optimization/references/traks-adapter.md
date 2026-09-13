# Traks 适配，不是所有站点的固定漏斗

先验证部署的Traks分支、版本与分析契约，再使用功能。上游未必含有本fork新增模块；不能凭Skill描述猜线上API存在。

## 本实现的入口

- 站点详情：`/portal/site/{siteId}`。趋势最先显示，旧概览/Top-N包含原始队列，不等同质量区的production范围。
- `Traffic quality & requirements`：选流量、完整读取、优化闭环/问题/漏斗/会话摘要。
- 认证读取：`GET /api/analytics/{siteId}/stats/quality-evidence?period=...&cursor=...`，每页必须通过站点权限检查。
- `packages/shared/src/quality.ts` 负责规范化、固定窗口读取、会话、漏斗与问题；`quality-actions.ts` 负责保守操作/恢复；`quality-brief.ts` 生成聚合包与行动单。
- `docs/reading-optimization-guide.zh-CN.md` 给站点负责人操作步骤；schema `traks-optimization-evidence/v1` 不是开放数据服务。

## 新网站必须适配的地方

此fork的calculator路径、事件前缀、业务类型和漏斗步骤针对一个计算器站，不是通用推断引擎。新站先列出自己的路由/任务/结果，设计显式版本化适配器或确认已有规则完全匹配。通过原站+新站隔离测试后才能使用新漏斗，不能把其他工具默认为concrete calculator。

站点ID、origin、账户、Worker名、仓库路径和部署凭据保存在该站私有绑定文件，不写进通用Skill。接入授权不包含创建付费Cloudflare资源或推送任意fork。

## 口径与陷阱

- 当前窗口用live DO，历史用R2 SQL；本地SQLite执行不是R2生产验证。
- R2 SQL不支持OFFSET；历史分页必须用受支持的排名/过滤，并在分页过滤前计算全窗口总量。验证首/末页、空结果、重复事件、同时间戳和NULL排序；真实R2跨页读取与live DO都通过才算兼容。
- collector对机器人自定义事件可能返回200后直接丢弃，HeadlessChrome属于该路径。200只说明请求处理，不能证明存储；不要伪造UA绕过过滤。用普通浏览器、显式QA、当前版本和安全属性白名单完成操作，再从live与历史数据读回QA证据。缺失时分别查隐私退出、站点绑定、机器人/限额过滤、版本与写入延迟，不改写成production。
- 质量读取一页500组，完整客户端持续分页；游标过期/范围冲突/源错误不得降级为短窗口成功。
- 事件名边界240字符，元数据标签48字符；不要把长合法事件名误降级成unknown。
- `field_completed`需计算器表单、有效、修改且非空才进入该站输入漏斗；失焦只读validity，不调用会产生invalid事件的checkValidity。
- `calculator_search_results_viewed`来自cmdk实际结果状态，普通search_input不能作为工具零结果。
- copy需要attempt与success/error，native打印请求不是完成；PDF需有效类型/非空内容，下载开始不证明保存。
- 关联要求同会话/页访问/版本/语言/设备/工具/操作及严格递增接收时间。重复/并发/同时间戳保持无法关联；若未来增加operation ID，要升级契约并保持旧数据unknown。
- 分析包省略筛选原文和原始ID，包含全部分组，不受UI初始预览条数影响；它不是自动重放任意筛选的配置文件。
- 目前问题卡手工复核状态只在浏览器存储，不是团队工单数据库；部署不自动标“修复”。

## 发布顺序

先核后端兼容旧/新事件，更新collector/API/dashboard，再发网站事件生产者，最后同步事件目录并验证真实QA与历史读取。若网站先发新事件而后台未支持，会出现临时unknown，需记录发布窗口。

检查现有发布脚本是否有资源创建、迁移、secret或cron副作用；即使叫update-only也不能盲跑。确认资源已存在、无未批准迁移，保存旧Worker版本与资产，按当前授权发布。校验目录是127或其他具体数字只代表那一版目录数量，不是跨站固定目标。

## 获客与联系请求扩展

`get_quality_insights` 的 `acquisition` 按选定会话首次已观测原生pageview归因，保留
安全UTM/referrer、入口、语言、设备和版本集合。每个行为只计一次会话，不是顺序或多触点漏斗。
完整读取后才应用全会话QA/internal隔离；缺失pageview不猜渠道，旧form_success不当受理。
详见仓库 `docs/quality-analysis.md` 的 Acquisition 契约与 `growthCoverage`。

迁移到其他站时先盘点真实业务：表单提交、服务端受理、送达、有效线索、单次回复许可、
营销订阅、实际跟进、用户回复必须分别定义，不能复用一个success假装闭环。浏览器观测
服务端响应不是独立服务端遥测。没有CRM/webhook/留存标识的字段保持null，并列出接入需求。
不得采集联系方式、自由文本、完整URL或凭据到分析事件；渠道只用非个人活动短标签。

本版unknown缺上下文原因不被legacy覆盖；MCP内部批量5000，外部证据500/页。
上线重新开始旧cursor，完整导出校验总量、顺序及推进；批量改善不保证任意窗口无超时。
# CRM 业务证据适配

可选 `get_crm_quality` 是独立服务端业务聚合，只读专用连接需按 siteId 和真实域名单独配置。参数固定 `siteId/from/to`，不接受浏览器漏斗filters；`not_connected`、503/502、null不得改写成0。

联系请求需要持久化业务ID和本次请求许可，默认不订阅营销；跟进需人工确认、幂等发送锁、供应商邮件ID、签名/防重放/乱序回执。失败与送达分开保留。无签名回执不宣称送达，邮箱打开/链接扫描不算真实回访。客户回复若由站主确认，必须显式标记人工来源；自动收信未接通继续保留null。

示例站的账号留存仅测已验证账号在成功保存项目后，按UTC成熟1/7/30日重新保存；排除owner/QA/internal/unknown，遵循DNT/GPC和私密页面排除。保留期内首次观测不等于终身首次，best-effort活动记录可漏报。其他网站需重新定义有业务价值的回访，不复制示例人群或分母。

分析端只取固定白名单数值，不得把客户邮箱、正文、联系人ID或整份CRM记录写入 Traks、SOP或问题卡。暂无跨匿名会话/业务身份join就保留未关联，不猜测渠道归因。发信/CRM变更不经只读MCP工具执行。
