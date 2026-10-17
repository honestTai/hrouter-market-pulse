import { useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate, useSearch } from '@tanstack/react-router'
import { Plus, RefreshCw, RotateCcw, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Page, PageHeader } from '@/components/Shell'
import { EvidenceList } from '@/components/Evidence'
import { Expandable } from '@/components/Expandable'
import { Markdown } from '@/components/Markdown'
import { AgentMark, Button, Card, CardTitle, Dialog, Dot, Empty, ErrorNote, Field, Input, Pager, Pill, Segmented, Select, Spinner, Textarea, cn } from '@/components/ui'
import { get, post, type ResearchTask } from '@/lib/api'
import { AGENT_NAME, compact, dateTime, duration } from '@/lib/format'
import { t } from '@/lib/i18n'
import { collectEvidence, titleOf } from '@/lib/market'
import { useAction, useResearchTasks, useRunEvents } from '@/lib/queries'
import { useAgentOptions } from './trader/Settings'
import { useMarketReport } from './Market'

/* eslint-disable @typescript-eslint/no-explicit-any */
const STATE: Record<string, string> = { watch: t('观察'), candidate: t('候选评审'), hold: t('持有观察'), 'review-exit': t('退出评审'), inactive: t('已停用') }
const OUTCOME: Record<string, string> = { open: t('继续观察'), invalidated: t('条件失效'), 'target-reached': t('目标达到'), expired: t('观察到期'), closed: t('已结束') }
const PILLAR: Record<string, [string, 'ok' | 'warn' | 'bad' | 'neutral']> = { supported: [t('得到支持'), 'ok'], weakened: [t('论据削弱'), 'warn'], invalidated: [t('论据失效'), 'bad'], inconclusive: [t('证据不足'), 'neutral'], unreviewed: [t('待验证'), 'neutral'] }
const KIND: Record<string, string> = { question: t('研究问题'), 'deep-dive': t('个股深度'), 'investor-panel': t('投资人评审'), market: t('市场复盘') }
const TASK_STATUS: Record<string, [string, 'neutral' | 'accent' | 'ok' | 'bad']> = { queued: [t('排队中'), 'neutral'], running: [t('研究中'), 'accent'], done: [t('完成'), 'ok'], failed: [t('失败'), 'bad'] }

export function ResearchPage() {
  const [tab, setTab] = useState<'tasks' | 'evidence' | 'journal'>('tasks')
  return (
    <Page>
      <PageHeader title={t('研究')} description={t('让 Agent 只读地做一次研究（不下单），或从原始资料出发核对证据、记下判断再追加复盘。')}
        actions={<Segmented label={t('页面')} value={tab} onChange={setTab} options={[['tasks', t('研究任务')], ['evidence', t('证据与事件')], ['journal', t('研究记录')]]} />} />
      {tab === 'tasks' ? <Tasks /> : tab === 'evidence' ? <Evidence /> : <Journal />}
    </Page>
  )
}

function Tasks() {
  const search = useSearch({ from: '/research' })
  const navigate = useNavigate()
  const tasks = useResearchTasks()
  const list = tasks.data?.tasks ?? []
  const [creating, setCreating] = useState(search.new === '1')
  const [selected, setSelected] = useState<string | null>(search.task ?? null)
  useEffect(() => { if (search.new === '1') { setCreating(true); navigate({ to: '/research', search: { new: undefined, task: undefined }, replace: true }) } }, [search.new, navigate])
  const focus = list.find((task) => task.id === selected) ?? list[0]
  return (
    <div className="flex flex-wrap items-start gap-4">
      <Card className="flex min-w-0 flex-[1_1_320px] flex-col gap-2 p-4 lg:max-w-[400px]">
        <CardTitle extra={<Button size="sm" variant="primary" className="ml-auto" onClick={() => setCreating(true)}><Plus className="size-4" />{t('新建')}</Button>}>{t('研究任务')}</CardTitle>
        <ErrorNote error={tasks.error} />
        {tasks.isLoading ? <Spinner /> : list.length ? list.map((task) => (
          <button key={task.id} type="button" onClick={() => setSelected(task.id)} className={cn('flex flex-col gap-1 rounded-[10px] border p-3 text-left', focus?.id === task.id ? 'border-accent-line bg-accent-soft' : 'border-line hover:border-line-strong')}>
            <span className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-[13px] font-semibold">{task.title}</span>
              <Pill tone={TASK_STATUS[task.status]?.[1] ?? 'neutral'}>{task.status === 'running' && <Dot tone="accent" pulse />}{TASK_STATUS[task.status]?.[0] ?? task.status}</Pill>
            </span>
            <span className="flex flex-wrap items-center gap-1.5 text-xs text-ink-3"><AgentMark kind={task.runner.type} size={16} />{KIND[task.kind]}{task.symbols.length ? ` · ${task.symbols.join(', ')}` : ''} · {dateTime(task.createdAt)}</span>
          </button>
        )) : <Empty title={t('还没有研究任务')} action={<Button variant="primary" onClick={() => setCreating(true)}>{t('新建研究任务')}</Button>}>{t('问一个研究问题、做个股深度、请五位投资人评审，或者复盘今天的市场。Agent 只读运行，不会下单。')}</Empty>}
      </Card>
      <div className="flex min-w-0 flex-[999_1_560px] flex-col gap-4">
        {focus ? <TaskReport task={focus} /> : null}
      </div>
      <NewTaskDialog open={creating} onOpenChange={setCreating} onCreated={(task) => setSelected(task.id)} />
    </div>
  )
}

