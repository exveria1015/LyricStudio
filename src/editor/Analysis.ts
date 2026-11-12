import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import type { Node } from '@tiptap/pm/model'
import { analyzeDocument } from '../analysis'

export type Analysis = ReturnType<typeof analyzeDocument>
export type TagOverrides = Record<string, 'section' | 'instruction' | 'unknown'>
export const analysisKey = new PluginKey<{ analysis: Analysis; decorations: DecorationSet; frozen: boolean }>('lyricsAnalysis')
export const REASONS: Record<string, string> = {
  kanji_without_reading: '読みが未設定', english_oov: '英語辞書に未登録',
  ambiguous_pronunciation: '音節数に複数の候補', unclosed_tag: 'タグが閉じられていません',
  invalid_ruby: '読みを再確認してください', unsupported_character: '発音を指定してください',
  empty_tag: 'タグ名を入力してください', invalid_tag: 'タグの入れ子は使えません',
}

export function countLabel(value: { confirmedMora: number; confirmedSyllables: number; complete: boolean }) {
  return `${value.confirmedMora} mora${value.confirmedSyllables ? ` + ${value.confirmedSyllables} syl` : ''}${value.complete ? '' : ' + ?'}`
}

function decorate(doc: Node, analysis: Analysis) {
  const decorations: Decoration[] = []
  const decoratedParagraphs = new Set<number>()
  for (const line of analysis.lines) {
    const start = doc.resolve(Math.min(line.from, doc.content.size)).before(1)
    const paragraph = doc.nodeAt(start)
    if (!paragraph) continue
    const heading = line.tags.find(tag => tag.semantic === 'section')
    const tagOnly = line.tags.length > 0 && line.tags.map(t => t.source).join('').replace(/\s/g, '') === line.text.replace(/\s/g, '')
    const count = line.text.trim() && !tagOnly ? countLabel(line) : ''
    let hasHardBreak = false
    paragraph.forEach(child => { if (child.type.name === 'hardBreak') hasHardBreak = true })
    if (hasHardBreak) {
      // Imported documents may use hard breaks. Each logical line needs its own
      // anchor; repeated node decorations on the same paragraph lose line data.
      if (!decoratedParagraphs.has(start)) {
        decorations.push(Decoration.node(start, start + paragraph.nodeSize, {
          'data-line': '', 'data-count': '', class: 'hard-break-paragraph',
        }))
        decoratedParagraphs.add(start)
      }
      decorations.push(Decoration.widget(line.from, () => {
        const marker = document.createElement('span')
        marker.className = 'hard-break-line-marker'
        marker.dataset.analysisLine = String(line.index + 1)
        marker.setAttribute('contenteditable', 'false')
        marker.setAttribute('aria-hidden', 'true')
        const number = document.createElement('span')
        number.className = 'hard-break-line-number'
        number.textContent = String(line.index + 1)
        marker.append(number)
        if (count) {
          const badge = document.createElement('span')
          badge.className = `hard-break-count${line.complete ? '' : ' incomplete'}`
          badge.textContent = count
          marker.append(badge)
        }
        return marker
      }, {
        key: `line-${line.index}-${line.from}-${count}`,
        side: -1, marks: [], ignoreSelection: true,
      }))
    } else {
      decorations.push(Decoration.node(start, start + paragraph.nodeSize, {
        'data-line': String(line.index + 1),
        'data-count': count,
        class: `${heading ? 'section-line' : ''} ${line.complete ? '' : 'incomplete-line'}`,
      }))
    }
    for (const tag of line.tags) {
      decorations.push(Decoration.inline(tag.from, tag.to, { class: `meta-tag tag-${tag.semantic}` }))
    }
    for (const unresolved of line.unresolved) {
      if (unresolved.to > unresolved.from) decorations.push(Decoration.inline(unresolved.from, unresolved.to, {
        class: 'unresolved-text', title: REASONS[unresolved.reason] ?? unresolved.reason,
      }))
    }
  }
  return DecorationSet.create(doc, decorations)
}

export const ProsodyAnalysis = Extension.create<{ getOverrides: () => TagOverrides }>({
  name: 'prosodyAnalysis',
  addOptions() { return { getOverrides: () => ({}) } },
  addProseMirrorPlugins() {
    const overrides = this.options.getOverrides
    let compositionEpoch = 0
    return [new Plugin({
      key: analysisKey,
      state: {
        init: (_, state) => {
          const analysis = analyzeDocument(state.doc.toJSON(), overrides())
          return { analysis, decorations: decorate(state.doc, analysis), frozen: false }
        },
        apply(tr, previous) {
          const frozen = tr.getMeta('compositionFrozen') ?? previous.frozen
          if (frozen) return { ...previous, frozen, decorations: previous.decorations.map(tr.mapping, tr.doc) }
          if (!tr.docChanged && !tr.getMeta('refreshAnalysis') && !previous.frozen) return previous
          const analysis = analyzeDocument(tr.doc.toJSON(), overrides())
          return { analysis, decorations: decorate(tr.doc, analysis), frozen: false }
        },
      },
      props: {
        decorations: state => analysisKey.getState(state)?.decorations,
        handleDOMEvents: {
          compositionstart(view) {
            compositionEpoch++
            view.dispatch(view.state.tr.setMeta('compositionFrozen', true))
            return false
          },
          compositionend(view) {
            const epoch = ++compositionEpoch
            setTimeout(() => {
              if (!view.isDestroyed && epoch === compositionEpoch) view.dispatch(view.state.tr.setMeta('compositionFrozen', false).setMeta('refreshAnalysis', true))
            }, 0)
            return false
          },
        },
      },
    })]
  },
})
