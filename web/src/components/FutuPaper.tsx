import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { get, post } from '@/lib/api'
import { dateTime, num } from '@/lib/format'
import { Button, Card, CardTitle, Dialog, Empty, ErrorNote, Field, Input, Pill, Segmented, Select, Spinner, Textarea } from './ui'

/* eslint-disable @typescript-eslint/no-explicit-any */
// Futu OpenD SIMULATE accounts: real broker paper orders within limits the owner authorizes here.
const example = (side: 'BUY' | 'SELL') => ({ name: side === 'BUY' ? 'paper-entry-example' : 'paper-exit-example', version: '1', baseScore: 0, minimumScore: 1, rules: [{ feature: 'priceToSma20Pct', operator: side === 'BUY' ? 'gt' : 'lt', value: 0, points: 1, label: side === 'BUY' ? '价格在 MA20 上方（示例，不是建议）' : '价格跌破 MA20（示例，不是建议）' }] })
const mask = (id: string | undefined) => (id ? `••••${id.slice(-4)}` : '—')
const STATES: Record<string, string> = { blocked: '门槛拦截', dispatching: '发送中 / 待核对', unknown: '结果未知 · 禁止重试', acknowledged: '券商已响应' }

export function FutuPaper() {
  const client = useQueryClient()
  const status = useQuery({ queryKey: ['paper-status'], queryFn: ({ signal }) => get<any>('/api/paper/status', signal), refetchInterval: 15_000 })
  const [market, setMarket] = useState<'HK' | 'US'>('HK')
  const [accountId, setAccountId] = useState('')
  const [accounts, setAccounts] = useState<any[]>([])
  const [snapshot, setSnapshot] = useState<any>(null)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [editing, setEditing] = useState(false)
  const [tab, setTab] = useState<'orders' | 'positions' | 'journal'>('orders')
  useEffect(() => { const policy = status.data?.policy; if (policy?.market && !accountId) { setMarket(policy.market); setAccountId(policy.accountId ?? '') } }, [status.data, accountId])
  useEffect(() => { const latest = status.data?.snapshots?.find((entry: any) => entry.accountId === accountId && entry.market === market); if (latest) setSnapshot(latest) }, [status.data, accountId, market])
  const act = async (name: string, task: () => Promise<void>) => { setBusy(name); setError(''); try { await task() } catch (caught) { setError((caught as Error).message) } finally { setBusy('') } }
  const policy = status.data?.policy ?? {}
  const setup = !status.data?.bridgeEnabled || status.data?.demoDisabled
  const verified = accounts.some((entry) => entry.accountId === accountId && entry.market === market && entry.environment === 'SIMULATE') || (policy.accountId === accountId && policy.market === market)
  const intents = (status.data?.intents ?? []).filter((entry: any) => !accountId || (entry.accountId === accountId && entry.market === market))
  if (status.isLoading) return <Spinner />
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap gap-2"><Pill tone="ok">{snapshot ? '已读取富途模拟账户' : '真实接口 · 待读取'}</Pill><Pill tone={policy.enabled ? 'ok' : 'warn'}>{policy.enabled ? '已授权 · Agent 可执行' : 'Agent 执行已暂停'}</Pill><Pill>实盘永久禁用</Pill></div>
      <ErrorNote error={error || status.error} />
      {setup && (
        <Card className="flex flex-col gap-2 p-4 text-[13px] text-ink-2">
          <CardTitle>先连接本机 OpenD</CardTitle>
          <div>1. 在本机启动富途 OpenD 并登录；只接受 127.0.0.1，不读取你的登录密码。</div>
          <div>2. 在独立 venv 里安装 <code className="font-mono">bridges/futu/requirements.txt</code>。</div>
          <div>3. 设置环境变量后重启服务，再回到这里选账户、规则、白名单和限额。</div>
          <pre className="m-0 rounded-lg bg-surface-2 p-3 font-mono text-xs">{'HROUTER_FUTU_ENABLED=1\nHROUTER_FUTU_PYTHON=/absolute/path/to/venv/bin/python\nHROUTER_FUTU_PORT=11111'}</pre>
        </Card>
      )}
      <Card className="flex flex-wrap items-end gap-3 p-4">
        <Field label="市场" className="w-36"><Select value={market} disabled={Boolean(busy)} onChange={(event) => { setMarket(event.target.value as 'HK' | 'US'); setAccountId(''); setAccounts([]); setSnapshot(null) }}><option value="HK">港股 · HKD</option><option value="US">美股 · USD</option></Select></Field>
        <Field label="富途模拟账户" className="w-56"><Select value={accountId} disabled={Boolean(busy) || !accounts.length} onChange={(event) => { setAccountId(event.target.value); setSnapshot(null) }}><option value="">{accountId ? mask(accountId) : '连接后选择账户'}</option>{accounts.map((entry) => <option key={entry.accountId} value={entry.accountId}>{mask(entry.accountId)} · SIMULATE</option>)}</Select></Field>
        <Button disabled={setup || Boolean(busy)} loading={busy === 'connect'} onClick={() => act('connect', async () => { const result = await post<any>('/api/paper/connect', { market }); setAccounts(result.accounts); setAccountId((old) => (result.accounts.some((entry: any) => entry.accountId === old) ? old : result.accounts[0]?.accountId ?? '')); if (!result.accounts.length) throw new Error('该市场没有可用的股票模拟账户，请在富途检查账户和权限。') })}>连接 OpenD</Button>
        <Button disabled={!verified || Boolean(busy)} loading={busy === 'refresh'} onClick={() => act('refresh', async () => { const result = await post<any>('/api/paper/refresh', { market, accountId }); setSnapshot(result.snapshot); client.invalidateQueries({ queryKey: ['paper-status'] }) })}>核对账户</Button>
        <Button variant="primary" disabled={!verified || Boolean(busy)} onClick={() => setEditing(true)}>策略与授权</Button>
        {policy.enabled && <Button variant="danger" disabled={Boolean(busy)} loading={busy === 'pause'} onClick={() => act('pause', async () => { await post('/api/paper/policy', { environment: 'SIMULATE', enabled: false }); client.invalidateQueries({ queryKey: ['paper-status'] }); toast.success('Agent 执行已暂停') })}>暂停 Agent 执行</Button>}
      </Card>
      <div className="grid grid-cols-4 gap-3 max-md:grid-cols-2">
        {[['账户总资产', snapshot?.funds?.totalAssets, snapshot?.currency], ['现金余额', snapshot?.funds?.cash, snapshot?.currency], ['持仓市值', snapshot?.funds?.marketValue, snapshot?.currency], ['Agent 当日委托上限', policy.maxDailyOrderValue, policy.currency]].map(([label, value, unit]) => (
          <Card key={label} className="p-4"><div className="text-xs text-ink-3">{label}</div><div className="font-mono text-lg">{num(value)} <small className="text-ink-3">{unit ?? ''}</small></div><div className="text-xs text-ink-3">{snapshot ? `采样 ${dateTime(snapshot.observedAt)}` : '还没读取账户，不显示虚构数字'}</div></Card>
        ))}
      </div>
      <Card className="flex flex-col gap-3 p-4">
        <Segmented label="记录" value={tab} onChange={setTab} options={[['orders', '券商委托'], ['positions', '模拟持仓'], ['journal', 'Agent 执行记录']]} />
        {tab === 'orders' && (snapshot?.orders?.length ? (
          <table className="w-full border-collapse text-[13px]"><thead><tr className="text-left text-xs text-ink-3"><th className="py-1.5 font-medium">代码 / 委托号</th><th className="font-medium">方向</th><th className="font-medium">委托 / 成交</th><th className="font-medium">限价 / 均价</th><th className="font-medium">状态</th><th /></tr></thead>
            <tbody>{snapshot.orders.map((order: any) => <tr key={order.orderId} className="border-t border-line"><td className="py-1.5"><div className="font-semibold">{order.code}</div><div className="font-mono text-[11px] text-ink-3">{order.orderId}</div></td><td>{order.side}</td><td className="font-mono">{num(order.quantity, 0)} / {num(order.filledQuantity, 0)}</td><td className="font-mono">{num(order.price)} / {num(order.filledAveragePrice)}</td><td><Pill>{order.status}</Pill></td><td className="text-right">{['SUBMITTED', 'FILLED_PART'].includes(order.status) && intents.some((entry: any) => entry.kind === 'order' && entry.brokerOrderId === order.orderId) && <Button size="sm" variant="danger" disabled={Boolean(busy)} onClick={() => act('cancel', async () => { const result = await post<any>('/api/paper/cancel', { orderId: order.orderId, idempotencyKey: `cancel_${crypto.randomUUID()}`, environment: 'SIMULATE' }); client.invalidateQueries({ queryKey: ['paper-status'] }); if (result.status === 'unknown') throw new Error(result.error) })}>请求撤单</Button>}</td></tr>)}</tbody></table>
        ) : <Empty title="没有已读取的券商委托">只显示富途返回的真实委托，不会把信号或下单响应当成成交。</Empty>)}
        {tab === 'positions' && (snapshot?.positions?.length ? (
          <table className="w-full border-collapse text-[13px]"><thead><tr className="text-left text-xs text-ink-3"><th className="py-1.5 font-medium">代码</th><th className="font-medium">数量 / 可卖</th><th className="font-medium">成本</th><th className="font-medium">市值</th><th className="font-medium">未实现盈亏</th></tr></thead>
            <tbody>{snapshot.positions.map((position: any, index: number) => <tr key={`${position.code}:${index}`} className="border-t border-line font-mono"><td className="py-1.5 font-sans">{position.code}</td><td>{num(position.quantity, 0)} / {num(position.canSellQuantity, 0)}</td><td>{num(position.costPrice)}</td><td>{num(position.marketValue)}</td><td>{num(position.unrealizedPnl)}</td></tr>)}</tbody></table>
        ) : <Empty title="没有已读取的模拟持仓" />)}
        {tab === 'journal' && (intents.length ? intents.map((entry: any) => (
          <div key={entry.id} className="border-t border-line pt-2 text-[13px] first:border-t-0">
            <div className="flex flex-wrap items-center gap-2"><strong>{entry.symbol || entry.brokerOrderId} · {entry.side || '撤单'}</strong><Pill tone={entry.status === 'unknown' ? 'bad' : entry.status === 'blocked' ? 'warn' : 'neutral'}>{STATES[entry.status] ?? entry.status}</Pill><span className="font-mono text-xs text-ink-3">{dateTime(entry.createdAt)}</span></div>
            <p className="m-0 mt-1 text-ink-2">{entry.rationale || entry.meaning}</p>{entry.error && <p className="m-0 text-xs text-bad">{entry.error}</p>}
          </div>
        )) : <Empty title="还没有 Agent 执行记录">执行和拦截都会留下记录；没有连接或没授权时不会编造战绩。</Empty>)}
      </Card>
      {editing && <PolicyDialog policy={policy} market={market} accountId={accountId} onClose={() => setEditing(false)} onSaved={() => client.invalidateQueries({ queryKey: ['paper-status'] })} />}
    </div>
  )
}

