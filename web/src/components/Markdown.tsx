import type { ReactNode } from 'react'
import { safeUrl } from '@/lib/format'
import { cn } from './ui'

// Just enough Markdown for agent reports: headings, lists, tables, quotes, code blocks, **bold**,
// `code` and [links](https://…). Everything renders as React text; no HTML from the report is used.

function inline(text: string, key = 0): ReactNode[] {
  const parts: ReactNode[] = []
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)\s]+\))/g
  let last = 0
  let match: RegExpExecArray | null
  let index = key
  while ((match = pattern.exec(text))) {
    if (match.index > last) parts.push(text.slice(last, match.index))
    const token = match[0]
    if (token.startsWith('**')) parts.push(<strong key={index++}>{token.slice(2, -2)}</strong>)
    else if (token.startsWith('`')) parts.push(<code key={index++} className="rounded bg-sunken px-1 font-mono text-[0.9em]">{token.slice(1, -1)}</code>)
    else {
      const [, label, href] = token.match(/^\[([^\]]+)\]\(([^)\s]+)\)$/) ?? []
      const url = safeUrl(href)
      parts.push(url ? <a key={index++} href={url} target="_blank" rel="noreferrer noopener" className="text-accent-ink underline-offset-2 hover:underline">{label}</a> : label)
    }
    last = match.index + token.length
  }
  if (last < text.length) parts.push(text.slice(last))
  return parts
}

export function Markdown({ text, className }: { text: string; className?: string }) {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const blocks: ReactNode[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (!line.trim()) { i += 1; continue }
    if (line.startsWith('```')) {
      const body: string[] = []
      i += 1
      while (i < lines.length && !lines[i].startsWith('```')) body.push(lines[i++])
      i += 1
      blocks.push(<pre key={blocks.length} className="overflow-x-auto rounded-lg bg-surface-2 p-3 font-mono text-xs">{body.join('\n')}</pre>)
      continue
    }
    const heading = line.match(/^(#{1,4})\s+(.*)$/)
    if (heading) {
      const level = heading[1].length
      blocks.push(<div key={blocks.length} role="heading" aria-level={level + 1} className={cn('font-semibold', level === 1 ? 'mt-2 text-lg' : level === 2 ? 'mt-2 text-base' : 'mt-1 text-[14px]')}>{inline(heading[2])}</div>)
      i += 1
      continue
    }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      const rows: string[][] = []
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
        if (!/^\s*\|[\s:|-]+\|\s*$/.test(lines[i])) rows.push(lines[i].trim().slice(1, -1).split('|').map((cell) => cell.trim()))
        i += 1
      }
      const [head, ...body] = rows
      blocks.push(
        <div key={blocks.length} className="overflow-x-auto">
          <table className="w-full border-collapse text-[13px]">
            {head && <thead><tr>{head.map((cell, index) => <th key={index} className="border-b border-line px-2 py-1.5 text-left text-xs font-semibold text-ink-2">{inline(cell)}</th>)}</tr></thead>}
            <tbody>{body.map((row, rowIndex) => <tr key={rowIndex} className="border-b border-line last:border-b-0">{row.map((cell, index) => <td key={index} className="px-2 py-1.5 align-top">{inline(cell)}</td>)}</tr>)}</tbody>
          </table>
        </div>,
      )
      continue
    }
    if (/^\s*([-*•]|\d+[.)])\s+/.test(line)) {
      const ordered = /^\s*\d+[.)]\s+/.test(line)
      const items: string[] = []
      while (i < lines.length && /^\s*([-*•]|\d+[.)])\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*([-*•]|\d+[.)])\s+/, ''))
      const List = ordered ? 'ol' : 'ul'
      blocks.push(<List key={blocks.length} className={cn('m-0 flex flex-col gap-1 pl-5', ordered ? 'list-decimal' : 'list-disc')}>{items.map((item, index) => <li key={index}>{inline(item)}</li>)}</List>)
      continue
    }
    if (line.startsWith('>')) {
      const quote: string[] = []
      while (i < lines.length && lines[i].startsWith('>')) quote.push(lines[i++].replace(/^>\s?/, ''))
      blocks.push(<blockquote key={blocks.length} className="m-0 border-l-2 border-line-strong pl-3 text-ink-2">{inline(quote.join(' '))}</blockquote>)
      continue
    }
    const paragraph: string[] = []
    while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|```|\s*\||\s*([-*•]|\d+[.)])\s+|>)/.test(lines[i])) paragraph.push(lines[i++])
    blocks.push(<p key={blocks.length} className="m-0 whitespace-pre-wrap">{inline(paragraph.join('\n'))}</p>)
  }
  return <div className={cn('flex flex-col gap-2.5 text-[14px] leading-relaxed', className)}>{blocks}</div>
}
