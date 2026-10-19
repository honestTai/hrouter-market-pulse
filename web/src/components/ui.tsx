import { forwardRef, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react'
import * as RD from '@radix-ui/react-dialog'
import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'
import { Loader2, Lock, LockOpen, X } from 'lucide-react'
import { isNumber, num, pct } from '@/lib/format'
import { t } from '@/lib/i18n'

export const cn = (...values: ClassValue[]) => twMerge(clsx(values))

type BtnVariant = 'primary' | 'secondary' | 'ghost' | 'warn' | 'danger'
const btnStyles: Record<BtnVariant, string> = {
  primary: 'bg-accent text-white hover:bg-accent-hover border border-transparent font-semibold',
  secondary: 'bg-surface text-ink border border-line-strong hover:bg-surface-2 font-semibold',
  ghost: 'bg-transparent text-ink-2 border border-transparent hover:bg-sunken',
  warn: 'bg-surface text-warn-ink border border-warn-line hover:bg-warn-soft font-semibold',
  danger: 'bg-surface text-bad border border-bad-line hover:bg-bad-soft font-semibold',
}

export const Button = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { variant?: BtnVariant; size?: 'sm' | 'md' | 'lg'; loading?: boolean }>(
  ({ variant = 'secondary', size = 'md', loading, className, children, disabled, type = 'button', ...rest }, ref) => (
    <button ref={ref} type={type} disabled={disabled || loading}
      className={cn('inline-flex items-center justify-center gap-2 rounded-[9px] whitespace-nowrap transition-colors',
        size === 'sm' ? 'h-8 px-3 text-[13px]' : size === 'lg' ? 'h-11 px-5 text-sm' : 'h-9 px-3.5 text-[13px]', btnStyles[variant], className)}
      {...rest}>
      {loading && <Loader2 className="size-4 animate-spin" aria-hidden />}
      {children}
    </button>
  ))

export function Pill({ tone = 'neutral', className, children, title }: { tone?: 'neutral' | 'accent' | 'ok' | 'warn' | 'bad'; className?: string; children: ReactNode; title?: string }) {
  const tones = { neutral: 'bg-sunken text-ink-2', accent: 'bg-accent-soft text-accent-ink', ok: 'bg-ok-soft text-ok', warn: 'bg-warn-soft text-warn-ink', bad: 'bg-bad-soft text-bad' }
  return <span title={title} className={cn('inline-flex items-center gap-1 rounded-full px-2 py-px text-xs whitespace-nowrap', tones[tone], className)}>{children}</span>
}

export function Card({ className, children, ...rest }: { className?: string; children: ReactNode } & React.HTMLAttributes<HTMLElement>) {
  return <section className={cn('rounded-[14px] border border-line bg-surface', className)} {...rest}>{children}</section>
}

export function CardTitle({ children, extra, className }: { children: ReactNode; extra?: ReactNode; className?: string }) {
  return (
    <div className={cn('flex flex-wrap items-center gap-2', className)}>
      <h2 className="m-0 text-[15px] font-semibold">{children}</h2>
      {extra}
    </div>
  )
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(({ className, ...rest }, ref) => (
  <input ref={ref} className={cn('h-9 w-full rounded-lg border border-line-strong bg-surface px-2.5 text-[13px] text-ink outline-none placeholder:text-ink-3 focus:border-accent', className)} {...rest} />
))

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(({ className, ...rest }, ref) => (
  <textarea ref={ref} className={cn('w-full resize-y rounded-lg border border-line-strong bg-surface px-2.5 py-2 text-[13px] leading-relaxed text-ink outline-none placeholder:text-ink-3 focus:border-accent', className)} {...rest} />
))

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={cn('h-9 w-full rounded-lg border border-line-strong bg-surface px-2 text-[13px] text-ink outline-none focus:border-accent', className)} {...rest}>{children}</select>
}

export function Field({ label, hint, children, className }: { label: string; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <label className={cn('flex flex-col gap-1', className)}>
      <span className="text-xs text-ink-3">{label}</span>
      {children}
      {hint && <span className="text-[11px] text-ink-3">{hint}</span>}
    </label>
  )
}

export function Dot({ tone, pulse, label }: { tone: 'ok' | 'warn' | 'bad' | 'accent' | 'muted'; pulse?: boolean; label?: string }) {
  const color = { ok: 'bg-ok', warn: 'bg-warn', bad: 'bg-bad', accent: 'bg-accent', muted: 'bg-line-strong' }[tone]
  return <span aria-label={label} aria-hidden={label ? undefined : true} role={label ? 'img' : undefined} className={cn('inline-block size-[7px] shrink-0 rounded-full', color, pulse && 'pulse-dot')} />
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cn('size-4 animate-spin text-ink-3', className)} aria-label={t('加载中')} />
}

