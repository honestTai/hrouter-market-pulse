import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { get, post } from '@/lib/api'
import { dateTime, money, num } from '@/lib/format'
import { t } from '@/lib/i18n'
import { Button, Card, CardTitle, Dialog, Empty, ErrorNote, Field, Input, Pill, Segmented, Select, Spinner } from './ui'

/* eslint-disable @typescript-eslint/no-explicit-any */
// Interactive Brokers through the owner's TWS / IB Gateway. PAPER: agents trade within limits.
// LIVE: agents only propose; every order waits here for the owner's confirmation.
type Env = 'PAPER' | 'LIVE'
const LIVE_PHRASE = '我确认使用真实资金'
const STATES: Record<string, string> = { blocked: t('门槛拦截'), 'awaiting-confirmation': t('等你确认'), rejected: t('已拒绝'), expired: t('已过期'), dispatching: t('发送中 / 待核对'), unknown: t('结果未知 · 禁止重试'), acknowledged: t('IB 已接收') }
const PORTS: Array<[string, string]> = [['7497', t('TWS 模拟 7497')], ['7496', t('TWS 实盘 7496')], ['4002', t('IB Gateway 模拟 4002')], ['4001', t('IB Gateway 实盘 4001')]]
const mask = (id: string | undefined) => (id ? `${id.slice(0, 2)}••••${id.slice(-3)}` : '—')

export const useIbkrStatus = () => useQuery({ queryKey: ['ibkr-status'], queryFn: ({ signal }) => get<any>('/api/ibkr/status', signal), refetchInterval: 10_000 })

