import type { DocumentAnalysis, LineAnalysis, SectionAnalysis } from '../analysis/types'

export type ComparisonSide = 'left' | 'right'
export interface AlignmentPair { left: number | null; right: number | null }
/** Indices refer to these exact body-line snapshots, never to the live document. */
export interface AlignmentSnapshot {
  leftDocumentId: string
  rightDocumentId: string
  leftSectionId: string | null
  rightSectionId: string | null
  leftLines: string[]
  rightLines: string[]
  rows: AlignmentPair[]
}
export interface ComparisonSource {
  documentId: string
  analysis: DocumentAnalysis
  sectionId?: string | null
}
export interface ComparisonLine extends LineAnalysis {
  bodyIndex: number
  rawText: string
  bodyText: string
  /** False only when a single physical line crosses a selected section boundary. */
  countsAvailable: boolean
}
export interface ComparisonDelta {
  /** Right minus left. A missing counterpart is not a zero-length lyric. */
  value: number | null
  provisional: boolean
}
export interface ComparisonSummary {
  confirmedMora: number
  confirmedSyllables: number
  unresolvedCount: number
  lineCount: number
  complete: boolean
  provisional: boolean
  available: boolean
}
export interface ComparisonRow {
  id: string
  left: ComparisonLine | null
  right: ComparisonLine | null
  moraDelta: ComparisonDelta
  syllableDelta: ComparisonDelta
  missing: ComparisonSide | null
}
export interface ComparisonResult {
  leftLines: ComparisonLine[]
  rightLines: ComparisonLine[]
  rows: ComparisonRow[]
  alignmentStatus: 'automatic' | 'manual' | 'stale'
  scopeMissing: { left: boolean; right: boolean }
  summary: {
    left: ComparisonSummary
    right: ComparisonSummary
    moraDelta: ComparisonDelta
    syllableDelta: ComparisonDelta
  }
}

function selectedSection(source: ComparisonSource): SectionAnalysis | undefined {
  return source.sectionId ? source.analysis.sections.find(section => section.id === source.sectionId) : undefined
}

/** Remove only parsed tag spans, not bracket-like prose, punctuation, or spaces. */
function bodyRanges(line: LineAnalysis): { from: number; to: number }[] {
  const excluded = [
    ...line.tags.map(tag => ({ from: tag.from, to: tag.to })),
    ...line.unresolved.filter(problem => problem.reason === 'unclosed_tag').map(problem => ({ from: problem.from, to: problem.to })),
  ].sort((a, b) => a.from - b.from)
  const ranges: { from: number; to: number }[] = []
  let cursor = line.from
  for (const span of excluded) {
    if (span.from > cursor) ranges.push({ from: cursor, to: span.from })
    cursor = Math.max(cursor, span.to)
  }
  if (cursor < line.to) ranges.push({ from: cursor, to: line.to })
  return ranges
}

export function deriveComparisonLines(analysis: DocumentAnalysis, sectionId?: string | null): ComparisonLine[] {
  const section = sectionId ? analysis.sections.find(item => item.id === sectionId) : undefined
  if (sectionId && !section) return []
  const lines: ComparisonLine[] = []
  for (const line of analysis.lines) {
    const ranges = bodyRanges(line)
    const clipped = ranges.map(range => ({
      from: Math.max(range.from, section?.from ?? range.from),
      to: Math.min(range.to, section?.to ?? range.to),
    })).filter(range => range.to > range.from)
    const bodyText = clipped.map(range => line.text.slice(range.from - line.from, range.to - line.from)).join('')
    if (!bodyText.trim()) continue
    const countsAvailable = ranges.every(range => {
      const leftEnd = Math.min(range.to, section?.from ?? range.from)
      const rightStart = Math.max(range.from, section?.to ?? range.to)
      const outsideLeft = leftEnd > range.from ? line.text.slice(range.from - line.from, leftEnd - line.from) : ''
      const outsideRight = rightStart < range.to ? line.text.slice(rightStart - line.from, range.to - line.from) : ''
      return !outsideLeft.trim() && !outsideRight.trim()
    })
    const from = clipped[0].from
    const to = clipped[clipped.length - 1].to
    const unresolved = line.unresolved.filter(problem => !section || (problem.from < section.to && problem.to > section.from))
    lines.push({
      ...line,
      bodyIndex: lines.length,
      from, to,
      rawText: line.text,
      bodyText,
      countsAvailable,
      unresolved,
      complete: line.complete && countsAvailable && !section?.provisional,
    })
  }
  return lines
}

