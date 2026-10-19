// Thin client for the local service. Every call goes to the same origin (127.0.0.1:8780 by default).

export class ApiError extends Error {
  status: number
  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

async function request<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, body === undefined
    ? { signal, headers: { Accept: 'application/json' } }
    : { method: 'POST', signal, headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body) })
  const text = await response.text()
  let data: unknown = null
  try { data = text ? JSON.parse(text) : null } catch { data = { error: text.slice(0, 300) } }
  if (!response.ok) throw new ApiError((data as { error?: string })?.error ?? `HTTP ${response.status}`, response.status)
  return data as T
}

export const get = <T,>(path: string, signal?: AbortSignal) => request<T>(path, undefined, signal)
export const post = <T,>(path: string, body: unknown = {}) => request<T>(path, body)

export const qs = (params: Record<string, string | number | boolean | null | undefined>) => {
  const entries = Object.entries(params).filter(([, value]) => value !== undefined && value !== null && value !== '' && value !== 'all')
  return entries.length ? `?${new URLSearchParams(entries.map(([key, value]) => [key, String(value)])).toString()}` : ''
}

// ---------------------------------------------------------------------------
// Types (only the fields the UI reads)
// ---------------------------------------------------------------------------

export type Market = 'A' | 'HK' | 'US'

export interface Metrics {
  equity: number; cash: number; availableCash: number; totalReturnPct: number; todayReturnPct: number | null
  benchmarkReturnPct: number | null; excessReturnPct: number | null; maxDrawdownPct: number; sharpe: number | null
  winRatePct: number | null; closedTrades: number; trades: number; ordersRejected: number; openOrders: number
  exposurePct: number; positions: number; tradingDays: number; sampleWarning: string | null; feesPaid: number
  decisionsLogged: number; reportsPublished: number; todayFills: number; todayRejected: number; byStrategyVersion: Array<{ version: number; trades: number; closedTrades: number; realizedPnl: number; winRatePct: number | null }>
}

export interface Limits { [key: string]: number | string[] | string | null | undefined; minCashPct?: number | null; maxPositions?: number | null }
export interface LimitStatus { cashPct: number; holdings: number; newToday: number; ordersToday: number; buyableValue: number; positionsLeft?: number; newLeftToday?: number; ordersLeftToday?: number; active: string[]; industries?: Array<{ industry: string; value: number; pct: number }> }

export interface Instruction { id: string; text: string; at: string; expiresAt: string; status: string }
export interface Report { id: string; at: string; title: string; summary: string; sentiment: string | null; marketView?: string | null; actions?: Array<{ symbol: string; action: string; detail: string }>; picks?: Array<{ symbol: string; thesis: string }>; risks?: string | null; nextSteps?: string | null; body?: string | null; strategyVersion?: number; account?: AccountRef }
export interface AccountRef { id: string; name: string; model: string; market: Market; currency: string; agent: Agent }
export interface Agent { client: string | null; label: string | null }

