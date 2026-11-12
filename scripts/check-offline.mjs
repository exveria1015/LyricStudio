/** Run against a production preview in a fresh browser profile, never a user's draft. */
import { chromium, expect } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import process from 'node:process'
import { log } from 'node:console'

const baseURL = process.argv[2] ?? 'http://127.0.0.1:4174/'
const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
    || (existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : undefined),
  headless: true,
})
const context = await browser.newContext({ locale: 'ja-JP', viewport: { width: 1600, height: 1000 }, acceptDownloads: true })
const page = await context.newPage()
page.setDefaultTimeout(10_000)
const pageErrors = []
page.on('pageerror', error => pageErrors.push(error.message))

try {
  await page.goto(baseURL)
  const editor = page.getByRole('textbox', { name: '歌詞エディター' })
  await expect(editor).toBeVisible()
  await page.waitForFunction(() => Boolean(globalThis.navigator.serviceWorker.controller), undefined, { timeout: 15_000 })
  const cachedAssets = await page.evaluate(async () => {
    const names = await globalThis.caches.keys()
    return Promise.all(names.filter(name => name.startsWith('lyrics-studio-offline-v1-')).map(async name => ({
      name, urls: (await (await globalThis.caches.open(name)).keys()).map(request => request.url),
    })))
  })
  expect(cachedAssets.length).toBeGreaterThan(0)

  await context.setOffline(true)
  await editor.fill('明日 Break the night')
  await page.locator('.unresolved-list button').filter({ hasText: '明日' }).click()
  await expect(page.locator('.selected-word')).toHaveText('明日')
  await page.getByLabel('読み（ひらがな・カタカナ）').fill('あした')
  await expect(page.getByRole('button', { name: '読みを適用', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: '読みを適用', exact: true }).click()
  await expect(editor.locator('rt')).toHaveText('あした')
  await expect(page.locator('.total-count')).toHaveText('全体 3 mora + 3 syl')
  await page.getByLabel('文書名').fill('オフライン検証')
  await expect(page.locator('.save-indicator')).toHaveText('この端末に保存済み')

  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: '保存', exact: true }).click()
  const download = await downloadPromise
  const exported = JSON.parse(await readFile(await download.path(), 'utf8'))
  const exportedNodes = exported.editorDocument.content.flatMap(paragraph => paragraph.content ?? [])
  expect(exportedNodes.map(node => node.text ?? '').join('')).toBe('明日 Break the night')
  expect(exportedNodes.flatMap(node => node.marks ?? [])).toContainEqual(expect.objectContaining({
    type: 'rubyReading', attrs: expect.objectContaining({ base: '明日', reading: 'あした' }),
  }))

  await page.reload({ waitUntil: 'domcontentloaded' })
  await expect(page.getByLabel('文書名')).toHaveValue('オフライン検証')
  await expect(editor.locator('rt')).toHaveText('あした')
  await expect(page.locator('.total-count')).toHaveText('全体 3 mora + 3 syl')
  await expect(page.locator('.save-indicator')).toHaveText('この端末に保存済み')

  await page.getByRole('button', { name: 'A/B比較', exact: true }).click()
  const paneA = page.locator('[data-pane="a"]')
  const paneB = page.locator('[data-pane="b"]')
  await paneB.getByRole('textbox', { name: '歌詞エディター' }).fill('Break the night')
  await page.getByLabel('文書名').fill('Offline translation B')
  const comparison = page.getByRole('region', { name: 'A/B 歌詞比較', exact: true })
  await comparison.getByRole('button', { name: 'B 1行目に空きを入れる', exact: true }).click()
  await page.getByRole('button', { name: '上下に分割', exact: true }).click()
  await expect(page.locator('.save-indicator')).toHaveText('この端末に保存済み')
  const workspaceDownloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: 'A/Bをまとめて保存', exact: true }).click()
  const workspaceDownload = await workspaceDownloadPromise
  const workspace = JSON.parse(await readFile(await workspaceDownload.path(), 'utf8'))
  expect(workspace.documents.a.editorDocument).toEqual(exported.editorDocument)
  expect(workspace.documents.b.title).toBe('Offline translation B')
  expect(workspace.comparison.alignment.rows).toEqual([{ left: 0, right: null }, { left: null, right: 0 }])
  await page.reload({ waitUntil: 'domcontentloaded' })
  await expect(page.getByLabel('文書名')).toHaveValue('Offline translation B')
  await expect(paneA.locator('rt')).toHaveText('あした')
  await expect(paneB.getByRole('textbox', { name: '歌詞エディター' })).toHaveText('Break the night')
  await expect(page.getByRole('separator', { name: 'ペインの分割位置' })).toHaveAttribute('aria-orientation', 'horizontal')
  await expect(comparison.locator('.comparison-table-row')).toHaveCount(2)
  await expect(comparison.locator('.comparison-guide')).toContainText('作者指定の行対応')
  expect(pageErrors).toEqual([])
  log(JSON.stringify({
    offlineReload: true, offlineRubyEdit: true, offlineDictionaryCount: '3 mora + 3 syl',
    offlineIndexedDBRestore: true, offlineNativeExport: true,
    offlineWorkspaceExport: true, offlineSplitAndAlignmentRestore: true, pageErrors, cachedAssets,
    exportedDocument: exported.editorDocument,
  }, null, 2))
} catch (error) {
  log(JSON.stringify({ failureDiagnostic: {
    editorText: await page.locator('.lyrics-editor').allTextContents().catch(() => null),
    selectedText: await page.locator('.selected-word').textContent().catch(() => null),
    readingValue: await page.getByLabel('読み（ひらがな・カタカナ）').inputValue().catch(() => null),
    activeElement: await page.evaluate(() => globalThis.document.activeElement?.outerHTML).catch(() => null),
  } }, null, 2))
  throw error
} finally {
  await context.close()
  await browser.close()
}
