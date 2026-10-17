import { useMemo, useState, type ReactNode } from 'react'
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router'
import { ChevronLeft, Send, X } from 'lucide-react'
import type { AccountDetail, Job, Message, Run, RunEvent } from '@/lib/api'
import { AGENT_NAME, agentKind, AUTONOMY_NAME, BENCHMARK_NAME, changeLabel, changedByLabel, compact, dateTime, FAILURE_KIND, MARKET_NAME, money, num, RUN_STATUS, SIDE_NAME, TEAM_ROLE, time, valueLabel } from '@/lib/format'
import { locale, t } from '@/lib/i18n'
import { useAccount, useAction, useJob, useRunEvents, useRuns } from '@/lib/queries'
import { ApprovalCard, jobState } from '@/components/trader-bits'
import { AgentMark, Button, Card, CardTitle, Dot, Empty, ErrorNote, Pill, Segmented, Select, Signed, Spinner, Tabs, Textarea, cn } from '@/components/ui'
import { Expandable } from '@/components/Expandable'
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
  if (account.error || !account.data) return <div className="p-8"><ErrorNote error={account.error ?? t('找不到这个交易员')} /></div>
  const data = account.data
  return (
    <div className="flex min-h-full flex-col">
      <TraderHeader account={data} job={job} />
      <div className="overflow-x-auto border-b border-line bg-surface px-6 max-sm:px-3">
        <Tabs value={tab} onChange={setTab} items={[
          { id: 'overview', label: t('概览'), count: data.pendingApprovals ? `· ${data.pendingApprovals}` : undefined },
          { id: 'strategy', label: t('策略') },
          { id: 'settings', label: t('设置') },
          { id: 'reports', label: t('报告'), count: data.metrics.reportsPublished },
          { id: 'orders', label: t('委托与成交') },
          { id: 'changes', label: t('修改记录'), count: data.pendingRequests ? t('· {n} 待处理', { n: data.pendingRequests }) : undefined },
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
  const run = useAction<{ lane?: string }>(`/api/arena/schedules/${account.id}/run`, { invalidate: [['schedules'], ['runs', account.id]], success: (result: unknown) => ((result as { status: string }).status === 'started' ? t('已开始，过程会实时显示在概览里') : t('正在运行，这次跳过')) })
  const toggle = useAction<Record<string, unknown>>(`/api/arena/schedules/${account.id}`, { invalidate: [['schedules']], success: t('已更新') })
  const strategy = job?.strategy || job?.runner.type === 'strategy'
  const agent = job && job.runner.type !== 'strategy'
  const autonomy = account.autonomy?.level ?? 'full'
  return (
    <div className="flex flex-wrap items-center gap-3.5 border-b border-line bg-surface px-6 pb-3 pt-4 max-sm:px-3">
      <Link to="/traders" aria-label={t('返回交易员列表')} className="flex size-9 items-center justify-center rounded-[9px] border border-line text-ink-2"><ChevronLeft className="size-4" /></Link>
      <AgentMark kind={agentKind(account)} size={40} />
      <div className="min-w-0 flex-[1_1_280px]">
        <h1 className="m-0 truncate text-xl font-bold leading-snug">{account.name}</h1>
        <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-ink-2">
          <span className="font-mono">{account.model}</span>
          {job?.backup && <><span>·</span><span>{t('备用 {agent}', { agent: AGENT_NAME[job.backup.type] ?? job.backup.type })}{job.backup.model ? ` ${job.backup.model}` : ''}</span></>}
          <span>·</span><span>{MARKET_NAME[account.market]}</span>
          {account.template && <><span>·</span><span>{t('模板 {id}', { id: account.template })}</span></>}
          <span>·</span><span>{job?.mode === 'director' || job?.strategy ? t('Agent 主控') : job?.runner.type === 'strategy' ? t('纯代码策略') : t('全托管轮次')}</span>
          {job?.team?.enabled && <><span>·</span><span>{t('团队模式')}</span></>}
          {agent && <><span>·</span><Pill tone={autonomy === 'full' ? 'neutral' : 'accent'}>{AUTONOMY_NAME[autonomy]}</Pill></>}
        </div>
      </div>
      <span className={cn('inline-flex max-w-full items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs', state.tone === 'bad' ? 'border-bad-line bg-bad-soft text-bad' : state.tone === 'warn' ? 'border-warn-line bg-warn-soft text-warn-ink' : state.tone === 'accent' ? 'border-accent-line bg-accent-soft text-accent-ink' : 'border-line bg-surface-2 text-ink-2')}>
        <Dot tone={state.tone} pulse={state.pulse} /><span className="truncate">{account.readonly ? t('正在回答你的问题') : state.text}</span>
      </span>
      {job && <Button onClick={() => toggle.mutate({ enabled: job.enabled === false })} loading={toggle.isPending}>{job.enabled === false ? t('启用') : t('暂停')}</Button>}
      {strategy && job?.runner.type !== 'strategy' && <Button onClick={() => run.mutate({ lane: 'strategy' })} loading={run.isPending && run.variables?.lane === 'strategy'}>{t('跑一次策略')}</Button>}
      {job && <Button variant="primary" onClick={() => run.mutate({})} loading={run.isPending && !run.variables?.lane}>{agent ? t('立即复查') : t('立即执行')}</Button>}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Overview: approvals, today's timeline, conversation, portfolio
// ---------------------------------------------------------------------------

type TimelineItem = { at: string; tone: 'ok' | 'warn' | 'bad' | 'accent' | 'muted' | 'up' | 'down'; title: string; detail?: string; sub?: string; highlight?: 'bad' | 'warn' | 'accent'; runId?: string }

const FILL_BASIS: Record<string, string> = { ask: t('卖一价'), bid: t('买一价'), book: t('逐档'), last: t('最新价'), 'minute-trade-through': t('分钟线穿价') }

// The latest day with any activity: today during the week, the last trading day on weekends.
function latestDay(account: AccountDetail, runs: Run[]) {
  const stamps = [...runs.map((run) => run.startedAt), ...account.trades.map((trade) => trade.at), ...account.orders.map((order) => order.createdAt)].filter(Boolean).map((at) => Date.parse(at)).filter(Number.isFinite)
  return stamps.length ? new Date(Math.max(...stamps)).toDateString() : new Date().toDateString()
}

function runTitle(run: Run) {
  const failed = ['failed', 'timeout'].includes(run.status)
  const what = run.lane === 'ask' ? t('回答你的问题') : run.lane === 'team' ? (TEAM_ROLE[run.role ?? ''] ?? t('团队分析')) : run.trigger === 'wake' ? t('提前复查') : t('复查')
  if (run.status === 'running') return t('{what}中…', { what })
  if (failed) return `${what} · ${t('失败')} · ${FAILURE_KIND[run.failure?.kind ?? 'other']}`
  if (run.status === 'skipped') return `${t('跳过')} · ${run.reason === 'queue-full' ? t('排队太久') : t('额度用尽')}`
  return `${what}${run.backupFor ? t(' · 备用代班') : ''}`
}

function useTimeline(account: AccountDetail, runs: Run[], job: Job | undefined) {
  return useMemo(() => {
    const today = latestDay(account, runs)
    const isToday = (at: string) => new Date(at).toDateString() === today
    const items: TimelineItem[] = []
    const strategyRuns = runs.filter((run) => run.lane === 'strategy' && isToday(run.startedAt))
    for (const run of runs.filter((entry) => ['agent', 'ask', 'team'].includes(entry.lane) && isToday(entry.startedAt))) {
      const failed = ['failed', 'timeout'].includes(run.status)
      items.push({
        at: run.startedAt, runId: run.id, tone: run.status === 'running' ? 'accent' : failed ? 'bad' : run.status === 'skipped' ? 'warn' : run.lane === 'team' ? 'muted' : 'ok',
        title: runTitle(run),
        detail: failed || run.status === 'skipped' ? (run.failure?.message ?? run.error ?? undefined) : run.trigger === 'wake' ? run.changes : undefined,
        sub: [AGENT_NAME[run.runner] ?? run.runner, run.usage ? `${compact(run.usage.inputTokens + run.usage.outputTokens)} tokens` : null, run.status === 'no-round' && run.lane === 'agent' ? t('没有记下这一轮') : null].filter(Boolean).join(' · '),
        highlight: run.status === 'running' ? 'accent' : failed ? 'bad' : run.status === 'skipped' ? 'warn' : undefined,
      })
    }
    for (const trade of account.trades.filter((entry) => isToday(entry.at)))
      items.push({ at: trade.at, tone: trade.side === 'BUY' ? 'up' : 'down', title: t('{side} {name} {qty} 股', { side: SIDE_NAME[trade.side], name: trade.name, qty: trade.quantity.toLocaleString(locale()) }), sub: `@ ${num(trade.price, trade.price < 1 ? 4 : 2)} ${FILL_BASIS[trade.fillBasis ?? ''] ?? ''}${trade.trigger ? ` · ${trade.trigger === 'stop-loss' ? t('止损') : trade.trigger === 'take-profit' ? t('止盈') : trade.trigger}` : ''}${trade.realizedPnl !== null && trade.realizedPnl !== undefined ? ` · ${t('盈亏 {n}', { n: num(trade.realizedPnl, 0) })}` : ''}` })
    for (const order of account.orders.filter((entry) => entry.status === 'rejected' && isToday(entry.createdAt)))
      items.push({ at: order.createdAt, tone: 'bad', highlight: 'bad', title: t('拦截 {side} {name} {qty} 股', { side: SIDE_NAME[order.side], name: order.name, qty: order.quantity.toLocaleString(locale()) }), detail: order.rejectReason })
    for (const change of account.changeLog.filter((entry) => isToday(entry.at)))
      items.push({ at: change.at, tone: 'accent', title: change.key === 'instruction' ? t('你：{text}', { text: String(change.to) }) : `${changeLabel(change.key)} ${valueLabel(change.key, change.from)} → ${valueLabel(change.key, change.to)}`, sub: changedByLabel(change.by) + (change.reason ? ` · ${change.reason}` : '') })
    for (const event of account.events.filter((entry) => isToday(entry.at) && ['exit-deferred', 'suspended', 'risk-breaker', 'change-request', 'dividend', 'split', 'approval-requested', 'approval-approved', 'approval-rejected'].includes(entry.type)))
      items.push({ at: event.at, tone: event.type.startsWith('approval') ? 'accent' : 'warn', highlight: event.type === 'approval-requested' ? 'accent' : event.type.startsWith('approval') ? undefined : 'warn', title: event.message })
    items.sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
    const gate = job?.gateToday && new Date(job.gateToday.date).toDateString() === today ? job.gateToday : null
    return { items, strategyRuns, day: today, gate }
  }, [account, runs, job])
}

function Overview({ account, job }: { account: AccountDetail; job: Job | undefined }) {
  const runs = useRuns(account.id, { limit: 150 })
  const list = runs.data?.runs ?? []
  const { items, strategyRuns, day, gate } = useTimeline(account, list, job)
  const isToday = day === new Date().toDateString()
  const dayLabel = isToday ? t('今天') : new Intl.DateTimeFormat(locale(), { month: 'numeric', day: 'numeric', weekday: 'short' }).format(new Date(day))
  const live = list.find((run) => run.status === 'running' && run.lane !== 'strategy')
  const [selected, setSelected] = useState<string | null>(null)
  const focus = selected ?? live?.id ?? list.find((run) => run.lane === 'agent')?.id ?? null
  const pending = (account.approvals ?? []).filter((entry) => entry.status === 'pending')
  return (
    <div className="flex flex-col gap-4">
      {pending.length > 0 && (
        <div className="grid grid-cols-[repeat(auto-fit,minmax(min(380px,100%),1fr))] gap-4">
          {pending.map((approval) => <ApprovalCard key={approval.id} approval={approval} account={account} />)}
        </div>
      )}
      <div className="flex flex-wrap items-start gap-4">
        <Card className="flex min-w-0 flex-[1_1_280px] flex-col gap-1 p-4 lg:max-w-[340px]">
          <CardTitle extra={<span className="text-xs text-ink-3">{t('复查 {a} · 成交 {b} · 拦截 {c}', { a: list.filter((run) => run.lane === 'agent' && new Date(run.startedAt).toDateString() === day).length, b: account.trades.filter((trade) => new Date(trade.at).toDateString() === day).length, c: account.orders.filter((order) => order.status === 'rejected' && new Date(order.createdAt).toDateString() === day).length })}</span>}>{dayLabel}</CardTitle>
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
            )) : <div className="py-4 text-[13px] text-ink-3">{t('还没有动作。')}</div>}
          </div>
          {(gate?.skipped || gate?.wakes) ? (
            <div className="mt-2 border-t border-line pt-2.5 text-xs text-ink-2">
              {t('脚本先看：无变化跳过 {s} 次，提前叫醒 {w} 次', { s: gate.skipped ?? 0, w: gate.wakes ?? 0 })}
            </div>
          ) : null}
          {(strategyRuns.length > 0 || job?.strategy) && <div className="mt-2 border-t border-line pt-2.5 text-xs text-ink-2">{t('代码策略')}{job?.strategy ? t('每 {n} 分钟执行', { n: job.strategy.intervalMinutes }) : ''}{t('：{day} {n} 次', { day: dayLabel, n: strategyRuns.length })}{strategyRuns.some((run) => run.status === 'failed') ? t('，失败 {n} 次', { n: strategyRuns.filter((run) => run.status === 'failed').length }) : ''}</div>}
        </Card>

        <Conversation account={account} runs={list} focus={focus} onFocus={setSelected} job={job} />

        <aside aria-label={t('组合')} className="flex min-w-0 flex-[1_1_340px] flex-col gap-4 lg:max-w-[400px]">
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

type Mode = 'instruction' | 'question' | 'rule'

function Conversation({ account, runs, focus, onFocus, job }: { account: AccountDetail; runs: Run[]; focus: string | null; onFocus: (id: string) => void; job: Job | undefined }) {
  const [text, setText] = useState('')
  const [days, setDays] = useState('3')
  const [mode, setMode] = useState<Mode>('question')
  const invalidate = [['account', account.id], ['runs', account.id]]
  const instruct = useAction<{ text: string; days: number }>(`/api/arena/accounts/${account.id}/instructions`, { invalidate, success: t('已存成指令，之后每次复查都会带上') })
  const ask = useAction<{ text: string }, { status: string }>(`/api/arena/accounts/${account.id}/messages`, { invalidate, success: (result) => (result.status === 'started' ? t('已发给交易员，回答会出现在这里') : t('交易员正在忙，空下来就回答')) })
  const addRule = useAction<{ text: string }>(`/api/arena/accounts/${account.id}/rules`, { invalidate, success: t('已加为长期规则，从下一轮起每次都要遵守') })
  const revoke = useAction<{ id: string }>((input) => `/api/arena/accounts/${account.id}/instructions/${input.id}/revoke`, { invalidate, success: t('已撤销') })
  const revokeRule = useAction<{ id: string }>((input) => `/api/arena/accounts/${account.id}/rules/${input.id}/revoke`, { invalidate, success: t('已删除这条规则') })
  const agentRuns = runs.filter((run) => run.lane === 'agent' && run.status !== 'skipped').slice(0, 12).reverse()
  const instructions = account.changeLog.filter((change) => change.key === 'instruction').slice(0, 10)
  const questions = account.messages ?? []
  const answers = new Map(questions.filter((message) => message.kind === 'answer' && message.replyTo).map((message) => [message.replyTo!, message]))
  type Entry = { kind: 'agent'; at: string; run: Run } | { kind: 'instruction'; at: string; text: string; active?: { id: string; expiresAt: string } } | { kind: 'question'; at: string; message: Message; answer?: Message }
  const entries: Entry[] = [
    ...agentRuns.map((run) => ({ kind: 'agent' as const, at: run.startedAt, run })),
    ...instructions.map((change) => ({ kind: 'instruction' as const, at: change.at, text: String(change.to), active: account.instructions.find((entry) => entry.text === change.to) })),
    ...questions.filter((message) => message.kind === 'question').map((message) => ({ kind: 'question' as const, at: message.at, message, answer: answers.get(message.id) })),
  ].sort((a, b) => Date.parse(a.at) - Date.parse(b.at)).slice(-20)
  const canAsk = job && job.runner.type !== 'strategy'
  const busy = instruct.isPending || ask.isPending || addRule.isPending
  const submit = () => {
    const value = text.trim()
    if (!value) return
    const done = { onSuccess: () => setText('') }
    if (mode === 'instruction') instruct.mutate({ text: value, days: Number(days) }, done)
    else if (mode === 'question') ask.mutate({ text: value }, done)
    else addRule.mutate({ text: value }, done)
  }
  const placeholder = { instruction: t('例如：这周不碰半导体；仓位降到 60% 以下'), question: t('例如：为什么昨天买了招商银行？现在最担心哪只？'), rule: t('例如：当日涨幅超过 5% 的不追') }[mode]
  const hint = { instruction: t('指令在有效期内每次复查都会带上，报告里要回应。'), question: t('提问不触发交易：交易员只读地查自己的记录来回答。'), rule: t('长期规则一直生效，直到你删掉；交易员也可以提议规则，等你确认。') }[mode]
  return (
    <Card className="flex min-w-0 flex-[999_1_420px] flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3.5">
        <CardTitle>{t('跟交易员说话')}</CardTitle>
        <span className="text-xs text-ink-3">{hint}</span>
      </div>
      {(account.rules ?? []).length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 border-b border-line px-4 py-2.5">
          <span className="text-xs text-ink-3">{t('长期规则')}</span>
          {account.rules!.map((rule) => (
            <span key={rule.id} className="inline-flex items-center gap-1 rounded-full border border-accent-line bg-accent-soft py-0.5 pl-2.5 pr-1 text-xs text-accent-ink">
              {rule.text}
              <button type="button" aria-label={t('删除规则「{text}」', { text: rule.text })} onClick={() => revokeRule.mutate({ id: rule.id })} className="rounded-full p-0.5 hover:bg-surface"><X className="size-3" /></button>
            </span>
          ))}
        </div>
      )}
      <div className="flex max-h-[640px] min-h-[200px] flex-1 flex-col gap-4 overflow-y-auto p-4 scroll-thin">
        {entries.length ? entries.map((entry, index) => {
          if (entry.kind === 'instruction') return (
            <OwnerBubble key={index} at={entry.at} label={t('指令')} text={entry.text}>
              {entry.active ? (
                <span className="flex items-center gap-2 rounded-full border border-accent-line bg-surface px-2 py-0.5 text-xs text-accent-ink">{t('有效到 {time}', { time: dateTime(entry.active.expiresAt) })}<button type="button" className="underline" onClick={() => revoke.mutate({ id: entry.active!.id })}>{t('撤销')}</button></span>
              ) : <span className="text-xs text-ink-3">{t('已过期或已撤销')}</span>}
            </OwnerBubble>
          )
          if (entry.kind === 'question') return (
            <div key={index} className="flex flex-col gap-3">
              <OwnerBubble at={entry.at} label={t('提问')} text={entry.message.text} />
              <TraderBubble kind={job?.runner.type} at={entry.answer?.at ?? null} label={t('回答')} status={entry.message.status === 'open' ? 'running' : entry.message.status === 'failed' ? 'failed' : 'ok'}
                text={entry.answer?.text ?? (entry.message.status === 'open' ? t('正在查记录回答…') : '')} onProcess={entry.message.status !== 'open' && entry.answer?.runId ? () => onFocus(entry.answer!.runId!) : undefined} focused={focus === entry.answer?.runId} />
            </div>
          )
          const run = entry.run
          return (
            <TraderBubble key={index} kind={run.runner === 'acp' ? 'acp' : run.runner} at={run.startedAt}
              label={`${run.trigger === 'manual' ? t('手动复查') : run.trigger === 'wake' ? t('提前复查') : t('复查')}${run.backupFor ? t('（备用 {agent} 代班）', { agent: AGENT_NAME[run.runner] ?? run.runner }) : ''}`}
              status={run.status} text={run.status === 'running' ? t('正在复查…') : (run.stdoutTail ?? '').trim().slice(-900) || run.error || t('（没有文字输出）')}
              onProcess={() => onFocus(run.id)} focused={focus === run.id} note={run.team?.length ? t('团队 {n} 份报告', { n: run.team.length }) : run.changes ? t('变化：{text}', { text: run.changes.slice(0, 80) }) : undefined} />
          )
        }) : <Empty title={t('还没有对话')}>{t('交易员每次复查后，它的结论会出现在这里。你可以先问它一个问题，或给它下一条指令。')}</Empty>}
      </div>
      <form className="flex flex-col gap-2 border-t border-line p-4" onSubmit={(event) => { event.preventDefault(); submit() }}>
        <Segmented size="sm" label={t('发送方式')} value={mode} onChange={setMode} options={[['question', t('提问')], ['instruction', t('指令')], ['rule', t('长期规则')]]} />
        <div className="flex items-end gap-2.5 rounded-xl border border-line-strong p-2.5 pl-3.5 focus-within:border-accent">
          <Textarea rows={2} value={text} onChange={(event) => setText(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); submit() } }} placeholder={placeholder} aria-label={{ instruction: t('给交易员下指令'), question: t('向交易员提问'), rule: t('加一条长期规则') }[mode]} className="border-0 p-0 focus:border-0" maxLength={mode === 'rule' ? 300 : 1000} />
          {mode === 'instruction' && (
            <Select aria-label={t('有效期')} value={days} onChange={(event) => setDays(event.target.value)} className="w-28 shrink-0">
              <option value="0.5">{t('半天')}</option><option value="1">{t('1 天')}</option><option value="3">{t('3 天')}</option><option value="7">{t('1 周')}</option><option value="30">{t('1 个月')}</option>
            </Select>
          )}
          <Button type="submit" variant="primary" aria-label={t('发送')} loading={busy} disabled={mode === 'question' && !canAsk} className="size-9 shrink-0 p-0"><Send className="size-4" /></Button>
        </div>
        {mode === 'question' && !canAsk && <span className="text-xs text-warn-ink">{t('纯代码策略不能回答问题；给它配一个 Agent 才能提问。')}</span>}
      </form>
    </Card>
  )
}

