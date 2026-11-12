import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, SetStateAction } from 'react'
import { Activity, ArrowLeftRight, Columns2, CopyPlus, GripVertical, PanelTop, Rows2, X } from 'lucide-react'
import { EditorPane } from './components/EditorPane'
import type { ChromeSlots, PaneBinding, PaneCommand } from './components/EditorPane'
import { DesktopMenu } from './components/DesktopMenu'
import type { MenuGroup } from './components/DesktopMenu'
import { createDemoFile, createLyricsFile } from './model/document'
import type { LyricsFile } from './model/document'
import { createWorkspace, parseWorkspaceFile } from './model/workspace'
import type { PaneId, SplitMode, WorkspaceFile } from './model/workspace'
import { archiveWorkspace, downloadStoredWorkspace, downloadWorkspace, loadWorkspace, saveWorkspace } from './storage/workspace'
import { ComparisonPanel } from './features/ComparisonPanel'
import './workspace.css'

export default function App() {
  const [initial, setInitial] = useState<WorkspaceFile | null>(null)
  const [bootError, setBootError] = useState('')
  const [bootNotice, setBootNotice] = useState('')
  const [bootBusy, setBootBusy] = useState(false)
  const [hasEditLock, setHasEditLock] = useState(false)
  useEffect(() => {
    let active = true
    const controller = new AbortController()
    let release = () => {}
    const held = new Promise<void>(resolve => { release = resolve })
    if (!navigator.locks) {
      setBootError('安全な自動保存に必要な Web Locks を利用できません。対応ブラウザーで localhost または HTTPS の URL を開いてください。')
    } else {
      // Hold the lock for this mounted app's lifetime. Waiting tabs must load
      // only after acquisition, otherwise their snapshot would already be old.
      void navigator.locks.request('lyrics-studio-workspace-editor', { signal: controller.signal }, async () => {
        if (!active) return
        setHasEditLock(true)
        try {
          const workspace = await loadWorkspace()
          if (active) setInitial(workspace ?? createWorkspace(createDemoFile()))
        } catch (error) { if (active) setBootError(String(error)) }
        await held
      }).catch(error => { if (active) setBootError(String(error)) })
    }
    return () => { active = false; controller.abort(); release() }
  }, [])
  async function recover(action: () => Promise<void>) {
    setBootBusy(true)
    setBootNotice('')
    try { await action() }
    catch (error) { setBootError(String(error)) }
    finally { setBootBusy(false) }
  }
  if (!initial) return <main className="boot">
    <span className="brand-mark"><Activity /></span><h1>Lyrics Studio</h1>
    {bootError ? <>
      <p>保存した文書を読み込めませんでした。</p><p role="alert">{bootError}</p>
      {hasEditLock && <>
        <p>まず元データを書き出して保管してください。書き出しても、ブラウザー内の保存データは変更されません。</p>
        <div className="boot-actions">
          <button disabled={bootBusy} onClick={() => void recover(async () => {
            await downloadStoredWorkspace()
            setBootNotice('元データのダウンロードを開始しました。保存先を確認してください。')
          })}>保存された元データを書き出す</button>
          <button disabled={bootBusy} onClick={() => void recover(async () => {
            const workspace = await loadWorkspace()
            setInitial(workspace ?? createWorkspace(createDemoFile()))
          })}>読み込みを再試行</button>
          <button disabled={bootBusy} onClick={() => void recover(async () => {
            await archiveWorkspace()
            setInitial(createWorkspace(createLyricsFile()))
          })}>元データを退避して新しい文書で開始</button>
        </div>
      </>}
      {bootNotice && <p role="status">{bootNotice}</p>}
    </> : <p role="status">{hasEditLock ? '作詞のワークスペースを開いています…' : '編集権を待っています。別のタブで Lyrics Studio を開いている場合は、そのタブを閉じると最新の歌詞を読み込みます。'}</p>}
  </main>
  return <StudioWorkspace initial={initial} />
}

