import { Fragment, useState } from 'react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { get, qs, type AccountDetail, type Approval, type ChangeRequest, type Order, type PipelineStep, type QuoteSnapshot, type Report, type Trade } from '@/lib/api'
import { changeLabel, changedByLabel, dateTime, money, num, SIDE_NAME, time, valueLabel } from '@/lib/format'
import { locale, t } from '@/lib/i18n'
import { useAction, useReconcile } from '@/lib/queries'
import { CitationList } from '@/components/trader-bits'
import { Expandable } from '@/components/Expandable'
import { Button, Card, CardTitle, Dot, Empty, Input, Pager, Pill, Segmented, Select, Signed, Spinner, cn } from '@/components/ui'

type HistoryKind = 'trades' | 'orders' | 'journal' | 'events' | 'reports'
interface HistoryPage<T> { items: T[]; total: number; offset: number; limit: number; facets: { types: string[]; symbols: string[] }; all: number }

function useHistory<T>(accountId: string, kind: HistoryKind, params: Record<string, string | number | undefined>) {
  return useQuery({ queryKey: ['history', accountId, kind, params], queryFn: ({ signal }) => get<HistoryPage<T>>(`/api/arena/accounts/${accountId}/history${qs({ kind, limit: 20, ...params })}`, signal), placeholderData: keepPreviousData })
}

const SENTIMENT: Record<string, [string, 'ok' | 'bad' | 'neutral' | 'warn']> = { bullish: [t('看多'), 'ok'], bearish: [t('看空'), 'bad'], neutral: [t('中性'), 'neutral'], defensive: [t('防守'), 'warn'] }

export function ReportBody({ report }: { report: Report }) {
  return (
    <div className="flex flex-col gap-3 text-[13px]">
      <p className="m-0 whitespace-pre-wrap">{report.summary}</p>
      {report.marketView && <section><div className="mb-1 text-xs font-semibold text-ink-3">{t('市场判断')}</div><p className="m-0 whitespace-pre-wrap text-ink-2">{report.marketView}</p></section>}
      {report.actions?.length ? <section><div className="mb-1 text-xs font-semibold text-ink-3">{t('操作')}</div><ul className="m-0 flex flex-col gap-1 pl-0">{report.actions.map((action, index) => <li key={index} className="flex list-none gap-2"><span className="w-20 shrink-0 font-mono text-xs">{action.symbol}</span><Pill>{action.action}</Pill><span className="text-ink-2">{action.detail}</span></li>)}</ul></section> : null}
      {report.picks?.length ? <section><div className="mb-1 text-xs font-semibold text-ink-3">{t('看好')}</div><ul className="m-0 flex flex-col gap-1 pl-0">{report.picks.map((pick, index) => <li key={index} className="flex list-none gap-2"><span className="w-20 shrink-0 font-mono text-xs">{pick.symbol}</span><span className="text-ink-2">{pick.thesis}</span></li>)}</ul></section> : null}
      {report.risks && <section><div className="mb-1 text-xs font-semibold text-ink-3">{t('风险')}</div><p className="m-0 whitespace-pre-wrap text-ink-2">{report.risks}</p></section>}
      {report.nextSteps && <section><div className="mb-1 text-xs font-semibold text-ink-3">{t('下一步')}</div><p className="m-0 whitespace-pre-wrap text-ink-2">{report.nextSteps}</p></section>}
      {report.body && <details><summary className="cursor-pointer text-ink-2">{t('完整分析')}</summary><pre className="mt-2 whitespace-pre-wrap rounded-lg bg-surface-2 p-3 font-sans text-[13px]">{report.body}</pre></details>}
    </div>
  )
}

