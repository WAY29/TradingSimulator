import { KLineChartPro } from '@klinecharts/pro'
import { ActionType, init as getKLineChart } from 'klinecharts'
import {
  cancelPaperOrder,
  closePaperPosition,
  createPaperAccount,
  normalizePaperAccount,
  pagePaperHistory,
  paperSummary,
  paperPosition,
  placePaperOrder,
  positionProtection,
  processPaperBar,
  processPaperBars,
  projectedPnl,
  resetPaperAccount,
} from './paper.js'
import '@klinecharts/pro/dist/klinecharts-pro.css'
import './style.css'

const START_CONTEXT = 40
const REPLAY_WINDOW = 240
const HISTORY_PAGE_SIZE = 10
const PAPER_PANEL_MIN_HEIGHT = 260
const INITIAL_CASH = 100_000
const FEE_RATE = 0.001
const SLIPPAGE_RATE = 0.0005
const TIMEFRAMES = [
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
const DEFAULT_FAVORITE_TIMEFRAMES = ['5', '15', '30', '60', '240', 'D']
const MARKET_STORAGE_KEY = 'trading-simulator:selected-market'
const TIMEFRAME_STORAGE_KEY = 'trading-simulator:selected-timeframe'
const FAVORITES_STORAGE_KEY = 'trading-simulator:favorite-timeframes'
const WATCHLIST_STORAGE_KEY = 'trading-simulator:watchlist'
const DEFAULT_WATCHLIST = [
  { id: 'BINANCE:BTCUSDT', exchange: 'BINANCE', symbol: 'BTCUSDT', description: 'Bitcoin / TetherUS', type: 'spot' },
  { id: 'BINANCE:ETHUSDT', exchange: 'BINANCE', symbol: 'ETHUSDT', description: 'Ethereum / TetherUS', type: 'spot' },
  { id: 'BINANCE:SOLUSDT', exchange: 'BINANCE', symbol: 'SOLUSDT', description: 'Solana / TetherUS', type: 'spot' },
  { id: 'BINANCE:DOGEUSDT', exchange: 'BINANCE', symbol: 'DOGEUSDT', description: 'Dogecoin / TetherUS', type: 'spot' },
  { id: 'BINANCE:BNBUSDT', exchange: 'BINANCE', symbol: 'BNBUSDT', description: 'BNB / TetherUS', type: 'spot' },
]

const state = {
  symbol: loadSelectedMarket(),
  timeframe: loadSelectedTimeframe(),
  favoriteTimeframes: loadFavoriteTimeframes(),
  bars: [],
  mode: 'live',
  liveHead: 0,
  replayStart: 0,
  replayHead: 0,
  replayEnd: 0,
  playing: false,
  timer: null,
  speed: 700,
  paper: createPaperAccount({ initialBalance: INITIAL_CASH, feeRate: FEE_RATE, slippageRate: SLIPPAGE_RATE }),
  paperTab: 'positions',
  historyView: {
    'order-history': { symbol: '', side: '', page: 1 },
    'trade-history': { symbol: '', side: '', page: 1 },
  },
  orderDraft: null,
  contextPrice: null,
  watchlist: loadSavedWatchlist(),
  currentQuote: null,
  eventSource: null,
  searchMode: 'switch',
  searchFilter: '',
  searchResults: [],
  selectionTimestamp: null,
  focusTimestamp: null,
  restoredSession: null,
  paperPanelOpen: false,
}

document.querySelector('#app').innerHTML = `
  <main class="terminal">
    <header class="tv-toolbar">
      <div class="toolbar-left">
        <img class="app-logo" src="/trading-simulator-logo.png" alt="TradingSimulator" title="TradingSimulator" />
        <button class="market-identity" id="symbol-button" title="切换标的">
          <span class="asset-icon" id="header-icon"></span>
          <strong id="current-symbol">BTCUSDT</strong>
          <small id="current-exchange">BINANCE · D</small>
          <span class="header-price" id="header-price">--</span>
          <span class="header-change" id="header-change">--</span>
          <span class="chevron">⌄</span>
        </button>
        <div class="timeframe-control">
          <div class="timeframe-favorites" id="timeframe-favorites"></div>
          <button class="timeframe-more" id="timeframe-more" title="时间周期" aria-label="时间周期"><span class="chevron-icon" aria-hidden="true"></span></button>
          <div class="timeframe-menu" id="timeframe-menu" hidden></div>
        </div>
        <button class="toolbar-button text-button" id="indicators" title="指标">fx&nbsp; 指标</button>
        <button class="toolbar-button replay-toggle" id="replay-toggle" title="Bar Replay">◁&nbsp; Replay</button>
      </div>
      <div class="toolbar-right">
        <button class="paper-toggle" id="paper-toggle" title="模拟交易">模拟交易</button>
      </div>
    </header>
    <div class="tv-main">
      <div id="chart" class="chart-host"></div>
      <div class="replay-watermark" id="replay-watermark" hidden><span>◀◀</span> Replay</div>
      <div class="replay-future-mask" id="replay-future-mask" hidden></div>
      <div class="replay-selector-line" id="replay-selector-line" hidden><span>✂</span></div>
      <div class="trade-layer" id="trade-layer"></div>
      <div class="chart-context-menu" id="chart-context-menu" hidden></div>
      <aside class="watchlist-panel">
        <div class="watchlist-header">
          <strong>自选表</strong>
          <span id="watchlist-status" title="行情更新时间">--:--:--</span>
          <button id="add-symbol" title="添加到自选表" aria-label="添加到自选表">＋</button>
        </div>
        <div class="watchlist-tabs"><span>Symbol</span><span>Last</span><span>Chg</span><span>Chg%</span><span></span></div>
        <div id="watchlist-list" class="watchlist-list"></div>
        <div id="market-details" class="market-details"></div>
      </aside>
    </div>
    <footer class="replay-dock" hidden>
      <div class="replay-controls">
        <button class="replay-select" id="select-bar" title="选择起始 K 线"><span>⇤</span> 选择 K 线 <small>⌄</small></button>
        <span class="replay-divider"></span>
        <button class="icon-button play" id="play" title="播放" aria-label="播放">▶</button>
        <button class="icon-button" id="step-forward" title="前进" aria-label="前进">▷│</button>
        <div class="speed-control">
          <button class="replay-text-button" id="speed" title="回放速度">1x</button>
          <div class="speed-menu" id="speed-menu" hidden>
            <button data-speed="1200" data-label="0.5x">0.5x</button>
            <button class="active" data-speed="700" data-label="1x">1x</button>
            <button data-speed="350" data-label="2x">2x</button>
            <button data-speed="175" data-label="4x">4x</button>
          </div>
        </div>
        <span class="replay-divider"></span>
        <button class="icon-button" id="jump-live" title="跳转到实时图表" aria-label="跳转到实时图表">│▷</button>
      </div>
      <button class="replay-exit" id="exit-replay" title="退出 Bar Replay" aria-label="退出 Bar Replay">×</button>
    </footer>
    <section class="paper-panel" id="paper-panel" hidden>
      <div class="paper-resize-handle" id="paper-resize-handle" role="separator" tabindex="0" aria-orientation="horizontal" aria-label="调整模拟交易面板高度" aria-valuemin="260" aria-valuenow="260"></div>
      <div class="paper-panel-header"><strong>模拟交易</strong></div>
      <div class="paper-account" id="paper-account"></div>
      <nav class="paper-nav" id="paper-tabs">
        <button class="active" data-paper-tab="positions">持仓 <span id="positions-count">0</span></button>
        <button data-paper-tab="orders">当前委托 <span id="orders-count">0</span></button>
        <button data-paper-tab="order-history">委托历史</button>
        <button data-paper-tab="trade-history">成交历史</button>
      </nav>
      <div class="paper-table" id="paper-table"></div>
    </section>
    <div class="symbol-dialog" id="symbol-dialog" hidden>
      <section class="symbol-modal" role="dialog" aria-modal="true" aria-labelledby="symbol-dialog-title">
        <div class="symbol-dialog-heading">
          <strong id="symbol-dialog-title">商品代码搜索</strong>
          <button id="close-search" title="关闭" aria-label="关闭">×</button>
        </div>
        <div class="symbol-search-bar">
          <span aria-hidden="true">⌕</span>
          <input id="symbol-search" type="search" autocomplete="off" placeholder="搜索市场" aria-label="搜索标的" />
        </div>
        <div class="symbol-filters" id="symbol-filters">
          <button class="active" data-filter="">全部</button>
          <button data-filter="stock">股票</button>
          <button data-filter="futures">期货</button>
          <button data-filter="forex">外汇</button>
          <button data-filter="crypto">加密货币</button>
          <button data-filter="index">指数</button>
          <button data-filter="economic">经济</button>
        </div>
        <div class="symbol-results" id="symbol-results"></div>
      </section>
    </div>
    <div class="loading" id="loading" aria-label="加载中"><span></span><span></span><span></span></div>
    <div class="toast" id="toast" role="status"></div>
  </main>
`

let chart
let coreChart
let tradeLayerFrame = null
let liveSubscriber = null
let searchTimer = null
let persistTimer = null
let persistErrorShown = false

function currentTimeframe() {
  return TIMEFRAMES.find(({ id }) => id === state.timeframe)
}

function loadSelectedMarket() {
  try {
    const saved = JSON.parse(localStorage.getItem(MARKET_STORAGE_KEY))
    if (validSymbol(saved)) return saved
  } catch {}
  return { ...DEFAULT_WATCHLIST[0] }
}

function loadSelectedTimeframe() {
  const saved = localStorage.getItem(TIMEFRAME_STORAGE_KEY)
  return TIMEFRAMES.some(({ id }) => id === saved) ? saved : 'D'
}

function saveChartPreferences() {
  const { id, exchange, symbol, description, type, logoId, providerId, sourceLogoId } = state.symbol
  localStorage.setItem(MARKET_STORAGE_KEY, JSON.stringify({ id, exchange, symbol, description, type, logoId, providerId, sourceLogoId }))
  localStorage.setItem(TIMEFRAME_STORAGE_KEY, state.timeframe)
}

function loadFavoriteTimeframes() {
  try {
    const saved = JSON.parse(localStorage.getItem(FAVORITES_STORAGE_KEY))
    if (Array.isArray(saved)) return saved.filter((id) => TIMEFRAMES.some((item) => item.id === id))
  } catch {}
  return [...DEFAULT_FAVORITE_TIMEFRAMES]
}

function saveFavoriteTimeframes() {
  localStorage.setItem(FAVORITES_STORAGE_KEY, JSON.stringify(state.favoriteTimeframes))
}

function renderTimeframes() {
  document.querySelector('#timeframe-favorites').innerHTML = state.favoriteTimeframes.map((id) => {
    const item = TIMEFRAMES.find((timeframe) => timeframe.id === id)
    return `<button data-timeframe="${id}" class="${id === state.timeframe ? 'active' : ''}">${item.label}</button>`
  }).join('')
  document.querySelector('#timeframe-menu').innerHTML = TIMEFRAMES.map((item) => `
    <div class="timeframe-option ${item.id === state.timeframe ? 'active' : ''}">
      <button class="timeframe-pick" data-timeframe="${item.id}"><span>${item.name}</span><small>${item.label}</small></button>
      <button class="timeframe-favorite" data-favorite="${item.id}" title="${state.favoriteTimeframes.includes(item.id) ? '取消收藏' : '收藏'}" aria-label="${state.favoriteTimeframes.includes(item.id) ? '取消收藏' : '收藏'}">${state.favoriteTimeframes.includes(item.id) ? '★' : '☆'}</button>
    </div>
  `).join('')
}

const replayDatafeed = {
  async searchSymbols(search = '') {
    const symbol = chartSymbol(state.symbol)
    return symbol.ticker.toLowerCase().includes(search.toLowerCase()) ? [symbol] : []
  },
  async getHistoryKLineData(_symbol, _period, from, to) {
    const inReplay = state.mode === 'replay'
    const end = inReplay ? state.replayHead : state.liveHead
    const focusIndex = !inReplay && state.focusTimestamp != null
      ? state.bars.findIndex(({ timestamp }) => timestamp === state.focusTimestamp)
      : -1
    const focused = focusIndex >= 0
    const start = inReplay
      ? state.replayStart
      : focused ? Math.max(0, focusIndex - Math.floor(REPLAY_WINDOW / 2)) : Math.max(0, end - REPLAY_WINDOW + 1)
    const visibleEnd = inReplay
      ? end
      : focused ? Math.min(state.bars.length - 1, focusIndex + Math.floor(REPLAY_WINDOW / 2)) : end
    const firstVisible = state.bars[start]
    const endTimestamp = state.bars[visibleEnd]?.timestamp
    if (!firstVisible || !endTimestamp) return []
    const loadingOlder = to < firstVisible.timestamp
    if (loadingOlder && from < state.bars[0].timestamp) await loadOlderBars()
    const minimum = loadingOlder ? from : Math.max(from, firstVisible.timestamp)
    return state.bars.filter((bar) => bar.timestamp >= minimum && bar.timestamp <= Math.min(to, endTimestamp))
  },
  subscribe(_symbol, _period, callback) {
    liveSubscriber = callback
  },
  unsubscribe() {
    liveSubscriber = null
  },
}

function loadSavedWatchlist() {
  try {
    const saved = JSON.parse(localStorage.getItem(WATCHLIST_STORAGE_KEY))
    if (Array.isArray(saved) && saved.length) return saved.filter(validSymbol).slice(0, 20)
  } catch {}
  return DEFAULT_WATCHLIST.map((item) => ({ ...item }))
}

function validSymbol(item) {
  return item && /^[A-Z0-9_.-]+:[A-Z0-9_.-]+$/.test(item.id) && item.symbol && item.exchange
}

function saveWatchlist() {
  const metadata = state.watchlist.map(({ id, exchange, symbol, description, type, logoId, providerId, sourceLogoId }) => ({
    id, exchange, symbol, description, type, logoId, providerId, sourceLogoId,
  }))
  localStorage.setItem(WATCHLIST_STORAGE_KEY, JSON.stringify(metadata))
}

function chartSymbol(item) {
  return {
    exchange: item.id.split(':')[0], market: item.type || 'crypto', name: item.description,
    shortName: item.symbol, ticker: item.symbol, priceCurrency: quoteCurrency(item.symbol), type: (item.type || 'spot').toUpperCase(),
  }
}

async function loadBars(id = state.symbol.id, timeframe = state.timeframe, range = 1000, to, closed = false) {
  const params = new URLSearchParams({ symbol: id, timeframe, range })
  if (to != null) params.set('to', to)
  if (closed) params.set('closed', '1')
  const response = await fetch(`/api/tradingview/history?${params}`)
  if (!response.ok) throw new Error(`TradingView HTTP ${response.status}`)
  const { bars } = await response.json()
  if (to == null && !closed && bars.length < START_CONTEXT + 2) throw new Error('Not enough TradingView bars')
  return bars
}

async function catchUpPaperOrders() {
  const ordersBySymbol = new Map()
  state.paper.orders.forEach((order) => {
    const activeAt = Number(order.activeAt)
    if (!Number.isFinite(activeAt)) return
    ordersBySymbol.set(order.symbol, Math.min(ordersBySymbol.get(order.symbol) ?? activeAt, activeAt))
  })
  for (const [symbol, activeAt] of ordersBySymbol) {
    const elapsed = Math.max(0, Date.now() - activeAt)
    // Older gaps use coarser bars; exact intrabar ordering would require persisted minute data.
    const timeframe = TIMEFRAMES.find(({ duration }) => duration && elapsed <= duration * 900)?.id || 'M'
    try {
      const bars = await loadBars(symbol, timeframe, 1000, undefined, true)
      processPaperBars(state.paper, bars.filter((bar) => bar.timestamp >= activeAt), symbol)
    } catch (error) {
      console.error(`Paper order catch-up failed for ${symbol}:`, error)
      showToast('历史订单补偿失败')
    }
  }
}

async function loadOlderBars() {
  const symbol = state.symbol.id
  const timeframe = state.timeframe
  const firstTimestamp = state.bars[0]?.timestamp
  if (!firstTimestamp) return
  let bars
  try {
    bars = await loadBars(symbol, timeframe, 500, Math.floor(firstTimestamp / 1000))
  } catch (error) {
    console.error('Historical data load failed:', error)
    showToast('更早的 K 线加载失败')
    return
  }
  if (symbol !== state.symbol.id || timeframe !== state.timeframe) return
  const older = bars.filter(({ timestamp }) => timestamp < firstTimestamp)
  if (!older.length) return
  state.bars.unshift(...older)
  state.liveHead += older.length
  state.replayStart += older.length
  state.replayHead += older.length
  state.replayEnd += older.length
}

function setupReplay(bars) {
  state.bars = bars
  state.liveHead = bars.length - 1
  state.replayEnd = bars.findLastIndex((bar) => nextBarTimestamp(bar.timestamp) <= Date.now())
  state.replayStart = Math.max(0, state.replayEnd - REPLAY_WINDOW + 1)
  state.replayHead = state.liveHead
}

function chartWindowData() {
  const end = state.mode === 'replay' ? state.replayHead : state.liveHead
  const focusIndex = state.mode !== 'replay' && state.focusTimestamp != null
    ? state.bars.findIndex(({ timestamp }) => timestamp === state.focusTimestamp)
    : -1
  const start = focusIndex >= 0
    ? Math.max(0, focusIndex - Math.floor(REPLAY_WINDOW / 2))
    : state.mode === 'replay' ? state.replayStart : Math.max(0, end - REPLAY_WINDOW + 1)
  const visibleEnd = focusIndex >= 0
    ? Math.min(state.bars.length - 1, focusIndex + Math.floor(REPLAY_WINDOW / 2))
    : end
  return state.bars.slice(start, visibleEnd + 1)
}

function renderChart() {
  const period = currentTimeframe().period
  chart = new KLineChartPro({
    container: document.querySelector('#chart'), theme: 'dark', locale: 'zh-CN', timezone: 'Asia/Shanghai',
    drawingBarVisible: true, symbol: chartSymbol(state.symbol), period, periods: [period],
    mainIndicators: ['MA'], subIndicators: ['VOL'], datafeed: replayDatafeed,
  })
  bindChartInteractions()
}

function bindChartInteractions() {
  const root = document.querySelector('#chart [k-line-chart-id]')
  if (!root) return window.requestAnimationFrame(bindChartInteractions)
  root.id ||= root.getAttribute('k-line-chart-id')
  coreChart = getKLineChart(root)
  coreChart.subscribeAction(ActionType.OnCrosshairChange, (data) => {
    if (state.mode !== 'select') return
    const timestamp = actionTimestamp(data)
    if (!timestamp) return
    state.selectionTimestamp = timestamp
    positionReplaySelector(timestamp)
  })
  ;[ActionType.OnZoom, ActionType.OnScroll, ActionType.OnVisibleRangeChange, ActionType.OnPaneDrag]
    .forEach((type) => coreChart.subscribeAction(type, syncTradeLayerPosition))
  root.addEventListener('wheel', syncTradeLayerPosition, { passive: true })
  root.addEventListener('mousemove', (event) => {
    if (state.mode !== 'select') return
    const timestamp = pointerTimestamp(event, root)
    if (!timestamp) return
    state.selectionTimestamp = timestamp
    positionReplaySelector(timestamp)
  })
  root.addEventListener('click', (event) => {
    if (state.mode !== 'select') return
    const timestamp = pointerTimestamp(event, root) || state.selectionTimestamp
    if (timestamp) selectReplayBar(timestamp)
  })
  root.addEventListener('contextmenu', (event) => openChartContextMenu(event, root))
  renderTradeLayer()
}

function pointerTimestamp(event, root) {
  const point = coreChart?.convertFromPixel(
    { x: event.clientX - root.getBoundingClientRect().left },
    { paneId: 'candle_pane' },
  )
  return point?.timestamp ?? null
}

function actionTimestamp(data) {
  return data?.data?.timestamp ?? data?.kLineData?.timestamp ?? data?.timestamp ?? null
}

function positionReplaySelector(timestamp) {
  const coordinate = coreChart?.convertToPixel({ timestamp }, { paneId: 'candle_pane', absolute: true })
  if (!Number.isFinite(coordinate?.x)) return
  const chartOffset = document.querySelector('#chart canvas').getBoundingClientRect().left - document.querySelector('.tv-main').getBoundingClientRect().left
  const left = coordinate.x + chartOffset
  const line = document.querySelector('#replay-selector-line')
  const mask = document.querySelector('#replay-future-mask')
  line.style.left = `${left}px`
  mask.style.left = `${left}px`
  line.hidden = false
  mask.hidden = state.mode !== 'select'
}

function refreshChart() {
  chart.setPeriod({ ...currentTimeframe().period })
}

function nextBarTimestamp(timestamp) {
  const timeframe = currentTimeframe()
  if (timeframe.id !== 'M') return timestamp + timeframe.duration
  const date = new Date(timestamp)
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1)
}

