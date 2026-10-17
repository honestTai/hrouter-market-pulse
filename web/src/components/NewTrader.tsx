import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { post, type AccountDetail, type Autonomy, type Market } from '@/lib/api'
import { AGENT_NAME, AUTONOMY_NAME, MARKET_NAME, valueLabel, CHANGE_KEY } from '@/lib/format'
import { locale, t } from '@/lib/i18n'
import { useAction, useEnv, useLibrary } from '@/lib/queries'
import { AgentMark, Button, Dialog, Field, Input, Pill, Segmented, Select, Textarea, cn } from './ui'

const DEFAULT_CASH: Record<Market, number> = { A: 1000000, HK: 1000000, US: 100000 }
const STEPS = [t('市场与资金'), t('流派'), t('Agent 与模型'), t('提示词与边界'), t('节奏与自主')]
const AUTONOMY_HINT: Record<Autonomy['level'], string> = { full: t('选股、下单、写报告都不会停下来问你；锁住的边界改不了，会变成申请。'), confirm: t('新开仓和大额订单先等你确认，卖出和小额加减仓照常执行。'), suggest: t('每笔订单都等你确认，交易员只给建议。') }

type AgentChoice = { type: string; command?: string; args?: string[]; label: string }

export function NewTraderDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (value: boolean) => void }) {
  const navigate = useNavigate()
  const library = useLibrary()
  const env = useEnv()
  const [step, setStep] = useState(0)
  const [market, setMarket] = useState<Market>('A')
  const [name, setName] = useState('')
  const [cash, setCash] = useState('')
  const [competition, setCompetition] = useState('default')
  const [template, setTemplate] = useState<string>('a-share-swing')
  const [agent, setAgent] = useState('codex')
  const [model, setModel] = useState('')
  const [backup, setBackup] = useState('')
  const [prompt, setPrompt] = useState('')
  const [promptTouched, setPromptTouched] = useState(false)
  const [minCash, setMinCash] = useState('20')
  const [suggested, setSuggested] = useState(false)
  const [review, setReview] = useState('10')
  const [autonomy, setAutonomy] = useState<Autonomy['level']>('full')

  useEffect(() => { if (open) setStep(0) }, [open])
  const templates = (library.data?.templates ?? []).filter((entry) => entry.markets.includes(market))
  const chosen = templates.find((entry) => entry.id === template) ?? null
  useEffect(() => { if (chosen && !promptTouched) setPrompt(chosen.prompt) }, [chosen, promptTouched])
  useEffect(() => { if (template && !templates.some((entry) => entry.id === template && entry.status === 'available')) setTemplate(templates.find((entry) => entry.status === 'available')?.id ?? '') }, [market, templates, template])
  useEffect(() => { if (chosen?.cadence.reviewMinutes) setReview(String(chosen.cadence.reviewMinutes)) }, [chosen])

  const agents = useMemo<AgentChoice[]>(() => {
    const installed = (env.data?.agents ?? []).filter((entry) => entry.installed)
    return installed.map((entry) => entry.kind === 'acp' ? { type: 'acp', command: entry.command ?? undefined, args: (env.data?.acpPresets.find((preset) => preset.id === entry.id)?.args) ?? [], label: entry.name } : { type: entry.id, label: entry.name })
  }, [env.data])
  const quant = chosen?.builtinStrategy
  const agentChoice = agents.find((entry) => (entry.type === 'acp' ? `acp:${entry.command}` : entry.type) === agent)

  const create = useAction<Record<string, unknown>, AccountDetail>('/api/arena/accounts', { invalidate: [['leaderboard'], ['schedules']], success: (account) => t('已创建 {name}', { name: account.name }) })

  const submit = () => {
    const limits = { minCashPct: minCash === '' ? null : Number(minCash) }
    const runner = quant ? { type: 'strategy', strategyId: chosen?.starterStrategy } : agentChoice ? { type: agentChoice.type, ...(model ? { model } : {}), ...(agentChoice.command ? { command: agentChoice.command, args: agentChoice.args } : {}) } : null
    const backupChoice = agents.find((entry) => (entry.type === 'acp' ? `acp:${entry.command}` : entry.type) === backup)
    create.mutate({
      name: name.trim() || `${quant ? t('量化') : AGENT_NAME[agentChoice?.type ?? ''] ?? agentChoice?.label ?? 'Agent'} · ${chosen?.name ?? MARKET_NAME[market]}`,
      model: quant ? `strategy:${chosen?.starterStrategy}` : model || agentChoice?.type || 'unknown',
      market, competition: competition.trim() || 'default', agentLabel: quant ? t('量化策略') : AGENT_NAME[agentChoice?.type ?? ''] ?? agentChoice?.label,
      ...(cash ? { initialCash: Number(cash) } : {}), ...(template ? { template } : {}), prompt, applySuggestedLimits: suggested, limits, reviewMinutes: Number(review) || undefined,
      ...(runner ? { runner: runner.type === 'strategy' ? runner : { ...runner, timeoutMinutes: 20 } } : {}),
      ...(backupChoice && !quant ? { backup: { type: backupChoice.type, ...(backupChoice.command ? { command: backupChoice.command, args: backupChoice.args } : {}) } } : {}),
    }, { onSuccess: async (account) => { if (autonomy !== 'full') await post(`/api/arena/accounts/${account.id}`, { autonomy: { level: autonomy }, reason: t('新建时选择') }).catch(() => {}); onOpenChange(false); navigate({ to: '/traders/$id', params: { id: account.id }, search: { tab: undefined } }) } })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={t('新建交易员')} description={t('交易员 = 一个模拟账户 + 一个 Agent 和模型 + 流派 skill + 前置提示词 + 边界。以后都能改。')} width={680}>
      <ol className="mb-5 flex flex-wrap gap-1.5">
        {STEPS.map((label, index) => (
          <li key={label}><button type="button" onClick={() => setStep(index)} className={cn('rounded-full px-2.5 py-1 text-xs', index === step ? 'bg-accent text-white' : index < step ? 'bg-accent-soft text-accent-ink' : 'bg-sunken text-ink-2')}>{index + 1} {label}</button></li>
        ))}
      </ol>

      {step === 0 && (
        <div className="grid grid-cols-2 gap-4 max-sm:grid-cols-1">
          <Field label={t('市场')}><Select value={market} onChange={(event) => setMarket(event.target.value as Market)}>{(['A', 'HK', 'US'] as Market[]).map((key) => <option key={key} value={key}>{MARKET_NAME[key]}</option>)}</Select></Field>
          <Field label={t('名称')} hint={t('留空自动起名')}><Input value={name} onChange={(event) => setName(event.target.value)} maxLength={60} placeholder={t('例如：Codex · A股趋势波段')} /></Field>
          <Field label={t('初始资金')} hint={t('留空用默认 {n}，同组可比', { n: DEFAULT_CASH[market].toLocaleString(locale()) })}><Input type="number" min={1000} step={1000} value={cash} onChange={(event) => setCash(event.target.value)} /></Field>
          <Field label={t('比赛组别')} hint={t('同市场、同组别才一起排名')}><Input value={competition} onChange={(event) => setCompetition(event.target.value)} maxLength={40} /></Field>
        </div>
      )}

      {step === 1 && (
        <div className="grid grid-cols-2 gap-3 max-sm:grid-cols-1">
          {templates.map((entry) => (
            <button key={entry.id} type="button" disabled={entry.status !== 'available'} onClick={() => setTemplate(entry.id)}
              className={cn('flex flex-col gap-1.5 rounded-xl border p-3 text-left', template === entry.id ? 'border-accent bg-accent-soft' : 'border-line bg-surface hover:border-line-strong', entry.status !== 'available' && 'opacity-60')}>
              <span className="flex items-center gap-2 font-semibold">{t(entry.name)}{entry.status !== 'available' && <Pill tone="warn">{t('缺数据')}</Pill>}</span>
              <span className="text-xs text-ink-2">{entry.builtinStrategy ? t('纯代码策略，不需要 Agent') : entry.skills.map((id) => library.data?.skills.find((skill) => skill.id === id)?.name ?? id).join(t('、')) || t('只带纪律类 skill')}</span>
              {entry.status !== 'available' && <span className="text-xs text-warn-ink">{t('需要：{list}', { list: entry.requires?.join(t('、')) ?? '' })}</span>}
            </button>
          ))}
          <button type="button" onClick={() => setTemplate('')} className={cn('rounded-xl border p-3 text-left', template === '' ? 'border-accent bg-accent-soft' : 'border-line bg-surface')}>
            <span className="font-semibold">{t('从空白开始')}</span><span className="block text-xs text-ink-2">{t('只带纪律类 skill，策略由 Agent 自己写')}</span>
          </button>
        </div>
      )}

      {step === 2 && (quant ? <p className="m-0 text-[13px] text-ink-2">{t('「{name}」是纯代码策略（{id}），不需要 Agent。每 {n} 分钟执行一次。', { name: t(chosen?.name ?? ''), id: chosen?.starterStrategy ?? '', n: chosen?.cadence.strategyMinutes ?? '' })}</p> : (
        <div className="flex flex-col gap-4">
          <Field label={t('主 Agent')} hint={t('只列出本机已安装的；ACP 接入的 Agent 在设置里管理')}>
            <div className="flex flex-wrap gap-2">
              {agents.map((entry) => {
                const key = entry.type === 'acp' ? `acp:${entry.command}` : entry.type
                return <button key={key} type="button" onClick={() => setAgent(key)} className={cn('flex items-center gap-2 rounded-[10px] border px-3 py-2 text-[13px]', agent === key ? 'border-accent bg-accent-soft font-semibold' : 'border-line')}><AgentMark kind={entry.type === 'acp' ? entry.label.toLowerCase().split(' ')[0] : entry.type} />{entry.label}</button>
              })}
              {!agents.length && <span className="text-[13px] text-ink-3">{t('没检测到 Agent CLI，去设置 → 环境检查看看。')}</span>}
            </div>
          </Field>
          <Field label={t('模型')} hint={t('留空跟随 HRouter Desktop 当前配置。要和 Agent 对应：Kimi 的模型名别填到 Claude 上')}><Input value={model} onChange={(event) => setModel(event.target.value)} placeholder={agent === 'codex' ? 'gpt-6-astra' : agent === 'claude' ? 'claude-opus-5-5' : agent === 'kimi' ? 'k3-256k' : ''} /></Field>
          <Field label={t('备用 Agent')} hint={t('主 Agent 额度用尽或启动失败时代班复查')}>
            <Select value={backup} onChange={(event) => setBackup(event.target.value)}>
              <option value="">{t('不设置')}</option>
              {agents.filter((entry) => (entry.type === 'acp' ? `acp:${entry.command}` : entry.type) !== agent).map((entry) => { const key = entry.type === 'acp' ? `acp:${entry.command}` : entry.type; return <option key={key} value={key}>{entry.label}</option> })}
            </Select>
          </Field>
        </div>
      ))}

      {step === 3 && (
        <div className="flex flex-col gap-4">
          <Field label={t('本交易员的前置提示词')} hint={t('排在全局和市场提示词后面，每次复查都会带上')}><Textarea rows={4} value={prompt} onChange={(event) => { setPrompt(event.target.value); setPromptTouched(true) }} maxLength={4000} /></Field>
          <Field label={t('保留现金（%）')} hint={t('默认 20%，其他边界默认都不限制，建好后随时在设置里打开')}><Input type="number" min={0} max={95} value={minCash} onChange={(event) => setMinCash(event.target.value)} className="w-32" /></Field>
          {chosen && Object.keys(chosen.suggestedLimits).length > 0 && (
            <label className="flex items-start gap-2 text-[13px]">
              <input type="checkbox" checked={suggested} onChange={(event) => setSuggested(event.target.checked)} className="mt-0.5 size-4 accent-[var(--c-accent)]" />
              <span>{t('同时打开「{name}」推荐的边界：', { name: t(chosen.name) })}{Object.entries(chosen.suggestedLimits).map(([key, value]) => `${CHANGE_KEY[key] ?? key} ${valueLabel(key, value)}`).join(t('，'))}</span>
            </label>
          )}
        </div>
      )}

      {step === 4 && (
        <div className="flex flex-col gap-4">
          {!quant && <Field label={t('复查间隔（分钟）')} hint={t('Agent 当主控：每隔这么久复查一次，中间由它写的代码策略执行；没变化的时段自动跳过。Agent 自己也能改')}><Input type="number" min={5} max={240} value={review} onChange={(event) => setReview(event.target.value)} className="w-32" /></Field>}
          <Field label={t('自主级别')} hint={AUTONOMY_HINT[autonomy]}>
            <Segmented label={t('自主级别')} value={autonomy} onChange={setAutonomy} options={(['full', 'confirm', 'suggest'] as const).map((level) => [level, AUTONOMY_NAME[level]])} />
          </Field>
        </div>
      )}

      <div className="mt-6 flex items-center gap-2">
        {step > 0 && <Button onClick={() => setStep(step - 1)}>{t('上一步')}</Button>}
        <span className="flex-1" />
        {step < STEPS.length - 1 ? <Button variant="primary" onClick={() => setStep(step + 1)} disabled={step === 2 && !quant && !agentChoice}>{t('下一步')}</Button>
          : <Button variant="primary" onClick={submit} loading={create.isPending} disabled={!quant && !agentChoice}>{t('创建交易员')}</Button>}
      </div>
    </Dialog>
  )
}