export function TraderReportsTab({ account }: { account: AccountDetail }) {
  const [offset, setOffset] = useState(0)
  const [q, setQ] = useState('')
  const reports = useHistory<Report>(account.id, 'reports', { offset, q: q || undefined })
  const [open, setOpen] = useState<string | null>(null)
  return (
    <div className="flex flex-col gap-3">
      <Input value={q} onChange={(event) => { setQ(event.target.value); setOffset(0) }} placeholder={t('搜索标题、结论、股票')} aria-label={t('搜索报告')} className="max-w-sm" />
      {reports.isLoading ? <Spinner /> : !reports.data?.items.length ? <Empty title={t('还没有报告')}>{t('交易员有变化（改了策略、下了单、改了设置）时会写报告；没变化的复查只记一句。')}</Empty> : (
        <div className="flex flex-col gap-2">
          {reports.data.items.map((report) => (
            <Card key={report.id} className="p-0">
              <button type="button" aria-expanded={open === report.id} onClick={() => setOpen(open === report.id ? null : report.id)} className="flex w-full flex-wrap items-center gap-3 px-4 py-3 text-left">
                <span className="w-24 shrink-0 font-mono text-xs text-ink-3">{dateTime(report.at)}</span>
                <span className="min-w-0 flex-1 font-semibold">{report.title}</span>
                {report.sentiment && <Pill tone={SENTIMENT[report.sentiment]?.[1] ?? 'neutral'}>{SENTIMENT[report.sentiment]?.[0] ?? report.sentiment}</Pill>}
                {report.strategyVersion && <span className="font-mono text-xs text-ink-3">v{report.strategyVersion}</span>}
              </button>
              {open === report.id && <div className="border-t border-line px-4 py-3"><ReportBody report={report} /></div>}
            </Card>
          ))}
          <Pager total={reports.data.total} offset={offset} limit={20} onChange={setOffset} />
        </div>
      )}
    </div>
  )
}

const BASIS: Record<string, string> = { ask: t('卖一'), bid: t('买一'), book: t('逐档'), last: t('最新价'), 'minute-trade-through': t('分钟线穿价') }
const ORDER_STATUS: Record<string, [string, 'ok' | 'bad' | 'neutral' | 'accent' | 'warn']> = { filled: [t('已成交'), 'ok'], open: [t('挂单中'), 'accent'], rejected: [t('被拒'), 'bad'], cancelled: [t('已撤'), 'neutral'], expired: [t('过期'), 'neutral'] }
const STAGE: Record<string, string> = { intent: t('意图'), limits: t('硬性边界'), discipline: t('纪律检查'), confirmation: t('确认'), broker: t('撮合') }
const APPROVAL_STATUS: Record<string, [string, 'ok' | 'bad' | 'neutral' | 'accent' | 'warn']> = { pending: [t('等你确认'), 'accent'], approving: [t('下单中'), 'accent'], approved: [t('已确认'), 'ok'], rejected: [t('已拒绝'), 'neutral'], failed: [t('确认后被拦下'), 'bad'], expired: [t('已过期'), 'warn'] }

function QuoteLine({ quote, label }: { quote?: QuoteSnapshot | null; label: string }) {
  if (!quote) return <div className="text-xs text-ink-3">{label}：{t('旧版本没有记录')}</div>
  return <div className="text-xs text-ink-2">{label}：<span className="font-mono">{t('最新 {p} · 买一 {b} / 卖一 {a}', { p: num(quote.price), b: num(quote.bid), a: num(quote.ask) })}</span> · {quote.source ?? '—'} · {time(quote.asOf)}{quote.freshness ? ` · ${quote.freshness === 'fresh' ? t('新鲜') : quote.freshness}` : ''}</div>
}

