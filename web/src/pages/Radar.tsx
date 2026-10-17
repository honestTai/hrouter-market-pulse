import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { RefreshCw } from 'lucide-react'
import { get, type Emotion, type Radar } from '@/lib/api'
import { bigAmount, dateTime, num } from '@/lib/format'
import { isEnglish, t } from '@/lib/i18n'
import { useEmotion, useRadar } from '@/lib/queries'
import { Page, PageHeader } from '@/components/Shell'
import { Expandable } from '@/components/Expandable'
import { Button, Card, CardTitle, Dialog, Dot, Empty, ErrorNote, Pill, Signed, Spinner, Stat, cn } from '@/components/ui'

const STAGE_HINT: Record<string, string> = { 回暖: t('回暖'), 转弱: t('转弱'), 震荡: t('震荡') }

// The stage a trader would read from the readings (see the emotion-cycle skill).
function stageOf(emotion: Emotion | undefined, radar: Radar | undefined) {
  const cycle = emotion?.cycle
  const broken = radar?.sentiment.brokenRatePct
  if (!cycle?.current && cycle?.current !== 0) return null
  if (cycle.current <= 0.2 && (broken ?? 0) >= 35) return { name: t('冰点'), tone: 'bad' as const, hint: t('空仓或极轻仓，只记录不接力') }
  if (cycle.trend === '回暖' && (cycle.daysFromTrough ?? 9) <= 3) return { name: t('修复'), tone: 'accent' as const, hint: t('小仓位试新题材的首板、一进二') }
  if (cycle.current >= 0.8) return { name: t('高潮'), tone: 'warn' as const, hint: t('只卖不买新的高位股，兑现为主') }
  if (cycle.trend === '转弱' && cycle.current < 0.6) return { name: t('退潮'), tone: 'bad' as const, hint: t('不接力，持仓按失效规则离场') }
  return { name: t('发酵'), tone: 'ok' as const, hint: t('做主线龙头和前排，可以接力') }
}

export function RadarPage() {
  const radar = useRadar()
  const emotion = useEmotion()
  const data = radar.data
  const stage = stageOf(emotion.data, data)
  const s = data?.sentiment
  const b = data?.breadth
  return (
    <Page>
      <PageHeader eyebrow={t('A 股 · 真实公开数据 · 东方财富')} title={t('市场雷达')}
        description={data ? t('数据日 {date} · 更新于 {time}。交易员用 get_market_radar 读到的是同一份数据。', { date: data.date, time: dateTime(data.generatedAt) }) : t('读取全市场数据…')}
        actions={<Button onClick={() => { radar.refetch(); emotion.refetch() }} loading={radar.isFetching}><RefreshCw className="size-4" />{t('刷新')}</Button>} />
      <ErrorNote error={radar.error} />
      {radar.isLoading ? <Spinner /> : data && <>
        <div className="grid grid-cols-5 gap-4 max-xl:grid-cols-3 max-md:grid-cols-2 max-sm:grid-cols-1">
          <Card className="p-4"><Stat label={t('上涨 / 下跌')} value={b?.advancers !== null && b?.advancers !== undefined ? <><span className="text-up">{b.advancers}</span><span className="text-ink-3"> / </span><span className="text-down">{b.decliners}</span></> : '—'} sub={b?.error ?? `${t('平盘 {n}', { n: b?.unchanged ?? '—' })} · ${t('沪深两市，不含北交所')}`} /></Card>
          <Card className="p-4"><Stat label={t('两市成交额')} value={bigAmount(b?.turnover)} sub={(b?.indices ?? []).slice(0, 2).map((index) => `${t(index.name)} ${index.changePct !== null && index.changePct !== undefined ? `${index.changePct > 0 ? '+' : ''}${index.changePct}%` : '—'}`).join(' · ')} /></Card>
          <Card className="p-4"><Stat label={t('涨停 / 炸板 / 跌停')} value={s?.limitUps !== undefined ? <><span className="text-up">{s.limitUps}</span><span className="text-ink-3"> / </span>{s.broken}<span className="text-ink-3"> / </span><span className="text-down">{s.limitDowns}</span></> : '—'} sub={s?.brokenRatePct !== null && s?.brokenRatePct !== undefined ? t('炸板率 {pct}%', { pct: s.brokenRatePct }) : s?.error ?? '—'} /></Card>
          <Card className="p-4"><Stat label={t('最高连板')} value={s?.highestBoard ? t('{n} 板', { n: s.highestBoard }) : '—'} sub={s?.ladder?.[0]?.stocks.map((stock) => stock.name).join(t('、')) ?? '—'} /></Card>
          <Card className={cn('p-4', stage && { bad: 'border-bad-line', warn: 'border-warn-line', ok: 'border-ok-line', accent: 'border-accent-line' }[stage.tone])}><Stat label={t('情绪阶段')} value={stage ? <span className={{ bad: 'text-bad', warn: 'text-warn-ink', ok: 'text-ok', accent: 'text-accent-ink' }[stage.tone]}>{stage.name}</span> : '—'} sub={stage?.hint ?? (emotion.isLoading ? t('计算中…') : '—')} /></Card>
        </div>

        <div className="grid grid-cols-[minmax(0,3fr)_minmax(0,2fr)] gap-4 max-lg:grid-cols-1">
          <Expandable title={t('情绪周期')}><EmotionCard emotion={emotion.data} loading={emotion.isLoading} error={emotion.error} /></Expandable>
          <Expandable title={t('连板天梯')}><LadderCard radar={data} /></Expandable>
        </div>

        <Expandable title={t('龙虎榜')}><DragonTigerCard radar={data} /></Expandable>

        <div className="grid grid-cols-2 gap-4 max-lg:grid-cols-1">
          <Expandable title={t('板块与概念')}><SectorsCard radar={data} /></Expandable>
          <div className="flex min-w-0 flex-col gap-4">
            <Expandable title={t('融资余额')}><MarginCard radar={data} /></Expandable>
            <Expandable title={t('沪深港通')}><ConnectCard radar={data} /></Expandable>
          </div>
        </div>
      </>}
    </Page>
  )
}

