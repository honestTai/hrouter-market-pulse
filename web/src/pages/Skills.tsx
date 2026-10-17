import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Download, ExternalLink, RefreshCw } from 'lucide-react'
import { Page, PageHeader } from '@/components/Shell'
import { Markdown } from '@/components/Markdown'
import { Button, Card, CardTitle, Dialog, Dot, Field, Input, Pill, Segmented, Spinner, cn } from '@/components/ui'
import { get, type LibrarySkill, type SkillUpdate } from '@/lib/api'
import { dateTime, MARKET_NAME, safeUrl } from '@/lib/format'
import { t } from '@/lib/i18n'
import { useAccounts, useAction, useClaudeSkills, useLibrary, useSkillUpdates } from '@/lib/queries'

const CATEGORY: Record<string, string> = { discipline: t('纪律'), team: t('团队'), style: t('流派'), research: t('研究'), imported: t('导入') }

export function SkillsPage() {
  const library = useLibrary()
  const { accounts } = useAccounts()
  const [force, setForce] = useState(false)
  const updates = useSkillUpdates(force)
  const [source, setSource] = useState<'all' | 'third' | 'hrouter' | 'imported'>('all')
  const [market, setMarket] = useState<'all' | 'A' | 'HK' | 'US'>('all')
  const [open, setOpen] = useState<LibrarySkill | null>(null)
  const [importing, setImporting] = useState(false)
  if (library.isLoading || !library.data) return <Page><Spinner /></Page>
  const { skills, templates, discipline } = library.data
  const users = (skill: LibrarySkill) => accounts.filter((account) => account.market && skill.markets.includes(account.market) && (discipline.includes(skill.id) || (account.skills ?? templates.find((entry) => entry.id === account.template)?.skills ?? []).includes(skill.id))).length
  const shown = skills.filter((skill) => (source === 'all' || (source === 'hrouter' ? skill.source === 'hrouter' : source === 'imported' ? skill.source === 'imported' : !['hrouter', 'imported'].includes(skill.source))) && (market === 'all' || skill.markets.includes(market)))
  const updateOf = (id: string) => updates.data?.results.find((entry) => entry.skillId === id)
  const changed = (updates.data?.results ?? []).filter((entry) => entry.changed)
  const builtin = skills.filter((skill) => skill.source !== 'imported').length
  return (
    <Page>
      <PageHeader title={t('Skill 库')} description={t('{n} 个内置交易员 skill，来自 GitHub 上的开源项目，保留原仓库许可证和 commit，只拿方法和规则，数据全部换成工作台已核验的接口。也可以导入你自己的 skill。', { n: builtin })}
        actions={<><Button onClick={() => { setForce(true); updates.refetch() }} loading={updates.isFetching}><RefreshCw className="size-4" />{t('检查上游更新')}</Button><Button variant="primary" onClick={() => setImporting(true)}><Download className="size-4" />{t('导入 skill')}</Button></>} />
      <div className="flex flex-wrap items-center gap-3">
        <Segmented label={t('来源')} value={source} onChange={setSource} options={[['all', t('全部')], ['third', t('第三方')], ['hrouter', t('本仓库')], ['imported', t('导入的')]]} />
        <Segmented label={t('市场')} value={market} onChange={setMarket} options={[['all', t('全部市场')], ['A', MARKET_NAME.A], ['HK', MARKET_NAME.HK], ['US', MARKET_NAME.US]]} />
        {updates.data && <span className="text-xs text-ink-3">{changed.length ? t('{n} 个 skill 的上游有更新', { n: changed.length }) : t('上游都没有更新')} · {t('检查于 {time}', { time: dateTime(updates.data.checkedAt) })}</span>}
        {updates.error && <span className="text-xs text-warn-ink">{(updates.error as Error).message}</span>}
      </div>
      <div className="flex flex-wrap items-start gap-5">
        <div className="grid min-w-0 flex-[999_1_600px] grid-cols-[repeat(auto-fill,minmax(min(280px,100%),1fr))] gap-3">
          {shown.map((skill) => {
            const update = updateOf(skill.id)
            return (
              <button key={skill.id} type="button" onClick={() => setOpen(skill)} className={cn('flex flex-col gap-2 rounded-xl border p-3.5 text-left', skill.status === 'available' ? 'border-line bg-surface hover:border-line-strong' : 'border-dashed border-line-strong bg-surface-2')}>
                <span className="flex items-center gap-2"><span className="font-semibold">{skill.name}</span><Pill className="ml-auto">{CATEGORY[skill.category] ?? skill.category}</Pill></span>
                <span className="font-mono text-xs text-ink-3">{skill.id}</span>
                <span className="line-clamp-3 text-[13px] text-ink-2">{skill.summary}</span>
                <span className="truncate text-xs text-ink-2">{skill.sourceInfo?.repo} <span className="font-mono text-ink-3">{skill.sourceInfo?.license}</span></span>
                <span className="flex flex-wrap items-center gap-1.5 border-t border-line pt-2 text-xs">
                  <Dot tone={skill.status === 'available' ? 'ok' : 'warn'} />
                  {skill.status === 'available' ? <span className="text-ok">{t('可用')}</span> : <span className="text-warn-ink">{t('缺数据：{list}', { list: skill.requires?.join(t('、')) ?? '' })}</span>}
                  <span className="text-ink-3">· {skill.markets.map((key) => MARKET_NAME[key]).join(t('、'))} · {t('{n} 个交易员在用', { n: users(skill) })}</span>
                  {update?.changed && <Pill tone="accent" className="ml-auto">{t('上游有更新')}</Pill>}
                </span>
              </button>
            )
          })}
        </div>
        <aside className="flex min-w-0 flex-[1_1_300px] flex-col gap-4 lg:max-w-[360px]">
          <Card className="flex flex-col gap-3 p-4">
            <CardTitle>{t('交易员模板')}</CardTitle>
            {templates.map((template) => (
              <div key={template.id} className={cn('flex items-center gap-2.5', template.status !== 'available' && 'opacity-75')}>
                <div className="min-w-0 flex-1"><div className="text-[13px] font-semibold">{t(template.name)}</div><div className={cn('text-xs', template.status === 'available' ? 'text-ink-3' : 'text-warn-ink')}>{template.status === 'available' ? (template.builtinStrategy ? t('纯代码，不需要 Agent') : template.skills.map((id) => skills.find((skill) => skill.id === id)?.name ?? id).join(' · ')) : t('缺 {list}', { list: template.requires?.join(t('、')) ?? '' })}</div></div>
                <span className="shrink-0 font-mono text-xs text-ink-2">{t('{n} 在用', { n: accounts.filter((account) => account.template === template.id).length })}</span>
              </div>
            ))}
            <div className="border-t border-line pt-2.5 text-xs text-ink-2">{t('每个模板都默认带上纪律类 skill')}</div>
          </Card>
          <Card className="flex flex-col gap-2 p-4 text-[13px] text-ink-2">
            <CardTitle>{t('第三方 skill 怎么内置')}</CardTitle>
            <div>{t('保留原仓库的许可证和 commit 号')}</div>
            <div>{t('只拿方法和规则，数据改走工作台已核验的接口')}</div>
            <div>{t('不运行原仓库自带的数据脚本')}</div>
            <div>{t('上游更新不会自动覆盖改编版：看差异后再决定是否跟进')}</div>
            <div>{t('导入的 skill 只复制 Markdown，不复制、不运行脚本')}</div>
          </Card>
        </aside>
      </div>
      {open && <SkillDialog skill={open} update={updateOf(open.id)} onClose={() => setOpen(null)} />}
      {importing && <ImportDialog onClose={() => setImporting(false)} />}
    </Page>
  )
}

