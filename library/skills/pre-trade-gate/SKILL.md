# 交易前纪律关卡

> 方法来自 tradermonty/claude-trading-skills 的 pre-trade-discipline-gate（MIT）。这里不跑原仓库的脚本，所有事实都从工作台工具读。

每一笔**新开仓或加仓**的买单，下单前在自己的推理里过一遍下面的清单。任何一条不满足，就不下这一单，改记 `arena_log_decision`（kind `no-trade`），写明是哪一条。

| 检查 | 怎么查 | 不满足时 |
|---|---|---|
| 有书面计划 | 入场理由、止损位、目标仓位在下单前就写得出来 | 不下单 |
| 止损预先定好 | 买单带 `stopLossPct` 或 `stopLossPrice` | 不下单 |
| 仓位在计划内 | 用「仓位计算」算出的股数，不临时放大 | 按计划股数下 |
| 实际风险 ≤ 计划风险 | （成交价 − 止损价）× 股数 ≤ 计划的亏损金额 | 缩小股数 |
| 不是报复性交易 | `arena_get_account` 的 trades / events 里，最近一个交易日有没有止损或亏损卖出；有的话，同一只或同一逻辑当天不再追 | 等冷却结束 |
| 市场状态允许 | 「亏损熔断与冷却」给出的状态不是「只减不加」或「现金优先」 | 只管理已有持仓 |
| 熔断没触发 | `risk.breaker` 为空；没有处在冷却期 | 不开新仓 |
| 边界有空间 | `limitStatus.buyableValue`、`positionsLeft`、`newLeftToday` 够这一单 | 缩小或放弃 |
| 数据可用 | 这只的 `get_quote` 返回 `signalEligible: true` | 只针对这一只放弃 |

在订单 `reason` 里写一行关卡结论，例如「关卡通过：计划止损 -7%，风险 0.9% ≤ 1%，无近期止损，市场状态允许新仓」。
