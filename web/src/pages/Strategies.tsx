import { useState } from 'react'
import { Link } from '@tanstack/react-router'
import { useQueries, useQuery } from '@tanstack/react-query'
import { Page, PageHeader } from '@/components/Shell'
import { AgentMark, Card, CardTitle, Dialog, Empty, Pill, Signed, Spinner } from '@/components/ui'
import { get, type TraderStrategy } from '@/lib/api'
import { agentKind, dateTime, MARKET_NAME, num } from '@/lib/format'
import { useAccounts, useLibrary, useSchedules } from '@/lib/queries'
import { t } from '@/lib/i18n'

export function StrategiesPage() {
  const { accounts } = useAccounts()
  const schedules = useSchedules()
  const library = useLibrary()
  const [viewing, setViewing] = useState<string | null>(null)
  const traders = useQueries({ queries: accounts.map((account) => ({ queryKey: ['trader-strategy', account.id, undefined], queryFn: ({ signal }: { signal: AbortSignal }) => get<TraderStrategy>(`/api/arena/accounts/${account.id}/strategy`, signal) })) })
  const written = accounts.map((account, index) => ({ account, strategy: traders[index].data })).filter((entry) => entry.strategy?.versions.length)
  const starters = (library.data?.skills ?? []).filter((skill) => skill.starterStrategy)
  return (
    <Page>
      <PageHeader title={t('策略库')} description={t('交易员自己写的代码策略、内置量化策略和模板的起始策略。所有策略都只用已收盘日线和实时报价，在沙箱里执行。')} />
      <section className="flex flex-col gap-3">
        <h2 className="m-0 text-base font-semibold">{t('交易员写的策略')}</h2>
        {!written.length ? <Empty title={t('还没有交易员写过代码策略')}>{t('Agent 当主控时会用 arena_write_strategy 写自己的策略，上线前自动空跑和回测。')}</Empty> : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(min(320px,100%),1fr))] gap-3">
            {written.map(({ account, strategy }) => {
              const live = strategy!.versions.find((entry) => entry.status === 'live')
              return (
                <Link key={account.id} to="/traders/$id" params={{ id: account.id }} search={{ tab: 'strategy' }} className="flex flex-col gap-2 rounded-xl border border-line bg-surface p-4 text-ink hover:border-line-strong">
                  <span className="flex items-center gap-2"><AgentMark kind={agentKind(account)} /><span className="flex-1 truncate font-semibold">{account.name}</span><Pill>{MARKET_NAME[account.market]}</Pill></span>
                  <span className="font-mono text-xs text-ink-3">{strategy!.strategyId} · {live ? t('v{n} 运行中', { n: live.version }) : t('没有上线版本')} · {t('共 {n} 版', { n: strategy!.versions.length })}</span>
                  {live?.backtest?.ok && <span className="text-xs text-ink-2">{t('回测 {from}–{to}：', { from: live.backtest.from, to: live.backtest.to })}<Signed value={live.backtest.totalReturnPct} /> · {t('回撤 {n}%', { n: num(live.backtest.maxDrawdownPct, 1) })} · {t('{n} 笔', { n: live.backtest.trades })}</span>}
                  <span className="text-xs text-ink-3">{live?.changeNote ?? ''} · {dateTime(live?.at)}</span>
                </Link>
              )
            })}
          </div>
        )}
      </section>
      <section className="flex flex-col gap-3">
        <h2 className="m-0 text-base font-semibold">{t('内置量化策略')}</h2>
        {schedules.isLoading ? <Spinner /> : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(min(320px,100%),1fr))] gap-3">
            {(schedules.data?.strategies ?? []).map((strategy) => (
              <Card key={strategy.id} className="flex flex-col gap-2 p-4">
                <CardTitle extra={<span className="font-mono text-xs text-ink-3">{strategy.id} · v{strategy.version}</span>}>{strategy.name}</CardTitle>
                <p className="m-0 text-[13px] text-ink-2">{strategy.description}</p>
                <div className="flex flex-wrap gap-1.5">{strategy.markets.map((market) => <Pill key={market}>{MARKET_NAME[market]}</Pill>)}{strategy.origin !== 'builtin' && <Pill tone="accent">{t('你的策略')}</Pill>}</div>
                <div className="text-xs text-ink-3">{t('参数：')}{Object.entries(strategy.params).map(([key, spec]) => `${spec.label ?? key} ${String(spec.default)}`).join(t('，')) || t('无')}</div>
              </Card>
            ))}
          </div>
        )}
        {schedules.data?.strategyErrors?.length ? <div className="rounded-lg bg-warn-soft px-3 py-2 text-xs text-warn-ink">{schedules.data.strategyErrors.join(t('；'))}</div> : null}
        <div className="text-xs text-ink-3">{t('自己的策略放进 {dir}，会和内置策略一起出现。', { dir: schedules.data?.strategyDir ?? '' })}</div>
      </section>
      <section className="flex flex-col gap-3">
        <h2 className="m-0 text-base font-semibold">{t('起始策略（来自内置 skill）')}</h2>
        <div className="grid grid-cols-[repeat(auto-fill,minmax(min(320px,100%),1fr))] gap-3">
          {starters.map((skill) => (
            <Card key={skill.id} className="flex flex-col gap-2 p-4">
              <CardTitle extra={<span className="font-mono text-xs text-ink-3">{skill.starterStrategy}</span>}>{skill.name}</CardTitle>
              <p className="m-0 text-[13px] text-ink-2">{skill.summary}</p>
              <div className="flex items-center gap-2 text-xs text-ink-3"><span>{skill.sourceInfo?.repo} · {skill.sourceInfo?.license}</span><button type="button" className="ml-auto text-accent-ink underline-offset-2 hover:underline" onClick={() => setViewing(skill.starterStrategy!)}>{t('看代码')}</button></div>
            </Card>
          ))}
        </div>
      </section>
      {viewing && <StarterCode id={viewing} onClose={() => setViewing(null)} />}
    </Page>
  )
}

function StarterCode({ id, onClose }: { id: string; onClose: () => void }) {
  const code = useQuery({ queryKey: ['starter', id], queryFn: ({ signal }) => get<{ code: string }>(`/api/library/strategies/${id}`, signal) })
  return (
    <Dialog open onOpenChange={(value) => !value && onClose()} title={`${id}.mjs`} description={t('交易员可以用 arena_get_starter_strategy 读到这份代码，改好后用 arena_write_strategy 发布')} width={900}>
      {code.isLoading ? <Spinner /> : <pre className="m-0 max-h-[64vh] overflow-auto rounded-lg bg-surface-2 p-4 font-mono text-xs scroll-thin">{code.data?.code}</pre>}
    </Dialog>
  )
}
