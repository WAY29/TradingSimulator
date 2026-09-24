import { KLineChartPro } from '@klinecharts/pro'
import type { Datafeed, DatafeedSubscribeCallback, SymbolInfo } from '@klinecharts/pro'
import { ActionType, dispose as disposeKLineChart, getSupportedIndicators, getSupportedOverlays, init as getKLineChart, registerIndicator } from 'klinecharts'
import type { Chart, Coordinate, Indicator, KLineData, Overlay, Point } from 'klinecharts'
import { PineClient } from './pine-client'
import { drawPine, pineLegend, pineSubPrecision } from './pine-renderer'
import type { PineResult } from './pine'
import { newChartLayout, readChartLayouts, CHART_LAYOUTS_KEY } from './chart-layouts.ts'
import type { ChartDrawing, ChartLayout, ChartView } from './chart-layouts.ts'
import {
  cancelPaperOrder,
  closePaperPosition,
  createPaperAccount,
  normalizePaperAccount,
  normalizePaperFill,
  pagePaperHistory,
  paperTradeHistory,
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
type ChartAxis = {
  getAutoCalcTickFlag(): boolean
  setAutoCalcTickFlag(auto: boolean): void
  getRange(): ChartView['ranges'][string]
  setRange(range: ChartView['ranges'][string]): void
}
type ChartPane = {
  getId(): string
  getBounding(): { height: number }
  getAxisComponent(): ChartAxis
}
type ChartInternals = CoreChart & {
  getAllDrawPanes(): ChartPane[]
  getChartStore(): {
    getOverlayStore(): { getInstances(): Overlay[] }
    getTimeScaleStore(): { getLastBarRightSideDiffBarCount(): number }
  }
  adjustPaneViewport(measureHeight: boolean, measureWidth: boolean, update: boolean, adjustAxis: boolean, forceAxis: boolean): void
}
type SavedState = { paper: Partial<PaperAccount>; session: ReplaySession }

const listeners = new Set<() => void>()
const chartLayouts = readChartLayouts(localStorage, loadSelectedMarket(), loadSelectedTimeframe())

function activeChartLayout() {
  return chartLayouts.items.find(({ id }) => id === chartLayouts.activeId)!
}

const state: ControllerState = {
  symbol: { ...activeChartLayout().symbol },
  timeframe: activeChartLayout().timeframe,
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
  pineSource: activeChartLayout().pineSource,
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
let saveInFlight: Promise<void> | null = null
let saveAgain = false
let paperSyncSerial = 0
let paperDirty = false
let paperChannel: BroadcastChannel | null = null
let toastTimer: number | null = null
let persistErrorShown = false
let startupGeneration = 0
let pineClient: PineClient | null = null
let pinePanes: string[] = []
let pineResult: PineResult | null = null
let pineGeneration = 0
let togglePineEditor: (() => void) | null = null
let chartLayoutSwitch = 0
let chartLayoutReady = false
let chartDefaultBarSpace = 8
let chartLayoutSaveTimer: number | null = null
let chartContextSerial = 0

export function setPineEditorToggle(callback: (() => void) | null) {
  togglePineEditor = callback
}

export function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getControllerState() {
  return state
}

export function getChartLayouts() {
  return { activeId: chartLayouts.activeId, items: chartLayouts.items.map(({ id, name }) => ({ id, name })) }
}

function writeChartLayouts() {
  try {
    localStorage.setItem(CHART_LAYOUTS_KEY, JSON.stringify(chartLayouts))
    return true
  } catch {
    showToast('图表配置保存失败，请检查浏览器存储空间')
    return false
  }
}

function paneForIndicator(core: CoreChart, name: string) {
  return (core as ChartInternals).getAllDrawPanes().find((pane) => {
    const indicators = core.getIndicatorByPaneId(pane.getId()) as Map<string, Indicator> | null
    return indicators instanceof Map && indicators.has(name)
  })
}

function paneKey(core: CoreChart, paneId: string) {
  if (paneId === 'candle_pane') return paneId
  const indicators = core.getIndicatorByPaneId(paneId) as Map<string, Indicator> | null
  return indicators instanceof Map ? indicators.keys().next().value as string || paneId : paneId
}

function viewKey() {
  return `${state.symbol.id}/${state.timeframe}`
}

function captureChartLayout() {
  if (!chartLayoutReady || !coreChart || state.mode !== 'live' || !coreChart.getDataList().length) return false
  const core = coreChart
  const internals = core as ChartInternals
  const layout = activeChartLayout()
  const ranges: ChartView['ranges'] = {}
  const paneHeights: NonNullable<ChartView['paneHeights']> = {}
  layout.indicators = internals.getAllDrawPanes().flatMap((pane) => {
    const paneId = pane.getId()
    if (paneId === 'x_axis_pane') return []
    if (paneId !== 'candle_pane') paneHeights[paneKey(core, paneId)] = pane.getBounding().height
    const axis = pane.getAxisComponent()
    if (!axis.getAutoCalcTickFlag()) ranges[paneKey(core, paneId)] = { ...axis.getRange() }
    const indicators = core.getIndicatorByPaneId(paneId) as Map<string, Indicator> | null
    if (!(indicators instanceof Map)) return []
    return [...indicators.values()].filter(({ name }) => name !== 'PINE_SCRIPT').map((indicator) => ({
      name: indicator.name, pane: paneId === 'candle_pane' ? paneId : indicator.name,
      calcParams: indicator.calcParams, visible: indicator.visible, styles: indicator.styles,
      series: indicator.series, height: paneId === 'candle_pane' ? undefined : pane.getBounding().height,
    }))
  })
  const supported = new Set(getSupportedOverlays())
  const presentPanes = new Set(internals.getAllDrawPanes().map((pane) => paneKey(core, pane.getId())))
  layout.drawings = layout.drawings.filter(({ symbol, pane }) => symbol !== state.symbol.id || !presentPanes.has(pane)).concat(internals.getChartStore().getOverlayStore().getInstances()
    .filter((overlay) => supported.has(overlay.name))
    .map((overlay): ChartDrawing => ({
      id: overlay.id, groupId: overlay.groupId, name: overlay.name,
      symbol: state.symbol.id,
      pane: paneKey(core, overlay.paneId), points: overlay.points.map((point) => ({ ...point })),
      lock: overlay.lock, visible: overlay.visible, zLevel: overlay.zLevel, mode: overlay.mode,
      styles: overlay.styles, extendData: overlay.extendData,
    })))
  layout.views[viewKey()] = {
    barSpace: core.getBarSpace(),
    rightBars: internals.getChartStore().getTimeScaleStore().getLastBarRightSideDiffBarCount(),
    ranges,
    paneHeights,
  }
  layout.pineSource = state.pineSource
  return writeChartLayouts()
}

function queueChartLayoutSave() {
  if (!chartLayoutReady || state.mode !== 'live') return
  if (chartLayoutSaveTimer != null) window.clearTimeout(chartLayoutSaveTimer)
  chartLayoutSaveTimer = window.setTimeout(() => { chartLayoutSaveTimer = null; captureChartLayout() }, 160)
}

function flushChartLayout() {
  if (chartLayoutSaveTimer != null) window.clearTimeout(chartLayoutSaveTimer)
  chartLayoutSaveTimer = null
  return captureChartLayout()
}

export function saveChartLayout() {
  if (state.mode !== 'live') return showToast('退出 Replay 后再保存图表')
  if (!chartLayoutReady || !coreChart?.getDataList().length) return showToast('图表尚未加载完成')
  if (flushChartLayout()) showToast('图表已保存')
}

async function restoreChartLayout(core: CoreChart) {
  const layout = activeChartLayout()
  const supported = new Set(getSupportedIndicators())
  for (const item of layout.indicators) {
    if (!supported.has(item.name)) continue
    const pane = item.pane === 'candle_pane'
      ? (core as ChartInternals).getAllDrawPanes().find((pane) => pane.getId() === 'candle_pane')
      : paneForIndicator(core, item.name)
    if (!pane) continue
    core.overrideIndicator({ name: item.name, calcParams: item.calcParams, visible: item.visible,
      styles: item.styles || undefined, series: item.series }, pane.getId())
    if (item.height && pane.getId() !== 'candle_pane') core.setPaneOptions({ id: pane.getId(), height: item.height })
  }
  if (layout.pineSource) {
    try { await applyPineScript(layout.pineSource) }
    catch (error) { if (coreChart === core) showToast(`Pine Script: ${error instanceof Error ? error.message : String(error)}`) }
  }
  if (coreChart !== core || activeChartLayout() !== layout) return
  restoreChartView(core, layout)
  restoreChartDrawings(core, layout)
  chartLayoutReady = true
}

function restoreChartDrawings(core: CoreChart, layout: ChartLayout) {
  const overlays = new Set(getSupportedOverlays())
  for (const drawing of layout.drawings.filter(({ symbol }) => symbol === state.symbol.id)) {
    if (!overlays.has(drawing.name)) continue
    const paneId = drawing.pane === 'candle_pane' ? drawing.pane : paneForIndicator(core, drawing.pane)?.getId()
    if (paneId) {
      const { pane: _pane, symbol: _symbol, ...overlay } = drawing
      core.createOverlay(overlay, paneId)
    }
  }
}

function restoreChartView(core: CoreChart, layout: ChartLayout) {
  const view = layout.views[viewKey()]
  const internals = core as ChartInternals
  internals.getAllDrawPanes().forEach((pane) => {
    if (pane.getId() !== 'x_axis_pane') pane.getAxisComponent().setAutoCalcTickFlag(true)
  })
  if (view && Number.isFinite(view.barSpace) && view.barSpace > 0) {
    core.setBarSpace(view.barSpace)
    const scale = internals.getChartStore().getTimeScaleStore()
    core.scrollByDistance((scale.getLastBarRightSideDiffBarCount() - view.rightBars) * core.getBarSpace())
  } else core.setBarSpace(chartDefaultBarSpace)
  if (view) {
    for (const [key, height] of Object.entries(view.paneHeights || {})) {
      const pane = paneForIndicator(core, key)
      if (pane && Number.isFinite(height) && height > 0) core.setPaneOptions({ id: pane.getId(), height })
    }
    for (const [key, range] of Object.entries(view.ranges)) {
      const pane = key === 'candle_pane'
        ? (core as ChartInternals).getAllDrawPanes().find((pane) => pane.getId() === key)
        : paneForIndicator(core, key)
      if (pane && Object.values(range).every(Number.isFinite)) pane.getAxisComponent().setRange(range)
    }
  }
  internals.adjustPaneViewport(false, true, true, true, true)
}

function restoreChartContextOnData(core: CoreChart, pineReady?: Promise<void>) {
  const serial = ++chartContextSerial
  const symbol = state.symbol.id
  const timeframe = state.timeframe
  const restore = () => {
    if (serial !== chartContextSerial || coreChart !== core || state.symbol.id !== symbol || state.timeframe !== timeframe) {
      core.unsubscribeAction(ActionType.OnDataReady, restore)
      return
    }
    const current = core.getDataList()
    const expected = state.bars[state.liveHead]
    if (!current.length || !expected || current.at(-1)?.timestamp !== expected.timestamp || current.at(-1)?.close !== expected.close) return
    core.unsubscribeAction(ActionType.OnDataReady, restore)
    const finish = () => {
      if (serial !== chartContextSerial || coreChart !== core || state.symbol.id !== symbol || state.timeframe !== timeframe) return
      restoreChartDrawings(core, activeChartLayout())
      restoreChartView(core, activeChartLayout())
      chartLayoutReady = true
      queueChartLayoutSave()
    }
    if (pineReady) void pineReady.then(finish)
    else finish()
  }
  core.subscribeAction(ActionType.OnDataReady, restore)
  window.requestAnimationFrame(restore)
}

export function createChartLayout() {
  if (state.loading) return
  const layout = newChartLayout(state.symbol, state.timeframe, uniqueChartName('图表', 1))
  chartLayouts.items.push(layout)
  void selectChartLayout(layout.id)
}

function uniqueChartName(base: string, start = 0) {
  let number = start
  let name = number ? `${base} ${number}` : base
  while (chartLayouts.items.some((item) => item.name === name)) {
    number = Math.max(2, number + 1)
    name = `${base} ${number}`
  }
  return name
}

export function duplicateChartLayout(id: string) {
  if (state.loading) return
  if (id === chartLayouts.activeId) flushChartLayout()
  const source = chartLayouts.items.find((item) => item.id === id)
  if (!source) return
  const layout: ChartLayout = { ...structuredClone(source), id: crypto.randomUUID(), name: uniqueChartName(`${source.name} 副本`) }
  chartLayouts.items.push(layout)
  void selectChartLayout(layout.id)
}

export function renameChartLayout(id: string, name: string) {
  const layout = chartLayouts.items.find((item) => item.id === id)
  const next = name.trim().slice(0, 40)
  if (!layout || !next) return
  layout.name = next
  writeChartLayouts()
  notify()
}

export async function deleteChartLayout(id: string) {
  if (state.loading || chartLayouts.items.length < 2) return
  if (id === chartLayouts.activeId) {
    const next = chartLayouts.items.find((item) => item.id !== id)!
    await selectChartLayout(next.id)
    if (chartLayouts.activeId !== next.id) return
  }
  chartLayouts.items = chartLayouts.items.filter((item) => item.id !== id)
  writeChartLayouts()
  notify()
}

export async function selectChartLayout(id: string) {
  const target = chartLayouts.items.find((item) => item.id === id)
  if (!target || id === chartLayouts.activeId || state.loading) return
  const wasLive = state.mode === 'live'
  if (wasLive) flushChartLayout()
  else chartLayoutReady = false
  const serial = ++chartLayoutSwitch
  if (state.mode !== 'live') exitReplay(false)
  showLoading(true)
  try {
    const changed = target.symbol.id !== state.symbol.id || target.timeframe !== state.timeframe
    const bars = changed ? await loadBars(target.symbol.id, target.timeframe) : null
    if (serial !== chartLayoutSwitch) return
    if (wasLive) flushChartLayout()
    chartLayoutReady = false
    state.symbol = { ...target.symbol }
    state.timeframe = target.timeframe
    state.pineSource = target.pineSource
    state.currentQuote = null
    if (bars) setupReplay(bars)
    chartLayouts.activeId = id
    saveChartPreferences()
    writeChartLayouts()
    connectQuoteStream()
    updateReplayView()
    notify()
  } catch (error) {
    chartLayoutReady = true
    showToast(`图表切换失败: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    if (serial === chartLayoutSwitch) showLoading(false)
  }
}

export function dispose() {
  flushChartLayout()
  startupGeneration++
  stopPlayback()
  state.eventSource?.close()
  state.eventSource = null
  liveSubscriber = null
  if (searchTimer) window.clearTimeout(searchTimer)
  if (persistTimer != null) void persistPaperState({ keepalive: true })
  paperChannel?.close()
  paperChannel = null
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
  if (state.mode === 'live') {
    const layout = activeChartLayout()
    layout.symbol = { ...state.symbol }
    layout.timeframe = state.timeframe
    writeChartLayouts()
  }
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
    const start = inReplay
      ? state.replayStart
      : Math.max(0, end - REPLAY_WINDOW + 1)
    const visibleEnd = end
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
      if (processPaperBars(state.paper, bars.filter((bar) => bar.timestamp >= activeAt), symbol).length) markPaperChanged()
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
  const start = state.mode === 'replay' ? state.replayStart : Math.max(0, end - REPLAY_WINDOW + 1)
  return state.bars.slice(start, end + 1)
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
  chartLayoutReady = false
  if (chartLayoutSaveTimer != null) window.clearTimeout(chartLayoutSaveTimer)
  chartLayoutSaveTimer = null
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
  const indicators = activeChartLayout().indicators
  chart = new KLineChartPro({
    container: chartContainer, theme: 'dark', locale: 'zh-CN', timezone: 'Asia/Shanghai',
    drawingBarVisible: true, symbol: chartSymbol(state.symbol), period, periods: [period],
    mainIndicators: indicators.filter(({ pane }) => pane === 'candle_pane').map(({ name }) => name),
    subIndicators: indicators.filter(({ pane }) => pane !== 'candle_pane').map(({ name }) => name),
    datafeed: replayDatafeed,
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
  chartDefaultBarSpace = core.getBarSpace()
  const { icons, text } = core.getStyles().indicator.tooltip
  const openEye = icons.find(({ id }) => id === 'visible')?.icon
  const closedEye = icons.find(({ id }) => id === 'invisible')?.icon
  core.setStyles({ indicator: { tooltip: { icons: icons.map((icon) => ({
    ...icon,
    marginTop: text.marginTop + (text.size - icon.size) / 2,
    icon: icon.id === 'visible' ? closedEye ?? icon.icon :
      icon.id === 'invisible' ? openEye ?? icon.icon : icon.icon,
  })) } } })
  core.subscribeAction(ActionType.OnCrosshairChange, (data) => {
    if (state.mode !== 'select') return
    const timestamp = actionTimestamp(data)
    if (!timestamp) return
    state.selectionTimestamp = timestamp
    positionReplaySelector(timestamp)
  })
  core.subscribeAction(ActionType.OnTooltipIconClick, (data: { indicatorName?: string; iconId?: string } | undefined) => {
    if (data?.indicatorName !== 'PINE_SCRIPT') return
    if (data.iconId === 'pine-editor') togglePineEditor?.()
    if (data.iconId === 'pine-remove') clearPineScript()
  })
  ;[ActionType.OnZoom, ActionType.OnScroll, ActionType.OnVisibleRangeChange, ActionType.OnPaneDrag]
    .forEach((type) => core.subscribeAction(type, () => { syncTradeLayerPosition(); queueChartLayoutSave() }))
  const watchChange = () => window.setTimeout(queueChartLayoutSave, 0)
  const createOverlay = core.createOverlay.bind(core)
  core.createOverlay = (...args) => { const value = createOverlay(...args); watchChange(); return value }
  const overrideOverlay = core.overrideOverlay.bind(core)
  core.overrideOverlay = (...args) => { overrideOverlay(...args); watchChange() }
  const removeOverlay = core.removeOverlay.bind(core)
  core.removeOverlay = (...args) => { removeOverlay(...args); watchChange() }
  const createIndicator = core.createIndicator.bind(core)
  core.createIndicator = (...args) => {
    const value = createIndicator(...args)
    if ((typeof args[0] === 'string' ? args[0] : args[0].name) !== 'PINE_SCRIPT') watchChange()
    return value
  }
  const overrideIndicator = core.overrideIndicator.bind(core)
  core.overrideIndicator = (...args) => { overrideIndicator(...args); if (args[0].name !== 'PINE_SCRIPT') watchChange() }
  const removeIndicator = core.removeIndicator.bind(core)
  core.removeIndicator = (...args) => { removeIndicator(...args); if (args[1] !== 'PINE_SCRIPT') watchChange() }
  const setPaneOptions = core.setPaneOptions.bind(core)
  core.setPaneOptions = (...args) => { setPaneOptions(...args); watchChange() }
  document.addEventListener('pointerup', queueChartLayoutSave, { signal: chartEvents.signal })
  document.addEventListener('keyup', queueChartLayoutSave, { signal: chartEvents.signal })
  document.addEventListener('change', queueChartLayoutSave, { signal: chartEvents.signal })
  const restore = () => {
    if (chartLayoutReady || !core.getDataList().length) return
    // The ready flag stays false until the one-time async Pine restoration finishes.
    core.unsubscribeAction(ActionType.OnDataReady, restore)
    void restoreChartLayout(core).catch((error: unknown) => {
      if (coreChart === core) showToast(`图表恢复失败: ${error instanceof Error ? error.message : String(error)}`)
    })
  }
  core.subscribeAction(ActionType.OnDataReady, restore)
  restore()
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
  resizeChart()
  renderTradeLayer()
}

const PINE_COLORS = ['#38bdf8', '#f0b90b', '#22ab94', '#e879f9', '#ef5350', '#a3e635', '#fb923c', '#a5b4fc']
registerIndicator({ name: 'PINE_SCRIPT', calc: () => [] })

function removePineIndicator() {
  pinePanes.forEach((pane) => coreChart?.removeIndicator(pane, 'PINE_SCRIPT'))
  pinePanes = []
  pineResult = null
  pineClient?.dispose()
  pineClient = null
}

function refreshPineIndicator(): Promise<void> {
  if (!state.pineSource) return Promise.resolve()
  const source = state.pineSource
  removePineIndicator()
  return applyPineScript(source).then(() => {}, (error: unknown) => {
    showToast(`Pine Script: ${error instanceof Error ? error.message : String(error)}`)
  })
}

export function clearPineScript() {
  pineGeneration++
  removePineIndicator()
  state.pineSource = ''
  activeChartLayout().pineSource = ''
  writeChartLayouts()
  notify()
}

export async function applyPineScript(source: string) {
  const core = coreChart
  if (!core) throw new Error('图表尚未加载')
  const generation = ++pineGeneration
  const client = new PineClient()
  try {
    const visibleBars = core.getDataList()
    const symbol = state.symbol.id
    const timeframe = state.timeframe
    const mode = state.mode
    const scale = state.currentQuote?.priceScale ?? 10 ** priceDigits(visibleBars.at(-1)?.close ?? 0)
    const prepared = await client.prepare(source, timeframe, symbol, mode === 'replay'
      ? visibleBars.filter((bar) => bar.timestamp <= (currentBar()?.timestamp ?? 0)) : visibleBars, scale)
    if (coreChart !== core || generation !== pineGeneration || state.symbol.id !== symbol || state.timeframe !== timeframe || state.mode !== mode) throw new Error('图表已切换')
    if (state.mode === 'replay' && (core.getDataList().at(-1)?.timestamp ?? 0) > (currentBar()?.timestamp ?? 0)) {
      throw new Error('回放图表尚未加载')
    }
    removePineIndicator()
    pineClient = client
    pineResult = prepared
    const figures = (main: boolean) => prepared.plots.flatMap((plot, index) =>
      main === plot.overlay ? [{
        key: `p${index}`, title: `${plot.title}: `, type: plot.style === 'circles' ? 'circle' :
          ['histogram', 'columns'].includes(plot.style) ? 'bar' : 'line', baseValue: plot.baseValue,
        styles: (data: { current: { indicatorData?: Record<string, number | string> } }) => ({
          color: typeof data.current.indicatorData?.[`c${index}`] === 'string'
            ? data.current.indicatorData[`c${index}`] as string : plot.color || PINE_COLORS[index % PINE_COLORS.length],
          size: plot.linewidth,
        }),
      }] : [])
    const calc = async (dataList: KLineData[]) => {
      if (state.mode === 'replay' && (dataList.at(-1)?.timestamp ?? 0) > (currentBar()?.timestamp ?? 0)) {
        return dataList.map(() => ({}))
      }
      const length = dataList.length
      const symbol = state.symbol.id
      const timeframe = state.timeframe
      const firstTimestamp = dataList[0]?.timestamp
      const firstClose = dataList[0]?.close
      const lastTimestamp = dataList.at(-1)?.timestamp
      const lastClose = dataList.at(-1)?.close
      try {
        const scale = state.currentQuote?.priceScale ?? 10 ** priceDigits(dataList.at(-1)?.close ?? 0)
        const result = await client.calculate(dataList, timeframe, symbol, scale)
        const current = core.getDataList()
        if (pineClient !== client || state.symbol.id !== symbol || state.timeframe !== timeframe ||
          current.length !== length || current[0]?.timestamp !== firstTimestamp ||
          current[0]?.close !== firstClose || current.at(-1)?.timestamp !== lastTimestamp || current.at(-1)?.close !== lastClose) {
          return current.map(() => ({}))
        }
        pineResult = result
        const subPane = pinePanes.find((pane) => pane !== 'candle_pane')
        const precision = pineSubPrecision(result)
        if (subPane && (core.getIndicatorByPaneId(subPane, 'PINE_SCRIPT') as Indicator | null)?.precision !== precision) {
          window.setTimeout(() => {
            if (pineClient === client && coreChart === core && state.symbol.id === symbol && state.timeframe === timeframe &&
              (core.getIndicatorByPaneId(subPane, 'PINE_SCRIPT') as Indicator | null)?.precision !== precision) {
              core.overrideIndicator({ name: 'PINE_SCRIPT', precision }, subPane)
            }
          }, 0)
        }
        return result.rows
      } catch (error) {
        if (pineClient === client) window.setTimeout(() => {
          if (pineClient !== client) return
          clearPineScript()
          showToast(`Pine Script: ${error instanceof Error ? error.message : String(error)}`)
        }, 0)
        return core.getDataList().map(() => ({}))
      }
    }
    const create = (main: boolean) => core.createIndicator({
      name: 'PINE_SCRIPT', shortName: prepared.name, precision: main
        ? priceDigits(state.bars.at(-1)?.close ?? 0, state.currentQuote?.priceScale) : pineSubPrecision(prepared),
      figures: figures(main),
      createTooltipDataSource: ({ indicator, defaultStyles, bounding, crosshair }) => {
        const defaults = defaultStyles.tooltip.icons
        const eye = defaults.find(({ id }) => id === (indicator.visible ? 'invisible' : 'visible'))
        const settings = defaults.find(({ id }) => id === 'setting')
        const close = defaults.find(({ id }) => id === 'close')
        const limit = Math.max(4, Math.floor((bounding.width - 115) / 14))
        const letters = Array.from(prepared.name)
        return {
          name: letters.length > limit ? `${letters.slice(0, limit).join('')}…` : prepared.name,
          icons: [eye, settings && { ...settings, id: 'pine-editor' }, close && { ...close, id: 'pine-remove' }]
            .filter((icon) => icon != null),
          calcParamsText: '',
          values: pineLegend(prepared, indicator.result, main, crosshair.dataIndex ?? indicator.result.length - 1, indicator.precision),
        }
      },
      draw: (params) => drawPine(params, pineResult, main),
      calc,
    }, true, main ? { id: 'candle_pane' } : undefined)
    const main = prepared.overlay || prepared.plots.some((plot) => plot.overlay)
    if (!prepared.overlay) {
      const subPane = create(false)
      if (!subPane || !core.getIndicatorByPaneId(subPane, 'PINE_SCRIPT')) throw new Error('无法创建副图指标')
      pinePanes.push(subPane)
    }
    if (main) {
      create(true)
      if (!core.getIndicatorByPaneId('candle_pane', 'PINE_SCRIPT')) throw new Error('无法创建主图指标')
      pinePanes.push('candle_pane')
    }
    state.pineSource = source
    activeChartLayout().pineSource = source
    writeChartLayouts()
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

function applyPaperAccount(paper: Partial<PaperAccount>, fallbackSymbol?: string) {
  const empty = createPaperAccount({ initialBalance: INITIAL_CASH, feeRate: FEE_RATE, slippageRate: SLIPPAGE_RATE })
  state.paper = {
    ...empty,
    ...paper,
    positions: paper.positions || empty.positions,
    orders: paper.orders || [],
    orderHistory: paper.orderHistory || [],
    trades: paper.trades || [],
  }
  normalizePaperAccount(state.paper, fallbackSymbol)
}

function applyPaperState(saved: SavedState | null) {
  if (!saved?.paper || !saved.session) return
  applyPaperAccount(saved.paper, saved.session.symbol?.id)
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
  if (saveInFlight) { saveAgain = true; return saveInFlight }
  saveInFlight = (async () => {
    do {
      saveAgain = false
      const serial = paperSyncSerial
      const snapshot = paperStateSnapshot()
      try {
        const response = await fetch('/api/paper/state', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(snapshot),
          keepalive,
        })
        if (!response.ok) throw new Error(`Paper state HTTP ${response.status}`)
        persistErrorShown = false
        if (serial !== paperSyncSerial) saveAgain = true
        else {
          paperDirty = false
          paperChannel?.postMessage(snapshot.paper)
        }
      } catch (error) {
        console.error('Paper state save failed:', error)
        if (!persistErrorShown) showToast('模拟交易状态保存失败')
        persistErrorShown = true
      }
    } while (saveAgain)
  })().finally(() => { saveInFlight = null })
  return saveInFlight
}

function queuePaperStateSave() {
  if (persistTimer != null) window.clearTimeout(persistTimer)
  persistTimer = window.setTimeout(persistPaperState, 120)
}

function markPaperChanged() {
  paperDirty = true
  paperSyncSerial++
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
  flushChartLayout()
  if (persistTimer != null) void persistPaperState({ keepalive: true })
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
  }))
  const orders = tab === 'orders' ? state.paper.orders : tab === 'order-history'
    ? [...state.paper.orderHistory].sort((a, b) => b.createdAt - a.createdAt || b.id - a.id) : []
  const trades = tab === 'trade-history' ? paperTradeHistory(state.paper.trades, state.paper.orderHistory) : []
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
  const orders = new Map(state.paper.orderHistory.map((order) => [order.id, order]))
  return {
    mode: state.mode,
    symbol: state.symbol,
    price: currentBar()?.close ?? state.currentQuote?.price ?? 0,
    position,
    orders: state.paper.orders.filter(({ symbol }) => symbol === state.symbol.id),
    trades: state.paper.trades.filter((trade): trade is PaperFillTrade => trade.event !== 'balance-reset' && trade.symbol === state.symbol.id)
      .map((trade) => normalizePaperFill(trade, orders.get(trade.id)))
      .filter((trade) => state.mode !== 'replay' || trade.barTimestamp <= replayTimestamp),
    draft: state.orderDraft,
  }
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
  if (pinePanes.includes('candle_pane') && previousScale !== quote.priceScale) {
    coreChart?.overrideIndicator({ name: 'PINE_SCRIPT', precision: priceDigits(quote.price, quote.priceScale) }, 'candle_pane')
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
  if (fills.length) { markPaperChanged(); queuePaperStateSave() }
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

async function switchSymbol(item: MarketSymbol) {
  if (item.id === state.symbol.id) {
    closeSymbolSearch()
    return
  }
  const wasLive = state.mode === 'live'
  if (wasLive) flushChartLayout()
  else chartLayoutReady = false
  showLoading(true)
  exitReplay(false)
  try {
    const bars = await loadBars(item.id)
    if (wasLive) flushChartLayout()
    chartLayoutReady = false
    const core = coreChart
    core?.removeOverlay()
    state.symbol = { ...item }
    state.currentQuote = null
    setupReplay(bars)
    saveChartPreferences()
    if (core && chart) {
      resetPriceAxis()
      restoreChartContextOnData(core)
      core.clearData()
      chart.setSymbol(chartSymbol(state.symbol))
      core.applyNewData(chartWindowData(), true)
      if (pinePanes.includes('candle_pane')) {
        core.overrideIndicator({ name: 'PINE_SCRIPT', precision: priceDigits(state.bars.at(-1)?.close ?? 0) }, 'candle_pane')
      }
      window.requestAnimationFrame(() => {
        if (coreChart !== core) return
        if (!activeChartLayout().views[viewKey()]) core.scrollToRealTime()
      })
    }
    updateReplayView()
    connectQuoteStream()
    closeSymbolSearch()
    persistPaperState()
  } catch (error) {
    chartLayoutReady = true
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
  const wasLive = state.mode === 'live'
  if (wasLive) flushChartLayout()
  else chartLayoutReady = false
  showLoading(true)
  exitReplay(false)
  try {
    const bars = await loadBars(state.symbol.id, timeframe)
    if (wasLive) flushChartLayout()
    chartLayoutReady = false
    const core = coreChart
    core?.removeOverlay()
    state.timeframe = timeframe
    setupReplay(bars)
    saveChartPreferences()
    notify()
    resetPriceAxis()
    chart?.setPeriod({ ...currentTimeframe().period })
    const pineReady = refreshPineIndicator()
    if (core) restoreChartContextOnData(core, pineReady)
    updateReplayView()
    state.timeframeMenuOpen = false
    notify()
    persistPaperState()
  } catch (error) {
    chartLayoutReady = true
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

function jumpToPaperEvent(symbol: string) {
  const item = paperSymbol(symbol)
  return switchSymbol(item)
}

export { jumpToPaperEvent }

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
  if (processPaperBar(state.paper, currentBar(), state.symbol.id, state.replayHead).length) markPaperChanged()
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
  if (state.mode === 'live') flushChartLayout()
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

export function exitReplay(restoreLayout = true) {
  const shouldRefresh = state.mode === 'replay'
  const core = coreChart
  if (restoreLayout && state.mode !== 'live') {
    chartLayoutReady = false
    core?.removeOverlay()
  }
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
    if (restoreLayout && core) restoreChartContextOnData(core)
    refreshChart()
  } else if (restoreLayout && core) {
    restoreChartDrawings(core, activeChartLayout())
    restoreChartView(core, activeChartLayout())
    chartLayoutReady = true
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
  resetPaperAccount(state.paper, INITIAL_CASH)
  markPaperChanged()
  state.orderDraft = null
  state.paperTab = 'trade-history'
  closeChartContextMenu()
  updateReplayView()
}

export function cancelOrder(id: number) {
  if (cancelPaperOrder(state.paper, Number(id), currentBar().timestamp)) markPaperChanged()
  updateReplayView()
}

export async function closePosition(symbol: string) {
  await jumpToPaperEvent(symbol)
  const position = paperPosition(state.paper, symbol)
  if (closePaperPosition(state.paper, symbol, position.marketPrice || currentBar().close, currentBarIndex(), currentBar().timestamp)) markPaperChanged()
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
  if (order) { order[field] = null; markPaperChanged() }
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
    markPaperChanged()
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
  const bar = state.bars.findLast(({ timestamp: start }) => start <= timestamp && timestamp < nextBarTimestamp(start))
  if (!bar || !coreChart) return element.hidden = true
  const coordinate = coreChart.convertToPixel({ timestamp: bar.timestamp }, { paneId: 'candle_pane', absolute: true })
  const value = element.classList.contains('trade-marker-buy') ? bar.low : bar.high
  const top = tradePriceTop(value)
  const canvas = document.querySelector('#chart canvas')
  const main = document.querySelector('.tv-main')
  const x = coordinate?.x
  if (x == null || !Number.isFinite(x) || !Number.isFinite(top) || !canvas || !main) return element.hidden = true
  element.style.left = `${x + canvas.getBoundingClientRect().left - main.getBoundingClientRect().left}px`
  element.style.top = `${top + (element.classList.contains('trade-marker-buy') ? 8 : -28)}px`
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
    if (moved) { markPaperChanged(); updateReplayView() }
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
    paperChannel = new BroadcastChannel('trading-simulator:paper')
    paperChannel.onmessage = ({ data }: MessageEvent<PaperAccount>) => {
      if (!data || !Array.isArray(data.orders) || !Array.isArray(data.orderHistory) || !Array.isArray(data.trades)) return
      if (paperDirty) return
      paperSyncSerial++
      if (persistTimer != null) window.clearTimeout(persistTimer)
      persistTimer = null
      if (saveInFlight) saveAgain = true
      applyPaperAccount(data, state.symbol.id)
      notify()
      if (state.bars.length) connectQuoteStream()
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
