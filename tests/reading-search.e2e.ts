import { readFile } from 'node:fs/promises'
import { expect, test, type Page } from '@playwright/test'
import { createLyricsFile, documentToText, parseLyricsFile } from '../src/model/document'
import { createWorkspace, parseWorkspaceFile, serializeWorkspaceFile, type PaneId, type WorkspaceFile } from '../src/model/workspace'
import { createReadingMemory, parseReadingMemory, serializeReadingMemory } from '../src/model/readingMemory'

const pane = (page: Page, id: PaneId = 'a') => page.locator(`.document-pane[data-pane="${id}"]`)
const editor = (page: Page, id: PaneId = 'a') => pane(page, id).getByRole('textbox', { name: '歌詞エディター' })
const search = (page: Page) => page.getByRole('dialog', { name: '読み候補の探索', exact: true })
const library = (page: Page) => page.getByRole('dialog', { name: '個人読み辞書', exact: true })
const saved = (page: Page) => page.getByText('この端末に保存済み', { exact: true })

function fixture(): WorkspaceFile {
  return createWorkspace(createLyricsFile('[Verse 1]\n明日へ\n届かない声', '探索 A'), createLyricsFile('[Verse 1]\n明日をうたう', '探索 B'))
}

async function openStudio(page: Page, workspace?: WorkspaceFile) {
  await page.goto('/')
  await expect(saved(page)).toBeVisible()
  if (workspace) {
    await page.locator('input[type="file"]').setInputFiles({ name: 'search.lyrics-workspace.json', mimeType: 'application/json', buffer: Buffer.from(serializeWorkspaceFile(workspace)) })
    await expect(page.getByLabel('文書名')).toHaveValue(workspace.documents[workspace.activePane]!.title)
    await expect(saved(page)).toBeVisible()
  }
}

async function selectWord(page: Page, word: string, id: PaneId = 'a') {
  await page.locator('.document-switch').getByRole('button', { name: `${id.toUpperCase()} 歌詞${id.toUpperCase()}`, exact: true }).click()
  await editor(page, id).evaluate((element, word) => {
    ;(element as HTMLElement).focus()
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, {
      acceptNode: node => node.parentElement?.closest('rt, [contenteditable="false"]') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
    })
    const nodes: Text[] = []
    let text = ''
    for (let node = walker.nextNode(); node; node = walker.nextNode()) { nodes.push(node as Text); text += node.textContent }
    const start = text.indexOf(word)
    if (start < 0) throw new Error(`Text not found: ${word}`)
    const range = document.createRange()
    let offset = 0
    let started = false
    for (const node of nodes) {
      if (!started && start >= offset && start < offset + node.length) { range.setStart(node, start - offset); started = true }
      if (started && start + word.length <= offset + node.length) { range.setEnd(node, start + word.length - offset); break }
      offset += node.length
    }
    window.getSelection()!.removeAllRanges()
    window.getSelection()!.addRange(range)
    document.dispatchEvent(new Event('selectionchange'))
  }, word)
  await expect(page.locator('.selected-word')).toHaveText(word)
}

async function openSearch(page: Page) {
  await page.getByRole('button', { name: '読み候補を探す', exact: true }).click()
  await expect(search(page)).toBeVisible()
  return search(page)
}

async function openLibrary(page: Page) {
  await page.getByRole('menubar', { name: 'アプリケーションメニュー' }).getByRole('menuitem', { name: '編集', exact: true }).click()
  await page.getByRole('menu', { name: '編集', exact: true }).getByRole('menuitem', { name: '個人読み辞書', exact: true }).click()
  await expect(library(page)).toBeVisible()
  return library(page)
}

async function exportActive(page: Page) {
  const pending = page.waitForEvent('download')
  await page.getByRole('button', { name: '保存', exact: true }).click()
  return parseLyricsFile(await readFile((await (await pending).path())!, 'utf8'))
}

async function exportWorkspace(page: Page) {
  const pending = page.waitForEvent('download')
  await page.getByRole('button', { name: 'A/Bをまとめて保存', exact: true }).click()
  return parseWorkspaceFile(await readFile((await (await pending).path())!, 'utf8'))
}

