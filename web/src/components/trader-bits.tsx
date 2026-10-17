import { Link } from '@tanstack/react-router'
import { useQueries } from '@tanstack/react-query'
import { get, type AccountSummary, type ChangeRequest, type Job, type Pool, type TraderSettings } from '@/lib/api'
import { AGENT_NAME, agentKind, changeLabel, changedByLabel, dateTime, FAILURE_KIND, MARKET_NAME, money, time, valueLabel } from '@/lib/format'
import { useAction } from '@/lib/queries'
import { AgentMark, Button, Card, Dot, Pill, Signed, Sparkline, cn } from './ui'

export function jobState(job: Job | undefined, account?: AccountSummary): { tone: 'ok' | 'warn' | 'bad' | 'accent' | 'muted'; text: string; pulse?: boolean } {
  if (!job) return account?.model?.startsWith('strategy:') ? { tone: 'muted', text: '没有调度' } : { tone: 'muted', text: '没有调度：在设置里配置运行方式' }
  if (job.paused) return { tone: 'bad', text: `已暂停：${FAILURE_KIND[job.paused.kind] ?? job.paused.kind}` }
  if (job.enabled === false) return { tone: 'muted', text: '已停用' }
  if (job.running) return { tone: 'accent', text: job.runner.type === 'strategy' ? '策略执行中' : '复查中', pulse: true }
  if (job.pool) return { tone: 'warn', text: `${AGENT_NAME[job.runner.type] ?? job.runner.type} 额度用尽 · ${time(job.pool.pausedUntil)} 恢复${job.backup ? ' · 备用代班' : ''}` }
  if (job.queued) return { tone: 'warn', text: '排队中：同时运行的 Agent 已满' }
  const strategy = job.strategy ? `策略每 ${job.strategy.intervalMinutes} 分钟` : job.runner.type === 'strategy' ? `每 ${job.intervalMinutes ?? '—'} 分钟执行 · 0 token` : null
  const review = job.runner.type !== 'strategy' && job.intervalMinutes ? `复查每 ${job.intervalMinutes} 分钟` : job.times.length ? `每天 ${job.times.join('、')}` : null
  const last = job.lastRun ? ` · 上次 ${time(job.lastRun.at)}${job.lastRun.status !== 'ok' && job.lastRun.status !== 'no-round' ? '（失败）' : ''}` : ''
  return { tone: (job.consecutiveFailures ?? 0) >= 3 ? 'warn' : 'ok', text: `${[strategy, review].filter(Boolean).join(' · ') || '已调度'}${last}` }
}

export function TraderCard({ account, job }: { account: AccountSummary; job?: Job }) {
  const state = jobState(job, account)
  const m = account.metrics
  const backup = job?.backup ? ` · 备用 ${AGENT_NAME[job.backup.type] ?? job.backup.type}` : ''
  return (
    <Link to="/traders/$id" params={{ id: account.id }} search={{ tab: undefined }} className="flex flex-col gap-2.5 rounded-xl border border-line bg-surface p-3.5 text-ink hover:border-line-strong">
      <span className="flex items-center gap-2.5">
        <AgentMark kind={agentKind(account)} size={32} />
        <span className="flex min-w-0 flex-1 flex-col leading-snug">
          <span className="truncate text-sm font-semibold">{account.name}</span>
          <span className="truncate font-mono text-xs text-ink-3">{account.model}{backup}</span>
        </span>
        <Pill>{MARKET_NAME[account.market]}</Pill>
      </span>
      <Sparkline points={account.curve.map((point) => point.returnPct)} />
      <span className="grid grid-cols-4 gap-1.5 text-xs text-ink-3">
        <span className="flex flex-col">今日<Signed value={m.todayReturnPct} className="text-sm" /></span>
        <span className="flex flex-col">累计<Signed value={m.totalReturnPct} className="text-sm" /></span>
        <span className="flex flex-col">持仓<span className="font-mono text-sm text-ink">{m.positions} 只</span></span>
        <span className="flex flex-col">现金<span className="font-mono text-sm text-ink">{account.limitStatus ? `${Math.round(account.limitStatus.cashPct)}%` : '—'}</span></span>
      </span>
      <span className={cn('flex items-center gap-1.5 border-t border-line pt-2 text-xs', state.tone === 'bad' ? 'text-bad' : state.tone === 'warn' ? 'text-warn-ink' : state.tone === 'accent' ? 'text-accent-ink' : 'text-ink-2')}>
        <Dot tone={state.tone} pulse={state.pulse} /><span className="truncate">{account.pendingRequests ? `等你处理 ${account.pendingRequests} 个申请` : state.text}</span>
      </span>
    </Link>
  )
}

// Agents' requests to change items the owner locked, across traders.
export function useRequests(accounts: AccountSummary[]) {
  const pending = accounts.filter((account) => account.pendingRequests)
  const results = useQueries({ queries: pending.map((account) => ({ queryKey: ['trader-settings', account.id], queryFn: ({ signal }: { signal: AbortSignal }) => get<TraderSettings>(`/api/arena/accounts/${account.id}/settings`, signal) })) })
  return pending.flatMap((account, index) => (results[index].data?.requests ?? []).map((request) => ({ account, request })))
}

