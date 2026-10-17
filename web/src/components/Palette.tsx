import { useEffect, useMemo, useRef, useState } from 'react'
import * as RD from '@radix-ui/react-dialog'
import { useNavigate } from '@tanstack/react-router'
import { Search } from 'lucide-react'
import { useAccounts } from '@/lib/queries'
import { agentKind, MARKET_NAME } from '@/lib/format'
import { t } from '@/lib/i18n'
import { AgentMark, cn } from './ui'

type Item = { id: string; label: string; hint?: string; keywords: string; go: () => void; kind: string }

const PAGES: Array<[string, string, string]> = [
  ['/', t('工作台'), 'home gzt 工作台'], ['/traders', t('交易员'), 'traders jyy 交易员'], ['/arena', t('竞技场'), 'arena leaderboard jjc 排行 竞技场'], ['/radar', t('市场雷达'), 'radar 雷达 涨停 龙虎榜 情绪 融资 sentiment scld'],
  ['/market', t('行情'), 'market quotes 行情 自选 sc hq'], ['/research', t('研究'), 'research evidence journal 证据 决策 研究任务 投资人评审 yj'], ['/reports', t('报告'), 'reports digest 日报 bg 报告'],
  ['/strategies', t('策略库'), 'strategy code clk 策略'], ['/skills', t('Skill 库'), 'skills library 导入 import'], ['/schedule', t('定时任务'), 'schedule jobs 调度 dsrw'], ['/settings', t('设置'), 'settings env 环境 agent 费率 language 语言 sz'],
]

export function Palette() {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)
  const navigate = useNavigate()
  const { accounts } = useAccounts()
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test((event.target as HTMLElement)?.tagName) || (event.target as HTMLElement)?.isContentEditable
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); setOpen((value) => !value) }
      else if (event.key === '/' && !typing) { event.preventDefault(); setOpen(true) }
    }
    const onOpen = () => setOpen(true)
    window.addEventListener('keydown', onKey)
    window.addEventListener('open-palette', onOpen)
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('open-palette', onOpen) }
  }, [])

  const items = useMemo<Item[]>(() => [
    ...PAGES.map(([to, label, keywords]) => ({ id: to, label, keywords, kind: 'page', go: () => navigate({ to }) })),
    ...accounts.map((account) => ({ id: account.id, label: account.name, hint: `${MARKET_NAME[account.market]} · ${account.model}`, keywords: `${account.name} ${account.model} ${account.agent.label ?? ''} ${account.id}`, kind: agentKind(account), go: () => navigate({ to: '/traders/$id', params: { id: account.id }, search: { tab: undefined } }) })),
    { id: 'new-trader', label: t('新建交易员'), keywords: 'new trader create xjjyy 新建交易员', kind: 'action', go: () => { navigate({ to: '/traders' }); setTimeout(() => window.dispatchEvent(new CustomEvent('new-trader')), 50) } },
    { id: 'new-research', label: t('新建研究任务'), keywords: 'research task deep dive investor panel 研究任务 投资人评审 xjyj', kind: 'action', go: () => navigate({ to: '/research', search: { new: '1', task: undefined } }) },
    { id: 'env', label: t('环境检查'), keywords: 'env check hjjc 环境检查', kind: 'action', go: () => navigate({ to: '/settings', search: { section: 'env' } }) },
    { id: 'fees', label: t('费率设置'), keywords: 'fees commission fl 费率', kind: 'action', go: () => navigate({ to: '/settings', search: { section: 'fees' } }) },
    { id: 'prompts', label: t('全局前置提示词'), keywords: 'prompt qztsc 提示词', kind: 'action', go: () => navigate({ to: '/settings', search: { section: 'prompts' } }) },
  ], [accounts, navigate])

  const needle = query.trim().toLowerCase()
  const shown = items.filter((item) => !needle || `${item.label} ${item.keywords} ${item.hint ?? ''}`.toLowerCase().includes(needle)).slice(0, 12)
  useEffect(() => setCursor(0), [query, open])

  const choose = (item: Item | undefined) => { if (!item) return; setOpen(false); setQuery(''); item.go() }

  return (
    <RD.Root open={open} onOpenChange={setOpen}>
      <RD.Portal>
        <RD.Overlay className="fixed inset-0 z-40 bg-black/25" />
        <RD.Content onOpenAutoFocus={(event) => { event.preventDefault(); input.current?.focus() }} className="fixed left-1/2 top-[14vh] z-50 w-[560px] max-w-[calc(100vw-32px)] -translate-x-1/2 overflow-hidden rounded-2xl border border-line bg-surface shadow-2xl">
          <RD.Title className="sr-only">{t('搜索')}</RD.Title>
          <RD.Description className="sr-only">{t('搜索页面、交易员和操作')}</RD.Description>
          <label className="flex items-center gap-2 border-b border-line px-4">
            <Search className="size-4 text-ink-3" aria-hidden />
            <input ref={input} value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('搜索页面、交易员、操作…')} aria-label={t('搜索')}
              onKeyDown={(event) => {
                if (event.key === 'ArrowDown') { event.preventDefault(); setCursor((value) => Math.min(shown.length - 1, value + 1)) }
                if (event.key === 'ArrowUp') { event.preventDefault(); setCursor((value) => Math.max(0, value - 1)) }
                if (event.key === 'Enter') { event.preventDefault(); choose(shown[cursor]) }
              }}
              className="h-12 flex-1 bg-transparent text-[15px] outline-none placeholder:text-ink-3" />
          </label>
          <ul className="max-h-[50vh] overflow-auto p-2 scroll-thin" role="listbox" aria-label={t('结果')}>
            {shown.map((item, index) => (
              <li key={item.id} role="option" aria-selected={index === cursor}>
                <button type="button" onMouseEnter={() => setCursor(index)} onClick={() => choose(item)} className={cn('flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left', index === cursor && 'bg-accent-soft')}>
                  {item.kind === 'page' || item.kind === 'action' ? <span className="w-[22px] text-center text-xs text-ink-3">{item.kind === 'page' ? t('页') : '→'}</span> : <AgentMark kind={item.kind} />}
                  <span className="flex-1 truncate text-[14px]">{item.label}</span>
                  {item.hint && <span className="truncate font-mono text-xs text-ink-3">{item.hint}</span>}
                </button>
              </li>
            ))}
            {!shown.length && <li className="px-3 py-6 text-center text-[13px] text-ink-3">{t('没有匹配的结果')}</li>}
          </ul>
        </RD.Content>
      </RD.Portal>
    </RD.Root>
  )
}
