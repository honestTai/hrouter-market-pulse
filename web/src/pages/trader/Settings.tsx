import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { get, type AccountDetail, type Job, type Limits, type Runner } from '@/lib/api'
import { changeLabel, changedByLabel, dateTime, MARKET_NAME, valueLabel } from '@/lib/format'
import { useAction, useEnv, useLibrary, useTraderSettings } from '@/lib/queries'
import { Button, Card, CardTitle, Dialog, Field, Input, LockButton, Pill, Segmented, Select, Spinner, Switch, Textarea, cn } from '@/components/ui'

const BOARDS: Array<[string, string]> = [['st', 'ST'], ['star', '科创板'], ['chinext', '创业板'], ['bse', '北交所']]
const SHOWN_LIMITS = ['minCashPct', 'maxPositions', 'maxPositionPct', 'maxNewPerDay', 'maxRiskPerTradePct', 'maxDrawdownPct', 'maxOrdersPerDay', 'cooldownDays', 'excludeBoards', 'minPrice', 'maxChangePct']

export function TraderSettingsTab({ account, job }: { account: AccountDetail; job: Job | undefined }) {
  const settings = useTraderSettings(account.id)
  if (settings.isLoading || !settings.data) return <Spinner />
  return (
    <div className="flex flex-wrap items-start gap-4">
      <div className="flex min-w-0 flex-[999_1_640px] flex-col gap-4">
        <PromptCard account={account} />
        <LimitsCard account={account} />
        <div className="grid grid-cols-[repeat(auto-fit,minmax(320px,1fr))] gap-4">
          <FeesCard account={account} />
          <AgentCard account={account} job={job} />
        </div>
        <SkillsCard account={account} />
        <DangerCard account={account} />
      </div>
      <aside className="flex min-w-0 max-w-[400px] flex-[1_1_320px] flex-col gap-4">
        <ChangeLogCard account={account} />
        <McpCard account={account} />
      </aside>
    </div>
  )
}

function PromptCard({ account }: { account: AccountDetail }) {
  const settings = useTraderSettings(account.id).data!
  const [layer, setLayer] = useState<'global' | 'market' | 'trader'>('trader')
  const [text, setText] = useState('')
  const [preview, setPreview] = useState(false)
  useEffect(() => { setText(layer === 'global' ? settings.prompts.global : layer === 'market' ? settings.prompts.market : settings.prompt) }, [layer, settings])
  const saveTrader = useAction<{ prompt: string }>(`/api/arena/accounts/${account.id}/prompt`, { invalidate: [['trader-settings', account.id], ['account', account.id]], success: '提示词已保存' })
  const saveShared = useAction<{ scope: string; prompt: string }>('/api/workbench/prompts', { invalidate: [['trader-settings', account.id], ['workbench']], success: '提示词已保存，对所有相关交易员生效' })
  const lock = useAction<{ locks: Record<string, boolean> }>(`/api/arena/accounts/${account.id}/locks`, { invalidate: [['trader-settings', account.id], ['account', account.id]] })
  const save = () => layer === 'trader' ? saveTrader.mutate({ prompt: text }) : saveShared.mutate({ scope: layer === 'global' ? 'global' : account.market, prompt: text })
  return (
    <Card className="flex flex-col gap-3 p-[18px]">
      <div className="flex flex-wrap items-center gap-2.5">
        <h2 className="m-0 text-base font-semibold">前置提示词</h2>
        <Segmented label="层级" value={layer} onChange={setLayer} options={[['global', '全局'], ['market', MARKET_NAME[account.market]], ['trader', '本交易员']]} />
        {layer === 'trader' && <LockButton label="前置提示词" locked={Boolean(settings.locks.prompt)} onChange={(value) => lock.mutate({ locks: { prompt: value } })} />}
        <Button size="sm" className="ml-auto" onClick={() => setPreview(true)}>预览完整提示词</Button>
      </div>
      <Field label={layer === 'trader' ? '只对这个交易员生效，排在全局和市场的后面' : layer === 'global' ? '对所有交易员生效' : `对所有${MARKET_NAME[account.market]}交易员生效`}>
        <Textarea rows={5} value={text} onChange={(event) => setText(event.target.value)} maxLength={4000} />
      </Field>
      <div className="flex flex-wrap items-center gap-1.5 text-xs text-ink-2">
        <span>每次发给 Agent 的顺序：</span>
        {['系统规则', '全局', MARKET_NAME[account.market], '本交易员', '边界摘要', '流派 skill', '你的指令', '本次任务'].map((label, index) => (
          <span key={label} className="flex items-center gap-1.5">{index > 0 && <span aria-hidden>›</span>}<span className={cn('rounded-md px-1.5 py-px', (layer === 'global' && index === 1) || (layer === 'market' && index === 2) || (layer === 'trader' && index === 3) ? 'bg-accent-soft text-accent-ink' : 'bg-sunken')}>{label}</span></span>
        ))}
        <Button size="sm" variant="primary" className="ml-auto" loading={saveTrader.isPending || saveShared.isPending} onClick={save}>保存</Button>
      </div>
      <PromptPreview accountId={account.id} open={preview} onOpenChange={setPreview} />
    </Card>
  )
}