function scope(source: ComparisonSource) {
  return source.sectionId ?? null
}

function orderedPairs(leftLength: number, rightLength: number): AlignmentPair[] {
  return Array.from({ length: Math.max(leftLength, rightLength) }, (_, index) => ({
    left: index < leftLength ? index : null,
    right: index < rightLength ? index : null,
  }))
}

export function createAlignment(left: ComparisonSource, right: ComparisonSource): AlignmentSnapshot {
  const leftLines = deriveComparisonLines(left.analysis, left.sectionId).map(line => line.rawText)
  const rightLines = deriveComparisonLines(right.analysis, right.sectionId).map(line => line.rawText)
  return {
    leftDocumentId: left.documentId, rightDocumentId: right.documentId,
    leftSectionId: scope(left), rightSectionId: scope(right),
    leftLines, rightLines, rows: orderedPairs(leftLines.length, rightLines.length),
  }
}

/** Check full coverage and uniqueness; crossed author-specified pairs are valid. */
export function isValidAlignment(snapshot: AlignmentSnapshot): boolean {
  for (const side of ['left', 'right'] as const) {
    const length = snapshot[`${side}Lines`].length
    const values = snapshot.rows.map(row => row[side]).filter(value => value !== null)
    if (values.length !== length || new Set(values).size !== length) return false
    if (values.some(value => !Number.isInteger(value) || value < 0 || value >= length)) return false
  }
  return snapshot.rows.every(row => row.left !== null || row.right !== null)
}

export function isAlignmentCurrent(snapshot: AlignmentSnapshot, left: ComparisonSource, right: ComparisonSource): boolean {
  if (!isValidAlignment(snapshot)) return false
  const current = createAlignment(left, right)
  return snapshot.leftDocumentId === current.leftDocumentId && snapshot.rightDocumentId === current.rightDocumentId
    && snapshot.leftSectionId === current.leftSectionId && snapshot.rightSectionId === current.rightSectionId
    && JSON.stringify(snapshot.leftLines) === JSON.stringify(current.leftLines)
    && JSON.stringify(snapshot.rightLines) === JSON.stringify(current.rightLines)
}

/**
 * Caller must first prove one-to-one line identity with the editor transaction
 * mapping. This helper cannot infer identity from equal line counts or language.
 * Reading-only edits already preserve snapshots without calling this function.
 */
export function rebaseAlignmentSnapshots(snapshot: AlignmentSnapshot, left: ComparisonSource, right: ComparisonSource): AlignmentSnapshot | null {
  if (!isValidAlignment(snapshot)) return null
  const current = createAlignment(left, right)
  if (snapshot.leftDocumentId !== current.leftDocumentId || snapshot.rightDocumentId !== current.rightDocumentId
    || snapshot.leftSectionId !== current.leftSectionId || snapshot.rightSectionId !== current.rightSectionId
    || snapshot.leftLines.length !== current.leftLines.length || snapshot.rightLines.length !== current.rightLines.length) return null
  return { ...current, rows: snapshot.rows.map(row => ({ ...row })) }
}

function cloneAlignment(snapshot: AlignmentSnapshot): AlignmentSnapshot {
  if (!isValidAlignment(snapshot)) throw new Error('行対応の参照が不正です。現在の行順で対応を作り直してください。')
  return { ...snapshot, leftLines: [...snapshot.leftLines], rightLines: [...snapshot.rightLines], rows: snapshot.rows.map(row => ({ ...row })) }
}

/** Insert a missing counterpart on one side, shifting that side down one row. */
export function insertAlignmentGap(snapshot: AlignmentSnapshot, side: ComparisonSide, rowIndex: number): AlignmentSnapshot {
  const next = cloneAlignment(snapshot)
  if (!Number.isInteger(rowIndex) || rowIndex < 0 || rowIndex >= next.rows.length) throw new RangeError('対応行が存在しません。')
  let carried: number | null = null
  for (let index = rowIndex; index < next.rows.length; index++) {
    const displaced = next.rows[index][side]
    next.rows[index][side] = carried
    carried = displaced
  }
  if (carried !== null) next.rows.push({ left: side === 'left' ? carried : null, right: side === 'right' ? carried : null })
  next.rows = next.rows.filter(row => row.left !== null || row.right !== null)
  return next
}