function quoteBarTimestamp(timestamp) {
  const timeframe = currentTimeframe()
  if (timeframe.id === 'M') {
    const date = new Date(timestamp)
    return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)
  }
  if (timeframe.id === 'W') {
    const date = new Date(timestamp)
    const dayStart = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
    return dayStart - ((date.getUTCDay() + 6) % 7) * 86_400_000
  }
  return Math.floor(timestamp / timeframe.duration) * timeframe.duration
}

function currentBar() {
  return state.bars[state.mode === 'replay' ? state.replayHead : state.liveHead]
}

function currentBarIndex() {
  return state.mode === 'replay' ? state.replayHead : state.liveHead
}

async function loadPaperState() {
  const response = await fetch('/api/paper/state', { cache: 'no-store' })
  if (!response.ok) throw new Error(`Paper state HTTP ${response.status}`)
  return response.json()
}

function applyPaperState(saved) {
  if (!saved?.paper || !saved.session) return
  const empty = createPaperAccount({ initialBalance: INITIAL_CASH, feeRate: FEE_RATE, slippageRate: SLIPPAGE_RATE })
  state.paper = {
    ...empty,
    ...saved.paper,
    positions: saved.paper.positions || empty.positions,
    orders: saved.paper.orders || [],
    orderHistory: saved.paper.orderHistory || [],
    trades: saved.paper.trades || [],
  }
  normalizePaperAccount(state.paper, saved.session.symbol?.id)
  state.paperTab = saved.session.paperTab || 'positions'
  state.paperPanelOpen = Boolean(saved.session.paperPanelOpen)
  if (saved.session.mode === 'replay' && validSymbol(saved.session.symbol) && TIMEFRAMES.some(({ id }) => id === saved.session.timeframe)) {
    state.symbol = saved.session.symbol
    state.timeframe = saved.session.timeframe
    state.restoredSession = saved.session
    saveChartPreferences()
  }
}