function EmotionCard({ emotion, loading, error }: { emotion: Emotion | undefined; loading: boolean; error: unknown }) {
  const days = emotion?.cycle.days ?? []
  return (
    <Card className="flex flex-col gap-3 p-4">
      <CardTitle extra={emotion?.cycle.trend && <Pill tone={emotion.cycle.trend === '回暖' ? 'ok' : emotion.cycle.trend === '转弱' ? 'bad' : 'neutral'}>{STAGE_HINT[emotion.cycle.trend] ?? emotion.cycle.trend}</Pill>}>{t('情绪周期')}</CardTitle>
      <ErrorNote error={error} />
      {loading ? <Spinner /> : days.length ? <>
        <div className="flex h-36 items-end gap-1.5" role="img" aria-label={t('最近 {n} 个交易日的情绪分', { n: days.length })}>
          {days.map((day) => (
            <div key={day.date} className="group/day flex min-w-0 flex-1 flex-col items-center gap-1" title={t('{date}：涨停 {u}，炸板率 {b}%，最高 {h} 板，情绪分 {s}', { date: day.date, u: day.limitUps, b: day.brokenRatePct ?? '—', h: day.highestBoard ?? '—', s: day.score })}>
              <span className="font-mono text-[10px] text-ink-3 opacity-0 group-hover/day:opacity-100">{num(day.score, 2)}</span>
              <span className={cn('w-full rounded-t-[4px]', day.date === emotion?.cycle.trough?.date ? 'bg-bad' : day.date === days.at(-1)?.date ? 'bg-accent' : 'bg-line-strong')} style={{ height: `${Math.max(4, day.score * 100)}px` }} />
              <span className="font-mono text-[10px] text-ink-3">{day.date.slice(5)}</span>
            </div>
          ))}
        </div>
        <div className="text-xs text-ink-2">
          {emotion?.cycle.trough && t('窗口最低在 {date}（{n} 天前），现在处在窗口的 {pct}% 位置。', { date: emotion.cycle.trough.date, n: emotion.cycle.daysFromTrough ?? '—', pct: emotion.cycle.positionPct ?? '—' })}
          <span className="text-ink-3"> {t('分数只在这个窗口内比较。')}</span>
        </div>
        <div className="grid grid-cols-2 gap-3 border-t border-line pt-3 max-sm:grid-cols-1">
          <div className="flex flex-col gap-1">
            <div className="text-xs font-semibold text-ink-3">{t('晋级率（昨日 → 今日）')}</div>
            {emotion?.promotion.length ? emotion.promotion.map((group) => (
              <div key={group.boards} className="flex items-center gap-2 text-[13px]" title={group.names.join(t('、'))}>
                <span className="w-16 shrink-0">{t('{a} 进 {b}', { a: group.boards, b: group.boards + 1 })}</span>
                <span aria-hidden className="relative h-1.5 flex-1 rounded-full bg-sunken"><span className="absolute inset-y-0 left-0 rounded-full bg-accent" style={{ width: `${group.ratePct}%` }} /></span>
                <span className="w-24 shrink-0 text-right font-mono text-xs">{group.promoted}/{group.candidates} · {group.ratePct}%</span>
              </div>
            )) : <div className="text-xs text-ink-3">—</div>}
          </div>
          <div className="flex flex-col gap-1">
            <div className="text-xs font-semibold text-ink-3">{t('赚钱效应（昨日涨停股今天）')}</div>
            {emotion?.moneyEffect?.avgChangePct !== undefined ? <>
              <div className="text-[13px]">{t('平均')} <Signed value={emotion.moneyEffect.avgChangePct} /> · {t('上涨 {pct}%', { pct: emotion.moneyEffect.upRatioPct ?? '—' })}</div>
              <div className="text-xs text-ink-3">{t('再涨停 {n} 只 · 样本 {a}/{b}', { n: emotion.moneyEffect.relimitUps ?? 0, a: emotion.moneyEffect.samples ?? 0, b: emotion.moneyEffect.of ?? 0 })}{emotion.moneyEffect.partial ? t('（样本不全）') : ''}</div>
            </> : <div className="text-xs text-ink-3">{emotion?.moneyEffect?.note ?? t('只对最新交易日计算')}</div>}
          </div>
        </div>
      </> : <Empty title={t('没有可用的交易日数据')}>{emotion?.cycle.note ?? '—'}</Empty>}
    </Card>
  )
}

