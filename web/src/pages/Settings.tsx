import { useEffect, useState } from 'react'
import { useNavigate, useSearch } from '@tanstack/react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { Page, PageHeader } from '@/components/Shell'
import { FuturePaperSection } from './settings-broker'
import { FeesForm } from './trader/Settings'
import { PoolRow } from './Schedule'
import { AgentMark, Button, Card, CardTitle, Dot, Field, Input, LockButton, Pill, Segmented, Select, Spinner, Textarea, cn } from '@/components/ui'
import { get, post, type Market } from '@/lib/api'
import { MARKET_NAME, changeLabel, changedByLabel, dateTime, valueLabel } from '@/lib/format'
import { prefs, type Colors, type Theme } from '@/lib/prefs'
import { useAccounts, useAction, useEnv, usePools, useWorkbench } from '@/lib/queries'
import { language, setLanguage, t } from '@/lib/i18n'

const SECTIONS: Array<[string, string]> = [['env', t('环境检查')], ['agents', t('Agent 管理')], ['quota', t('额度池')], ['prompts', t('前置提示词')], ['fees', t('费率')], ['push', t('推送')], ['broker', t('券商连接')], ['general', t('通用')]]

export function SettingsPage() {
  const search = useSearch({ from: '/settings' })
  const navigate = useNavigate()
  const section = search.section ?? 'env'
  return (
    <Page>
      <PageHeader title={t('设置')} description={t('只在本机运行。模型和供应商在 HRouter Desktop 里切换，这里管 Agent、额度、提示词、费率、推送、券商连接和语言。')} />
      <div className="flex flex-wrap items-start gap-5">
        <nav aria-label={t('设置分组')} className="flex min-w-0 flex-[0_1_200px] flex-col gap-0.5">
          {SECTIONS.map(([id, label]) => (
            <button key={id} type="button" aria-current={section === id ? 'page' : undefined} onClick={() => navigate({ to: '/settings', search: { section: id } })}
              className={cn('flex min-h-9 items-center rounded-lg px-2.5 text-left text-[14px]', section === id ? 'border border-line bg-surface font-semibold' : 'text-ink-2 hover:bg-surface')}>{label}</button>
          ))}
        </nav>
        <div className="flex min-w-0 flex-[999_1_640px] flex-col gap-4">
          {section === 'env' && <EnvSection />}
          {section === 'agents' && <AgentsSection />}
          {section === 'quota' && <QuotaSection />}
          {section === 'prompts' && <PromptsSection />}
          {section === 'fees' && <FeesSection />}
          {section === 'push' && <PushSection />}
          {section === 'broker' && <FuturePaperSection />}
          {section === 'general' && <GeneralSection />}
        </div>
      </div>
    </Page>
  )
}

const TONE = { ok: 'ok', action: 'warn', temporary: 'muted', missing: 'muted' } as const

function EnvSection() {
  const env = useEnv()
  const client = useQueryClient()
  const [checking, setChecking] = useState(false)
  const recheck = async () => { setChecking(true); try { client.setQueryData(['env'], await get('/api/env?fresh=1')) } catch (error) { toast.error((error as Error).message) } finally { setChecking(false) } }
  const summary = env.data?.summary
  return (
    <Card className="flex flex-col gap-3 p-[18px]">
      <div className="flex flex-wrap items-center gap-2.5">
        <h2 className="m-0 text-base font-semibold">{t('环境检查')}</h2>
        {summary && <><Pill tone="ok">{t('{n} 项就绪', { n: summary.ok })}</Pill>{summary.action > 0 && <Pill tone="warn">{t('{n} 项待处理', { n: summary.action })}</Pill>}{summary.temporary > 0 && <Pill>{t('{n} 项暂时不可用', { n: summary.temporary })}</Pill>}{summary.missing > 0 && <Pill>{t('{n} 项没装', { n: summary.missing })}</Pill>}</>}
        <Button size="sm" className="ml-auto" loading={checking} onClick={recheck}><RefreshCw className="size-4" />{t('重新检查')}</Button>
      </div>
      {env.isLoading ? <Spinner /> : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(min(320px,100%),1fr))] gap-x-6">
          {env.data?.items.map((item) => (
            <div key={item.id} className={cn('flex items-center gap-2.5 border-t border-line py-2.5', item.status === 'action' && '-mx-2 rounded-lg bg-warn-soft px-2')}>
              <Dot tone={TONE[item.status]} label={item.status} />
              <span className="flex-1 font-semibold">{item.name}</span>
              <span className="truncate text-right font-mono text-xs text-ink-3" title={item.detail}>{item.detail}</span>
            </div>
          ))}
        </div>
      )}
      <div className="text-xs text-ink-3">{t('登录状态不直接探测（会花额度），看最近一次运行的结果判断。检查时间 {time}。', { time: dateTime(env.data?.at) })}</div>
    </Card>
  )
}

