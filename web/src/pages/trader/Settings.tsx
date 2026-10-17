import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { Plus, Trash2 } from 'lucide-react'
import { get, type AccountDetail, type Autonomy, type Job, type Limits, type Runner, type SkillOverride } from '@/lib/api'
import { AUTONOMY_NAME, BOARD_NAME, changeLabel, changedByLabel, dateTime, MARKET_NAME, TEAM_ROLE, valueLabel } from '@/lib/format'
import { isEnglish, locale, t } from '@/lib/i18n'
import { useAction, useEnv, useLibrary, useTraderSettings } from '@/lib/queries'
import { Button, Card, CardTitle, Dialog, Field, Input, LockButton, Pill, Segmented, Select, Spinner, Switch, Textarea, cn } from '@/components/ui'

const SHOWN_LIMITS = ['minCashPct', 'maxPositions', 'maxPositionPct', 'maxExposurePct', 'maxIndustryPct', 'maxNewPerDay', 'maxRiskPerTradePct', 'maxDrawdownPct', 'maxOrdersPerDay', 'cooldownDays', 'excludeBoards', 'minPrice', 'maxChangePct']

export function TraderSettingsTab({ account, job }: { account: AccountDetail; job: Job | undefined }) {
  const settings = useTraderSettings(account.id)
  if (settings.isLoading || !settings.data) return <Spinner />
  const agent = job && job.runner.type !== 'strategy'
  return (
    <div className="flex flex-wrap items-start gap-4">
      <div className="flex min-w-0 flex-[999_1_640px] flex-col gap-4">
        <PromptCard account={account} />
        <LimitsCard account={account} />
        <AutonomyCard account={account} />
        <div className="grid grid-cols-[repeat(auto-fit,minmax(min(320px,100%),1fr))] gap-4">
          <AgentCard account={account} job={job} />
          <FeesCard account={account} />
        </div>
        {agent && <div className="grid grid-cols-[repeat(auto-fit,minmax(min(320px,100%),1fr))] gap-4">
          <ReviewTriggerCard account={account} job={job!} />
          <TeamCard account={account} job={job!} />
        </div>}
        <SkillsCard account={account} />
        <DangerCard account={account} />
      </div>
      <aside className="flex min-w-0 flex-[1_1_320px] flex-col gap-4 lg:max-w-[400px]">
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
  const saveTrader = useAction<{ prompt: string }>(`/api/arena/accounts/${account.id}/prompt`, { invalidate: [['trader-settings', account.id], ['account', account.id]], success: t('提示词已保存') })
  const saveShared = useAction<{ scope: string; prompt: string }>('/api/workbench/prompts', { invalidate: [['trader-settings', account.id], ['workbench']], success: t('提示词已保存，对所有相关交易员生效') })
  const lock = useAction<{ locks: Record<string, boolean> }>(`/api/arena/accounts/${account.id}/locks`, { invalidate: [['trader-settings', account.id], ['account', account.id]] })
  const save = () => layer === 'trader' ? saveTrader.mutate({ prompt: text }) : saveShared.mutate({ scope: layer === 'global' ? 'global' : account.market, prompt: text })
  return (
    <Card className="flex flex-col gap-3 p-[18px]">
      <div className="flex flex-wrap items-center gap-2.5">
        <h2 className="m-0 text-base font-semibold">{t('前置提示词')}</h2>
        <Segmented label={t('层级')} value={layer} onChange={setLayer} options={[['global', t('全局')], ['market', MARKET_NAME[account.market]], ['trader', t('本交易员')]]} />
        {layer === 'trader' && <LockButton label={t('前置提示词')} locked={Boolean(settings.locks.prompt)} onChange={(value) => lock.mutate({ locks: { prompt: value } })} />}
        <Button size="sm" className="ml-auto" onClick={() => setPreview(true)}>{t('预览完整提示词')}</Button>
      </div>
      <Field label={layer === 'trader' ? t('只对这个交易员生效，排在全局和市场的后面') : layer === 'global' ? t('对所有交易员生效') : t('对所有{market}交易员生效', { market: MARKET_NAME[account.market] })}>
        <Textarea rows={5} value={text} onChange={(event) => setText(event.target.value)} maxLength={4000} />
      </Field>
      <div className="flex flex-wrap items-center gap-1.5 text-xs text-ink-2">
        <span>{t('每次发给 Agent 的顺序：')}</span>
        {[t('系统规则'), t('全局'), MARKET_NAME[account.market], t('本交易员'), t('边界摘要'), t('长期规则'), t('流派 skill'), t('你的指令'), t('本次任务')].map((label, index) => (
          <span key={label} className="flex items-center gap-1.5">{index > 0 && <span aria-hidden>›</span>}<span className={cn('rounded-md px-1.5 py-px', (layer === 'global' && index === 1) || (layer === 'market' && index === 2) || (layer === 'trader' && index === 3) ? 'bg-accent-soft text-accent-ink' : 'bg-sunken')}>{label}</span></span>
        ))}
        <Button size="sm" variant="primary" className="ml-auto" loading={saveTrader.isPending || saveShared.isPending} onClick={save}>{t('保存')}</Button>
      </div>
      <PromptPreview accountId={account.id} open={preview} onOpenChange={setPreview} />
    </Card>
  )
}

function PromptPreview({ accountId, open, onOpenChange }: { accountId: string; open: boolean; onOpenChange: (value: boolean) => void }) {
  const preview = useQuery({ queryKey: ['prompt-preview', accountId], enabled: open, queryFn: ({ signal }) => get<{ prompt: string; skills: string | null; chars: number }>(`/api/arena/accounts/${accountId}/prompt-preview`, signal) })
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={t('完整提示词')} description={preview.data ? t('下一次复查会发出去的内容，约 {n} 个字符（skill 作为系统提示词另外附上）', { n: preview.data.chars.toLocaleString(locale()) }) : undefined} width={820}>
      {preview.isLoading ? <Spinner /> : (
        <div className="flex flex-col gap-3">
          <pre className="m-0 max-h-[46vh] overflow-auto whitespace-pre-wrap rounded-lg bg-surface-2 p-3 font-mono text-xs scroll-thin">{preview.data?.prompt}</pre>
          <details><summary className="cursor-pointer text-[13px] text-ink-2">{t('系统提示词里的 skill（{n} 字符）', { n: preview.data?.skills?.length.toLocaleString(locale()) ?? 0 })}</summary><pre className="mt-2 max-h-[40vh] overflow-auto whitespace-pre-wrap rounded-lg bg-surface-2 p-3 font-mono text-xs scroll-thin">{preview.data?.skills}</pre></details>
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
  const save = useAction<{ limits: Limits }>(`/api/arena/accounts/${account.id}/limits`, { invalidate: [['trader-settings', account.id], ['account', account.id], ['leaderboard']], success: t('边界已更新，下一笔订单起生效') })
  const lock = useAction<{ locks: Record<string, boolean> }>(`/api/arena/accounts/${account.id}/locks`, { invalidate: [['trader-settings', account.id], ['account', account.id]] })
  const shown = SHOWN_LIMITS.filter((key) => settings.limitSpecs[key])
  const changed = shown.filter((key) => JSON.stringify(draft[key] ?? null) !== JSON.stringify(settings.limits[key] ?? null))
  const lastChange = (key: string) => settings.changeLog.find((entry) => entry.key === key)
  const active = (key: string) => draft[key] !== null && draft[key] !== undefined && !(Array.isArray(draft[key]) && !(draft[key] as string[]).length)
  const visible = showAll ? shown : shown.filter((key, index) => index < 6 || active(key) || settings.limits[key] !== null)
  const defaults: Record<string, number | string[]> = { minCashPct: 20, maxPositions: 6, maxPositionPct: 20, maxExposurePct: 80, maxIndustryPct: 30, maxNewPerDay: 3, maxRiskPerTradePct: 1.5, maxDrawdownPct: 15, maxOrdersPerDay: 10, cooldownDays: 1, excludeBoards: ['st'], minPrice: 3, maxChangePct: 7 }
  const label = (key: string) => (isEnglish() ? settings.limitSpecs[key].en : settings.limitSpecs[key].zh)
  const unit = (key: string, type: string) => (type === 'pct' || key === 'maxChangePct' ? '%' : key === 'cooldownDays' ? t('天') : key === 'minPrice' ? t('元') : t('只'))
  return (
    <Card className="flex flex-col gap-1 p-[18px]">
      <div className="mb-2 flex flex-wrap items-baseline gap-2.5">
        <h2 className="m-0 text-base font-semibold">{t('边界')}</h2>
        <span className="text-[13px] text-ink-2">{t('系统在下单前检查，超了直接拦下。默认只开「保留现金 20%」。锁住的项 Agent 改不了，会变成申请')}</span>
      </div>
      {visible.map((key) => {
        const spec = settings.limitSpecs[key]
        const on = active(key)
        const locked = Boolean(settings.locks[key])
        const change = lastChange(key)
        return (
          <div key={key} className="flex flex-wrap items-center gap-3 border-t border-line py-2.5">
            <Switch label={label(key)} checked={on} onChange={(value) => setDraft({ ...draft, [key]: value ? (settings.limits[key] ?? defaults[key]) : null })} />
            <div className="min-w-[200px] flex-1"><div className="font-semibold">{label(key)}</div><div className="text-xs text-ink-3">{t(spec.hint)}</div>{change && <div className="text-xs text-ink-3 sm:hidden">{changedByLabel(change.by).replace(t(' · 界面'), '')} · {dateTime(change.at)}</div>}</div>
            {spec.type === 'boards' ? (
              <div className="flex flex-wrap gap-2">{Object.entries(BOARD_NAME).map(([board, name]) => {
                const list = (draft[key] as string[] | null) ?? []
                return <label key={board} className="flex items-center gap-1 text-[13px]"><input type="checkbox" className="size-4 accent-[var(--c-accent)]" checked={list.includes(board)} onChange={(event) => setDraft({ ...draft, [key]: event.target.checked ? [...list, board] : list.filter((entry) => entry !== board) })} />{name}</label>
              })}</div>
            ) : on ? (
              <label className="flex h-9 items-center gap-1 rounded-[9px] border border-line-strong bg-surface px-2.5 focus-within:border-accent">
                <span className="sr-only">{label(key)}</span>
                <input type="number" min={spec.min} max={spec.max} step={spec.type === 'int' ? 1 : 0.1} value={String(draft[key] ?? '')} onChange={(event) => setDraft({ ...draft, [key]: event.target.value === '' ? null : Number(event.target.value) })} className="w-16 bg-transparent text-right font-mono outline-none" />
                <span className="text-ink-3">{unit(key, spec.type)}</span>
              </label>
            ) : <span className="text-[13px] text-ink-3">{t('不限制')}</span>}
            <LockButton label={label(key)} locked={locked} onChange={(value) => lock.mutate({ locks: { [key]: value } })} />
            <span className="w-[130px] shrink-0 text-xs text-ink-3 max-sm:hidden">{change ? `${changedByLabel(change.by).replace(t(' · 界面'), '')} · ${dateTime(change.at)}` : t('默认')}</span>
          </div>
        )
      })}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {!showAll && <Button size="sm" variant="ghost" onClick={() => setShowAll(true)}>{t('显示全部 {n} 项', { n: shown.length })}</Button>}
        <span className="flex-1" />
        {changed.length > 0 && <Button size="sm" onClick={() => setDraft(settings.limits)}>{t('撤销')}</Button>}
        <Button size="sm" variant="primary" disabled={!changed.length} loading={save.isPending} onClick={() => save.mutate({ limits: Object.fromEntries(changed.map((key) => [key, draft[key] ?? null])) })}>{changed.length ? t('保存 {n} 项', { n: changed.length }) : t('保存')}</Button>
      </div>
    </Card>
  )
}

function AutonomyCard({ account }: { account: AccountDetail }) {
  const current: Autonomy = account.autonomy ?? { level: 'full', minValuePct: 10, sells: false, expiryMinutes: 120 }
  const [draft, setDraft] = useState<Autonomy>(current)
  useEffect(() => setDraft(account.autonomy ?? current), [account.autonomy]) // eslint-disable-line react-hooks/exhaustive-deps
  const save = useAction<{ autonomy: Autonomy }>(`/api/arena/accounts/${account.id}`, { invalidate: [['account', account.id], ['leaderboard']], success: t('自主级别已保存，下一笔订单起生效') })
  const dirty = JSON.stringify(draft) !== JSON.stringify(current)
  const descriptions = { full: t('选股、下单都不停下来问你；你只看报告。'), confirm: t('新开仓、大额订单（和可选的卖出）先变成确认卡片，你点确认才下单。'), suggest: t('每笔订单都是提议，你确认才下单；适合刚开始观察一个新交易员。') }
  return (
    <Card className="flex flex-col gap-3 p-[18px]">
      <CardTitle extra={<span className="text-xs text-ink-3">{t('只有你能改，Agent 改不了')}</span>}>{t('自主级别')}</CardTitle>
      <Segmented label={t('自主级别')} value={draft.level} onChange={(level) => setDraft({ ...draft, level })} options={[['full', AUTONOMY_NAME.full], ['confirm', AUTONOMY_NAME.confirm], ['suggest', AUTONOMY_NAME.suggest]]} />
      <p className="m-0 text-[13px] text-ink-2">{descriptions[draft.level]}</p>
      {draft.level === 'confirm' && (
        <div className="flex flex-wrap items-end gap-4">
          <Field label={t('金额超过总资产的（%）就要确认')} className="w-56"><Input type="number" min={0} max={100} value={draft.minValuePct} onChange={(event) => setDraft({ ...draft, minValuePct: Number(event.target.value) })} /></Field>
          <label className="flex h-9 items-center gap-2 text-[13px]"><Switch label={t('卖出也要确认')} checked={draft.sells} onChange={(sells) => setDraft({ ...draft, sells })} />{t('卖出也要确认')}</label>
        </div>
      )}
      {draft.level !== 'full' && <Field label={t('确认卡片多久后过期（分钟）')} hint={t('过期的订单不会下；交易员下一轮会看到。')} className="w-56"><Input type="number" min={5} max={1440} value={draft.expiryMinutes} onChange={(event) => setDraft({ ...draft, expiryMinutes: Number(event.target.value) })} /></Field>}
      <div className="flex items-center gap-2">
        <span className="text-xs text-ink-3">{t('确认时按当时的真实行情下单，所有边界会再检查一遍；止损、止盈的自动卖出不需要确认。')}</span>
        <Button size="sm" variant="primary" className="ml-auto" disabled={!dirty} loading={save.isPending} onClick={() => save.mutate({ autonomy: draft })}>{t('保存')}</Button>
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
  const save = useAction<{ market: string; fees: Record<string, number | boolean> }>('/api/workbench/fees', { invalidate: [['workbench'], ['trader-settings']], success: t('{market}费率已保存，之后的成交按新费率算', { market: MARKET_NAME[market] }) })
  const submit = () => save.mutate({ market, fees: Object.fromEntries([...(FEE_FIELDS[market] ?? []).map(([key, , scale]): [string, number | boolean] => [key, Number(draft[key]) / scale]), ...(market !== 'US' ? [['waiveMinimum', Boolean(draft.waiveMinimum)] as [string, boolean]] : [])]) }, { onSuccess: onSaved })
  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-2.5 max-sm:grid-cols-1">
        {(FEE_FIELDS[market] ?? []).map(([key, label]) => <Field key={key} label={t(label)}><Input type="number" step="any" value={String(draft[key] ?? '')} onChange={(event) => setDraft({ ...draft, [key]: event.target.value })} className="font-mono" /></Field>)}
        {market !== 'US' && <label className="col-span-2 flex items-center gap-2 text-[13px] max-sm:col-span-1"><input type="checkbox" className="size-4 accent-[var(--c-accent)]" checked={Boolean(draft.waiveMinimum)} onChange={(event) => setDraft({ ...draft, waiveMinimum: event.target.checked })} />{t('免五（不收最低佣金）')}</label>}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-ink-3">{t('成交价按买一 / 卖一，再加滑点。')}{isEnglish() ? ' ' : ''}{locked ? t('已锁定：Agent 不能改。') : t('Agent 也能用 arena_set_fees 改。')}</span>
        <Button size="sm" variant="primary" className="ml-auto" loading={save.isPending} onClick={submit}>{t('保存费率')}</Button>
      </div>
    </div>
  )
}

function FeesCard({ account }: { account: AccountDetail }) {
  const settings = useTraderSettings(account.id).data!
  return (
    <Card className="flex flex-col gap-3 p-[18px]">
      <CardTitle extra={<span className="ml-auto text-xs text-ink-3">{t('同市场的交易员共用')}</span>}>{t('费率 · {market}', { market: MARKET_NAME[account.market] })}</CardTitle>
      <FeesForm market={account.market} fees={settings.fees} locked={settings.feesLocked} />
    </Card>
  )
}

type AgentOption = { key: string; runner: Runner; label: string }

export function useAgentOptions(): AgentOption[] {
  const env = useEnv()
  return useMemo(() => (env.data?.agents ?? []).filter((agent) => agent.installed).map((agent) => agent.kind === 'acp'
    ? { key: `acp:${agent.command}`, runner: { type: 'acp', command: agent.command ?? undefined, args: env.data?.acpPresets.find((preset) => preset.id === agent.id)?.args ?? [] }, label: agent.name }
    : { key: agent.id, runner: { type: agent.id }, label: agent.name }), [env.data])
}
const keyOf = (runner?: Runner | null) => (!runner ? '' : runner.type === 'acp' ? `acp:${runner.command}` : runner.type)

function AgentCard({ account, job }: { account: AccountDetail; job: Job | undefined }) {
  const options = useAgentOptions()
  const [primary, setPrimary] = useState(keyOf(job?.runner))
  const [model, setModel] = useState(job?.runner.model ?? '')
  const [backup, setBackup] = useState(keyOf(job?.backup))
  const [backupModel, setBackupModel] = useState(job?.backup?.model ?? '')
  const [mode, setMode] = useState(job?.mode === 'director' || job?.strategy ? 'director' : 'rounds')
  const [review, setReview] = useState(String(job?.intervalMinutes ?? 10))
  useEffect(() => { setPrimary(keyOf(job?.runner)); setModel(job?.runner.model ?? ''); setBackup(keyOf(job?.backup)); setBackupModel(job?.backup?.model ?? ''); setMode(job?.mode === 'director' || job?.strategy ? 'director' : 'rounds'); setReview(String(job?.intervalMinutes ?? 10)) }, [job])
  const save = useAction<Record<string, unknown>>(`/api/arena/schedules/${account.id}`, { invalidate: [['schedules']], success: t('运行方式已保存') })
  if (job?.runner.type === 'strategy') return (
    <Card className="flex flex-col gap-2 p-[18px]">
      <CardTitle>{t('节奏与运行方式')}</CardTitle>
      <div className="text-[13px] text-ink-2">{t('纯代码策略 {id}，每 {n} 分钟执行。', { id: job.runner.strategyId ?? '', n: job.intervalMinutes ?? '—' })}</div>
      <div className="text-xs text-ink-3">{t('想让 Agent 来当主控：在下面选一个 Agent 保存，原来的代码策略会作为策略执行线保留。')}</div>
      <AgentPicker options={options} primary={primary} setPrimary={setPrimary} model={model} setModel={setModel} />
      <Button size="sm" variant="primary" className="self-start" disabled={!primary || primary === 'strategy'} loading={save.isPending} onClick={() => {
        const option = options.find((entry) => entry.key === primary)
        save.mutate({ runner: { ...option!.runner, ...(model ? { model } : {}), timeoutMinutes: 20 }, intervalMinutes: 10, times: [], mode: 'director', strategy: { strategyId: job.runner.strategyId, intervalMinutes: job.intervalMinutes ?? 5, params: job.runner.params ?? {} } })
      }}>{t('改成 Agent 主控')}</Button>
    </Card>
  )
  return (
    <Card className="flex flex-col gap-3 p-[18px]">
      <CardTitle>{t('节奏与 Agent')}</CardTitle>
      <AgentPicker options={options} primary={primary} setPrimary={setPrimary} model={model} setModel={setModel} />
      <div className="grid grid-cols-2 gap-2.5 max-sm:grid-cols-1">
        <Field label={t('备用 Agent')} hint={t('额度用尽或启动失败时代班')}><Select value={backup} onChange={(event) => setBackup(event.target.value)}><option value="">{t('不设置')}</option>{options.filter((entry) => entry.key !== primary).map((entry) => <option key={entry.key} value={entry.key}>{entry.label}</option>)}</Select></Field>
        <Field label={t('备用模型')}><Input value={backupModel} onChange={(event) => setBackupModel(event.target.value)} placeholder={t('跟随当前配置')} disabled={!backup} /></Field>
        <Field label={t('工作方式')}><Select value={mode} onChange={(event) => setMode(event.target.value)}><option value="director">{t('Agent 主控（写代码策略 + 复查）')}</option><option value="rounds">{t('每轮亲自看盘下单')}</option></Select></Field>
        <Field label={mode === 'director' ? t('复查间隔（分钟）') : t('每轮间隔（分钟）')}><Input type="number" min={5} max={240} value={review} onChange={(event) => setReview(event.target.value)} /></Field>
      </div>
      <div className="flex items-center gap-2">
        <Button size="sm" variant="primary" className="ml-auto" disabled={!primary} loading={save.isPending} onClick={() => {
          const option = options.find((entry) => entry.key === primary)
          const backupOption = options.find((entry) => entry.key === backup)
          save.mutate({
            runner: { ...(job?.runner ?? {}), ...option!.runner, model: model || undefined, timeoutMinutes: job?.runner.timeoutMinutes ?? 20 },
            backup: backupOption ? { ...backupOption.runner, ...(backupModel ? { model: backupModel } : {}) } : null,
            mode, intervalMinutes: Number(review) || 10, times: job?.times ?? [],
          })
        }}>{t('保存')}</Button>
      </div>
    </Card>
  )
}

function AgentPicker({ options, primary, setPrimary, model, setModel }: { options: AgentOption[]; primary: string; setPrimary: (value: string) => void; model: string; setModel: (value: string) => void }) {
  return (
    <div className="grid grid-cols-2 gap-2.5 max-sm:grid-cols-1">
      <Field label={t('主 Agent')}><Select value={primary} onChange={(event) => setPrimary(event.target.value)}><option value="" disabled>{t('选择')}</option>{options.map((entry) => <option key={entry.key} value={entry.key}>{entry.label}</option>)}</Select></Field>
      <Field label={t('模型')} hint={t('留空跟随 HRouter Desktop')}><Input value={model} onChange={(event) => setModel(event.target.value)} placeholder={primary === 'kimi' ? 'k3-256k' : primary === 'codex' ? 'gpt-6-astra' : primary === 'claude' ? 'claude-opus-5-5' : ''} /></Field>
    </div>
  )
}

// Scripts look before the agent is woken: skip unchanged slots, wake early when something happens.
function ReviewTriggerCard({ account, job }: { account: AccountDetail; job: Job }) {
  const initial = () => ({ gate: { enabled: true, movePct: 2, maxQuietMinutes: 60, ...job.gate }, wake: { enabled: true, movePct: 4, minMinutes: 5, maxPerDay: 10, ...job.wake } })
  const [draft, setDraft] = useState(initial)
  useEffect(() => setDraft(initial()), [job]) // eslint-disable-line react-hooks/exhaustive-deps
  const save = useAction<Record<string, unknown>>(`/api/arena/schedules/${account.id}`, { invalidate: [['schedules']], success: t('已保存，从下一个时段起生效') })
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial())
  const today = job.gateToday
  return (
    <Card className="flex flex-col gap-3 p-[18px]">
      <CardTitle extra={today ? <span className="text-xs text-ink-3">{t('今天：跳过 {s} · 提前叫醒 {w}', { s: today.skipped ?? 0, w: today.wakes ?? 0 })}</span> : undefined}>{t('复查时机：脚本先看，有变化才叫醒')}</CardTitle>
      <div className="flex items-start gap-3">
        <Switch label={t('没变化就跳过复查')} checked={draft.gate.enabled} onChange={(enabled) => setDraft({ ...draft, gate: { ...draft.gate, enabled } })} />
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <div className="text-[13px] font-semibold">{t('没变化就跳过复查')}<span className="block text-xs font-normal text-ink-3">{t('持仓、挂单、成交、指令和价格都没明显变化时，这个时段不调用 Agent。')}</span></div>
          {draft.gate.enabled && <div className="grid grid-cols-2 gap-2.5">
            <Field label={t('持仓价格变动超过（%）算变化')}><Input type="number" min={0.5} max={20} step={0.5} value={draft.gate.movePct} onChange={(event) => setDraft({ ...draft, gate: { ...draft.gate, movePct: Number(event.target.value) } })} /></Field>
            <Field label={t('最多连续跳过（分钟）')}><Input type="number" min={10} max={480} value={draft.gate.maxQuietMinutes} onChange={(event) => setDraft({ ...draft, gate: { ...draft.gate, maxQuietMinutes: Number(event.target.value) } })} /></Field>
          </div>}
        </div>
      </div>
      <div className="flex items-start gap-3 border-t border-line pt-3">
        <Switch label={t('有事提前叫醒')} checked={draft.wake.enabled} onChange={(enabled) => setDraft({ ...draft, wake: { ...draft.wake, enabled } })} />
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <div className="text-[13px] font-semibold">{t('有事提前叫醒')}<span className="block text-xs font-normal text-ink-3">{t('成交、止损止盈、熔断、你的新指令、订单确认结果、持仓急涨急跌时，不等下个时段马上复查（只在交易时段）。')}</span></div>
          {draft.wake.enabled && <div className="grid grid-cols-2 gap-2.5">
            <Field label={t('持仓急动超过（%）')}><Input type="number" min={1} max={30} step={0.5} value={draft.wake.movePct} onChange={(event) => setDraft({ ...draft, wake: { ...draft.wake, movePct: Number(event.target.value) } })} /></Field>
            <Field label={t('每天最多提前几次')}><Input type="number" min={0} max={50} value={draft.wake.maxPerDay} onChange={(event) => setDraft({ ...draft, wake: { ...draft.wake, maxPerDay: Number(event.target.value) } })} /></Field>
          </div>}
        </div>
      </div>
      <div className="flex justify-end"><Button size="sm" variant="primary" disabled={!dirty} loading={save.isPending} onClick={() => save.mutate(draft)}>{t('保存')}</Button></div>
    </Card>
  )
}

const ANALYSTS = ['technical', 'news', 'fundamental', 'market', 'risk']

function TeamCard({ account, job }: { account: AccountDetail; job: Job }) {
  const options = useAgentOptions().filter((option) => option.runner.type !== 'kimi')
  const initial = () => ({ enabled: Boolean(job.team?.enabled), roles: job.team?.roles ?? ['technical', 'news', 'market'], debate: job.team?.debate ?? true, analyst: keyOf(job.team?.analyst ?? null), model: job.team?.analyst?.model ?? '' })
  const [draft, setDraft] = useState(initial)
  useEffect(() => setDraft(initial()), [job]) // eslint-disable-line react-hooks/exhaustive-deps
  const save = useAction<Record<string, unknown>>(`/api/arena/schedules/${account.id}`, { invalidate: [['schedules']], success: t('团队模式已保存') })
  const kimiMain = job.runner.type === 'kimi'
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial())
  const runs = draft.roles.length + (draft.debate ? 2 : 0)
  return (
    <Card className="flex flex-col gap-3 p-[18px]">
      <CardTitle extra={<Switch label={t('团队模式')} checked={draft.enabled} onChange={(enabled) => setDraft({ ...draft, enabled })} />}>{t('团队模式')}</CardTitle>
      <p className="m-0 text-[13px] text-ink-2">{t('每次复查前，先让只读的分析员各写一份报告（可加多空辩论），交易员看完再拍板。分析员不能下单。')}</p>
      {draft.enabled && <>
        <div className="flex flex-wrap gap-2">
          {ANALYSTS.map((role) => (
            <label key={role} className={cn('flex items-center gap-1.5 rounded-[9px] border px-2.5 py-1.5 text-[13px]', draft.roles.includes(role) ? 'border-accent-line bg-accent-soft' : 'border-line')}>
              <input type="checkbox" className="size-4 accent-[var(--c-accent)]" checked={draft.roles.includes(role)} onChange={(event) => setDraft({ ...draft, roles: event.target.checked ? [...draft.roles, role] : draft.roles.filter((entry) => entry !== role) })} />{TEAM_ROLE[role]}
            </label>
          ))}
        </div>
        <label className="flex items-center gap-2 text-[13px]"><Switch label={t('多空辩论')} checked={draft.debate} onChange={(debate) => setDraft({ ...draft, debate })} />{t('多空辩论（多头、空头研究员各一份）')}</label>
        <div className="grid grid-cols-2 gap-2.5 max-sm:grid-cols-1">
          <Field label={t('分析员用的 Agent')} hint={kimiMain ? t('Kimi Code 不能只读运行，请另选') : t('留空用主 Agent；可以选便宜的模型')}>
            <Select value={draft.analyst} onChange={(event) => setDraft({ ...draft, analyst: event.target.value })}><option value="">{kimiMain ? t('请选择') : t('跟主 Agent 一样')}</option>{options.map((entry) => <option key={entry.key} value={entry.key}>{entry.label}</option>)}</Select>
          </Field>
          <Field label={t('分析员模型')}><Input value={draft.model} onChange={(event) => setDraft({ ...draft, model: event.target.value })} placeholder={t('跟随当前配置')} /></Field>
        </div>
        <p className="m-0 text-xs text-warn-ink">{t('每次复查前会先多跑 {n} 个 Agent。', { n: runs })}</p>
      </>}
      <div className="flex justify-end">
        <Button size="sm" variant="primary" disabled={!dirty || (draft.enabled && (!draft.roles.length || (kimiMain && !draft.analyst)))} loading={save.isPending} onClick={() => {
          const option = options.find((entry) => entry.key === draft.analyst)
          save.mutate({ team: draft.enabled ? { enabled: true, roles: draft.roles, debate: draft.debate, analyst: option ? { ...option.runner, ...(draft.model ? { model: draft.model } : {}) } : null } : { enabled: false } })
        }}>{t('保存')}</Button>
      </div>
    </Card>
  )
}

function SkillsCard({ account }: { account: AccountDetail }) {
  const library = useLibrary()
  const template = library.data?.templates.find((entry) => entry.id === account.template)
  const current = account.skills ?? template?.skills ?? []
  const [chosen, setChosen] = useState<string[]>(current)
  const [editing, setEditing] = useState<string | null>(null)
  useEffect(() => setChosen(account.skills ?? template?.skills ?? []), [account.skills, template])
  const save = useAction<{ skills: string[] | null }>(`/api/arena/accounts/${account.id}`, { invalidate: [['account', account.id], ['leaderboard']], success: t('Skill 已更新，下一次复查起生效') })
  const discipline = library.data?.discipline ?? []
  const skills = (library.data?.skills ?? []).filter((skill) => skill.markets.includes(account.market) && !discipline.includes(skill.id))
  const overrides = account.skillOverrides ?? {}
  const editingSkill = library.data?.skills.find((skill) => skill.id === editing)
  return (
    <Card className="flex flex-col gap-3 p-[18px]">
      <CardTitle extra={<span className="text-xs text-ink-3">{t('纪律类 skill（交易前关卡、仓位计算、亏损熔断、复盘）总是带上')}</span>}>{t('流派 Skill')}{template ? t(' · 模板「{name}」', { name: template.name }) : ''}</CardTitle>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(min(240px,100%),1fr))] gap-2">
        {skills.map((skill) => (
          <div key={skill.id} className={cn('flex flex-col gap-1.5 rounded-[10px] border p-2.5 text-[13px]', skill.status !== 'available' ? 'opacity-60' : chosen.includes(skill.id) ? 'border-accent-line bg-accent-soft' : 'border-line')}>
            <label className="flex items-start gap-2">
              <input type="checkbox" className="mt-0.5 size-4 accent-[var(--c-accent)]" disabled={skill.status !== 'available'} checked={chosen.includes(skill.id)} onChange={(event) => setChosen(event.target.checked ? [...chosen, skill.id] : chosen.filter((id) => id !== skill.id))} />
              <span><span className="font-semibold">{skill.name}</span>{skill.source === 'imported' && <Pill className="ml-1">{t('导入的')}</Pill>}{overrides[skill.id] && <Pill tone="accent" className="ml-1">{t('已定制 v{n}', { n: overrides[skill.id].version ?? 1 })}</Pill>}<span className="block text-xs text-ink-3">{skill.summary}</span></span>
            </label>
            {chosen.includes(skill.id) && <button type="button" className="self-end text-xs text-accent-ink hover:underline" onClick={() => setEditing(skill.id)}>{t('定制')}</button>}
          </div>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-1.5 text-xs text-ink-3">
        <span>{t('纪律类也能定制：')}</span>
        {discipline.map((id) => <button key={id} type="button" onClick={() => setEditing(id)} className="rounded-md bg-sunken px-1.5 py-0.5 hover:text-ink">{library.data?.skills.find((skill) => skill.id === id)?.name ?? id}{overrides[id] ? ' ✓' : ''}</button>)}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Link to="/skills" className="text-[13px]">{t('看 Skill 库')}</Link>
        {account.skills && <Button size="sm" variant="ghost" onClick={() => save.mutate({ skills: null })}>{t('恢复模板默认')}</Button>}
        <Button size="sm" variant="primary" className="ml-auto" disabled={JSON.stringify(chosen) === JSON.stringify(current)} loading={save.isPending} onClick={() => save.mutate({ skills: chosen })}>{t('保存')}</Button>
      </div>
      {editingSkill && <SkillOverrideDialog accountId={account.id} skillId={editingSkill.id} skillName={editingSkill.name} override={overrides[editingSkill.id]} onClose={() => setEditing(null)} />}
    </Card>
  )
}

function SkillOverrideDialog({ accountId, skillId, skillName, override, onClose }: { accountId: string; skillId: string; skillName: string; override?: SkillOverride; onClose: () => void }) {
  const [params, setParams] = useState(Object.entries(override?.params ?? {}).map(([key, value]) => `${key} = ${value}`).join('\n'))
  const [append, setAppend] = useState(override?.append ?? '')
  const [references, setReferences] = useState(override?.references ?? [])
  const body = useQuery({ queryKey: ['skill-body', skillId], queryFn: ({ signal }) => get<{ body: string }>(`/api/library/skills/${skillId}`, signal) })
  const save = useAction<{ params: Record<string, string>; append: string; references: Array<{ name: string; text: string }> }>(`/api/arena/accounts/${accountId}/skills/${skillId}`, { invalidate: [['account', accountId]], success: t('定制已保存，下一次复查起生效') })
  const parsed = Object.fromEntries(params.split('\n').map((line) => line.split(/[=:：]/)).filter((parts) => parts.length >= 2 && parts[0].trim()).map(([key, ...rest]) => [key.trim(), rest.join('=').trim()]))
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()} title={t('定制「{name}」', { name: skillName })} description={t('只对这个交易员生效，追加在通用 skill 后面；改动会记进修改记录，每次复查记下 skill 版本。')} width={760}>
      <div className="flex flex-col gap-3">
        <details className="rounded-lg border border-line"><summary className="cursor-pointer px-3 py-2 text-[13px] text-ink-2">{t('看通用 skill 原文')}</summary><pre className="m-0 max-h-[30vh] overflow-auto whitespace-pre-wrap border-t border-line bg-surface-2 p-3 font-mono text-xs scroll-thin">{body.data?.body ?? '…'}</pre></details>
        <Field label={t('改过的参数（每行一个：名称 = 值）')} hint={t('例如：快线 = 10；单笔风险 = 1%')}><Textarea rows={3} value={params} onChange={(event) => setParams(event.target.value)} className="font-mono" /></Field>
        <Field label={t('追加的规则')}><Textarea rows={4} value={append} onChange={(event) => setAppend(event.target.value)} maxLength={4000} placeholder={t('例如：只做沪深 300 成分股；周五下午不开新仓')} /></Field>
        <div className="flex flex-col gap-2">
          <div className="flex items-center text-xs text-ink-3"><span className="flex-1">{t('参考资料（最多 5 份，每份截取前 3000 字发给 Agent）')}</span>{references.length < 5 && <Button size="sm" variant="ghost" onClick={() => setReferences([...references, { name: '', text: '' }])}><Plus className="size-3.5" />{t('添加')}</Button>}</div>
          {references.map((reference, index) => (
            <div key={index} className="flex flex-col gap-1.5 rounded-lg border border-line p-2.5">
              <div className="flex gap-2"><Input value={reference.name} onChange={(event) => setReferences(references.map((entry, i) => (i === index ? { ...entry, name: event.target.value } : entry)))} placeholder={t('名称')} aria-label={t('参考资料名称')} /><Button size="sm" variant="ghost" aria-label={t('删除这份资料')} onClick={() => setReferences(references.filter((_, i) => i !== index))}><Trash2 className="size-3.5" /></Button></div>
              <Textarea rows={3} value={reference.text} onChange={(event) => setReferences(references.map((entry, i) => (i === index ? { ...entry, text: event.target.value } : entry)))} placeholder={t('粘贴内容')} aria-label={t('参考资料内容')} />
            </div>
          ))}
        </div>
        <div className="flex items-center gap-2">
          {override && <Button size="sm" variant="ghost" onClick={() => save.mutate({ params: {}, append: '', references: [] }, { onSuccess: onClose })}>{t('清除定制')}</Button>}
          <span className="flex-1" />
          <Button size="sm" onClick={onClose}>{t('取消')}</Button>
          <Button size="sm" variant="primary" loading={save.isPending} onClick={() => save.mutate({ params: parsed, append, references: references.filter((entry) => entry.text.trim()) }, { onSuccess: onClose })}>{t('保存')}</Button>
        </div>
      </div>
    </Dialog>
  )
}