function OwnerBubble({ at, label, text, children }: { at: string; label: string; text: string; children?: ReactNode }) {
  return (
    <div className="flex justify-end">
      <div className="flex max-w-[80%] flex-col items-end gap-1.5">
        <div className="text-xs text-ink-3">{t('你')} · {label} · {dateTime(at)}</div>
        <div className="whitespace-pre-wrap break-words rounded-[12px_12px_4px_12px] bg-accent-soft px-3 py-2.5 text-accent-ink">{text}</div>
        {children}
      </div>
    </div>
  )
}

function TraderBubble({ kind, at, label, status, text, onProcess, focused, note }: { kind: string | undefined; at: string | null; label: string; status: string; text: string; onProcess?: () => void; focused?: boolean; note?: string }) {
  return (
    <div className="flex gap-2.5">
      <AgentMark kind={kind} size={28} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2 text-xs text-ink-3">
          <span>{t('交易员')} · {label}{at ? ` · ${dateTime(at)}` : ''}</span>
          {status !== 'ok' && <Pill tone={status === 'running' ? 'accent' : status === 'no-round' ? 'warn' : 'bad'}>{RUN_STATUS[status] ?? status}</Pill>}
          {note && <span className="truncate text-ink-3">{note}</span>}
          {onProcess && <button type="button" onClick={onProcess} className={cn('underline-offset-2 hover:underline', focused && 'text-accent-ink')}>{t('看过程')}</button>}
        </div>
        <p className="m-0 mt-1 whitespace-pre-wrap break-words text-[14px]">{text}</p>
      </div>
    </div>
  )
}

