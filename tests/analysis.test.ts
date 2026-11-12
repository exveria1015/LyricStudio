import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { JSONContent } from '@tiptap/core'
import { analyzeDocument, countEnglishSyllables, countMora, parseTagLine } from '../src/analysis'

const text = (value: string): JSONContent => ({ type: 'text', text: value })
const paragraph = (...content: JSONContent[]): JSONContent => ({ type: 'paragraph', content })
const document = (...content: JSONContent[]): JSONContent => ({ type: 'doc', content })
const plain = (...lines: string[]) => document(...lines.map(line => paragraph(...(line ? [text(line)] : []))))
const ruby = (base: string, reading: string, id = `ruby-${base}`): JSONContent => ({
  ...text(base), marks: [{ type: 'rubyReading', attrs: { id, base, reading, source: 'author_ruby' } }],
})
const syllables = (base: string, count: number): JSONContent => ({
  ...text(base), marks: [{ type: 'syllableOverride', attrs: { id: `syllables-${base}`, base, syllables: count, source: 'author_syllables' } }],
})

describe('supplied acceptance TSV', () => {
  const cases = readFileSync('tests/mora_acceptance_cases.tsv', 'utf8').trim().split('\n').slice(1)
  for (const line of cases) {
    const [id, kind, source, reading, expectedMora, expectedSyllables, status] = line.split('\t')
    it(id, () => {
      const doc = document(paragraph(kind === 'ruby' ? ruby(source, reading) : text(source)))
      const result = analyzeDocument(doc)
      expect(result.confirmedMora).toBe(Number(expectedMora))
      expect(result.confirmedSyllables).toBe(Number(expectedSyllables))
      expect(result.complete).toBe(status === 'complete')
    })
  }
})

describe('mora rules and Unicode coordinates', () => {
  it.each([
    ['かな', 2], ['きゃ', 1], ['きょう', 2], ['がっこう', 4], ['スーパー', 4], ['ファイル', 3], ['しんじつ', 4],
    ['ヴァイオリン', 5], ['ウィスキー', 4], ['シェア', 2], ['ティー', 2], ['トゥデイ', 3],
    ['っんー', 3], ['くゎ', 1], ['ｷｬｯﾄ', 3], ['カ\u3099', 1], ['あ、い。う！♪', 3],
  ])('%s -> %i mora', (reading, expected) => {
    expect(countMora(reading)).toMatchObject({ confirmedMora: expected, complete: true, unresolved: [] })
  })
  it.each(['ゃ', 'ぁ', 'あゃ', 'っゃ', 'きゃょ', 'き ゃ', 'ヵ', 'ヶ', 'ゝ', 'ゞ', '々', 'ヿ', '🫧'])('does not silently ignore unsupported %s', reading => {
    expect(countMora(reading).complete).toBe(false)
    expect(countMora(reading).unresolved.length).toBeGreaterThan(0)
  })
  it('retains original UTF-16 positions across normalization and emoji', () => {
    expect(countMora('ｶﾞ🫧あ')).toMatchObject({
      confirmedMora: 2, unresolved: [{ from: 2, to: 4, sourceText: '🫧' }], complete: false,
    })
  })
})

describe('complete local English dictionary', () => {
  it('counts each word, including contractions and uppercase variants', () => {
    expect(analyzeDocument(plain("BREAK the night don't"))).toMatchObject({ confirmedMora: 0, confirmedSyllables: 4, complete: true })
    expect(countEnglishSyllables('don’t')).toMatchObject({ confirmedSyllables: 1, complete: true })
    expect(countEnglishSyllables("'cause")).toMatchObject({ confirmedSyllables: 1, complete: true })
  })
  it('retains alternative counts and never chooses the first pronunciation', () => {
    expect(countEnglishSyllables('fire')).toMatchObject({ confirmedSyllables: 0, candidates: [1, 2], reason: 'ambiguous_pronunciation', complete: false })
    expect(analyzeDocument(plain('fire'))).toMatchObject({ unresolved: [{ from: 1, to: 5, sourceText: 'fire', candidates: [1, 2], reason: 'ambiguous_pronunciation' }] })
  })
  it('does not infer syllables for an invented word or romanized Japanese', () => {
    expect(countEnglishSyllables('zzyxxblorptastic')).toMatchObject({ confirmedSyllables: 0, reason: 'english_oov', complete: false })
    expect(countEnglishSyllables('arigatou')).toMatchObject({ complete: false })
  })
  it('does not certify zero syllables for consonant-only dictionary pronunciations', () => {
    expect(countEnglishSyllables('shh')).toMatchObject({ confirmedSyllables: 0, complete: false, candidates: [0] })
  })
  it('treats prototype names as ordinary dictionary lookups', () => {
    expect(() => countEnglishSyllables('__proto__')).not.toThrow()
    expect(countEnglishSyllables('__proto__').complete).toBe(false)
    expect(parseTagLine('[toString]').tags[0].semantic).toBe('unknown')
  })
  it('records manual syllable overrides and transfers kana readings out of English', () => {
    const result = analyzeDocument(document(paragraph(ruby('Break', 'ブレイク'), text(' '), syllables('fire', 1))))
    expect(result).toMatchObject({ confirmedMora: 4, confirmedSyllables: 1, complete: true })
    expect(result.evidence).toEqual(['author_ruby', 'author_syllables'])
  })
})

