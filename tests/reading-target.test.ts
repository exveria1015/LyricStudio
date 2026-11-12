import { describe, expect, it } from 'vitest'
import { getSchema, type JSONContent } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { analyzeDocument } from '../src/analysis'
import { Reading, SyllableOverride } from '../src/editor/Reading'
import { assertWholeReadingRanges, captureReadingTarget, readingContext } from '../src/search/target'

const schema = getSchema([StarterKit, Reading, SyllableOverride])
const text = (value: string): JSONContent => ({ type: 'text', text: value })
const paragraph = (...content: JSONContent[]): JSONContent => ({ type: 'paragraph', content })
const ruby = (base: string, reading: string, id = 'ruby'): JSONContent => ({
  ...text(base), marks: [{ type: 'rubyReading', attrs: { id, base, reading, source: 'author_ruby' } }],
})
const syllables = (base: string, count: number): JSONContent => ({
  ...text(base), marks: [{ type: 'syllableOverride', attrs: { id: 'syllables', base, syllables: count, source: 'author_syllables' } }],
})
function fixture(...content: JSONContent[]) {
  const json: JSONContent = { type: 'doc', content }
  return { doc: schema.nodeFromJSON(json), analysis: analyzeDocument(json) }
}
function target(content: JSONContent, from: number, to: number) {
  const { doc, analysis } = fixture(content)
  return captureReadingTarget(doc, analysis, from, to)
}

describe('capturing a reading target without changing its author document', () => {
  it('keeps UTF-16 offsets after non-BMP characters and does not insert reading text', () => {
    const { doc, analysis } = fixture(paragraph(text('𠮷野😀'), ruby('明日', 'あした'), text('へ')))
    const before = doc.toJSON()
    const captured = captureReadingTarget(doc, analysis, 6, 8)
    expect(captured).toMatchObject({ base: '明日', context: '𠮷野😀明日へ', selectionFrom: 5, selectionTo: 7, currentReading: 'あした' })
    expect(captured.context.slice(captured.selectionFrom, captured.selectionTo)).toBe('明日')
    expect(doc.toJSON()).toEqual(before)
    expect(captured.snapshotKey).not.toBe(captureReadingTarget(doc, analysis, 6, 8).snapshotKey)
  })

  it('expands context boundaries rather than cutting surrogate pairs', () => {
    const context = readingContext('a😀明日😀z', 3, 5, 1)
    expect(context).toEqual({ context: '😀明日😀', selectionFrom: 2, selectionTo: 4 })
    expect(context.context.slice(context.selectionFrom, context.selectionTo)).toBe('明日')
  })

  it('bounds a long surrounding line while preserving the selected spelling', () => {
    const value = 'あ'.repeat(200) + '明日' + 'い'.repeat(200)
    const captured = target(paragraph(text(value)), 201, 203)
    expect(captured.context.length).toBe(194)
    expect(captured.selectionFrom).toBe(96)
    expect(captured.selectionTo).toBe(98)
    expect(captured.context.slice(96, 98)).toBe('明日')
  })

  it.each(['[Chorus]', '[Whispered]', '[Custom]', '［Chorus］'])('rejects a selection inside the metadata %s', tag => {
    expect(() => target(paragraph(text(`前${tag}後`)), 3, 5)).toThrow('タグを含まない')
  })

  it('allows lyrics next to metadata and escaped literal brackets', () => {
    expect(target(paragraph(text('[Chorus]明日')), 9, 11).base).toBe('明日')
    expect(target(paragraph(text('\\[Chorus]')), 3, 9).base).toBe('Chorus')
  })

  it('rejects selections across paragraphs and hard breaks', () => {
    const { doc, analysis } = fixture(paragraph(text('明日')), paragraph(text('へ')))
    expect(() => captureReadingTarget(doc, analysis, 1, 6)).toThrow('1行内')
    expect(() => target(paragraph(text('明日'), { type: 'hardBreak' }, text('へ')), 1, 5)).toThrow('1行内')
  })

  it('uses the correct logical line after a hard break', () => {
    const captured = target(paragraph(text('前'), { type: 'hardBreak' }, text('明日へ')), 3, 5)
    expect(captured).toMatchObject({ context: '明日へ', selectionFrom: 0, selectionTo: 2, base: '明日' })
  })

  it('rejects empty or whitespace-only selections and caps the UTF-16 size at 64', () => {
    expect(() => target(paragraph(text('明日')), 1, 1)).toThrow('64文字以内')
    expect(() => target(paragraph(text('  ')), 1, 3)).toThrow('64文字以内')
    expect(target(paragraph(text('あ'.repeat(64))), 1, 65).base).toHaveLength(64)
    expect(() => target(paragraph(text('あ'.repeat(65))), 1, 66)).toThrow('64文字以内')
    expect(target(paragraph(text('😀'.repeat(32))), 1, 65).base).toHaveLength(64)
    expect(() => target(paragraph(text('😀'.repeat(33))), 1, 67)).toThrow('64文字以内')
  })

  it('refuses stale analysis whose selected slice no longer matches the document', () => {
    const { doc, analysis } = fixture(paragraph(text('明日')))
    analysis.lines[0].text = '昨日'
    expect(() => captureReadingTarget(doc, analysis, 1, 3)).toThrow('選択範囲を確認できません')
  })
})

