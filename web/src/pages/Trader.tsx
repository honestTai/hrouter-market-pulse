import { useMemo, useState, type ReactNode } from 'react'
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router'
import { ChevronLeft, Send } from 'lucide-react'
import type { AccountDetail, Job, Run, RunEvent } from '@/lib/api'
import { AGENT_NAME, agentKind, ago, BENCHMARK_NAME, changeLabel, changedByLabel, compact, dateTime, FAILURE_KIND, MARKET_NAME, money, num, RUN_STATUS, time, valueLabel } from '@/lib/format'
import { useAccount, useAction, useJob, useRunEvents, useRuns } from '@/lib/queries'
import { jobState } from '@/components/trader-bits'
import { AgentMark, Button, Card, CardTitle, Dot, Empty, ErrorNote, Pill, Select, Signed, Spinner, Tabs, Textarea, cn } from '@/components/ui'
import { TraderStrategyTab } from './trader/Strategy'
import { TraderSettingsTab } from './trader/Settings'
import { TraderHistoryTab, TraderReportsTab, TraderChangesTab } from './trader/History'

type Tab = 'overview' | 'strategy' | 'settings' | 'reports' | 'orders' | 'changes'

export function TraderPage() {
  const { id } = useParams({ from: '/traders/$id' })
  const search = useSearch({ from: '/traders/$id' })
  const navigate = useNavigate()
  const tab = (search.tab ?? 'overview') as Tab
  const account = useAccount(id)
  const { job } = useJob(id)
  const setTab = (next: Tab) => navigate({ to: '/traders/$id', params: { id }, search: { tab: next === 'overview' ? undefined : next } })
  if (account.isLoading) return <div className="p-8"><Spinner /></div>
  if (account.error || !account.data) return <div className="p-8"><ErrorNote error={account.error ?? '找不到这个交易员'} /></div>
  const data = account.data
  return (
    <div className="flex min-h-full flex-col">
      <TraderHeader account={data} job={job} />
      <div className="border-b border-line bg-surface px-6">
        <Tabs value={tab} onChange={setTab} items={[
          { id: 'overview', label: '概览' },
          { id: 'strategy', label: '策略', count: job?.strategy || job?.runner.type === 'strategy' ? '' : undefined },
          { id: 'settings', label: '设置' },
          { id: 'reports', label: '报告', count: data.metrics.reportsPublished },
          { id: 'orders', label: '委托与成交' },
          { id: 'changes', label: '修改记录', count: data.pendingRequests ? `· ${data.pendingRequests} 待处理` : undefined },
        ]} />
      </div>
      <div className="flex-1 px-6 py-4 max-sm:px-3">
        {tab === 'overview' && <Overview account={data} job={job} />}
        {tab === 'strategy' && <TraderStrategyTab account={data} job={job} />}
        {tab === 'settings' && <TraderSettingsTab account={data} job={job} />}
        {tab === 'reports' && <TraderReportsTab account={data} />}
        {tab === 'orders' && <TraderHistoryTab account={data} />}
        {tab === 'changes' && <TraderChangesTab account={data} />}
      </div>
    </div>
  )
}

