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

const SECTIONS: Array<[string, string]> = [['env', '环境检查'], ['agents', 'Agent 管理'], ['quota', '额度池'], ['prompts', '前置提示词'], ['fees', '费率'], ['push', '推送'], ['broker', '券商连接'], ['general', '通用']]

export function SettingsPage() {
  const search = useSearch({ from: '/settings' })
  const navigate = useNavigate()
  const section = search.section ?? 'env'
  return (
    <Page>
      <PageHeader title="设置" description="只在本机运行。模型和供应商在 HRouter Desktop 里切换，这里管 Agent、额度、提示词、费率、推送和券商连接。" />
      <div className="flex flex-wrap items-start gap-5">
        <nav aria-label="设置分组" className="flex min-w-0 flex-[0_1_200px] flex-col gap-0.5">
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
        <h2 className="m-0 text-base font-semibold">环境检查</h2>
        {summary && <><Pill tone="ok">{summary.ok} 项就绪</Pill>{summary.action > 0 && <Pill tone="warn">{summary.action} 项待处理</Pill>}{summary.temporary > 0 && <Pill>{summary.temporary} 项暂时不可用</Pill>}{summary.missing > 0 && <Pill>{summary.missing} 项没装</Pill>}</>}
        <Button size="sm" className="ml-auto" loading={checking} onClick={recheck}><RefreshCw className="size-4" />重新检查</Button>
      </div>
      {env.isLoading ? <Spinner /> : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(320px,1fr))] gap-x-6">
          {env.data?.items.map((item) => (
            <div key={item.id} className={cn('flex items-center gap-2.5 border-t border-line py-2.5', item.status === 'action' && '-mx-2 rounded-lg bg-warn-soft px-2')}>
              <Dot tone={TONE[item.status]} label={item.status} />
              <span className="flex-1 font-semibold">{item.name}</span>
              <span className="truncate text-right font-mono text-xs text-ink-3" title={item.detail}>{item.detail}</span>
            </div>
          ))}
        </div>
      )}
      <div className="text-xs text-ink-3">登录状态不直接探测（会花额度），看最近一次运行的结果判断。检查时间 {dateTime(env.data?.at)}。</div>
    </Card>
  )
}