export function IbkrPanel() {
  const client = useQueryClient()
  const status = useIbkrStatus()
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [env, setEnv] = useState<Env | null>(null)
  const [accounts, setAccounts] = useState<string[]>([])
  const [accountId, setAccountId] = useState('')
  const [editing, setEditing] = useState(false)
  const [tab, setTab] = useState<'orders' | 'positions' | 'journal'>('orders')
  const refreshStatus = () => client.invalidateQueries({ queryKey: ['ibkr-status'] })
  const act = async (name: string, task: () => Promise<void>) => { setBusy(name); setError(''); try { await task() } catch (caught) { setError((caught as Error).message) } finally { setBusy('') } }
  if (status.isLoading) return <Spinner />
  const data = status.data ?? {}
  const policy = data.policy ?? {}
  const environment: Env = env ?? policy.environment ?? 'PAPER'
  const account = accountId || (policy.environment === environment ? policy.accountId ?? '' : '')
  const snapshot = data.snapshot?.accountId === account ? data.snapshot : null
  const intents = (data.intents ?? []).filter((entry: any) => !account || entry.accountId === account)
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap gap-2">
        <Pill tone={data.config?.connected ? 'ok' : 'warn'}>{data.config?.connected ? t('已设置 TWS 连接 · 端口 {port}', { port: data.config.port }) : t('还没设置 TWS 连接')}</Pill>
        <Pill tone={policy.enabled ? (policy.environment === 'LIVE' ? 'bad' : 'ok') : 'neutral'}>{policy.enabled ? (policy.environment === 'LIVE' ? t('实盘 · 每笔要你确认') : t('模拟账户 · Agent 可在限额内下单')) : t('Agent 下单已暂停')}</Pill>
      </div>
      <ErrorNote error={error || status.error} />
      <PendingConfirmations />
      <ConnectionCard config={data.config} onSaved={refreshStatus} />
      <Card className="flex flex-wrap items-end gap-3 p-4">
        <div className="flex flex-col gap-1.5"><span className="text-xs font-medium text-ink-2">{t('账户类型')}</span><Segmented label={t('账户类型')} value={environment} onChange={(next: Env) => { setEnv(next); setAccounts([]); setAccountId('') }} options={[['PAPER', t('模拟 DU…')], ['LIVE', t('实盘 U…')]]} /></div>
        <Field label={t('IB 账户')} className="w-48"><Select value={account} disabled={!accounts.length} onChange={(event) => setAccountId(event.target.value)}><option value="">{account ? mask(account) : t('连接后选择')}</option>{accounts.map((id) => <option key={id} value={id}>{mask(id)}</option>)}</Select></Field>
        <Button disabled={!data.config?.connected || Boolean(busy)} loading={busy === 'connect'} onClick={() => act('connect', async () => { const result = await post<any>('/api/ibkr/connect', { environment }); const ids = result.accounts.map((entry: any) => entry.accountId); setAccounts(ids); setAccountId(ids.includes(account) ? account : ids[0] ?? ''); if (!ids.length) throw new Error(environment === 'PAPER' ? t('这个 TWS 登录里没有模拟账户。用模拟账户登录 TWS 再试。') : t('这个 TWS 登录里没有实盘账户。')) })}>{t('连接 TWS')}</Button>
        <Button disabled={!policy.accountId || Boolean(busy)} loading={busy === 'refresh'} onClick={() => act('refresh', async () => { await post('/api/ibkr/refresh', {}); refreshStatus() })}>{t('核对账户')}</Button>
        <Button variant="primary" disabled={!account || Boolean(busy)} onClick={() => setEditing(true)}>{t('白名单与限额')}</Button>
        {policy.enabled && <Button variant="danger" disabled={Boolean(busy)} loading={busy === 'halt'} onClick={() => act('halt', async () => { const result = await post<any>('/api/ibkr/halt', {}); refreshStatus(); toast.success(t('已暂停，并请求撤销 {n} 笔未成交委托', { n: result.cancellations.length })) })}>{t('全部停止')}</Button>}
      </Card>
      <div className="grid grid-cols-4 gap-3 max-md:grid-cols-2">
        {[[t('净资产'), snapshot?.funds?.netLiquidation], [t('现金'), snapshot?.funds?.cash], [t('持仓市值'), snapshot?.funds?.marketValue], [t('单日委托上限'), policy.maxDailyOrderValue]].map(([label, value]) => (
          <Card key={label as string} className="p-4"><div className="text-xs text-ink-3">{label}</div><div className="font-mono text-lg">{num(value as number)} <small className="text-ink-3">USD</small></div><div className="text-xs text-ink-3">{snapshot ? t('采样 {time}', { time: dateTime(snapshot.observedAt) }) : t('还没核对账户')}</div></Card>
        ))}
      </div>
      <Card className="flex flex-col gap-3 p-4">
        <Segmented label={t('记录')} value={tab} onChange={setTab} options={[['orders', t('IB 委托')], ['positions', t('持仓')], ['journal', t('下单记录')]]} />
        {tab === 'orders' && (snapshot?.orders?.length ? (
          <div className="overflow-x-auto"><table className="w-full min-w-[560px] border-collapse text-[13px] [&_td+td]:pl-3 [&_th+th]:pl-3"><thead><tr className="text-left text-xs text-ink-3"><th className="py-1.5 font-medium">{t('代码 / 委托号')}</th><th className="font-medium">{t('方向')}</th><th className="font-medium">{t('委托 / 成交')}</th><th className="font-medium">{t('限价 / 均价')}</th><th className="font-medium">{t('状态')}</th><th /></tr></thead>
            <tbody>{snapshot.orders.map((order: any) => <tr key={order.orderId ?? order.clientOrderId} className="border-t border-line"><td className="py-1.5"><div className="font-semibold">{order.symbol}</div><div className="font-mono text-[11px] text-ink-3">{order.orderId}</div></td><td>{order.side}</td><td className="font-mono">{num(order.quantity, 0)} / {num(order.filledQuantity, 0)}</td><td className="font-mono">{num(order.price)} / {num(order.filledAveragePrice)}</td><td><Pill>{order.status}</Pill></td>
              <td className="text-right">{['PreSubmitted', 'Submitted'].includes(order.status) && order.orderId && <Button size="sm" variant="danger" disabled={Boolean(busy)} onClick={() => act('cancel', async () => { const result = await post<any>('/api/ibkr/cancel', { orderId: order.orderId, idempotencyKey: `cancel_${crypto.randomUUID()}` }); refreshStatus(); if (result.status !== 'acknowledged') throw new Error(result.error) })}>{t('撤单')}</Button>}</td></tr>)}</tbody></table></div>
        ) : <Empty title={t('没有已读取的 IB 委托')}>{t('点「核对账户」从 TWS 读取。')}</Empty>)}
        {tab === 'positions' && (snapshot?.positions?.length ? (
          <div className="overflow-x-auto"><table className="w-full min-w-[480px] border-collapse text-[13px] [&_td+td]:pl-3 [&_th+th]:pl-3"><thead><tr className="text-left text-xs text-ink-3"><th className="py-1.5 font-medium">{t('代码')}</th><th className="font-medium">{t('数量')}</th><th className="font-medium">{t('成本')}</th><th className="font-medium">{t('市值')}</th><th className="font-medium">{t('未实现盈亏')}</th></tr></thead>
            <tbody>{snapshot.positions.map((position: any, index: number) => <tr key={`${position.symbol}:${index}`} className="border-t border-line font-mono"><td className="py-1.5 font-sans">{position.symbol} <span className="text-ink-3">{position.secType}</span></td><td>{num(position.quantity, 0)}</td><td>{num(position.averageCost)}</td><td>{num(position.marketValue)}</td><td>{num(position.unrealizedPnl)}</td></tr>)}</tbody></table></div>
        ) : <Empty title={t('没有已读取的持仓')} />)}
        {tab === 'journal' && (intents.length ? intents.map((entry: any) => (
          <div key={entry.id} className="border-t border-line pt-2 text-[13px] first:border-t-0">
            <div className="flex flex-wrap items-center gap-2"><strong>{entry.symbol ?? entry.brokerOrderId} · {entry.side ?? t('撤单')} {entry.quantity ? `${entry.quantity} @ ${entry.limitPrice}` : ''}</strong><Pill tone={entry.environment === 'LIVE' ? 'bad' : 'neutral'}>{entry.environment}</Pill><Pill tone={entry.status === 'unknown' ? 'bad' : ['blocked', 'expired', 'rejected'].includes(entry.status) ? 'warn' : 'neutral'}>{STATES[entry.status] ?? entry.status}</Pill><span className="font-mono text-xs text-ink-3">{dateTime(entry.createdAt)}</span></div>
            {entry.rationale && <p className="m-0 mt-1 text-ink-2">{entry.rationale}</p>}{entry.error && <p className="m-0 text-xs text-bad">{entry.error}</p>}
          </div>
        )) : <Empty title={t('还没有下单记录')}>{t('Agent 的每次下单、拦截和你的确认都会记在这里。')}</Empty>)}
      </Card>
      {editing && <PolicyDialog policy={policy} environment={environment} accountId={account} onClose={() => setEditing(false)} onSaved={refreshStatus} />}
    </div>
  )
}

