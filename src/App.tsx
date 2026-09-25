import { Fragment, lazy, Suspense, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown, ChevronLeft, CodeXml, Copy, FilePlus2, LayoutTemplate, LockKeyhole, LockKeyholeOpen, Pencil, Plus, Save, Trash2, X } from 'lucide-react'
import { TIMEFRAMES } from './config'
import { TREND_TOOLS } from './drawing-tools'
import { activeOrderNumbers, projectedPnl, type PaperHistoryTrade } from './paper'
import { savedPineScripts, selectPineScript, type SavedPineScript } from './pine-scripts'
import { baseCurrency, providerLogoUrl, symbolLogoUrl } from './symbols'
import type { OrderDraft, PaperOrder, PaperPosition, ProtectionField } from './types'

type TerminalController = typeof import('./terminal-controller')
type PanelData = ReturnType<TerminalController['getPaperPanelData']>
const PineEditor = lazy(() => import('./PineEditor'))

function TerminalShell() {
  const [controller, setController] = useState<TerminalController | null>(null)
  const [pineOpen, setPineOpen] = useState(false)
  const [pineSelection, setPineSelection] = useState(0)
  const [, refresh] = useState(0)

  useEffect(() => {
    let disposed = false
    let unsubscribe = () => {}
    let controllerModule: TerminalController | null = null
    import('./terminal-controller').then((module) => {
      if (disposed) return
      controllerModule = module
      setController(module)
      unsubscribe = module.subscribe(() => refresh((version) => version + 1))
      void module.start()
    })
    return () => {
      disposed = true
      unsubscribe()
      controllerModule?.dispose()
    }
  }, [])

  const controllerState = controller?.getControllerState()
  const activeLayoutId = controller?.getChartLayouts().activeId
  const modeClass = controllerState?.mode && controllerState.mode !== 'live' ? 'replay-open' : ''
  const paperClass = controllerState?.paperPanelOpen ? 'paper-open' : ''

  useEffect(() => {
    if (controllerState?.symbol && controllerState.currentQuote) {
      document.title = `${controllerState.symbol.symbol} ${controller?.formatPrice(controllerState.currentQuote.price, controllerState.currentQuote.priceScale)} ${controllerState.currentQuote.change >= 0 ? '▲' : '▼'}`
    }
  }, [controller, controllerState?.symbol?.symbol, controllerState?.currentQuote?.price, controllerState?.currentQuote?.change])

  useEffect(() => {
    if (!controller) return
    const dismiss = (event: MouseEvent) => {
      controller.dismissMenus(event.target as HTMLElement)
      document.querySelectorAll<HTMLDetailsElement>('.history-filter[open]').forEach((details) => {
        if (!details.contains(event.target as Node)) details.open = false
      })
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') controller.dismissMenus(null)
    }
    const resize = () => {
      const state = controller.getControllerState()
      if (state.paperPanelHeight > window.innerHeight - 180) controller.setPaperPanelHeight(window.innerHeight - 180)
      document.querySelectorAll<HTMLDetailsElement>('.history-filter[open]').forEach(positionHistoryFilter)
      window.requestAnimationFrame(controller.positionTradeLayerElements)
    }
    const pagehide = () => controller.saveOnPageHide()
    document.addEventListener('click', dismiss)
    document.addEventListener('keydown', escape)
    window.addEventListener('resize', resize)
    window.addEventListener('pagehide', pagehide)
    return () => {
      document.removeEventListener('click', dismiss)
      document.removeEventListener('keydown', escape)
      window.removeEventListener('resize', resize)
      window.removeEventListener('pagehide', pagehide)
    }
  }, [controller])

  useEffect(() => {
    if (!controller) return
    const save = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 's' || event.defaultPrevented) return
      if (event.target instanceof Element && event.target.closest('.pine-editor')) return
      event.preventDefault()
      if (!document.querySelector('.confirm-dialog[open]')) controller.saveChartLayout()
    }
    document.addEventListener('keydown', save)
    return () => document.removeEventListener('keydown', save)
  }, [controller])

  useEffect(() => {
    if (!controller) return
    controller.setPineEditorToggle(() => setPineOpen((open) => !open))
    return () => controller.setPineEditorToggle(null)
  }, [controller])

  useEffect(() => setPineOpen(false), [activeLayoutId])

  const openPineScript = (script: SavedPineScript | null) => {
    selectPineScript(script)
    setPineSelection((selection) => selection + 1)
    setPineOpen(true)
  }

  return (
    <main className={`terminal ${modeClass} ${paperClass} ${pineOpen ? 'pine-open' : ''}`} style={{ ['--paper-panel-height' as string]: `${controllerState?.paperPanelHeight || 260}px` }}>
      <Toolbar controller={controller} onPine={openPineScript} />
      <ChartWorkspace controller={controller} />
      <ReplayDock controller={controller} />
      <PaperPanel controller={controller} />
      <SymbolDialog controller={controller} />
      {pineOpen && controller && <Suspense fallback={null}><PineEditor key={pineSelection} controller={controller} onClose={() => setPineOpen(false)} /></Suspense>}
      <StatusLayer controller={controller} />
    </main>
  )
}

