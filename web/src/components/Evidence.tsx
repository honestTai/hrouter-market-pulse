import { CalendarDays, ExternalLink, FileText, Layers, ShieldCheck } from 'lucide-react'
import { dateTime, num, safeUrl } from '@/lib/format'
import { titleOf } from '@/lib/market'
import { Empty, Pill } from './ui'
import { t } from '@/lib/i18n'

const TIER: Record<string, string> = { official: t('官方原始来源'), primary: t('一手来源'), secondary: t('二手来源'), unknown: t('来源未核验') }
const STATUS: Record<string, string> = { confirmed: t('已确认'), tentative: t('预计'), cancelled: t('已取消'), completed: t('已结束') }

/* eslint-disable @typescript-eslint/no-explicit-any */
export function EvidenceRow({ row }: { row: any }) {
  const url = safeUrl(row.url || row.sourceUrl)
  const event = Boolean(row.scheduledAt)
  const financial = row.kind === 'financial' && row.payload
  const Icon = event ? CalendarDays : financial ? Layers : FileText
  return (
    <article className="flex gap-3 border-t border-line py-3 first:border-t-0">
      <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-sunken text-ink-2"><Icon className="size-4" strokeWidth={1.7} aria-hidden /></span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          {url ? <a href={url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-semibold">{titleOf(row) || t('来源记录')}<ExternalLink className="size-3" /></a> : <strong>{titleOf(row) || t('来源记录')}</strong>}
          {row.symbol && <Pill>{row.symbol}</Pill>}
        </div>
        {financial && <div className="mt-1 flex flex-wrap gap-3 text-[13px]"><span>{financial.metric}</span><strong className="font-mono">{num(financial.value)} <small className="text-ink-3">{financial.unit}{financial.scale && financial.scale !== 1 ? ` × ${financial.scale}` : ''}</small></strong><span className="text-ink-3">{financial.periodStart ? `${financial.periodStart} → ` : ''}{financial.periodEnd || '—'}</span></div>}
        {event && <div className="mt-1 flex flex-wrap items-center gap-2 text-[13px]"><Pill tone={row.eventStatus === 'cancelled' || row.conflict ? 'warn' : 'ok'}>{STATUS[row.eventStatus] ?? t('预计')}</Pill><span>{dateTime(row.scheduledAt)}</span>{row.dateConfidence === 'estimated' && <span className="text-xs text-warn-ink">{t('日期为估计')}</span>}</div>}
        <div className="mt-1 flex flex-wrap gap-3 text-xs text-ink-3">
          <span className={row.sourceTier === 'official' ? 'inline-flex items-center gap-1 text-ok' : ''}>{row.sourceTier === 'official' && <ShieldCheck className="size-3" />}{TIER[row.sourceTier] ?? TIER.unknown}</span>
          <span>{row.publisher || row.provider || row.providerId || ''}</span>
          <span>{t('发布')} {dateTime(row.publishedAt || row.availableAt)}</span>
          {row.availableAt && <span title={t('系统最早看到这条证据的时间')}>{t('可见')} {dateTime(row.availableAt)}</span>}
        </div>
      </div>
    </article>
  )
}

export function EvidenceList({ rows, limit }: { rows: any[]; limit?: number }) {
  if (!rows.length) return <Empty title={t('还没有来源证据')}>{t('同步官方资料或让 Agent 用 ingest_evidence 导入后，公告、财务事实和事件会出现在这里。')}</Empty>
  return <div className="flex flex-col">{(limit ? rows.slice(0, limit) : rows).map((row, index) => <EvidenceRow key={row.id || `${row.title}:${index}`} row={row} />)}</div>
}
