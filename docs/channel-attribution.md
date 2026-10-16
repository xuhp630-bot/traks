# Traks 渠道与声明收入

本批增强现有 Traks，不需要开通 Plausible Cloud。仍是匿名网站统计，不是账号、订单或广告账本。

## 接入

使用本站 Traks 看板生成的新版 snippet。旧调用仍有效：

```js
window.traks('Tool Completed', { tool: 'compress' });
```

新增明确的收入接口，避免把旧的通用数值误认作钱：

```js
// 仅在业务系统已确认成功、并已避免重复上报之后执行。
window.traks.event('Purchase Confirmed', {
  props: { plan: 'pro', billing: 'monthly' },
  revenue: { currency: 'USD', amount: 49 },
});
```

金额使用主币单位，支持有限的非负数；三字母币种是事件声明，不是汇率或订单真实性验证。浏览器回跳、按钮点击和刷新不证明付款。不要将前端与 webhook 重复上报；没有可靠访客上下文时不编造来源/IP。

推广链接使用 `utm_source/utm_medium/utm_campaign/utm_content/utm_term`。会话首入口保留到后续事件，多页/SPA 不依赖链接一直带参数；30分钟无活动后新开会话，不从过期页面复活旧渠道。同一标签页的来源保留使用已有短期 sessionStorage，不是长期账号识别。

Source/Medium/Campaign 可在既有看板点击筛选，目标、事件、漏斗与收入使用相同筛选范围。Content/Term 暂存为 `__traks_utm_content`、`__traks_utm_term` 事件属性，可在属性明细/目标属性条件区分素材与词；不是五维独立访客报表。自动外链/下载/WebMCP保留原 canonical 属性结构，只使用基础渠道字段筛选。

## 读数

- Goals 仍统计匿名访客的目标完成，不是注册账号人数或真实付费人数。
- 漏斗按同日、同访客、同会话的首次步骤严格时序计算；同时间戳不能证明先后。首次出现近似可能漏掉乱序后重试的有效路径，不是完整轨迹重放。
- Declared revenue 仅显示当前 Top20 事件名称下的声明收入，各币种独立，无全站收入总计/汇率换算/订单对账。旧通用值没有币种，不能补认成收入。
- 公开事件分享不自动公开新增收入；收入面板仅在已授权的私人看板显示。
- 历史无来源事件只在报表窗口内、同日同访客/会话、先前入口无歧义时回溯；缺标识、跨窗或冲突保持未关联，不改历史记录。
- 账号留存、订单/退款、广告费用、CAC/LTV/利润ROI仍待各业务站授权连接，缺数据不是0。

## 隐私与发布

DNT/GPC、`localStorage.traks_ignore = 'true'`、兼容 `plausible_ignore` 或 `window.traks.disabled = true` 可阻止新采集；不会撤销历史数据。禁止发送身份/邮箱/设备号/凭据/个人URL。常见敏感字段和query有守卫，但不能代替业务属性白名单、私密路线排除及法域审查。

未增加 D1/DO/Pipelines 物理列：收入币种与额外推广标签使用既有 event_meta。发布须先升级接收端及统计端，再发布新SDK/snippet；旧接收端严格schema会拒绝新可选字段。当前仅本地实现，未推送、迁移或部署；线上真实接收/DO与R2读回仍需验收。

## 开发验证

现有依赖与锁文件不变；这些开发测试使用 Node 24（node:sqlite / stripTypeScriptTypes），不改变 Worker 运行时。

```sh
node --test scripts/ingest-attribution.test.mjs scripts/attribution-queries.test.mjs tests/tracker-attribution.test.mjs
yarn type-check
yarn build
yarn lint
yarn tracker:check
```

浏览器隔离 fixture：构建后运行 `node scripts/attribution-browser-fixture.mjs`，只监听127.0.0.1:5518，捕获合成事件到内存，不连接任何业务账号或生产存储。SQLite语义测试不代表线上R2 SQL方言已验证。
