export function createPaperAccount({ initialBalance = 100_000, feeRate = 0.001, slippageRate = 0.0005 } = {}) {
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

export function placePaperOrder(account, input, marketPrice, barIndex, timestamp = Date.now()) {
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

  const order = {
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
  }

  if (type === 'market') {
    const fillPrice = marketPrice * (input.side === 'buy' ? 1 + account.slippageRate : 1 - account.slippageRate)
    fillOrder(account, order, fillPrice, barIndex, timestamp)
  } else {
    account.orders.push(order)
  }
  return order
}

export function processPaperBar(account, bar, symbol, barIndex) {
  const position = account.positions[symbol]
  if (position && Number.isFinite(bar.close)) position.marketPrice = bar.close
  const fills = []
  const working = account.orders
    .filter((order) => order.symbol === symbol && order.activeFrom <= barIndex)
    .sort((a, b) => Number(b.role === 'stop-loss') - Number(a.role === 'stop-loss'))

  for (const order of working) {
    if (!account.orders.includes(order) || !isTriggered(order, bar)) continue
    const fillPrice = triggeredPrice(order, bar)
    if (fillOrder(account, order, fillPrice, barIndex, bar.timestamp)) fills.push(order)
  }
  return fills
}

export function cancelPaperOrder(account, id, timestamp = Date.now()) {
  const order = account.orders.find((item) => item.id === id)
  if (!order) return false
  finishOrder(account, order, 'cancelled', timestamp)
  return true
}

export function closePaperPosition(account, symbol, marketPrice, barIndex, timestamp = Date.now()) {
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

export function resetPaperAccount(account, balance = 100_000, timestamp = Date.now()) {
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

export function paperSummary(account, marketPrice, symbol) {
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

export function paperPosition(account, symbol) {
  return account.positions[symbol] || { symbol, quantity: 0, averagePrice: 0, marketPrice: 0 }
}

export function positionProtection(account, symbol) {
  const orders = account.orders.filter((order) => order.symbol === symbol && order.reduceOnly)
  return {
    takeProfit: orders.find((order) => order.role === 'take-profit')?.price ?? null,
    stopLoss: orders.find((order) => order.role === 'stop-loss')?.price ?? null,
  }
}

export function projectedPnl(side, quantity, entryPrice, exitPrice) {
  return Number(quantity) * (Number(exitPrice) - Number(entryPrice)) * (side === 'buy' ? 1 : -1)
}

export function normalizePaperAccount(account, fallbackSymbol) {
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
  const groups = new Map()
  let next = Number.isInteger(account.nextGroupId) && account.nextGroupId > 0 ? account.nextGroupId : 1
  const groupKey = (order) => order.parentId == null ? `order:${order.id}` : `order:${order.parentId}`
  account.orders.forEach((order) => {
    if (!Number.isInteger(order.groupId) || order.groupId < 1) return
    groups.set(groupKey(order), order.groupId)
    next = Math.max(next, order.groupId + 1)
  })
  account.orders.forEach((order) => {
    const key = groupKey(order)
    if (!groups.has(key)) groups.set(key, next++)
    order.groupId = groups.get(key)
  })
  account.nextGroupId = next
  return account
}

function validateOrder(side, type, quantity, price, marketPrice) {
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

function validateProtection(side, entryPrice, takeProfit, stopLoss) {
  const tp = numberOrNull(takeProfit)
  const sl = numberOrNull(stopLoss)
  if (tp != null && ((side === 'buy' && tp <= entryPrice) || (side === 'sell' && tp >= entryPrice))) {
    throw new Error('止盈价方向无效')
  }
  if (sl != null && ((side === 'buy' && sl >= entryPrice) || (side === 'sell' && sl <= entryPrice))) {
    throw new Error('止损价方向无效')
  }
}

function numberOrNull(value) {
  if (value == null || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function isTriggered(order, bar) {
  if (order.type === 'limit') return order.side === 'buy' ? bar.low <= order.price : bar.high >= order.price
  if (order.type === 'stop') return order.side === 'buy' ? bar.high >= order.price : bar.low <= order.price
  return false
}

function triggeredPrice(order, bar) {
  if (order.type === 'limit') return order.side === 'buy' ? Math.min(order.price, bar.open) : Math.max(order.price, bar.open)
  return order.side === 'buy' ? Math.max(order.price, bar.open) : Math.min(order.price, bar.open)
}

function fillOrder(account, order, price, barIndex, timestamp) {
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
  finishOrder(account, order, 'filled', timestamp)
  account.trades.unshift({
    id: order.id,
    symbol: order.symbol,
    side: order.side,
    type: order.type,
    quantity,
    price,
    fee,
    realizedPnl: order.realizedPnl,
    timestamp,
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

function applyPositionFill(account, symbol, side, quantity, price) {
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

function createProtectionOrders(account, parent, quantity, barIndex, timestamp) {
  const side = parent.side === 'buy' ? 'sell' : 'buy'
  const ocoGroup = `bracket-${parent.id}`
  const common = {
    symbol: parent.symbol,
    side,
    quantity,
    reduceOnly: true,
    parentId: parent.id,
    ocoGroup,
    status: 'working',
    createdAt: timestamp,
    activeFrom: barIndex + 1,
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

function finishOrder(account, order, status, timestamp) {
  account.orders = account.orders.filter((item) => item !== order)
  order.status = status
  order.closedAt = timestamp
  account.orderHistory.unshift({ ...order })
}
