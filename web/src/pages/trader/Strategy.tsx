import { useEffect, useState } from 'react'
import { Link } from '@tanstack/react-router'
import type { AccountDetail, Job, StrategyVersion } from '@/lib/api'
import { dateTime, num } from '@/lib/format'
import { useAction, useRuns, useSchedules, useTraderStrategy } from '@/lib/queries'
import { Button, Card, CardTitle, Dot, Empty, Input, Pill, Signed, Spinner, cn } from '@/components/ui'
import { t } from '@/lib/i18n'

const STATUS: Record<string, [string, 'ok' | 'neutral' | 'bad' | 'accent']> = { live: [t('运行中'), 'ok'], retired: [t('已下线'), 'neutral'], rejected: [t('未上线'), 'bad'], checking: [t('检查中'), 'accent'] }
const STAGE: Record<string, string> = { load: t('加载'), params: t('参数'), 'dry-run': t('空跑'), backtest: t('回测') }

export function TraderStrategyTab({ account, job }: { account: AccountDetail; job: Job | undefined }) {
  const strategy = useTraderStrategy(account.id)
  const [version, setVersion] = useState<number | undefined>(undefined)
  const selectedVersion = version ?? strategy.data?.live ?? strategy.data?.versions.at(-1)?.version
  const code = useTraderStrategy(account.id, selectedVersion)
  const schedules = useSchedules()
  const runs = useRuns(account.id, { limit: 120 })
  const builtin = job?.runner.type === 'strategy' && !job.runner.strategyId?.startsWith('trader-') ? schedules.data?.strategies.find((entry) => entry.id === job.runner.strategyId) : null

  if (strategy.isLoading) return <Spinner />
  const versions = [...(strategy.data?.versions ?? [])].reverse()
  const entry = versions.find((item) => item.version === selectedVersion)
  const live = versions.find((item) => item.status === 'live')

  if (builtin) return (
    <Card className="flex flex-col gap-2 p-5">
      <CardTitle>{builtin.name}</CardTitle>
      <p className="m-0 text-[13px] text-ink-2">{builtin.description}</p>
      <p className="m-0 text-[13px] text-ink-2">{t('这是内置量化策略，每 {n} 分钟执行一次，不需要 Agent。参数在「设置 → 节奏与 Agent」里改；要换成 Agent 主控，在设置里把运行方式改成某个 Agent。', { n: job?.intervalMinutes ?? '—' })}</p>
    </Card>
  )

  if (!versions.length) return (
    <Empty title={t('还没有代码策略')}>
      {t('交易员（Agent）会在复查时用 arena_write_strategy 写自己的策略。上线前会自动沙箱加载、用实时行情空跑一次、用真实日线回测约半年；任何一关没过都不会上线。')}{account.template && ` ${t('模板带了起始策略，Agent 可以从它改起。')}`}
    </Empty>
  )

  return (
    <div className="flex flex-wrap items-start gap-4">
      <Card className="flex min-w-0 max-w-[300px] flex-[1_1_240px] flex-col gap-1 p-3">
        <h2 className="m-1 mb-2 text-[15px] font-semibold">{t('版本')}</h2>
        {versions.map((item) => (
          <button key={item.version} type="button" aria-pressed={item.version === selectedVersion} onClick={() => setVersion(item.version)}
            className={cn('flex flex-col gap-0.5 rounded-[10px] border px-3 py-2.5 text-left', item.version === selectedVersion ? 'border-accent-line bg-accent-soft' : 'border-transparent hover:bg-surface-2')}>
            <span className="flex items-center gap-1.5">
              <span className={cn('font-mono font-semibold', item.status === 'rejected' && 'text-ink-3')}>v{item.version}</span>
              <Pill tone={STATUS[item.status]?.[1] ?? 'neutral'}>{STATUS[item.status]?.[0] ?? item.status}</Pill>
              <span className="ml-auto text-xs text-ink-3">{dateTime(item.at)}</span>
            </span>
            <span className="text-xs text-ink-2">{item.changeNote ?? '—'}</span>
            {item.status === 'rejected' && <span className="text-xs text-bad">{t('{stage}没过：{error}', { stage: STAGE[item.rejectedAt ?? ''] ?? item.rejectedAt ?? '', error: item.error ?? '' })}</span>}
            {item.backtest?.ok && <span className="font-mono text-xs text-ink-3">{t('回测')} <Signed value={item.backtest.totalReturnPct} /> · {t('回撤 {n}%', { n: num(item.backtest.maxDrawdownPct, 1) })}</span>}
          </button>
        ))}
      </Card>

      <Card className="flex min-w-0 flex-[999_1_460px] flex-col overflow-hidden">
        <div className="flex flex-wrap items-center gap-2.5 border-b border-line px-4 py-3">
          <h2 className="m-0 text-[15px] font-semibold">{strategy.data?.strategyId}.mjs</h2>
          <span className="font-mono text-xs text-ink-3">v{selectedVersion} · {t('{who} 写的', { who: entry?.by.kind === 'owner' ? t('你') : entry?.by.client ?? 'Agent' })} · {t('{n} 行', { n: entry?.lines ?? '—' })}</span>
          {entry && entry.status !== 'live' && entry.meta && <RollbackButton accountId={account.id} version={entry.version} />}
        </div>
        <div className="overflow-x-auto bg-surface-2">
          {code.isLoading ? <div className="p-4"><Spinner /></div> : <pre className="m-0 min-w-[600px] p-4 font-mono text-[12.5px] leading-relaxed text-ink">{(code.data?.code ?? '').split('\n').map((line, index) => <div key={index}><span className="mr-4 inline-block w-8 select-none text-right text-ink-3">{index + 1}</span>{line}</div>)}</pre>}
        </div>
        <div className="border-t border-line px-4 py-3 text-xs text-ink-2">{t('边界不写在策略里：保留现金等边界由系统在下单前检查，策略算出来的订单超了会被拦下。')}</div>
      </Card>

      <aside className="flex min-w-0 max-w-[380px] flex-[1_1_320px] flex-col gap-4">
        <Cadence account={account} job={job} />
        {entry && <Checks entry={entry} previous={live && live.version !== entry.version ? live : undefined} />}
        <TodayStats account={account} runs={runs.data?.runs ?? []} />
      </aside>
    </div>
  )
}