export interface Position { symbol: string; name: string; quantity: number; averageCost: number; marketValue: number; weightPct: number; unrealizedPnl: number; unrealizedPnlPct: number | null; lastPrice: number; lots: Array<{ date: string; quantity: number }>; exitLevels: { stopLoss: number | null; takeProfit: number | null } | null; openedAt: string }
export interface Citation { kind: string; title: string; url: string | null; source: string | null; publishedAt: string | null }
export interface QuoteSnapshot { price: number | null; bid: number | null; ask: number | null; asOf: string | null; source: string | null; changePct?: number | null; freshness?: string | null }
export interface PipelineStep { stage: 'intent' | 'limits' | 'discipline' | 'confirmation' | 'broker'; at?: string; by?: string; ok?: boolean; detail?: string | null; warnings?: string[]; status?: string; broker?: string; approvalId?: string }
export interface Trade { id: string; orderId: string; symbol: string; name: string; side: 'BUY' | 'SELL'; quantity: number; price: number; gross: number; fees: number; realizedPnl: number | null; at: string; reason: string; trigger?: string; fillBasis?: string | null; quote?: QuoteSnapshot | null; strategyVersion?: number; citations?: Citation[]; feeBreakdown?: Record<string, number> }
export interface Order { id: string; symbol: string; name: string; side: 'BUY' | 'SELL'; type: string; quantity: number; filledQuantity?: number; limitPrice: number | null; status: string; reason: string; rejectReason?: string; createdAt: string; trigger?: string; placedBy?: string; citations?: Citation[]; warnings?: string[]; pipeline?: PipelineStep[]; origin?: string; industry?: string; quoteAtSubmit?: QuoteSnapshot | null; approvalId?: string }
export interface Approval {
  id: string; kind: string; status: 'pending' | 'approving' | 'approved' | 'rejected' | 'failed' | 'expired'; reason: string; createdAt: string; expiresAt: string; decidedAt?: string; note?: string | null
  requestedBy: string | null; origin: string; warnings: string[]
  preview: { symbol: string; name: string; side: 'BUY' | 'SELL'; type: string; quantity: number; limitPrice: number | null; price: number | null; value: number | null; quote: QuoteSnapshot | null; exits: unknown }
  input: { reason: string; citations?: Citation[] }
  result?: { orderId: string | null; status: string | null; tradeId: string | null; error: string | null }
  account?: AccountRef
}
export interface Autonomy { level: 'full' | 'confirm' | 'suggest'; minValuePct: number; sells: boolean; expiryMinutes: number }
export interface Message { id: string; kind: 'question' | 'answer'; role: 'owner' | 'trader'; text: string; at: string; status: string; replyTo?: string; runId?: string | null }
export interface Rule { id: string; text: string; status: string; createdAt: string; source: string; proposedBy?: string | null }
export interface SkillOverride { append: string; params: Record<string, string>; references: Array<{ name: string; text: string }>; version?: number; updatedAt?: string }
export interface Reconcile { ok: boolean | null; partial: boolean; note: string | null; cash: { ledger: number; stored: number; diff: number }; positions: Array<{ symbol: string; ledger: number; stored: number; diff: number }>; mismatched: number; trades: number; openOrders: number; checkedAt: string }
export interface ArenaEvent { id: string; at: string; type: string; symbol?: string; message: string }
export interface Change { id: string; at: string; key: string; from: unknown; to: unknown; by: { kind: string; via?: string; client?: string }; reason: string | null }
export interface ChangeRequest { id: string; at: string; key: string; from: unknown; to: unknown; reason: string | null; by: { kind: string; client?: string }; status: string }

export interface AccountSummary {
  id: string; name: string; competition: string; market: Market; currency: string; agent: Agent; model: string
  strategy: { version: number; summary: string; updatedAt: string }; status: string; createdAt: string; initialCash: number
  metrics: Metrics; curve: Array<{ at: string; returnPct: number }>; lastActivityAt: string | null; lastRoundAt: string | null
  latestReport: Report | null; watchlist: { symbols: string[] } | null; limits: Limits; limitStatus: LimitStatus
  health: { status: string; missedTradingDays: number }; alerts: Array<{ type: string; severity: string; message: string }>
  template: string | null; skills: string[] | null; pendingRequests: number; instructions: Instruction[]; prompt: string
  autonomy?: Autonomy; pendingApprovals?: number; approvals?: Approval[]; rules?: Rule[]; messages?: Message[]; readonly?: { until: string; reason: string } | null
  risk: { breaker: { drawdownPct: number } | null; drawdownPct: number }; rank?: number
}

export interface AccountDetail extends AccountSummary {
  positions: Position[]; openOrders: Order[]; orders: Order[]; trades: Trade[]; journal: Array<{ id: string; at: string; kind: string; summary: string; details: string | null; symbols: string[] }>
  reports: Report[]; events: ArenaEvent[]; changeLog: Change[]; requests: ChangeRequest[]; locks: Record<string, boolean>; equity: Array<{ at: string; equity: number }>
  strategyHistory: Array<{ version: number; summary: string; note: string | null; at: string }>
  skillOverrides?: Record<string, SkillOverride>
}

export interface Leaderboard { generatedAt: string; groups: Array<{ market: Market; competition: string; currency: string; accounts: AccountSummary[] }>; matcher: { state: string; lastTickAt?: string }; service: { state: string } }

export interface Runner { type: string; model?: string; effort?: string; timeoutMinutes?: number; strategyId?: string; params?: Record<string, unknown>; command?: string; args?: string[]; webSearch?: boolean }
export interface Job {
  accountId: string; enabled?: boolean; times: string[]; intervalMinutes?: number; runner: Runner; backup?: Runner; mode?: string
  strategy?: { strategyId: string; intervalMinutes: number; params: Record<string, unknown> }
  lastRun?: { id: string; status: string; at: string }; strategyLastRun?: { id: string; status: string; at: string }
  consecutiveFailures?: number; paused?: { kind: string; message: string | null; at: string }; running: boolean; strategyRunning: boolean; queued: boolean; unhealthy: boolean
  pool: { pausedUntil: string; kind: string; message: string | null } | null
  gate?: { enabled: boolean; movePct: number; maxQuietMinutes: number }; wake?: { enabled: boolean; movePct: number; minMinutes: number; maxPerDay: number }
  gateToday?: { date: string; skipped?: number; wakes?: number; last_skipped?: { at: string; reason: string }; last_wakes?: { at: string; reason: string } } | null
  lastReviewAt?: string | null
  team?: { enabled: boolean; roles: string[]; debate: boolean; analyst: Runner | null; timeoutMinutes: number }
}
export interface Schedules { jobs: Job[]; strategies: Array<{ id: string; name: string; version: string; markets: Market[]; description: string; origin: string; params: Record<string, { type: string; default: unknown; label?: string }> }>; strategyErrors: string[]; strategyDir: string; service: { state: string }; scheduler: { role: string; running: string[] } }

