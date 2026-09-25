import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { pitchforkFigures, rangeBars, regression, TREND_TOOLS } from './drawing-tools.ts'
import type { Bar } from './types.ts'

const bars: Bar[] = [
  { timestamp: 1000, open: 1, high: 3, low: 1, close: 2, volume: 10 },
  { timestamp: 2000, open: 2, high: 4, low: 2, close: 3, volume: 20 },
  { timestamp: 3000, open: 3, high: 5, low: 3, close: 4, volume: 0 },
  { timestamp: 4000, open: 4, high: 6, low: 4, close: 5, volume: 10 },
]

assert.deepEqual(TREND_TOOLS.map(({ name }) => name), [
  'segment', 'rayLine', 'infoLine', 'straightLine', 'trendAngle',
  'horizontalStraightLine', 'horizontalRayLine', 'verticalStraightLine', 'crossLine',
  'priceChannelLine', 'regressionTrend', 'flatChannel', 'disjointChannel',
  'pitchfork', 'schiffPitchfork', 'modifiedSchiffPitchfork', 'insidePitchfork',
])
const icons = new Set([...readFileSync(new URL('../public/icons/tradingview-drawing-tools.svg', import.meta.url), 'utf8').matchAll(/<symbol id="([^"]+)"/g)].map((match) => match[1]))
assert.equal(icons.size, 121)
assert.ok(TREND_TOOLS.every(({ icon }) => icons.has(icon)))
assert.ok(icons.has('toolbar-linetool-group-trend-line-arrow'))
assert.deepEqual(regression(bars), { start: 2, end: 5, deviation: 0 })
assert.equal(regression(bars.slice(0, 1)), null)
assert.deepEqual(rangeBars(bars, 2000, 3000), bars.slice(1, 3))
assert.deepEqual(rangeBars(bars, 0, 3000), [])
assert.deepEqual(rangeBars(bars, 2000, 5000), [])
const points = [{ x: 10, y: 90 }, { x: 30, y: 30 }, { x: 50, y: 70 }]
const standard = pitchforkFigures('pitchfork', points, 100, 100)
const schiff = pitchforkFigures('schiffPitchfork', points, 100, 100)
const modified = pitchforkFigures('modifiedSchiffPitchfork', points, 100, 100)
const inside = pitchforkFigures('insidePitchfork', points, 100, 100)
assert.equal(standard.length, 3)
assert.deepEqual(standard[0].attrs.coordinates[0], points[0])
assert.deepEqual(schiff[0].attrs.coordinates[0], { x: 10, y: 60 })
assert.deepEqual(modified[0].attrs.coordinates[0], { x: 20, y: 60 })
assert.deepEqual(inside[0].attrs.coordinates[0], { x: 40, y: 50 })
assert.deepEqual(inside[0].attrs.coordinates[1], { x: 100, y: 70 })
assert.deepEqual(pitchforkFigures('pitchfork', [points[0], points[1]], 100, 100)[0].attrs.coordinates, points.slice(0, 2))

console.log('Drawing tools tests passed')
