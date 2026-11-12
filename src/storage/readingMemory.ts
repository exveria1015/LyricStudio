import {
  createReadingMemory, mergeReadingMemory, parseReadingMemory, serializeReadingMemory,
  validateAcceptedReading, type AcceptedReading, type ReadingMemoryFile,
} from '../model/readingMemory'

const DATABASE_NAME = 'lyrics-studio-readings'
const STORE_NAME = 'library'
const CURRENT_KEY = 'current'
const CHANNEL_NAME = 'lyrics-studio-reading-memory-changed'
const listeners = new Set<() => void>()
let channel: BroadcastChannel | null = null

function notify() {
  for (const listener of listeners) {
    // A subscriber must not turn a completed database commit into a reported failure.
    try { listener() } catch { /* Other subscribers still receive the invalidation. */ }
  }
}

export function subscribeReadingMemory(listener: () => void): () => void {
  listeners.add(listener)
  if (!channel && typeof BroadcastChannel !== 'undefined') {
    try {
      channel = new BroadcastChannel(CHANNEL_NAME)
      channel.onmessage = notify
    } catch { /* Local panes are still notified if cross-tab messaging is unavailable. */ }
  }
  return () => {
    listeners.delete(listener)
    if (!listeners.size) { channel?.close(); channel = null }
  }
}

function committed() {
  notify()
  try {
    if (channel) channel.postMessage('changed')
    else if (typeof BroadcastChannel !== 'undefined') {
      const sender = new BroadcastChannel(CHANNEL_NAME)
      sender.postMessage('changed')
      sender.close()
    }
  } catch { /* The durable write succeeded; a missed notification is not data loss. */ }
}

function storageError(error: DOMException | null, action: string): Error {
  if (error?.name === 'QuotaExceededError') return new Error('個人読み辞書を保存できません：ブラウザーの保存容量が不足しています。歌詞の読み指定は別に保存されます。')
  if (error?.name === 'SecurityError' || error?.name === 'NotAllowedError') return new Error('ブラウザーで個人読み辞書のローカル保存が許可されていません。')
  return new Error(`個人読み辞書の${action}に失敗しました${error?.message ? `：${error.message}` : '。'}元データは変更されていません。`)
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('この環境では個人読み辞書のローカル保存を利用できません。')); return }
    const request = indexedDB.open(DATABASE_NAME, 1)
    let blocked = false
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME)
    }
    request.onerror = () => reject(storageError(request.error, '接続'))
    request.onblocked = () => { blocked = true; reject(new Error('別のタブが個人読み辞書を使用しています。他のタブを閉じてから再試行してください。')) }
    request.onsuccess = () => {
      if (blocked) { request.result.close(); return }
      request.result.onversionchange = () => request.result.close()
      resolve(request.result)
    }
  })
}

function decode(raw: unknown): ReadingMemoryFile {
  if (raw === undefined) return createReadingMemory()
  if (typeof raw !== 'string') throw new Error('個人読み辞書の保存形式が不正です。元データは変更されていません。')
  return parseReadingMemory(raw)
}

export async function loadReadingMemoryRaw(): Promise<unknown> {
  const database = await openDatabase()
  try {
    return await new Promise<unknown>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readonly')
      const request = transaction.objectStore(STORE_NAME).get(CURRENT_KEY)
      transaction.oncomplete = () => resolve(request.result)
      transaction.onerror = () => reject(storageError(transaction.error ?? request.error, '読み込み'))
      transaction.onabort = () => reject(storageError(transaction.error, '読み込み'))
    })
  } finally { database.close() }
}

export async function loadReadingMemory(): Promise<ReadingMemoryFile> {
  return decode(await loadReadingMemoryRaw())
}

/** Mutation reads and writes inside one serialized transaction, never from a pane snapshot. */
async function update(transform: (current: ReadingMemoryFile) => ReadingMemoryFile, archive = false): Promise<ReadingMemoryFile> {
  const database = await openDatabase()
  try {
    const result = await new Promise<ReadingMemoryFile>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readwrite')
      const store = transaction.objectStore(STORE_NAME)
      const request = store.get(CURRENT_KEY)
      let next: ReadingMemoryFile
      let failure: unknown
      request.onsuccess = () => {
        try {
          // Only an explicitly requested archival reset may bypass corrupt/future data.
          next = transform(archive ? createReadingMemory() : decode(request.result))
          const raw = serializeReadingMemory(next)
          if (archive && request.result !== undefined) store.put(request.result, `recovery-${new Date().toISOString()}-${crypto.randomUUID()}`)
          store.put(raw, CURRENT_KEY)
        } catch (error) {
          failure = error
          transaction.abort()
        }
      }
      transaction.oncomplete = () => resolve(next!)
      transaction.onerror = () => reject(failure ?? storageError(transaction.error ?? request.error, '更新'))
      transaction.onabort = () => reject(failure ?? storageError(transaction.error, '更新'))
    })
    committed()
    return result
  } finally { database.close() }
}

export async function recordAcceptedReading(record: AcceptedReading): Promise<ReadingMemoryFile> {
  // Freeze the accepted evidence before awaiting a connection or another transaction.
  validateAcceptedReading(record)
  const incoming = parseReadingMemory(serializeReadingMemory({ ...createReadingMemory(), records: [record] }))
  return update(current => mergeReadingMemory(current, incoming))
}

export function removeAcceptedReading(id: string): Promise<ReadingMemoryFile> {
  if (typeof id !== 'string' || !id.trim() || id.length > 128 || /\p{Cc}/u.test(id)) return Promise.reject(new Error('削除する採用履歴のIDが不正です。'))
  return update(current => ({ ...current, records: current.records.filter(record => record.id !== id) }))
}

export async function importReadingMemory(raw: string): Promise<ReadingMemoryFile> {
  const incoming = parseReadingMemory(raw)
  return update(current => mergeReadingMemory(current, incoming))
}

export function resetReadingMemory(options: { archive?: boolean } = {}): Promise<ReadingMemoryFile> {
  return update(() => createReadingMemory(), options.archive === true)
}

/** Malformed JSON strings are returned verbatim for recovery, with no validation or rewrite. */
export async function exportReadingMemoryRaw(): Promise<string> {
  const raw = await loadReadingMemoryRaw()
  if (raw === undefined) return serializeReadingMemory(createReadingMemory())
  if (typeof raw === 'string') return raw
  // A foreign non-string IndexedDB value cannot be represented faithfully as native JSON.
  throw new Error('保存データがJSON文字列ではありません。「元データを退避して初期化」で元の値を保持できます。')
}

export function downloadReadingMemory(file: ReadingMemoryFile): void {
  const raw = serializeReadingMemory(file)
  const url = URL.createObjectURL(new Blob([raw], { type: 'application/json;charset=utf-8' }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = '個人読み辞書.lyrics-readings.json'
  document.body.append(anchor)
  try { anchor.click() } finally { anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000) }
}
