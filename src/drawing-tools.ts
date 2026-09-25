import { registerOverlay } from 'klinecharts'
import type { Chart, Coordinate, OverlayFigure, OverlayTemplate } from 'klinecharts'
import type { Bar } from './types.ts'

export const TREND_TOOLS = [
  { name: 'segment', label: '趋势线', icon: 'LineToolTrendLine' },
  { name: 'rayLine', label: '射线', icon: 'LineToolRay' },
  { name: 'infoLine', label: '信息线', icon: 'LineToolInfoLine' },
  { name: 'straightLine', label: '延长线', icon: 'LineToolExtended' },
  { name: 'trendAngle', label: '趋势角度', icon: 'LineToolTrendAngle' },
  { name: 'horizontalStraightLine', label: '水平线', icon: 'LineToolHorzLine' },
  { name: 'horizontalRayLine', label: '水平射线', icon: 'LineToolHorzRay' },
  { name: 'verticalStraightLine', label: '垂直线', icon: 'LineToolVertLine' },
  { name: 'crossLine', label: '横线', icon: 'LineToolCrossLine' },
  { name: 'priceChannelLine', label: '平行通道', icon: 'LineToolParallelChannel' },
  { name: 'regressionTrend', label: '回归趋势', icon: 'LineToolRegressionTrend' },
  { name: 'flatChannel', label: '平顶/平底', icon: 'LineToolFlatBottom' },
  { name: 'disjointChannel', label: '不相交通道', icon: 'LineToolDisjointAngle' },
  { name: 'pitchfork', label: '分叉线', icon: 'LineToolPitchfork' },
  { name: 'schiffPitchfork', label: '希夫干草叉', icon: 'LineToolSchiffPitchfork2' },
  { name: 'modifiedSchiffPitchfork', label: '改良希夫干草叉', icon: 'LineToolSchiffPitchfork' },
  { name: 'insidePitchfork', label: '内部分叉线', icon: 'LineToolInsidePitchfork' },
] as const

export type TrendToolName = typeof TREND_TOOLS[number]['name']

export function regression(bars: Bar[]) {
  if (bars.length < 2) return null
  const count = bars.length
  const mean = bars.reduce((sum, bar) => sum + bar.close, 0) / count
  const mid = (count - 1) / 2
  const slope = bars.reduce((sum, bar, index) => sum + (index - mid) * (bar.close - mean), 0) /
    bars.reduce((sum, _bar, index) => sum + (index - mid) ** 2, 0)
  const start = mean - slope * mid
  const deviation = Math.sqrt(bars.reduce((sum, bar, index) => sum + (bar.close - start - index * slope) ** 2, 0) / count)
  return { start, end: start + (count - 1) * slope, deviation }
}

export function rangeBars(bars: Bar[], first?: number, second?: number) {
  if (!bars.length || first == null || second == null || Math.min(first, second) < bars[0].timestamp ||
    Math.max(first, second) > bars.at(-1)!.timestamp) return []
  return bars.filter(({ timestamp }) => timestamp >= Math.min(first, second) && timestamp <= Math.max(first, second))
}

const line = (coordinates: Coordinate[], styles?: Record<string, unknown>): OverlayFigure =>
  ({ type: 'line', attrs: { coordinates }, styles })

const label = (text: string, coordinate: Coordinate): OverlayFigure => ({
  type: 'text', ignoreEvent: true,
  attrs: { x: coordinate.x, y: coordinate.y - 12, text, align: 'center', baseline: 'bottom' },
  styles: { size: 12, color: '#f0f3fa', backgroundColor: '#20242d', paddingLeft: 5, paddingRight: 5, paddingTop: 3, paddingBottom: 3 },
})

export function pitchforkFigures(name: string, points: Coordinate[], width: number, height: number): OverlayFigure[] {
  if (points.length < 2) return []
  if (points.length < 3) return [line(points)]
  const [a, b, c] = points
  const midpoint = { x: (b.x + c.x) / 2, y: (b.y + c.y) / 2 }
  const origin = name === 'insidePitchfork' ? { ...midpoint } : { ...a }
  if (name === 'schiffPitchfork' || name === 'modifiedSchiffPitchfork') origin.y = (a.y + b.y) / 2
  if (name === 'modifiedSchiffPitchfork') origin.x = (a.x + b.x) / 2
  const base = name === 'insidePitchfork' ? { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } : origin
  const dx = (name === 'insidePitchfork' ? c.x : midpoint.x) - base.x
  const dy = (name === 'insidePitchfork' ? c.y : midpoint.y) - base.y
  if (!dx && !dy) return []
  const endpoint = (point: Coordinate): Coordinate => dx
    ? { x: dx > 0 ? width : 0, y: point.y + dy / dx * ((dx > 0 ? width : 0) - point.x) }
    : { x: point.x, y: dy > 0 ? height : 0 }
  return [line([origin, endpoint(origin)]), line([b, endpoint(b)]), line([c, endpoint(c)])]
}

