# React 面板 / React dashboard

## 技术栈与构建 / Stack and build

- React 19、Radix Themes 3、Lucide React；图表引擎为 TradingView Lightweight Charts 5。版本锁定在 lockfile。
- 全部脚本、样式与字体回退本地打包到 `assets/dashboard.js` / `assets/dashboard.css`，不加载 CDN；许可证见 `THIRD_PARTY_NOTICES.md`。
- 不要手工修改生成的 bundle。改 `ui/` 后 `npm run build:ui` 并刷新页面；提交或打包前 `npm run build`（同时生成 MCP bundle 与可安装插件）。改 HTTP / demo 模块需要重启服务；常驻服务检测到 bundle 变化会自动重启。

```bash
npm ci
npm run build:ui
npm run build
npm test && npm run check && npm run smoke
npm run demo
```

## 结构 / Layout

| 文件 | 职责 |
| --- | --- |
| `ui/main.jsx` | 挂载与错误边界 |
| `ui/App.jsx` | 导航（研究 / 模拟交易两组 7 个页面）、偏好、托管账户、全局搜索、全屏、写操作锁与通知 |
| `ui/components/MarketBoard.jsx` · `MarketChart.jsx` | 市场工作台、自选、K 线与分时、指标与数据核验 |
| `ui/components/Managed.jsx` | 我的持仓（Agent 托管组合） |
| `ui/components/Arena.jsx` | 竞技场、排行榜、对比、账户详情与历史页签、报告卡片、日报面板、接入引导 |
| `ui/components/Reports.jsx` | 报告中心、报告详情、日报详情 |
| `ui/components/Automation.jsx` | 账户自动运行（调度、运行方式、策略参数、运行记录） |
| `ui/components/Paging.jsx` | 分页 hook（服务端 `usePagedList`、本地 `useLocalPage`）、`Pager`、`SearchField`、`DateRange` |
| `ui/components/CommandPalette.jsx` | ⌘K 全局搜索 |
| `ui/components/ResearchPanels.jsx` · `PaperTrading.jsx` · `Editors.jsx` · `Primitives.jsx` | 证据与研究记录、富途模拟盘、编辑弹窗、通用组件 |
| `ui/data.mjs` | 纯展示层校验：缺失数字、真实 OHLC、来源 URL、时效、分币种持仓、证据去重 |
| `ui/styles.css` | 布局与深浅色设计变量 |

## 交互约定 / Interaction contracts

- **列表**：长列表一律服务端筛选 + 分页（`/api/arena/reports`、`/api/arena/digests`、`/api/arena/runs/:id`、`/api/arena/accounts/:id/history?kind=orders|trades|events|reports|journal`，参数 `offset`、`limit`、`q`、`side`、`type`、`from`、`to`）。已在内存里的短列表用本地分页；只有一页时不显示分页器。切换筛选回到第一页，加载新页时保留旧内容，不闪烁。
- **稳定布局**：滚动条位置固定、页面与列表设最小高度、数字等宽，筛选和页签切换不跳动。
- **读取速度**：后台撮合器每个交易时段 tick 都会给所有账户按最新行情估值，因此它在运行时面板直接读本地状态，不在每次请求里抓行情；「同步行情」按钮强制刷新。
- **报告**：卡片有精简（结论 + 操作标签 + 查看完整报告）与完整两种形态；完整报告把市场判断、本轮操作（每只一行）、看好标的、风险、下一步分块展示。
- **全局搜索**：⌘K / Ctrl+K 或 `/`；匹配中英文页面名、账户名、模型、股票代码与名称、常用操作。
- **全屏**：顶栏切换整页全屏（隐藏侧栏，用 ⌘K 导航）；带全屏按钮的面板单独全屏，图表随容器高度放大。
- **持仓与估值**：分币种汇总，缺失价格或币种不匹配时不估值；价格按市场显示位数（A 股 / 美股 2 位，港股 3 位）。
- **证据**：保留来源、报告期、单位、发布时间与可得时间；预计事件标注为预计；不虚构财报日期。
- **编辑**：带标签的字段、可键盘操作的弹窗、加载锁与行内错误；写入成功后的读取失败不会重试写入。
- **演示模式**：合成数据仅保存在当前进程内存，界面明确标注；富途模拟盘与调度在演示模式下禁用。

## 验证 / Verification

`tests/react-dashboard.test.mjs` 服务端渲染各页面并覆盖展示层约定；`tests/arena-http.test.mjs` 覆盖竞技场 HTTP 接口与服务端分页筛选；`scripts/smoke-local.mjs` 检查打包资源与许可证。浏览器检查还应覆盖：图表缩放与销毁、面板全屏、深浅色、弹窗键盘操作、窄屏滚动与分页。