function SkillDialog({ skill, update, onClose }: { skill: LibrarySkill; update?: SkillUpdate; onClose: () => void }) {
  const body = useQuery({ queryKey: ['skill', skill.id], enabled: skill.status === 'available', queryFn: ({ signal }) => get<{ body: string }>(`/api/library/skills/${skill.id}`, signal) })
  const imported = skill.source === 'imported'
  const refresh = useAction(`/api/library/imported/${skill.id}/update`, { invalidate: [['library'], ['skill', skill.id], ['skill-updates']], success: t('已更新到上游最新版本') })
  const remove = useAction(`/api/library/imported/${skill.id}/delete`, { invalidate: [['library']], success: t('已删除这个导入的 skill') })
  const url = safeUrl(skill.sourceInfo?.url)
  const compare = safeUrl(update?.compareUrl)
  return (
    <Dialog open onOpenChange={(value) => !value && onClose()} title={skill.name} description={`${skill.sourceInfo?.repo ?? ''} · ${skill.sourceInfo?.license ?? ''}${skill.sourceInfo?.commit ? ` · ${skill.sourceInfo.commit.slice(0, 8)}` : ''}`} width={820}>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        {url && <a href={url} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 text-[13px]">{t('打开原仓库')}<ExternalLink className="size-3" /></a>}
        {update?.changed && <Pill tone="accent">{t('上游有更新：{msg}', { msg: update.latest?.message ?? update.latest?.sha.slice(0, 8) ?? '' })}</Pill>}
        {compare && <a href={compare} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 text-[13px]">{t('看差异')}<ExternalLink className="size-3" /></a>}
        {imported && skill.imported?.source.kind === 'git' && <Button size="sm" onClick={() => refresh.mutate({})} loading={refresh.isPending}>{t('更新到最新')}</Button>}
        {imported && <Button size="sm" variant="danger" onClick={() => { if (window.confirm(t('删除导入的「{name}」？用它的交易员下一轮起不再带上。', { name: skill.name }))) remove.mutate({}, { onSuccess: onClose }) }}>{t('删除')}</Button>}
      </div>
      {imported && <p className="m-0 mb-2 text-xs text-ink-3">{t('导入于 {time} · {n} 个文件 · 来源：{src}', { time: dateTime(skill.imported?.importedAt), n: skill.imported?.files.length ?? 0, src: skill.imported?.source.url ?? skill.imported?.source.path ?? skill.imported?.source.name ?? '' })}</p>}
      {skill.status !== 'available' ? <p className="text-[13px] text-warn-ink">{t('这个 skill 需要 {list}，工作台还没有这些真实数据。', { list: skill.requires?.join(t('、')) ?? '' })}</p>
        : body.isLoading ? <Spinner /> : <div className="max-h-[60vh] overflow-auto rounded-lg bg-surface-2 p-4 scroll-thin"><Markdown text={(body.data?.body ?? '').replace(/^---[\s\S]*?---\s*/, '')} className="text-[13px]" /></div>}
    </Dialog>
  )
}

function ImportDialog({ onClose }: { onClose: () => void }) {
  const [kind, setKind] = useState<'git' | 'claude' | 'folder'>('git')
  const [url, setUrl] = useState('')
  const [subdir, setSubdir] = useState('')
  const [folder, setFolder] = useState('')
  const [name, setName] = useState('')
  const [markets, setMarkets] = useState<string[]>(['A', 'HK', 'US'])
  const claude = useClaudeSkills(kind === 'claude')
  const run = useAction<Record<string, unknown>, { name: string }>('/api/library/import', { invalidate: [['library'], ['skill-updates']], success: (result) => t('已导入「{name}」，可以在交易员设置里选它', { name: result.name }) })
  const submit = () => run.mutate(kind === 'git' ? { kind, url, subdir: subdir || undefined, markets } : kind === 'claude' ? { kind, name, markets } : { kind, path: folder, markets }, { onSuccess: onClose })
  const ready = kind === 'git' ? url.startsWith('https://') : kind === 'claude' ? Boolean(name) : folder.startsWith('/') || /^[A-Za-z]:\\/.test(folder)
  return (
    <Dialog open onOpenChange={(value) => !value && onClose()} title={t('导入 skill')} description={t('只复制 SKILL.md 和参考资料（Markdown），不复制、不运行任何脚本。导入后在交易员设置里勾选才会用上。')} width={620}>
      <div className="flex flex-col gap-3">
        <Segmented label={t('来源')} value={kind} onChange={setKind} options={[['git', t('Git 仓库')], ['claude', '~/.claude/skills'], ['folder', t('本机文件夹')]]} />
        {kind === 'git' && <>
          <Field label={t('仓库地址（https）')}><Input value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://github.com/owner/repo" /></Field>
          <Field label={t('子目录（SKILL.md 所在的目录，可选）')}><Input value={subdir} onChange={(event) => setSubdir(event.target.value)} placeholder="skills/my-skill" /></Field>
        </>}
        {kind === 'claude' && (claude.isLoading ? <Spinner /> : (
          <div className="flex max-h-[40vh] flex-col gap-1.5 overflow-y-auto scroll-thin">
            {(claude.data?.skills ?? []).length ? claude.data!.skills.map((skill) => (
              <label key={skill.name} className={cn('flex cursor-pointer items-start gap-2 rounded-[10px] border p-2.5 text-[13px]', name === skill.name ? 'border-accent-line bg-accent-soft' : 'border-line')}>
                <input type="radio" name="claude-skill" className="mt-0.5 accent-[var(--c-accent)]" checked={name === skill.name} onChange={() => setName(skill.name)} />
                <span className="min-w-0"><span className="font-semibold">{skill.name}</span><span className="block text-xs text-ink-3 line-clamp-2">{skill.summary}</span></span>
              </label>
            )) : <p className="m-0 text-[13px] text-ink-3">{t('~/.claude/skills 里没有 skill。')}</p>}
          </div>
        ))}
        {kind === 'folder' && <Field label={t('文件夹的绝对路径')} hint={t('文件夹里要有 SKILL.md')}><Input value={folder} onChange={(event) => setFolder(event.target.value)} placeholder="/Users/me/skills/my-skill" /></Field>}
        <div className="flex flex-wrap items-center gap-3 text-[13px]">
          <span className="text-xs text-ink-3">{t('适用市场')}</span>
          {(['A', 'HK', 'US'] as const).map((key) => <label key={key} className="flex items-center gap-1.5"><input type="checkbox" className="size-4 accent-[var(--c-accent)]" checked={markets.includes(key)} onChange={(event) => setMarkets(event.target.checked ? [...markets, key] : markets.filter((entry) => entry !== key))} />{MARKET_NAME[key]}</label>)}
        </div>
        <div className="flex justify-end gap-2"><Button onClick={onClose}>{t('取消')}</Button><Button variant="primary" disabled={!ready || !markets.length} loading={run.isPending} onClick={submit}>{t('导入')}</Button></div>
      </div>
    </Dialog>
  )
}
