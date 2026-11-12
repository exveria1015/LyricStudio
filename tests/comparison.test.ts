import { describe, expect, it } from 'vitest'
import type { JSONContent } from '@tiptap/core'
import { analyzeDocument } from '../src/analysis'
import { textToDocument } from '../src/model/document'
import {
  assignAlignmentLine, compareLyrics, createAlignment, deriveComparisonLines, insertAlignmentGap,
  isAlignmentCurrent, isValidAlignment, rebaseAlignmentSnapshots, removeAlignmentGap,
} from '../src/features/comparison'
import type { AlignmentSnapshot, ComparisonSource } from '../src/features/comparison'

function source(text: string, documentId = 'a', sectionId: string | null = null): ComparisonSource {
  return { documentId, analysis: analyzeDocument(textToDocument(text)), sectionId }
}
function rubySource(reading: string): ComparisonSource {
  const doc: JSONContent = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '明日', marks: [{ type: 'rubyReading', attrs: { id: 'reading', base: '明日', reading, source: 'author_ruby' } }] }] }] }
  return { documentId: 'a', analysis: analyzeDocument(doc) }
}
const left = () => source('あ\nいい\nううう')
const right = () => source('a\nbreak\nnight', 'b')

describe('body line projection', () => {
  it('excludes empty, whitespace-only, section, instruction, and arbitrary tag-only lines', () => {
    const result = deriveComparisonLines(source('[Verse 1]\n\n \n[Whispered]\n[Custom Effect]\nあ[Whispered]い\nかな').analysis)
    expect(result.map(line => line.bodyText)).toEqual(['あい', 'かな'])
    expect(result[0].rawText).toBe('あ[Whispered]い')
    expect(result[0]).toMatchObject({ index: 5, bodyIndex: 0, confirmedMora: 2, complete: true })
  })
  it('preserves original whitespace, escaped brackets, punctuation, and source positions', () => {
    const input = source('  あ [Whispered] い！\n\\[chorus]')
    const result = deriveComparisonLines(input.analysis)
    expect(result[0].bodyText).toBe('  あ  い！')
    expect(result[1].bodyText).toBe('\\[chorus]')
    expect(result[0].from).toBe(1)
    expect(result[0].to).toBe(input.analysis.lines[0].to)
    expect(result[1].from).toBe(input.analysis.lines[1].from)
  })
  it('keeps only the known body prefix of an incomplete tag and retains its uncertainty', () => {
    const input = source('[Verse]\n[Cho\nあ[Whis\nい')
    const result = deriveComparisonLines(input.analysis)
    expect(result.map(line => line.bodyText)).toEqual(['あ', 'い'])
    expect(result[0].complete).toBe(false)
    const comparison = compareLyrics(input, source('あ\nい', 'b'))
    expect(comparison.summary.left).toMatchObject({ complete: false, provisional: true, unresolvedCount: 2 })
  })
  it('distinguishes repeated section names by instance id', () => {
    const input = source('[Chorus]\nあ\n[Chorus]\nいい')
    const [first, second] = input.analysis.sections
    expect(deriveComparisonLines(input.analysis, first.id).map(line => line.bodyText)).toEqual(['あ'])
    expect(deriveComparisonLines(input.analysis, second.id).map(line => line.bodyText)).toEqual(['いい'])
    const result = compareLyrics({ ...input, sectionId: first.id }, { ...input, sectionId: second.id })
    expect(result.rows[0].moraDelta).toEqual({ value: 1, provisional: false })
  })
  it('does not attribute a whole-line count to one side of an inline section boundary', () => {
    const input = source('あ[Chorus]いい')
    const [first, second] = input.analysis.sections
    const a = deriveComparisonLines(input.analysis, first.id)[0]
    const b = deriveComparisonLines(input.analysis, second.id)[0]
    expect(a.bodyText).toBe('あ')
    expect(b.bodyText).toBe('いい')
    expect(a.countsAvailable).toBe(false)
    expect(b.countsAvailable).toBe(false)
    const result = compareLyrics({ ...input, sectionId: first.id }, { ...input, sectionId: second.id })
    expect(result.rows[0].moraDelta.value).toBeNull()
    expect(result.summary.moraDelta).toEqual({ value: 1, provisional: false })
  })
  it('retains usable counts when an inline section tag has no body before it', () => {
    const input = source('[Verse]あい')
    const result = deriveComparisonLines(input.analysis, input.analysis.sections[0].id)[0]
    expect(result).toMatchObject({ bodyText: 'あい', countsAvailable: true, confirmedMora: 2, complete: true })
  })
  it('retains counts for long body lines wholly inside a section', () => {
    const input = source('[Verse 1]\nBeyond the night\nかなかなかなかなかなかなかなかなかなかなかなかなかなかなかなかな')
    const lines = deriveComparisonLines(input.analysis, input.analysis.sections[0].id)
    expect(lines.map(line => line.countsAvailable)).toEqual([true, true])
    expect(lines[0]).toMatchObject({ confirmedSyllables: 4, complete: true })
    const compared = compareLyrics({ ...input, sectionId: input.analysis.sections[0].id }, { ...input, sectionId: input.analysis.sections[0].id })
    expect(compared.rows[0].syllableDelta).toEqual({ value: 0, provisional: false })
  })
  it('returns an explicit missing scope without silently falling back to the full document', () => {
    const result = compareLyrics({ ...left(), sectionId: 'deleted-section' }, right())
    expect(result.leftLines).toEqual([])
    expect(result.scopeMissing).toEqual({ left: true, right: false })
    expect(result.summary.left.available).toBe(false)
    expect(result.summary.moraDelta.value).toBeNull()
  })
})

