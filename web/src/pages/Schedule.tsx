import { Link } from '@tanstack/react-router'
import { Page, PageHeader } from '@/components/Shell'
import { jobState } from '@/components/trader-bits'
import { AgentMark, Button, Card, CardTitle, Dot, Empty, ErrorNote, Spinner } from '@/components/ui'
import { AGENT_NAME, agentKind, dateTime, RUN_STATUS } from '@/lib/format'
import { useAccounts, useAction, usePools, useSchedules } from '@/lib/queries'

export function SchedulePage() {
  const schedules = useSchedules()
  const { accounts } = useAccounts()
  const pools = usePools()
  const jobs = schedules.data?.jobs ?? []
  return (
    <Page>
      <PageHeader title="定时任务" description="所有交易员的调度：Agent 复查（花 token）和代码策略执行（不花 token）。只在交易时段运行，错过的 90 分钟内补跑。"
        actions={<span className="flex items-center gap-1.5 text-[13px] text-ink-2"><Dot tone={schedules.data?.service.state === 'running' ? 'ok' : 'bad'} />常驻服务{schedules.data?.service.state === 'running' ? '运行中' : '没在运行'} · 调度器 {schedules.data?.scheduler.role ?? '—'}</span>} />
      <ErrorNote error={schedules.error} />
      {schedules.data?.service.state !== 'running' && !schedules.isLoading && <div className="rounded-[10px] border border-warn-line bg-warn-soft px-3.5 py-2.5 text-[13px] text-warn-ink">常驻服务没在运行，调度不会按时触发。运行 <code className="font-mono">npm run service:install</code> 安装开机自启。</div>}
      {schedules.isLoading ? <Spinner /> : !jobs.length ? <Empty title="还没有调度">新建交易员时会自动建好调度。</Empty> : (
        <Card className="overflow-x-auto p-0">
          <table className="w-full min-w-[1000px] border-collapse text-[13px]">
            <thead><tr className="text-left text-xs text-ink-3"><th className="px-4 py-2.5 font-medium">交易员</th><th className="font-medium">工作方式</th><th className="font-medium">Agent 复查</th><th className="font-medium">代码策略</th><th className="font-medium">上次</th><th className="font-medium">状态</th><th className="px-4 font-medium" /></tr></thead>
            <tbody>{jobs.map((job) => {
              const account = accounts.find((entry) => entry.id === job.accountId)
              const state = jobState(job, account)
              return (
                <tr key={job.accountId} className="border-t border-line align-middle">
                  <td className="px-4 py-2.5"><Link to="/traders/$id" params={{ id: job.accountId }} search={{ tab: undefined }} className="flex items-center gap-2.5 text-ink"><AgentMark kind={account ? agentKind(account) : job.runner.type} /><span className="font-semibold">{account?.name ?? job.accountId}</span></Link></td>
                  <td className="text-ink-2">{job.runner.type === 'strategy' ? '纯代码策略' : job.mode === 'director' || job.strategy ? 'Agent 主控' : '每轮看盘'}</td>
                  <td className="text-ink-2">{job.runner.type === 'strategy' ? '—' : <>{AGENT_NAME[job.runner.type] ?? job.runner.type} · {job.intervalMinutes ? `每 ${job.intervalMinutes} 分钟` : ''}{job.times.length ? ` · ${job.times.join('、')}` : ''}{job.backup ? <span className="block text-xs text-ink-3">备用 {AGENT_NAME[job.backup.type] ?? job.backup.type}</span> : null}</>}</td>
                  <td className="font-mono text-xs text-ink-2">{job.strategy ? `${job.strategy.strategyId} · 每 ${job.strategy.intervalMinutes} 分钟` : job.runner.type === 'strategy' ? `${job.runner.strategyId} · 每 ${job.intervalMinutes} 分钟` : '还没写'}</td>
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
        <CardTitle extra={<span className="text-xs text-ink-3">同一个 CLI 登录是一份额度，用它的交易员一起算</span>}>额度池</CardTitle>
        {(pools.data?.pools ?? []).map((pool) => <PoolRow key={pool.key} pool={pool} names={pool.traders.map((id) => accounts.find((account) => account.id === id)?.name ?? id)} />)}
      </Card>
    </Page>
  )
}

function JobActions({ accountId, paused, enabled }: { accountId: string; paused: boolean; enabled: boolean }) {
  const run = useAction(`/api/arena/schedules/${accountId}/run`, { invalidate: [['schedules']], success: '已开始' })
  const resume = useAction(`/api/arena/schedules/${accountId}/resume`, { invalidate: [['schedules']], success: '已恢复' })
  const toggle = useAction<{ enabled: boolean }>(`/api/arena/schedules/${accountId}`, { invalidate: [['schedules']] })
  return (
    <span className="inline-flex gap-1.5">
      {paused ? <Button size="sm" variant="warn" onClick={() => resume.mutate({})} loading={resume.isPending}>恢复</Button> : <Button size="sm" onClick={() => toggle.mutate({ enabled: !enabled })}>{enabled ? '停用' : '启用'}</Button>}
      <Button size="sm" onClick={() => run.mutate({})} loading={run.isPending}>立即运行</Button>
    </span>
  )
}

export function PoolRow({ pool, names }: { pool: { key: string; paused: boolean; pausedUntil?: string; message?: string | null; backups: string[] }; names: string[] }) {
  const clear = useAction(`/api/arena/pools/${encodeURIComponent(pool.key)}/clear`, { invalidate: [['pools'], ['schedules']], success: '已解除暂停' })
  return (
    <div className="flex flex-wrap items-center gap-3 border-t border-line pt-2.5 first:border-t-0 first:pt-0">
      <Dot tone={pool.paused ? 'warn' : 'ok'} />
      <div className="min-w-[200px] flex-1"><div className="font-semibold">{AGENT_NAME[pool.key] ?? pool.key}</div><div className="text-xs text-ink-3">{names.join('、') || '没有交易员'}{pool.backups.length ? ` · 给 ${pool.backups.length} 个交易员当备用` : ''}</div></div>
      {pool.paused ? <><span className="text-xs text-warn-ink">额度用尽 · {dateTime(pool.pausedUntil)} 恢复</span><Button size="sm" onClick={() => clear.mutate({})} loading={clear.isPending}>已恢复，解除</Button></> : <span className="text-xs text-ok">正常</span>}
    </div>
  )
}