function PromptPreview({ accountId, open, onOpenChange }: { accountId: string; open: boolean; onOpenChange: (value: boolean) => void }) {
  const preview = useQuery({ queryKey: ['prompt-preview', accountId], enabled: open, queryFn: ({ signal }) => get<{ prompt: string; skills: string | null; chars: number }>(`/api/arena/accounts/${accountId}/prompt-preview`, signal) })
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="完整提示词" description={preview.data ? `下一次复查会发出去的内容，约 ${preview.data.chars.toLocaleString('zh-CN')} 个字符（skill 作为系统提示词另外附上）` : undefined} width={820}>
      {preview.isLoading ? <Spinner /> : (
        <div className="flex flex-col gap-3">
          <pre className="m-0 max-h-[46vh] overflow-auto whitespace-pre-wrap rounded-lg bg-surface-2 p-3 font-mono text-xs scroll-thin">{preview.data?.prompt}</pre>
          <details><summary className="cursor-pointer text-[13px] text-ink-2">系统提示词里的 skill（{preview.data?.skills?.length.toLocaleString('zh-CN') ?? 0} 字符）</summary><pre className="mt-2 max-h-[40vh] overflow-auto whitespace-pre-wrap rounded-lg bg-surface-2 p-3 font-mono text-xs scroll-thin">{preview.data?.skills}</pre></details>
        </div>
      )}
    </Dialog>
  )
}