function RollbackButton({ accountId, version }: { accountId: string; version: number }) {
  const rollback = useAction<{ version: number }>(`/api/arena/accounts/${accountId}/strategy/rollback`, { invalidate: [['trader-strategy', accountId], ['schedules']], success: t('v{n} 已重新上线', { n: version }) })
  return <Button size="sm" className="ml-auto" onClick={() => rollback.mutate({ version })} loading={rollback.isPending}>{t('让 v{n} 重新上线', { n: version })}</Button>
}

function Cadence({ account, job }: { account: AccountDetail; job: Job | undefined }) {
  const [review, setReview] = useState('')
  const [strategy, setStrategy] = useState('')
  useEffect(() => { setReview(String(job?.intervalMinutes ?? '')); setStrategy(String(job?.strategy?.intervalMinutes ?? '')) }, [job?.intervalMinutes, job?.strategy?.intervalMinutes])
  const save = useAction<Record<string, unknown>>(`/api/arena/schedules/${account.id}/cadence`, { invalidate: [['schedules'], ['account', account.id]], success: t('节奏已更新') })
  if (!job) return <Card className="p-4 text-[13px] text-ink-3">{t('没有调度。去「设置」配置运行方式。')}</Card>
  return (
    <Card className="flex flex-col gap-3 p-4">
      <CardTitle>{t('节奏')}</CardTitle>
      <div className="flex items-center gap-2.5">
        <div className="flex-1"><div className="text-[13px] font-semibold">{t('策略执行')}</div><div className="text-xs text-ink-3">{t('纯代码 · Agent 能自己改')}</div></div>
        <label className="flex items-center gap-1 text-[13px] text-ink-3">{t('每')}<Input aria-label={t('策略执行间隔（分钟）')} type="number" min={1} max={240} value={strategy} onChange={(event) => setStrategy(event.target.value)} disabled={!job.strategy} className="w-16 text-right font-mono" />{t('分钟')}</label>
      </div>
      <div className="flex items-center gap-2.5">
        <div className="flex-1"><div className="text-[13px] font-semibold">{t('交易员复查')}</div><div className="text-xs text-ink-3">{t('没变化自动跳过 · Agent 能自己改')}</div></div>
        <label className="flex items-center gap-1 text-[13px] text-ink-3">{t('每')}<Input aria-label={t('复查间隔（分钟）')} type="number" min={5} max={240} value={review} onChange={(event) => setReview(event.target.value)} className="w-16 text-right font-mono" />{t('分钟')}</label>
      </div>
      <Button size="sm" className="self-start" loading={save.isPending} onClick={() => save.mutate({ reviewMinutes: review ? Number(review) : undefined, strategyMinutes: job.strategy && strategy ? Number(strategy) : undefined })}>{t('保存节奏')}</Button>
      <div className="border-t border-line pt-2.5 text-xs text-ink-3">{t('成交、止损、持仓急动、你的新指令会提前叫醒交易员，规则在设置里调。交易员也能用 arena_set_cadence 自己改节奏；你可以在')}<Link to="/traders/$id" params={{ id: account.id }} search={{ tab: 'settings' }}>{t('设置')}</Link>{t('里锁住。')}</div>
    </Card>
  )
}

