import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import type { DocumentAnalysis } from '../analysis/types'
import { parseTagLine } from '../analysis/tags'
import { getReadingRanges } from '../editor/Reading'
import { runReadingSearch } from './engine'
import { readingContext } from './target'
import type { AuthorReading, ReadingExample, ReadingProvider, ReadingProviderRequest, ReadingProviderResponse, ReadingSearchResult, ReadingSearchTarget } from './types'

export const MAX_BATCH_SELECTION_LENGTH = 8192
export const MAX_BATCH_TARGETS = 128
const MAX_BATCH_TIME_MS = 60_000
const HAN = /\p{Script=Han}/u
const JAPANESE_RUN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}々〆〻ー]+/gu

interface Range { from: number; to: number }
interface SourceLine extends Range { text: string; index: number; excluded: Range[] }
interface SourceSpan extends Range { lineIndex: number }

export interface BatchReadingTarget extends Range {
  snapshotKey: string
  sourceText: string
  preservedCount: number
  /** Captured immutable source data. These positions remain ProseMirror UTF-16 positions. */
  lines: SourceLine[]
  spans: SourceSpan[]
  authorReadings: AuthorReading[]
  issues: string[]
}

export interface BatchReadingItem extends Range {
  id: string
  base: string
  lineIndex: number
  target: ReadingSearchTarget
  result: ReadingSearchResult | null
  error?: string
}

export interface BatchReadingResult {
  snapshotKey: string
  status: 'running' | 'ready' | 'partial' | 'cancelled' | 'stale'
  items: BatchReadingItem[]
  preservedCount: number
  issues: string[]
  completed: number
}

const overlaps = (a: Range, b: Range) => a.from < b.to && a.to > b.from
const splitsSurrogate = (text: string, position: number) => position > 0 && position < text.length
  && /[\uD800-\uDBFF]/u.test(text[position - 1]) && /[\uDC00-\uDFFF]/u.test(text[position])

function subtract(range: Range, exclusions: Range[]): Range[] {
  let cursor = range.from
  const result: Range[] = []
  for (const exclusion of exclusions.filter(item => overlaps(item, range)).sort((a, b) => a.from - b.from)) {
    if (exclusion.from > cursor) result.push({ from: cursor, to: Math.min(exclusion.from, range.to) })
    cursor = Math.max(cursor, exclusion.to)
    if (cursor >= range.to) break
  }
  if (cursor < range.to) result.push({ from: cursor, to: range.to })
  return result
}

/** Preserve all existing annotations, including ones only partly inside the selection. */
export function captureBatchReadingTarget(doc: ProseMirrorNode, analysis: DocumentAnalysis, from: number, to: number): BatchReadingTarget {
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to <= from || to > doc.content.size) {
    throw new Error('読みを探索する範囲を選択してください。')
  }
  const sourceText = doc.textBetween(from, to, '\n', '\n')
  if (!sourceText.trim() || sourceText.length > MAX_BATCH_SELECTION_LENGTH || to - from > MAX_BATCH_SELECTION_LENGTH + analysis.lines.length * 2) {
    throw new Error('一括探索する範囲は8192文字以内で選択してください。')
  }
  const readings = getReadingRanges(doc)
  const preservedCount = readings.filter(range => overlaps(range, { from, to })).length
  const issues: string[] = []
  const lines: SourceLine[] = analysis.lines.map(line => ({
    index: line.index, from: line.from, to: line.to, text: line.text,
    excluded: parseTagLine(line.text).excluded.map(range => ({ from: line.from + range.from, to: line.from + range.to })),
  }))
  const spans: SourceSpan[] = []
  for (const line of lines) {
    const range = { from: Math.max(from, line.from), to: Math.min(to, line.to) }
    if (range.from >= range.to) continue
    if (doc.textBetween(line.from, line.to, '\n', '\n') !== line.text
      || splitsSurrogate(line.text, range.from - line.from) || splitsSurrogate(line.text, range.to - line.from)) {
      throw new Error('選択範囲と原文が一致しません。選択し直してください。')
    }
    if (parseTagLine(line.text).unresolved.some(item => item.reason === 'unclosed_tag'
      && overlaps({ from: line.from + item.from, to: line.from + item.to }, range))) {
      issues.push(`${line.index + 1}行目の閉じていないタグ内は探索から除外しました。`)
    }
    for (const span of subtract(range, [...line.excluded, ...readings])) {
      if (HAN.test(line.text.slice(span.from - line.from, span.to - line.from))) spans.push({ ...span, lineIndex: line.index })
    }
  }
  return {
    snapshotKey: crypto.randomUUID(), from, to, sourceText, preservedCount, lines, spans, issues,
    authorReadings: readings.filter(range => range.mark.type.name === 'rubyReading' && range.mark.attrs.source === 'author_ruby')
      .map(range => ({ id: String(range.mark.attrs.id), surface: range.text, reading: String(range.mark.attrs.reading), source: 'document' })),
  }
}