function LimitsCard({ account }: { account: AccountDetail }) {
  const settings = useTraderSettings(account.id).data!
  const [draft, setDraft] = useState<Limits>(settings.limits)
  const [showAll, setShowAll] = useState(false)
  useEffect(() => setDraft(settings.limits), [settings.limits])
  const save = useAction<{ limits: Limits }>(`/api/arena/accounts/${account.id}/limits`, { invalidate: [['trader-settings', account.id], ['account', account.id], ['leaderboard']], success: '边界已更新，下一笔订单起生效' })
  const lock = useAction<{ locks: Record<string, boolean> }>(`/api/arena/accounts/${account.id}/locks`, { invalidate: [['trader-settings', account.id], ['account', account.id]] })
  const changed = SHOWN_LIMITS.filter((key) => JSON.stringify(draft[key] ?? null) !== JSON.stringify(settings.limits[key] ?? null))
  const lastChange = (key: string) => settings.changeLog.find((entry) => entry.key === key)
  const active = (key: string) => draft[key] !== null && draft[key] !== undefined && !(Array.isArray(draft[key]) && !(draft[key] as string[]).length)
  const visible = showAll ? SHOWN_LIMITS : SHOWN_LIMITS.filter((key, index) => index < 6 || active(key) || settings.limits[key] !== null)
  const defaults: Record<string, number | string[]> = { minCashPct: 20, maxPositions: 6, maxPositionPct: 20, maxNewPerDay: 3, maxRiskPerTradePct: 1.5, maxDrawdownPct: 15, maxOrdersPerDay: 10, cooldownDays: 1, excludeBoards: ['st'], minPrice: 3, maxChangePct: 7 }
  return (
    <Card className="flex flex-col gap-1 p-[18px]">
      <div className="mb-2 flex flex-wrap items-baseline gap-2.5">
        <h2 className="m-0 text-base font-semibold">边界</h2>
        <span className="text-[13px] text-ink-2">系统在下单前检查，超了直接拦下。默认只开「保留现金 20%」。锁住的项 Agent 改不了，会变成申请</span>
      </div>
      {visible.map((key) => {
        const spec = settings.limitSpecs[key]
        const on = active(key)
        const locked = Boolean(settings.locks[key])
        const change = lastChange(key)
        return (
          <div key={key} className="flex flex-wrap items-center gap-3 border-t border-line py-2.5">
            <Switch label={spec.zh} checked={on} onChange={(value) => setDraft({ ...draft, [key]: value ? (settings.limits[key] ?? defaults[key]) : null })} />
            <div className="min-w-[200px] flex-1"><div className="font-semibold">{spec.zh}</div><div className="text-xs text-ink-3">{spec.hint}</div></div>
            {spec.type === 'boards' ? (
              <div className="flex flex-wrap gap-2">{BOARDS.map(([board, label]) => {
                const list = (draft[key] as string[] | null) ?? []
                return <label key={board} className="flex items-center gap-1 text-[13px]"><input type="checkbox" className="size-4 accent-[var(--c-accent)]" checked={list.includes(board)} onChange={(event) => setDraft({ ...draft, [key]: event.target.checked ? [...list, board] : list.filter((entry) => entry !== board) })} />{label}</label>
              })}</div>
            ) : on ? (
              <label className="flex h-9 items-center gap-1 rounded-[9px] border border-line-strong bg-surface px-2.5">
                <span className="sr-only">{spec.zh}</span>
                <input type="number" min={spec.min} max={spec.max} step={spec.type === 'int' ? 1 : 0.1} value={String(draft[key] ?? '')} onChange={(event) => setDraft({ ...draft, [key]: event.target.value === '' ? null : Number(event.target.value) })} className="w-16 bg-transparent text-right font-mono outline-none" />
                <span className="text-ink-3">{spec.type === 'pct' || key === 'maxChangePct' ? '%' : key === 'cooldownDays' ? '天' : key === 'minPrice' ? '元' : '只'}</span>
              </label>
            ) : <span className="text-[13px] text-ink-3">不限制</span>}
            <LockButton label={spec.zh} locked={locked} onChange={(value) => lock.mutate({ locks: { [key]: value } })} />
            <span className="w-[130px] shrink-0 text-xs text-ink-3">{change ? `${changedByLabel(change.by).replace(' · 界面', '')} · ${dateTime(change.at)}` : '默认'}</span>
          </div>
        )
      })}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {!showAll && <Button size="sm" variant="ghost" onClick={() => setShowAll(true)}>显示全部 {SHOWN_LIMITS.length} 项</Button>}
        <span className="flex-1" />
        {changed.length > 0 && <Button size="sm" onClick={() => setDraft(settings.limits)}>撤销</Button>}
        <Button size="sm" variant="primary" disabled={!changed.length} loading={save.isPending} onClick={() => save.mutate({ limits: Object.fromEntries(changed.map((key) => [key, draft[key] ?? null])) })}>保存{changed.length ? ` ${changed.length} 项` : ''}</Button>
      </div>
    </Card>
  )
}

const FEE_FIELDS: Record<string, Array<[string, string, number]>> = {
  A: [['commissionRate', '佣金率（%）', 100], ['minCommission', '最低佣金（元）', 1], ['stampDutyRate', '印花税 · 卖出（%）', 100], ['transferFeeRate', '过户费（%）', 100]],
  HK: [['commissionRate', '佣金率（%）', 100], ['minCommission', '最低佣金（港元）', 1], ['stampDutyRate', '印花税（%）', 100], ['tradingFeeRate', '交易费（%）', 100]],
  US: [['perShare', '每股佣金（美元）', 1], ['minCommission', '最低佣金（美元）', 1], ['secFeeRate', 'SEC 费 · 卖出（%）', 100], ['tafPerShare', 'TAF 每股（美元）', 1]],
}

