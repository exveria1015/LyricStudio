import { readFile } from 'node:fs/promises'
import { expect, test, type Page } from '@playwright/test'
import type { Editor } from '@tiptap/core'
import { createLyricsFile, documentToText, parseLyricsFile, serializeLyricsFile, type LyricsFile } from '../src/model/document'
import { parseWorkspaceFile } from '../src/model/workspace'
import { moveCaretToEnd } from './keyboard'

const editor = (page: Page) => page.getByRole('textbox', { name: '歌詞エディター', exact: true })
const browserErrors = new WeakMap<Page, string[]>()
test.beforeEach(({ page }) => {
  const errors: string[] = []
  browserErrors.set(page, errors)
  page.on('pageerror', error => errors.push(error.message))
})
test.afterEach(({ page }) => { expect(browserErrors.get(page)).toEqual([]) })

async function openFixture(page: Page, file: LyricsFile) {
  await page.goto('/')
  await expect(editor(page)).toBeVisible()
  await page.locator('input[type="file"]').first().setInputFiles({ name: 'p0-check.lyrics.json', mimeType: 'application/json', buffer: Buffer.from(serializeLyricsFile(file)) })
  await expect(page.getByLabel('文書名', { exact: true })).toHaveValue(file.title)
  await expect(page.getByText('この端末に保存済み', { exact: true })).toBeVisible()
}

function rubyFixture() {
  const file = createLyricsFile('明日', 'P0 変換検証')
  file.editorDocument.content![0].content![0].marks = [{ type: 'rubyReading', attrs: {
    id: 'p0-original-reading', base: '明日', reading: 'あした', source: 'author_ruby',
  } }]
  return file
}

/** Native keyboard navigation also checks that ruby widgets do not trap the caret. */
async function sourceSelection(page: Page, from: number, to = from) {
  await editor(page).focus()
  // ProseMirror treats a move to document start within 200 ms of regained
  // focus as a browser reset (domobserver.ts). Let this native focus heuristic
  // expire before keyboard navigation, then verify its actual editor selection.
  await page.waitForTimeout(220)
  await editor(page).press('Control+Home')
  const selection = () => editor(page).evaluate(element => {
    const current = (element as HTMLElement & { editor: Editor }).editor.state.selection
    return { from: current.from, to: current.to }
  })
  for (let index = 0; index < from; index++) {
    await editor(page).press('ArrowRight')
    await expect.poll(selection).toEqual({ from: index + 2, to: index + 2 })
  }
  for (let index = from; index < to; index++) {
    await editor(page).press('Shift+ArrowRight')
    await expect.poll(selection).toEqual({ from: from + 1, to: index + 2 })
  }
  await expect.poll(selection).toEqual({ from: from + 1, to: to + 1 })
}

async function saveNative(page: Page) {
  const pending = page.waitForEvent('download')
  await page.getByRole('button', { name: '保存', exact: true }).click()
  const download = await pending
  const path = await download.path()
  if (!path) throw new Error('No downloaded native document')
  return parseLyricsFile(await readFile(path, 'utf8'))
}

async function persistedDraft(page: Page) {
  const raw = await page.evaluate(() => new Promise<string>((resolve, reject) => {
    const request = indexedDB.open('lyrics-studio', 1)
    request.onsuccess = () => {
      const database = request.result
      const transaction = database.transaction('drafts', 'readonly')
      const value = transaction.objectStore('drafts').get('workspace-current')
      transaction.oncomplete = () => { database.close(); resolve(value.result as string) }
      transaction.onerror = () => reject(transaction.error)
    }
    request.onerror = () => reject(request.error)
  }))
  return parseWorkspaceFile(raw).documents.a
}

type CompositionRecord = { type: string; data: string | null; trusted: boolean; inputType?: string; composing?: boolean }
type CaptureWindow = Window & { p0CompositionEvents: CompositionRecord[] }

