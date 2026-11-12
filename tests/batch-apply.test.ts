import { afterEach, describe, expect, it, vi } from 'vitest'
import { Editor, type JSONContent } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { applyBatchReadings, type BatchReadingWrite } from '../src/editor/BatchReading'
import { Reading, ReadingIntegrity, SyllableOverride, getReadingRanges } from '../src/editor/Reading'
import { ProsodyAnalysis } from '../src/editor/Analysis'
import { createLyricsFile, parseLyricsFile, serializeLyricsFile } from '../src/model/document'

const editors: Editor[] = []
function createEditor(content: string | JSONContent = '<p>明日、声</p>', withAnalysis = false) {
  const editor = new Editor({
    element: document.createElement('div'),
    extensions: [StarterKit, Reading, SyllableOverride, ReadingIntegrity, ...(withAnalysis ? [ProsodyAnalysis] : [])],
    content,
    // jsdom has no layout rectangles; history behavior does not require scrolling.
    editorProps: { handleScrollToSelection: () => true },
  })
  document.body.append(editor.view.dom)
  editors.push(editor)
  return editor
}

function snapshot(editor: Editor, from = 1, to = editor.state.doc.content.size - 1) {
  return { doc: editor.state.doc, from, to }
}

const writes: BatchReadingWrite[] = [
  { from: 1, to: 3, base: '明日', reading: 'あした' },
  { from: 4, to: 5, base: '声', reading: 'こえ' },
]

afterEach(() => {
  vi.restoreAllMocks()
  for (const editor of editors.splice(0)) editor.destroy()
  document.body.replaceChildren()
})

