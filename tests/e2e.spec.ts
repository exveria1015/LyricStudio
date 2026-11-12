import { readFile } from 'node:fs/promises'
import { expect, test, type Download, type Page } from '@playwright/test'
import { createLyricsFile, documentToText, parseLyricsFile, serializeLyricsFile } from '../src/model/document'
import { parseWorkspaceFile } from '../src/model/workspace'
import { moveCaretToEnd } from './keyboard'

const editor = (page: Page) => page.getByRole('textbox', { name: '歌詞エディター' })

async function openStudio(page: Page) {
  await page.goto('/')
  await expect(editor(page)).toBeVisible()
  await expect(page.getByText('この端末に保存済み', { exact: true })).toBeVisible()
}

/** Select rendered source text, excluding rt presentation; no application test hooks. */
async function selectWord(page: Page, word: string, occurrence = 0) {
  await editor(page).evaluate((element, { word, occurrence }) => {
    const root = element as HTMLElement
    root.focus()
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        return node.parentElement?.closest('rt, [contenteditable="false"]') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT
      },
    })
    const nodes: Text[] = []
    let text = ''
    let node = walker.nextNode()
    while (node) {
      nodes.push(node as Text)
      text += node.textContent
      node = walker.nextNode()
    }
    let start = -1
    for (let index = 0; index <= occurrence; index++) start = text.indexOf(word, start + 1)
    if (start < 0) throw new Error(`Rendered source word not found: ${word}`)
    const range = document.createRange()
    let offset = 0
    let startSet = false
    for (const textNode of nodes) {
      const end = offset + textNode.length
      if (!startSet && start >= offset && start < end) {
        range.setStart(textNode, start - offset)
        startSet = true
      }
      if (startSet && start + word.length <= end) {
        range.setEnd(textNode, start + word.length - offset)
        break
      }
      offset = end
    }
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    document.dispatchEvent(new Event('selectionchange'))
  }, { word, occurrence })
  await expect(page.locator('.selected-word')).toHaveText(word)
}

async function downloadText(download: Download) {
  const path = await download.path()
  if (!path) throw new Error('Browser download did not produce a local file')
  return readFile(path, 'utf8')
}

async function saveNative(page: Page) {
  const pending = page.waitForEvent('download')
  await page.getByRole('button', { name: '保存', exact: true }).click()
  const download = await pending
  expect(download.suggestedFilename()).toMatch(/\.lyrics\.json$/)
  return parseLyricsFile(await downloadText(download))
}

test('sample shows separate verified counts and unresolved readings', async ({ page }, testInfo) => {
  await openStudio(page)
  await expect(page.getByLabel('文書名')).toHaveValue('雨の向こうへ')
  await expect(page.locator('.section-item').filter({ hasText: 'Verse 1' })).toContainText('25 mora + 3 syl')
  await expect(page.locator('.unresolved-list strong')).toHaveText(['届', '明日'])
  await expect(page.locator('ruby[data-reading-base="響"] rt')).toHaveText('ひび')
  await expect(editor(page).locator('p').nth(3)).toHaveAttribute('data-count', '11 mora')
  const screenshot = testInfo.outputPath('studio.png')
  await page.screenshot({ path: screenshot, fullPage: true })
  await testInfo.attach('studio', { path: screenshot, contentType: 'image/png' })
})

