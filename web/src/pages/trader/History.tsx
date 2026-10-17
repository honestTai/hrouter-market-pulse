import { useState } from 'react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { get, qs, type AccountDetail, type ChangeRequest, type Order, type Report, type Trade } from '@/lib/api'
import { changeLabel, changedByLabel, dateTime, money, num, valueLabel } from '@/lib/format'
import { useAction, useTraderSettings } from '@/lib/queries'
import { Button, Card, CardTitle, Empty, Input, Pager, Pill, Segmented, Select, Signed, Spinner, cn } from '@/components/ui'

type HistoryKind = 'trades' | 'orders' | 'journal' | 'events' | 'reports'
interface HistoryPage<T> { items: T[]; total: number; offset: number; limit: number; facets: { types: string[]; symbols: string[] }; all: number }

function useHistory<T>(accountId: string, kind: HistoryKind, params: Record<string, string | number | undefined>) {
  return useQuery({ queryKey: ['history', accountId, kind, params], queryFn: ({ signal }) => get<HistoryPage<T>>(`/api/arena/accounts/${accountId}/history${qs({ kind, limit: 20, ...params })}`, signal), placeholderData: keepPreviousData })
}

const SENTIMENT: Record<string, [string, 'ok' | 'bad' | 'neutral' | 'warn']> = { bullish: ['看多', 'ok'], bearish: ['看空', 'bad'], neutral: ['中性', 'neutral'], defensive: ['防守', 'warn'] }

