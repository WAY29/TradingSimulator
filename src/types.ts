export interface MarketSymbol {
  id: string
  exchange: string
  symbol: string
  description: string
  type: string
  logoId?: string
  providerId?: string
  sourceLogoId?: string
}

export interface Bar {
  timestamp: number
  open: number
  high: number
  low: number
  close: number
  volume: number
}

export interface Quote {
  id: string
  timestamp: number
  price: number
  change: number
  changePct: number
  volume: number
  direction: number
  priceScale?: number
  logoId?: string
}

export interface Timeframe {
  id: string
  label: string
  name: string
  duration: number | null
  period: {
    multiplier: number
    timespan: string
    text: string
  }
}

export type OrderSide = 'buy' | 'sell'
export type OrderType = 'market' | 'limit' | 'stop'
export type PaperTab = 'positions' | 'orders' | 'order-history' | 'trade-history'
export type TradingMode = 'live' | 'select' | 'replay'

export interface PaperPosition {
  symbol: string
  quantity: number
  averagePrice: number
  marketPrice: number
}

export type ProtectionRole = 'take-profit' | 'stop-loss'

export interface PaperOrder {
  id: number
  groupId: number | null
  symbol: string
  side: OrderSide
  type: OrderType
  role: 'entry' | ProtectionRole
  quantity: number
  price: number
  takeProfit: number | null
  stopLoss: number | null
  reduceOnly: boolean
  parentId: number | null
  ocoGroup: string | null
  status: 'working' | 'filled' | 'cancelled'
  createdAt: number
  activeFrom: number
  activeAt: number
  filledAt?: number
  fillPrice?: number
  fee?: number
  realizedPnl?: number
  openedQuantity?: number
  closedQuantity?: number
  closedAt?: number
}

export interface PaperFillTrade {
  id: number
  parentId?: number | null
  symbol: string
  side: OrderSide
  type: OrderType
  role: PaperOrder['role']
  reduceOnly: boolean
  quantity: number
  price: number
  fee: number
  realizedPnl: number
  openedQuantity: number
  closedQuantity: number
  timestamp: number
  barTimestamp: number
  event?: never
}

export interface PaperResetTrade {
  id: string
  event: 'balance-reset'
  balance: number
  timestamp: number
  symbol?: never
  side?: never
}

export type PaperTrade = PaperFillTrade | PaperResetTrade

export interface PaperAccount {
  initialBalance: number
  feeRate: number
  slippageRate: number
  realizedPnl: number
  positions: Record<string, PaperPosition>
  position?: { quantity: number; averagePrice: number }
  orders: PaperOrder[]
  orderHistory: PaperOrder[]
  trades: PaperTrade[]
  nextOrderId: number
  nextGroupId: number
}

export type PaperOrderInput = Pick<PaperOrder, 'symbol' | 'side' | 'quantity'> & Partial<Pick<PaperOrder,
  'type' | 'price' | 'takeProfit' | 'stopLoss' | 'role' | 'reduceOnly' | 'groupId' | 'parentId' | 'ocoGroup' | 'activeFrom' | 'activeAt'>>

export type PaperBar = Pick<Bar, 'timestamp' | 'open' | 'high' | 'low'> & { close?: number }

export type WatchItem = MarketSymbol & {
  price?: number | null
  change?: number | null
  changePct?: number | null
  volume?: number | null
  direction?: number
}
export type SearchResult = MarketSymbol & { typeSpecs?: string[] }
export type ProtectionField = 'takeProfit' | 'stopLoss'
export type HistoryView = { symbol: string; side: string; page: number }
export type OrderDraft = { side: OrderSide; type: OrderType; quantity: number; price: number; takeProfit: number | null; stopLoss: number | null }
export type ContextMenu = { left: number; top: number; price: number; first: { side: OrderSide; type: OrderType }; second: { side: OrderSide; type: OrderType } }
export type ReplaySession = {
  mode: TradingMode
  symbol: MarketSymbol
  timeframe: string
  replayTimestamp: number
  replayStartTimestamp?: number
  paperTab?: PaperTab
  paperPanelOpen?: boolean
}

export interface ControllerState {
  symbol: MarketSymbol
  timeframe: string
  favoriteTimeframes: string[]
  bars: Bar[]
  mode: TradingMode
  liveHead: number
  replayStart: number
  replayHead: number
  replayEnd: number
  playing: boolean
  timer: number | null
  speed: number
  speedLabel: string
  paper: PaperAccount
  paperTab: PaperTab
  historyView: Partial<Record<PaperTab, HistoryView>>
  orderDraft: OrderDraft | null
  contextPrice: number | null
  watchlist: WatchItem[]
  currentQuote: Quote | null
  eventSource: EventSource | null
  searchMode: 'switch' | 'add'
  searchFilter: string
  searchQuery: string
  searchResults: SearchResult[]
  selectionTimestamp: number | null
  restoredSession: ReplaySession | null
  paperPanelOpen: boolean
  paperPanelHeight: number
  searchOpen: boolean
  loading: boolean
  toast: string
  watchlistStatus: string
  streamStatus: string
  marketDetails: Pick<Quote, 'price' | 'change' | 'changePct' | 'volume' | 'priceScale' | 'logoId'> | null
  speedMenuOpen: boolean
  timeframeMenuOpen: boolean
  pineSource: string
  contextMenu: ContextMenu | null
  replaySelectorLeft: number | null
}