export interface RunEvent { t: string; at: string; seq: number; id?: string; text?: string; name?: string; input?: unknown; ok?: boolean; preview?: string; inputTokens?: number; outputTokens?: number; costUsd?: number | null; message?: string; command?: string }
export interface Run {
  id: string; accountId: string; lane: string; runner: string; model: string | null; strategyId?: string | null; slot: string | null; trigger: string; startedAt: string; finishedAt?: string
  status: string; error?: string | null; reason?: string; usage?: { inputTokens: number; outputTokens: number; costUsd: number | null; estimated?: boolean } | null; failure?: { kind: string; message?: string; resetAt?: string } | null
  orders?: Array<{ symbol: string; side: string; quantity: number; status: string; fillPrice?: number | null; error?: string | null }>; backupFor?: string; events?: number; durationMs?: number; stdoutTail?: string
  changes?: string; role?: string; team?: Array<{ role: string; runId: string; status: string; text: string }>; messageId?: string; skillsVersion?: string | null
}

export interface Pool { key: string; paused: boolean; pausedUntil?: string; kind?: string; message?: string | null; traders: string[]; backups: string[] }

export interface TraderSettings {
  accountId: string; market: Market; currency: string; limits: Limits; limitStatus: LimitStatus
  limitSpecs: Record<string, { type: string; min?: number; max?: number; zh: string; en: string; hint: string }>
  prompt: string; locks: Record<string, boolean>; requests: ChangeRequest[]; fees: Record<string, number | boolean>; feesLocked: boolean
  prompts: { global: string; market: string }; changeLog: Change[]
}

export interface WorkbenchSettings { fees: Record<Market, Record<string, number | boolean>>; prompts: Record<string, string>; maxConcurrentAgents: number; defaultReviewMinutes: number; locks: Record<string, boolean>; changeLog: Change[] }

export interface StrategyVersion { version: number; at: string; by: { kind: string; client?: string }; changeNote: string | null; status: string; error?: string; rejectedAt?: string; lines?: number; params?: Record<string, unknown>; backtest?: Backtest; dryRun?: { ok: boolean; orders: Array<{ symbol: string; side: string; quantity: number; reason: string }>; error?: string }; meta?: { name?: string; params?: Record<string, { type: string; default: unknown; label?: string }> } }
export interface Backtest { ok: boolean; from: string; to: string; sessions: number; totalReturnPct: number; maxDrawdownPct: number; benchmarkReturnPct: number | null; trades: number; closedTrades: number; winRatePct: number | null; notes: string[]; basis: string; error?: string }
export interface TraderStrategy { strategyId: string; live: number | null; versions: StrategyVersion[]; code: string | null; version: number | null }

export interface LibrarySkill { id: string; name: string; category: string; markets: Market[]; source: string; status: string; requires?: string[]; summary: string; starterStrategy?: string; upstream?: string[]; sourceInfo: { repo: string; url: string | null; commit: string | null; license: string } | null; imported?: { source: { kind: string; url?: string; path?: string; name?: string; commit?: string; subdir?: string | null }; importedAt: string; files: string[] } }
export interface SkillUpdate { skillId: string; kind: 'builtin' | 'imported'; repo?: string; url?: string; pinned?: { sha?: string; date?: string }; latest?: { sha: string; date?: string; message?: string } | null; changed?: boolean; compareUrl?: string | null; error?: string }
export interface ResearchTask { id: string; kind: string; title: string; prompt: string; symbols: string[]; accountId: string | null; runner: Runner; status: 'queued' | 'running' | 'done' | 'failed'; createdAt: string; startedAt?: string | null; finishedAt?: string | null; runId?: string; running?: boolean; result?: { text: string; usage: { inputTokens: number; outputTokens: number; costUsd: number | null } | null; error: string | null; runId: string } | null }
export interface LibraryTemplate { id: string; name: string; markets: Market[]; status: string; skills: string[]; starterStrategy: string | null; builtinStrategy?: boolean; prompt: string; suggestedLimits: Record<string, number>; cadence: { reviewMinutes: number | null; strategyMinutes: number }; requires?: string[] }
export interface Library { skills: LibrarySkill[]; templates: LibraryTemplate[]; discipline: string[]; note: string }