export function Empty({ title, children, className, action }: { title: string; children?: ReactNode; className?: string; action?: ReactNode }) {
  return (
    <div className={cn('flex flex-col items-center justify-center gap-2 rounded-[14px] border border-dashed border-line-strong bg-surface-2 p-8 text-center', className)}>
      <div className="font-semibold">{title}</div>
      {children && <div className="max-w-md text-[13px] text-ink-3">{children}</div>}
      {action}
    </div>
  )
}

export function ErrorNote({ error, className }: { error: unknown; className?: string }) {
  if (!error) return null
  return <div role="alert" className={cn('rounded-[10px] border border-bad-line bg-bad-soft px-3 py-2 text-[13px] text-bad', className)}>{error instanceof Error ? error.message : String(error)}</div>
}

export function Dialog({ open, onOpenChange, title, description, children, width = 520 }: {
  open: boolean; onOpenChange: (value: boolean) => void; title: string; description?: string; children: ReactNode; width?: number
}) {
  return (
    <RD.Root open={open} onOpenChange={onOpenChange}>
      <RD.Portal>
        <RD.Overlay className="fixed inset-0 z-40 bg-black/30 backdrop-blur-[1px]" />
        <RD.Content style={{ width }} className="fixed left-1/2 top-1/2 z-50 max-h-[88vh] max-w-[calc(100vw-32px)] -translate-x-1/2 -translate-y-1/2 overflow-auto rounded-2xl border border-line bg-surface p-6 shadow-2xl scroll-thin">
          <div className="mb-4 flex items-start gap-3">
            <div className="flex-1">
              <RD.Title className="m-0 text-lg font-bold">{title}</RD.Title>
              {description ? <RD.Description className="mt-1 text-[13px] text-ink-2">{description}</RD.Description> : <RD.Description className="sr-only">{title}</RD.Description>}
            </div>
            <RD.Close aria-label={t('关闭')} className="rounded-md p-1 text-ink-3 hover:bg-sunken"><X className="size-4" /></RD.Close>
          </div>
          {children}
        </RD.Content>
      </RD.Portal>
    </RD.Root>
  )
}

/** A panel that slides in from the right edge, for detail that belongs next to what was clicked. */
export function Drawer({ open, onOpenChange, title, extra, children, width = 720 }: {
  open: boolean; onOpenChange: (value: boolean) => void; title: string; extra?: ReactNode; children: ReactNode; width?: number
}) {
  return (
    <RD.Root open={open} onOpenChange={onOpenChange}>
      <RD.Portal>
        <RD.Overlay className="fixed inset-0 z-40 bg-black/20" />
        <RD.Content style={{ width }} className="fixed inset-y-0 right-0 z-50 flex max-w-full flex-col border-l border-line bg-surface shadow-2xl">
          <div className="flex shrink-0 items-start gap-3 border-b border-line px-5 py-3.5">
            <div className="min-w-0 flex-1">
              <RD.Title className="m-0 text-[15px] font-bold">{title}</RD.Title>
              {extra ? <RD.Description asChild><div className="mt-0.5 text-xs text-ink-3">{extra}</div></RD.Description> : <RD.Description className="sr-only">{title}</RD.Description>}
            </div>
            <RD.Close aria-label={t('关闭')} className="rounded-md p-1 text-ink-3 hover:bg-sunken"><X className="size-4" /></RD.Close>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-5 scroll-thin max-sm:p-3">{children}</div>
        </RD.Content>
      </RD.Portal>
    </RD.Root>
  )
}

