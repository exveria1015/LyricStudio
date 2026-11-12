import { describe, expect, it, vi } from 'vitest'
import {
  buildReadingActions, extractContextEvidence, planNextReadingAction, rankReadingCandidates,
  reduceReadingObservation, runReadingSearch, validateReadingTarget,
} from '../src/search/engine'
import type {
  DictionaryEntry, ReadingCandidate, ReadingProvider, ReadingProviderRequest, ReadingProviderResponse,
  ReadingSearchAction, ReadingSearchTarget, ReadingToken,
} from '../src/search/types'

const providerInfo = {
  id: 'sudachi-full', edition: 'full', version: 'full-fixture-v1', engineVersion: 'fixture', dictionaryVersion: 'fixture-v1',
} as const

function entry(surface: string, reading: string, id = `${surface}:${reading}`): DictionaryEntry {
  return { id, surface, reading, normalizedForm: surface, dictionaryForm: surface, partOfSpeech: ['名詞'], dictionaryId: 0, wordId: 4026533388, isOov: false }
}
function token(surface: string, reading: string, from: number, to = from + surface.length): ReadingToken {
  return { ...entry(surface, reading), from, to }
}
function response(entries: DictionaryEntry[] = [], tokens: ReadingToken[] = [], extra: Partial<ReadingProviderResponse> = {}): ReadingProviderResponse {
  return { provider: { ...providerInfo }, entries, tokens, elapsedMs: 2, truncated: false, notes: [], ...extra }
}
function target(base = '明日', context = `また${base}に会う`): ReadingSearchTarget {
  const selectionFrom = context.indexOf(base)
  return { snapshotKey: 'document-1:selection-1:history-1', base, currentReading: null, context, selectionFrom, selectionTo: selectionFrom + base.length, authorReadings: [], examples: [] }
}
function contextAction(text: string, from: number, to: number): ReadingSearchAction {
  return { id: 'test-context', kind: 'context', label: 'test', reason: 'test', request: { kind: 'context', text, mode: 'C' }, selectionFrom: from, selectionTo: to, scope: 'surrounding' }
}
const tomorrow = [entry('明日', 'アス'), entry('明日', 'アシタ'), entry('明日', 'ミョウニチ')]
function tomorrowProvider(contextReading = 'アス') {
  return vi.fn<ReadingProvider>(async request => request.kind === 'exact'
    ? response(tomorrow)
    : response([], [token('明日', contextReading, request.text.indexOf('明日'))]))
}
function readings(candidates: ReadingCandidate[]) { return candidates.map(candidate => candidate.reading) }

