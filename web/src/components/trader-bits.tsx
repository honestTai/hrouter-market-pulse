import { useState } from 'react'
import { Link } from '@tanstack/react-router'
import { useQueries } from '@tanstack/react-query'
import { ExternalLink } from 'lucide-react'
import { toast } from 'sonner'
import { get, type AccountSummary, type Approval, type ChangeRequest, type Citation, type Job, type Pool, type TraderSettings } from '@/lib/api'
import { AGENT_NAME, agentKind, changeLabel, changedByLabel, dateTime, FAILURE_KIND, MARKET_NAME, money, num, safeUrl, SIDE_NAME, time, valueLabel } from '@/lib/format'
import { t } from '@/lib/i18n'
import { useAction } from '@/lib/queries'
import { AgentMark, Button, Card, Dot, Pill, Signed, Sparkline, Textarea, cn } from './ui'

export function jobState(job: Job | undefined, account?: AccountSummary): { tone: 'ok' | 'warn' | 'bad' | 'accent' | 'muted'; text: string; pulse?: boolean } {
  if (!job) return account?.model?.startsWith('strategy:') ? { tone: 'muted', text: t('没有调度') } : { tone: 'muted', text: t('没有调度：在设置里配置运行方式') }
  if (job.paused) return { tone: 'bad', text: t('已暂停：{kind}', { kind: FAILURE_KIND[job.paused.kind] ?? job.paused.kind }) }
  if (job.enabled === false) return { tone: 'muted', text: t('已停用') }
  if (job.running) return { tone: 'accent', text: job.runner.type === 'strategy' ? t('策略执行中') : t('复查中'), pulse: true }
  if (job.pool) return { tone: 'warn', text: t('{agent} 额度用尽 · {time} 恢复', { agent: AGENT_NAME[job.runner.type] ?? job.runner.type, time: time(job.pool.pausedUntil) }) + (job.backup ? t(' · 备用代班') : '') }
  if (job.queued) return { tone: 'warn', text: t('排队中：同时运行的 Agent 已满') }
  const strategy = job.strategy ? t('策略每 {n} 分钟', { n: job.strategy.intervalMinutes }) : job.runner.type === 'strategy' ? t('每 {n} 分钟执行', { n: job.intervalMinutes ?? '—' }) : null
  const review = job.runner.type !== 'strategy' && job.intervalMinutes ? t('复查每 {n} 分钟', { n: job.intervalMinutes }) : job.times.length ? t('每天 {times}', { times: job.times.join(t('、')) }) : null
  const failed = job.lastRun && job.lastRun.status !== 'ok' && job.lastRun.status !== 'no-round'
  const last = job.lastRun ? t(' · 上次 {time}', { time: time(job.lastRun.at) }) + (failed ? t('（失败）') : '') : ''
  return { tone: (job.consecutiveFailures ?? 0) >= 3 ? 'warn' : 'ok', text: `${[strategy, review].filter(Boolean).join(' · ') || t('已调度')}${last}` }
}

export function TraderCard({ account, job }: { account: AccountSummary; job?: Job }) {
  const state = jobState(job, account)
  const m = account.metrics
  const backup = job?.backup ? t(' · 备用 {agent}', { agent: AGENT_NAME[job.backup.type] ?? job.backup.type }) : ''
  const waiting = (account.pendingApprovals ?? 0) + (account.pendingRequests ?? 0)
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
        <span className="flex flex-col">{t('今日')}<Signed value={m.todayReturnPct} className="text-sm" /></span>
        <span className="flex flex-col">{t('累计')}<Signed value={m.totalReturnPct} className="text-sm" /></span>
        <span className="flex flex-col">{t('持仓')}<span className="font-mono text-sm text-ink">{t('{n} 只', { n: m.positions })}</span></span>
        <span className="flex flex-col">{t('现金')}<span className="font-mono text-sm text-ink">{account.limitStatus ? `${Math.round(account.limitStatus.cashPct)}%` : '—'}</span></span>
      </span>
      <span className={cn('flex items-center gap-1.5 border-t border-line pt-2 text-xs', waiting ? 'text-accent-ink' : state.tone === 'bad' ? 'text-bad' : state.tone === 'warn' ? 'text-warn-ink' : state.tone === 'accent' ? 'text-accent-ink' : 'text-ink-2')}>
        <Dot tone={waiting ? 'accent' : state.tone} pulse={state.pulse} /><span className="truncate">{waiting ? t('等你处理 {n} 件事', { n: waiting }) : state.text}</span>
      </span>
    </Link>
  )
}

