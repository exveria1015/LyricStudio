import { useEffect, useMemo, useRef, useState } from 'react'
import { Search, RefreshCw } from 'lucide-react'
import { createReadingMemory, type ReadingMemoryFile } from '../model/readingMemory'
import { loadReadingMemory, subscribeReadingMemory } from '../storage/readingMemory'
import type { ReadingCandidate, ReadingSearchResult, ReadingSearchStopReason, ReadingSearchTarget } from '../search/types'
import { runReadingSearch } from '../search/engine'
import { observeReadings } from '../search/client'
import { ToolDialog } from './ToolDialog'

const stopLabels: Record<ReadingSearchStopReason, string> = {
  sufficient_observations: '提示に必要な根拠が揃ったため、自動観測を終えました。',
  no_more_actions: '用意された観測方法を実行しました。',
  diminishing_returns: '追加観測で新しい候補や根拠の種類が増えなくなったため、自動観測を止めました。',
  observation_budget: '今回の観測回数の上限に達しました。残った方法は追加で選べます。',
  time_budget: '今回の探索時間の上限に達しました。',
  cancelled: '探索を中止しました。',
  invalid_target: '探索条件を確認してください。',
  provider_unavailable: '辞書解析を利用できないため、自動観測を止めました。',
  provider_changed: '辞書のバージョンが変わったため、結果は採用できません。',
  requested_observation: '選んだ方法による追加観測を終えました。',
}

