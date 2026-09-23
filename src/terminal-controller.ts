import { KLineChartPro } from '@klinecharts/pro'
import type { Datafeed, DatafeedSubscribeCallback, SymbolInfo } from '@klinecharts/pro'
import { ActionType, dispose as disposeKLineChart, init as getKLineChart, registerIndicator } from 'klinecharts'
import type { Chart, Coordinate, KLineData, Point } from 'klinecharts'
import { PineClient } from './pine-client'
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
  resetPaperAccount,
} from './paper'
import {
  DEFAULT_FAVORITE_TIMEFRAMES,
  DEFAULT_WATCHLIST,
  FAVORITES_STORAGE_KEY,
  FEE_RATE,
  HISTORY_PAGE_SIZE,
  INITIAL_CASH,
  MARKET_STORAGE_KEY,
  PAPER_PANEL_MIN_HEIGHT,
  REPLAY_WINDOW,
  SLIPPAGE_RATE,
  START_CONTEXT,
  TIMEFRAME_STORAGE_KEY,
  TIMEFRAMES,
  WATCHLIST_STORAGE_KEY,
} from './config.ts'
import { baseCurrency, inferCryptoLogo, quoteCurrency } from './symbols.ts'
import type { Bar, ControllerState, MarketSymbol, OrderDraft, OrderSide, OrderType, PaperAccount, PaperFillTrade, PaperOrder, PaperTab, PaperTrade, ProtectionField, Quote, ReplaySession, SearchResult, Timeframe, WatchItem } from './types.ts'

type CoreChart = Omit<Chart, 'convertToPixel' | 'convertFromPixel'> & {
  convertToPixel(point: Partial<Point>, finder: { paneId?: string; absolute?: boolean }): Partial<Coordinate>
  convertFromPixel(coordinate: Partial<Coordinate>, finder: { paneId?: string; absolute?: boolean }): Partial<Point>
}
type SavedState = { paper: Partial<PaperAccount>; session: ReplaySession }

const listeners = new Set<() => void>()

const state: ControllerState = {
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
  speedLabel: '1x',
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
  searchQuery: '',
  searchResults: [],
  selectionTimestamp: null,
  focusTimestamp: null,
  restoredSession: null,
  paperPanelOpen: false,
  paperPanelHeight: PAPER_PANEL_MIN_HEIGHT,
  searchOpen: false,
  loading: false,
  toast: '',
  watchlistStatus: '--:--:--',
  streamStatus: '',
  marketDetails: null,
  speedMenuOpen: false,
  timeframeMenuOpen: false,
  pineSource: '',
  contextMenu: null,
  replaySelectorLeft: null,
}

let chart: KLineChartPro | null = null
let coreChart: CoreChart | null = null
let chartContainer: HTMLElement | null = null
let tradeLayerFrame: number | null = null
let chartBindFrame: number | null = null
let chartEvents: AbortController | null = null
let dragEvents: AbortController | null = null
let liveSubscriber: DatafeedSubscribeCallback | null = null
let searchTimer: number | null = null
let persistTimer: number | null = null
let toastTimer: number | null = null
let persistErrorShown = false
let startupGeneration = 0
let pineClient: PineClient | null = null
let pinePane: string | null = null
let pineGeneration = 0

export function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getControllerState() {
  return state
}

export function dispose() {
  startupGeneration++
  stopPlayback()
  state.eventSource?.close()
  state.eventSource = null
  liveSubscriber = null
  if (searchTimer) window.clearTimeout(searchTimer)
  if (persistTimer != null) void persistPaperState({ keepalive: true })
  if (toastTimer) window.clearTimeout(toastTimer)
  unmountChart()
  dragEvents?.abort()
  dragEvents = null
  if (tradeLayerFrame != null) window.cancelAnimationFrame(tradeLayerFrame)
  tradeLayerFrame = null
}

function notify() {
  listeners.forEach((listener) => listener())
}

function currentTimeframe(): Timeframe {
  return TIMEFRAMES.find(({ id }) => id === state.timeframe)!
}

function loadSelectedMarket(): MarketSymbol {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(MARKET_STORAGE_KEY) || 'null')
    if (validSymbol(saved)) return saved
  } catch {}
  return { ...DEFAULT_WATCHLIST[0] }
}

function loadSelectedTimeframe(): string {
  const saved = localStorage.getItem(TIMEFRAME_STORAGE_KEY)
  return saved && TIMEFRAMES.some(({ id }) => id === saved) ? saved : 'D'
}

function saveChartPreferences() {
  const { id, exchange, symbol, description, type, logoId, providerId, sourceLogoId } = state.symbol
  localStorage.setItem(MARKET_STORAGE_KEY, JSON.stringify({ id, exchange, symbol, description, type, logoId, providerId, sourceLogoId }))
  localStorage.setItem(TIMEFRAME_STORAGE_KEY, state.timeframe)
}

function loadFavoriteTimeframes(): string[] {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(FAVORITES_STORAGE_KEY) || 'null')
    if (Array.isArray(saved)) return saved.filter((id): id is string => typeof id === 'string' && TIMEFRAMES.some((item) => item.id === id))
  } catch {}
  return [...DEFAULT_FAVORITE_TIMEFRAMES]
}

function saveFavoriteTimeframes() {
  localStorage.setItem(FAVORITES_STORAGE_KEY, JSON.stringify(state.favoriteTimeframes))
}

export function toggleFavoriteTimeframe(id: string) {
  state.favoriteTimeframes = state.favoriteTimeframes.includes(id)
    ? state.favoriteTimeframes.filter((item) => item !== id)
    : [...state.favoriteTimeframes, id]
  saveFavoriteTimeframes()
  notify()
}

export function openIndicators() {
  const item = [...document.querySelectorAll<HTMLElement>('#chart .klinecharts-pro-period-bar .tools')].find((node) => node.textContent?.includes('指标'))
  item?.click()
}

