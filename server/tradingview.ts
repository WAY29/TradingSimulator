import { createRequire } from 'node:module'
import { Router } from 'express'
import type { Response } from 'express'
import type { ClientOptions } from 'ws'
import type { Bar, MarketSymbol, Quote } from '../src/types.ts'

const require = createRequire(import.meta.url)
const WebSocket = require('ws') as typeof import('ws').default
const axios = require('axios') as typeof import('axios').default
const { HttpsProxyAgent } = require('https-proxy-agent') as typeof import('https-proxy-agent')
const proxyUrl = process.env.https_proxy || process.env.HTTPS_PROXY
const proxyAgent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined

class ProxyAwareWebSocket extends WebSocket {
  constructor(url: string | URL, protocols?: string | string[] | ClientOptions, options?: ClientOptions) {
    const selected = protocols && typeof protocols === 'object' && !Array.isArray(protocols) ? protocols : options
    super(url, typeof protocols === 'string' || Array.isArray(protocols) ? protocols : undefined,
      { ...selected, agent: selected?.agent || proxyAgent })
  }
}

require.cache[require.resolve('ws')]!.exports = ProxyAwareWebSocket
const TradingView = require('@mathieuc/tradingview')

type QuoteMarket = {
  close(): void
  onData(callback: (data: Record<string, unknown>) => void): void
  onError(callback: (...errors: unknown[]) => void): void
}
type QuoteConnection = {
  client: { end(): void }
  session: { delete(): void; Market: new (symbol: string) => QuoteMarket }
  markets: Map<string, QuoteMarket>
  closed: boolean
}
type SearchSymbol = {
  prefix?: string; exchange: string; symbol: string; description: string; type: string
  logo?: { logoid?: string }; 'base-currency-logoid'?: string
  provider_id?: string; source_logoid?: string; typespecs?: string[]
}
type SearchResult = MarketSymbol & { typeSpecs: string[] }
type StreamQuote = Quote & { symbol: string; exchange: string }

const DEFAULT_SYMBOLS = [
  'BINANCE:BTCUSDT',
  'BINANCE:ETHUSDT',
  'BINANCE:SOLUSDT',
  'BINANCE:DOGEUSDT',
  'BINANCE:BNBUSDT',
]
export const ALLOWED_TIMEFRAMES = new Set(['1', '3', '5', '15', '30', '45', '60', '120', '180', '240', 'D', 'W', 'M'])
const TIMEFRAME_MS: Record<string, number> = {
  1: 60_000, 3: 180_000, 5: 300_000, 15: 900_000, 30: 1_800_000, 45: 2_700_000,
  60: 3_600_000, 120: 7_200_000, 180: 10_800_000, 240: 14_400_000, D: 86_400_000, W: 604_800_000,
}
export const SYMBOL_PATTERN = /^[A-Z0-9_.-]+:[A-Z0-9_.-]+$/
const SEARCH_FILTERS = new Set(['', 'stock', 'futures', 'forex', 'crypto', 'index', 'economic'])
const cache = new Map<string, { timestamp: number; data: Bar[] }>()
const streamClients = new Map<Response, Set<string>>()
const quoteSnapshots = new Map<string, StreamQuote>()
let quoteConnection: QuoteConnection | null = null
let reconnectTimer: NodeJS.Timeout | null = null
let heartbeat: NodeJS.Timeout | null = null

async function searchMarkets(search: string, filter: string): Promise<SearchResult[]> {
  const parts = search.toUpperCase().replace(/ /g, '+').split(':')
  const { data } = await axios.get<{ symbols: SearchSymbol[] }>('https://symbol-search.tradingview.com/symbol_search/v3', {
    params: {
      exchange: parts.length === 2 ? parts[0] : undefined,
      text: parts.pop(),
      search_type: filter,
      start: 0,
    },
    headers: { origin: 'https://www.tradingview.com' },
  })
  return data.symbols.map((symbol) => {
    const exchange = symbol.exchange.split(' ')[0]
    return {
      id: symbol.prefix ? `${symbol.prefix}:${symbol.symbol}` : `${exchange.toUpperCase()}:${symbol.symbol}`,
      exchange,
      symbol: symbol.symbol,
      description: symbol.description,
      type: symbol.type,
      logoId: symbol.logo?.logoid || symbol['base-currency-logoid'] || '',
      providerId: symbol.provider_id || '',
      sourceLogoId: symbol.source_logoid || '',
      typeSpecs: symbol.typespecs || [],
    }
  })
}

