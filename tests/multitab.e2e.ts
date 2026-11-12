import { expect, test, type Page } from '@playwright/test'
import type { WorkspaceFile } from '../src/model/workspace'

const editor = (page: Page) => page.getByRole('textbox', { name: '歌詞エディター', exact: true })
const waiting = (page: Page) => page.getByRole('status').filter({ hasText: '編集権を待っています' })
const lockName = 'lyrics-studio-workspace-editor'

// Read the committed record, rather than a saved indicator left over from the
// previous render. A waiting tab must not load or write an older snapshot.
async function storedDocument(page: Page) {
  return page.evaluate(() => new Promise<{ text: string; title: string } | null>((resolve, reject) => {
    const request = indexedDB.open('lyrics-studio', 1)
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const db = request.result
      const transaction = db.transaction('drafts', 'readonly')
      const record = transaction.objectStore('drafts').get('workspace-current')
      transaction.onabort = () => { db.close(); reject(transaction.error) }
      transaction.onerror = () => { db.close(); reject(transaction.error) }
      transaction.oncomplete = () => {
        db.close()
        if (!record.result) { resolve(null); return }
        try {
          const workspace = JSON.parse(record.result) as WorkspaceFile
          const document = workspace.documents.a
          const text = document.editorDocument.content?.map(paragraph =>
            paragraph.content?.map(node => node.type === 'hardBreak' ? '\n' : node.text ?? '').join('') ?? '',
          ).join('\n') ?? ''
          resolve({ text, title: document.title })
        } catch (error) { reject(error) }
      }
    }
  }))
}

async function expectQueued(page: Page, pendingCount: number) {
  await expect(waiting(page)).toBeVisible()
  await expect(editor(page)).toHaveCount(0)
  await expect(page.getByLabel('文書名')).toHaveCount(0)
  await expect.poll(async () => page.evaluate(async name => {
    const locks = await navigator.locks.query()
    return {
      held: locks.held?.filter(lock => lock.name === name).length,
      // Chrome may retain an aborted StrictMode request in this snapshot until
      // the lock can be granted. Count waiting tabs, not transient requests.
      pending: new Set(locks.pending?.filter(lock => lock.name === name).map(lock => lock.clientId)).size,
    }
  }, lockName)).toEqual({ held: 1, pending: pendingCount })
}

test('a second tab waits, then loads the latest saved lyrics when the editor tab closes', async ({ page, context }) => {
  await page.goto('/')
  await expect(editor(page)).toBeVisible()
  await editor(page).fill('かな')
  await expect.poll(async () => (await storedDocument(page))?.text).toBe('かな')

  const second = await context.newPage()
  await second.goto('/')
  await expectQueued(second, 1)

  const latest = 'かな追加した最新本文'
  await editor(page).fill(latest)
  await expect.poll(async () => (await storedDocument(page))?.text).toBe(latest)
  await expectQueued(second, 1)
  await page.close()

  await expect(editor(second)).toHaveText(latest)
  await expect(waiting(second)).toHaveCount(0)
  await second.getByLabel('文書名').fill('引き継いだタブのタイトル')
  await expect.poll(() => storedDocument(second)).toEqual({ text: latest, title: '引き継いだタブのタイトル' })
  await expect(second.getByText('この端末に保存済み', { exact: true })).toBeVisible()
  await second.reload()
  await expect(editor(second)).toHaveText(latest)
  await expect(second.getByLabel('文書名')).toHaveValue('引き継いだタブのタイトル')
})

test('closing a queued tab cancels its request without releasing the current editor lock', async ({ page, context }) => {
  await page.goto('/')
  await expect(editor(page)).toBeVisible()
  const cancelled = await context.newPage()
  await cancelled.goto('/')
  await expectQueued(cancelled, 1)
  const next = await context.newPage()
  await next.goto('/')
  await expectQueued(next, 2)

  await cancelled.close()
  await expectQueued(next, 1)
  await editor(page).fill('待機タブを閉じても編集中の歌詞を保持')
  await expect.poll(async () => (await storedDocument(page))?.text).toBe('待機タブを閉じても編集中の歌詞を保持')
  await expectQueued(next, 1)
  await page.close()

  await expect(editor(next)).toHaveText('待機タブを閉じても編集中の歌詞を保持')
  await expect(waiting(next)).toHaveCount(0)
  await editor(next).fill('引き継ぎ後も編集できる')
  await expect.poll(async () => (await storedDocument(next))?.text).toBe('引き継ぎ後も編集できる')
})