function LadderCard({ radar }: { radar: Radar }) {
  const s = radar.sentiment
  return (
    <Card className="flex flex-col gap-3 p-4">
      <CardTitle extra={<span className="text-xs text-ink-3">{s.date}</span>}>{t('连板天梯')}</CardTitle>
      {s.error ? <ErrorNote error={s.error} /> : s.ladder.length ? (
        <div className="flex max-h-[300px] flex-col gap-2 overflow-y-auto scroll-thin">
          {s.ladder.map((step) => (
            <div key={step.boards} className="flex gap-2.5">
              <span className={cn('flex h-6 shrink-0 items-center justify-center whitespace-nowrap rounded-md font-mono text-xs font-semibold', isEnglish() ? 'w-[4.5rem]' : 'w-12', step.boards >= 4 ? 'bg-up text-white' : step.boards >= 2 ? 'bg-bad-soft text-up' : 'bg-sunken text-ink-2')}>{t('{n} 板', { n: step.boards })}</span>
              <div className="flex min-w-0 flex-1 flex-wrap gap-1">
                {(step.boards >= 2 ? step.stocks : step.stocks.slice(0, 12)).map((stock) => <span key={stock.symbol} title={`${stock.symbol} · ${stock.industry ?? ''} · ${t('首封 {time}', { time: stock.firstSealAt ?? '—' })}`} className="rounded-md border border-line px-1.5 py-0.5 text-xs">{stock.name}</span>)}
                {step.boards < 2 && step.stocks.length > 12 && <span className="px-1 py-0.5 text-xs text-ink-3">{t('… 共 {n} 只', { n: step.count })}</span>}
              </div>
            </div>
          ))}
        </div>
      ) : <div className="text-[13px] text-ink-3">{t('今天还没有涨停。')}</div>}
      {s.hotIndustries?.length ? (
        <div className="flex flex-wrap items-center gap-1.5 border-t border-line pt-2.5 text-xs">
          <span className="text-ink-3">{t('涨停集中')}</span>
          {s.hotIndustries.map((entry) => <Pill key={entry.industry} tone="accent">{entry.industry} {entry.limitUps}</Pill>)}
        </div>
      ) : null}
    </Card>
  )
}