export function RequestCard({ account, request }: { account: AccountSummary; request: ChangeRequest }) {
  const resolve = useAction<{ approve: boolean; value?: unknown }>(`/api/arena/accounts/${account.id}/requests/${request.id}`, {
    invalidate: [['leaderboard'], ['trader-settings', account.id], ['account', account.id]], success: (result: unknown) => ((result as { request: { status: string } }).request.status === 'approved' ? '已同意，边界已更新' : '已拒绝'),
  })
  const numeric = typeof request.to === 'number' && typeof request.from === 'number'
  const middle = numeric ? Math.round(((request.from as number) + (request.to as number)) / 2) : null
  return (
    <article className="flex flex-col gap-2.5 rounded-[14px] border border-accent-line bg-surface p-4 shadow-[0_1px_2px_rgba(17,19,24,0.04),0_8px_24px_-12px_rgba(67,56,202,0.25)]">
      <div className="flex items-center gap-1.5 text-xs font-semibold text-accent-ink"><Dot tone="accent" />申请修改锁定项</div>
      <div className="text-[15px] font-semibold leading-snug">{account.name} 想把「{changeLabel(request.key)}」从 {valueLabel(request.key, request.from)} 改成 {valueLabel(request.key, request.to)}</div>
      {request.reason && <p className="m-0 text-[13px] text-ink-2">理由：{request.reason}</p>}
      <div className="mt-0.5 flex flex-wrap items-center gap-2.5">
        <span className="font-mono text-xs text-ink-3">{changedByLabel(request.by)} · {dateTime(request.at)}</span>
        <span className="flex-1" />
        <Button size="sm" onClick={() => resolve.mutate({ approve: false })} disabled={resolve.isPending}>拒绝</Button>
        {middle !== null && middle !== request.to && <Button size="sm" onClick={() => resolve.mutate({ approve: true, value: middle })} disabled={resolve.isPending}>只同意到 {valueLabel(request.key, middle)}</Button>}
        <Button size="sm" variant="primary" onClick={() => resolve.mutate({ approve: true })} loading={resolve.isPending}>同意</Button>
      </div>
    </article>
  )
}

export function PausedCard({ account, job }: { account: AccountSummary; job: Job }) {
  const resume = useAction(`/api/arena/schedules/${account.id}/resume`, { invalidate: [['schedules']], success: '已恢复，下一轮会照常运行' })
  return (
    <article className="flex flex-col gap-2.5 rounded-[14px] border border-bad-line bg-surface p-4">
      <div className="flex items-center gap-1.5 text-xs font-semibold text-bad"><Dot tone="bad" />{FAILURE_KIND[job.paused!.kind] ?? job.paused!.kind} · 已自动暂停</div>
      <div className="text-[15px] font-semibold leading-snug">{account.name} 停下来了，不再每轮重复失败</div>
      <p className="m-0 break-words font-mono text-xs text-ink-2">{job.paused!.message ?? '—'}</p>
      <div className="flex flex-wrap items-center gap-2.5">
        <span className="font-mono text-xs text-ink-3">{dateTime(job.paused!.at)}</span>
        <span className="flex-1" />
        <Link to="/traders/$id" params={{ id: account.id }} search={{ tab: 'settings' }} className="inline-flex h-8 items-center rounded-[9px] border border-line-strong px-3 text-[13px] font-semibold text-ink">去改配置</Link>
        <Button size="sm" variant="primary" onClick={() => resume.mutate({})} loading={resume.isPending}>已修好，恢复</Button>
      </div>
    </article>
  )
}

export function PoolCard({ pool, accounts }: { pool: Pool; accounts: AccountSummary[] }) {
  const names = pool.traders.map((id) => accounts.find((account) => account.id === id)?.name).filter(Boolean)
  return (
    <article className="flex flex-col gap-2.5 rounded-[14px] border border-warn-line bg-surface p-4">
      <div className="flex items-center gap-1.5 text-xs font-semibold text-warn-ink"><Dot tone="warn" />额度用尽 · 已自动处理</div>
      <div className="text-[15px] font-semibold leading-snug">{AGENT_NAME[pool.key] ?? pool.key} 的额度用完了，{time(pool.pausedUntil)} 恢复</div>
      <p className="m-0 text-[13px] text-ink-2">{names.length} 个交易员共用这份额度{names.length ? `（${names.join('、')}）` : ''}。设了备用 Agent 的由备用代班复查，代码策略照常执行；额度恢复后自动换回。</p>
      <div className="flex items-center gap-2.5">
        <span className="font-mono text-xs text-ink-3">{pool.message?.slice(0, 80)}</span>
        <span className="flex-1" />
        <Link to="/settings" search={{ section: 'quota' }} className="inline-flex h-8 items-center rounded-[9px] border border-line-strong px-3 text-[13px] font-semibold text-ink">额度池</Link>
      </div>
    </article>
  )
}

export function Money({ value, currency }: { value: number | null | undefined; currency: string }) {
  return <span className="font-mono tabular">{money(value, currency)}</span>
}

export { Card }
