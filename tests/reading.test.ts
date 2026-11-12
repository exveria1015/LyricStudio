import { afterEach, describe, expect, it } from 'vitest'
import { Editor, type JSONContent } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import RubyText from '@tiptap/extension-ruby-text'
import { closeHistory } from '@tiptap/pm/history'
import { Reading, ReadingIntegrity, SyllableOverride, getReadingRanges } from '../src/editor/Reading'

const editors: Editor[] = []
function createEditor(content: string | JSONContent = '<p>響く声</p>') {
  const editor = new Editor({
    element: document.createElement('div'),
    extensions: [StarterKit, Reading, SyllableOverride, ReadingIntegrity],
    content,
  })
  document.body.append(editor.view.dom)
  editors.push(editor)
  return editor
}

function read(editor: Editor, from = 1, to = 3, reading = 'ひびく', id = 'reading-1') {
  return editor.chain().setTextSelection({ from, to }).setMark('rubyReading', {
    id, reading, base: editor.state.doc.textBetween(from, to), source: 'author_ruby',
  }).run()
}

function separateHistory(editor: Editor) {
  editor.view.dispatch(closeHistory(editor.state.tr))
}

function pasteHTML(editor: Editor, html: string) {
  // jsdom has no ClipboardEvent; the public API accepts the originating event.
  return editor.view.pasteHTML(html, new Event('paste') as ClipboardEvent)
}

afterEach(() => {
  for (const editor of editors.splice(0)) editor.destroy()
  document.body.replaceChildren()
})