describe('reading search target and evidence integrity', () => {
  it('rejects stale positions, tag contents, multiline and surrogate-split selections before provider calls', async () => {
    const provider = tomorrowProvider()
    for (const input of [
      { ...target(), selectionFrom: 0 }, target('[Verse]', '[Verse]'), target('明\n日', '明\n日'),
      { ...target('😀', '😀'), base: '\ud83d', selectionFrom: 0, selectionTo: 1 },
    ]) {
      expect(validateReadingTarget(input).length).toBeGreaterThan(0)
      const result = await runReadingSearch(input, {}, provider)
      expect(result.status).toBe('invalid')
      expect(result.trace).toEqual([])
    }
    expect(provider).not.toHaveBeenCalled()
  })

  it('keeps UTF-16 coordinates and complete surrogate pairs in bounded context windows', () => {
    const input = target('明日', `${'😀'.repeat(700)}明日${'😀'.repeat(700)}`)
    for (const action of buildReadingActions(input)) {
      if (!action.request) continue
      expect(action.request.text.length).toBeLessThanOrEqual(1024)
      expect(action.request.text.slice(action.selectionFrom, action.selectionTo)).toBe('明日')
      expect(Array.from(action.request.text).every(unit => unit.length === 2 || !/[\uD800-\uDFFF]/u.test(unit))).toBe(true)
    }
    const action = contextAction('😀明日', 2, 4)
    const result = extractContextEvidence(action, response([], [token('😀', 'ニンマリ', 0), token('明日', 'アス', 2)]))
    expect(result.evidence?.rawReading).toBe('あす')
    expect(result.evidence?.from).toBe(2)
  })

  it('accepts a real dictionary emoji entry and does not infer OOV from character class', () => {
    const input = target('😀', '😀')
    const exact = buildReadingActions(input)[0]
    const result = reduceReadingObservation(input, exact, response([entry('😀', 'ニンマリ')]), [])
    expect(readings(result.candidates)).toEqual(['にんまり'])
    expect(result.candidates[0].mora).toBe(4)
    expect(result.candidates[0].evidence[0].entries[0].wordId).toBe(4026533388)
  })

  it('requires literal surface equality for exact evidence and excludes OOV entries', () => {
    const input = target('ＡＢＣ', 'ＡＢＣ')
    const exact = buildReadingActions(input)[0]
    const observed = reduceReadingObservation(input, exact, response([
      entry('abc', 'エービーシー'), { ...entry('ＡＢＣ', 'ＡＢＣ'), isOov: true },
    ], [], { notes: ['lookup_input_normalized'] }), [])
    expect(observed.candidates).toEqual([])
    expect(observed.trace.coverage).toBe('none')
    expect(observed.trace.response?.entries).toHaveLength(2)
    expect(observed.trace.notes).toContain('lookup_input_normalized')
  })

  it('merges only normalized-identical readings while retaining every dictionary entry', () => {
    const input = target()
    const observed = reduceReadingObservation(input, buildReadingActions(input)[0], response([
      entry('明日', 'アス', 'entry-1'), entry('明日', 'あす', 'entry-2'), entry('明日', 'ｱｽ', 'entry-3'), entry('明日', 'アシタ', 'entry-4'),
    ]), [])
    expect(readings(observed.candidates)).toEqual(['あす', 'あした'])
    expect(observed.candidates[0].evidence.map(item => item.sourceId)).toEqual(['entry-1', 'entry-2', 'entry-3'])
    expect(observed.candidates.every(candidate => candidate.status === 'inferred_candidate')).toBe(true)
    expect(observed.trace.addedCandidateIds).toHaveLength(2)
    expect(observed.trace.addedEvidenceIds).toHaveLength(4)
  })

  it('extracts partial-token readings only from exact direct-kana anchors', () => {
    const action = contextAction('届かない', 0, 1)
    const result = extractContextEvidence(action, response([], [token('届か', 'トドカ', 0), token('ない', 'ナイ', 2)]))
    expect(result.evidence?.rawReading).toBe('とど')
    expect(result.evidence?.method).toBe('kana_anchor')
    expect(result.evidence?.anchors).toEqual({ prefix: '', suffix: 'か', removedPrefix: '', removedSuffix: 'か' })
    expect(result.evidence?.tokens[0].reading).toBe('トドカ')
    const both = extractContextEvidence(contextAction('お祝い', 1, 2), response([], [token('お祝い', 'オイワイ', 0)]))
    expect(both.evidence?.rawReading).toBe('いわ')
    expect(both.evidence?.anchors?.prefix).toBe('お')
    expect(both.evidence?.anchors?.suffix).toBe('い')
  })

  it('refuses spelling-position slicing, unmatched anchors, OOV, gaps and false token offsets', () => {
    const cases: [ReadingSearchAction, ReadingToken[]][] = [
      [contextAction('明日', 0, 1), [token('明日', 'アシタ', 0)]],
      [contextAction('届か', 0, 1), [token('届か', 'トドケ', 0)]],
      [contextAction('届か', 0, 1), [{ ...token('届か', 'トドカ', 0), isOov: true }]],
      [contextAction('明日へ', 0, 3), [token('明日', 'アス', 0)]],
      [contextAction('明日へ', 0, 3), [token('明', 'ア', 0), token('へ', 'ヘ', 2)]],
      [contextAction('明日', 0, 2), [token('翌日', 'ヨクジツ', 0)]],
      [contextAction('明日', 0, 2), [token('明日', 'アス', 0), token('日', 'ヒ', 1)]],
    ]
    for (const [action, tokens] of cases) {
      const observed = extractContextEvidence(action, response([], tokens))
      expect(observed.evidence).toBeNull()
      expect(observed.notes.length).toBeGreaterThan(0)
    }
  })

  it('combines fully covered contiguous tokens without slicing their readings', () => {
    const observed = extractContextEvidence(contextAction('また明日へ', 2, 5), response([], [token('明日', 'アス', 2), token('へ', 'ヘ', 4)]))
    expect(observed.evidence?.rawReading).toBe('あすへ')
    expect(observed.evidence?.method).toBe('token_cover')
    expect(observed.evidence?.tokens).toHaveLength(2)
  })

  it('retains author conflicts and provenance, excluding history for a different surface', () => {
    const input = target()
    input.authorReadings = [
      { id: 'doc-1', surface: '明日', reading: 'アス', source: 'document' },
      { id: 'personal-1', surface: '明日', reading: 'あした', source: 'personal', context: 'また明日に会う' },
      { id: 'other', surface: '未来', reading: 'みらい', source: 'personal' },
    ]
    const action = buildReadingActions(input).find(item => item.id === 'author')!
    const observed = reduceReadingObservation(input, action, null, [])
    expect(readings(observed.candidates)).toEqual(['あす', 'あした'])
    const evidence = observed.candidates[1].evidence[0]
    expect(evidence.text.slice(evidence.from, evidence.to)).toBe('明日')
    expect(evidence.authorContext).toBe('また明日に会う')
    expect(evidence.sourceId).toBe('personal-1')
  })
})

