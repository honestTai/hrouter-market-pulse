import { useMemo, useState } from 'react'
import { Plus } from 'lucide-react'
import { Page, PageHeader } from '@/components/Shell'
import { PausedCard, PoolCard, RequestCard, TraderCard, useRequests } from '@/components/trader-bits'
import { AgentMark, Button, Card, CardTitle, Empty, ErrorNote, Segmented, Signed, Spinner, Stat } from '@/components/ui'
import { NewTraderDialog } from '@/components/NewTrader'
import { AGENT_NAME, BENCHMARK_NAME, compact, duration, MARKET_NAME } from '@/lib/format'
import { useAccounts, usePools, useSchedules, useUsage } from '@/lib/queries'

const today = () => new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', weekday: 'short' }).format(new Date())

export function HomePage() {
  const { accounts, isLoading, error } = useAccounts()
  const schedules = useSchedules()
  const pools = usePools()
  const usage = useUsage()
  const requests = useRequests(accounts)
  const [market, setMarket] = useState<'all' | 'A' | 'HK' | 'US'>('all')
  const [creating, setCreating] = useState(false)
  const jobs = schedules.data?.jobs ?? []
  const paused = jobs.filter((job) => job.paused).map((job) => ({ job, account: accounts.find((account) => account.id === job.accountId) })).filter((entry) => entry.account)
  const exhausted = (pools.data?.pools ?? []).filter((pool) => pool.paused)
  const attention = requests.length + paused.length + exhausted.length
  const sorted = useMemo(() => [...accounts].filter((account) => market === 'all' || account.market === market).sort((a, b) => (b.metrics.todayReturnPct ?? -999) - (a.metrics.todayReturnPct ?? -999)), [accounts, market])
  const leader = [...accounts].sort((a, b) => (b.metrics.todayReturnPct ?? -999) - (a.metrics.todayReturnPct ?? -999))[0]
  const beating = accounts.filter((account) => (account.metrics.excessReturnPct ?? 0) > 0).length
  const fills = accounts.reduce((sum, account) => sum + (account.metrics.todayFills ?? 0), 0)
  const rejected = accounts.reduce((sum, account) => sum + (account.metrics.todayRejected ?? 0), 0)
  const running = jobs.filter((job) => job.running || job.strategyRunning)
  const lanes = (schedules.data?.scheduler.running ?? [])

  return (
    <Page>
      <PageHeader eyebrow={`${today()} · 模拟盘 · 真实行情`} title="工作台"
        description={isLoading ? '读取交易员…' : `${accounts.length} 个交易员在跑${attention ? `，${attention} 件事需要你看一下` : '，没有需要你处理的事'}。`}
        actions={<Button variant="primary" size="lg" onClick={() => setCreating(true)}><Plus className="size-4" />新建交易员</Button>} />
      <ErrorNote error={error} />

      <div className="grid grid-cols-4 gap-4 max-lg:grid-cols-2">
        <Card className="p-4"><Stat label="今日领先" value={leader ? <Signed value={leader.metrics.todayReturnPct} className="text-[20px]" /> : '—'} sub={leader?.name ?? '还没有交易员'} /></Card>
        <Card className="p-4"><Stat label="跑赢基准" value={<>{beating}<span className="text-sm text-ink-3"> / {accounts.length}</span></>} sub={[...new Set(accounts.map((account) => account.market))].map((key) => BENCHMARK_NAME[key]).join(' · ') || '—'} /></Card>
        <Card className="p-4"><Stat label="今日成交 / 被边界拦下" value={<>{fills}<span className="text-sm text-ink-3"> / {rejected}</span></>} sub="拦截原因在交易员页的时间线里" /></Card>
        <Card className="p-4"><Stat label="今日用量" value={<>{compact(usage.data?.totals.tokens ?? 0)}<span className="text-sm text-ink-3"> tokens</span></>} sub={`Agent 复查 ${usage.data?.totals.reviews ?? 0} 次 · 代码策略 ${usage.data?.totals.strategyRuns ?? 0} 次`} /></Card>
      </div>

      {attention > 0 && (
        <section aria-labelledby="h-attn" className="flex flex-col gap-3">
          <div className="flex items-center gap-2"><h2 id="h-attn" className="m-0 text-base font-semibold">需要你看</h2><span className="rounded-full bg-accent px-[7px] font-mono text-xs text-white">{attention}</span></div>
          <div className="grid grid-cols-[repeat(auto-fit,minmax(380px,1fr))] gap-4 max-sm:grid-cols-1">
            {requests.map(({ account, request }) => <RequestCard key={request.id} account={account} request={request} />)}
            {paused.map(({ job, account }) => <PausedCard key={job.accountId} job={job} account={account!} />)}
            {exhausted.map((pool) => <PoolCard key={pool.key} pool={pool} accounts={accounts} />)}
          </div>
        </section>
      )}

      <div className="flex flex-wrap items-start gap-6">
        <section aria-labelledby="h-traders" className="flex min-w-0 flex-[999_1_640px] flex-col gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <h2 id="h-traders" className="m-0 text-base font-semibold">交易员</h2>
            <Segmented label="市场" value={market} onChange={setMarket} options={[['all', '全部'], ['A', 'A 股'], ['HK', '港股'], ['US', '美股']]} />
            <span className="ml-auto text-[13px] text-ink-3">按今日收益排序</span>
          </div>
          {isLoading ? <Spinner /> : sorted.length ? (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-3">
              {sorted.map((account) => <TraderCard key={account.id} account={account} job={jobs.find((job) => job.accountId === account.id)} />)}
            </div>
          ) : <Empty title={market === 'all' ? '还没有交易员' : `没有${MARKET_NAME[market]}交易员`} action={<Button variant="primary" onClick={() => setCreating(true)}>新建交易员</Button>}>新建一个交易员，选 Agent、流派和边界；也可以让 Agent 在自己的客户端里用 arena_register_account 开户。</Empty>}
        </section>

        <aside aria-label="运行状态" className="flex min-w-0 flex-[1_1_300px] flex-col gap-4">
          <Card className="flex flex-col gap-3 p-4">
            <CardTitle extra={<span className="text-xs text-ink-3">Agent {lanes.filter((key) => !key.endsWith(':S')).length} · 策略 {lanes.filter((key) => key.endsWith(':S')).length}</span>}>正在运行</CardTitle>
            {running.length ? running.map((job) => {
              const account = accounts.find((entry) => entry.id === job.accountId)
              return (
                <div key={job.accountId} className="flex items-start gap-2.5">
                  <AgentMark kind={job.running && job.runner.type !== 'strategy' ? job.runner.type : 'strategy'} size={28} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] font-semibold">{job.running && job.runner.type !== 'strategy' ? '复查' : '策略执行'} · {account?.name ?? job.accountId}</div>
                    <div className="truncate font-mono text-xs text-ink-3">{job.runner.model ?? job.strategy?.strategyId ?? job.runner.strategyId ?? ''}</div>
                  </div>
                </div>
              )
            }) : <div className="text-[13px] text-ink-3">现在没有在跑的复查或策略。{schedules.data?.service.state !== 'running' ? '常驻服务没在运行，调度不会按时触发。' : ''}</div>}
          </Card>

          <Card className="flex flex-col gap-3 p-4">
            <CardTitle>额度池</CardTitle>
            {(pools.data?.pools ?? []).length ? pools.data!.pools.map((pool) => {
              const tokens = (usage.data?.traders ?? []).flatMap((row) => row.byRunner).filter((entry) => entry.runner === pool.key).reduce((sum, entry) => sum + entry.tokens, 0)
              return (
                <div key={pool.key} className="flex flex-col gap-0.5">
                  <div className="flex text-[13px]"><span className="flex-1">{AGENT_NAME[pool.key] ?? pool.key}</span><span className={pool.paused ? 'font-mono text-warn-ink' : 'font-mono text-ink-2'}>{pool.paused ? '用尽' : '正常'}</span></div>
                  <div className="text-xs text-ink-3">{pool.traders.length} 个交易员{pool.backups.length ? ` + 备用 ${pool.backups.length}` : ''} · 今日 {compact(tokens)} tokens</div>
                </div>
              )
            }) : <div className="text-[13px] text-ink-3">还没有 Agent 交易员。</div>}
          </Card>

          <Card className="grid grid-cols-2 gap-3.5 p-4">
            <h2 className="col-span-2 m-0 text-[15px] font-semibold">今天</h2>
            <Stat label="复查" value={`${usage.data?.totals.reviews ?? 0} 次`} />
            <Stat label="失败" value={`${usage.data?.totals.failed ?? 0} 次`} />
            <Stat label="花费" value={`$${(usage.data?.totals.costUsd ?? 0).toFixed(2)}`} sub="Codex / Kimi 不报金额" />
            <Stat label="平均每次复查" value={usage.data?.totals.reviews ? compact(usage.data.totals.tokens / usage.data.totals.reviews) : '—'} sub={`tokens · ${duration(null)}`.replace(' · —', '')} />
          </Card>
        </aside>
      </div>
      <NewTraderDialog open={creating} onOpenChange={setCreating} />
    </Page>
  )
}