describe('reading range editing', () => {
  it('adds, changes, removes ruby without putting its reading in original text', () => {
    const editor = createEditor()
    read(editor)
    expect(getReadingRanges(editor.state.doc)).toMatchObject([{ from: 1, to: 3, text: '響く' }])
    expect(editor.getText()).toBe('響く声')
    expect(editor.view.dom.querySelector('ruby rt')?.textContent).toBe('ひびく')
    expect(editor.view.dom.querySelector('rt')?.getAttribute('contenteditable')).toBe('false')
    read(editor, 1, 3, 'なりひびく')
    expect(getReadingRanges(editor.state.doc)[0]?.mark.attrs.reading).toBe('なりひびく')
    editor.chain().setTextSelection({ from: 1, to: 3 }).unsetMark('rubyReading').run()
    expect(getReadingRanges(editor.state.doc)).toHaveLength(0)
    expect(editor.getText()).toBe('響く声')
  })

  it.each([
    ['insert', (editor: Editor) => editor.view.dispatch(editor.state.tr.insertText('き', 2))],
    ['delete', (editor: Editor) => editor.view.dispatch(editor.state.tr.delete(2, 3))],
    ['replace', (editor: Editor) => editor.view.dispatch(editor.state.tr.insertText('け', 2, 3))],
    ['same-text replacement', (editor: Editor) => editor.view.dispatch(editor.state.tr.insertText('く', 2, 3))],
    ['split paragraph', (editor: Editor) => editor.chain().setTextSelection(2).splitBlock().run()],
  ])('invalidates the entire old reading on an internal %s', (_label, edit) => {
    const editor = createEditor()
    read(editor)
    edit(editor)
    expect(getReadingRanges(editor.state.doc)).toHaveLength(0)
    expect(editor.view.dom.querySelector('rt')).toBeNull()
  })

  it('does not grow the range when typing exactly before and after it', () => {
    const editor = createEditor()
    read(editor)
    editor.view.dispatch(editor.state.tr.insertText('あ', 1))
    editor.view.dispatch(editor.state.tr.insertText('い', 4))
    expect(editor.getText()).toBe('あ響くい声')
    expect(getReadingRanges(editor.state.doc)).toMatchObject([{ from: 2, to: 4, text: '響く' }])
  })

  it('preserves two adjacent equal readings as independent instances', () => {
    const editor = createEditor('<p>日々</p>')
    read(editor, 1, 2, 'ひ', 'first')
    read(editor, 2, 3, 'ひ', 'second')
    expect(getReadingRanges(editor.state.doc)).toHaveLength(2)
    expect(editor.view.dom.querySelectorAll('rt')).toHaveLength(2)
    editor.view.dispatch(editor.state.tr.insertText('月', 1, 2))
    expect(getReadingRanges(editor.state.doc)).toMatchObject([{ text: '々', mark: { attrs: { id: 'second' } } }])
  })

  it('renders one annotation when other formatting splits text nodes', () => {
    const editor = createEditor('<p>あいうえ</p>')
    read(editor, 1, 5, 'あいうえ')
    editor.chain().setTextSelection({ from: 2, to: 4 }).setBold().run()
    expect(getReadingRanges(editor.state.doc)).toHaveLength(1)
    expect(editor.view.dom.querySelectorAll('ruby')).toHaveLength(1)
    expect(editor.view.dom.querySelectorAll('rt')).toHaveLength(1)
    expect(editor.getText()).toBe('あいうえ')
  })

  it('restores both original text and its reading in one Undo after invalidation', () => {
    const editor = createEditor()
    read(editor)
    separateHistory(editor)
    editor.view.dispatch(editor.state.tr.insertText('き', 2))
    expect(editor.getText()).toBe('響きく声')
    expect(getReadingRanges(editor.state.doc)).toHaveLength(0)
    expect(editor.commands.undo()).toBe(true)
    expect(editor.getText()).toBe('響く声')
    expect(getReadingRanges(editor.state.doc)[0]?.mark.attrs.reading).toBe('ひびく')
    expect(editor.commands.redo()).toBe(true)
    expect(editor.getText()).toBe('響きく声')
    expect(getReadingRanges(editor.state.doc)).toHaveLength(0)
  })

  it('undoes and redoes annotation edits independently', () => {
    const editor = createEditor()
    read(editor)
    separateHistory(editor)
    read(editor, 1, 3, 'なりひびく')
    editor.commands.undo()
    expect(getReadingRanges(editor.state.doc)[0]?.mark.attrs.reading).toBe('ひびく')
    editor.commands.redo()
    expect(getReadingRanges(editor.state.doc)[0]?.mark.attrs.reading).toBe('なりひびく')
  })

  it('defers reading removal during a synthetic composition and invalidates after it ends', () => {
    const editor = createEditor()
    read(editor)
    separateHistory(editor)
    editor.view.dispatch(editor.state.tr.setMeta('compositionFrozen', true))
    editor.view.dispatch(editor.state.tr.insertText('き', 2))
    expect(editor.getText()).toBe('響きく声')
    expect(getReadingRanges(editor.state.doc)[0]?.mark.attrs.reading).toBe('ひびく')
    editor.view.dispatch(editor.state.tr.setMeta('compositionFrozen', false))
    expect(getReadingRanges(editor.state.doc)).toHaveLength(0)
    expect(editor.commands.undo()).toBe(true)
    expect(editor.getText()).toBe('響く声')
    expect(getReadingRanges(editor.state.doc)[0]?.mark.attrs.reading).toBe('ひびく')
    expect(editor.commands.redo()).toBe(true)
    expect(editor.getText()).toBe('響きく声')
    expect(getReadingRanges(editor.state.doc)).toHaveLength(0)
  })

  it('retains reading when composition ends without changing its original range', () => {
    const editor = createEditor()
    read(editor)
    editor.view.dispatch(editor.state.tr.setMeta('compositionFrozen', true))
    editor.view.dispatch(editor.state.tr.insertText('あ', 1))
    editor.view.dispatch(editor.state.tr.setMeta('compositionFrozen', false))
    expect(getReadingRanges(editor.state.doc)).toMatchObject([{ from: 2, to: 4, text: '響く' }])
  })

  it('preserves a reading when a cancelled composition restores its exact base', () => {
    const editor = createEditor()
    read(editor)
    const original = editor.getJSON()
    editor.view.dispatch(editor.state.tr.setMeta('compositionFrozen', true))
    editor.view.dispatch(editor.state.tr.insertText('き', 2))
    editor.view.dispatch(editor.state.tr.delete(2, 3))
    editor.view.dispatch(editor.state.tr.setMeta('compositionFrozen', false))
    expect(editor.getJSON()).toEqual(original)
    expect(editor.view.dom.querySelector('rt')?.textContent).toBe('ひびく')
    // Pending composition touches must not leak into an unrelated later edit.
    editor.view.dispatch(editor.state.tr.insertText('あ', 1))
    expect(getReadingRanges(editor.state.doc)).toMatchObject([{ from: 2, to: 4, text: '響く' }])
  })

  it.each([true, false])('trims inherited boundary marks while preserving the mapped original (composition: %s)', composing => {
    const editor = createEditor()
    read(editor)
    separateHistory(editor)
    const mark = getReadingRanges(editor.state.doc)[0].mark
    if (composing) editor.view.dispatch(editor.state.tr.setMeta('compositionFrozen', true))
    // Models the browser's native DOM parser: boundary text inherits the ruby.
    editor.view.dispatch(editor.state.tr.insert(1, editor.schema.text('あ', [mark])))
    editor.view.dispatch(editor.state.tr.insert(4, editor.schema.text('い', [mark])))
    if (composing) editor.view.dispatch(editor.state.tr.setMeta('compositionFrozen', false))
    expect(editor.getText()).toBe('あ響くい声')
    expect(getReadingRanges(editor.state.doc)).toMatchObject([{ from: 2, to: 4, text: '響く' }])
    editor.commands.undo()
    expect(editor.getText()).toBe('あ響く声')
    expect(getReadingRanges(editor.state.doc)).toMatchObject([{ from: 2, to: 4, text: '響く' }])
    editor.commands.undo()
    expect(editor.getText()).toBe('響く声')
    expect(getReadingRanges(editor.state.doc)).toMatchObject([{ from: 1, to: 3, text: '響く' }])
  })

  it.each(['before', 'after'])('recovers a browser DOM rewrite at the %s boundary using the caret, including repeated text', boundary => {
    const editor = createEditor('<p>ああ</p>')
    read(editor, 1, 3, 'ああ')
    const original = editor.getJSON()
    editor.commands.setTextSelection(boundary === 'before' ? 1 : 3)
    separateHistory(editor)
    editor.view.dispatch(editor.state.tr.setMeta('compositionFrozen', true))
    // Chromium may parse the entire ruby as unmarked text while adding a
    // boundary character. Repeated letters cannot justify a substring search.
    editor.view.dispatch(editor.state.tr.replaceWith(1, 3, editor.schema.text('あああ')).setMeta('composition', 1))
    editor.view.dispatch(editor.state.tr.setMeta('compositionFrozen', false))
    expect(getReadingRanges(editor.state.doc)).toMatchObject([{ from: boundary === 'before' ? 2 : 1, to: boundary === 'before' ? 4 : 3, text: 'ああ' }])
    expect(editor.commands.undo()).toBe(true)
    expect(editor.getJSON()).toEqual(original)
    expect(editor.commands.redo()).toBe(true)
    expect(getReadingRanges(editor.state.doc)).toMatchObject([{ from: boundary === 'before' ? 2 : 1, to: boundary === 'before' ? 4 : 3, text: 'ああ' }])
  })

  it('does not recover a dropped ruby from a repeated word when native composition changes its interior', () => {
    const editor = createEditor('<p>ああああ</p>')
    read(editor, 1, 3, 'ああ')
    editor.commands.setTextSelection(2)
    editor.view.dispatch(editor.state.tr.setMeta('compositionFrozen', true))
    editor.view.dispatch(editor.state.tr.replaceWith(1, 3, editor.schema.text('あいあ')).setMeta('composition', 1))
    editor.view.dispatch(editor.state.tr.setMeta('compositionFrozen', false))
    expect(editor.getText()).toBe('あいあああ')
    expect(getReadingRanges(editor.state.doc)).toHaveLength(0)
  })

  it('does not undo an explicit annotation removal during a boundary composition', () => {
    const editor = createEditor('<p>明日</p>')
    read(editor, 1, 3, 'あした')
    const mark = getReadingRanges(editor.state.doc)[0].mark
    editor.commands.setTextSelection(3)
    editor.view.dispatch(editor.state.tr.setMeta('compositionFrozen', true))
    editor.view.dispatch(editor.state.tr.replaceWith(1, 3, editor.schema.text('明日あ', [mark])).setMeta('composition', 1))
    editor.view.dispatch(editor.state.tr.removeMark(1, 4, mark))
    editor.view.dispatch(editor.state.tr.setMeta('compositionFrozen', false))
    expect(editor.getText()).toBe('明日あ')
    expect(getReadingRanges(editor.state.doc)).toHaveLength(0)
  })

  it('does not overwrite a different author reading during a native boundary rewrite', () => {
    const editor = createEditor('<p>明日</p>')
    read(editor, 1, 3, 'あした')
    editor.commands.setTextSelection(3)
    editor.view.dispatch(editor.state.tr.setMeta('compositionFrozen', true))
    editor.view.dispatch(editor.state.tr.replaceWith(1, 3, editor.schema.text('明日あ')).setMeta('composition', 1))
    read(editor, 1, 3, 'あす', 'replacement-reading')
    editor.view.dispatch(editor.state.tr.setMeta('compositionFrozen', false))
    expect(getReadingRanges(editor.state.doc)).toMatchObject([{ text: '明日', mark: { attrs: { id: 'replacement-reading', reading: 'あす' } } }])
  })

  it('roundtrips native JSON and safely reloads the same document', () => {
    const editor = createEditor('<p>響く Break</p><p>声</p>')
    read(editor)
    editor.chain().setTextSelection({ from: 4, to: 9 }).setMark('syllableOverride', {
      id: 'english-1', syllables: 1, source: 'author_syllables', base: 'Break',
    }).run()
    const json = editor.getJSON()
    const restored = createEditor(json)
    expect(restored.getJSON()).toEqual(json)
    expect(restored.getText()).toBe(editor.getText())
    editor.chain().setMeta('readingDocumentLoad', true).setContent(json).run()
    expect(editor.getJSON()).toEqual(json)
  })

  it('makes ruby and syllable override mutually exclusive', () => {
    const editor = createEditor('<p>Break</p>')
    read(editor, 1, 6, 'ブレイク')
    editor.chain().setTextSelection({ from: 1, to: 6 }).setMark('syllableOverride', {
      id: 'english-1', syllables: 1, source: 'author_syllables', base: 'Break',
    }).run()
    expect(getReadingRanges(editor.state.doc)).toHaveLength(1)
    expect(getReadingRanges(editor.state.doc)[0]?.mark.type.name).toBe('syllableOverride')
    read(editor, 1, 6, 'ブレイク')
    expect(getReadingRanges(editor.state.doc)).toHaveLength(1)
    expect(getReadingRanges(editor.state.doc)[0]?.mark.type.name).toBe('rubyReading')
  })

  it('invalidates English overrides when their original range changes', () => {
    const editor = createEditor('<p>Break</p>')
    editor.chain().setTextSelection({ from: 1, to: 6 }).setMark('syllableOverride', {
      id: 'english-1', syllables: 1, source: 'author_syllables', base: 'Break',
    }).run()
    editor.view.dispatch(editor.state.tr.insertText('s', 3))
    expect(getReadingRanges(editor.state.doc)).toHaveLength(0)
  })

  it('rejects a multi-line mark instead of applying the same reading per line', () => {
    const editor = createEditor('<p>あ</p><p>い</p>')
    read(editor, 1, 5, 'あい')
    expect(getReadingRanges(editor.state.doc)).toHaveLength(0)
  })
})

