import { readFile } from 'node:fs/promises'
import { expect, test, type Page } from '@playwright/test'
import type { Editor } from '@tiptap/core'
import { createLyricsFile, documentToText, parseLyricsFile } from '../src/model/document'
import { createWorkspace, parseWorkspaceFile, serializeWorkspaceFile, type PaneId, type WorkspaceFile } from '../src/model/workspace'
import { parseReadingMemory } from '../src/model/readingMemory'

const pane = (page: Page, id: PaneId = 'a') => page.locator(`.document-pane[data-pane="${id}"]`)
const editor = (page: Page, id: PaneId = 'a') => pane(page, id).getByRole('textbox', { name: '歌詞エディター' })
const batch = (page: Page) => page.getByRole('dialog', { name: '選択範囲の読みを一括設定', exact: true })
const saved = (page: Page) => page.getByText('この端末に保存済み', { exact: true })
const apply = (page: Page) => batch(page).getByRole('button', { name: '選んだ読みを一括適用', exact: true })
const browserErrors = new WeakMap<Page, string[]>()
test.beforeEach(({ page }) => {
  const errors: string[] = []
  browserErrors.set(page, errors)
  page.on('pageerror', error => errors.push(error.message))
})
test.afterEach(({ page }) => { expect(browserErrors.get(page)).toEqual([]) })

function protectedFixture(): WorkspaceFile {
  const a = createLyricsFile('[Verse 1]\n明日へ\n届かない声\n[Chorus]\n空と光\ntomorrow', '一括読み A')
  a.editorDocument.content![1].content = [
    { type: 'text', text: '明日', marks: [{ type: 'rubyReading', attrs: { id: 'keep-tomorrow', base: '明日', reading: 'あす', source: 'author_ruby' } }] },
    { type: 'text', text: 'へ' },
  ]
  a.editorDocument.content![5].content![0].marks = [{ type: 'syllableOverride', attrs: { id: 'keep-syllables', base: 'tomorrow', syllables: 3, source: 'author_syllables' } }]
  return createWorkspace(a, createLyricsFile('[Verse 1]\n明日と空', '一括読み B'))
}

async function openStudio(page: Page, workspace = protectedFixture()) {
  await page.goto('/')
  await expect(saved(page)).toBeVisible()
  await page.locator('input[type="file"]').setInputFiles({ name: 'batch.lyrics-workspace.json', mimeType: 'application/json', buffer: Buffer.from(serializeWorkspaceFile(workspace)) })
  await expect(page.getByLabel('文書名')).toHaveValue(workspace.documents[workspace.activePane]!.title)
  await expect(saved(page)).toBeVisible()
  return workspace
}

async function activate(page: Page, id: PaneId) {
  await page.locator('.document-switch').getByRole('button', { name: `${id.toUpperCase()} 歌詞${id.toUpperCase()}`, exact: true }).click()
}

async function selectAll(page: Page, id: PaneId = 'a') {
  await activate(page, id)
  await editor(page, id).focus()
  await editor(page, id).press('Control+a')
  await expect.poll(() => editor(page, id).evaluate(element => {
    const active = (element as HTMLElement & { editor: Editor }).editor
    return active.state.selection.to - active.state.selection.from
  })).toBeGreaterThan(0)
}