test('CDP composition freezes completion, counts and autosave until committed insertion', async ({ page, context }, testInfo) => {
  await openFixture(page, createLyricsFile('あ', 'P0 composition'))
  await sourceSelection(page, 1)
  await editor(page).evaluate(element => {
    const capture = window as unknown as CaptureWindow
    capture.p0CompositionEvents = []
    for (const type of ['compositionstart', 'compositionupdate', 'compositionend', 'beforeinput', 'input']) {
      element.addEventListener(type, event => {
        const input = event as InputEvent
        capture.p0CompositionEvents.push({ type: event.type, data: input.data, trusted: event.isTrusted, inputType: input.inputType, composing: input.isComposing })
      })
    }
  })
  const cdp = await context.newCDPSession(page)
  await cdp.send('Input.imeSetComposition', { text: '[Cho', selectionStart: 4, selectionEnd: 4 })
  await expect(editor(page)).toContainText('あ[Cho')
  await expect(page.getByRole('listbox', { name: 'メタタグ候補' })).toHaveCount(0)
  await expect(editor(page).locator('p')).toHaveAttribute('data-count', '1 mora')
  // Exceed the app's 500 ms autosave debounce while the conversion is active.
  await page.waitForTimeout(650)
  expect(documentToText((await persistedDraft(page)).editorDocument)).toBe('あ')
  await cdp.send('Input.insertText', { text: '[Cho' })
  await expect(page.getByRole('listbox', { name: 'メタタグ候補' })).toBeVisible()
  await editor(page).press('Enter')
  await expect(editor(page).locator('p')).toHaveCount(1)
  await expect(editor(page).locator('p')).toHaveText('あ[Chorus]')
  const events = await page.evaluate(() => (window as unknown as CaptureWindow).p0CompositionEvents)
  expect(events).toContainEqual(expect.objectContaining({ type: 'compositionstart', trusted: true }))
  expect(events).toContainEqual(expect.objectContaining({ type: 'beforeinput', inputType: 'insertCompositionText', composing: true, trusted: true }))
  expect(events).toContainEqual(expect.objectContaining({ type: 'compositionend', data: '[Cho' }))
  await testInfo.attach('cdp-composition-events', { body: JSON.stringify(events, null, 2), contentType: 'application/json' })
  expect(documentToText((await saveNative(page)).editorDocument)).toBe('あ[Chorus]')
})

test('CDP committed conversion inside ruby invalidates its reading and Undo restores the exact source', async ({ page, context }) => {
  const original = rubyFixture()
  await openFixture(page, original)
  await sourceSelection(page, 1)
  const cdp = await context.newCDPSession(page)
  await cdp.send('Input.imeSetComposition', { text: 'る', selectionStart: 1, selectionEnd: 1 })
  await expect(editor(page)).toContainText('明る日')
  await expect(editor(page).locator('p')).toHaveAttribute('data-count', '3 mora')
  await cdp.send('Input.imeSetComposition', { text: '後', selectionStart: 1, selectionEnd: 1 })
  await cdp.send('Input.insertText', { text: '後' })
  await expect(editor(page)).toHaveText('明後日')
  await expect(editor(page).locator('ruby')).toHaveCount(0)
  await editor(page).press('Control+z')
  await expect(editor(page).locator('ruby[data-reading-id="p0-original-reading"] rt')).toHaveText('あした')
  expect((await saveNative(page)).editorDocument).toEqual(original.editorDocument)
  await editor(page).press('Control+Shift+z')
  await expect(editor(page)).toHaveText('明後日')
  await expect(editor(page).locator('ruby')).toHaveCount(0)
})

test('CDP cancelled conversion preserves ruby, and conversions at both boundaries keep its original range', async ({ page, context }) => {
  const original = rubyFixture()
  await openFixture(page, original)
  const cdp = await context.newCDPSession(page)
  await sourceSelection(page, 1)
  await cdp.send('Input.imeSetComposition', { text: 'る', selectionStart: 1, selectionEnd: 1 })
  await cdp.send('Input.imeSetComposition', { text: '', selectionStart: 0, selectionEnd: 0 })
  await expect(editor(page).locator('ruby rt')).toHaveText('あした')
  expect(await editor(page).evaluate(element => (element as HTMLElement & { editor: Editor }).editor.getJSON())).toEqual(original.editorDocument)
  await sourceSelection(page, 0)
  await cdp.send('Input.imeSetComposition', { text: 'あ', selectionStart: 1, selectionEnd: 1 })
  await cdp.send('Input.insertText', { text: 'あ' })
  await expect(editor(page).locator('ruby rt')).toHaveText('あした')
  await sourceSelection(page, 3)
  // Treat the next conversion as a separate edit. ProseMirror intentionally
  // merges adjacent edits within its default 500 ms history window, including
  // different composition IDs. The focus helper's 220 ms is not enough.
  await page.waitForTimeout(550)
  await cdp.send('Input.imeSetComposition', { text: 'い', selectionStart: 1, selectionEnd: 1 })
  await cdp.send('Input.insertText', { text: 'い' })
  await expect(editor(page).locator('ruby')).toHaveCount(1)
  await expect(editor(page).locator('ruby')).toHaveAttribute('data-reading-base', '明日')
  await expect(editor(page).locator('ruby rt')).toHaveText('あした')
  await editor(page).press('Control+z')
  expect(await editor(page).evaluate(element => (element as HTMLElement & { editor: Editor }).editor.getText())).toBe('あ明日')
  await expect(editor(page).locator('ruby rt')).toHaveText('あした')
  await editor(page).press('Control+Shift+z')
  await expect(editor(page).locator('ruby rt')).toHaveText('あした')
  expect(documentToText((await saveNative(page)).editorDocument)).toBe('あ明日い')
})

