import express from 'express'
import type { NextFunction, Request, Response } from 'express'
import { createServer } from 'node:http'
import { createServer as createViteServer } from 'vite'
import { closePaperStore } from './server/paper-store.ts'
import { apiRouter } from './server/routes.ts'
import { startTradingView, stopTradingView } from './server/tradingview.ts'

const app = express()
const server = createServer(app)
const vite = await createViteServer({ server: { middlewareMode: true, ws: { server } }, appType: 'spa' })

app.disable('x-powered-by')
app.use(express.json({ limit: '2mb' }))
app.use('/api', apiRouter)
app.use('/api', (_request, response) => response.status(404).json({ error: 'API route not found' }))
app.use(vite.middlewares)
app.use((error: unknown, _request: Request, response: Response, next: NextFunction) => {
  if (response.headersSent) return next(error)
  const status = error instanceof Error && 'status' in error && typeof error.status === 'number'
    ? error.status : error instanceof SyntaxError ? 400 : 500
  response.status(status).json({ error: status === 500 ? 'Internal server error' : error instanceof Error ? error.message : String(error) })
})

const port = Number(process.env.PORT) || 5173
server.listen(port, '0.0.0.0', () => console.log(`TradingSimulator: http://localhost:${port}/`))
startTradingView()

let shuttingDown = false
async function shutdown() {
  if (shuttingDown) return
  shuttingDown = true
  stopTradingView()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await vite.close()
  closePaperStore()
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => shutdown().then(() => process.exit(0)))
}
