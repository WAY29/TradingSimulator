import type { OrderSide, OrderType, PaperAccount, PaperBar, PaperFillTrade, PaperOrder, PaperOrderInput, PaperPosition, PaperResetTrade, PaperTrade } from './types'

export type PaperHistoryTrade = PaperResetTrade | (PaperFillTrade & { closedAt?: number })

export function createPaperAccount({ initialBalance = 100_000, feeRate = 0.001, slippageRate = 0.0005 } = {}): PaperAccount {
  return {
    initialBalance,
    feeRate,
    slippageRate,
    realizedPnl: 0,
    positions: {},
    orders: [],
    orderHistory: [],
    trades: [],
    nextOrderId: 1,
    nextGroupId: 1,
  }
}

export function placePaperOrder(account: PaperAccount, input: PaperOrderInput, marketPrice: number, barIndex: number, timestamp = Date.now()): PaperOrder {
  const quantity = Number(input.quantity)
  const type = input.type || 'market'
  const price = type === 'market' ? marketPrice : Number(input.price)
  validateOrder(input.side, type, quantity, price, marketPrice)
  validateProtection(input.side, price, input.takeProfit, input.stopLoss)
  if (!input.reduceOnly) {
    const position = paperPosition(account, input.symbol).quantity
    const delta = input.side === 'buy' ? quantity : -quantity
    const openingQuantity = !position || Math.sign(position) === Math.sign(delta)
      ? quantity
      : Math.max(0, quantity - Math.abs(position))
    if (openingQuantity * price > paperSummary(account, marketPrice, input.symbol).availableFunds) throw new Error('可用资金不足')
  }

  const order: PaperOrder = {
    id: account.nextOrderId++,
    groupId: input.groupId ?? (!input.reduceOnly ? account.nextGroupId++ : null),
    symbol: input.symbol,
    side: input.side,
    type,
    role: input.role || 'entry',
    quantity,
    price,
    takeProfit: numberOrNull(input.takeProfit),
    stopLoss: numberOrNull(input.stopLoss),
    reduceOnly: Boolean(input.reduceOnly),
    parentId: input.parentId ?? null,
    ocoGroup: input.ocoGroup ?? null,
    status: 'working',
    createdAt: timestamp,
    activeFrom: input.activeFrom ?? barIndex,
    activeAt: input.activeAt ?? timestamp,
  }

  if (type === 'market') {
    const fillPrice = marketPrice * (input.side === 'buy' ? 1 + account.slippageRate : 1 - account.slippageRate)
    fillOrder(account, order, fillPrice, barIndex, timestamp)
  } else {
    account.orders.push(order)
  }
  return order
}

export function processPaperBar(account: PaperAccount, bar: PaperBar, symbol: string, barIndex: number): PaperOrder[] {
  const position = account.positions[symbol]
  if (position && bar.close != null && Number.isFinite(bar.close)) position.marketPrice = bar.close
  const fills: PaperOrder[] = []
  const working = account.orders
    .filter((order) => order.symbol === symbol && order.activeAt <= bar.timestamp)
    .sort((a, b) => Number(b.role === 'stop-loss') - Number(a.role === 'stop-loss'))

  for (const order of working) {
    if (!account.orders.includes(order) || !isTriggered(order, bar)) continue
    const fillPrice = triggeredPrice(order, bar)
    if (fillOrder(account, order, fillPrice, barIndex, bar.timestamp)) fills.push(order)
  }
  return fills
}

export function processPaperBars(account: PaperAccount, bars: PaperBar[], symbol: string): PaperOrder[] {
  return bars.flatMap((bar, index) => processPaperBar(account, bar, symbol, index))
}

export function cancelPaperOrder(account: PaperAccount, id: number, timestamp = Date.now()) {
  const order = account.orders.find((item) => item.id === id)
  if (!order) return false
  finishOrder(account, order, 'cancelled', timestamp)
  return true
}

