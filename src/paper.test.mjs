import assert from 'node:assert/strict'
import {
  cancelPaperOrder,
  closePaperPosition,
  createPaperAccount,
  paperPosition,
  paperSummary,
  placePaperOrder,
  processPaperBar,
  processPaperBars,
  projectedPnl,
  normalizePaperAccount,
  pagePaperHistory,
  resetPaperAccount,
} from './paper.js'

assert.equal(projectedPnl('buy', 2, 100, 110), 20)
assert.equal(projectedPnl('buy', 2, 100, 90), -20)
assert.equal(projectedPnl('sell', 2, 100, 90), 20)
assert.equal(projectedPnl('sell', 2, 100, 110), -20)

const account = createPaperAccount({ feeRate: 0, slippageRate: 0 })
const firstEntry = placePaperOrder(account, {
  symbol: 'BINANCE:BTCUSDT', side: 'buy', type: 'market', quantity: 1, takeProfit: 110, stopLoss: 90,
}, 100, 0, 1)
assert.deepEqual(paperPosition(account, 'BINANCE:BTCUSDT'), {
  symbol: 'BINANCE:BTCUSDT', quantity: 1, averagePrice: 100, marketPrice: 100,
})
assert.equal(account.orders.length, 2)
assert.equal(firstEntry.groupId, 1)
assert.deepEqual(account.orders.map(({ groupId }) => groupId), [1, 1])
processPaperBar(account, { timestamp: 2, open: 100, high: 111, low: 95 }, 'BINANCE:BTCUSDT', 1)
assert.equal(paperPosition(account, 'BINANCE:BTCUSDT').quantity, 0)
assert.equal(account.realizedPnl, 10)
assert.equal(account.orders.length, 0)

const limit = placePaperOrder(account, {
  symbol: 'BINANCE:BTCUSDT', side: 'buy', type: 'limit', quantity: 2, price: 90,
}, 100, 2, 3)
assert.equal(limit.groupId, 2)
processPaperBar(account, { timestamp: 4, open: 100, high: 102, low: 91 }, 'BINANCE:BTCUSDT', 3)
assert.equal(paperPosition(account, 'BINANCE:BTCUSDT').quantity, 0)
processPaperBar(account, { timestamp: 5, open: 92, high: 94, low: 89 }, 'BINANCE:BTCUSDT', 4)
assert.equal(paperPosition(account, 'BINANCE:BTCUSDT').quantity, 2)
assert.equal(paperPosition(account, 'BINANCE:BTCUSDT').averagePrice, 90)
assert.equal(limit.status, 'filled')

placePaperOrder(account, {
  symbol: 'BINANCE:BTCUSDT', side: 'sell', type: 'market', quantity: 3,
}, 95, 5, 6)
assert.equal(paperPosition(account, 'BINANCE:BTCUSDT').quantity, -1)
assert.equal(paperPosition(account, 'BINANCE:BTCUSDT').averagePrice, 95)
assert.equal(account.realizedPnl, 20)
assert.equal(account.trades[0].realizedPnl, 10)
assert.equal(paperSummary(account, 90, 'BINANCE:BTCUSDT').unrealizedPnl, 5)

const pending = placePaperOrder(account, {
  symbol: 'BINANCE:BTCUSDT', side: 'sell', type: 'limit', quantity: 1, price: 100,
}, 90, 6, 7)
assert.equal(cancelPaperOrder(account, pending.id, 8), true)
assert.equal(pending.status, 'cancelled')

const conservative = createPaperAccount({ feeRate: 0, slippageRate: 0 })
placePaperOrder(conservative, {
  symbol: 'BINANCE:BTCUSDT', side: 'buy', type: 'market', quantity: 1, takeProfit: 110, stopLoss: 90,
}, 100, 0, 1)
processPaperBar(conservative, { timestamp: 2, open: 100, high: 111, low: 89 }, 'BINANCE:BTCUSDT', 1)
assert.equal(conservative.realizedPnl, -10)
assert.equal(paperPosition(conservative, 'BINANCE:BTCUSDT').quantity, 0)

