import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Page, PageHeader } from '@/components/Shell'
import { Card, CardTitle, Dialog, Dot, Pill, Segmented, Spinner, cn } from '@/components/ui'
import { get, type LibrarySkill } from '@/lib/api'
import { MARKET_NAME } from '@/lib/format'
import { useAccounts, useLibrary } from '@/lib/queries'

const CATEGORY: Record<string, string> = { discipline: '纪律', team: '团队', style: '流派', research: '研究' }

export function SkillsPage() {
  const library = useLibrary()
  const { accounts } = useAccounts()
  const [source, setSource] = useState<'all' | 'third' | 'hrouter'>('all')
  const [market, setMarket] = useState<'all' | 'A' | 'HK' | 'US'>('all')
  const [availableOnly, setAvailableOnly] = useState(false)
  const [open, setOpen] = useState<LibrarySkill | null>(null)
  if (library.isLoading || !library.data) return <Page><Spinner /></Page>
  const { skills, templates, discipline } = library.data
  const users = (skill: LibrarySkill) => accounts.filter((account) => account.market && skill.markets.includes(account.market) && (discipline.includes(skill.id) || (account.skills ?? templates.find((entry) => entry.id === account.template)?.skills ?? []).includes(skill.id))).length
  const shown = skills.filter((skill) => (source === 'all' || (source === 'hrouter' ? skill.source === 'hrouter' : skill.source !== 'hrouter')) && (market === 'all' || skill.markets.includes(market)) && (!availableOnly || skill.status === 'available'))
  return (
    <Page>
      <PageHeader title="Skill 库" description={`${skills.length} 个内置交易员 skill，来自 GitHub 上的开源项目。保留原仓库许可证和 commit，只拿方法和规则，数据全部换成工作台已核验的接口。另有本插件自带的 10 个研究技能，Agent 在自己的客户端里直接可用。`} />
      <div className="flex flex-wrap items-center gap-3">
        <Segmented label="来源" value={source} onChange={setSource} options={[['all', '全部'], ['third', '第三方'], ['hrouter', '本仓库']]} />
        <Segmented label="市场" value={market} onChange={setMarket} options={[['all', '全部市场'], ['A', 'A 股'], ['HK', '港股'], ['US', '美股']]} />
        <label className="flex items-center gap-2 text-[13px] text-ink-2"><input type="checkbox" checked={availableOnly} onChange={(event) => setAvailableOnly(event.target.checked)} className="size-4 accent-[var(--c-accent)]" />只看可用的</label>
      </div>
      <div className="flex flex-wrap items-start gap-5">
        <div className="grid min-w-0 flex-[999_1_600px] grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-3">
          {shown.map((skill) => (
            <button key={skill.id} type="button" onClick={() => setOpen(skill)} className={cn('flex flex-col gap-2 rounded-xl border p-3.5 text-left', skill.status === 'available' ? 'border-line bg-surface hover:border-line-strong' : 'border-dashed border-line-strong bg-surface-2')}>
              <span className="flex items-center gap-2"><span className="font-semibold">{skill.name}</span><Pill className="ml-auto">{CATEGORY[skill.category] ?? skill.category}</Pill></span>
              <span className="font-mono text-xs text-ink-3">{skill.id}</span>
              <span className="text-[13px] text-ink-2">{skill.summary}</span>
              <span className="text-xs text-ink-2">{skill.sourceInfo?.repo} <span className="font-mono text-ink-3">{skill.sourceInfo?.license}</span></span>
              <span className="flex items-center gap-1.5 border-t border-line pt-2 text-xs">
                <Dot tone={skill.status === 'available' ? 'ok' : 'warn'} />
                {skill.status === 'available' ? <span className="text-ok">可用</span> : <span className="text-warn-ink">缺数据：{skill.requires?.join('、')}</span>}
                <span className="text-ink-3">· {skill.markets.map((key) => MARKET_NAME[key]).join('、')}{skill.status === 'available' ? ` · ${users(skill)} 个交易员在用` : ' · 第 2 期'}</span>
              </span>
            </button>
          ))}
        </div>
        <aside className="flex min-w-0 max-w-[360px] flex-[1_1_300px] flex-col gap-4">
          <Card className="flex flex-col gap-3 p-4">
            <CardTitle>交易员模板</CardTitle>
            {templates.map((template) => (
              <div key={template.id} className={cn('flex items-center gap-2.5', template.status !== 'available' && 'opacity-75')}>
                <div className="flex-1"><div className="text-[13px] font-semibold">{template.name}</div><div className={cn('text-xs', template.status === 'available' ? 'text-ink-3' : 'text-warn-ink')}>{template.status === 'available' ? (template.builtinStrategy ? '纯代码，不需要 Agent' : template.skills.map((id) => skills.find((skill) => skill.id === id)?.name ?? id).join(' · ')) : `缺 ${template.requires?.join('、')} · 第 2 期`}</div></div>
                <span className="font-mono text-xs text-ink-2">{accounts.filter((account) => account.template === template.id).length} 在用</span>
              </div>
            ))}
            <div className="border-t border-line pt-2.5 text-xs text-ink-2">每个模板都默认带上纪律类 skill</div>
          </Card>
          <Card className="flex flex-col gap-2 p-4 text-[13px] text-ink-2">
            <CardTitle>第三方 skill 怎么内置</CardTitle>
            <div>保留原仓库的许可证和 commit 号</div>
            <div>只拿方法和规则，数据改走工作台已核验的接口</div>
            <div>不运行原仓库自带的数据脚本</div>
            <div>缺的数据补上真实来源之前，skill 不能选</div>
          </Card>
        </aside>
      </div>
      {open && <SkillDialog skill={open} onClose={() => setOpen(null)} />}
    </Page>
  )
}

function SkillDialog({ skill, onClose }: { skill: LibrarySkill; onClose: () => void }) {
  const body = useQuery({ queryKey: ['skill', skill.id], enabled: skill.status === 'available', queryFn: ({ signal }) => get<{ body: string }>(`/api/library/skills/${skill.id}`, signal) })
  return (
    <Dialog open onOpenChange={(value) => !value && onClose()} title={skill.name} description={`${skill.sourceInfo?.repo ?? ''} · ${skill.sourceInfo?.license ?? ''}${skill.sourceInfo?.commit ? ` · ${skill.sourceInfo.commit.slice(0, 8)}` : ''}`} width={820}>
      {skill.sourceInfo?.url && <a href={skill.sourceInfo.url} target="_blank" rel="noreferrer" className="text-[13px]">打开原仓库</a>}
      {skill.status !== 'available' ? <p className="text-[13px] text-warn-ink">这个 skill 需要 {skill.requires?.join('、')}，工作台还没有这些真实数据，第 2 期补上数据源后开放。</p>
        : body.isLoading ? <Spinner /> : <pre className="mt-3 max-h-[60vh] overflow-auto whitespace-pre-wrap rounded-lg bg-surface-2 p-4 font-sans text-[13px] leading-relaxed scroll-thin">{body.data?.body}</pre>}
    </Dialog>
  )
}