export function FeesForm({ market, fees, locked, onSaved }: { market: string; fees: Record<string, number | boolean>; locked?: boolean; onSaved?: () => void }) {
  const [draft, setDraft] = useState<Record<string, string | boolean>>({})
  useEffect(() => setDraft(Object.fromEntries(Object.entries(fees).map(([key, value]) => [key, typeof value === 'boolean' ? value : String(Number((value * ((FEE_FIELDS[market] ?? []).find(([field]) => field === key)?.[2] ?? 1)).toPrecision(6)))]))), [fees, market])
  const save = useAction<{ market: string; fees: Record<string, number | boolean> }>('/api/workbench/fees', { invalidate: [['workbench'], ['trader-settings']], success: `${MARKET_NAME[market]}费率已保存，之后的成交按新费率算` })
  const submit = () => save.mutate({ market, fees: Object.fromEntries([...(FEE_FIELDS[market] ?? []).map(([key, , scale]): [string, number | boolean] => [key, Number(draft[key]) / scale]), ...(market !== 'US' ? [['waiveMinimum', Boolean(draft.waiveMinimum)] as [string, boolean]] : [])]) }, { onSuccess: onSaved })
  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-2.5">
        {(FEE_FIELDS[market] ?? []).map(([key, label]) => <Field key={key} label={label}><Input type="number" step="any" value={String(draft[key] ?? '')} onChange={(event) => setDraft({ ...draft, [key]: event.target.value })} className="font-mono" /></Field>)}
        {market !== 'US' && <label className="col-span-2 flex items-center gap-2 text-[13px]"><input type="checkbox" className="size-4 accent-[var(--c-accent)]" checked={Boolean(draft.waiveMinimum)} onChange={(event) => setDraft({ ...draft, waiveMinimum: event.target.checked })} />免五（不收最低佣金）</label>}
      </div>
      <div className="flex items-center gap-2">
        <span className="text-xs text-ink-3">成交价按买一 / 卖一，再加滑点。{locked ? '已锁定：Agent 不能改。' : 'Agent 也能用 arena_set_fees 改。'}</span>
        <Button size="sm" variant="primary" className="ml-auto" loading={save.isPending} onClick={submit}>保存费率</Button>
      </div>
    </div>
  )
}

function FeesCard({ account }: { account: AccountDetail }) {
  const settings = useTraderSettings(account.id).data!
  return (
    <Card className="flex flex-col gap-3 p-[18px]">
      <CardTitle extra={<span className="ml-auto text-xs text-ink-3">同市场的交易员共用</span>}>费率 · {MARKET_NAME[account.market]}</CardTitle>
      <FeesForm market={account.market} fees={settings.fees} locked={settings.feesLocked} />
    </Card>
  )
}

type AgentOption = { key: string; runner: Runner; label: string }

function useAgentOptions(): AgentOption[] {
  const env = useEnv()
  return useMemo(() => (env.data?.agents ?? []).filter((agent) => agent.installed).map((agent) => agent.kind === 'acp'
    ? { key: `acp:${agent.command}`, runner: { type: 'acp', command: agent.command ?? undefined, args: env.data?.acpPresets.find((preset) => preset.id === agent.id)?.args ?? [] }, label: agent.name }
    : { key: agent.id, runner: { type: agent.id }, label: agent.name }), [env.data])
}