function AgentsSection() {
  const env = useEnv()
  const workbench = useWorkbench()
  const [cap, setCap] = useState('')
  useEffect(() => setCap(String(workbench.data?.maxConcurrentAgents ?? 4)), [workbench.data])
  const save = useAction<{ maxConcurrentAgents: number }>('/api/workbench/settings', { invalidate: [['workbench']], success: '已保存' })
  return (
    <>
      <Card className="flex flex-col gap-3 p-[18px]">
        <div className="flex flex-wrap items-center gap-2.5">
          <h2 className="m-0 text-base font-semibold">Agent 管理</h2>
          <span className="text-[13px] text-ink-2">CLI 和 ACP 两种接入；每个交易员可以设一个主 Agent 和一个备用</span>
          <label className="ml-auto flex items-center gap-2 text-[13px] text-ink-2">同时最多<Input aria-label="同时运行的 Agent 进程上限" type="number" min={1} max={16} value={cap} onChange={(event) => setCap(event.target.value)} className="w-16 text-center font-mono" />个 Agent 进程<Button size="sm" onClick={() => save.mutate({ maxConcurrentAgents: Number(cap) })} loading={save.isPending}>保存</Button></label>
        </div>
        {env.isLoading ? <Spinner /> : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] border-collapse text-[13px]">
              <thead><tr className="text-left text-xs text-ink-3"><th className="py-1.5 font-medium">Agent</th><th className="font-medium">接入方式</th><th className="font-medium">命令</th><th className="font-medium">版本</th><th className="font-medium">交易员</th><th className="font-medium">状态</th></tr></thead>
              <tbody>{env.data?.agents.map((agent) => (
                <tr key={agent.id} className={cn('border-t border-line', !agent.installed && 'text-ink-3')}>
                  <td className="py-2.5"><span className="flex items-center gap-2 font-semibold"><AgentMark kind={agent.kind === 'acp' ? agent.id : agent.id} />{agent.name}</span></td>
                  <td><span className={cn('rounded-md px-1.5 py-px font-mono text-xs', agent.kind === 'acp' ? 'bg-accent-soft text-accent-ink' : 'bg-sunken')}>{agent.kind}</span></td>
                  <td className="max-w-[260px] truncate font-mono text-xs" title={agent.command ?? ''}>{agent.command ?? '没找到'}</td>
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
        <CardTitle>怎么接一个新的 Agent</CardTitle>
        <div><strong className="text-ink">命令行（CLI）</strong>：Claude Code、Codex、Kimi Code、WorkBuddy 内置支持，装好并在命令行登录一次就能用（例如 <code className="font-mono">claude auth login</code>、<code className="font-mono">codex login</code>）。</div>
        <div><strong className="text-ink">ACP</strong>：支持 Agent Client Protocol 的 Agent 都能接，工作台会通过 session/new 给它挂上本插件的 MCP 工具。内置预设：{env.data?.acpPresets.map((preset) => <code key={preset.id} className="mx-1 font-mono">{preset.command} {preset.args.join(' ')}</code>)}。装好后在新建交易员或交易员设置里就能选。</div>
        <div><strong className="text-ink">自己的客户端</strong>：Cursor、Cline 等任何 MCP 客户端，用 <code className="font-mono">npm run connect -- cursor</code> 打印配置；它们在自己的会话里交易，工作台照样统计。</div>
      </Card>
    </>
  )
}

function QuotaSection() {
  const pools = usePools()
  const { accounts } = useAccounts()
  return (
    <Card className="flex flex-col gap-3 p-[18px]">
      <CardTitle extra={<span className="text-[13px] text-ink-2">同一个 CLI 登录是一份额度，用它的交易员一起算</span>}>额度池</CardTitle>
      {pools.isLoading ? <Spinner /> : (pools.data?.pools ?? []).map((pool) => <PoolRow key={pool.key} pool={pool} names={pool.traders.map((id) => accounts.find((account) => account.id === id)?.name ?? id)} />)}
      <div className="border-t border-line pt-2.5 text-xs text-ink-2">额度用尽时：设了备用 Agent 的交易员由备用代班，没设的跳过复查，代码策略照常执行；到了恢复时间自动换回。配置错了（模型不存在、参数冲突、没登录）不会一直重试：交易员直接暂停并在工作台标出来。</div>
    </Card>
  )
}

function PromptsSection() {
  const workbench = useWorkbench()
  const [scope, setScope] = useState<'global' | Market>('global')
  const [text, setText] = useState('')
  useEffect(() => setText(workbench.data?.prompts?.[scope] ?? ''), [scope, workbench.data])
  const save = useAction<{ scope: string; prompt: string }>('/api/workbench/prompts', { invalidate: [['workbench'], ['trader-settings']], success: '前置提示词已保存，下一次复查起生效' })
  const lock = useAction<{ locks: Record<string, boolean> }>('/api/workbench/settings', { invalidate: [['workbench']] })
  const key = `prompt.${scope}`
  return (
    <Card className="flex flex-col gap-3 p-[18px]">
      <div className="flex flex-wrap items-center gap-2.5">
        <h2 className="m-0 text-base font-semibold">前置提示词</h2>
        <Segmented label="层级" value={scope} onChange={setScope} options={[['global', '全局'], ['A', 'A 股'], ['HK', '港股'], ['US', '美股']]} />
        <LockButton label="这一层提示词" locked={Boolean(workbench.data?.locks?.[key])} onChange={(value) => lock.mutate({ locks: { [key]: value } })} />
      </div>
      <Field label={scope === 'global' ? '对所有交易员生效，排在系统规则后面' : `对所有${MARKET_NAME[scope]}交易员生效，排在全局后面`}><Textarea rows={8} value={text} onChange={(event) => setText(event.target.value)} maxLength={4000} /></Field>
      <div className="flex items-center gap-2"><span className="text-xs text-ink-3">每个交易员自己的那一层在交易员页 → 设置里改。</span><Button variant="primary" size="sm" className="ml-auto" loading={save.isPending} onClick={() => save.mutate({ scope, prompt: text })}>保存</Button></div>
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
          <CardTitle extra={<span className="ml-auto flex items-center gap-2 text-xs text-ink-3">锁定后 Agent 不能改<LockButton label={`${MARKET_NAME[market]}费率`} locked={Boolean(workbench.data.locks?.[`fees.${market}`])} onChange={(value) => lock.mutate({ locks: { [`fees.${market}`]: value } })} /></span>}>费率 · {MARKET_NAME[market]}</CardTitle>
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
      <CardTitle>修改记录</CardTitle>
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
    try { await post('/api/preferences', { digestWebhook: url.trim() ? { url: url.trim(), format, enabled } : null }); client.invalidateQueries({ queryKey: ['preferences'] }); client.invalidateQueries({ queryKey: ['digests'] }); toast.success(url.trim() ? '推送设置已保存' : '已关闭推送') }
    catch (error) { toast.error((error as Error).message) } finally { setSaving(false) }
  }
  return (
    <Card className="flex flex-col gap-3 p-[18px]">
      <CardTitle>收盘日报推送</CardTitle>
      <p className="m-0 text-[13px] text-ink-2">每个市场收盘后把日报 POST 到这个地址：企业微信 / 飞书机器人，或转发到邮件的通用 JSON 网关。留空就关闭。</p>
      {preferences.isLoading ? <Spinner /> : (
        <div className="grid grid-cols-[1fr_180px] gap-3 max-sm:grid-cols-1">
          <Field label="Webhook 地址"><Input type="url" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=…" /></Field>
          <Field label="格式"><Select value={format} onChange={(event) => setFormat(event.target.value)}><option value="generic">通用 JSON</option><option value="wecom">企业微信</option><option value="feishu">飞书</option></Select></Field>
          <label className="flex items-center gap-2 text-[13px]"><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} className="size-4 accent-[var(--c-accent)]" />启用推送</label>
          <Button variant="primary" className="justify-self-end" loading={saving} onClick={save}>保存</Button>
        </div>
      )}
      <div className="text-xs text-ink-3">失败告警、额度用尽、熔断等即时推送放在第 2 期。</div>
    </Card>
  )
}

function GeneralSection() {
  const workbench = useWorkbench()
  const [theme, setTheme] = useState<Theme>(prefs.theme())
  const [colors, setColors] = useState<Colors>(prefs.colors())
  const [review, setReview] = useState('')
  useEffect(() => setReview(String(workbench.data?.defaultReviewMinutes ?? 10)), [workbench.data])
  const save = useAction<{ defaultReviewMinutes: number }>('/api/workbench/settings', { invalidate: [['workbench']], success: '已保存' })
  const health = useQuery({ queryKey: ['health'], queryFn: ({ signal }) => get<{ version: string }>('/health', signal) })
  return (
    <Card className="flex flex-col gap-4 p-[18px]">
      <CardTitle>通用</CardTitle>
      <div className="flex flex-wrap items-center gap-3"><span className="w-28 text-[13px]">外观</span><Segmented label="外观" value={theme} onChange={(value) => { setTheme(value); prefs.setTheme(value) }} options={[['system', '跟随系统'], ['light', '浅色'], ['dark', '深色']]} /></div>
      <div className="flex flex-wrap items-center gap-3"><span className="w-28 text-[13px]">涨跌颜色</span><Segmented label="涨跌颜色" value={colors} onChange={(value) => { setColors(value); prefs.setColors(value) }} options={[['red-up', '红涨绿跌'], ['green-up', '绿涨红跌']]} /></div>
      <div className="flex flex-wrap items-center gap-3"><span className="w-28 text-[13px]">默认复查间隔</span><Input type="number" min={5} max={240} value={review} onChange={(event) => setReview(event.target.value)} className="w-20 font-mono" /><span className="text-[13px] text-ink-3">分钟，新建交易员时的默认值</span><Button size="sm" onClick={() => save.mutate({ defaultReviewMinutes: Number(review) })} loading={save.isPending}>保存</Button></div>
      <div className="border-t border-line pt-3 text-xs text-ink-3">版本 {health.data?.version ?? '—'} · 界面目前只有中文。</div>
    </Card>
  )
}
