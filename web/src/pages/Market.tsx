import { useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Maximize2, Plus, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { Page, PageHeader } from '@/components/Shell'
import { PriceChart } from '@/components/PriceChart'
import { EvidenceList } from '@/components/Evidence'
import { Button, Card, CardTitle, Dialog, Dot, Empty, ErrorNote, Field, Input, Pill, Segmented, Signed, Spinner, Tabs, Textarea, cn } from '@/components/ui'
import { get, post } from '@/lib/api'
import { dateTime, isNumber, num } from '@/lib/format'
import { collectEvidence, crossStatus, marketIndices, nameOf, quoteStatus, type Item, type MarketReport } from '@/lib/market'
import { embeddedReport } from '@/lib/prefs'

const QUOTE: Record<string, [string, 'ok' | 'warn' | 'bad' | 'muted']> = { fresh: ['实时', 'ok'], closed: ['收盘价', 'muted'], stale: ['过期', 'warn'], error: ['取不到', 'bad'], unverified: ['未核验', 'warn'] }
const CROSS: Record<string, [string, 'ok' | 'warn' | 'bad' | 'muted']> = { aligned: ['双源一致', 'ok'], conflict: ['双源冲突', 'bad'], single: ['单一来源', 'muted'], unverified: ['未交叉核验', 'warn'] }

export const useMarketReport = () => {
  const initial = embeddedReport<MarketReport>()
  return useQuery({ queryKey: ['latest'], queryFn: ({ signal }) => get<MarketReport>('/api/latest', signal).catch(() => initial ?? { items: [], empty: true }), initialData: initial?.items ? initial : undefined, staleTime: 60_000 })
}

function Status({ item, cross }: { item: Item; cross?: boolean }) {
  const [label, tone] = cross ? CROSS[crossStatus(item)] : QUOTE[quoteStatus(item)] ?? QUOTE.unverified
  return <span className="inline-flex items-center gap-1 text-xs text-ink-2"><Dot tone={tone} />{label}</span>
}

export function MarketPage() {
  const report = useMarketReport()
  const client = useQueryClient()
  const [selected, setSelected] = useState<string | null>(null)
  const [timeframe, setTimeframe] = useState<'daily' | 'intraday'>('daily')
  const [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState(false)
  const items = report.data?.items ?? []
  const item = items.find((entry) => entry.symbol === selected) ?? items[0]
  const refresh = async () => {
    setBusy(true)
    try {
      const response = await post<MarketReport & { report?: MarketReport }>('/api/refresh', { phase: timeframe === 'intraday' ? 'intraday' : 'research' })
      const next = response.items ? response : response.report?.items ? response.report : await get<MarketReport>('/api/latest')
      client.setQueryData(['latest'], next)
      toast.success('行情已更新')
    } catch (error) { toast.error((error as Error).message) } finally { setBusy(false) }
  }
  return (
    <Page>
      <PageHeader eyebrow="真实公开行情 · 可能延迟" title="市场" description={`自选 ${items.length} 只 · 报告 ${dateTime(report.data?.generatedAt)}${report.data?.demo ? ' · 演示数据' : ''}`}
        actions={<><Button onClick={() => setEditing(true)}><Plus className="size-4" />管理自选</Button><Button variant="primary" loading={busy} onClick={refresh}><RefreshCw className="size-4" />更新行情</Button></>} />
      <ErrorNote error={report.error} />
      <Indices report={report.data} />
      {report.isLoading ? <Spinner /> : !items.length ? <Empty title="自选是空的" action={<Button variant="primary" onClick={() => setEditing(true)}>添加自选</Button>}>添加股票后，行情、日线与分时、技术指标、数据核验和来源证据会显示在这里。交易员用 arena_set_watchlist 设的股票池也会同步过来。</Empty> : (
        <div className="flex flex-wrap items-start gap-4">
          <Watchlist items={items} selected={item?.symbol} onSelect={setSelected} />
          {item && <StockDetail item={item} report={report.data!} timeframe={timeframe} setTimeframe={setTimeframe} />}
        </div>
      )}
      <WatchlistDialog open={editing} onOpenChange={setEditing} />
    </Page>
  )
}

function Indices({ report }: { report: MarketReport | undefined }) {
  const indices = report ? marketIndices(report).slice(0, 3) : []
  if (!indices.length) return null
  return (
    <div className="grid grid-cols-3 gap-4 max-md:grid-cols-1">
      {indices.map((index: Item, position: number) => (
        <Card key={index.symbol || position} className="p-4">
          <div className="flex items-center gap-2 text-xs text-ink-3"><Pill>{index.market === 'A' ? 'CN' : index.market}</Pill>{nameOf(index)}</div>
          <div className="mt-1 flex items-baseline gap-3"><span className="font-mono text-[22px] font-medium">{num(index.price)}</span><Signed value={index.changePct} /></div>
          <div className="mt-1 flex justify-between font-mono text-xs text-ink-3"><span>{index.symbol}</span><span>{dateTime(index.asOf)}</span></div>
        </Card>
      ))}
    </div>
  )
}

function Watchlist({ items, selected, onSelect }: { items: Item[]; selected?: string; onSelect: (symbol: string) => void }) {
  const [query, setQuery] = useState('')
  const [market, setMarket] = useState<'all' | 'A' | 'HK' | 'US'>('all')
  const [sort, setSort] = useState<'default' | 'gainers' | 'losers'>('default')
  const shown = useMemo(() => {
    const rows = items.filter((item) => (market === 'all' || item.market === market) && `${item.symbol} ${nameOf(item)}`.toLowerCase().includes(query.toLowerCase()))
    if (sort !== 'default') rows.sort((a, b) => (!isNumber(a.changePct) ? 1 : !isNumber(b.changePct) ? -1 : sort === 'gainers' ? b.changePct - a.changePct : a.changePct - b.changePct))
    return rows
  }, [items, market, query, sort])
  const valid = items.filter((item) => !item.error && isNumber(item.changePct))
  const up = valid.filter((item) => item.changePct > 0).length, down = valid.filter((item) => item.changePct < 0).length
  return (
    <Card className="flex min-w-0 max-w-[380px] flex-[1_1_300px] flex-col gap-3 p-4">
      <CardTitle extra={<span className="font-mono text-xs text-ink-3">{items.length}</span>}>自选</CardTitle>
      <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索代码或名称" aria-label="搜索自选" />
      <div className="flex flex-wrap gap-2">
        <Segmented size="sm" label="市场" value={market} onChange={setMarket} options={[['all', '全部'], ['A', 'A'], ['HK', '港'], ['US', '美']]} />
        <Segmented size="sm" label="排序" value={sort} onChange={setSort} options={[['default', '默认'], ['gainers', '涨幅'], ['losers', '跌幅']]} />
      </div>
      <ul className="m-0 flex max-h-[560px] flex-col overflow-y-auto p-0 scroll-thin">
        {shown.map((item) => (
          <li key={item.symbol} className="list-none">
            <button type="button" aria-pressed={selected === item.symbol} onClick={() => onSelect(item.symbol)} className={cn('flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left', selected === item.symbol ? 'bg-accent-soft' : 'hover:bg-surface-2')}>
              <span className="min-w-0 flex-1"><span className="block truncate font-semibold">{nameOf(item)}</span><span className="font-mono text-xs text-ink-3">{item.symbol}{item.position ? ' · 持仓' : ''}</span></span>
              <span className="text-right"><span className="block font-mono">{item.error ? '—' : num(item.price)}</span><Signed value={item.changePct} className="text-xs" /></span>
            </button>
          </li>
        ))}
      </ul>
      {valid.length > 0 && <div className="flex flex-col gap-1 border-t border-line pt-2.5 text-xs text-ink-3"><span>上涨 {up} · 下跌 {down} · 平 {valid.length - up - down}</span><div aria-hidden className="flex h-1.5 overflow-hidden rounded-full bg-sunken"><span className="bg-up" style={{ width: `${(up / valid.length) * 100}%` }} /><span className="bg-down" style={{ width: `${(down / valid.length) * 100}%` }} /></div></div>}
    </Card>
  )
}

function StockDetail({ item, report, timeframe, setTimeframe }: { item: Item; report: MarketReport; timeframe: 'daily' | 'intraday'; setTimeframe: (value: 'daily' | 'intraday') => void }) {
  const [type, setType] = useState<'candles' | 'line'>('candles')
  const [range, setRange] = useState('90')
  const [averages, setAverages] = useState(true)
  const [tab, setTab] = useState<'indicators' | 'quality' | 'evidence'>('indicators')
  const [expanded, setExpanded] = useState(false)
  const ind = item.indicators || {}
  const evidence = collectEvidence(report, item.symbol)
  const usable = item.signalEligible === true && crossStatus(item) !== 'conflict' && !['stale', 'error', 'unverified'].includes(quoteStatus(item, { demo: report.demo }))
  const chart = (height: number) => <PriceChart item={item} timeframe={timeframe} type={type} range={range} averages={averages} height={height} />
  return (
    <Card className="flex min-w-0 flex-[999_1_560px] flex-col gap-4 p-5">
      <div className="flex flex-wrap items-start gap-4">
        <div className="min-w-0 flex-1">
          <h2 className="m-0 text-xl font-bold">{nameOf(item)}</h2>
          <div className="text-xs text-ink-3">{item.symbol} · {item.exchange || item.market}{item.sectorZh || item.sector ? ` · ${item.sectorZh || item.sector}` : ''}</div>
        </div>
        <div className="text-right"><div className="font-mono text-[26px] font-medium">{num(item.price)} <span className="text-xs text-ink-3">{item.currency}</span></div><Signed value={item.changePct} /></div>
      </div>
      <div className="flex flex-wrap items-center gap-3"><Status item={item} /><Status item={item} cross /><span className="text-xs text-ink-3">报价 {dateTime(item.asOf)}</span></div>
      <div className="flex flex-wrap items-center gap-2">
        <Segmented size="sm" label="周期" value={timeframe} onChange={setTimeframe} options={[['daily', '日线'], ['intraday', '分时']]} />
        <Segmented size="sm" label="范围" value={range} onChange={setRange} options={[['30', '30'], ['90', '90'], ['180', '180'], ['all', '全部']]} />
        <Segmented size="sm" label="样式" value={type} onChange={setType} options={[['candles', 'K 线'], ['line', '折线']]} />
        <label className="flex items-center gap-1.5 text-xs text-ink-2"><input type="checkbox" checked={averages} onChange={(event) => setAverages(event.target.checked)} className="accent-[var(--c-accent)]" />均线</label>
        <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setExpanded(true)} aria-label="放大图表"><Maximize2 className="size-4" /></Button>
      </div>
      {chart(320)}
      <div className="border-b border-line"><Tabs value={tab} onChange={setTab} items={[{ id: 'indicators', label: '技术指标' }, { id: 'quality', label: '数据核验' }, { id: 'evidence', label: '相关证据', count: evidence.length }]} /></div>
      {tab === 'indicators' && (
        <div className="grid grid-cols-4 gap-3 max-md:grid-cols-2">
          {[['MA20', ind.sma20, item.currency], ['MA60', ind.sma60, item.currency], ['RSI (14)', ind.rsi14, '/ 100'], ['MACD', ind.macd, ''], ['支撑 · 20D', ind.support20d, item.currency], ['阻力 · 20D', ind.resistance20d, item.currency], ['年化波动率', ind.annualizedVolatilityPct, '%'], ['最大回撤 · 60D', ind.maxDrawdown60dPct, '%']].map(([label, value, unit]) => (
            <div key={label as string} className="rounded-[10px] bg-surface-2 p-3"><div className="text-xs text-ink-3">{label}</div><div className="font-mono text-[15px]">{num(value)} <small className="text-ink-3">{unit}</small></div></div>
          ))}
          <div className="col-span-full text-xs text-ink-3">以上为日线指标，只用已收盘的交易日 · 样本 {ind.sampleCount ?? '—'} · {dateTime(ind.asOf)}</div>
        </div>
      )}
      {tab === 'quality' && (
        <dl className="m-0 grid grid-cols-2 gap-3 text-[13px] max-md:grid-cols-1">
          {[['报价时间', dateTime(item.asOf)], ['数据来源', item.dataSources?.map((source: Item) => source.provider).join(' + ') || item.provider || item.source || '—'], ['两源价差', `${num(item.crossCheck?.priceDifferencePct ?? item.crossCheck?.spreadPct)}%`], ['两源时间差', `${num(item.crossCheck?.timestampSkewSeconds ?? item.crossCheck?.timeDifferenceSeconds, 0)}s`], ['能不能用来交易', usable ? '符合数据门槛（不等于交易建议）' : '暂停：数据不满足门槛'], ['交易所时区', item.exchangeTimezone || '—']].map(([label, value]) => (
            <div key={label} className="rounded-[10px] bg-surface-2 p-3"><dt className="text-xs text-ink-3">{label}</dt><dd className="m-0 mt-0.5">{value}</dd></div>
          ))}
          {(item.dataQuality?.warnings || []).map((warning: unknown, index: number) => <p key={index} className="col-span-full m-0 text-xs text-warn-ink">{typeof warning === 'string' ? warning : JSON.stringify(warning)}</p>)}
        </dl>
      )}
      {tab === 'evidence' && <EvidenceList rows={evidence} limit={8} />}
      <Dialog open={expanded} onOpenChange={setExpanded} title={`${nameOf(item)} · ${item.symbol}`} description="历史价格与成交量，不是价格预测" width={1200}>{expanded && chart(520)}</Dialog>
    </Card>
  )
}

function WatchlistDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (value: boolean) => void }) {
  const client = useQueryClient()
  const prefsQuery = useQuery({ queryKey: ['preferences'], enabled: open, queryFn: ({ signal }) => get<{ preferences?: { watchlist: string[] }; watchlist?: string[] }>('/api/preferences', signal) })
  const current = (prefsQuery.data?.preferences ?? prefsQuery.data)?.watchlist ?? []
  const [text, setText] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const value = text ?? current.join(', ')
  const save = async () => {
    const watchlist = [...new Set(value.split(/[,，;；\s]+/).map((entry) => entry.trim()).filter(Boolean))]
    if (watchlist.length > 50) { toast.error('最多 50 只'); return }
    setSaving(true)
    try { await post('/api/preferences', { watchlist }); client.invalidateQueries({ queryKey: ['preferences'] }); toast.success('自选已保存，点「更新行情」载入'); setText(null); onOpenChange(false) }
    catch (error) { toast.error((error as Error).message) } finally { setSaving(false) }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="管理自选" description="用逗号、空格或换行分隔。例如：600519、0700.HK、AAPL。交易员设股票池时也会同步到这里。">
      {prefsQuery.isLoading ? <Spinner /> : (
        <div className="flex flex-col gap-4">
          <Field label="自选代码"><Textarea rows={5} value={value} onChange={(event) => setText(event.target.value)} /></Field>
          <div className="flex justify-end gap-2"><Button onClick={() => onOpenChange(false)}>取消</Button><Button variant="primary" loading={saving} onClick={save}>保存</Button></div>
        </div>
      )}
    </Dialog>
  )
}
