import { Link } from '@tanstack/react-router'
import { Page, PageHeader } from '@/components/Shell'
import { jobState } from '@/components/trader-bits'
import { AgentMark, Button, Card, CardTitle, Dot, Empty, ErrorNote, Pill, Spinner } from '@/components/ui'
import { AGENT_NAME, agentKind, dateTime, RUN_STATUS, TEAM_ROLE } from '@/lib/format'
import { t } from '@/lib/i18n'
import { useAccounts, useAction, usePools, useSchedules } from '@/lib/queries'

export function SchedulePage() {
  const schedules = useSchedules()
  const { accounts } = useAccounts()
  const pools = usePools()
  const jobs = schedules.data?.jobs ?? []
  const up = schedules.data?.service.state === 'running'
  return (
    <Page>
      <PageHeader title={t('定时任务')} description={t('所有交易员的调度：Agent 复查和代码策略执行。脚本先看盘，没变化就跳过复查，有事提前叫醒。只在交易时段运行，错过的 90 分钟内补跑。')}
        actions={<span className="flex items-center gap-1.5 text-[13px] text-ink-2"><Dot tone={up ? 'ok' : 'bad'} />{up ? t('常驻服务运行中') : t('常驻服务没在运行')} · {t('调度器 {role}', { role: schedules.data?.scheduler.role ?? '—' })}</span>} />
      <ErrorNote error={schedules.error} />
      {!up && !schedules.isLoading && <div className="rounded-[10px] border border-warn-line bg-warn-soft px-3.5 py-2.5 text-[13px] text-warn-ink">{t('常驻服务没在运行，调度不会按时触发。运行 {cmd} 安装开机自启。', { cmd: 'npm run service:install' })}</div>}
      {schedules.isLoading ? <Spinner /> : !jobs.length ? <Empty title={t('还没有调度')}>{t('新建交易员时会自动建好调度。')}</Empty> : (
        <Card className="overflow-x-auto p-0">
          <table className="w-full min-w-[1080px] border-collapse text-[13px] [&_td+td]:pl-3 [&_th+th]:pl-3">
            <thead><tr className="text-left text-xs text-ink-3"><th className="px-4 py-2.5 font-medium">{t('交易员')}</th><th className="font-medium">{t('工作方式')}</th><th className="font-medium">{t('Agent 复查')}</th><th className="font-medium">{t('代码策略')}</th><th className="font-medium">{t('今天')}</th><th className="font-medium">{t('上次')}</th><th className="font-medium">{t('状态')}</th><th className="px-4 font-medium" /></tr></thead>
            <tbody>{jobs.map((job) => {
              const account = accounts.find((entry) => entry.id === job.accountId)
              const state = jobState(job, account)
              const agent = job.runner.type !== 'strategy'
              const today = job.gateToday
              return (
                <tr key={job.accountId} className="border-t border-line align-middle">
                  <td className="px-4 py-2.5"><Link to="/traders/$id" params={{ id: job.accountId }} search={{ tab: undefined }} className="flex items-center gap-2.5 text-ink"><AgentMark kind={account ? agentKind(account) : job.runner.type} /><span className="font-semibold">{account?.name ?? job.accountId}</span></Link></td>
                  <td className="text-ink-2">{!agent ? t('纯代码策略') : job.mode === 'director' || job.strategy ? t('Agent 主控') : t('每轮看盘')}{job.team?.enabled && <span className="mt-0.5 block"><Pill tone="accent" title={(job.team.roles ?? []).map((role) => TEAM_ROLE[role] ?? role).join(' · ')}>{t('团队 {n} 人', { n: (job.team.roles ?? []).length })}{job.team.debate ? t(' + 辩论') : ''}</Pill></span>}</td>
                  <td className="text-ink-2">{!agent ? '—' : <>{AGENT_NAME[job.runner.type] ?? job.runner.type}{job.intervalMinutes ? ` · ${t('每 {n} 分钟', { n: job.intervalMinutes })}` : ''}{job.times.length ? ` · ${job.times.join(t('、'))}` : ''}{job.backup ? <span className="block text-xs text-ink-3">{t('备用 {name}', { name: AGENT_NAME[job.backup.type] ?? job.backup.type })}</span> : null}</>}</td>
                  <td className="font-mono text-xs text-ink-2">{job.strategy ? `${job.strategy.strategyId} · ${t('每 {n} 分钟', { n: job.strategy.intervalMinutes })}` : !agent ? `${job.runner.strategyId} · ${t('每 {n} 分钟', { n: job.intervalMinutes })}` : t('还没写')}</td>
                  <td className="text-xs text-ink-2">{!agent ? '—' : <>
                    <span className="block">{t('跳过 {s} · 叫醒 {w}', { s: today?.skipped ?? 0, w: today?.wakes ?? 0 })}</span>
                    <span className="block text-ink-3">{job.gate?.enabled === false ? t('每个时段都复查') : t('没变化就跳过')}{job.wake?.enabled === false ? '' : ` · ${t('有事提前叫醒')}`}</span>
                  </>}</td>
                  <td className="text-xs text-ink-2">{job.lastRun ? `${dateTime(job.lastRun.at)} · ${RUN_STATUS[job.lastRun.status] ?? job.lastRun.status}` : '—'}</td>
                  <td><span className="flex items-center gap-1.5 text-xs text-ink-2"><Dot tone={state.tone} pulse={state.pulse} />{state.text.split(' · ')[0]}</span></td>
                  <td className="px-4 text-right"><JobActions accountId={job.accountId} paused={Boolean(job.paused)} enabled={job.enabled !== false} /></td>
                </tr>
              )
            })}</tbody>
          </table>
        </Card>
      )}
      <Card className="flex flex-col gap-3 p-4">
        <CardTitle extra={<span className="text-xs text-ink-3">{t('同一个 CLI 登录是一份额度，用它的交易员一起算')}</span>}>{t('额度池')}</CardTitle>
        {(pools.data?.pools ?? []).length ? pools.data!.pools.map((pool) => <PoolRow key={pool.key} pool={pool} names={pool.traders.map((id) => accounts.find((account) => account.id === id)?.name ?? id)} />) : <div className="text-[13px] text-ink-3">{t('还没有 Agent 交易员。')}</div>}
      </Card>
    </Page>
  )
}