function Toolbar({ controller, onPine }: { controller: TerminalController | null; onPine: (script: SavedPineScript | null) => void }) {
  const [indicatorMenuOpen, setIndicatorMenuOpen] = useState(false)
  const [indicatorView, setIndicatorView] = useState<'root' | 'pine'>('root')
  const indicatorMenuRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!indicatorMenuOpen) return
    const dismiss = (event: MouseEvent) => { if (!indicatorMenuRef.current?.contains(event.target as Node)) setIndicatorMenuOpen(false) }
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setIndicatorMenuOpen(false) }
    document.addEventListener('click', dismiss)
    document.addEventListener('keydown', escape)
    return () => { document.removeEventListener('click', dismiss); document.removeEventListener('keydown', escape) }
  }, [indicatorMenuOpen])
  const state = controller?.getControllerState()
  const currentTimeframe = TIMEFRAMES.find(({ id }) => id === state?.timeframe)
  const favoriteTimeframes: string[] = state?.favoriteTimeframes || []
  const quote = state?.currentQuote
  const layouts = controller?.getChartLayouts()

  return (
    <header className="tv-toolbar">
      <div className="toolbar-left">
        <img className="app-logo" src="/trading-simulator-logo.png" alt="TradingSimulator" title="TradingSimulator" />
        <button className="market-identity" id="symbol-button" title="切换标的" onClick={() => controller?.openSymbolSearch('switch')}>
          <AssetIcon symbol={state?.symbol?.symbol || 'BTCUSDT'} logoId={state?.currentQuote?.logoId} />
          <strong id="current-symbol">{state?.symbol.symbol || 'BTCUSDT'}</strong>
          <small id="current-exchange">{state?.symbol ? `${state.symbol.id.split(':')[0]} · ${currentTimeframe?.label || 'D'}` : 'BINANCE · D'}</small>
          <span className="header-price" id="header-price">{quote && controller ? controller.formatPrice(quote.price, undefined) : '--'}</span>
          <span className={`header-change ${quote && controller ? controller.signClass(quote.changePct) : ''}`} id="header-change">{quote && controller ? `${controller.formatSigned(quote.changePct)}%` : '--'}</span>
          <span className="chevron">⌄</span>
        </button>
        <div className="timeframe-control">
          <div className="timeframe-favorites" id="timeframe-favorites">
            {favoriteTimeframes.map((id) => {
              const item = TIMEFRAMES.find((timeframe) => timeframe.id === id)
              return item ? <button key={id} data-timeframe={id} className={id === state?.timeframe ? 'active' : ''} onClick={() => controller?.switchTimeframe(id)}>{item.label}</button> : null
            })}
          </div>
          <button className="timeframe-more" id="timeframe-more" title="时间周期" aria-label="时间周期" onClick={() => controller?.toggleTimeframeMenu()}><span className="mobile-timeframe">{currentTimeframe?.label || 'D'}</span><span className="chevron-icon" aria-hidden="true" /></button>
          <div className="timeframe-menu" id="timeframe-menu" hidden={!state?.timeframeMenuOpen}>
            {TIMEFRAMES.map((item) => {
              const favorite = favoriteTimeframes.includes(item.id)
              return <div className={`timeframe-option ${item.id === state?.timeframe ? 'active' : ''}`} key={item.id}><button className="timeframe-pick" data-timeframe={item.id} onClick={() => controller?.switchTimeframe(item.id)}><span>{item.name}</span><small>{item.label}</small></button><button className="timeframe-favorite" data-favorite={item.id} onClick={() => controller?.toggleFavoriteTimeframe(item.id)} title={favorite ? '取消收藏' : '收藏'} aria-label={favorite ? '取消收藏' : '收藏'}>{favorite ? '★' : '☆'}</button></div>
            })}
          </div>
        </div>
        <div className="indicator-control" ref={indicatorMenuRef}>
          <button className="toolbar-button text-button" id="indicators" title="指标" aria-expanded={indicatorMenuOpen} onClick={() => { setIndicatorView('root'); setIndicatorMenuOpen(!indicatorMenuOpen) }}>fx<span className="mobile-hide">&nbsp; 指标</span></button>
          {indicatorMenuOpen && <div className={`indicator-menu ${indicatorView === 'pine' ? 'indicator-menu--scripts' : ''}`} role="group" aria-label={indicatorView === 'pine' ? 'Pine Script 脚本' : '指标选项'} onClick={(event) => event.stopPropagation()}>
            {indicatorView === 'root' ? <>
              <button onClick={() => { setIndicatorMenuOpen(false); controller?.openIndicators() }}>内置指标</button>
              <button onClick={() => setIndicatorView('pine')}>Pine Script</button>
            </> : <>
              <button onClick={() => setIndicatorView('root')}><ChevronLeft size={16} /> 指标</button>
              {savedPineScripts().map((script) => <button key={script.id} title={script.name} onClick={() => { setIndicatorMenuOpen(false); onPine(script) }}>{script.name}</button>)}
              <button onClick={() => { setIndicatorMenuOpen(false); onPine(null) }}><FilePlus2 size={16} /> 新建脚本</button>
            </>}
          </div>}
        </div>
        <button className="toolbar-button replay-toggle" id="replay-toggle" title="Bar Replay" onClick={() => controller?.toggleReplay()}>◁<span className="mobile-hide">&nbsp; Replay</span></button>
      </div>
      <div className="toolbar-right"><button className="toolbar-button chart-save" title="保存图表 (Ctrl+S)" aria-label="保存图表" disabled={!controller || state?.loading} onClick={() => controller?.saveChartLayout()}><Save size={17} /></button><ChartLayoutMenu controller={controller} layouts={layouts} /><a className="source-link" href="https://github.com/WAY29/TradingSimulator" target="_blank" rel="noopener noreferrer" title="项目源码与 AGPL 许可证" aria-label="项目源码与 AGPL 许可证"><CodeXml size={17} /></a><button className="paper-toggle" id="paper-toggle" title="模拟交易" onClick={() => controller?.setPaperPanelOpen(!state?.paperPanelOpen)}>模拟交易</button></div>
    </header>
  )
}

function ChartLayoutMenu({ controller, layouts }: { controller: TerminalController | null; layouts?: ReturnType<TerminalController['getChartLayouts']> }) {
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<{ id: string; name: string } | null>(null)
  const [name, setName] = useState('')
  const busy = controller?.getControllerState().loading ?? false
  const menu = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const dismiss = (event: MouseEvent) => { if (!menu.current?.contains(event.target as Node)) { setOpen(false); setEditing(null) } }
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { setOpen(false); setEditing(null) } }
    document.addEventListener('click', dismiss)
    document.addEventListener('keydown', escape)
    return () => { document.removeEventListener('click', dismiss); document.removeEventListener('keydown', escape) }
  }, [open])
  const active = layouts?.items.find(({ id }) => id === layouts.activeId)
  const close = () => { setOpen(false); setEditing(null) }
  return <div className="chart-layout-control" ref={menu}>
    <button id="chart-layout-toggle" className="toolbar-button chart-layout-toggle" title="切换图表" aria-expanded={open} onClick={() => { setOpen(!open); setEditing(null) }}><LayoutTemplate size={17} /><span>{active?.name || '图表 1'}</span><ChevronDown size={15} /></button>
    {open && <div className="chart-layout-menu" role="group" aria-label="图表配置" onClick={(event) => event.stopPropagation()}>
      <div className="chart-layout-menu-header"><strong>图表</strong><button title="新建图表" aria-label="新建图表" disabled={busy} onClick={() => { controller?.createChartLayout(); close() }}><Plus size={17} /></button></div>
      <div className="chart-layout-list">{layouts?.items.map((layout) => <div className={`chart-layout-item ${layout.id === layouts.activeId ? 'active' : ''}`} key={layout.id}>
        {editing === layout.id ? <form onSubmit={(event) => { event.preventDefault(); controller?.renameChartLayout(layout.id, name); setEditing(null) }}><input autoFocus aria-label="图表名称" maxLength={40} value={name} onChange={(event) => setName(event.target.value)} onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); setEditing(null) } }} /><button type="submit" title="保存名称" aria-label="保存名称"><Check size={15} /></button><button type="button" title="取消重命名" aria-label="取消重命名" onClick={() => setEditing(null)}><X size={15} /></button></form> : <>
          <button className="chart-layout-pick" disabled={busy} aria-current={layout.id === layouts.activeId ? 'page' : undefined} onClick={() => { void controller?.selectChartLayout(layout.id); close() }}>{layout.id === layouts.activeId ? <Check size={15} /> : <span className="chart-layout-check" />}{layout.name}</button>
          <div className="chart-layout-actions"><button title={`重命名 ${layout.name}`} aria-label={`重命名 ${layout.name}`} disabled={busy} onClick={() => { setName(layout.name); setEditing(layout.id) }}><Pencil size={14} /></button><button title={`复制 ${layout.name}`} aria-label={`复制 ${layout.name}`} disabled={busy} onClick={() => { controller?.duplicateChartLayout(layout.id); close() }}><Copy size={14} /></button><button title={`删除 ${layout.name}`} aria-label={`删除 ${layout.name}`} disabled={busy || layouts.items.length === 1} onClick={() => { setDeleting({ id: layout.id, name: layout.name }); close() }}><Trash2 size={14} /></button></div>
        </>}
      </div>)}</div>
    </div>}
    {deleting && <ConfirmDialog title={`删除图表“${deleting.name}”？`} message="该图表的指标、画线和视角将被删除。" action="删除图表" onConfirm={() => { void controller?.deleteChartLayout(deleting.id) }} onClose={() => { setDeleting(null); menu.current?.querySelector<HTMLButtonElement>('#chart-layout-toggle')?.focus() }} />}
  </div>
}