function makeTarget(batch: BatchReadingTarget, line: SourceLine, range: Range, personal: AuthorReading[]): ReadingSearchTarget {
  const base = line.text.slice(range.from - line.from, range.to - line.from)
  const examples: ReadingExample[] = []
  for (const other of batch.lines) {
    let offset = other.text.indexOf(base)
    while (offset >= 0 && examples.length < 3) {
      const occurrence = { from: other.from + offset, to: other.from + offset + base.length }
      if (occurrence.from !== range.from && !other.excluded.some(excluded => overlaps(excluded, occurrence))) {
        examples.push({ id: `line-${other.index}-${offset}`, ...readingContext(other.text, offset, offset + base.length) })
      }
      offset = other.text.indexOf(base, offset + Math.max(1, base.length))
    }
    if (examples.length >= 3) break
  }
  return {
    snapshotKey: `${batch.snapshotKey}:${range.from}:${range.to}`, base, currentReading: null,
    ...readingContext(line.text, range.from - line.from, range.to - line.from), examples,
    authorReadings: structuredClone([...batch.authorReadings, ...personal].filter(reading => reading.surface === base)),
  }
}

/** Enforce cancellation even for a provider that does not observe its AbortSignal. */
async function observe(provider: ReadingProvider, request: ReadingProviderRequest, signal: AbortSignal, timeoutMs: number) {
  if (signal.aborted) throw signal.reason
  const timeout = new AbortController()
  const timer = setTimeout(() => timeout.abort(new DOMException('形態素解析が時間内に完了しませんでした。', 'TimeoutError')), Math.max(1, timeoutMs))
  const combined = AbortSignal.any([signal, timeout.signal])
  let abort = () => {}
  try {
    const aborted = new Promise<never>((_, reject) => {
      abort = () => reject(combined.reason)
      combined.addEventListener('abort', abort, { once: true })
    })
    return await Promise.race([provider(request, combined), aborted])
  } finally {
    clearTimeout(timer)
    combined.removeEventListener('abort', abort)
  }
}

function validateTokens(response: ReadingProviderResponse, text: string) {
  let end = 0
  for (const token of response.tokens) {
    if (!Number.isSafeInteger(token.from) || !Number.isSafeInteger(token.to) || token.from < end || token.to <= token.from
      || token.to > text.length || splitsSurrogate(text, token.from) || splitsSurrogate(text, token.to)
      || text.slice(token.from, token.to) !== token.surface) throw new Error('形態素の位置を原文と照合できませんでした。')
    end = token.to
  }
}