test('native browser clipboard preserves independent full-range rubies and Undo; partial copies drop reading', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await openFixture(page, rubyFixture())
  await sourceSelection(page, 0, 2)
  await editor(page).press('Control+c')
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('明日')
  const clipboardHTML = await page.evaluate(async () => {
    const items = await navigator.clipboard.read()
    const html = items.find(item => item.types.includes('text/html'))
    return html ? (await html.getType('text/html')).text() : ''
  })
  expect(clipboardHTML).toContain('data-reading-id="p0-original-reading"')
  await sourceSelection(page, 2)
  await editor(page).press('Control+v')
  await expect(editor(page).locator('ruby')).toHaveCount(2)
  const ids = await editor(page).locator('ruby').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-reading-id')))
  expect(new Set(ids).size).toBe(2)
  await editor(page).press('Control+z')
  await expect(editor(page).locator('ruby')).toHaveCount(1)
  await editor(page).press('Control+Shift+z')
  await expect(editor(page).locator('ruby')).toHaveCount(2)
  await sourceSelection(page, 0, 1)
  await editor(page).press('Control+c')
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('明')
  await sourceSelection(page, 4)
  await editor(page).press('Control+v')
  await expect(editor(page).locator('ruby')).toHaveCount(2)
  expect(documentToText((await saveNative(page)).editorDocument)).toBe('明日明日明')
})

test('reading assignment and its history work through browser keyboard shortcuts', async ({ page }) => {
  await openFixture(page, createLyricsFile('明日', 'P0 キーボード'))
  await sourceSelection(page, 0, 2)
  await editor(page).press('Alt+r')
  await expect(page.getByLabel('読み（ひらがな・カタカナ）')).toBeFocused()
  await page.keyboard.insertText('あした')
  await expect(page.getByLabel('読み（ひらがな・カタカナ）')).toHaveValue('あした')
  await expect(page.getByRole('button', { name: '読みを適用', exact: true })).toBeEnabled()
  await page.keyboard.press('Enter')
  await expect(editor(page).locator('ruby rt')).toHaveText('あした')
  await editor(page).press('Control+z')
  await expect(editor(page).locator('ruby')).toHaveCount(0)
  await expect(editor(page)).toHaveText('明日')
  await editor(page).press('Control+Shift+z')
  await expect(editor(page).locator('ruby rt')).toHaveText('あした')
})

