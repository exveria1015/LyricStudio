import { readFile } from 'node:fs/promises'
import { expect, test, type Page } from '@playwright/test'
import { createLyricsFile, documentToText, parseLyricsFile, serializeLyricsFile } from '../src/model/document'
import { createWorkspace, parseWorkspaceFile, serializeWorkspaceFile, type PaneId, type WorkspaceFile } from '../src/model/workspace'
import { moveCaretToEnd } from './keyboard'

const pane = (page: Page, id: PaneId) => page.locator(`.document-pane[data-pane="${id}"]`)
const editor = (page: Page, id: PaneId) => pane(page, id).getByRole('textbox', { name: '歌詞エディター' })
const saved = (page: Page) => page.getByText('この端末に保存済み', { exact: true })

function fixture() {
  const a = createLyricsFile('[Verse 1]\n明日\nきょう\n\n[Verse 2]\nあす\nひかり', '原詞 A')
  a.editorDocument.content![1].content![0].marks = [{ type: 'rubyReading', attrs: { id: 'fixture-reading', base: '明日', reading: 'あす', source: 'author_ruby' } }]
  const b = createLyricsFile('[Verse 1]\nrain\nlight', 'English B')
  return createWorkspace(a, b)
}

async function openWorkspace(page: Page, file = fixture()) {
  await page.goto('/')
  await expect(saved(page)).toBeVisible()
  await page.locator('input[type="file"]').setInputFiles({ name: 'test.lyrics-workspace.json', mimeType: 'application/json', buffer: Buffer.from(serializeWorkspaceFile(file)) })
  await expect(page.getByLabel('文書名')).toHaveValue(file.documents[file.activePane]!.title)
  await expect(saved(page)).toBeVisible()
  return file
}

async function activate(page: Page, id: PaneId) {
  await page.locator('.document-switch').getByRole('button', { name: `${id.toUpperCase()} 歌詞${id.toUpperCase()}`, exact: true }).click()
  await expect(pane(page, id)).toHaveClass(/active-pane/)
}

