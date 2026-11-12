import { countMora, normalizeKana } from '../analysis/mora'
import { parseTagLine } from '../analysis/tags'
import type {
  DictionaryEntry, ReadingCandidate, ReadingEvidence, ReadingProvider, ReadingProviderResponse,
  ReadingSearchAction, ReadingSearchOptions, ReadingSearchPlan, ReadingSearchResult,
  ReadingSearchStopReason, ReadingSearchTarget, ReadingSearchTrace, ReadingToken,
} from './types'

const MAX_PROVIDER_TEXT = 1024
const MAX_OBSERVATIONS = 8
const DEFAULT_TIME_BUDGET = 5000
const READING_LIMIT = 512

function bounds(options: ReadingSearchOptions) {
  return {
    maxObservations: options.maxObservations === undefined || !Number.isFinite(options.maxObservations)
      ? MAX_OBSERVATIONS : Math.max(0, Math.min(MAX_OBSERVATIONS, Math.floor(options.maxObservations))),
    maxElapsedMs: options.maxElapsedMs === undefined || !Number.isFinite(options.maxElapsedMs)
      ? DEFAULT_TIME_BUDGET : Math.max(0, Math.min(60_000, options.maxElapsedMs)),
  }
}

function readingFacts(reading: string) {
  const result = countMora(reading)
  const applicable = Boolean(reading.trim()) && reading.length <= READING_LIMIT && !/[\r\n]/u.test(reading)
    && result.complete && result.confirmedMora > 0
  return { mora: applicable ? result.confirmedMora : null, applicable }
}

function splitsSurrogate(text: string, position: number) {
  return position > 0 && position < text.length
    && /[\uD800-\uDBFF]/u.test(text[position - 1]) && /[\uDC00-\uDFFF]/u.test(text[position])
}

export function validateReadingTarget(target: ReadingSearchTarget): string[] {
  const problems: string[] = []
  if (!target.snapshotKey) problems.push('入力の改訂を識別できません。')
  if (!target.base || target.base.length > MAX_PROVIDER_TEXT || /[\r\n]/u.test(target.base)) problems.push('選択する表記は改行を含まない1〜1024文字にしてください。')
  if (!Number.isSafeInteger(target.selectionFrom) || !Number.isSafeInteger(target.selectionTo)
    || target.selectionFrom < 0 || target.selectionTo <= target.selectionFrom || target.selectionTo > target.context.length
    || target.context.slice(target.selectionFrom, target.selectionTo) !== target.base
    || splitsSurrogate(target.context, target.selectionFrom) || splitsSurrogate(target.context, target.selectionTo)) problems.push('選択範囲と原文が一致しません。選び直してください。')
  const tags = parseTagLine(target.context)
  if (tags.excluded.some(range => range.from < target.selectionTo && range.to > target.selectionFrom)) problems.push('メタタグの範囲は読み探索の対象にできません。')
  return problems
}

/** Preserve whole surrogate pairs while limiting provider windows in UTF-16. */
function windowAround(context: string, from: number, to: number, padding: number) {
  let start = Math.max(0, from - padding)
  let end = Math.min(context.length, to + padding)
  if (end - start > MAX_PROVIDER_TEXT) {
    const left = Math.min(from - start, Math.floor((MAX_PROVIDER_TEXT - (to - from)) / 2))
    start = from - left
    end = Math.min(context.length, start + MAX_PROVIDER_TEXT)
  }
  if (start > 0 && /[\uDC00-\uDFFF]/u.test(context[start]) && /[\uD800-\uDBFF]/u.test(context[start - 1])) start++
  if (end < context.length && /[\uD800-\uDBFF]/u.test(context[end - 1]) && /[\uDC00-\uDFFF]/u.test(context[end])) end--
  return { text: context.slice(start, end), from: from - start, to: to - start }
}