function nextBarTimestamp(timestamp: number, timeframe: string) {
  if (timeframe !== 'M') return timestamp + TIMEFRAME_MS[timeframe]
  const date = new Date(timestamp)
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1)
}

function sendEvent(response: Response, quote: StreamQuote) {
  response.write(`data: ${JSON.stringify(quote)}\n\n`)
}

function broadcastQuote(quote: StreamQuote) {
  quoteSnapshots.set(quote.id, quote)
  for (const [response, symbols] of streamClients) {
    if (symbols.has(quote.id)) sendEvent(response, quote)
  }
}

function subscribeSymbol(fullSymbol: string) {
  const connection = quoteConnection
  if (!connection || connection.markets.has(fullSymbol)) return
  const market = new connection.session.Market(fullSymbol)
  market.onData((data: Record<string, unknown>) => {
    const price = Number(data.lp)
    if (!Number.isFinite(price)) return
    const previous = quoteSnapshots.get(fullSymbol)
    broadcastQuote({
      id: fullSymbol,
      symbol: fullSymbol.split(':')[1],
      exchange: fullSymbol.split(':')[0],
      price,
      change: Number(data.ch),
      changePct: Number(data.chp),
      volume: Number(data.volume),
      priceScale: Number(data.pricescale),
      logoId: String(data.logoid || data['base-currency-logoid'] || ''),
      timestamp: Number(data.lp_time) * 1000,
      direction: previous ? Math.sign(price - previous.price) : 0,
    })
  })
  market.onError((...errors: unknown[]) => console.error(`TradingView ${fullSymbol}:`, ...errors))
  connection.markets.set(fullSymbol, market)
}

function unsubscribeUnusedSymbols() {
  const connection = quoteConnection
  if (!connection) return
  const used = new Set(DEFAULT_SYMBOLS)
  streamClients.forEach((symbols) => symbols.forEach((symbol) => used.add(symbol)))
  connection.markets.forEach((market, symbol) => {
    if (used.has(symbol)) return
    market.close()
    connection.markets.delete(symbol)
    quoteSnapshots.delete(symbol)
  })
}

function connectQuotes() {
  if (quoteConnection) return
  const client = new TradingView.Client()
  const session = new client.Session.Quote({
    customFields: ['lp', 'ch', 'chp', 'volume', 'lp_time', 'description', 'exchange', 'pricescale', 'logoid', 'base-currency-logoid'],
  })
  const connection: QuoteConnection = { client, session, markets: new Map<string, QuoteMarket>(), closed: false }
  quoteConnection = connection

  const reconnect = () => {
    if (connection.closed || quoteConnection !== connection) return
    connection.closed = true
    quoteConnection = null
    connection.markets.forEach((market) => market.close())
    session.delete()
    client.end()
    if (reconnectTimer) clearTimeout(reconnectTimer)
    reconnectTimer = setTimeout(connectQuotes, 2_000)
  }

  client.onDisconnected(reconnect)
  client.onError((...errors: unknown[]) => {
    console.error('TradingView quote stream:', ...errors)
    reconnect()
  })
  DEFAULT_SYMBOLS.forEach(subscribeSymbol)
}