function DragonTigerCard({ radar }: { radar: Radar }) {
  const [seats, setSeats] = useState<{ symbol: string; name: string } | null>(null)
  const lhb = radar.dragonTiger
  return (
    <Card className="flex flex-col gap-3 p-4">
      <CardTitle extra={<span className="text-xs text-ink-3">{t('{date} · 共 {n} 条 · 收盘后约 18:00 公布 · 点一行看买卖营业部', { date: lhb.date, n: lhb.total ?? 0 })}</span>}>{t('龙虎榜 · 净买入前列')}</CardTitle>
      {lhb.error ? <ErrorNote error={lhb.error} /> : lhb.rows?.length ? (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] border-collapse text-[13px] [&_td+td]:pl-3 [&_th+th]:pl-3">
            <thead><tr className="text-left text-xs text-ink-3"><th className="py-1.5 font-medium">{t('股票')}</th><th className="text-right font-medium">{t('收盘')}</th><th className="text-right font-medium">{t('涨跌')}</th><th className="text-right font-medium">{t('上榜净买入')}</th><th className="text-right font-medium">{t('买入 / 卖出')}</th><th className="pl-4 font-medium">{t('上榜原因')}</th></tr></thead>
            <tbody>
              {lhb.rows.map((row, index) => (
                <tr key={`${row.symbol}-${index}`} className="cursor-pointer border-t border-line hover:bg-surface-2" onClick={() => setSeats({ symbol: row.symbol, name: row.name })}>
                  <td className="py-1.5"><button type="button" className="text-left" onClick={(event) => { event.stopPropagation(); setSeats({ symbol: row.symbol, name: row.name }) }}><span className="font-semibold">{row.name}</span> <span className="font-mono text-[11px] text-ink-3">{row.symbol}</span></button></td>
                  <td className="text-right font-mono">{num(row.close)}</td>
                  <td className="text-right"><Signed value={row.changePct} /></td>
                  <td className={cn('text-right font-mono', (row.netBuy ?? 0) >= 0 ? 'text-up' : 'text-down')}>{bigAmount(row.netBuy)}</td>
                  <td className="text-right font-mono text-xs text-ink-2">{bigAmount(row.buy)} / {bigAmount(row.sell)}</td>
                  <td className="max-w-[320px] truncate pl-4 text-xs text-ink-2" title={row.reason ?? ''}>{row.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : <div className="text-[13px] text-ink-3">{lhb.note ?? '—'}</div>}
      {seats && <SeatsDialog symbol={seats.symbol} name={seats.name} date={lhb.date} onClose={() => setSeats(null)} />}
    </Card>
  )
}

type Seat = { side: string; seat: string; buy: number | null; sell: number | null; net: number | null; institution: boolean; connect: boolean; rise3dPct: number | null }

function SeatsDialog({ symbol, name, date, onClose }: { symbol: string; name: string; date: string; onClose: () => void }) {
  const seats = useQuery({ queryKey: ['seats', symbol, date], queryFn: ({ signal }) => get<{ buyers: Seat[]; sellers: Seat[]; note: string | null }>(`/api/market-data/dragon-tiger?symbol=${encodeURIComponent(symbol)}&date=${date}`, signal) })
  const table = (rows: Seat[], title: string) => (
    <div className="flex flex-col gap-1.5">
      <div className="text-xs font-semibold text-ink-3">{title}</div>
      {rows.map((row, index) => (
        <div key={index} className="flex flex-wrap items-center gap-2 border-t border-line py-1.5 text-[13px]">
          <span className="min-w-0 flex-1">{row.seat}{row.institution && <Pill tone="accent" className="ml-1">{t('机构')}</Pill>}{row.connect && <Pill className="ml-1">{t('外资')}</Pill>}</span>
          <span className="font-mono text-xs text-ink-2">{t('买 {a} · 卖 {b}', { a: bigAmount(row.buy), b: bigAmount(row.sell) })}</span>
          <span className={cn('w-24 text-right font-mono text-xs', (row.net ?? 0) >= 0 ? 'text-up' : 'text-down')}>{bigAmount(row.net)}</span>
        </div>
      ))}
    </div>
  )
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()} title={t('{name} 龙虎榜营业部', { name })} description={t('{date} · 买卖各前五。游资身份以营业部名称为准，对应关系是公开流传的说法。', { date })} width={720}>
      {seats.isLoading ? <Spinner /> : seats.error ? <ErrorNote error={seats.error} /> : seats.data?.note ? <p className="m-0 text-[13px] text-ink-3">{seats.data.note}</p> : (
        <div className="flex flex-col gap-4">{table(seats.data?.buyers ?? [], t('买入前五'))}{table(seats.data?.sellers ?? [], t('卖出前五'))}</div>
      )}
    </Dialog>
  )
}

function SectorsCard({ radar }: { radar: Radar }) {
  const [view, setView] = useState<'sectors' | 'concepts'>('sectors')
  const list = view === 'sectors' ? radar.sectors : radar.concepts
  return (
    <Card className="flex flex-col gap-3 p-4">
      <CardTitle extra={<span className="ml-auto inline-flex rounded-[9px] bg-sunken p-[3px] text-[13px]">{(['sectors', 'concepts'] as const).map((key) => <button key={key} type="button" aria-pressed={view === key} onClick={() => setView(key)} className={cn('h-7 rounded-[7px] px-3', view === key ? 'bg-surface font-semibold shadow-[0_1px_2px_rgba(17,19,24,0.08)]' : 'text-ink-2')}>{key === 'sectors' ? t('行业') : t('概念')}</button>)}</span>}>{t('涨幅前列')}</CardTitle>
      {list.error ? <ErrorNote error={list.error} /> : (
        <table className="w-full border-collapse text-[13px] [&_td+td]:pl-3 [&_th+th]:pl-3">
          <thead><tr className="text-left text-xs text-ink-3"><th className="py-1.5 font-medium">{t('名称')}</th><th className="text-right font-medium">{t('涨跌')}</th><th className="text-right font-medium">{t('主力净流入')}</th><th className="pl-3 font-medium">{t('领涨')}</th></tr></thead>
          <tbody>
            {(list.rows ?? []).map((row) => (
              <tr key={row.code} className="border-t border-line">
                <td className="py-1.5 font-semibold">{row.name}</td>
                <td className="text-right"><Signed value={row.changePct} /></td>
                <td className={cn('text-right font-mono text-xs', (row.mainNetInflow ?? 0) >= 0 ? 'text-up' : 'text-down')}>{bigAmount(row.mainNetInflow)}</td>
                <td className="truncate pl-3 text-xs text-ink-2">{row.leader?.name ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  )
}

function MarginCard({ radar }: { radar: Radar }) {
  const rows = radar.margin.rows ?? []
  const max = Math.max(...rows.map((row) => row.financingBalance ?? 0), 1)
  const min = Math.min(...rows.map((row) => row.financingBalance ?? max))
  return (
    <Card className="flex flex-col gap-2.5 p-4">
      <CardTitle extra={<span className="text-xs text-ink-3">{t('次日早上公布前一日')}</span>}>{t('融资余额')}</CardTitle>
      {radar.margin.error ? <ErrorNote error={radar.margin.error} /> : rows.length ? <>
        <div className="flex items-baseline gap-2"><span className="font-mono text-[22px] tabular">{bigAmount(rows[0].financingBalance)}</span><span className="text-xs text-ink-3">{rows[0].date}</span><span className={cn('ml-auto font-mono text-[13px]', (rows[0].financingNet ?? 0) >= 0 ? 'text-up' : 'text-down')}>{t('净买 {n}', { n: bigAmount(rows[0].financingNet) })}</span></div>
        <div className="flex h-14 items-end gap-1" role="img" aria-label={t('融资余额走势')}>
          {[...rows].reverse().map((row) => <span key={row.date} title={`${row.date} · ${bigAmount(row.financingBalance)}`} className="flex-1 rounded-t-[3px] bg-accent/70" style={{ height: `${8 + ((row.financingBalance ?? min) - min) / Math.max(1, max - min) * 48}px` }} />)}
        </div>
      </> : <div className="text-[13px] text-ink-3">—</div>}
    </Card>
  )
}

function ConnectCard({ radar }: { radar: Radar }) {
  const rows = radar.connect.rows ?? []
  const latest = rows[0]?.date
  const today = rows.filter((row) => row.date === latest)
  return (
    <Card className="flex flex-col gap-2.5 p-4">
      <CardTitle extra={<span className="text-xs text-ink-3">{latest}</span>}>{t('沪深港通')}</CardTitle>
      {radar.connect.error ? <ErrorNote error={radar.connect.error} /> : (
        <div className="flex flex-col">
          {today.map((row) => (
            <div key={row.channel} className="flex items-center gap-2 border-t border-line py-1.5 text-[13px] first:border-t-0">
              <Dot tone={row.channel.includes('南向') ? 'accent' : 'muted'} />
              <span className="w-20 shrink-0">{t(row.channel)}</span>
              <span className="flex-1 font-mono text-xs text-ink-2">{t('成交 {n}', { n: bigAmount(row.turnover) })}</span>
              <span className={cn('font-mono text-xs', row.netBuy === null ? 'text-ink-3' : row.netBuy >= 0 ? 'text-up' : 'text-down')}>{row.netBuy === null ? t('净买入不公布') : t('净买 {n}', { n: bigAmount(row.netBuy) })}</span>
            </div>
          ))}
          <p className="m-0 mt-1.5 text-[11px] text-ink-3">{t(radar.connect.note)}</p>
        </div>
      )}
    </Card>
  )
}