function StudioWorkspace({ initial }: { initial: WorkspaceFile }) {
  const [menuMode, setMenuMode] = useState<'bar' | 'compact'>(() => {
    try { return localStorage.getItem('lyrics-studio-menu-mode') === 'compact' ? 'compact' : 'bar' }
    catch { return 'bar' }
  })
  const [workspace, setWorkspace] = useState(initial)
  const current = useRef(workspace)
  current.current = workspace
  const [sessions, setSessions] = useState({ a: 0, b: 0 })
  const [saveStatus, setSaveStatus] = useState<'pending' | 'saved' | 'error'>('pending')
  const [error, setError] = useState('')
  const [saveError, setSaveError] = useState('')
  const [notice, setNotice] = useState('')
  const bindings = useRef<Record<PaneId, PaneBinding | null>>({ a: null, b: null })
  const pendingFocus = useRef<PaneId | null>(null)
  const composing = useRef<Record<PaneId, boolean>>({ a: false, b: false })
  const saveQueue = useRef<Promise<void>>(Promise.resolve())
  const replacing = useRef(false)
  const [top, setTop] = useState<HTMLDivElement | null>(null)
  const [toolbar, setToolbar] = useState<HTMLDivElement | null>(null)
  const [structure, setStructure] = useState<HTMLDivElement | null>(null)
  const [inspector, setInspector] = useState<HTMLDivElement | null>(null)
  const [footer, setFooter] = useState<HTMLDivElement | null>(null)
  const paneGrid = useRef<HTMLDivElement>(null)
  const slots = useMemo<ChromeSlots | null>(() => top && toolbar && structure && inspector && footer ? { top, toolbar, structure, inspector, footer } : null, [top, toolbar, structure, inspector, footer])

  const updatePane = useCallback((id: PaneId, change: SetStateAction<LyricsFile>) => {
    setWorkspace(previous => {
      const oldFile = previous.documents[id]
      if (!oldFile) return previous
      const file = typeof change === 'function' ? change(oldFile) : change
      if (oldFile === file) return previous
      return { ...previous, documents: { ...previous.documents, [id]: file } }
    })
  }, [])
  const setA = useCallback((change: SetStateAction<LyricsFile>) => updatePane('a', change), [updatePane])
  const setB = useCallback((change: SetStateAction<LyricsFile>) => updatePane('b', change), [updatePane])
  const onActivate = useCallback((id: PaneId) => setWorkspace(previous => previous.activePane === id ? previous : { ...previous, activePane: id }), [])
  const onReady = useCallback((id: PaneId, value: PaneBinding | null) => { bindings.current[id] = value }, [])
  const onComposing = useCallback((id: PaneId, value: boolean) => { composing.current[id] = value }, [])

  useLayoutEffect(() => {
    if (pendingFocus.current === workspace.activePane) {
      const editor = bindings.current[workspace.activePane]?.editor
      editor?.view.focus()
      editor?.commands.scrollIntoView()
      pendingFocus.current = null
    }
  }, [workspace.activePane])

  useEffect(() => {
    let active = true
    setSaveStatus('pending')
    const timer = setTimeout(() => {
      const pending = saveQueue.current.catch(() => {}).then(() => saveWorkspace(workspace))
      saveQueue.current = pending
      pending.then(() => { if (active) { setSaveStatus('saved'); setSaveError('') } }).catch(cause => { if (active) { setSaveStatus('error'); setSaveError(`自動保存できませんでした。「A/Bをまとめて保存」で書き出してください。${String(cause)}`) } })
    }, 500)
    return () => { active = false; clearTimeout(timer) }
  }, [workspace])

  useEffect(() => {
    const guard = (event: BeforeUnloadEvent) => {
      if (saveStatus !== 'saved' || composing.current.a || composing.current.b) { event.preventDefault(); event.returnValue = '' }
    }
    window.addEventListener('beforeunload', guard)
    return () => window.removeEventListener('beforeunload', guard)
  }, [saveStatus])

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229 || composing.current.a || composing.current.b) return
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 's') {
        event.preventDefault()
        try { downloadWorkspace(current.current); setNotice('歌詞A/Bと分割・比較設定のダウンロードを開始しました。保存先を確認してください。') } catch (cause) { setError(String(cause)) }
      }
      if (event.altKey && (event.key === '1' || event.key === '2') && !event.isComposing) {
        if (document.activeElement?.closest('[role="dialog"][aria-modal="true"]')) return
        const id = event.key === '1' ? 'a' : 'b'
        if (current.current.documents[id]) {
          event.preventDefault()
          // Commit visibility before focusing a previously hidden pane. A layout
          // effect below handles that case; visible editors can focus directly.
          onActivate(id)
          const binding = bindings.current[id]
          if (binding && !binding.editor.view.dom.closest('[hidden]')) binding.editor.view.focus()
          else pendingFocus.current = id
        }
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onActivate])

  async function replaceSafely(apply: (snapshot: WorkspaceFile) => void) {
    if (replacing.current) throw new Error('別のファイルを開いています。処理が終わってから開いてください。')
    replacing.current = true
    try {
      const snapshot = current.current
      const editorsMatch = () => (['a', 'b'] as const).every(id => {
        const binding = bindings.current[id]
        return !binding || binding.editor.state.doc.eq(binding.editor.schema.nodeFromJSON(snapshot.documents[id]?.editorDocument))
      })
      if (composing.current.a || composing.current.b || !editorsMatch()) throw new Error('入力を確定してから、もう一度開いてください。')
      // Serialize archival with autosaves, and abort replacement if editing
      // continued while IndexedDB was busy. No newer input is discarded.
      const pending = saveQueue.current.catch(() => {}).then(async () => {
        await saveWorkspace(snapshot)
        await archiveWorkspace()
      })
      saveQueue.current = pending
      await pending
      if (current.current !== snapshot || composing.current.a || composing.current.b || !editorsMatch()) {
        throw new Error('退避中に編集内容が変わったため、切り替えを中止しました。現在の歌詞を保持しています。もう一度開いてください。')
      }
      apply(snapshot)
    } finally { replacing.current = false }
  }
  async function replacePane(id: PaneId, file: LyricsFile) {
    await replaceSafely(previous => {
      setWorkspace({ ...previous, documents: { ...previous.documents, [id]: file }, comparison: { ...previous.comparison, alignment: null, leftSectionId: null, rightSectionId: null } })
      setSessions(sessions => ({ ...sessions, [id]: sessions[id] + 1 }))
    })
  }
  async function openWorkspace(raw: string) {
    const next = parseWorkspaceFile(raw)
    await replaceSafely(() => {
      setWorkspace(next)
      setSessions(previous => ({ a: previous.a + 1, b: previous.b + 1 }))
    })
  }
  function split(mode: SplitMode) {
    setWorkspace(previous => ({ ...previous, documents: mode === 'single' || previous.documents.b ? previous.documents : { ...previous.documents, b: createLyricsFile('', '訳詞 B') }, layout: { ...previous.layout, mode } }))
  }
  function compare(kind: 'sections' | 'documents') {
    setWorkspace(previous => {
      const a = previous.documents.a
      const isDocuments = kind === 'documents'
      return {
        ...previous,
        documents: { a, b: isDocuments ? previous.documents.b ?? createLyricsFile('', '訳詞 B') : previous.documents.b },
        layout: isDocuments && previous.layout.mode === 'single' ? { ...previous.layout, mode: 'vertical' } : previous.layout,
        comparison: previous.comparison.kind === kind
          ? { ...previous.comparison, visible: true }
          : { ...previous.comparison, visible: true, kind, leftSectionId: null, rightSectionId: null, alignment: null },
      }
    })
  }
  async function duplicateToB() {
    try {
      await replaceSafely(previous => {
        const source = previous.documents.a
        const clone = structuredClone(source)
        clone.documentId = crypto.randomUUID()
        clone.title = `${source.title} — 訳詞`
        clone.createdAt = clone.updatedAt = new Date().toISOString()
        setWorkspace({ ...previous, documents: { ...previous.documents, b: clone }, activePane: 'b', layout: { ...previous.layout, mode: previous.layout.mode === 'single' ? 'vertical' : previous.layout.mode }, comparison: { ...previous.comparison, kind: 'documents', visible: true, alignment: null, leftSectionId: null, rightSectionId: null } })
        setSessions(previous => ({ ...previous, b: previous.b + 1 }))
      })
      setNotice('歌詞Aを独立した歌詞Bへ複製しました。元のワークスペースは退避済みです。')
    } catch (cause) { setError(String(cause)) }
  }

  function resize(clientX: number, clientY: number) {
    const rect = paneGrid.current?.getBoundingClientRect()
    if (!rect) return
    const vertical = current.current.layout.mode === 'vertical'
    const ratio = vertical ? (clientX - rect.left) / rect.width : (clientY - rect.top) / rect.height
    setWorkspace(previous => ({ ...previous, layout: { ...previous.layout, ratio: Math.min(.75, Math.max(.25, ratio)) } }))
  }
  function jump(side: 'left' | 'right', from: number, to: number) {
    const pane = workspace.comparison.kind === 'documents' ? side === 'left' ? 'a' : 'b' : workspace.activePane
    const binding = bindings.current[pane]
    if (binding?.editor.view.dom.closest('[hidden]')) {
      pendingFocus.current = pane
      binding.editor.commands.setTextSelection({ from, to })
    } else binding?.focusRange(from, to)
    onActivate(pane)
  }
  function setMenuPresentation(mode: 'bar' | 'compact') {
    setMenuMode(mode)
    try { localStorage.setItem('lyrics-studio-menu-mode', mode) }
    catch { setNotice('メニュー表示を変更しました。このブラウザーでは表示設定を保存できません。') }
  }
  function runCommand(command: PaneCommand) {
    bindings.current[current.current.activePane]?.runCommand(command)
  }
  function saveAll() {
    try { downloadWorkspace(current.current); setNotice('歌詞A/Bと分割・比較設定のダウンロードを開始しました。保存先を確認してください。') }
    catch (cause) { setError(String(cause)) }
  }
  function closeComparison() {
    setWorkspace(previous => ({ ...previous, comparison: { ...previous.comparison, visible: false } }))
  }
  const activeFile = workspace.documents[workspace.activePane] ?? workspace.documents.a
  const activeEditor = bindings.current[workspace.activePane]?.editor
  const groups: MenuGroup[] = [
    { id: 'file', label: 'ファイル', items: [
      { id: 'new', label: '新しい歌詞', onSelect: () => runCommand('new') },
      { id: 'open', label: 'ファイルを開く…', shortcut: 'Ctrl+O', onSelect: () => runCommand('open') },
      { separator: true },
      { id: 'save', label: '操作中の歌詞を保存', shortcut: 'Ctrl+S', onSelect: () => runCommand('save') },
      { id: 'saveAll', label: 'A/Bをまとめて保存', shortcut: 'Ctrl+Shift+S', onSelect: saveAll },
      { separator: true },
      { id: 'exportText', label: 'プレーンテキストを書き出す', onSelect: () => runCommand('exportText') },
    ] },
    { id: 'edit', label: '編集', items: [
      { id: 'undo', label: '元に戻す', shortcut: 'Ctrl+Z', disabled: !activeEditor?.can().undo(), onSelect: () => runCommand('undo') },
      { id: 'redo', label: 'やり直す', shortcut: 'Ctrl+Shift+Z', disabled: !activeEditor?.can().redo(), onSelect: () => runCommand('redo') },
      { separator: true },
      { id: 'selectAll', label: 'すべて選択', shortcut: 'Ctrl+A', onSelect: () => runCommand('selectAll') },
      { id: 'reading', label: '読みを編集', shortcut: 'Alt+R', onSelect: () => runCommand('reading') },
      { id: 'searchReading', label: '読み候補を探す', onSelect: () => runCommand('searchReading') },
      { id: 'batchReading', label: '選択範囲の読みを一括設定', onSelect: () => runCommand('batchReading') },
      { id: 'readingLibrary', label: '個人読み辞書', onSelect: () => runCommand('readingLibrary') },
      { id: 'tags', label: 'タグの分類…', onSelect: () => runCommand('tags') },
    ] },
    { id: 'view', label: '表示', items: [
      ...(['plain', 'ruby', 'analysis'] as const).map((mode, index) => ({
        id: mode, label: ['原文', 'ルビ', '解析'][index], checked: activeFile.settings.viewMode === mode,
        onSelect: () => updatePane(workspace.activePane, file => ({ ...file, settings: { ...file.settings, viewMode: mode } })),
      })),
      { separator: true },
      { id: 'zoomIn', label: '拡大', onSelect: () => runCommand('zoomIn') },
      { id: 'zoomOut', label: '縮小', onSelect: () => runCommand('zoomOut') },
      { id: 'zoomReset', label: '100%に戻す', onSelect: () => runCommand('zoomReset') },
      { separator: true },
      { id: 'menuMode', label: 'メニューバーを常時表示', checked: menuMode === 'bar', onSelect: () => setMenuPresentation(menuMode === 'bar' ? 'compact' : 'bar') },
    ] },
    { id: 'compare', label: '比較', items: [
      { id: 'sections', label: 'セクション比較', checked: workspace.comparison.visible && workspace.comparison.kind === 'sections', onSelect: () => compare('sections') },
      { id: 'documents', label: 'A/B比較', checked: workspace.comparison.visible && workspace.comparison.kind === 'documents', onSelect: () => compare('documents') },
      { id: 'closeComparison', label: '比較を閉じる', disabled: !workspace.comparison.visible, onSelect: closeComparison },
      { separator: true },
      ...(['single', 'vertical', 'horizontal'] as const).map((mode, index) => ({
        id: mode, label: ['単一ペイン', '左右に分割', '上下に分割'][index], checked: workspace.layout.mode === mode, onSelect: () => split(mode),
      })),
    ] },
    { id: 'help', label: 'ヘルプ', items: [{ id: 'help', label: '使い方', onSelect: () => runCommand('help') }] },
  ]
  const isSplit = workspace.layout.mode !== 'single' && Boolean(workspace.documents.b)
  const leftDocument = workspace.comparison.kind === 'documents' ? workspace.documents.a : workspace.documents[workspace.activePane] ?? workspace.documents.a
  const rightDocument = workspace.comparison.kind === 'documents' ? workspace.documents.b ?? workspace.documents.a : leftDocument
  const gridStyle: CSSProperties = workspace.layout.mode === 'vertical' ? { gridTemplateColumns: `minmax(0, ${workspace.layout.ratio}fr) 7px minmax(0, ${1 - workspace.layout.ratio}fr)` } : workspace.layout.mode === 'horizontal' ? { gridTemplateRows: `minmax(0, ${workspace.layout.ratio}fr) 7px minmax(0, ${1 - workspace.layout.ratio}fr)` } : {}

  return <div className={`studio-shell ${isSplit ? 'is-split' : ''}`}>
    <header className="desktop-header">
      <div className="desktop-titlebar">
        <DesktopMenu groups={groups} mode={menuMode} onModeChange={setMenuPresentation} />
        <div ref={setTop} className="chrome-top" />
      </div>
      <div ref={setToolbar} className="desktop-toolbar" role="group" aria-label="ファイル操作" />
    </header>
    <div className="studio-body">
      <div ref={setStructure} className="chrome-structure" />
      <div className="main-workspace">
        <nav className="workspace-controls" aria-label="ペインと比較">
          <div className="document-switch" aria-label="操作する歌詞">
            <button className={workspace.activePane === 'a' ? 'active' : ''} aria-pressed={workspace.activePane === 'a'} onClick={() => onActivate('a')}>A <span>歌詞A</span></button>
            {workspace.documents.b && <button className={workspace.activePane === 'b' ? 'active' : ''} aria-pressed={workspace.activePane === 'b'} onClick={() => onActivate('b')}>B <span>歌詞B</span></button>}
          </div>
          <div className="split-controls" aria-label="ペイン分割">
            <button title="単一ペイン（もう片方の歌詞は保持）" aria-label="単一ペイン" aria-pressed={workspace.layout.mode === 'single'} onClick={() => split('single')}><PanelTop size={16} /></button>
            <button title="左右に分割" aria-label="左右に分割" aria-pressed={workspace.layout.mode === 'vertical'} onClick={() => split('vertical')}><Columns2 size={16} /></button>
            <button title="上下に分割" aria-label="上下に分割" aria-pressed={workspace.layout.mode === 'horizontal'} onClick={() => split('horizontal')}><Rows2 size={16} /></button>
          </div>
          <div className="compare-controls"><button aria-pressed={workspace.comparison.visible && workspace.comparison.kind === 'sections'} onClick={() => compare('sections')}>セクション比較</button><button aria-pressed={workspace.comparison.visible && workspace.comparison.kind === 'documents'} onClick={() => compare('documents')}><ArrowLeftRight size={14} />A/B比較</button></div>
        </nav>
        <div className={`pane-grid split-${workspace.layout.mode}`} ref={paneGrid} style={gridStyle}>
          {slots && <EditorPane key={`a-${sessions.a}`} paneId="a" file={workspace.documents.a} setFile={setA} active={workspace.activePane === 'a'} hidden={!isSplit && workspace.activePane !== 'a'} slots={slots} saveStatus={saveStatus} onActivate={onActivate} onReady={onReady} onComposing={onComposing} onOpen={file => replacePane('a', file)} onOpenWorkspace={openWorkspace} onSaveWorkspace={saveAll} />}
          {isSplit && <div className="pane-divider" role="separator" tabIndex={0} aria-label="ペインの分割位置" aria-orientation={workspace.layout.mode === 'vertical' ? 'vertical' : 'horizontal'} aria-valuemin={25} aria-valuemax={75} aria-valuenow={Math.round(workspace.layout.ratio * 100)} onPointerDown={event => { event.currentTarget.setPointerCapture(event.pointerId); event.preventDefault() }} onPointerMove={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) resize(event.clientX, event.clientY) }} onPointerUp={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId) }} onKeyDown={event => { if (['ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowDown', 'Home', 'End'].includes(event.key)) { event.preventDefault(); const ratio = event.key === 'Home' ? .25 : event.key === 'End' ? .75 : workspace.layout.ratio + (['ArrowLeft', 'ArrowUp'].includes(event.key) ? -.05 : .05); setWorkspace(previous => ({ ...previous, layout: { ...previous.layout, ratio: Math.max(.25, Math.min(.75, ratio)) } })) } }}><GripVertical size={12} /></div>}
          {slots && workspace.documents.b && <EditorPane key={`b-${sessions.b}`} paneId="b" file={workspace.documents.b} setFile={setB} active={workspace.activePane === 'b'} hidden={!isSplit && workspace.activePane !== 'b'} slots={slots} saveStatus={saveStatus} onActivate={onActivate} onReady={onReady} onComposing={onComposing} onOpen={file => replacePane('b', file)} onOpenWorkspace={openWorkspace} onSaveWorkspace={saveAll} />}
        </div>
        {workspace.documents.b && !workspace.documents.b.editorDocument.content?.some(paragraph => paragraph.content?.some(node => Boolean(node.text))) && <div className="translation-start"><span>歌詞Bに訳詞を入力、またはファイルを開いて比較できます。</span><button onClick={duplicateToB}><CopyPlus size={14} />AをBへ複製して始める</button></div>}
        {workspace.comparison.visible && <ComparisonPanel leftDocument={leftDocument} rightDocument={rightDocument} kind={workspace.comparison.kind} leftSectionId={workspace.comparison.leftSectionId} rightSectionId={workspace.comparison.rightSectionId} alignment={workspace.comparison.alignment} onChange={patch => setWorkspace(previous => ({ ...previous, comparison: { ...previous.comparison, ...patch } }))} onJump={jump} onClose={() => setWorkspace(previous => ({ ...previous, comparison: { ...previous.comparison, visible: false } }))} />}
      </div>
      <div ref={setInspector} className="chrome-inspector" />
    </div>
    <div ref={setFooter} className="chrome-footer" />
    {(error || saveError || notice) && <div className={`notification workspace-notice ${error || saveError ? 'error' : ''}`} role={error || saveError ? 'alert' : 'status'}><span>{error || saveError || notice}</span><button aria-label="ワークスペース通知を閉じる" onClick={() => { setError(''); setSaveError(''); setNotice('') }}><X size={16} /></button></div>}
  </div>
}
