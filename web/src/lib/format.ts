// Presentation-only formatting. Market facts stay server-owned; missing numbers stay "—".
import { locale, t } from './i18n'

export const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

export function num(value: unknown, digits = 2) {
  return isNumber(value) ? new Intl.NumberFormat(locale(), { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value) : '—'
}

export function int(value: unknown) {
  return isNumber(value) ? new Intl.NumberFormat(locale(), { maximumFractionDigits: 0 }).format(value) : '—'
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
  return new Intl.DateTimeFormat(locale(), { hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value))
}

export function dateTime(value: string | null | undefined) {
  if (!value || !Number.isFinite(Date.parse(value))) return '—'
  return new Intl.DateTimeFormat(locale(), { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value))
}

export function day(value: string | null | undefined) {
  if (!value || !Number.isFinite(Date.parse(value))) return '—'
  return new Intl.DateTimeFormat(locale(), { month: 'numeric', day: 'numeric' }).format(new Date(value))
}

export function ago(value: string | null | undefined, now = Date.now()) {
  if (!value || !Number.isFinite(Date.parse(value))) return '—'
  const minutes = Math.round((now - Date.parse(value)) / 60000)
  if (minutes < 1) return t('刚刚')
  if (minutes < 60) return t('{n} 分钟前', { n: minutes })
  if (minutes < 1440) return t('{n} 小时前', { n: Math.round(minutes / 60) })
  return t('{n} 天前', { n: Math.round(minutes / 1440) })
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

export const MARKET_NAME: Record<string, string> = { A: t('A 股'), HK: t('港股'), US: t('美股') }
export const BENCHMARK_NAME: Record<string, string> = { A: t('沪深300'), HK: t('恒指'), US: t('标普500') }

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

export const AGENT_NAME: Record<string, string> = { claude: 'Claude Code', codex: 'Codex', kimi: 'Kimi Code', workbuddy: 'WorkBuddy', gemini: 'Gemini CLI', opencode: 'OpenCode', acp: 'ACP', command: t('命令行'), strategy: t('量化策略'), other: 'Agent' }

export const RUN_STATUS: Record<string, string> = { ok: t('完成'), 'no-round': t('没有记录这一轮'), failed: t('失败'), timeout: t('超时'), skipped: t('跳过'), running: t('运行中') }
export const FAILURE_KIND: Record<string, string> = { quota: t('额度用尽'), auth: t('没有登录'), config: t('配置错误'), missing: t('没装这个命令'), timeout: t('超时'), other: t('出错') }
export const BOARD_NAME: Record<string, string> = { st: 'ST', star: t('科创板'), chinext: t('创业板'), bse: t('北交所') }

export const CHANGE_KEY: Record<string, string> = {
  minCashPct: t('保留现金'), maxPositions: t('最多持有几只'), maxPositionPct: t('单只最大仓位'), maxExposurePct: t('总仓位上限'), maxIndustryPct: t('单行业上限'), maxNewPerDay: t('每天最多新开几只'), maxOrdersPerDay: t('每天最多几笔买单'),
  maxRiskPerTradePct: t('单笔最大风险'), cooldownDays: t('卖出后冷却'), excludeBoards: t('禁止范围'), minPrice: t('最低股价'), maxChangePct: t('不追涨'), maxDrawdownPct: t('回撤熔断'),
  prompt: t('前置提示词'), reviewMinutes: t('复查间隔'), strategyMinutes: t('策略执行频率'), instruction: t('指令'), skills: 'Skill', autonomy: t('自主级别'), rule: t('长期规则'),
}

export function changeLabel(key: string) {
  if (key.startsWith('lock:')) return t('锁定「{name}」', { name: CHANGE_KEY[key.slice(5)] ?? key.slice(5) })
  if (key.startsWith('fees.')) return t('{market} 费率 {field}', { market: key.split('.')[1], field: key.split('.')[2] ?? '' })
  if (key.startsWith('prompt.')) return t('{scope} 前置提示词', { scope: key.split('.')[1] === 'global' ? t('全局') : MARKET_NAME[key.split('.')[1]] ?? key })
  if (key.startsWith('skill:')) return t('Skill 定制「{id}」', { id: key.slice(6) })
  return CHANGE_KEY[key] ?? key
}

export function changedByLabel(by: { kind: string; via?: string; client?: string } | undefined) {
  if (!by) return '—'
  if (by.kind === 'owner') return t('你 · 界面')
  if (by.kind === 'system') return t('系统')
  return `${by.client ?? 'Agent'} · ${by.via === 'mcp' ? 'MCP' : by.via ?? 'MCP'}`
}

export function valueLabel(key: string, value: unknown) {
  if (value === null || value === undefined || value === '') return t('不限制')
  if (Array.isArray(value)) return value.length ? value.map((board) => BOARD_NAME[board] ?? board).join(t('、')) : t('不限制')
  if (typeof value === 'boolean') return value ? t('是') : t('否')
  if (key === 'autonomy' && typeof value === 'object') return AUTONOMY_NAME[(value as { level: string }).level] ?? '—'
  if (/Pct$/.test(key) || key === 'maxChangePct') return `${value}%`
  if (key === 'cooldownDays') return t('{n} 天', { n: String(value) })
  if (key === 'prompt' || key === 'instruction' || key === 'rule') return String(value).length > 40 ? `${String(value).slice(0, 40)}…` : String(value)
  return String(value)
}

export const AUTONOMY_NAME: Record<string, string> = { full: t('全托管'), confirm: t('关键操作确认'), suggest: t('只给建议') }
export const SIDE_NAME: Record<string, string> = { BUY: t('买入'), SELL: t('卖出') }
export const TEAM_ROLE: Record<string, string> = { technical: t('技术分析师'), news: t('新闻与公告分析师'), fundamental: t('基本面分析师'), market: t('市场情绪分析师'), risk: t('风控'), bull: t('多头研究员'), bear: t('空头研究员') }

/** 亿 / 万 for Chinese amounts, B / M in English. */
export function bigAmount(value: unknown, currency = 'CNY') {
  if (!isNumber(value)) return '—'
  const sign = value < 0 ? '−' : ''
  const abs = Math.abs(value)
  const unit = CURRENCY[currency] ?? ''
  if (locale() === 'en-US') return abs >= 1e9 ? `${sign}${unit}${(abs / 1e9).toFixed(2)}B` : abs >= 1e6 ? `${sign}${unit}${(abs / 1e6).toFixed(1)}M` : `${sign}${unit}${num(abs, 0)}`
  return abs >= 1e8 ? `${sign}${(abs / 1e8).toFixed(abs >= 1e11 ? 0 : 2)} 亿` : abs >= 1e4 ? `${sign}${(abs / 1e4).toFixed(0)} 万` : `${sign}${num(abs, 0)}`
}
