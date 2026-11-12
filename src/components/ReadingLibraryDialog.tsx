import { useEffect, useRef, useState } from 'react'
import { Download, FolderOpen, Trash2 } from 'lucide-react'
import type { ReadingMemoryFile } from '../model/readingMemory'
import { loadReadingMemory, subscribeReadingMemory, removeAcceptedReading, importReadingMemory, resetReadingMemory, downloadReadingMemory, exportReadingMemoryRaw } from '../storage/readingMemory'
import { ToolDialog } from './ToolDialog'

export function ReadingLibraryDialog({ onClose }: { onClose: () => void }) {
  const [file, setFile] = useState<ReadingMemoryFile | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [confirmReset, setConfirmReset] = useState(false)
  const [query, setQuery] = useState('')
  const [visibleCount, setVisibleCount] = useState(200)
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => {
    let active = true
    let generation = 0
    const refresh = () => {
      const id = ++generation
      void loadReadingMemory().then(value => { if (active && id === generation) { setFile(value); setError('') } })
        .catch(cause => { if (active && id === generation) { setFile(null); setError(String(cause)) } })
    }
    refresh()
    const unsubscribe = subscribeReadingMemory(refresh)
    return () => { active = false; unsubscribe() }
  }, [])
  async function change(action: () => Promise<ReadingMemoryFile>, message: string) {
    setBusy(true); setNotice(''); setError('')
    try { setFile(await action()); setNotice(message) }
    catch (cause) { setError(String(cause)) }
    finally { setBusy(false) }
  }
  async function exportRaw() {
    try {
      const raw = await exportReadingMemoryRaw()
      const url = URL.createObjectURL(new Blob([raw], { type: 'application/json;charset=utf-8' }))
      const anchor = document.createElement('a')
      anchor.href = url; anchor.download = '個人読み辞書-元データ.json'; anchor.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch (cause) { setError(String(cause)) }
  }
  const filtered = (file?.records ?? []).filter(record => !query || record.surface.includes(query) || record.reading.includes(query))
    .toSorted((a, b) => b.acceptedAt.localeCompare(a.acceptedAt))
  return <ToolDialog title="個人読み辞書" onClose={onClose}>
    <div className="tool-dialog-content">
      <p className="search-caption">登録を選んで採用した読みを、このブラウザーに保存します。他の文脈でも正しいとは限りません。歌詞のUndoでは過去の採用記録は消えません。</p>
      <div className="reading-library-actions">
        <button disabled={!file || busy} onClick={() => { try { if (file) downloadReadingMemory(file) } catch (cause) { setError(String(cause)) } }}><Download size={16} />辞書を書き出す</button>
        <button disabled={busy} onClick={() => input.current?.click()}><FolderOpen size={16} />辞書を取り込む</button>
        <button disabled={busy} onClick={() => setConfirmReset(true)}><Trash2 size={16} />退避して空にする</button>
        <input ref={input} type="file" accept=".json,application/json" hidden aria-label="個人読み辞書ファイル" onChange={async event => {
          const selected = event.target.files?.[0]; event.target.value = ''
          if (!selected) return
          if (selected.size > 10 * 1024 * 1024) { setError('辞書ファイルは10 MB以下にしてください。'); return }
          setBusy(true)
          try { const raw = await selected.text(); await change(() => importReadingMemory(raw), '既存の採用記録を保持して取り込みました。') }
          catch (cause) { setError(String(cause)); setBusy(false) }
        }} />
      </div>
      {error && <div className="search-error" role="alert">{error}<div><button onClick={() => void exportRaw()}>保存された元データを書き出す</button></div></div>}
      {notice && <p className="search-progress" role="status">{notice}</p>}
      {confirmReset && <div className="reading-library-confirm"><span>現在の辞書をローカルに退避し、個人辞書を空にします。</span><button disabled={busy} onClick={() => { setConfirmReset(false); void change(() => resetReadingMemory({ archive: true }), '元データを退避して個人辞書を空にしました。') }}>退避して初期化</button><button onClick={() => setConfirmReset(false)}>戻る</button></div>}
      <div className="search-options"><input aria-label="個人読み辞書を検索" placeholder="表記・読みで絞り込む" value={query} onChange={event => { setQuery(event.target.value); setVisibleCount(200) }} /><span className="search-caption">{file?.records.length ?? 0} 件の採用記録</span></div>
      {file && !filtered.length && <p className="search-empty">{file.records.length ? '一致する採用記録はありません。' : '登録した読みはまだありません。読み候補を採用するとき、個人辞書への登録を選べます。'}</p>}
      <div className="reading-library-list">{filtered.slice(0, visibleCount).map(record => <div className="reading-library-record" key={record.id}>
        <div><strong>{record.surface} → {record.reading}</strong><small>{new Date(record.acceptedAt).toLocaleString('ja-JP')} · {record.origin.kind === 'manual' ? '手動で登録' : '候補から採用'}</small><small>{record.context.before}【{record.surface}】{record.context.after}</small></div>
        <button disabled={busy} aria-label={`採用記録 ${record.surface} ${record.reading} を削除`} onClick={() => void change(() => removeAcceptedReading(record.id), '採用記録を削除しました。歌詞の読みは変更していません。')}><Trash2 size={16} /></button>
      </div>)}</div>
      {filtered.length > 200 && <div className="reading-library-actions"><span className="search-caption" role="status">{filtered.length}件中 {Math.min(visibleCount, filtered.length)}件を表示</span>{visibleCount < filtered.length && <button onClick={() => setVisibleCount(count => count + 200)}>さらに200件を表示</button>}</div>}
    </div>
    <footer className="tool-dialog-footer"><button onClick={onClose}>閉じる</button></footer>
  </ToolDialog>
}
