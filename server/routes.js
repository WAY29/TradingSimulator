import { Router } from 'express'
import { paperRouter } from './paper-store.js'
import { tradingViewRouter } from './tradingview.js'

export const apiRouter = Router()

apiRouter.use('/tradingview', tradingViewRouter)
apiRouter.use('/paper', paperRouter)