function AgentCard({ account, job }: { account: AccountDetail; job: Job | undefined }) {
  const options = useAgentOptions()
  const keyOf = (runner?: Runner) => (!runner ? '' : runner.type === 'acp' ? `acp:${runner.command}` : runner.type)
  const [primary, setPrimary] = useState(keyOf(job?.runner))
  const [model, setModel] = useState(job?.runner.model ?? '')
  const [backup, setBackup] = useState(keyOf(job?.backup))
  const [backupModel, setBackupModel] = useState(job?.backup?.model ?? '')
  const [mode, setMode] = useState(job?.mode === 'director' || job?.strategy ? 'director' : 'rounds')
  const [review, setReview] = useState(String(job?.intervalMinutes ?? 10))
  useEffect(() => { setPrimary(keyOf(job?.runner)); setModel(job?.runner.model ?? ''); setBackup(keyOf(job?.backup)); setBackupModel(job?.backup?.model ?? ''); setMode(job?.mode === 'director' || job?.strategy ? 'director' : 'rounds'); setReview(String(job?.intervalMinutes ?? 10)) }, [job])
  const save = useAction<Record<string, unknown>>(`/api/arena/schedules/${account.id}`, { invalidate: [['schedules']], success: '运行方式已保存' })
  if (job?.runner.type === 'strategy') return (
    <Card className="flex flex-col gap-2 p-[18px]">
      <CardTitle>节奏与运行方式</CardTitle>
      <div className="text-[13px] text-ink-2">纯代码策略 <span className="font-mono">{job.runner.strategyId}</span>，每 {job.intervalMinutes} 分钟执行，不花 token。</div>
      <div className="text-xs text-ink-3">想让 Agent 来当主控：在下面选一个 Agent 保存，原来的代码策略会作为策略执行线保留。</div>
      <AgentPicker options={options} primary={primary} setPrimary={setPrimary} model={model} setModel={setModel} />
      <Button size="sm" variant="primary" className="self-start" disabled={!primary || primary === 'strategy'} loading={save.isPending} onClick={() => {
        const option = options.find((entry) => entry.key === primary)
        save.mutate({ runner: { ...option!.runner, ...(model ? { model } : {}), timeoutMinutes: 20 }, intervalMinutes: 10, times: [], mode: 'director', strategy: { strategyId: job.runner.strategyId, intervalMinutes: job.intervalMinutes ?? 5, params: job.runner.params ?? {} } })
      }}>改成 Agent 主控</Button>
    </Card>
  )
  return (
    <Card className="flex flex-col gap-3 p-[18px]">
      <CardTitle>节奏与 Agent</CardTitle>
      <AgentPicker options={options} primary={primary} setPrimary={setPrimary} model={model} setModel={setModel} />
      <div className="grid grid-cols-2 gap-2.5">
        <Field label="备用 Agent" hint="额度用尽或启动失败时代班"><Select value={backup} onChange={(event) => setBackup(event.target.value)}><option value="">不设置</option>{options.filter((entry) => entry.key !== primary).map((entry) => <option key={entry.key} value={entry.key}>{entry.label}</option>)}</Select></Field>
        <Field label="备用模型"><Input value={backupModel} onChange={(event) => setBackupModel(event.target.value)} placeholder="跟随当前配置" disabled={!backup} /></Field>
        <Field label="工作方式"><Select value={mode} onChange={(event) => setMode(event.target.value)}><option value="director">Agent 主控（写代码策略 + 复查）</option><option value="rounds">每轮亲自看盘下单</option></Select></Field>
        <Field label={mode === 'director' ? '复查间隔（分钟）' : '每轮间隔（分钟）'}><Input type="number" min={5} max={240} value={review} onChange={(event) => setReview(event.target.value)} /></Field>
      </div>
      <div className="flex items-center gap-2">
        <span className="text-xs text-ink-3">自主级别：全托管</span>
        <Button size="sm" variant="primary" className="ml-auto" disabled={!primary} loading={save.isPending} onClick={() => {
          const option = options.find((entry) => entry.key === primary)
          const backupOption = options.find((entry) => entry.key === backup)
          save.mutate({
            runner: { ...(job?.runner ?? {}), ...option!.runner, model: model || undefined, timeoutMinutes: job?.runner.timeoutMinutes ?? 20 },
            backup: backupOption ? { ...backupOption.runner, ...(backupModel ? { model: backupModel } : {}) } : null,
            mode, intervalMinutes: Number(review) || 10, times: job?.times ?? [],
          })
        }}>保存</Button>
      </div>
    </Card>
  )
}

function AgentPicker({ options, primary, setPrimary, model, setModel }: { options: AgentOption[]; primary: string; setPrimary: (value: string) => void; model: string; setModel: (value: string) => void }) {
  return (
    <div className="grid grid-cols-2 gap-2.5">
      <Field label="主 Agent"><Select value={primary} onChange={(event) => setPrimary(event.target.value)}><option value="" disabled>选择</option>{options.map((entry) => <option key={entry.key} value={entry.key}>{entry.label}</option>)}</Select></Field>
      <Field label="模型" hint="留空跟随 HRouter Desktop"><Input value={model} onChange={(event) => setModel(event.target.value)} placeholder={primary === 'kimi' ? 'k3-256k' : primary === 'codex' ? 'gpt-6-astra' : primary === 'claude' ? 'claude-opus-5-5' : ''} /></Field>
    </div>
  )
}

function SkillsCard({ account }: { account: AccountDetail }) {
  const library = useLibrary()
  const template = library.data?.templates.find((entry) => entry.id === account.template)
  const current = account.skills ?? template?.skills ?? []
  const [chosen, setChosen] = useState<string[]>(current)
  useEffect(() => setChosen(account.skills ?? template?.skills ?? []), [account.skills, template])
  const save = useAction<{ skills: string[] | null }>(`/api/arena/accounts/${account.id}`, { invalidate: [['account', account.id], ['leaderboard']], success: 'Skill 已更新，下一次复查起生效' })
  const skills = (library.data?.skills ?? []).filter((skill) => skill.markets.includes(account.market) && !(library.data?.discipline ?? []).includes(skill.id))
  return (
    <Card className="flex flex-col gap-3 p-[18px]">
      <CardTitle extra={<span className="text-xs text-ink-3">纪律类 skill（交易前关卡、仓位计算、亏损熔断、复盘）总是带上</span>}>流派 Skill{template ? ` · 模板「${template.name}」` : ''}</CardTitle>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-2">
        {skills.map((skill) => (
          <label key={skill.id} className={cn('flex items-start gap-2 rounded-[10px] border p-2.5 text-[13px]', skill.status !== 'available' ? 'opacity-60' : chosen.includes(skill.id) ? 'border-accent-line bg-accent-soft' : 'border-line')}>
            <input type="checkbox" className="mt-0.5 size-4 accent-[var(--c-accent)]" disabled={skill.status !== 'available'} checked={chosen.includes(skill.id)} onChange={(event) => setChosen(event.target.checked ? [...chosen, skill.id] : chosen.filter((id) => id !== skill.id))} />
            <span><span className="font-semibold">{skill.name}</span>{skill.status !== 'available' && <Pill tone="warn" className="ml-1">缺数据</Pill>}<span className="block text-xs text-ink-3">{skill.summary}</span></span>
          </label>
        ))}
      </div>
      <div className="flex items-center gap-2">
        <Link to="/skills" className="text-[13px]">看 Skill 库</Link>
        {account.skills && <Button size="sm" variant="ghost" onClick={() => save.mutate({ skills: null })}>恢复模板默认</Button>}
        <Button size="sm" variant="primary" className="ml-auto" disabled={JSON.stringify(chosen) === JSON.stringify(current)} loading={save.isPending} onClick={() => save.mutate({ skills: chosen })}>保存</Button>
      </div>
    </Card>
  )
}

