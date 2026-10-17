import { useEffect, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Maximize2, X } from 'lucide-react'
import { t } from '@/lib/i18n'
import { cn } from './ui'

/** A panel that can open full-window (charts, long tables, run processes). Esc or the close button returns. */
export function Expandable({ title, children, className }: { title: string; children: ReactNode; className?: string }) {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false) }
    window.addEventListener('keydown', onKey)
    const overflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { window.removeEventListener('keydown', onKey); document.body.style.overflow = overflow }
  }, [open])
  return (
    <div className={cn('group/expand relative min-w-0', className)}>
      <button type="button" aria-label={t('全屏查看「{title}」', { title })} title={t('全屏')} onClick={() => setOpen(true)}
        className="absolute right-2.5 top-2.5 z-10 rounded-md bg-surface/80 p-1.5 text-ink-3 opacity-0 transition-opacity hover:bg-sunken hover:text-ink focus-visible:opacity-100 group-hover/expand:opacity-100 [@media(hover:none)]:opacity-70">
        <Maximize2 className="size-3.5" />
      </button>
      {children}
      {open && createPortal(
        <div role="dialog" aria-modal="true" aria-label={title} className="fixed inset-0 z-50 flex flex-col bg-bg">
          <div className="flex h-12 shrink-0 items-center gap-3 border-b border-line bg-surface px-5">
            <span className="flex-1 truncate text-[15px] font-semibold">{title}</span>
            <span className="text-xs text-ink-3 max-sm:hidden">{t('按 Esc 退出')}</span>
            <button type="button" aria-label={t('退出全屏')} onClick={() => setOpen(false)} className="rounded-md p-1.5 text-ink-2 hover:bg-sunken"><X className="size-4" /></button>
          </div>
          <div className="min-h-0 flex-1 overflow-auto p-6 scroll-thin max-sm:p-3">{children}</div>
        </div>,
        document.body,
      )}
    </div>
  )
}