function restoreReplaySession() {
  const session = state.restoredSession
  if (!session) return false
  const index = state.bars.findIndex(({ timestamp }) => timestamp === session.replayTimestamp)
  if (index < START_CONTEXT || index > state.replayEnd) return false
  const savedStart = state.bars.findIndex(({ timestamp }) => timestamp === session.replayStartTimestamp)
  state.replayStart = savedStart >= 0 ? savedStart : Math.max(0, index - REPLAY_WINDOW + 1)
  state.replayHead = index
  state.mode = 'replay'
  state.selectionTimestamp = session.replayTimestamp
  return true
}

function paperStateSnapshot() {
  return {
    version: 2,
    paper: state.paper,
    session: {
      mode: state.mode === 'replay' ? 'replay' : 'live',
      symbol: state.symbol,
      timeframe: state.timeframe,
      replayTimestamp: state.mode === 'replay' ? currentBar().timestamp : null,
      replayStartTimestamp: state.mode === 'replay' ? state.bars[state.replayStart]?.timestamp : null,
      paperTab: state.paperTab,
      paperPanelOpen: state.paperPanelOpen,
    },
  }
}

async function persistPaperState({ keepalive = false } = {}) {
  window.clearTimeout(persistTimer)
  persistTimer = null
  try {
    const response = await fetch('/api/paper/state', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(paperStateSnapshot()),
      keepalive,
    })
    if (!response.ok) throw new Error(`Paper state HTTP ${response.status}`)
    persistErrorShown = false
  } catch (error) {
    console.error('Paper state save failed:', error)
    if (!persistErrorShown) showToast('模拟交易状态保存失败')
    persistErrorShown = true
  }
}

function queuePaperStateSave() {
  window.clearTimeout(persistTimer)
  persistTimer = window.setTimeout(persistPaperState, 120)
}

function updateReplayView() {
  renderPaperPanel()
  renderTradeLayer()
  updateMarketDetails()
  document.querySelector('#play').disabled = state.mode !== 'replay' || state.replayHead >= state.replayEnd
  document.querySelector('#step-forward').disabled = state.mode !== 'replay' || state.replayHead >= state.replayEnd
  document.querySelector('#jump-live').disabled = state.mode !== 'replay'
  queuePaperStateSave()
}

function setPaperPanelOpen(open, { save = true } = {}) {
  state.paperPanelOpen = open
  document.querySelector('#paper-panel').hidden = !open
  document.querySelector('.terminal').classList.toggle('paper-open', open)
  document.querySelector('#paper-toggle').classList.toggle('active', open)
  if (open) renderPaperPanel()
  window.dispatchEvent(new Event('resize'))
  if (save) queuePaperStateSave()
}

function setPaperPanelHeight(height, notify = true) {
  const terminal = document.querySelector('.terminal')
  const max = Math.max(PAPER_PANEL_MIN_HEIGHT, terminal.clientHeight - 180)
  const next = Math.min(max, Math.max(PAPER_PANEL_MIN_HEIGHT, Math.round(height)))
  terminal.style.setProperty('--paper-panel-height', `${next}px`)
  const handle = document.querySelector('#paper-resize-handle')
  handle.setAttribute('aria-valuemax', max)
  handle.setAttribute('aria-valuenow', next)
  if (notify) window.dispatchEvent(new Event('resize'))
}

function beginPaperPanelResize(event) {
  event.preventDefault()
  const handle = event.currentTarget
  handle.setPointerCapture(event.pointerId)
  document.body.classList.add('resizing-paper-panel')
  const move = ({ clientY }) => setPaperPanelHeight(document.querySelector('.terminal').getBoundingClientRect().bottom - clientY)
  const stop = () => {
    document.body.classList.remove('resizing-paper-panel')
    handle.removeEventListener('pointermove', move)
    handle.removeEventListener('pointerup', stop)
    handle.removeEventListener('pointercancel', stop)
  }
  handle.addEventListener('pointermove', move)
  handle.addEventListener('pointerup', stop)
  handle.addEventListener('pointercancel', stop)
}

function resizePaperPanelWithKeyboard(event) {
  if (!['ArrowUp', 'ArrowDown'].includes(event.key)) return
  event.preventDefault()
  const current = Number.parseFloat(getComputedStyle(document.querySelector('.terminal')).getPropertyValue('--paper-panel-height'))
  setPaperPanelHeight(current + (event.key === 'ArrowUp' ? 20 : -20))
}

function renderPaperPanel() {
  const price = currentBar().close
  const summary = paperSummary(state.paper, price, state.symbol.id)
  document.querySelector('#paper-account').innerHTML = [
    ['账户余额', summary.balance],
    ['账户净值', summary.equity],
    ['已实现盈亏', summary.realizedPnl],
    ['未实现盈亏', summary.unrealizedPnl],
    ['可用资金', summary.availableFunds],
    ['委托占用', summary.ordersMargin],
  ].map(([label, value], index) => `
    <span><small>${label}${index === 0 ? '<button class="balance-reset" data-reset-balance title="重置模拟账户" aria-label="重置模拟账户">↻</button>' : ''}</small><strong class="${label.includes('盈亏') ? signClass(value) : ''}">${formatMoney(value)}</strong></span>
  `).join('')
  document.querySelector('#positions-count').textContent = Object.values(state.paper.positions).filter(({ quantity }) => quantity).length
  document.querySelector('#orders-count').textContent = state.paper.orders.length
  document.querySelectorAll('#paper-tabs button').forEach((button) => {
    button.classList.toggle('active', button.dataset.paperTab === state.paperTab)
  })
  const table = document.querySelector('#paper-table')
  table.classList.toggle('history', state.paperTab.endsWith('history'))
  table.innerHTML = paperTable(state.paperTab, price)
}

function paperTable(tab, price) {
  if (tab === 'positions') return positionsTable(price)
  if (tab === 'orders') return ordersTable(state.paper.orders, true)
  return historyTable(tab, tab === 'order-history' ? state.paper.orderHistory : state.paper.trades)
}

function historyTable(tab, items) {
  const view = state.historyView[tab]
  const symbols = [...new Set(items.map(({ symbol }) => symbol).filter(Boolean))].sort()
  const result = pagePaperHistory(items, { ...view, pageSize: HISTORY_PAGE_SIZE })
  view.page = result.page
  const emptyLabel = items.length ? '没有符合条件的记录' : tab === 'order-history' ? '暂无委托历史' : '暂无成交记录'
  const rows = tab === 'order-history'
    ? ordersTable(result.items, false, symbols, emptyLabel)
    : tradesTable(result.items, symbols, emptyLabel)
  return `
    <div class="history-content">${rows}</div>
    ${result.pageCount > 1 ? `<div class="history-pagination">
      <button data-history-page="-1" title="上一页" aria-label="上一页" ${result.page === 1 ? 'disabled' : ''}>‹</button>
      <span>${result.page} / ${result.pageCount}</span>
      <button data-history-page="1" title="下一页" aria-label="下一页" ${result.page === result.pageCount ? 'disabled' : ''}>›</button>
    </div>` : ''}`
}

function historyFilterHeader(label, field, symbols) {
  const view = state.historyView[state.paperTab]
  const options = field === 'symbol'
    ? symbols.map((symbol) => [symbol, symbol])
    : [['buy', '买入'], ['sell', '卖出']]
  return `<span class="history-column-label">${label}
    <details class="history-filter ${view[field] ? 'active' : ''}">
      <summary title="筛选${label}" aria-label="筛选${label}">⌕</summary>
      <div class="history-filter-menu" data-history-filter-menu="${field}">
        <button class="${view[field] ? '' : 'active'}" data-history-filter-value="">全部${label}</button>
        ${options.map(([value, text]) => `<button class="${view[field] === value ? 'active' : ''}" data-history-filter-value="${value}">${text}</button>`).join('')}
      </div>
    </details>
  </span>`
}

