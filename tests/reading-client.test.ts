import { afterEach, describe, expect, it, vi } from 'vitest'
import { observeReadings, validateReadingResponse } from '../src/search/client'
import type { DictionaryEntry, ReadingProviderInfo, ReadingProviderResponse, ReadingToken } from '../src/search/types'

const provider: ReadingProviderInfo = {
  id: 'sudachi-full', edition: 'full', version: 'full-20261015+sudachipy-0.7.0', engineVersion: '0.7.0', dictionaryVersion: '20261015',
}
function entry(overrides: Partial<DictionaryEntry> = {}): DictionaryEntry {
  return {
    id: 'full-20261015+sudachipy-0.7.0:0:2237307', surface: '明日', reading: 'アシタ',
    normalizedForm: '明日', dictionaryForm: '明日', partOfSpeech: ['名詞', '普通名詞', '副詞可能', '*', '*', '*'],
    dictionaryId: 0, wordId: 2237307, isOov: false, ...overrides,
  }
}
function response(overrides: Partial<ReadingProviderResponse> = {}): ReadingProviderResponse {
  return { provider: { ...provider }, entries: [entry()], tokens: [], elapsedMs: 0.25, truncated: false, notes: ['lookup_indexed_entries_only'], ...overrides }
}
function token(overrides: Partial<ReadingToken> = {}): ReadingToken {
  return { ...entry(), from: 0, to: 2, ...overrides }
}
const invalidMessage = '読み解析サービスの応答形式を確認できませんでした。候補は採用していません。'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('validating local Sudachi observations at the browser boundary', () => {
  it('retains real dictionary IDs, provenance, alternative entries and explicit truncation', () => {
    const raw = response({
      entries: [entry(), entry({ id: 'other-reading', reading: 'ミョウニチ', wordId: 2237312 })],
      truncated: true, notes: ['lookup_indexed_entries_only', 'exact_entry_limit_128'],
    })
    expect(validateReadingResponse(raw, '明日')).toEqual(raw)
    expect(raw.entries.map(item => item.reading)).toEqual(['アシタ', 'ミョウニチ'])
  })

  it('accepts token coordinates in UTF-16 after non-BMP characters without treating OOV as known', () => {
    const raw = response({ entries: [], tokens: [
      token({ id: 'oov', surface: '𠮷', reading: '𠮷', from: 0, to: 2, dictionaryId: -1, wordId: 4026533388, isOov: true }),
      token({ id: 'emoji', surface: '😀', reading: 'ニンマリ', from: 2, to: 4 }),
      token({ from: 4, to: 6 }),
    ] })
    const validated = validateReadingResponse(raw, '𠮷😀明日')
    expect(validated.tokens[0]).toMatchObject({ from: 0, to: 2, wordId: 4026533388, isOov: true })
    expect(validated.tokens[2]).toMatchObject({ from: 4, to: 6, surface: '明日' })
  })

  it('retains a normalized lookup surface for the engine to distinguish from literal matches', () => {
    const raw = response({ entries: [entry({ surface: 'abc', reading: 'エービーシー' })], notes: ['lookup_input_normalized'] })
    expect(validateReadingResponse(raw, 'ＡＢＣ').entries[0].surface).toBe('abc')
  })

  it.each([
    ['null response', null], ['array response', []], ['missing fields', {}],
    ['missing provider', { ...response(), provider: null }],
    ['different source', { ...response(), provider: { ...provider, id: 'another-provider' } }],
    ['core edition', { ...response(), provider: { ...provider, edition: 'core' } }],
    ['missing combined version', { ...response(), provider: { ...provider, version: undefined } }],
    ['empty combined version', { ...response(), provider: { ...provider, version: '' } }],
    ['blank engine version', { ...response(), provider: { ...provider, engineVersion: '  ' } }],
    ['empty dictionary version', { ...response(), provider: { ...provider, dictionaryVersion: '' } }],
    ['oversized provider version', { ...response(), provider: { ...provider, version: 'v'.repeat(257) } }],
    ['oversized engine version', { ...response(), provider: { ...provider, engineVersion: 'v'.repeat(129) } }],
    ['negative elapsed time', { ...response(), elapsedMs: -1 }],
    ['non-finite elapsed time', { ...response(), elapsedMs: Infinity }],
    ['NaN elapsed time', { ...response(), elapsedMs: NaN }],
    ['untyped truncation', { ...response(), truncated: 'false' }],
    ['untyped note', { ...response(), notes: [123] }],
    ['oversized note', { ...response(), notes: ['n'.repeat(4097)] }],
    ['null entries', { ...response(), entries: null }],
    ['object tokens', { ...response(), tokens: {} }],
  ])('rejects %s without exposing the response body', (_name, raw) => {
    expect(() => validateReadingResponse(raw, '明日')).toThrow(invalidMessage)
  })

  it.each([
    ['string dictionary ID', { dictionaryId: '0' }],
    ['fractional word ID', { wordId: 1.5 }],
    ['unsafe word ID', { wordId: Number.MAX_SAFE_INTEGER + 1 }],
    ['untyped OOV flag', { isOov: 0 }],
    ['missing reading', { reading: undefined }],
    ['oversized reading', { reading: 'ア'.repeat(4097) }],
    ['oversized ID', { id: 'x'.repeat(257) }],
    ['invalid POS entry', { partOfSpeech: ['名詞', null] }],
    ['too many POS fields', { partOfSpeech: Array.from({ length: 13 }, () => '*') }],
    ['oversized POS field', { partOfSpeech: ['名'.repeat(129)] }],
  ])('rejects malformed dictionary metadata: %s', (_name, fields) => {
    expect(() => validateReadingResponse({ ...response(), entries: [{ ...entry(), ...fields }] }, '明日')).toThrow(invalidMessage)
  })

  it.each([
    ['negative start', { from: -1 }], ['fractional start', { from: 0.5 }],
    ['string start', { from: '0' }], ['inverted range', { from: 2, to: 1 }],
    ['empty range', { from: 0, to: 0, surface: '' }], ['outside input', { to: 3 }],
    ['wrong surface', { surface: '昨日' }], ['code-point offsets used as UTF-16', { surface: '😀', from: 0, to: 1 }],
  ])('rejects token coordinates that cannot certify a literal input slice: %s', (_name, fields) => {
    expect(() => validateReadingResponse({ ...response(), tokens: [{ ...token(), ...fields }] }, '明日')).toThrow(invalidMessage)
  })

  it('allows explicit capacity boundaries and rejects payloads beyond them', () => {
    const exact = response({ entries: Array.from({ length: 128 }, (_, index) => entry({ id: `entry-${index}` })) })
    expect(validateReadingResponse(exact, '明日').entries).toHaveLength(128)
    expect(() => validateReadingResponse({ ...exact, entries: [...exact.entries, entry()] }, '明日')).toThrow(invalidMessage)
    const text = 'あ'.repeat(1024)
    const context = response({ entries: [], tokens: Array.from({ length: 1024 }, (_, index) => token({ surface: 'あ', from: index, to: index + 1 })) })
    expect(validateReadingResponse(context, text).tokens).toHaveLength(1024)
    expect(() => validateReadingResponse({ ...context, tokens: [...context.tokens, token()] }, text)).toThrow(invalidMessage)
    expect(validateReadingResponse(response({ notes: Array.from({ length: 64 }, () => 'note') }), '明日').notes).toHaveLength(64)
    expect(() => validateReadingResponse(response({ notes: Array.from({ length: 65 }, () => 'note') }), '明日')).toThrow(invalidMessage)
  })

  it('preserves valid different versions so the search engine can detect changes between observations', () => {
    const nextProvider = { ...provider, version: 'full-next+sudachipy-next', engineVersion: 'next', dictionaryVersion: 'next' }
    expect(validateReadingResponse(response({ provider: nextProvider }), '明日').provider).toEqual(nextProvider)
  })
})