/** 涨跌数字：颜色跟随红涨绿跌 / 绿涨红跌设置，正负号永远写出来 */
export function Signed({ value, digits = 2, suffix = '%', className }: { value: number | null | undefined; digits?: number; suffix?: '%' | ''; className?: string }) {
  if (!isNumber(value)) return <span className={cn('font-mono text-ink-3', className)}>—</span>
  const tone = value > 0 ? 'text-up' : value < 0 ? 'text-down' : 'text-ink-2'
  return <span className={cn('font-mono tabular', tone, className)}>{suffix === '%' ? pct(value, digits) : `${value > 0 ? '+' : value < 0 ? '−' : ''}${num(Math.abs(value), digits)}`}</span>
}

export function Stat({ label, value, sub, className }: { label: string; value: ReactNode; sub?: ReactNode; className?: string }) {
  return (
    <div className={cn('min-w-0', className)}>
      <div className="text-xs text-ink-3">{label}</div>
      <div className="mt-0.5 truncate font-mono text-[20px] font-medium tabular">{value}</div>
      {sub && <div className="text-xs text-ink-2">{sub}</div>}
    </div>
  )
}

export function Segmented<T extends string>({ value, onChange, options, label, size = 'md' }: { value: T; onChange: (value: T) => void; options: Array<[T, ReactNode]>; label: string; size?: 'sm' | 'md' }) {
  return (
    <div role="group" aria-label={label} className="inline-flex flex-wrap rounded-[9px] bg-sunken p-[3px]">
      {options.map(([key, text]) => (
        <button key={key} type="button" aria-pressed={value === key} onClick={() => onChange(key)}
          className={cn('rounded-[7px] px-3 text-[13px]', size === 'sm' ? 'h-7' : 'h-[30px]', value === key ? 'bg-surface font-semibold shadow-[0_1px_2px_rgba(17,19,24,0.08)]' : 'text-ink-2')}>
          {text}
        </button>
      ))}
    </div>
  )
}

export function Tabs<T extends string>({ value, onChange, items }: { value: T; onChange: (value: T) => void; items: Array<{ id: T; label: ReactNode; count?: ReactNode }> }) {
  return (
    <div role="tablist" className="flex flex-wrap gap-1">
      {items.map((item) => (
        <button key={item.id} role="tab" type="button" aria-selected={value === item.id} onClick={() => onChange(item.id)}
          className={cn('border-b-2 px-3 py-2 text-sm', value === item.id ? 'border-accent font-semibold text-ink' : 'border-transparent text-ink-2 hover:text-ink')}>
          {item.label}{item.count !== undefined && <span className="ml-1 font-mono text-xs text-ink-3">{item.count}</span>}
        </button>
      ))}
    </div>
  )
}

export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (value: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled} onClick={() => onChange(!checked)}
      className={cn('relative h-[22px] w-9 shrink-0 rounded-full transition-colors', checked ? 'bg-accent' : 'bg-line-strong')}>
      <span className={cn('absolute top-[3px] size-4 rounded-full bg-white transition-all', checked ? 'left-[17px]' : 'left-[3px]')} />
    </button>
  )
}

export function LockButton({ locked, onChange, label }: { locked: boolean; onChange: (value: boolean) => void; label: string }) {
  return (
    <button type="button" aria-pressed={locked} aria-label={locked ? t('{label}：已锁定，Agent 不能改', { label }) : t('{label}：未锁定', { label })} title={locked ? t('已锁定：Agent 改不了，只能你改') : t('未锁定：Agent 可以通过 MCP 改')} onClick={() => onChange(!locked)}
      className={cn('flex size-9 shrink-0 items-center justify-center rounded-[9px] border', locked ? 'border-accent-line bg-accent-soft text-accent-ink' : 'border-line bg-surface text-ink-3 hover:text-ink-2')}>
      {locked ? <Lock className="size-4" /> : <LockOpen className="size-4" />}
    </button>
  )
}