function ChangeLogCard({ account }: { account: AccountDetail }) {
  const settings = useTraderSettings(account.id).data!
  return (
    <Card className="flex flex-col gap-3 p-4">
      <CardTitle>修改记录</CardTitle>
      {settings.changeLog.length ? settings.changeLog.slice(0, 12).map((entry) => (
        <div key={entry.id} className="flex flex-col gap-0.5">
          <div className="text-[13px] font-semibold">{changeLabel(entry.key)}{entry.key.startsWith('lock:') ? (entry.to ? '' : '（解锁）') : ` ${valueLabel(entry.key, entry.from)} → ${valueLabel(entry.key, entry.to)}`}</div>
          {entry.reason && <div className="text-xs text-ink-2">「{entry.reason}」</div>}
          <div className="font-mono text-xs text-ink-3">{changedByLabel(entry.by)} · {dateTime(entry.at)}</div>
        </div>
      )) : <div className="text-[13px] text-ink-3">还没有修改。</div>}
      <div className="border-t border-line pt-2.5 text-xs text-ink-2">绩效按每次修改前后分段，竞技场里能看到。</div>
    </Card>
  )
}

function McpCard({ account }: { account: AccountDetail }) {
  return (
    <Card className="flex flex-col gap-2.5 p-4">
      <CardTitle>用 MCP / ACP 改</CardTitle>
      <p className="m-0 text-[13px] text-ink-2">Claude Code、Codex、Kimi（ACP）等任何接了本插件的 Agent 都能调这些工具。锁住的项会被拒绝并变成申请。</p>
      <div className="flex flex-col gap-1.5 text-xs">
        {[['arena_get_settings', '读当前值和锁定状态'], ['arena_set_limits', '边界'], ['arena_set_fees', '费率'], ['arena_set_cadence', '复查间隔、执行频率'], ['arena_set_prompt', '前置提示词'], ['arena_write_strategy', '代码策略']].map(([tool, label]) => (
          <div key={tool} className="flex gap-2"><code className="font-mono text-accent-ink">{tool}</code><span className="text-ink-3">{label}</span></div>
        ))}
      </div>
      <pre className="m-0 whitespace-pre-wrap rounded-[9px] border border-line bg-surface-2 p-3 font-mono text-xs">{`arena_set_limits({\n  accountId: "${account.id}",\n  minCashPct: 30,\n  reason: "周五前降仓"\n})`}</pre>
    </Card>
  )
}

function DangerCard({ account }: { account: AccountDetail }) {
  const navigate = useNavigate()
  const archive = useAction<{ status: string }>(`/api/arena/accounts/${account.id}`, { invalidate: [['leaderboard']], success: '已归档，挂单已撤销' })
  return (
    <Card className="flex flex-wrap items-center gap-3 p-[18px]">
      <div className="min-w-[240px] flex-1"><div className="font-semibold">归档交易员</div><div className="text-xs text-ink-3">停止交易、撤销挂单，排行榜里不再显示。记录都保留。</div></div>
      <Button variant="danger" loading={archive.isPending} onClick={() => { if (window.confirm(`归档「${account.name}」？挂单会被撤销。`)) archive.mutate({ status: 'archived' }, { onSuccess: () => navigate({ to: '/traders' }) }) }}>归档</Button>
    </Card>
  )
}