describe('bounded adaptive observation and comparison', () => {
  it('starts with exact then C, keeps fixed baseline order and never writes author data', async () => {
    const input = target()
    const before = structuredClone(input)
    const provider = tomorrowProvider('アシタ')
    const result = await runReadingSearch(input, { targetMora: 3 }, provider)
    expect(result.trace.map(item => item.action.id)).toEqual(['exact', 'surrounding-C', 'author'])
    expect(provider.mock.calls.map(([request]) => [request.kind, request.mode])).toEqual([['exact', undefined], ['context', 'C']])
    expect(readings(result.baselineCandidates)).toEqual(['あす', 'あした', 'みょうにち'])
    expect(result.rankedCandidates[0]).toMatchObject({ reading: 'あした', mora: 3, targetDelta: 0, baselineRank: 2, rank: 1, rankChange: 1 })
    expect(result.rankedCandidates).toHaveLength(3)
    expect(result.requiresAuthorConfirmation).toBe(true)
    expect(result.nextActions.length).toBeGreaterThan(0)
    expect(result.unresolved.join('')).toContain('完全性は保証しません')
    expect(input).toEqual(before)
    expect(result.baselineCandidates.every(candidate => candidate.evidence.every(item => item.source === 'dictionary'))).toBe(true)
  })

  it('chooses finer granularity when C cannot cover a partial kanji selection', async () => {
    const input = target('明', '明日')
    const provider = vi.fn<ReadingProvider>(async request => request.kind === 'exact' ? response()
      : request.mode === 'C' ? response([], [token('明日', 'アシタ', 0)])
        : response([], [token('明', 'アカリ', 0), token('日', 'ヒ', 1)]))
    const result = await runReadingSearch(input, {}, provider)
    expect(result.trace.map(item => item.action.id)).toEqual(['exact', 'surrounding-C', 'author', 'surrounding-A'])
    expect(result.trace[1].coverage).toBe('none')
    expect(result.trace[3].coverage).toBe('exact')
    expect(result.rankedCandidates[0].reading).toBe('あかり')
    expect(result.trace[3].action.reason).toContain('完全な読みが得られていない')
  })

  it('uses another document occurrence for ambiguity, but stops earlier when a goal has contextual support', async () => {
    const input = target()
    input.examples = [{ id: 'elsewhere', context: '明日は晴れる', selectionFrom: 0, selectionTo: 2 }]
    const provider = tomorrowProvider()
    const unresolved = await runReadingSearch(input, {}, provider)
    expect(unresolved.trace[3].action.id).toBe('example:elsewhere')
    const goal = await runReadingSearch(input, { targetMora: 2 }, provider)
    expect(goal.trace.map(item => item.action.id)).toEqual(['exact', 'surrounding-C', 'author'])
    expect(readings(goal.rankedCandidates)).toContain('みょうにち')
    expect(goal.rankedCandidates.find(candidate => candidate.reading === 'みょうにち')?.targetDelta).toBe(2)
    expect(goal.requiresAuthorConfirmation).toBe(true)
  })

  it('does not use existing reading or conflicting author history as permission to stop or auto-confirm', async () => {
    const input = target()
    input.currentReading = 'あす'
    input.authorReadings = [{ id: 'author-1', surface: '明日', reading: 'あした', source: 'personal' }]
    input.examples = [{ id: 'elsewhere', context: '明日まで', selectionFrom: 0, selectionTo: 2 }]
    const result = await runReadingSearch(input, { targetMora: 2 }, tomorrowProvider('アス'))
    expect(result.trace.length).toBeGreaterThan(3)
    expect(result.trace[3].action.scope).toBe('example')
    expect(result.rankedCandidates.find(candidate => candidate.reading === 'あした')?.evidence.some(item => item.source === 'personal')).toBe(true)
    expect(result.requiresAuthorConfirmation).toBe(true)
    expect(input.currentReading).toBe('あす')
  })

  it('does not turn A/B/C or duplicate entries into independent votes', () => {
    const input = target()
    const actions = buildReadingActions(input)
    let candidates = reduceReadingObservation(input, actions[0], response(tomorrow), []).candidates
    const first = reduceReadingObservation(input, actions.find(item => item.id === 'surrounding-C')!, response([], [token('明日', 'アス', 2)]), candidates)
    candidates = first.candidates
    expect(first.trace.newEvidenceCategories).toHaveLength(1)
    for (const mode of ['A', 'B']) {
      const next = reduceReadingObservation(input, actions.find(item => item.id === `surrounding-${mode}`)!, response([], [token('明日', 'アス', 2)]), candidates)
      expect(next.trace.addedCandidateIds).toEqual([])
      expect(next.trace.newEvidenceCategories).toEqual([])
      expect(next.trace.newContextReadingIds).toEqual([])
      expect(next.trace.addedEvidenceIds).toHaveLength(1)
      expect(readings(rankReadingCandidates(next.candidates))).toEqual(readings(rankReadingCandidates(candidates)))
      candidates = next.candidates
    }
    expect(candidates.find(candidate => candidate.reading === 'あす')?.evidence).toHaveLength(4)
    expect(rankReadingCandidates(candidates)[0].reasons.join('')).toContain('独立した票とは数えません')
    expect(rankReadingCandidates(candidates)[0]).not.toHaveProperty('confidence')
  })

  it('keeps a change between already-known readings as an informative disagreement, not a vote', () => {
    const input = target()
    const actions = buildReadingActions(input)
    const exact = reduceReadingObservation(input, actions[0], response(tomorrow), [])
    const coarse = reduceReadingObservation(input, actions.find(item => item.id === 'surrounding-C')!, response([], [token('明日', 'アス', 2)]), exact.candidates)
    const author = reduceReadingObservation(input, actions.find(item => item.id === 'author')!, null, coarse.candidates)
    const finer = reduceReadingObservation(input, actions.find(item => item.id === 'surrounding-A')!, response([], [token('明日', 'アシタ', 2)]), author.candidates)
    expect(finer.trace.addedCandidateIds).toEqual([])
    expect(finer.trace.newEvidenceCategories).toEqual([])
    expect(finer.trace.newContextReadingIds).toEqual(['reading:あした'])
    expect(finer.trace.notes.join('')).toContain('以前の観測「あす」と異なる「あした」')
    const middle = reduceReadingObservation(input, actions.find(item => item.id === 'surrounding-B')!, response([], [token('明日', 'アシタ', 2)]), finer.candidates)
    const plan = planNextReadingAction(input, [exact.trace, coarse.trace, author.trace, finer.trace, middle.trace], middle.candidates)
    expect(plan.stopReason).toBeNull()
    expect(plan.next?.id).toBe('selection-C')
  })

  it('retains same-mora alternatives and exposes unresolved semantic ambiguity', async () => {
    const input = target('生', '生')
    const provider: ReadingProvider = async request => request.kind === 'exact'
      ? response([entry('生', 'ナマ'), entry('生', 'セイ')])
      : response([], [token('生', 'ナマ', 0)])
    const result = await runReadingSearch(input, { targetMora: 2 }, provider)
    expect(readings(result.rankedCandidates)).toEqual(['なま', 'せい'])
    expect(result.rankedCandidates.every(candidate => candidate.targetDelta === 0)).toBe(true)
    expect(result.unresolved.join('')).toContain('目標モーラが同じでも')
    expect(result.trace.length).toBeGreaterThan(3)
    expect(result.stopReason).toBe('no_more_actions')
  })

  it('stops automatic expansion after repeated no-gain coverage while showing unobserved windows', async () => {
    const result = await runReadingSearch(target(), {}, async () => response())
    expect(result.trace.map(item => item.action.id)).toEqual(['exact', 'surrounding-C', 'author', 'surrounding-A', 'surrounding-B'])
    expect(result.stopReason).toBe('diminishing_returns')
    expect(result.nextActions.some(action => action.id === 'selection-C')).toBe(true)
  })

  it('makes reranking pure and preserves baseline-only evidence and all candidates', async () => {
    const result = await runReadingSearch(target(), { targetMora: 3 }, tomorrowProvider('アシタ'))
    const saved = structuredClone(result)
    const reordered = rankReadingCandidates(result.rankedCandidates, 4)
    expect(reordered[0]).toMatchObject({ reading: 'みょうにち', targetDelta: 0, rankChange: 2 })
    expect(reordered).toHaveLength(3)
    expect(result).toEqual(saved)
  })

  it('reports bounded attempted observations and leaves remaining actions explicit', async () => {
    const provider = tomorrowProvider()
    const result = await runReadingSearch(target(), { maxObservations: 2 }, provider)
    expect(result.status).toBe('partial')
    expect(result.stopReason).toBe('observation_budget')
    expect(result.budget.observations).toBe(2)
    expect(provider).toHaveBeenCalledTimes(2)
    expect(result.nextActions.some(action => action.kind === 'author')).toBe(true)
    expect(result.trace.every(item => item.elapsedMs >= 0 && item.providerElapsedMs === 2)).toBe(true)
    expect(result.trace[0].addedCandidateIds).toHaveLength(3)
    expect(result.trace[1].addedCandidateIds).toEqual([])
  })

  it('treats provider failure separately from a successful empty lookup, preserving local author evidence', async () => {
    const broken = vi.fn<ReadingProvider>(async () => { throw new Error('service unavailable') })
    const unavailable = await runReadingSearch(target(), {}, broken)
    expect(unavailable.status).toBe('unavailable')
    expect(unavailable.stopReason).toBe('provider_unavailable')
    expect(unavailable.trace.filter(item => item.status === 'failed')).toHaveLength(2)
    expect(unavailable.unresolved.join('')).toContain('失敗を「候補なし」とは扱いません')
    const input = target()
    input.authorReadings = [{ id: 'memory-1', surface: '明日', reading: 'あす', source: 'personal' }]
    const local = await runReadingSearch(input, {}, broken)
    expect(local.status).toBe('partial')
    expect(readings(local.rankedCandidates)).toEqual(['あす'])
    const empty = await runReadingSearch(target(), {}, async () => response())
    expect(empty.status).toBe('ready')
    expect(empty.trace.every(item => item.status === 'observed')).toBe(true)
    expect(empty.rankedCandidates).toEqual([])
  })

  it('reports truncation without silently certifying the visible subset as complete', async () => {
    const provider: ReadingProvider = async request => request.kind === 'exact'
      ? response([tomorrow[0]], [], { truncated: true }) : response([], [token('明日', 'アス', request.text.indexOf('明日'))])
    const result = await runReadingSearch(target(), {}, provider)
    expect(result.status).toBe('partial')
    expect(result.truncated).toBe(true)
    expect(result.unresolved.join('')).toContain('返されていない候補')
    expect(result.baselineCandidates).toHaveLength(1)
  })

  it('does not let progress consumers mutate subsequent evidence', async () => {
    const result = await runReadingSearch(target(), { targetMora: 3 }, tomorrowProvider('アシタ'), undefined, snapshot => {
      snapshot.trace.length = 0
      snapshot.rankedCandidates.forEach(candidate => { candidate.reading = 'corrupt'; candidate.evidence.length = 0 })
    })
    expect(result.trace).toHaveLength(3)
    expect(result.rankedCandidates[0].reading).toBe('あした')
    expect(result.rankedCandidates[0].evidence.length).toBeGreaterThan(0)
  })
})

