import { readFile } from 'node:fs/promises'
import { expect, test, type Page } from '@playwright/test'
import { createLyricsFile, serializeLyricsFile } from '../src/model/document'
import { createWorkspace, serializeWorkspaceFile } from '../src/model/workspace'
import { createReadingMemory, serializeReadingMemory } from '../src/model/readingMemory'

const saved = (page: Page) => page.getByText('この端末に保存済み', { exact: true })
const browserErrors = new WeakMap<Page, string[]>()
test.beforeEach(({ page }) => {
  const errors: string[] = []
  browserErrors.set(page, errors)
  page.on('pageerror', error => errors.push(error.message))
})
test.afterEach(({ page }) => { expect(browserErrors.get(page)).toEqual([]) })

async function seedDraft(page: Page, key: string, raw: string) {
  await page.evaluate(({ key, raw }) => new Promise<void>((resolve, reject) => {
    const request = indexedDB.open('lyrics-studio', 1)
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const database = request.result
      const transaction = database.transaction('drafts', 'readwrite')
      transaction.objectStore('drafts').delete('workspace-current')
      transaction.objectStore('drafts').put(raw, key)
      transaction.oncomplete = () => { database.close(); resolve() }
      transaction.onabort = () => { database.close(); reject(transaction.error) }
    }
  }), { key, raw })
}

async function drafts(page: Page) {
  return page.evaluate(() => new Promise<unknown[]>((resolve, reject) => {
    const request = indexedDB.open('lyrics-studio', 1)
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const database = request.result
      const transaction = database.transaction('drafts', 'readonly')
      const values = transaction.objectStore('drafts').getAll()
      transaction.oncomplete = () => { database.close(); resolve(values.result) }
      transaction.onabort = () => { database.close(); reject(transaction.error) }
    }
  }))
}

test('uppercase JSON imports native readings and a complete workspace', async ({ page }) => {
  await page.goto('/')
  await expect(saved(page)).toBeVisible()
  const file = createLyricsFile('明日', '大文字拡張子')
  file.editorDocument.content![0].content![0].marks = [{ type: 'rubyReading', attrs: {
    id: 'uppercase-reading', base: '明日', reading: 'あす', source: 'author_ruby',
  } }]
  await page.locator('input[type="file"]').setInputFiles({ name: 'song.LYRICS.JSON', mimeType: 'application/json', buffer: Buffer.from(serializeLyricsFile(file)) })
  await expect(page.getByLabel('文書名', { exact: true })).toHaveValue(file.title)
  await expect(page.locator('ruby rt')).toHaveText('あす')
  const workspace = createWorkspace(file, createLyricsFile('rain', '歌詞Bも復元'))
  workspace.activePane = 'b'
  await page.locator('input[type="file"]').setInputFiles({ name: 'song.LYRICS-WORKSPACE.JSON', mimeType: 'application/json', buffer: Buffer.from(serializeWorkspaceFile(workspace)) })
  await expect(page.getByLabel('文書名', { exact: true })).toHaveValue('歌詞Bも復元')
  await expect(page.locator('.document-pane[data-pane="a"] ruby rt')).toHaveText('あす')
})

test('a later successful autosave clears its old failure message', async ({ page }) => {
  await page.goto('/')
  await expect(saved(page)).toBeVisible()
  await page.evaluate(() => {
    const put = IDBObjectStore.prototype.put
    IDBObjectStore.prototype.put = function (...args) {
      if (args[1] === 'workspace-current') {
        IDBObjectStore.prototype.put = put
        throw new DOMException('Injected full storage', 'QuotaExceededError')
      }
      return put.apply(this, args)
    }
  })
  await page.getByLabel('文書名', { exact: true }).fill('保存失敗を再現')
  await expect(page.getByRole('alert')).toContainText('自動保存できませんでした')
  await page.getByLabel('文書名', { exact: true }).fill('復旧後の歌詞')
  await expect(saved(page)).toBeVisible()
  await expect(page.getByRole('alert')).toHaveCount(0)
  await page.reload()
  await expect(page.getByLabel('文書名', { exact: true })).toHaveValue('復旧後の歌詞')
})

