import assert from 'node:assert/strict'
import type { PaperAccount, PaperFillTrade, PaperOrder } from './types.ts'
import {
  activeOrderNumbers,
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
  normalizePaperFill,
  pagePaperHistory,
  paperTradeHistory,
  resetPaperAccount,
} from './paper.ts'

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
const firstHistory = paperTradeHistory(account.trades, account.orderHistory)
assert.equal(firstHistory.length, 1)
assert.equal(firstHistory[0].event, undefined)
if (firstHistory[0].event !== 'balance-reset') {
  assert.equal(firstHistory[0].id, firstEntry.id)
  assert.equal(firstHistory[0].realizedPnl, 10)
  assert.equal(firstHistory[0].closedAt, 2)
  assert.equal(firstHistory[0].timestamp, 1)
}

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
assert.equal((account.trades[0] as PaperFillTrade).realizedPnl, 10)
assert.equal(paperSummary(account, 90, 'BINANCE:BTCUSDT').unrealizedPnl, 5)
const reversalHistory = paperTradeHistory(account.trades, account.orderHistory)
assert.equal(reversalHistory.filter((trade) => trade.event !== 'balance-reset').length, 3)
const reversedEntry = reversalHistory.find((trade) => trade.id === limit.id)
if (reversedEntry?.event !== 'balance-reset') {
  assert.equal(reversedEntry?.closedQuantity, 2)
  assert.equal(reversedEntry?.realizedPnl, 10)
  assert.equal(reversedEntry?.closedAt, 6)
}

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
delete (legacy as Partial<PaperAccount>).nextGroupId
legacy.orders = [
  { id: 3, parentId: 2, symbol: 'BINANCE:BTCUSDT', reduceOnly: true },
  { id: 4, parentId: 2, symbol: 'BINANCE:BTCUSDT', reduceOnly: true },
  { id: 5, parentId: null, symbol: 'BINANCE:BTCUSDT' },
] as PaperOrder[]
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
assert.equal((offline.trades[0] as PaperFillTrade).price, 90)

const linked = createPaperAccount({ initialBalance: 1_000_000, feeRate: 0.01, slippageRate: 0 })
const older = placePaperOrder(linked, { symbol: 'BINANCE:BTCUSDT', side: 'buy', quantity: 1 }, 100, 0, 1)
const protectedEntry = placePaperOrder(linked, { symbol: 'BINANCE:BTCUSDT', side: 'buy', quantity: 1, takeProfit: 130 }, 120, 0, 2)
processPaperBar(linked, { timestamp: 3, open: 120, high: 131, low: 119 }, 'BINANCE:BTCUSDT', 1)
const linkedHistory = paperTradeHistory(linked.trades, linked.orderHistory)
assert.equal(linked.trades.length, 3)
assert.equal(linkedHistory.length, 2)
const olderRow = linkedHistory.find((trade) => trade.id === older.id)
const protectedRow = linkedHistory.find((trade) => trade.id === protectedEntry.id)
if (olderRow?.event !== 'balance-reset' && protectedRow?.event !== 'balance-reset') {
  assert.equal(olderRow?.closedAt, undefined)
  assert.equal(olderRow?.realizedPnl, -1)
  assert.equal(protectedRow?.closedAt, 3)
  assert.equal(protectedRow?.closedQuantity, 1)
  assert.equal(protectedRow?.fee, 2.5)
  assert.equal(protectedRow?.realizedPnl, 17.5)
}
assert.equal(linkedHistory.reduce((sum, trade) => sum + (trade.event === 'balance-reset' ? 0 : trade.realizedPnl), 0), linked.realizedPnl)

const legacyTrades = linked.trades.filter((trade): trade is PaperFillTrade => trade.event !== 'balance-reset').map((trade) => ({ ...trade }))
const legacyEntry = legacyTrades.find((trade) => trade.id === protectedEntry.id)
const legacyExit = legacyTrades.find((trade) => trade.id !== protectedEntry.id && trade.id !== older.id)
assert.ok(legacyEntry && legacyExit)
delete (legacyEntry as Partial<PaperFillTrade>).openedQuantity
delete (legacyEntry as Partial<PaperFillTrade>).closedQuantity
delete (legacyEntry as Partial<PaperFillTrade>).reduceOnly
delete (legacyExit as Partial<PaperFillTrade>).parentId
const legacyEntryOrder = linked.orderHistory.find((order) => order.id === protectedEntry.id)
const legacyExitOrder = linked.orderHistory.find((order) => order.id === legacyExit.id)
assert.equal(normalizePaperFill(legacyEntry, legacyEntryOrder).openedQuantity, 1)
assert.equal(normalizePaperFill(legacyEntry, legacyEntryOrder).barTimestamp, legacyEntry.timestamp)
assert.equal(normalizePaperFill(legacyExit, legacyExitOrder).closedQuantity, 1)
assert.equal(normalizePaperFill(legacyExit, legacyExitOrder).parentId, protectedEntry.id)
const legacyHistory = paperTradeHistory(legacyTrades, linked.orderHistory)
assert.equal(legacyHistory.length, 2)
const matchedLegacy = legacyHistory.find((trade) => trade.id === protectedEntry.id)
assert.equal(matchedLegacy?.event, undefined)
if (matchedLegacy?.event !== 'balance-reset') {
  assert.equal(matchedLegacy?.closedAt, 3)
  assert.equal(matchedLegacy?.realizedPnl, 17.5)
}

const partial = createPaperAccount({ feeRate: 0.01, slippageRate: 0 })
placePaperOrder(partial, { symbol: 'BINANCE:BTCUSDT', side: 'buy', quantity: 2 }, 100, 0, 1)
placePaperOrder(partial, { symbol: 'BINANCE:BTCUSDT', side: 'sell', quantity: 1, reduceOnly: true }, 110, 1, 2)
const partiallyClosed = paperTradeHistory(partial.trades)[0]
if (partiallyClosed.event !== 'balance-reset') {
  assert.equal(partiallyClosed.closedQuantity, 1)
  assert.equal(partiallyClosed.closedAt, 2)
  assert.equal(partiallyClosed.realizedPnl, 6.9)
}
closePaperPosition(partial, 'BINANCE:BTCUSDT', 90, 2, 3)
const closed = paperTradeHistory(partial.trades)[0]
assert.equal(paperTradeHistory(partial.trades).length, 1)
if (closed.event !== 'balance-reset') {
  assert.equal(closed.closedQuantity, 2)
  assert.equal(closed.closedAt, 3)
  assert.ok(Math.abs(closed.realizedPnl - partial.realizedPnl) < 1e-9)
}

assert.deepEqual([...activeOrderNumbers([
  { groupId: 99 }, { groupId: 50 }, { groupId: 99 }, { groupId: null },
] as PaperOrder[])], [[50, 1], [99, 2]])
assert.deepEqual([...activeOrderNumbers([{ groupId: 99 }] as PaperOrder[])], [[99, 1]])

const rewound = createPaperAccount({ feeRate: 0, slippageRate: 0 })
const later = placePaperOrder(rewound, { symbol: 'BINANCE:BTCUSDT', side: 'buy', quantity: 1 }, 100, 0, 10)
const earlier = placePaperOrder(rewound, { symbol: 'BINANCE:ETHUSDT', side: 'buy', quantity: 1 }, 100, 0, 5)
assert.deepEqual(paperTradeHistory(rewound.trades).map(({ id }) => id), [later.id, earlier.id])

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