test('real Sudachi Full presents three readings and target changes never apply a reading automatically', async ({ page, request }) => {
  const health = await request.get('/api/readings/health')
  expect(health.ok(), 'Start the real local Sudachi Full service before this suite').toBe(true)
  expect(await health.json()).toMatchObject({ available: true, provider: { id: 'sudachi-full', edition: 'full' } })
  await openStudio(page)
  const before = await exportActive(page)
  await page.locator('.unresolved-list button').filter({ hasText: '明日' }).click()
  const dialog = await openSearch(page)
  await expect(dialog.getByRole('status')).toContainText('探索完了')
  for (const [reading, mora] of [['あす', 2], ['あした', 3], ['みょうにち', 4]] as const) {
    const radio = dialog.getByRole('radio', { name: reading, exact: true })
    await expect(radio).toBeVisible()
    await expect(dialog.locator('.search-candidate').filter({ has: page.getByRole('radio', { name: reading, exact: true }) }).locator('.search-candidate-count')).toHaveText(`${mora}mora`)
  }
  await expect(dialog.getByRole('button', { name: 'この読みを採用', exact: true })).toBeDisabled()
  await expect(dialog.getByRole('checkbox', { name: '採用した読みを個人辞書に登録', exact: true })).not.toBeChecked()
  await dialog.getByRole('spinbutton', { name: '選択表記の目標モーラ', exact: true }).fill('3')
  await dialog.getByRole('button', { name: '条件を変えて探索', exact: true }).click()
  await expect(dialog.getByRole('status')).toContainText('探索完了')
  await expect(dialog.getByRole('radio', { name: 'あした', exact: true })).toBeVisible()
  await expect(dialog.locator('.search-candidate').filter({ has: page.getByRole('radio', { name: 'あした', exact: true }) })).toContainText('目標との差 0')
  await expect(dialog.getByRole('button', { name: 'この読みを採用', exact: true })).toBeDisabled()
  await dialog.getByRole('button', { name: '辞書順', exact: true }).click()
  await dialog.getByRole('button', { name: '探索順', exact: true }).click()
  await dialog.getByRole('button', { name: '保留して閉じる', exact: true }).click()
  expect(await exportActive(page)).toEqual(before)
  await openLibrary(page)
  await expect(library(page)).toContainText('0 件の採用記録')
})