function positionHistoryFilter(details) {
  if (!details.open) return
  document.querySelectorAll('.history-filter[open]').forEach((item) => {
    if (item !== details) item.removeAttribute('open')
  })
  const summary = details.querySelector('summary')
  const menu = details.querySelector('.history-filter-menu')
  const rect = summary.getBoundingClientRect()
  const roomBelow = window.innerHeight - rect.bottom - 8
  const roomAbove = rect.top - 8
  const opensBelow = roomBelow >= 120 || roomBelow >= roomAbove
  menu.style.maxHeight = `${Math.max(80, Math.min(210, opensBelow ? roomBelow : roomAbove))}px`
  menu.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - menu.offsetWidth - 8))}px`
  menu.style.top = `${opensBelow ? rect.bottom + 4 : Math.max(8, rect.top - menu.offsetHeight - 4)}px`
}

function positionsTable(price) {
  const positions = Object.values(state.paper.positions).filter(({ quantity }) => quantity)
  if (!positions.length) return paperEmpty('暂无持仓')
  return `
    <div class="paper-grid position-grid paper-grid-head"><span>标的</span><span>方向</span><span>数量</span><span>平均成交价</span><span>止盈</span><span>止损</span><span>最新价</span><span>未实现盈亏</span><span>盈亏比例</span><span></span></div>
    ${positions.map((position) => {
      const symbol = position.symbol
      const positionPrice = symbol === state.symbol.id ? price : position.marketPrice
      const protection = positionProtection(state.paper, symbol)
      const pnl = position.quantity * (positionPrice - position.averagePrice)
      const pnlPercent = pnl / Math.abs(position.quantity * position.averagePrice) * 100
      const opening = positionOpeningTrade(symbol)
      return `<div class="paper-grid position-grid paper-row" ${paperJumpAttributes(symbol, opening?.barTimestamp ?? opening?.timestamp ?? opening?.filledAt ?? opening?.createdAt)}>
        <strong>${symbol}</strong><span class="${position.quantity > 0 ? 'positive' : 'negative'}">${position.quantity > 0 ? '多' : '空'}</span>
        <span>${formatOrderQuantity(Math.abs(position.quantity), symbol.split(':').at(-1))}</span><span>${formatPrice(position.averagePrice)}</span>
        <span>${protection.takeProfit == null ? '—' : formatPrice(protection.takeProfit)}</span><span>${protection.stopLoss == null ? '—' : formatPrice(protection.stopLoss)}</span>
        <span>${formatPrice(positionPrice)}</span><span class="${signClass(pnl)}">${formatMoney(pnl)}</span><span class="${signClass(pnlPercent)}">${formatPnlPercent(pnlPercent)}</span>
        <button class="table-action" data-close-position-symbol="${symbol}" title="平仓" aria-label="平仓">×</button>
      </div>`
    }).join('')}`
}

function ordersTable(orders, cancellable, historySymbols = null, emptyLabel) {
  const head = `<div class="paper-grid order-grid paper-grid-head">${historySymbols ? historyFilterHeader('标的', 'symbol', historySymbols) : '<span>标的</span>'}${historySymbols ? historyFilterHeader('方向', 'side', historySymbols) : '<span>方向</span>'}<span>类型</span><span>数量</span><span>限价 / 止损价</span><span>成交价</span><span>止盈</span><span>止损</span><span>状态</span><span>下单时间</span><span></span></div>`
  if (!orders.length) return historySymbols ? `${head}${paperEmpty(emptyLabel)}` : paperEmpty(cancellable ? '暂无当前委托' : '暂无委托历史')
  return `${head}
    ${orders.map((order) => `
      <div class="paper-grid order-grid paper-row" ${paperJumpAttributes(order.symbol, order.filledAt ?? order.createdAt)}>
        <strong>${order.symbol}</strong><span class="${order.side === 'buy' ? 'positive' : 'negative'}">${order.side === 'buy' ? '买入' : '卖出'}</span>
        <span>${orderTypeLabel(order)}</span><span>${formatOrderQuantity(order.quantity, order.symbol)}</span><span>${formatPrice(order.price)}</span>
        <span>${order.fillPrice == null ? '—' : formatPrice(order.fillPrice)}</span><span>${order.takeProfit == null ? '—' : formatPrice(order.takeProfit)}</span><span>${order.stopLoss == null ? '—' : formatPrice(order.stopLoss)}</span><span class="order-status ${order.status}">${orderStatusLabel(order.status)}</span>
        <span>${formatTimestamp(order.createdAt)}</span>${cancellable ? `<button class="table-action" data-cancel-order="${order.id}" title="取消订单" aria-label="取消订单">×</button>` : '<span></span>'}
      </div>`).join('')}`
}

function tradesTable(trades, historySymbols = null, emptyLabel) {
  const head = `<div class="paper-grid trade-grid paper-grid-head">${historySymbols ? historyFilterHeader('标的', 'symbol', historySymbols) : '<span>标的</span>'}${historySymbols ? historyFilterHeader('方向', 'side', historySymbols) : '<span>方向</span>'}<span>类型</span><span>数量</span><span>成交价</span><span>手续费</span><span>已实现盈亏</span><span>时间</span></div>`
  if (!trades.length) return historySymbols ? `${head}${paperEmpty(emptyLabel)}` : paperEmpty('暂无成交记录')
  return `${head}
    ${trades.map((trade) => trade.event === 'balance-reset' ? `
      <div class="paper-grid trade-grid trade-reset"><strong>模拟交易</strong><span>重置余额</span><span>—</span><span>—</span><span>—</span><span>—</span><span>—</span><span>${formatTimestamp(trade.timestamp)}</span></div>` : `
      <div class="paper-grid trade-grid paper-row" ${paperJumpAttributes(trade.symbol, trade.barTimestamp ?? trade.timestamp)}><strong>${trade.symbol}</strong><span class="${trade.side === 'buy' ? 'positive' : 'negative'}">${trade.side === 'buy' ? '买入' : '卖出'}</span>
        <span>${orderTypeLabel(trade)}</span><span>${formatOrderQuantity(trade.quantity, trade.symbol)}</span><span>${formatPrice(trade.price)}</span>
        <span>${formatMoney(trade.fee)}</span><span class="${signClass(trade.realizedPnl)}">${formatMoney(trade.realizedPnl)}</span><span>${formatTimestamp(trade.timestamp)}</span></div>
    `).join('')}`
}

function paperEmpty(label) {
  return `<div class="paper-empty">${label}</div>`
}

function positionOpeningTrade(symbol) {
  return state.paper.trades.find((trade) => trade.symbol === symbol && trade.openedQuantity > 0)
}

function paperJumpAttributes(symbol, timestamp) {
  if (!symbol) return ''
  const value = Number(timestamp)
  const time = Number.isFinite(value) ? ` data-paper-jump-timestamp="${value}"` : ''
  return `data-paper-jump-symbol="${symbol}"${time} role="button" tabindex="0"`
}

function orderTypeLabel(order) {
  if (order.role === 'take-profit') return '止盈'
  if (order.role === 'stop-loss') return '止损'
  return ({ market: '市价', limit: '限价', stop: '止损' })[order.type] || order.type
}

function orderStatusLabel(status) {
  return ({ working: '挂单中', filled: '已成交', cancelled: '已取消' })[status] || status
}

function renderIdentity() {
  document.querySelector('#current-symbol').textContent = state.symbol.symbol
  document.querySelector('#current-exchange').textContent = `${state.symbol.id.split(':')[0]} · ${currentTimeframe().label}`
  document.querySelector('#header-price').textContent = '--'
  document.querySelector('#header-change').textContent = '--'
  setIcon(document.querySelector('#header-icon'), state.symbol.symbol, state.currentQuote?.logoId)
}

function updateMarketDetails() {
  const bar = currentBar()
  const quote = state.currentQuote
  const price = quote?.price ?? bar.close
  const change = quote?.change ?? 0
  const changePct = quote?.changePct ?? 0
  document.querySelector('#market-details').innerHTML = `
    <div class="detail-title"><span class="asset-icon"></span><strong>${state.symbol.symbol}</strong></div>
    <div class="detail-subtitle">${state.symbol.description} · ${state.symbol.id.split(':')[0]}</div>
    <div class="detail-price">${formatPrice(price, quote?.priceScale)} <small>${quoteCurrency(state.symbol.symbol)}</small></div>
    <div class="detail-change ${change >= 0 ? 'positive' : 'negative'}">${formatSigned(change)} (${formatSigned(changePct)}%)</div>
    <div class="detail-row"><span>24h volume</span><strong>${formatCompact(quote?.volume ?? bar.volume)}</strong></div>
  `
  setIcon(document.querySelector('#market-details .asset-icon'), state.symbol.symbol, quote?.logoId)
}

function renderWatchlist() {
  document.querySelector('#watchlist-list').innerHTML = state.watchlist.map((item) => `
    <div class="watch-row ${item.id === state.symbol.id ? 'selected' : ''}" data-id="${item.id}" role="button" tabindex="0">
      <span class="watch-symbol"><i class="asset-icon"></i>${item.symbol}</span>
      <span data-field="price">${item.price == null ? '--' : formatPrice(item.price, item.priceScale)}</span>
      <span data-field="change" class="${signClass(item.change)}">${item.change == null ? '--' : formatSigned(item.change)}</span>
      <span data-field="changePct" class="${signClass(item.changePct)}">${item.changePct == null ? '--' : `${formatSigned(item.changePct)}%`}</span>
      <button class="remove-symbol" title="从自选表移除" aria-label="从自选表移除">×</button>
    </div>
  `).join('')
  document.querySelectorAll('.watch-row').forEach((row) => {
    const item = state.watchlist.find(({ id }) => id === row.dataset.id)
    setIcon(row.querySelector('.asset-icon'), item.symbol, item.logoId)
  })
}

function applyQuote(quote) {
  const item = state.watchlist.find(({ id }) => id === quote.id)
  const previousPrice = item?.price ?? (quote.id === state.symbol.id ? state.currentQuote?.price : null)
  if (item) Object.assign(item, quote)
  if (item) updateWatchlistRow(item, previousPrice)

  document.querySelector('#watchlist-status').textContent = new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(quote.timestamp)

  if (quote.id !== state.symbol.id) {
    processLivePaperQuote(quote)
    return
  }
  state.currentQuote = quote
  const direction = previousPrice == null ? quote.direction : Math.sign(quote.price - previousPrice) || quote.direction
  if (previousPrice == null || quote.price !== previousPrice) {
    updatePriceCell(document.querySelector('#header-price'), previousPrice, quote.price, direction, quote.priceScale)
  }
  setIcon(document.querySelector('#header-icon'), state.symbol.symbol, quote.logoId)
  const headerChange = document.querySelector('#header-change')
  headerChange.textContent = `${formatSigned(quote.changePct)}%`
  headerChange.className = `header-change ${signClass(quote.changePct)}`
  document.title = `${state.symbol.symbol} ${formatPrice(quote.price, quote.priceScale)} ${quote.change >= 0 ? '▲' : '▼'}`

  let bar = state.bars[state.liveHead]
  const timestamp = quoteBarTimestamp(quote.timestamp)
  if (timestamp > bar.timestamp) {
    bar = { timestamp, open: bar.close, high: quote.price, low: quote.price, close: quote.price, volume: 0 }
    state.bars.push(bar)
    state.liveHead = state.bars.length - 1
    state.replayEnd = Math.max(state.replayEnd, state.liveHead - 1)
  } else {
    bar.close = quote.price
    bar.high = Math.max(bar.high, quote.price)
    bar.low = Math.min(bar.low, quote.price)
  }
  processLivePaperQuote(quote)
  if (state.mode !== 'replay') liveSubscriber?.({ ...bar })
  updateMarketDetails()
}

function processLivePaperQuote(quote) {
  if (state.mode !== 'live' || (!state.paper.positions[quote.id] && !state.paper.orders.some(({ symbol }) => symbol === quote.id))) return
  const tick = { timestamp: quote.timestamp, open: quote.price, high: quote.price, low: quote.price, close: quote.price, volume: 0 }
  const fills = processPaperBar(state.paper, tick, quote.id, state.liveHead)
  if (fills.length) queuePaperStateSave()
  if (state.paperPanelOpen) renderPaperPanel()
  if (quote.id === state.symbol.id) window.requestAnimationFrame(renderTradeLayer)
}

function updateWatchlistRow(item, previousPrice) {
  const row = document.querySelector(`.watch-row[data-id="${CSS.escape(item.id)}"]`)
  if (!row) return
  const direction = previousPrice == null ? item.direction : Math.sign(item.price - previousPrice) || item.direction
  if (previousPrice == null || item.price !== previousPrice) {
    updatePriceCell(row.querySelector('[data-field="price"]'), previousPrice, item.price, direction, item.priceScale)
  }
  setIcon(row.querySelector('.asset-icon'), item.symbol, item.logoId)
  for (const [field, value] of [['change', item.change], ['changePct', item.changePct]]) {
    const element = row.querySelector(`[data-field="${field}"]`)
    element.textContent = field === 'changePct' ? `${formatSigned(value)}%` : formatSigned(value)
    element.className = signClass(value)
  }
  if (previousPrice != null && direction !== 0) flashRow(row, direction)
}

function updatePriceCell(cell, previousPrice, price, direction, priceScale) {
  const next = formatPrice(price, priceScale)
  const previous = previousPrice == null ? '' : formatPrice(previousPrice, priceScale)
  cell.textContent = ''
  if (!previous || !direction) {
    cell.textContent = next
    return
  }
  let split = 0
  while (split < previous.length && split < next.length && previous[split] === next[split]) split += 1
  cell.append(document.createTextNode(next.slice(0, split)))
  const changed = document.createElement('span')
  changed.className = direction > 0 ? 'price-tick-up' : 'price-tick-down'
  changed.textContent = next.slice(split)
  cell.append(changed)
}

function flashRow(row, direction) {
  const className = direction > 0 ? 'flash-up' : 'flash-down'
  row.classList.remove('flash-up', 'flash-down')
  void row.offsetWidth
  row.classList.add(className)
  window.setTimeout(() => row.classList.remove(className), 500)
}

function connectQuoteStream() {
  state.eventSource?.close()
  const symbols = new Set(state.paper.orders.map(({ symbol }) => symbol))
  Object.keys(state.paper.positions).forEach((symbol) => symbols.add(symbol))
  symbols.add(state.symbol.id)
  state.watchlist.forEach(({ id }) => symbols.add(id))
  state.eventSource = new EventSource(`/api/tradingview/stream?symbols=${encodeURIComponent([...symbols].join(','))}`)
  state.eventSource.onmessage = (event) => applyQuote(JSON.parse(event.data))
  state.eventSource.onerror = () => { document.querySelector('#watchlist-status').textContent = '重连中' }
}

async function switchSymbol(item, jumpTimestamp = null) {
  if (item.id === state.symbol.id) {
    closeSymbolSearch()
    if (Number.isFinite(jumpTimestamp)) jumpToChartTimestamp(jumpTimestamp)
    return
  }
  showLoading(true)
  exitReplay()
  try {
    state.symbol = { ...item }
    state.focusTimestamp = Number.isFinite(jumpTimestamp) ? jumpTimestamp : null
    state.currentQuote = null
    setupReplay(await loadBars(item.id))
    saveChartPreferences()
    renderIdentity()
    renderWatchlist()
    coreChart.clearData()
    chart.setSymbol(chartSymbol(state.symbol))
    coreChart.applyNewData(chartWindowData(), true)
    window.requestAnimationFrame(() => {
      if (Number.isFinite(jumpTimestamp)) jumpToChartTimestamp(jumpTimestamp)
      else coreChart.scrollToRealTime()
    })
    setPaperPanelOpen(state.paperPanelOpen, { save: false })
    updateReplayView()
    connectQuoteStream()
    closeSymbolSearch()
    persistPaperState()
  } catch (error) {
    showToast(`数据加载失败: ${error.message}`)
  } finally {
    showLoading(false)
  }
}

async function switchTimeframe(timeframe) {
  if (timeframe === state.timeframe) {
    document.querySelector('#timeframe-menu').hidden = true
    return
  }
  showLoading(true)
  exitReplay()
  try {
    const bars = await loadBars(state.symbol.id, timeframe)
    state.timeframe = timeframe
    state.focusTimestamp = null
    setupReplay(bars)
    saveChartPreferences()
    renderTimeframes()
    renderIdentity()
    chart.setPeriod({ ...currentTimeframe().period })
    updateReplayView()
    document.querySelector('#timeframe-menu').hidden = true
    persistPaperState()
  } catch (error) {
    showToast(`周期切换失败: ${error.message}`)
  } finally {
    showLoading(false)
  }
}

function paperSymbol(symbol) {
  if (state.symbol.id === symbol) return state.symbol
  return state.watchlist.find((item) => item.id === symbol) || {
    id: symbol,
    exchange: symbol.split(':')[0],
    symbol: symbol.split(':').at(-1),
    description: symbol.split(':').at(-1),
    type: 'spot',
  }
}

function jumpToPaperEvent(symbol, timestamp) {
  const item = paperSymbol(symbol)
  if (!item) return
  return switchSymbol(item, Number.isFinite(timestamp) ? timestamp : null)
}

function jumpToChartTimestamp(timestamp) {
  const target = state.bars.find(({ timestamp: value }) => value === timestamp)
    || state.bars.reduce((closest, bar) => Math.abs(bar.timestamp - timestamp) < Math.abs(closest.timestamp - timestamp) ? bar : closest, state.bars[0])
  if (!target || !coreChart) return
  state.focusTimestamp = target.timestamp
  coreChart.applyNewData(chartWindowData(), true)
  window.requestAnimationFrame(() => {
    coreChart.scrollToTimestamp(target.timestamp, 300)
    renderTradeLayer()
  })
}

function addToWatchlist(item) {
  if (!state.watchlist.some(({ id }) => id === item.id)) {
    state.watchlist.push({ ...item, price: null, change: null, changePct: null, volume: null })
    saveWatchlist()
    renderWatchlist()
    connectQuoteStream()
  }
  closeSymbolSearch()
}

function removeFromWatchlist(id) {
  state.watchlist = state.watchlist.filter((item) => item.id !== id)
  saveWatchlist()
  renderWatchlist()
  connectQuoteStream()
}

function openSymbolSearch(mode) {
  state.searchMode = mode
  state.searchFilter = ''
  const dialog = document.querySelector('#symbol-dialog')
  const input = document.querySelector('#symbol-search')
  dialog.hidden = false
  input.value = mode === 'switch' ? state.symbol.symbol : ''
  document.querySelectorAll('#symbol-filters button').forEach((button) => button.classList.toggle('active', button.dataset.filter === ''))
  document.querySelector('#symbol-results').innerHTML = ''
  input.focus()
  input.select()
  if (input.value) searchSymbols(input.value)
}

function closeSymbolSearch() {
  document.querySelector('#symbol-dialog').hidden = true
}

async function searchSymbols(query) {
  if (!query.trim()) {
    document.querySelector('#symbol-results').innerHTML = ''
    return
  }
  const response = await fetch(`/api/tradingview/search?q=${encodeURIComponent(query)}&filter=${encodeURIComponent(state.searchFilter)}`)
  if (!response.ok) return showToast('搜索失败')
  state.searchResults = await response.json()
  document.querySelector('#symbol-results').innerHTML = state.searchResults.length ? state.searchResults.map((item, index) => `
    <button class="symbol-result ${item.id === state.symbol.id ? 'selected' : ''}" data-index="${index}">
      <span class="result-symbol"><i class="asset-icon"></i><strong>${item.symbol}</strong></span>
      <span class="result-description">${item.description}</span>
      <small class="result-type">${displayMarketType(item.type)} ${displayTypeSpecs(item.typeSpecs)}</small>
      <span class="result-provider"><small>${item.exchange}</small><i class="provider-icon"></i></span>
    </button>
  `).join('') : '<div class="symbol-empty">未找到市场</div>'
  document.querySelectorAll('.symbol-result').forEach((row) => {
    const item = state.searchResults[Number(row.dataset.index)]
    setIcon(row.querySelector('.asset-icon'), item.symbol, item.logoId)
    setProviderIcon(row.querySelector('.provider-icon'), item.sourceLogoId, item.providerId)
  })
}

function displayMarketType(type = '') {
  return ({ spot: '现货', swap: '永续', futures: '期货', stock: '股票', forex: '外汇', index: '指数', economic: '经济' })[type] || type
}

function displayTypeSpecs(typeSpecs = []) {
  return typeSpecs.filter((type) => !['crypto'].includes(type)).join(' ')
}

function step() {
  if (state.mode !== 'replay') return
  state.replayHead = Math.min(state.replayEnd, state.replayHead + 1)
  processPaperBar(state.paper, currentBar(), state.symbol.id, state.replayHead)
  refreshChart()
  updateReplayView()
  if (state.replayHead >= state.replayEnd) stopPlayback()
}

function startPlayback() {
  if (state.mode !== 'replay' || state.playing || state.replayHead >= state.replayEnd) return
  state.playing = true
  document.querySelector('#play').textContent = 'Ⅱ'
  document.querySelector('#play').title = '暂停'
  state.timer = window.setInterval(step, state.speed)
}

function stopPlayback() {
  state.playing = false
  window.clearInterval(state.timer)
  state.timer = null
  document.querySelector('#play').textContent = '▶'
  document.querySelector('#play').title = '播放'
}

function openReplay() {
  document.querySelector('.replay-dock').hidden = false
  document.querySelector('#replay-toggle').classList.add('active')
  document.querySelector('.terminal').classList.add('replay-open')
  startBarSelection()
  window.dispatchEvent(new Event('resize'))
}

function startBarSelection() {
  const wasReplay = state.mode === 'replay'
  stopPlayback()
  state.mode = 'select'
  document.querySelector('#select-bar').classList.add('active')
  document.querySelector('#replay-selector-line').hidden = true
  document.querySelector('#replay-future-mask').hidden = true
  document.querySelector('#replay-watermark').hidden = true
  state.selectionTimestamp = null
  if (wasReplay) refreshChart()
  updateReplayView()
  document.querySelector('#chart').classList.add('selecting-replay-bar')
}

function selectReplayBar(timestamp) {
  const index = state.bars.findIndex((bar) => bar.timestamp === timestamp)
  if (index < START_CONTEXT) return showToast('这根 K 线之前的历史数据不足')
  if (index > state.replayEnd) return showToast('请选择已经收盘的 K 线')
  stopPlayback()
  state.replayStart = Math.max(0, index - REPLAY_WINDOW + 1)
  state.replayHead = index
  state.mode = 'replay'
  state.selectionTimestamp = timestamp
  showReplayWorkspace()
  refreshChart()
  updateReplayView()
  window.dispatchEvent(new Event('resize'))
}

function showReplayWorkspace() {
  document.querySelector('.replay-dock').hidden = false
  document.querySelector('#replay-toggle').classList.add('active')
  document.querySelector('.terminal').classList.add('replay-open')
  document.querySelector('#select-bar').classList.remove('active')
  document.querySelector('#chart').classList.remove('selecting-replay-bar')
  document.querySelector('#replay-selector-line').hidden = true
  document.querySelector('#replay-future-mask').hidden = true
  document.querySelector('#replay-watermark').hidden = false
  setPaperPanelOpen(true)
}

function exitReplay() {
  const shouldRefresh = state.mode === 'replay'
  stopPlayback()
  state.mode = 'live'
  document.querySelector('.replay-dock').hidden = true
  document.querySelector('#replay-selector-line').hidden = true
  document.querySelector('#replay-future-mask').hidden = true
  document.querySelector('#replay-watermark').hidden = true
  document.querySelector('#chart').classList.remove('selecting-replay-bar')
  document.querySelector('#select-bar').classList.remove('active')
  document.querySelector('#replay-toggle').classList.remove('active')
  document.querySelector('.terminal').classList.remove('replay-open')
  setPaperPanelOpen(state.paperPanelOpen, { save: false })
  state.orderDraft = null
  closeChartContextMenu()
  renderTradeLayer()
  persistPaperState()
  if (shouldRefresh) refreshChart()
  updateMarketDetails()
  window.dispatchEvent(new Event('resize'))
}

function openChartContextMenu(event, root) {
  if (state.mode === 'select') return
  event.preventDefault()
  const point = coreChart?.convertFromPixel(
    { y: event.clientY - root.getBoundingClientRect().top },
    { paneId: 'candle_pane', absolute: true },
  )
  if (!Number.isFinite(point?.value)) return
  state.contextPrice = point.value
  const above = point.value >= currentBar().close
  const first = above ? { side: 'sell', type: 'limit' } : { side: 'buy', type: 'limit' }
  const second = above ? { side: 'buy', type: 'stop' } : { side: 'sell', type: 'stop' }
  const menu = document.querySelector('#chart-context-menu')
  menu.innerHTML = `
    <button data-context="copy">Copy price <strong>${formatPrice(point.value)}</strong></button>
    <span></span>
    ${contextOrderButton(first, point.value)}
    ${contextOrderButton(second, point.value)}
    <button data-context="add">Add order on ${state.symbol.symbol} at ${formatPrice(point.value)}…</button>`
  const main = document.querySelector('.tv-main').getBoundingClientRect()
  menu.hidden = false
  menu.style.left = `${Math.min(event.clientX - main.left, main.width - 310)}px`
  menu.style.top = `${Math.min(event.clientY - main.top, main.height - menu.offsetHeight - 8)}px`
}

function contextOrderButton({ side, type }, price) {
  return `<button data-context="draft" data-side="${side}" data-type="${type}"><b class="${side === 'buy' ? 'positive' : 'negative'}">${side === 'buy' ? 'Buy' : 'Sell'}</b> 0.01 ${baseCurrency(state.symbol.symbol)} @ ${formatPrice(price)} ${type}</button>`
}

function closeChartContextMenu() {
  document.querySelector('#chart-context-menu').hidden = true
}

function openOrderDraft(side, type, price = state.contextPrice) {
  state.orderDraft = {
    side,
    type,
    quantity: 0.01,
    price: type === 'market' ? currentBar().close : price,
    takeProfit: null,
    stopLoss: null,
  }
  closeChartContextMenu()
  renderTradeLayer()
}

function submitOrderDraft() {
  const draft = state.orderDraft
  if (!draft) return
  try {
    const timestamp = state.mode === 'replay' ? currentBar().timestamp : state.currentQuote?.timestamp ?? Date.now()
    placePaperOrder(state.paper, { ...draft, symbol: state.symbol.id }, currentBar().close, currentBarIndex(), timestamp)
    state.orderDraft = null
    updateReplayView()
  } catch (error) {
    showToast(error.message)
  }
}

function renderTradeLayer() {
  const layer = document.querySelector('#trade-layer')
  if (!coreChart || state.mode === 'select') {
    layer.replaceChildren()
    return
  }
  const position = paperPosition(state.paper, state.symbol.id)
  const price = currentBar().close
  const html = [tradeMarkerLines()]
  if (position.quantity) {
    const pnl = position.quantity * (price - position.averagePrice)
    const groups = [...new Set(state.paper.orders.filter(({ symbol, reduceOnly }) => symbol === state.symbol.id && reduceOnly).map(({ groupId }) => groupId).filter(Boolean))].join(',')
    html.push(orderLine({
      classes: 'position-line',
      price: position.averagePrice,
      segments: [
        groups && { text: groups, className: 'order-sequence' },
        { text: `${formatOrderQuantity(Math.abs(position.quantity), state.symbol.symbol)} ${position.quantity > 0 ? 'Long' : 'Short'}` },
        { text: formatMoney(pnl), className: signClass(pnl) },
      ].filter(Boolean),
      showPrice: false,
    }))
  }
  state.paper.orders.filter(({ symbol }) => symbol === state.symbol.id).forEach((order) => {
    html.push(workingOrderLines(order, position))
  })
  if (state.orderDraft) html.push(draftLines(state.orderDraft))
  layer.innerHTML = html.join('')
  positionTradeLayerElements()
}

function tradeMarkerLines() {
  const headTimestamp = currentBar()?.timestamp
  return state.paper.trades.flatMap((trade) => {
    if (trade.event === 'balance-reset' || trade.symbol !== state.symbol.id) return []
    const timestamp = trade.barTimestamp ?? trade.timestamp
    if (!Number.isFinite(timestamp) || (state.mode === 'replay' && timestamp > headTimestamp)) return []
    const markers = []
    if (trade.openedQuantity > 0) markers.push(`<span class="trade-marker trade-marker-open" data-marker-timestamp="${timestamp}" data-marker-price="${trade.price}" aria-label="开仓">↑</span>`)
    if (trade.closedQuantity > 0) markers.push(`<span class="trade-marker trade-marker-close" data-marker-timestamp="${timestamp}" data-marker-price="${trade.price}" aria-label="平仓">↓</span>`)
    return markers
  }).join('')
}

function workingOrderLines(order, position) {
  if (order.role !== 'entry') {
    const side = position.quantity > 0 ? 'buy' : 'sell'
    const pnl = projectedPnl(side, order.quantity, position.averagePrice, order.price)
    return protectionOrderLine(order.role, order.price, order.groupId, pnl, `data-cancel-order="${order.id}"`, `data-protection-order="${order.id}"`)
  }

  const brackets = [
    order.takeProfit == null ? '' : '<span class="order-bracket take-profit">TP</span>',
    order.stopLoss == null ? '' : '<span class="order-bracket stop-loss">SL</span>',
  ].join('')
  const entry = orderLine({
    classes: `entry-order ${order.side}`,
    price: order.price,
    prefix: brackets,
    segments: [
      { text: order.groupId, className: 'order-sequence' },
      { text: `${order.side === 'buy' ? 'Buy' : 'Sell'} ${order.type}` },
    ],
    actionAttributes: `data-cancel-order="${order.id}"`,
  })
  const takeProfit = order.takeProfit == null ? '' : protectionOrderLine(
    'take-profit', order.takeProfit, order.groupId,
    projectedPnl(order.side, order.quantity, order.price, order.takeProfit),
    `data-remove-order-protection="${order.id}" data-protection-field="takeProfit"`,
    `data-protection-parent="${order.id}" data-protection-field="takeProfit"`,
  )
  const stopLoss = order.stopLoss == null ? '' : protectionOrderLine(
    'stop-loss', order.stopLoss, order.groupId,
    projectedPnl(order.side, order.quantity, order.price, order.stopLoss),
    `data-remove-order-protection="${order.id}" data-protection-field="stopLoss"`,
    `data-protection-parent="${order.id}" data-protection-field="stopLoss"`,
  )
  return takeProfit + stopLoss + entry
}

function protectionOrderLine(role, price, groupId, pnl, buttonAttributes, dragAttributes) {
  return orderLine({
    classes: role,
    price,
    segments: [
      { text: groupId, className: 'order-sequence' },
      { text: formatProjectedPnl(pnl) },
    ],
    actionAttributes: buttonAttributes,
    attributes: dragAttributes,
  })
}

function orderLine({ classes, price, segments, prefix = '', actionAttributes = '', attributes = '', showPrice = true }) {
  return `<div class="trade-line working-line ${classes}" data-price="${price}" ${attributes}>
    <div class="working-controls">${prefix}${lineControl(segments, actionAttributes)}</div>
    ${showPrice ? `<strong class="line-price">${formatPrice(price)}</strong>` : ''}
  </div>`
}

function lineControl(segments, actionAttributes) {
  const content = segments.map(({ text, className = '' }) => `<b class="${className}">${text}</b>`).join('')
  const action = actionAttributes ? `<button ${actionAttributes} title="取消订单" aria-label="取消订单">×</button>` : ''
  return `<span class="working-control">${content}${action}</span>`
}

function draftLines(draft) {
  const entry = `
    <div class="trade-line draft-entry ${draft.side}" data-price="${draft.price}" data-draft-role="price">
      <div class="draft-controls">
        <button class="draft-submit ${draft.side}" data-submit-draft>${draft.side === 'buy' ? 'Buy' : 'Sell'}</button>
        <button class="protection-toggle ${draft.takeProfit != null ? 'active' : ''}" data-toggle-protection="takeProfit">TP</button>
        <button class="protection-toggle ${draft.stopLoss != null ? 'active' : ''}" data-toggle-protection="stopLoss">SL</button>
        <label class="draft-quantity"><input data-draft-quantity type="number" min="0.0001" step="0.0001" value="${draft.quantity}" aria-label="下单数量"><span>${baseCurrency(state.symbol.symbol)}</span></label>
        <select data-draft-type aria-label="订单类型">
          <option value="market" ${draft.type === 'market' ? 'selected' : ''}>Market</option>
          <option value="limit" ${draft.type === 'limit' ? 'selected' : ''}>Limit</option>
          <option value="stop" ${draft.type === 'stop' ? 'selected' : ''}>Stop</option>
        </select>
        <button data-cancel-draft title="取消" aria-label="取消">×</button>
      </div>
      <strong>${formatPrice(draft.price)}</strong>
    </div>`
  const tp = draft.takeProfit == null ? '' : `<div class="protection-zone take-profit-zone" data-entry="${draft.price}" data-target="${draft.takeProfit}"></div><div class="trade-line protection-line take-profit" data-price="${draft.takeProfit}" data-draft-role="takeProfit"><span>TP · ${formatProjectedPnl(projectedPnl(draft.side, draft.quantity, draft.price, draft.takeProfit))} <button data-remove-protection="takeProfit" aria-label="移除止盈">×</button></span></div>`
  const sl = draft.stopLoss == null ? '' : `<div class="protection-zone stop-loss-zone" data-entry="${draft.price}" data-target="${draft.stopLoss}"></div><div class="trade-line protection-line stop-loss" data-price="${draft.stopLoss}" data-draft-role="stopLoss"><span>SL · ${formatProjectedPnl(projectedPnl(draft.side, draft.quantity, draft.price, draft.stopLoss))} <button data-remove-protection="stopLoss" aria-label="移除止损">×</button></span></div>`
  return tp + sl + entry
}

function scheduleTradeLayerPosition() {
  if (tradeLayerFrame != null) return
  tradeLayerFrame = window.requestAnimationFrame(() => {
    tradeLayerFrame = null
    positionTradeLayerElements()
  })
}

function syncTradeLayerPosition() {
  positionTradeLayerElements()
  scheduleTradeLayerPosition()
}

function positionTradeLayerElements() {
  const layer = document.querySelector('#trade-layer')
  layer.querySelectorAll('.trade-marker').forEach(positionTradeMarker)
  layer.querySelectorAll('.trade-line[data-price]').forEach(positionTradeLine)
  layer.querySelectorAll('.protection-zone').forEach(positionProtectionZone)
}

function positionTradeMarker(element) {
  const timestamp = Number(element.dataset.markerTimestamp)
  const price = Number(element.dataset.markerPrice)
  const bar = state.bars.find(({ timestamp: value }) => value === timestamp)
  if (!bar) return element.hidden = true
  const coordinate = coreChart.convertToPixel({ timestamp }, { paneId: 'candle_pane', absolute: true })
  const value = element.classList.contains('trade-marker-open') ? bar.low : bar.high
  const top = tradePriceTop(value)
  const canvas = document.querySelector('#chart canvas')
  const main = document.querySelector('.tv-main')
  if (!Number.isFinite(coordinate?.x) || !Number.isFinite(top) || !canvas || !main) return element.hidden = true
  element.style.left = `${coordinate.x + canvas.getBoundingClientRect().left - main.getBoundingClientRect().left}px`
  element.style.top = `${top + (element.classList.contains('trade-marker-open') ? 12 : -12)}px`
  element.hidden = false
}

function positionTradeLine(element) {
  const top = tradePriceTop(Number(element.dataset.price))
  if (!Number.isFinite(top)) return element.hidden = true
  const root = document.querySelector('#chart [k-line-chart-id]').getBoundingClientRect()
  const main = document.querySelector('.tv-main').getBoundingClientRect()
  element.style.top = `${top}px`
  element.hidden = top < root.top - main.top || top > root.bottom - main.top
}

function positionProtectionZone(element) {
  const entry = tradePriceTop(Number(element.dataset.entry))
  const target = tradePriceTop(Number(element.dataset.target))
  if (!Number.isFinite(entry) || !Number.isFinite(target)) return element.hidden = true
  element.style.top = `${Math.min(entry, target)}px`
  element.style.height = `${Math.abs(entry - target)}px`
}

function tradePriceTop(price) {
  const coordinate = coreChart.convertToPixel({ value: price }, { paneId: 'candle_pane', absolute: true })
  if (!Number.isFinite(coordinate?.y)) return NaN
  const root = document.querySelector('#chart [k-line-chart-id]').getBoundingClientRect()
  const main = document.querySelector('.tv-main').getBoundingClientRect()
  return coordinate.y + root.top - main.top
}

function beginDraftDrag(event, role, fromControl = false) {
  if (!fromControl && event.target.closest('button, input, select')) return
  event.preventDefault()
  const root = document.querySelector('#chart [k-line-chart-id]')
  const startY = event.clientY
  let moved = false
  const move = (moveEvent) => {
    if (Math.abs(moveEvent.clientY - startY) < 2) return
    moved = true
    const point = coreChart.convertFromPixel(
      { y: moveEvent.clientY - root.getBoundingClientRect().top },
      { paneId: 'candle_pane', absolute: true },
    )
    if (!Number.isFinite(point?.value) || !state.orderDraft) return
    if (role === 'takeProfit') state.orderDraft.takeProfit = constrainProtection('takeProfit', point.value, state.orderDraft)
    else if (role === 'stopLoss') state.orderDraft.stopLoss = constrainProtection('stopLoss', point.value, state.orderDraft)
    else state.orderDraft.price = point.value
    renderTradeLayer()
  }
  const stop = () => {
    document.removeEventListener('pointermove', move)
    document.removeEventListener('pointerup', stop)
    if (!moved) renderTradeLayer()
  }
  document.addEventListener('pointermove', move)
  document.addEventListener('pointerup', stop)
}

function beginWorkingProtectionDrag(event, element) {
  if (event.target.closest('button')) return
  event.preventDefault()
  const root = document.querySelector('#chart [k-line-chart-id]')
  const position = paperPosition(state.paper, state.symbol.id)
  let moved = false
  const move = (moveEvent) => {
    const point = coreChart.convertFromPixel(
      { y: moveEvent.clientY - root.getBoundingClientRect().top },
      { paneId: 'candle_pane', absolute: true },
    )
    if (!Number.isFinite(point?.value)) return
    const parent = state.paper.orders.find(({ id }) => id === Number(element.dataset.protectionParent))
    const protection = state.paper.orders.find(({ id }) => id === Number(element.dataset.protectionOrder))
    if (parent) {
      const field = element.dataset.protectionField
      parent[field] = constrainProtection(field, point.value, parent)
    } else if (protection && position.quantity) {
      const field = protection.role === 'take-profit' ? 'takeProfit' : 'stopLoss'
      const side = position.quantity > 0 ? 'buy' : 'sell'
      protection.price = constrainProtection(field, point.value, { side, price: position.averagePrice })
    } else {
      return
    }
    moved = true
    renderTradeLayer()
  }
  const stop = () => {
    document.removeEventListener('pointermove', move)
    document.removeEventListener('pointerup', stop)
    if (moved) updateReplayView()
  }
  document.addEventListener('pointermove', move)
  document.addEventListener('pointerup', stop)
}

function constrainProtection(role, value, draft) {
  const step = Math.max(draft.price * 0.00001, 0.00000001)
  if (role === 'takeProfit') return draft.side === 'buy' ? Math.max(value, draft.price + step) : Math.min(value, draft.price - step)
  return draft.side === 'buy' ? Math.min(value, draft.price - step) : Math.max(value, draft.price + step)
}

function setIcon(element, symbol, logoId) {
  element.replaceChildren()
  const officialLogo = logoId || inferCryptoLogo(symbol)
  if (officialLogo) {
    const image = document.createElement('img')
    image.src = `https://s3-symbol-logo.tradingview.com/${officialLogo}--big.svg`
    image.alt = ''
    image.addEventListener('error', () => setFallbackIcon(element, symbol), { once: true })
    element.append(image)
    element.style.removeProperty('--icon-color')
    return
  }
  setFallbackIcon(element, symbol)
}

