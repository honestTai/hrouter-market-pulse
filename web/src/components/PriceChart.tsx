import { useEffect, useMemo, useRef, useState } from 'react'
import { AreaSeries, CandlestickSeries, ColorType, createChart, HistogramSeries, LineSeries, type UTCTimestamp } from 'lightweight-charts'
import { chartBars, type Item } from '@/lib/market'
import { compact, isNumber, num } from '@/lib/format'
import { prefs } from '@/lib/prefs'
import { Empty } from './ui'
import { t } from '@/lib/i18n'

const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim()

export function PriceChart({ item, timeframe, type, range, averages, height = 320 }: { item: Item; timeframe: 'daily' | 'intraday'; type: 'line' | 'candles'; range: string; averages: boolean; height?: number }) {
  const host = useRef<HTMLDivElement>(null)
  const [hover, setHover] = useState<ReturnType<typeof chartBars>[number] | null>(null)
  const [error, setError] = useState('')
  const all = useMemo(() => chartBars(item, timeframe, type), [item, timeframe, type])
  const rows = useMemo(() => (range === 'all' ? all : all.slice(-Number(range))), [all, range])
  const row = hover || rows.at(-1)
  useEffect(() => {
    setHover(null); setError('')
    if (!host.current || !rows.length) return
    let chart: ReturnType<typeof createChart> | undefined
    let observer: ResizeObserver | undefined
    try {
      const up = css('--c-up') || '#c92a2a', down = css('--c-down') || '#15803d'
      chart = createChart(host.current, {
        width: host.current.clientWidth, height,
        layout: { background: { type: ColorType.Solid, color: css('--c-surface') || '#fff' }, textColor: css('--c-ink-3') || '#6b7180', fontSize: 11, fontFamily: 'Geist Variable, sans-serif', attributionLogo: false },
        grid: { vertLines: { visible: false }, horzLines: { color: css('--c-line') || '#e4e6eb' } },
        rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.12, bottom: 0.25 } },
        timeScale: { borderVisible: false, timeVisible: timeframe === 'intraday', secondsVisible: false, rightOffset: 3, fixLeftEdge: true },
        localization: { locale: 'zh-CN' },
      })
      const direction = (item.changePct ?? 0) >= 0 ? up : down
      const series = type === 'candles'
        ? chart.addSeries(CandlestickSeries, { upColor: up, downColor: down, borderVisible: false, wickUpColor: up, wickDownColor: down, priceLineStyle: 2 })
        : chart.addSeries(AreaSeries, { lineColor: direction, topColor: `${direction}26`, bottomColor: `${direction}00`, lineWidth: 2, priceLineStyle: 2 })
      series.setData(rows.map((bar) => (type === 'candles' ? { time: bar.time as UTCTimestamp, open: bar.open!, high: bar.high!, low: bar.low!, close: bar.close } : { time: bar.time as UTCTimestamp, value: bar.close })) as never)
      const volumes = chart.addSeries(HistogramSeries, { priceFormat: { type: 'volume' }, priceScaleId: 'volume', priceLineVisible: false, lastValueVisible: false })
      volumes.priceScale().applyOptions({ scaleMargins: { top: 0.83, bottom: 0.01 } })
      volumes.setData(rows.filter((bar) => isNumber(bar.volume) && bar.volume! >= 0).map((bar) => ({ time: bar.time as UTCTimestamp, value: bar.volume!, color: `${bar.close >= (bar.open ?? bar.close) ? up : down}40` })))
      if (averages && timeframe === 'daily') {
        for (const [period, color] of [[20, '#d8a04b'], [60, '#7b83c7']] as const) {
          const moving = chart.addSeries(LineSeries, { color, lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false })
          const data: Array<{ time: UTCTimestamp; value: number }> = []
          for (let index = period - 1; index < all.length; index += 1) {
            if (all[index].time < rows[0].time) continue
            data.push({ time: all[index].time as UTCTimestamp, value: all.slice(index - period + 1, index + 1).reduce((sum, bar) => sum + bar.close, 0) / period })
          }
          moving.setData(data)
        }
      }
      const byTime = new Map(rows.map((bar) => [bar.time, bar]))
      chart.subscribeCrosshairMove((param) => setHover(byTime.get(param.time as number) || null))
      chart.timeScale().fitContent()
      observer = new ResizeObserver(() => { if (host.current?.clientWidth) chart?.applyOptions({ width: host.current.clientWidth }) })
      observer.observe(host.current)
    } catch (caught) { setError((caught as Error).message) }
    return () => { observer?.disconnect(); chart?.remove() }
  }, [rows, all, type, timeframe, averages, height, item.changePct, prefs.colors()])
  if (!rows.length) return <Empty title={t('暂无可用图表数据')}>{t('不会用模拟价格或缺失的 OHLC 补齐图表。')}</Empty>
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap gap-3 font-mono text-xs text-ink-2">
        <span>{t('开')} <b className="text-ink">{num(row?.open)}</b></span><span>{t('高')} <b className="text-ink">{num(row?.high)}</b></span><span>{t('低')} <b className="text-ink">{num(row?.low)}</b></span><span>{t('收')} <b className="text-ink">{num(row?.close)}</b></span><span>{t('量')} <b className="text-ink">{compact(row?.volume)}</b></span>
        {averages && timeframe === 'daily' && <><span style={{ color: '#d8a04b' }}>● MA20</span><span style={{ color: '#7b83c7' }}>● MA60</span></>}
      </div>
      {error && <p role="alert" className="m-0 text-xs text-bad">{t('图表暂不可用：{error}', { error })}</p>}
      <div ref={host} style={{ height }} aria-label={t('{symbol} 价格与成交量图', { symbol: item.symbol })} />
      <div className="flex justify-between text-[11px] text-ink-3"><span>{t('{n} 个有效样本', { n: rows.length })} · {timeframe === 'daily' ? t('日线') : t('分时')}</span><span>{t('历史数据，不是预测')}</span></div>
    </div>
  )
}
