// Helpers for the market workspace report (/api/latest). Missing OHLC is never fabricated.
import { isNumber } from './format'

/* eslint-disable @typescript-eslint/no-explicit-any */
export type Item = Record<string, any>
export type MarketReport = { items: Item[]; generatedAt?: string | null; context?: any; evidence?: any; events?: any[]; monitor?: any; alerts?: any[]; eventWarnings?: string[]; empty?: boolean; phase?: string }

export const array = (value: any, key?: string): any[] => Array.isArray(value) ? value : key && Array.isArray(value?.[key]) ? value[key] : []

export type Bar = { time: number; open?: number; high?: number; low?: number; close: number; volume?: number }

export function chartBars(item: Item | undefined, timeframe: 'daily' | 'intraday' = 'daily', type: 'line' | 'candles' = 'line'): Bar[] {
  const interval = item?.period || item?.interval || '1d'
  const raw = timeframe === 'daily' ? item?.dailyHistory || (interval === '1d' ? item?.history : []) : item?.intraday?.history || item?.intradayHistory || (interval !== '1d' ? item?.history : [])
  const result = new Map<number, Bar>()
  for (const row of array(raw)) {
    const stamp = row.timestamp ?? row.date ?? row.time
    const time = typeof stamp === 'number' ? Math.floor(stamp > 1e12 ? stamp / 1000 : stamp) : Math.floor(Date.parse(stamp) / 1000)
    if (!Number.isFinite(time) || !isNumber(row.close) || row.close <= 0) continue
    if (type === 'candles' && (!['open', 'high', 'low'].every((key) => isNumber(row[key]) && row[key] > 0) || row.high < Math.max(row.open, row.close) || row.low > Math.min(row.open, row.close))) continue
    result.set(time, { ...row, time })
  }
  return [...result.values()].sort((a, b) => a.time - b.time)
}

export function quoteStatus(item: Item, { now = Date.now() } = {}) {
  if (item.error) return 'error'
  const freshness = item.freshness || item.dataQuality?.freshness || {}
  const status = freshness.status || item.dataQuality?.status
  if (['stale', 'future', 'expired', 'invalid', 'missing_timestamp', 'unknown-timestamp'].includes(status) || item.dataQuality?.stale) return 'stale'
  if (['closed', 'closed_fresh', 'session_closed', 'fresh_closed', 'market-closed'].includes(status)) return 'closed'
  if (['fresh', 'ok'].includes(status)) {
    const age = now - Date.parse(item.asOf)
    if (!Number.isFinite(age) || age < 0 || age > (freshness.maxAgeSeconds || 300) * 1000) return 'stale'
    return 'fresh'
  }
  return 'unverified'
}

export function crossStatus(item: Item) {
  const status = item.crossCheck?.status
  if (['matched', 'consistent', 'aligned'].includes(status)) return 'aligned'
  if (['divergent', 'currency-mismatch'].includes(status)) return 'conflict'
  if (['single_source', 'single-source', 'fallback', 'unavailable'].includes(status) || !status) return 'single'
  return 'unverified'
}

export function marketIndices(report: MarketReport) {
  const context = report.context || {}
  const rows = context.indices || context.benchmarks || context.marketSnapshot?.indices || []
  return Array.isArray(rows) ? rows : Object.values(rows).flatMap((value) => array(value, 'indices'))
}

export function collectEvidence(report: { events?: any[]; evidence?: any; items?: Item[] }, symbol?: string) {
  const merged = new Map<string, any>()
  const rows = [...array(report.events), ...array(report.evidence, 'items'), ...array(report.items).flatMap((item) =>
    [...array(item.events), ...array(item.evidence), ...array(item.news)].map((entry) => ({ ...entry, symbol: entry.symbol || entry.entity?.symbol || item.symbol })))]
  for (const row of rows) {
    const stock = row.symbol || row.entity?.symbol
    if (symbol && stock !== symbol && !row.affectedSymbols?.includes(symbol)) continue
    const key = row.id || `${row.sourceUrl || row.url}:${row.title}:${row.publishedAt}`
    merged.set(key, { ...row, symbol: stock, ...merged.get(key) })
  }
  return [...merged.values()].sort((a, b) => (Date.parse(b.publishedAt || b.availableAt) || 0) - (Date.parse(a.publishedAt || a.availableAt) || 0))
}

export const nameOf = (item: Item | undefined) => item?.nameZh || item?.name || item?.symbol || ''
export const titleOf = (row: any) => row?.titleZh || row?.title || row?.nameZh || row?.name || row?.messageZh || row?.message || row?.summary || ''