async function selectWord(page: Page, word: string, id: PaneId = 'a') {
  await activate(page, id)
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

async function openBatch(page: Page, fromMenu = false) {
  if (fromMenu) {
    await page.getByRole('menubar', { name: 'アプリケーションメニュー' }).getByRole('menuitem', { name: '編集', exact: true }).click()
    await page.getByRole('menu', { name: '編集', exact: true }).getByRole('menuitem', { name: '選択範囲の読みを一括設定', exact: true }).click()
  } else await page.getByRole('button', { name: '選択範囲の読みを一括設定', exact: true }).click()
  await expect(batch(page)).toBeVisible()
  return batch(page)
}

async function finishBatch(page: Page) {
  await expect(batch(page).getByRole('status')).toContainText('一括探索完了')
}

async function snapshot(page: Page, id: PaneId = 'a') {
  return editor(page, id).evaluate(element => (element as HTMLElement & { editor: Editor }).editor.getJSON())
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

test('real Full explores a multi-line selection and one undo removes only the explicitly adopted batch', async ({ page, request }) => {
  const health = await request.get('/api/readings/health')
  expect(health.ok(), 'Start the real local Sudachi Full service before this suite').toBe(true)
  expect(await health.json()).toMatchObject({ available: true, provider: { id: 'sudachi-full', edition: 'full' } })
  const original = await openStudio(page)
  await selectAll(page)
  const dialog = await openBatch(page, true)
  await finishBatch(page)
  const bases = await dialog.locator('.batch-reading-base').allTextContents()
  expect(bases).toEqual(['届か', '声', '空', '光'])
  await expect(dialog.getByRole('checkbox', { name: '一括採用した読みを個人辞書に登録', exact: true })).not.toBeChecked()
  expect(await snapshot(page)).toEqual(original.documents.a.editorDocument)
  await expect(apply(page)).toBeEnabled()
  await apply(page).click()
  await expect(dialog).toHaveCount(0)
  await expect(editor(page).locator('ruby')).toHaveCount(5)
  await expect(editor(page).locator('ruby[data-reading-id="keep-tomorrow"] rt')).toHaveText('あす')
  const adopted = await exportWorkspace(page)
  expect(documentToText(adopted.documents.a.editorDocument)).toBe(documentToText(original.documents.a.editorDocument))
  expect(adopted.documents.a.editorDocument.content![1]).toEqual(original.documents.a.editorDocument.content![1])
  expect(adopted.documents.a.editorDocument.content![5]).toEqual(original.documents.a.editorDocument.content![5])
  expect(adopted.documents.a.editorDocument.content![0]).toEqual(original.documents.a.editorDocument.content![0])
  expect(adopted.documents.a.editorDocument.content![3]).toEqual(original.documents.a.editorDocument.content![3])
  expect(adopted.documents.b).toEqual(original.documents.b)
  await pane(page).getByRole('button', { name: '元に戻す', exact: true }).click()
  expect((await exportActive(page)).editorDocument).toEqual(original.documents.a.editorDocument)
})

test('B candidate choices and a per-word hold affect only B and survive reload', async ({ page }) => {
  const original = await openStudio(page)
  await selectAll(page, 'b')
  const dialog = await openBatch(page)
  await finishBatch(page)
  const tomorrow = dialog.getByRole('combobox', { name: '「明日」の読み（2行目）', exact: true })
  const chosen = await tomorrow.locator('option').evaluateAll(options => (options.find(option => option.textContent?.includes('あした')) as HTMLOptionElement | undefined)?.value)
  expect(chosen).toBeTruthy()
  await tomorrow.selectOption(chosen!)
  const sky = dialog.getByRole('combobox', { name: '「空」の読み（2行目）', exact: true })
  const hold = await sky.locator('option').evaluateAll(options => (options.find(option => option.textContent?.includes('保留')) as HTMLOptionElement | undefined)?.value)
  expect(hold).toBeDefined()
  await sky.selectOption(hold!)
  expect(await snapshot(page, 'b')).toEqual(original.documents.b!.editorDocument)
  await apply(page).click()
  await expect(editor(page, 'b')).toBeFocused()
  await expect(editor(page, 'b').locator('ruby[data-reading-base="明日"] rt')).toHaveText('あした')
  await expect(editor(page, 'b').locator('ruby[data-reading-base="空"]')).toHaveCount(0)
  const adopted = await exportWorkspace(page)
  expect(adopted.documents.a).toEqual(original.documents.a)
  expect(documentToText(adopted.documents.b!.editorDocument)).toBe(documentToText(original.documents.b!.editorDocument))
  await expect(saved(page)).toBeVisible()
  await page.reload()
  await expect(saved(page)).toBeVisible()
  await expect(editor(page, 'b').locator('ruby[data-reading-base="明日"] rt')).toHaveText('あした')
  expect((await exportWorkspace(page)).documents).toEqual(adopted.documents)
})

test('a selected word fragment after an emoji derives only the selected reading', async ({ page }) => {
  const original = await openStudio(page, createWorkspace(createLyricsFile('😀届かない声', '部分選択')))
  await selectWord(page, '届')
  const dialog = await openBatch(page)
  await finishBatch(page)
  await expect(dialog.locator('.batch-reading-base')).toHaveText('届')
  await expect(dialog.getByRole('combobox')).toContainText('とど')
  await apply(page).click()
  await expect(editor(page).locator('ruby[data-reading-base="届"] rt')).toHaveText('とど')
  await expect(editor(page).locator('ruby')).toHaveCount(1)
  expect(documentToText((await exportActive(page)).editorDocument)).toBe(documentToText(original.documents.a.editorDocument))
})

test('holding every row prevents application and reselecting suggestions remains a preview', async ({ page }) => {
  const original = await openStudio(page)
  await selectAll(page)
  const dialog = await openBatch(page)
  await finishBatch(page)
  await dialog.getByRole('button', { name: 'すべて保留', exact: true }).click()
  await expect(apply(page)).toBeDisabled()
  for (const select of await dialog.getByRole('combobox').all()) await expect(select.locator('option:checked')).toContainText('保留')
  await dialog.getByRole('button', { name: '候補の先頭をまとめて選ぶ', exact: true }).click()
  await expect(apply(page)).toBeEnabled()
  expect(await snapshot(page)).toEqual(original.documents.a.editorDocument)
  await dialog.getByRole('button', { name: '選択範囲の読みを一括設定を閉じる', exact: true }).click()
  expect((await exportActive(page)).editorDocument).toEqual(original.documents.a.editorDocument)
})

test('closing while the provider is pending never annotates the old selection', async ({ page }) => {
  const original = await openStudio(page)
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  let reached!: () => void
  const waiting = new Promise<void>(resolve => { reached = resolve })
  await page.route('**/api/readings/observe', async route => {
    const response = await route.fetch()
    reached()
    await held
    try { await route.fulfill({ response }) } catch { /* A closed dialog aborts requests. */ }
  })
  await selectAll(page)
  const dialog = await openBatch(page)
  await waiting
  await expect(apply(page)).toBeDisabled()
  await dialog.getByRole('button', { name: '選択範囲の読みを一括設定を閉じる', exact: true }).click()
  await selectWord(page, '光')
  release()
  const next = await openBatch(page)
  await finishBatch(page)
  await expect(next.locator('.batch-reading-base')).toHaveText('光')
  expect(await snapshot(page)).toEqual(original.documents.a.editorDocument)
  await apply(page).click()
  await expect(editor(page).locator('ruby')).toHaveCount(2)
  await expect(editor(page).locator('ruby[data-reading-base="光"]')).toHaveCount(1)
  await expect(editor(page).locator('ruby[data-reading-base="届か"]')).toHaveCount(0)
})

test('a document change while results are pending invalidates the batch instead of applying obsolete ranges', async ({ page }) => {
  const original = await openStudio(page)
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  let reached!: () => void
  const waiting = new Promise<void>(resolve => { reached = resolve })
  await page.route('**/api/readings/observe', async route => {
    const response = await route.fetch()
    reached()
    await held
    try { await route.fulfill({ response }) } catch { /* Invalidated snapshots abort requests. */ }
  })
  await selectAll(page)
  const dialog = await openBatch(page)
  await waiting
  // A host-side editor transaction can arrive even while the modal owns focus.
  // This uses the real editor rather than an application-only test hook.
  await editor(page).evaluate(element => {
    const active = (element as HTMLElement & { editor: Editor }).editor
    active.view.dispatch(active.state.tr.insertText('!', active.state.doc.content.size - 1))
  })
  release()
  await expect(apply(page)).toBeDisabled()
  await expect(dialog).toContainText(/変わ|選び直/)
  await dialog.getByRole('button', { name: '選択範囲の読みを一括設定を閉じる', exact: true }).click()
  const changed = await exportActive(page)
  expect(documentToText(changed.editorDocument)).toBe(`${documentToText(original.documents.a.editorDocument)}!`)
  await expect(editor(page).locator('ruby')).toHaveCount(1)
})

test('an unavailable local provider leaves the document editable and cannot report an adoptable batch', async ({ page }) => {
  const original = await openStudio(page)
  await page.route('**/api/readings/observe', route => route.abort('failed'))
  await selectAll(page)
  const dialog = await openBatch(page)
  await finishBatch(page)
  await expect(dialog).toContainText(/接続|解析|失敗|利用でき/)
  await expect(apply(page)).toBeDisabled()
  expect(await snapshot(page)).toEqual(original.documents.a.editorDocument)
  await dialog.getByRole('button', { name: '選択範囲の読みを一括設定を閉じる', exact: true }).click()
  await editor(page).press('Control+End')
  await page.keyboard.insertText('!')
  const changed = await exportActive(page)
  expect(documentToText(changed.editorDocument)).toBe(`${documentToText(original.documents.a.editorDocument)}!`)
  await expect(editor(page).locator('ruby')).toHaveCount(1)
})

test('manual per-word readings are validated before one batch can be applied', async ({ page }) => {
  const original = await openStudio(page, createWorkspace(createLyricsFile('空と声', '一括手入力')))
  await selectAll(page)
  const dialog = await openBatch(page)
  await finishBatch(page)
  await dialog.getByRole('combobox', { name: '「声」の読み（1行目）', exact: true }).selectOption('manual')
  const manual = dialog.getByRole('textbox', { name: '「声」の手入力（1行目）', exact: true })
  await manual.fill('心')
  await expect(apply(page)).toBeDisabled()
  await expect(dialog).toContainText('ひらがな・カタカナで読みを指定してください。')
  expect(await snapshot(page)).toEqual(original.documents.a.editorDocument)
  await manual.fill('まごころ')
  await expect(apply(page)).toBeEnabled()
  await apply(page).click()
  await expect(editor(page).locator('ruby[data-reading-base="声"] rt')).toHaveText('まごころ')
  await expect(editor(page).locator('ruby')).toHaveCount(2)
  const changed = await exportActive(page)
  expect(documentToText(changed.editorDocument)).toBe('空と声')
  await pane(page).getByRole('button', { name: '元に戻す', exact: true }).click()
  expect((await exportActive(page)).editorDocument).toEqual(original.documents.a.editorDocument)
})

test('explicit batch registration records every accepted word and lyric undo keeps that author history', async ({ page }) => {
  const original = await openStudio(page, createWorkspace(createLyricsFile('空と光', '一括採用記録')))
  await selectAll(page)
  const dialog = await openBatch(page)
  await finishBatch(page)
  await dialog.getByRole('checkbox', { name: '一括採用した読みを個人辞書に登録', exact: true }).check()
  await apply(page).click()
  await expect(editor(page).locator('ruby')).toHaveCount(2)
  await pane(page).getByRole('button', { name: '元に戻す', exact: true }).click()
  expect((await exportActive(page)).editorDocument).toEqual(original.documents.a.editorDocument)
  await page.getByRole('menubar', { name: 'アプリケーションメニュー' }).getByRole('menuitem', { name: '編集', exact: true }).click()
  await page.getByRole('menu', { name: '編集', exact: true }).getByRole('menuitem', { name: '個人読み辞書', exact: true }).click()
  const dictionary = page.getByRole('dialog', { name: '個人読み辞書', exact: true })
  await expect(dictionary).toContainText('2 件の採用記録')
  const pending = page.waitForEvent('download')
  await dictionary.getByRole('button', { name: '辞書を書き出す', exact: true }).click()
  const memory = parseReadingMemory(await readFile((await (await pending).path())!, 'utf8'))
  expect(memory.records.map(record => record.surface).sort()).toEqual(['光', '空'])
  for (const record of memory.records) {
    expect(record.context.documentId).toBe(original.documents.a.documentId)
    expect(record.origin.kind).toBe('candidate')
    expect(record.origin.dictionaryVersion).toContain('full-')
    expect(record.origin.sources.length).toBeGreaterThan(0)
  }
})

test('cancelling pending exploration rejects late responses and a fresh search can recover', async ({ page }) => {
  const original = await openStudio(page, createWorkspace(createLyricsFile('空と光', '中止と再探索')))
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  let reached!: () => void
  const waiting = new Promise<void>(resolve => { reached = resolve })
  await page.route('**/api/readings/observe', async route => {
    const response = await route.fetch()
    reached()
    await held
    try { await route.fulfill({ response }) } catch { /* Cancellation may abort the response. */ }
  })
  await selectAll(page)
  const dialog = await openBatch(page)
  await waiting
  await dialog.getByRole('button', { name: '一括探索を中止', exact: true }).click()
  await expect(dialog.getByRole('status')).toContainText('一括探索を中止しました')
  await expect(apply(page)).toBeDisabled()
  release()
  await page.waitForLoadState('networkidle')
  await expect(dialog.getByRole('status')).toContainText('一括探索を中止しました')
  await expect(apply(page)).toBeDisabled()
  expect(await snapshot(page)).toEqual(original.documents.a.editorDocument)
  await dialog.getByRole('button', { name: 'もう一度探索', exact: true }).click()
  await finishBatch(page)
  await expect(dialog.locator('.batch-reading-base')).toHaveText(['空', '光'])
  await expect(apply(page)).toBeEnabled()
  await apply(page).click()
  await expect(editor(page).locator('ruby')).toHaveCount(2)
  expect(documentToText((await exportActive(page)).editorDocument)).toBe('空と光')
})