describe('tag grammar and classifications', () => {
  it('preserves source and accepts mixed-width brackets', () => {
    const result = parseTagLine('［cHoRuS] [Whispered］ [Custom Effect]')
    expect(result.tags.map(tag => [tag.source, tag.semantic])).toEqual([
      ['［cHoRuS]', 'section'], ['[Whispered］', 'instruction'], ['[Custom Effect]', 'unknown'],
    ])
  })
  it('makes Instrumental classification configurable', () => {
    expect(parseTagLine('[Instrumental]').tags[0].semantic).toBe('instruction')
    expect(parseTagLine('[Instrumental]', { instrumental: 'section' }).tags[0].semantic).toBe('section')
  })
  it('does not swallow escaped brackets or parse them as tags', () => {
    expect(parseTagLine('\\[Chorus] \\［Verse］').tags).toEqual([])
    expect(analyzeDocument(plain('\\[Chorus]'))).toMatchObject({ confirmedSyllables: 2, complete: true })
  })
  it('preserves the confirmed prefix of an incomplete or nested tag', () => {
    for (const source of ['あお[Cho', 'あお[Ch[or]']) {
      expect(analyzeDocument(plain(source))).toMatchObject({ confirmedMora: 2, complete: false, unresolved: [{ from: 3, reason: 'unclosed_tag' }] })
    }
  })
  it('diagnoses empty tags and still excludes them from counts', () => {
    expect(analyzeDocument(plain('あ[]い'))).toMatchObject({ confirmedMora: 2, complete: false, unresolved: [{ from: 2, to: 4, reason: 'unsupported_character', sourceText: '[]' }] })
  })
  it('continues subsequent line counts while section membership is provisional', () => {
    const result = analyzeDocument(plain('[Verse 1]', 'あお[Cho', 'かな', '[Chorus]', 'きゃ'))
    expect(result.lines.map(line => line.confirmedMora)).toEqual([0, 2, 2, 0, 1])
    expect(result.sections.map(section => [section.name, section.confirmedMora, section.provisional, section.complete])).toEqual([
      ['Verse 1', 4, true, false], ['Chorus', 1, false, true],
    ])
  })
  it('keeps repeated section instances and instruction tags inside a section', () => {
    const result = analyzeDocument(plain('[Chorus]', 'あ', '[Whispered]', 'い', '[Chorus]', 'う'))
    expect(result.sections.map(section => [section.name, section.confirmedMora, section.lineCount])).toEqual([['Chorus', 2, 2], ['Chorus', 1, 1]])
    expect(new Set(result.sections.map(section => section.id)).size).toBe(2)
  })
  it('assigns inline content to the precise side of a section boundary', () => {
    const result = analyzeDocument(plain('あ[Chorus]いう'))
    expect(result.sections.map(section => [section.name, section.confirmedMora])).toEqual([['Intro / Untagged', 1], ['Chorus', 2]])
  })
})

