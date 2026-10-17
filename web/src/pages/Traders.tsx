import { useEffect, useMemo, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { Plus } from 'lucide-react'
import { Page, PageHeader } from '@/components/Shell'
import { jobState, TraderCard } from '@/components/trader-bits'
import { NewTraderDialog } from '@/components/NewTrader'
import { AgentMark, Button, Card, Dot, Empty, ErrorNote, Input, Segmented, Signed, Spinner } from '@/components/ui'
import { agentKind, MARKET_NAME } from '@/lib/format'
import { useAccounts, useSchedules } from '@/lib/queries'

export function TradersPage() {
  const { accounts, isLoading, error } = useAccounts()
  const schedules = useSchedules()
  const [view, setView] = useState<'cards' | 'table'>('cards')
  const [market, setMarket] = useState<'all' | 'A' | 'HK' | 'US'>('all')
  const [query, setQuery] = useState('')
  const [creating, setCreating] = useState(false)
  useEffect(() => { const open = () => setCreating(true); window.addEventListener('new-trader', open); return () => window.removeEventListener('new-trader', open) }, [])
  const jobs = schedules.data?.jobs ?? []
  const shown = useMemo(() => accounts.filter((account) => (market === 'all' || account.market === market) && (!query || `${account.name} ${account.model} ${account.agent.label ?? ''}`.toLowerCase().includes(query.toLowerCase()))), [accounts, market, query])
  return (
    <Page>
      <PageHeader title="交易员" description="每个交易员是一个模拟账户、一个 Agent 和模型、流派 skill、前置提示词和边界。Agent 是主控，自己写代码策略、自己定频率。"
        actions={<Button variant="primary" size="lg" onClick={() => setCreating(true)}><Plus className="size-4" />新建交易员</Button>} />
      <ErrorNote error={error} />
      <div className="flex flex-wrap items-center gap-3">
        <Segmented label="市场" value={market} onChange={setMarket} options={[['all', '全部'], ['A', 'A 股'], ['HK', '港股'], ['US', '美股']]} />
        <Segmented label="视图" value={view} onChange={setView} options={[['cards', '卡片'], ['table', '列表']]} />
        <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索名称、模型、Agent" aria-label="搜索交易员" className="ml-auto w-64" />
      </div>
      {isLoading ? <Spinner /> : !shown.length ? <Empty title="没有交易员" action={<Button variant="primary" onClick={() => setCreating(true)}>新建交易员</Button>}>也可以让 Agent 在自己的客户端里用 arena_register_account 开户，开户后会出现在这里。</Empty>
        : view === 'cards' ? (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-3">{shown.map((account) => <TraderCard key={account.id} account={account} job={jobs.find((job) => job.accountId === account.id)} />)}</div>
        ) : (
          <Card className="overflow-x-auto p-0">
            <table className="w-full min-w-[900px] border-collapse text-[13px]">
              <thead><tr className="text-left text-xs text-ink-3"><th className="px-4 py-2.5 font-medium">交易员</th><th className="font-medium">市场</th><th className="text-right font-medium">今日</th><th className="text-right font-medium">累计</th><th className="text-right font-medium">持仓</th><th className="text-right font-medium">现金</th><th className="px-4 font-medium">状态</th></tr></thead>
              <tbody>
                {shown.map((account) => {
                  const state = jobState(jobs.find((job) => job.accountId === account.id), account)
                  return (
                    <tr key={account.id} className="border-t border-line">
                      <td className="px-4 py-2.5"><Link to="/traders/$id" params={{ id: account.id }} search={{ tab: undefined }} className="flex items-center gap-2.5 text-ink"><AgentMark kind={agentKind(account)} /><span className="flex flex-col"><span className="font-semibold">{account.name}</span><span className="font-mono text-xs text-ink-3">{account.model}</span></span></Link></td>
                      <td>{MARKET_NAME[account.market]}</td>
                      <td className="text-right"><Signed value={account.metrics.todayReturnPct} /></td>
                      <td className="text-right"><Signed value={account.metrics.totalReturnPct} /></td>
                      <td className="text-right font-mono">{account.metrics.positions}</td>
                      <td className="text-right font-mono">{account.limitStatus ? `${Math.round(account.limitStatus.cashPct)}%` : '—'}</td>
                      <td className="px-4"><span className="flex items-center gap-1.5 text-xs text-ink-2"><Dot tone={state.tone} pulse={state.pulse} />{state.text}</span></td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </Card>
        )}
      <NewTraderDialog open={creating} onOpenChange={setCreating} />
    </Page>
  )
}
