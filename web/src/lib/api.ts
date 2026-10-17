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
export interface LimitStatus { cashPct: number; holdings: number; newToday: number; ordersToday: number; buyableValue: number; positionsLeft?: number; newLeftToday?: number; ordersLeftToday?: number; active: string[] }

export interface Instruction { id: string; text: string; at: string; expiresAt: string; status: string }
export interface Report { id: string; at: string; title: string; summary: string; sentiment: string | null; marketView?: string | null; actions?: Array<{ symbol: string; action: string; detail: string }>; picks?: Array<{ symbol: string; thesis: string }>; risks?: string | null; nextSteps?: string | null; body?: string | null; strategyVersion?: number; account?: AccountRef }
export interface AccountRef { id: string; name: string; model: string; market: Market; currency: string; agent: Agent }
export interface Agent { client: string | null; label: string | null }

export interface Position { symbol: string; name: string; quantity: number; averageCost: number; marketValue: number; weightPct: number; unrealizedPnl: number; unrealizedPnlPct: number | null; lastPrice: number; lots: Array<{ date: string; quantity: number }>; exitLevels: { stopLoss: number | null; takeProfit: number | null } | null; openedAt: string }
export interface Trade { id: string; orderId: string; symbol: string; name: string; side: 'BUY' | 'SELL'; quantity: number; price: number; gross: number; fees: number; realizedPnl: number | null; at: string; reason: string; trigger?: string; fillBasis?: string | null; quote?: { price: number | null; bid: number | null; ask: number | null; asOf: string | null; source: string | null } | null; strategyVersion?: number }
export interface Order { id: string; symbol: string; name: string; side: 'BUY' | 'SELL'; type: string; quantity: number; filledQuantity?: number; limitPrice: number | null; status: string; reason: string; rejectReason?: string; createdAt: string; trigger?: string; placedBy?: string }
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
  risk: { breaker: { drawdownPct: number } | null; drawdownPct: number }; rank?: number; demo?: boolean
}

export interface AccountDetail extends AccountSummary {
  positions: Position[]; openOrders: Order[]; orders: Order[]; trades: Trade[]; journal: Array<{ id: string; at: string; kind: string; summary: string; details: string | null; symbols: string[] }>
  reports: Report[]; events: ArenaEvent[]; changeLog: Change[]; requests: ChangeRequest[]; locks: Record<string, boolean>; equity: Array<{ at: string; equity: number }>
  strategyHistory: Array<{ version: number; summary: string; note: string | null; at: string }>
}

export interface Leaderboard { generatedAt: string; demo?: boolean; groups: Array<{ market: Market; competition: string; currency: string; accounts: AccountSummary[] }>; matcher: { state: string; lastTickAt?: string }; service: { state: string } }

export interface Runner { type: string; model?: string; timeoutMinutes?: number; strategyId?: string; params?: Record<string, unknown>; command?: string; args?: string[]; webSearch?: boolean }
export interface Job {
  accountId: string; enabled?: boolean; times: string[]; intervalMinutes?: number; runner: Runner; backup?: Runner; mode?: string
  strategy?: { strategyId: string; intervalMinutes: number; params: Record<string, unknown> }
  lastRun?: { id: string; status: string; at: string }; strategyLastRun?: { id: string; status: string; at: string }
  consecutiveFailures?: number; paused?: { kind: string; message: string | null; at: string }; running: boolean; strategyRunning: boolean; queued: boolean; unhealthy: boolean
  pool: { pausedUntil: string; kind: string; message: string | null } | null
}
export interface Schedules { jobs: Job[]; strategies: Array<{ id: string; name: string; version: string; markets: Market[]; description: string; origin: string; params: Record<string, { type: string; default: unknown; label?: string }> }>; strategyErrors: string[]; strategyDir: string; service: { state: string }; scheduler: { role: string; running: string[] } }

export interface RunEvent { t: string; at: string; seq: number; id?: string; text?: string; name?: string; input?: unknown; ok?: boolean; preview?: string; inputTokens?: number; outputTokens?: number; costUsd?: number | null; message?: string; command?: string }
export interface Run {
  id: string; accountId: string; lane: string; runner: string; model: string | null; strategyId?: string | null; slot: string | null; trigger: string; startedAt: string; finishedAt?: string
  status: string; error?: string | null; reason?: string; usage?: { inputTokens: number; outputTokens: number; costUsd: number | null; estimated?: boolean } | null; failure?: { kind: string; message?: string; resetAt?: string } | null
  orders?: Array<{ symbol: string; side: string; quantity: number; status: string; fillPrice?: number | null; error?: string | null }>; backupFor?: string; events?: number; durationMs?: number; stdoutTail?: string
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

export interface LibrarySkill { id: string; name: string; category: string; markets: Market[]; source: string; status: string; requires?: string[]; summary: string; starterStrategy?: string; sourceInfo: { repo: string; url: string; commit: string | null; license: string } | null }
export interface LibraryTemplate { id: string; name: string; markets: Market[]; status: string; skills: string[]; starterStrategy: string | null; builtinStrategy?: boolean; prompt: string; suggestedLimits: Record<string, number>; cadence: { reviewMinutes: number | null; strategyMinutes: number }; requires?: string[] }
export interface Library { skills: LibrarySkill[]; templates: LibraryTemplate[]; discipline: string[]; note: string }

export interface EnvItem { id: string; group: string; name: string; status: 'ok' | 'action' | 'temporary' | 'missing'; detail: string }
export interface EnvReport { at: string; items: EnvItem[]; agents: Array<{ id: string; name: string; kind: string; command: string | null; version: string | null; installed: boolean; status: string; traders: number; detail: string }>; pools: Pool[]; summary: Record<string, number>; acpPresets: Array<{ id: string; name: string; command: string; args: string[] }> }

export interface Page<T> { total: number; offset: number; limit: number; all?: number; items?: T[] }

export interface Usage { since: string; traders: Array<{ accountId: string; reviews: number; strategyRuns: number; inputTokens: number; outputTokens: number; costUsd: number; failed: number; byRunner: Array<{ runner: string; tokens: number }> }>; totals: { reviews: number; strategyRuns: number; tokens: number; costUsd: number; failed: number } }
