import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { get } from '@/lib/api'
import { isEnglish, t } from '@/lib/i18n'
import { Field, Input, Select } from './ui'

// Models and efforts each agent CLI offers, read by the service from the CLI's own files
// (Claude Code aliases, ~/.codex/models_cache.json, ~/.kimi-code/config.toml). Newest first.
export interface AgentModel { id: string; label: string; latest?: boolean; efforts?: string[] }
export interface AgentModels { efforts: string[]; defaultEffort: string; agents: Record<string, { models: AgentModel[]; configured: string | null; source: string | null; effortFlag: boolean }> }

export const useAgentModels = () => useQuery({ queryKey: ['agent-models'], queryFn: ({ signal }) => get<AgentModels>('/api/agent-models', signal), staleTime: 600_000 })

// Not dictionary keys: 低 / 高 already mean the chart's low / high.
export const EFFORT_NAME: Record<string, string> = isEnglish() ? { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max' } : { low: '低', medium: '中', high: '高', xhigh: '很高', max: '最高' }

/** The newest model an agent CLI offers, or '' when it lists none (ACP, WorkBuddy). */
export function latestModel(data: AgentModels | undefined, agent: string) {
  return data?.agents[agent]?.models.find((model) => model.latest)?.id ?? ''
}

export function ModelField({ agent, value, onChange, label = t('模型'), disabled }: { agent: string; value: string; onChange: (value: string) => void; label?: string; disabled?: boolean }) {
  const models = useAgentModels()
  const entry = models.data?.agents[agent]
  const list = entry?.models ?? []
  const [custom, setCustom] = useState(false)
  const known = !value || list.some((model) => model.id === value)
  if (!list.length || custom || !known) {
    return (
      <Field label={label} hint={list.length ? <button type="button" className="text-accent-ink underline-offset-2 hover:underline" onClick={() => { setCustom(false); onChange(latestModel(models.data, agent)) }}>{t('从列表选')}</button> : t('留空用这个 Agent 自己的默认模型')}>
        <Input value={value} onChange={(event) => onChange(event.target.value)} disabled={disabled} placeholder={t('模型名')} />
      </Field>
    )
  }
  return (
    <Field label={label} hint={entry?.source ? t('列表来自 {source}', { source: entry.source }) : undefined}>
      <Select value={value} disabled={disabled} onChange={(event) => { if (event.target.value === '__custom') { setCustom(true); return } onChange(event.target.value) }}>
        {list.map((model) => <option key={model.id} value={model.id}>{model.label}{model.latest ? t('（最新）') : ''}</option>)}
        <option value="">{t('Agent 自己的默认{model}', { model: entry?.configured ? `（${entry.configured}）` : '' })}</option>
        <option value="__custom">{t('其他（手动填）…')}</option>
      </Select>
    </Field>
  )
}

export function EffortField({ agent, model, value, onChange, disabled }: { agent: string; model: string; value: string; onChange: (value: string) => void; disabled?: boolean }) {
  const models = useAgentModels()
  const entry = models.data?.agents[agent]
  if (!entry?.effortFlag) return <Field label={t('推理强度')} hint={agent === 'kimi' ? t('Kimi Code 用它自己配置里的 thinking 设置') : t('这个 Agent 不支持设置强度')}><Select disabled value=""><option value="">—</option></Select></Field>
  const efforts = entry.models.find((item) => item.id === model)?.efforts?.length ? entry.models.find((item) => item.id === model)!.efforts! : models.data!.efforts
  return (
    <Field label={t('推理强度')} hint={t('默认高；越高越慢、用量越大')}>
      <Select value={efforts.includes(value) ? value : models.data!.defaultEffort} disabled={disabled} onChange={(event) => onChange(event.target.value)}>
        {efforts.map((effort) => <option key={effort} value={effort}>{EFFORT_NAME[effort] ?? effort}</option>)}
      </Select>
    </Field>
  )
}
