import assert from 'node:assert/strict'
import {
  cancelPaperOrder,
  createPaperAccount,
  paperSummary,
  placePaperOrder,
  processPaperBar,
  resetPaperAccount,
} from './paper.js'

const account = createPaperAccount({ feeRate: 0, slippageRate: 0 })
placePaperOrder(account, {
  symbol: 'BINANCE:BTCUSDT', side: 'buy', type: 'market', quantity: 1, takeProfit: 110, stopLoss: 90,
}, 100, 0, 1)
assert.deepEqual(account.position, { quantity: 1, averagePrice: 100 })
assert.equal(account.orders.length, 2)
processPaperBar(account, { timestamp: 2, open: 100, high: 111, low: 95 }, 'BINANCE:BTCUSDT', 1)
assert.equal(account.position.quantity, 0)
assert.equal(account.realizedPnl, 10)
assert.equal(account.orders.length, 0)

const limit = placePaperOrder(account, {
  symbol: 'BINANCE:BTCUSDT', side: 'buy', type: 'limit', quantity: 2, price: 90,
}, 100, 2, 3)
processPaperBar(account, { timestamp: 4, open: 100, high: 102, low: 91 }, 'BINANCE:BTCUSDT', 3)
assert.equal(account.position.quantity, 0)
processPaperBar(account, { timestamp: 5, open: 92, high: 94, low: 89 }, 'BINANCE:BTCUSDT', 4)
assert.equal(account.position.quantity, 2)
assert.equal(account.position.averagePrice, 90)
assert.equal(limit.status, 'filled')

placePaperOrder(account, {
  symbol: 'BINANCE:BTCUSDT', side: 'sell', type: 'market', quantity: 3,
}, 95, 5, 6)
assert.deepEqual(account.position, { quantity: -1, averagePrice: 95 })
assert.equal(account.realizedPnl, 20)
assert.equal(account.trades[0].realizedPnl, 10)
assert.equal(paperSummary(account, 90).unrealizedPnl, 5)

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
assert.equal(conservative.position.quantity, 0)

const tradeCount = account.trades.length
placePaperOrder(account, {
  symbol: 'BINANCE:BTCUSDT', side: 'buy', type: 'limit', quantity: 1, price: 80,
}, 90, 7, 9)
resetPaperAccount(account, 100_000, 10)
assert.equal(account.position.quantity, 0)
assert.equal(account.orders.length, 0)
assert.equal(account.initialBalance, 100_000)
assert.equal(account.realizedPnl, 0)
assert.equal(account.trades.length, tradeCount + 1)
assert.deepEqual(account.trades[0], {
  id: 'reset-10', event: 'balance-reset', balance: 100_000, timestamp: 10,
})
assert.equal(account.orderHistory[0].status, 'cancelled')

console.log('paper trading checks passed')
