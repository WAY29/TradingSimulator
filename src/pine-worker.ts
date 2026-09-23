import { calculatePine, preparePine } from './pine'
import type { PineProgram } from './pine'
import type { KLineData } from 'klinecharts'

type Request = { id: number; action: 'prepare'; source: string; timeframe: string } | { id: number; action: 'calculate'; bars: KLineData[] }
let program: PineProgram | null = null

self.onmessage = (event: MessageEvent<Request>) => {
  const request = event.data
  try {
    if (request.action === 'prepare') {
      const next = preparePine(request.source, request.timeframe)
      program = next
      self.postMessage({ id: request.id, value: { plots: next.plots, overlay: next.overlay } })
    } else {
      if (!program) throw new Error('Pine Script 尚未编译')
      self.postMessage({ id: request.id, value: calculatePine(program, request.bars) })
    }
  } catch (error) {
    self.postMessage({ id: request.id, error: error instanceof Error ? error.message : String(error) })
  }
}