export function closePaperPosition(account: PaperAccount, symbol: string, marketPrice: number, barIndex: number, timestamp = Date.now()) {
  const quantity = paperPosition(account, symbol).quantity
  if (!quantity) return null
  return placePaperOrder(account, {
    symbol,
    side: quantity > 0 ? 'sell' : 'buy',
    type: 'market',
    quantity: Math.abs(quantity),
    reduceOnly: true,
  }, marketPrice, barIndex, timestamp)
}

export function resetPaperAccount(account: PaperAccount, balance = 100_000, timestamp = Date.now()) {
  account.orders.slice().forEach((order) => finishOrder(account, order, 'cancelled', timestamp))
  account.initialBalance = balance
  account.realizedPnl = 0
  account.positions = {}
  account.nextGroupId = 1
  account.trades.unshift({
    id: `reset-${timestamp}`,
    event: 'balance-reset',
    balance,
    timestamp,
  })
}

export function paperSummary(account: PaperAccount, marketPrice: number, symbol: string) {
  const positions = Object.values(account.positions)
  const unrealizedPnl = positions.reduce((sum, position) => {
    const price = position.symbol === symbol ? marketPrice : position.marketPrice
    return sum + position.quantity * ((price ?? position.averagePrice) - position.averagePrice)
  }, 0)
  const equity = account.initialBalance + account.realizedPnl + unrealizedPnl
  const positionMargin = positions.reduce((sum, position) => {
    const price = position.symbol === symbol ? marketPrice : position.marketPrice
    return sum + Math.abs(position.quantity * (price ?? position.averagePrice))
  }, 0)
  const ordersMargin = account.orders
    .filter((order) => !order.reduceOnly)
    .reduce((sum, order) => sum + order.quantity * order.price, 0)
  return {
    balance: account.initialBalance + account.realizedPnl,
    equity,
    realizedPnl: account.realizedPnl,
    unrealizedPnl,
    positionMargin,
    ordersMargin,
    availableFunds: equity - positionMargin - ordersMargin,
  }
}

export function paperPosition(account: PaperAccount, symbol: string): PaperPosition {
  return account.positions[symbol] || { symbol, quantity: 0, averagePrice: 0, marketPrice: 0 }
}

export function positionProtection(account: PaperAccount, symbol: string) {
  const orders = account.orders.filter((order) => order.symbol === symbol && order.reduceOnly)
  return {
    takeProfit: orders.find((order) => order.role === 'take-profit')?.price ?? null,
    stopLoss: orders.find((order) => order.role === 'stop-loss')?.price ?? null,
  }
}

export function projectedPnl(side: OrderSide, quantity: number, entryPrice: number, exitPrice: number) {
  return Number(quantity) * (Number(exitPrice) - Number(entryPrice)) * (side === 'buy' ? 1 : -1)
}

export function pagePaperHistory<T extends { symbol?: string; side?: string }>(items: T[], { symbol = '', side = '', page = 1, pageSize = 10 }: { symbol?: string; side?: string; page?: number; pageSize?: number } = {}) {
  const filtered = items.filter((item) => (!symbol || item.symbol === symbol) && (!side || item.side === side))
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize))
  const currentPage = Math.min(Math.max(1, page), pageCount)
  return {
    items: filtered.slice((currentPage - 1) * pageSize, currentPage * pageSize),
    page: currentPage,
    pageCount,
    total: filtered.length,
  }
}

export function activeOrderNumbers(orders: PaperOrder[]) {
  const groups = [...new Set(orders.map(({ groupId }) => groupId).filter((id): id is number => id != null))].sort((a, b) => a - b)
  return new Map(groups.map((id, index) => [id, index + 1]))
}

