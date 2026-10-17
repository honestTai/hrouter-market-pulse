// Presentation-only formatting. Market facts stay server-owned; missing numbers stay "—".

export const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

export function num(value: unknown, digits = 2) {
  return isNumber(value) ? new Intl.NumberFormat('zh-CN', { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value) : '—'
}

export function int(value: unknown) {
  return isNumber(value) ? new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 0 }).format(value) : '—'
}

export function pct(value: unknown, digits = 2) {
  return isNumber(value) ? `${value > 0 ? '+' : value < 0 ? '−' : ''}${num(Math.abs(value), digits)}%` : '—'
}

export function compact(value: unknown) {
  if (!isNumber(value)) return '—'
  if (Math.abs(value) >= 1e6) return `${(value / 1e6).toFixed(value >= 1e7 ? 1 : 2)}M`
  if (Math.abs(value) >= 1e3) return `${(value / 1e3).toFixed(value >= 1e5 ? 0 : 1)}k`
  return String(Math.round(value))
}

const CURRENCY: Record<string, string> = { CNY: '¥', HKD: 'HK$', USD: '$' }
export function money(value: unknown, currency = 'CNY', digits = 0) {
  return isNumber(value) ? `${CURRENCY[currency] ?? ''}${num(value, digits)}` : '—'
}

export function time(value: string | null | undefined) {
  if (!value || !Number.isFinite(Date.parse(value))) return '—'
  return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value))
}

export function dateTime(value: string | null | undefined) {
  if (!value || !Number.isFinite(Date.parse(value))) return '—'
  return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value))
}

export function day(value: string | null | undefined) {
  if (!value || !Number.isFinite(Date.parse(value))) return '—'
  return new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric' }).format(new Date(value))
}

export function ago(value: string | null | undefined, now = Date.now()) {
  if (!value || !Number.isFinite(Date.parse(value))) return '—'
  const minutes = Math.round((now - Date.parse(value)) / 60000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  if (minutes < 1440) return `${Math.round(minutes / 60)} 小时前`
  return `${Math.round(minutes / 1440)} 天前`
}

export function duration(ms: number | null | undefined) {
  if (!isNumber(ms)) return '—'
  const seconds = Math.round(ms / 1000)
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

export function safeUrl(value: unknown) {
  try {
    const url = new URL(String(value))
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : null
  } catch { return null }
}

export const MARKET_NAME: Record<string, string> = { A: 'A 股', HK: '港股', US: '美股' }
export const BENCHMARK_NAME: Record<string, string> = { A: '沪深300', HK: '恒指', US: '标普500' }

// Which agent ran / owns an account, for marks and labels.
export function agentKind(account: { agent?: { client?: string | null; label?: string | null }; model?: string } | null | undefined) {
  const text = `${account?.agent?.client ?? ''} ${account?.agent?.label ?? ''}`.toLowerCase()
  if ((account?.model ?? '').startsWith('strategy:') || text.includes('strategy')) return 'strategy'
  if (text.includes('claude')) return 'claude'
  if (text.includes('codex') || text.includes('openai')) return 'codex'
  if (text.includes('kimi')) return 'kimi'
  if (text.includes('workbuddy') || text.includes('codebuddy')) return 'workbuddy'
  if (text.includes('gemini')) return 'gemini'
  if (text.includes('opencode')) return 'opencode'
  return 'other'
}

export const AGENT_NAME: Record<string, string> = { claude: 'Claude Code', codex: 'Codex', kimi: 'Kimi Code', workbuddy: 'WorkBuddy', gemini: 'Gemini CLI', opencode: 'OpenCode', acp: 'ACP', command: '命令行', strategy: '量化策略', other: 'Agent' }

export const RUN_STATUS: Record<string, string> = { ok: '完成', 'no-round': '没有记录这一轮', failed: '失败', timeout: '超时', skipped: '跳过', running: '运行中' }
export const FAILURE_KIND: Record<string, string> = { quota: '额度用尽', auth: '没有登录', config: '配置错误', missing: '没装这个命令', timeout: '超时', other: '出错' }

export const CHANGE_KEY: Record<string, string> = {
  minCashPct: '保留现金', maxPositions: '最多持有几只', maxPositionPct: '单只最大仓位', maxExposurePct: '总仓位上限', maxNewPerDay: '每天最多新开几只', maxOrdersPerDay: '每天最多几笔买单',
  maxRiskPerTradePct: '单笔最大风险', cooldownDays: '卖出后冷却', excludeBoards: '禁止范围', minPrice: '最低股价', maxChangePct: '不追涨', maxDrawdownPct: '回撤熔断',
  prompt: '前置提示词', reviewMinutes: '复查间隔', strategyMinutes: '策略执行频率', instruction: '指令', skills: 'Skill',
}

export function changeLabel(key: string) {
  if (key.startsWith('lock:')) return `锁定「${CHANGE_KEY[key.slice(5)] ?? key.slice(5)}」`
  if (key.startsWith('fees.')) return `${key.split('.')[1]} 费率 ${key.split('.')[2] ?? ''}`
  if (key.startsWith('prompt.')) return `${key.split('.')[1] === 'global' ? '全局' : MARKET_NAME[key.split('.')[1]] ?? key} 前置提示词`
  return CHANGE_KEY[key] ?? key
}

export function changedByLabel(by: { kind: string; via?: string; client?: string } | undefined) {
  if (!by) return '—'
  if (by.kind === 'owner') return '你 · 界面'
  if (by.kind === 'system') return '系统'
  return `${by.client ?? 'Agent'} · ${by.via === 'mcp' ? 'MCP' : by.via ?? 'MCP'}`
}

export function valueLabel(key: string, value: unknown) {
  if (value === null || value === undefined || value === '') return '不限制'
  if (Array.isArray(value)) return value.length ? value.map((board) => ({ st: 'ST', star: '科创板', chinext: '创业板', bse: '北交所' } as Record<string, string>)[board] ?? board).join('、') : '不限制'
  if (typeof value === 'boolean') return value ? '是' : '否'
  if (/Pct$/.test(key) || key === 'maxChangePct') return `${value}%`
  if (key === 'cooldownDays') return `${value} 天`
  if (key === 'prompt' || key === 'instruction') return String(value).length > 40 ? `${String(value).slice(0, 40)}…` : String(value)
  return String(value)
}