function Pipeline({ steps }: { steps?: PipelineStep[] }) {
  if (!steps?.length) return null
  return (
    <ol className="m-0 flex flex-wrap items-center gap-1.5 p-0 text-xs">
      {steps.map((step, index) => {
        const bad = step.stage === 'limits' && step.ok === false
        const warn = step.stage === 'discipline' && (step.warnings?.length ?? 0) > 0
        const detail = step.stage === 'confirmation' ? (step.status === 'approved' ? t('你确认过') : t('不需要')) : step.stage === 'broker' ? `${step.broker === 'paper' ? t('模拟盘') : step.broker} · ${ORDER_STATUS[step.status ?? '']?.[0] ?? step.status}` : step.stage === 'intent' ? step.by : bad ? t('拦下') : warn ? t('{n} 条提醒', { n: step.warnings!.length }) : t('通过')
        return (
          <li key={index} className="flex list-none items-center gap-1.5">
            {index > 0 && <span aria-hidden className="text-ink-3">›</span>}
            <span className={cn('inline-flex items-center gap-1 rounded-md px-1.5 py-0.5', bad ? 'bg-bad-soft text-bad' : warn ? 'bg-warn-soft text-warn-ink' : 'bg-sunken text-ink-2')}><Dot tone={bad ? 'bad' : warn ? 'warn' : 'ok'} />{STAGE[step.stage]} · {detail}</span>
          </li>
        )
      })}
    </ol>
  )
}

function RowDetail({ row, kind, currency }: { row: Trade & Order; kind: 'trades' | 'orders'; currency: string }) {
  return (
    <div className="flex flex-col gap-2 bg-surface-2 px-4 py-3">
      <div className="text-[13px] text-ink">{row.reason}</div>
      {row.rejectReason && <div className="text-[13px] text-bad">{row.rejectReason}</div>}
      <Pipeline steps={row.pipeline} />
      {row.warnings?.length ? <div className="flex flex-wrap gap-1.5">{row.warnings.map((warning) => <Pill key={warning} tone="warn">{warning}</Pill>)}</div> : null}
      {kind === 'trades' ? <QuoteLine quote={row.quote} label={t('成交时行情')} /> : <QuoteLine quote={row.quoteAtSubmit} label={t('下单时行情')} />}
      {kind === 'trades' && row.feeBreakdown && <div className="text-xs text-ink-2">{t('费用明细')}：{Object.entries(row.feeBreakdown).map(([key, value]) => `${key} ${money(value, currency, 2)}`).join(' · ')}</div>}
      {row.industry && <div className="text-xs text-ink-2">{t('行业：{name}', { name: row.industry })}</div>}
      {row.citations?.length ? <div className="flex flex-col gap-1"><div className="text-xs font-semibold text-ink-3">{t('依据的来源')}</div><CitationList citations={row.citations} /></div> : <div className="text-xs text-ink-3">{t('没有引用来源。')}</div>}
    </div>
  )
}

