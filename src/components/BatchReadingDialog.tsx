import { useEffect, useMemo, useRef, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { countMora } from '../analysis'
import { createReadingMemory, type ReadingMemoryFile } from '../model/readingMemory'
import { loadReadingMemory, subscribeReadingMemory } from '../storage/readingMemory'
import { runBatchReadingSearch, type BatchReadingTarget, type BatchReadingResult, type BatchReadingItem } from '../search/batch'
import { observeReadings } from '../search/client'
import type { ReadingCandidate } from '../search/types'
import { ToolDialog } from './ToolDialog'

export interface BatchReadingChoice { item: BatchReadingItem; reading: string; candidate: ReadingCandidate | null }
type Choice = { id: string; manual: string }
const usable = (item: BatchReadingItem) => item.result && !['stale', 'invalid', 'cancelled', 'running'].includes(item.result.status)
  ? item.result.rankedCandidates.filter(candidate => candidate.applicable) : []

export function BatchReadingDialog({ target, stale, onAdopt, onClose }: {
  target: BatchReadingTarget; stale: boolean
  onAdopt: (choices: BatchReadingChoice[], remember: boolean) => void
  onClose: () => void
}) {
  const [memory, setMemory] = useState<ReadingMemoryFile | null>(null)
  const [memoryError, setMemoryError] = useState('')
  const [result, setResult] = useState<BatchReadingResult | null>(null)
  const [choices, setChoices] = useState<Record<string, Choice>>({})
  const [busy, setBusy] = useState(false)
  const [cancelled, setCancelled] = useState(false)
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  const [remember, setRemember] = useState(false)
  const controller = useRef<AbortController | null>(null)

  useEffect(() => {
    let active = true
    let generation = 0
    const refresh = () => {
      const id = ++generation
      controller.current?.abort()
      setMemory(null); setChoices({})
      void loadReadingMemory().then(value => {
        if (active && id === generation) { setMemory(value); setMemoryError('') }
      }).catch(cause => {
        if (active && id === generation) { setMemory(createReadingMemory()); setMemoryError(String(cause)) }
      })
    }
    refresh()
    const unsubscribe = subscribeReadingMemory(refresh)
    return () => { active = false; unsubscribe() }
  }, [])
  const effective = useMemo(() => memory ? {
    ...target, snapshotKey: JSON.stringify([target.snapshotKey, memory.records.map(record => [record.id, record.reading, record.acceptedAt])]),
  } : null, [target, memory])

  useEffect(() => {
    if (!effective || !memory || stale) { setBusy(false); return }
    let active = true
    const current = new AbortController()
    controller.current = current
    setBusy(true); setCancelled(false); setError(''); setResult(null); setChoices({})
    const personal = memory.records.map(record => ({ id: record.id, surface: record.surface, reading: record.reading, source: 'personal' as const,
      context: record.context.before + record.surface + record.context.after }))
    void runBatchReadingSearch(effective, personal, observeReadings, current.signal, progress => {
      if (active && !current.signal.aborted) setResult(progress)
    }).then(next => {
      if (!active || current.signal.aborted) return
      setResult(next)
      setChoices(Object.fromEntries(next.items.map(item => [item.id, { id: usable(item)[0]?.id ?? '', manual: '' }])))
    }).catch(cause => { if (active && !current.signal.aborted) setError(String(cause)) })
      .finally(() => { if (active) setBusy(false) })
    return () => { active = false; current.abort() }
  }, [effective, memory, stale, retry])

  const disabled = busy || !memory || stale || cancelled || !result || result.snapshotKey !== effective?.snapshotKey || ['stale', 'cancelled', 'running'].includes(result.status)
  const selected: BatchReadingChoice[] = []
  const invalidManual = new Set<string>()
  for (const item of result?.items ?? []) {
    const choice = choices[item.id]
    if (!choice?.id) continue
    if (choice.id === 'manual') {
      const count = countMora(choice.manual)
      if (!choice.manual || choice.manual.length > 512 || /[\r\n]/.test(choice.manual) || !count.complete || count.confirmedMora < 1) invalidManual.add(item.id)
      else selected.push({ item, reading: choice.manual, candidate: null })
    } else {
      const candidate = usable(item).find(candidate => candidate.id === choice.id)
      if (candidate) selected.push({ item, reading: candidate.reading, candidate })
    }
  }
  const updateChoice = (item: BatchReadingItem, value: Partial<Choice>) => setChoices(previous => ({ ...previous, [item.id]: { ...(previous[item.id] ?? { id: '', manual: '' }), ...value } }))
  const ambiguity = result?.items.filter(item => usable(item).length > 1).length ?? 0
  return <ToolDialog title="選択範囲の読みを一括設定" onClose={onClose} className="batch-reading-dialog">
    <div className="tool-dialog-content">
      <p className="batch-reading-intro">選択範囲を語に分け、未設定の漢字を含む語の読みを探索します。候補の先頭を仮選択しています。内容を確認して一括適用してください。</p>
      <details className="batch-reading-source"><summary>選択範囲の原文を確認</summary><pre>{target.sourceText}</pre></details>
      <p className="search-caption">既存の読み・音節指定 {target.preservedCount} 件を保持します。タグ、かなだけの語、英語は対象外です。</p>
      <div className="search-options">
        <button disabled={busy || !memory || stale} onClick={() => setRetry(value => value + 1)}><RefreshCw size={15} />もう一度探索</button>
        {busy && <button onClick={() => { controller.current?.abort(); setCancelled(true); setBusy(false) }}>一括探索を中止</button>}
        <button disabled={disabled} onClick={() => setChoices({})}>すべて保留</button>
        <button disabled={disabled} onClick={() => setChoices(Object.fromEntries((result?.items ?? []).map(item => [item.id, { id: usable(item)[0]?.id ?? '', manual: '' }])))}>候補の先頭をまとめて選ぶ</button>
      </div>
      <p className="search-progress" role="status">{stale ? '歌詞が変わったため一括適用できません。' : cancelled ? '一括探索を中止しました。再探索できます。'
        : !memory ? '個人読み辞書を確認しています…' : busy ? `一括探索中… ${result?.completed ?? 0} / ${result?.items.length ?? 0} 語`
        : error ? '一括探索を完了できませんでした。' : result?.status === 'stale' ? '辞書が変わったため再探索が必要です。'
        : result ? `一括探索完了${result.status === 'partial' ? '（一部に未解決）' : ''} · ${result.items.length} 語 · ${selected.length} 語を適用予定` : '探索を準備しています…'}</p>
      {stale && <p className="search-warning" role="alert">探索後に歌詞や入力状態が変わりました。閉じて範囲を選び直してください。</p>}
      {error && <p className="search-error" role="alert">{error}</p>}
      {memoryError && <p className="search-warning">個人辞書を読み込めませんでした。元データを保持して探索しています。{memoryError}</p>}
      {ambiguity > 0 && <p className="search-warning">{ambiguity} 語に複数の読みがあります。仮選択は作者の意図を保証しません。変更、手入力、保留を選べます。</p>}
      {Boolean(result?.issues.length) && <div className="search-warning" role="alert">{result!.issues.map((issue, index) => <p key={index}>{issue}</p>)}</div>}
      <div className="batch-reading-list">{result?.items.map(item => {
        const candidates = usable(item)
        const choice = choices[item.id] ?? { id: '', manual: '' }
        const picked = selected.find(selection => selection.item.id === item.id)
        const count = picked ? countMora(picked.reading).confirmedMora : null
        return <section key={item.id} className={`batch-reading-row${choice.id ? ' is-selected' : ''}`} data-from={item.from}>
          <div className="batch-reading-word"><small>{item.lineIndex + 1}行目</small><strong className="batch-reading-base">{item.base}</strong><span className="search-caption">{candidates.length > 1 ? `${candidates.length}候補` : candidates.length === 1 ? '1候補' : item.result || item.error ? '候補なし' : '探索待ち'}</span></div>
          <div className="batch-reading-controls">
            <select aria-label={`「${item.base}」の読み（${item.lineIndex + 1}行目）`} value={choice.id} disabled={disabled} onChange={event => updateChoice(item, { id: event.target.value })}>
              <option value="">保留（変更しない）</option>
              {candidates.map((candidate, index) => <option key={candidate.id} value={candidate.id}>{candidate.reading} · {candidate.mora} mora{index === 0 ? ' · 探索順1位' : ''}</option>)}
              <option value="manual">手入力</option>
            </select>
            {choice.id === 'manual' && <label className="batch-reading-manual">読みを手入力<input aria-label={`「${item.base}」の手入力（${item.lineIndex + 1}行目）`} value={choice.manual} maxLength={512} disabled={disabled} onChange={event => updateChoice(item, { manual: event.target.value })} />{invalidManual.has(item.id) && <span className="search-error">ひらがな・カタカナで読みを指定してください。</span>}</label>}
            <span className="search-caption">{count === null ? 'この語は保留します' : `${count} mora を設定`}</span>
            {item.error && <p className="search-caption">{item.error}</p>}
            {item.result && <details className="batch-reading-evidence"><summary>文脈・候補の根拠</summary><p>{item.target.context}</p><ul>{candidates.map(candidate => <li key={candidate.id}><strong>{candidate.reading}</strong>：{candidate.reasons.join(' · ')}</li>)}</ul><p>{item.result.trace.length} 回の観測{item.result.provider ? ` / Full ${item.result.provider.dictionaryVersion}` : ''}</p></details>}
          </div>
        </section>
      })}</div>
      {!busy && result && result.items.length === 0 && <p className="search-empty">{result.issues.length ? '今回の探索では対象語の候補を用意できませんでした。範囲を狭めるか、もう一度探索してください。' : '選択範囲に探索対象の語がありません。'}既存の読みと本文をそのまま保持します。</p>}
    </div>
    <footer className="tool-dialog-footer">
      <label className="search-remember"><input type="checkbox" checked={remember} disabled={Boolean(memoryError)} onChange={event => setRemember(event.target.checked)} />一括採用した読みを個人辞書に登録</label>
      <button onClick={onClose}>変更せず閉じる</button>
      <button className="primary" disabled={disabled || !selected.length || invalidManual.size > 0} onClick={() => { if (!disabled && selected.length && !invalidManual.size) onAdopt(selected, remember) }}>選んだ読みを一括適用</button>
    </footer>
  </ToolDialog>
}