// Agents' requests to change items the owner locked (and proposed rules), across traders.
export function useRequests(accounts: AccountSummary[]) {
  const pending = accounts.filter((account) => account.pendingRequests)
  const results = useQueries({ queries: pending.map((account) => ({ queryKey: ['trader-settings', account.id], queryFn: ({ signal }: { signal: AbortSignal }) => get<TraderSettings>(`/api/arena/accounts/${account.id}/settings`, signal) })) })
  return pending.flatMap((account, index) => (results[index].data?.requests ?? []).filter((request) => request.status === 'pending').map((request) => ({ account, request })))
}

const cardShadow = 'shadow-[0_1px_2px_rgba(17,19,24,0.04),0_8px_24px_-12px_rgba(67,56,202,0.25)]'

export function RequestCard({ account, request }: { account: AccountSummary; request: ChangeRequest }) {
  const rule = request.key === 'rule'
  const resolve = useAction<{ approve: boolean; value?: unknown }>(`/api/arena/accounts/${account.id}/requests/${request.id}`, {
    invalidate: [['leaderboard'], ['trader-settings', account.id], ['account', account.id]],
    success: (result: unknown) => ((result as { request: { status: string } }).request.status === 'approved' ? (rule ? t('已同意，这条规则从下一轮起生效') : t('已同意，边界已更新')) : t('已拒绝')),
  })
  const numeric = typeof request.to === 'number' && typeof request.from === 'number'
  const middle = numeric ? Math.round(((request.from as number) + (request.to as number)) / 2) : null
  return (
    <article className={cn('flex flex-col gap-2.5 rounded-[14px] border border-accent-line bg-surface p-4', cardShadow)}>
      <div className="flex items-center gap-1.5 text-xs font-semibold text-accent-ink"><Dot tone="accent" />{rule ? t('提议一条长期规则') : t('申请修改锁定项')}</div>
      <div className="text-[15px] font-semibold leading-snug">
        {rule ? t('{name}：「{rule}」', { name: account.name, rule: String(request.to) }) : t('{name} 想把「{key}」从 {from} 改成 {to}', { name: account.name, key: changeLabel(request.key), from: valueLabel(request.key, request.from), to: valueLabel(request.key, request.to) })}
      </div>
      {request.reason && <p className="m-0 text-[13px] text-ink-2">{t('理由：{reason}', { reason: request.reason })}</p>}
      <div className="mt-0.5 flex flex-wrap items-center gap-2.5">
        <span className="font-mono text-xs text-ink-3">{changedByLabel(request.by)} · {dateTime(request.at)}</span>
        <span className="flex-1" />
        <Button size="sm" onClick={() => resolve.mutate({ approve: false })} disabled={resolve.isPending}>{t('拒绝')}</Button>
        {middle !== null && middle !== request.to && <Button size="sm" onClick={() => resolve.mutate({ approve: true, value: middle })} disabled={resolve.isPending}>{t('只同意到 {value}', { value: valueLabel(request.key, middle) })}</Button>}
        <Button size="sm" variant="primary" onClick={() => resolve.mutate({ approve: true })} loading={resolve.isPending}>{t('同意')}</Button>
      </div>
    </article>
  )
}

