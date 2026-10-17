# 富途真实模拟盘 / Actual Futu paper trading

## What is implemented

**真实行情 + 实际富途 SIMULATE 账户 + Agent 自主执行。** 不是自行捏造价格或撮合的演示账本。第一版支持港股、美股股票，DAY 限价单、已有多头持仓卖出和撤单。A 股仍可研究，但本适配器暂不执行 A 股委托。

- React 侧栏新增「模拟交易」：连接账户、查看资金/持仓/券商委托、策略授权、暂停、核对和执行记录。
- 用户在界面一次性明确策略、白名单及限额后，Agent 可通过 MCP 自主评估、提交、撤单，不需要逐笔确认。
- 每笔买卖重新评估配置的入场/退出规则，记录规则版本、授权 revision、原始行情时间/来源/指标、理由、限价数量与券商响应。
- 当前真实行情由插件原有 Yahoo/Tencent 数据接口提供，并非承诺富途付费实时行情；过期、休市或冲突会阻止新委托。富途账户、委托、基本资料和现金购买能力来自本地 OpenD。
- 页面可见时每 15 秒仅读取本地执行记录，便于查看 Agent 进度；不会因此请求 OpenD 或下单。
- 没有自动后台交易循环；需要当前 Agent 执行请求，或用户明确创建的定时任务。授权状态不是 Agent 正在运行的证明。
- 不修改研究模块的实盘候选/模型准入规则。模拟技术规则试验不能被当成已通过实盘验证的预测模型。

## Setup (no global Python packages)

1. 从富途官方下载、启动 OpenD，在 **OpenD 自己的界面** 登录。默认网关端口 11111。本插件只连 `127.0.0.1`；不存储登录密码、不解锁实盘账户。行情或模拟账户权限不足时明确失败，不自动购买行情包。
2. 在项目根目录执行：

   ```bash
   npm run setup:futu
   ```

   复用已有 Python 3.10+，将 `futu-api==10.11.7108` 安装到用户目录独立 venv，不安装系统运行时、不更改 PATH。可以用 `HROUTER_FUTU_PYTHON_BASE` 指定已有 Python，用 `HROUTER_FUTU_VENV` 指定 venv 目录。脚本打印最终解释器路径。Node-only 功能不依赖这个可选环境。

3. 对启动插件的进程设置以下环境变量并重启。不要把登录凭据写到这些变量里；项目不自动读取 `.env`：

   ```bash
   export HROUTER_FUTU_ENABLED=1
   export HROUTER_FUTU_PYTHON="$HOME/.local/share/hrouter-market-pulse/futu-venv/bin/python"
   export HROUTER_FUTU_PORT=11111
   npm run build
   npm start
   ```

   Windows 使用安装脚本实际打印的 `Scripts/python.exe` 路径和 PowerShell 环境变量语法。已安装插件需要使用更新后的源码/分发包并重启 MCP，不能仅刷新浏览器；`.mcp.json` 已声明上述环境变量转发。
4. 打开真实数据面板的「模拟交易」，选择 HK 或 US，连接 OpenD，选择返回的 SIMULATE 股票账户，点击「核对账户」。没读取到账户时不会显示伪造的模拟账户资金。
5. 在「策略与授权」中填写：代码白名单、单笔/单日/单标的金额上限、每日委托数、最大行情年龄（不超过 300 秒）、限价偏差（不超过 5%）、港股每手股数、买入/卖出声明式规则。示例 JSON **不是推荐策略**。所有金额以该账户市场的 HKD/USD 计算，无自动换汇。
6. 勾选授权后保存。此时 Agent 可自主执行模拟单；所有实盘路径仍禁止。先从用户自己确定的小规模实验开始，不要为跑通演示而放宽时间/质量校验。

## Agent workflow

```text
使用 hrouter-paper-trading 工作流，在我已授权的富途模拟账户中检验已保存策略。
先核对真实账户、未完成委托和当时行情；在白名单和限额内自主判断是否提交限价单。
记录没有下单的原因以及实际执行结果；不要将下单响应当成成交。
如果委托结果未知，停止新单并核对；不更换幂等键重试。
只执行当前这一轮，不创建定时任务，不操作实盘。
```