/** The complete finite action pool is reported even when the planner stops early. */
export function buildReadingActions(target: ReadingSearchTarget): ReadingSearchAction[] {
  if (validateReadingTarget(target).length) return []
  const surrounding = windowAround(target.context, target.selectionFrom, target.selectionTo, MAX_PROVIDER_TEXT)
  const actions: ReadingSearchAction[] = [{
    id: 'exact', kind: 'exact', label: '同じ表記の辞書見出しを照会', reason: '辞書の元の候補順を比較基準として記録します。',
    request: { kind: 'exact', text: target.base }, selectionFrom: 0, selectionTo: target.base.length, scope: 'exact',
  }]
  for (const mode of ['C', 'A', 'B'] as const) actions.push({
    id: `surrounding-${mode}`, kind: 'context', label: `周囲の文脈を粒度${mode}で解析`,
    reason: mode === 'C' ? '文脈を含む長い単位で、選択範囲の読みと被覆を観測します。' : '分割粒度を変え、選択範囲を覆えるか、別の読みが現れるか調べます。',
    request: { kind: 'context', text: surrounding.text, mode }, selectionFrom: surrounding.from, selectionTo: surrounding.to, scope: 'surrounding',
  })
  actions.push({ id: 'author', kind: 'author', label: '文書と個人辞書の作者指定を照合', reason: '一般辞書と作者が選んだ読みの一致・衝突を調べます。', selectionFrom: 0, selectionTo: target.base.length, scope: 'author' })
  const seen = new Set(actions.filter(action => action.request).map(action => JSON.stringify([action.request, action.selectionFrom, action.selectionTo])))
  const addContext = (action: ReadingSearchAction) => {
    const key = JSON.stringify([action.request, action.selectionFrom, action.selectionTo])
    if (!seen.has(key)) { actions.push(action); seen.add(key) }
  }
  const nearby = windowAround(target.context, target.selectionFrom, target.selectionTo, 12)
  addContext({
    id: 'nearby-C', kind: 'context', label: '近い文脈だけで再観測', reason: '文脈窓を短くした時に読みが変わるかを比較します。',
    request: { kind: 'context', text: nearby.text, mode: 'C' }, selectionFrom: nearby.from, selectionTo: nearby.to, scope: 'nearby',
  })
  addContext({
    id: 'selection-C', kind: 'context', label: '選択した表記だけを解析', reason: '周囲の語を外し、文脈に依存した読みの違いを調べます。',
    request: { kind: 'context', text: target.base, mode: 'C' }, selectionFrom: 0, selectionTo: target.base.length, scope: 'selection',
  })
  for (const example of target.examples) {
    if (!Number.isSafeInteger(example.selectionFrom) || !Number.isSafeInteger(example.selectionTo)
      || example.selectionFrom < 0 || example.selectionTo > example.context.length
      || splitsSurrogate(example.context, example.selectionFrom) || splitsSurrogate(example.context, example.selectionTo)
      || example.context.slice(example.selectionFrom, example.selectionTo) !== target.base) continue
    const window = windowAround(example.context, example.selectionFrom, example.selectionTo, MAX_PROVIDER_TEXT)
    addContext({
      id: `example:${example.id}`, kind: 'context', label: '文書内の別の用例を解析', reason: '同じ表記が別の文脈でどう読まれるかを観測します。',
      request: { kind: 'context', text: window.text, mode: 'C' }, selectionFrom: window.from, selectionTo: window.to, scope: 'example', exampleId: example.id,
    })
  }
  return actions
}

function evidenceCategory(evidence: ReadingEvidence) {
  // A/B/C on the same text are one correlated observation category, not votes.
  if (evidence.source === 'context') return `context:${JSON.stringify([evidence.text, evidence.from, evidence.to])}`
  return evidence.source
}

function evidenceId(evidence: Omit<ReadingEvidence, 'id'>) {
  return JSON.stringify([evidence.actionId, evidence.source, evidence.sourceId, evidence.rawReading, evidence.from, evidence.to])
}

function completeEvidence(evidence: Omit<ReadingEvidence, 'id'>): ReadingEvidence {
  return { ...evidence, id: evidenceId(evidence) }
}