async function selectWord(page: Page, id: PaneId, word: string) {
  await activate(page, id)
  await editor(page, id).evaluate((element, word) => {
    const root = element as HTMLElement
    root.focus()
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
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

async function exportWorkspace(page: Page) {
  const pending = page.waitForEvent('download')
  await page.getByRole('button', { name: 'A/Bをまとめて保存', exact: true }).click()
  const download = await pending
  expect(download.suggestedFilename()).toMatch(/\.lyrics-workspace\.json$/)
  return parseWorkspaceFile(await readFile((await download.path())!, 'utf8'))
}

async function exportActive(page: Page) {
  const pending = page.waitForEvent('download')
  await page.getByRole('button', { name: '保存', exact: true }).click()
  const download = await pending
  expect(download.suggestedFilename()).toMatch(/\.lyrics\.json$/)
  return parseLyricsFile(await readFile((await download.path())!, 'utf8'))
}

test('split panes edit and undo independently and the shared inspector follows the active pane', async ({ page }) => {
  await openWorkspace(page)
  await expect(editor(page, 'a')).toBeVisible()
  await expect(editor(page, 'b')).toBeVisible()
  await moveCaretToEnd(editor(page, 'a'))
  await page.keyboard.insertText('うた')
  await moveCaretToEnd(editor(page, 'b'))
  await page.keyboard.insertText(' night')
  await expect(page.getByLabel('文書名')).toHaveValue('English B')
  await pane(page, 'b').getByRole('button', { name: '元に戻す', exact: true }).click()
  await expect(editor(page, 'b').locator('p').last()).toHaveText('light')
  await expect(editor(page, 'a').locator('p').last()).toHaveText('ひかりうた')
  await pane(page, 'b').getByRole('button', { name: 'やり直す', exact: true }).click()
  await pane(page, 'a').getByRole('button', { name: '元に戻す', exact: true }).click()
  await expect(editor(page, 'a').locator('p').last()).toHaveText('ひかり')
  await expect(editor(page, 'b').locator('p').last()).toHaveText('light night')
  await selectWord(page, 'a', '明日')
  await expect(page.getByLabel('読み（ひらがな・カタカナ）')).toHaveValue('あす')
  await selectWord(page, 'b', 'rain')
  await expect(page.getByLabel('読み（ひらがな・カタカナ）')).toHaveValue('')
  await page.getByRole('button', { name: '英語の音節数', exact: true }).click()
  await page.getByLabel('作者指定のシラブル数').fill('2')
  await page.getByRole('button', { name: '読みを適用', exact: true }).click()
  await expect(editor(page, 'b').locator('[data-lyric-syllables="2"]')).toHaveText('rain')
  await expect(editor(page, 'a').locator('ruby[data-reading-base="明日"] rt')).toHaveText('あす')
  await activate(page, 'a')
  await expect(page.getByLabel('読み（ひらがな・カタカナ）')).toHaveValue('あす')
  expect((await exportWorkspace(page)).documents.b!.editorDocument.content![1].content![0].marks![0].attrs!.source).toBe('author_syllables')
})

test('both split orientations resize by keyboard and single-pane mode keeps hidden B through reload', async ({ page }) => {
  await openWorkspace(page)
  const divider = page.getByRole('separator', { name: 'ペインの分割位置' })
  await expect(divider).toHaveAttribute('aria-orientation', 'vertical')
  await divider.press('ArrowRight')
  await expect(divider).toHaveAttribute('aria-valuenow', '55')
  await page.getByRole('button', { name: '上下に分割', exact: true }).click()
  await expect(divider).toHaveAttribute('aria-orientation', 'horizontal')
  await divider.press('ArrowDown')
  await expect(divider).toHaveAttribute('aria-valuenow', '60')
  await editor(page, 'b').press('Control+End')
  await page.keyboard.insertText(' forever')
  await page.getByLabel('文書名').fill('保存するB')
  await page.getByRole('button', { name: '単一ペイン', exact: true }).click()
  await expect(pane(page, 'a')).toBeHidden()
  await expect(editor(page, 'b')).toBeVisible()
  await activate(page, 'a')
  await expect(editor(page, 'a')).toBeVisible()
  await expect(pane(page, 'b')).toBeHidden()
  await expect(saved(page)).toBeVisible()
  await page.reload()
  await expect(saved(page)).toBeVisible()
  await expect(pane(page, 'b')).toBeHidden()
  await activate(page, 'b')
  await expect(page.getByLabel('文書名')).toHaveValue('保存するB')
  await expect(editor(page, 'b').locator('p').last()).toHaveText('light forever')
  const workspace = await exportWorkspace(page)
  expect(workspace.layout.mode).toBe('single')
  expect(workspace.layout.ratio).toBeCloseTo(.6)
  expect(documentToText(workspace.documents.a.editorDocument)).toContain('明日')
  expect(documentToText(workspace.documents.b!.editorDocument)).toContain('light forever')
  await page.getByRole('button', { name: '左右に分割', exact: true }).click()
  await expect(editor(page, 'a')).toBeVisible()
  await expect(editor(page, 'b')).toBeVisible()
})

test('workspace roundtrip preserves IDs and single native saving and importing target only the active pane', async ({ page }) => {
  const original = await openWorkspace(page)
  const exported = await exportWorkspace(page)
  expect(exported).toEqual(original)
  await activate(page, 'b')
  expect(await exportActive(page)).toEqual(original.documents.b)
  const replacement = createLyricsFile('a new translation', 'Replacement B')
  await page.locator('input[type="file"]').setInputFiles({ name: 'replacement.lyrics.json', mimeType: 'application/json', buffer: Buffer.from(serializeLyricsFile(replacement)) })
  await expect(page.getByLabel('文書名')).toHaveValue('Replacement B')
  const changed = await exportWorkspace(page)
  expect(changed.workspaceId).toBe(original.workspaceId)
  expect(changed.documents.a).toEqual(original.documents.a)
  expect(changed.documents.b).toEqual(replacement)
  await page.locator('input[type="file"]').setInputFiles({ name: 'roundtrip.lyrics-workspace.json', mimeType: 'application/json', buffer: Buffer.from(serializeWorkspaceFile(exported)) })
  await expect(page.getByLabel('文書名')).toHaveValue('原詞 A')
  expect(await exportWorkspace(page)).toEqual(original)
  await expect(saved(page)).toBeVisible()
  await page.reload()
  expect(await exportWorkspace(page)).toEqual(original)
})

test('section comparison selects Verse instances, keeps separate deltas and saves manual correspondence', async ({ page }) => {
  await openWorkspace(page)
  await page.getByRole('button', { name: 'セクション比較', exact: true }).click()
  const panel = page.getByRole('region', { name: 'セクション比較', exact: true })
  await panel.getByLabel('A 比較するセクション').selectOption({ label: '1. Verse 1' })
  await panel.getByLabel('B 比較するセクション').selectOption({ label: '2. Verse 2' })
  await expect(panel.locator('.comparison-table-row')).toHaveCount(2)
  await expect(panel.locator('.comparison-table-row').nth(0).locator('.comparison-delta-cell')).toContainText('0mora')
  await expect(panel.locator('.comparison-table-row').nth(1).locator('.comparison-delta-cell')).toContainText('+1mora')
  await expect(panel.locator('.comparison-table-row').nth(1).locator('.comparison-delta-cell')).toContainText('0syl')
  await panel.getByLabel('B 対応行 1', { exact: true }).selectOption('1')
  await expect(panel.locator('.comparison-guide')).toContainText('作者指定の行対応')
  const manual = await exportWorkspace(page)
  expect(manual.comparison.alignment!.rows).toEqual([{ left: 0, right: 1 }, { left: 1, right: 0 }])
  await expect(saved(page)).toBeVisible()
  await page.reload()
  await expect(panel.getByLabel('B 対応行 1', { exact: true })).toHaveValue('1')
  await panel.getByRole('button', { name: 'B 1行目に空きを入れる', exact: true }).click()
  await expect(panel.locator('.comparison-table-row')).toHaveCount(3)
  await expect(panel.locator('.comparison-table-row').first()).toContainText('対応する行なし')
  const gap = await exportWorkspace(page)
  expect(gap.comparison.alignment!.rows.some(row => row.right === null)).toBe(true)
})

test('A/B comparison shows missing translation lines and invalidates manual pairing after text changes', async ({ page }) => {
  await openWorkspace(page)
  await page.getByRole('button', { name: 'A/B比較', exact: true }).click()
  const panel = page.getByRole('region', { name: 'A/B 歌詞比較', exact: true })
  await expect(panel.locator('.comparison-table-row')).toHaveCount(4)
  await expect(panel.locator('.comparison-gap-label')).toHaveCount(2)
  await expect(panel.locator('.comparison-table-row').first().locator('.comparison-delta-cell')).toContainText('-2mora')
  await expect(panel.locator('.comparison-table-row').first().locator('.comparison-delta-cell')).toContainText('+1syl')
  await panel.getByLabel('B 対応行 1', { exact: true }).selectOption('1')
  await expect(panel.locator('.comparison-guide')).toContainText('作者指定の行対応')
  await editor(page, 'b').press('Control+End')
  await page.keyboard.insertText(' night')
  await expect(panel.getByRole('status')).toContainText('以前の手動対応は適用していません')
  await expect(panel.getByLabel('B 対応行 1', { exact: true })).toBeDisabled()
  await panel.getByRole('button', { name: '現在の行順で対応を再確認', exact: true }).click()
  await expect(panel.getByLabel('B 対応行 1', { exact: true })).toBeEnabled()
  const workspace: WorkspaceFile = await exportWorkspace(page)
  expect(workspace.comparison.kind).toBe('documents')
  expect(workspace.comparison.alignment!.rightLines).toEqual(['rain', 'light night'])
})

test('selected sections retain counts for long lines entirely within their section', async ({ page }) => {
  const file = fixture()
  file.documents.b = createLyricsFile('[Verse 1]\nBeyond the night\nI hear your voice\n\n[Chorus]\nInto the light', 'English B')
  file.comparison.visible = true
  await openWorkspace(page, file)
  const panel = page.getByRole('region', { name: 'A/B 歌詞比較', exact: true })
  await panel.getByLabel('A 比較するセクション').selectOption({ label: '1. Verse 1' })
  await panel.getByLabel('B 比較するセクション').selectOption({ label: '1. Verse 1' })
  const row = panel.locator('.comparison-table-row').first()
  await expect(row.locator('.comparison-line-count').nth(1)).toHaveText('0 mora / 4 syl')
  await expect(row.locator('.comparison-delta-cell')).toContainText('-2mora')
  await expect(row.locator('.comparison-delta-cell')).toContainText('+4syl')
  await expect(panel.getByText('この行は複数セクションにまたがります')).toHaveCount(0)
})

test('Alt pane shortcuts move typing focus with the inspector and save target, including a hidden pane', async ({ page }) => {
  await openWorkspace(page)
  await editor(page, 'a').press('Control+End')
  await page.keyboard.press('Alt+2')
  await expect(page.getByLabel('文書名')).toHaveValue('English B')
  await expect(editor(page, 'b')).toBeFocused()
  await page.keyboard.press('Control+End')
  await page.keyboard.insertText(' BONLY')
  await expect(editor(page, 'b').locator('p').last()).toHaveText('light BONLY')
  await expect(editor(page, 'a').locator('p').last()).toHaveText('ひかり')
  expect(documentToText((await exportActive(page)).editorDocument)).toContain('light BONLY')
  await page.getByRole('button', { name: '単一ペイン', exact: true }).click()
  await expect(pane(page, 'a')).toBeHidden()
  await page.keyboard.press('Alt+1')
  await expect(editor(page, 'a')).toBeVisible()
  await expect(editor(page, 'a')).toBeFocused()
  await expect(page.getByLabel('文書名')).toHaveValue('原詞 A')
  await page.keyboard.press('Control+End')
  await page.keyboard.insertText(' AONLY')
  await expect(editor(page, 'a').locator('p').last()).toHaveText('ひかり AONLY')
  expect(documentToText((await exportActive(page)).editorDocument)).toContain('ひかり AONLY')
  const workspace = await exportWorkspace(page)
  expect(documentToText(workspace.documents.b!.editorDocument)).toContain('light BONLY')
  expect(documentToText(workspace.documents.b!.editorDocument)).not.toContain('AONLY')
})

test('editing either pane during import archival aborts replacement and preserves both edits after reload', async ({ page }) => {
  const original = await openWorkspace(page)
  await activate(page, 'b')
  await expect(saved(page)).toBeVisible()
  // Hold one real IDB commit notification without blocking editing or adding an
  // application hook. The original browser descriptor is restored immediately.
  await page.evaluate(() => {
    const prototype = IDBTransaction.prototype
    const descriptor = Object.getOwnPropertyDescriptor(prototype, 'oncomplete')!
    Object.defineProperty(prototype, 'oncomplete', {
      ...descriptor,
      set: function (this: IDBTransaction, handler: IDBTransaction['oncomplete']) {
        if (this.mode !== 'readwrite' || !handler) {
          descriptor.set!.call(this, handler)
          return
        }
        Object.defineProperty(prototype, 'oncomplete', descriptor)
        descriptor.set!.call(this, function (this: IDBTransaction, event: Event) {
          document.documentElement.dataset.delayedIdbCommit = 'ready'
          document.addEventListener('release-delayed-idb-commit', () => {
            delete document.documentElement.dataset.delayedIdbCommit
            handler.call(this, event)
          }, { once: true })
        })
      },
    })
  })
  const replacement = createLyricsFile('This import must be cancelled', 'Replacement during editing')
  await page.locator('input[type="file"]').setInputFiles({ name: 'replacement.lyrics.json', mimeType: 'application/json', buffer: Buffer.from(serializeLyricsFile(replacement)) })
  await expect(page.locator('html')).toHaveAttribute('data-delayed-idb-commit', 'ready')
  await editor(page, 'a').press('Control+End')
  await page.keyboard.insertText(' A_DURING_IMPORT')
  await editor(page, 'b').press('Control+End')
  await page.keyboard.insertText(' B_DURING_IMPORT')
  await expect(editor(page, 'a').locator('p').last()).toHaveText('ひかり A_DURING_IMPORT')
  await expect(editor(page, 'b').locator('p').last()).toHaveText('light B_DURING_IMPORT')
  await page.evaluate(() => document.dispatchEvent(new Event('release-delayed-idb-commit')))
  await expect(page.getByRole('status').filter({ hasText: '現在の文書は保持しています' })).toBeVisible()
  await expect(page.getByLabel('文書名')).toHaveValue('English B')
  await expect(editor(page, 'a').locator('p').last()).toHaveText('ひかり A_DURING_IMPORT')
  await expect(editor(page, 'b').locator('p').last()).toHaveText('light B_DURING_IMPORT')
  await expect(saved(page)).toBeVisible()
  await page.reload()
  await expect(saved(page)).toBeVisible()
  const restored = await exportWorkspace(page)
  expect(restored.documents.a.documentId).toBe(original.documents.a.documentId)
  expect(restored.documents.b!.documentId).toBe(original.documents.b!.documentId)
  expect(documentToText(restored.documents.a.editorDocument)).toContain('ひかり A_DURING_IMPORT')
  expect(documentToText(restored.documents.b!.editorDocument)).toContain('light B_DURING_IMPORT')
  expect(documentToText(restored.documents.b!.editorDocument)).not.toContain('This import must be cancelled')
})

test('comparison jump reveals and focuses hidden B so subsequent typing edits the selected B line', async ({ page }) => {
  const original = await openWorkspace(page)
  await page.getByRole('button', { name: 'A/B比較', exact: true }).click()
  await page.getByRole('button', { name: '単一ペイン', exact: true }).click()
  await expect(editor(page, 'a')).toBeVisible()
  await expect(pane(page, 'b')).toBeHidden()
  const comparison = page.getByRole('region', { name: 'A/B 歌詞比較', exact: true })
  await comparison.locator('.comparison-table-row').first().locator('.comparison-line-text').nth(1).click()
  await expect(pane(page, 'a')).toBeHidden()
  await expect(editor(page, 'b')).toBeVisible()
  await expect(editor(page, 'b')).toBeFocused()
  await expect(page.getByLabel('文書名')).toHaveValue('English B')
  await expect(page.locator('.selected-word')).toHaveText('rain')
  await page.keyboard.insertText('moonlight')
  await expect(editor(page, 'b').locator('p').nth(1)).toHaveText('moonlight')
  const workspace = await exportWorkspace(page)
  expect(workspace.activePane).toBe('b')
  expect(workspace.documents.a).toEqual(original.documents.a)
  expect(documentToText(workspace.documents.b!.editorDocument)).toBe('[Verse 1]\nmoonlight\nlight')
})