function setProviderIcon(element, sourceLogoId, providerId) {
  element.replaceChildren()
  const logoId = sourceLogoId || (providerId ? `provider/${providerId}` : '')
  if (!logoId) return
  const image = document.createElement('img')
  image.src = `https://s3-symbol-logo.tradingview.com/${logoId}--big.svg`
  image.alt = ''
  image.addEventListener('error', () => element.remove(), { once: true })
  element.append(image)
}

function inferCryptoLogo(symbol) {
  const quote = quoteCurrency(symbol)
  return ['USDT', 'USDC', 'BUSD', 'BTC', 'ETH'].includes(quote) ? `crypto/XTVC${baseCurrency(symbol)}` : ''
}

function setFallbackIcon(element, symbol) {
  const base = baseCurrency(symbol)
  element.replaceChildren(base[0] || '?')
  element.style.setProperty('--icon-color', '#596579')
}

function baseCurrency(symbol) {
  const normalized = symbol.replace(/\.P$/i, '')
  return normalized.replace(/(USDT|USDC|BUSD|USD|BTC|ETH|EUR|GBP|JPY)$/i, '') || normalized
}

function quoteCurrency(symbol) {
  return symbol.replace(/\.P$/i, '').match(/(USDT|USDC|BUSD|USD|BTC|ETH|EUR|GBP|JPY)$/i)?.[1]?.toUpperCase() || ''
}

