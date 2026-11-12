import type { DictionaryEntry, ReadingProvider, ReadingProviderResponse, ReadingToken } from './types'

function invalid(): never { throw new Error('読み解析サービスの応答形式を確認できませんでした。候補は採用していません。') }
function string(value: unknown, limit = 4096): value is string { return typeof value === 'string' && value.length <= limit }
function entry(value: unknown): value is DictionaryEntry {
  if (!value || typeof value !== 'object') return false
  const e = value as DictionaryEntry
  return string(e.id, 256) && string(e.surface) && string(e.reading) && string(e.normalizedForm)
    && string(e.dictionaryForm) && Array.isArray(e.partOfSpeech) && e.partOfSpeech.length <= 12
    && e.partOfSpeech.every(part => string(part, 128)) && Number.isSafeInteger(e.dictionaryId)
    && Number.isSafeInteger(e.wordId) && typeof e.isOov === 'boolean'
}

export function validateReadingResponse(value: unknown, text: string): ReadingProviderResponse {
  if (!value || typeof value !== 'object') invalid()
  const result = value as ReadingProviderResponse
  const provider = result.provider
  if (!provider || provider.id !== 'sudachi-full' || provider.edition !== 'full'
    || !string(provider.version, 256) || !provider.version.trim()
    || !string(provider.engineVersion, 128) || !provider.engineVersion.trim()
    || !string(provider.dictionaryVersion, 128) || !provider.dictionaryVersion.trim()) invalid()
  if (!Array.isArray(result.entries) || result.entries.length > 128 || !result.entries.every(entry)) invalid()
  if (!Array.isArray(result.tokens) || result.tokens.length > 1024 || !result.tokens.every((token: ReadingToken) => entry(token)
    && Number.isSafeInteger(token.from) && Number.isSafeInteger(token.to) && token.from >= 0 && token.to > token.from
    && token.to <= text.length && text.slice(token.from, token.to) === token.surface)) invalid()
  if (!Number.isFinite(result.elapsedMs) || result.elapsedMs < 0 || typeof result.truncated !== 'boolean'
    || !Array.isArray(result.notes) || result.notes.length > 64 || !result.notes.every(note => string(note))) invalid()
  return result
}

/** Same-origin only: the server forwards to the local Sudachi Full process. */
export const observeReadings: ReadingProvider = async (request, signal) => {
  const timeout = AbortSignal.timeout(20_000)
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
  let response: Response
  try {
    response = await fetch(`${import.meta.env.BASE_URL}api/readings/observe`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request), signal: combined, cache: 'no-store',
    })
  } catch (cause) {
    if (signal?.aborted) throw cause
    throw new Error(timeout.aborted
      ? 'ローカル解析が時間内に完了しませんでした。再度探索できます。'
      : 'ローカルのSudachi解析に接続できません。npm run setup:readings で準備し、npm run dev または npm start で起動してください。', { cause })
  }
  if (!response.ok) throw new Error('SudachiDict Fullの解析を利用できません。ローカル解析プロセスの起動状態を確認してください。手動の読み設定は引き続き使えます。')
  let raw: unknown
  try { raw = await response.json() } catch { invalid() }
  return validateReadingResponse(raw, request.text)
}
