import { run, transpile } from '@nullarch/resin'
import type { TranspileOk } from '@nullarch/resin'
import type { KLineData } from 'klinecharts'

export type PinePlot = { title: string; color: string | null; style: 'line' | 'histogram'; linewidth: number; baseValue: number }
export type PineRow = Record<string, number | string>
export type PineProgram = { compiled: TranspileOk; plots: PinePlot[]; overlay: boolean }

export function preparePine(source: string, timeframe: string): PineProgram {
  if (!source.trim() || source.length > 100_000) throw new Error('请输入不超过 10 万字符的 Pine Script')
  const result = transpile(source, { chartTf: timeframe })
  if (!result.ok) throw new Error(result.errors.join('\n'))
  if (result.isStrategy) throw new Error('只支持 indicator()，不支持 strategy()')
  const viz = result.viz
  if ([viz.bgcolors, viz.barcolors, viz.fills, viz.shapes, viz.chars, viz.arrows, viz.candles, viz.plotbars].some((items) => items.length)) {
    throw new Error('当前只支持 plot() 与 hline()，不支持填充、标记或 K 线绘图')
  }
  if (viz.plots.some((plot) => plot.offset || plot.trackprice || (plot.forceOverlay && !viz.overlay) || !['line', 'histogram', 'columns'].includes(plot.style))) {
    throw new Error('当前只支持无偏移、无价格跟踪的折线与柱状 plot()')
  }
  if (viz.hlines.some((line) => line.price == null)) throw new Error('hline() 需要固定价格')
  if (viz.hlines.some((line) => line.linestyle !== 'solid')) throw new Error('当前只支持实线 hline()')
  const plots: PinePlot[] = [
    ...viz.plots.map((plot) => ({
      title: plot.title, color: plot.color, style: plot.style === 'line' ? 'line' as const : 'histogram' as const,
      linewidth: plot.linewidth, baseValue: plot.histbase,
    })),
    ...viz.hlines.map((line) => ({ title: line.title || String(line.price), color: line.color, style: 'line' as const, linewidth: line.linewidth, baseValue: 0 })),
  ]
  if (!plots.length || plots.length > 8) throw new Error('需要 1 至 8 条 plot() 或 hline() 曲线')
  return { compiled: result, plots, overlay: viz.overlay }
}

export function calculatePine(program: PineProgram, bars: KLineData[]): PineRow[] {
  if (!bars.length) return []
  const { plots, viz } = run(program.compiled, {
    open: bars.map((bar) => bar.open), high: bars.map((bar) => bar.high), low: bars.map((bar) => bar.low),
    close: bars.map((bar) => bar.close), volume: bars.map((bar) => bar.volume ?? 0), time: bars.map((bar) => bar.timestamp),
  })
  if (!viz || viz.drawings.length) throw new Error('当前不支持 Pine 绘图对象')
  return bars.map((_, index) => {
    const row: PineRow = {}
    plots.forEach((plot, plotIndex) => {
      const value = plot.values[index]
      const color = viz.plots[plotIndex]?.colors?.[index]
      if (Number.isFinite(value) && color !== null) row[`p${plotIndex}`] = value
      if (color) row[`c${plotIndex}`] = color
    })
    viz.hlines.forEach((line, lineIndex) => {
      if (line.price != null) row[`p${plots.length + lineIndex}`] = line.price
    })
    return row
  })
}
