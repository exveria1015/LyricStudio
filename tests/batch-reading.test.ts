import { getSchema, type JSONContent } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { describe, expect, it, vi } from 'vitest'
import { analyzeDocument } from '../src/analysis'
import { Reading, SyllableOverride } from '../src/editor/Reading'
import { captureBatchReadingTarget, MAX_BATCH_TARGETS, runBatchReadingSearch } from '../src/search/batch'
import type { DictionaryEntry, ReadingProvider, ReadingProviderResponse, ReadingToken } from '../src/search/types'

const schema = getSchema([StarterKit, Reading, SyllableOverride])
const text = (value: string): JSONContent => ({ type: 'text', text: value })
const paragraph = (...content: JSONContent[]): JSONContent => ({ type: 'paragraph', content })
const ruby = (base: string, reading: string, id = 'ruby'): JSONContent => ({ ...text(base), marks: [{ type: 'rubyReading', attrs: { id, base, reading, source: 'author_ruby' } }] })
const syllables = (base: string): JSONContent => ({ ...text(base), marks: [{ type: 'syllableOverride', attrs: { id: 'syllables', base, syllables: 1, source: 'author_syllables' } }] })
function fixture(...content: JSONContent[]) {
  const json: JSONContent = { type: 'doc', content }
  const doc = schema.nodeFromJSON(json)
  const analysis = analyzeDocument(json)
  return { doc, analysis, capture: (from = 0, to = doc.content.size) => captureBatchReadingTarget(doc, analysis, from, to) }
}
const info = { id: 'sudachi-full', edition: 'full', version: 'fixture-v1', engineVersion: 'fixture', dictionaryVersion: 'fixture-v1' } as const
function entry(surface: string, reading: string): DictionaryEntry {
  return { id: `${surface}:${reading}`, surface, reading, normalizedForm: surface, dictionaryForm: surface, partOfSpeech: ['名詞'], dictionaryId: 0, wordId: 1, isOov: false }
}
function response(entries: DictionaryEntry[] = [], tokens: ReadingToken[] = [], extra: Partial<ReadingProviderResponse> = {}): ReadingProviderResponse {
  return { provider: info, entries, tokens, elapsedMs: 1, truncated: false, notes: [], ...extra }
}
const readings: Record<string, string> = { 明日: 'アス', 届か: 'トドカ', 声: 'コエ', 空: 'ソラ', 光: 'ヒカリ', 東京: 'トウキョウ', 𠮷野: 'ヨシノ', 明日空光: 'アスソラヒカリ' }
function dictionary() {
  return vi.fn<ReadingProvider>(async request => {
    if (request.kind === 'exact') return response(readings[request.text] ? [entry(request.text, readings[request.text])] : [])
    return response([], [...request.text.matchAll(/明日空光|明日|届か|声|空|光|東京|𠮷野|未知/gu)].map(match => ({
      ...entry(match[0], readings[match[0]] ?? match[0]), from: match.index, to: match.index + match[0].length, isOov: match[0] === '未知',
    })))
  })
}