test('DOM-selected reading applies, undoes, redoes and invalidates after source edit', async ({ page }) => {
  await openStudio(page)
  await selectWord(page, '明日')
  await page.getByLabel('読み（ひらがな・カタカナ）').fill('あす')
  await page.getByRole('button', { name: '読みを適用', exact: true }).click()
  const ruby = page.locator('ruby[data-reading-base="明日"]')
  await expect(ruby.locator('rt')).toHaveText('あす')
  await expect(page.locator('.unresolved-list strong')).toHaveText(['届'])
  await page.getByRole('button', { name: '元に戻す', exact: true }).click()
  await expect(ruby).toHaveCount(0)
  await expect(page.locator('.unresolved-list strong')).toHaveText(['届', '明日'])
  await page.getByRole('button', { name: 'やり直す', exact: true }).click()
  await expect(ruby.locator('rt')).toHaveText('あす')
  await selectWord(page, '明日')
  await editor(page).press('ArrowLeft')
  await editor(page).press('ArrowRight')
  await page.keyboard.insertText('る')
  await expect(ruby).toHaveCount(0)
  await expect(editor(page)).toContainText('明る日')
  await page.getByRole('button', { name: '元に戻す', exact: true }).click()
  await expect(ruby.locator('rt')).toHaveText('あす')
})

test('native and plain downloads preserve source while native keeps annotation provenance', async ({ page }) => {
  await openStudio(page)
  const native = await saveNative(page)
  expect(native.title).toBe('雨の向こうへ')
  const mark = native.editorDocument.content![1].content![0].marks![0]
  expect(mark.attrs).toMatchObject({ base: '響', reading: 'ひび', source: 'author_ruby' })
  await page.getByRole('button', { name: '書き出し' }).click()
  const pending = page.waitForEvent('download')
  await page.getByRole('button', { name: /プレーンテキスト/ }).click()
  const download = await pending
  expect(download.suggestedFilename()).toMatch(/\.txt$/)
  const plain = await downloadText(download)
  expect(plain).toBe(await readFile('examples/sample-lyrics.txt', 'utf8'))
  expect(plain).toBe(documentToText(native.editorDocument))
  expect(plain).not.toContain('ひび')
})

test('reading actions do not steal focus from the next title edit', async ({ page }) => {
  await openStudio(page)
  const original = documentToText((await saveNative(page)).editorDocument)
  for (let iteration = 0; iteration < 4; iteration++) {
    await selectWord(page, '明日')
    const reading = iteration % 2 ? 'あした' : 'あす'
    await page.getByLabel('読み（ひらがな・カタカナ）').fill(reading)
    await page.getByRole('button', { name: '読みを適用', exact: true }).click()
    await page.getByLabel('文書名').fill(`歌詞タイトル ${iteration}`)
    await expect(page.getByLabel('文書名')).toBeFocused()
    const saved = await saveNative(page)
    expect(saved.title).toBe(`歌詞タイトル ${iteration}`)
    expect(documentToText(saved.editorDocument)).toBe(original)
    await expect(page.locator('ruby[data-reading-base="明日"] rt')).toHaveText(reading)
  }
})

test('native import and reload preserve document and annotation identities and fullwidth spelling', async ({ page }) => {
  await openStudio(page)
  const file = createLyricsFile('［Chorus］\n明日　Rain\n', '再読み込み確認')
  file.documentId = 'imported-document-identity'
  file.editorDocument.content![1].content = [
    { type: 'text', text: '明日', marks: [{ type: 'rubyReading', attrs: { id: 'imported-reading-identity', base: '明日', reading: 'あした', source: 'author_ruby' } }] },
    { type: 'text', text: '　Rain' },
  ]
  file.settings.tagOverrides.Chorus = 'instruction'
  await page.locator('input[type="file"]').setInputFiles({ name: 'imported.lyrics.json', mimeType: 'application/json', buffer: Buffer.from(serializeLyricsFile(file)) })
  await expect(page.getByLabel('文書名')).toHaveValue('再読み込み確認')
  await expect(page.getByText('この端末に保存済み', { exact: true })).toBeVisible()
  await page.reload()
  await expect(page.getByLabel('文書名')).toHaveValue('再読み込み確認')
  await expect(page.locator('ruby[data-reading-id="imported-reading-identity"] rt')).toHaveText('あした')
  const saved = await saveNative(page)
  expect(saved.documentId).toBe(file.documentId)
  expect(saved.editorDocument).toEqual(file.editorDocument)
  expect(saved.settings).toEqual(file.settings)
  expect(saved.createdAt).toBe(file.createdAt)
})