export function CitationList({ citations, className }: { citations?: Citation[]; className?: string }) {
  if (!citations?.length) return null
  return (
    <ul className={cn('m-0 flex list-none flex-col gap-1 p-0', className)}>
      {citations.map((citation, index) => {
        const url = safeUrl(citation.url)
        const label = <>{citation.title}{citation.source && <span className="text-ink-3"> · {citation.source}</span>}{citation.publishedAt && <span className="text-ink-3"> · {dateTime(citation.publishedAt)}</span>}</>
        return (
          <li key={index} className="flex items-start gap-1.5 text-xs">
            <Pill className="shrink-0">{{ news: t('新闻'), filing: t('公告'), data: t('数据'), report: t('研报') }[citation.kind] ?? citation.kind}</Pill>
            {url ? <a href={url} target="_blank" rel="noreferrer noopener" className="inline-flex min-w-0 items-start gap-1 text-accent-ink hover:underline">{label}<ExternalLink className="mt-0.5 size-3 shrink-0" aria-hidden /></a> : <span className="min-w-0 text-ink-2">{label}</span>}
          </li>
        )
      })}
    </ul>
  )
}

// An order the trader wants to place that waits for the owner (autonomy: confirm / suggest).
export function ApprovalCard({ approval, account }: { approval: Approval; account: { id: string; name: string; currency: string } }) {
  const [rejecting, setRejecting] = useState(false)
  const [note, setNote] = useState('')
  const decide = useAction<{ approve: boolean; note?: string }, { approval: Approval; order: { status: string; filledQuantity?: number; fillPrice?: number } | null; error: string | null }>(`/api/arena/accounts/${account.id}/approvals/${approval.id}`, {
    invalidate: [['approvals'], ['account', account.id], ['leaderboard']],
  })
  const submit = (approve: boolean) => decide.mutate({ approve, note: note.trim() || undefined }, {
    onSuccess: (result) => {
      if (!approve) toast.success(t('已拒绝，交易员下一轮会看到'))
      else if (result.error) toast.error(t('确认后被拦下：{error}', { error: result.error }))
      else if (result.order?.status === 'filled') toast.success(t('已确认并成交 {qty} 股 @ {price}', { qty: result.order.filledQuantity ?? approval.preview.quantity, price: num(result.order.fillPrice ?? null) }))
      else toast.success(t('已确认，订单已挂出'))
    },
  })
  const p = approval.preview
  const minutesLeft = Math.max(0, Math.round((Date.parse(approval.expiresAt) - Date.now()) / 60000))
  return (
    <article className={cn('flex flex-col gap-2.5 rounded-[14px] border border-accent-line bg-surface p-4', cardShadow)}>
      <div className="flex items-center gap-1.5 text-xs font-semibold text-accent-ink"><Dot tone="accent" pulse />{t('等你确认的订单')} · {approval.reason}</div>
      <div className="text-[15px] font-semibold leading-snug">
        {t('{name} 想{side} {stock} {qty} 股', { name: account.name, side: SIDE_NAME[p.side], stock: p.name || p.symbol, qty: p.quantity.toLocaleString() })}
        <span className="ml-2 font-mono text-[13px] font-normal text-ink-2">{p.type === 'limit' ? t('限价 {price}', { price: num(p.limitPrice) }) : t('市价约 {price}', { price: num(p.price) })} · {t('约 {value}', { value: money(p.value, account.currency) })}</span>
      </div>
      <p className="m-0 line-clamp-4 text-[13px] text-ink-2">{approval.input.reason}</p>
      {approval.warnings.length > 0 && <div className="flex flex-wrap gap-1.5">{approval.warnings.map((warning) => <Pill key={warning} tone="warn">{warning}</Pill>)}</div>}
      <CitationList citations={approval.input.citations?.slice(0, 3)} />
      {p.quote && <div className="font-mono text-[11px] text-ink-3">{t('提交时行情：{source} · 买一 {bid} / 卖一 {ask} · {time}', { source: p.quote.source ?? '—', bid: num(p.quote.bid), ask: num(p.quote.ask), time: time(p.quote.asOf) })}</div>}
      {rejecting && <Textarea rows={2} value={note} onChange={(event) => setNote(event.target.value)} placeholder={t('拒绝理由（可选，交易员下一轮会看到）')} aria-label={t('拒绝理由')} />}
      <div className="mt-0.5 flex flex-wrap items-center gap-2.5">
        <span className="font-mono text-xs text-ink-3">{approval.origin === 'strategy' ? t('代码策略') : approval.requestedBy ?? 'Agent'} · {t('{n} 分钟内有效', { n: minutesLeft })}</span>
        <span className="flex-1" />
        {rejecting
          ? <><Button size="sm" variant="ghost" onClick={() => setRejecting(false)}>{t('取消')}</Button><Button size="sm" variant="danger" onClick={() => submit(false)} loading={decide.isPending}>{t('拒绝')}</Button></>
          : <><Button size="sm" onClick={() => setRejecting(true)} disabled={decide.isPending}>{t('拒绝')}</Button><Button size="sm" variant="primary" onClick={() => submit(true)} loading={decide.isPending}>{t('确认下单')}</Button></>}
      </div>
      <p className="m-0 text-[11px] text-ink-3">{t('确认后按当时的真实行情下单，所有边界会再检查一遍。')}</p>
    </article>
  )
}