function validToken(token: ReadingToken, text: string) {
  return Number.isSafeInteger(token.from) && Number.isSafeInteger(token.to) && token.from >= 0
    && token.to > token.from && token.to <= text.length && text.slice(token.from, token.to) === token.surface
}

function directKana(value: string) {
  return value.length === 0 || /^[\u3041-\u3096ー]+$/u.test(normalizeKana(value))
}

/** Derive partial readings only by matching literal kana outside the selection. */
export function extractContextEvidence(action: ReadingSearchAction, response: ReadingProviderResponse): { evidence: ReadingEvidence | null; notes: string[] } {
  const text = action.request?.text ?? ''
  const from = action.selectionFrom
  const to = action.selectionTo
  const notes: string[] = []
  const tokens = response.tokens.filter(token => token.from < to && token.to > from).sort((a, b) => a.from - b.from)
  if (!tokens.length) return { evidence: null, notes: ['選択範囲を覆う形態素がありません。'] }
  let cursor = from
  let reading = ''
  let derived = false
  const anchors = { prefix: '', suffix: '', removedPrefix: '', removedSuffix: '' }
  for (const token of tokens) {
    if (!validToken(token, text) || Math.max(from, token.from) !== cursor) return { evidence: null, notes: ['形態素の位置・表記・連続被覆を確認できません。'] }
    if (token.isOov) return { evidence: null, notes: ['辞書外形態素の読みを、辞書一致の根拠として採用しません。'] }
    const prefix = text.slice(token.from, Math.max(from, token.from))
    const suffix = text.slice(Math.min(to, token.to), token.to)
    const normalized = normalizeKana(token.reading)
    const normalizedPrefix = normalizeKana(prefix)
    const normalizedSuffix = normalizeKana(suffix)
    if (!directKana(prefix) || !directKana(suffix)) return { evidence: null, notes: ['選択外に漢字などが含まれ、形態素の読みを分割できません。粒度を変えて確認してください。'] }
    if (!normalized.startsWith(normalizedPrefix) || !normalized.endsWith(normalizedSuffix)
      || normalizedPrefix.length + normalizedSuffix.length >= normalized.length) return { evidence: null, notes: ['選択外のかなと読みが一致しないため、部分的な読みを推定しません。'] }
    const piece = normalized.slice(normalizedPrefix.length, normalized.length - normalizedSuffix.length)
    if ((prefix || suffix) && !readingFacts(piece).applicable) return { evidence: null, notes: ['かなを除いた残りの読みをモーラ規則で確認できません。'] }
    reading += piece
    cursor = Math.min(to, token.to)
    if (prefix || suffix) {
      derived = true
      anchors.prefix += prefix
      anchors.suffix += suffix
      anchors.removedPrefix += normalizedPrefix
      anchors.removedSuffix += normalizedSuffix
    }
  }
  if (cursor !== to) return { evidence: null, notes: ['選択範囲の末尾まで形態素が連続していません。'] }
  if (derived) notes.push('選択外の直接かなを読みの前後と照合して除いた派生候補です。辞書の完全一致ではありません。')
  return {
    evidence: completeEvidence({
      actionId: action.id, source: 'context', method: derived ? 'kana_anchor' : 'token_cover', rawReading: reading,
      sourceId: tokens.map(token => token.id).join('|'), provider: structuredClone(response.provider), text, from, to,
      entries: [], tokens: structuredClone(tokens), ...(derived ? { anchors } : {}), notes,
    }), notes,
  }
}

function mergeEvidence(candidates: ReadingCandidate[], observations: ReadingEvidence[]) {
  const map = new Map(candidates.map(candidate => [candidate.id, structuredClone(candidate)]))
  for (const evidence of observations) {
    const reading = normalizeKana(evidence.rawReading)
    const id = `reading:${reading}`
    let candidate = map.get(id)
    if (!candidate) {
      candidate = { id, reading, status: 'inferred_candidate', ...readingFacts(reading), evidence: [], reasons: [], targetDelta: null, rank: 0, baselineRank: null, rankChange: null }
      map.set(id, candidate)
    }
    if (!candidate.evidence.some(item => item.id === evidence.id)) candidate.evidence.push(structuredClone(evidence))
  }
  return [...map.values()]
}

