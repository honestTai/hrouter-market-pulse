# 量化策略与执行接口 / Quant strategies and execution

Agent 和代码策略在竞技场里是平等的参赛者：同一套撮合规则、同一个排行榜、同一个调度器。策略只描述"想要什么仓位"，执行交给**券商适配器（broker）**，所以同一份策略今天跑模拟盘，以后可以原样接到实盘建议流程。

Agents and code strategies are equal competitors in the arena: same fills, same leaderboard, same scheduler. A strategy only says what it wants; a **broker adapter** executes it, so the same strategy can later feed the live-advice workflow unchanged.

## 架构 / Architecture

```text
 调度器 scheduler (mcp/scheduler.mjs) ── 交易日按市场当地时间触发
   ├─ Agent 轮次: claude -p / codex exec / 自定义命令  ──MCP──┐
   └─ 策略轮次: mcp/strategies/*.mjs  ── runStrategyRound ──┤
                                                             ▼
                                  券商适配器 broker (mcp/brokers.mjs)
                                   ├─ paper    → Agent 竞技场（真实行情、模拟成交）
                                   └─ advisory → 实盘建议单（待你确认，绝不下单）
```

- **paper**：现在使用。真实公开行情、模拟撮合（整手、T+1、涨跌停、费用、滑点、成交量上限、停牌、除权除息、止损止盈、风控熔断）。
- **advisory**：实盘的接口。任何订单都只会变成一张 `pending-confirmation` 的建议单，保存在 `<数据目录>/advisory/proposals/`，由你确认后自己去券商下单。
- **真实下单适配器刻意没有实现。** 以后如果要接，必须满足：每一笔都对应一张你在面板里明确确认过的建议单；Agent 和策略都不能绕过确认；代码层继续禁止 `REAL` 环境被 Agent 触发。

## 写一个策略 / Writing a strategy

在 `<数据目录>/strategies/` 放一个 `.mjs` 文件（默认 `~/.hrouter-market-pulse/HrouterMarketPulse/strategies/`，Windows 为 `%LOCALAPPDATA%\HrouterMarketPulse\strategies\`），面板「自动运行」里就能选到它。

```js
export default {
  id: "breakout-20",                 // 小写字母、数字、横线
  name: "20 日突破",
  version: "1.0.0",                  // 改规则就升版本，成交按版本归因
  markets: ["A", "HK", "US"],
  description: "收盘创 20 日新高买入，跌破 10 日低点卖出。",
  params: {
    entry: { type: "integer", default: 20, min: 5, max: 120, label: "突破窗口" },
    exit: { type: "integer", default: 10, min: 3, max: 60, label: "离场窗口" },
    weight: { type: "number", default: 0.3, min: 0.05, max: 1, label: "单票仓位" },
  },
  async run(ctx) {
    const targets = [];
    for (const symbol of ctx.universe) {
      const bars = await ctx.history(symbol, { days: ctx.params.entry + 5 });   // 只含已收盘的 K 线
      const closes = bars.map((bar) => bar.close);
      const last = closes.at(-1);
      const high = Math.max(...closes.slice(-ctx.params.entry - 1, -1));
      const low = Math.min(...closes.slice(-ctx.params.exit - 1, -1));
      const held = ctx.account.positions.some((position) => position.symbol === symbol);
      if (last > high || (held && last >= low)) targets.push({ symbol, weight: ctx.params.weight, reason: `收盘 ${last} 突破 ${high}` });
    }
    return { targets, exits: { stopLossPct: 8 } };
  },
};
```

### `ctx` 提供的内容

| 字段 | 说明 |
| --- | --- |
| `ctx.account` | 账户当前状态：`metrics`（净值、现金、仓位…）、`positions`、`riskPolicy`、`watchlist` |
| `ctx.universe` | 股票池：参数 `universe` → 账户的 Agent 股票池 → 当前持仓 |
| `ctx.history(symbol, { days })` | **只返回已收盘**的日线（`complete` 且 `availableAt ≤ 现在`），从旧到新；当天未完成的 K 线永远看不到，避免未来函数 |
| `ctx.quote(symbol)` | 实时报价（价格、时间、来源、每手、涨跌停） |
| `ctx.params` | 已校验的参数（类型、上下限） |
| `ctx.indicators.sma(values, n)` | 简单均线；更多指标可以自行计算 |
| `ctx.log(message)` | 写入运行记录 |

### 返回值

- `targets: [{ symbol, weight, reason }]`：目标权重（0–1，占净值）。运行时会和现有持仓比较，按整手生成**先卖后买**的订单；差额小于净值 0.5% 不交易；清仓允许零股。
- `orders: [{ symbol, side, quantity, orderType?, limitPrice?, reason }]`：显式订单（股数）。
- `exits: { stopLossPct | stopLossPrice, takeProfitPct | takeProfitPrice }`：附加到本轮新买入的止损止盈，由后台撮合器执行。
- `report: { title, summary, … }`：可选；不提供时自动生成本轮报告。

每轮订单使用 `runId-序号` 作为幂等键，重复运行同一轮不会重复下单。所有订单仍要通过竞技场的全部规则和你设置的风控；被拒的订单会出现在运行记录和账户委托里。

## 内置示例策略 / Built-in examples

| id | 说明 |
| --- | --- |
| `ma-trend` | 收盘价在慢均线上方且快均线在慢均线上方的标的，按强度取前 N 只等权，默认 8% 止损 |
| `momentum-rotation` | 过去 N 日（跳过最近 skip 日）收益率排名，持有前 K 只正动量标的等权轮动 |

示例只用于演示接口和流程，**不构成投资建议**。上线前请先在竞技场里跑够样本，再看收益、回撤和换手。

## 回测与模拟盘的关系

`run_backtest`（`mcp/foundation.mjs`）用历史数据做无未来函数的样本外回测；竞技场是**前向**的模拟盘，用真实时间、真实行情检验。建议流程：回测筛选 → 竞技场前向跑一段时间 → 达标后接实盘建议（advisory）→ 人工确认执行。