describe('document projection and author readings', () => {
  it('counts either a whole mixed-script word or only its kanji without doubling', () => {
    expect(analyzeDocument(document(paragraph(ruby('響', 'ひび'), text('く'))))).toMatchObject({ confirmedMora: 3, complete: true })
    expect(analyzeDocument(document(paragraph(ruby('響く', 'ひびく'))))).toMatchObject({ confirmedMora: 3, complete: true })
  })
  it('matches the specification example exactly', () => {
    const result = analyzeDocument(document(
      paragraph(text('[Verse 1]')),
      paragraph(ruby('響', 'ひび'), text('く '), ruby('声', 'こえ'), text('を Break the night')),
      paragraph(text('まだ '), ruby('見', 'み'), text('ぬ '), ruby('光', 'ひかり'), text('へ')),
      paragraph(ruby('冷', 'つめ'), text('たい '), ruby('雨', 'あめ'), text('を '), ruby('照', 'て'), text('らして')),
    ))
    expect(result).toMatchObject({ confirmedMora: 25, confirmedSyllables: 3, complete: true })
    expect(result.lines.map(line => line.confirmedMora)).toEqual([0, 6, 8, 11])
    expect(result.sections).toHaveLength(1)
    expect(result.sections[0]).toMatchObject({ lineCount: 3, confirmedMora: 25, confirmedSyllables: 3 })
  })
  it('does not apply a stale reading after its base changes', () => {
    const stale = ruby('明日', 'あす')
    stale.text = '明月'
    expect(analyzeDocument(document(paragraph(stale)))).toMatchObject({ confirmedMora: 0, complete: false, unresolved: [{ reason: 'invalid_ruby', sourceText: '明月' }] })
  })
  it('diagnoses empty, invalid, and overlapping author annotations', () => {
    for (const reading of ['', ' ', '明日', 'あゃ', '!!!']) {
      expect(analyzeDocument(document(paragraph(ruby('明日', reading))))).toMatchObject({ confirmedMora: 0, complete: false, unresolved: [{ reason: 'invalid_ruby' }] })
    }
    const overlapping = ruby('Break', 'ブレイク')
    overlapping.marks!.push(...syllables('Break', 1).marks!)
    expect(analyzeDocument(document(paragraph(overlapping)))).toMatchObject({ confirmedMora: 0, confirmedSyllables: 0, complete: false })
  })
  it('merges identical ruby marks split by formatting into one pronunciation', () => {
    const first = ruby('明日', 'あした', 'one')
    const second = structuredClone(first)
    first.text = '明'
    second.text = '日'
    second.marks!.push({ type: 'bold' })
    expect(analyzeDocument(document(paragraph(first, second)))).toMatchObject({ confirmedMora: 3, complete: true })
  })
  it('uses ProseMirror coordinates for paragraphs, hard breaks, and surrogate pairs', () => {
    const result = analyzeDocument(document(paragraph(text('あ🫧'), { type: 'hardBreak' }, text('明日')), paragraph(text('い'))))
    expect(result.lines.map(line => [line.from, line.to])).toEqual([[1, 4], [5, 7], [9, 10]])
    expect(result.unresolved).toEqual([
      { from: 2, to: 4, reason: 'unsupported_character', sourceText: '🫧' },
      { from: 5, to: 7, reason: 'kanji_without_reading', sourceText: '明日' },
    ])
  })
  it('does not reuse cached document offsets, overrides, or readings after edits and Undo', () => {
    expect(analyzeDocument(plain('明日')).unresolved[0].from).toBe(1)
    expect(analyzeDocument(plain('あ', '明日')).unresolved[0].from).toBe(4)
    expect(analyzeDocument(document(paragraph(ruby('明日', 'あす')))).confirmedMora).toBe(2)
    expect(analyzeDocument(document(paragraph(ruby('明日', 'あした')))).confirmedMora).toBe(3)
    expect(analyzeDocument(document(paragraph(ruby('明日', 'あす')))).confirmedMora).toBe(2)
    expect(analyzeDocument(plain('[Instrumental]')).sections[0].name).toBe('Intro / Untagged')
    expect(analyzeDocument(plain('[Instrumental]'), { Instrumental: 'section' }).sections[0].name).toBe('Instrumental')
  })
  it('does not mutate document input or allow returned arrays to corrupt cached analysis', () => {
    const input = plain('明日 fire')
    const snapshot = JSON.stringify(input)
    const result = analyzeDocument(input)
    result.unresolved[0].from = 999
    result.lines[0].unresolved.push({ from: 999, to: 999, reason: 'english_oov', sourceText: 'x' })
    result.lines[0].tags.push({ from: 0, to: 0, source: '', name: '', semantic: 'section', known: true })
    expect(analyzeDocument(input).unresolved[0].from).toBe(1)
    expect(analyzeDocument(input).lines[0].unresolved).toHaveLength(2)
    expect(JSON.stringify(input)).toBe(snapshot)
  })
})