/** Remove a deliberate gap, shifting that side up without deleting a lyric line. */
export function removeAlignmentGap(snapshot: AlignmentSnapshot, side: ComparisonSide, rowIndex: number): AlignmentSnapshot {
  const next = cloneAlignment(snapshot)
  if (!Number.isInteger(rowIndex) || rowIndex < 0 || rowIndex >= next.rows.length || next.rows[rowIndex][side] !== null) throw new RangeError('この位置に空き行はありません。')
  for (let index = rowIndex; index < next.rows.length; index++) next.rows[index][side] = next.rows[index + 1]?.[side] ?? null
  next.rows = next.rows.filter(row => row.left !== null || row.right !== null)
  return next
}

/** Explicit reassignment swaps references, preserving every source line once. */
export function assignAlignmentLine(snapshot: AlignmentSnapshot, side: ComparisonSide, rowIndex: number, lineIndex: number | null): AlignmentSnapshot {
  const next = cloneAlignment(snapshot)
  if (!Number.isInteger(rowIndex) || rowIndex < 0 || rowIndex >= next.rows.length) throw new RangeError('対応行が存在しません。')
  if (lineIndex === null) return next.rows[rowIndex][side] === null ? next : insertAlignmentGap(next, side, rowIndex)
  if (!Number.isInteger(lineIndex) || lineIndex < 0 || lineIndex >= next[`${side}Lines`].length) throw new RangeError('指定した本文行が存在しません。')
  const otherIndex = next.rows.findIndex(row => row[side] === lineIndex)
  const previous = next.rows[rowIndex][side]
  next.rows[rowIndex][side] = lineIndex
  next.rows[otherIndex][side] = previous
  next.rows = next.rows.filter(row => row.left !== null || row.right !== null)
  return next
}

function delta(left: number, right: number, available: boolean, complete: boolean): ComparisonDelta {
  return { value: available ? right - left : null, provisional: !complete }
}

function sourceSummary(source: ComparisonSource, lines: ComparisonLine[]): ComparisonSummary {
  const selected = selectedSection(source)
  const available = !source.sectionId || Boolean(selected)
  const aggregate = selected ?? source.analysis
  const provisional = selected?.provisional ?? source.analysis.sections.some(section => section.provisional)
  return {
    confirmedMora: available ? aggregate.confirmedMora : 0,
    confirmedSyllables: available ? aggregate.confirmedSyllables : 0,
    unresolvedCount: available ? aggregate.unresolved.length : 0,
    lineCount: lines.length,
    complete: available && aggregate.complete && !provisional,
    provisional, available,
  }
}

export function compareLyrics(left: ComparisonSource, right: ComparisonSource, alignment?: AlignmentSnapshot | null): ComparisonResult {
  const leftLines = deriveComparisonLines(left.analysis, left.sectionId)
  const rightLines = deriveComparisonLines(right.analysis, right.sectionId)
  const manual = alignment ? isAlignmentCurrent(alignment, left, right) : false
  const pairs = manual ? alignment!.rows : orderedPairs(leftLines.length, rightLines.length)
  const rows = pairs.map((pair, index): ComparisonRow => {
    const leftLine = pair.left === null ? null : leftLines[pair.left]
    const rightLine = pair.right === null ? null : rightLines[pair.right]
    const available = Boolean(leftLine && rightLine && leftLine.countsAvailable && rightLine.countsAvailable)
    const complete = Boolean(leftLine?.complete && rightLine?.complete && available)
    return {
      id: `comparison-row-${index}`,
      left: leftLine, right: rightLine,
      moraDelta: delta(leftLine?.confirmedMora ?? 0, rightLine?.confirmedMora ?? 0, available, complete),
      syllableDelta: delta(leftLine?.confirmedSyllables ?? 0, rightLine?.confirmedSyllables ?? 0, available, complete),
      missing: leftLine ? rightLine ? null : 'right' : 'left',
    }
  })
  const leftSummary = sourceSummary(left, leftLines)
  const rightSummary = sourceSummary(right, rightLines)
  const available = leftSummary.available && rightSummary.available
  const complete = leftSummary.complete && rightSummary.complete
  return {
    leftLines, rightLines, rows,
    alignmentStatus: alignment ? manual ? 'manual' : 'stale' : 'automatic',
    scopeMissing: { left: !leftSummary.available, right: !rightSummary.available },
    summary: {
      left: leftSummary, right: rightSummary,
      moraDelta: delta(leftSummary.confirmedMora, rightSummary.confirmedMora, available, complete),
      syllableDelta: delta(leftSummary.confirmedSyllables, rightSummary.confirmedSyllables, available, complete),
    },
  }
}