test('context observation derives 届 from 届かない and adoption remains an undoable author annotation', async ({ page }) => {
  await openStudio(page, fixture())
  const before = await exportActive(page)
  await selectWord(page, '届')
  const dialog = await openSearch(page)
  await dialog.getByRole('radio', { name: 'とど', exact: true }).check()
  await dialog.getByRole('button', { name: 'この読みを採用', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await expect(editor(page).locator('ruby[data-reading-base="届"] rt')).toHaveText('とど')
  const native = await exportActive(page)
  expect(documentToText(native.editorDocument)).toBe(documentToText(before.editorDocument))
  expect(native.editorDocument.content![2].content!.find(node => node.text === '届')!.marks![0].attrs).toMatchObject({ base: '届', reading: 'とど', source: 'author_ruby' })
  await page.getByRole('menubar', { name: 'アプリケーションメニュー' }).getByRole('menuitem', { name: 'ファイル', exact: true }).click()
  const textDownload = page.waitForEvent('download')
  await page.getByRole('menu', { name: 'ファイル', exact: true }).getByRole('menuitem', { name: 'プレーンテキストを書き出す', exact: true }).click()
  expect(await readFile((await (await textDownload).path())!, 'utf8')).toBe(documentToText(before.editorDocument))
  await pane(page).getByRole('button', { name: '元に戻す', exact: true }).click()
  expect((await exportActive(page)).editorDocument).toEqual(before.editorDocument)
  await openLibrary(page)
  await expect(library(page)).toContainText('0 件の採用記録')
})

test('explicit personal registration targets B, survives reload, and exports and merges provenance', async ({ page }) => {
  const original = fixture()
  await openStudio(page, original)
  await selectWord(page, '明日', 'b')
  const dialog = await openSearch(page)
  await dialog.getByRole('radio', { name: 'あした', exact: true }).check()
  await dialog.getByRole('checkbox', { name: '採用した読みを個人辞書に登録', exact: true }).check()
  await dialog.getByRole('button', { name: 'この読みを採用', exact: true }).click()
  await expect(editor(page, 'b').locator('ruby[data-reading-base="明日"] rt')).toHaveText('あした')
  const workspace = await exportWorkspace(page)
  expect(workspace.documents.a).toEqual(original.documents.a)
  expect(workspace.documents.b!.documentId).toBe(original.documents.b!.documentId)
  await expect(saved(page)).toBeVisible()
  await page.reload()
  await expect(saved(page)).toBeVisible()
  await expect(editor(page, 'b').locator('ruby[data-reading-base="明日"] rt')).toHaveText('あした')
  const dictionary = await openLibrary(page)
  await expect(dictionary).toContainText('1 件の採用記録')
  const pending = page.waitForEvent('download')
  await dictionary.getByRole('button', { name: '辞書を書き出す', exact: true }).click()
  const raw = await readFile((await (await pending).path())!, 'utf8')
  const memory = parseReadingMemory(raw)
  expect(memory.records).toHaveLength(1)
  expect(memory.records[0]).toMatchObject({ surface: '明日', reading: 'あした', context: { documentId: original.documents.b!.documentId }, origin: { kind: 'candidate' } })
  expect(memory.records[0].origin.sources.length).toBeGreaterThan(0)
  expect(memory.records[0].origin.dictionaryVersion).toBeTruthy()
  await dictionary.getByLabel('個人読み辞書ファイル', { exact: true }).setInputFiles({ name: 'readings.json', mimeType: 'application/json', buffer: Buffer.from(raw) })
  await expect(dictionary).toContainText('1 件の採用記録')
  await dictionary.getByRole('button', { name: '採用記録 明日 あした を削除', exact: true }).click()
  await expect(dictionary).toContainText('0 件の採用記録')
  await dictionary.getByRole('button', { name: '閉じる', exact: true }).click()
  await expect(editor(page, 'b').locator('ruby[data-reading-base="明日"] rt')).toHaveText('あした')
})

test('retaining the current author reading does not replace it with a selected inference', async ({ page }) => {
  const workspace = fixture()
  workspace.documents.a.editorDocument.content![1].content = [
    { type: 'text', text: '明日', marks: [{ type: 'rubyReading', attrs: { id: 'original-reading', base: '明日', reading: 'あす', source: 'author_ruby' } }] },
    { type: 'text', text: 'へ' },
  ]
  await openStudio(page, workspace)
  await selectWord(page, '明日')
  const dialog = await openSearch(page)
  await dialog.getByRole('radio', { name: 'あした', exact: true }).check()
  await dialog.getByRole('button', { name: '現在の読みを維持', exact: true }).click()
  expect(await exportActive(page)).toEqual(workspace.documents.a)
})

test('partial ruby and syllable ranges cannot start a search while the full ruby range can be changed', async ({ page }) => {
  const workspace = fixture()
  workspace.documents.a.editorDocument.content![1].content = [
    { type: 'text', text: '明日', marks: [{ type: 'rubyReading', attrs: { id: 'whole-tomorrow', base: '明日', reading: 'あした', source: 'author_ruby' } }] },
    { type: 'text', text: 'へ' },
  ]
  workspace.documents.b = createLyricsFile('tomorrow', 'Existing syllables B')
  workspace.documents.b.editorDocument.content![0].content![0].marks = [
    { type: 'syllableOverride', attrs: { id: 'whole-english-word', base: 'tomorrow', syllables: 3, source: 'author_syllables' } },
  ]
  await openStudio(page, workspace)
  for (const [word, id] of [['明', 'a'], ['日へ', 'a'], ['tom', 'b']] as const) {
    await selectWord(page, word, id)
    await page.getByRole('button', { name: '読み候補を探す', exact: true }).click()
    await expect(search(page)).toHaveCount(0)
    await expect(pane(page, id).locator('.notification')).toContainText('既存の読みが付いた範囲全体を選択してください。')
    expect((await exportWorkspace(page)).documents).toEqual(workspace.documents)
  }
  await selectWord(page, '明日')
  const dialog = await openSearch(page)
  await dialog.getByRole('radio', { name: 'あす', exact: true }).check()
  await dialog.getByRole('button', { name: 'この読みを採用', exact: true }).click()
  await expect(editor(page).locator('ruby[data-reading-base="明日"] rt')).toHaveText('あす')
  const changed = await exportWorkspace(page)
  expect(changed.documents.b).toEqual(workspace.documents.b)
  expect(documentToText(changed.documents.a.editorDocument)).toBe(documentToText(workspace.documents.a.editorDocument))
  await pane(page).getByRole('button', { name: '元に戻す', exact: true }).click()
  expect((await exportActive(page)).editorDocument).toEqual(workspace.documents.a.editorDocument)
})

test('adopting from the dialog restores keyboard typing to the intended B editor', async ({ page }) => {
  const workspace = fixture()
  await openStudio(page, workspace)
  await selectWord(page, '明日', 'b')
  const dialog = await openSearch(page)
  await dialog.getByRole('radio', { name: 'あした', exact: true }).check()
  await dialog.getByRole('button', { name: 'この読みを採用', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await expect(editor(page, 'b')).toBeFocused()
  await page.keyboard.press('ArrowRight')
  await page.keyboard.insertText('!')
  const changed = await exportWorkspace(page)
  expect(documentToText(changed.documents.b!.editorDocument)).toBe('[Verse 1]\n明日!をうたう')
  expect(changed.documents.a).toEqual(workspace.documents.a)
  expect(changed.activePane).toBe('b')
})

test('provider failure still permits personal candidates and manual reading entry', async ({ page }) => {
  await openStudio(page, fixture())
  const memory = createReadingMemory()
  memory.records.push({ id: 'past-author', surface: '明日', reading: 'あす', acceptedAt: '2026-10-20T12:00:00Z', context: { documentId: 'past-song', before: '', after: '' }, origin: { kind: 'manual', sources: [] } })
  const dictionary = await openLibrary(page)
  await dictionary.getByLabel('個人読み辞書ファイル', { exact: true }).setInputFiles({ name: 'past.json', mimeType: 'application/json', buffer: Buffer.from(serializeReadingMemory(memory)) })
  await expect(dictionary).toContainText('1 件の採用記録')
  await dictionary.getByRole('button', { name: '閉じる', exact: true }).click()
  await page.route('**/api/readings/observe', route => route.abort('failed'))
  await selectWord(page, '明日')
  const dialog = await openSearch(page)
  await expect(dialog.getByRole('radio', { name: 'あす', exact: true })).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'この読みを採用', exact: true })).toBeDisabled()
  await dialog.getByRole('button', { name: '保留して閉じる', exact: true }).click()
  await page.getByLabel('読み（ひらがな・カタカナ）', { exact: true }).fill('あした')
  await page.getByRole('button', { name: '読みを適用', exact: true }).click()
  await expect(editor(page).locator('ruby[data-reading-base="明日"] rt')).toHaveText('あした')
})

test('manual registration is explicit and undo removes the annotation while retaining the adoption record', async ({ page }) => {
  await openStudio(page, fixture())
  await selectWord(page, '明日')
  const dialog = await openSearch(page)
  await dialog.getByRole('button', { name: '手動で入力', exact: true }).click()
  await expect(page.getByLabel('読み（ひらがな・カタカナ）', { exact: true })).toBeFocused()
  const remember = page.getByRole('checkbox', { name: '手動で適用した読みを個人辞書に登録', exact: true })
  await expect(remember).not.toBeChecked()
  await remember.check()
  await page.getByLabel('読み（ひらがな・カタカナ）', { exact: true }).fill('あす')
  await page.getByRole('button', { name: '読みを適用', exact: true }).click()
  await expect(editor(page).locator('ruby[data-reading-base="明日"] rt')).toHaveText('あす')
  await pane(page).getByRole('button', { name: '元に戻す', exact: true }).click()
  await expect(editor(page).locator('ruby[data-reading-base="明日"]')).toHaveCount(0)
  const dictionary = await openLibrary(page)
  await expect(dictionary).toContainText('1 件の採用記録')
  await expect(dictionary).toContainText('手動で登録')
  const pending = page.waitForEvent('download')
  await dictionary.getByRole('button', { name: '辞書を書き出す', exact: true }).click()
  const memory = parseReadingMemory(await readFile((await (await pending).path())!, 'utf8'))
  expect(memory.records[0].origin).toEqual({ kind: 'manual', sources: [] })
})

test('a late response from a closed search cannot replace a different current selection', async ({ page }) => {
  await openStudio(page, fixture())
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  let reached!: () => void
  const waiting = new Promise<void>(resolve => { reached = resolve })
  let delayed = false
  await page.route('**/api/readings/observe', async route => {
    const body = route.request().postDataJSON() as { kind: string; text: string }
    if (!delayed && body.kind === 'exact' && body.text === '明日') {
      delayed = true
      const response = await route.fetch()
      reached()
      await held
      try { await route.fulfill({ response }) } catch { /* Closing the dialog can abort its pending request. */ }
    } else await route.continue()
  })
  await selectWord(page, '明日')
  await openSearch(page)
  await waiting
  await search(page).getByRole('button', { name: '保留して閉じる', exact: true }).click()
  await selectWord(page, '届')
  const current = await openSearch(page)
  release()
  await expect(current.getByRole('radio', { name: 'とど', exact: true })).toBeVisible()
  await expect(current.getByRole('radio', { name: 'あした', exact: true })).toHaveCount(0)
  await current.getByRole('radio', { name: 'とど', exact: true }).check()
  await current.getByRole('button', { name: 'この読みを採用', exact: true }).click()
  await expect(editor(page).locator('ruby[data-reading-base="届"] rt')).toHaveText('とど')
  await expect(editor(page).locator('ruby[data-reading-base="明日"]')).toHaveCount(0)
})

test('corrupt personal memory remains exportable and does not block real dictionary observations', async ({ page }) => {
  await openStudio(page, fixture())
  const raw = '{ keep this damaged personal dictionary verbatim'
  await page.evaluate(async raw => {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open('lyrics-studio-readings', 1)
      request.onupgradeneeded = () => request.result.createObjectStore('library')
      request.onerror = () => reject(request.error)
      request.onsuccess = () => {
        const database = request.result
        const transaction = database.transaction('library', 'readwrite')
        transaction.objectStore('library').put(raw, 'current')
        transaction.oncomplete = () => { database.close(); resolve() }
        transaction.onabort = () => { database.close(); reject(transaction.error) }
      }
    })
  }, raw)
  await page.reload()
  await expect(saved(page)).toBeVisible()
  const dictionary = await openLibrary(page)
  await expect(dictionary.getByRole('alert')).toContainText('JSON')
  const pending = page.waitForEvent('download')
  await dictionary.getByRole('button', { name: '保存された元データを書き出す', exact: true }).click()
  expect(await readFile((await (await pending).path())!, 'utf8')).toBe(raw)
  await dictionary.getByRole('button', { name: '閉じる', exact: true }).click()
  await selectWord(page, '明日')
  await openSearch(page)
  await expect(search(page).getByRole('radio', { name: 'あした', exact: true })).toBeVisible()
  await search(page).getByRole('button', { name: '保留して閉じる', exact: true }).click()
  await openLibrary(page)
  await dictionary.getByRole('button', { name: '退避して空にする', exact: true }).click()
  await dictionary.getByRole('button', { name: '退避して初期化', exact: true }).click()
  await expect(dictionary).toContainText('0 件の採用記録')
  await expect(dictionary.getByRole('alert')).toHaveCount(0)
  const archived = await page.evaluate(async () => new Promise<unknown[]>((resolve, reject) => {
    const request = indexedDB.open('lyrics-studio-readings', 1)
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const database = request.result
      const transaction = database.transaction('library', 'readonly')
      const values = transaction.objectStore('library').getAll()
      transaction.oncomplete = () => { database.close(); resolve(values.result) }
      transaction.onabort = () => { database.close(); reject(transaction.error) }
    }
  }))
  expect(archived).toContain(raw)
})
