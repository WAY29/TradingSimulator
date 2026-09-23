import type { MarketSymbol, Timeframe } from './types'

export const START_CONTEXT = 40
export const REPLAY_WINDOW = 240
export const HISTORY_PAGE_SIZE = 10
export const PAPER_PANEL_MIN_HEIGHT = 260
export const INITIAL_CASH = 100_000
export const FEE_RATE = 0.001
export const SLIPPAGE_RATE = 0.0005

export const TIMEFRAMES: Timeframe[] = [
  { id: '1', label: '1m', name: '1 分钟', duration: 60_000, period: { multiplier: 1, timespan: 'minute', text: '1m' } },
  { id: '3', label: '3m', name: '3 分钟', duration: 180_000, period: { multiplier: 3, timespan: 'minute', text: '3m' } },
  { id: '5', label: '5m', name: '5 分钟', duration: 300_000, period: { multiplier: 5, timespan: 'minute', text: '5m' } },
  { id: '15', label: '15m', name: '15 分钟', duration: 900_000, period: { multiplier: 15, timespan: 'minute', text: '15m' } },
  { id: '30', label: '30m', name: '30 分钟', duration: 1_800_000, period: { multiplier: 30, timespan: 'minute', text: '30m' } },
  { id: '45', label: '45m', name: '45 分钟', duration: 2_700_000, period: { multiplier: 45, timespan: 'minute', text: '45m' } },
  { id: '60', label: '1h', name: '1 小时', duration: 3_600_000, period: { multiplier: 1, timespan: 'hour', text: '1h' } },
  { id: '120', label: '2h', name: '2 小时', duration: 7_200_000, period: { multiplier: 2, timespan: 'hour', text: '2h' } },
  { id: '180', label: '3h', name: '3 小时', duration: 10_800_000, period: { multiplier: 3, timespan: 'hour', text: '3h' } },
  { id: '240', label: '4h', name: '4 小时', duration: 14_400_000, period: { multiplier: 4, timespan: 'hour', text: '4h' } },
  { id: 'D', label: 'D', name: '1 天', duration: 86_400_000, period: { multiplier: 1, timespan: 'day', text: '1D' } },
  { id: 'W', label: 'W', name: '1 周', duration: 604_800_000, period: { multiplier: 1, timespan: 'week', text: '1W' } },
  { id: 'M', label: 'M', name: '1 月', duration: null, period: { multiplier: 1, timespan: 'month', text: '1M' } },
]

export const DEFAULT_FAVORITE_TIMEFRAMES = ['5', '15', '30', '60', '240', 'D']
export const MARKET_STORAGE_KEY = 'trading-simulator:selected-market'
export const TIMEFRAME_STORAGE_KEY = 'trading-simulator:selected-timeframe'
export const FAVORITES_STORAGE_KEY = 'trading-simulator:favorite-timeframes'
export const WATCHLIST_STORAGE_KEY = 'trading-simulator:watchlist'

export const DEFAULT_WATCHLIST: MarketSymbol[] = [
  { id: 'BINANCE:BTCUSDT', exchange: 'BINANCE', symbol: 'BTCUSDT', description: 'Bitcoin / TetherUS', type: 'spot' },
  { id: 'BINANCE:ETHUSDT', exchange: 'BINANCE', symbol: 'ETHUSDT', description: 'Ethereum / TetherUS', type: 'spot' },
  { id: 'BINANCE:SOLUSDT', exchange: 'BINANCE', symbol: 'SOLUSDT', description: 'Solana / TetherUS', type: 'spot' },
  { id: 'BINANCE:DOGEUSDT', exchange: 'BINANCE', symbol: 'DOGEUSDT', description: 'Dogecoin / TetherUS', type: 'spot' },
  { id: 'BINANCE:BNBUSDT', exchange: 'BINANCE', symbol: 'BNBUSDT', description: 'BNB / TetherUS', type: 'spot' },
]
