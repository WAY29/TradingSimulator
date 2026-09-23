import assert from 'node:assert/strict'
import { calculatePine, preparePine } from './pine.ts'

const source = '//@version=6\nindicator("Replay EMA", overlay=true)\nplot(ta.ema(close, 3), "EMA", color=color.aqua)'
const program = preparePine(source, 'D')
const bars = [1, 2, 3, 4].map((close, index) => ({ timestamp: index * 86_400_000, open: close, high: close, low: close, close, volume: 1 }))
assert.equal(program.overlay, true)
assert.equal(program.plots[0].color, '#00BCD4')
assert.equal(calculatePine(program, bars).at(-1)?.p0, 3)
assert.equal(calculatePine(program, bars.slice(0, 3)).at(-1)?.p0, 2)
assert.equal(calculatePine(program, bars.slice(0, 3)).length, 3)
const histogram = preparePine('//@version=6\nindicator("Delta")\nplot(close - open, "Delta", style=plot.style_histogram)\nhline(0, "Zero")', 'D')
assert.deepEqual(histogram.plots.map((plot) => plot.style), ['histogram', 'line'])
assert.equal(calculatePine(histogram, bars)[0].p1, 0)
const dynamic = preparePine('//@version=6\nindicator("Colors")\nplot(close, "Colored", color=close > 2 ? color.lime : color.red)', 'D')
const colors = calculatePine(dynamic, bars)
assert.equal(typeof colors[0].c0, 'string')
assert.notEqual(colors[0].c0, colors.at(-1)?.c0)
assert.throws(() => preparePine('//@version=6\nstrategy("No")\nplot(close)', 'D'), /indicator/)
assert.throws(() => preparePine('//@version=6\nindicator("No")\nplot(close, offset=1)', 'D'), /无偏移/)
assert.throws(() => preparePine('//@version=6\nindicator("No")\nplot(close, trackprice=true)', 'D'), /价格跟踪/)
assert.throws(() => preparePine('//@version=6\nindicator("No")\nhline(70, linestyle=hline.style_dotted)', 'D'), /实线/)
console.log('pine checks passed')
