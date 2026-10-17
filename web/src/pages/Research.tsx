import { useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { Page, PageHeader } from '@/components/Shell'
import { EvidenceList } from '@/components/Evidence'
import { Button, Card, Dialog, Empty, ErrorNote, Field, Input, Pager, Pill, Segmented, Select, Spinner, Textarea } from '@/components/ui'
import { get, post } from '@/lib/api'
import { dateTime } from '@/lib/format'
import { collectEvidence, titleOf } from '@/lib/market'
import { useMarketReport } from './Market'

/* eslint-disable @typescript-eslint/no-explicit-any */
const STATE: Record<string, string> = { watch: '观察', candidate: '候选评审', hold: '持有观察', 'review-exit': '退出评审', inactive: '已停用' }
const OUTCOME: Record<string, string> = { open: '继续观察', invalidated: '条件失效', 'target-reached': '目标达到', expired: '观察到期', closed: '已结束' }
const PILLAR: Record<string, [string, 'ok' | 'warn' | 'bad' | 'neutral']> = { supported: ['得到支持', 'ok'], weakened: ['论据削弱', 'warn'], invalidated: ['论据失效', 'bad'], inconclusive: ['证据不足', 'neutral'], unreviewed: ['待验证', 'neutral'] }

export function ResearchPage() {
  const [tab, setTab] = useState<'evidence' | 'journal'>('evidence')
  return (
    <Page>
      <PageHeader title="研究" description="从原始资料出发，区分事实、事件和推断；保存当时的判断，用新证据追加复盘。"
        actions={<Segmented label="页面" value={tab} onChange={setTab} options={[['evidence', '证据与事件'], ['journal', '研究记录']]} />} />
      {tab === 'evidence' ? <Evidence /> : <Journal />}
    </Page>
  )
}

function Evidence() {
  const report = useMarketReport()
  const evidence = useQuery({ queryKey: ['evidence'], queryFn: ({ signal }) => get<{ items: any[]; events?: any[]; eventWarnings?: string[] }>('/api/evidence', signal) })
  const client = useQueryClient()
  const [kind, setKind] = useState<'all' | 'events' | 'financial' | 'official'>('all')
  const [symbol, setSymbol] = useState('all')
  const [query, setQuery] = useState('')
  const [offset, setOffset] = useState(0)
  const [syncing, setSyncing] = useState(false)
  const all = useMemo(() => collectEvidence({ evidence: evidence.data?.items ?? [], events: evidence.data?.events ?? [], items: report.data?.items ?? [] }), [evidence.data, report.data])
  const symbols = [...new Set(all.map((row) => row.symbol).filter(Boolean))].sort()
  const rows = all.filter((row) => (symbol === 'all' || row.symbol === symbol) && (kind === 'all' || (kind === 'events' ? row.scheduledAt : kind === 'financial' ? row.kind === 'financial' : row.sourceTier === 'official')) && `${titleOf(row)} ${row.symbol ?? ''} ${row.payload?.metric ?? ''}`.toLowerCase().includes(query.toLowerCase()))
  const sync = async () => {
    setSyncing(true)
    try {
      const symbolsToSync = symbol === 'all' ? (report.data?.items ?? []).map((item) => item.symbol) : [symbol]
      await post('/api/official/sync', { symbols: symbolsToSync })
      client.invalidateQueries({ queryKey: ['evidence'] })
      toast.success('官方来源同步完成，请核对各数据源的状态')
    } catch (error) { toast.error((error as Error).message) } finally { setSyncing(false) }
  }
  return (
    <Card className="flex flex-col gap-3 p-4">
      <div className="flex flex-wrap items-center gap-2.5">
        <Segmented label="类型" value={kind} onChange={(value) => { setKind(value); setOffset(0) }} options={[['all', '全部证据'], ['events', '事件日历'], ['financial', '财务事实'], ['official', '官方来源']]} />
        <Select aria-label="标的" value={symbol} onChange={(event) => { setSymbol(event.target.value); setOffset(0) }} className="w-40"><option value="all">所有标的</option>{symbols.map((entry) => <option key={entry}>{entry}</option>)}</Select>
        <Input value={query} onChange={(event) => { setQuery(event.target.value); setOffset(0) }} placeholder="搜索标题、代码、财务指标" aria-label="搜索证据" className="w-64" />
        <Button className="ml-auto" loading={syncing} onClick={sync}><RefreshCw className="size-4" />同步官方来源</Button>
      </div>
      <ErrorNote error={evidence.error} />
      {(evidence.data?.eventWarnings ?? []).map((warning) => <div key={warning} className="rounded-lg bg-warn-soft px-3 py-2 text-xs text-warn-ink">{warning}</div>)}
      {evidence.isLoading ? <Spinner /> : <EvidenceList rows={rows.slice(offset, offset + 20)} />}
      <Pager total={rows.length} offset={offset} limit={20} onChange={setOffset} />
      <div className="text-xs text-ink-3">只包含已导入的证据，不代表全市场事件；查询事件不会创建提醒。</div>
    </Card>
  )
}

function Journal() {
  const decisions = useQuery({ queryKey: ['decisions'], queryFn: ({ signal }) => get<{ decisions: any[] }>('/api/decisions', signal) })
  const [state, setState] = useState('all')
  const [query, setQuery] = useState('')
  const [creating, setCreating] = useState(false)
  const [reviewing, setReviewing] = useState<any>(null)
  const rows = (decisions.data?.decisions ?? []).filter((row) => (state === 'all' || row.state === state) && `${row.symbol} ${row.thesis}`.toLowerCase().includes(query.toLowerCase()))
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2.5">
        <Select aria-label="状态" value={state} onChange={(event) => setState(event.target.value)} className="w-40"><option value="all">全部状态</option>{Object.entries(STATE).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</Select>
        <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索标的或投资逻辑" aria-label="搜索研究记录" className="w-64" />
        <Button variant="primary" className="ml-auto" onClick={() => setCreating(true)}><Plus className="size-4" />新建研究记录</Button>
      </div>
      <ErrorNote error={decisions.error} />
      {decisions.isLoading ? <Spinner /> : !rows.length ? <Empty title="还没有研究记录">先写下理由、失效条件与证据。复盘只会追加，不会改写原始记录。</Empty> : rows.map((row) => (
        <Card key={row.id} className="flex flex-col gap-2.5 p-4">
          <div className="flex flex-wrap items-center gap-2">
            <Pill tone="accent">{row.symbol}</Pill><Pill>{STATE[row.state] ?? row.state}</Pill>
            <span className="text-xs text-ink-3">{dateTime(row.createdAt ?? row.recordedAt)}</span>
            <Button size="sm" className="ml-auto" onClick={() => setReviewing(row)}>追加复盘</Button>
          </div>
          <p className="m-0 whitespace-pre-wrap text-[14px]">{row.thesis}</p>
          <div className="grid grid-cols-3 gap-2 text-xs text-ink-2 max-md:grid-cols-1">
            {row.entryCondition && <div><span className="text-ink-3">入场条件：</span>{row.entryCondition}</div>}
            {row.invalidationCondition && <div><span className="text-ink-3">失效条件：</span>{row.invalidationCondition}</div>}
            {row.horizon && <div><span className="text-ink-3">观察周期：</span>{row.horizon}</div>}
          </div>
          {row.scorecard?.pillars?.length > 0 && (
            <div className="flex flex-col gap-1.5 border-t border-line pt-2.5">
              <div className="text-xs font-semibold text-ink-3">投资逻辑卡（研究判断，不是盈利概率）</div>
              {row.scorecard.pillars.map((pillar: any) => <div key={pillar.id} className="flex flex-wrap items-center gap-2 text-[13px]"><Pill tone={PILLAR[pillar.status]?.[1] ?? 'neutral'}>{PILLAR[pillar.status]?.[0] ?? pillar.status}</Pill><span>{pillar.expectation}</span><span className="text-xs text-ink-3">失效：{pillar.invalidationCondition}</span></div>)}
            </div>
          )}
          {row.reviews?.length > 0 && (
            <div className="flex flex-col gap-1.5 border-t border-line pt-2.5">
              <div className="text-xs font-semibold text-ink-3">复盘时间线</div>
              {row.reviews.map((review: any, index: number) => <div key={index} className="text-[13px]"><span className="mr-2 font-mono text-xs text-ink-3">{dateTime(review.reviewedAt ?? review.at)}</span><Pill>{OUTCOME[review.outcome] ?? review.outcome}</Pill> <span className="text-ink-2">{review.notes || '无补充说明'}</span></div>)}
            </div>
          )}
        </Card>
      ))}
      <DecisionDialog open={creating} onOpenChange={setCreating} />
      {reviewing && <ReviewDialog record={reviewing} onClose={() => setReviewing(null)} />}
    </div>
  )
}

function DecisionDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (value: boolean) => void }) {
  const client = useQueryClient()
  const [form, setForm] = useState({ symbol: '', state: 'watch', thesis: '', entryCondition: '', invalidationCondition: '', horizon: '', riskBudget: '', notes: '' })
  const [pillars, setPillars] = useState<Array<{ expectation: string; invalidationCondition: string; reviewBy: string }>>([])
  const [saving, setSaving] = useState(false)
  const set = (key: keyof typeof form) => (event: { target: { value: string } }) => setForm({ ...form, [key]: event.target.value })
  const save = async () => {
    setSaving(true)
    try {
      await post('/api/decisions', { ...form, ...(pillars.length ? { pillars: pillars.map((pillar, index) => ({ id: `pillar_${index + 1}`, expectation: pillar.expectation, invalidationCondition: pillar.invalidationCondition, ...(pillar.reviewBy ? { reviewBy: pillar.reviewBy } : {}) })) } : {}) })
      client.invalidateQueries({ queryKey: ['decisions'] })
      toast.success('原始研究判断已保存')
      onOpenChange(false)
    } catch (error) { toast.error((error as Error).message) } finally { setSaving(false) }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="新建研究记录" description="记下当时的理由和失效条件。保存后不会被改写，之后只追加复盘。" width={720}>
      <div className="grid grid-cols-2 gap-3 max-sm:grid-cols-1">
        <Field label="证券代码 *"><Input value={form.symbol} onChange={set('symbol')} placeholder="600519 / 0700.HK / AAPL" /></Field>
        <Field label="研究状态"><Select value={form.state} onChange={set('state')}>{Object.entries(STATE).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</Select></Field>
        <Field label="投资逻辑 *" className="col-span-full"><Textarea rows={3} value={form.thesis} onChange={set('thesis')} /></Field>
        <Field label="入场条件"><Input value={form.entryCondition} onChange={set('entryCondition')} /></Field>
        <Field label="失效条件"><Input value={form.invalidationCondition} onChange={set('invalidationCondition')} /></Field>
        <Field label="观察周期"><Input value={form.horizon} onChange={set('horizon')} placeholder="例如 3 个月" /></Field>
        <Field label="风险预算"><Input value={form.riskBudget} onChange={set('riskBudget')} /></Field>
        <Field label="备注" className="col-span-full"><Textarea rows={2} value={form.notes} onChange={set('notes')} /></Field>
      </div>
      <div className="mt-4 flex flex-col gap-2">
        <div className="flex items-center"><span className="text-[13px] font-semibold">可证伪的论据（可选）</span><Button size="sm" className="ml-auto" disabled={pillars.length >= 12} onClick={() => setPillars([...pillars, { expectation: '', invalidationCondition: '', reviewBy: '' }])}><Plus className="size-4" />添加论据</Button></div>
        {pillars.map((pillar, index) => (
          <div key={index} className="grid grid-cols-[2fr_2fr_1fr] gap-2 max-sm:grid-cols-1">
            <Input aria-label="预期" placeholder="预期" value={pillar.expectation} onChange={(event) => setPillars(pillars.map((entry, position) => position === index ? { ...entry, expectation: event.target.value } : entry))} />
            <Input aria-label="失效条件" placeholder="失效条件" value={pillar.invalidationCondition} onChange={(event) => setPillars(pillars.map((entry, position) => position === index ? { ...entry, invalidationCondition: event.target.value } : entry))} />
            <Input aria-label="复核日期" type="date" value={pillar.reviewBy} onChange={(event) => setPillars(pillars.map((entry, position) => position === index ? { ...entry, reviewBy: event.target.value } : entry))} />
          </div>
        ))}
      </div>
      <div className="mt-5 flex justify-end gap-2"><Button onClick={() => onOpenChange(false)}>取消</Button><Button variant="primary" loading={saving} disabled={!form.symbol.trim() || !form.thesis.trim()} onClick={save}>保存</Button></div>
    </Dialog>
  )
}

function ReviewDialog({ record, onClose }: { record: any; onClose: () => void }) {
  const client = useQueryClient()
  const [outcome, setOutcome] = useState('open')
  const [notes, setNotes] = useState('')
  const [saving, setSaving] = useState(false)
  const save = async () => {
    setSaving(true)
    try { await post(`/api/decisions/${encodeURIComponent(record.id)}/review`, { outcome, notes }); client.invalidateQueries({ queryKey: ['decisions'] }); toast.success('复盘已追加，原始判断不变'); onClose() }
    catch (error) { toast.error((error as Error).message) } finally { setSaving(false) }
  }
  return (
    <Dialog open onOpenChange={(value) => !value && onClose()} title="追加复盘" description={`${record.symbol} · ${record.thesis.slice(0, 80)}`}>
      <div className="flex flex-col gap-3">
        <Field label="结论"><Select value={outcome} onChange={(event) => setOutcome(event.target.value)}>{Object.entries(OUTCOME).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</Select></Field>
        <Field label="说明"><Textarea rows={4} value={notes} onChange={(event) => setNotes(event.target.value)} /></Field>
        <div className="flex justify-end gap-2"><Button onClick={onClose}>取消</Button><Button variant="primary" loading={saving} onClick={save}>追加</Button></div>
      </div>
    </Dialog>
  )
}