describe('same-origin reading provider transport', () => {
  it('posts only to the local proxy and preserves the exact text and requested split mode', async () => {
    const raw = response({ entries: [], tokens: [token({ surface: '𠮷野😀届かない', reading: '', from: 0, to: 9, isOov: true })] })
    const fetchMock = vi.fn().mockResolvedValue(Response.json(raw))
    vi.stubGlobal('fetch', fetchMock)
    const request = { kind: 'context' as const, text: '𠮷野😀届かない', mode: 'B' as const }
    expect(await observeReadings(request)).toEqual(raw)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/api/readings/observe')
    expect(options).toMatchObject({ method: 'POST', headers: { 'Content-Type': 'application/json' }, cache: 'no-store' })
    expect(JSON.parse(options.body as string)).toEqual(request)
    expect(options.signal?.aborted).toBe(false)
  })

  it.each([400, 404, 500, 503])('handles HTTP %i without rendering an untrusted server body', async status => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('private lyrics <script>unsafe()</script>', { status })))
    const failure = await observeReadings({ kind: 'exact', text: '明日' }).catch(error => error as Error)
    expect(failure).toBeInstanceOf(Error)
    expect(String(failure)).toContain('手動の読み設定は引き続き使えます')
    expect(String(failure)).not.toMatch(/private lyrics|<script>/)
  })

  it('turns network errors into an actionable local-service error without echoing their content', async () => {
    const cause = new Error('private lyrics or internal address')
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(cause))
    const failure = await observeReadings({ kind: 'exact', text: '明日' }).catch(error => error as Error)
    expect(String(failure)).toContain('ローカルのSudachi解析に接続できません')
    expect(String(failure)).not.toContain(cause.message)
  })

  it.each([
    ['HTML fallback', () => new Response('<!doctype html><title>private data</title>')],
    ['malformed JSON', () => new Response('{ private data')],
    ['wrong JSON shape', () => Response.json({ message: 'private data' })],
  ])('rejects %s without returning an apparently successful observation', async (_name, makeResponse) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeResponse()))
    await expect(observeReadings({ kind: 'exact', text: '明日' })).rejects.toThrow(invalidMessage)
  })

  it('propagates caller cancellation instead of misreporting service failure', async () => {
    vi.stubGlobal('fetch', vi.fn((_url: string, options: RequestInit) => new Promise<Response>((_resolve, reject) => {
      options.signal!.addEventListener('abort', () => reject(options.signal!.reason), { once: true })
    })))
    const controller = new AbortController()
    const pending = observeReadings({ kind: 'exact', text: '明日' }, controller.signal)
    const reason = new DOMException('Closed search', 'AbortError')
    controller.abort(reason)
    await expect(pending).rejects.toBe(reason)
  })

  it('forwards an already-aborted signal without reviving the cancelled search', async () => {
    const controller = new AbortController()
    const reason = new DOMException('Closed before request', 'AbortError')
    controller.abort(reason)
    const fetchMock = vi.fn((_url: string, options: RequestInit) => Promise.reject(options.signal!.reason))
    vi.stubGlobal('fetch', fetchMock)
    await expect(observeReadings({ kind: 'exact', text: '明日' }, controller.signal)).rejects.toBe(reason)
    expect((fetchMock.mock.calls[0][1] as RequestInit).signal?.aborted).toBe(true)
  })

  it('bounds request time and distinguishes timeout from caller cancellation', async () => {
    const timeout = new AbortController()
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeout.signal)
    vi.stubGlobal('fetch', vi.fn((_url: string, options: RequestInit) => new Promise<Response>((_resolve, reject) => {
      options.signal!.addEventListener('abort', () => reject(options.signal!.reason), { once: true })
    })))
    const pending = observeReadings({ kind: 'exact', text: '明日' })
    timeout.abort(new DOMException('Request timed out', 'TimeoutError'))
    await expect(pending).rejects.toThrow('ローカル解析が時間内に完了しませんでした')
    expect(timeoutSpy).toHaveBeenCalledWith(20_000)
  })
})
