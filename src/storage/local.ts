import { parseLyricsFile, serializeLyricsFile, type LyricsFile } from '../model/document'

const DATABASE_NAME = 'lyrics-studio'
const STORE_NAME = 'drafts'
const DRAFT_KEY = 'current'

function storageError(error: DOMException | null, action: string): Error {
  if (error?.name === 'QuotaExceededError') return new Error('自動保存できません：ブラウザーの保存容量が不足しています。ファイルに保存してください。')
  if (error?.name === 'SecurityError' || error?.name === 'NotAllowedError') return new Error('ブラウザーでローカル保存が許可されていません。ファイルに保存してください。')
  return new Error(`ローカル文書の${action}に失敗しました${error?.message ? `：${error.message}` : '。'}`)
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('この環境ではローカル自動保存を利用できません。ファイルに保存してください。'))
      return
    }
    const request = indexedDB.open(DATABASE_NAME, 1)
    let blocked = false
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME)
    }
    request.onerror = () => reject(storageError(request.error, '接続'))
    request.onblocked = () => {
      blocked = true
      reject(new Error('別のタブがローカル保存を使用しています。他のLyrics Studioタブを閉じてから再試行してください。'))
    }
    request.onsuccess = () => {
      if (blocked) { request.result.close(); return }
      request.result.onversionchange = () => request.result.close()
      resolve(request.result)
    }
  })
}

export async function loadDraft(): Promise<LyricsFile | null> {
  const database = await openDatabase()
  let raw: unknown
  try {
    raw = await new Promise<unknown>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readonly')
      const request = transaction.objectStore(STORE_NAME).get(DRAFT_KEY)
      transaction.oncomplete = () => resolve(request.result)
      transaction.onerror = () => reject(storageError(transaction.error ?? request.error, '読み込み'))
      transaction.onabort = () => reject(storageError(transaction.error, '読み込み'))
    })
  } finally {
    database.close()
  }
  if (raw === undefined) return null
  if (typeof raw !== 'string') throw new Error('自動保存データの形式が不正です。既存の保存データは削除されていません。')
  // Corrupt and future files are never silently replaced by a fresh document.
  return parseLyricsFile(raw)
}

export async function saveDraft(file: LyricsFile): Promise<void> {
  const raw = serializeLyricsFile(file)
  const database = await openDatabase()
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readwrite')
      const request = transaction.objectStore(STORE_NAME).put(raw, DRAFT_KEY)
      // A successful request is not a committed transaction; wait for completion.
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(storageError(transaction.error ?? request.error, '保存'))
      transaction.onabort = () => reject(storageError(transaction.error, '保存'))
    })
  } finally {
    database.close()
  }
}

/** Preserve the raw prior draft, including unreadable/future data, before replacement. */
export async function archiveDraft(): Promise<void> {
  const database = await openDatabase()
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readwrite')
      const store = transaction.objectStore(STORE_NAME)
      const request = store.get(DRAFT_KEY)
      request.onsuccess = () => {
        if (request.result !== undefined) {
          store.put(request.result, `recovery-${new Date().toISOString()}-${crypto.randomUUID()}`)
        }
      }
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(storageError(transaction.error ?? request.error, '回復用コピーの作成'))
      transaction.onabort = () => reject(storageError(transaction.error, '回復用コピーの作成'))
    })
  } finally {
    database.close()
  }
}