export function TraderHistoryTab({ account }: { account: AccountDetail }) {
  const [kind, setKind] = useState<'trades' | 'orders' | 'approvals' | 'journal' | 'events'>('trades')
  const [offset, setOffset] = useState(0)
  const [side, setSide] = useState('')
  const [type, setType] = useState('')
  const [q, setQ] = useState('')
  const [open, setOpen] = useState<string | null>(null)
  const page = useHistory<Trade & Order & { kind?: string; summary?: string; details?: string; message?: string; type?: string }>(account.id, kind === 'approvals' ? 'orders' : kind, { offset, side: side || undefined, type: type || undefined, q: q || undefined })
  const reset = () => { setOffset(0); setOpen(null) }
  const expandable = kind === 'trades' || kind === 'orders'
  const columns = kind === 'trades' ? 10 : kind === 'orders' ? 8 : 3
  return (
    <div className="flex flex-wrap items-start gap-4">
      <div className="flex min-w-0 flex-[999_1_640px] flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2.5">
          <Segmented label={t('类型')} value={kind} onChange={(value) => { setKind(value); setType(''); reset() }} options={[['trades', t('成交')], ['orders', t('委托')], ['approvals', t('确认记录')], ['journal', t('决策日志')], ['events', t('事件')]]} />
          {(kind === 'trades' || kind === 'orders') && <Select aria-label={t('方向')} value={side} onChange={(event) => { setSide(event.target.value); reset() }} className="w-28"><option value="">{t('全部方向')}</option><option value="BUY">{t('买入')}</option><option value="SELL">{t('卖出')}</option></Select>}
          {kind !== 'approvals' && <Select aria-label={t('筛选')} value={type} onChange={(event) => { setType(event.target.value); reset() }} className="w-36"><option value="">{t('全部')}</option>{(page.data?.facets.types ?? []).map((entry) => <option key={entry} value={entry}>{ORDER_STATUS[entry]?.[0] ?? entry}</option>)}</Select>}
          {kind !== 'approvals' && <Input value={q} onChange={(event) => { setQ(event.target.value); reset() }} placeholder={t('搜索股票、理由')} aria-label={t('搜索')} className="w-56 max-sm:w-full" />}
        </div>
        {account.metrics.byStrategyVersion.length > 1 && kind === 'trades' && (
          <Card className="flex flex-wrap gap-4 p-3 text-xs">
            <span className="font-semibold">{t('按策略版本归因')}</span>
            {account.metrics.byStrategyVersion.map((entry) => <span key={entry.version} className="font-mono text-ink-2">{t('v{v}：{n} 笔 · 已实现', { v: entry.version, n: entry.trades })} <Signed value={entry.realizedPnl} suffix="" digits={0} />{entry.winRatePct !== null ? t(' · 胜率 {pct}%', { pct: entry.winRatePct }) : ''}</span>)}
          </Card>
        )}
        {kind === 'approvals' ? <ApprovalLog approvals={account.approvals ?? []} currency={account.currency} /> : (
          <Expandable title={t('{name} · 委托与成交', { name: account.name })}>
            <Card className="overflow-x-auto p-0">
              {page.isLoading ? <div className="p-4"><Spinner /></div> : !page.data?.items.length ? <div className="p-6 text-center text-[13px] text-ink-3">{t('没有记录。')}</div> : (
                <table className="w-full min-w-[860px] border-collapse text-[13px]">
                  <thead><tr className="text-left text-xs text-ink-3">
                    {expandable && <th className="w-8" aria-label={t('展开')} />}
                    <th className={cn('py-2.5 font-medium', !expandable && 'px-4')}>{t('时间')}</th>
                    {kind === 'trades' && <><th className="font-medium">{t('股票')}</th><th className="font-medium">{t('方向')}</th><th className="text-right font-medium">{t('数量')}</th><th className="text-right font-medium">{t('价格')}</th><th className="pl-3 font-medium">{t('价格来源')}</th><th className="text-right font-medium">{t('费用')}</th><th className="text-right font-medium">{t('盈亏')}</th><th className="px-4 font-medium">{t('理由')}</th></>}
                    {kind === 'orders' && <><th className="font-medium">{t('股票')}</th><th className="font-medium">{t('方向')}</th><th className="text-right font-medium">{t('数量')}</th><th className="pl-3 font-medium">{t('类型')}</th><th className="font-medium">{t('状态')}</th><th className="px-4 font-medium">{t('理由 / 原因')}</th></>}
                    {(kind === 'journal' || kind === 'events') && <><th className="font-medium">{t('类型')}</th><th className="px-4 font-medium">{t('内容')}</th></>}
                  </tr></thead>
                  <tbody>
                    {page.data.items.map((row) => {
                      const expanded = open === row.id
                      const toggle = expandable ? () => setOpen(expanded ? null : row.id) : undefined
                      return (
                        <Fragment key={row.id}>
                          <tr className={cn('border-t border-line align-top', expandable && 'cursor-pointer hover:bg-surface-2', expanded && 'bg-surface-2')} onClick={toggle}>
                            {expandable && <td className="py-2 pl-3"><button type="button" aria-expanded={expanded} aria-label={expanded ? t('收起详情') : t('展开详情')} onClick={(event) => { event.stopPropagation(); toggle?.() }} className="text-ink-3">{expanded ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}</button></td>}
                            <td className={cn('whitespace-nowrap py-2 pr-3 font-mono text-xs text-ink-3', !expandable && 'px-4')}>{dateTime(kind === 'orders' ? row.createdAt : row.at)}</td>
                            {kind === 'trades' && <>
                              <td className="py-2 pr-3"><div className="font-semibold">{row.name}</div><div className="font-mono text-[11px] text-ink-3">{row.symbol}</div></td>
                              <td className={cn('pr-3', row.side === 'BUY' ? 'text-up' : 'text-down')}>{SIDE_NAME[row.side]}{row.trigger ? `（${row.trigger === 'stop-loss' ? t('止损') : row.trigger === 'take-profit' ? t('止盈') : row.trigger}）` : ''}</td>
                              <td className="text-right font-mono">{row.quantity.toLocaleString(locale())}</td>
                              <td className="text-right font-mono">{num(row.price, row.price < 1 ? 4 : 2)}</td>
                              <td className="pl-3 text-xs text-ink-2">{BASIS[row.fillBasis ?? ''] ?? '—'}{row.quote?.source ? ` · ${row.quote.source}` : ''}{row.citations?.length ? <Pill className="ml-1">{t('{n} 个来源', { n: row.citations.length })}</Pill> : null}</td>
                              <td className="text-right font-mono">{num(row.fees, 2)}</td>
                              <td className="text-right">{row.realizedPnl !== null && row.realizedPnl !== undefined ? <Signed value={row.realizedPnl} suffix="" digits={0} /> : '—'}</td>
                              <td className="max-w-[360px] px-4 py-2 text-xs text-ink-2"><span className="line-clamp-2">{row.reason}</span></td>
                            </>}
                            {kind === 'orders' && <>
                              <td className="py-2 pr-3"><div className="font-semibold">{row.name}</div><div className="font-mono text-[11px] text-ink-3">{row.symbol}</div></td>
                              <td className={cn('pr-3', row.side === 'BUY' ? 'text-up' : 'text-down')}>{SIDE_NAME[row.side]}</td>
                              <td className="text-right font-mono">{row.quantity.toLocaleString(locale())}{row.filledQuantity ? <span className="text-ink-3"> / {row.filledQuantity}</span> : ''}</td>
                              <td className="pl-3 text-xs">{row.type === 'limit' ? t('限价 {price}', { price: row.limitPrice ?? '—' }) : t('市价')}</td>
                              <td><Pill tone={ORDER_STATUS[row.status]?.[1] ?? 'neutral'}>{ORDER_STATUS[row.status]?.[0] ?? row.status}</Pill>{row.warnings?.length ? <Pill tone="warn" className="ml-1">{t('{n} 条提醒', { n: row.warnings.length })}</Pill> : null}</td>
                              <td className={cn('max-w-[420px] px-4 py-2 text-xs', row.status === 'rejected' ? 'text-bad' : 'text-ink-2')}><span className="line-clamp-2">{row.rejectReason ?? row.reason}</span></td>
                            </>}
                            {kind === 'journal' && <><td className="py-2"><Pill>{row.kind}</Pill></td><td className="px-4 py-2"><div>{row.summary}</div>{row.details && <details className="mt-1 text-xs text-ink-2"><summary className="cursor-pointer">{t('详情')}</summary><pre className="whitespace-pre-wrap font-sans">{row.details}</pre></details>}</td></>}
                            {kind === 'events' && <><td className="py-2"><Pill>{row.type}</Pill></td><td className="px-4 py-2 text-ink-2">{row.message}</td></>}
                          </tr>
                          {expanded && <tr><td colSpan={columns} className="p-0"><RowDetail row={row} kind={kind as 'trades' | 'orders'} currency={account.currency} /></td></tr>}
                        </Fragment>
                      )
                    })}
                  </tbody>
                </table>
              )}
            </Card>
          </Expandable>
        )}
        {page.data && kind !== 'approvals' && <Pager total={page.data.total} offset={offset} limit={20} onChange={setOffset} />}
        <div className="text-xs text-ink-3">{t('现金 {cash} · 手续费合计 {fees}', { cash: money(account.metrics.cash, account.currency), fees: money(account.metrics.feesPaid, account.currency, 2) })}</div>
      </div>
      <aside className="flex min-w-0 flex-[1_1_300px] flex-col gap-4 lg:max-w-[360px]">
        <ReconcileCard account={account} />
      </aside>
    </div>
  )
}