/** Discovery and candidate search are observations only; the caller owns explicit bulk adoption. */
export async function runBatchReadingSearch(
  input: BatchReadingTarget, personal: AuthorReading[], provider: ReadingProvider,
  signal?: AbortSignal, onProgress?: (result: BatchReadingResult) => void,
): Promise<BatchReadingResult> {
  const target = structuredClone(input)
  const history = structuredClone(personal)
  const started = performance.now()
  const controller = new AbortController()
  const abort = () => controller.abort(signal?.reason ?? new DOMException('探索を中止しました。', 'AbortError'))
  signal?.addEventListener('abort', abort, { once: true })
  if (signal?.aborted) abort()
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; controller.abort(new DOMException('一括探索の時間上限に達しました。', 'TimeoutError')) }, MAX_BATCH_TIME_MS)
  const issues = [...target.issues]
  const items: BatchReadingItem[] = []
  const handled: Range[] = []
  const lineMap = new Map(target.lines.map(line => [line.index, line]))
  let completed = 0
  let version: string | null = null
  let stale = false
  let capped = false
  let discoveryFailures = 0
  const issue = (message: string) => { if (!issues.includes(message)) issues.push(message) }
  const snapshot = (status: BatchReadingResult['status']): BatchReadingResult => ({
    snapshotKey: target.snapshotKey, status, items: structuredClone(items), preservedCount: target.preservedCount, issues: [...issues], completed,
  })
  const checkedProvider: ReadingProvider = async (request, requestSignal) => {
    const response = await observe(provider, request, requestSignal ? AbortSignal.any([controller.signal, requestSignal]) : controller.signal,
      Math.min(10_000, MAX_BATCH_TIME_MS - (performance.now() - started)))
    if (controller.signal.aborted) throw controller.signal.reason
    if (response.provider?.id !== 'sudachi-full' || response.provider.edition !== 'full' || !response.provider.version) {
      throw new Error('SudachiDict Fullの応答形式を確認できません。')
    }
    if (version !== null && version !== response.provider.version) {
      stale = true
      controller.abort(new DOMException('探索中に辞書バージョンが変わりました。最初から探索し直してください。', 'AbortError'))
      throw controller.signal.reason
    }
    version = response.provider.version
    return response
  }
  function addRange(line: SourceLine, range: Range, error?: string) {
    if (handled.some(other => overlaps(other, range))) return
    handled.push(range)
    const base = line.text.slice(range.from - line.from, range.to - line.from)
    if (base.length > 64) {
      issue(`${line.index + 1}行目に64文字を超える未確認の語があります。範囲を狭めて探索してください。`)
      return
    }
    if (items.length >= MAX_BATCH_TARGETS) { capped = true; return }
    const itemTarget = makeTarget(target, line, range, history)
    items.push({ id: itemTarget.snapshotKey, ...range, base, lineIndex: line.index, target: itemTarget, result: null, ...(error ? { error } : {}) })
  }
  function addJapaneseRuns(line: SourceLine, range: Range, error?: string) {
    const text = line.text.slice(range.from - line.from, range.to - line.from)
    for (const match of text.matchAll(JAPANESE_RUN)) {
      if (HAN.test(match[0])) addRange(line, { from: range.from + match.index, to: range.from + match.index + match[0].length }, error)
    }
  }
  try {
    onProgress?.(snapshot('running'))
    for (const span of target.spans) {
      if (controller.signal.aborted || capped || discoveryFailures >= 2) break
      const line = lineMap.get(span.lineIndex)!
      for (let cursor = span.from; cursor < span.to;) {
        if (controller.signal.aborted || capped || discoveryFailures >= 2) break
        let end = Math.min(cursor + 768, span.to)
        if (splitsSurrogate(line.text, end - line.from)) end--
        const window = readingContext(line.text, cursor - line.from, end - line.from)
        const contextStart = cursor - window.selectionFrom
        try {
          const response = await checkedProvider({ kind: 'context', text: window.context, mode: 'C' }, controller.signal)
          validateTokens(response, window.context)
          if (response.truncated) issue(`${line.index + 1}行目の形態素解析は一部のみ取得できました。未確認の範囲を残しています。`)
          for (const token of response.tokens) {
            const absolute = { from: contextStart + token.from, to: contextStart + token.to }
            if (!overlaps(absolute, { from: cursor, to: end })) continue
            addJapaneseRuns(line, { from: Math.max(span.from, absolute.from), to: Math.min(span.to, absolute.to) })
          }
        } catch (cause) {
          if (controller.signal.aborted) break
          discoveryFailures++
          issue(`${line.index + 1}行目の語の区切りを解析できませんでした。${cause instanceof Error ? cause.message : String(cause)}`)
        }
        cursor = end
        onProgress?.(snapshot('running'))
      }
    }
    if (!controller.signal.aborted) {
      // A failed, incomplete or unavailable tokenizer must not make unresolved Han disappear.
      for (const span of target.spans) {
        const line = lineMap.get(span.lineIndex)!
        for (const missing of subtract(span, handled)) {
          if (!HAN.test(line.text.slice(missing.from - line.from, missing.to - line.from))) continue
          const error = '形態素解析で語の区切りを確認できなかった範囲です。候補と表記を確認してください。'
          issue(error)
          addJapaneseRuns(line, missing, error)
        }
      }
    }
    if (capped) issue('一度に探索できる128件を超えました。残りは範囲を狭めて探索してください。')
    items.sort((a, b) => a.from - b.from)
    onProgress?.(snapshot('running'))
    for (const item of items) {
      if (controller.signal.aborted) break
      item.result = await runReadingSearch(item.target, { maxObservations: 8, maxElapsedMs: Math.min(10_000, MAX_BATCH_TIME_MS - (performance.now() - started)) }, checkedProvider, controller.signal)
      completed++
      if (item.result.status === 'stale') { stale = true; break }
      onProgress?.(snapshot('running'))
    }
    if (stale) {
      issue('探索中に辞書のバージョンが変わりました。この結果は採用せず、最初から探索し直してください。')
      return snapshot('stale')
    }
    if (signal?.aborted) return snapshot('cancelled')
    if (timedOut || performance.now() - started >= MAX_BATCH_TIME_MS) issue('一括探索の60秒の上限に達しました。未探索の項目は保留されています。')
    const partial = issues.length > 0 || items.some(item => item.error || !item.result || !['ready'].includes(item.result.status)
      || !item.result.rankedCandidates.some(candidate => candidate.applicable))
    return snapshot(partial ? 'partial' : 'ready')
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', abort)
  }
}