export function Sparkline({ points, height = 44, className }: { points: number[]; height?: number; className?: string }) {
  if (points.length < 2) return <div style={{ height }} className={cn('rounded bg-surface-2', className)} />
  const min = Math.min(...points), max = Math.max(...points)
  const span = max - min
  // A flat curve sits in the middle in a neutral color instead of hugging the bottom in "up" red.
  const coords = points.map((value, index) => `${(index / (points.length - 1)) * 280},${span ? height - 4 - ((value - min) / span) * (height - 8) : height / 2}`).join(' ')
  const change = points.at(-1)! - points[0]
  return (
    <svg viewBox={`0 0 280 ${height}`} width="100%" height={height} preserveAspectRatio="none" aria-hidden className={className}>
      <polyline fill="none" stroke={!span || change === 0 ? 'var(--c-line-strong)' : change > 0 ? 'var(--c-up)' : 'var(--c-down)'} strokeWidth="1.8" vectorEffect="non-scaling-stroke" points={coords} />
    </svg>
  )
}

/** Agent 小图标：Claude 是陶土色星芒，Codex 是终端，Kimi 是 K，量化策略是代码括号 */
export function AgentMark({ kind, size = 22 }: { kind: string | null | undefined; size?: number }) {
  const box = { width: size, height: size }
  const icon = Math.round(size * 0.6)
  const radius = size >= 30 ? 'rounded-[8px]' : 'rounded-md'
  if (kind === 'claude')
    return <span aria-hidden style={box} className={cn('inline-flex shrink-0 items-center justify-center bg-claude-soft', radius)}><svg width={icon} height={icon} viewBox="0 0 24 24"><g stroke="#C96442" strokeWidth="2.8" strokeLinecap="round"><path d="M12 3v18M3 12h18M5.6 5.6l12.8 12.8M18.4 5.6L5.6 18.4" /></g></svg></span>
  if (kind === 'codex')
    return <span aria-hidden style={box} className={cn('inline-flex shrink-0 items-center justify-center bg-brand', radius)}><svg width={icon} height={icon} viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M5 17l5-5-5-5M12 19h7" /></svg></span>
  if (kind === 'strategy')
    return <span aria-hidden style={box} className={cn('inline-flex shrink-0 items-center justify-center bg-sunken text-ink-2', radius)}><svg width={icon} height={icon} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M16 18l6-6-6-6M8 6l-6 6 6 6" /></svg></span>
  const letter = { kimi: 'K', workbuddy: 'W', gemini: 'G', opencode: 'O', acp: 'A', command: '>' }[kind ?? ''] ?? 'A'
  const dark = kind === 'kimi'
  return <span aria-hidden style={{ ...box, fontSize: Math.round(size * 0.5) }} className={cn('inline-flex shrink-0 items-center justify-center font-bold', radius, dark ? 'bg-[#1f2430] text-white' : 'bg-sunken text-ink-2')}>{letter}</span>
}

export function Mono({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn('font-mono text-xs', className)}>{children}</span>
}

export function Pager({ total, offset, limit, onChange }: { total: number; offset: number; limit: number; onChange: (offset: number) => void }) {
  if (total <= limit) return total ? <div className="text-xs text-ink-3">{t('共 {n} 条', { n: total })}</div> : null
  const page = Math.floor(offset / limit) + 1
  const pages = Math.ceil(total / limit)
  return (
    <div className="flex items-center gap-2 text-xs text-ink-3">
      <span>{t('共 {n} 条 · 第 {page} / {pages} 页', { n: total, page, pages })}</span>
      <span className="flex-1" />
      <Button size="sm" disabled={offset === 0} onClick={() => onChange(Math.max(0, offset - limit))}>{t('上一页')}</Button>
      <Button size="sm" disabled={offset + limit >= total} onClick={() => onChange(offset + limit)}>{t('下一页')}</Button>
    </div>
  )
}