describe('capturing a protected selected range for bulk reading exploration', () => {
  it('uses ProseMirror offsets across paragraphs and hard breaks, preserving original UTF-16 text', () => {
    const { doc, capture } = fixture(paragraph(text('😀明日'), { type: 'hardBreak' }, text('届かない声')), paragraph(text('𠮷野へ')))
    const before = doc.toJSON()
    const target = capture()
    expect(target.sourceText).toBe('😀明日\n届かない声\n𠮷野へ')
    expect(target.spans).toEqual([{ from: 1, to: 5, lineIndex: 0 }, { from: 6, to: 11, lineIndex: 1 }, { from: 13, to: 17, lineIndex: 2 }])
    expect(doc.toJSON()).toEqual(before)
  })

  it('preserves complete ruby and syllable annotations even when only their edges are selected', () => {
    const { capture } = fixture(paragraph(ruby('明日', 'あした'), text('空'), syllables('東京'), text('声')))
    expect(capture(2, 5)).toMatchObject({ preservedCount: 2, spans: [{ from: 3, to: 4, lineIndex: 0 }] })
    expect(capture(1, 7)).toMatchObject({ preservedCount: 2, spans: [{ from: 3, to: 4, lineIndex: 0 }, { from: 6, to: 7, lineIndex: 0 }] })
  })

  it('excludes unknown, full-width and unclosed tags while allowing escaped literal brackets', () => {
    const { capture } = fixture(paragraph(text('[明日]空［声］光[未知')), paragraph(text('\\[東京]')))
    const target = capture()
    expect(target.spans.map(span => target.lines[span.lineIndex].text.slice(span.from - target.lines[span.lineIndex].from, span.to - target.lines[span.lineIndex].from))).toEqual(['空', '光', '\\[東京]'])
    expect(target.issues).toEqual(['1行目の閉じていないタグ内は探索から除外しました。'])
  })

  it('rejects empty, excessively long and surrogate-split selections', () => {
    expect(() => fixture(paragraph(text('明日'))).capture(1, 1)).toThrow('範囲を選択')
    expect(() => fixture(paragraph(text(' '))).capture()).toThrow('8192')
    expect(() => fixture(paragraph(text('明'.repeat(8193)))).capture()).toThrow('8192')
    expect(() => fixture(paragraph(text('𠮷野'))).capture(1, 2)).toThrow('原文が一致')
    expect(() => fixture(paragraph(text('𠮷野'))).capture(2, 4)).toThrow('原文が一致')
  })

  it('rejects stale selected-line analysis before any request', () => {
    const { doc, analysis } = fixture(paragraph(text('明日')))
    analysis.lines[0].text = '昨日'
    expect(() => captureBatchReadingTarget(doc, analysis, 1, 3)).toThrow('原文が一致')
  })
})