function ConfirmDialog({ title, message, action, onConfirm, onClose }: { title: string; message: string; action: string; onConfirm: () => void; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const element = dialog.current
    element?.showModal()
    element?.querySelector<HTMLButtonElement>('.confirm-cancel')?.focus()
    return () => { if (element?.open) element.close() }
  }, [])
  return <dialog ref={dialog} className="confirm-dialog" aria-label={title} onClose={onClose} onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); dialog.current?.close() } }}>
    <h2>{title}</h2>
    <p>{message}</p>
    <div className="confirm-actions"><button className="confirm-cancel" onClick={() => dialog.current?.close()}>取消</button><button className="confirm-danger" onClick={() => { onConfirm(); dialog.current?.close() }}>{action}</button></div>
  </dialog>
}

function ChartWorkspace({ controller }: { controller: TerminalController | null }) {
  const state = controller?.getControllerState()
  const context = state?.contextMenu
  const drawing = controller?.getSelectedDrawing()
  return (
    <div className="tv-main">
      <ChartHost key={controller?.getChartLayouts().activeId} controller={controller} />
      <TrendTools controller={controller} />
      <div className="replay-watermark" id="replay-watermark" hidden={state?.mode !== 'replay'}><span>◀◀</span> Replay</div>
      <div className="replay-future-mask" id="replay-future-mask" hidden={state?.mode !== 'select'} style={{ left: state?.replaySelectorLeft ?? 0 }} />
      <div className="replay-selector-line" id="replay-selector-line" hidden={state?.mode !== 'select' || state?.replaySelectorLeft == null} style={{ left: state?.replaySelectorLeft ?? 0 }}><span>✂</span></div>
      <TradeLayer controller={controller} />
      {drawing && <div id="drawing-toolbar" className="drawing-toolbar" role="toolbar" aria-label="画线设置" onContextMenu={(event) => event.preventDefault()}>
        <input type="color" title="颜色" aria-label="画线颜色" value={/^#[0-9a-f]{6}$/i.test(drawing.color) ? drawing.color : '#1677ff'} onChange={(event) => controller?.setDrawingColor(event.target.value)} />
        <select aria-label="线宽" title="线宽" value={drawing.width} onChange={(event) => controller?.setDrawingWidth(Number(event.target.value))}>{[1, 2, 3, 4, 5].map((width) => <option key={width} value={width}>{width}px</option>)}</select>
        <select aria-label="线型" title="线型" value={drawing.dashed ? 'dashed' : 'solid'} onChange={() => controller?.toggleDrawingStyle()}><option value="solid">实线</option><option value="dashed">虚线</option></select>
        <button title={drawing.lock ? '解锁画线' : '锁定画线'} aria-label={drawing.lock ? '解锁画线' : '锁定画线'} onClick={() => controller?.toggleDrawingLock()}>{drawing.lock ? <LockKeyhole size={18} /> : <LockKeyholeOpen size={18} />}</button>
        <button title="删除画线" aria-label="删除画线" onClick={() => controller?.deleteSelectedDrawing()}><Trash2 size={18} /></button>
      </div>}
      <div className="chart-context-menu" id="chart-context-menu" hidden={!context} style={context ? { left: context.left, top: context.top } : undefined}>
        {context ? <>
          <button onClick={() => { navigator.clipboard.writeText(String(context.price)).catch(() => {}); controller?.closeChartContextMenu() }}>Copy price <strong>{controller?.formatPrice(context.price, undefined)}</strong></button>
          <span />
          <button onClick={() => controller?.openOrderDraft(context.first.side, context.first.type, context.price)}><b className={context.first.side === 'buy' ? 'positive' : 'negative'}>{context.first.side === 'buy' ? 'Buy' : 'Sell'}</b> 0.01 @ {controller?.formatPrice(context.price, undefined)} {context.first.type}</button>
          <button onClick={() => controller?.openOrderDraft(context.second.side, context.second.type, context.price)}><b className={context.second.side === 'buy' ? 'positive' : 'negative'}>{context.second.side === 'buy' ? 'Buy' : 'Sell'}</b> 0.01 @ {controller?.formatPrice(context.price, undefined)} {context.second.type}</button>
          <button onClick={() => controller?.openOrderDraft(context.price <= (state?.currentQuote?.price || 0) ? 'buy' : 'sell', 'limit', context.price)}>Add order on {state?.symbol.symbol} at {controller?.formatPrice(context.price, undefined)}…</button>
        </> : null}
      </div>
      <Watchlist controller={controller} />
    </div>
  )
}

const drawingIconsUrl = '/icons/tradingview-drawing-tools.svg#'

function TrendIcon({ icon }: { icon: string }) {
  return <svg className="trend-tool-icon" width="28" height="28" fill="currentColor" aria-hidden="true"><use href={`${drawingIconsUrl}${icon}`} width="100%" height="100%" /></svg>
}

function TrendTools({ controller }: { controller: TerminalController | null }) {
  const [open, setOpen] = useState(false)
  const [drawingBar, setDrawingBar] = useState<HTMLElement | null>(null)
  const group = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const workspace = document.querySelector('.tv-main')
    if (!workspace) return
    const update = () => setDrawingBar(workspace.querySelector<HTMLElement>('.chart-host .klinecharts-pro-content > .klinecharts-pro-drawing-bar'))
    const observer = new MutationObserver(update)
    observer.observe(workspace, { childList: true, subtree: true })
    update()
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    if (!open) return
    const dismiss = (event: MouseEvent) => { if (!group.current?.contains(event.target as Node)) setOpen(false) }
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false) }
    document.addEventListener('click', dismiss)
    document.addEventListener('keydown', escape)
    return () => { document.removeEventListener('click', dismiss); document.removeEventListener('keydown', escape) }
  }, [open])
  const active = controller?.getTrendTool() ?? 'segment'
  const activeTool = TREND_TOOLS.find(({ name }) => name === active) ?? TREND_TOOLS[0]
  const disabled = !controller || controller.getControllerState().mode === 'select'
  if (!drawingBar) return null
  return createPortal(<div className="item trend-tool-group" ref={group}>
    <button className="trend-tool-main" title={activeTool.label} aria-label={activeTool.label} disabled={disabled} onClick={() => controller?.selectTrendTool(active)}><span className="icon-overlay"><TrendIcon icon={activeTool.icon} /></span></button>
    <button className="icon-arrow trend-tool-expand" title="趋势线工具" aria-label="展开趋势线工具" aria-expanded={open} disabled={disabled} onClick={() => setOpen(!open)}><TrendIcon icon="toolbar-linetool-group-trend-line-arrow" /></button>
    {open && <ul className="klinecharts-pro-list list trend-tool-menu" role="group" aria-label="趋势工具">{TREND_TOOLS.map(({ name, label, icon }, index) => {
      const section = index === 0 ? '线' : index === 9 ? '通道' : index === 13 ? '分叉线' : null
      const select = () => { controller?.selectTrendTool(name); setOpen(false) }
      return <Fragment key={name}>{section && <li className="trend-tool-heading">{section}</li>}<li role="button" tabIndex={0} title={label} className={name === active ? 'active' : ''} onClick={select} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); select() } }}><span className="icon-overlay"><TrendIcon icon={icon} /></span><span style={{ paddingLeft: 8 }}>{label}</span></li></Fragment>
    })}</ul>}
  </div>, drawingBar)
}