export function ReportBody({ report }: { report: Report }) {
  return (
    <div className="flex flex-col gap-3 text-[13px]">
      <p className="m-0 whitespace-pre-wrap">{report.summary}</p>
      {report.marketView && <section><div className="mb-1 text-xs font-semibold text-ink-3">市场判断</div><p className="m-0 whitespace-pre-wrap text-ink-2">{report.marketView}</p></section>}
      {report.actions?.length ? <section><div className="mb-1 text-xs font-semibold text-ink-3">操作</div><ul className="m-0 flex flex-col gap-1 pl-0">{report.actions.map((action, index) => <li key={index} className="flex list-none gap-2"><span className="w-20 shrink-0 font-mono text-xs">{action.symbol}</span><Pill>{action.action}</Pill><span className="text-ink-2">{action.detail}</span></li>)}</ul></section> : null}
      {report.picks?.length ? <section><div className="mb-1 text-xs font-semibold text-ink-3">看好</div><ul className="m-0 flex flex-col gap-1 pl-0">{report.picks.map((pick, index) => <li key={index} className="flex list-none gap-2"><span className="w-20 shrink-0 font-mono text-xs">{pick.symbol}</span><span className="text-ink-2">{pick.thesis}</span></li>)}</ul></section> : null}
      {report.risks && <section><div className="mb-1 text-xs font-semibold text-ink-3">风险</div><p className="m-0 whitespace-pre-wrap text-ink-2">{report.risks}</p></section>}
      {report.nextSteps && <section><div className="mb-1 text-xs font-semibold text-ink-3">下一步</div><p className="m-0 whitespace-pre-wrap text-ink-2">{report.nextSteps}</p></section>}
      {report.body && <details><summary className="cursor-pointer text-ink-2">完整分析</summary><pre className="mt-2 whitespace-pre-wrap rounded-lg bg-surface-2 p-3 font-sans text-[13px]">{report.body}</pre></details>}
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
      <Input value={q} onChange={(event) => { setQ(event.target.value); setOffset(0) }} placeholder="搜索标题、结论、股票" aria-label="搜索报告" className="max-w-sm" />
      {reports.isLoading ? <Spinner /> : !reports.data?.items.length ? <Empty title="还没有报告">交易员有变化（改了策略、下了单、改了设置）时会写报告；没变化的复查只记一句。</Empty> : (
        <div className="flex flex-col gap-2">
          {reports.data.items.map((report) => (
            <Card key={report.id} className="p-0">
              <button type="button" onClick={() => setOpen(open === report.id ? null : report.id)} className="flex w-full items-center gap-3 px-4 py-3 text-left">
                <span className="w-24 shrink-0 font-mono text-xs text-ink-3">{dateTime(report.at)}</span>
                <span className="flex-1 font-semibold">{report.title}</span>
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

const BASIS: Record<string, string> = { ask: '卖一', bid: '买一', book: '逐档', last: '最新价', 'minute-trade-through': '分钟线穿价' }
const ORDER_STATUS: Record<string, [string, 'ok' | 'bad' | 'neutral' | 'accent' | 'warn']> = { filled: ['已成交', 'ok'], open: ['挂单中', 'accent'], rejected: ['被拒', 'bad'], cancelled: ['已撤', 'neutral'], expired: ['过期', 'neutral'] }

export function TraderHistoryTab({ account }: { account: AccountDetail }) {
  const [kind, setKind] = useState<'trades' | 'orders' | 'journal' | 'events'>('trades')
  const [offset, setOffset] = useState(0)
  const [side, setSide] = useState('')
  const [type, setType] = useState('')
  const [q, setQ] = useState('')
  const page = useHistory<Trade & Order & { kind?: string; summary?: string; details?: string; message?: string; type?: string }>(account.id, kind, { offset, side: side || undefined, type: type || undefined, q: q || undefined })
  const reset = () => setOffset(0)
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2.5">
        <Segmented label="类型" value={kind} onChange={(value) => { setKind(value); setType(''); reset() }} options={[['trades', '成交'], ['orders', '委托'], ['journal', '决策日志'], ['events', '事件']]} />
        {(kind === 'trades' || kind === 'orders') && <Select aria-label="方向" value={side} onChange={(event) => { setSide(event.target.value); reset() }} className="w-28"><option value="">全部方向</option><option value="BUY">买入</option><option value="SELL">卖出</option></Select>}
        <Select aria-label="筛选" value={type} onChange={(event) => { setType(event.target.value); reset() }} className="w-36"><option value="">全部</option>{(page.data?.facets.types ?? []).map((entry) => <option key={entry} value={entry}>{ORDER_STATUS[entry]?.[0] ?? entry}</option>)}</Select>
        <Input value={q} onChange={(event) => { setQ(event.target.value); reset() }} placeholder="搜索股票、理由" aria-label="搜索" className="w-56" />
      </div>
      {account.metrics.byStrategyVersion.length > 1 && kind === 'trades' && (
        <Card className="flex flex-wrap gap-4 p-3 text-xs">
          <span className="font-semibold">按策略版本归因</span>
          {account.metrics.byStrategyVersion.map((entry) => <span key={entry.version} className="font-mono text-ink-2">v{entry.version}：{entry.trades} 笔 · 已实现 <Signed value={entry.realizedPnl} suffix="" digits={0} />{entry.winRatePct !== null ? ` · 胜率 ${entry.winRatePct}%` : ''}</span>)}
        </Card>
      )}
      <Card className="overflow-x-auto p-0">
        {page.isLoading ? <div className="p-4"><Spinner /></div> : !page.data?.items.length ? <div className="p-6 text-center text-[13px] text-ink-3">没有记录。</div> : (
          <table className="w-full min-w-[860px] border-collapse text-[13px]">
            <thead><tr className="text-left text-xs text-ink-3">
              <th className="px-4 py-2.5 font-medium">时间</th>
              {kind === 'trades' && <><th className="font-medium">股票</th><th className="font-medium">方向</th><th className="text-right font-medium">数量</th><th className="text-right font-medium">价格</th><th className="font-medium">价格来源</th><th className="text-right font-medium">费用</th><th className="text-right font-medium">盈亏</th><th className="px-4 font-medium">理由</th></>}
              {kind === 'orders' && <><th className="font-medium">股票</th><th className="font-medium">方向</th><th className="text-right font-medium">数量</th><th className="font-medium">类型</th><th className="font-medium">状态</th><th className="px-4 font-medium">理由 / 原因</th></>}
              {kind === 'journal' && <><th className="font-medium">类型</th><th className="px-4 font-medium">内容</th></>}
              {kind === 'events' && <><th className="font-medium">类型</th><th className="px-4 font-medium">内容</th></>}
            </tr></thead>
            <tbody>
              {page.data.items.map((row) => (
                <tr key={row.id} className="border-t border-line align-top">
                  <td className="whitespace-nowrap px-4 py-2 font-mono text-xs text-ink-3">{dateTime(kind === 'orders' ? row.createdAt : row.at)}</td>
                  {kind === 'trades' && <>
                    <td className="py-2"><div className="font-semibold">{row.name}</div><div className="font-mono text-[11px] text-ink-3">{row.symbol}</div></td>
                    <td className={row.side === 'BUY' ? 'text-up' : 'text-down'}>{row.side === 'BUY' ? '买入' : '卖出'}{row.trigger ? `（${row.trigger === 'stop-loss' ? '止损' : row.trigger === 'take-profit' ? '止盈' : row.trigger}）` : ''}</td>
                    <td className="text-right font-mono">{row.quantity.toLocaleString('zh-CN')}</td>
                    <td className="text-right font-mono">{num(row.price, row.price < 1 ? 4 : 2)}</td>
                    <td className="text-xs text-ink-2" title={row.quote ? `买一 ${row.quote.bid ?? '—'} / 卖一 ${row.quote.ask ?? '—'} · ${row.quote.source ?? ''} · ${row.quote.asOf ?? ''}` : '旧版本成交没有记录盘口'}>{BASIS[row.fillBasis ?? ''] ?? '—'}{row.quote?.source ? ` · ${row.quote.source}` : ''}</td>
                    <td className="text-right font-mono">{num(row.fees, 2)}</td>
                    <td className="text-right">{row.realizedPnl !== null && row.realizedPnl !== undefined ? <Signed value={row.realizedPnl} suffix="" digits={0} /> : '—'}</td>
                    <td className="max-w-[360px] px-4 py-2 text-xs text-ink-2">{row.reason}</td>
                  </>}
                  {kind === 'orders' && <>
                    <td className="py-2"><div className="font-semibold">{row.name}</div><div className="font-mono text-[11px] text-ink-3">{row.symbol}</div></td>
                    <td className={row.side === 'BUY' ? 'text-up' : 'text-down'}>{row.side === 'BUY' ? '买入' : '卖出'}</td>
                    <td className="text-right font-mono">{row.quantity.toLocaleString('zh-CN')}{row.filledQuantity ? <span className="text-ink-3"> / {row.filledQuantity}</span> : ''}</td>
                    <td className="text-xs">{row.type === 'limit' ? `限价 ${row.limitPrice}` : '市价'}</td>
                    <td><Pill tone={ORDER_STATUS[row.status]?.[1] ?? 'neutral'}>{ORDER_STATUS[row.status]?.[0] ?? row.status}</Pill></td>
                    <td className={cn('max-w-[420px] px-4 py-2 text-xs', row.status === 'rejected' ? 'text-bad' : 'text-ink-2')}>{row.rejectReason ?? row.reason}</td>
                  </>}
                  {kind === 'journal' && <><td className="py-2"><Pill>{row.kind}</Pill></td><td className="px-4 py-2"><div>{row.summary}</div>{row.details && <details className="mt-1 text-xs text-ink-2"><summary className="cursor-pointer">详情</summary><pre className="whitespace-pre-wrap font-sans">{row.details}</pre></details>}</td></>}
                  {kind === 'events' && <><td className="py-2"><Pill>{row.type}</Pill></td><td className="px-4 py-2 text-ink-2">{row.message}</td></>}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      {page.data && <Pager total={page.data.total} offset={offset} limit={20} onChange={setOffset} />}
      <div className="text-xs text-ink-3">现金 {money(account.metrics.cash, account.currency)} · 手续费合计 {money(account.metrics.feesPaid, account.currency, 2)}</div>
    </div>
  )
}

export function TraderChangesTab({ account }: { account: AccountDetail }) {
  const settings = useTraderSettings(account.id)
  const requests = account.requests ?? []
  return (
    <div className="flex flex-wrap items-start gap-4">
      <Card className="flex min-w-0 flex-[999_1_520px] flex-col gap-3 p-4">
        <CardTitle>修改记录</CardTitle>
        {account.changeLog.length ? (
          <table className="w-full border-collapse text-[13px]">
            <tbody>{account.changeLog.map((entry) => (
              <tr key={entry.id} className="border-t border-line align-top">
                <td className="whitespace-nowrap py-2 pr-3 font-mono text-xs text-ink-3">{dateTime(entry.at)}</td>
                <td className="py-2 pr-3 font-semibold">{changeLabel(entry.key)}</td>
                <td className="py-2 pr-3 text-ink-2">{entry.key.startsWith('lock:') ? (entry.to ? '锁定' : '解锁') : `${valueLabel(entry.key, entry.from)} → ${valueLabel(entry.key, entry.to)}`}{entry.reason && <div className="text-xs text-ink-3">「{entry.reason}」</div>}</td>
                <td className="py-2 font-mono text-xs text-ink-3">{changedByLabel(entry.by)}</td>
              </tr>
            ))}</tbody>
          </table>
        ) : <div className="text-[13px] text-ink-3">还没有修改。</div>}
      </Card>
      <Card className="flex min-w-0 max-w-[420px] flex-[1_1_340px] flex-col gap-3 p-4">
        <CardTitle>Agent 的申请</CardTitle>
        {requests.length ? requests.map((request) => <RequestRow key={request.id} accountId={account.id} request={request} />) : <div className="text-[13px] text-ink-3">没有申请。锁住的项被 Agent 改时会出现在这里。</div>}
        {settings.data && null}
      </Card>
    </div>
  )
}

function RequestRow({ accountId, request }: { accountId: string; request: ChangeRequest }) {
  const resolve = useAction<{ approve: boolean }>(`/api/arena/accounts/${accountId}/requests/${request.id}`, { invalidate: [['account', accountId], ['trader-settings', accountId], ['leaderboard']] })
  return (
    <div className="flex flex-col gap-1 border-t border-line pt-2.5">
      <div className="text-[13px] font-semibold">{changeLabel(request.key)}：{valueLabel(request.key, request.from)} → {valueLabel(request.key, request.to)}</div>
      {request.reason && <div className="text-xs text-ink-2">理由：{request.reason}</div>}
      <div className="flex items-center gap-2 text-xs text-ink-3">
        <span>{changedByLabel(request.by)} · {dateTime(request.at)}</span>
        <span className="flex-1" />
        {request.status === 'pending' ? <><Button size="sm" onClick={() => resolve.mutate({ approve: false })}>拒绝</Button><Button size="sm" variant="primary" loading={resolve.isPending} onClick={() => resolve.mutate({ approve: true })}>同意</Button></>
          : <Pill tone={request.status === 'approved' ? 'ok' : 'neutral'}>{{ approved: '已同意', rejected: '已拒绝', superseded: '被新申请替代' }[request.status] ?? request.status}</Pill>}
      </div>
    </div>
  )
}
