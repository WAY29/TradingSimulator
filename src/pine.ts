import { PineTS } from 'pinets'
import type { IProvider } from 'pinets'
import type { KLineData } from 'klinecharts'
import { TIMEFRAMES } from './config.ts'

export type PinePoint = { time: number; value: unknown; title?: string; options?: Record<string, unknown> }
export type PineSeries = {
  title?: string; data: PinePoint[]; options: Record<string, unknown>;
  plot1?: string; plot2?: string
}
export type PinePlot = {
  key: string; title: string; style: string; linewidth: number; offset: number;
  color: string | null; baseValue: number; trackprice: boolean; overlay: boolean
}
export type PineRow = Record<string, number | string>
export type PineResult = { name: string; rows: PineRow[]; series: Record<string, PineSeries>; plots: PinePlot[]; overlay: boolean }

const drawingKeys = new Set(['__labels__', '__lines__', '__boxes__', '__linefills__', '__polylines__', '__tables__'])
const scalarStyles = new Set(['line', 'linebr', 'stepline', 'steplinebr', 'stepline_diamond', 'histogram', 'columns', 'area', 'areabr', 'circles', 'cross', 'hline'])
const canvasStyles = new Set(['fill', 'background', 'barcolor', 'candle', 'bar', 'shape', 'char'])

function text(value: unknown): string | null { return typeof value === 'string' ? value : null }
function number(value: unknown, fallback = 0): number { return typeof value === 'number' && Number.isFinite(value) ? value : fallback }

function periodStart(timestamp: number, timeframe: string) {
  if (timeframe === 'M') {
    const date = new Date(timestamp)
    return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)
  }
  if (timeframe === 'W') {
    const day = Math.floor(timestamp / 86_400_000) * 86_400_000
    return day - ((new Date(day).getUTCDay() + 6) % 7) * 86_400_000
  }
  const duration = TIMEFRAMES.find(({ id }) => id === timeframe)?.duration
  if (!duration) throw new Error(`不支持的周期：${timeframe}`)
  return Math.floor(timestamp / duration) * duration
}

function periodEnd(timestamp: number, timeframe: string) {
  if (timeframe === 'M') {
    const date = new Date(timestamp)
    return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1)
  }
  return timestamp + (TIMEFRAMES.find(({ id }) => id === timeframe)?.duration ?? 0)
}

function localProvider(bars: KLineData[], symbol: string, timeframe: string, priceScale: number): IProvider {
  const [exchange, ticker] = symbol.includes(':') ? symbol.split(':', 2) : ['', symbol]
  const baseDuration = TIMEFRAMES.find(({ id }) => id === timeframe)?.duration
  const marketData = (items: KLineData[], resolution: string) => items.map((bar) => ({
    openTime: bar.timestamp, closeTime: periodEnd(bar.timestamp, resolution),
    open: bar.open, high: bar.high, low: bar.low, close: bar.close, volume: bar.volume ?? 0,
    quoteAssetVolume: bar.turnover ?? 0, numberOfTrades: 0, takerBuyBaseAssetVolume: 0,
    takerBuyQuoteAssetVolume: 0, ignore: 0,
  }))
  return {
    async getMarketData(tickerId, resolution, limit, from, to) {
      if (tickerId !== ticker && tickerId !== symbol) throw new Error(`跨标的 request.security() 暂不支持：${tickerId}`)
      let result = bars
      if (resolution !== timeframe) {
        const targetDuration = TIMEFRAMES.find(({ id }) => id === resolution)?.duration
        if (exchange !== 'BINANCE' || !baseDuration || (targetDuration && (targetDuration < baseDuration || targetDuration % baseDuration))) {
          throw new Error(`无法仅用当前 K 线计算 ${resolution} 周期，请选择更小的图表周期`)
        }
        if (!TIMEFRAMES.some(({ id }) => id === resolution)) throw new Error(`不支持的周期：${resolution}`)
        const grouped: KLineData[] = []
        for (const bar of bars) {
          const start = periodStart(bar.timestamp, resolution)
          const last = grouped.at(-1)
          if (last?.timestamp === start) {
            last.high = Math.max(last.high, bar.high)
            last.low = Math.min(last.low, bar.low)
            last.close = bar.close
            last.volume = (last.volume ?? 0) + (bar.volume ?? 0)
          } else grouped.push({ ...bar, timestamp: start })
        }
        result = grouped
      }
      // The provider has no access to the live cache: Replay passes only bars up to its head.
      if (from != null) result = result.filter((bar) => bar.timestamp >= from)
      if (to != null) result = result.filter((bar) => bar.timestamp <= to)
      if (limit != null) result = result.slice(-limit)
      return marketData(result, resolution)
    },
    async getSymbolInfo() {
      return { ticker, tickerid: symbol, prefix: exchange, main_tickerid: symbol,
        timezone: 'Etc/UTC', session: '24x7', minmove: 1, pricescale: priceScale, mintick: 1 / priceScale } as Awaited<ReturnType<IProvider['getSymbolInfo']>>
    },
    configure() {},
  }
}

export async function calculatePine(source: string, bars: KLineData[], timeframe: string, symbol: string, priceScale = 100): Promise<PineResult> {
  if (!source.trim() || source.length > 100_000) throw new Error('请输入不超过 10 万字符的 Pine Script')
  if (!bars.length) throw new Error('图表暂无 K 线数据')
  const context = await new PineTS(localProvider(bars, symbol, timeframe, priceScale > 0 && Number.isFinite(priceScale) ? priceScale : 100), symbol, timeframe, bars.length).run(source)
  if (context.strategy && Object.keys(context.strategy).length) throw new Error('只支持 indicator()，不支持 strategy()')
  const series = context.plots as Record<string, PineSeries>
  const overlay = series.__labels__?.options.overlay === true
  const rows: PineRow[] = bars.map(() => ({}))
  const plots: PinePlot[] = []
  for (const [key, item] of Object.entries(series)) {
    if (drawingKeys.has(key)) continue
    if (item.data.length !== bars.length) throw new Error(`绘图 ${key} 的输出被合并；请给 plotshape/plotchar/plotarrow 不同的 title，且不要组合未命名的 bgcolor()/barcolor()`)
    const style = text(item.options.style)?.replace(/^style_/, '') ?? 'line'
    if (!scalarStyles.has(style) && !canvasStyles.has(style)) throw new Error(`暂不支持绘图 ${key} 的 ${style} 样式`)
    if (!scalarStyles.has(style)) continue
    const index = plots.length
    const offset = number(item.options.offset)
    const plot: PinePlot = {
      key, title: item.title || key, style, linewidth: number(item.options.linewidth, 1), offset,
      color: text(item.options.color), baseValue: number(item.options.histbase),
      trackprice: item.options.trackprice === true, overlay: item.options.overlay === true || overlay && item.options.overlay !== false,
    }
    plots.push(plot)
    item.data.forEach((point, barIndex) => {
      if (point.time !== bars[barIndex].timestamp) throw new Error(`绘图 ${key} 的时间与图表 K 线不匹配`)
      const target = barIndex + offset
      if (target < 0 || target >= bars.length || typeof point.value !== 'number' || !Number.isFinite(point.value)) return
      rows[target][`p${index}`] = point.value
      const color = text(point.options?.color) ?? plot.color
      if (color) rows[target][`c${index}`] = color
    })
  }
  return { name: context.indicator?.title?.trim() || 'Pine Script', rows, series, plots, overlay }
}
