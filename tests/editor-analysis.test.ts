import { afterEach, describe, expect, it, vi } from 'vitest'
import { Editor, type JSONContent } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { ProsodyAnalysis, analysisKey } from '../src/editor/Analysis'

const editors: Editor[] = []
function createEditor(content: string | JSONContent) {
  const editor = new Editor({ element: document.createElement('div'), extensions: [StarterKit, ProsodyAnalysis], content })
  document.body.append(editor.view.dom)
  editors.push(editor)
  return editor
}

afterEach(() => {
  editors.splice(0).forEach(editor => editor.destroy())
  document.body.replaceChildren()
  vi.useRealTimers()
})

describe('line decoration projection', () => {
  it('retains paragraph badges for ordinary lines', () => {
    const editor = createEditor('<p>かな</p><p>きょう</p>')
    const paragraphs = Array.from(editor.view.dom.querySelectorAll('p'))
    expect(paragraphs.map(node => [node.dataset.line, node.dataset.count])).toEqual([['1', '2 mora'], ['2', '2 mora']])
    expect(editor.view.dom.querySelector('.hard-break-line-marker')).toBeNull()
  })

  it('gives imported hard-break lines separate numbers and counts without changing their native content', () => {
    const editor = createEditor('<p>かな<br>きょう</p>')
    const native = editor.getJSON()
    const lines = Array.from(editor.view.dom.querySelectorAll('.hard-break-line-marker'))
    expect(lines.map(line => line.getAttribute('data-analysis-line'))).toEqual(['1', '2'])
    expect(lines.map(line => line.querySelector('.hard-break-count')?.textContent)).toEqual(['2 mora', '2 mora'])
    expect(editor.view.dom.querySelector('p')?.getAttribute('data-count')).toBe('')
    expect(analysisKey.getState(editor.state)?.analysis.lines.map(line => line.text)).toEqual(['かな', 'きょう'])
    expect(editor.getText()).toBe('かな\nきょう')
    expect(editor.getJSON()).toEqual(native)
    expect(editor.getHTML()).toBe('<p>かな<br>きょう</p>')
  })

  it('hides tag-only counts, marks unresolved lines, and continues numbering after hard breaks', () => {
    const editor = createEditor('<p>[Verse]<br>かな<br>明日<br></p><p>きょう</p>')
    const lines = Array.from(editor.view.dom.querySelectorAll('.hard-break-line-marker'))
    expect(lines).toHaveLength(4)
    expect(lines[0].querySelector('.hard-break-count')).toBeNull()
    expect(lines[1].querySelector('.hard-break-count')?.textContent).toBe('2 mora')
    expect(lines[2].querySelector('.hard-break-count.incomplete')?.textContent).toBe('0 mora + ?')
    expect(lines[3].querySelector('.hard-break-count')).toBeNull()
    expect(editor.view.dom.querySelector('p:last-child')?.getAttribute('data-line')).toBe('5')
  })

  it('updates a hard-break line badge after editing and undoing it', () => {
    const editor = createEditor('<p>かな<br>きょう</p>')
    editor.view.dispatch(editor.state.tr.insertText('あ', 4))
    expect(Array.from(editor.view.dom.querySelectorAll('.hard-break-count')).map(badge => badge.textContent)).toEqual(['2 mora', '3 mora'])
    editor.commands.undo()
    expect(Array.from(editor.view.dom.querySelectorAll('.hard-break-count')).map(badge => badge.textContent)).toEqual(['2 mora', '2 mora'])
  })
})

describe('synthetic composition lifecycle', () => {
  it('does not let an old composition-end timer thaw a newer composition', async () => {
    vi.useFakeTimers()
    const editor = createEditor('<p>あ</p>')
    const plugin = analysisKey.get(editor.state)!
    const handlers = plugin.props.handleDOMEvents
    handlers?.compositionstart?.call(plugin, editor.view, new CompositionEvent('compositionstart'))
    editor.view.dispatch(editor.state.tr.insertText('い', 2))
    handlers?.compositionend?.call(plugin, editor.view, new CompositionEvent('compositionend'))
    handlers?.compositionstart?.call(plugin, editor.view, new CompositionEvent('compositionstart'))
    await vi.advanceTimersByTimeAsync(1)
    expect(analysisKey.getState(editor.state)?.frozen).toBe(true)
    expect(analysisKey.getState(editor.state)?.analysis.confirmedMora).toBe(1)
    editor.view.dispatch(editor.state.tr.insertText('う', 3))
    handlers?.compositionend?.call(plugin, editor.view, new CompositionEvent('compositionend'))
    await vi.advanceTimersByTimeAsync(1)
    expect(analysisKey.getState(editor.state)?.frozen).toBe(false)
    expect(analysisKey.getState(editor.state)?.analysis.confirmedMora).toBe(3)
  })
})
