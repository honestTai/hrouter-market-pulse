import { useMemo, useState } from 'react'
import { Plus } from 'lucide-react'
import { Page, PageHeader } from '@/components/Shell'
import { ApprovalCard, PausedCard, PoolCard, RequestCard, TraderCard, useRequests } from '@/components/trader-bits'
import { AgentMark, Button, Card, CardTitle, Empty, ErrorNote, Segmented, Signed, Spinner, Stat } from '@/components/ui'
import { NewTraderDialog } from '@/components/NewTrader'
import { AGENT_NAME, BENCHMARK_NAME, MARKET_NAME } from '@/lib/format'
import { locale, t } from '@/lib/i18n'
import { useAccounts, useApprovals, usePools, useSchedules, useUsage } from '@/lib/queries'

const today = () => new Intl.DateTimeFormat(locale(), { month: 'long', day: 'numeric', weekday: 'short' }).format(new Date())

export function HomePage() {
  const { accounts, isLoading, error } = useAccounts()
  const schedules = useSchedules()
  const pools = usePools()
  const usage = useUsage()
  const approvals = useApprovals()
  const requests = useRequests(accounts)
  const [market, setMarket] = useState<'all' | 'A' | 'HK' | 'US'>('all')
  const [creating, setCreating] = useState(false)
  const jobs = schedules.data?.jobs ?? []
  const waiting = approvals.data?.approvals ?? []
  const paused = jobs.filter((job) => job.paused).map((job) => ({ job, account: accounts.find((account) => account.id === job.accountId) })).filter((entry) => entry.account)
  const exhausted = (pools.data?.pools ?? []).filter((pool) => pool.paused)
  const attention = waiting.length + requests.length + paused.length + exhausted.length
  const sorted = useMemo(() => [...accounts].filter((account) => market === 'all' || account.market === market).sort((a, b) => (b.metrics.todayReturnPct ?? -999) - (a.metrics.todayReturnPct ?? -999)), [accounts, market])
  const leader = [...accounts].sort((a, b) => (b.metrics.todayReturnPct ?? -999) - (a.metrics.todayReturnPct ?? -999))[0]
  const beating = accounts.filter((account) => (account.metrics.excessReturnPct ?? 0) > 0).length
  const fills = accounts.reduce((sum, account) => sum + (account.metrics.todayFills ?? 0), 0)
  const rejected = accounts.reduce((sum, account) => sum + (account.metrics.todayRejected ?? 0), 0)
  const running = jobs.filter((job) => job.running || job.strategyRunning)
  const lanes = schedules.data?.scheduler.running ?? []
  const skipped = jobs.reduce((sum, job) => sum + (job.gateToday?.date ? job.gateToday.skipped ?? 0 : 0), 0)
  const wakes = jobs.reduce((sum, job) => sum + (job.gateToday?.date ? job.gateToday.wakes ?? 0 : 0), 0)

  return (
    <Page>
      <PageHeader eyebrow={`${today()} · ${t('模拟盘 · 真实行情')}`} title={t('工作台')}
        description={isLoading ? t('读取交易员…') : attention ? t('{n} 个交易员在跑，{m} 件事需要你看一下。', { n: accounts.length, m: attention }) : t('{n} 个交易员在跑，没有需要你处理的事。', { n: accounts.length })}
        actions={<Button variant="primary" size="lg" onClick={() => setCreating(true)}><Plus className="size-4" />{t('新建交易员')}</Button>} />
      <ErrorNote error={error} />

      <div className="grid grid-cols-4 gap-4 max-lg:grid-cols-2 max-sm:grid-cols-1">
        <Card className="p-4"><Stat label={t('今日领先')} value={leader ? <Signed value={leader.metrics.todayReturnPct} className="text-[20px]" /> : '—'} sub={leader?.name ?? t('还没有交易员')} /></Card>
        <Card className="p-4"><Stat label={t('跑赢基准')} value={<>{beating}<span className="text-sm text-ink-3"> / {accounts.length}</span></>} sub={[...new Set(accounts.map((account) => account.market))].map((key) => BENCHMARK_NAME[key]).join(' · ') || '—'} /></Card>
        <Card className="p-4"><Stat label={t('今日成交 / 被边界拦下')} value={<>{fills}<span className="text-sm text-ink-3"> / {rejected}</span></>} sub={t('拦截原因在交易员页的时间线里')} /></Card>
        <Card className="p-4"><Stat label={t('今日复查')} value={<>{usage.data?.totals.reviews ?? 0}<span className="text-sm text-ink-3"> {t('次')}</span></>} sub={t('无变化跳过 {s} 次 · 提前叫醒 {w} 次', { s: skipped, w: wakes })} /></Card>
      </div>

      {attention > 0 && (
        <section aria-labelledby="h-attn" className="flex flex-col gap-3">
          <div className="flex items-center gap-2"><h2 id="h-attn" className="m-0 text-base font-semibold">{t('需要你看')}</h2><span className="rounded-full bg-accent px-[7px] font-mono text-xs text-white">{attention}</span></div>
          <div className="grid grid-cols-[repeat(auto-fit,minmax(min(380px,100%),1fr))] gap-4">
            {waiting.map((approval) => approval.account && <ApprovalCard key={approval.id} approval={approval} account={approval.account} />)}
            {requests.map(({ account, request }) => <RequestCard key={request.id} account={account} request={request} />)}
            {paused.map(({ job, account }) => <PausedCard key={job.accountId} job={job} account={account!} />)}
            {exhausted.map((pool) => <PoolCard key={pool.key} pool={pool} accounts={accounts} />)}
          </div>
        </section>
      )}

      <div className="flex flex-wrap items-start gap-6">
        <section aria-labelledby="h-traders" className="flex min-w-0 flex-[999_1_640px] flex-col gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <h2 id="h-traders" className="m-0 text-base font-semibold">{t('交易员')}</h2>
            <Segmented label={t('市场')} value={market} onChange={setMarket} options={[['all', t('全部')], ['A', MARKET_NAME.A], ['HK', MARKET_NAME.HK], ['US', MARKET_NAME.US]]} />
            <span className="ml-auto text-[13px] text-ink-3">{t('按今日收益排序')}</span>
          </div>
          {isLoading ? <Spinner /> : sorted.length ? (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(min(300px,100%),1fr))] gap-3">
              {sorted.map((account) => <TraderCard key={account.id} account={account} job={jobs.find((job) => job.accountId === account.id)} />)}
            </div>
          ) : <Empty title={market === 'all' ? t('还没有交易员') : t('没有{market}交易员', { market: MARKET_NAME[market] })} action={<Button variant="primary" onClick={() => setCreating(true)}>{t('新建交易员')}</Button>}>{t('新建一个交易员，选 Agent、流派和边界；也可以让 Agent 在自己的客户端里用 arena_register_account 开户。')}</Empty>}
        </section>

        <aside aria-label={t('运行状态')} className="flex min-w-0 flex-[1_1_300px] flex-col gap-4">
          <Card className="flex flex-col gap-3 p-4">
            <CardTitle extra={<span className="text-xs text-ink-3">{t('Agent {a} · 策略 {s}', { a: lanes.filter((key) => !key.endsWith(':S')).length, s: lanes.filter((key) => key.endsWith(':S')).length })}</span>}>{t('正在运行')}</CardTitle>
            {running.length ? running.map((job) => {
              const account = accounts.find((entry) => entry.id === job.accountId)
              return (
                <div key={job.accountId} className="flex items-start gap-2.5">
                  <AgentMark kind={job.running && job.runner.type !== 'strategy' ? job.runner.type : 'strategy'} size={28} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] font-semibold">{job.running && job.runner.type !== 'strategy' ? t('复查') : t('策略执行')} · {account?.name ?? job.accountId}</div>
                    <div className="truncate font-mono text-xs text-ink-3">{job.runner.model ?? job.strategy?.strategyId ?? job.runner.strategyId ?? ''}</div>
                  </div>
                </div>
              )
            }) : <div className="text-[13px] text-ink-3">{t('现在没有在跑的复查或策略。')}{schedules.data?.service.state !== 'running' ? t('常驻服务没在运行，调度不会按时触发。') : ''}</div>}
          </Card>

          <Card className="flex flex-col gap-3 p-4">
            <CardTitle>{t('额度池')}</CardTitle>
            {(pools.data?.pools ?? []).length ? pools.data!.pools.map((pool) => {
              return (
                <div key={pool.key} className="flex flex-col gap-0.5">
                  <div className="flex text-[13px]"><span className="flex-1">{AGENT_NAME[pool.key] ?? pool.key}</span><span className={pool.paused ? 'font-mono text-warn-ink' : 'font-mono text-ink-2'}>{pool.paused ? t('用尽') : t('正常')}</span></div>
                  <div className="text-xs text-ink-3">{t('{n} 个交易员', { n: pool.traders.length })}{pool.backups.length ? t(' + 备用 {n}', { n: pool.backups.length }) : ''}</div>
                </div>
              )
            }) : <div className="text-[13px] text-ink-3">{t('还没有 Agent 交易员。')}</div>}
          </Card>

          <Card className="grid grid-cols-2 gap-3.5 p-4">
            <h2 className="col-span-2 m-0 text-[15px] font-semibold">{t('今天')}</h2>
            <Stat label={t('复查')} value={t('{n} 次', { n: usage.data?.totals.reviews ?? 0 })} sub={t('无变化跳过 {n} 次', { n: skipped })} />
            <Stat label={t('失败')} value={t('{n} 次', { n: usage.data?.totals.failed ?? 0 })} />
            <Stat label={t('策略执行')} value={t('{n} 次', { n: usage.data?.totals.strategyRuns ?? 0 })} />
            <Stat label={t('提前叫醒')} value={t('{n} 次', { n: wakes })} />
          </Card>
        </aside>
      </div>
      <NewTraderDialog open={creating} onOpenChange={setCreating} />
    </Page>
  )
}
