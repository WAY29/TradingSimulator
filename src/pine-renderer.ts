import type { IndicatorDrawParams, TooltipLegend } from 'klinecharts'
import type { PinePlot, PineResult, PineRow, PinePoint, PineSeries } from './pine'

type Draw = IndicatorDrawParams<PineRow>
type ObjectState = Record<string, unknown>

const text = (value: unknown): string | null => typeof value === 'string' ? value : null
const numeric = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) ? value : NaN
const value = (series: PineSeries, point: PinePoint | undefined, key: string) => point?.options?.[key] ?? series.options[key]
const color = (series: PineSeries, point?: PinePoint) => text(value(series, point, 'color'))
const style = (series: PineSeries) => (text(series.options.style) ?? 'line').replace(/^style_/, '')
const onPane = (result: PineResult, series: PineSeries, main: boolean) => main === (series.options.overlay === true || (result.overlay && series.options.overlay !== false))
const range = (params: Draw) => ({
  from: Math.max(0, Math.floor(params.visibleRange.from) - 1),
  to: Math.min(params.kLineDataList.length - 1, Math.ceil(params.visibleRange.to) + 1),
})

export function pineLegend(result: PineResult, rows: PineRow[], main: boolean, index: number, precision: number): TooltipLegend[] {
  const format = new Intl.NumberFormat('en-US', { minimumFractionDigits: precision, maximumFractionDigits: precision })
  return result.plots.flatMap((plot, plotIndex) => {
    if (plot.overlay !== main) return []
    const key = `p${plotIndex}`
    let position = index
    if (plot.style === 'circles' || plot.style === 'cross') {
      while (position >= 0 && !Number.isFinite(rows[position]?.[key])) position--
    }
    const price = rows[position]?.[key]
    const ink = rows[position]?.[`c${plotIndex}`]
    const color = typeof ink === 'string' ? ink : plot.color ?? '#8892a0'
    return [{
      title: { text: /^#\d+$/.test(plot.title) ? '' : `${plot.title}: `, color },
      value: { text: typeof price === 'number' && Number.isFinite(price) ? format.format(price) : '∅', color },
    }]
  })
}

export function pineSubPrecision(result: PineResult) {
  let precision = 4
  result.plots.forEach((plot, index) => {
    if (plot.overlay) return
    for (const row of result.rows) {
      const value = row[`p${index}`]
      if (typeof value === 'number' && value !== 0) {
        precision = Math.max(precision, Math.min(8, Math.ceil(-Math.log10(Math.abs(value)))))
      }
    }
  })
  return precision
}

function dash(ctx: CanvasRenderingContext2D, name: unknown) {
  ctx.setLineDash(name === 'style_dotted' || name === 'dotted' ? [2, 3] : name === 'style_dashed' || name === 'dashed' ? [6, 4] : [])
}

function plotPoint(result: PineResult, key: string, target: number) {
  const series = result.series[key]
  if (!series) return NaN
  return numeric(series.data[target - (numeric(series.options.offset) || 0)]?.value)
}

function drawBackground(params: Draw, result: PineResult, main: boolean) {
  const { ctx, xAxis, barSpace, bounding } = params
  const { from, to } = range(params)
  for (const series of Object.values(result.series)) {
    if (!onPane(result, series, main) || style(series) !== 'background') continue
    const offset = numeric(series.options.offset) || 0
    for (let i = from; i <= to; i++) {
      const point = series.data[i - offset]
      const fill = color(series, point)
      if (!point?.value || !fill) continue
      ctx.fillStyle = fill
      ctx.fillRect(xAxis.convertToPixel(i) - barSpace.bar / 2, 0, barSpace.bar, bounding.height)
    }
  }
}

function drawFills(params: Draw, result: PineResult, main: boolean) {
  const { ctx, xAxis, yAxis, barSpace } = params
  const { from, to } = range(params)
  for (const series of Object.values(result.series)) {
    if (style(series) !== 'fill' || !series.plot1 || !series.plot2 || !onPane(result, series, main)) continue
    for (let i = from; i <= to; i++) {
      const a = plotPoint(result, series.plot1, i)
      const b = plotPoint(result, series.plot2, i)
      const fill = color(series, series.data[i])
      if (![a, b].every(Number.isFinite) || !fill) continue
      const top = yAxis.convertToPixel(a)
      const bottom = yAxis.convertToPixel(b)
      ctx.fillStyle = fill
      ctx.fillRect(xAxis.convertToPixel(i) - barSpace.bar / 2, Math.min(top, bottom), barSpace.bar, Math.abs(top - bottom))
    }
  }
}

function drawPlots(params: Draw, result: PineResult, main: boolean) {
  const { ctx, xAxis, yAxis, barSpace, bounding } = params
  const { from, to } = range(params)
  for (const plot of result.plots) {
    if (plot.overlay !== main) continue
    const series = result.series[plot.key]
    if (!series) continue
    if (plot.style === 'hline') {
      const price = numeric(series.data[0]?.value)
      if (!Number.isFinite(price)) continue
      ctx.strokeStyle = plot.color || '#8892a0'
      ctx.lineWidth = plot.linewidth
      dash(ctx, series.options.linestyle)
      const y = yAxis.convertToPixel(price)
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(bounding.width, y); ctx.stroke()
      ctx.setLineDash([])
      continue
    }
    const baseline = yAxis.convertToPixel(plot.baseValue)
    ctx.lineWidth = Math.max(1, plot.linewidth)
    let previous: { x: number; y: number } | null = null
    for (let i = from; i <= to; i++) {
      const point = series.data[i - plot.offset]
      const price = numeric(point?.value)
      const ink = color(series, point)
      if (!Number.isFinite(price) || !ink) {
        if (plot.style.includes('br')) previous = null
        continue
      }
      const x = xAxis.convertToPixel(i)
      const y = yAxis.convertToPixel(price)
      ctx.fillStyle = ink; ctx.strokeStyle = ink
      if (plot.style === 'circles' || plot.style === 'cross' || plot.style === 'stepline_diamond') {
        const radius = Math.max(2, plot.linewidth)
        ctx.beginPath()
        if (plot.style === 'circles') ctx.arc(x, y, radius, 0, Math.PI * 2)
        else if (plot.style === 'cross') {
          ctx.moveTo(x - radius, y - radius); ctx.lineTo(x + radius, y + radius)
          ctx.moveTo(x - radius, y + radius); ctx.lineTo(x + radius, y - radius)
        } else {
          ctx.moveTo(x, y - radius); ctx.lineTo(x + radius, y); ctx.lineTo(x, y + radius)
          ctx.lineTo(x - radius, y); ctx.closePath()
        }
        if (plot.style === 'cross') ctx.stroke(); else ctx.fill()
      }
      if (plot.style === 'area' || plot.style === 'areabr') {
        ctx.beginPath()
        ctx.moveTo(previous?.x ?? x - barSpace.bar / 2, baseline)
        ctx.lineTo(previous?.x ?? x - barSpace.bar / 2, previous?.y ?? y)
        ctx.lineTo(x, y); ctx.lineTo(x, baseline); ctx.closePath(); ctx.fill()
      }
      if (plot.style === 'histogram' || plot.style === 'columns') {
        const width = plot.style === 'columns' ? barSpace.bar * 0.8 : Math.max(1, barSpace.bar * 0.65)
        ctx.fillRect(x - width / 2, Math.min(y, baseline), width, Math.max(1, Math.abs(y - baseline)))
      }
      if (previous && ['line', 'linebr', 'stepline', 'steplinebr', 'stepline_diamond', 'area', 'areabr'].includes(plot.style)) {
        ctx.beginPath(); ctx.moveTo(previous.x, previous.y)
        if (plot.style.startsWith('step')) ctx.lineTo(x, previous.y)
        ctx.lineTo(x, y); ctx.stroke()
      }
      previous = { x, y }
    }
    if (plot.trackprice) {
      for (let i = series.data.length - 1; i >= 0; i--) {
        const point = series.data[i]
        const price = numeric(point?.value)
        const ink = color(series, point)
        if (!Number.isFinite(price) || !ink) continue
        const y = yAxis.convertToPixel(price)
        ctx.strokeStyle = ink; ctx.setLineDash([3, 3]); ctx.beginPath()
        ctx.moveTo(xAxis.convertToPixel(i + plot.offset), y); ctx.lineTo(bounding.width, y); ctx.stroke()
        ctx.setLineDash([])
        break
      }
    }
  }
}

function candle(ctx: CanvasRenderingContext2D, x: number, width: number, prices: number[], colorValue: string, wick = colorValue, border = colorValue, asBar = false) {
  if (prices.length !== 4 || !prices.every(Number.isFinite)) return
  const [open, high, low, close] = prices
  ctx.lineWidth = 1; ctx.strokeStyle = wick
  ctx.beginPath(); ctx.moveTo(x, high); ctx.lineTo(x, low); ctx.stroke()
  ctx.strokeStyle = border
  if (asBar) {
    ctx.beginPath(); ctx.moveTo(x - width / 2, open); ctx.lineTo(x, open)
    ctx.moveTo(x, close); ctx.lineTo(x + width / 2, close); ctx.stroke()
  } else {
    ctx.fillStyle = colorValue
    ctx.fillRect(x - width / 2, Math.min(open, close), width, Math.max(1, Math.abs(close - open)))
  }
}

function drawBars(params: Draw, result: PineResult, main: boolean) {
  const { ctx, xAxis, yAxis, barSpace, kLineDataList } = params
  const { from, to } = range(params)
  for (const series of Object.values(result.series)) {
    const kind = style(series)
    if (!['barcolor', 'candle', 'bar'].includes(kind) || (kind !== 'barcolor' && !onPane(result, series, main)) || (kind === 'barcolor' && !main)) continue
    for (let i = from; i <= to; i++) {
      const point = series.data[i]
      const bar = kLineDataList[i]
      const prices = kind === 'barcolor' && bar ? [bar.open, bar.high, bar.low, bar.close] :
        Array.isArray(point?.value) ? point.value.map(numeric) : []
      const ink = color(series, point) ?? (prices[3] >= prices[0] ? '#22ab94' : '#ef5350')
      if (!point || (kind === 'barcolor' && !color(series, point))) continue
      candle(ctx, xAxis.convertToPixel(i), barSpace.bar * 0.65, prices.map((price) => yAxis.convertToPixel(price)), ink,
        text(value(series, point, 'wickcolor')) || ink, text(value(series, point, 'bordercolor')) || ink, kind === 'bar')
    }
  }
}

function marker(ctx: CanvasRenderingContext2D, x: number, y: number, shape: string, size: number, labelWidth = size) {
  ctx.beginPath()
  if (shape.includes('arrow')) {
    const tip = y + (shape.includes('down') ? size : -size)
    const base = y + (shape.includes('down') ? -size / 4 : size / 4)
    ctx.moveTo(x, tip); ctx.lineTo(x - size * 0.6, base); ctx.lineTo(x + size * 0.6, base)
    ctx.closePath(); ctx.fill()
    ctx.beginPath(); ctx.moveTo(x, base); ctx.lineTo(x, y + (shape.includes('down') ? -size : size)); ctx.stroke()
    return
  }
  if (shape.includes('circle')) { ctx.arc(x, y, size, 0, Math.PI * 2); ctx.fill(); return }
  if (shape.includes('square')) { ctx.fillRect(x - size, y - size, size * 2, size * 2); return }
  if (shape.includes('label')) {
    const up = !shape.includes('down')
    const top = y + (up ? -size / 4 : -size * 0.75)
    ctx.fillRect(x - labelWidth, top, labelWidth * 2, size)
    ctx.moveTo(x, y + (up ? -size : size))
    ctx.lineTo(x - size / 4, up ? top : top + size)
    ctx.lineTo(x + size / 4, up ? top : top + size); ctx.closePath(); ctx.fill()
    return
  }
  if (shape.includes('flag')) {
    ctx.moveTo(x, y + size); ctx.lineTo(x, y - size); ctx.stroke()
    ctx.beginPath(); ctx.moveTo(x, y - size); ctx.lineTo(x + size, y - size / 2)
    ctx.lineTo(x, y); ctx.closePath(); ctx.fill(); return
  }
  if (shape.includes('cross')) {
    if (shape.includes('xcross')) {
      ctx.moveTo(x - size, y - size); ctx.lineTo(x + size, y + size)
      ctx.moveTo(x - size, y + size); ctx.lineTo(x + size, y - size)
    } else {
      ctx.moveTo(x - size, y); ctx.lineTo(x + size, y)
      ctx.moveTo(x, y - size); ctx.lineTo(x, y + size)
    }
    ctx.stroke(); return
  }
  if (shape.includes('diamond')) {
    ctx.moveTo(x, y - size); ctx.lineTo(x + size, y); ctx.lineTo(x, y + size)
    ctx.lineTo(x - size, y); ctx.closePath(); ctx.fill(); return
  }
  const down = shape.includes('down')
  ctx.moveTo(x, y + (down ? size : -size))
  ctx.lineTo(x - size, y + (down ? -size : size))
  ctx.lineTo(x + size, y + (down ? -size : size)); ctx.closePath(); ctx.fill()
}

function drawMarkers(params: Draw, result: PineResult, main: boolean) {
  const { ctx, xAxis, yAxis, kLineDataList, bounding } = params
  const { from, to } = range(params)
  for (const series of Object.values(result.series)) {
    if (!['shape', 'char'].includes(style(series)) || !onPane(result, series, main)) continue
    const offset = numeric(series.options.offset) || 0
    for (let i = from; i <= to; i++) {
      const point = series.data[i - offset]
      if (!point?.value) continue
      const bar = kLineDataList[i]
      if (!bar) continue
      const shape = text(value(series, point, 'shape')) ?? 'shape_triangle_up'
      const location = text(value(series, point, 'location')) ?? 'AboveBar'
      const up = !shape.includes('down')
      const y = location === 'Top' ? (main ? 14 : 32) : location === 'Bottom' ? bounding.height - 14 :
        location === 'BelowBar' ? (main ? yAxis.convertToPixel(bar.low) + 12 : bounding.height - 14) :
          location === 'AboveBar' ? (main ? yAxis.convertToPixel(bar.high) - 12 : 44) :
            yAxis.convertToPixel(numeric(point.value))
      const x = xAxis.convertToPixel(i)
      const label = text(value(series, point, 'text'))
      const size = value(series, point, 'size') === 'size_large' ? 9 : value(series, point, 'size') === 'size_tiny' ? 3 : 6
      ctx.font = '11px sans-serif'
      const labelWidth = shape.includes('label') && label ? Math.max(size, ctx.measureText(label).width / 2 + 5) : size
      ctx.fillStyle = color(series, point) ?? (up ? '#22ab94' : '#ef5350')
      ctx.strokeStyle = ctx.fillStyle
      if (style(series) === 'char') {
        ctx.font = `${Math.max(11, size * 2)}px sans-serif`; ctx.textAlign = 'center'
        ctx.fillText(text(value(series, point, 'char')) ?? '', x, y)
      } else marker(ctx, x, y, shape, size, labelWidth)
      if (label) {
        ctx.font = '11px sans-serif'; ctx.textAlign = 'center'
        ctx.fillStyle = text(value(series, point, 'textcolor')) ?? ctx.fillStyle
        ctx.fillText(label, x, shape.includes('label') ? y + 4 : y + size * 2 + 5)
      }
    }
  }
}

function objects(result: PineResult, key: string): ObjectState[] {
  const values = result.series[key]?.data[0]?.value
  return Array.isArray(values) ? values as ObjectState[] : []
}

function drawObjects(params: Draw, result: PineResult, main: boolean) {
  const { ctx, xAxis, yAxis, kLineDataList, bounding } = params
  const onLayer = (item: ObjectState) => !item._deleted && main === (item.force_overlay === true || result.overlay)
  const x = (position: unknown, xloc: unknown) => {
    const coordinate = numeric(position)
    if (!Number.isFinite(coordinate)) return NaN
    const index = xloc === 'bt' || xloc === 'bar_time'
      ? kLineDataList.findIndex((bar) => bar.timestamp >= coordinate) : coordinate
    return xAxis.convertToPixel(index)
  }
  const linePoint = (s: ObjectState, index: 1 | 2) => ({ x: x(s[`x${index}`], s.xloc), y: yAxis.convertToPixel(numeric(s[`y${index}`])) })
  for (const fill of objects(result, '__linefills__')) {
    if (!onLayer(fill) || !fill.line1 || !fill.line2) continue
    const first = fill.line1 as ObjectState
    const second = fill.line2 as ObjectState
    if (first._deleted || second._deleted) continue
    const a = linePoint(first, 1), b = linePoint(first, 2), c = linePoint(second, 2), d = linePoint(second, 1)
    if (![a, b, c, d].every((point) => Number.isFinite(point.x) && Number.isFinite(point.y))) continue
    ctx.fillStyle = text(fill.color) ?? '#38bdf833'
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.lineTo(c.x, c.y); ctx.lineTo(d.x, d.y); ctx.closePath(); ctx.fill()
  }
  for (const s of objects(result, '__boxes__')) {
    if (!onLayer(s)) continue
    const left = x(s.left, s.xloc), right = x(s.right, s.xloc)
    const top = yAxis.convertToPixel(numeric(s.top)), bottom = yAxis.convertToPixel(numeric(s.bottom))
    if (![left, right, top, bottom].every(Number.isFinite)) continue
    ctx.fillStyle = text(s.bgcolor) ?? '#38bdf833'
    ctx.fillRect(Math.min(left, right), Math.min(top, bottom), Math.abs(right - left), Math.abs(bottom - top))
    ctx.strokeStyle = text(s.border_color) ?? '#38bdf8'
    ctx.lineWidth = numeric(s.border_width) || 1; dash(ctx, s.border_style)
    ctx.strokeRect(Math.min(left, right), Math.min(top, bottom), Math.abs(right - left), Math.abs(bottom - top))
    ctx.setLineDash([])
    if (s.text) {
      ctx.fillStyle = text(s.text_color) ?? '#f0f3fa'; ctx.font = '12px sans-serif'; ctx.textAlign = 'left'
      ctx.fillText(String(s.text), Math.min(left, right) + 4, Math.min(top, bottom) + 14)
    }
  }
  for (const s of objects(result, '__polylines__')) {
    if (!onLayer(s) || !Array.isArray(s.points) || !s.points.length) continue
    ctx.strokeStyle = text(s.line_color) ?? '#38bdf8'
    ctx.lineWidth = numeric(s.line_width) || 1; dash(ctx, s.line_style)
    ctx.beginPath()
    s.points.forEach((point: ObjectState, index: number) => {
      const px = x(point.index ?? point.time, s.xloc)
      const py = yAxis.convertToPixel(numeric(point.price))
      if (index === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py)
    })
    if (s.closed) ctx.closePath()
    if (s.fill_color) { ctx.fillStyle = String(s.fill_color); ctx.fill() }
    ctx.stroke(); ctx.setLineDash([])
  }
  for (const s of objects(result, '__lines__')) {
    if (!onLayer(s)) continue
    const a = linePoint(s, 1), b = linePoint(s, 2)
    if (![a.x, a.y, b.x, b.y].every(Number.isFinite)) continue
    ctx.strokeStyle = text(s.color) ?? '#38bdf8'; ctx.lineWidth = numeric(s.width) || 1; dash(ctx, s.style)
    const slope = b.x === a.x ? 0 : (b.y - a.y) / (b.x - a.x)
    ctx.beginPath()
    ctx.moveTo(s.extend === 'left' || s.extend === 'both' ? 0 : a.x,
      s.extend === 'left' || s.extend === 'both' ? a.y - a.x * slope : a.y)
    ctx.lineTo(s.extend === 'right' || s.extend === 'both' ? bounding.width : b.x,
      s.extend === 'right' || s.extend === 'both' ? b.y + (bounding.width - b.x) * slope : b.y)
    ctx.stroke(); ctx.setLineDash([])
  }
  for (const s of objects(result, '__labels__')) {
    if (!onLayer(s)) continue
    const px = x(s.x, s.xloc), py = yAxis.convertToPixel(numeric(s.y))
    if (!Number.isFinite(px) || !Number.isFinite(py)) continue
    const label = String(s.text ?? '')
    ctx.font = '12px sans-serif'; ctx.textAlign = 'center'
    const width = ctx.measureText(label).width + 12
    ctx.fillStyle = text(s.color) ?? '#2962ff'
    ctx.fillRect(px - width / 2, py - 13, width, 20)
    ctx.fillStyle = text(s.textcolor) ?? '#f0f3fa'
    ctx.fillText(label, px, py + 2)
  }
}

function drawTables(params: Draw, result: PineResult, main: boolean) {
  const { ctx, bounding } = params
  const tableSeries = result.series.__tables__
  if (!tableSeries || !onPane(result, tableSeries, main)) return
  for (const table of objects(result, '__tables__')) {
    if (table._deleted || !Array.isArray(table.cells)) continue
    const rows = table.cells as ObjectState[][]
    const columns = numeric(table.columns) || 0
    if (!columns || !rows.length) continue
    ctx.font = '12px sans-serif'
    const widths = Array.from({ length: columns }, (_, column) =>
      Math.min(160, Math.max(48, ...rows.map((row) => ctx.measureText(String(row[column]?.text ?? '')).width + 16))))
    const width = widths.reduce((a, b) => a + b, 0)
    const height = rows.length * 26
    const position = text(table.position) ?? 'top_right'
    const left = position.includes('left') ? 8 : position.includes('right') ? bounding.width - width - 8 : (bounding.width - width) / 2
    const top = position.includes('bottom') ? bounding.height - height - 8 : position.includes('middle') ? (bounding.height - height) / 2 : 8
    rows.forEach((row, rowIndex) => {
      let px = left
      row.forEach((cell, column) => {
        if (column >= columns) return
        ctx.fillStyle = text(cell.bgcolor) || text(table.bgcolor) || '#1e222d'
        ctx.fillRect(px, top + rowIndex * 26, widths[column], 26)
        ctx.strokeStyle = text(table.border_color) || '#363a45'; ctx.lineWidth = numeric(table.border_width) || 1
        ctx.strokeRect(px, top + rowIndex * 26, widths[column], 26)
        ctx.fillStyle = text(cell.text_color) || '#f0f3fa'
        ctx.font = '12px sans-serif'; ctx.textAlign = 'left'
        ctx.fillText(String(cell.text ?? ''), px + 8, top + rowIndex * 26 + 17, widths[column] - 16)
        px += widths[column]
      })
    })
  }
}

export function drawPine(params: Draw, result: PineResult | null, main: boolean) {
  if (!result || result.rows.length !== params.kLineDataList.length) return true
  const { ctx, bounding } = params
  ctx.save()
  ctx.beginPath(); ctx.rect(0, 0, bounding.width, bounding.height); ctx.clip()
  drawBackground(params, result, main)
  drawFills(params, result, main)
  drawPlots(params, result, main)
  drawBars(params, result, main)
  drawMarkers(params, result, main)
  drawObjects(params, result, main)
  drawTables(params, result, main)
  ctx.restore()
  return true
}