function TaskReport({ task }: { task: ResearchTask }) {
  const running = task.status === 'running' || task.status === 'queued'
  const events = useRunEvents(task.runId ?? task.result?.runId, running)
  const retry = useAction(`/api/research/${task.id}/retry`, { invalidate: [['research-tasks']], success: t('已重新开始') })
  const remove = useAction(`/api/research/${task.id}/delete`, { invalidate: [['research-tasks']], success: t('已删除') })
  const steps = (events.data?.events ?? []).filter((event) => event.t === 'tool').slice(-12)
  const usage = task.result?.usage
  return (
    <Expandable title={task.title}>
      <Card className="flex flex-col gap-3 p-5">
        <div className="flex flex-wrap items-center gap-2 pr-8">
          <h2 className="m-0 min-w-0 flex-1 text-lg font-semibold">{task.title}</h2>
          <Pill tone={TASK_STATUS[task.status]?.[1] ?? 'neutral'}>{TASK_STATUS[task.status]?.[0] ?? task.status}</Pill>
          {!running && <Button size="sm" onClick={() => retry.mutate({})} loading={retry.isPending}><RotateCcw className="size-3.5" />{t('重新研究')}</Button>}
          {!running && <Button size="sm" variant="ghost" aria-label={t('删除这个任务')} onClick={() => { if (window.confirm(t('删除「{title}」？', { title: task.title }))) remove.mutate({}) }}><Trash2 className="size-3.5" /></Button>}
        </div>
        <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-ink-3">
          <span>{KIND[task.kind]}</span>
          {task.symbols.length > 0 && <span className="font-mono">{task.symbols.join(', ')}</span>}
          <span>{AGENT_NAME[task.runner.type] ?? task.runner.type}{task.runner.model ? ` · ${task.runner.model}` : ''}</span>
          <span>{t('创建于 {time}', { time: dateTime(task.createdAt) })}</span>
          {task.startedAt && task.finishedAt && <span>{t('用时 {d}', { d: duration(Date.parse(task.finishedAt) - Date.parse(task.startedAt)) })}</span>}
          {usage && <span>{t('{n} tokens', { n: compact(usage.inputTokens + usage.outputTokens) })}</span>}
        </div>
        {task.prompt && <p className="m-0 rounded-lg bg-surface-2 px-3 py-2 text-[13px] text-ink-2">{task.prompt}</p>}
        {running ? (
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2 text-[13px] text-accent-ink"><Spinner className="text-accent" />{task.status === 'queued' ? t('排队中，前面的复查跑完就开始…') : t('Agent 正在查资料…')}</div>
            {steps.length > 0 && <ol className="m-0 flex flex-col gap-1 p-0">{steps.map((event, index) => <li key={index} className="flex list-none items-center gap-2 text-xs text-ink-2"><Dot tone="muted" /><span className="font-mono">{String(event.name ?? '').replace('mcp__hrouter_market_pulse__', '')}</span><span className="truncate text-ink-3">{JSON.stringify(event.input ?? {}).slice(0, 90)}</span></li>)}</ol>}
          </div>
        ) : task.status === 'failed' ? <ErrorNote error={task.result?.error ?? t('研究失败')} /> : task.result?.text ? <Markdown text={task.result.text} /> : <Empty title={t('没有报告')}>{t('Agent 没有输出文字。')}</Empty>}
        <p className="m-0 border-t border-line pt-2.5 text-[11px] text-ink-3">{t('研究任务只读运行：不能下单、不能改任何交易员的设置。结论来自 Agent，数据以工具返回的为准，不构成投资建议。')}</p>
      </Card>
    </Expandable>
  )
}