function ApprovalLog({ approvals, currency }: { approvals: Approval[]; currency: string }) {
  if (!approvals.length) return <Empty title={t('还没有确认记录')}>{t('自主级别设成「关键操作确认」或「只给建议」后，等你确认的订单和你的决定会记在这里。')}</Empty>
  return (
    <Card className="overflow-x-auto p-0">
      <table className="w-full min-w-[760px] border-collapse text-[13px]">
        <thead><tr className="text-left text-xs text-ink-3"><th className="px-4 py-2.5 font-medium">{t('提交')}</th><th className="font-medium">{t('订单')}</th><th className="font-medium">{t('为什么要确认')}</th><th className="font-medium">{t('结果')}</th><th className="px-4 font-medium">{t('备注')}</th></tr></thead>
        <tbody>
          {approvals.map((approval) => (
            <tr key={approval.id} className="border-t border-line align-top">
              <td className="whitespace-nowrap px-4 py-2 font-mono text-xs text-ink-3">{dateTime(approval.createdAt)}</td>
              <td className="py-2 pr-3"><span className={approval.preview.side === 'BUY' ? 'text-up' : 'text-down'}>{SIDE_NAME[approval.preview.side]}</span> {approval.preview.name} {approval.preview.quantity.toLocaleString(locale())} <span className="text-xs text-ink-3">≈ {money(approval.preview.value, currency)}</span></td>
              <td className="pr-3 text-xs text-ink-2">{approval.reason}</td>
              <td className="pr-3"><Pill tone={APPROVAL_STATUS[approval.status]?.[1] ?? 'neutral'}>{APPROVAL_STATUS[approval.status]?.[0] ?? approval.status}</Pill>{approval.decidedAt && <div className="mt-0.5 font-mono text-[11px] text-ink-3">{dateTime(approval.decidedAt)}</div>}</td>
              <td className="max-w-[300px] px-4 py-2 text-xs text-ink-2">{approval.note ?? approval.result?.error ?? (approval.result?.status ? ORDER_STATUS[approval.result.status]?.[0] : '') ?? ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  )
}

// Rebuild cash and positions from the records and compare: the check a real account will need.
function ReconcileCard({ account }: { account: AccountDetail }) {
  const [enabled, setEnabled] = useState(false)
  const check = useReconcile(account.id, enabled)
  const data = check.data
  return (
    <Card className="flex flex-col gap-2.5 p-4">
      <CardTitle extra={<Button size="sm" className="ml-auto" loading={check.isFetching} onClick={() => (enabled ? check.refetch() : setEnabled(true))}>{data ? t('重新核对') : t('核对')}</Button>}>{t('对账')}</CardTitle>
      <p className="m-0 text-xs text-ink-3">{t('用成交、派息和拆股记录重算现金和持仓，和账户里存的数比对。以后接真实券商时，用同样的方法和券商的对账单核对。')}</p>
      {data && (
        <div className="flex flex-col gap-1.5 text-[13px]">
          <div className={cn('flex items-center gap-1.5 font-semibold', data.ok ? 'text-ok' : data.ok === false ? 'text-bad' : 'text-warn-ink')}><Dot tone={data.ok ? 'ok' : data.ok === false ? 'bad' : 'warn'} />{data.ok ? t('账目一致') : data.ok === false ? t('账目对不上') : t('只能部分核对')}</div>
          <div className="text-xs text-ink-2">{t('现金：按记录 {a} · 账户 {b}', { a: money(data.cash.ledger, account.currency, 2), b: money(data.cash.stored, account.currency, 2) })}{data.cash.diff ? <span className="text-bad"> · {t('差 {n}', { n: money(data.cash.diff, account.currency, 2) })}</span> : null}</div>
          <div className="text-xs text-ink-2">{t('持仓 {n} 只，{m} 只对不上 · 成交 {t} 笔 · 挂单 {o} 笔', { n: data.positions.length, m: data.mismatched, t: data.trades, o: data.openOrders })}</div>
          {data.positions.filter((row) => row.diff !== 0).map((row) => <div key={row.symbol} className="font-mono text-xs text-bad">{row.symbol}: {t('记录 {a} · 账户 {b}', { a: row.ledger, b: row.stored })}</div>)}
          {data.note && <div className="text-xs text-warn-ink">{data.note}</div>}
          <div className="font-mono text-[11px] text-ink-3">{dateTime(data.checkedAt)}</div>
        </div>
      )}
    </Card>
  )
}

export function TraderChangesTab({ account }: { account: AccountDetail }) {
  const requests = account.requests ?? []
  return (
    <div className="flex flex-wrap items-start gap-4">
      <Card className="flex min-w-0 flex-[999_1_520px] flex-col gap-3 overflow-x-auto p-4">
        <CardTitle>{t('修改记录')}</CardTitle>
        {account.changeLog.length ? (
          <table className="w-full min-w-[520px] border-collapse text-[13px]">
            <tbody>{account.changeLog.map((entry) => (
              <tr key={entry.id} className="border-t border-line align-top">
                <td className="whitespace-nowrap py-2 pr-3 font-mono text-xs text-ink-3">{dateTime(entry.at)}</td>
                <td className="py-2 pr-3 font-semibold">{changeLabel(entry.key)}</td>
                <td className="py-2 pr-3 text-ink-2">{entry.key.startsWith('lock:') ? (entry.to ? t('锁定') : t('解锁')) : `${valueLabel(entry.key, entry.from)} → ${valueLabel(entry.key, entry.to)}`}{entry.reason && <div className="text-xs text-ink-3">「{entry.reason}」</div>}</td>
                <td className="py-2 font-mono text-xs text-ink-3">{changedByLabel(entry.by)}</td>
              </tr>
            ))}</tbody>
          </table>
        ) : <div className="text-[13px] text-ink-3">{t('还没有修改。')}</div>}
      </Card>
      <Card className="flex min-w-0 flex-[1_1_340px] flex-col gap-3 p-4 lg:max-w-[420px]">
        <CardTitle>{t('Agent 的申请')}</CardTitle>
        {requests.length ? requests.map((request) => <RequestRow key={request.id} accountId={account.id} request={request} />) : <div className="text-[13px] text-ink-3">{t('没有申请。锁住的项被 Agent 改、或交易员提议长期规则时会出现在这里。')}</div>}
      </Card>
    </div>
  )
}

function RequestRow({ accountId, request }: { accountId: string; request: ChangeRequest }) {
  const resolve = useAction<{ approve: boolean }>(`/api/arena/accounts/${accountId}/requests/${request.id}`, { invalidate: [['account', accountId], ['trader-settings', accountId], ['leaderboard']] })
  return (
    <div className="flex flex-col gap-1 border-t border-line pt-2.5">
      <div className="text-[13px] font-semibold">{request.key === 'rule' ? t('提议长期规则：「{rule}」', { rule: String(request.to) }) : `${changeLabel(request.key)}：${valueLabel(request.key, request.from)} → ${valueLabel(request.key, request.to)}`}</div>
      {request.reason && <div className="text-xs text-ink-2">{t('理由：{reason}', { reason: request.reason })}</div>}
      <div className="flex flex-wrap items-center gap-2 text-xs text-ink-3">
        <span>{changedByLabel(request.by)} · {dateTime(request.at)}</span>
        <span className="flex-1" />
        {request.status === 'pending' ? <><Button size="sm" onClick={() => resolve.mutate({ approve: false })}>{t('拒绝')}</Button><Button size="sm" variant="primary" loading={resolve.isPending} onClick={() => resolve.mutate({ approve: true })}>{t('同意')}</Button></>
          : <Pill tone={request.status === 'approved' ? 'ok' : 'neutral'}>{{ approved: t('已同意'), rejected: t('已拒绝'), superseded: t('被新申请替代') }[request.status] ?? request.status}</Pill>}
      </div>
    </div>
  )
}