function candidateReasons(candidate: ReadingCandidate, targetMora: number | null) {
  const reasons: string[] = []
  const sources = new Set(candidate.evidence.map(evidence => evidence.source))
  if (sources.has('document')) reasons.push('この文書で作者が指定した読み')
  if (sources.has('personal')) reasons.push('個人辞書に作者が登録した読み')
  if (sources.has('dictionary')) reasons.push('SudachiDict Fullの同表記見出し')
  if (sources.has('context')) reasons.push('Sudachiの文脈解析で観測（粒度違いを独立した票とは数えません）')
  if (candidate.evidence.some(evidence => evidence.method === 'kana_anchor')) reasons.push('選択外のかな照合による派生を含む')
  if (!candidate.applicable) reasons.push('読みの文字・長さを確認できないため適用不可')
  if (targetMora !== null && candidate.mora !== null) reasons.push(candidate.mora === targetMora ? '選択表記の目標モーラと一致（正解の保証ではありません）' : `選択表記の目標から${candidate.mora - targetMora > 0 ? '+' : ''}${candidate.mora - targetMora} mora`)
  return reasons
}

/** A transparent preference order. Evidence counts are never confidence scores. */
export function rankReadingCandidates(candidates: ReadingCandidate[], targetMora: number | null = null): ReadingCandidate[] {
  const goal = Number.isSafeInteger(targetMora) && (targetMora ?? 0) > 0 ? targetMora : null
  const has = (candidate: ReadingCandidate, source: ReadingEvidence['source']) => Number(candidate.evidence.some(evidence => evidence.source === source))
  const distance = (candidate: ReadingCandidate) => goal === null ? 0 : candidate.mora === null ? Infinity : Math.abs(candidate.mora - goal)
  const ordered = candidates.map(candidate => ({ ...structuredClone(candidate), targetDelta: goal !== null && candidate.mora !== null ? candidate.mora - goal : null }))
  ordered.sort((a, b) => Number(b.applicable) - Number(a.applicable)
    || distance(a) - distance(b)
    || has(b, 'document') - has(a, 'document')
    || has(b, 'personal') - has(a, 'personal')
    || has(b, 'context') - has(a, 'context')
    || has(b, 'dictionary') - has(a, 'dictionary')
    || (a.baselineRank ?? Infinity) - (b.baselineRank ?? Infinity)
    || (a.reading < b.reading ? -1 : a.reading > b.reading ? 1 : 0))
  return ordered.map((candidate, index) => ({
    ...candidate, rank: index + 1, rankChange: candidate.baselineRank === null ? null : candidate.baselineRank - index - 1,
    reasons: candidateReasons(candidate, goal),
  }))
}

