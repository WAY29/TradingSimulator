import assert from 'node:assert/strict'
import { CHART_LAYOUTS_KEY, newChartLayout, readChartLayouts } from './chart-layouts.ts'
import { DEFAULT_WATCHLIST } from './config.ts'

const symbol = DEFAULT_WATCHLIST[0]
const storage = (value: string | null) => ({ getItem: (key: string) => key === CHART_LAYOUTS_KEY ? value : null })
const migrated = readChartLayouts(storage(null), symbol, 'D')
assert.equal(migrated.items.length, 1)
assert.equal(migrated.items[0].symbol.id, symbol.id)
assert.deepEqual(migrated.items[0].indicators.map(({ name }) => name), ['MA', 'VOL'])

const alternate = newChartLayout(DEFAULT_WATCHLIST[1], '60', '研究')
alternate.pineSource = 'indicator("Test")\nplot(close)'
alternate.indicators[0].calcParams = [8, 16, 24, 48]
alternate.views[`${alternate.symbol.id}/60`] = { barSpace: 12, rightBars: 6, ranges: {}, paneHeights: { VOL: 150 } }
const saved = { version: 1, activeId: alternate.id, items: [migrated.items[0], alternate] }
assert.deepEqual(readChartLayouts(storage(JSON.stringify(saved)), symbol, 'D'), saved)

assert.equal(readChartLayouts(storage('{invalid'), symbol, 'D').items.length, 1)
assert.equal(readChartLayouts(storage(JSON.stringify({ ...saved, version: 2 })), symbol, 'D').items.length, 1)
const damaged = { ...saved, items: [migrated.items[0], { ...alternate, drawings: [null] }] }
assert.deepEqual(readChartLayouts(storage(JSON.stringify(damaged)), symbol, 'D').items.map(({ id }) => id), [migrated.items[0].id])
assert.equal(readChartLayouts(storage(JSON.stringify(damaged)), symbol, 'D').activeId, migrated.items[0].id)
assert.equal(readChartLayouts(storage(JSON.stringify({ ...saved, items: [{ ...alternate, views: { broken: { barSpace: 12, rightBars: 1, ranges: null } } }] })), symbol, 'D').items[0].name, '图表 1')
console.log('chart layout checks passed')