export function registerTrendOverlays(getChart: () => Chart | null, getBars: () => Bar[]) {
  const template = (name: string, totalStep: number, createPointFigures: NonNullable<OverlayTemplate['createPointFigures']>): OverlayTemplate =>
    ({ name, totalStep, needDefaultPointFigure: true, createPointFigures })
  const available = (timestamps: (number | undefined)[]) => {
    const bars = getBars()
    return bars.length && timestamps.every((timestamp) => timestamp != null && timestamp <= bars.at(-1)!.timestamp) ? bars : []
  }
  const coordinate = (timestamp: number, value: number): Coordinate | null => {
    const point = getChart()?.convertToPixel({ timestamp, value }, { paneId: 'candle_pane' }) as Partial<Coordinate> | undefined
    return point && Number.isFinite(point.x) && Number.isFinite(point.y) ? point as Coordinate : null
  }

  registerOverlay(template('infoLine', 3, ({ overlay, coordinates, precision }) => {
    const [first, second] = overlay.points
    const bars = rangeBars(available([first?.timestamp, second?.timestamp]), first?.timestamp, second?.timestamp)
    if (!bars.length || coordinates.length < 2 || first.value == null || second.value == null) return []
    const delta = second.value - first.value
    const count = bars.length - 1
    const percent = first.value ? `${(delta / Math.abs(first.value) * 100).toFixed(2)}%` : '--'
    const duration = Math.abs(second.timestamp! - first.timestamp!)
    const span = duration >= 86_400_000 ? `${(duration / 86_400_000).toFixed(1)}天` : duration >= 3_600_000 ? `${(duration / 3_600_000).toFixed(1)}小时` : `${Math.round(duration / 60_000)}分钟`
    return [line(coordinates), label(`${delta >= 0 ? '+' : ''}${delta.toFixed(precision.price)} (${percent}) · ${Math.max(count, 0)}根 · ${span}`,
      { x: (coordinates[0].x + coordinates[1].x) / 2, y: (coordinates[0].y + coordinates[1].y) / 2 })]
  }))
  registerOverlay(template('trendAngle', 3, ({ overlay, coordinates, precision }) => {
    const [first, second] = overlay.points
    const bars = rangeBars(available([first?.timestamp, second?.timestamp]), first?.timestamp, second?.timestamp)
    if (!bars.length || coordinates.length < 2 || first.value == null || second.value == null) return []
    const count = bars.length - 1
    const degrees = Math.atan2(coordinates[0].y - coordinates[1].y, coordinates[1].x - coordinates[0].x) * 180 / Math.PI
    const slope = count > 0 ? `${((second.value - first.value) / count).toFixed(precision.price)}/根` : '--/根'
    return [line(coordinates), label(`${degrees.toFixed(1)}° · ${slope}`, coordinates[1])]
  }))
  registerOverlay(template('crossLine', 2, ({ overlay, coordinates, bounding }) => {
    if (!available([overlay.points[0]?.timestamp]).length || !coordinates.length) return []
    const { x, y } = coordinates[0]
    return [line([{ x, y: 0 }, { x, y: bounding.height }]), line([{ x: 0, y }, { x: bounding.width, y }])]
  }))
  registerOverlay(template('flatChannel', 4, ({ overlay, coordinates }) => {
    if (!available(overlay.points.map(({ timestamp }) => timestamp)).length) return []
    if (coordinates.length < 3) return coordinates.length === 2 ? [line(coordinates)] : []
    return [line(coordinates.slice(0, 2)), line([{ x: coordinates[0].x, y: coordinates[2].y }, { x: coordinates[1].x, y: coordinates[2].y }])]
  }))
  registerOverlay(template('disjointChannel', 5, ({ overlay, coordinates }) => {
    if (!available(overlay.points.map(({ timestamp }) => timestamp)).length || coordinates.length < 2) return []
    return [line(coordinates.slice(0, 2)), ...(coordinates.length >= 4 ? [line(coordinates.slice(2, 4))] : [])]
  }))
  for (const name of ['pitchfork', 'schiffPitchfork', 'modifiedSchiffPitchfork', 'insidePitchfork']) {
    registerOverlay(template(name, 4, ({ overlay, coordinates, bounding }) =>
      available(overlay.points.map(({ timestamp }) => timestamp)).length
        ? pitchforkFigures(name, coordinates, bounding.width, bounding.height) : []))
  }
  registerOverlay(template('regressionTrend', 3, ({ overlay }) => {
    const [first, second] = overlay.points
    const selected = rangeBars(available([first?.timestamp, second?.timestamp]), first?.timestamp, second?.timestamp)
    const fit = regression(selected)
    if (!fit) return []
    return [0, 2, -2].flatMap((factor) => {
      const start = coordinate(selected[0].timestamp, fit.start + factor * fit.deviation)
      const end = coordinate(selected.at(-1)!.timestamp, fit.end + factor * fit.deviation)
      return start && end ? [line([start, end], factor ? { style: 'dashed' } : undefined)] : []
    })
  }))
}
