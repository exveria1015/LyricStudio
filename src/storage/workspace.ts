import { createWorkspace, parseWorkspaceFile, serializeWorkspaceFile, type WorkspaceFile } from '../model/workspace'
import { loadDraft } from './local'
import { download } from './files'

const DATABASE_NAME = 'lyrics-studio'
const STORE_NAME = 'drafts'
const WORKSPACE_KEY = 'workspace-current'
const LEGACY_KEY = 'current'

function storageError(error: DOMException | null, action: string): Error {
  if (error?.name === 'QuotaExceededError') return new Error('ワークスペースを保存できません：ブラウザーの保存容量が不足しています。ファイルに保存してください。')
  if (error?.name === 'SecurityError' || error?.name === 'NotAllowedError') return new Error('ブラウザーでローカル保存が許可されていません。ワークスペースをファイルに保存してください。')
  return new Error(`ワークスペースの${action}に失敗しました${error?.message ? `：${error.message}` : '。'}`)
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('この環境ではローカル自動保存を利用できません。ワークスペースをファイルに保存してください。'))
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

/** A legacy draft is wrapped in memory only: migration never changes its saved bytes. */
export async function loadWorkspace(): Promise<WorkspaceFile | null> {
  const database = await openDatabase()
  let raw: unknown
  try {
    raw = await new Promise<unknown>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readonly')
      const request = transaction.objectStore(STORE_NAME).get(WORKSPACE_KEY)
      transaction.oncomplete = () => resolve(request.result)
      transaction.onerror = () => reject(storageError(transaction.error ?? request.error, '読み込み'))
      transaction.onabort = () => reject(storageError(transaction.error, '読み込み'))
    })
  } finally {
    database.close()
  }
  if (raw === undefined) {
    const legacy = await loadDraft()
    return legacy === null ? null : createWorkspace(legacy)
  }
  if (typeof raw !== 'string') throw new Error('ワークスペースの自動保存データが不正です。保存データは変更されていません。')
  // Never fall back to an old single document when a newer workspace is damaged.
  return parseWorkspaceFile(raw)
}

/** Read only: a damaged/future document must be exportable even when writes fail. */
export async function downloadStoredWorkspace(): Promise<void> {
  const database = await openDatabase()
  let raw: unknown
  let legacy = false
  try {
    raw = await new Promise<unknown>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readonly')
      const store = transaction.objectStore(STORE_NAME)
      const workspace = store.get(WORKSPACE_KEY)
      const draft = store.get(LEGACY_KEY)
      transaction.oncomplete = () => {
        legacy = workspace.result === undefined
        resolve(legacy ? draft.result : workspace.result)
      }
      transaction.onerror = () => reject(storageError(transaction.error, '読み込み'))
      transaction.onabort = () => reject(storageError(transaction.error, '読み込み'))
    })
  } finally { database.close() }
  if (raw === undefined) throw new Error('書き出せる自動保存データがありません。')
  if (typeof raw !== 'string') throw new Error('保存データが文字列ではないため、そのまま書き出せません。元データは変更していません。')
  download(raw, legacy ? '回復用-元データ.lyrics.json' : '回復用-元データ.lyrics-workspace.json', 'application/json;charset=utf-8')
}

/** A/B documents, active pane, layout and author pairing commit in one transaction. */
export async function saveWorkspace(workspace: WorkspaceFile): Promise<void> {
  const raw = serializeWorkspaceFile(workspace)
  const database = await openDatabase()
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readwrite')
      const request = transaction.objectStore(STORE_NAME).put(raw, WORKSPACE_KEY)
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(storageError(transaction.error ?? request.error, '保存'))
      transaction.onabort = () => reject(storageError(transaction.error, '保存'))
    })
  } finally {
    database.close()
  }
}

/** Archive exact raw bytes, including future/corrupt data, before explicit replacement. */
export async function archiveWorkspace(): Promise<void> {
  const database = await openDatabase()
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readwrite')
      const store = transaction.objectStore(STORE_NAME)
      const archive = (raw: unknown, source: string) => {
        try {
          if (raw !== undefined) store.put(raw, `recovery-${source}-${new Date().toISOString()}-${crypto.randomUUID()}`)
        } catch (error) {
          // Exceptions in an IDB event handler would otherwise escape to the
          // window. Abort the whole archive and surface the failure in the UI.
          reject(storageError(error instanceof DOMException ? error : null, '回復用コピーの作成'))
          transaction.abort()
        }
      }
      const request = store.get(WORKSPACE_KEY)
      request.onsuccess = () => archive(request.result, 'workspace')
      const legacy = store.get(LEGACY_KEY)
      legacy.onsuccess = () => archive(legacy.result, 'legacy')
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(storageError(transaction.error ?? request.error, '回復用コピーの作成'))
      transaction.onabort = () => reject(storageError(transaction.error, '回復用コピーの作成'))
    })
  } finally {
    database.close()
  }
}

export function downloadWorkspace(workspace: WorkspaceFile): void {
  const raw = serializeWorkspaceFile(workspace)
  const title = workspace.documents.a.title.replace(/[<>:"/\\|?*\p{Cc}]/gu, '_').replace(/[. ]+$/, '').trim()
  const url = URL.createObjectURL(new Blob([raw], { type: 'application/json;charset=utf-8' }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `${title || '無題の歌詞'}.lyrics-workspace.json`
  document.body.append(anchor)
  try { anchor.click() } finally {
    anchor.remove()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
}