function ChangeLogCard({ account }: { account: AccountDetail }) {
  const settings = useTraderSettings(account.id).data!
  return (
    <Card className="flex flex-col gap-3 p-4">
      <CardTitle>{t('修改记录')}</CardTitle>
      {settings.changeLog.length ? settings.changeLog.slice(0, 12).map((entry) => (
        <div key={entry.id} className="flex flex-col gap-0.5">
          <div className="text-[13px] font-semibold">{changeLabel(entry.key)}{entry.key.startsWith('lock:') ? (entry.to ? '' : t('（解锁）')) : ` ${valueLabel(entry.key, entry.from)} → ${valueLabel(entry.key, entry.to)}`}</div>
          {entry.reason && <div className="text-xs text-ink-2">「{entry.reason}」</div>}
          <div className="font-mono text-xs text-ink-3">{changedByLabel(entry.by)} · {dateTime(entry.at)}</div>
        </div>
      )) : <div className="text-[13px] text-ink-3">{t('还没有修改。')}</div>}
      <div className="border-t border-line pt-2.5 text-xs text-ink-2">{t('绩效按每次修改前后分段，竞技场里能看到。')}</div>
    </Card>
  )
}

function McpCard({ account }: { account: AccountDetail }) {
  return (
    <Card className="flex flex-col gap-2.5 p-4">
      <CardTitle>{t('用 MCP / ACP 改')}</CardTitle>
      <p className="m-0 text-[13px] text-ink-2">{t('Claude Code、Codex、Kimi（ACP）等任何接了本插件的 Agent 都能调这些工具。锁住的项会被拒绝并变成申请。')}</p>
      <div className="flex flex-col gap-1.5 text-xs">
        {[['arena_get_settings', t('读当前值和锁定状态')], ['arena_set_limits', t('边界')], ['arena_set_fees', t('费率')], ['arena_set_cadence', t('复查间隔、执行频率')], ['arena_set_prompt', t('前置提示词')], ['arena_write_strategy', t('代码策略')], ['arena_propose_rule', t('提议长期规则')], ['arena_check_rules', t('下单前试算')], ['arena_request_confirmation', t('请你确认订单')], ['arena_dispatch', t('派活给团队分析员')]].map(([tool, label]) => (
          <div key={tool} className="flex gap-2"><code className="font-mono text-accent-ink">{tool}</code><span className="text-ink-3">{label}</span></div>
        ))}
      </div>
      <pre className="m-0 whitespace-pre-wrap rounded-[9px] border border-line bg-surface-2 p-3 font-mono text-xs">{`arena_set_limits({\n  accountId: "${account.id}",\n  minCashPct: 30,\n  reason: "${t('周五前降仓')}"\n})`}</pre>
    </Card>
  )
}

function DangerCard({ account }: { account: AccountDetail }) {
  const navigate = useNavigate()
  const archive = useAction<{ status: string }>(`/api/arena/accounts/${account.id}`, { invalidate: [['leaderboard']], success: t('已归档，挂单已撤销') })
  return (
    <Card className="flex flex-wrap items-center gap-3 p-[18px]">
      <div className="min-w-[240px] flex-1"><div className="font-semibold">{t('归档交易员')}</div><div className="text-xs text-ink-3">{t('停止交易、撤销挂单，排行榜里不再显示。记录都保留。')}</div></div>
      <Button variant="danger" loading={archive.isPending} onClick={() => { if (window.confirm(t('归档「{name}」？挂单会被撤销。', { name: account.name }))) archive.mutate({ status: 'archived' }, { onSuccess: () => navigate({ to: '/traders' }) }) }}>{t('归档')}</Button>
    </Card>
  )
}