test('invalid and future imports retain the current document and persisted draft', async ({ page }) => {
  await openStudio(page)
  const before = await saveNative(page)
  await page.locator('input[type="file"]').setInputFiles({ name: 'broken.lyrics.json', mimeType: 'application/json', buffer: Buffer.from('{not json') })
  await expect(page.getByRole('status')).toContainText('現在の文書は保持しています')
  await expect(page.getByLabel('文書名')).toHaveValue(before.title)
  const future = { ...before, schemaVersion: 99, title: '開いてはいけない未来版' }
  await page.locator('input[type="file"]').setInputFiles({ name: 'future.lyrics.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(future)) })
  await expect(page.getByRole('status')).toContainText('新しい形式')
  await expect(page.getByLabel('文書名')).toHaveValue(before.title)
  await page.reload()
  const after = await saveNative(page)
  expect(after).toEqual(before)
})

test('tag classification follows the parser across case changes and persists overrides', async ({ page }) => {
  await openStudio(page)
  const file = createLyricsFile('[chorus]\nかな', 'タグ分類')
  file.settings.tagOverrides.Chorus = 'instruction'
  await page.locator('input[type="file"]').setInputFiles({ name: 'tags.lyrics.json', mimeType: 'application/json', buffer: Buffer.from(serializeLyricsFile(file)) })
  await expect(page.getByLabel('文書名')).toHaveValue('タグ分類')
  await page.getByRole('button', { name: 'タグの分類' }).click()
  const tag = page.getByRole('dialog').locator('label').filter({ hasText: /^\[chorus\]/ }).getByRole('combobox')
  await expect(tag).toHaveValue('instruction')
  await tag.selectOption('section')
  await page.getByRole('button', { name: '閉じる', exact: true }).click()
  await expect(page.locator('.section-item')).toContainText('chorus')
  const saved = await saveNative(page)
  expect(saved.settings.tagOverrides).toEqual({ chorus: 'section' })
})

test('unreadable saved draft stays intact until explicit recovery archives its exact raw data', async ({ page }) => {
  await openStudio(page)
  const futureRaw = '{"format":"lyrics-studio-workspace","schemaVersion":42,"evidence":"そのまま残す"}'
  const legacyRaw = serializeLyricsFile(createLyricsFile('元の単独文書', '旧データ'))
  await page.evaluate(async ({ raw, legacy }) => {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open('lyrics-studio', 1)
      request.onsuccess = () => {
        const db = request.result
        const transaction = db.transaction('drafts', 'readwrite')
        transaction.objectStore('drafts').put(raw, 'workspace-current')
        transaction.objectStore('drafts').put(legacy, 'current')
        transaction.oncomplete = () => { db.close(); resolve() }
        transaction.onerror = () => reject(transaction.error)
      }
      request.onerror = () => reject(request.error)
    })
  }, { raw: futureRaw, legacy: legacyRaw })
  await page.reload()
  await expect(page.getByText('保存した文書を読み込めませんでした。', { exact: true })).toBeVisible()
  await expect(editor(page)).toHaveCount(0)
  await page.getByRole('button', { name: '元データを退避して新しい文書で開始' }).click()
  await expect(editor(page)).toBeVisible()
  await expect(page.getByText('この端末に保存済み', { exact: true })).toBeVisible()
  const records = await page.evaluate(async () => new Promise<Array<{ key: IDBValidKey; value: unknown }>>((resolve, reject) => {
    const request = indexedDB.open('lyrics-studio', 1)
    request.onsuccess = () => {
      const db = request.result
      const transaction = db.transaction('drafts', 'readonly')
      const store = transaction.objectStore('drafts')
      const keys = store.getAllKeys()
      const values = store.getAll()
      transaction.oncomplete = () => {
        db.close()
        resolve(keys.result.map((key, index) => ({ key, value: values.result[index] })))
      }
      transaction.onerror = () => reject(transaction.error)
    }
    request.onerror = () => reject(request.error)
  }))
  const archived = records.filter((record) => String(record.key).startsWith('recovery-'))
  expect(archived.some((record) => record.value === futureRaw)).toBe(true)
  expect(archived.some((record) => record.value === legacyRaw)).toBe(true)
  expect(records.find((record) => record.key === 'current')!.value).toBe(legacyRaw)
  const current = records.find((record) => record.key === 'workspace-current')
  expect(documentToText(parseWorkspaceFile(current!.value as string).documents.a.editorDocument)).toBe('')
})