| MCP tool | Behavior |
| --- | --- |
| `get_paper_trading_status` | Read authorized policy, actual local journal and account observations; does not grant authority |
| `list_paper_accounts` | Discover only permitted SIMULATE stock accounts through OpenD |
| `refresh_paper_account` | Query actual funds/positions/current orders, reconcile uncertain acknowledgements and record equity observations |
| `evaluate_paper_order` | Preflight against real quotes and saved strategy; does not place an order |
| `submit_paper_order` | Autonomous bounded limit order; stable idempotency key required; re-evaluates all gates |
| `cancel_paper_order` | Cancel only plugin-originated SIMULATE orders; available while paused |

Authorization editing is an explicit local UI action, not an MCP tool. The Agent cannot use a tool to raise its limits or enable itself. Pausing prevents new orders after the policy save succeeds; it does not cancel orders already sent or kill an in-flight request.

## Execution boundaries

- Both JavaScript and Python reject real environments. Python independently checks `get_acc_list` on every request and always supplies `TrdEnv.SIMULATE` plus an exact string-selected account ID; it never relies on SDK defaults (which may be REAL).
- Before submission, broker basic info must identify a stock and current board lot. Cash-only capacity uses `max_cash_buy`, not cash-plus-margin capacity. A sell must have `max_position_sell` capacity and sellable long holdings. Capacity/basic-info errors fail closed.
- Long-only DAY limit orders; extended-hours fills disabled. Broker lot/tick size/fees/session/permissions remain authoritative. Public quotes can be delayed or limited. No synthetic fallback.
- Daily budgets use the selected exchange timezone. All buy and sell attempts dispatched to the bridge count conservatively (including subsequent refusal, failure or cancellation); this is a risk budget, not a count of actual broker fills; strategy edits do not reset usage. Position limits include pending buys and actual holdings, including outside activity visible to the account.
- Every economic intent has one caller-supplied key. Changed request + same key is rejected. The intent is durably saved before broker dispatch. Acknowledged/blocked/uncertain intents are not replayed after restart. A failed send with no conclusive response is UNKNOWN, not zero fills.
- Unknown/dispatching requests block new orders in that account until reconciled. The current order list may not contain old orders. Failure to find an order is **not** proof no execution occurred; request manual broker reconciliation instead of guessing or automatically clearing the block.
- Local state resides at `<HROUTER_REPORT_DIR or default data dir>/paper-futu/`. `policy.json` contains the authorized rules; `state.json` contains intents and equity observations. It is not the manually entered portfolio, and never written to the repository. State is capped at 10,000 intents; start a new explicitly archived experiment rather than silently dropping idempotency history.
- A cross-process `operation.lock` prevents concurrent broker writes and policy changes. If a process dies, do not automatically remove the lock/replay. Stop related plugin processes, inspect Futu for any outstanding `hrouter:<intent-id>` order, back up the state, then have an operator recover the lock and reconcile. Never change uncertain status without broker evidence.

## Measurement and verification boundaries

The UI records broker-reported equity observations, but **does not claim strategy return**: deposits, reset balances, other trading and strategy switches are not adjusted out. It does not infer complete fills or exact fees from an order response. No fabricated win rate, realized profit, annualized return or historical backfill is displayed.

Integration tests use explicit SDK mocks and do not place orders. Importing the official SDK verifies installation/API shape, not a successful brokerage connection. A live smoke test requires your logged-in OpenD, your SIMULATE account, your authorization and actual broker responses. Distinguish implemented features, offline tests and completed live paper experiments.

## Official API contracts consulted

- [Python SDK](https://github.com/FutunnOpen/py-futu-api)
- [Account list](https://openapi.futunn.com/futu-api-doc/trade/get-acc-list.html)
- [Place order](https://openapi.futunn.com/futu-api-doc/trade/place-order.html)
- [Maximum trading quantity](https://openapi.futunn.com/futu-api-doc/trade/get-max-trd-qtys.html)
- [Modify/cancel](https://openapi.futunn.com/futu-api-doc/trade/modify-order.html)
- [Simulation limitations](https://openapi.futunn.com/futu-api-doc/qa/trade.html)

The SDK is optional and separately installed; no commercial quote subscription or OpenD installer is bundled.
