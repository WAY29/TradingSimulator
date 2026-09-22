import { createRequire } from 'node:module'
import { Router } from 'express'

const require = createRequire(import.meta.url)
const WebSocket = require('ws')
const axios = require('axios')
const { HttpsProxyAgent } = require('https-proxy-agent')
const proxyUrl = process.env.https_proxy || process.env.HTTPS_PROXY
const proxyAgent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined

class ProxyAwareWebSocket extends WebSocket {
  constructor(url, protocols, options) {
    if (protocols && !Array.isArray(protocols) && typeof protocols === 'object') {
      options = protocols
      protocols = undefined
    }
    super(url, protocols, { ...options, agent: options?.agent || proxyAgent })
  }
}

require.cache[require.resolve('ws')].exports = ProxyAwareWebSocket
const TradingView = require('@mathieuc/tradingview')

const DEFAULT_SYMBOLS = [
  'BINANCE:BTCUSDT',
  'BINANCE:ETHUSDT',
  'BINANCE:SOLUSDT',
  'BINANCE:DOGEUSDT',
  'BINANCE:BNBUSDT',
]
export const ALLOWED_TIMEFRAMES = new Set(['1', '3', '5', '15', '30', '45', '60', '120', '180', '240', 'D', 'W', 'M'])
const TIMEFRAME_MS = {
  1: 60_000, 3: 180_000, 5: 300_000, 15: 900_000, 30: 1_800_000, 45: 2_700_000,
  60: 3_600_000, 120: 7_200_000, 180: 10_800_000, 240: 14_400_000, D: 86_400_000, W: 604_800_000,
}
export const SYMBOL_PATTERN = /^[A-Z0-9_.-]+:[A-Z0-9_.-]+$/
const SEARCH_FILTERS = new Set(['', 'stock', 'futures', 'forex', 'crypto', 'index', 'economic'])
const cache = new Map()
const streamClients = new Map()
const quoteSnapshots = new Map()
let quoteConnection = null
let reconnectTimer = null
let heartbeat = null

async function searchMarkets(search, filter) {
  const parts = search.toUpperCase().replace(/ /g, '+').split(':')
  const { data } = await axios.get('https://symbol-search.tradingview.com/symbol_search/v3', {
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

function nextBarTimestamp(timestamp, timeframe) {
  if (timeframe !== 'M') return timestamp + TIMEFRAME_MS[timeframe]
  const date = new Date(timestamp)
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1)
}

function sendEvent(response, quote) {
  response.write(`data: ${JSON.stringify(quote)}\n\n`)
}

function broadcastQuote(quote) {
  quoteSnapshots.set(quote.id, quote)
  for (const [response, symbols] of streamClients) {
    if (symbols.has(quote.id)) sendEvent(response, quote)
  }
}

function subscribeSymbol(fullSymbol) {
  const connection = quoteConnection
  if (!connection || connection.markets.has(fullSymbol)) return
  const market = new connection.session.Market(fullSymbol)
  market.onData((data) => {
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
      logoId: data.logoid || data['base-currency-logoid'] || '',
      timestamp: Number(data.lp_time) * 1000,
      direction: previous ? Math.sign(price - previous.price) : 0,
    })
  })
  market.onError((...errors) => console.error(`TradingView ${fullSymbol}:`, ...errors))
  connection.markets.set(fullSymbol, market)
}

function unsubscribeUnusedSymbols() {
  if (!quoteConnection) return
  const used = new Set(DEFAULT_SYMBOLS)
  streamClients.forEach((symbols) => symbols.forEach((symbol) => used.add(symbol)))
  quoteConnection.markets.forEach((market, symbol) => {
    if (used.has(symbol)) return
    market.close()
    quoteConnection.markets.delete(symbol)
    quoteSnapshots.delete(symbol)
  })
}