test('tag completion follows keyboard selection, preserves fullwidth brackets and allows Escape', async ({ page }) => {
  await openStudio(page)
  await moveCaretToEnd(editor(page))
  await page.keyboard.insertText('[Cho')
  await expect(page.getByRole('listbox', { name: 'メタタグ候補' })).toBeVisible()
  await expect(page.getByRole('option', { name: 'Chorus セクション', exact: true })).toHaveAttribute('aria-selected', 'true')
  await editor(page).press('Enter')
  await expect(editor(page).locator('p').last()).toHaveText('[Chorus]')
  await expect(page.getByRole('listbox')).toHaveCount(0)
  await editor(page).press('Enter')
  await page.keyboard.insertText('［Bri')
  await editor(page).press('Enter')
  await expect(editor(page).locator('p').last()).toHaveText('［Bridge］')
  await editor(page).press('Enter')
  await page.keyboard.insertText('[')
  await expect(page.getByRole('listbox')).toBeVisible()
  await editor(page).press('Escape')
  await expect(page.getByRole('listbox')).toHaveCount(0)
  await expect(editor(page).locator('p').last()).toHaveText('[')
})

test('already loaded workspace edits, analyzes, saves and exports while offline', async ({ page, context }) => {
  await openStudio(page)
  await context.setOffline(true)
  await moveCaretToEnd(editor(page))
  await page.keyboard.insertText('かな')
  await expect(editor(page).locator('p').last()).toHaveAttribute('data-count', '2 mora')
  await page.getByLabel('文書名').fill('オフライン確認')
  await expect(page.getByText('この端末に保存済み', { exact: true })).toBeVisible()
  const file = await saveNative(page)
  expect(file.title).toBe('オフライン確認')
  expect(documentToText(file.editorDocument)).toMatch(/かな$/)
  await context.setOffline(false)
  await page.reload()
  await expect(page.getByLabel('文書名')).toHaveValue('オフライン確認')
  await expect(editor(page).locator('p').last()).toHaveAttribute('data-count', '2 mora')
})

test('Shift+Enter keeps independent line counts and preserves a native hardBreak', async ({ page }) => {
  await openStudio(page)
  await editor(page).press('Control+End')
  await page.keyboard.insertText('かな')
  await editor(page).press('Shift+Enter')
  await page.keyboard.insertText('きょう')
  const paragraph = editor(page).locator('p').last()
  await expect(paragraph).toHaveClass(/hard-break-paragraph/)
  await expect(paragraph.locator('.hard-break-count')).toHaveText(['2 mora', '2 mora'])
  await expect(paragraph.locator('.hard-break-line-marker')).toHaveCount(2)
  const file = await saveNative(page)
  expect(file.editorDocument.content!.at(-1)!.content).toEqual([
    { type: 'text', text: 'かな' }, { type: 'hardBreak' }, { type: 'text', text: 'きょう' },
  ])
  expect(documentToText(file.editorDocument)).toMatch(/かな\nきょう$/)
  await expect(page.getByText('この端末に保存済み', { exact: true })).toBeVisible()
  await page.reload()
  await expect(editor(page).locator('p').last().locator('.hard-break-count')).toHaveText(['2 mora', '2 mora'])
})