function Portfolio({ account }: { account: AccountDetail }) {
  const m = account.metrics
  const status = account.limitStatus
  const minCash = typeof account.limits.minCashPct === 'number' ? account.limits.minCashPct : null
  const industryCap = typeof account.limits.maxIndustryPct === 'number' ? account.limits.maxIndustryPct : null
  const others = status?.active.filter((key) => key !== 'minCashPct') ?? []
  return (
    <Card className="flex flex-col gap-3 p-4">
      <div className="flex items-baseline gap-2.5">
        <div className="flex-1">
          <div className="text-xs text-ink-3">{t('总资产（模拟）')}</div>
          <div className="font-mono text-[26px] font-medium tabular">{money(m.equity, account.currency)}</div>
        </div>
        <div className="text-right">
          <Signed value={m.totalReturnPct} className="text-[15px]" />
          <div className="text-xs text-ink-3">{t('今日')} <Signed value={m.todayReturnPct} /></div>
        </div>
      </div>
      <div className="text-xs text-ink-2">{t('vs {benchmark} 超额', { benchmark: BENCHMARK_NAME[account.market] })} <Signed value={m.excessReturnPct} /> · {t('{n} 个交易日', { n: m.tradingDays })}{m.sampleWarning ? t(' · 样本还少') : ''}</div>
      <div className="flex flex-col gap-1.5 border-t border-line pt-3">
        <div className="flex flex-wrap gap-x-2 text-[13px]"><span className="flex-1 font-semibold">{t('现金 {pct}', { pct: status ? `${num(status.cashPct, 0)}%` : '—' })}</span>{minCash !== null && <span className="text-ink-2">{t('保留 {pct}% · 还能买 {value}', { pct: minCash, value: money(status?.buyableValue, account.currency) })}</span>}</div>
        <div aria-hidden className="relative h-2 rounded-full bg-sunken">
          <span className="absolute inset-y-0 left-0 rounded-full bg-accent" style={{ width: `${Math.min(100, Math.max(0, status?.cashPct ?? 0))}%` }} />
          {minCash !== null && <span className="absolute -inset-y-[3px] w-0.5 bg-ink" style={{ left: `${minCash}%` }} />}
        </div>
        <div className="text-xs text-ink-3">{others.length ? t('另有 {n} 条边界在生效', { n: others.length }) : t('其他边界都没开')}{status?.positionsLeft !== undefined ? t(' · 还能再开 {n} 只', { n: status.positionsLeft }) : ''} · <Link to="/traders/$id" params={{ id: account.id }} search={{ tab: 'settings' }}>{t('去设置')}</Link></div>
      </div>
      {status?.industries?.length ? (
        <div className="flex flex-col gap-1.5 border-t border-line pt-3">
          <div className="flex text-xs text-ink-3"><span className="flex-1">{t('行业分布')}</span>{industryCap !== null && <span>{t('单行业上限 {pct}%', { pct: industryCap })}</span>}</div>
          {status.industries.slice(0, 5).map((entry) => (
            <div key={entry.industry} className="flex items-center gap-2 text-xs">
              <span className="w-20 shrink-0 truncate">{entry.industry}</span>
              <span aria-hidden className="relative h-1.5 flex-1 rounded-full bg-sunken">
                <span className={cn('absolute inset-y-0 left-0 rounded-full', industryCap !== null && entry.pct >= industryCap * 0.9 ? 'bg-warn' : 'bg-accent')} style={{ width: `${Math.min(100, entry.pct)}%` }} />
              </span>
              <span className="w-12 shrink-0 text-right font-mono">{num(entry.pct, 1)}%</span>
            </div>
          ))}
        </div>
      ) : null}
      {account.risk?.breaker && <div className="rounded-lg bg-bad-soft px-3 py-2 text-xs text-bad">{t('回撤熔断已触发（{pct}%），禁止新买入', { pct: account.risk.breaker.drawdownPct })}</div>}
    </Card>
  )
}