function PolicyDialog({ policy, market, accountId, onClose, onSaved }: { policy: any; market: string; accountId: string; onClose: () => void; onSaved: () => void }) {
  const current = policy?.market === market && policy?.accountId === accountId ? policy : {}
  const [form, setForm] = useState<Record<string, string>>({
    allowedSymbols: current.allowedSymbols?.join(', ') ?? '', maxOrderValue: String(current.maxOrderValue ?? ''), maxDailyOrderValue: String(current.maxDailyOrderValue ?? ''), maxPositionValue: String(current.maxPositionValue ?? ''),
    maxOrdersPerDay: String(current.maxOrdersPerDay ?? ''), maxQuoteAgeSeconds: String(current.maxQuoteAgeSeconds ?? ''), maxLimitDeviationPct: String(current.maxLimitDeviationPct ?? ''),
    lotSizes: JSON.stringify(current.lotSizes ?? {}, null, 2), entryStrategy: JSON.stringify(current.entryStrategy ?? example('BUY'), null, 2), exitStrategy: JSON.stringify(current.exitStrategy ?? example('SELL'), null, 2),
  })
  const [approved, setApproved] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const set = (key: string) => (event: { target: { value: string } }) => setForm({ ...form, [key]: event.target.value })
  const save = async () => {
    setError('')
    try {
      if (!approved) throw new Error('请确认授权范围。')
      setSaving(true)
      const input: Record<string, unknown> = { enabled: true, environment: 'SIMULATE', market, accountId, allowedSymbols: form.allowedSymbols.split(/[\s,，]+/).filter(Boolean), lotSizes: JSON.parse(form.lotSizes || '{}'), entryStrategy: JSON.parse(form.entryStrategy), exitStrategy: JSON.parse(form.exitStrategy) }
      for (const name of ['maxOrderValue', 'maxDailyOrderValue', 'maxPositionValue', 'maxOrdersPerDay', 'maxQuoteAgeSeconds', 'maxLimitDeviationPct']) input[name] = Number(form[name])
      await post('/api/paper/policy', input)
      onSaved(); toast.success('授权已保存'); onClose()
    } catch (caught) { setError((caught as Error).message) } finally { setSaving(false) }
  }
  return (
    <Dialog open onOpenChange={(value) => !value && !saving && onClose()} title="授权 Agent 模拟执行" description={`${market} · ${mask(accountId)} · 只限 SIMULATE`} width={760}>
      <div className="grid grid-cols-2 gap-3 max-sm:grid-cols-1">
        <Field label="允许的证券代码（逗号分隔）" className="col-span-full"><Input value={form.allowedSymbols} onChange={set('allowedSymbols')} placeholder={market === 'HK' ? '0700.HK' : 'AAPL, MSFT'} /></Field>
        {[['maxOrderValue', '单笔名义金额上限'], ['maxDailyOrderValue', '单日委托金额上限'], ['maxPositionValue', '单标的持仓上限（含待成交）'], ['maxOrdersPerDay', '单日最多委托数'], ['maxQuoteAgeSeconds', '行情最大年龄（秒，≤300）'], ['maxLimitDeviationPct', '限价偏离现价上限（%，≤5）']].map(([key, label]) => <Field key={key} label={label}><Input type="number" value={form[key]} onChange={set(key)} /></Field>)}
        <Field label="每手股数 JSON（港股须核实；美股固定 1）" className="col-span-full"><Textarea rows={2} value={form.lotSizes} onChange={set('lotSizes')} className="font-mono" /></Field>
        <Field label="买入规则 JSON（示例需要你自己评估修改）" className="col-span-full"><Textarea rows={6} value={form.entryStrategy} onChange={set('entryStrategy')} className="font-mono" /></Field>
        <Field label="卖出规则 JSON（只卖已有可卖持仓）" className="col-span-full"><Textarea rows={6} value={form.exitStrategy} onChange={set('exitStrategy')} className="font-mono" /></Field>
      </div>
      <p className="text-xs text-ink-3">金额单位 {market === 'HK' ? 'HKD' : 'USD'}。撤单不返还当日委托预算；没有自动换汇或融资。模拟表现不代表可以实盘。</p>
      <label className="flex items-start gap-2 text-[13px]"><input type="checkbox" checked={approved} onChange={(event) => setApproved(event.target.checked)} className="mt-0.5 size-4 accent-[var(--c-accent)]" />我授权 Agent 按以上规则和限额自主提交模拟委托，不需要逐笔确认；不授权实盘。</label>
      <ErrorNote error={error} className="mt-3" />
      <div className="mt-4 flex justify-end gap-2"><Button onClick={onClose} disabled={saving}>取消</Button><Button variant="primary" loading={saving} onClick={save}>保存授权</Button></div>
    </Dialog>
  )
}
