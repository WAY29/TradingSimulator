import { Router } from 'express'
import { paperRouter } from './paper-store.ts'
import { tradingViewRouter } from './tradingview.ts'

export const apiRouter = Router()

apiRouter.use('/tradingview', tradingViewRouter)
apiRouter.use('/paper', paperRouter)