export interface EnvItem { id: string; group: string; name: string; status: 'ok' | 'action' | 'temporary' | 'missing'; detail: string }
export interface EnvReport { at: string; items: EnvItem[]; agents: Array<{ id: string; name: string; kind: string; command: string | null; version: string | null; installed: boolean; status: string; traders: number; detail: string }>; pools: Pool[]; summary: Record<string, number>; acpPresets: Array<{ id: string; name: string; command: string; args: string[] }> }

export interface Page<T> { total: number; offset: number; limit: number; all?: number; items?: T[] }

export interface Usage { since: string; traders: Array<{ accountId: string; reviews: number; strategyRuns: number; inputTokens: number; outputTokens: number; costUsd: number; failed: number; byRunner: Array<{ runner: string; tokens: number }> }>; totals: { reviews: number; strategyRuns: number; tokens: number; costUsd: number; failed: number } }

// Market-wide data (radar page)
export interface LadderStep { boards: number; count: number; stocks: Array<{ symbol: string; name: string; industry: string | null; firstSealAt: string | null }> }
export interface Sentiment { date: string; limitUps: number; broken: number; limitDowns: number; brokenRatePct: number | null; highestBoard: number | null; ladder: LadderStep[]; hotIndustries: Array<{ industry: string; limitUps: number }>; error?: string }
export interface Radar {
  generatedAt: string; date: string
  breadth: { indices: Array<{ symbol: string; name: string; price: number | null; changePct: number | null; amount: number | null; advancers: number | null; decliners: number | null }>; advancers: number | null; decliners: number | null; unchanged: number | null; turnover: number | null; error?: string }
  sentiment: Sentiment
  dragonTiger: { date: string; total: number; rows: Array<{ symbol: string; name: string; reason: string | null; close: number | null; changePct: number | null; netBuy: number | null; buy: number | null; sell: number | null }>; note: string | null; error?: string }
  margin: { rows: Array<{ date: string; financingBalance: number | null; financingNet: number | null; shortBalance: number | null }>; error?: string }
  connect: { rows: Array<{ channel: string; date: string; turnover: number | null; netBuy: number | null; leader: string | null }>; note: string; error?: string }
  sectors: { rows: Array<{ code: string; name: string; changePct: number | null; amount: number | null; mainNetInflow: number | null; advancers: number | null; decliners: number | null; leader: { name: string; symbol: string } | null }>; error?: string }
  concepts: { rows: Array<{ code: string; name: string; changePct: number | null; amount: number | null; mainNetInflow: number | null; leader: { name: string; symbol: string } | null }>; error?: string }
}
export interface GlobalMover { symbol: string; name: string; price: number | null; changePct: number | null; amount: number | null }
type Part<T> = T & { error?: undefined } | { error: string }
export interface GlobalRadar {
  generatedAt: string; market: 'HK' | 'US'; currency: string; session: { status: string; date?: string }
  indices: Array<{ code: string; name: string; price: number | null; change: number | null; changePct: number | null }> | { error: string }
  breadth: Part<{ source: string; total: number | null; advancers: number; decliners: number }>
  gainers: Part<{ source: string; rows: GlobalMover[] }>; losers: Part<{ source: string; rows: GlobalMover[] }>; active: Part<{ source: string; rows: GlobalMover[] }>
  southbound?: Part<{ source: string; rows: Array<{ date: string; turnover: number | null; netBuy: number | null; leader: string | null; leaderChangePct: number | null }> }>
  chinaAdrs?: Part<{ source: string; rows: GlobalMover[] }>
}
export interface Emotion {
  date: string; previousDate: string | null
  promotion: Array<{ boards: number; candidates: number; promoted: number; ratePct: number; names: string[] }>
  moneyEffect: { samples?: number; of?: number; avgChangePct?: number; upRatioPct?: number; relimitUps?: number; partial?: boolean; note?: string } | null
  cycle: { days: Array<{ date: string; limitUps: number; broken: number; brokenRatePct: number | null; highestBoard: number | null; score: number }>; current?: number; trough?: { date: string; score: number }; daysFromTrough?: number; trend?: string; positionPct?: number | null; note: string | null }
}