test('ten-thousand-character lyrics wrap at 75–150 percent without horizontal or count-gutter overflow', async ({ page }, testInfo) => {
  const longLine = 'かな'.repeat(120)
  const shortLine = 'かなきょう'.repeat(10)
  const source = `[Verse 1]\n${[longLine, ...Array.from({ length: 199 }, () => shortLine)].join('\n')}`
  expect(source.length).toBeGreaterThan(10_000)
  await openFixture(page, createLyricsFile(source, 'P0 長文検証'))
  const longParagraph = editor(page).locator('p').nth(1)
  await expect(longParagraph).toHaveAttribute('data-count', '240 mora')
  await expect(editor(page).locator('p').last()).toHaveAttribute('data-count', '40 mora')
  const snapshots: unknown[] = []
  for (const width of [1600, 1100]) {
    await page.setViewportSize({ width, height: 1000 })
    for (const zoom of [150, 75]) {
      const control = page.locator('.zoom-control')
      const current = Number((await control.innerText()).replace(/\D/g, ''))
      const label = zoom > current ? '拡大' : '縮小'
      for (let value = current; label === '拡大' ? value < zoom : value > zoom; value += label === '拡大' ? 10 : -10) await page.getByRole('button', { name: label, exact: true }).click()
      await expect(control).toContainText(`${zoom}%`)
      const geometry = await longParagraph.evaluate(paragraph => {
        const element = paragraph as HTMLElement
        const style = getComputedStyle(element)
        const badge = getComputedStyle(element, '::after')
        const canvas = document.createElement('canvas')
        const context = canvas.getContext('2d')!
        context.font = badge.font
        const badgeWidth = context.measureText(element.dataset.count ?? '').width + parseFloat(badge.paddingLeft) + parseFloat(badge.paddingRight)
        const scroller = element.closest('.editor-scroll') as HTMLElement
        return { height: element.getBoundingClientRect().height, lineHeight: parseFloat(style.lineHeight), badgeWidth, reservedGutter: parseFloat(style.paddingRight), scrollWidth: scroller.scrollWidth, clientWidth: scroller.clientWidth, pageWidth: document.documentElement.scrollWidth, viewportWidth: innerWidth }
      })
      expect(geometry.height).toBeGreaterThan(geometry.lineHeight * 2)
      expect(geometry.badgeWidth).toBeLessThan(geometry.reservedGutter)
      expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth + 1)
      expect(geometry.pageWidth).toBeLessThanOrEqual(geometry.viewportWidth + 1)
      snapshots.push({ width, zoom, ...geometry })
      if (width === 1100 && zoom === 150) await testInfo.attach('long-lyrics-150-percent', { body: await page.screenshot(), contentType: 'image/png' })
    }
  }
  await testInfo.attach('layout-measurements', { body: JSON.stringify(snapshots, null, 2), contentType: 'application/json' })
  expect(documentToText((await saveNative(page)).editorDocument)).toBe(source)
})

test('one-character edits refresh long-document counts and record browser response observations', async ({ page }, testInfo) => {
  const source = Array.from({ length: 200 }, () => 'かなきょう'.repeat(10)).join('\n')
  await openFixture(page, createLyricsFile(source, 'P0 入力応答'))
  await moveCaretToEnd(editor(page))
  type ResponseCapture = Window & { p0Frames: number[]; p0LongTasks: number[]; p0Observer: PerformanceObserver }
  await editor(page).evaluate(element => {
    const capture = window as unknown as ResponseCapture
    capture.p0Frames = []
    capture.p0LongTasks = []
    capture.p0Observer = new PerformanceObserver(list => {
      capture.p0LongTasks.push(...list.getEntries().map(entry => entry.duration))
    })
    if (PerformanceObserver.supportedEntryTypes.includes('longtask')) capture.p0Observer.observe({ type: 'longtask' })
    element.addEventListener('beforeinput', () => {
      const before = performance.now()
      requestAnimationFrame(() => capture.p0Frames.push(performance.now() - before))
    })
  })
  for (let index = 0; index < 20; index++) {
    await page.keyboard.insertText('あ')
    await expect(editor(page).locator('p').last()).toHaveAttribute('data-count', `${41 + index} mora`)
  }
  await expect.poll(() => page.evaluate(() => (window as unknown as ResponseCapture).p0Frames.length)).toBe(20)
  const observations = await page.evaluate(() => {
    const capture = window as unknown as ResponseCapture
    capture.p0Observer.disconnect()
    const sorted = [...capture.p0Frames].sort((a, b) => a - b)
    return {
      beforeInputToNextAnimationFrameMs: { samples: sorted.length, median: sorted[10], p95: sorted[18], maximum: sorted[19], values: capture.p0Frames },
      longTasksMs: capture.p0LongTasks,
      browser: navigator.userAgent,
      limitation: 'CDP inserted text in a headless browser; the next animation frame is not physical key-to-display latency.',
    }
  })
  await testInfo.attach('input-response-observations', { body: JSON.stringify(observations, null, 2), contentType: 'application/json' })
  expect(documentToText((await saveNative(page)).editorDocument)).toBe(`${source}${'あ'.repeat(20)}`)
})
