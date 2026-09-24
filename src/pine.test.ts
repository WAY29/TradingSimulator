import assert from 'node:assert/strict'
import { calculatePine } from './pine.ts'
import { pineLegend, pineSubPrecision } from './pine-renderer.ts'
import { PINE_EXAMPLE } from './pine-example.ts'

const symbol = 'BINANCE:BTCUSDT'
const daily = [1, 2, 3, 4].map((close, index) => ({ timestamp: index * 86_400_000, open: close, high: close, low: close, close, volume: 1 }))
const ema = '//@version=6\nindicator("Replay EMA", overlay=true)\nplot(ta.ema(close, 3), "EMA", color=color.aqua)'
const full = await calculatePine(ema, daily, 'D', symbol)
assert.equal(full.overlay, true)
assert.equal(full.plots[0].color, '#00BCD4')
assert.equal(full.rows.at(-1)?.p0, 3)
const replay = await calculatePine(ema, daily.slice(0, 3), 'D', symbol)
assert.equal(replay.rows.at(-1)?.p0, 2)
assert.equal(replay.rows.length, 3)

const histogram = await calculatePine('//@version=6\nindicator("Delta")\nplot(close - open, "Delta", style=plot.style_histogram)\nhline(0, "Zero")', daily, 'D', symbol)
assert.equal(histogram.overlay, false)
assert.deepEqual(histogram.plots.map(({ style }) => style), ['histogram', 'hline'])
assert.equal(histogram.rows[0].p1, 0)
const dynamic = await calculatePine('//@version=6\nindicator("Colors")\nplot(close, "Colored", color=close > 2 ? color.lime : color.red)', daily, 'D', symbol)
assert.notEqual(dynamic.rows[0].c0, dynamic.rows.at(-1)?.c0)
const identity = '//@version=5\nindicator("Symbol")\nplot(syminfo.ticker == "BTCUSDT" ? 1 : 2)'
assert.equal((await calculatePine(identity, daily, 'D', symbol)).rows.at(-1)?.p0, 1)
assert.equal((await calculatePine(identity, daily, 'D', 'BINANCE:DOGEUSDT')).rows.at(-1)?.p0, 2)
const tick = '//@version=5\nindicator("Tick")\nplot(syminfo.mintick)'
const btcTick = await calculatePine(tick, daily, 'D', symbol, 100)
const dogeTick = await calculatePine(tick, daily, 'D', 'BINANCE:DOGEUSDT', 100_000)
assert.equal(btcTick.rows.at(-1)?.p0, 0.01)
assert.equal(dogeTick.rows.at(-1)?.p0, 0.00001)
assert.equal(pineSubPrecision(btcTick), 4)
assert.equal(pineSubPrecision(dogeTick), 5)
await assert.rejects(calculatePine('//@version=6\nstrategy("No")\nplot(close)', daily, 'D', symbol), /indicator/)

const trending = Array.from({ length: 160 }, (_, index) => ({ timestamp: index * 60_000, open: 2700 + index, high: 2702 + index, low: 2698 + index, close: 2700 + index, volume: 1 }))
const points = await calculatePine(PINE_EXAMPLE, trending, '1', symbol)
assert.equal(points.name, '均线系统')
assert.deepEqual(points.plots.map(({ offset }) => offset), [0, 0, 0, 0, 0, 0, -20, -60, -120])
assert.deepEqual(points.plots.slice(6).map(({ style }) => style), ['circles', 'circles', 'circles'])
assert.equal(points.rows[139].p6, trending[139].low)
assert.equal(points.rows[99].p7, trending[99].low)
assert.equal(points.rows[39].p8, trending[39].low)
assert.equal(points.rows.at(-1)?.p6, undefined)
const legend = (index: number) => pineLegend(points, points.rows, true, index, 2).map(({ value }) => typeof value === 'string' ? value : value.text)
assert.deepEqual(legend(38).slice(6), ['∅', '∅', '∅'])
assert.deepEqual(legend(39).slice(6), ['∅', '∅', '2,737.00'])
assert.deepEqual(legend(99).slice(6), ['∅', '2,797.00', '2,737.00'])
assert.deepEqual(legend(138).slice(6), ['∅', '2,797.00', '2,737.00'])
assert.deepEqual(legend(140).slice(6), ['2,837.00', '2,797.00', '2,737.00'])
const untitled = pineLegend(points, points.rows, true, 140, 2)[6].title
assert.equal(typeof untitled === 'string' ? untitled : untitled.text, '')

const objects = await calculatePine(`//@version=5
indicator('Objects', overlay=true)
if barstate.islast
    line.new(bar_index-2, low[2], bar_index, high)
    box.new(bar_index-2, high, bar_index, low)
    label.new(bar_index, close, 'last')
    t=table.new(position.top_right, 1, 1)
    table.cell(t,0,0,'ok',bgcolor=color.red)
`, trending, '1', symbol)
assert.equal((objects.series.__lines__.data[0].value as unknown[]).length, 1)
assert.equal((objects.series.__boxes__.data[0].value as unknown[]).length, 1)
assert.equal((objects.series.__tables__.data[0].value as { cells: { text: string }[][] }[])[0].cells[0][0].text, 'ok')

const arrow = await calculatePine(`//@version=5
indicator('Arrows', overlay=true)
plotarrow(close > open ? 1 : -1, title='Direction')`, trending, '1', symbol)
assert.equal(arrow.series.Direction.options.style, 'shape')
assert.equal((arrow.series.Direction.data[0].options as { shape: string }).shape, 'shape_arrow_down')
assert.equal((arrow.series.Direction.data[0].options as { location: string }).location, 'AboveBar')
const area = await calculatePine(`//@version=5
indicator('Area')
plot(close, title='Filled', style=plot.style_area)`, trending, '1', symbol)
assert.equal(area.plots[0].style, 'area')

await assert.rejects(calculatePine(`//@version=5
indicator('Unnamed',overlay=true)
plotshape(close>open,style=shape.triangleup)
plotshape(close>open,style=shape.triangledown)`, trending, '1', symbol), /不同的 title/)
console.log('pine checks passed')
