import { useEffect, useState, type ReactNode } from 'react'
import { Link, useRouterState } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { BookOpen, Bot, CandlestickChart, Clock, Code2, FileText, LayoutDashboard, Radar, Search, SlidersHorizontal, Trophy, Blocks } from 'lucide-react'
import { get } from '@/lib/api'
import { useAccounts, useEnv, useLibrary, usePools } from '@/lib/queries'
import { AGENT_NAME, MARKET_NAME } from '@/lib/format'
import { isEnglish, locale, t } from '@/lib/i18n'
import logo from '@/assets/logo.png'
import { AgentMark, Dot, cn } from './ui'

const isMac = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform)
// Opened inside the Tauri desktop app (desktop/): the window has no native title bar there.
const inDesktopApp = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

type MarketState = Record<string, { status: string; date: string; minute: number; nextOpenAt: string | null }>
export const useMarkets = () => useQuery({ queryKey: ['markets'], queryFn: ({ signal }) => get<MarketState>('/api/markets', signal), refetchInterval: 60_000 })

const STATUS_TEXT: Record<string, string> = { open: t('交易中'), break: t('午休'), premarket: t('未开盘'), postmarket: t('已收盘'), closed: t('休市') }
const hhmm = (minute: number) => `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`
function nextOpenText(at: string | null, market: string) {
  if (!at) return ''
  const zone = { A: 'Asia/Shanghai', HK: 'Asia/Hong_Kong', US: 'America/New_York' }[market]
  const local = new Intl.DateTimeFormat(locale(), { timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(at)).replace(',', '')
  return zone === 'Asia/Shanghai' ? local : t('{time}（北京时间）', { time: local })
}

export function TitleBar() {
  const { data: health, isError } = useQuery({ queryKey: ['health'], queryFn: ({ signal }) => get<{ ok: boolean; version: string }>('/health', signal), refetchInterval: 15_000 })
  const { data: markets } = useMarkets()
  // In the desktop app this header drags the window and leaves room for the window buttons.
  return (
    <header data-tauri-drag-region className={cn('flex h-10 shrink-0 select-none items-center gap-3 border-b border-line bg-surface px-4', inDesktopApp && 'pl-20')}>
      <div data-tauri-drag-region className="flex-1 truncate text-center text-[13px] font-medium text-ink-2">{t('HRouter 股票工作台')}</div>
      {isError ? (
        <span className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border border-bad-line bg-bad-soft px-2 py-px text-xs text-bad"><Dot tone="bad" />{t('本机服务未连接')}</span>
      ) : health ? (
        <span className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border border-ok-line bg-ok-soft px-2 py-px text-xs text-ok">
          <Dot tone="ok" />{t('本机')} · {markets?.A?.status === 'open' ? t('A 股交易中 {time}', { time: hhmm(markets.A.minute) }) : <span className="max-sm:hidden">{t('服务运行中 · {version}', { version: health.version })}</span>}
        </span>
      ) : null}
    </header>
  )
}

type NavItem = { to: string; label: string; icon: typeof LayoutDashboard; badge?: ReactNode; dot?: 'warn' | 'bad' }

function useNav(): NavItem[] {
  const { accounts } = useAccounts()
  const library = useLibrary()
  const env = useEnv()
  const pools = usePools()
  const attention = (env.data?.summary.action ?? 0) + (pools.data?.pools.filter((pool) => pool.paused).length ?? 0)
  return [
    { to: '/', label: t('工作台'), icon: LayoutDashboard },
    { to: '/traders', label: t('交易员'), icon: Bot, badge: accounts.length || undefined },
    { to: '/arena', label: t('竞技场'), icon: Trophy },
    { to: '/radar', label: t('市场雷达'), icon: Radar },
    { to: '/market', label: t('行情'), icon: CandlestickChart },
    { to: '/research', label: t('研究'), icon: BookOpen },
    { to: '/reports', label: t('报告'), icon: FileText },
    { to: '/strategies', label: t('策略库'), icon: Code2 },
    { to: '/skills', label: t('Skill 库'), icon: Blocks, badge: library.data?.skills.length },
    { to: '/schedule', label: t('定时任务'), icon: Clock },
    { to: '/settings', label: t('设置'), icon: SlidersHorizontal, dot: attention ? 'warn' : undefined },
  ]
}

const active = (path: string, to: string) => (to === '/' ? path === '/' : path.startsWith(to))

function MarketClock() {
  const { data } = useMarkets()
  return (
    <div className="flex flex-col gap-1.5 rounded-[10px] border border-line bg-surface-2 px-3 py-2.5 text-xs">
      {(['A', 'HK', 'US'] as const).map((market) => {
        const session = data?.[market]
        const open = session?.status === 'open'
        return (
          <div key={market} className="flex items-center gap-2" title={session ? STATUS_TEXT[session.status] ?? session.status : undefined}>
            <Dot tone={open ? 'ok' : session?.status === 'break' ? 'warn' : 'muted'} />
            <span className={cn('shrink-0 text-[13px] font-semibold', isEnglish() ? 'w-7' : 'w-9')}>{isEnglish() ? { A: 'CN', HK: 'HK', US: 'US' }[market] : MARKET_NAME[market]}</span>
            {/* English status words don't fit next to the next-open time; the dot and tooltip carry it. */}
            <span className={cn('min-w-0 flex-1 truncate', open ? 'text-ok' : 'text-ink-3')}>{session ? (open || !isEnglish() ? STATUS_TEXT[session.status] ?? session.status : '') : '—'}</span>
            {session && <span className="font-mono text-ink-3">{open ? hhmm(session.minute) : nextOpenText(session.nextOpenAt, 'A')}</span>}
          </div>
        )
      })}
    </div>
  )
}

function AgentStatus() {
  const env = useEnv()
  const agents = env.data?.agents.filter((agent) => agent.installed || agent.kind !== 'acp') ?? []
  return (
    <div className="mt-auto flex flex-col gap-2.5 rounded-xl border border-line bg-surface-2 p-3">
      <div className="text-xs font-semibold text-ink-2">{t('Agent 与额度')}</div>
      {agents.length ? agents.map((agent) => (
        <Link key={agent.id} to="/settings" search={{ section: 'agents' }} className="flex items-center gap-2 text-[13px] text-ink">
          <AgentMark kind={agent.id} />
          <span className="flex-1 truncate">{AGENT_NAME[agent.id] ?? agent.name}</span>
          {agent.status === 'quota' && <span className="text-[11px] text-warn-ink">{t('额度用尽')}</span>}
          {agent.status === 'auth' && <span className="text-[11px] text-bad">{t('未登录')}</span>}
          <Dot tone={agent.status === 'ok' ? 'ok' : agent.status === 'missing' ? 'muted' : agent.status === 'quota' ? 'warn' : 'bad'} label={agent.detail} />
        </Link>
      )) : <div className="text-xs text-ink-3">{t('检查中…')}</div>}
      <div className="border-t border-line pt-2 text-xs text-ink-3">{t('模型默认用各 Agent 的最新版，推理强度默认高')}</div>
    </div>
  )
}

export function openPalette() { window.dispatchEvent(new CustomEvent('open-palette')) }

function Sidebar() {
  const path = useRouterState({ select: (state) => state.location.pathname })
  const nav = useNav()
  return (
    <nav aria-label={t('主导航')} className="flex w-[232px] shrink-0 flex-col gap-4 overflow-y-auto border-r border-line bg-surface px-3 py-4 scroll-thin">
      <Link to="/" className="flex items-center gap-2.5 px-2 py-1 text-ink">
        <img src={logo} alt="" aria-hidden className="size-[34px] rounded-[9px]" />
        <span className="flex flex-col leading-tight"><span className="text-[15px] font-bold">HRouter</span><span className="text-xs text-ink-3">{t('股票工作台')}</span></span>
      </Link>
      <button type="button" onClick={openPalette} className="flex h-9 items-center gap-2 rounded-[9px] border border-line bg-surface-2 px-2.5 text-[13px] text-ink-3 hover:text-ink-2">
        <Search className="size-4" aria-hidden /><span className="flex-1 text-left">{t('搜索…')}</span><kbd className="rounded border border-line bg-surface px-1 font-mono text-[11px]">{isMac ? '⌘K' : 'Ctrl K'}</kbd>
      </button>
      <MarketClock />
      <div className="flex flex-col gap-0.5">
        {nav.map((item) => {
          const on = active(path, item.to)
          return (
            <Link key={item.to} to={item.to} aria-current={on ? 'page' : undefined}
              className={cn('flex min-h-10 items-center gap-2.5 rounded-lg px-2.5 text-[14px]', on ? 'bg-accent-soft font-semibold text-accent-ink' : 'text-ink hover:bg-surface-2')}>
              <item.icon className="size-[18px]" strokeWidth={1.8} aria-hidden />
              <span className="flex-1">{item.label}</span>
              {item.badge !== undefined && <span className="font-mono text-xs text-ink-3">{item.badge}</span>}
              {item.dot && <Dot tone={item.dot} label={t('有需要处理的项')} />}
            </Link>
          )
        })}
      </div>
      <AgentStatus />
    </nav>
  )
}

function Rail() {
  const path = useRouterState({ select: (state) => state.location.pathname })
  const nav = useNav()
  return (
    <nav aria-label={t('主导航')} className="flex w-16 shrink-0 flex-col items-center gap-1.5 border-r border-line bg-surface py-3.5">
      <Link to="/" aria-label={t('工作台')} className="mb-2.5 flex size-[34px] items-center justify-center"><img src={logo} alt="" aria-hidden className="size-[34px] rounded-[9px]" /></Link>
      {nav.map((item) => {
        const on = active(path, item.to)
        return (
          <Link key={item.to} to={item.to} aria-label={item.label} title={item.label} aria-current={on ? 'page' : undefined}
            className={cn('relative flex size-11 items-center justify-center rounded-[10px]', on ? 'bg-accent-soft text-accent-ink' : 'text-ink-2 hover:bg-surface-2', item.to === '/settings' && 'mt-auto')}>
            <item.icon className="size-5" strokeWidth={1.8} aria-hidden />
            {item.dot && <span className="absolute right-2 top-2"><Dot tone={item.dot} /></span>}
          </Link>
        )
      })}
    </nav>
  )
}

export function AppShell({ children }: { children: ReactNode }) {
  const path = useRouterState({ select: (state) => state.location.pathname })
  const rail = /^\/traders\/acc_/.test(path)
  const [narrow, setNarrow] = useState(() => typeof window !== 'undefined' && window.innerWidth < 900)
  useEffect(() => { const onResize = () => setNarrow(window.innerWidth < 900); window.addEventListener('resize', onResize); return () => window.removeEventListener('resize', onResize) }, [])
  return (
    <div className="flex h-full flex-col">
      <TitleBar />
      <div className="flex min-h-0 flex-1">
        {rail || narrow ? <Rail /> : <Sidebar />}
        <div className="min-w-0 flex-1 overflow-auto scroll-thin">{children}</div>
      </div>
    </div>
  )
}

export function PageHeader({ eyebrow, title, description, actions }: { eyebrow?: ReactNode; title: ReactNode; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end gap-4">
      <div className="min-w-0 flex-[1_1_320px]">
        {eyebrow && <div className="text-xs font-semibold tracking-[0.08em] text-ink-3">{eyebrow}</div>}
        <h1 className="m-0 mt-1 text-[28px] font-bold leading-tight">{title}</h1>
        {description && <p className="m-0 mt-1.5 text-ink-2">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2.5">{actions}</div>}
    </div>
  )
}

export function Page({ children, className }: { children: ReactNode; className?: string }) {
  return <main className={cn('mx-auto flex w-full max-w-[1480px] flex-col gap-6 px-8 pb-10 pt-7 max-sm:px-4', className)}>{children}</main>
}