function ConnectionCard({ config, onSaved }: { config: any; onSaved: () => void }) {
  const [form, setForm] = useState({ python: config?.python ?? '', port: String(config?.port ?? 7497), clientId: String(config?.clientId ?? 71) })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const save = async () => { setSaving(true); setError(''); try { await post('/api/ibkr/config', { python: form.python || undefined, port: Number(form.port), clientId: Number(form.clientId) }); onSaved(); toast.success(t('已保存 TWS 连接')) } catch (caught) { setError((caught as Error).message) } finally { setSaving(false) } }
  return (
    <Card className="flex flex-col gap-3 p-4 text-[13px]">
      <CardTitle>{t('TWS / IB Gateway 连接')}</CardTitle>
      {!config?.connected && (
        <ol className="m-0 flex list-decimal flex-col gap-1 pl-5 text-ink-2">
          <li>{t('安装并登录 TWS 或 IB Gateway（先用模拟账户登录）。')}</li>
          <li>{t('TWS 里打开 设置 → API → Settings：勾选 Enable ActiveX and Socket Clients，取消 Read-Only API，Trusted IPs 加 127.0.0.1。')}</li>
          <li>{t('在项目目录运行 {cmd}，它会打印 Python 路径；留空就用默认路径。', { cmd: 'npm run setup:ibkr' })}</li>
        </ol>
      )}
      <div className="grid grid-cols-[2fr_1fr_1fr] gap-3 max-md:grid-cols-1">
        <Field label={t('Python（ibkr venv）')}><Input value={form.python} placeholder="~/.local/share/hrouter-market-pulse/ibkr-venv/bin/python" onChange={(event) => setForm({ ...form, python: event.target.value })} className="font-mono" /></Field>
        <Field label={t('端口')}><Select value={PORTS.some(([port]) => port === form.port) ? form.port : ''} onChange={(event) => setForm({ ...form, port: event.target.value || form.port })}>{PORTS.map(([port, label]) => <option key={port} value={port}>{label}</option>)}{!PORTS.some(([port]) => port === form.port) && <option value="">{form.port}</option>}</Select></Field>
        <Field label={t('API 客户端 ID')}><Input type="number" value={form.clientId} onChange={(event) => setForm({ ...form, clientId: event.target.value })} /></Field>
      </div>
      <ErrorNote error={error} />
      <div><Button onClick={save} loading={saving}>{t('保存连接')}</Button></div>
    </Card>
  )
}

