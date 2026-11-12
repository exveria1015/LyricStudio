import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createReadingMemory, MAX_READING_MEMORY_BYTES, MAX_READING_MEMORY_RECORDS,
  mergeReadingMemory, parseReadingMemory, serializeReadingMemory, validateAcceptedReading,
  type AcceptedReading, type ReadingMemoryFile,
} from '../src/model/readingMemory'
import { importReadingMemory, loadReadingMemory, recordAcceptedReading } from '../src/storage/readingMemory'

function accepted(id = 'accept-1', reading = 'あした'): AcceptedReading {
  return {
    id, surface: '明日', reading, acceptedAt: '2026-10-20T12:00:00.000Z',
    context: { documentId: 'song-a', before: '[Verse 1]\nきみと ', after: ' へ\nいこう' },
    origin: { kind: 'candidate', candidateId: 'sudachi-full:明日:あした', sources: ['dictionary'], dictionaryVersion: 'sudachi-full-test' },
  }
}

function memory(records: AcceptedReading[] = [accepted()]): ReadingMemoryFile {
  return { ...createReadingMemory(), records }
}

afterEach(() => vi.unstubAllGlobals())

describe('personal reading memory format', () => {
  it('roundtrips accepted evidence, original spelling, kana and multiline context', () => {
    const file = memory([accepted('event-a', 'アシタ')])
    const original = structuredClone(file)
    expect(parseReadingMemory(serializeReadingMemory(file))).toEqual(original)
    expect(file).toEqual(original)
    expect(file.records[0].reading).toBe('アシタ')
  })

  it('supports explicit manual adoption without inferred provenance', () => {
    const record = { ...accepted(), origin: { kind: 'manual' as const, sources: [] } }
    expect(parseReadingMemory(serializeReadingMemory(memory([record]))).records[0].origin).toEqual({ kind: 'manual', sources: [] })
  })

  it('keeps multiple author readings of the same surface and context', () => {
    const combined = mergeReadingMemory(memory(), memory([accepted('event-2', 'あす')]))
    expect(combined.records.map(record => record.reading)).toEqual(['あした', 'あす'])
  })

  it('merges idempotently while ignoring JSON key and source-set ordering', () => {
    const first = accepted()
    first.origin.sources = ['dictionary', 'personal_dictionary']
    const second = {
      origin: { dictionaryVersion: first.origin.dictionaryVersion, sources: [...first.origin.sources].reverse(), candidateId: first.origin.candidateId, kind: first.origin.kind },
      context: { after: first.context.after, before: first.context.before, documentId: first.context.documentId },
      acceptedAt: first.acceptedAt, reading: first.reading, surface: first.surface, id: first.id,
    }
    expect(mergeReadingMemory(memory([first]), memory([second]))).toEqual(memory([first]))
  })

  it('rejects event-ID collisions without changing either input', () => {
    const current = memory()
    const incoming = memory([accepted('accept-1', 'あす')])
    const original = structuredClone(current)
    expect(() => mergeReadingMemory(current, incoming)).toThrow('衝突')
    expect(current).toEqual(original)
    expect(incoming.records[0].reading).toBe('あす')
  })

  it('returns detached merged records instead of sharing mutable pane state', () => {
    const incoming = memory()
    const combined = mergeReadingMemory(createReadingMemory(), incoming)
    incoming.records[0].context.before = '変更'
    incoming.records[0].origin.sources.push('changed')
    expect(combined.records[0].context.before).toBe('[Verse 1]\nきみと ')
    expect(combined.records[0].origin.sources).toEqual(['dictionary'])
  })

  it.each(['{', 'null', '[]', '{}'])('rejects corrupt or missing native structures: %s', raw => {
    expect(() => parseReadingMemory(raw)).toThrow('個人読み辞書')
  })

  it.each([0, 2, '1'])('rejects incompatible schema version %s', schemaVersion => {
    expect(() => parseReadingMemory(JSON.stringify({ ...memory(), schemaVersion }))).toThrow('形式')
  })

  it('rejects unknown properties and prototype-like imported keys', () => {
    const file = JSON.parse(serializeReadingMemory(memory()))
    file.records[0].status = 'inferred_candidate'
    expect(() => parseReadingMemory(JSON.stringify(file))).toThrow('未対応の属性')
    expect(() => parseReadingMemory(serializeReadingMemory(memory()).replace('"surface":', '"__proto__": {}, "surface":'))).toThrow('未対応の属性')
  })

  it('rejects duplicate IDs within one file even when records are equal', () => {
    expect(() => serializeReadingMemory(memory([accepted(), accepted()]))).toThrow('IDが重複')
  })

  it.each(['', '明日', 'abc', '♪', 'あ\nす', 'あ\u0000す', 'あ'.repeat(513)])('rejects invalid reading %j', reading => {
    expect(() => validateAcceptedReading(accepted('event', reading))).toThrow()
  })

  it.each(['', 'あ'.repeat(65), '明\n日'])('bounds selection surface %j', surface => {
    expect(() => validateAcceptedReading({ ...accepted(), surface })).toThrow('surface')
  })

  it('bounds context and identifiers', () => {
    const record = accepted()
    record.context.before = 'あ'.repeat(65)
    expect(() => validateAcceptedReading(record)).toThrow('before')
    expect(() => validateAcceptedReading({ ...accepted(), id: 'i'.repeat(129) })).toThrow('.id')
  })

  it.each([
    { kind: 'inferred_candidate', sources: ['dictionary'] },
    { kind: 'candidate', sources: ['dictionary'] },
    { kind: 'candidate', candidateId: 'candidate', sources: [] },
    { kind: 'manual', candidateId: 'candidate', sources: [] },
    { kind: 'manual', sources: ['dictionary', 'dictionary'] },
    { kind: 'manual', sources: [], dictionaryVersion: null },
  ])('requires explicit valid adoption provenance: %j', origin => {
    expect(() => validateAcceptedReading({ ...accepted(), origin })).toThrow('origin')
  })

  it('rejects invalid dates and limits raw file size before JSON parsing', () => {
    expect(() => validateAcceptedReading({ ...accepted(), acceptedAt: 'yesterday' })).toThrow('acceptedAt')
    expect(() => parseReadingMemory(' '.repeat(MAX_READING_MEMORY_BYTES + 1))).toThrow('10 MB')
  })

  it('limits file and combined record counts without silently discarding history', () => {
    const first = memory(Array.from({ length: MAX_READING_MEMORY_RECORDS }, (_, index) => accepted(`id-${index}`)))
    expect(() => mergeReadingMemory(first, memory([accepted('one-more')]))).toThrow('20,000')
    expect(first.records).toHaveLength(MAX_READING_MEMORY_RECORDS)
  })
})

describe('reading-memory storage validation boundary', () => {
  it('rejects invalid imports and events before opening any database', async () => {
    const open = vi.fn()
    vi.stubGlobal('indexedDB', { open })
    await expect(importReadingMemory('{')).rejects.toThrow('JSON')
    await expect(recordAcceptedReading({ ...accepted(), reading: '漢字' })).rejects.toThrow('かな')
    expect(open).not.toHaveBeenCalled()
  })

  it('reports unavailable storage rather than pretending an empty dictionary was saved', async () => {
    vi.stubGlobal('indexedDB', undefined)
    await expect(loadReadingMemory()).rejects.toThrow('ローカル保存を利用できません')
    await expect(recordAcceptedReading(accepted())).rejects.toThrow('ローカル保存を利用できません')
  })
})
