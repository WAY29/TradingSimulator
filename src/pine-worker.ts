import { calculatePine } from './pine'
import type { KLineData } from 'klinecharts'

type Request = { id: number; action: 'prepare' | 'calculate'; source?: string; timeframe: string; symbol: string; bars: KLineData[]; priceScale: number }
let source: string | null = null

self.onmessage = async (event: MessageEvent<Request>) => {
  const request = event.data
  try {
    if (request.action === 'prepare') {
      if (!request.source) throw new Error('请输入 Pine Script')
      const result = await calculatePine(request.source, request.bars, request.timeframe, request.symbol, request.priceScale)
      source = request.source
      self.postMessage({ id: request.id, value: result })
    } else {
      if (!source) throw new Error('Pine Script 尚未编译')
      self.postMessage({ id: request.id, value: await calculatePine(source, request.bars, request.timeframe, request.symbol, request.priceScale) })
    }
  } catch (error) {
    self.postMessage({ id: request.id, error: error instanceof Error ? error.message : String(error) })
  }
}
