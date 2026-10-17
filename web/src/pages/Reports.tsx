import { useState } from 'react'
import { Link } from '@tanstack/react-router'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { Page, PageHeader } from '@/components/Shell'
import { ReportBody } from './trader/History'
import { AgentMark, Button, Card, Empty, ErrorNote, Input, Pager, Pill, Segmented, Select, Spinner } from '@/components/ui'
import { get, qs, type AccountRef, type Report } from '@/lib/api'
import { agentKind, dateTime, MARKET_NAME } from '@/lib/format'
import { useAction } from '@/lib/queries'
import { t } from '@/lib/i18n'

const SENTIMENT: Record<string, [string, 'ok' | 'bad' | 'neutral' | 'warn']> = { bullish: [t('看多'), 'ok'], bearish: [t('看空'), 'bad'], neutral: [t('中性'), 'neutral'], defensive: [t('防守'), 'warn'] }

export function ReportsPage() {
  const [tab, setTab] = useState<'reports' | 'digests'>('reports')
  return (
    <Page>
      <PageHeader title={t('报告')} description={t('每个交易员的结论报告和每天的收盘日报，都可以在这里检索、筛选、查看全文。')} actions={<Segmented label={t('类型')} value={tab} onChange={setTab} options={[['reports', t('交易员报告')], ['digests', t('收盘日报')]]} />} />
      {tab === 'reports' ? <AgentReports /> : <Digests />}
    </Page>
  )
}

