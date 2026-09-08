# Hrouter Market Pulse

**一个开源的 A 股、港股、美股研究工作台，也是可安装的 Codex 插件。**

[English](README.en.md) · [官网](https://hrouter.net/) · [使用文档](docs/USAGE.md) · [数据与方法](docs/METHODOLOGY.md) · [版本记录](CHANGELOG.md)

![Hrouter Market Pulse 中文看盘工作台，使用合成演示数据](docs/images/dashboard-zh.png)

看盘时，把价格、持仓、异动、公告和判断依据放在同一个工作台。Hrouter Market Pulse 负责可复核的数据计算，Codex 当前任务模型负责研究和解释。无需另配一个模型服务。

## 能做什么

| 工作流 | 能力 |
| --- | --- |
| 看盘 | 中英文切换、自选股筛选排序、持仓优先、日线和 5 分钟图、成交量、清晰的指标周期与数据状态 |
| 行情核验 | Yahoo Finance 与腾讯财经交叉检查，核对报价时间、交易时段、历史样本和数据质量 |
| 异动监控 | 记录触发、恢复和冷却状态，避免同一个条件反复通知；过期数据不触发新交易信号 |
| 研究背景 | 指数对照、相对强弱、自选池行业分组，明确区分自选池统计和完整市场统计 |
| 公告证据 | SEC 公告与财务事实、巨潮公告适配器，以及原始交易所公告导入；保留来源和首次可见时间 |
| 风险预算 | 校验币种与汇率，纳入已有持仓、可用现金、组合风险和交易单位 |
| 策略验证 | 按时间推进的共享资金回测、市场持有规则、费用滑点、公司行动，以及滚动样本外评估 |
| 决策复盘 | 保存原始判断和当时证据，追加结果回顾；预测先记录，结果后核对 |

## 安装 Codex 插件

需要 Node.js 20 或更新版本，以及支持插件的 Codex CLI / 桌面应用。

```bash
codex plugin marketplace add honestTai/hrouter-market-pulse
codex plugin add hrouter-market-pulse@hrouter-market-pulse
```

安装包已包含 MCP 运行文件和图表资源。安装后新建一个 Codex 任务，再选择 Hrouter Market Pulse。

```text
设置中文界面，自选股为 600519、0700.HK、AAPL，生成盘中报告。
```

也可以从 Releases 下载 ZIP，解压后将解压目录作为本地 marketplace 安装。不要把 `plugins/hrouter-market-pulse` 当成 marketplace 根目录。

## 本地运行与开发

```bash
git clone https://github.com/honestTai/hrouter-market-pulse.git
cd hrouter-market-pulse
npm ci
npm run build
npm run demo
```

浏览器打开 [http://127.0.0.1:8787](http://127.0.0.1:8787)。演示模式使用明确标注的合成数据，修改仅保存在本次进程内。

运行 `npm start` 启动真实数据工作台，在设置中添加自选股后刷新。运行 `npm test`、`npm run check` 和 `npm run smoke` 验证源码、构建及 MCP 接口。

## 数据边界

- 公开行情可能延迟或被限流。本项目没有券商级实时数据承诺，也不连接下单接口。
- HKEXnews 公告当前通过原始记录导入。完整市场广度需要带来源与统计范围的数据输入，自选池涨跌数始终标注为自选池。
- 官方源不可用时显示失败或缺失，不用模拟行情替代。财务数据保留单位、期间与修订信息，不自动混算不同期间。
- 内置交易日历的覆盖范围、回测执行假设和模型准入条件见[方法说明](docs/METHODOLOGY.md)。历史样本和模拟成交不能证明未来收益。
- 自选股、持仓、证据与决策记录写入本机数据目录，不写入仓库。报告的联网查询会把所查证券代码发送给对应数据源。

## 项目结构

```text
mcp/                       服务、行情、风控、研究与 HTTP 接口
assets/                    看盘界面与本地第三方图表资源
skills/                    7 个 Codex 工作流技能
tests/                     离线回归测试
docs/                      使用、方法、宣传与截图
plugins/hrouter-market-pulse/  自动构建的可安装插件
.agents/plugins/marketplace.json  Codex marketplace 入口
```

代码采用 [MIT](LICENSE) 许可证。图表使用 [TradingView Lightweight Charts](https://www.tradingview.com/lightweight-charts/)，图标使用 [Lucide](https://lucide.dev/)，各自许可证见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

欢迎提交包含复现步骤、数据时间和脱敏样例的 Issue 或 PR。项目官网：[https://hrouter.net/](https://hrouter.net/)。