export function reduceReadingObservation(target: ReadingSearchTarget, action: ReadingSearchAction, response: ReadingProviderResponse | null, candidates: ReadingCandidate[], elapsedMs = 0) {
  const observations: ReadingEvidence[] = []
  const notes = [...(response?.notes ?? [])]
  let coverage: ReadingSearchTrace['coverage'] = 'none'
  if (action.kind === 'author') {
    for (const item of target.authorReadings) {
      if (item.surface !== target.base) continue
      observations.push(completeEvidence({
        actionId: action.id, source: item.source, method: 'author_reading', rawReading: item.reading, sourceId: item.id,
        text: item.surface, from: 0, to: item.surface.length, entries: [], tokens: [],
        ...(item.context ? { authorContext: item.context } : {}),
        notes: ['過去の作者指定です。この箇所の意図が同じとは限りません。'],
      }))
    }
    coverage = observations.length ? 'author' : 'none'
    if (!observations.length) notes.push('同じ表記の作者指定は観測されませんでした。')
  } else if (action.kind === 'exact' && response) {
    for (const entry of response.entries) {
      if (entry.isOov || entry.surface !== target.base) { notes.push(`完全一致の対象外: ${entry.id}`); continue }
      observations.push(completeEvidence({
        actionId: action.id, source: 'dictionary', method: 'exact_entry', rawReading: entry.reading, sourceId: entry.id,
        provider: structuredClone(response.provider), text: target.base, from: 0, to: target.base.length,
        entries: [structuredClone(entry)], tokens: [], notes: [],
      }))
    }
    coverage = observations.length ? 'exact' : 'none'
  } else if (response) {
    const extracted = extractContextEvidence(action, response)
    notes.push(...extracted.notes)
    if (extracted.evidence) { observations.push(extracted.evidence); coverage = extracted.evidence.method === 'kana_anchor' ? 'derived' : 'exact' }
  }
  const previousIds = new Set(candidates.map(candidate => candidate.id))
  const previousEvidence = new Set(candidates.flatMap(candidate => candidate.evidence.map(item => item.id)))
  const previousCategories = new Set(candidates.flatMap(candidate => candidate.evidence.map(evidenceCategory)))
  const newContextReadingIds: string[] = []
  for (const observation of observations.filter(item => item.source === 'context')) {
    const reading = normalizeKana(observation.rawReading)
    const category = evidenceCategory(observation)
    const earlier = candidates.filter(candidate => candidate.evidence.some(item => item.source === 'context' && evidenceCategory(item) === category))
    if (!earlier.some(candidate => candidate.reading === reading)) {
      newContextReadingIds.push(`reading:${reading}`)
      if (earlier.length) notes.push(`同じ文脈で、以前の観測「${earlier.map(candidate => candidate.reading).join('・')}」と異なる「${reading}」が現れました。粒度差による不一致として保持します。`)
    }
  }
  const next = mergeEvidence(candidates, observations)
  const trace: ReadingSearchTrace = {
    action: structuredClone(action), status: 'observed', elapsedMs, providerElapsedMs: response?.elapsedMs ?? null,
    ...(response ? { response: structuredClone(response) } : {}),
    addedCandidateIds: next.filter(candidate => !previousIds.has(candidate.id)).map(candidate => candidate.id),
    addedEvidenceIds: observations.filter(item => !previousEvidence.has(item.id)).map(item => item.id),
    newEvidenceCategories: [...new Set(observations.map(evidenceCategory))].filter(category => !previousCategories.has(category)),
    newContextReadingIds,
    coverage, notes,
  }
  return { candidates: next, trace }
}