function TradeLayer({ controller }: { controller: TerminalController | null }) {
  const data = controller?.getTradeLayerData()
  useEffect(() => {
    controller?.positionTradeLayerElements()
  }, [controller, data?.price, data?.orders, data?.trades, data?.draft, data?.position?.quantity])
  if (!data || data.mode === 'select') return <div className="trade-layer" id="trade-layer" />
  const position = data.position
  const price = data.price
  const numbers = activeOrderNumbers(data.orders)
  const groupIds = [...new Set(data.orders.filter((order) => order.reduceOnly).map((order) => numbers.get(order.groupId ?? -1)).filter(Boolean))].join(',')
  return <div className="trade-layer" id="trade-layer">
    {data.trades.flatMap((trade, index) => [
      trade.openedQuantity > 0 ? <span className={`trade-marker trade-marker-${trade.side}`} data-marker-timestamp={trade.barTimestamp} data-marker-kind="开" aria-label={`开仓${trade.side === 'buy' ? '买入' : '卖出'}`} key={`${trade.id}-${index}-open`} /> : null,
      trade.closedQuantity > 0 ? <span className={`trade-marker trade-marker-${trade.side}`} data-marker-timestamp={trade.barTimestamp} data-marker-kind="平" aria-label={`平仓${trade.side === 'buy' ? '买入' : '卖出'}`} key={`${trade.id}-${index}-close`} /> : null,
    ])}
    {position.quantity ? <div className="trade-line working-line position-line" data-price={position.averagePrice}><div className="working-controls"><span className="working-control">{groupIds ? <b className="order-sequence">{groupIds}</b> : null}<b>{controller?.formatOrderQuantity(Math.abs(position.quantity), data.symbol.symbol)} {position.quantity > 0 ? 'Long' : 'Short'}</b><b className={controller?.signClass(position.quantity * (price - position.averagePrice))}>{controller?.formatMoney(position.quantity * (price - position.averagePrice))}</b></span></div></div> : null}
    {data.orders.map((order) => <TradeOrderLine key={order.id} order={order} sequence={numbers.get(order.groupId ?? -1)} position={position} controller={controller} />)}
    {data.draft ? <TradeDraft draft={data.draft} controller={controller} /> : null}
  </div>
}

function TradeOrderLine({ order, sequence, position, controller }: { order: PaperOrder; sequence?: number; position: PaperPosition; controller: TerminalController | null }) {
  const cancel = () => controller?.cancelOrder(order.id)
  if (order.role !== 'entry') {
    const side = position.quantity > 0 ? 'buy' : 'sell'
    return <ProtectionOrderLine order={order} sequence={sequence} price={order.price} field={order.role === 'take-profit' ? 'takeProfit' : 'stopLoss'} pnl={projectedPnl(side, order.quantity, position.averagePrice, order.price)} controller={controller} onRemove={cancel} />
  }
  return <>
    {order.takeProfit != null ? <ProtectionOrderLine order={order} sequence={sequence} price={order.takeProfit} field="takeProfit" pnl={projectedPnl(order.side, order.quantity, order.price, order.takeProfit)} controller={controller} onRemove={() => controller?.removeOrderProtection(order.id, 'takeProfit')} /> : null}
    {order.stopLoss != null ? <ProtectionOrderLine order={order} sequence={sequence} price={order.stopLoss} field="stopLoss" pnl={projectedPnl(order.side, order.quantity, order.price, order.stopLoss)} controller={controller} onRemove={() => controller?.removeOrderProtection(order.id, 'stopLoss')} /> : null}
    <div className={`trade-line working-line entry-order ${order.side}`} data-price={order.price}><div className="working-controls">{order.takeProfit != null ? <span className="order-bracket take-profit">TP</span> : null}{order.stopLoss != null ? <span className="order-bracket stop-loss">SL</span> : null}<span className="working-control">{sequence != null ? <b className="order-sequence">{sequence}</b> : null}<b>{order.side === 'buy' ? 'Buy' : 'Sell'} {order.type}</b><button onClick={cancel} title="取消订单" aria-label="取消订单">×</button></span></div><strong className="line-price">{controller?.formatPrice(order.price, undefined)}</strong></div>
  </>
}