const tradeCount = account.trades.length
placePaperOrder(account, {
  symbol: 'BINANCE:BTCUSDT', side: 'buy', type: 'limit', quantity: 1, price: 80,
}, 90, 7, 9)
resetPaperAccount(account, 100_000, 10)
assert.equal(Object.keys(account.positions).length, 0)
assert.equal(account.orders.length, 0)
assert.equal(account.initialBalance, 100_000)
assert.equal(account.realizedPnl, 0)
assert.equal(account.nextGroupId, 1)
assert.equal(account.trades.length, tradeCount + 1)
assert.deepEqual(account.trades[0], {
  id: 'reset-10', event: 'balance-reset', balance: 100_000, timestamp: 10,
})
assert.equal(account.orderHistory[0].status, 'cancelled')

const legacy = createPaperAccount()
legacy.position = { quantity: 1, averagePrice: 100 }
delete legacy.nextGroupId
legacy.orders = [
  { id: 3, parentId: 2, symbol: 'BINANCE:BTCUSDT', reduceOnly: true },
  { id: 4, parentId: 2, symbol: 'BINANCE:BTCUSDT', reduceOnly: true },
  { id: 5, parentId: null, symbol: 'BINANCE:BTCUSDT' },
]
normalizePaperAccount(legacy)
assert.deepEqual(legacy.orders.map(({ groupId }) => groupId), [1, 1, 2])
assert.equal(legacy.orders.every(({ activeAt }) => Number.isFinite(activeAt)), true)
assert.equal(legacy.nextGroupId, 3)
assert.equal(paperPosition(legacy, 'BINANCE:BTCUSDT').quantity, 1)

const multi = createPaperAccount({ feeRate: 0, slippageRate: 0 })
placePaperOrder(multi, {
  symbol: 'BINANCE:BTCUSDT', side: 'buy', type: 'market', quantity: 1,
}, 100, 0, 1)
placePaperOrder(multi, {
  symbol: 'BINANCE:ETHUSDT', side: 'buy', type: 'market', quantity: 2,
}, 2_000, 0, 1)
const ethOrder = placePaperOrder(multi, {
  symbol: 'BINANCE:ETHUSDT', side: 'buy', type: 'limit', quantity: 1, price: 1_900,
}, 2_000, 0, 2)
processPaperBar(multi, { timestamp: 3, open: 100, high: 105, low: 90, close: 102 }, 'BINANCE:BTCUSDT', 1)
assert.equal(multi.orders.includes(ethOrder), true)
assert.equal(paperPosition(multi, 'BINANCE:BTCUSDT').quantity, 1)
assert.equal(paperPosition(multi, 'BINANCE:ETHUSDT').quantity, 2)
closePaperPosition(multi, 'BINANCE:BTCUSDT', 102, 2, 4)
assert.equal(paperPosition(multi, 'BINANCE:BTCUSDT').quantity, 0)
assert.equal(paperPosition(multi, 'BINANCE:ETHUSDT').quantity, 2)

const offline = createPaperAccount({ feeRate: 0, slippageRate: 0 })
placePaperOrder(offline, {
  symbol: 'BINANCE:BTCUSDT', side: 'buy', type: 'market', quantity: 1, stopLoss: 90,
}, 100, 999, 1)
const offlineFills = processPaperBars(offline, [
  { timestamp: 2, open: 92, high: 94, low: 89, close: 90 },
], 'BINANCE:BTCUSDT')
assert.equal(offlineFills.length, 1)
assert.equal(offlineFills[0].role, 'stop-loss')
assert.equal(paperPosition(offline, 'BINANCE:BTCUSDT').quantity, 0)
assert.equal(offline.trades[0].price, 90)

const history = Array.from({ length: 12 }, (_, index) => ({
  id: index + 1,
  symbol: index % 2 ? 'BINANCE:ETHUSDT' : 'BINANCE:BTCUSDT',
  side: index % 3 ? 'buy' : 'sell',
}))
assert.deepEqual(pagePaperHistory(history, { page: 99 }).items.map(({ id }) => id), [11, 12])
assert.deepEqual(pagePaperHistory(history, { symbol: 'BINANCE:BTCUSDT', side: 'sell' }), {
  items: [history[0], history[6]], page: 1, pageCount: 1, total: 2,
})

console.log('paper trading checks passed')
