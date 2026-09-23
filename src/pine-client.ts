import type { PinePlot, PineRow } from './pine'
import type { KLineData } from 'klinecharts'

export class PineClient {
  private worker = new Worker(new URL('./pine-worker.ts', import.meta.url), { type: 'module' })
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (reason: Error) => void; timer: number }>()
  private nextId = 0

  constructor() {
    this.worker.onmessage = ({ data }: MessageEvent<{ id: number; value?: unknown; error?: string }>) => {
      const entry = this.pending.get(data.id)
      if (!entry) return
      clearTimeout(entry.timer)
      this.pending.delete(data.id)
      if (data.error) entry.reject(new Error(data.error))
      else entry.resolve(data.value)
    }
    this.worker.onerror = (event) => { this.dispose(new Error(event.message || 'Pine Worker 加载失败')) }
  }

  prepare(source: string, timeframe: string) {
    return this.request<{ plots: PinePlot[]; overlay: boolean }>({ action: 'prepare', source, timeframe })
  }

  calculate(bars: KLineData[]) {
    return this.request<PineRow[]>({ action: 'calculate', bars })
  }

  private request<T>(message: object): Promise<T> {
    const id = ++this.nextId
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => this.dispose(new Error('Pine Script 运行超时')), 5000)
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject, timer })
      this.worker.postMessage({ id, ...message })
    })
  }

  dispose(reason = new Error('Pine Worker 已关闭')) {
    this.worker.terminate()
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer)
      entry.reject(reason)
    }
    this.pending.clear()
  }
}