function ProtectionOrderLine({ order, sequence, price, field, pnl, controller, onRemove }: { order: PaperOrder; sequence?: number; price: number; field: ProtectionField; pnl: number; controller: TerminalController | null; onRemove: () => void }) {
  const role = field === 'takeProfit' ? 'take-profit' : 'stop-loss'
  return <div className={`trade-line working-line ${role}`} data-price={price} data-protection-parent={order.role === 'entry' ? order.id : undefined} data-protection-order={order.role !== 'entry' ? order.id : undefined} data-protection-field={field} onPointerDown={(event) => controller?.beginWorkingProtectionDrag(event.nativeEvent, event.currentTarget)}><div className="working-controls"><span className="working-control">{sequence != null ? <b className="order-sequence">{sequence}</b> : null}<b>{controller?.formatProjectedPnl(pnl)}</b><button onClick={onRemove} title="取消订单" aria-label="取消订单">×</button></span></div><strong className="line-price">{controller?.formatPrice(price, undefined)}</strong></div>
}

function TradeDraft({ draft, controller }: { draft: OrderDraft; controller: TerminalController | null }) {
  return <>
    <DraftProtection draft={draft} field="takeProfit" controller={controller} />
    <DraftProtection draft={draft} field="stopLoss" controller={controller} />
    <div className={`trade-line draft-entry ${draft.side}`} data-price={draft.price} data-draft-role="price" onPointerDown={(event) => controller?.beginDraftDrag(event.nativeEvent, 'price')}><div className="draft-controls"><button className={`draft-submit ${draft.side}`} onClick={() => controller?.submitOrderDraft()}>{draft.side === 'buy' ? 'Buy' : 'Sell'}</button><button className={`protection-toggle ${draft.takeProfit != null ? 'active' : ''}`} data-toggle-protection="takeProfit" onClick={() => controller?.toggleDraftProtection('takeProfit')} onPointerDown={(event) => controller?.beginDraftDrag(event.nativeEvent, 'takeProfit', true)}>TP</button><button className={`protection-toggle ${draft.stopLoss != null ? 'active' : ''}`} data-toggle-protection="stopLoss" onClick={() => controller?.toggleDraftProtection('stopLoss')} onPointerDown={(event) => controller?.beginDraftDrag(event.nativeEvent, 'stopLoss', true)}>SL</button><label className="draft-quantity"><input type="number" min="0.0001" step="0.0001" value={draft.quantity} aria-label="下单数量" onChange={(event) => controller?.setDraftQuantity(event.target.value)} /><span>{baseCurrency(controller?.getControllerState()?.symbol?.symbol || '')}</span></label><select value={draft.type} aria-label="订单类型" onChange={(event) => controller?.setDraftType(event.target.value)}><option value="market">Market</option><option value="limit">Limit</option><option value="stop">Stop</option></select><button onClick={() => controller?.cancelDraft()} title="取消" aria-label="取消">×</button></div><strong>{controller?.formatPrice(draft.price, undefined)}</strong></div>
  </>
}

function DraftProtection({ draft, field, controller }: { draft: OrderDraft; field: ProtectionField; controller: TerminalController | null }) {
  const price = draft[field]
  if (price == null) return null
  const profit = field === 'takeProfit'
  return <>
    <div className={`protection-zone ${profit ? 'take-profit-zone' : 'stop-loss-zone'}`} data-entry={draft.price} data-target={price} />
    <div className={`trade-line protection-line ${profit ? 'take-profit' : 'stop-loss'}`} data-price={price} data-draft-role={field} onPointerDown={(event) => controller?.beginDraftDrag(event.nativeEvent, field)}><span>{profit ? 'TP' : 'SL'} · {controller?.formatProjectedPnl(projectedPnl(draft.side, draft.quantity, draft.price, price))} <button onClick={() => controller?.removeDraftProtection(field)} aria-label={profit ? '移除止盈' : '移除止损'}>×</button></span></div>
  </>
}

function ChartHost({ controller }: { controller: TerminalController | null }) {
  const container = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!controller || !container.current) return
    const host = container.current
    controller.mountChart(host)
    const observer = new ResizeObserver(() => controller.resizeChart())
    observer.observe(host)
    return () => {
      observer.disconnect()
      controller.unmountChart()
    }
  }, [controller])
  return <div id="chart" className="chart-host" ref={container} />
}

function Watchlist({ controller }: { controller: TerminalController | null }) {
  const state = controller?.getControllerState()
  const items = state?.watchlist || []
  const formatPrice = controller ? (value: number) => controller.formatPrice(value, undefined) : (value: number) => value.toLocaleString('en-US', { maximumFractionDigits: 8 })
  const formatSigned = controller?.formatSigned || ((value: number) => `${value >= 0 ? '+' : ''}${value}`)
  const signClass = controller?.signClass || (() => '')

  return (
    <aside className="watchlist-panel">
      <div className="watchlist-header">
        <strong>自选表</strong>
        <span id="watchlist-status" title="行情更新时间">{state?.watchlistStatus || state?.streamStatus || '--:--:--'}</span>
        <button id="add-symbol" title="添加到自选表" aria-label="添加到自选表" onClick={() => controller?.openSymbolSearch('add')}>＋</button>
      </div>
      <div className="watchlist-tabs"><span>Symbol</span><span>Last</span><span>Chg</span><span>Chg%</span><span /></div>
      <div id="watchlist-list" className="watchlist-list">
        {items.map((item) => (
          <div className={`watch-row ${item.id === state?.symbol.id ? 'selected' : ''}`} data-id={item.id} role="button" tabIndex={0} key={item.id} onClick={(event) => event.target instanceof HTMLElement && (event.target.closest('.remove-symbol') ? controller?.removeWatchlist(item.id) : controller?.selectWatchlist(item.id))} onKeyDown={(event) => { if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); controller?.selectWatchlist(item.id) } }}>
            <span className="watch-symbol"><AssetIcon symbol={item.symbol} logoId={item.logoId} />{item.symbol}</span>
            <span data-field="price">{item.price == null ? '--' : formatPrice(item.price)}</span>
            <span data-field="change" className={signClass(item.change)}>{item.change == null ? '--' : formatSigned(item.change)}</span>
            <span data-field="changePct" className={signClass(item.changePct)}>{item.changePct == null ? '--' : `${formatSigned(item.changePct)}%`}</span>
            <button className="remove-symbol" title="从自选表移除" aria-label="从自选表移除">×</button>
          </div>
        ))}
      </div>
      <MarketDetails controller={controller} />
    </aside>
  )
}