export function PausedCard({ account, job }: { account: AccountSummary; job: Job }) {
  const resume = useAction(`/api/arena/schedules/${account.id}/resume`, { invalidate: [['schedules']], success: t('已恢复，下一轮会照常运行') })
  return (
    <article className="flex flex-col gap-2.5 rounded-[14px] border border-bad-line bg-surface p-4">
      <div className="flex items-center gap-1.5 text-xs font-semibold text-bad"><Dot tone="bad" />{FAILURE_KIND[job.paused!.kind] ?? job.paused!.kind} · {t('已自动暂停')}</div>
      <div className="text-[15px] font-semibold leading-snug">{t('{name} 停下来了，不再每轮重复失败', { name: account.name })}</div>
      <p className="m-0 break-words font-mono text-xs text-ink-2">{job.paused!.message ?? '—'}</p>
      <div className="flex flex-wrap items-center gap-2.5">
        <span className="font-mono text-xs text-ink-3">{dateTime(job.paused!.at)}</span>
        <span className="flex-1" />
        <Link to="/traders/$id" params={{ id: account.id }} search={{ tab: 'settings' }} className="inline-flex h-8 items-center rounded-[9px] border border-line-strong px-3 text-[13px] font-semibold text-ink">{t('去改配置')}</Link>
        <Button size="sm" variant="primary" onClick={() => resume.mutate({})} loading={resume.isPending}>{t('已修好，恢复')}</Button>
      </div>
    </article>
  )
}

export function PoolCard({ pool, accounts }: { pool: Pool; accounts: AccountSummary[] }) {
  const names = pool.traders.map((id) => accounts.find((account) => account.id === id)?.name).filter(Boolean)
  return (
    <article className="flex flex-col gap-2.5 rounded-[14px] border border-warn-line bg-surface p-4">
      <div className="flex items-center gap-1.5 text-xs font-semibold text-warn-ink"><Dot tone="warn" />{t('额度用尽 · 已自动处理')}</div>
      <div className="text-[15px] font-semibold leading-snug">{t('{agent} 的额度用完了，{time} 恢复', { agent: AGENT_NAME[pool.key] ?? pool.key, time: time(pool.pausedUntil) })}</div>
      <p className="m-0 text-[13px] text-ink-2">{t('{n} 个交易员共用这份额度', { n: names.length })}{names.length ? t('（{names}）', { names: names.join(t('、')) }) : ''}{t('。设了备用 Agent 的由备用代班复查，代码策略照常执行；额度恢复后自动换回。')}</p>
      <div className="flex items-center gap-2.5">
        <span className="font-mono text-xs text-ink-3">{pool.message?.slice(0, 80)}</span>
        <span className="flex-1" />
        <Link to="/settings" search={{ section: 'quota' }} className="inline-flex h-8 items-center rounded-[9px] border border-line-strong px-3 text-[13px] font-semibold text-ink">{t('额度池')}</Link>
      </div>
    </article>
  )
}

export function Money({ value, currency }: { value: number | null | undefined; currency: string }) {
  return <span className="font-mono tabular">{money(value, currency)}</span>
}

export { Card }
