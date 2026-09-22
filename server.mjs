import express from 'express'
import { createServer as createViteServer } from 'vite'
import { closePaperStore } from './server/paper-store.js'
import { apiRouter } from './server/routes.js'
import { startTradingView, stopTradingView } from './server/tradingview.js'

const app = express()
const vite = await createViteServer({ server: { middlewareMode: true }, appType: 'spa' })

app.disable('x-powered-by')
app.use(express.json({ limit: '2mb' }))
app.use('/api', apiRouter)
app.use('/api', (_request, response) => response.status(404).json({ error: 'API route not found' }))
app.use(vite.middlewares)
app.use((error, _request, response, next) => {
  if (response.headersSent) return next(error)
  const status = error.status || (error instanceof SyntaxError ? 400 : 500)
  response.status(status).json({ error: status === 500 ? 'Internal server error' : error.message })
})

const server = app.listen(5173, '0.0.0.0', () => console.log('TradingSimulator: http://localhost:5173/'))
startTradingView()

let shuttingDown = false
async function shutdown() {
  if (shuttingDown) return
  shuttingDown = true
  stopTradingView()
  await new Promise((resolve) => server.close(resolve))
  await vite.close()
  closePaperStore()
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => shutdown().then(() => process.exit(0)))
}