function MarketDetails({ controller }: { controller: TerminalController | null }) {
  const state = controller?.getControllerState()
  const details = state?.marketDetails
  if (!state?.symbol || !details) return <div id="market-details" className="market-details" />
  return <div id="market-details" className="market-details">
    <div className="detail-title"><AssetIcon symbol={state.symbol.symbol} logoId={details.logoId} /><strong>{state.symbol.symbol}</strong></div>
    <div className="detail-subtitle">{state.symbol.description} · {state.symbol.id.split(':')[0]}</div>
    <div className="detail-price">{controller?.formatPrice(details.price, details.priceScale)} <small>{state.symbol.symbol.split('/').at(-1) || 'USDT'}</small></div>
    <div className={`detail-change ${details.change >= 0 ? 'positive' : 'negative'}`}>{controller?.formatSigned(details.change)} ({controller?.formatSigned(details.changePct)}%)</div>
    <div className="detail-row"><span>24h volume</span><strong>{details.volume}</strong></div>
  </div>
}

function AssetIcon({ symbol, logoId }: { symbol: string; logoId?: string }) {
  const [failed, setFailed] = useState(false)
  const src = symbolLogoUrl(symbol, logoId)
  useEffect(() => setFailed(false), [src])
  if (!src || failed) return <i className="asset-icon">{baseCurrency(symbol)[0] || '?'}</i>
  return <i className="asset-icon"><img src={src} alt="" onError={() => setFailed(true)} /></i>
}

function ReplayDock({ controller }: { controller: TerminalController | null }) {
  const state = controller?.getControllerState()
  const mode = state?.mode
  const canAdvance = !!state && mode === 'replay' && state.replayHead < state.replayEnd
  return (
    <footer className="replay-dock" hidden={!controller || mode === 'live'}>
      <div className="replay-controls">
        <button className={`replay-select ${mode === 'select' ? 'active' : ''}`} id="select-bar" title="选择起始 K 线" onClick={() => controller?.startBarSelection()}><span>⇤</span> 选择 K 线 <small>⌄</small></button>
        <span className="replay-divider" />
        <button className="icon-button play" id="play" title={state?.playing ? '暂停' : '播放'} aria-label={state?.playing ? '暂停' : '播放'} disabled={!canAdvance} onClick={() => state?.playing ? controller?.stopPlayback() : controller?.startPlayback()}>{state?.playing ? 'Ⅱ' : '▶'}</button>
        <button className="icon-button" id="step-forward" title="前进" aria-label="前进" disabled={!canAdvance} onClick={() => controller?.step()}>▷│</button>
        <div className="speed-control">
          <button className="replay-text-button" id="speed" title="回放速度" onClick={() => controller?.toggleSpeedMenu()}>{state?.speedLabel || '1x'}</button>
          <div className="speed-menu" id="speed-menu" hidden={!state?.speedMenuOpen}>
            {[['1200', '0.5x'], ['700', '1x'], ['350', '2x'], ['175', '4x']].map(([speed, label]) => <button key={speed} className={state?.speed === Number(speed) ? 'active' : ''} onClick={() => controller?.setSpeed(speed, label)}>{label}</button>)}
          </div>
        </div>
        <span className="replay-divider" />
        <button className="icon-button" id="jump-live" title="跳转到实时图表" aria-label="跳转到实时图表" disabled={mode !== 'replay'} onClick={() => controller?.exitReplay()}>│▷</button>
      </div>
      <button className="replay-exit" id="exit-replay" title="退出 Bar Replay" aria-label="退出 Bar Replay" onClick={() => controller?.exitReplay()}>×</button>
    </footer>
  )
}

function PaperPanel({ controller }: { controller: TerminalController | null }) {
  const state = controller?.getControllerState()
  const data = controller?.getPaperPanelData()
  const resizeStart = (event: React.PointerEvent) => {
    if (!controller || !state) return
    const startY = event.clientY
    const startHeight = state.paperPanelHeight
    const move = (moveEvent: PointerEvent) => controller.setPaperPanelHeight(startHeight + startY - moveEvent.clientY, window.innerHeight - 180)
    const stop = () => {
      document.removeEventListener('pointermove', move)
      document.removeEventListener('pointerup', stop)
      document.removeEventListener('pointercancel', stop)
    }
    document.addEventListener('pointermove', move)
    document.addEventListener('pointerup', stop)
    document.addEventListener('pointercancel', stop)
  }
  return (
    <section className="paper-panel" id="paper-panel" hidden={!data?.open}>
      <div className="paper-resize-handle" id="paper-resize-handle" role="separator" tabIndex={0} aria-orientation="horizontal" aria-label="调整模拟交易面板高度" aria-valuemin={260} aria-valuenow={state?.paperPanelHeight || 260} onPointerDown={resizeStart} onKeyDown={(event) => { const delta = event.key === 'ArrowUp' ? 20 : event.key === 'ArrowDown' ? -20 : 0; if (delta) { event.preventDefault(); controller?.setPaperPanelHeight((state?.paperPanelHeight || 260) + delta, window.innerHeight - 180) } }} />
      <div className="paper-panel-header"><strong>模拟交易</strong></div>
      <PaperAccount data={data} controller={controller} />
      <nav className="paper-nav" id="paper-tabs">
        <button onClick={() => controller?.setPaperTab('positions')} className={data?.tab === 'positions' ? 'active' : ''}>持仓 <span id="positions-count">{data?.positionsCount || 0}</span></button>
        <button onClick={() => controller?.setPaperTab('orders')} className={data?.tab === 'orders' ? 'active' : ''}>当前委托 <span id="orders-count">{data?.ordersCount || 0}</span></button>
        <button onClick={() => controller?.setPaperTab('order-history')} className={data?.tab === 'order-history' ? 'active' : ''}>委托历史</button><button onClick={() => controller?.setPaperTab('trade-history')} className={data?.tab === 'trade-history' ? 'active' : ''}>成交历史</button>
      </nav>
      <PaperTable data={data} controller={controller} />
    </section>
  )
}

function PaperAccount({ data, controller }: { data: PanelData | undefined; controller: TerminalController | null }) {
  const [confirming, setConfirming] = useState(false)
  if (!data) return <div className="paper-account" id="paper-account" />
  const summary = data.summary
  const fields: [string, number][] = [['账户余额', summary.balance], ['账户净值', summary.equity], ['已实现盈亏', summary.realizedPnl], ['未实现盈亏', summary.unrealizedPnl], ['可用资金', summary.availableFunds], ['委托占用', summary.ordersMargin]]
  return <><div className="paper-account" id="paper-account">{fields.map(([label, value], index) => <span key={label}><small>{label}{index === 0 ? <button className="balance-reset" onClick={() => setConfirming(true)} title="重置模拟账户" aria-label="重置模拟账户">↻</button> : null}</small><strong className={label.includes('盈亏') ? controller?.signClass(value) : ''}>{controller?.formatMoney(value)}</strong></span>)}</div>{confirming && <ConfirmDialog title="重置模拟账户至 $100,000？" message="所有持仓和挂单将被清空，历史记录会保留。" action="重置账户" onConfirm={() => controller?.resetAccount()} onClose={() => setConfirming(false)} />}</>
}

