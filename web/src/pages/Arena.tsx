import { useMemo, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { TriangleAlert } from 'lucide-react'
import { Page, PageHeader } from '@/components/Shell'
import { AgentMark, Card, CardTitle, Empty, ErrorNote, Segmented, Signed, Spinner } from '@/components/ui'
import type { AccountSummary, Market } from '@/lib/api'
import { AGENT_NAME, agentKind, BENCHMARK_NAME, MARKET_NAME, num } from '@/lib/format'
import { locale, t } from '@/lib/i18n'
import { useAccounts, useLibrary } from '@/lib/queries'

const COLORS = ['#4338CA', '#D97706', '#0E7490', '#C96442', '#7C3AED', '#DB2777', '#059669', '#64748B']

function Curves({ accounts }: { accounts: AccountSummary[] }) {
  const series = accounts.filter((account) => account.curve.length > 1).slice(0, 8)
  if (!series.length) return <Empty title={t('等第一条收益曲线')}>{t('交易员下单、行情同步后，这里会叠加每个交易员开户以来的收益率。')}</Empty>
  const all = series.flatMap((account) => account.curve.map((point) => point.returnPct))
  const min = Math.min(0, ...all), max = Math.max(0, ...all)
  const span = max - min || 1
  const times = series.flatMap((account) => account.curve.map((point) => Date.parse(point.at)))
  const start = Math.min(...times), end = Math.max(...times)
  const x = (at: string) => ((Date.parse(at) - start) / (end - start || 1)) * 1000
  const y = (value: number) => 200 - ((value - min) / span) * 180 - 10
  const step = span > 6 ? 2 : span > 2 ? 1 : 0.5
  const ticks: number[] = []
  for (let tick = Math.ceil(min / step) * step; tick <= max; tick += step) ticks.push(Number(tick.toFixed(2)))
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-3.5">
        {series.map((account, index) => <span key={account.id} className="inline-flex items-center gap-1.5 text-xs"><span className="h-[3px] w-3.5 rounded" style={{ background: COLORS[index] }} />{account.name}</span>)}
      </div>
      <svg viewBox="0 0 1000 210" width="100%" height="220" role="img" aria-label={t('各交易员累计收益率')} preserveAspectRatio="none">
        {ticks.map((tick) => <g key={tick}><line x1="0" x2="1000" y1={y(tick)} y2={y(tick)} stroke={tick === 0 ? 'var(--c-line-strong)' : 'var(--c-line)'} /><text x="4" y={y(tick) - 4} fill="var(--c-ink-3)" fontSize="11" fontFamily="var(--font-mono)">{tick > 0 ? '+' : ''}{tick}%</text></g>)}
        {series.map((account, index) => <polyline key={account.id} fill="none" stroke={COLORS[index]} strokeWidth="2.2" vectorEffect="non-scaling-stroke" points={account.curve.map((point) => `${x(point.at)},${y(point.returnPct)}`).join(' ')} />)}
      </svg>
      <div className="flex justify-between font-mono text-[11px] text-ink-3"><span>{new Date(start).toLocaleDateString(locale())}</span><span>{new Date(end).toLocaleDateString(locale())}</span></div>
    </div>
  )
}