describe('ordered comparison and independent sound units', () => {
  it('computes right-minus-left mora and syllable deltas separately', () => {
    const result = compareLyrics(source('かな break'), source('あいう the night', 'b'))
    expect(result.rows[0].moraDelta).toEqual({ value: 1, provisional: false })
    expect(result.rows[0].syllableDelta).toEqual({ value: 1, provisional: false })
    expect(result.summary.left).toMatchObject({ confirmedMora: 2, confirmedSyllables: 1, lineCount: 1, complete: true })
  })
  it('represents missing counterparts as null, never a zero-valued lyric', () => {
    const result = compareLyrics(source('あ\nい'), source('う', 'b'))
    expect(result.rows[1]).toMatchObject({ left: { bodyText: 'い' }, right: null, missing: 'right', moraDelta: { value: null }, syllableDelta: { value: null } })
    expect(result.summary.moraDelta.value).toBe(-1)
  })
  it('labels known-part differences as provisional when either side is unresolved', () => {
    const result = compareLyrics(source('明日かな'), source('あいう', 'b'))
    expect(result.rows[0].moraDelta).toEqual({ value: 1, provisional: true })
    expect(result.rows[0].syllableDelta).toEqual({ value: 0, provisional: true })
    expect(result.summary.moraDelta.provisional).toBe(true)
  })
  it('does not infer translation equivalence from text or numbers', () => {
    const result = compareLyrics(source('かな'), source('night', 'b'))
    expect(result.rows).toHaveLength(1)
    expect(result.alignmentStatus).toBe('automatic')
    expect(result.rows[0].moraDelta.value).toBe(-2)
    expect(result.rows[0].syllableDelta.value).toBe(1)
  })
  it('handles both empty and one empty document', () => {
    expect(compareLyrics(source(''), source('', 'b')).rows).toEqual([])
    expect(compareLyrics(source(''), source('あ', 'b')).rows[0].missing).toBe('left')
  })
})

