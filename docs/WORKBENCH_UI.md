# 工作台界面 / Workbench UI

## 技术栈与构建 / Stack and build

- 和 HRouter 视频工作台同一套：React 19 + TypeScript + Vite 6 + Tailwind CSS 4，TanStack Router / Query，Radix Dialog，Lucide 图标，sonner 通知，Geist 字体；K 线用 TradingView Lightweight Charts 5。
- 源码在 `web/`，`npm run build:ui` 用 Vite 打包到 `assets/app/`（`app.js`、`app.css`、字体在 `files/`）。全部本地打包，不加载 CDN；许可证见 `THIRD_PARTY_NOTICES.md`。
- 本机服务返回同一个 HTML 外壳（`mcp/dashboard.mjs`，内嵌最新行情报告），前端路由负责各页面。旧链接 `?view=arena` 等会跳到新页面。
- 开发时可以 `npx vite --config web/vite.config.ts`，把 `/api` 代理到 `HROUTER_PREVIEW_PORT`（默认 8790）上运行的面板。

```bash
npm ci
npm run build:ui       # 只打包界面
npm run build          # 界面 + MCP bundle + 可安装插件
npx tsc -p web         # 类型检查
npm test && npm run check && npm run smoke
```

> 常驻服务直接运行 `plugins/hrouter-market-pulse/mcp/server.bundle.mjs`，文件一变就会自动重启。本机有正在跑的模拟盘时，`npm run build` 会让它换成新代码。

## 桌面客户端 / Desktop app

`desktop/` 是 Tauri 2 桌面壳（和视频工作台同一套做法）：打开窗口时如果本机服务（端口 8780）没在跑，就用系统的 node 拉起安装包里的插件（`--service`），然后窗口直接打开服务自带的界面。关掉窗口服务继续跑，撮合、盯价和调度不受影响；已经用 `npm run service:install` 装了常驻服务的话直接连上。本机服务以外的链接用系统浏览器打开。安装包不带 Node，电脑上需要 Node 20+；构建需要 Rust。

```bash
npm run build                  # 先打包插件（安装包里带的就是 plugins/hrouter-market-pulse）
npm --prefix desktop ci
npm run build:desktop          # macOS 出 .app / .dmg；在 Windows 上运行同一条命令出 NSIS 安装包
```

产物在 `desktop/src-tauri/target/release/bundle/`。安装包没有签名，第一次打开要在「系统设置 → 隐私与安全性」里允许。服务日志在 `~/Library/Logs/net.hrouter.stockworkbench/service.log`（只有桌面端自己拉起服务时才写）。图标源图是 `desktop/icon.png`（用 HRouter Canvas 生图后裁成 macOS 圆角方块），改了之后运行 `npx --prefix desktop tauri icon desktop/icon.png -o desktop/src-tauri/icons` 重新生成各尺寸。

MCP 和 ACP 不受影响：Agent 仍然通过插件里的 `server.bundle.mjs --stdio` 连接，桌面端只是同一个本机服务的窗口。

## 页面 / Pages

| 路由 | 页面 | 内容 |
| --- | --- | --- |
| `/` | 工作台 | 今日领先、跑赢基准、成交 / 被拦、今日复查（跳过 / 提前叫醒）；需要你看的事（等你确认的订单、锁定项申请和规则提议、配置错误暂停、额度用尽）；交易员卡片；正在运行、额度池 |
| `/traders` | 交易员 | 卡片 / 列表；新建交易员（市场、流派模板、Agent 与备用、提示词与边界、节奏与自主级别） |
| `/traders/:id` | 交易员页 | 概览（时间线、跟交易员说话：指令 / 提问 / 长期规则、组合与边界用量、行业分布、持仓、复查过程和团队报告，可全屏）、策略（版本、代码、上线检查、节奏、回退）、设置（三层前置提示词与完整预览、边界与锁、自主级别、复查时机、团队模式、费率、Agent 与工作方式、流派 skill 与定制、归档）、报告、委托与成交（处理流水、引用来源、成交时行情、确认记录、对账）、修改记录与申请 |
| `/arena` | 竞技场 | 收益曲线叠加、排行榜、按模型 / Agent / 流派对比 |
| `/radar` | 市场雷达 | A 股涨跌家数、成交额、涨停 / 炸板 / 跌停、情绪周期和晋级率、连板天梯、龙虎榜和营业部、板块与概念、融资余额、沪深港通 |
| `/market` | 行情 | 指数、自选、K 线与分时、技术指标、数据核验、相关证据、管理自选 |
| `/research` | 研究 | 研究任务（研究问题、个股深度、投资人评审、市场复盘，只读运行）、证据与事件（同步官方来源）、研究记录（可证伪论据、追加式复盘） |
| `/reports` | 报告 | 交易员报告与收盘日报，筛选、分页、生成与推送 |
| `/strategies` | 策略库 | 交易员写的代码策略、内置量化策略、起始策略 |
| `/skills` | Skill 库 | 内置和导入的交易员 skill（来源、许可证、市场、谁在用）、导入（Git / 本机文件夹 / `~/.claude/skills`）、上游更新检查、交易员模板 |
| `/schedule` | 定时任务 | 所有调度、团队模式、今天跳过和提前叫醒的次数、启停、立即运行、额度池 |
| `/settings` | 设置 | 环境检查、Agent 管理（CLI / ACP、并发上限）、额度池、全局与市场提示词、三个市场的费率与锁、推送（日报和即时提醒）、富途模拟盘、外观、红涨绿跌、语言 |

## 结构 / Layout

| 路径 | 职责 |
| --- | --- |
| `web/src/main.tsx` · `router.tsx` | 挂载、路由、旧链接跳转、实时事件 |
| `web/src/lib/api.ts` · `queries.ts` | 接口类型、查询与写操作（带通知和缓存刷新）、SSE |
| `web/src/lib/format.ts` · `market.ts` · `prefs.ts` | 展示格式（缺失数字显示「—」）、行情与证据整理（不补造 OHLC）、外观偏好 |
| `web/src/components/ui.tsx` | 按钮、卡片、标签、开关、锁、分段、页签、分页、对话框、Agent 图标、涨跌数字 |
| `web/src/components/Shell.tsx` · `Palette.tsx` | 顶栏、侧栏 / 窄栏、市场时钟、Agent 状态；⌘K 搜索 |
| `web/src/components/trader-bits.tsx` · `NewTrader.tsx` | 交易员卡片与状态、申请 / 暂停 / 额度卡片；新建交易员 |
| `web/src/pages/*` · `pages/trader/*` | 各页面；交易员页的策略、设置、历史页签 |

界面文字用 `t('中文原文')`（`web/src/lib/i18n.ts`），英文在 `web/src/lib/i18n-en.ts`；`tests/i18n.test.mjs` 检查每条文字都有英文、占位符一致。新加文字时两边一起加。