function JobActions({ accountId, paused, enabled }: { accountId: string; paused: boolean; enabled: boolean }) {
  const run = useAction(`/api/arena/schedules/${accountId}/run`, { invalidate: [['schedules']], success: t('已开始') })
  const resume = useAction(`/api/arena/schedules/${accountId}/resume`, { invalidate: [['schedules']], success: t('已恢复') })
  const toggle = useAction<{ enabled: boolean }>(`/api/arena/schedules/${accountId}`, { invalidate: [['schedules']] })
  return (
    <span className="inline-flex gap-1.5">
      {paused ? <Button size="sm" variant="warn" onClick={() => resume.mutate({})} loading={resume.isPending}>{t('恢复')}</Button> : <Button size="sm" onClick={() => toggle.mutate({ enabled: !enabled })} loading={toggle.isPending}>{enabled ? t('停用') : t('启用')}</Button>}
      <Button size="sm" onClick={() => run.mutate({})} loading={run.isPending}>{t('立即运行')}</Button>
    </span>
  )
}

export function PoolRow({ pool, names }: { pool: { key: string; paused: boolean; pausedUntil?: string; message?: string | null; backups: string[] }; names: string[] }) {
  const clear = useAction(`/api/arena/pools/${encodeURIComponent(pool.key)}/clear`, { invalidate: [['pools'], ['schedules']], success: t('已解除暂停') })
  return (
    <div className="flex flex-wrap items-center gap-3 border-t border-line pt-2.5 first:border-t-0 first:pt-0">
      <Dot tone={pool.paused ? 'warn' : 'ok'} />
      <div className="min-w-[200px] flex-1"><div className="font-semibold">{AGENT_NAME[pool.key] ?? pool.key}</div><div className="text-xs text-ink-3">{names.join(t('、')) || t('没有交易员')}{pool.backups.length ? ` · ${t('给 {n} 个交易员当备用', { n: pool.backups.length })}` : ''}</div></div>
      {pool.paused ? <><span className="text-xs text-warn-ink">{t('额度用尽 · {time} 恢复', { time: dateTime(pool.pausedUntil) })}</span><Button size="sm" onClick={() => clear.mutate({})} loading={clear.isPending}>{t('已恢复，解除')}</Button></> : <span className="text-xs text-ok">{t('正常')}</span>}
    </div>
  )
}