function signClass(value) {
  if (value == null) return ''
  return value >= 0 ? 'positive' : 'negative'
}

function formatMoney(value) {
  return `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function formatProjectedPnl(value) {
  return `${value >= 0 ? '+' : '−'}${Math.abs(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USD`
}

function formatPnlPercent(value) {
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`
}

function formatQuantity(value) {
  return value.toLocaleString('en-US', { maximumFractionDigits: 8 })
}

function formatOrderQuantity(value, symbol) {
  return `${formatQuantity(value)} ${baseCurrency(symbol.split(':').at(-1))}`
}

function formatTimestamp(value) {
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(value)
}

function formatPrice(value, priceScale) {
  const digits = Number.isFinite(priceScale) && priceScale > 0
    ? Math.min(8, Math.max(0, Math.round(Math.log10(priceScale))))
    : value >= 1 ? 2 : value >= 0.01 ? 5 : 8
  return value.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })
}

function formatSigned(value) {
  const digits = Math.abs(value) >= 1 ? 2 : Math.abs(value) >= 0.01 ? 4 : 6
  return `${value >= 0 ? '+' : ''}${value.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`
}

function formatCompact(value) {
  if (value >= 1e9) return `${(value / 1e9).toFixed(2)}B`
  if (value >= 1e6) return `${(value / 1e6).toFixed(2)}M`
  if (value >= 1e3) return `${(value / 1e3).toFixed(2)}K`
  return value.toFixed(2)
}