export function planNextReadingAction(target: ReadingSearchTarget, trace: ReadingSearchTrace[], candidates: ReadingCandidate[], options: ReadingSearchOptions = {}): ReadingSearchPlan {
  const actions = buildReadingActions(target)
  const observed = new Set(trace.map(item => item.action.id))
  const remaining = actions.filter(action => !observed.has(action.id))
  const stop = (stopReason: ReadingSearchStopReason): ReadingSearchPlan => ({ next: null, remaining, stopReason })
  const choose = (id: string, reason?: string): ReadingSearchPlan | null => {
    const next = remaining.find(action => action.id === id)
    return next ? { next: { ...next, ...(reason ? { reason } : {}) }, remaining, stopReason: null } : null
  }
  if (validateReadingTarget(target).length) return stop('invalid_target')
  const resumedCount = options.resume?.trace.length ?? 0
  const explicitAddition = Boolean(options.resume && options.requestedActionId)
  if (explicitAddition && trace.length > resumedCount) return stop('requested_observation')
  if (trace.length - resumedCount >= bounds(options).maxObservations) return stop('observation_budget')
  if (explicitAddition) return choose(options.requestedActionId!, '作者が選んだ未観測の方法で追加照会します。') ?? stop('requested_observation')
  // Initial observations are fixed to provide a reproducible dictionary baseline.
  for (const initial of ['exact', 'surrounding-C']) { const first = choose(initial); if (first) return first }
  if (options.requestedActionId) {
    const requested = choose(options.requestedActionId, '作者が選んだ未観測の方法で追加照会します。')
    if (requested) return requested
    if (explicitAddition) return stop('requested_observation')
  }
  const author = choose('author')
  if (author) return author
  if (!remaining.length) return stop('no_more_actions')
  const providerAttempts = trace.filter(item => item.action.kind !== 'author')
  if (providerAttempts.length >= 2 && providerAttempts.every(item => item.status === 'failed')) return stop('provider_unavailable')
  const viable = candidates.filter(candidate => candidate.applicable)
  const contextual = trace.filter(item => item.action.kind === 'context' && item.status === 'observed')
  const exactCoverage = contextual.some(item => item.coverage === 'exact')
  const authors = viable.filter(candidate => candidate.evidence.some(item => item.source === 'document' || item.source === 'personal'))
  const contextualReadings = viable.filter(candidate => candidate.evidence.some(item => item.source === 'context'))
  const authorConflict = authors.length > 0 && new Set([...authors, ...contextualReadings].map(candidate => candidate.reading)).size > 1
  if (viable.length === 1 && exactCoverage && !authorConflict) return stop('sufficient_observations')
  const matches = options.targetMora == null ? [] : viable.filter(candidate => candidate.mora === options.targetMora)
  if (matches.length === 1 && exactCoverage && !authorConflict
    && matches[0].evidence.some(item => item.source === 'context')) return stop('sufficient_observations')
  const additional = contextual.filter(item => item.action.id !== 'surrounding-C')
  if (additional.length >= 2 && additional.slice(-2).every(item => !item.addedCandidateIds.length && !item.newEvidenceCategories.length && !item.newContextReadingIds.length)
    && additional.at(-1)?.coverage === additional.at(-2)?.coverage) return stop('diminishing_returns')
  if (!viable.length || !exactCoverage) {
    for (const mode of ['A', 'B']) { const finer = choose(`surrounding-${mode}`, '現在の観測では選択範囲の完全な読みが得られていないため、分割粒度を変えます。'); if (finer) return finer }
  }
  const example = remaining.find(action => action.scope === 'example')
  if (example && (viable.length > 1 || authorConflict)) return { next: { ...example, reason: '異なる読みが残るため、同じ表記の別の用例を観測します。' }, remaining, stopReason: null }
  for (const id of ['nearby-C', 'selection-C', 'surrounding-B', 'surrounding-A']) {
    const next = choose(id, id.startsWith('surrounding') ? '別の分割粒度で候補増加・被覆の変化を調べます。同じ読みを独立した票には数えません。' : '未解決の読みの差が文脈窓に依存するか、条件を変えて観測します。')
    if (next) return next
  }
  return example ? { next: example, remaining, stopReason: null } : stop('no_more_actions')
}

function baselineFrom(trace: ReadingSearchTrace[], target: ReadingSearchTarget) {
  const exact = trace.find(item => item.action.id === 'exact' && item.response && item.status === 'observed')
  if (!exact?.response) return []
  return reduceReadingObservation(target, exact.action, exact.response, []).candidates.map((candidate, index) => ({
    ...candidate, rank: index + 1, baselineRank: index + 1, rankChange: 0, reasons: candidateReasons(candidate, null),
  }))
}

function unresolvedReasons(candidates: ReadingCandidate[], trace: ReadingSearchTrace[], remaining: ReadingSearchAction[], targetMora: number | null) {
  const reasons: string[] = []
  const applicable = candidates.filter(candidate => candidate.applicable)
  if (!applicable.length) reasons.push('適用できる読みをまだ観測していません。手動入力または保留を選べます。')
  if (applicable.length > 1) reasons.push(`${applicable.length}種類の読みが残っています。順位は作者の意図を確定しません。`)
  if (targetMora !== null) {
    const matches = applicable.filter(candidate => candidate.mora === targetMora)
    if (!matches.length) reasons.push('選択表記の目標モーラに一致する候補はまだ観測されていません。')
    if (matches.length > 1) reasons.push('目標モーラが同じでも、読みの違いは解消していません。')
  }
  const authorReadings = applicable.filter(candidate => candidate.evidence.some(item => item.source === 'document' || item.source === 'personal'))
  if (authorReadings.length > 1) reasons.push('作者指定にも異なる読みがあります。過去の指定をこの箇所へ自動適用しません。')
  if (authorReadings.length && applicable.some(candidate => candidate.evidence.some(item => item.source === 'context')
    && !authorReadings.some(author => author.reading === candidate.reading))) reasons.push('文脈解析と過去の作者指定が異なります。この箇所の意図は作者が選択してください。')
  if (trace.some(item => item.coverage === 'derived')) reasons.push('直接かなの照合による派生候補を含みます。辞書の完全一致とは区別してください。')
  if (trace.some(item => item.status === 'failed')) reasons.push('実行できなかった照会があります。失敗を「候補なし」とは扱いません。')
  if (trace.some(item => item.response?.truncated)) reasons.push('取得上限に達した照会があり、返されていない候補が残っています。')
  if (remaining.length) reasons.push(`未観測の方法が${remaining.length}件残っています。候補集合の完全性は保証しません。`)
  reasons.push('候補はすべて推定です。適用には作者の明示選択が必要です。')
  return reasons
}