describe('atomic selection reading adoption', () => {
  it('preserves text and unrelated formatting with independent author annotations', () => {
    const editor = createEditor('<p><strong>明</strong>日、<em>声</em></p>')
    const text = editor.getText()
    expect(applyBatchReadings(editor, snapshot(editor), writes)).toBe(2)
    expect(editor.getText()).toBe(text)
    expect(editor.view.dom.querySelector('strong')?.textContent).toBe('明')
    expect(editor.view.dom.querySelector('em')?.textContent).toBe('声')
    const ranges = getReadingRanges(editor.state.doc)
    expect(ranges).toMatchObject([
      { from: 1, to: 3, text: '明日', mark: { attrs: { base: '明日', reading: 'あした', source: 'author_ruby' } } },
      { from: 4, to: 5, text: '声', mark: { attrs: { base: '声', reading: 'こえ', source: 'author_ruby' } } },
    ])
    expect(new Set(ranges.map(range => range.mark.attrs.id)).size).toBe(2)
  })

  it('saves bulk author annotations in the existing strict native format', () => {
    const editor = createEditor()
    applyBatchReadings(editor, snapshot(editor), writes)
    const native = createLyricsFile(editor.getText())
    native.editorDocument = editor.getJSON()
    expect(parseLyricsFile(serializeLyricsFile(native)).editorDocument).toEqual(native.editorDocument)
  })

  it('isolates the whole batch from immediate edits before and after it for Undo and Redo', () => {
    const editor = createEditor()
    // No timers or artificial history boundaries: the command owns isolation.
    editor.view.dispatch(editor.state.tr.insertText('よ', 5))
    expect(applyBatchReadings(editor, snapshot(editor), writes)).toBe(2)
    editor.view.dispatch(editor.state.tr.insertText('ね', 6))
    expect(editor.getText()).toBe('明日、声よね')
    expect(getReadingRanges(editor.state.doc)).toHaveLength(2)

    expect(editor.commands.undo()).toBe(true)
    expect(editor.getText()).toBe('明日、声よ')
    expect(getReadingRanges(editor.state.doc)).toHaveLength(2)
    expect(editor.commands.undo()).toBe(true)
    expect(editor.getText()).toBe('明日、声よ')
    expect(getReadingRanges(editor.state.doc)).toHaveLength(0)
    expect(editor.commands.undo()).toBe(true)
    expect(editor.getText()).toBe('明日、声')

    expect(editor.commands.redo()).toBe(true)
    expect(editor.getText()).toBe('明日、声よ')
    expect(getReadingRanges(editor.state.doc)).toHaveLength(0)
    expect(editor.commands.redo()).toBe(true)
    expect(getReadingRanges(editor.state.doc)).toHaveLength(2)
    expect(editor.commands.redo()).toBe(true)
    expect(editor.getText()).toBe('明日、声よね')
    expect(getReadingRanges(editor.state.doc)).toHaveLength(2)
  })

  it('refuses a stale document even when an intervening replacement preserves the source text', () => {
    const editor = createEditor()
    const expected = snapshot(editor)
    editor.view.dispatch(editor.state.tr.insertText('明日', 1, 3))
    expect(editor.state.doc).not.toBe(expected.doc)
    expect(() => applyBatchReadings(editor, expected, writes)).toThrow()
    expect(editor.getText()).toBe('明日、声')
    expect(getReadingRanges(editor.state.doc)).toHaveLength(0)
  })

  it('waits for the editor composition freeze to end even when native view composition has ended', () => {
    const editor = createEditor('<p>明日、声</p>', true)
    const expected = snapshot(editor)
    editor.view.dispatch(editor.state.tr.setMeta('compositionFrozen', true))
    expect(editor.view.composing).toBe(false)
    expect(() => applyBatchReadings(editor, expected, writes)).toThrow()
    expect(editor.state.doc).toBe(expected.doc)
    expect(getReadingRanges(editor.state.doc)).toHaveLength(0)
    editor.view.dispatch(editor.state.tr.setMeta('compositionFrozen', false))
    expect(applyBatchReadings(editor, expected, writes)).toBe(2)
  })

  it.each(['text', 'composition'])('rechecks state after focus flushes a pending %s update', update => {
    const editor = createEditor('<p>明日、声</p>', true)
    const expected = snapshot(editor)
    // Focusing a real ProseMirror view can synchronously flush its DOM observer.
    vi.spyOn(editor.view, 'focus').mockImplementationOnce(() => {
      editor.view.dispatch(update === 'text'
        ? editor.state.tr.insertText('よ', 5)
        : editor.state.tr.setMeta('compositionFrozen', true))
    })
    expect(() => applyBatchReadings(editor, expected, writes)).toThrow()
    expect(getReadingRanges(editor.state.doc)).toHaveLength(0)
    expect(editor.getText()).toBe(update === 'text' ? '明日、声よ' : '明日、声')
  })

  it.each([
    ['wrong base', { from: 4, to: 5, base: '月', reading: 'つき' }],
    ['invalid reading', { from: 4, to: 5, base: '声', reading: 'voice' }],
    ['empty reading', { from: 4, to: 5, base: '声', reading: '' }],
    ['silent reading', { from: 4, to: 5, base: '声', reading: '…' }],
    ['oversized reading', { from: 4, to: 5, base: '声', reading: 'あ'.repeat(513) }],
    ['overlap', { from: 2, to: 3, base: '日', reading: 'ひ' }],
    ['duplicate range', { from: 1, to: 3, base: '明日', reading: 'あす' }],
    ['out of range', { from: 5, to: 6, base: '', reading: 'あ' }],
    ['fractional offset', { from: 4.5, to: 5, base: '声', reading: 'こえ' }],
  ] satisfies [string, BatchReadingWrite][])('rejects all writes without mutation for a later %s', (_name, invalid) => {
    const editor = createEditor()
    const expected = snapshot(editor)
    expect(() => applyBatchReadings(editor, expected, [writes[0], invalid])).toThrow()
    expect(editor.state.doc).toBe(expected.doc)
    expect(getReadingRanges(editor.state.doc)).toHaveLength(0)
    expect(editor.commands.undo()).toBe(false)
  })

  it('refuses empty proposals and writes beyond the selected source range', () => {
    const editor = createEditor()
    const doc = editor.state.doc
    expect(() => applyBatchReadings(editor, snapshot(editor), [])).toThrow()
    expect(() => applyBatchReadings(editor, snapshot(editor, 4, 5), writes)).toThrow()
    expect(editor.state.doc).toBe(doc)
    expect(editor.commands.undo()).toBe(false)
  })

  it.each(['<p>明日<br>声</p>', '<p>明日</p><p>声</p>'])('does not allow one reading to cross logical line boundaries in %s', content => {
    const editor = createEditor(content)
    const expected = snapshot(editor)
    const base = editor.state.doc.textBetween(1, expected.to, '\n', '\n')
    expect(() => applyBatchReadings(editor, expected, [{ from: 1, to: expected.to, base, reading: 'あしたこえ' }])).toThrow()
    expect(editor.state.doc).toBe(expected.doc)
  })

  it.each(['[明日]', '［明日］', '[明日', '[Verse [明日]'])('protects metadata and unclosed metadata in %s', text => {
    const editor = createEditor(`<p>${text}</p>`)
    const from = text.indexOf('明日') + 1
    const expected = snapshot(editor)
    expect(() => applyBatchReadings(editor, expected, [{ from, to: from + 2, base: '明日', reading: 'あした' }])).toThrow()
    expect(editor.state.doc).toBe(expected.doc)
  })

  it.each(['rubyReading', 'syllableOverride'])('protects an existing %s including its part outside the selection', type => {
    const attrs = type === 'rubyReading'
      ? { id: 'author-original', base: '明日', reading: 'あす', source: 'author_ruby' }
      : { id: 'author-original', base: '明日', syllables: 2, source: 'author_syllables' }
    const editor = createEditor({ type: 'doc', content: [{ type: 'paragraph', content: [
      { type: 'text', text: '明日', marks: [{ type, attrs }] }, { type: 'text', text: '、声' },
    ] }] })
    const expected = snapshot(editor, 2, 5)
    expect(() => applyBatchReadings(editor, expected, [{ from: 2, to: 3, base: '日', reading: 'ひ' }])).toThrow()
    expect(editor.state.doc).toBe(expected.doc)
    expect(getReadingRanges(editor.state.doc)[0].mark.attrs).toEqual(attrs)
    expect(applyBatchReadings(editor, expected, [writes[1]])).toBe(1)
    expect(getReadingRanges(editor.state.doc)[0].mark.attrs).toEqual(attrs)
  })

  it('rejects boundaries that split an astral source character but accepts full UTF-16 ranges', () => {
    const editor = createEditor('<p>𠮷野</p>')
    const expected = snapshot(editor)
    expect(() => applyBatchReadings(editor, expected, [{ from: 2, to: 4, base: '\uDFB7野', reading: 'よしの' }])).toThrow()
    expect(() => applyBatchReadings(editor, expected, [{ from: 1, to: 2, base: '\uD842', reading: 'よし' }])).toThrow()
    expect(editor.state.doc).toBe(expected.doc)
    expect(applyBatchReadings(editor, expected, [{ from: 1, to: 4, base: '𠮷野', reading: 'よしの' }])).toBe(1)
    expect(editor.getText()).toBe('𠮷野')
    expect(getReadingRanges(editor.state.doc)).toMatchObject([{ from: 1, to: 4, text: '𠮷野' }])
  })
})