describe('explicit manual correspondence', () => {
  it('inserts a gap and shifts only the selected side without losing any line', () => {
    const original = createAlignment(left(), right())
    const next = insertAlignmentGap(original, 'left', 1)
    expect(next.rows).toEqual([{ left: 0, right: 0 }, { left: null, right: 1 }, { left: 1, right: 2 }, { left: 2, right: null }])
    expect(original.rows).toEqual([{ left: 0, right: 0 }, { left: 1, right: 1 }, { left: 2, right: 2 }])
    expect(isValidAlignment(next)).toBe(true)
    const result = compareLyrics(left(), right(), next)
    expect(result.alignmentStatus).toBe('manual')
    expect(result.rows[2]).toMatchObject({ left: { bodyText: 'いい' }, right: { bodyText: 'night' } })
  })
  it('removes a gap without discarding a body line', () => {
    const original = createAlignment(left(), right())
    const shifted = insertAlignmentGap(original, 'right', 0)
    expect(removeAlignmentGap(shifted, 'right', 0)).toEqual(original)
  })
  it('can explicitly swap corresponding lines, including across order', () => {
    const next = assignAlignmentLine(createAlignment(left(), right()), 'right', 0, 2)
    expect(next.rows).toEqual([{ left: 0, right: 2 }, { left: 1, right: 1 }, { left: 2, right: 0 }])
    expect(isValidAlignment(next)).toBe(true)
  })
  it('moves a line into an existing gap and compacts empty pairs', () => {
    const next = insertAlignmentGap(createAlignment(left(), right()), 'left', 0)
    const moved = assignAlignmentLine(next, 'left', 0, 2)
    expect(isValidAlignment(moved)).toBe(true)
    expect(moved.rows[0]).toEqual({ left: 2, right: 0 })
    expect(moved.rows.every(row => row.left !== null || row.right !== null)).toBe(true)
  })
  it('can set a counterpart to absent while keeping the displaced line', () => {
    const next = assignAlignmentLine(createAlignment(left(), right()), 'right', 1, null)
    expect(next.rows).toHaveLength(4)
    expect(next.rows[1]).toEqual({ left: 1, right: null })
    expect(isValidAlignment(next)).toBe(true)
  })
  it('rejects duplicate, missing, out-of-bounds, and empty-pair references', () => {
    const original = createAlignment(left(), right())
    const invalid: AlignmentSnapshot[] = [
      { ...original, rows: [{ left: 0, right: 0 }, { left: 0, right: 1 }, { left: 2, right: 2 }] },
      { ...original, rows: original.rows.slice(0, 2) },
      { ...original, rows: [{ left: 0, right: 0 }, { left: 1, right: 1 }, { left: 9, right: 2 }] },
      { ...original, rows: [...original.rows, { left: null, right: null }] },
    ]
    for (const snapshot of invalid) {
      expect(isValidAlignment(snapshot)).toBe(false)
      expect(compareLyrics(left(), right(), snapshot).alignmentStatus).toBe('stale')
      expect(() => insertAlignmentGap(snapshot, 'left', 0)).toThrow()
    }
  })
  it('rejects operations on nonexistent rows and non-gap cells', () => {
    const snapshot = createAlignment(left(), right())
    expect(() => insertAlignmentGap(snapshot, 'left', -1)).toThrow(RangeError)
    expect(() => removeAlignmentGap(snapshot, 'left', 0)).toThrow(RangeError)
    expect(() => assignAlignmentLine(snapshot, 'right', 0, 99)).toThrow(RangeError)
  })
})

describe('alignment freshness and explicit rebasing', () => {
  it('does not silently move a manual link after line insertion, including duplicate lines', () => {
    const a = source('あ\nあ\nいい')
    const b = right()
    const alignment = insertAlignmentGap(createAlignment(a, b), 'right', 0)
    const changed = source('あ\nあ\nあ\nいい')
    expect(isAlignmentCurrent(alignment, changed, b)).toBe(false)
    expect(compareLyrics(changed, b, alignment).alignmentStatus).toBe('stale')
    expect(rebaseAlignmentSnapshots(alignment, changed, b)).toBeNull()
  })
  it('flags same-length text edits as stale until explicitly rebased', () => {
    const a = left()
    const b = right()
    const original = insertAlignmentGap(createAlignment(a, b), 'right', 0)
    const changed = source('ああ\nいい\nううう')
    expect(compareLyrics(changed, b, original).alignmentStatus).toBe('stale')
    const rebased = rebaseAlignmentSnapshots(original, changed, b)!
    expect(rebased.rows).toEqual(original.rows)
    expect(rebased.leftLines[0]).toBe('ああ')
    expect(compareLyrics(changed, b, rebased).alignmentStatus).toBe('manual')
  })
  it('preserves manual correspondence when only readings or absolute positions change', () => {
    const b = source('ああ', 'b')
    const alignment = createAlignment(rubySource('あす'), b)
    expect(compareLyrics(rubySource('あした'), b, alignment)).toMatchObject({ alignmentStatus: 'manual', rows: [{ moraDelta: { value: -1, provisional: false } }] })
    const original = createAlignment(source('かな'), b)
    const shifted = source('[Whispered]\n\nかな')
    expect(compareLyrics(shifted, b, original)).toMatchObject({ alignmentStatus: 'manual', rows: [{ left: { from: shifted.analysis.lines[2].from } }] })
  })
  it('does not carry links across different documents or section instances', () => {
    const original = createAlignment(left(), right())
    expect(compareLyrics(source('あ\nいい\nううう', 'another-document'), right(), original).alignmentStatus).toBe('stale')
    expect(rebaseAlignmentSnapshots(original, source('あ\nいい\nううう', 'another-document'), right())).toBeNull()
  })
})
