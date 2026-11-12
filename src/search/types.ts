/** All positions at this boundary are UTF-16 offsets in the accompanying text. */
export type ReadingSplitMode = 'A' | 'B' | 'C'

export interface ReadingProviderInfo {
  id: 'sudachi-full'
  edition: 'full'
  version: string
  engineVersion: string
  dictionaryVersion: string
}

export interface DictionaryEntry {
  id: string
  surface: string
  reading: string
  normalizedForm: string
  dictionaryForm: string
  partOfSpeech: string[]
  dictionaryId: number
  wordId: number
  isOov: boolean
}

export interface ReadingToken extends DictionaryEntry {
  from: number
  to: number
}

export interface ReadingProviderRequest {
  kind: 'exact' | 'context'
  text: string
  mode?: ReadingSplitMode
}

export interface ReadingProviderResponse {
  provider: ReadingProviderInfo
  entries: DictionaryEntry[]
  tokens: ReadingToken[]
  elapsedMs: number
  truncated: boolean
  notes: string[]
}

export type ReadingProvider = (request: ReadingProviderRequest, signal?: AbortSignal) => Promise<ReadingProviderResponse>

export interface AuthorReading {
  id: string
  surface: string
  reading: string
  source: 'document' | 'personal'
  context?: string
}

export interface ReadingExample {
  id: string
  context: string
  selectionFrom: number
  selectionTo: number
}

export interface ReadingSearchTarget {
  /** Caller includes document/selection/author-history revisions in this key. */
  snapshotKey: string
  base: string
  currentReading: string | null
  context: string
  selectionFrom: number
  selectionTo: number
  authorReadings: AuthorReading[]
  examples: ReadingExample[]
}

export interface ReadingSearchAction {
  id: string
  kind: 'exact' | 'context' | 'author'
  label: string
  reason: string
  request?: ReadingProviderRequest
  selectionFrom: number
  selectionTo: number
  scope: 'exact' | 'surrounding' | 'selection' | 'nearby' | 'example' | 'author'
  exampleId?: string
}

export type ReadingEvidenceMethod = 'exact_entry' | 'token_cover' | 'kana_anchor' | 'author_reading'

export interface ReadingEvidence {
  id: string
  actionId: string
  source: 'dictionary' | 'context' | 'document' | 'personal'
  method: ReadingEvidenceMethod
  rawReading: string
  sourceId: string
  provider?: ReadingProviderInfo
  text: string
  from: number
  to: number
  entries: DictionaryEntry[]
  tokens: ReadingToken[]
  /** Optional author-use context with no implied token offsets. */
  authorContext?: string
  /** Direct kana outside the selection, matched against the token reading. */
  anchors?: { prefix: string; suffix: string; removedPrefix: string; removedSuffix: string }
  notes: string[]
}

export interface ReadingCandidate {
  id: string
  reading: string
  status: 'inferred_candidate'
  mora: number | null
  applicable: boolean
  evidence: ReadingEvidence[]
  reasons: string[]
  targetDelta: number | null
  rank: number
  baselineRank: number | null
  /** Positive means earlier than in the fixed exact-dictionary baseline. */
  rankChange: number | null
}

export interface ReadingSearchTrace {
  action: ReadingSearchAction
  status: 'observed' | 'failed'
  elapsedMs: number
  providerElapsedMs: number | null
  response?: ReadingProviderResponse
  error?: string
  addedCandidateIds: string[]
  addedEvidenceIds: string[]
  newEvidenceCategories: string[]
  /** First support for this reading in this context; A/B/C agreement is not a new item. */
  newContextReadingIds: string[]
  coverage: 'exact' | 'derived' | 'none' | 'author'
  notes: string[]
}

export interface ReadingSearchOptions {
  /** Goal for the selected spelling only, never a line total or syllable count. */
  targetMora?: number | null
  /** Additional automatic observations in this run; default 8, hard cap 8. */
  maxObservations?: number
  /** Additional wall-clock budget for this run; in-flight requests receive cancellation. */
  maxElapsedMs?: number
  /** Reuse evidence only for the exact same caller snapshot. */
  resume?: ReadingSearchResult
  /** With resume, perform exactly this one still-unobserved action. */
  requestedActionId?: string
}

export type ReadingSearchStopReason = 'sufficient_observations' | 'no_more_actions' | 'diminishing_returns'
  | 'observation_budget' | 'time_budget' | 'cancelled' | 'invalid_target' | 'provider_unavailable' | 'provider_changed' | 'requested_observation'

export interface ReadingSearchResult {
  snapshotKey: string
  status: 'running' | 'ready' | 'partial' | 'unavailable' | 'cancelled' | 'invalid' | 'stale'
  stopReason: ReadingSearchStopReason | null
  /** No candidate becomes an author annotation without a separate author action. */
  requiresAuthorConfirmation: true
  rankedCandidates: ReadingCandidate[]
  /** The original exact-dictionary order and its exact-only evidence. */
  baselineCandidates: ReadingCandidate[]
  trace: ReadingSearchTrace[]
  nextActions: ReadingSearchAction[]
  unresolved: string[]
  provider: ReadingProviderInfo | null
  targetMora: number | null
  truncated: boolean
  /** Cumulative cost and cap, including resumed evidence; a manual addition has a one-action cap. */
  budget: { maxObservations: number; observations: number; maxElapsedMs: number; elapsedMs: number }
}

export interface ReadingSearchPlan {
  next: ReadingSearchAction | null
  remaining: ReadingSearchAction[]
  stopReason: ReadingSearchStopReason | null
}