function TraderHeader({ account, job }: { account: AccountDetail; job: Job | undefined }) {
  const state = jobState(job, account)
  const run = useAction<{ lane?: string }>(`/api/arena/schedules/${account.id}/run`, { invalidate: [['schedules'], ['runs', account.id]], success: (result: unknown) => ((result as { status: string }).status === 'started' ? '已开始，过程会实时显示在概览里' : '正在运行，这次跳过') })
  const toggle = useAction<Record<string, unknown>>(`/api/arena/schedules/${account.id}`, { invalidate: [['schedules']], success: '已更新' })
  const strategy = job?.strategy || job?.runner.type === 'strategy'
  const agent = job && job.runner.type !== 'strategy'
  return (
    <div className="flex flex-wrap items-center gap-3.5 border-b border-line bg-surface px-6 pb-3 pt-4">
      <Link to="/traders" aria-label="返回交易员列表" className="flex size-9 items-center justify-center rounded-[9px] border border-line text-ink-2"><ChevronLeft className="size-4" /></Link>
      <AgentMark kind={agentKind(account)} size={40} />
      <div className="min-w-0 flex-[1_1_280px]">
        <h1 className="m-0 truncate text-xl font-bold leading-snug">{account.name}</h1>
        <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-ink-2">
          <span className="font-mono">{account.model}</span>
          {job?.backup && <><span>·</span><span>备用 {AGENT_NAME[job.backup.type] ?? job.backup.type}{job.backup.model ? ` ${job.backup.model}` : ''}</span></>}
          <span>·</span><span>{MARKET_NAME[account.market]}</span>
          {account.template && <><span>·</span><span>模板 {account.template}</span></>}
          <span>·</span><span>{job?.mode === 'director' || job?.strategy ? 'Agent 主控' : job?.runner.type === 'strategy' ? '纯代码策略' : '全托管轮次'}</span>
        </div>
      </div>
      <span className={cn('inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs', state.tone === 'bad' ? 'border-bad-line bg-bad-soft text-bad' : state.tone === 'warn' ? 'border-warn-line bg-warn-soft text-warn-ink' : state.tone === 'accent' ? 'border-accent-line bg-accent-soft text-accent-ink' : 'border-line bg-surface-2 text-ink-2')}>
        <Dot tone={state.tone} pulse={state.pulse} />{state.text}
      </span>
      {job && <Button onClick={() => toggle.mutate({ enabled: job.enabled === false })} loading={toggle.isPending}>{job.enabled === false ? '启用' : '暂停'}</Button>}
      {strategy && job?.runner.type !== 'strategy' && <Button onClick={() => run.mutate({ lane: 'strategy' })} loading={run.isPending && run.variables?.lane === 'strategy'}>跑一次策略</Button>}
      {job && <Button variant="primary" onClick={() => run.mutate({})} loading={run.isPending && !run.variables?.lane}>{agent ? '立即复查' : '立即执行'}</Button>}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Overview: today's timeline, conversation, portfolio
// ---------------------------------------------------------------------------

type TimelineItem = { at: string; tone: 'ok' | 'warn' | 'bad' | 'accent' | 'muted' | 'up' | 'down'; title: string; detail?: string; sub?: string; highlight?: 'bad' | 'warn' | 'accent'; runId?: string }

// The latest day with any activity: today during the week, the last trading day on weekends.
function latestDay(account: AccountDetail, runs: Run[]) {
  const stamps = [...runs.map((run) => run.startedAt), ...account.trades.map((trade) => trade.at), ...account.orders.map((order) => order.createdAt)].filter(Boolean).map((at) => Date.parse(at)).filter(Number.isFinite)
  return stamps.length ? new Date(Math.max(...stamps)).toDateString() : new Date().toDateString()
}

function useTimeline(account: AccountDetail, runs: Run[]) {
  return useMemo(() => {
    const today = latestDay(account, runs)
    const isToday = (at: string) => new Date(at).toDateString() === today
    const items: TimelineItem[] = []
    const strategyRuns = runs.filter((run) => run.lane === 'strategy' && isToday(run.startedAt))
    for (const run of runs.filter((entry) => entry.lane === 'agent' && isToday(entry.startedAt))) {
      const failed = ['failed', 'timeout'].includes(run.status)
      items.push({
        at: run.startedAt, runId: run.id, tone: run.status === 'running' ? 'accent' : failed ? 'bad' : run.status === 'skipped' ? 'warn' : 'ok',
        title: run.status === 'running' ? `复查中${run.backupFor ? '（备用代班）' : ''}` : failed ? `复查失败 · ${FAILURE_KIND[run.failure?.kind ?? 'other']}` : run.status === 'skipped' ? `跳过 · ${run.reason === 'queue-full' ? '排队太久' : '额度用尽'}` : `复查${run.backupFor ? ' · 备用代班' : ''}`,
        detail: failed || run.status === 'skipped' ? (run.failure?.message ?? run.error ?? undefined) : undefined,
        sub: [AGENT_NAME[run.runner] ?? run.runner, run.usage ? `${compact(run.usage.inputTokens + run.usage.outputTokens)} tokens` : null, run.status === 'no-round' ? '没有记下这一轮' : null].filter(Boolean).join(' · '),
        highlight: run.status === 'running' ? 'accent' : failed ? 'bad' : run.status === 'skipped' ? 'warn' : undefined,
      })
    }
    for (const trade of account.trades.filter((entry) => isToday(entry.at)))
      items.push({ at: trade.at, tone: trade.side === 'BUY' ? 'up' : 'down', title: `${trade.side === 'BUY' ? '买入' : '卖出'} ${trade.name} ${trade.quantity.toLocaleString('zh-CN')} 股`, sub: `@ ${num(trade.price, trade.price < 1 ? 4 : 2)} ${{ ask: '卖一价', bid: '买一价', book: '逐档', last: '最新价', 'minute-trade-through': '分钟线穿价' }[trade.fillBasis ?? ''] ?? ''}${trade.trigger ? ` · ${trade.trigger === 'stop-loss' ? '止损' : trade.trigger === 'take-profit' ? '止盈' : trade.trigger}` : ''}${trade.realizedPnl !== null && trade.realizedPnl !== undefined ? ` · 盈亏 ${num(trade.realizedPnl, 0)}` : ''}` })
    for (const order of account.orders.filter((entry) => entry.status === 'rejected' && isToday(entry.createdAt)))
      items.push({ at: order.createdAt, tone: 'bad', highlight: 'bad', title: `拦截 ${order.side === 'BUY' ? '买入' : '卖出'} ${order.name} ${order.quantity.toLocaleString('zh-CN')} 股`, detail: order.rejectReason })
    for (const change of account.changeLog.filter((entry) => isToday(entry.at)))
      items.push({ at: change.at, tone: 'accent', title: change.key === 'instruction' ? `你：${String(change.to)}` : `${changeLabel(change.key)} ${valueLabel(change.key, change.from)} → ${valueLabel(change.key, change.to)}`, sub: changedByLabel(change.by) + (change.reason ? ` · ${change.reason}` : '') })
    for (const event of account.events.filter((entry) => isToday(entry.at) && ['exit-deferred', 'suspended', 'risk-breaker', 'change-request', 'dividend', 'split'].includes(entry.type)))
      items.push({ at: event.at, tone: 'warn', highlight: 'warn', title: event.message })
    items.sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
    return { items, strategyRuns, day: today }
  }, [account, runs])
}

function Overview({ account, job }: { account: AccountDetail; job: Job | undefined }) {
  const runs = useRuns(account.id, { limit: 120 })
  const list = runs.data?.runs ?? []
  const { items, strategyRuns, day } = useTimeline(account, list)
  const isToday = day === new Date().toDateString()
  const dayLabel = isToday ? '今天' : new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', weekday: 'short' }).format(new Date(day))
  const live = list.find((run) => run.status === 'running' && run.lane === 'agent')
  const [selected, setSelected] = useState<string | null>(null)
  const focus = selected ?? live?.id ?? list.find((run) => run.lane === 'agent')?.id ?? null
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start gap-4">
        <Card className="flex min-w-0 max-w-[340px] flex-[1_1_280px] flex-col gap-1 p-4">
          <CardTitle extra={<span className="text-xs text-ink-3">复查 {list.filter((run) => run.lane === 'agent' && new Date(run.startedAt).toDateString() === day).length} · 成交 {account.trades.filter((trade) => new Date(trade.at).toDateString() === day).length} · 拦截 {account.orders.filter((order) => order.status === 'rejected' && new Date(order.createdAt).toDateString() === day).length}</span>}>{dayLabel}</CardTitle>
          <div className="mt-2 flex flex-col">
            {items.length ? items.map((item, index) => (
              <TimelineRow key={index} onClick={item.runId ? () => setSelected(item.runId!) : undefined}
                className={cn('-mx-2 flex gap-2.5 rounded-lg px-2 py-1.5 text-left', item.highlight === 'bad' && 'bg-bad-soft', item.highlight === 'warn' && 'bg-warn-soft', item.highlight === 'accent' && 'bg-accent-soft', item.runId && 'hover:ring-1 hover:ring-line-strong', item.runId === focus && 'ring-1 ring-accent-line')}>
                <span className="w-10 shrink-0 font-mono text-xs text-ink-3">{time(item.at)}</span>
                <span className={cn('mt-1.5 size-2 shrink-0 rounded-full', { ok: 'bg-ok', warn: 'bg-warn', bad: 'bg-bad', accent: 'bg-accent', muted: 'bg-line-strong', up: 'bg-up', down: 'bg-down' }[item.tone])} />
                <span className="min-w-0">
                  <span className={cn('block text-[13px] font-semibold', item.highlight === 'bad' && 'text-bad', item.highlight === 'warn' && 'text-warn-ink')}>{item.title}</span>
                  {item.detail && <span className="block break-words text-xs text-ink-2">{item.detail}</span>}
                  {item.sub && <span className="block text-xs text-ink-3">{item.sub}</span>}
                </span>
              </TimelineRow>
            )) : <div className="py-4 text-[13px] text-ink-3">还没有动作。</div>}
          </div>
          {(strategyRuns.length > 0 || job?.strategy) && <div className="mt-2 border-t border-line pt-2.5 text-xs text-ink-2">代码策略{job?.strategy ? `每 ${job.strategy.intervalMinutes} 分钟执行` : ''}：{dayLabel} {strategyRuns.length} 次，0 token{strategyRuns.some((run) => run.status === 'failed') ? `，失败 ${strategyRuns.filter((run) => run.status === 'failed').length} 次` : ''}</div>}
        </Card>

        <Conversation account={account} runs={list} focus={focus} onFocus={setSelected} />

        <aside aria-label="组合" className="flex min-w-0 max-w-[400px] flex-[1_1_340px] flex-col gap-4">
          <Portfolio account={account} />
          <Holdings account={account} />
        </aside>
      </div>
      {focus && <RunProcess runId={focus} run={list.find((run) => run.id === focus)} />}
    </div>
  )
}

// Run entries open their process below; other entries are plain rows (not disabled buttons).
function TimelineRow({ onClick, className, children }: { onClick?: () => void; className: string; children: ReactNode }) {
  return onClick ? <button type="button" onClick={onClick} className={className}>{children}</button> : <div className={className}>{children}</div>
}

function Conversation({ account, runs, focus, onFocus }: { account: AccountDetail; runs: Run[]; focus: string | null; onFocus: (id: string) => void }) {
  const [text, setText] = useState('')
  const [days, setDays] = useState('3')
  const add = useAction<{ text: string; days: number }>(`/api/arena/accounts/${account.id}/instructions`, { invalidate: [['account', account.id]], success: '已存成指令，之后每次复查都会带上' })
  const revoke = useAction<{ id: string }>((input) => `/api/arena/accounts/${account.id}/instructions/${input.id}/revoke`, { invalidate: [['account', account.id]], success: '已撤销' })
  const agentRuns = runs.filter((run) => run.lane === 'agent' && run.status !== 'skipped').slice(0, 12).reverse()
  const instructions = account.changeLog.filter((change) => change.key === 'instruction').slice(0, 10)
  const messages = [
    ...agentRuns.map((run) => ({ kind: 'agent' as const, at: run.startedAt, run })),
    ...instructions.map((change) => ({ kind: 'owner' as const, at: change.at, text: String(change.to), active: account.instructions.find((entry) => entry.text === change.to) })),
  ].sort((a, b) => Date.parse(a.at) - Date.parse(b.at)).slice(-16)
  return (
    <Card className="flex min-w-0 flex-[999_1_420px] flex-col">
      <div className="flex items-center gap-2 border-b border-line px-4 py-3.5">
        <CardTitle>跟交易员说话</CardTitle>
        <span className="text-xs text-ink-3">指令在有效期内每次复查都会带上，报告里要回应</span>
      </div>
      <div className="flex max-h-[640px] flex-1 flex-col gap-4 overflow-y-auto p-4 scroll-thin">
        {messages.length ? messages.map((message, index) => message.kind === 'owner' ? (
          <div key={index} className="flex justify-end">
            <div className="flex max-w-[75%] flex-col items-end gap-1.5">
              <div className="text-xs text-ink-3">你 · {dateTime(message.at)}</div>
              <div className="rounded-[12px_12px_4px_12px] bg-accent-soft px-3 py-2.5 text-[#1e1b4b] dark:text-accent-ink">{message.text}</div>
              {message.active ? (
                <span className="flex items-center gap-2 rounded-full border border-accent-line bg-surface px-2 py-0.5 text-xs text-accent-ink">有效到 {dateTime(message.active.expiresAt)}<button type="button" className="underline" onClick={() => revoke.mutate({ id: message.active!.id })}>撤销</button></span>
              ) : <span className="text-xs text-ink-3">已过期或已撤销</span>}
            </div>
          </div>
        ) : (
          <div key={index} className="flex gap-2.5">
            <AgentMark kind={message.run.runner === 'acp' ? 'acp' : message.run.runner} size={28} />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2 text-xs text-ink-3">
                <span>交易员{message.run.backupFor ? `（备用 ${AGENT_NAME[message.run.runner] ?? message.run.runner} 代班）` : ''} · {dateTime(message.run.startedAt)} {message.run.trigger === 'manual' ? '手动复查' : '复查'}</span>
                {message.run.status !== 'ok' && <Pill tone={message.run.status === 'running' ? 'accent' : message.run.status === 'no-round' ? 'warn' : 'bad'}>{RUN_STATUS[message.run.status] ?? message.run.status}</Pill>}
                <button type="button" onClick={() => onFocus(message.run.id)} className={cn('underline-offset-2 hover:underline', focus === message.run.id && 'text-accent-ink')}>看过程</button>
              </div>
              <p className="m-0 mt-1 whitespace-pre-wrap break-words text-[14px]">{message.run.status === 'running' ? '正在复查…' : (message.run.stdoutTail ?? '').trim().slice(-900) || message.run.error || '（没有文字输出）'}</p>
            </div>
          </div>
        )) : <Empty title="还没有对话">交易员每次复查后，它的结论会出现在这里。你也可以先给它下一条指令。</Empty>}
      </div>
      <form className="flex flex-col gap-2 border-t border-line p-4" onSubmit={(event) => { event.preventDefault(); if (text.trim()) add.mutate({ text: text.trim(), days: Number(days) }, { onSuccess: () => setText('') }) }}>
        <div className="flex items-end gap-2.5 rounded-xl border border-line-strong p-2.5 pl-3.5">
          <Textarea rows={2} value={text} onChange={(event) => setText(event.target.value)} placeholder="例如：这周不碰半导体；仓位降到 60% 以下" aria-label="给交易员下指令" className="border-0 p-0 focus:border-0" maxLength={500} />
          <Select aria-label="有效期" value={days} onChange={(event) => setDays(event.target.value)} className="w-28 shrink-0">
            <option value="0.5">半天</option><option value="1">1 天</option><option value="3">3 天</option><option value="7">1 周</option><option value="30">1 个月</option>
          </Select>
          <Button type="submit" variant="primary" aria-label="发送指令" loading={add.isPending} className="size-9 shrink-0 p-0"><Send className="size-4" /></Button>
        </div>
        <span className="text-xs text-ink-3">现在只能下指令；向交易员提问（不触发交易）放在第 2 期。</span>
      </form>
    </Card>
  )
}

function Portfolio({ account }: { account: AccountDetail }) {
  const m = account.metrics
  const status = account.limitStatus
  const minCash = typeof account.limits.minCashPct === 'number' ? account.limits.minCashPct : null
  const others = status?.active.filter((key) => key !== 'minCashPct') ?? []
  return (
    <Card className="flex flex-col gap-3 p-4">
      <div className="flex items-baseline gap-2.5">
        <div className="flex-1">
          <div className="text-xs text-ink-3">总资产（模拟）</div>
          <div className="font-mono text-[26px] font-medium tabular">{money(m.equity, account.currency)}</div>
        </div>
        <div className="text-right">
          <Signed value={m.totalReturnPct} className="text-[15px]" />
          <div className="text-xs text-ink-3">今日 <Signed value={m.todayReturnPct} /></div>
        </div>
      </div>
      <div className="text-xs text-ink-2">vs {BENCHMARK_NAME[account.market]} 超额 <Signed value={m.excessReturnPct} /> · {m.tradingDays} 个交易日{m.sampleWarning ? ' · 样本还少' : ''}</div>
      <div className="flex flex-col gap-1.5 border-t border-line pt-3">
        <div className="flex text-[13px]"><span className="flex-1 font-semibold">现金 {status ? `${num(status.cashPct, 0)}%` : '—'}</span>{minCash !== null && <span className="text-ink-2">保留 {minCash}% · 还能买 {money(status?.buyableValue, account.currency)}</span>}</div>
        <div aria-hidden className="relative h-2 rounded-full bg-sunken">
          <span className="absolute inset-y-0 left-0 rounded-full bg-accent" style={{ width: `${Math.min(100, Math.max(0, status?.cashPct ?? 0))}%` }} />
          {minCash !== null && <span className="absolute -inset-y-[3px] w-0.5 bg-ink" style={{ left: `${minCash}%` }} />}
        </div>
        <div className="text-xs text-ink-3">{others.length ? `另有 ${others.length} 条边界在生效` : '其他边界都没开'}{status?.positionsLeft !== undefined ? ` · 还能再开 ${status.positionsLeft} 只` : ''} · <Link to="/traders/$id" params={{ id: account.id }} search={{ tab: 'settings' }}>去设置</Link></div>
      </div>
      {account.risk?.breaker && <div className="rounded-lg bg-bad-soft px-3 py-2 text-xs text-bad">回撤熔断已触发（{account.risk.breaker.drawdownPct}%），禁止新买入</div>}
    </Card>
  )
}

function Holdings({ account }: { account: AccountDetail }) {
  const today = new Date().toISOString().slice(0, 10)
  return (
    <Card className="flex flex-col gap-2.5 p-4">
      <CardTitle extra={<><span className="font-mono text-xs text-ink-3">{account.positions.length}</span><span className="ml-auto text-xs text-ink-3">委托 {account.openOrders.length} · 今日成交 {account.metrics.todayFills ?? 0}</span></>}>持仓</CardTitle>
      {account.positions.length ? (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-[13px]">
            <thead><tr className="text-left text-xs text-ink-3"><th className="py-1 font-medium">股票</th><th className="text-right font-medium">仓位</th><th className="text-right font-medium">盈亏</th><th className="text-right font-medium">止损</th></tr></thead>
            <tbody>
              {account.positions.map((position) => {
                const near = position.exitLevels?.stopLoss && position.lastPrice <= position.exitLevels.stopLoss * 1.02
                const lockedToday = account.market === 'A' && position.lots?.some((lot) => lot.date === today)
                return (
                  <tr key={position.symbol} className={cn('border-t border-line', near && 'bg-bad-soft')}>
                    <td className="py-1.5"><div className="font-semibold">{position.name}</div><div className="font-mono text-[11px] text-ink-3">{position.symbol.replace(/\.(SS|SZ)$/, '')}{near ? ' · 接近止损' : lockedToday ? ' · 今日买入 T+1' : ''}</div></td>
                    <td className="text-right font-mono">{num(position.weightPct, 1)}%</td>
                    <td className="text-right"><Signed value={position.unrealizedPnlPct} digits={1} /></td>
                    <td className={cn('text-right font-mono', near ? 'text-bad' : 'text-ink-2')}>{position.exitLevels?.stopLoss ? num(position.exitLevels.stopLoss, 2) : '—'}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      ) : <div className="text-[13px] text-ink-3">空仓。</div>}
    </Card>
  )
}

function RunProcess({ runId, run }: { runId: string; run: Run | undefined }) {
  const events = useRunEvents(runId, run?.status === 'running')
  const list = (events.data?.events ?? []).filter((event) => ['tool', 'tool_result', 'text', 'error', 'usage'].includes(event.t))
  const results = new Map(list.filter((event) => event.t === 'tool_result').map((event) => [(event as RunEvent & { id?: string }).id, event]))
  return (
    <Card className="p-4">
      <CardTitle extra={run && <span className="text-xs text-ink-3">{AGENT_NAME[run.runner] ?? run.runner} · {dateTime(run.startedAt)} · {RUN_STATUS[run.status] ?? run.status}{run.usage ? ` · ${compact(run.usage.inputTokens)} 入 / ${compact(run.usage.outputTokens)} 出 tokens${run.usage.costUsd ? ` · $${run.usage.costUsd.toFixed(2)}` : ''}` : ''}{run.durationMs ? ` · ${Math.round(run.durationMs / 1000)}s` : ''}</span>}>本次复查过程</CardTitle>
      {events.isLoading ? <Spinner className="mt-3" /> : list.length ? (
        <ol className="mt-3 flex flex-col overflow-hidden rounded-[10px] border border-line">
          {list.filter((event) => event.t !== 'tool_result').map((event, index) => {
            const result = event.t === 'tool' ? results.get((event as RunEvent & { id?: string }).id) : undefined
            return (
              <li key={index} className="flex items-start gap-2 border-b border-line bg-surface-2 px-3 py-2 text-[13px] last:border-b-0">
                {event.t === 'tool' ? <Dot tone={result ? (result.ok ? 'ok' : 'bad') : 'accent'} pulse={!result && run?.status === 'running'} /> : event.t === 'error' ? <Dot tone="bad" /> : event.t === 'usage' ? <Dot tone="muted" /> : <Dot tone="accent" />}
                <span className="min-w-0 flex-1">
                  {event.t === 'tool' && <><span className="font-mono text-xs">{String(event.name ?? '').replace('mcp__hrouter_market_pulse__', '')}</span> <span className="font-mono text-xs text-ink-3">{JSON.stringify(event.input ?? {}).slice(0, 120)}</span>{result?.preview && <span className="mt-0.5 block truncate text-xs text-ink-3">{result.preview}</span>}</>}
                  {event.t === 'text' && <span className="whitespace-pre-wrap break-words">{event.text}</span>}
                  {event.t === 'error' && <span className="text-bad">{event.message}</span>}
                  {event.t === 'usage' && <span className="text-xs text-ink-3">用量 {compact(event.inputTokens)} 入 / {compact(event.outputTokens)} 出{event.costUsd ? ` · $${event.costUsd.toFixed(2)}` : ''}</span>}
                </span>
                <span className="font-mono text-[11px] text-ink-3">{time(event.at)}</span>
              </li>
            )
          })}
        </ol>
      ) : <div className="mt-3 text-[13px] text-ink-3">{run?.status === 'running' ? '等第一条事件…' : run?.error ? <span className="text-bad">{run.error}</span> : '这一轮没有记录过程（旧版本的运行只保存了输出结尾）。'}{run && !list.length && run.stdoutTail && <pre className="mt-2 max-h-60 overflow-auto whitespace-pre-wrap rounded-lg bg-surface-2 p-3 font-mono text-xs scroll-thin">{run.stdoutTail}</pre>}</div>}
      {run && ago(run.startedAt) && null}
    </Card>
  )
}