function showToast(message) {
  const toast = document.querySelector('#toast')
  toast.textContent = message
  toast.classList.add('show')
  window.clearTimeout(showToast.timer)
  showToast.timer = window.setTimeout(() => toast.classList.remove('show'), 1800)
}

function showLoading(visible) {
  document.querySelector('#loading').classList.toggle('show', visible)
}

document.querySelector('#select-bar').addEventListener('click', startBarSelection)
document.querySelector('#step-forward').addEventListener('click', step)
document.querySelector('#play').addEventListener('click', () => state.playing ? stopPlayback() : startPlayback())
document.querySelector('#jump-live').addEventListener('click', exitReplay)
document.querySelector('#exit-replay').addEventListener('click', exitReplay)
document.querySelector('#paper-tabs').addEventListener('click', (event) => {
  const button = event.target.closest('button[data-paper-tab]')
  if (!button) return
  state.paperTab = button.dataset.paperTab
  renderPaperPanel()
  queuePaperStateSave()
})
document.querySelector('#paper-resize-handle').addEventListener('pointerdown', beginPaperPanelResize)
document.querySelector('#paper-resize-handle').addEventListener('keydown', resizePaperPanelWithKeyboard)
document.querySelector('#paper-account').addEventListener('click', (event) => {
  if (!event.target.closest('[data-reset-balance]')) return
  if (!window.confirm('重置模拟账户至 $100,000？\n\n所有持仓和挂单将被清空，历史记录会保留。')) return
  resetPaperAccount(state.paper, INITIAL_CASH)
  state.orderDraft = null
  state.paperTab = 'trade-history'
  closeChartContextMenu()
  updateReplayView()
})
document.querySelector('#paper-table').addEventListener('click', async (event) => {
  const summary = event.target.closest('.history-filter summary')
  if (summary) {
    window.requestAnimationFrame(() => positionHistoryFilter(summary.parentElement))
    return
  }
  const filter = event.target.closest('[data-history-filter-value]')
  if (filter) {
    const field = filter.closest('[data-history-filter-menu]').dataset.historyFilterMenu
    const view = state.historyView[state.paperTab]
    view[field] = filter.dataset.historyFilterValue
    view.page = 1
    renderPaperPanel()
    return
  }
  const page = event.target.closest('[data-history-page]')
  if (page) {
    state.historyView[state.paperTab].page += Number(page.dataset.historyPage)
    renderPaperPanel()
    return
  }
  const cancel = event.target.closest('[data-cancel-order]')
  if (cancel) {
    cancelPaperOrder(state.paper, Number(cancel.dataset.cancelOrder), currentBar().timestamp)
    updateReplayView()
    return
  }
  const close = event.target.closest('[data-close-position-symbol]')
  if (close) {
    const symbol = close.dataset.closePositionSymbol
    await jumpToPaperEvent(symbol, Number(close.closest('[data-paper-jump-symbol]')?.dataset.paperJumpTimestamp))
    const position = paperPosition(state.paper, symbol)
    closePaperPosition(state.paper, symbol, position.marketPrice || currentBar().close, currentBarIndex(), currentBar().timestamp)
    updateReplayView()
    return
  }
  const jump = event.target.closest('[data-paper-jump-symbol]')
  if (jump) {
    await jumpToPaperEvent(jump.dataset.paperJumpSymbol, Number(jump.dataset.paperJumpTimestamp))
    return
  }
})
document.addEventListener('click', (event) => {
  document.querySelectorAll('.history-filter[open]').forEach((details) => {
    if (!details.contains(event.target)) details.removeAttribute('open')
  })
})
document.querySelector('#chart-context-menu').addEventListener('click', async (event) => {
  const action = event.target.closest('button[data-context]')
  if (!action) return
  if (action.dataset.context === 'copy') {
    await navigator.clipboard.writeText(String(state.contextPrice)).catch(() => {})
    closeChartContextMenu()
  } else if (action.dataset.context === 'draft') {
    openOrderDraft(action.dataset.side, action.dataset.type)
  } else {
    const side = state.contextPrice <= currentBar().close ? 'buy' : 'sell'
    openOrderDraft(side, 'limit')
  }
})
document.querySelector('#trade-layer').addEventListener('click', (event) => {
  if (event.target.closest('[data-submit-draft]')) return submitOrderDraft()
  const removeProtection = event.target.closest('[data-remove-protection]')
  if (removeProtection && state.orderDraft) {
    state.orderDraft[removeProtection.dataset.removeProtection] = null
    return renderTradeLayer()
  }
  if (event.target.closest('[data-cancel-draft]')) {
    state.orderDraft = null
    return renderTradeLayer()
  }
  const removeOrderProtection = event.target.closest('[data-remove-order-protection]')
  if (removeOrderProtection) {
    const order = state.paper.orders.find(({ id }) => id === Number(removeOrderProtection.dataset.removeOrderProtection))
    if (order) order[removeOrderProtection.dataset.protectionField] = null
    return updateReplayView()
  }
  const cancel = event.target.closest('[data-cancel-order]')
  if (cancel) {
    cancelPaperOrder(state.paper, Number(cancel.dataset.cancelOrder), currentBar().timestamp)
    updateReplayView()
  }
})
document.querySelector('#trade-layer').addEventListener('input', (event) => {
  if (event.target.matches('[data-draft-quantity]') && state.orderDraft) state.orderDraft.quantity = Number(event.target.value)
})
document.querySelector('#trade-layer').addEventListener('change', (event) => {
  if (!event.target.matches('[data-draft-type]') || !state.orderDraft) return
  state.orderDraft.type = event.target.value
  if (state.orderDraft.type === 'market') state.orderDraft.price = currentBar().close
  renderTradeLayer()
})
document.querySelector('#trade-layer').addEventListener('pointerdown', (event) => {
  const workingProtection = event.target.closest('[data-protection-order], [data-protection-parent]')
  if (workingProtection) return beginWorkingProtectionDrag(event, workingProtection)
  const protection = event.target.closest('[data-toggle-protection]')
  if (protection) return beginDraftDrag(event, protection.dataset.toggleProtection, true)
  const line = event.target.closest('[data-draft-role]')
  if (line) beginDraftDrag(event, line.dataset.draftRole)
})
document.querySelector('#speed').addEventListener('click', () => {
  const menu = document.querySelector('#speed-menu')
  menu.hidden = !menu.hidden
})
document.querySelector('#speed-menu').addEventListener('click', (event) => {
  const button = event.target.closest('button[data-speed]')
  if (!button) return
  const wasPlaying = state.playing
  stopPlayback()
  state.speed = Number(button.dataset.speed)
  document.querySelector('#speed').textContent = button.dataset.label
  document.querySelectorAll('#speed-menu button').forEach((item) => item.classList.toggle('active', item === button))
  document.querySelector('#speed-menu').hidden = true
  if (wasPlaying) startPlayback()
})
document.querySelector('#replay-toggle').addEventListener('click', () => {
  const dock = document.querySelector('.replay-dock')
  dock.hidden ? openReplay() : exitReplay()
})
document.querySelector('#paper-toggle').addEventListener('click', () => setPaperPanelOpen(!state.paperPanelOpen))
document.querySelector('#indicators').addEventListener('click', () => {
  const item = [...document.querySelectorAll('#chart .klinecharts-pro-period-bar .tools')].find((node) => node.textContent.includes('指标'))
  item?.click()
})
document.querySelector('#symbol-button').addEventListener('click', () => openSymbolSearch('switch'))
document.querySelector('#timeframe-favorites').addEventListener('click', (event) => {
  const button = event.target.closest('button[data-timeframe]')
  if (button) switchTimeframe(button.dataset.timeframe)
})
document.querySelector('#timeframe-more').addEventListener('click', () => {
  const menu = document.querySelector('#timeframe-menu')
  menu.hidden = !menu.hidden
})
document.querySelector('#timeframe-menu').addEventListener('click', (event) => {
  event.stopPropagation()
  const favorite = event.target.closest('button[data-favorite]')
  if (favorite) {
    const id = favorite.dataset.favorite
    state.favoriteTimeframes = state.favoriteTimeframes.includes(id)
      ? state.favoriteTimeframes.filter((item) => item !== id)
      : [...state.favoriteTimeframes, id]
    saveFavoriteTimeframes()
    renderTimeframes()
    return
  }
  const picker = event.target.closest('button[data-timeframe]')
  if (picker) switchTimeframe(picker.dataset.timeframe)
})
document.querySelector('#add-symbol').addEventListener('click', () => openSymbolSearch('add'))
document.querySelector('#close-search').addEventListener('click', closeSymbolSearch)
document.querySelector('#symbol-search').addEventListener('input', (event) => {
  window.clearTimeout(searchTimer)
  searchTimer = window.setTimeout(() => searchSymbols(event.target.value), 250)
})
document.querySelector('#symbol-filters').addEventListener('click', (event) => {
  const button = event.target.closest('button[data-filter]')
  if (!button) return
  state.searchFilter = button.dataset.filter
  document.querySelectorAll('#symbol-filters button').forEach((item) => item.classList.toggle('active', item === button))
  searchSymbols(document.querySelector('#symbol-search').value)
})
document.querySelector('#symbol-results').addEventListener('click', (event) => {
  const row = event.target.closest('.symbol-result')
  if (!row) return
  const item = state.searchResults[Number(row.dataset.index)]
  if (state.searchMode === 'add') addToWatchlist(item)
  else switchSymbol(item)
})
document.querySelector('#watchlist-list').addEventListener('click', (event) => {
  const row = event.target.closest('.watch-row')
  if (!row) return
  if (event.target.closest('.remove-symbol')) removeFromWatchlist(row.dataset.id)
  else switchSymbol(state.watchlist.find(({ id }) => id === row.dataset.id))
})
document.querySelector('#symbol-dialog').addEventListener('click', (event) => {
  if (event.target.id === 'symbol-dialog') closeSymbolSearch()
})
document.addEventListener('click', (event) => {
  if (!event.target.closest('.speed-control')) document.querySelector('#speed-menu').hidden = true
  if (!event.target.closest('.timeframe-control')) document.querySelector('#timeframe-menu').hidden = true
  if (!event.target.closest('#chart-context-menu')) closeChartContextMenu()
})
window.addEventListener('resize', () => {
  const terminal = document.querySelector('.terminal')
  setPaperPanelHeight(Number.parseFloat(getComputedStyle(terminal).getPropertyValue('--paper-panel-height')), false)
  document.querySelectorAll('.history-filter[open]').forEach(positionHistoryFilter)
  window.requestAnimationFrame(renderTradeLayer)
})
window.addEventListener('pagehide', () => persistPaperState({ keepalive: true }))
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return
  if (!document.querySelector('#symbol-dialog').hidden) closeSymbolSearch()
  else if (!document.querySelector('#speed-menu').hidden) document.querySelector('#speed-menu').hidden = true
  else if (!document.querySelector('#timeframe-menu').hidden) document.querySelector('#timeframe-menu').hidden = true
})

async function start() {
  showLoading(true)
  try {
    try {
      applyPaperState(await loadPaperState())
    } catch (error) {
      console.error('Paper state load failed:', error)
      showToast('模拟交易状态读取失败')
    }
    setupReplay(await loadBars())
    restoreReplaySession()
    if (state.mode === 'live') await catchUpPaperOrders()
    renderTimeframes()
    renderIdentity()
    renderWatchlist()
    renderChart()
    if (state.mode === 'replay') showReplayWorkspace()
    else setPaperPanelOpen(state.paperPanelOpen, { save: false })
    updateReplayView()
    connectQuoteStream()
  } catch (error) {
    showToast(`数据加载失败: ${error.message}`)
  } finally {
    showLoading(false)
  }
}

start()
