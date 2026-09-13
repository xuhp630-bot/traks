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