export function normalizePaperFill(trade: PaperFillTrade, order?: PaperOrder): PaperFillTrade {
  const closedQuantity = trade.closedQuantity ?? (trade.openedQuantity != null ? trade.quantity - trade.openedQuantity
    : (trade.reduceOnly ?? order?.reduceOnly ?? (trade.role === 'take-profit' || trade.role === 'stop-loss')) ? trade.quantity : 0)
  return { ...trade, openedQuantity: trade.openedQuantity ?? trade.quantity - closedQuantity,
    closedQuantity, parentId: trade.parentId ?? order?.parentId, barTimestamp: trade.barTimestamp ?? trade.timestamp }
}

export function paperTradeHistory(trades: PaperTrade[], orderHistory: PaperOrder[] = []): PaperHistoryTrade[] {
  type Row = { trade: PaperHistoryTrade; last: number }
  const rows: Row[] = []
  const open = new Map<string, { row: Row; remaining: number }[]>()
  const orders = new Map(orderHistory.map((order) => [order.id, order]))
  ;[...trades].reverse().forEach((trade, index) => {
    if (trade.event === 'balance-reset') {
      open.clear()
      rows.push({ trade, last: index })
      return
    }
    const order = orders.get(trade.id)
    const fill = normalizePaperFill(trade, order)
    if (fill.closedQuantity > 0) {
      const entries = open.get(fill.symbol) || []
      let remaining = fill.closedQuantity
      const parentId = fill.parentId
      while (remaining > 0 && entries.length) {
        const entryIndex = parentId == null ? 0 : Math.max(0, entries.findIndex(({ row }) => row.trade.id === parentId))
        const entry = entries[entryIndex]
        const quantity = Math.min(remaining, entry.remaining)
        const fee = fill.fee * quantity / fill.quantity
        const opening = entry.row.trade as PaperFillTrade & { closedAt?: number }
        opening.fee += fee
        opening.realizedPnl += (fill.realizedPnl + fill.fee) * quantity / fill.closedQuantity - fee
        opening.closedQuantity += quantity
        opening.closedAt = fill.timestamp
        entry.row.last = index
        entry.remaining -= quantity
        remaining -= quantity
        if (!entry.remaining) entries.splice(entryIndex, 1)
      }
      if (remaining > 0) {
        // Older or incomplete histories may lack the matching entry; keep their realized P&L visible.
        const fee = fill.fee * remaining / fill.quantity
        rows.push({ trade: { ...fill, openedQuantity: 0, closedQuantity: remaining, quantity: remaining,
          fee, realizedPnl: (fill.realizedPnl + fill.fee) * remaining / fill.closedQuantity - fee, closedAt: fill.timestamp }, last: index })
      }
    }
    if (fill.openedQuantity > 0) {
      const fee = fill.fee * fill.openedQuantity / fill.quantity
      const row: Row = { trade: { ...fill, quantity: fill.openedQuantity, fee, realizedPnl: -fee, closedQuantity: 0 }, last: index }
      rows.push(row)
      const entries = open.get(fill.symbol) || []
      entries.push({ row, remaining: fill.openedQuantity })
      open.set(fill.symbol, entries)
    }
  })
  const time = (trade: PaperHistoryTrade) => trade.event === 'balance-reset' ? trade.timestamp : trade.closedAt ?? trade.timestamp
  return rows.sort((a, b) => time(b.trade) - time(a.trade) || b.last - a.last).map(({ trade }) => trade)
}