const replayDatafeed: Datafeed = {
  async searchSymbols(search = '') {
    const symbol = chartSymbol(state.symbol)
    return symbol.ticker.toLowerCase().includes(search.toLowerCase()) ? [symbol] : []
  },
  async getHistoryKLineData(symbol, period, from, to) {
    const requestedSymbol = state.symbol.id
    const requestedTimeframe = state.timeframe
    const activePeriod = currentTimeframe().period
    if (`${symbol.exchange}:${symbol.ticker}` !== requestedSymbol || period.multiplier !== activePeriod.multiplier || period.timespan !== activePeriod.timespan) return []
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
    if (requestedSymbol !== state.symbol.id || requestedTimeframe !== state.timeframe) return []
    const minimum = loadingOlder ? from : Math.max(from, firstVisible.timestamp)
    const currentEnd = state.bars[state.mode === 'replay' ? state.replayHead : state.liveHead]?.timestamp ?? 0
    return state.bars.filter((bar) => bar.timestamp >= minimum && bar.timestamp <= Math.min(to, endTimestamp, currentEnd))
  },
  subscribe(_symbol, _period, callback) {
    liveSubscriber = callback
  },
  unsubscribe() {
    liveSubscriber = null
  },
}

function loadSavedWatchlist(): WatchItem[] {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(WATCHLIST_STORAGE_KEY) || 'null')
    if (Array.isArray(saved) && saved.length) return saved.filter(validSymbol).slice(0, 20)
  } catch {}
  return DEFAULT_WATCHLIST.map((item) => ({ ...item }))
}

function validSymbol(item: unknown): item is MarketSymbol {
  if (!item || typeof item !== 'object') return false
  const symbol = item as Partial<MarketSymbol>
  return typeof symbol.id === 'string' && /^[A-Z0-9_.-]+:[A-Z0-9_.-]+$/.test(symbol.id)
    && typeof symbol.symbol === 'string' && typeof symbol.exchange === 'string'
    && typeof symbol.description === 'string' && typeof symbol.type === 'string'
}

function saveWatchlist() {
  const metadata = state.watchlist.map(({ id, exchange, symbol, description, type, logoId, providerId, sourceLogoId }) => ({
    id, exchange, symbol, description, type, logoId, providerId, sourceLogoId,
  }))
  localStorage.setItem(WATCHLIST_STORAGE_KEY, JSON.stringify(metadata))
}

function chartSymbol(item: MarketSymbol): SymbolInfo {
  return {
    exchange: item.id.split(':')[0], market: item.type || 'crypto', name: item.description,
    shortName: item.symbol, ticker: item.symbol, priceCurrency: quoteCurrency(item.symbol), type: (item.type || 'spot').toUpperCase(),
    pricePrecision: priceDigits(state.bars.at(-1)?.close ?? 0, state.currentQuote?.priceScale),
  }
}

async function loadBars(id = state.symbol.id, timeframe = state.timeframe, range = 1000, to?: number, closed = false): Promise<Bar[]> {
  const params = new URLSearchParams({ symbol: id, timeframe, range: String(range) })
  if (to != null) params.set('to', String(to))
  if (closed) params.set('closed', '1')
  const response = await fetch(`/api/tradingview/history?${params}`)
  if (!response.ok) throw new Error(`TradingView HTTP ${response.status}`)
  const { bars } = await response.json() as { bars: Bar[] }
  if (to == null && !closed && bars.length < START_CONTEXT + 2) throw new Error('Not enough TradingView bars')
  return bars
}

