import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { createDemoFile, createLyricsFile, documentToText, parseLyricsFile, serializeLyricsFile, textToDocument } from '../src/model/document'

describe('native document preservation', () => {
  it('round-trips author readings, identities, settings, original text and engine versions', () => {
    const file = createDemoFile()
    file.settings.tagOverrides['Piano Solo'] = 'section'
    file.settings.viewMode = 'ruby'
    file.editorDocument.content!.push({ type: 'paragraph', content: [{
      type: 'text', text: 'Starlight', marks: [{ type: 'syllableOverride', attrs: {
        id: 'manual-syllables', base: 'Starlight', syllables: 3, source: 'author_syllables',
      } }],
    }] })
    expect(parseLyricsFile(serializeLyricsFile(file))).toEqual(file)
  })

  it('uses exactly the supplied sample spelling with explicitly authored demo readings', () => {
    const file = createDemoFile()
    expect(documentToText(file.editorDocument)).toBe(readFileSync('examples/sample-lyrics.txt', 'utf8'))
    const marks = file.editorDocument.content!.flatMap((p) => p.content ?? []).flatMap((n) => n.marks ?? [])
    expect(marks.length).toBeGreaterThan(10)
    expect(marks.every((mark) => mark.attrs?.source === 'author_ruby')).toBe(true)
    expect(documentToText(file.editorDocument)).not.toContain('ひび')
    expect(serializeLyricsFile(file)).toContain('ひび')
  })

  it('preserves empty lines, trailing newline, full-width tags, decomposed Unicode and whitespace', () => {
    const text = '［Chorus］\n\n  か\u3099　RAIN\t\\[Chorus]\n'
    expect(documentToText(textToDocument(text))).toBe(text)
    expect(documentToText(textToDocument(text.replaceAll('\n', '\r\n')))).toBe(text)
    expect(documentToText(textToDocument(text.replaceAll('\n', '\r')))).toBe(text)
    expect(documentToText(textToDocument(''))).toBe('')
  })

  it('exports explicit hardBreak as a newline without ruby metadata', () => {
    const file = createLyricsFile()
    file.editorDocument = { type: 'doc', content: [{ type: 'paragraph', content: [
      { type: 'text', text: 'a' }, { type: 'hardBreak' }, { type: 'text', text: 'b' },
    ] }] }
    expect(documentToText(parseLyricsFile(serializeLyricsFile(file)).editorDocument)).toBe('a\nb')
  })

  it('accepts adjacent split text nodes belonging to the same complete annotation', () => {
    const file = createLyricsFile()
    const marks = [{ type: 'rubyReading', attrs: { id: 'ruby-1', base: '明日', reading: 'あす', source: 'author_ruby' } }]
    file.editorDocument = { type: 'doc', content: [{ type: 'paragraph', content: [
      { type: 'text', text: '明', marks }, { type: 'text', text: '日', marks },
    ] }] }
    expect(parseLyricsFile(serializeLyricsFile(file))).toEqual(file)
  })
})

describe('native import validation', () => {
  it('rejects corrupt JSON and future formats without changing the current object', () => {
    const file = createDemoFile()
    const before = structuredClone(file)
    expect(() => parseLyricsFile('{')).toThrow('JSON')
    expect(() => parseLyricsFile(JSON.stringify({ ...file, schemaVersion: 9 }))).toThrow('新しい形式')
    expect(file).toEqual(before)
  })

  it.each([
    ['missing fields', { format: 'lyrics-studio', schemaVersion: 1 }],
    ['foreign format', { ...createLyricsFile(), format: 'other' }],
    ['invalid date', { ...createLyricsFile(), updatedAt: 'yesterday' }],
    ['unsupported root property', { ...createLyricsFile(), onload: 'alert(1)' }],
    ['unsupported node', { ...createLyricsFile(), editorDocument: { type: 'doc', content: [{ type: 'script', text: 'x' }] } }],
    ['nested nodes', { ...createLyricsFile(), editorDocument: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'paragraph' }] }] } }],
  ])('rejects %s', (_label, file) => {
    expect(() => parseLyricsFile(JSON.stringify(file))).toThrow('歌詞ファイルを読み込めません')
  })

  it.each([
    ['stale base', { base: '別の語' }],
    ['forged provenance', { source: 'inferred_candidate' }],
    ['malicious attrs', { onclick: 'alert(1)' }],
    ['multiline reading', { reading: 'あ\nす' }],
    ['missing id', { id: null }],
    ['overlong id', { id: 'x'.repeat(129) }],
    ['overlong reading', { reading: 'あ'.repeat(513) }],
  ])('rejects annotation %s', (_label, changes) => {
    const file = createDemoFile()
    const mark = file.editorDocument.content![1].content![0].marks![0]
    mark.attrs = { ...mark.attrs, ...changes }
    expect(() => parseLyricsFile(JSON.stringify(file))).toThrow('歌詞ファイルを読み込めません')
  })

  it.each([0, -1, 1.5, '2', 101, Number.MAX_SAFE_INTEGER + 1])('rejects invalid syllable count %s', (syllables) => {
    const file = createLyricsFile('rain')
    file.editorDocument.content![0].content![0].marks = [{ type: 'syllableOverride', attrs: { id: 'x', base: 'rain', syllables, source: 'author_syllables' } }]
    expect(() => parseLyricsFile(JSON.stringify(file))).toThrow('音節数')
  })

  it('rejects duplicate IDs across separate ranges', () => {
    const file = createDemoFile()
    const first = file.editorDocument.content![1].content![0].marks![0]
    const second = file.editorDocument.content![1].content![2].marks![0]
    second.attrs!.id = first.attrs!.id
    expect(() => parseLyricsFile(JSON.stringify(file))).toThrow('重複')
  })

  it('rejects prototype pollution keys rather than merging them into settings', () => {
    const file = createLyricsFile()
    file.settings.tagOverrides = JSON.parse('{"__proto__":"section"}')
    expect(() => parseLyricsFile(JSON.stringify(file))).toThrow('予約済み')
    expect(Object.prototype).not.toHaveProperty('section')
  })
})
