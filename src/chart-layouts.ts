import type { Indicator, Overlay, Point } from 'klinecharts'
import { TIMEFRAMES } from './config.ts'
import type { MarketSymbol } from './types.ts'

export const CHART_LAYOUTS_KEY = 'trading-simulator:chart-layouts'

export interface ChartIndicator {
  name: string
  pane: string
  calcParams?: Indicator['calcParams']
  visible?: boolean
  styles?: Indicator['styles']
  series?: Indicator['series']
  height?: number
}

export type ChartDrawing = Pick<Overlay, 'id' | 'groupId' | 'name' | 'lock' | 'visible' | 'zLevel' | 'mode' | 'styles' | 'extendData'> & {
  symbol: string
  pane: string
  points: Partial<Point>[]
}

export interface ChartView {
  barSpace: number
  rightBars: number
  ranges: Record<string, { from: number; to: number; range: number; realFrom: number; realTo: number; realRange: number }>
  paneHeights?: Record<string, number>
}

export interface ChartLayout {
  id: string
  name: string
  symbol: MarketSymbol
  timeframe: string
  indicators: ChartIndicator[]
  pineSource: string
  drawings: ChartDrawing[]
  views: Record<string, ChartView>
}

export interface ChartLayouts {
  version: 1
  activeId: string
  items: ChartLayout[]
}

export function newChartLayout(symbol: MarketSymbol, timeframe: string, name = '图表 1'): ChartLayout {
  return {
    id: crypto.randomUUID(), name, symbol: { ...symbol }, timeframe,
    indicators: [{ name: 'MA', pane: 'candle_pane' }, { name: 'VOL', pane: 'VOL' }],
    pineSource: '', drawings: [], views: {},
  }
}

export function readChartLayouts(storage: Pick<Storage, 'getItem'>, symbol: MarketSymbol, timeframe: string): ChartLayouts {
  try {
    const saved: unknown = JSON.parse(storage.getItem(CHART_LAYOUTS_KEY) || 'null')
    if (saved && typeof saved === 'object') {
      const value = saved as Partial<ChartLayouts>
      if (value.version === 1 && Array.isArray(value.items)) {
        const items = value.items.filter((item): item is ChartLayout =>
          !!item && typeof item.id === 'string' && typeof item.name === 'string' && item.name.length > 0 &&
          !!item.symbol && typeof item.symbol === 'object' && typeof item.symbol.id === 'string' &&
          /^[A-Z0-9_.-]+:[A-Z0-9_.-]+$/.test(item.symbol.id) && typeof item.symbol.symbol === 'string' &&
          typeof item.symbol.exchange === 'string' && typeof item.symbol.description === 'string' &&
          typeof item.symbol.type === 'string' && TIMEFRAMES.some(({ id }) => id === item.timeframe) &&
          Array.isArray(item.indicators) && typeof item.pineSource === 'string' && Array.isArray(item.drawings) &&
          !!item.views && typeof item.views === 'object' && !Array.isArray(item.views) &&
          item.indicators.every((indicator) => indicator && typeof indicator.name === 'string' && typeof indicator.pane === 'string') &&
          item.drawings.every((drawing) => drawing && typeof drawing.name === 'string' && typeof drawing.symbol === 'string' &&
            typeof drawing.pane === 'string' && Array.isArray(drawing.points) && drawing.points.every((point: unknown) => point && typeof point === 'object')) &&
          Object.values(item.views).every((view) => view && Number.isFinite(view.barSpace) && Number.isFinite(view.rightBars) &&
            view.ranges && typeof view.ranges === 'object' && !Array.isArray(view.ranges) &&
            (view.paneHeights === undefined || (view.paneHeights && typeof view.paneHeights === 'object' && !Array.isArray(view.paneHeights) &&
              Object.values(view.paneHeights).every((height) => Number.isFinite(height) && height > 0))) &&
            Object.values(view.ranges).every((range) => range && ['from', 'to', 'range', 'realFrom', 'realTo', 'realRange']
              .every((key) => Number.isFinite(range[key as keyof typeof range])))),
        )
        if (items.length) return { version: 1, activeId: items.some(({ id }) => id === value.activeId) ? value.activeId! : items[0].id, items }
      }
    }
  } catch {}
  const first = newChartLayout(symbol, timeframe)
  return { version: 1, activeId: first.id, items: [first] }
}
