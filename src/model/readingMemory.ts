import { countMora } from '../analysis/mora'

/** A past author decision, never a declaration that this reading is universally correct. */
export interface AcceptedReading {
  id: string
  surface: string
  reading: string
  acceptedAt: string
  context: { documentId: string; before: string; after: string }
  origin: {
    kind: 'manual' | 'candidate'
    candidateId?: string
    sources: string[]
    dictionaryVersion?: string
  }
}

export interface ReadingMemoryFile {
  format: 'lyrics-studio-reading-memory'
  schemaVersion: 1
  records: AcceptedReading[]
}

export const MAX_READING_MEMORY_BYTES = 10 * 1024 * 1024
export const MAX_READING_MEMORY_RECORDS = 20_000

function fail(path: string, reason: string): never {
  throw new Error(`個人読み辞書を読み込めません（${path}）：${reason}`)
}

function object(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail(path, 'オブジェクトが必要です。')
  return value as Record<string, unknown>
}

function keys(value: Record<string, unknown>, required: string[], optional: string[], path: string) {
  for (const key of Object.keys(value)) {
    if (!required.includes(key) && !optional.includes(key)) fail(path, `未対応の属性「${key}」があります。`)
  }
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) fail(`${path}.${key}`, '必須項目がありません。')
  }
}

function string(value: unknown, path: string, limit: number, empty = false, lineBreaks = false): asserts value is string {
  if (typeof value !== 'string' || value.length > limit || (!empty && !value.trim()) || /\p{Cc}/u.test(lineBreaks ? value.replace(/[\r\n\t]/g, '') : value)) {
    fail(path, `${empty ? '空文字列または' : ''}制御文字を含まない${limit}文字以内の文字列が必要です。`)
  }
}

/** Validate without normalizing original spelling, kana or context. */
export function validateAcceptedReading(value: unknown, path = '採用履歴'): AcceptedReading {
  const record = object(value, path)
  keys(record, ['id', 'surface', 'reading', 'acceptedAt', 'context', 'origin'], [], path)
  string(record.id, `${path}.id`, 128)
  string(record.surface, `${path}.surface`, 64)
  string(record.reading, `${path}.reading`, 512)
  const mora = countMora(record.reading)
  if (!mora.complete || mora.confirmedMora === 0) fail(`${path}.reading`, '計数できるかなの読みが必要です。')
  string(record.acceptedAt, `${path}.acceptedAt`, 64)
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(record.acceptedAt)
    || !Number.isFinite(Date.parse(record.acceptedAt))) fail(`${path}.acceptedAt`, 'ISO 8601形式の日時が必要です。')
  const context = object(record.context, `${path}.context`)
  keys(context, ['documentId', 'before', 'after'], [], `${path}.context`)
  string(context.documentId, `${path}.context.documentId`, 256)
  string(context.before, `${path}.context.before`, 64, true, true)
  string(context.after, `${path}.context.after`, 64, true, true)
  const origin = object(record.origin, `${path}.origin`)
  keys(origin, ['kind', 'sources'], ['candidateId', 'dictionaryVersion'], `${path}.origin`)
  if (origin.kind !== 'manual' && origin.kind !== 'candidate') fail(`${path}.origin.kind`, 'manual または candidate が必要です。')
  if (!Array.isArray(origin.sources) || origin.sources.length > 16) fail(`${path}.origin.sources`, '16件以下の由来の配列が必要です。')
  const sources = new Set<string>()
  for (const source of origin.sources) {
    string(source, `${path}.origin.sources`, 128)
    if (sources.has(source)) fail(`${path}.origin.sources`, '由来が重複しています。')
    sources.add(source)
  }
  if (Object.prototype.hasOwnProperty.call(origin, 'candidateId')) string(origin.candidateId, `${path}.origin.candidateId`, 1024)
  if (Object.prototype.hasOwnProperty.call(origin, 'dictionaryVersion')) string(origin.dictionaryVersion, `${path}.origin.dictionaryVersion`, 256)
  if (origin.kind === 'candidate' && (!origin.candidateId || !origin.sources.length)) {
    fail(`${path}.origin`, '候補からの採用には候補IDと由来が必要です。')
  }
  if (origin.kind === 'manual' && origin.candidateId !== undefined) fail(`${path}.origin`, '手動入力に候補IDを指定できません。')
  return value as AcceptedReading
}

export function createReadingMemory(): ReadingMemoryFile {
  return { format: 'lyrics-studio-reading-memory', schemaVersion: 1, records: [] }
}

function validateFile(value: unknown): ReadingMemoryFile {
  const file = object(value, 'ルート')
  if (file.format !== 'lyrics-studio-reading-memory') fail('format', 'Lyrics Studioの個人読み辞書ではありません。')
  if (typeof file.schemaVersion === 'number' && file.schemaVersion > 1) fail('schemaVersion', '新しい形式です。対応するアプリで開いてください。元データは変更されません。')
  if (file.schemaVersion !== 1) fail('schemaVersion', '対応している形式バージョンは1です。')
  keys(file, ['format', 'schemaVersion', 'records'], [], 'ルート')
  if (!Array.isArray(file.records) || file.records.length > MAX_READING_MEMORY_RECORDS) fail('records', '採用履歴は20,000件以内の配列にしてください。')
  const ids = new Set<string>()
  file.records.forEach((value, index) => {
    const record = validateAcceptedReading(value, `records[${index}]`)
    if (ids.has(record.id)) fail(`records[${index}].id`, '採用履歴のIDが重複しています。')
    ids.add(record.id)
  })
  return value as ReadingMemoryFile
}

export function parseReadingMemory(raw: string): ReadingMemoryFile {
  if (typeof raw !== 'string') fail('JSON', 'JSON文字列が必要です。')
  if (new TextEncoder().encode(raw).length > MAX_READING_MEMORY_BYTES) fail('ファイル容量', '10 MBを超える辞書には対応していません。')
  let value: unknown
  try { value = JSON.parse(raw) } catch { fail('JSON', 'JSONが壊れています。元データは変更されません。') }
  return validateFile(value)
}

export function serializeReadingMemory(file: ReadingMemoryFile): string {
  validateFile(file)
  const raw = `${JSON.stringify(file, null, 2)}\n`
  if (new TextEncoder().encode(raw).length > MAX_READING_MEMORY_BYTES) fail('ファイル容量', '10 MBを超える辞書には対応していません。')
  return raw
}

function signature(record: AcceptedReading): string {
  // JSON property ordering is irrelevant to idempotency; evidence content is not.
  return JSON.stringify([record.surface, record.reading, record.acceptedAt,
    record.context.documentId, record.context.before, record.context.after,
    record.origin.kind, record.origin.candidateId ?? null, [...record.origin.sources].sort(), record.origin.dictionaryVersion ?? null])
}

/** Preserve competing readings and refuse to silently replace an existing event ID. */
export function mergeReadingMemory(current: ReadingMemoryFile, incoming: ReadingMemoryFile): ReadingMemoryFile {
  validateFile(current)
  validateFile(incoming)
  const records = new Map(current.records.map(record => [record.id, record]))
  for (const record of incoming.records) {
    const old = records.get(record.id)
    if (old && signature(old) !== signature(record)) fail('id', `採用履歴「${record.id}」が既存データと衝突しています。既存データは変更されません。`)
    if (!old) records.set(record.id, record)
  }
  const merged = { ...createReadingMemory(), records: [...records.values()] }
  // Reparse to detach caller-owned objects and validate the combined capacity.
  return parseReadingMemory(serializeReadingMemory(merged))
}