for (const key of ['workspace-current', 'current']) {
  test(`unreadable ${key} is exportable verbatim even when storage is full`, async ({ page }) => {
    await page.goto('/')
    await expect(saved(page)).toBeVisible()
    const raw = '{ 壊れた保存データ\r\n  keep spacing and 日本語  '
    await seedDraft(page, key, raw)
    await page.reload()
    await expect(page.getByText('保存した文書を読み込めませんでした。')).toBeVisible()
    await page.evaluate(() => {
      IDBObjectStore.prototype.put = () => { throw new DOMException('Injected full storage', 'QuotaExceededError') }
    })
    const pending = page.waitForEvent('download')
    await page.getByRole('button', { name: '保存された元データを書き出す', exact: true }).click()
    const download = await pending
    expect(await readFile((await download.path())!, 'utf8')).toBe(raw)
    expect(await drafts(page)).toContain(raw)
    await page.getByRole('button', { name: '元データを退避して新しい文書で開始', exact: true }).click()
    await expect(page.getByRole('textbox', { name: '歌詞エディター', exact: true })).toHaveCount(0)
    expect(await drafts(page)).toContain(raw)
    // A reload removes the injected failure. The retry must retain an archive.
    await page.reload()
    await page.getByRole('button', { name: '元データを退避して新しい文書で開始', exact: true }).click()
    await expect(saved(page)).toBeVisible()
    expect(await drafts(page)).toContain(raw)
  })
}

test('startup retry opens a repaired workspace without overwriting it', async ({ page }) => {
  await page.goto('/')
  await expect(saved(page)).toBeVisible()
  await seedDraft(page, 'workspace-current', '{ broken')
  await page.reload()
  await expect(page.getByText('保存した文書を読み込めませんでした。')).toBeVisible()
  await seedDraft(page, 'workspace-current', serializeWorkspaceFile(createWorkspace(createLyricsFile('修復した歌詞', '復旧確認'))))
  await page.getByRole('button', { name: '読み込みを再試行', exact: true }).click()
  await expect(page.getByLabel('文書名', { exact: true })).toHaveValue('復旧確認')
})

test('personal reading memory can show records beyond the first 200', async ({ page }) => {
  await page.goto('/')
  await expect(saved(page)).toBeVisible()
  await page.getByRole('menubar').getByRole('menuitem', { name: '編集', exact: true }).click()
  await page.getByRole('menu', { name: '編集', exact: true }).getByRole('menuitem', { name: '個人読み辞書', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '個人読み辞書', exact: true })
  const memory = createReadingMemory()
  memory.records = Array.from({ length: 201 }, (_, index) => ({
    id: `record-${index}`, surface: '明日', reading: 'あす', acceptedAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
    context: { documentId: 'test-document', before: `文脈${index}`, after: '' }, origin: { kind: 'manual', sources: [] },
  }))
  await dialog.getByLabel('個人読み辞書ファイル', { exact: true }).setInputFiles({ name: 'records.json', mimeType: 'application/json', buffer: Buffer.from(serializeReadingMemory(memory)) })
  await expect(dialog.locator('.reading-library-record')).toHaveCount(200)
  // Every record shares its surface and reading, so search cannot reveal #201.
  await dialog.getByRole('button', { name: 'さらに200件を表示', exact: true }).click()
  await expect(dialog.locator('.reading-library-record')).toHaveCount(201)
  await expect(dialog.locator('.reading-library-record').last()).toContainText('文脈0【明日】')
  await dialog.getByLabel('個人読み辞書を検索', { exact: true }).fill('存在しない表記')
  await expect(dialog.locator('.reading-library-record')).toHaveCount(0)
  await dialog.getByLabel('個人読み辞書を検索', { exact: true }).fill('')
  await expect(dialog.locator('.reading-library-record')).toHaveCount(200)
})
