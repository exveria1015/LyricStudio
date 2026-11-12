import { expect, type Locator } from '@playwright/test'
import type { Editor } from '@tiptap/core'

/** Native navigation completes before CDP inserts text at the current caret. */
export async function moveCaretToEnd(editor: Locator) {
  await editor.focus()
  // ProseMirror's DOMObserver can restore the old selection during the first
  // 200 ms after focus (prosemirror-view/src/domobserver.ts). Settle focus
  // before sending navigation, as the ruby keyboard tests already do.
  await editor.page().waitForTimeout(220)
  await editor.press('Control+End')
  await expect.poll(() => editor.evaluate(element => {
    const view = (element as HTMLElement & { editor: Editor }).editor.view
    return view.state.selection.empty && view.state.selection.from === view.state.doc.content.size - 1
  })).toBe(true)
}
