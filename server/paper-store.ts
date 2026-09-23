import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { Router } from 'express'
import { ALLOWED_TIMEFRAMES, SYMBOL_PATTERN } from './tradingview.ts'
import type { PaperAccount } from '../src/types.ts'

const dataDirectory = join(dirname(fileURLToPath(import.meta.url)), '..', '.data')
mkdirSync(dataDirectory, { recursive: true })
const database = new DatabaseSync(join(dataDirectory, 'trading-simulator.sqlite'))
database.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS app_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    payload TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
`)
const readState = database.prepare('SELECT payload FROM app_state WHERE id = 1')
const writeState = database.prepare(`
  INSERT INTO app_state (id, payload, updated_at) VALUES (1, ?, ?)
  ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at
`)

function isValidState(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const state = value as {
    version: number
    paper: Partial<PaperAccount> & { position?: { quantity: number; averagePrice: number } }
    session?: { symbol?: { id: string }; timeframe: string; mode: string; replayTimestamp?: number }
  }
  if (!state || ![1, 2].includes(state.version) || typeof state.paper !== 'object' || !state.paper) return false
  const { paper, session } = state
  if (![paper.initialBalance, paper.realizedPnl, paper.feeRate, paper.slippageRate].every(Number.isFinite)) return false
  if (!Number.isInteger(paper.nextOrderId) || (paper.nextOrderId ?? 0) < 1) return false
  if (!Number.isInteger(paper.nextGroupId) || (paper.nextGroupId ?? 0) < 1) return false
  if (state.version === 1 && (!paper.position || ![paper.position.quantity, paper.position.averagePrice].every(Number.isFinite))) return false
  if (state.version === 2) {
    if (!paper.positions || typeof paper.positions !== 'object' || Array.isArray(paper.positions)) return false
    const positions = Object.entries(paper.positions)
    if (positions.length > 1_000 || positions.some(([symbol, position]) => (
      !SYMBOL_PATTERN.test(symbol)
      || !position
      || ![position.quantity, position.averagePrice, position.marketPrice].every(Number.isFinite)
    ))) return false
  }
  if (!Array.isArray(paper.orders) || !Array.isArray(paper.orderHistory) || !Array.isArray(paper.trades)) return false
  if ([paper.orders, paper.orderHistory, paper.trades].some((items) => items.length > 10_000)) return false
  if (!session || !SYMBOL_PATTERN.test(session.symbol?.id || '') || !ALLOWED_TIMEFRAMES.has(session.timeframe)) return false
  return session.mode === 'live' || (session.mode === 'replay' && Number.isFinite(session.replayTimestamp))
}

export const paperRouter = Router()

paperRouter.get('/state', (_request, response) => {
  const row = readState.get()
  response.set('Cache-Control', 'no-store').type('json').send(String(row?.payload || 'null'))
})

paperRouter.put('/state', (request, response) => {
  if (!isValidState(request.body)) return response.status(400).json({ error: 'Invalid paper trading state' })
  writeState.run(JSON.stringify(request.body), Date.now())
  response.json({ ok: true })
})

export function closePaperStore() {
  database.close()
}