function Checks({ entry, previous }: { entry: StrategyVersion; previous?: StrategyVersion }) {
  const bt = entry.backtest
  return (
    <Card className="flex flex-col gap-2.5 p-4">
      <CardTitle>{t('v{n} 上线检查', { n: entry.version })}</CardTitle>
      <Check ok={entry.status !== 'rejected' || !['load', 'params'].includes(entry.rejectedAt ?? '')} title={t('沙箱加载')} detail={entry.rejectedAt === 'load' ? entry.error : t('没有文件、网络和子进程权限的独立进程里加载成功')} />
      <Check ok={entry.dryRun ? entry.dryRun.ok : entry.rejectedAt !== 'dry-run'} pending={!entry.dryRun && entry.status === 'checking'} title={t('空跑一次')} detail={entry.dryRun ? (entry.dryRun.ok ? `${t('用实时行情算出 {n} 笔订单，没有真的下单', { n: entry.dryRun.orders.length })}${entry.dryRun.orders.length ? `${t('：')}${entry.dryRun.orders.slice(0, 3).map((order) => `${order.side === 'BUY' ? t('买') : t('卖')} ${order.symbol} ${order.quantity}`).join(t('，'))}` : ''}` : entry.dryRun.error) : entry.rejectedAt === 'dry-run' ? entry.error : '—'} />
      <Check ok={bt ? bt.ok : entry.rejectedAt !== 'backtest'} pending={!bt && entry.status === 'checking'} title={bt?.ok ? t('回测 {from} 至 {to}', { from: bt.from, to: bt.to }) : t('回测')} detail={bt?.ok ? `${bt.basis} · ${t('收益 {r}%，最大回撤 {d}%，基准 {b}%，{n} 笔', { r: num(bt.totalReturnPct), d: num(bt.maxDrawdownPct), b: bt.benchmarkReturnPct ?? '—', n: bt.trades })}${previous?.backtest?.ok ? `（v${previous.version}：${num(previous.backtest.totalReturnPct)}% / ${num(previous.backtest.maxDrawdownPct)}%）` : ''}` : bt?.error ?? (entry.rejectedAt === 'backtest' ? entry.error : '—')} />
      {bt?.notes?.length ? <ul className="m-0 list-disc border-t border-line pl-5 pt-2 text-xs text-ink-3">{bt.notes.map((note) => <li key={note}>{note}</li>)}</ul> : null}
    </Card>
  )
}

function Check({ ok, pending, title, detail }: { ok: boolean; pending?: boolean; title: string; detail?: string | null }) {
  return (
    <div className="flex items-start gap-2.5">
      <span className="mt-1"><Dot tone={pending ? 'accent' : ok ? 'ok' : 'bad'} pulse={pending} /></span>
      <div className="min-w-0"><div className="text-[13px] font-semibold">{title}</div>{detail && <div className="break-words text-xs text-ink-2">{detail}</div>}</div>
    </div>
  )
}

function TodayStats({ account, runs }: { account: AccountDetail; runs: Array<{ lane: string; startedAt: string; status: string; orders?: unknown[]; durationMs?: number }> }) {
  const today = runs.filter((run) => run.lane === 'strategy' && new Date(run.startedAt).toDateString() === new Date().toDateString())
  const orders = today.flatMap((run) => run.orders ?? []) as Array<{ status: string }>
  return (
    <Card className="grid grid-cols-2 gap-3 p-4">
      <h2 className="col-span-2 m-0 text-[15px] font-semibold">{t('策略今天')}</h2>
      <div><div className="text-xs text-ink-3">{t('执行')}</div><div className="font-mono text-lg">{t('{n} 次', { n: today.length })}</div></div>
      <div><div className="text-xs text-ink-3">{t('失败')}</div><div className="font-mono text-lg">{today.filter((run) => run.status === 'failed').length}</div></div>
      <div><div className="text-xs text-ink-3">{t('产生订单')}</div><div className="font-mono text-lg">{orders.length}</div></div>
      <div><div className="text-xs text-ink-3">{t('被拦')}</div><div className="font-mono text-lg">{orders.filter((order) => order.status === 'rejected').length}</div></div>
      <div className="col-span-2 text-xs text-ink-3">{t('按策略版本的成交归因见「委托与成交」。')}</div>
    </Card>
  )
}