export function ReadingSearchDialog({ target, stale, onAdopt, onClose, onManual }: {
  target: ReadingSearchTarget
  stale: boolean
  onAdopt: (candidate: ReadingCandidate, remember: boolean) => void
  onClose: () => void
  onManual: () => void
}) {
  const [memory, setMemory] = useState<ReadingMemoryFile | null>(null)
  const [memoryError, setMemoryError] = useState('')
  const [goal, setGoal] = useState('')
  const [result, setResult] = useState<ReadingSearchResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [selectedId, setSelectedId] = useState('')
  const [remember, setRemember] = useState(false)
  const [order, setOrder] = useState<'search' | 'baseline'>('search')
  const controller = useRef<AbortController | null>(null)
  const generation = useRef(0)
  const lastStarted = useRef('')
  const [dismissed, setDismissed] = useState(false)
  useEffect(() => {
    let active = true
    let loadId = 0
    const reload = () => {
      const id = ++loadId
      void loadReadingMemory().then(value => { if (active && id === loadId) { setMemory(value); setMemoryError('') } })
        .catch(cause => { if (active && id === loadId) { setMemory(createReadingMemory()); setMemoryError(String(cause)) } })
    }
    reload()
    const unsubscribe = subscribeReadingMemory(reload)
    return () => { active = false; unsubscribe() }
  }, [])
  const personal = useMemo(() => memory?.records.filter(record => record.surface === target.base) ?? [], [memory, target.base])
  const personalKey = JSON.stringify(personal.map(record => [record.id, record.reading, record.acceptedAt]))
  const effectiveTarget = useMemo<ReadingSearchTarget>(() => ({
    ...target, snapshotKey: JSON.stringify([target.snapshotKey, personalKey]),
    authorReadings: [...target.authorReadings, ...personal.map(record => ({ id: record.id, surface: record.surface, reading: record.reading, source: 'personal' as const,
      context: record.context.before + record.surface + record.context.after }))],
  }), [target, personalKey, personal])
  const targetMora = goal === '' ? null : Number(goal)
  const validGoal = targetMora === null || Number.isSafeInteger(targetMora) && targetMora >= 1 && targetMora <= 512
  const changed = Boolean(result && (result.snapshotKey !== effectiveTarget.snapshotKey || result.targetMora !== targetMora))

  async function search(actionId?: string) {
    if (!memory || !validGoal || stale) return
    controller.current?.abort()
    const requestController = new AbortController()
    controller.current = requestController
    const id = ++generation.current
    setSelectedId(''); setBusy(true); setError(''); setDismissed(false)
    try {
      const next = await runReadingSearch(effectiveTarget, {
        targetMora, maxObservations: 8, maxElapsedMs: 10_000,
        ...(actionId && result && !changed ? { resume: result, requestedActionId: actionId } : {}),
      }, observeReadings, requestController.signal, progress => {
        if (id === generation.current && !requestController.signal.aborted) setResult(progress)
      })
      if (id === generation.current && !requestController.signal.aborted) setResult(next)
    } catch (cause) {
      if (id === generation.current && !requestController.signal.aborted) setError(String(cause))
    } finally { if (id === generation.current) setBusy(false) }
  }
  // Opening the tool starts a bounded search. Source/library changes retire the
  // old run; changing the goal is an explicit re-run through the button below.
  useEffect(() => {
    if (!memory || stale) return
    if (lastStarted.current === effectiveTarget.snapshotKey) return
    lastStarted.current = effectiveTarget.snapshotKey
    void search()
  }, [effectiveTarget.snapshotKey, Boolean(memory), stale])
  useEffect(() => {
    if (stale) { controller.current?.abort(); generation.current++; setBusy(false); setSelectedId('') }
    return () => { controller.current?.abort(); generation.current++ }
  }, [stale])

  const candidates = order === 'search' ? result?.rankedCandidates ?? [] : result?.baselineCandidates ?? []
  const selected = candidates.find(candidate => candidate.id === selectedId)
  const canAdopt = !busy && !stale && !changed && !dismissed && validGoal && selected?.applicable
    && result?.snapshotKey === effectiveTarget.snapshotKey && result.status !== 'stale' && result.status !== 'invalid'
  const failed = result?.trace.filter(item => item.status === 'failed') ?? []
  const resultLabel = result?.status === 'partial' ? '探索を停止・一部の結果' : result?.status === 'unavailable' ? '解析を利用できません'
    : result?.status === 'stale' || result?.status === 'invalid' ? '再探索が必要です' : '探索完了'
  return <ToolDialog title="読み候補の探索" onClose={onClose}>
    <div className="tool-dialog-content">
      <div className="search-target">
        <div className="search-target-word"><span className="search-caption">選択中の表記</span><strong>{target.base}</strong>{target.currentReading && <span className="search-caption">現在の読み：{target.currentReading}</span>}</div>
        <p className="search-target-context">{target.context.slice(0, target.selectionFrom)}<mark>{target.base}</mark>{target.context.slice(target.selectionTo)}</p>
      </div>
      <p className="search-caption">SudachiDict Fullの辞書照会を基準に、文脈・分割粒度・作者の採用記録を追加で調べます。候補の表示だけでは歌詞や確定音数は変わりません。</p>
      <div className="search-options">
        <label>選択表記の目標 <input aria-label="選択表記の目標モーラ" type="number" min={1} max={512} placeholder="任意" value={goal} onChange={event => { setGoal(event.target.value); setSelectedId('') }} /> mora</label>
        <button disabled={stale || !memory || !validGoal} onClick={() => void search()}><RefreshCw size={15} />条件を変えて探索</button>
        {busy && <button onClick={() => { controller.current?.abort(); generation.current++; setBusy(false); setDismissed(true); setSelectedId('') }}>探索を中止</button>}
      </div>
      {!validGoal && <p className="search-error" role="alert">目標は1〜512の整数、または空欄にしてください。</p>}
      {stale && <p className="search-warning" role="alert">探索後に歌詞や入力状態が変わりました。古い範囲へは適用できません。閉じて表記を選び直してください。</p>}
      {result?.status === 'stale' && <p className="search-warning" role="alert">探索中に辞書のバージョンが変わりました。「条件を変えて探索」で調べ直してください。</p>}
      {changed && !stale && <p className="search-warning">条件が変わりました。「条件を変えて探索」で比較し直してください。</p>}
      {memoryError && <p className="search-warning">個人辞書を読み込めませんでした。元データを保持し、他の情報源で探索しています。{memoryError}</p>}
      {error && <p className="search-error" role="alert">{error}</p>}
      {failed.length > 0 && <p className="search-warning" role="alert">{failed[0].error} 利用できた情報源だけの結果です。</p>}
      <p className="search-progress" role="status">{!memory ? '個人読み辞書を確認しています…' : busy
        ? `観測中… ${result?.trace.length ?? 0} 件の情報を比較しています。`
        : dismissed ? '探索を中止しました。採用する場合はもう一度探索してください。'
        : result ? `${resultLabel} · ${result.budget.observations} 回の観測 · ${result.rankedCandidates.length} 候補 · ${Math.round(result.budget.elapsedMs)} ms` : '探索を準備しています…'}</p>
      {result?.provider && <p className="search-caption">SudachiDict Full {result.provider.dictionaryVersion} / SudachiPy {result.provider.engineVersion} · このPCで解析</p>}
      <div className="search-results-heading"><h2><Search size={16} />読みの候補</h2><div className="search-sort">
        <button aria-pressed={order === 'search'} onClick={() => { setOrder('search'); setSelectedId('') }}>探索順</button>
        <button aria-pressed={order === 'baseline'} onClick={() => { setOrder('baseline'); setSelectedId('') }}>辞書順</button>
      </div></div>
      <p className="search-caption">{order === 'baseline' ? '同じ表記を辞書照会したときの元の順序です。文脈や履歴による追加候補は含みません。' : '目標との差と観測根拠を比較した提示順です。正解確率ではありません。'}</p>
      <div className="search-candidates" role="radiogroup" aria-label="読み候補">{candidates.map(candidate => <div className={`search-candidate ${candidate.id === selectedId ? 'is-selected' : ''}`} key={candidate.id}>
        <label className="search-candidate-main">
          <input type="radio" name="reading-candidate" aria-label={candidate.reading} checked={candidate.id === selectedId} disabled={!candidate.applicable || stale || busy || changed || dismissed} onChange={() => setSelectedId(candidate.id)} />
          <span className="search-candidate-copy"><span className="search-candidate-reading">{candidate.reading}</span><span className="search-candidate-reasons">{candidate.reasons.join(' · ')}</span><span className="search-baseline-rank">{candidate.baselineRank === null ? '追加観測で得た候補' : `辞書順 ${candidate.baselineRank}位`}{candidate.rankChange ? ` / ${candidate.rankChange > 0 ? '+' : ''}${candidate.rankChange}順位` : ''}</span></span>
          <span className="search-candidate-count">{candidate.mora ?? '未確定'}<small>mora{candidate.targetDelta !== null ? ` · 目標との差 ${candidate.targetDelta > 0 ? '+' : ''}${candidate.targetDelta}` : ''}</small></span>
        </label>
        <details className="search-evidence"><summary>根拠を確認（{candidate.evidence.length}件）</summary><ul>{candidate.evidence.map(evidence => <li key={evidence.id}>
          {evidence.source === 'personal' ? '個人辞書の採用記録' : evidence.source === 'document' ? 'この歌詞で作者が設定' : evidence.method === 'exact_entry' ? 'Full辞書の見出し' : evidence.method === 'kana_anchor' ? '文脈内のかなを照合した派生候補' : '文脈内の形態素解析'}：{evidence.rawReading}
          {evidence.tokens.length > 0 && <span> ／ {evidence.tokens.map(token => `${token.surface}（${token.reading}）`).join(' + ')}</span>}
          {evidence.entries.length > 0 && <span> ／ {evidence.entries.map(entry => entry.partOfSpeech.filter(part => part !== '*').join('・')).join(' / ')}</span>}
          {evidence.authorContext && <span> ／ 採用したときの文脈：{evidence.authorContext}</span>}
          {evidence.notes.length > 0 && <span> ／ {evidence.notes.join(' ')}</span>}
        </li>)}</ul></details>
      </div>)}</div>
      {!busy && result && candidates.length === 0 && <p className="search-empty">この条件では読み候補を提示できませんでした。表記を広く選び直すか、読みを手動で指定できます。</p>}
      {result && result.unresolved.length > 0 && <div className="search-warning">{result.unresolved.map((message, index) => <p key={index}>{message}</p>)}</div>}
      {result && result.status !== 'stale' && result.status !== 'invalid' && result.nextActions.length > 0 && !busy && !changed && !stale && <div className="search-options"><span className="search-caption">追加で調べる</span>{result.nextActions.slice(0, 3).map(action => <button key={action.id} title={action.reason} onClick={() => void search(action.id)}>{action.label}</button>)}</div>}
      {result && <details className="search-trace"><summary>探索の経過と残った観測（{result.trace.length}件）</summary><p className="search-caption">同じ解析系のA/B/Cを独立した投票として数えません。未観測の可能性を含む、探索的な比較です。</p><ol>{result.trace.map((trace, index) => <li key={`${trace.action.id}-${index}`}><strong>{trace.action.label}</strong> — {trace.action.reason}<br />{trace.status === 'failed' ? trace.error : `新しい候補 ${trace.addedCandidateIds.length}件 / 根拠 ${trace.addedEvidenceIds.length}件 · ${Math.round(trace.elapsedMs)} ms`}{trace.notes.length > 0 && <span> · {trace.notes.join(' ')}</span>}</li>)}</ol>
        {result.stopReason && <p>{stopLabels[result.stopReason]}</p>}
        {result.nextActions.length > 0 && <p>未観測：{result.nextActions.map(action => action.label).join('、')}</p>}
        {result.truncated && <p>取得上限に達した情報源があります。辞書全体を調べ尽くした結果ではありません。</p>}
      </details>}
    </div>
    <footer className="tool-dialog-footer">
      <label className="search-remember"><input type="checkbox" checked={remember} disabled={Boolean(memoryError)} onChange={event => setRemember(event.target.checked)} />採用した読みを個人辞書に登録</label>
      <button onClick={onManual}>手動で入力</button>
      <button onClick={onClose}>{target.currentReading ? '現在の読みを維持' : '保留して閉じる'}</button>
      <button className="primary" disabled={!canAdopt} onClick={() => { if (canAdopt && selected) onAdopt(selected, remember) }}>この読みを採用</button>
    </footer>
  </ToolDialog>
}