function connectQuotes() {
  if (quoteConnection) return
  const client = new TradingView.Client()
  const session = new client.Session.Quote({
    customFields: ['lp', 'ch', 'chp', 'volume', 'lp_time', 'description', 'exchange', 'pricescale', 'logoid', 'base-currency-logoid'],
  })
  const connection = { client, session, markets: new Map(), closed: false }
  quoteConnection = connection

  const reconnect = () => {
    if (connection.closed || quoteConnection !== connection) return
    connection.closed = true
    quoteConnection = null
    connection.markets.forEach((market) => market.close())
    session.delete()
    client.end()
    clearTimeout(reconnectTimer)
    reconnectTimer = setTimeout(connectQuotes, 2_000)
  }

  client.onDisconnected(reconnect)
  client.onError((...errors) => {
    console.error('TradingView quote stream:', ...errors)
    reconnect()
  })
  DEFAULT_SYMBOLS.forEach(subscribeSymbol)
}

function fetchBars(symbol, timeframe, range) {
  const key = `${symbol}:${timeframe}:${range}`
  const cached = cache.get(key)
  const maxAge = range <= 3 ? 10_000 : 60_000
  if (cached && Date.now() - cached.timestamp < maxAge) return Promise.resolve(cached.data)

  return new Promise((resolve, reject) => {
    const client = new TradingView.Client()
    const chart = new client.Session.Chart()
    let settled = false
    let settleTimer
    const close = () => {
      clearTimeout(timeout)
      clearTimeout(settleTimer)
      chart.delete()
      client.end()
    }
    const fail = (error) => {
      if (settled) return
      settled = true
      close()
      reject(error instanceof Error ? error : new Error(String(error)))
    }
    const finish = () => {
      if (settled || chart.periods.length === 0) return
      settled = true
      const data = chart.periods.filter(Boolean).map((bar) => ({
        timestamp: Number(bar.time) * 1000,
        open: Number(bar.open),
        high: Number(bar.max),
        low: Number(bar.min),
        close: Number(bar.close),
        volume: Number(bar.volume),
      })).sort((a, b) => a.timestamp - b.timestamp)
      cache.set(key, { timestamp: Date.now(), data })
      close()
      resolve(data)
    }
    const timeout = setTimeout(() => fail(new Error('TradingView request timed out')), 20_000)
    client.onError((...errors) => fail(new Error(errors.map(String).join(' '))))
    chart.onError((...errors) => fail(new Error(errors.map(String).join(' '))))
    chart.onUpdate((changes) => {
      if (!changes.includes('$prices')) return
      clearTimeout(settleTimer)
      settleTimer = setTimeout(finish, 100)
    })
    chart.setMarket(symbol, { timeframe, range })
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
  const filter = SEARCH_FILTERS.has(request.query.filter) ? request.query.filter : ''
  if (!query) return response.json([])
  try {
    const results = (await searchMarkets(query, filter))
      .filter((result) => SYMBOL_PATTERN.test(result.id)).slice(0, 30)
    response.set('Cache-Control', 'no-store').json(results)
  } catch (error) {
    response.status(502).json({ error: error.message })
  }
})

tradingViewRouter.get('/history', async (request, response) => {
  const symbol = request.query.symbol || 'BINANCE:BTCUSDT'
  const timeframe = request.query.timeframe || 'D'
  const range = Math.min(1000, Math.max(2, Number(request.query.range) || 300))
  if (!SYMBOL_PATTERN.test(symbol) || !ALLOWED_TIMEFRAMES.has(timeframe)) {
    return response.status(400).json({ error: 'Unsupported TradingView request' })
  }
  try {
    const bars = (await fetchBars(symbol, timeframe, range))
      .filter((bar) => request.query.closed !== '1' || nextBarTimestamp(bar.timestamp, timeframe) <= Date.now())
    response.set('Cache-Control', 'no-store').json({ source: 'TradingView', symbol, timeframe, bars })
  } catch (error) {
    response.status(502).json({ error: error.message })
  }
})

export function startTradingView() {
  connectQuotes()
  heartbeat = setInterval(() => {
    for (const response of streamClients.keys()) response.write(': ping\n\n')
  }, 15_000)
}

export function stopTradingView() {
  clearInterval(heartbeat)
  clearTimeout(reconnectTimer)
  streamClients.forEach((_symbols, response) => response.end())
  streamClients.clear()
  if (!quoteConnection) return
  quoteConnection.closed = true
  quoteConnection.markets.forEach((market) => market.close())
  quoteConnection.session.delete()
  quoteConnection.client.end()
  quoteConnection = null
}