export function normalizePaperAccount(account: PaperAccount, fallbackSymbol?: string) {
  account.positions ||= {}
  const legacy = account.position
  if (legacy) {
    const symbol = account.orders.find(({ reduceOnly }) => reduceOnly)?.symbol
      || account.trades.find((trade) => trade.symbol)?.symbol
      || fallbackSymbol
    if (legacy.quantity && symbol && !account.positions[symbol]) {
      account.positions[symbol] = { symbol, ...legacy, marketPrice: legacy.averagePrice }
    }
    delete account.position
  }
  Object.entries(account.positions).forEach(([symbol, position]) => {
    position.symbol = symbol
    if (!Number.isFinite(position.marketPrice)) position.marketPrice = position.averagePrice
  })
  const groups = new Map<string, number>()
  let next = Number.isInteger(account.nextGroupId) && account.nextGroupId > 0 ? account.nextGroupId : 1
  const groupKey = (order: PaperOrder) => order.parentId == null ? `order:${order.id}` : `order:${order.parentId}`
  account.orders.forEach((order) => {
    if (order.groupId == null || !Number.isInteger(order.groupId) || order.groupId < 1) return
    groups.set(groupKey(order), order.groupId)
    next = Math.max(next, order.groupId + 1)
  })
  account.orders.forEach((order) => {
    const key = groupKey(order)
    if (!groups.has(key)) groups.set(key, next++)
    order.groupId = groups.get(key)!
    if (!Number.isFinite(order.activeAt)) order.activeAt = Number.isFinite(order.createdAt) ? order.createdAt : 0
  })
  account.nextGroupId = next
  return account
}

function validateOrder(side: OrderSide, type: OrderType, quantity: number, price: number, marketPrice: number) {
  if (!['buy', 'sell'].includes(side)) throw new Error('请选择买入或卖出')
  if (!['market', 'limit', 'stop'].includes(type)) throw new Error('订单类型无效')
  if (!Number.isFinite(quantity) || quantity <= 0) throw new Error('数量必须大于 0')
  if (!Number.isFinite(price) || price <= 0) throw new Error('价格无效')
  if (type === 'limit' && ((side === 'buy' && price > marketPrice) || (side === 'sell' && price < marketPrice))) {
    throw new Error('限价单价格方向无效')
  }
  if (type === 'stop' && ((side === 'buy' && price < marketPrice) || (side === 'sell' && price > marketPrice))) {
    throw new Error('止损触发单价格方向无效')
  }
}

function validateProtection(side: OrderSide, entryPrice: number, takeProfit?: number | null, stopLoss?: number | null) {
  const tp = numberOrNull(takeProfit)
  const sl = numberOrNull(stopLoss)
  if (tp != null && ((side === 'buy' && tp <= entryPrice) || (side === 'sell' && tp >= entryPrice))) {
    throw new Error('止盈价方向无效')
  }
  if (sl != null && ((side === 'buy' && sl >= entryPrice) || (side === 'sell' && sl <= entryPrice))) {
    throw new Error('止损价方向无效')
  }
}