describe('clipboard and HTML boundaries', () => {
  it('copies only original text to text/plain and keeps annotations in text/html', () => {
    const editor = createEditor()
    read(editor)
    editor.commands.setTextSelection({ from: 1, to: 4 })
    const clipboard = editor.view.serializeForClipboard(editor.state.doc.slice(1, 4))
    expect(clipboard.text).toBe('響く声')
    expect(clipboard.dom.querySelector('rt')?.textContent).toBe('ひびく')
  })

  it('preserves an internal full-range paste but creates a new identity', () => {
    const editor = createEditor()
    read(editor)
    const html = editor.getHTML()
    editor.commands.setTextSelection(4)
    expect(pasteHTML(editor, html)).toBe(true)
    const ranges = getReadingRanges(editor.state.doc)
    expect(ranges).toHaveLength(2)
    expect(ranges[0]?.mark.attrs.id).not.toBe(ranges[1]?.mark.attrs.id)
    expect(ranges.map(range => range.text)).toEqual(['響く', '響く'])
  })

  it('drops partial-range copies while retaining the complete original', () => {
    const editor = createEditor()
    read(editor)
    const fragment = '<p><ruby data-lyric-reading="ひびく" data-reading-id="reading-1" data-reading-base="響く">響<rt>ひびく</rt></ruby></p>'
    editor.commands.setTextSelection(4)
    pasteHTML(editor, fragment)
    expect(editor.getText()).not.toContain('ひびく')
    expect(getReadingRanges(editor.state.doc)).toHaveLength(1)
  })

  it('handles an actual ProseMirror partial clipboard serialization as base text only', () => {
    const editor = createEditor()
    read(editor)
    editor.commands.setTextSelection({ from: 1, to: 2 })
    const clipboard = editor.view.serializeForClipboard(editor.state.doc.slice(1, 2))
    expect(clipboard.text).toBe('響')
    editor.commands.setTextSelection(4)
    pasteHTML(editor, clipboard.dom.innerHTML)
    expect(editor.getText()).toBe('響く声響')
    expect(getReadingRanges(editor.state.doc)).toHaveLength(1)
  })

  it('imports outside ruby as original text and ignores events and script markup', () => {
    const editor = createEditor('<p></p>')
    pasteHTML(editor, '<p><ruby onclick="alert(1)">東京<rp>(</rp><rt>とうきょう</rt><rp>)</rp></ruby><script>alert(2)</script></p>')
    expect(editor.getText()).toBe('東京')
    expect(getReadingRanges(editor.state.doc)).toHaveLength(0)
    expect(editor.view.dom.querySelector('script')).toBeNull()
    expect(editor.getHTML()).not.toContain('onclick')
  })

  it('does not import unexpected attributes and renders reading values as text', () => {
    const editor = createEditor('<p></p>')
    pasteHTML(editor, '<p><ruby data-lyric-reading="&lt;img src=x onerror=alert(1)&gt;" data-reading-id="safe" data-reading-base="響" reading="attack" source="evil" onclick="alert(1)"><rb>響</rb><rt>ignored</rt></ruby></p>')
    const mark = getReadingRanges(editor.state.doc)[0]?.mark
    expect(mark?.attrs.source).toBe('author_ruby')
    expect(mark?.attrs.reading).toBe('<img src=x onerror=alert(1)>')
    expect(editor.view.dom.querySelector('img')).toBeNull()
    expect(editor.view.dom.querySelector('rt')?.textContent).toBe('<img src=x onerror=alert(1)>')
    expect(editor.getText()).toBe('響')
    expect(editor.view.dom.querySelector('[onclick]')).toBeNull()
  })

  it('serializes HTML that roundtrips its base and reading attributes', () => {
    const editor = createEditor()
    read(editor)
    const restored = createEditor(editor.getHTML())
    expect(restored.getJSON()).toEqual(editor.getJSON())
    expect(restored.getText()).toBe('響く声')
  })
})

describe('official Ruby Text adoption spike', () => {
  it('demonstrates that official 3.32.0 alone retains a stale reading after internal replacement', () => {
    const editor = new Editor({
      element: document.createElement('div'),
      extensions: [StarterKit, RubyText.configure({ allowClickToEdit: false })],
      content: '<p>響く声</p>',
    })
    editors.push(editor)
    editor.chain().setTextSelection({ from: 1, to: 3 }).setRubyText({ rt: 'ひびく' }).run()
    const saved = editor.getJSON()
    expect(saved.content?.[0]?.content?.[0]?.marks?.[0]?.attrs?.rt).toBe('ひびく')
    editor.view.dispatch(editor.state.tr.insertText('け', 2, 3))
    expect(editor.getText()).toBe('響け声')
    expect(editor.getJSON().content?.[0]?.content?.some(node => node.marks?.some(mark => mark.type === 'rubyText'))).toBe(true)
  })
})