describe('preserving complete existing reading ranges', () => {
  it.each([
    ['ruby', ruby('明日', 'あした')],
    ['syllable', syllables('fire', 1)],
  ])('rejects both partial edges of an existing %s annotation', (_kind, annotated) => {
    const { doc, analysis } = fixture(paragraph(text('前'), annotated, text('後')))
    const end = 2 + annotated.text!.length
    for (const [from, to] of [[2, end - 1], [3, end], [1, end - 1], [3, end + 1]]) {
      expect(() => assertWholeReadingRanges(doc, from, to)).toThrow('範囲全体')
      expect(() => captureReadingTarget(doc, analysis, from, to)).toThrow('範囲全体')
    }
    expect(() => assertWholeReadingRanges(doc, 2, end)).not.toThrow()
    expect(() => assertWholeReadingRanges(doc, 1, end + 1)).not.toThrow()
    expect(() => assertWholeReadingRanges(doc, 1, 2)).not.toThrow()
    expect(() => assertWholeReadingRanges(doc, end, end + 1)).not.toThrow()
  })

  it('reports the current reading only for an exact full ruby range', () => {
    const content = paragraph(ruby('明日', 'あした'), text('へ'))
    expect(target(content, 1, 3).currentReading).toBe('あした')
    expect(target(content, 1, 4).currentReading).toBeNull()
    expect(target(content, 3, 4).currentReading).toBeNull()
    expect(target(paragraph(syllables('fire', 1)), 1, 5).currentReading).toBeNull()
  })

  it('permits replacing several complete annotations without inventing a combined current reading', () => {
    const content = paragraph(ruby('明日', 'あした', 'one'), ruby('空', 'そら', 'two'))
    expect(target(content, 1, 4)).toMatchObject({ base: '明日空', currentReading: null })
    expect(() => target(content, 2, 4)).toThrow('範囲全体')
  })

  it('recognizes one ruby range split across text nodes by other formatting', () => {
    const original = ruby('明日', 'あした')
    const content = paragraph(
      { ...text('明'), marks: original.marks },
      { ...text('日'), marks: [...original.marks!, { type: 'bold' }] },
    )
    expect(target(content, 1, 3).currentReading).toBe('あした')
    expect(() => target(content, 2, 3)).toThrow('範囲全体')
  })

  it('excludes the current instance from author history and retains competing readings elsewhere', () => {
    const { doc, analysis } = fixture(
      paragraph(ruby('明日', 'あした', 'selected'), text('へ')),
      paragraph(ruby('明日', 'あす', 'other-one'), text('と'), ruby('明日', 'みょうにち', 'other-two')),
      paragraph(ruby('昨日', 'きのう', 'different-spelling')),
    )
    const captured = captureReadingTarget(doc, analysis, 1, 3)
    expect(captured.authorReadings).toEqual([
      { id: 'other-one', surface: '明日', reading: 'あす', source: 'document' },
      { id: 'other-two', surface: '明日', reading: 'みょうにち', source: 'document' },
    ])
    expect(captured.currentReading).toBe('あした')
  })

  it('bounds other examples, excludes metadata and selection, and retains each exact occurrence', () => {
    const { doc, analysis } = fixture(
      paragraph(text('明日へ')), paragraph(text('[明日]')),
      paragraph(text('明日と明日')), paragraph(text('まだ明日')), paragraph(text('最後の明日')),
    )
    const captured = captureReadingTarget(doc, analysis, 1, 3)
    expect(captured.examples).toHaveLength(3)
    expect(new Set(captured.examples.map(example => example.id)).size).toBe(3)
    for (const example of captured.examples) {
      expect(example.context.slice(example.selectionFrom, example.selectionTo)).toBe('明日')
      expect(example.context).not.toContain('[')
      expect(example.context).not.toBe('明日へ')
    }
  })
})
