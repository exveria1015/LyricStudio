import { afterEach, describe, expect, it } from 'vitest'
import { Editor, type JSONContent } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { TagCompletion, acceptCompletion, completionKey } from '../src/editor/TagCompletion'
import { ProsodyAnalysis, analysisKey } from '../src/editor/Analysis'

const editors: Editor[] = []

function createEditor(text = '', content?: JSONContent) {
  const editor = new Editor({
    element: document.createElement('div'),
    extensions: [StarterKit, ProsodyAnalysis, TagCompletion],
    content: content ?? { type: 'doc', content: [{ type: 'paragraph', ...(text ? { content: [{ type: 'text', text }] } : {}) }] },
  })
  document.body.append(editor.view.dom)
  editors.push(editor)
  editor.commands.setTextSelection(editor.state.doc.content.size - 1)
  return editor
}

function key(editor: Editor, key: string, options: KeyboardEventInit = {}) {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options })
  editor.view.dom.dispatchEvent(event)
  return event
}

function completionKeyHandler(editor: Editor, key: string, options: KeyboardEventInit = {}) {
  const plugin = completionKey.get(editor.state)
  return plugin?.props.handleKeyDown?.call(plugin, editor.view, new KeyboardEvent('keydown', { key, ...options }))
}

afterEach(() => {
  editors.splice(0).forEach(editor => editor.destroy())
  document.body.replaceChildren()
})

describe('tag completion keyboard', () => {
  it('opens on a typed bracket, moves selection, and accepts Enter before StarterKit splits the block', () => {
    const editor = createEditor()
    editor.commands.insertContent('[')
    const initial = completionKey.getState(editor.state)
    expect(initial?.items.length).toBeGreaterThan(9)
    expect(key(editor, 'ArrowDown').defaultPrevented).toBe(true)
    expect(completionKey.getState(editor.state)?.selected).toBe(1)
    expect(key(editor, 'Enter').defaultPrevented).toBe(true)
    expect(editor.getText()).toBe(`[${initial?.items[1].name}]`)
    expect(editor.state.doc.childCount).toBe(1)
    expect(completionKey.getState(editor.state)).toBeNull()
  })

  it('cycles from the first candidate to the last and back without dropping candidates', () => {
    const editor = createEditor('[')
    const count = completionKey.getState(editor.state)?.items.length ?? 0
    key(editor, 'ArrowUp')
    expect(completionKey.getState(editor.state)?.selected).toBe(count - 1)
    key(editor, 'ArrowDown')
    expect(completionKey.getState(editor.state)?.selected).toBe(0)
  })

  it('filters case-insensitively, puts prefix matches first, and accepts Tab', () => {
    const editor = createEditor('[cHo')
    expect(completionKey.getState(editor.state)?.items[0].name).toBe('Chorus')
    expect(key(editor, 'Tab').defaultPrevented).toBe(true)
    expect(editor.getText()).toBe('[Chorus]')
  })

  it('Escape closes the popup while preserving the unfinished original', () => {
    const editor = createEditor('あお[Cho')
    expect(key(editor, 'Escape').defaultPrevented).toBe(true)
    expect(completionKey.getState(editor.state)).toBeNull()
    expect(editor.getText()).toBe('あお[Cho')
    expect(completionKeyHandler(editor, 'ArrowDown')).toBe(false)
  })

  it.each([
    ['[Cho]', '[Chorus]'],
    ['[Cho］', '[Chorus]'],
    ['［Cho］', '［Chorus］'],
    ['［Cho]', '［Chorus］'],
  ])('replaces the existing closing bracket in %s without duplicating it', (text, result) => {
    const editor = createEditor(text)
    editor.commands.setTextSelection(text.length)
    key(editor, 'Enter')
    expect(editor.getText()).toBe(result)
  })

  it('replaces only the active input range and retains surrounding lyrics', () => {
    const editor = createEditor('あお[Cho 響く')
    editor.commands.setTextSelection(7)
    key(editor, 'Enter')
    expect(editor.getText()).toBe('あお[Chorus] 響く')
  })

  it.each(['\\[Cho', '\\［Cho', '\\\\\\[Cho', '[Verse [Cho', '[unknown'])('does not open for escaped, nested, or unmatched input: %s', text => {
    const editor = createEditor(text)
    expect(completionKey.getState(editor.state)).toBeNull()
  })

  it.each(['\\\\[Cho', '\\\\［Cho'])('recognizes a bracket after an escaped backslash: %s', text => {
    const editor = createEditor(text)
    expect(completionKey.getState(editor.state)?.query).toBe('Cho')
    key(editor, 'Enter')
    expect(editor.getText()).toBe(text.startsWith('\\\\［') ? '\\\\［Chorus］' : '\\\\[Chorus]')
  })

  it('does not carry a query across a hard break in a paragraph', () => {
    const editor = createEditor('', { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '[Cho' }, { type: 'hardBreak' }, { type: 'text', text: 'rus' }] }] })
    expect(completionKey.getState(editor.state)).toBeNull()
  })

  it('does not open for a non-empty text selection or an invalid candidate index', () => {
    const editor = createEditor('[Cho')
    acceptCompletion(editor.view, 900)
    expect(editor.getText()).toBe('[Cho')
    editor.commands.setTextSelection({ from: 2, to: 4 })
    expect(completionKey.getState(editor.state)).toBeNull()
  })
})

describe('IME integration boundaries', () => {
  it.each([{ isComposing: true }, { keyCode: 229 }])('does not handle an IME confirmation key: %j', options => {
    const editor = createEditor('[Cho')
    // Exercise this plugin's guard, without bypassing the browser's composition
    // handling and invoking unrelated StarterKit Enter commands in jsdom.
    const result = completionKeyHandler(editor, 'Enter', options)
    expect(completionKey.getState(editor.state)?.query).toBe('Cho')
    expect(editor.getText()).toBe('[Cho')
    expect(result).toBe(false)
  })

  it('keeps candidates and derived counts frozen throughout composition transactions, then refreshes', () => {
    const editor = createEditor('[Ch')
    editor.view.dispatch(editor.state.tr.setMeta('compositionFrozen', true))
    expect(completionKey.getState(editor.state)).toBeNull()
    editor.view.dispatch(editor.state.tr.insertText('o', 4))
    expect(completionKey.getState(editor.state)).toBeNull()
    expect(analysisKey.getState(editor.state)?.frozen).toBe(true)
    expect(analysisKey.getState(editor.state)?.analysis.lines[0].text).toBe('[Ch')
    acceptCompletion(editor.view)
    expect(editor.getText()).toBe('[Cho')
    editor.view.dispatch(editor.state.tr.setMeta('compositionFrozen', false))
    expect(completionKey.getState(editor.state)?.query).toBe('Cho')
    expect(analysisKey.getState(editor.state)?.analysis.lines[0].text).toBe('[Cho')
    key(editor, 'Enter')
    expect(editor.getText()).toBe('[Chorus]')
  })
})