describe('reading search cancellation, resumption and invalidation', () => {
  it('honors pre-cancellation without calling a provider', async () => {
    const controller = new AbortController()
    controller.abort()
    const provider = tomorrowProvider()
    const result = await runReadingSearch(target(), {}, provider, controller.signal)
    expect(result.status).toBe('cancelled')
    expect(provider).not.toHaveBeenCalled()
  })

  it('cancels an in-flight provider and records the attempted cost', async () => {
    const controller = new AbortController()
    let providerSignal: AbortSignal | undefined
    const provider = vi.fn<ReadingProvider>((_request, signal) => {
      providerSignal = signal
      queueMicrotask(() => controller.abort())
      return new Promise<ReadingProviderResponse>(() => {})
    })
    const result = await runReadingSearch(target(), {}, provider, controller.signal)
    expect(result.status).toBe('cancelled')
    expect(providerSignal?.aborted).toBe(true)
    expect(result.budget.observations).toBe(1)
    expect(result.trace[0].status).toBe('failed')
    expect(result.rankedCandidates).toEqual([])
  })

  it('bounds an unresponsive provider by wall time and propagates its abort signal', async () => {
    let providerSignal: AbortSignal | undefined
    const provider: ReadingProvider = (_request, signal) => {
      providerSignal = signal
      return new Promise<ReadingProviderResponse>(() => {})
    }
    const result = await runReadingSearch(target(), { maxElapsedMs: 15 }, provider)
    expect(result.status).toBe('partial')
    expect(result.stopReason).toBe('time_budget')
    expect(providerSignal?.aborted).toBe(true)
    expect(result.trace).toHaveLength(1)
    expect(result.trace[0].error).toContain('時間上限')
  })

  it('resumes a chosen unobserved action once after a spent budget without replaying the baseline', async () => {
    const input = target()
    const provider = tomorrowProvider()
    const initial = await runReadingSearch(input, { maxObservations: 2 }, provider)
    const saved = structuredClone(initial)
    const resumed = await runReadingSearch(input, { resume: initial, requestedActionId: 'surrounding-A', maxObservations: 8 }, provider)
    expect(resumed.trace.map(item => item.action.id)).toEqual(['exact', 'surrounding-C', 'surrounding-A'])
    expect(resumed.stopReason).toBe('requested_observation')
    expect(resumed.budget.maxObservations).toBe(3)
    expect(provider.mock.calls.map(([request]) => request.mode ?? request.kind)).toEqual(['exact', 'C', 'A'])
    expect(resumed.baselineCandidates).toEqual(initial.baselineCandidates)
    expect(initial).toEqual(saved)
    expect(resumed.budget.elapsedMs).toBeGreaterThanOrEqual(initial.budget.elapsedMs)
    const repeated = await runReadingSearch(input, { resume: resumed, requestedActionId: 'surrounding-A' }, provider)
    expect(repeated.trace).toHaveLength(3)
    expect(provider).toHaveBeenCalledTimes(3)
  })

  it('starts a fresh time allowance for explicit additional observation', async () => {
    const provider = tomorrowProvider('アシタ')
    const initial = await runReadingSearch(target(), { targetMora: 3 }, provider)
    initial.budget.elapsedMs = 30_000
    const resumed = await runReadingSearch(target(), { resume: initial, requestedActionId: 'surrounding-A', maxElapsedMs: 1000 }, provider)
    expect(resumed.trace).toHaveLength(initial.trace.length + 1)
    expect(resumed.budget.maxElapsedMs).toBe(31_000)
    expect(resumed.stopReason).toBe('requested_observation')
  })

  it('refuses reuse after caller snapshot changes and makes no provider call', async () => {
    const provider = tomorrowProvider()
    const initial = await runReadingSearch(target(), { maxObservations: 2 }, provider)
    provider.mockClear()
    const changed = await runReadingSearch({ ...target(), snapshotKey: 'new-document-state' }, { resume: initial }, provider)
    expect(changed.status).toBe('invalid')
    expect(changed.rankedCandidates).toEqual([])
    expect(changed.unresolved.join('')).toContain('状態が変わりました')
    expect(provider).not.toHaveBeenCalled()
  })

  it('stops when dictionary version changes instead of mixing newly observed readings', async () => {
    const provider: ReadingProvider = async request => request.kind === 'exact' ? response(tomorrow)
      : response([], [token('明日', 'ミライ', request.text.indexOf('明日'))], { provider: { ...providerInfo, version: 'new-version' } })
    const result = await runReadingSearch(target(), {}, provider)
    expect(result.status).toBe('stale')
    expect(result.stopReason).toBe('provider_changed')
    expect(readings(result.rankedCandidates)).not.toContain('みらい')
    expect(result.provider?.version).toBe(providerInfo.version)
    expect(result.trace[1].status).toBe('failed')
    expect(result.trace[1].response?.provider.version).toBe('new-version')
    expect(result.unresolved.join('')).toContain('辞書のバージョンが変わりました')
    const restartedProvider = vi.fn<ReadingProvider>(async () => response())
    const invalidReuse = await runReadingSearch(target(), { resume: result, requestedActionId: 'author' }, restartedProvider)
    expect(invalidReuse.status).toBe('invalid')
    expect(invalidReuse.unresolved.join('')).toContain('失効した探索の根拠は再利用できません')
    expect(restartedProvider).not.toHaveBeenCalled()
  })

  it('respects the automatic hard cap even with many distinct document examples', async () => {
    const input = target()
    input.examples = Array.from({ length: 20 }, (_, index) => ({ id: `${index}`, context: `${index}回目の明日`, selectionFrom: `${index}回目の`.length, selectionTo: `${index}回目の`.length + 2 }))
    const provider = tomorrowProvider()
    const result = await runReadingSearch(input, { maxObservations: 999 }, provider)
    expect(result.trace).toHaveLength(8)
    expect(result.stopReason).toBe('observation_budget')
    expect(result.nextActions.length).toBeGreaterThan(0)
    const actionId = result.nextActions.find(action => action.scope === 'example')!.id
    const extended = await runReadingSearch(input, { maxObservations: 8, resume: result, requestedActionId: actionId }, provider)
    expect(extended.trace).toHaveLength(9)
    expect(extended.budget.maxObservations).toBe(9)
    expect(extended.stopReason).toBe('requested_observation')
  })

  it('exposes a deterministic first action with pure planning and rejects invalid goals', async () => {
    expect(planNextReadingAction(target(), [], []).next?.id).toBe('exact')
    const calls: ReadingProviderRequest[] = []
    const provider: ReadingProvider = async request => { calls.push(request); return response() }
    for (const targetMora of [0, -1, 1.5, 513, Number.NaN]) {
      expect((await runReadingSearch(target(), { targetMora }, provider)).status).toBe('invalid')
    }
    expect(calls).toEqual([])
  })
})
