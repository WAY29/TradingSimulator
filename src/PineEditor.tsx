import { useEffect, useRef, useState } from 'react'
import { basicSetup } from 'codemirror'
import { EditorState } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { StreamLanguage, HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { openSearchPanel } from '@codemirror/search'
import { tags } from '@lezer/highlight'
import { showMinimap } from '@replit/codemirror-minimap'
import { ChevronDown, CirclePlay, FilePlus2, MoreHorizontal, Save, Search, Trash2, X } from 'lucide-react'
import { PINE_EXAMPLE } from './pine-example'
import { NEW_SCRIPT_NAME, PINE_DRAFT_KEY, PINE_DRAFT_NAME_KEY, PINE_SCRIPT_ID_KEY, PINE_SCRIPTS_KEY, savedPineScripts, selectPineScript } from './pine-scripts'
import './pine-editor.css'

type Controller = typeof import('./terminal-controller')

const pineLanguage = StreamLanguage.define({
  token(stream) {
    if (stream.match(/\/\/.*$/)) return 'comment'
    if (stream.match(/#[\da-fA-F]{6,8}\b/)) return 'color'
    if (stream.match(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/)) return 'string'
    if (stream.match(/\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/)) return 'number'
    if (stream.match(/[\p{L}_][\p{L}\p{N}_]*/u)) {
      const value = stream.current()
      if (/^(if|else|for|while|switch|break|continue|return|var|varip|type|method|export|import|true|false|na)$/.test(value)) return 'keyword'
      if (/^(indicator|strategy|plot|plotshape|plotchar|plotarrow|plotcandle|plotbar|hline|fill|bgcolor|barcolor|input)$/.test(value)) return 'function'
      if (/^(open|high|low|close|volume|time|bar_index|barstate|color|ta|math|str|array|table|line|label|box)$/.test(value)) return 'builtin'
      if (stream.peek() === '(') return 'function'
      return 'variable'
    }
    if (stream.match(/(?:=>|:=|==|!=|<=|>=|[+*\/%=<>?:-])/)) return 'operator'
    stream.next()
    return null
  },
})

const pineColors = HighlightStyle.define([
  { tag: tags.comment, color: '#818794' },
  { tag: tags.string, color: '#71bd76' },
  { tag: tags.number, color: '#ffad55' },
  { tag: tags.keyword, color: '#ea7d86' },
  { tag: tags.function(tags.variableName), color: '#89baff' },
  { tag: tags.standard(tags.variableName), color: '#8db7ed' },
  { tag: tags.color, color: '#ffcb7d' },
  { tag: tags.operator, color: '#57c9c0' },
])

const pineTheme = EditorView.theme({
  '&': { height: '100%', backgroundColor: '#0b0c0f', color: '#d9dce2', fontSize: '13px' },
  '.cm-scroller': { overflow: 'auto', fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace', lineHeight: '22px' },
  '.cm-content': { padding: '14px 0', caretColor: '#d9dce2' },
  '.cm-line': { padding: '0 16px', whiteSpace: 'pre' },
  '.cm-gutters': { backgroundColor: '#0b0c0f', color: '#777d86', border: 'none', paddingRight: '8px' },
  '.cm-activeLine': { backgroundColor: '#1b2844' },
  '.cm-activeLineGutter': { backgroundColor: '#1b2844', color: '#c4c8d2' },
  '.cm-selectionBackground': { backgroundColor: '#304263 !important' },
  '.cm-cursor': { borderLeftColor: '#d9dce2' },
  '.cm-panels': { backgroundColor: '#1b1e25', color: '#d9dce2' },
  '.cm-searchMatch': { backgroundColor: '#74633388' },
}, { dark: true })

export default function PineEditor({ controller, onClose }: { controller: Controller; onClose: () => void }) {
  const [source, setSource] = useState(() => sessionStorage.getItem(PINE_DRAFT_KEY) || controller.getControllerState().pineSource || PINE_EXAMPLE)
  const [scripts, setScripts] = useState(savedPineScripts)
  const [scriptId, setScriptId] = useState<string | null>(() => sessionStorage.getItem(PINE_SCRIPT_ID_KEY))
  const [name, setName] = useState(() => sessionStorage.getItem(PINE_DRAFT_NAME_KEY) || savedPineScripts().find((script) => script.id === sessionStorage.getItem(PINE_SCRIPT_ID_KEY))?.name || '均线系统')
  const [menu, setMenu] = useState<'scripts' | 'more' | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const editorRoot = useRef<HTMLDivElement>(null)
  const editor = useRef<EditorView | null>(null)
  const saveRef = useRef<() => void>(() => {})
  const runRef = useRef<() => void>(() => {})
  const active = Boolean(controller.getControllerState().pineSource)

  const replaceSource = (next: string) => {
    const view = editor.current
    if (view) view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: next } })
    else setSource(next)
  }
  const save = () => {
    const nextSource = editor.current?.state.doc.toString() ?? source
    const nextName = name.trim() || NEW_SCRIPT_NAME
    const id = scriptId || crypto.randomUUID()
    const nextScripts = [{ id, name: nextName, source: nextSource }, ...scripts.filter((script) => script.id !== id)].slice(0, 50)
    try {
      localStorage.setItem(PINE_SCRIPTS_KEY, JSON.stringify(nextScripts))
      sessionStorage.setItem(PINE_SCRIPT_ID_KEY, id)
      sessionStorage.setItem(PINE_DRAFT_NAME_KEY, nextName)
      setScripts(nextScripts); setScriptId(id); setName(nextName); setMessage('已保存'); setError('')
    } catch { setError('无法保存脚本，请检查浏览器存储空间') }
  }
  const run = async () => {
    if (pending) return
    setPending(true); setError(''); setMessage('')
    try {
      await controller.applyPineScript(editor.current?.state.doc.toString() ?? source)
      setMessage('已添加到图表')
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setPending(false) }
  }
  saveRef.current = save
  runRef.current = () => { void run() }

  useEffect(() => {
    if (!editorRoot.current) return
    const view = new EditorView({
      state: EditorState.create({
        doc: source,
        extensions: [
          basicSetup, pineLanguage, syntaxHighlighting(pineColors), pineTheme,
          EditorView.contentAttributes.of({ 'aria-label': 'Pine Script 代码' }),
          EditorView.updateListener.of((update) => {
            if (!update.docChanged) return
            const text = update.state.doc.toString()
            setSource(text); sessionStorage.setItem(PINE_DRAFT_KEY, text)
            setMessage(''); setError('')
          }),
          keymap.of([
            { key: 'Mod-s', run: () => { saveRef.current(); return true } },
            { key: 'Mod-Enter', run: () => { runRef.current(); return true } },
          ]),
          showMinimap.compute(['doc'], () => ({
            create: () => { const dom = document.createElement('div'); return { dom } },
            displayText: 'blocks', showOverlay: 'always',
          })),
        ],
      }),
      parent: editorRoot.current,
    })
    editor.current = view
    view.focus()
    return () => { editor.current = null; view.destroy() }
  }, [])

  useEffect(() => {
    const dismiss = (event: MouseEvent) => { if (!(event.target as Element).closest('.pine-editor__menu-area')) setMenu(null) }
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      if (menu) setMenu(null)
      else if (!pending && !(event.target as Element).closest('.cm-panels')) onClose()
    }
    document.addEventListener('pointerdown', dismiss)
    document.addEventListener('keydown', escape)
    return () => { document.removeEventListener('pointerdown', dismiss); document.removeEventListener('keydown', escape) }
  }, [menu, pending, onClose])

  const load = (script: typeof scripts[number]) => {
    selectPineScript(script)
    replaceSource(script.source); setScriptId(script.id); setName(script.name); setMenu(null)
  }
  const newScript = () => {
    selectPineScript(null)
    replaceSource(sessionStorage.getItem(PINE_DRAFT_KEY) || '')
    setName(NEW_SCRIPT_NAME); setScriptId(null); setMenu(null)
  }
  return <aside className="pine-editor" aria-labelledby="pine-editor-title">
    <header className="pine-editor__header">
      <strong id="pine-editor-title">Pine编辑器</strong>
      <button className="pine-editor__icon" title="关闭编辑器" aria-label="关闭编辑器" onClick={onClose}><X size={20} /></button>
    </header>
    <div className="pine-editor__toolbar">
      <div className="pine-editor__menu-area">
        <button className="pine-editor__title" aria-expanded={menu === 'scripts'} aria-label="脚本列表" onClick={() => setMenu(menu === 'scripts' ? null : 'scripts')}><span>{name}</span><ChevronDown size={16} /></button>
        {menu === 'scripts' && <div className="pine-editor__menu" role="group" aria-label="已保存脚本">
          <label>脚本名称<input value={name} maxLength={64} onChange={(event) => { setName(event.target.value); sessionStorage.setItem(PINE_DRAFT_NAME_KEY, event.target.value) }} /></label>
          {scripts.map((script) => <button key={script.id} onClick={() => load(script)}>{script.name}</button>)}
          <button onClick={newScript}><FilePlus2 size={15} /> 新建脚本</button>
        </div>}
      </div>
      <div className="pine-editor__actions">
        <button className="pine-editor__icon" title="搜索代码" aria-label="搜索代码" onClick={() => editor.current && openSearchPanel(editor.current)}><Search size={18} /></button>
        <button className="pine-editor__icon" title="保存脚本" aria-label="保存脚本" onClick={save}><Save size={18} /></button>
        <button className="pine-editor__run" disabled={pending || !source.trim()} onClick={() => { void run() }}><CirclePlay size={17} />{pending ? '运行中…' : active ? '更新图表' : '添加到图表'}</button>
        {(active || scriptId) && <div className="pine-editor__menu-area">
          <button className="pine-editor__icon" title="更多操作" aria-label="更多操作" aria-expanded={menu === 'more'} onClick={() => setMenu(menu === 'more' ? null : 'more')}><MoreHorizontal size={20} /></button>
          {menu === 'more' && <div className="pine-editor__menu pine-editor__menu--right" role="group" aria-label="脚本操作">
            {active && <button onClick={() => { controller.clearPineScript(); setMenu(null); setMessage('已从图表移除') }}><Trash2 size={15} /> 从图表移除</button>}
            {scriptId && <button onClick={() => {
              const next = scripts.filter((script) => script.id !== scriptId)
              try {
                localStorage.setItem(PINE_SCRIPTS_KEY, JSON.stringify(next))
                sessionStorage.removeItem(PINE_SCRIPT_ID_KEY)
                setScripts(next); setScriptId(null); setMenu(null); setMessage('已删除保存的脚本')
              } catch { setError('无法删除脚本，请检查浏览器存储权限') }
            }}><Trash2 size={15} /> 删除已保存脚本</button>}
          </div>}
        </div>}
      </div>
    </div>
    <div className="pine-editor__code" ref={editorRoot} />
    <footer className="pine-editor__status">
      {error ? <span className="pine-editor__error" role="alert">{error}</span> : <span>{message || 'Pine Script'}</span>}
      <span>{source.split('\n').length} 行</span>
    </footer>
  </aside>
}