function AgentReports() {
  const [filters, setFilters] = useState({ market: 'all', account: 'all', sentiment: 'all', q: '', from: '', to: '' })
  const [offset, setOffset] = useState(0)
  const [open, setOpen] = useState<string | null>(null)
  const set = (key: keyof typeof filters) => (event: { target: { value: string } }) => { setFilters({ ...filters, [key]: event.target.value }); setOffset(0) }
  const reports = useQuery({ queryKey: ['reports', filters, offset], placeholderData: keepPreviousData, queryFn: ({ signal }) => get<{ reports: Report[]; total: number; all: number; accounts: AccountRef[] }>(`/api/arena/reports${qs({ ...filters, offset, limit: 20 })}`, signal) })
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2.5">
        <Select aria-label={t('市场')} value={filters.market} onChange={set('market')} className="w-28"><option value="all">{t('全部市场')}</option>{['A', 'HK', 'US'].map((key) => <option key={key} value={key}>{MARKET_NAME[key]}</option>)}</Select>
        <Select aria-label={t('交易员')} value={filters.account} onChange={set('account')} className="w-56"><option value="all">{t('全部交易员')}</option>{(reports.data?.accounts ?? []).map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}</Select>
        <Select aria-label={t('观点')} value={filters.sentiment} onChange={set('sentiment')} className="w-28"><option value="all">{t('全部观点')}</option>{Object.entries(SENTIMENT).map(([key, [label]]) => <option key={key} value={key}>{label}</option>)}</Select>
        <Input type="date" aria-label={t('开始日期')} value={filters.from} onChange={set('from')} className="w-40" />
        <Input type="date" aria-label={t('结束日期')} value={filters.to} onChange={set('to')} className="w-40" />
        <Input value={filters.q} onChange={set('q')} placeholder={t('搜索标题、结论、股票')} aria-label={t('搜索报告')} className="w-60 max-sm:w-full" />
      </div>
      <ErrorNote error={reports.error} />
      {reports.isLoading ? <Spinner /> : !reports.data?.reports.length ? <Empty title={t('没有匹配的报告')} /> : (
        <div className="flex flex-col gap-2">
          {reports.data.reports.map((report) => (
            <Card key={report.id} className="p-0">
              <button type="button" onClick={() => setOpen(open === report.id ? null : report.id)} className="flex w-full flex-wrap items-center gap-3 px-4 py-3 text-left">
                <span className="w-24 shrink-0 font-mono text-xs text-ink-3">{dateTime(report.at)}</span>
                {report.account && <span className="flex w-52 shrink-0 items-center gap-2 text-[13px]"><AgentMark kind={agentKind(report.account)} /><span className="truncate">{report.account.name}</span></span>}
                <span className="min-w-[200px] flex-1 font-semibold">{report.title}</span>
                {report.sentiment && <Pill tone={SENTIMENT[report.sentiment]?.[1] ?? 'neutral'}>{SENTIMENT[report.sentiment]?.[0] ?? report.sentiment}</Pill>}
              </button>
              {open === report.id && (
                <div className="flex flex-col gap-3 border-t border-line px-4 py-3">
                  <ReportBody report={report} />
                  {report.account && <Link to="/traders/$id" params={{ id: report.account.id }} search={{ tab: undefined }} className="text-[13px]">{t('去 {name} 的交易员页', { name: report.account.name })}</Link>}
                </div>
              )}
            </Card>
          ))}
          <Pager total={reports.data.total} offset={offset} limit={20} onChange={setOffset} />
        </div>
      )}
    </div>
  )
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function Digests() {
  const [market, setMarket] = useState('all')
  const [offset, setOffset] = useState(0)
  const [open, setOpen] = useState<string | null>(null)
  const digests = useQuery({ queryKey: ['digests', market, offset], placeholderData: keepPreviousData, queryFn: ({ signal }) => get<{ digests: any[]; total: number; webhook: { host: string; format: string; enabled: boolean } | null }>(`/api/arena/digests${qs({ market, offset, limit: 20 })}`, signal) })
  const make = useAction<{ send?: boolean; market?: string }>('/api/arena/digests', { invalidate: [['digests']], success: (result: unknown) => { const delivery = (result as any).delivery; return delivery ? (delivery.status === 'delivered' ? t('日报已推送') : t('推送失败：{error}', { error: delivery.error ?? '' })) : t('已生成最新日报') } })
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2.5">
        <Segmented label={t('市场')} value={market} onChange={(value) => { setMarket(value); setOffset(0) }} options={[['all', t('全部')], ['A', MARKET_NAME.A], ['HK', MARKET_NAME.HK], ['US', MARKET_NAME.US]]} />
        <span className="text-xs text-ink-3">{digests.data?.webhook ? t('推送到 {host}（{format}）', { host: digests.data.webhook.host, format: digests.data.webhook.format }) : t('没有设置推送')} · <Link to="/settings" search={{ section: 'push' }}>{t('推送设置')}</Link></span>
        <span className="flex-1" />
        <Button onClick={() => make.mutate({ market: market === 'all' ? undefined : market })} loading={make.isPending && !make.variables?.send}>{t('立即生成')}</Button>
        {digests.data?.webhook && <Button variant="primary" onClick={() => make.mutate({ send: true, market: market === 'all' ? undefined : market })} loading={make.isPending && Boolean(make.variables?.send)}>{t('生成并推送')}</Button>}
      </div>
      {digests.isLoading ? <Spinner /> : !digests.data?.digests.length ? <Empty title={t('还没有日报')}>{t('每个市场收盘后，后台撮合器会自动汇总所有交易员的收益、成交、报告和提醒。')}</Empty> : (
        <div className="flex flex-col gap-2">
          {digests.data.digests.map((digest) => (
            <Card key={digest.id} className="p-0">
              <button type="button" onClick={() => setOpen(open === digest.id ? null : digest.id)} className="flex w-full flex-wrap items-center gap-3 px-4 py-3 text-left">
                <span className="w-24 shrink-0 font-mono text-xs text-ink-3">{digest.date}</span>
                <span className="flex-1 font-semibold">{digest.title}</span>
                <span className="text-xs text-ink-2">{digest.headline}</span>
                {digest.delivery && <Pill tone={digest.delivery.status === 'delivered' ? 'ok' : digest.delivery.status === 'failed' ? 'bad' : 'neutral'}>{digest.delivery.status === 'delivered' ? t('已推送') : digest.delivery.status === 'failed' ? t('推送失败 ×{n}', { n: digest.delivery.attempts ?? 1 }) : digest.delivery.status}</Pill>}
              </button>
              {open === digest.id && <pre className="m-0 whitespace-pre-wrap border-t border-line px-4 py-3 font-sans text-[13px]">{digest.text}</pre>}
            </Card>
          ))}
          <Pager total={digests.data.total} offset={offset} limit={20} onChange={setOffset} />
        </div>
      )}
    </div>
  )
}