function positionHistoryFilter(details: HTMLDetailsElement) {
  if (!details.open) return
  const menu = details.querySelector<HTMLElement>('.history-filter-menu')
  const summary = details.querySelector('summary')
  if (!menu || !summary) return
  const rect = summary.getBoundingClientRect()
  const roomBelow = window.innerHeight - rect.bottom - 8
  const roomAbove = rect.top - 8
  const below = roomBelow >= 120 || roomBelow >= roomAbove
  menu.style.maxHeight = `${Math.max(80, Math.min(210, below ? roomBelow : roomAbove))}px`
  menu.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - menu.offsetWidth - 8))}px`
  menu.style.top = `${below ? rect.bottom + 4 : Math.max(8, rect.top - menu.offsetHeight - 4)}px`
}

function HistoryFilter({ field, label, symbols, data, controller }: { field: 'symbol' | 'side'; label: string; symbols: string[]; data: PanelData; controller: TerminalController | null }) {
  const detailsRef = useRef<HTMLDetailsElement>(null)
  const options = field === 'symbol' ? symbols.map((symbol) => [symbol, symbol]) : [['buy', '买入'], ['sell', '卖出']]
  const value = data?.filters?.[field] || ''
  const choose = (option: string) => { detailsRef.current!.open = false; controller?.setHistoryFilter(field, option) }
  return <span className="history-column-label">{label}<details ref={detailsRef} className={`history-filter ${value ? 'active' : ''}`} onToggle={(event) => { if (event.currentTarget.open) { document.querySelectorAll<HTMLDetailsElement>('.history-filter[open]').forEach((other) => { if (other !== event.currentTarget) other.open = false }); positionHistoryFilter(event.currentTarget) } }}><summary title={`筛选${label}`} aria-label={`筛选${label}`}>⌕</summary><div className="history-filter-menu" data-history-filter-menu={field}><button className={!value ? 'active' : ''} onClick={() => choose('')}>全部{label}</button>{options.map(([option, text]) => <button key={option} className={value === option ? 'active' : ''} onClick={() => choose(option)}>{text}</button>)}</div></details></span>
}

function PaperTable({ data, controller }: { data: PanelData | undefined; controller: TerminalController | null }) {
  if (!data) return <div className="paper-table" id="paper-table" />
  const format = (value: number) => controller?.formatPrice(value, undefined) || String(value)
  const money = (value: number) => controller?.formatMoney(value) || String(value)
  const jump = (event: React.MouseEvent, symbol: string) => { if ((event.target as HTMLElement).closest('button')) return; controller?.jumpToPaperEvent(symbol) }
  if (data.tab === 'positions') return <div className="paper-table" id="paper-table"><div className="paper-grid position-grid paper-grid-head"><span>标的</span><span>方向</span><span>数量</span><span>平均成交价</span><span>止盈</span><span>止损</span><span>最新价</span><span>未实现盈亏</span><span>盈亏比例</span><span /></div>{data.positions.length ? data.positions.map((position) => { const current = position.symbol === data.symbol ? data.price : position.marketPrice; const pnl = position.quantity * (current - position.averagePrice); const percent = pnl / Math.abs(position.quantity * position.averagePrice) * 100; return <div className="paper-grid position-grid paper-row" key={position.symbol} onClick={(event) => jump(event, position.symbol)}><strong>{position.symbol}</strong><span className={position.quantity > 0 ? 'positive' : 'negative'}>{position.quantity > 0 ? '多' : '空'}</span><span>{controller?.formatOrderQuantity(Math.abs(position.quantity), position.symbol.split(':').at(-1))}</span><span>{format(position.averagePrice)}</span><span>{position.protection.takeProfit == null ? '—' : format(position.protection.takeProfit)}</span><span>{position.protection.stopLoss == null ? '—' : format(position.protection.stopLoss)}</span><span>{format(current)}</span><span className={controller?.signClass(pnl)}>{money(pnl)}</span><span className={controller?.signClass(percent)}>{controller?.formatPnlPercent(percent)}</span><button className="table-action" onClick={() => controller?.closePosition(position.symbol)} title="平仓" aria-label="平仓">×</button></div> }) : <div className="paper-empty">暂无持仓</div>}</div>
  if (data?.tab === 'orders') return <OrderTable orders={data.orders} controller={controller} cancellable />
  const page = data.page
  const items = page?.items || []
  const symbols = [...new Set((data.tab === 'order-history' ? data.orders : data.trades).map((item) => item.symbol).filter((symbol): symbol is string => typeof symbol === 'string'))].sort()
  return <div className="paper-table history" id="paper-table">
    <div className="history-content">
      <div className={`paper-grid ${data.tab === 'order-history' ? 'order-grid' : 'trade-grid'} paper-grid-head`}><HistoryFilter field="symbol" label="标的" symbols={symbols} data={data} controller={controller} /><HistoryFilter field="side" label="方向" symbols={symbols} data={data} controller={controller} />{data.tab === 'order-history' ? <><span>类型</span><span>数量</span><span>限价 / 止损价</span><span>成交价</span><span>止盈</span><span>止损</span><span>状态</span><span>下单时间</span><span /></> : <><span>类型</span><span>数量</span><span>成交价</span><span>手续费</span><span>已实现盈亏</span><span>开仓时间</span><span>平仓时间</span></>}</div>
      {items.length ? data.tab === 'order-history'
        ? <OrderRows orders={items.filter((item): item is PaperOrder => 'status' in item)} controller={controller} />
        : <TradeRows trades={items.filter((item): item is PaperHistoryTrade => !('status' in item))} controller={controller} />
        : <div className="paper-empty">{(data.tab === 'order-history' ? data.orders : data.trades).length ? '没有符合条件的记录' : data.tab === 'order-history' ? '暂无委托历史' : '暂无成交记录'}</div>}
    </div>
    {page && page.pageCount > 1 ? <div className="history-pagination"><button disabled={page.page === 1} onClick={() => controller?.changeHistoryPage(-1)}>‹</button><span>{page.page} / {page.pageCount}</span><button disabled={page.page === page.pageCount} onClick={() => controller?.changeHistoryPage(1)}>›</button></div> : null}
  </div>
}

function OrderTable({ orders, controller, cancellable }: { orders: PaperOrder[]; controller: TerminalController | null; cancellable: boolean }) {
  return <div className="paper-table" id="paper-table"><div className="paper-grid order-grid paper-grid-head"><span>标的</span><span>方向</span><span>类型</span><span>数量</span><span>限价 / 止损价</span><span>成交价</span><span>止盈</span><span>止损</span><span>状态</span><span>下单时间</span><span /></div>{orders.length ? <OrderRows orders={orders} controller={controller} cancellable={cancellable} /> : <div className="paper-empty">暂无当前委托</div>}</div>
}

function OrderRows({ orders, controller, cancellable = false }: { orders: PaperOrder[]; controller: TerminalController | null; cancellable?: boolean }) {
  const format = (value: number | null | undefined) => value == null ? '—' : controller?.formatPrice(value, undefined)
  return <>{orders.map((order) => <div className="paper-grid order-grid paper-row" key={order.id} onClick={(event) => { if (!(event.target as HTMLElement).closest('button')) controller?.jumpToPaperEvent(order.symbol) }}><strong>{order.symbol}</strong><span className={order.side === 'buy' ? 'positive' : 'negative'}>{order.side === 'buy' ? '买入' : '卖出'}</span><span>{controller?.orderTypeLabel(order)}</span><span>{controller?.formatOrderQuantity(order.quantity, order.symbol)}</span><span>{format(order.price)}</span><span>{format(order.fillPrice)}</span><span>{format(order.takeProfit)}</span><span>{format(order.stopLoss)}</span><span className={`order-status ${order.status}`}>{controller?.orderStatusLabel(order.status)}</span><span>{controller?.formatTimestamp(order.createdAt)}</span>{cancellable ? <button className="table-action" onClick={() => controller?.cancelOrder(order.id)} title="取消订单" aria-label="取消订单">×</button> : <span />}</div>)}</>
}

function TradeRows({ trades, controller }: { trades: PaperHistoryTrade[]; controller: TerminalController | null }) {
  return <>{trades.length ? trades.map((trade) => trade.event === 'balance-reset'
    ? <div className="paper-grid trade-grid trade-reset" key={`${trade.timestamp}-${trade.event}`}><strong>模拟交易</strong><span>重置余额</span><span>—</span><span>—</span><span>—</span><span>—</span><span>—</span><span>{controller?.formatTimestamp(trade.timestamp)}</span><span>—</span></div>
    : <div className="paper-grid trade-grid paper-row" key={trade.id || trade.timestamp} onClick={() => controller?.jumpToPaperEvent(trade.symbol)}><strong>{trade.symbol}</strong><span className={trade.side === 'buy' ? 'positive' : 'negative'}>{trade.side === 'buy' ? '买入' : '卖出'}</span><span>{controller?.orderTypeLabel(trade)}</span><span>{controller?.formatOrderQuantity(trade.quantity, trade.symbol)}</span><span>{controller?.formatPrice(trade.price, undefined)}</span><span>{controller?.formatMoney(trade.fee)}</span><span className={controller?.signClass(trade.realizedPnl)}>{controller?.formatMoney(trade.realizedPnl)}</span><span>{trade.openedQuantity === 0 ? '—' : controller?.formatTimestamp(trade.timestamp)}</span><span title={trade.closedAt && trade.closedQuantity < trade.quantity ? '部分平仓' : undefined}>{trade.closedAt == null ? '—' : controller?.formatTimestamp(trade.closedAt)}</span></div>) : <div className="paper-empty">暂无成交记录</div>}</>
}

function SymbolDialog({ controller }: { controller: TerminalController | null }) {
  const state = controller?.getControllerState()
  const results = state?.searchResults || []
  const marketType = (type: string) => controller?.displayMarketType(type) || type
  const typeSpecs = (specs: string[]) => controller?.displayTypeSpecs(specs) || specs.join(' ')

  return (
    <div className="symbol-dialog" id="symbol-dialog" hidden={!state?.searchOpen} onClick={(event) => event.target === event.currentTarget && controller?.closeSymbolSearch()}>
      <section className="symbol-modal" role="dialog" aria-modal="true" aria-labelledby="symbol-dialog-title">
        <div className="symbol-dialog-heading"><strong id="symbol-dialog-title">商品代码搜索</strong><button id="close-search" title="关闭" aria-label="关闭" onClick={() => controller?.closeSymbolSearch()}>×</button></div>
        <div className="symbol-search-bar"><span aria-hidden="true">⌕</span><input id="symbol-search" type="search" autoComplete="off" placeholder="搜索市场" aria-label="搜索标的" value={state?.searchQuery || ''} onChange={(event) => controller?.setSearchQuery(event.target.value)} autoFocus /></div>
        <div className="symbol-filters" id="symbol-filters">
          {[['', '全部'], ['stock', '股票'], ['futures', '期货'], ['forex', '外汇'], ['crypto', '加密货币'], ['index', '指数'], ['economic', '经济']].map(([filter, label]) => <button onClick={() => controller?.setSearchFilter(filter)} className={state?.searchFilter === filter ? 'active' : ''} data-filter={filter} key={filter}>{label}</button>)}
        </div>
        <div className="symbol-results" id="symbol-results">
          {results.map((item, index) => {
            const providerLogo = providerLogoUrl(item.sourceLogoId, item.providerId)
            return <button onClick={() => controller?.selectSearchResult(index)} className={`symbol-result ${item.id === state?.symbol.id ? 'selected' : ''}`} data-index={index} key={`${item.id}-${index}`}>
              <span className="result-symbol"><AssetIcon symbol={item.symbol} logoId={item.logoId} /><strong>{item.symbol}</strong></span>
              <span className="result-description">{item.description}</span>
              <small className="result-type">{marketType(item.type)} {typeSpecs(item.typeSpecs || [])}</small>
              <span className="result-provider"><small>{item.exchange}</small>{providerLogo ? <i className="provider-icon"><img src={providerLogo} alt="" /></i> : null}</span>
            </button>
          })}
        </div>
      </section>
    </div>
  )
}

function StatusLayer({ controller }: { controller: TerminalController | null }) {
  const state = controller?.getControllerState()
  return <><div className={`loading ${state?.loading ? 'show' : ''}`} id="loading" aria-label="加载中"><span /><span /><span /></div><div className={`toast ${state?.toast ? 'show' : ''}`} id="toast" role="status">{state?.toast}</div></>
}

export default TerminalShell