export function ArenaPage() {
  const { data, accounts, isLoading, error } = useAccounts()
  const library = useLibrary()
  const markets = [...new Set(accounts.map((account) => account.market))] as Market[]
  const [market, setMarket] = useState<Market | null>(null)
  const [by, setBy] = useState<'trader' | 'model' | 'agent' | 'template'>('trader')
  const current = market ?? markets[0] ?? 'A'
  const groups = (data?.groups ?? []).filter((group) => group.market === current)
  const grouped = useMemo(() => {
    if (by === 'trader') return []
    const rows = new Map<string, AccountSummary[]>()
    for (const group of groups) for (const account of group.accounts) {
      const key = by === 'model' ? account.model : by === 'agent' ? AGENT_NAME[agentKind(account)] : library.data?.templates.find((entry) => entry.id === account.template)?.name ?? t('没有模板')
      rows.set(key, [...(rows.get(key) ?? []), account])
    }
    return [...rows].map(([key, list]) => ({ key, count: list.length, avg: list.reduce((sum, account) => sum + account.metrics.totalReturnPct, 0) / list.length, best: Math.max(...list.map((account) => account.metrics.totalReturnPct)), dd: list.reduce((sum, account) => sum + account.metrics.maxDrawdownPct, 0) / list.length, trades: list.reduce((sum, account) => sum + account.metrics.trades, 0) })).sort((a, b) => b.avg - a.avg)
  }, [by, groups, library.data])
  const all = groups.flatMap((group) => group.accounts)
  const short = all.some((account) => account.metrics.sampleWarning)
  return (
    <Page>
      <PageHeader eyebrow={t('同市场、同组别才一起排名')} title={t('竞技场')} description={`${MARKET_NAME[current]} ${groups.length > 1 ? t('{n} 个组别', { n: groups.length }) : ''} ${t('{n} 个交易员。', { n: all.length })}`}
        actions={<>
          {markets.length > 1 && <Segmented label={t('市场')} value={current} onChange={setMarket} options={markets.map((key) => [key, MARKET_NAME[key]])} />}
          <Segmented label={t('对比维度')} value={by} onChange={setBy} options={[['trader', t('交易员')], ['model', t('按模型')], ['agent', t('按 Agent')], ['template', t('按流派')]]} />
        </>} />
      <ErrorNote error={error} />
      {short && <div className="flex items-center gap-2.5 rounded-[10px] border border-warn-line bg-warn-soft px-3.5 py-2.5 text-[13px] text-warn-ink"><TriangleAlert className="size-4 shrink-0" />{t('样本还少：交易日或平仓笔数不够，现在的排名主要反映运气。至少看满 20 个交易日再下结论。')}</div>}
      {isLoading ? <Spinner /> : !all.length ? <Empty title={t('还没有交易员')} /> : groups.map((group) => (
        <div key={group.competition} className="flex flex-col gap-4">
          <Card className="p-4"><CardTitle extra={<span className="text-xs text-ink-3">{t('组别 {id}', { id: group.competition })} · {group.currency}</span>}>{t('累计收益')}</CardTitle><div className="mt-3"><Curves accounts={group.accounts} /></div></Card>
          {by === 'trader' ? (
            <Card className="flex flex-col gap-2.5 p-4">
              <CardTitle extra={<span className="text-xs text-ink-3">{t('按累计收益排序')}</span>}>{t('排行榜')}</CardTitle>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[820px] border-collapse text-[13px]">
                  <thead><tr className="text-right text-xs text-ink-3"><th className="py-1.5 text-left font-medium">{t('交易员')}</th><th className="text-left font-medium">{t('流派')}</th><th className="font-medium">{t('累计')}</th><th className="font-medium">{t('今日')}</th><th className="font-medium">{t('超额')}</th><th className="font-medium">{t('最大回撤')}</th><th className="font-medium">{t('胜率')}</th><th className="font-medium">{t('成交 / 拒单')}</th></tr></thead>
                  <tbody>{group.accounts.map((account) => {
                    return (
                      <tr key={account.id} className="border-t border-line text-right">
                        <td className="py-2.5 text-left"><Link to="/traders/$id" params={{ id: account.id }} search={{ tab: undefined }} className="flex items-center gap-2.5 text-ink"><span className="w-4 font-mono text-ink-3">{account.rank}</span><AgentMark kind={agentKind(account)} size={26} /><span className="flex flex-col leading-snug"><span className="font-semibold">{account.name}</span><span className="font-mono text-[11px] text-ink-3">{account.model} · {t('策略')} v{account.strategy.version}</span></span></Link></td>
                        <td className="text-left text-ink-2">{library.data?.templates.find((entry) => entry.id === account.template)?.name ? t(library.data.templates.find((entry) => entry.id === account.template)!.name) : '—'}</td>
                        <td><Signed value={account.metrics.totalReturnPct} /></td>
                        <td><Signed value={account.metrics.todayReturnPct} /></td>
                        <td><Signed value={account.metrics.excessReturnPct} /></td>
                        <td className="font-mono">{num(account.metrics.maxDrawdownPct, 1)}%</td>
                        <td className="font-mono">{account.metrics.winRatePct !== null ? `${num(account.metrics.winRatePct, 0)}%` : '—'}<span className="text-ink-3"> · {account.metrics.closedTrades}</span></td>
                        <td className="font-mono">{account.metrics.trades} / {account.metrics.ordersRejected}</td>
                      </tr>
                    )
                  })}</tbody>
                </table>
              </div>
              <div className="border-t border-line pt-2 text-xs text-ink-3">{t('超额相对{name}。胜率后面是平仓笔数。', { name: BENCHMARK_NAME[group.market] })}</div>
            </Card>
          ) : (
            <Card className="flex flex-col gap-2.5 p-4">
              <CardTitle>{{ model: t('按模型'), agent: t('按 Agent'), template: t('按流派') }[by]}</CardTitle>
              <table className="w-full border-collapse text-[13px]">
                <thead><tr className="text-right text-xs text-ink-3"><th className="py-1.5 text-left font-medium">{t('分组')}</th><th className="font-medium">{t('交易员')}</th><th className="font-medium">{t('平均收益')}</th><th className="font-medium">{t('最好')}</th><th className="font-medium">{t('平均回撤')}</th><th className="font-medium">{t('成交')}</th></tr></thead>
                <tbody>{grouped.map((row) => <tr key={row.key} className="border-t border-line text-right"><td className="py-2 text-left font-semibold">{row.key}</td><td className="font-mono">{row.count}</td><td><Signed value={row.avg} /></td><td><Signed value={row.best} /></td><td className="font-mono">{num(row.dd, 1)}%</td><td className="font-mono">{row.trades}</td></tr>)}</tbody>
              </table>
              <div className="text-xs text-ink-3">{t('平均是简单平均；样本少时差异可能只是运气。')}</div>
            </Card>
          )}
        </div>
      ))}
    </Page>
  )
}
