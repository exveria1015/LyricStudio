import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import type { EditorState } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'
import { TAG_PRESETS } from '../analysis'

type Candidate = { name: string; semantic: 'section' | 'instruction' | 'unknown' }
export interface Completion { from: number; to: number; query: string; fullwidth: boolean; items: Candidate[]; selected: number }
export const completionKey = new PluginKey<Completion | null>('tagCompletion')
const completionCompositionKey = new PluginKey<boolean>('tagCompletionComposition')
const ESCAPABLE = new Set(['[', ']', '［', '］', '\\'])

function findCompletion(state: EditorState): Completion | null {
  if (!state.selection.empty) return null
  const { $from, from } = state.selection
  const before = $from.parent.textBetween(0, $from.parentOffset, '', '\n')
  // Follow the same escape and single-line rules as the tag parser. A regex
  // with one preceding character cannot distinguish odd/even backslashes.
  let opening: number | null = null
  for (let index = before.lastIndexOf('\n') + 1; index < before.length; index++) {
    const character = before[index]
    if (character === '\\' && ESCAPABLE.has(before[index + 1] ?? '')) { index++; continue }
    if (character === '[' || character === '［') {
      if (opening !== null) return null // Nested tags remain an error.
      opening = index
    } else if (character === ']' || character === '］') opening = null
  }
  if (opening === null) return null
  const query = before.slice(opening + 1)
  const items = TAG_PRESETS.filter(t => t.name.toLowerCase().includes(query.toLowerCase()))
  if (!items.length) return null
  items.sort((a, b) => Number(b.name.toLowerCase().startsWith(query.toLowerCase())) - Number(a.name.toLowerCase().startsWith(query.toLowerCase())))
  return { from: from - query.length - 1, to: from, query, fullwidth: before[opening] === '［', items, selected: 0 }
}

export function acceptCompletion(view: EditorView, selected?: number) {
  const state = completionKey.getState(view.state)
  if (!state || view.composing || completionCompositionKey.getState(view.state)) return
  const item = state.items[selected ?? state.selected]
  if (!item) return
  const closing = state.fullwidth ? '］' : ']'
  const next = view.state.doc.textBetween(state.to, Math.min(state.to + 1, view.state.doc.content.size))
  view.dispatch(view.state.tr.insertText(`${state.fullwidth ? '［' : '['}${item.name}${closing}`, state.from, state.to + (next === ']' || next === '］' ? 1 : 0)).setMeta(completionKey, 'close'))
  view.focus()
}

export const TagCompletion = Extension.create({
  name: 'tagCompletion',
  addProseMirrorPlugins() {
    return [new Plugin<boolean>({
      key: completionCompositionKey,
      state: {
        init: () => false,
        apply: (tr, previous) => tr.getMeta('compositionFrozen') ?? previous,
      },
    }), new Plugin<Completion | null>({
      key: completionKey,
      state: {
        init: () => null,
        apply(tr, previous, _old, next) {
          const meta = tr.getMeta(completionKey)
          if (meta === 'close' || completionCompositionKey.getState(next)) return null
          if (typeof meta === 'number' && previous) return { ...previous, selected: (previous.selected + meta + previous.items.length) % previous.items.length }
          if (!tr.docChanged && !tr.selectionSet && tr.getMeta('compositionFrozen') !== false) return previous
          return findCompletion(next)
        },
      },
      props: {
        handleKeyDown(view, event) {
          if (view.composing || completionCompositionKey.getState(view.state) || event.isComposing || event.keyCode === 229) return false
          const current = completionKey.getState(view.state)
          if (!current) return false
          if (event.key === 'Escape') { view.dispatch(view.state.tr.setMeta(completionKey, 'close')); return true }
          if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
            view.dispatch(view.state.tr.setMeta(completionKey, event.key === 'ArrowUp' ? -1 : 1)); return true
          }
          if (event.key === 'Enter' || event.key === 'Tab') { acceptCompletion(view); return true }
          return false
        },
      },
    })]
  },
})