describe('bounded batch discovery and adaptive reading exploration', () => {
  it('discovers only unannotated Han-bearing words and leaves source and selection untouched', async () => {
    const { capture, doc } = fixture(paragraph(text('[Verse]'), ruby('明日', 'あした'), text('へ'), { type: 'hardBreak' }, text('届かない声')), paragraph(text('空と光 tomorrow かな')))
    const target = capture()
    const before = structuredClone(target)
    const docBefore = doc.toJSON()
    const progress: string[] = []
    const result = await runBatchReadingSearch(target, [], dictionary(), undefined, state => progress.push(state.status))
    expect(result.status).toBe('ready')
    expect(result.preservedCount).toBe(1)
    expect(result.items.map(item => item.base)).toEqual(['届か', '声', '空', '光'])
    expect(result.items.map(item => item.result?.rankedCandidates[0].reading)).toEqual(['とどか', 'こえ', 'そら', 'ひかり'])
    expect(result.completed).toBe(4)
    expect(progress.every(status => status === 'running')).toBe(true)
    for (const item of result.items) {
      expect(doc.textBetween(item.from, item.to)).toBe(item.base)
      expect(item.from).toBeGreaterThanOrEqual(target.from)
      expect(item.to).toBeLessThanOrEqual(target.to)
      expect(item.target.context.slice(item.target.selectionFrom, item.target.selectionTo)).toBe(item.base)
      expect(item.target.currentReading).toBeNull()
    }
    expect(target).toEqual(before)
    expect(doc.toJSON()).toEqual(docBefore)
  })

  it('does not call the tokenizer for kana, English, punctuation or protected annotations', async () => {
    const provider = dictionary()
    const target = fixture(paragraph(text('かな tomorrow 😀'), ruby('明日', 'あした'), syllables('東京'))).capture()
    const result = await runBatchReadingSearch(target, [], provider)
    expect(result).toMatchObject({ status: 'ready', items: [], completed: 0, preservedCount: 2 })
    expect(provider).not.toHaveBeenCalled()
  })

  it('uses surrounding kana to infer a selected kanji fragment, without escaping its boundary', async () => {
    const target = fixture(paragraph(text('届かない声'))).capture(1, 2)
    const result = await runBatchReadingSearch(target, [], dictionary())
    expect(result.items).toHaveLength(1)
    const item = result.items[0]
    expect(item).toMatchObject({ from: 1, to: 2, base: '届' })
    expect(item.result?.rankedCandidates[0]).toMatchObject({ reading: 'とど' })
    expect(item.result?.rankedCandidates[0].evidence.some(evidence => evidence.method === 'kana_anchor')).toBe(true)
  })

  it('never splits a kanji compound reading by spelling positions', async () => {
    const result = await runBatchReadingSearch(fixture(paragraph(text('東京'))).capture(2, 3), [], dictionary())
    expect(result.items).toHaveLength(1)
    expect(result.items[0].base).toBe('京')
    expect(result.items[0].result?.rankedCandidates).toEqual([])
    expect(result.status).toBe('partial')
  })

  it('retains original UTF-16 offsets after emoji and non-BMP Han', async () => {
    const { doc, capture } = fixture(paragraph(text('😀𠮷野へ明日')))
    const result = await runBatchReadingSearch(capture(), [], dictionary())
    expect(result.items.map(item => [item.from, item.to, item.base])).toEqual([[3, 6, '𠮷野'], [7, 9, '明日']])
    for (const item of result.items) expect(doc.textBetween(item.from, item.to)).toBe(item.base)
  })

  it('carries document author readings, personal history and other examples into each search', async () => {
    const target = fixture(paragraph(ruby('明日', 'あした')), paragraph(text('明日へ')), paragraph(text('また明日'))).capture()
    const personal = [{ id: 'personal', surface: '明日', reading: 'みょうにち', source: 'personal' as const }]
    const result = await runBatchReadingSearch(target, personal, dictionary())
    expect(result.items).toHaveLength(2)
    for (const item of result.items) {
      expect(item.target.authorReadings.map(reading => reading.source)).toEqual(['document', 'personal'])
      expect(item.target.examples).toHaveLength(2)
      expect(item.result?.rankedCandidates.map(candidate => candidate.reading)).toEqual(expect.arrayContaining(['あした', 'みょうにち', 'あす']))
    }
  })

  it('retains uncertain fallback units and author candidates when morphology is unavailable', async () => {
    const provider = vi.fn<ReadingProvider>(async () => { throw new Error('ローカル解析に接続できません。') })
    const personal = [{ id: 'known', surface: '明日', reading: 'あした', source: 'personal' as const }]
    const result = await runBatchReadingSearch(fixture(paragraph(text('明日 空'))).capture(), personal, provider)
    expect(result.status).toBe('partial')
    expect(result.items.map(item => item.base)).toEqual(['明日', '空'])
    expect(result.items.every(item => item.error?.includes('区切り'))).toBe(true)
    expect(result.items[0].result?.rankedCandidates[0].reading).toBe('あした')
    expect(result.items[1].result?.rankedCandidates).toEqual([])
    expect(result.issues.some(issue => issue.includes('解析できません'))).toBe(true)
  })

  it('does not hide uncovered Han when token data is incomplete or malformed', async () => {
    for (const malformed of [false, true]) {
      const provider = dictionary()
      provider.mockImplementationOnce(async () => response([], [{ ...entry('明日', 'アス'), from: malformed ? 1 : 0, to: malformed ? 3 : 2 }], { truncated: true }))
      const result = await runBatchReadingSearch(fixture(paragraph(text('明日 空'))).capture(), [], provider)
      expect(result.items.map(item => item.base)).toEqual(['明日', '空'])
      expect(result.status).toBe('partial')
      expect(result.issues.length).toBeGreaterThan(0)
    }
  })

  it('keeps OOV words unresolved instead of turning token surface into a reading', async () => {
    const result = await runBatchReadingSearch(fixture(paragraph(text('未知'))).capture(), [], dictionary())
    expect(result.status).toBe('partial')
    expect(result.items[0]).toMatchObject({ base: '未知' })
    expect(result.items[0].result?.rankedCandidates).toEqual([])
  })

  it('marks the entire result stale when the dictionary changes between discovery and a word search', async () => {
    const original = dictionary()
    let calls = 0
    const provider: ReadingProvider = async (request, signal) => {
      const value = await original(request, signal)
      return { ...value, provider: { ...info, version: ++calls === 1 ? 'fixture-v1' : 'fixture-v2' } }
    }
    const result = await runBatchReadingSearch(fixture(paragraph(text('明日 空'))).capture(), [], provider)
    expect(result.status).toBe('stale')
    expect(result.issues.some(issue => issue.includes('辞書のバージョン'))).toBe(true)
    expect(result.items.every(item => !item.result?.rankedCandidates.length)).toBe(true)
    expect(calls).toBe(2)
  })

  it('also checks dictionary consistency between discovery requests', async () => {
    const original = dictionary()
    let calls = 0
    const provider: ReadingProvider = async (request, signal) => ({ ...(await original(request, signal)), provider: { ...info, version: `fixture-${++calls}` } })
    const result = await runBatchReadingSearch(fixture(paragraph(text('明日')), paragraph(text('空'))).capture(), [], provider)
    expect(result.status).toBe('stale')
    expect(result.completed).toBe(0)
  })

  it('cancels immediately before starting and while an uncooperative provider is pending', async () => {
    const controller = new AbortController()
    controller.abort()
    const untouched = dictionary()
    expect((await runBatchReadingSearch(fixture(paragraph(text('明日'))).capture(), [], untouched, controller.signal)).status).toBe('cancelled')
    expect(untouched).not.toHaveBeenCalled()
    const pending = new AbortController()
    const provider = vi.fn<ReadingProvider>(() => new Promise(() => {}))
    const run = runBatchReadingSearch(fixture(paragraph(text('明日'))).capture(), [], provider, pending.signal)
    pending.abort()
    expect((await run).status).toBe('cancelled')
    expect(provider).toHaveBeenCalledTimes(1)
  })

  it('enforces the total 60-second deadline, retaining unsearched items as unresolved', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
    try {
      const provider: ReadingProvider = () => new Promise(() => {})
      const run = runBatchReadingSearch(fixture(paragraph(text('明日 空 光 声 東京 𠮷野'))).capture(), [], provider)
      await vi.advanceTimersByTimeAsync(60_001)
      const result = await run
      expect(result.status).toBe('partial')
      expect(result.issues.some(issue => issue.includes('60秒'))).toBe(true)
      expect(result.items).toHaveLength(6)
      expect(result.completed).toBeLessThan(6)
      expect(result.items.some(item => item.result === null)).toBe(true)
    } finally { vi.useRealTimers() }
  })

  it('caps target count and explicitly reports every remaining selected word as deferred', async () => {
    const result = await runBatchReadingSearch(fixture(paragraph(text('空 '.repeat(MAX_BATCH_TARGETS + 1)))).capture(), [], dictionary())
    expect(result.items).toHaveLength(MAX_BATCH_TARGETS)
    expect(result.status).toBe('partial')
    expect(result.issues.some(issue => issue.includes('128件'))).toBe(true)
  })

  it('keeps all requests bounded and does not duplicate a word crossing a discovery chunk boundary', async () => {
    const value = `${'😀'.repeat(383)}明日空光${'あ'.repeat(900)}声`
    const { doc, capture } = fixture(paragraph(text(value)))
    const provider = dictionary()
    const result = await runBatchReadingSearch(capture(), [], provider)
    expect(result.items.map(item => item.base)).toEqual(['明日空光', '声'])
    for (const [request] of provider.mock.calls) {
      expect(request.text.length).toBeLessThanOrEqual(1024)
      expect(request.text).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/u)
    }
    expect(result.items[0].to).toBeLessThanOrEqual(result.items[1].from)
    expect(doc.textBetween(result.items[0].from, result.items[0].to)).toBe('明日空光')
  })

  it('leaves an excessively long unsegmented word unresolved instead of slicing its reading', async () => {
    const surface = '明'.repeat(65)
    const provider: ReadingProvider = async () => response([], [{ ...entry(surface, 'ア'.repeat(65)), from: 0, to: 65 }])
    const result = await runBatchReadingSearch(fixture(paragraph(text(surface))).capture(), [], provider)
    expect(result.items).toEqual([])
    expect(result.status).toBe('partial')
    expect(result.issues.some(issue => issue.includes('64文字'))).toBe(true)
  })
})