function AgentsSection() {
  const env = useEnv()
  const workbench = useWorkbench()
  const [cap, setCap] = useState('')
  useEffect(() => setCap(String(workbench.data?.maxConcurrentAgents ?? 4)), [workbench.data])
  const save = useAction<{ maxConcurrentAgents: number }>('/api/workbench/settings', { invalidate: [['workbench']], success: t('已保存') })
  return (
    <>
      <Card className="flex flex-col gap-3 p-[18px]">
        <div className="flex flex-wrap items-center gap-2.5">
          <h2 className="m-0 text-base font-semibold">{t('Agent 管理')}</h2>
          <span className="text-[13px] text-ink-2">{t('CLI 和 ACP 两种接入；每个交易员可以设一个主 Agent 和一个备用')}</span>
          <label className="ml-auto flex items-center gap-2 text-[13px] text-ink-2">{t('同时最多')}<Input aria-label={t('同时运行的 Agent 进程上限')} type="number" min={1} max={16} value={cap} onChange={(event) => setCap(event.target.value)} className="w-16 text-center font-mono" />{t('个 Agent 进程')}<Button size="sm" onClick={() => save.mutate({ maxConcurrentAgents: Number(cap) })} loading={save.isPending}>{t('保存')}</Button></label>
        </div>
        {env.isLoading ? <Spinner /> : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] border-collapse text-[13px]">
              <thead><tr className="text-left text-xs text-ink-3"><th className="py-1.5 font-medium">Agent</th><th className="font-medium">{t('接入方式')}</th><th className="font-medium">{t('命令')}</th><th className="font-medium">{t('版本')}</th><th className="font-medium">{t('交易员')}</th><th className="font-medium">{t('状态')}</th></tr></thead>
              <tbody>{env.data?.agents.map((agent) => (
                <tr key={agent.id} className={cn('border-t border-line', !agent.installed && 'text-ink-3')}>
                  <td className="py-2.5"><span className="flex items-center gap-2 font-semibold"><AgentMark kind={agent.kind === 'acp' ? agent.id : agent.id} />{agent.name}</span></td>
                  <td><span className={cn('rounded-md px-1.5 py-px font-mono text-xs', agent.kind === 'acp' ? 'bg-accent-soft text-accent-ink' : 'bg-sunken')}>{agent.kind}</span></td>
                  <td className="max-w-[260px] truncate font-mono text-xs" title={agent.command ?? ''}>{agent.command ?? t('没找到')}</td>
                  <td className="font-mono text-xs">{agent.version ?? '—'}</td>
                  <td className="font-mono">{agent.traders}</td>
                  <td className="text-xs">{agent.detail}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </Card>
      <Card className="flex flex-col gap-2 p-[18px] text-[13px] text-ink-2">
        <CardTitle>{t('怎么接一个新的 Agent')}</CardTitle>
        <div><strong className="text-ink">{t('命令行（CLI）')}</strong>{t('：Claude Code、Codex、Kimi Code、WorkBuddy 内置支持，装好并在命令行登录一次就能用（例如 {a}、{b}）。', { a: 'claude auth login', b: 'codex login' })}</div>
        <div><strong className="text-ink">ACP</strong>{t('：支持 Agent Client Protocol 的 Agent 都能接，工作台会通过 session/new 给它挂上本插件的 MCP 工具。内置预设：')}{env.data?.acpPresets.map((preset) => <code key={preset.id} className="mx-1 font-mono">{preset.command} {preset.args.join(' ')}</code>)}{t('。装好后在新建交易员或交易员设置里就能选。')}</div>
        <div><strong className="text-ink">{t('自己的客户端')}</strong>{t('：Cursor、Cline 等任何 MCP 客户端，用 {cmd} 打印配置；它们在自己的会话里交易，工作台照样统计。', { cmd: 'npm run connect -- cursor' })}</div>
      </Card>
    </>
  )
}

function QuotaSection() {
  const pools = usePools()
  const { accounts } = useAccounts()
  return (
    <Card className="flex flex-col gap-3 p-[18px]">
      <CardTitle extra={<span className="text-[13px] text-ink-2">{t('同一个 CLI 登录是一份额度，用它的交易员一起算')}</span>}>{t('额度池')}</CardTitle>
      {pools.isLoading ? <Spinner /> : (pools.data?.pools ?? []).map((pool) => <PoolRow key={pool.key} pool={pool} names={pool.traders.map((id) => accounts.find((account) => account.id === id)?.name ?? id)} />)}
      <div className="border-t border-line pt-2.5 text-xs text-ink-2">{t('额度用尽时：设了备用 Agent 的交易员由备用代班，没设的跳过复查，代码策略照常执行；到了恢复时间自动换回。配置错了（模型不存在、参数冲突、没登录）不会一直重试：交易员直接暂停并在工作台标出来。')}</div>
    </Card>
  )
}

function PromptsSection() {
  const workbench = useWorkbench()
  const [scope, setScope] = useState<'global' | Market>('global')
  const [text, setText] = useState('')
  useEffect(() => setText(workbench.data?.prompts?.[scope] ?? ''), [scope, workbench.data])
  const save = useAction<{ scope: string; prompt: string }>('/api/workbench/prompts', { invalidate: [['workbench'], ['trader-settings']], success: t('前置提示词已保存，下一次复查起生效') })
  const lock = useAction<{ locks: Record<string, boolean> }>('/api/workbench/settings', { invalidate: [['workbench']] })
  const key = `prompt.${scope}`
  return (
    <Card className="flex flex-col gap-3 p-[18px]">
      <div className="flex flex-wrap items-center gap-2.5">
        <h2 className="m-0 text-base font-semibold">{t('前置提示词')}</h2>
        <Segmented label={t('层级')} value={scope} onChange={setScope} options={[['global', t('全局')], ['A', MARKET_NAME.A], ['HK', MARKET_NAME.HK], ['US', MARKET_NAME.US]]} />
        <LockButton label={t('这一层提示词')} locked={Boolean(workbench.data?.locks?.[key])} onChange={(value) => lock.mutate({ locks: { [key]: value } })} />
      </div>
      <Field label={scope === 'global' ? t('对所有交易员生效，排在系统规则后面') : t('对所有{market}交易员生效，排在全局后面', { market: MARKET_NAME[scope] })}><Textarea rows={8} value={text} onChange={(event) => setText(event.target.value)} maxLength={4000} /></Field>
      <div className="flex items-center gap-2"><span className="text-xs text-ink-3">{t('每个交易员自己的那一层在交易员页 → 设置里改。')}</span><Button variant="primary" size="sm" className="ml-auto" loading={save.isPending} onClick={() => save.mutate({ scope, prompt: text })}>{t('保存')}</Button></div>
    </Card>
  )
}

function FeesSection() {
  const workbench = useWorkbench()
  const lock = useAction<{ locks: Record<string, boolean> }>('/api/workbench/settings', { invalidate: [['workbench']] })
  if (workbench.isLoading || !workbench.data) return <Spinner />
  return (
    <>
      {(['A', 'HK', 'US'] as Market[]).map((market) => (
        <Card key={market} className="flex flex-col gap-3 p-[18px]">
          <CardTitle extra={<span className="ml-auto flex items-center gap-2 text-xs text-ink-3">{t('锁定后 Agent 不能改')}<LockButton label={t('{market}费率', { market: MARKET_NAME[market] })} locked={Boolean(workbench.data.locks?.[`fees.${market}`])} onChange={(value) => lock.mutate({ locks: { [`fees.${market}`]: value } })} /></span>}>{t('费率')} · {MARKET_NAME[market]}</CardTitle>
          <FeesForm market={market} fees={workbench.data.fees[market]} locked={Boolean(workbench.data.locks?.[`fees.${market}`])} />
        </Card>
      ))}
      <ChangeLog entries={workbench.data.changeLog.filter((entry) => entry.key.startsWith('fees.'))} />
    </>
  )
}

function ChangeLog({ entries }: { entries: Array<{ id: string; at: string; key: string; from: unknown; to: unknown; by: { kind: string; client?: string; via?: string }; reason: string | null }> }) {
  if (!entries.length) return null
  return (
    <Card className="flex flex-col gap-2 p-[18px]">
      <CardTitle>{t('修改记录')}</CardTitle>
      {entries.slice(-12).reverse().map((entry) => <div key={entry.id} className="flex flex-wrap gap-2 text-[13px]"><span className="font-mono text-xs text-ink-3">{dateTime(entry.at)}</span><span className="font-semibold">{changeLabel(entry.key)}</span><span className="text-ink-2">{valueLabel(entry.key, entry.from)} → {valueLabel(entry.key, entry.to)}</span><span className="font-mono text-xs text-ink-3">{changedByLabel(entry.by)}</span></div>)}
    </Card>
  )
}

function PushSection() {
  const client = useQueryClient()
  const preferences = useQuery({ queryKey: ['preferences'], queryFn: ({ signal }) => get<{ preferences?: { digestWebhook: { url: string; format: string; enabled: boolean } | null } }>('/api/preferences', signal) })
  const current = (preferences.data?.preferences ?? (preferences.data as { digestWebhook?: { url: string; format: string; enabled: boolean } | null } | undefined))?.digestWebhook ?? null
  const [url, setUrl] = useState('')
  const [format, setFormat] = useState('generic')
  const [enabled, setEnabled] = useState(true)
  const [saving, setSaving] = useState(false)
  useEffect(() => { setUrl(current?.url ?? ''); setFormat(current?.format ?? 'generic'); setEnabled(current?.enabled !== false) }, [current?.url, current?.format, current?.enabled])
  const save = async () => {
    setSaving(true)
    try { await post('/api/preferences', { digestWebhook: url.trim() ? { url: url.trim(), format, enabled } : null }); client.invalidateQueries({ queryKey: ['preferences'] }); client.invalidateQueries({ queryKey: ['digests'] }); toast.success(url.trim() ? t('推送设置已保存') : t('已关闭推送')) }
    catch (error) { toast.error((error as Error).message) } finally { setSaving(false) }
  }
  return (
    <Card className="flex flex-col gap-3 p-[18px]">
      <CardTitle>{t('收盘日报推送')}</CardTitle>
      <p className="m-0 text-[13px] text-ink-2">{t('每个市场收盘后把日报 POST 到这个地址：企业微信 / 飞书机器人，或转发到邮件的通用 JSON 网关。留空就关闭。')}</p>
      {preferences.isLoading ? <Spinner /> : (
        <div className="grid grid-cols-[1fr_180px] gap-3 max-sm:grid-cols-1">
          <Field label={t('Webhook 地址')}><Input type="url" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=…" /></Field>
          <Field label={t('格式')}><Select value={format} onChange={(event) => setFormat(event.target.value)}><option value="generic">{t('通用 JSON')}</option><option value="wecom">{t('企业微信')}</option><option value="feishu">{t('飞书')}</option></Select></Field>
          <label className="flex items-center gap-2 text-[13px]"><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} className="size-4 accent-[var(--c-accent)]" />{t('启用推送')}</label>
          <Button variant="primary" className="justify-self-end" loading={saving} onClick={save}>{t('保存')}</Button>
        </div>
      )}
      <div className="text-xs text-ink-3">{t('同一个地址也会收到即时提醒：等你确认的订单、额度用尽、交易员暂停和回撤熔断。')}</div>
    </Card>
  )
}

function GeneralSection() {
  const workbench = useWorkbench()
  const [theme, setTheme] = useState<Theme>(prefs.theme())
  const [colors, setColors] = useState<Colors>(prefs.colors())
  const [review, setReview] = useState('')
  useEffect(() => setReview(String(workbench.data?.defaultReviewMinutes ?? 10)), [workbench.data])
  const save = useAction<{ defaultReviewMinutes: number }>('/api/workbench/settings', { invalidate: [['workbench']], success: t('已保存') })
  const health = useQuery({ queryKey: ['health'], queryFn: ({ signal }) => get<{ version: string }>('/health', signal) })
  return (
    <Card className="flex flex-col gap-4 p-[18px]">
      <CardTitle>{t('通用')}</CardTitle>
      <div className="flex flex-wrap items-center gap-3"><span className="w-28 text-[13px]">{t('外观')}</span><Segmented label={t('外观')} value={theme} onChange={(value) => { setTheme(value); prefs.setTheme(value) }} options={[['system', t('跟随系统')], ['light', t('浅色')], ['dark', t('深色')]]} /></div>
      <div className="flex flex-wrap items-center gap-3"><span className="w-28 text-[13px]">{t('涨跌颜色')}</span><Segmented label={t('涨跌颜色')} value={colors} onChange={(value) => { setColors(value); prefs.setColors(value) }} options={[['red-up', t('红涨绿跌')], ['green-up', t('绿涨红跌')]]} />
      </div>
      <div className="flex flex-wrap items-center gap-3"><span className="w-28 text-[13px]">{t('语言')}</span><Segmented label={t('语言')} value={language()} onChange={(value) => setLanguage(value)} options={[['zh-CN', '中文'], ['en', 'English']]} /><span className="text-xs text-ink-3">{t('切换后页面会重新载入')}</span></div>
      <div className="flex flex-wrap items-center gap-3"><span className="w-28 text-[13px]">{t('默认复查间隔')}</span><Input type="number" min={5} max={240} value={review} onChange={(event) => setReview(event.target.value)} className="w-20 font-mono" /><span className="text-[13px] text-ink-3">{t('分钟，新建交易员时的默认值')}</span><Button size="sm" onClick={() => save.mutate({ defaultReviewMinutes: Number(review) })} loading={save.isPending}>{t('保存')}</Button></div>
      <div className="border-t border-line pt-3 text-xs text-ink-3">{t('版本 {v}', { v: health.data?.version ?? '—' })}</div>
    </Card>
  )
}