function fetchBars(symbol: string, timeframe: string, range: number, to?: number): Promise<Bar[]> {
  const key = `${symbol}:${timeframe}:${range}:${to || ''}`
  const cached = cache.get(key)
  const maxAge = range <= 3 ? 10_000 : 60_000
  if (cached && Date.now() - cached.timestamp < maxAge) return Promise.resolve(cached.data)

  return new Promise<Bar[]>((resolve, reject) => {
    const client = new TradingView.Client()
    const chart = new client.Session.Chart()
    let settled = false
    let settleTimer: NodeJS.Timeout | undefined
    const close = () => {
      clearTimeout(timeout)
      clearTimeout(settleTimer)
      chart.delete()
      client.end()
    }
    const fail = (error: unknown) => {
      if (settled) return
      settled = true
      close()
      reject(error instanceof Error ? error : new Error(String(error)))
    }
    const finish = () => {
      if (settled || chart.periods.length === 0) return
      settled = true
      const data: Bar[] = chart.periods.filter(Boolean).map((bar: { time: number; open: number; max: number; min: number; close: number; volume: number }) => ({
        timestamp: Number(bar.time) * 1000,
        open: Number(bar.open),
        high: Number(bar.max),
        low: Number(bar.min),
        close: Number(bar.close),
        volume: Number(bar.volume),
      })).sort((a: Bar, b: Bar) => a.timestamp - b.timestamp)
      cache.set(key, { timestamp: Date.now(), data })
      close()
      resolve(data)
    }
    const timeout = setTimeout(() => fail(new Error('TradingView request timed out')), 20_000)
    client.onError((...errors: unknown[]) => fail(new Error(errors.map(String).join(' '))))
    chart.onError((...errors: unknown[]) => fail(new Error(errors.map(String).join(' '))))
    chart.onUpdate((changes: string[]) => {
      if (!changes.includes('$prices')) return
      clearTimeout(settleTimer)
      settleTimer = setTimeout(finish, 100)
    })
    chart.setMarket(symbol, { timeframe, range, to })
  })
}

export const tradingViewRouter = Router()

tradingViewRouter.get('/stream', (request, response) => {
  const symbols = new Set(String(request.query.symbols || DEFAULT_SYMBOLS.join(','))
    .split(',').filter((symbol) => SYMBOL_PATTERN.test(symbol)).slice(0, 20))
  symbols.forEach(subscribeSymbol)
  response.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  response.flushHeaders()
  response.write('retry: 2000\n\n')
  streamClients.set(response, symbols)
  quoteSnapshots.forEach((quote, id) => {
    if (symbols.has(id)) sendEvent(response, quote)
  })
  request.on('close', () => {
    streamClients.delete(response)
    unsubscribeUnusedSymbols()
  })
})

tradingViewRouter.get('/search', async (request, response) => {
  const query = String(request.query.q || '').trim().slice(0, 80)
  const filter = typeof request.query.filter === 'string' && SEARCH_FILTERS.has(request.query.filter) ? request.query.filter : ''
  if (!query) return response.json([])
  try {
    const results = (await searchMarkets(query, filter))
      .filter((result) => SYMBOL_PATTERN.test(result.id)).slice(0, 30)
    response.set('Cache-Control', 'no-store').json(results)
  } catch (error) {
    response.status(502).json({ error: error instanceof Error ? error.message : String(error) })
  }
})

tradingViewRouter.get('/history', async (request, response) => {
  const symbol = String(request.query.symbol || 'BINANCE:BTCUSDT')
  const timeframe = String(request.query.timeframe || 'D')
  const range = Math.min(1000, Math.max(2, Number(request.query.range) || 300))
  const to = request.query.to == null ? undefined : Number(request.query.to)
  if (!SYMBOL_PATTERN.test(symbol) || !ALLOWED_TIMEFRAMES.has(timeframe) || (to != null && (!Number.isFinite(to) || to <= 0))) {
    return response.status(400).json({ error: 'Unsupported TradingView request' })
  }
  try {
    const bars = (await fetchBars(symbol, timeframe, range, to))
      .filter((bar) => request.query.closed !== '1' || nextBarTimestamp(bar.timestamp, timeframe) <= Date.now())
    response.set('Cache-Control', 'no-store').json({ source: 'TradingView', symbol, timeframe, bars })
  } catch (error) {
    response.status(502).json({ error: error instanceof Error ? error.message : String(error) })
  }
})

export function startTradingView() {
  connectQuotes()
  heartbeat = setInterval(() => {
    for (const response of streamClients.keys()) response.write(': ping\n\n')
  }, 15_000)
}

export function stopTradingView() {
  if (heartbeat) clearInterval(heartbeat)
  if (reconnectTimer) clearTimeout(reconnectTimer)
  streamClients.forEach((_symbols, response) => response.end())
  streamClients.clear()
  if (!quoteConnection) return
  quoteConnection.closed = true
  quoteConnection.markets.forEach((market) => market.close())
  quoteConnection.session.delete()
  quoteConnection.client.end()
  quoteConnection = null
}