async function catchUpPaperOrders() {
  const ordersBySymbol = new Map<string, number>()
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

function setupReplay(bars: Bar[]) {
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

export function mountChart(container: HTMLElement) {
  chartContainer = container
  if (state.bars.length && !chart) renderChart()
}

export function resizeChart() {
  if (!coreChart) return
  coreChart.resize()
  scheduleTradeLayerPosition()
}

export function unmountChart() {
  pineGeneration++
  removePineIndicator()
  chartEvents?.abort()
  chartEvents = null
  if (chartBindFrame != null) window.cancelAnimationFrame(chartBindFrame)
  chartBindFrame = null
  if (coreChart) disposeKLineChart(coreChart as Chart)
  chart = null
  coreChart = null
  chartContainer = null
}

function renderChart() {
  if (!chartContainer) return
  const period = currentTimeframe().period
  chart = new KLineChartPro({
    container: chartContainer, theme: 'dark', locale: 'zh-CN', timezone: 'Asia/Shanghai',
    drawingBarVisible: true, symbol: chartSymbol(state.symbol), period, periods: [period],
    mainIndicators: ['MA'], subIndicators: ['VOL'], datafeed: replayDatafeed,
  })
  bindChartInteractions()
}

function bindChartInteractions() {
  if (!chartContainer || !chart) return
  const root = chartContainer.querySelector<HTMLElement>('[k-line-chart-id]')
  if (!root) {
    chartBindFrame = window.requestAnimationFrame(bindChartInteractions)
    return
  }
  chartBindFrame = null
  chartEvents = new AbortController()
  root.id ||= root.getAttribute('k-line-chart-id') || ''
  coreChart = getKLineChart(root) as CoreChart | null
  if (!coreChart) {
    chartBindFrame = window.requestAnimationFrame(bindChartInteractions)
    return
  }
  const core = coreChart
  core.subscribeAction(ActionType.OnCrosshairChange, (data) => {
    if (state.mode !== 'select') return
    const timestamp = actionTimestamp(data)
    if (!timestamp) return
    state.selectionTimestamp = timestamp
    positionReplaySelector(timestamp)
  })
  ;[ActionType.OnZoom, ActionType.OnScroll, ActionType.OnVisibleRangeChange, ActionType.OnPaneDrag]
    .forEach((type) => core.subscribeAction(type, syncTradeLayerPosition))
  root.addEventListener('wheel', syncTradeLayerPosition, { passive: true, signal: chartEvents.signal })
  root.addEventListener('mousemove', (event) => {
    if (state.mode !== 'select') return
    const timestamp = pointerTimestamp(event, root)
    if (!timestamp) return
    state.selectionTimestamp = timestamp
    positionReplaySelector(timestamp)
  }, { signal: chartEvents.signal })
  root.addEventListener('click', (event) => {
    if (state.mode !== 'select') return
    const timestamp = pointerTimestamp(event, root) || state.selectionTimestamp
    if (timestamp) selectReplayBar(timestamp)
  }, { signal: chartEvents.signal })
  root.addEventListener('contextmenu', (event) => openChartContextMenu(event, root), { signal: chartEvents.signal })
  if (state.pineSource) void applyPineScript(state.pineSource).catch((error: unknown) => {
    if (coreChart === core) showToast(`Pine Script: ${error instanceof Error ? error.message : String(error)}`)
  })
  resizeChart()
  renderTradeLayer()
}

const PINE_COLORS = ['#38bdf8', '#f0b90b', '#22ab94', '#e879f9', '#ef5350', '#a3e635', '#fb923c', '#a5b4fc']
registerIndicator({ name: 'PINE_SCRIPT', calc: () => [] })

function removePineIndicator() {
  if (pinePane) coreChart?.removeIndicator(pinePane, 'PINE_SCRIPT')
  pinePane = null
  pineClient?.dispose()
  pineClient = null
}

function refreshPineIndicator() {
  if (!state.pineSource) return
  const source = state.pineSource
  removePineIndicator()
  void applyPineScript(source).catch((error: unknown) => showToast(`Pine Script: ${error instanceof Error ? error.message : String(error)}`))
}

export function clearPineScript() {
  pineGeneration++
  removePineIndicator()
  state.pineSource = ''
  notify()
}

export async function applyPineScript(source: string) {
  const core = coreChart
  if (!core) throw new Error('图表尚未加载')
  const generation = ++pineGeneration
  const client = new PineClient()
  try {
    const prepared = await client.prepare(source, state.timeframe)
    if (coreChart !== core || generation !== pineGeneration) throw new Error('图表已切换')
    const visibleBars = core.getDataList()
    await client.calculate(state.mode === 'replay'
      ? visibleBars.filter((bar) => bar.timestamp <= (currentBar()?.timestamp ?? 0)) : visibleBars)
    if (coreChart !== core || generation !== pineGeneration) throw new Error('图表已切换')
    removePineIndicator()
    pineClient = client
    const pane = core.createIndicator({
      name: 'PINE_SCRIPT', shortName: 'Pine', precision: prepared.overlay
        ? priceDigits(state.bars.at(-1)?.close ?? 0, state.currentQuote?.priceScale) : 4,
      figures: prepared.plots.map((plot, index) => ({
        key: `p${index}`, title: `${plot.title}: `, type: plot.style === 'line' ? 'line' : 'bar', baseValue: plot.baseValue,
        styles: (data) => ({
          color: typeof data.current.indicatorData?.[`c${index}`] === 'string'
            ? data.current.indicatorData[`c${index}`] as string : plot.color || PINE_COLORS[index],
          size: plot.linewidth,
        }),
      })),
      calc: async (dataList: KLineData[]) => {
        if (state.mode === 'replay' && (dataList.at(-1)?.timestamp ?? 0) > (currentBar()?.timestamp ?? 0)) {
          return dataList.map(() => ({}))
        }
        const length = dataList.length
        const firstTimestamp = dataList[0]?.timestamp
        const firstClose = dataList[0]?.close
        const lastTimestamp = dataList.at(-1)?.timestamp
        const lastClose = dataList.at(-1)?.close
        try {
          const rows = await client.calculate(dataList)
          const current = core.getDataList()
          if (pineClient !== client || current.length !== length || current[0]?.timestamp !== firstTimestamp ||
            current[0]?.close !== firstClose || current.at(-1)?.timestamp !== lastTimestamp || current.at(-1)?.close !== lastClose) {
            return current.map(() => ({}))
          }
          return rows
        } catch (error) {
          if (pineClient === client) window.setTimeout(() => {
            if (pineClient !== client) return
            clearPineScript()
            showToast(`Pine Script: ${error instanceof Error ? error.message : String(error)}`)
          }, 0)
          return core.getDataList().map(() => ({}))
        }
      },
    }, true, prepared.overlay ? { id: 'candle_pane' } : undefined)
    pinePane = prepared.overlay ? 'candle_pane' : pane
    if (!pinePane || !core.getIndicatorByPaneId(pinePane, 'PINE_SCRIPT')) throw new Error('无法创建指标图层')
    state.pineSource = source
    notify()
  } catch (error) {
    if (pineClient === client) removePineIndicator()
    else client.dispose()
    throw error
  }
}

function pointerTimestamp(event: MouseEvent, root: HTMLElement) {
  const point = coreChart?.convertFromPixel(
    { x: event.clientX - root.getBoundingClientRect().left },
    { paneId: 'candle_pane' },
  )
  return point?.timestamp ?? null
}

function actionTimestamp(data: { data?: { timestamp?: number }; kLineData?: { timestamp?: number }; timestamp?: number } | undefined) {
  return data?.data?.timestamp ?? data?.kLineData?.timestamp ?? data?.timestamp ?? null
}

function positionReplaySelector(timestamp: number) {
  const coordinate = coreChart?.convertToPixel({ timestamp }, { paneId: 'candle_pane', absolute: true })
  const x = coordinate?.x
  if (x == null || !Number.isFinite(x)) return
  const canvas = chartContainer?.querySelector('canvas')
  const main = document.querySelector('.tv-main')
  if (!canvas || !main) return
  const chartOffset = canvas.getBoundingClientRect().left - main.getBoundingClientRect().left
  const left = x + chartOffset
  state.replaySelectorLeft = left
  notify()
}

function refreshChart() {
  chart?.setPeriod({ ...currentTimeframe().period })
}

function resetPriceAxis() {
  const core = coreChart
  // KLineChart resets its manual Y-axis range when the axis type is reapplied.
  if (core) core.setStyles({ yAxis: { type: core.getStyles().yAxis.type } })
}

function nextBarTimestamp(timestamp: number) {
  const timeframe = currentTimeframe()
  if (timeframe.id !== 'M') return timestamp + timeframe.duration!
  const date = new Date(timestamp)
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1)
}

function quoteBarTimestamp(timestamp: number) {
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
  return Math.floor(timestamp / timeframe.duration!) * timeframe.duration!
}

function currentBar() {
  return state.bars[state.mode === 'replay' ? state.replayHead : state.liveHead]
}

function currentBarIndex() {
  return state.mode === 'replay' ? state.replayHead : state.liveHead
}

async function loadPaperState(): Promise<SavedState | null> {
  const response = await fetch('/api/paper/state', { cache: 'no-store' })
  if (!response.ok) throw new Error(`Paper state HTTP ${response.status}`)
  return response.json() as Promise<SavedState | null>
}

function applyPaperState(saved: SavedState | null) {
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
  if (persistTimer != null) window.clearTimeout(persistTimer)
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
  if (persistTimer != null) window.clearTimeout(persistTimer)
  persistTimer = window.setTimeout(persistPaperState, 120)
}

function updateReplayView() {
  updateMarketDetails()
  notify()
  queuePaperStateSave()
}

export function setPaperPanelOpen(open: boolean, { save = true } = {}) {
  state.paperPanelOpen = open
  notify()
  window.dispatchEvent(new Event('resize'))
  if (save) queuePaperStateSave()
}

export function setPaperPanelHeight(height: number, maxHeight = Number.POSITIVE_INFINITY) {
  const max = Math.max(PAPER_PANEL_MIN_HEIGHT, maxHeight)
  const next = Math.min(max, Math.max(PAPER_PANEL_MIN_HEIGHT, Math.round(height)))
  if (next === state.paperPanelHeight) return
  state.paperPanelHeight = next
  notify()
  window.dispatchEvent(new Event('resize'))
}

export function saveOnPageHide() {
  void persistPaperState({ keepalive: true })
}

export function dismissMenus(target: HTMLElement | null) {
  if (!target && state.searchOpen) return closeSymbolSearch()
  const speedOpen = state.speedMenuOpen
  const timeframeOpen = state.timeframeMenuOpen
  const contextOpen = state.contextMenu !== null
  if (!target || !target.closest('.speed-control')) state.speedMenuOpen = false
  if (!target || !target.closest('.timeframe-control')) state.timeframeMenuOpen = false
  if (!target || !target.closest('#chart-context-menu')) state.contextMenu = null
  if (speedOpen !== state.speedMenuOpen || timeframeOpen !== state.timeframeMenuOpen || contextOpen !== (state.contextMenu !== null)) notify()
}

export function getPaperPanelData() {
  const price = currentBar()?.close ?? 0
  const summary = paperSummary(state.paper, price, state.symbol.id)
  const tab = state.paperTab
  const positions = Object.values(state.paper.positions).filter(({ quantity }) => quantity).map((position) => ({
    ...position,
    protection: positionProtection(state.paper, position.symbol),
    openingTimestamp: positionOpeningTrade(position.symbol)?.barTimestamp,
  }))
  const orders = tab === 'orders' ? state.paper.orders : tab === 'order-history' ? state.paper.orderHistory : []
  const trades = tab === 'trade-history' ? state.paper.trades : []
  const items: (PaperOrder | PaperTrade)[] = tab === 'order-history' ? orders : trades
  const view = state.historyView[tab]
  const page = tab.endsWith('history') ? pagePaperHistory(items, { ...view, pageSize: HISTORY_PAGE_SIZE }) : null
  if (page && view) view.page = page.page
  return {
    open: state.paperPanelOpen,
    tab,
    summary,
    positions,
    orders,
    trades,
    positionsCount: positions.length,
    ordersCount: state.paper.orders.length,
    page,
    filters: view || null,
    price,
    symbol: state.symbol.id,
  }
}

export function getTradeLayerData() {
  const position = paperPosition(state.paper, state.symbol.id)
  const replayTimestamp = currentBar()?.timestamp ?? 0
  return {
    mode: state.mode,
    symbol: state.symbol,
    price: currentBar()?.close ?? state.currentQuote?.price ?? 0,
    position,
    orders: state.paper.orders.filter(({ symbol }) => symbol === state.symbol.id),
    trades: state.paper.trades.filter((trade): trade is PaperFillTrade => trade.event !== 'balance-reset' && trade.symbol === state.symbol.id && (state.mode !== 'replay' || trade.barTimestamp <= replayTimestamp)),
    draft: state.orderDraft,
  }
}

export function positionOpeningTrade(symbol: string): PaperFillTrade | undefined {
  return state.paper.trades.find((trade): trade is PaperFillTrade => trade.event !== 'balance-reset' && trade.symbol === symbol && trade.openedQuantity > 0)
}

export function orderTypeLabel(order: Pick<PaperOrder, 'role' | 'type'>) {
  if (order.role === 'take-profit') return '止盈'
  if (order.role === 'stop-loss') return '止损'
  return ({ market: '市价', limit: '限价', stop: '止损' })[order.type] || order.type
}

export function orderStatusLabel(status: PaperOrder['status']) {
  return ({ working: '挂单中', filled: '已成交', cancelled: '已取消' })[status] || status
}

function updateMarketDetails() {
  const bar = currentBar()
  if (!bar) return
  const quote = state.currentQuote
  const price = quote?.price ?? bar.close
  const change = quote?.change ?? 0
  const changePct = quote?.changePct ?? 0
  state.marketDetails = { price, change, changePct, volume: quote?.volume ?? bar.volume, priceScale: quote?.priceScale, logoId: quote?.logoId }
}

function applyQuote(quote: Quote) {
  const item = state.watchlist.find(({ id }) => id === quote.id)
  if (item) Object.assign(item, quote)
  state.watchlistStatus = new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(quote.timestamp)

  if (quote.id !== state.symbol.id) {
    processLivePaperQuote(quote)
    notify()
    return
  }
  const previousScale = state.currentQuote?.priceScale
  state.currentQuote = quote
  if (pinePane === 'candle_pane' && previousScale !== quote.priceScale) {
    coreChart?.overrideIndicator({ name: 'PINE_SCRIPT', precision: priceDigits(quote.price, quote.priceScale) }, pinePane)
  }
  let bar = state.bars[state.liveHead]
  if (!bar) { notify(); return }
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
  notify()
}

function processLivePaperQuote(quote: Quote) {
  if (state.mode !== 'live' || (!state.paper.positions[quote.id] && !state.paper.orders.some(({ symbol }) => symbol === quote.id))) return
  const tick = { timestamp: quote.timestamp, open: quote.price, high: quote.price, low: quote.price, close: quote.price, volume: 0 }
  const fills = processPaperBar(state.paper, tick, quote.id, state.liveHead)
  if (fills.length) queuePaperStateSave()
  if (state.paperPanelOpen) notify()
}

function connectQuoteStream() {
  state.eventSource?.close()
  const symbols = new Set(state.paper.orders.map(({ symbol }) => symbol))
  Object.keys(state.paper.positions).forEach((symbol) => symbols.add(symbol))
  symbols.add(state.symbol.id)
  state.watchlist.forEach(({ id }) => symbols.add(id))
  state.eventSource = new EventSource(`/api/tradingview/stream?symbols=${encodeURIComponent([...symbols].join(','))}`)
  state.eventSource.onmessage = (event) => applyQuote(JSON.parse(event.data))
  state.eventSource.onerror = () => { state.streamStatus = '重连中'; notify() }
}

async function switchSymbol(item: MarketSymbol, jumpTimestamp: number | null = null) {
  if (item.id === state.symbol.id) {
    closeSymbolSearch()
    if (jumpTimestamp != null && Number.isFinite(jumpTimestamp)) jumpToChartTimestamp(jumpTimestamp)
    return
  }
  showLoading(true)
  exitReplay()
  try {
    state.symbol = { ...item }
    state.focusTimestamp = jumpTimestamp != null && Number.isFinite(jumpTimestamp) ? jumpTimestamp : null
    state.currentQuote = null
    setupReplay(await loadBars(item.id))
    saveChartPreferences()
    const core = coreChart
    if (core && chart) {
      resetPriceAxis()
      core.clearData()
      chart.setSymbol(chartSymbol(state.symbol))
      core.applyNewData(chartWindowData(), true)
      if (pinePane === 'candle_pane') {
        core.overrideIndicator({ name: 'PINE_SCRIPT', precision: priceDigits(state.bars.at(-1)?.close ?? 0) }, pinePane)
      }
      window.requestAnimationFrame(() => {
        if (coreChart !== core) return
        if (jumpTimestamp != null && Number.isFinite(jumpTimestamp)) jumpToChartTimestamp(jumpTimestamp)
        else core.scrollToRealTime()
      })
    }
    updateReplayView()
    connectQuoteStream()
    closeSymbolSearch()
    persistPaperState()
  } catch (error) {
    showToast(`数据加载失败: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    showLoading(false)
  }
}

export async function switchTimeframe(timeframe: string) {
  if (!TIMEFRAMES.some(({ id }) => id === timeframe)) return
  if (timeframe === state.timeframe) {
    state.timeframeMenuOpen = false
    notify()
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
    notify()
    resetPriceAxis()
    chart?.setPeriod({ ...currentTimeframe().period })
    refreshPineIndicator()
    updateReplayView()
    state.timeframeMenuOpen = false
    notify()
    persistPaperState()
  } catch (error) {
    showToast(`周期切换失败: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    showLoading(false)
  }
}

function paperSymbol(symbol: string): MarketSymbol {
  if (state.symbol.id === symbol) return state.symbol
  const ticker = symbol.split(':').at(-1) || symbol
  return state.watchlist.find((item) => item.id === symbol) || {
    id: symbol,
    exchange: symbol.split(':')[0],
    symbol: ticker,
    description: ticker,
    type: 'spot',
  }
}

function jumpToPaperEvent(symbol: string, timestamp?: number | null) {
  const item = paperSymbol(symbol)
  if (!item) return
  return switchSymbol(item, timestamp != null && Number.isFinite(timestamp) ? timestamp : null)
}

export { jumpToPaperEvent }

function jumpToChartTimestamp(timestamp: number) {
  if (!state.bars.length) return
  const target = state.bars.find(({ timestamp: value }) => value === timestamp)
    || state.bars.reduce((closest, bar) => Math.abs(bar.timestamp - timestamp) < Math.abs(closest.timestamp - timestamp) ? bar : closest, state.bars[0])
  if (!target || !coreChart) return
  state.focusTimestamp = target.timestamp
  resetPriceAxis()
  coreChart.applyNewData(chartWindowData(), true)
  window.requestAnimationFrame(() => {
    coreChart?.scrollToTimestamp(target.timestamp, 300)
    renderTradeLayer()
  })
}

function addToWatchlist(item: MarketSymbol) {
  if (!state.watchlist.some(({ id }) => id === item.id)) {
    state.watchlist.push({ ...item, price: null, change: null, changePct: null, volume: null })
    saveWatchlist()
    notify()
    connectQuoteStream()
  }
  closeSymbolSearch()
}

function removeFromWatchlist(id: string) {
  state.watchlist = state.watchlist.filter((item) => item.id !== id)
  saveWatchlist()
  notify()
  connectQuoteStream()
}

export function openSymbolSearch(mode: 'switch' | 'add' = 'switch') {
  state.searchMode = mode
  state.searchFilter = ''
  state.searchQuery = mode === 'switch' ? state.symbol.symbol : ''
  state.searchOpen = true
  state.searchResults = []
  notify()
  if (mode === 'switch') searchSymbols(state.symbol.symbol)
}

export function closeSymbolSearch() {
  state.searchOpen = false
  notify()
}

async function searchSymbols(query: string) {
  if (!query.trim()) {
    state.searchResults = []
    notify()
    return
  }
  const response = await fetch(`/api/tradingview/search?q=${encodeURIComponent(query)}&filter=${encodeURIComponent(state.searchFilter)}`)
  if (!response.ok) return showToast('搜索失败')
  state.searchResults = await response.json() as SearchResult[]
  notify()
}

export function displayMarketType(type = '') {
  const labels: Record<string, string> = { spot: '现货', swap: '永续', futures: '期货', stock: '股票', forex: '外汇', index: '指数', economic: '经济' }
  return labels[type] || type
}

export function displayTypeSpecs(typeSpecs: string[] = []) {
  return typeSpecs.filter((type) => !['crypto'].includes(type)).join(' ')
}

export function step() {
  if (state.mode !== 'replay') return
  state.replayHead = Math.min(state.replayEnd, state.replayHead + 1)
  processPaperBar(state.paper, currentBar(), state.symbol.id, state.replayHead)
  refreshChart()
  updateReplayView()
  if (state.replayHead >= state.replayEnd) stopPlayback()
}

export function startPlayback() {
  if (state.mode !== 'replay' || state.playing || state.replayHead >= state.replayEnd) return
  state.playing = true
  notify()
  state.timer = window.setInterval(step, state.speed)
}

export function stopPlayback() {
  state.playing = false
  if (state.timer != null) window.clearInterval(state.timer)
  state.timer = null
  notify()
}

export function toggleReplay() {
  if (state.mode === 'live') {
    startBarSelection()
    return
  }
  exitReplay()
}

export function openReplay() {
  startBarSelection()
  window.dispatchEvent(new Event('resize'))
}

export function startBarSelection() {
  const wasReplay = state.mode === 'replay'
  stopPlayback()
  state.mode = 'select'
  state.selectionTimestamp = null
  state.replaySelectorLeft = null
  if (wasReplay) {
    resetPriceAxis()
    refreshChart()
  }
  updateReplayView()
}

function selectReplayBar(timestamp: number) {
  const index = state.bars.findIndex((bar) => bar.timestamp === timestamp)
  if (index < START_CONTEXT) return showToast('这根 K 线之前的历史数据不足')
  if (index > state.replayEnd) return showToast('请选择已经收盘的 K 线')
  stopPlayback()
  state.replayStart = Math.max(0, index - REPLAY_WINDOW + 1)
  state.replayHead = index
  state.mode = 'replay'
  state.selectionTimestamp = timestamp
  showReplayWorkspace()
  resetPriceAxis()
  refreshChart()
  updateReplayView()
  window.dispatchEvent(new Event('resize'))
}

export function showReplayWorkspace() {
  setPaperPanelOpen(true)
  notify()
}

export function exitReplay() {
  const shouldRefresh = state.mode === 'replay'
  stopPlayback()
  state.mode = 'live'
  setPaperPanelOpen(state.paperPanelOpen, { save: false })
  state.orderDraft = null
  state.replaySelectorLeft = null
  closeChartContextMenu()
  renderTradeLayer()
  persistPaperState()
  if (shouldRefresh) {
    resetPriceAxis()
    refreshChart()
  }
  updateMarketDetails()
  notify()
  window.dispatchEvent(new Event('resize'))
}

export function openChartContextMenu(event: MouseEvent, root: HTMLElement) {
  if (state.mode === 'select') return
  event.preventDefault()
  const point = coreChart?.convertFromPixel(
    { y: event.clientY - root.getBoundingClientRect().top },
    { paneId: 'candle_pane', absolute: true },
  )
  const price = point?.value
  if (price == null || !Number.isFinite(price)) return
  const main = document.querySelector<HTMLElement>('.tv-main')?.getBoundingClientRect()
  if (!main) return
  state.contextPrice = price
  const above = price >= (currentBar()?.close ?? 0)
  const first: { side: OrderSide; type: OrderType } = above ? { side: 'sell', type: 'limit' } : { side: 'buy', type: 'limit' }
  const second: { side: OrderSide; type: OrderType } = above ? { side: 'buy', type: 'stop' } : { side: 'sell', type: 'stop' }
  state.contextMenu = {
    left: Math.min(event.clientX - main.left, main.width - 310),
    top: Math.min(event.clientY - main.top, main.height - 180),
    price,
    first,
    second,
  }
  notify()
}

export function closeChartContextMenu() {
  state.contextMenu = null
  notify()
}

export function toggleTimeframeMenu() {
  state.timeframeMenuOpen = !state.timeframeMenuOpen
  state.speedMenuOpen = false
  notify()
}

export function toggleSpeedMenu() {
  state.speedMenuOpen = !state.speedMenuOpen
  state.timeframeMenuOpen = false
  notify()
}

export function setSpeed(speed: number | string, label: string) {
  const wasPlaying = state.playing
  stopPlayback()
  state.speed = Number(speed)
  state.speedLabel = label
  state.speedMenuOpen = false
  notify()
  if (wasPlaying) startPlayback()
}

export function setPaperTab(tab: PaperTab) {
  state.paperTab = tab
  queuePaperStateSave()
  notify()
}

export function setHistoryFilter(field: string, value: string) {
  const view = state.historyView[state.paperTab]
  if (!view || !['symbol', 'side'].includes(field)) return
  if (field === 'symbol') view.symbol = value
  else view.side = value
  view.page = 1
  notify()
}

export function changeHistoryPage(delta: number) {
  const view = state.historyView[state.paperTab]
  if (!view) return
  view.page += Number(delta)
  notify()
}

export function resetAccount() {
  if (!window.confirm('重置模拟账户至 $100,000？\n\n所有持仓和挂单将被清空，历史记录会保留。')) return
  resetPaperAccount(state.paper, INITIAL_CASH)
  state.orderDraft = null
  state.paperTab = 'trade-history'
  closeChartContextMenu()
  updateReplayView()
}

export function cancelOrder(id: number) {
  cancelPaperOrder(state.paper, Number(id), currentBar().timestamp)
  updateReplayView()
}

export async function closePosition(symbol: string, timestamp?: number) {
  await jumpToPaperEvent(symbol, timestamp)
  const position = paperPosition(state.paper, symbol)
  closePaperPosition(state.paper, symbol, position.marketPrice || currentBar().close, currentBarIndex(), currentBar().timestamp)
  updateReplayView()
}

export function setSearchQuery(query: string) {
  state.searchQuery = query
  if (searchTimer != null) window.clearTimeout(searchTimer)
  searchTimer = window.setTimeout(() => searchSymbols(query), 250)
  notify()
}

export function setSearchFilter(filter: string) {
  state.searchFilter = filter
  searchSymbols(state.searchQuery)
  notify()
}

export function selectSearchResult(index: number) {
  const item = state.searchResults[Number(index)]
  if (!item) return
  if (state.searchMode === 'add') addToWatchlist(item)
  else switchSymbol(item)
}

export function selectWatchlist(id: string) {
  const item = state.watchlist.find(({ id: itemId }) => itemId === id)
  if (item) switchSymbol(item)
}

export function removeWatchlist(id: string) {
  removeFromWatchlist(id)
}

export function setDraftQuantity(quantity: string) {
  if (!state.orderDraft) return
  state.orderDraft.quantity = Number(quantity)
  notify()
}

export function setDraftType(type: string) {
  if (!state.orderDraft) return
  if (type !== 'market' && type !== 'limit' && type !== 'stop') return
  state.orderDraft.type = type
  if (type === 'market') state.orderDraft.price = currentBar().close
  notify()
}

export function toggleDraftProtection(field: ProtectionField) {
  if (!state.orderDraft) return
  state.orderDraft[field] = state.orderDraft[field] == null ? state.orderDraft.price : null
  notify()
}

export function removeDraftProtection(field: ProtectionField) {
  if (!state.orderDraft) return
  state.orderDraft[field] = null
  notify()
}

export function cancelDraft() {
  state.orderDraft = null
  notify()
}

export function removeOrderProtection(id: number, field: ProtectionField) {
  const order = state.paper.orders.find(({ id: orderId }) => orderId === Number(id))
  if (order) order[field] = null
  updateReplayView()
}

export function openOrderDraft(side: OrderSide, type: OrderType, price = state.contextPrice ?? currentBar()?.close ?? 0) {
  state.orderDraft = {
    side,
    type,
    quantity: 0.01,
    price: type === 'market' ? currentBar().close : price,
    takeProfit: null,
    stopLoss: null,
  }
  closeChartContextMenu()
  notify()
}

export function submitOrderDraft() {
  const draft = state.orderDraft
  if (!draft) return
  try {
    const timestamp = state.mode === 'replay' ? currentBar().timestamp : state.currentQuote?.timestamp ?? Date.now()
    placePaperOrder(state.paper, { ...draft, symbol: state.symbol.id }, currentBar().close, currentBarIndex(), timestamp)
    state.orderDraft = null
    updateReplayView()
  } catch (error) {
    showToast(error instanceof Error ? error.message : String(error))
  }
}

function renderTradeLayer() {
  notify()
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

export function positionTradeLayerElements() {
  const layer = document.querySelector('#trade-layer')
  if (!layer || !coreChart || !chartContainer) return
  layer.querySelectorAll<HTMLElement>('.trade-marker').forEach(positionTradeMarker)
  layer.querySelectorAll<HTMLElement>('.trade-line[data-price]').forEach(positionTradeLine)
  layer.querySelectorAll<HTMLElement>('.protection-zone').forEach(positionProtectionZone)
}

function positionTradeMarker(element: HTMLElement) {
  const timestamp = Number(element.dataset.markerTimestamp)
  const bar = state.bars.find(({ timestamp: value }) => value === timestamp)
  if (!bar || !coreChart) return element.hidden = true
  const coordinate = coreChart.convertToPixel({ timestamp }, { paneId: 'candle_pane', absolute: true })
  const value = element.classList.contains('trade-marker-open') ? bar.low : bar.high
  const top = tradePriceTop(value)
  const canvas = document.querySelector('#chart canvas')
  const main = document.querySelector('.tv-main')
  const x = coordinate?.x
  if (x == null || !Number.isFinite(x) || !Number.isFinite(top) || !canvas || !main) return element.hidden = true
  element.style.left = `${x + canvas.getBoundingClientRect().left - main.getBoundingClientRect().left}px`
  element.style.top = `${top + (element.classList.contains('trade-marker-open') ? 12 : -12)}px`
  element.hidden = false
}

function positionTradeLine(element: HTMLElement) {
  const top = tradePriceTop(Number(element.dataset.price))
  if (!Number.isFinite(top)) return element.hidden = true
  const root = chartContainer?.querySelector('[k-line-chart-id]')?.getBoundingClientRect()
  const main = document.querySelector('.tv-main')?.getBoundingClientRect()
  if (!root || !main) return element.hidden = true
  element.style.top = `${top}px`
  element.hidden = top < root.top - main.top || top > root.bottom - main.top
}

function positionProtectionZone(element: HTMLElement) {
  const entry = tradePriceTop(Number(element.dataset.entry))
  const target = tradePriceTop(Number(element.dataset.target))
  if (!Number.isFinite(entry) || !Number.isFinite(target)) return element.hidden = true
  element.style.top = `${Math.min(entry, target)}px`
  element.style.height = `${Math.abs(entry - target)}px`
}

function tradePriceTop(price: number) {
  const coordinate = coreChart?.convertToPixel({ value: price }, { paneId: 'candle_pane', absolute: true })
  const y = coordinate?.y
  if (y == null || !Number.isFinite(y)) return NaN
  const root = chartContainer?.querySelector('[k-line-chart-id]')?.getBoundingClientRect()
  const main = document.querySelector('.tv-main')?.getBoundingClientRect()
  if (!root || !main) return NaN
  return y + root.top - main.top
}

export function beginDraftDrag(event: PointerEvent, role: ProtectionField | 'price', fromControl = false) {
  if (!fromControl && event.target instanceof Element && event.target.closest('button, input, select')) return
  event.preventDefault()
  const root = document.querySelector<HTMLElement>('#chart [k-line-chart-id]')
  const core = coreChart
  if (!root || !core) return
  dragEvents?.abort()
  dragEvents = new AbortController()
  const signal = dragEvents.signal
  const startY = event.clientY
  let moved = false
  const move = (moveEvent: PointerEvent) => {
    if (coreChart !== core) return
    if (Math.abs(moveEvent.clientY - startY) < 2) return
    moved = true
    const point = core.convertFromPixel(
      { y: moveEvent.clientY - root.getBoundingClientRect().top },
      { paneId: 'candle_pane', absolute: true },
    )
    const value = point?.value
    if (value == null || !Number.isFinite(value) || !state.orderDraft) return
    if (role === 'takeProfit') state.orderDraft.takeProfit = constrainProtection('takeProfit', value, state.orderDraft)
    else if (role === 'stopLoss') state.orderDraft.stopLoss = constrainProtection('stopLoss', value, state.orderDraft)
    else state.orderDraft.price = value
    renderTradeLayer()
  }
  const stop = () => {
    dragEvents?.abort()
    dragEvents = null
    if (!moved) renderTradeLayer()
  }
  document.addEventListener('pointermove', move, { signal })
  document.addEventListener('pointerup', stop, { signal })
  document.addEventListener('pointercancel', stop, { signal })
}

export function beginWorkingProtectionDrag(event: PointerEvent, element: HTMLElement) {
  if (event.target instanceof Element && event.target.closest('button')) return
  event.preventDefault()
  const root = document.querySelector<HTMLElement>('#chart [k-line-chart-id]')
  const core = coreChart
  if (!root || !core) return
  dragEvents?.abort()
  dragEvents = new AbortController()
  const signal = dragEvents.signal
  const position = paperPosition(state.paper, state.symbol.id)
  let moved = false
  const move = (moveEvent: PointerEvent) => {
    if (coreChart !== core) return
    const point = core.convertFromPixel(
      { y: moveEvent.clientY - root.getBoundingClientRect().top },
      { paneId: 'candle_pane', absolute: true },
    )
    const value = point?.value
    if (value == null || !Number.isFinite(value)) return
    const parent = state.paper.orders.find(({ id }) => id === Number(element.dataset.protectionParent))
    const protection = state.paper.orders.find(({ id }) => id === Number(element.dataset.protectionOrder))
    if (parent) {
      const field = element.dataset.protectionField
      if (field !== 'takeProfit' && field !== 'stopLoss') return
      parent[field] = constrainProtection(field, value, parent)
    } else if (protection && position.quantity) {
      const field = protection.role === 'take-profit' ? 'takeProfit' : 'stopLoss'
      const side = position.quantity > 0 ? 'buy' : 'sell'
      protection.price = constrainProtection(field, value, { side, price: position.averagePrice })
    } else {
      return
    }
    moved = true
    renderTradeLayer()
  }
  const stop = () => {
    dragEvents?.abort()
    dragEvents = null
    if (moved) updateReplayView()
  }
  document.addEventListener('pointermove', move, { signal })
  document.addEventListener('pointerup', stop, { signal })
  document.addEventListener('pointercancel', stop, { signal })
}

function constrainProtection(role: ProtectionField, value: number, draft: Pick<OrderDraft, 'side' | 'price'>) {
  const step = Math.max(draft.price * 0.00001, 0.00000001)
  if (role === 'takeProfit') return draft.side === 'buy' ? Math.max(value, draft.price + step) : Math.min(value, draft.price - step)
  return draft.side === 'buy' ? Math.min(value, draft.price - step) : Math.max(value, draft.price + step)
}

export function signClass(value: number | null | undefined) {
  if (value == null) return ''
  return value >= 0 ? 'positive' : 'negative'
}

export function formatMoney(value: number) {
  return `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

export function formatProjectedPnl(value: number) {
  return `${value >= 0 ? '+' : '−'}${Math.abs(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USD`
}

export function formatPnlPercent(value: number) {
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`
}

function formatQuantity(value: number) {
  return value.toLocaleString('en-US', { maximumFractionDigits: 8 })
}

export function formatOrderQuantity(value: number, symbol = '') {
  return `${formatQuantity(value)} ${baseCurrency(symbol.split(':').at(-1) || '')}`
}

export function formatTimestamp(value: number) {
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(value)
}

function priceDigits(value: number, priceScale?: number) {
  return priceScale != null && Number.isFinite(priceScale) && priceScale > 0
    ? Math.min(8, Math.max(0, Math.round(Math.log10(priceScale))))
    : value >= 1 ? 2 : value >= 0.01 ? 5 : 8
}

export function formatPrice(value: number, priceScale?: number) {
  const digits = priceDigits(value, priceScale)
  return value.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })
}

export function formatSigned(value: number) {
  const digits = Math.abs(value) >= 1 ? 2 : Math.abs(value) >= 0.01 ? 4 : 6
  return `${value >= 0 ? '+' : ''}${value.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`
}

function formatCompact(value: number) {
  if (value >= 1e9) return `${(value / 1e9).toFixed(2)}B`
  if (value >= 1e6) return `${(value / 1e6).toFixed(2)}M`
  if (value >= 1e3) return `${(value / 1e3).toFixed(2)}K`
  return value.toFixed(2)
}

export function showToast(message: string) {
  state.toast = message
  notify()
  if (toastTimer != null) window.clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => {
    state.toast = ''
    notify()
  }, 1800)
}

export function showLoading(visible: boolean) {
  state.loading = visible
  notify()
}

export async function start() {
  const generation = ++startupGeneration
  showLoading(true)
  try {
    try {
      const saved = await loadPaperState()
      if (generation !== startupGeneration) return
      applyPaperState(saved)
    } catch (error) {
      if (generation !== startupGeneration) return
      console.error('Paper state load failed:', error)
      showToast('模拟交易状态读取失败')
    }
    const bars = await loadBars()
    if (generation !== startupGeneration) return
    setupReplay(bars)
    restoreReplaySession()
    if (state.mode === 'live') await catchUpPaperOrders()
    if (generation !== startupGeneration) return
    if (chartContainer) renderChart()
    if (state.mode === 'replay') showReplayWorkspace()
    else setPaperPanelOpen(state.paperPanelOpen, { save: false })
    updateReplayView()
    connectQuoteStream()
  } catch (error) {
    if (generation === startupGeneration) showToast(`数据加载失败: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    if (generation === startupGeneration) showLoading(false)
  }
}