function numberOrNull(value: unknown): number | null {
  if (value == null || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function isTriggered(order: PaperOrder, bar: PaperBar) {
  if (order.type === 'limit') return order.side === 'buy' ? bar.low <= order.price : bar.high >= order.price
  if (order.type === 'stop') return order.side === 'buy' ? bar.high >= order.price : bar.low <= order.price
  return false
}

function triggeredPrice(order: PaperOrder, bar: PaperBar) {
  if (order.type === 'limit') return order.side === 'buy' ? Math.min(order.price, bar.open) : Math.max(order.price, bar.open)
  return order.side === 'buy' ? Math.max(order.price, bar.open) : Math.min(order.price, bar.open)
}

function fillOrder(account: PaperAccount, order: PaperOrder, price: number, barIndex: number, timestamp: number) {
  let quantity = order.quantity
  if (order.reduceOnly) {
    const position = paperPosition(account, order.symbol)
    const positionQuantity = position.quantity
    const reduces = (positionQuantity > 0 && order.side === 'sell') || (positionQuantity < 0 && order.side === 'buy')
    if (!reduces || !positionQuantity) {
      finishOrder(account, order, 'cancelled', timestamp)
      return false
    }
    quantity = Math.min(quantity, Math.abs(positionQuantity))
  }

  const fill = applyPositionFill(account, order.symbol, order.side, quantity, price)
  const fee = price * quantity * account.feeRate
  account.realizedPnl -= fee
  order.quantity = quantity
  order.fillPrice = price
  order.filledAt = timestamp
  order.fee = fee
  order.realizedPnl = fill.realizedPnl - fee
  order.openedQuantity = fill.openedQuantity
  order.closedQuantity = quantity - fill.openedQuantity
  finishOrder(account, order, 'filled', timestamp)
  account.trades.unshift({
    id: order.id,
    parentId: order.parentId,
    symbol: order.symbol,
    side: order.side,
    type: order.type,
    role: order.role,
    reduceOnly: order.reduceOnly,
    quantity,
    price,
    fee,
    realizedPnl: order.realizedPnl,
    openedQuantity: fill.openedQuantity,
    closedQuantity: quantity - fill.openedQuantity,
    timestamp,
    barTimestamp: timestamp,
  })

  if (order.ocoGroup) {
    account.orders.filter((item) => item.ocoGroup === order.ocoGroup).forEach((item) => finishOrder(account, item, 'cancelled', timestamp))
  }
  const position = paperPosition(account, order.symbol)
  if (!position.quantity) {
    delete account.positions[order.symbol]
    account.orders.filter((item) => item.symbol === order.symbol && item.reduceOnly).forEach((item) => finishOrder(account, item, 'cancelled', timestamp))
  } else if (!order.reduceOnly && fill.openedQuantity > 0) {
    createProtectionOrders(account, order, fill.openedQuantity, barIndex, timestamp)
  }
  return true
}

function applyPositionFill(account: PaperAccount, symbol: string, side: OrderSide, quantity: number, price: number) {
  const position = account.positions[symbol] ||= { symbol, quantity: 0, averagePrice: 0, marketPrice: price }
  position.marketPrice = price
  const before = position.quantity
  const delta = side === 'buy' ? quantity : -quantity
  if (!before || Math.sign(before) === Math.sign(delta)) {
    position.averagePrice = before
      ? (Math.abs(before) * position.averagePrice + quantity * price) / (Math.abs(before) + quantity)
      : price
    position.quantity = before + delta
    return { openedQuantity: quantity, realizedPnl: 0 }
  }

  const closedQuantity = Math.min(Math.abs(before), quantity)
  const pnl = closedQuantity * (price - position.averagePrice) * Math.sign(before)
  account.realizedPnl += pnl
  position.quantity = before + delta
  if (!position.quantity) position.averagePrice = 0
  else if (Math.sign(position.quantity) !== Math.sign(before)) position.averagePrice = price
  return { openedQuantity: Math.max(0, quantity - closedQuantity), realizedPnl: pnl }
}

function createProtectionOrders(account: PaperAccount, parent: PaperOrder, quantity: number, barIndex: number, timestamp: number) {
  const side = parent.side === 'buy' ? 'sell' : 'buy'
  const ocoGroup = `bracket-${parent.id}`
  const common: Omit<PaperOrder, 'id' | 'type' | 'role' | 'price'> = {
    symbol: parent.symbol,
    side,
    quantity,
    reduceOnly: true,
    parentId: parent.id,
    ocoGroup,
    status: 'working',
    createdAt: timestamp,
    activeFrom: barIndex + 1,
    activeAt: timestamp,
    groupId: parent.groupId,
    takeProfit: null,
    stopLoss: null,
  }
  if (parent.takeProfit != null) account.orders.push({
    ...common, id: account.nextOrderId++, type: 'limit', role: 'take-profit', price: parent.takeProfit,
  })
  if (parent.stopLoss != null) account.orders.push({
    ...common, id: account.nextOrderId++, type: 'stop', role: 'stop-loss', price: parent.stopLoss,
  })
}

function finishOrder(account: PaperAccount, order: PaperOrder, status: PaperOrder['status'], timestamp: number) {
  account.orders = account.orders.filter((item) => item !== order)
  order.status = status
  order.closedAt = timestamp
  account.orderHistory.unshift({ ...order })
}
