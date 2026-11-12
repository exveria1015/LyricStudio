import { readFile } from 'node:fs/promises'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { createLyricsFile, documentToText, parseLyricsFile, serializeLyricsFile } from '../src/model/document'
import { createWorkspace, serializeWorkspaceFile } from '../src/model/workspace'

const logo = (page: Page) => page.getByRole('button', { name: 'Lyrics Studio メニュー', exact: true })
const menubar = (page: Page) => page.getByRole('menubar', { name: 'アプリケーションメニュー', exact: true })
const editor = (page: Page, pane = 'a') => page.locator(`.document-pane[data-pane="${pane}"]`).getByRole('textbox', { name: '歌詞エディター' })
const saved = (page: Page) => page.getByText('この端末に保存済み', { exact: true })

function command(menu: Locator, label: string) {
  const name = new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\s|$)`)
  return menu.getByRole('menuitem', { name }).or(menu.getByRole('menuitemcheckbox', { name }))
}

async function openStudio(page: Page) {
  await page.goto('/')
  await expect(editor(page)).toBeVisible()
  await expect(saved(page)).toBeVisible()
}

async function openMenu(page: Page, group: string, throughLogo = false) {
  if (throughLogo || !(await menubar(page).isVisible())) {
    await logo(page).click()
    await page.getByRole('menu', { name: 'Lyrics Studio メニュー', exact: true }).getByRole('menuitem', { name: group, exact: true }).click()
  } else {
    await menubar(page).getByRole('menuitem', { name: group, exact: true }).click()
  }
  const menu = page.getByRole('menu', { name: group, exact: true })
  await expect(menu).toBeVisible()
  return menu
}

async function choose(page: Page, group: string, label: string, throughLogo = false) {
  await command(await openMenu(page, group, throughLogo), label).click()
}

async function selectUnresolvedTomorrow(page: Page) {
  await page.locator('.unresolved-list button').filter({ hasText: '明日' }).click()
  await expect(page.locator('.selected-word')).toHaveText('明日')
}

async function saveThroughMenu(page: Page) {
  const menu = await openMenu(page, 'ファイル')
  const pending = page.waitForEvent('download')
  await command(menu, '操作中の歌詞を保存').click()
  const download = await pending
  expect(download.suggestedFilename()).toMatch(/\.lyrics\.json$/)
  return parseLyricsFile(await readFile((await download.path())!, 'utf8'))
}

test('logo menu remains available and bar versus compact preference survives reload', async ({ page }) => {
  await openStudio(page)
  await expect(menubar(page)).toBeVisible()
  await expect(await openMenu(page, 'ファイル', true)).toBeVisible()
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')
  await expect(logo(page)).toBeFocused()
  const display = await openMenu(page, '表示', true)
  await expect(command(display, 'メニューバーを常時表示')).toHaveAttribute('aria-checked', 'true')
  await command(display, 'メニューバーを常時表示').click()
  await expect(menubar(page)).toBeHidden()
  await expect(logo(page)).toBeVisible()
  await page.reload()
  await expect(saved(page)).toBeVisible()
  await expect(menubar(page)).toBeHidden()
  const compactDisplay = await openMenu(page, '表示')
  await expect(command(compactDisplay, 'メニューバーを常時表示')).toHaveAttribute('aria-checked', 'false')
  await command(compactDisplay, 'メニューバーを常時表示').click()
  await expect(menubar(page)).toBeVisible()
  await page.reload()
  await expect(menubar(page)).toBeVisible()
})

test('file menu opens and saves only the active document while retaining the other pane', async ({ page }) => {
  await openStudio(page)
  const a = createLyricsFile('かな', '日本語 A')
  const b = createLyricsFile('rain', 'English B')
  const workspace = createWorkspace(a, b)
  await page.locator('input[type="file"]').setInputFiles({ name: 'menu-test.lyrics-workspace.json', mimeType: 'application/json', buffer: Buffer.from(serializeWorkspaceFile(workspace)) })
  await expect(page.getByLabel('文書名')).toHaveValue('日本語 A')
  await page.locator('.document-switch').getByRole('button', { name: 'B 歌詞B', exact: true }).click()
  expect(await saveThroughMenu(page)).toEqual(b)
  const replacement = createLyricsFile('light', 'Changed B')
  const fileMenu = await openMenu(page, 'ファイル')
  const pendingChooser = page.waitForEvent('filechooser')
  await command(fileMenu, 'ファイルを開く…').click()
  await (await pendingChooser).setFiles({ name: 'b.lyrics.json', mimeType: 'application/json', buffer: Buffer.from(serializeLyricsFile(replacement)) })
  await expect(page.getByLabel('文書名')).toHaveValue('Changed B')
  expect(await saveThroughMenu(page)).toEqual(replacement)
  await page.locator('.document-switch').getByRole('button', { name: 'A 歌詞A', exact: true }).click()
  expect(await saveThroughMenu(page)).toEqual(a)
  await expect(editor(page, 'b')).toHaveText('light')
})

test('editing menu keeps the selected reading range and performs undo and redo', async ({ page }) => {
  await openStudio(page)
  await selectUnresolvedTomorrow(page)
  await choose(page, '編集', '読みを編集')
  await expect(page.getByLabel('読み（ひらがな・カタカナ）')).toBeFocused()
  await expect(page.locator('.selected-word')).toHaveText('明日')
  await page.keyboard.insertText('あす')
  await page.getByRole('button', { name: '読みを適用', exact: true }).click()
  const ruby = editor(page).locator('ruby[data-reading-base="明日"]')
  await expect(ruby.locator('rt')).toHaveText('あす')
  await choose(page, '編集', '元に戻す')
  await expect(ruby).toHaveCount(0)
  await choose(page, '編集', 'やり直す')
  await expect(ruby.locator('rt')).toHaveText('あす')
  await choose(page, '編集', 'すべて選択')
  await expect(page.locator('.selected-word')).toContainText('[Verse 1]')
  await expect(page.getByRole('button', { name: '読みを適用', exact: true })).toBeDisabled()
})

test('display and comparison menus change the active view and pane layout', async ({ page }) => {
  await openStudio(page)
  await choose(page, '表示', '原文')
  await expect(page.locator('.document-pane[data-pane="a"]')).toHaveClass(/mode-plain/)
  await choose(page, '表示', 'ルビ')
  await expect(page.locator('.document-pane[data-pane="a"]')).toHaveClass(/mode-ruby/)
  await choose(page, '表示', '解析')
  await expect(page.locator('.document-pane[data-pane="a"]')).toHaveClass(/mode-analysis/)
  await choose(page, '比較', '左右に分割')
  await expect(editor(page, 'b')).toBeVisible()
  await expect(page.getByRole('separator', { name: 'ペインの分割位置' })).toHaveAttribute('aria-orientation', 'vertical')
  await choose(page, '比較', '上下に分割')
  await expect(page.getByRole('separator', { name: 'ペインの分割位置' })).toHaveAttribute('aria-orientation', 'horizontal')
  await choose(page, '比較', '単一ペイン')
  await expect(page.locator('.document-pane[data-pane="b"]')).toBeHidden()
  await choose(page, '比較', 'セクション比較')
  await expect(page.getByRole('region', { name: 'セクション比較', exact: true })).toBeVisible()
  await choose(page, '比較', '比較を閉じる')
  await expect(page.getByRole('region', { name: 'セクション比較', exact: true })).toHaveCount(0)
})

test('Alt F10, arrows, Escape and Tab provide keyboard access without trapping focus', async ({ page }) => {
  await openStudio(page)
  await editor(page).press('Control+End')
  await page.keyboard.press('Alt+F10')
  const fileGroup = menubar(page).getByRole('menuitem', { name: 'ファイル', exact: true })
  await expect(fileGroup).toBeFocused()
  await page.keyboard.press('ArrowRight')
  await expect(menubar(page).getByRole('menuitem', { name: '編集', exact: true })).toBeFocused()
  await page.keyboard.press('ArrowDown')
  const edit = page.getByRole('menu', { name: '編集', exact: true })
  await expect(edit).toBeVisible()
  await page.keyboard.press('End')
  await expect(command(edit, 'タグの分類…')).toBeFocused()
  await page.keyboard.press('Home')
  await expect(command(edit, '元に戻す')).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(edit).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(editor(page)).toBeFocused()
  await page.keyboard.press('Alt+F10')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Tab')
  await expect(page.getByRole('menu')).toHaveCount(0)
  expect(await page.evaluate(() => Boolean(document.activeElement?.closest('[role="menu"], [role="menubar"]')))).toBe(false)
  await choose(page, '表示', 'メニューバーを常時表示')
  await editor(page).focus()
  await page.keyboard.press('Alt+F10')
  await expect(page.getByRole('menu', { name: 'Lyrics Studio メニュー', exact: true }).getByRole('menuitem', { name: 'ファイル', exact: true })).toBeFocused()
  await page.keyboard.press('ArrowRight')
  await expect(page.getByRole('menu', { name: 'ファイル', exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')
  await expect(logo(page)).toBeFocused()
})

test('closing or executing menus does not steal focus from the next title edit', async ({ page }) => {
  await openStudio(page)
  const before = await saveThroughMenu(page)
  await openMenu(page, '表示')
  await page.getByLabel('文書名').click()
  await page.getByLabel('文書名').fill('外側クリックで編集')
  await page.keyboard.insertText('を継続')
  await expect(page.getByLabel('文書名')).toHaveValue('外側クリックで編集を継続')
  await expect(page.getByLabel('文書名')).toBeFocused()
  await expect(page.getByRole('menu')).toHaveCount(0)
  await selectUnresolvedTomorrow(page)
  await choose(page, '編集', '読みを編集')
  await page.getByLabel('文書名').fill('メニュー操作後のタイトル')
  await page.keyboard.insertText('も維持')
  await expect(page.getByLabel('文書名')).toHaveValue('メニュー操作後のタイトルも維持')
  await expect(page.getByLabel('文書名')).toBeFocused()
  const after = await saveThroughMenu(page)
  expect(documentToText(after.editorDocument)).toBe(documentToText(before.editorDocument))
})

test('disabled commands stay inert and composition keys do not execute menu commands', async ({ page }) => {
  await openStudio(page)
  const edit = await openMenu(page, '編集')
  const undo = command(edit, '元に戻す')
  await expect(undo).toHaveAttribute('aria-disabled', 'true')
  await undo.focus()
  await page.keyboard.press('Enter')
  await expect(edit).toBeVisible()
  await expect(undo).toBeFocused()
  await page.keyboard.press('Escape')
  await editor(page).focus()
  for (const key of [{ isComposing: true }, { keyCode: 229 }]) {
    await editor(page).evaluate((element, flags) => {
      element.dispatchEvent(new KeyboardEvent('keydown', { key: 'F10', code: 'F10', altKey: true, bubbles: true, ...flags }))
    }, key)
    await expect(page.getByRole('menu')).toHaveCount(0)
    await expect(editor(page)).toBeFocused()
  }
  const display = await openMenu(page, '表示')
  const plain = command(display, '原文')
  await plain.focus()
  await plain.evaluate(element => {
    element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true, bubbles: true }))
  })
  await expect(display).toBeVisible()
  await expect(page.locator('.document-pane[data-pane="a"]')).toHaveClass(/mode-analysis/)
  await expect(plain).toBeFocused()
})

test('compact menu flyouts stay inside a smaller viewport and help receives command focus', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 600 })
  await openStudio(page)
  await choose(page, '表示', 'メニューバーを常時表示')
  await openMenu(page, '表示')
  const boxes = await page.getByRole('menu').evaluateAll(elements => elements.map(element => {
    const box = element.getBoundingClientRect()
    return { left: box.left, right: box.right, top: box.top, bottom: box.bottom }
  }))
  expect(boxes).toHaveLength(2)
  for (const box of boxes) {
    expect(box.left).toBeGreaterThanOrEqual(8)
    expect(box.right).toBeLessThanOrEqual(892)
    expect(box.top).toBeGreaterThanOrEqual(8)
    expect(box.bottom).toBeLessThanOrEqual(592)
  }
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')
  const help = await openMenu(page, 'ヘルプ')
  await command(help, '使い方').focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('menu')).toHaveCount(0)
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  expect(await dialog.evaluate(element => element.contains(document.activeElement))).toBe(true)
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
})