async function observe(provider: ReadingProvider, action: ReadingSearchAction, remainingMs: number, signal?: AbortSignal) {
  if (!action.request) throw new Error('照会条件がありません。')
  const controller = new AbortController()
  const onAbort = () => controller.abort(new DOMException('探索を中止しました。', 'AbortError'))
  signal?.addEventListener('abort', onAbort, { once: true })
  if (signal?.aborted) onAbort()
  const timer = setTimeout(() => controller.abort(new DOMException('探索の時間上限に達しました。', 'TimeoutError')), Math.max(0, remainingMs))
  let abortHandler: (() => void) | undefined
  try {
    const aborted = new Promise<never>((_, reject) => {
      abortHandler = () => reject(controller.signal.reason)
      controller.signal.addEventListener('abort', abortHandler, { once: true })
      if (controller.signal.aborted) abortHandler()
    })
    return await Promise.race([Promise.resolve().then(() => provider(structuredClone(action.request!), controller.signal)), aborted])
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
    if (abortHandler) controller.signal.removeEventListener('abort', abortHandler)
  }
}

/** Bounded adaptive observation. This function never writes an author annotation. */
export async function runReadingSearch(
  input: ReadingSearchTarget, inputOptions: ReadingSearchOptions, provider: ReadingProvider,
  signal?: AbortSignal, onProgress?: (result: ReadingSearchResult) => void,
): Promise<ReadingSearchResult> {
  const target = structuredClone(input)
  const options = structuredClone(inputOptions)
  const limits = bounds(options)
  const targetMora = options.targetMora ?? null
  const started = performance.now()
  const problems = validateReadingTarget(target)
  if (targetMora !== null && (!Number.isSafeInteger(targetMora) || targetMora < 1 || targetMora > READING_LIMIT)) problems.push('選択表記の目標モーラは1〜512の整数にしてください。')
  const resume = options.resume && options.resume.snapshotKey === target.snapshotKey ? structuredClone(options.resume) : null
  if (options.resume && !resume) problems.push('前の探索から原文または履歴の状態が変わりました。新しく探索してください。')
  if (resume?.status === 'stale' || resume?.status === 'invalid') problems.push('失効した探索の根拠は再利用できません。新しく探索してください。')
  let candidates = resume?.rankedCandidates ?? []
  const trace = resume?.trace ?? []
  let providerInfo = resume?.provider ?? null
  let stopReason: ReadingSearchStopReason | null = problems.length ? 'invalid_target' : null
  const previousElapsed = resume?.budget.elapsedMs ?? 0
  const cumulativeLimits = {
    maxObservations: trace.length + (resume && options.requestedActionId ? Math.min(1, limits.maxObservations) : limits.maxObservations),
    maxElapsedMs: previousElapsed + limits.maxElapsedMs,
  }
  const elapsed = () => previousElapsed + performance.now() - started
  function snapshot(status: ReadingSearchResult['status']): ReadingSearchResult {
    const baseline = baselineFrom(trace, target)
    const ranks = new Map(baseline.map(candidate => [candidate.id, candidate.rank]))
    const ranked = rankReadingCandidates(candidates.map(candidate => ({ ...candidate, baselineRank: ranks.get(candidate.id) ?? null })), targetMora)
    const remaining = buildReadingActions(target).filter(action => !trace.some(item => item.action.id === action.id))
    return {
      snapshotKey: target.snapshotKey, status, stopReason, requiresAuthorConfirmation: true,
      rankedCandidates: ranked, baselineCandidates: baseline, trace: structuredClone(trace), nextActions: remaining,
      unresolved: [...problems, ...(stopReason === 'provider_changed' ? ['探索中に辞書のバージョンが変わりました。以前の根拠と混ぜず、新しく探索してください。'] : []), ...unresolvedReasons(ranked, trace, remaining, targetMora)], provider: providerInfo ? structuredClone(providerInfo) : null,
      targetMora, truncated: trace.some(item => item.response?.truncated), budget: { ...cumulativeLimits, observations: trace.length, elapsedMs: elapsed() },
    }
  }
  if (problems.length) return snapshot('invalid')
  onProgress?.(snapshot('running'))
  while (!stopReason) {
    if (signal?.aborted) { stopReason = 'cancelled'; break }
    if (elapsed() >= cumulativeLimits.maxElapsedMs) { stopReason = 'time_budget'; break }
    const plan = planNextReadingAction(target, trace, candidates, options)
    if (!plan.next) { stopReason = plan.stopReason ?? 'no_more_actions'; break }
    const action = plan.next
    const before = performance.now()
    try {
      const response = action.kind === 'author' ? null : await observe(provider, action, cumulativeLimits.maxElapsedMs - elapsed(), signal)
      if (signal?.aborted) throw new DOMException('探索を中止しました。', 'AbortError')
      if (response) {
        if (response.provider?.id !== 'sudachi-full' || response.provider.edition !== 'full' || !response.provider.version
          || !Array.isArray(response.entries) || !Array.isArray(response.tokens)) throw new Error('SudachiDict Fullの応答形式を確認できません。')
        if (providerInfo && response.provider.version !== providerInfo.version) {
          trace.push({ action: structuredClone(action), status: 'failed', elapsedMs: performance.now() - before, providerElapsedMs: response.elapsedMs,
            response: structuredClone(response), error: '辞書バージョンが変わったため、この応答の候補は採用していません。',
            addedCandidateIds: [], addedEvidenceIds: [], newEvidenceCategories: [], newContextReadingIds: [], coverage: 'none', notes: [] })
          stopReason = 'provider_changed'; break
        }
        providerInfo = structuredClone(response.provider)
      }
      const observed = reduceReadingObservation(target, action, response, candidates, performance.now() - before)
      candidates = observed.candidates
      trace.push(observed.trace)
    } catch (cause) {
      // DOMException need not inherit this realm's Error (e.g. browser/iframe or jsdom).
      const error = cause instanceof Error || cause instanceof DOMException ? cause : null
      const name = error?.name ?? ''
      trace.push({ action: structuredClone(action), status: 'failed', elapsedMs: performance.now() - before, providerElapsedMs: null,
        error: error?.message ?? String(cause), addedCandidateIds: [], addedEvidenceIds: [], newEvidenceCategories: [], newContextReadingIds: [], coverage: 'none', notes: [] })
      if (signal?.aborted || name === 'AbortError') { stopReason = 'cancelled'; break }
      if (name === 'TimeoutError') stopReason = 'time_budget'
    }
    onProgress?.(snapshot('running'))
  }
  const status: ReadingSearchResult['status'] = stopReason === 'cancelled' ? 'cancelled'
    : stopReason === 'provider_changed' ? 'stale'
      : stopReason === 'provider_unavailable' && !candidates.some(candidate => candidate.applicable) ? 'unavailable'
        : ['observation_budget', 'time_budget', 'provider_unavailable'].includes(stopReason ?? '') || trace.some(item => item.status === 'failed' || item.response?.truncated) ? 'partial' : 'ready'
  return snapshot(status)
}

export type { DictionaryEntry }