function NewTaskDialog({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (value: boolean) => void; onCreated: (task: ResearchTask) => void }) {
  const options = useAgentOptions().filter((option) => option.runner.type !== 'kimi')
  const [kind, setKind] = useState<'question' | 'deep-dive' | 'investor-panel' | 'market'>('question')
  const [title, setTitle] = useState('')
  const [symbols, setSymbols] = useState('')
  const [prompt, setPrompt] = useState('')
  const [agent, setAgent] = useState('')
  const [model, setModel] = useState('')
  useEffect(() => { if (!agent && options.length) setAgent(options[0].key) }, [options, agent])
  const create = useAction<Record<string, unknown>, ResearchTask>('/api/research', { invalidate: [['research-tasks']], success: t('已开始研究，进度会实时显示') })
  const symbolList = symbols.split(/[\s,，、]+/).map((entry) => entry.trim()).filter(Boolean)
  const needsSymbols = kind === 'deep-dive' || kind === 'investor-panel'
  const autoTitle = title.trim() || (kind === 'market' ? t('市场复盘') : needsSymbols && symbolList.length ? `${KIND[kind]} · ${symbolList.join(', ')}` : prompt.trim().slice(0, 30))
  const ready = autoTitle && agent && (!needsSymbols || symbolList.length) && (kind !== 'question' || prompt.trim().length >= 4)
  const submit = () => {
    const option = options.find((entry) => entry.key === agent)
    create.mutate({ kind, title: autoTitle, symbols: symbolList, prompt, runner: { ...option!.runner, ...(model ? { model } : {}) } }, { onSuccess: (task) => { onCreated(task); onOpenChange(false); setTitle(''); setSymbols(''); setPrompt('') } })
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={t('新建研究任务')} description={t('Agent 只读运行：查行情、新闻、公告和市场数据，写一份报告。不会下单。')} width={620}>
      <div className="flex flex-col gap-3">
        <Segmented label={t('研究类型')} value={kind} onChange={setKind} options={[['question', KIND.question], ['deep-dive', KIND['deep-dive']], ['investor-panel', KIND['investor-panel']], ['market', KIND.market]]} />
        <p className="m-0 text-xs text-ink-3">{{ question: t('任何研究问题：一个题材、一条政策、一家公司的某个疑问。'), 'deep-dive': t('行情趋势、新闻公告、估值、龙虎榜和融资、风险，最后给结论和失效条件。'), 'investor-panel': t('巴菲特、芒格、格雷厄姆、彼得·林奇、德鲁肯米勒各按自己的检查清单评审，再写共识和分歧。'), market: t('涨跌家数、情绪阶段、主线题材和资金，列出下个交易日要观察的点。') }[kind]}</p>
        {needsSymbols && <Field label={t('股票代码 *')} hint={t('最多 10 只，用逗号或空格分开')}><Input value={symbols} onChange={(event) => setSymbols(event.target.value)} placeholder="600519, 0700.HK, AAPL" /></Field>}
        <Field label={kind === 'question' ? t('研究问题 *') : t('补充说明（可选）')}><Textarea rows={3} value={prompt} onChange={(event) => setPrompt(event.target.value)} maxLength={2000} placeholder={kind === 'question' ? t('例如：固态电池产业链里，哪些公司今年有确定的量产订单？') : t('例如：重点看现金流和分红能力')} /></Field>
        <Field label={t('标题')}><Input value={title} onChange={(event) => setTitle(event.target.value)} placeholder={autoTitle || t('自动生成')} maxLength={80} /></Field>
        <div className="grid grid-cols-2 gap-2.5 max-sm:grid-cols-1">
          <Field label={t('用哪个 Agent')} hint={t('Kimi Code 不能只读运行，这里不列')}><Select value={agent} onChange={(event) => setAgent(event.target.value)}>{options.length ? options.map((entry) => <option key={entry.key} value={entry.key}>{entry.label}</option>) : <option value="">{t('没有可用的 Agent')}</option>}</Select></Field>
          <Field label={t('模型')} hint={t('留空跟随 HRouter Desktop')}><Input value={model} onChange={(event) => setModel(event.target.value)} /></Field>
        </div>
        <div className="flex justify-end gap-2"><Button onClick={() => onOpenChange(false)}>{t('取消')}</Button><Button variant="primary" disabled={!ready} loading={create.isPending} onClick={submit}>{t('开始研究')}</Button></div>
      </div>
    </Dialog>
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
      toast.success(t('官方来源同步完成，请核对各数据源的状态'))
    } catch (error) { toast.error((error as Error).message) } finally { setSyncing(false) }
  }
  return (
    <Card className="flex flex-col gap-3 p-4">
      <div className="flex flex-wrap items-center gap-2.5">
        <Segmented label={t('类型')} value={kind} onChange={(value) => { setKind(value); setOffset(0) }} options={[['all', t('全部证据')], ['events', t('事件日历')], ['financial', t('财务事实')], ['official', t('官方来源')]]} />
        <Select aria-label={t('标的')} value={symbol} onChange={(event) => { setSymbol(event.target.value); setOffset(0) }} className="w-40"><option value="all">{t('所有标的')}</option>{symbols.map((entry) => <option key={entry}>{entry}</option>)}</Select>
        <Input value={query} onChange={(event) => { setQuery(event.target.value); setOffset(0) }} placeholder={t('搜索标题、代码、财务指标')} aria-label={t('搜索证据')} className="w-64 max-sm:w-full" />
        <Button className="ml-auto" loading={syncing} onClick={sync}><RefreshCw className="size-4" />{t('同步官方来源')}</Button>
      </div>
      <ErrorNote error={evidence.error} />
      {(evidence.data?.eventWarnings ?? []).map((warning) => <div key={warning} className="rounded-lg bg-warn-soft px-3 py-2 text-xs text-warn-ink">{warning}</div>)}
      {evidence.isLoading ? <Spinner /> : <EvidenceList rows={rows.slice(offset, offset + 20)} />}
      <Pager total={rows.length} offset={offset} limit={20} onChange={setOffset} />
      <div className="text-xs text-ink-3">{t('只包含已导入的证据，不代表全市场事件；查询事件不会创建提醒。')}</div>
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
        <Select aria-label={t('状态')} value={state} onChange={(event) => setState(event.target.value)} className="w-40"><option value="all">{t('全部状态')}</option>{Object.entries(STATE).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</Select>
        <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('搜索标的或投资逻辑')} aria-label={t('搜索研究记录')} className="w-64 max-sm:w-full" />
        <Button variant="primary" className="ml-auto" onClick={() => setCreating(true)}><Plus className="size-4" />{t('新建研究记录')}</Button>
      </div>
      <ErrorNote error={decisions.error} />
      {decisions.isLoading ? <Spinner /> : !rows.length ? <Empty title={t('还没有研究记录')}>{t('先写下理由、失效条件与证据。复盘只会追加，不会改写原始记录。')}</Empty> : rows.map((row) => (
        <Card key={row.id} className="flex flex-col gap-2.5 p-4">
          <div className="flex flex-wrap items-center gap-2">
            <Pill tone="accent">{row.symbol}</Pill><Pill>{STATE[row.state] ?? row.state}</Pill>
            <span className="text-xs text-ink-3">{dateTime(row.createdAt ?? row.recordedAt)}</span>
            <Button size="sm" className="ml-auto" onClick={() => setReviewing(row)}>{t('追加复盘')}</Button>
          </div>
          <p className="m-0 whitespace-pre-wrap text-[14px]">{row.thesis}</p>
          <div className="grid grid-cols-3 gap-2 text-xs text-ink-2 max-md:grid-cols-1">
            {row.entryCondition && <div><span className="text-ink-3">{t('入场条件：')}</span>{row.entryCondition}</div>}
            {row.invalidationCondition && <div><span className="text-ink-3">{t('失效条件：')}</span>{row.invalidationCondition}</div>}
            {row.horizon && <div><span className="text-ink-3">{t('观察周期：')}</span>{row.horizon}</div>}
          </div>
          {row.scorecard?.pillars?.length > 0 && (
            <div className="flex flex-col gap-1.5 border-t border-line pt-2.5">
              <div className="text-xs font-semibold text-ink-3">{t('投资逻辑卡（研究判断，不是盈利概率）')}</div>
              {row.scorecard.pillars.map((pillar: any) => <div key={pillar.id} className="flex flex-wrap items-center gap-2 text-[13px]"><Pill tone={PILLAR[pillar.status]?.[1] ?? 'neutral'}>{PILLAR[pillar.status]?.[0] ?? pillar.status}</Pill><span>{pillar.expectation}</span><span className="text-xs text-ink-3">{t('失效：{text}', { text: pillar.invalidationCondition })}</span></div>)}
            </div>
          )}
          {row.reviews?.length > 0 && (
            <div className="flex flex-col gap-1.5 border-t border-line pt-2.5">
              <div className="text-xs font-semibold text-ink-3">{t('复盘时间线')}</div>
              {row.reviews.map((review: any, index: number) => <div key={index} className="text-[13px]"><span className="mr-2 font-mono text-xs text-ink-3">{dateTime(review.reviewedAt ?? review.at)}</span><Pill>{OUTCOME[review.outcome] ?? review.outcome}</Pill> <span className="text-ink-2">{review.notes || t('无补充说明')}</span></div>)}
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
      toast.success(t('原始研究判断已保存'))
      onOpenChange(false)
    } catch (error) { toast.error((error as Error).message) } finally { setSaving(false) }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={t('新建研究记录')} description={t('记下当时的理由和失效条件。保存后不会被改写，之后只追加复盘。')} width={720}>
      <div className="grid grid-cols-2 gap-3 max-sm:grid-cols-1">
        <Field label={t('证券代码 *')}><Input value={form.symbol} onChange={set('symbol')} placeholder="600519 / 0700.HK / AAPL" /></Field>
        <Field label={t('研究状态')}><Select value={form.state} onChange={set('state')}>{Object.entries(STATE).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</Select></Field>
        <Field label={t('投资逻辑 *')} className="col-span-full"><Textarea rows={3} value={form.thesis} onChange={set('thesis')} /></Field>
        <Field label={t('入场条件')}><Input value={form.entryCondition} onChange={set('entryCondition')} /></Field>
        <Field label={t('失效条件')}><Input value={form.invalidationCondition} onChange={set('invalidationCondition')} /></Field>
        <Field label={t('观察周期')}><Input value={form.horizon} onChange={set('horizon')} placeholder={t('例如 3 个月')} /></Field>
        <Field label={t('风险预算')}><Input value={form.riskBudget} onChange={set('riskBudget')} /></Field>
        <Field label={t('备注')} className="col-span-full"><Textarea rows={2} value={form.notes} onChange={set('notes')} /></Field>
      </div>
      <div className="mt-4 flex flex-col gap-2">
        <div className="flex items-center"><span className="text-[13px] font-semibold">{t('可证伪的论据（可选）')}</span><Button size="sm" className="ml-auto" disabled={pillars.length >= 12} onClick={() => setPillars([...pillars, { expectation: '', invalidationCondition: '', reviewBy: '' }])}><Plus className="size-4" />{t('添加论据')}</Button></div>
        {pillars.map((pillar, index) => (
          <div key={index} className="grid grid-cols-[2fr_2fr_1fr] gap-2 max-sm:grid-cols-1">
            <Input aria-label={t('预期')} placeholder={t('预期')} value={pillar.expectation} onChange={(event) => setPillars(pillars.map((entry, position) => position === index ? { ...entry, expectation: event.target.value } : entry))} />
            <Input aria-label={t('失效条件')} placeholder={t('失效条件')} value={pillar.invalidationCondition} onChange={(event) => setPillars(pillars.map((entry, position) => position === index ? { ...entry, invalidationCondition: event.target.value } : entry))} />
            <Input aria-label={t('复核日期')} type="date" value={pillar.reviewBy} onChange={(event) => setPillars(pillars.map((entry, position) => position === index ? { ...entry, reviewBy: event.target.value } : entry))} />
          </div>
        ))}
      </div>
      <div className="mt-5 flex justify-end gap-2"><Button onClick={() => onOpenChange(false)}>{t('取消')}</Button><Button variant="primary" loading={saving} disabled={!form.symbol.trim() || !form.thesis.trim()} onClick={save}>{t('保存')}</Button></div>
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
    try { await post(`/api/decisions/${encodeURIComponent(record.id)}/review`, { outcome, notes }); client.invalidateQueries({ queryKey: ['decisions'] }); toast.success(t('复盘已追加，原始判断不变')); onClose() }
    catch (error) { toast.error((error as Error).message) } finally { setSaving(false) }
  }
  return (
    <Dialog open onOpenChange={(value) => !value && onClose()} title={t('追加复盘')} description={`${record.symbol} · ${record.thesis.slice(0, 80)}`}>
      <div className="flex flex-col gap-3">
        <Field label={t('结论')}><Select value={outcome} onChange={(event) => setOutcome(event.target.value)}>{Object.entries(OUTCOME).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</Select></Field>
        <Field label={t('说明')}><Textarea rows={4} value={notes} onChange={(event) => setNotes(event.target.value)} /></Field>
        <div className="flex justify-end gap-2"><Button onClick={onClose}>{t('取消')}</Button><Button variant="primary" loading={saving} onClick={save}>{t('追加')}</Button></div>
      </div>
    </Dialog>
  )
}