function PolicyDialog({ policy, environment, accountId, onClose, onSaved }: { policy: any; environment: Env; accountId: string; onClose: () => void; onSaved: () => void }) {
  const current = policy?.environment === environment && policy?.accountId === accountId ? policy : {}
  const [form, setForm] = useState<Record<string, string>>({
    allowedSymbols: current.allowedSymbols?.join(', ') ?? '', maxOrderValue: String(current.maxOrderValue ?? ''), maxDailyOrderValue: String(current.maxDailyOrderValue ?? ''), maxPositionValue: String(current.maxPositionValue ?? ''),
    maxOrdersPerDay: String(current.maxOrdersPerDay ?? ''), maxQuoteAgeSeconds: String(current.maxQuoteAgeSeconds ?? 60), maxLimitDeviationPct: String(current.maxLimitDeviationPct ?? 1), confirmMinutes: String(current.confirmMinutes ?? 10), liveAcknowledgement: '',
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const set = (key: string) => (event: { target: { value: string } }) => setForm({ ...form, [key]: event.target.value })
  const save = async () => {
    setError(''); setSaving(true)
    try {
      const input: Record<string, unknown> = { enabled: true, environment, accountId, allowedSymbols: form.allowedSymbols.split(/[\s,，]+/).filter(Boolean), liveAcknowledgement: form.liveAcknowledgement }
      for (const name of ['maxOrderValue', 'maxDailyOrderValue', 'maxPositionValue', 'maxOrdersPerDay', 'maxQuoteAgeSeconds', 'maxLimitDeviationPct', 'confirmMinutes']) input[name] = Number(form[name])
      await post('/api/ibkr/policy', input)
      onSaved(); toast.success(t('已保存')); onClose()
    } catch (caught) { setError((caught as Error).message) } finally { setSaving(false) }
  }
  return (
    <Dialog open onOpenChange={(value) => !value && !saving && onClose()} title={environment === 'LIVE' ? t('实盘：白名单与限额') : t('模拟账户：白名单与限额')} description={`${mask(accountId)} · ${environment === 'LIVE' ? t('每笔都要你确认才发出') : t('Agent 在限额内自己下单')}`} width={720}>
      <div className="grid grid-cols-2 gap-3 max-sm:grid-cols-1">
        <Field label={t('允许的美股代码（逗号分隔）')} className="col-span-full"><Input value={form.allowedSymbols} onChange={set('allowedSymbols')} placeholder="AAPL, MSFT, NVDA" /></Field>
        {[['maxOrderValue', t('单笔金额上限（USD）')], ['maxDailyOrderValue', t('单日委托金额上限（USD）')], ['maxPositionValue', t('单只股票持仓上限（含未成交，USD）')], ['maxOrdersPerDay', t('单日最多委托数')], ['maxQuoteAgeSeconds', t('行情最大年龄（秒，≤300）')], ['maxLimitDeviationPct', t('限价偏离现价上限（%，≤5）')], ...(environment === 'LIVE' ? [['confirmMinutes', t('确认有效期（分钟，1–30）')]] : [])].map(([key, label]) => <Field key={key} label={label}><Input type="number" value={form[key]} onChange={set(key)} /></Field>)}
      </div>
      <p className="text-xs text-ink-3">{t('只做多、只用现金、只下当日限价单，不在盘前盘后成交。撤单不返还当日额度。')}</p>
      {environment === 'LIVE' && (
        <div className="mt-2 flex flex-col gap-2 rounded-lg border border-bad-line bg-bad-soft p-3 text-[13px] text-bad">
          <div>{t('这是真实资金账户。Agent 只能提议，每一笔都要你在这里确认后才会发给 IB；确认时会用最新行情再检查一遍。')}</div>
          <Field label={t('输入「{phrase}」开启', { phrase: LIVE_PHRASE })}><Input value={form.liveAcknowledgement} onChange={set('liveAcknowledgement')} /></Field>
        </div>
      )}
      <ErrorNote error={error} className="mt-3" />
      <div className="mt-4 flex justify-end gap-2"><Button onClick={onClose} disabled={saving}>{t('取消')}</Button><Button variant={environment === 'LIVE' ? 'danger' : 'primary'} loading={saving} onClick={save}>{t('保存并开启')}</Button></div>
    </Dialog>
  )
}

// Real-money orders the agents proposed; also shown on the home page.
export function PendingConfirmations() {
  const client = useQueryClient()
  const status = useIbkrStatus()
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const pending: any[] = status.data?.pendingConfirmations ?? []
  if (!pending.length) return null
  const decide = async (id: string, approve: boolean) => {
    setBusy(id); setError('')
    try {
      const result = await post<any>(`/api/ibkr/${approve ? 'confirm' : 'reject'}`, { id })
      client.invalidateQueries({ queryKey: ['ibkr-status'] })
      if (approve && result.status !== 'acknowledged') throw new Error(result.error ?? STATES[result.status] ?? result.status)
      toast.success(approve ? t('已发给 IB') : t('已拒绝'))
    } catch (caught) { setError((caught as Error).message) } finally { setBusy('') }
  }
  return (
    <div className="flex flex-col gap-3">
      <ErrorNote error={error} />
      {pending.map((entry) => (
        <Card key={entry.id} className="flex flex-col gap-2 border-bad-line p-4 text-[13px]">
          <div className="flex flex-wrap items-center gap-2"><Pill tone="bad">{t('实盘 · 等你确认')}</Pill><strong className="text-[15px]">{entry.side === 'BUY' ? t('买入') : t('卖出')} {entry.symbol} {entry.quantity} {t('股')} @ {entry.limitPrice}</strong><span className="font-mono text-ink-2">≈ {money(entry.notional, 'USD')}</span><span className="ml-auto text-xs text-ink-3">{t('{time} 前有效', { time: dateTime(entry.expiresAt) })}</span></div>
          <p className="m-0 text-ink-2">{entry.rationale}</p>
          <div className="text-xs text-ink-3">{t('提议时行情 {price}（{time}）· 账户 {account} · 确认时会用最新行情再检查', { price: entry.quote?.price, time: dateTime(entry.quote?.asOf), account: mask(entry.accountId) })}</div>
          <div className="flex gap-2"><Button variant="danger" loading={busy === entry.id} disabled={Boolean(busy)} onClick={() => decide(entry.id, true)}>{t('确认下单')}</Button><Button disabled={Boolean(busy)} onClick={() => decide(entry.id, false)}>{t('拒绝')}</Button></div>
        </Card>
      ))}
    </div>
  )
}