function Holdings({ account }: { account: AccountDetail }) {
  const today = new Date().toISOString().slice(0, 10)
  return (
    <Card className="flex flex-col gap-2.5 p-4">
      <CardTitle extra={<><span className="font-mono text-xs text-ink-3">{account.positions.length}</span><span className="ml-auto text-xs text-ink-3">{t('委托 {a} · 今日成交 {b}', { a: account.openOrders.length, b: account.metrics.todayFills ?? 0 })}</span></>}>{t('持仓')}</CardTitle>
      {account.positions.length ? (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-[13px]">
            <thead><tr className="text-left text-xs text-ink-3"><th className="py-1 font-medium">{t('股票')}</th><th className="text-right font-medium">{t('仓位')}</th><th className="text-right font-medium">{t('盈亏')}</th><th className="text-right font-medium">{t('止损')}</th></tr></thead>
            <tbody>
              {account.positions.map((position) => {
                const near = position.exitLevels?.stopLoss && position.lastPrice <= position.exitLevels.stopLoss * 1.02
                const lockedToday = account.market === 'A' && position.lots?.some((lot) => lot.date === today)
                return (
                  <tr key={position.symbol} className={cn('border-t border-line', near && 'bg-bad-soft')}>
                    <td className="py-1.5"><div className="font-semibold">{position.name}</div><div className="font-mono text-[11px] text-ink-3">{position.symbol.replace(/\.(SS|SZ)$/, '')}{near ? t(' · 接近止损') : lockedToday ? t(' · 今日买入 T+1') : ''}</div></td>
                    <td className="text-right font-mono">{num(position.weightPct, 1)}%</td>
                    <td className="text-right"><Signed value={position.unrealizedPnlPct} digits={1} /></td>
                    <td className={cn('text-right font-mono', near ? 'text-bad' : 'text-ink-2')}>{position.exitLevels?.stopLoss ? num(position.exitLevels.stopLoss, 2) : '—'}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      ) : <div className="text-[13px] text-ink-3">{t('空仓。')}</div>}
    </Card>
  )
}

function RunProcess({ runId, run }: { runId: string; run: Run | undefined }) {
  const events = useRunEvents(runId, run?.status === 'running')
  const list = (events.data?.events ?? []).filter((event) => ['tool', 'tool_result', 'text', 'error', 'usage'].includes(event.t))
  const results = new Map(list.filter((event) => event.t === 'tool_result').map((event) => [(event as RunEvent & { id?: string }).id, event]))
  const title = !run ? t('运行过程') : run.lane === 'ask' ? t('回答问题的过程') : run.lane === 'team' ? t('{role}的过程', { role: TEAM_ROLE[run.role ?? ''] ?? t('团队分析') }) : t('本次复查过程')
  return (
    <Expandable title={title}>
      <Card className="p-4">
        <CardTitle extra={run && <span className="text-xs text-ink-3">{AGENT_NAME[run.runner] ?? run.runner} · {dateTime(run.startedAt)} · {RUN_STATUS[run.status] ?? run.status}{run.usage ? ` · ${t('{a} 入 / {b} 出 tokens', { a: compact(run.usage.inputTokens), b: compact(run.usage.outputTokens) })}` : ''}{run.durationMs ? ` · ${Math.round(run.durationMs / 1000)}s` : ''}{run.skillsVersion ? ` · skill ${run.skillsVersion}` : ''}</span>}>{title}</CardTitle>
        {run?.changes && <p className="m-0 mt-2 text-xs text-ink-2">{run.trigger === 'wake' ? t('提前叫醒的原因：') : t('自上次复查以来的变化：')}{run.changes}</p>}
        {run?.team?.length ? (
          <div className="mt-3 grid grid-cols-[repeat(auto-fill,minmax(min(260px,100%),1fr))] gap-2">
            {run.team.map((entry) => (
              <div key={entry.runId} className="rounded-[10px] border border-line bg-surface-2 p-3">
                <div className="flex items-center gap-1.5 text-xs font-semibold"><Dot tone={entry.status === 'ok' ? 'ok' : 'bad'} />{TEAM_ROLE[entry.role] ?? entry.role}</div>
                <p className="m-0 mt-1 line-clamp-6 whitespace-pre-wrap text-xs text-ink-2">{entry.text || t('（没交报告）')}</p>
              </div>
            ))}
          </div>
        ) : null}
        {events.isLoading ? <Spinner className="mt-3" /> : list.length ? (
          <ol className="mt-3 flex flex-col overflow-hidden rounded-[10px] border border-line">
            {list.filter((event) => event.t !== 'tool_result').map((event, index) => {
              const result = event.t === 'tool' ? results.get((event as RunEvent & { id?: string }).id) : undefined
              return (
                <li key={index} className="flex items-start gap-2 border-b border-line bg-surface-2 px-3 py-2 text-[13px] last:border-b-0">
                  {event.t === 'tool' ? <Dot tone={result ? (result.ok ? 'ok' : 'bad') : 'accent'} pulse={!result && run?.status === 'running'} /> : event.t === 'error' ? <Dot tone="bad" /> : event.t === 'usage' ? <Dot tone="muted" /> : <Dot tone="accent" />}
                  <span className="min-w-0 flex-1">
                    {event.t === 'tool' && <><span className="font-mono text-xs">{String(event.name ?? '').replace('mcp__hrouter_market_pulse__', '')}</span> <span className="break-all font-mono text-xs text-ink-3">{JSON.stringify(event.input ?? {}).slice(0, 120)}</span>{result?.preview && <span className="mt-0.5 block truncate text-xs text-ink-3">{result.preview}</span>}</>}
                    {event.t === 'text' && <span className="whitespace-pre-wrap break-words">{event.text}</span>}
                    {event.t === 'error' && <span className="text-bad">{event.message}</span>}
                    {event.t === 'usage' && <span className="text-xs text-ink-3">{t('用量 {a} 入 / {b} 出', { a: compact(event.inputTokens), b: compact(event.outputTokens) })}</span>}
                  </span>
                  <span className="font-mono text-[11px] text-ink-3">{time(event.at)}</span>
                </li>
              )
            })}
          </ol>
        ) : <div className="mt-3 text-[13px] text-ink-3">{run?.status === 'running' ? t('等第一条事件…') : run?.error ? <span className="text-bad">{run.error}</span> : t('这一轮没有记录过程（旧版本的运行只保存了输出结尾）。')}{run && !list.length && run.stdoutTail && <pre className="mt-2 max-h-60 overflow-auto whitespace-pre-wrap rounded-lg bg-surface-2 p-3 font-mono text-xs scroll-thin">{run.stdoutTail}</pre>}</div>}
      </Card>
    </Expandable>
  )
}
