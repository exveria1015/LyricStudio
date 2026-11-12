import { Extension, Mark } from '@tiptap/core'
import { isHistoryTransaction } from '@tiptap/pm/history'
import { Fragment, Slice, type Mark as ProseMirrorMark, type Node as ProseMirrorNode } from '@tiptap/pm/model'
import { Plugin, PluginKey, type Transaction } from '@tiptap/pm/state'
import { RemoveMarkStep, StepMap } from '@tiptap/pm/transform'
import { Decoration, DecorationSet } from '@tiptap/pm/view'

const READING_TYPES = new Set(['rubyReading', 'syllableOverride'])

export interface ReadingRange {
  from: number
  to: number
  text: string
  mark: ProseMirrorMark
}

/** A reading is one complete range, even if unrelated formatting splits its text nodes. */
export function getReadingRanges(doc: ProseMirrorNode): ReadingRange[] {
  const ranges: ReadingRange[] = []
  doc.descendants((node, pos) => {
    for (const mark of node.marks) {
      if (!READING_TYPES.has(mark.type.name)) continue
      const previous = ranges.at(-1)
      if (node.isText && previous?.to === pos && previous.mark.eq(mark)) {
        previous.to += node.nodeSize
        previous.text += node.text ?? ''
      } else {
        ranges.push({ from: pos, to: pos + node.nodeSize, text: node.isText ? node.text ?? '' : '\n', mark })
      }
    }
  })
  return ranges
}

const hiddenAttribute = (defaultValue: unknown = null) => ({
  default: defaultValue,
  rendered: false,
  // Only the explicit allowlist in getAttrs imports attributes from HTML.
  parseHTML: () => null,
})

function baseElement(element: HTMLElement): HTMLElement {
  const surrogate = document.createElement('span')
  for (const child of element.childNodes) {
    if (child.nodeName !== 'RT' && child.nodeName !== 'RP') surrogate.append(child.cloneNode(true))
  }
  surrogate.querySelectorAll('rt, rp, script, style').forEach(node => node.remove())
  return surrogate
}

function validCommon(id: unknown, base: unknown): boolean {
  return typeof id === 'string' && id.length > 0 && id.length <= 128
    && typeof base === 'string' && base.length > 0 && !/[\r\n]/u.test(base)
}

function validReading(reading: unknown): boolean {
  return typeof reading === 'string' && reading.trim().length > 0
    && reading.length <= 512 && !/[\r\n]/u.test(reading)
}

function parseCommon(element: HTMLElement) {
  const id = element.getAttribute('data-reading-id')
  const base = element.getAttribute('data-reading-base')
  if (!validCommon(id, base) || baseElement(element).textContent !== base) return null
  return { id, base }
}

/** Native document mark. rt is presentation only, never editor text. */
export const Reading = Mark.create({
  name: 'rubyReading',
  inclusive: false,
  excludes: 'rubyReading syllableOverride',
  priority: 1100,

  addAttributes() {
    return {
      id: hiddenAttribute(),
      reading: hiddenAttribute(),
      source: hiddenAttribute('author_ruby'),
      base: hiddenAttribute(),
    }
  },

  parseHTML() {
    return [
      {
        tag: 'ruby[data-lyric-reading]',
        contentElement: baseElement,
        getAttrs: element => {
          const common = parseCommon(element)
          const reading = element.getAttribute('data-lyric-reading')
          return common && validReading(reading)
            ? { ...common, reading, source: 'author_ruby' }
            : false
        },
      },
      // External ruby imports its base only; annotations must never enter the lyrics.
      { tag: 'rt', ignore: true },
      { tag: 'rp', ignore: true },
    ]
  },

  renderHTML({ mark }) {
    return [
      'ruby',
      {
        'data-lyric-reading': mark.attrs.reading,
        'data-reading-id': mark.attrs.id,
        'data-reading-base': mark.attrs.base,
      },
      ['rb', 0],
      ['rt', { contenteditable: 'false' }, String(mark.attrs.reading ?? '')],
    ]
  },

  addMarkView() {
    // The single rt is a widget at the complete range's end. A static rt inside
    // every mark view would repeat the whole reading when text is split by decorations.
    return ({ mark }) => {
      const ruby = document.createElement('ruby')
      ruby.dataset.lyricReading = String(mark.attrs.reading ?? '')
      ruby.dataset.readingId = String(mark.attrs.id ?? '')
      ruby.dataset.readingBase = String(mark.attrs.base ?? '')
      return { dom: ruby, contentDOM: ruby }
    }
  },

  addProseMirrorPlugins() {
    return [new Plugin({
      key: new PluginKey('readingAnnotations'),
      props: {
        decorations(state) {
          const decorations = getReadingRanges(state.doc)
            .filter(range => range.mark.type.name === 'rubyReading')
            .map(range => Decoration.widget(range.to, () => {
              const rt = document.createElement('rt')
              rt.setAttribute('contenteditable', 'false')
              rt.textContent = String(range.mark.attrs.reading ?? '')
              return rt
            }, {
              key: `${String(range.mark.attrs.id)}:${range.from}:${range.to}:${String(range.mark.attrs.reading)}`,
              marks: [range.mark],
              side: 1,
              ignoreSelection: true,
            }))
          return DecorationSet.create(state.doc, decorations)
        },
      },
    })]
  },
})

export const SyllableOverride = Mark.create({
  name: 'syllableOverride',
  inclusive: false,
  excludes: 'rubyReading syllableOverride',

  addAttributes() {
    return {
      id: hiddenAttribute(),
      syllables: hiddenAttribute(),
      source: hiddenAttribute('author_syllables'),
      base: hiddenAttribute(),
    }
  },

  parseHTML() {
    return [{
      tag: 'span[data-lyric-syllables]',
      getAttrs: element => {
        const common = parseCommon(element)
        const syllables = Number(element.getAttribute('data-lyric-syllables'))
        return common && Number.isSafeInteger(syllables) && syllables > 0 && syllables <= 100
          ? { ...common, syllables, source: 'author_syllables' }
          : false
      },
    }]
  },

  renderHTML({ mark }) {
    return ['span', {
      'data-lyric-syllables': mark.attrs.syllables,
      'data-reading-id': mark.attrs.id,
      'data-reading-base': mark.attrs.base,
      class: 'syllable-override',
    }, 0]
  },
})

function rangeKey(range: ReadingRange): string {
  return `${range.mark.type.name}:${String(range.mark.attrs.id)}`
}

function invalidRanges(doc: ProseMirrorNode): Set<string> {
  const invalid = new Set<string>()
  const seen = new Set<string>()
  for (const range of getReadingRanges(doc)) {
    const { id, base, reading, syllables, source } = range.mark.attrs
    const key = rangeKey(range)
    const validValue = range.mark.type.name === 'rubyReading'
      ? source === 'author_ruby' && validReading(reading)
      : source === 'author_syllables' && Number.isSafeInteger(syllables) && syllables > 0 && syllables <= 100
    if (seen.has(key) || !validCommon(id, base) || !validValue || base !== range.text) invalid.add(key)
    seen.add(key)
  }
  return invalid
}

function reidentifyPasted(slice: Slice): Slice {
  const ids = new Map<string, string>()
  const map = (fragment: Fragment): Fragment => {
    const children: ProseMirrorNode[] = []
    fragment.forEach(node => {
      const marks = node.marks.map(mark => {
        if (!READING_TYPES.has(mark.type.name)) return mark
        const key = `${mark.type.name}:${String(mark.attrs.id)}`
        let id = ids.get(key)
        if (!id) {
          id = crypto.randomUUID()
          ids.set(key, id)
        }
        return mark.type.create({ ...mark.attrs, id })
      })
      children.push((node.isLeaf ? node : node.copy(map(node.content))).mark(marks))
    })
    return Fragment.from(children)
  }
  return new Slice(map(slice.content), slice.openStart, slice.openEnd)
}

function touchedReadings(transaction: Transaction): Set<string> {
  const touched = new Set<string>()
  if (transaction.getMeta('readingDocumentLoad') || isHistoryTransaction(transaction)) return touched
  transaction.mapping.maps.forEach((map, index) => {
    const before = transaction.docs[index]
    if (!before) return
    const ranges = getReadingRanges(before)
    map.forEach((from, to) => {
      for (const range of ranges) {
        const interiorInsertion = from === to && from > range.from && from < range.to
        const overlaps = from < range.to && to > range.from
        if (interiorInsertion || overlaps) touched.add(rangeKey(range))
      }
    })
  })
  return touched
}

function mapReadingRanges(ranges: ReadingRange[], transaction: Transaction): ReadingRange[] {
  return ranges.map(range => ({
    ...range,
    from: transaction.mapping.map(range.from, 1),
    to: transaction.mapping.map(range.to, -1),
  })).filter(range => range.from < range.to)
}

interface CompositionRange extends ReadingRange { restoreBoundary: boolean }

/** DOM parsing may replace an entire ruby when only its boundary was typed. */
function mapCompositionRanges(ranges: CompositionRange[], transaction: Transaction, selection: { from: number; to: number }): CompositionRange[] {
  let result = ranges
  let cursor = selection
  transaction.mapping.maps.forEach((coarse, index) => {
    const before = transaction.docs[index]
    const after = transaction.docs[index + 1] ?? transaction.doc
    const edits: number[] = []
    const nativeComposition = transaction.getMeta('composition') != null
    coarse.forEach((from, to, nextFrom, nextTo) => {
      let prefix = 0
      let suffix = 0
      // Only compare text within one textblock. Bound the unchanged edges by
      // the actual caret/selection, so repeated letters cannot move the edit
      // to another occurrence of the same word.
      if (nativeComposition && before.resolve(from).sameParent(before.resolve(to))
        && after.resolve(nextFrom).sameParent(after.resolve(nextTo))) {
        const oldText = before.textBetween(from, to)
        const newText = after.textBetween(nextFrom, nextTo)
        if (oldText.length === to - from && newText.length === nextTo - nextFrom) {
          const prefixLimit = Math.min(oldText.length, newText.length, Math.max(0, cursor.from - from))
          while (prefix < prefixLimit && oldText[prefix] === newText[prefix]) prefix++
          const suffixLimit = Math.min(oldText.length - prefix, newText.length - prefix, Math.max(0, to - cursor.to))
          while (suffix < suffixLimit && oldText[oldText.length - suffix - 1] === newText[newText.length - suffix - 1]) suffix++
        }
      }
      edits.push(from + prefix, to - from - prefix - suffix, nextTo - nextFrom - prefix - suffix)
    })
    const mapping = new StepMap(edits)
    const step = transaction.steps[index]
    result = result.map(range => {
      let overlapsCoarse = false
      let touchesSource = false
      coarse.forEach((from, to) => { if (from < range.to && to > range.from) overlapsCoarse = true })
      mapping.forEach((from, to) => {
        if ((from > range.from && from < range.to) || (from < range.to && to > range.from)) touchesSource = true
      })
      const atBoundary = cursor.from === cursor.to && (cursor.from === range.from || cursor.from === range.to)
      const explicitlyRemoved = step instanceof RemoveMarkStep && step.mark.eq(range.mark) && step.from < range.to && step.to > range.from
      return {
        ...range,
        from: mapping.map(range.from, 1),
        to: mapping.map(range.to, -1),
        restoreBoundary: !explicitlyRemoved && (range.restoreBoundary || (nativeComposition && atBoundary && overlapsCoarse && !touchesSource)),
      }
    }).filter(range => range.from < range.to)
    cursor = { from: mapping.map(cursor.from, 1), to: mapping.map(cursor.to, 1) }
  })
  return result
}

interface IntegrityState {
  frozen: boolean
  pending: Set<string>
  compositionRanges: CompositionRange[] | null
}
const integrityKey = new PluginKey<IntegrityState>('readingIntegrity')

/** Keep authors' annotations attached only to the exact original, single-line range. */
export const ReadingIntegrity = Extension.create({
  name: 'readingIntegrity',

  addProseMirrorPlugins() {
    return [new Plugin<IntegrityState>({
      key: integrityKey,
      state: {
        init: () => ({ frozen: false, pending: new Set<string>(), compositionRanges: null }),
        apply(transaction, previous, oldState) {
          const frozen = transaction.getMeta('compositionFrozen') ?? previous.frozen
          const reset = transaction.getMeta('readingIntegrityReset')
          const pending = reset
            ? new Set<string>()
            : frozen || previous.frozen
              ? new Set([...previous.pending, ...touchedReadings(transaction)])
              : previous.pending
          const originalRanges = reset ? null : frozen && !previous.frozen
            ? getReadingRanges(oldState.doc).filter(range => range.text === range.mark.attrs.base).map(range => ({ ...range, restoreBoundary: false }))
            : previous.compositionRanges
          const compositionRanges = originalRanges ? mapCompositionRanges(originalRanges, transaction, oldState.selection) : null
          return { frozen, pending, compositionRanges }
        },
      },
      props: { transformPasted: reidentifyPasted },
      appendTransaction(transactions, oldState, newState) {
        const integrity = integrityKey.getState(newState)
        if (integrity?.frozen) return null
        const pending = integrity?.pending ?? new Set<string>()
        if (!transactions.some(transaction => transaction.docChanged || transaction.getMeta('compositionFrozen') === false) && pending.size === 0) return null
        const tr = newState.tr
        let originalRanges: ReadingRange[] | null | undefined = integrity?.compositionRanges
        if (!originalRanges) {
          originalRanges = getReadingRanges(oldState.doc).filter(range => range.text === range.mark.attrs.base)
          for (const transaction of transactions) originalRanges = mapReadingRanges(originalRanges, transaction)
        }
        // Native DOM composition can inherit a ruby even at a non-inclusive
        // boundary. Preserve the mapped original base and remove only the
        // accidentally inherited prefix/suffix, never guess from a substring.
        const candidatesById = new Map<string, ReadingRange[]>()
        for (const range of getReadingRanges(tr.doc)) {
          const key = rangeKey(range)
          const candidates = candidatesById.get(key) ?? []
          candidates.push(range)
          candidatesById.set(key, candidates)
        }
        for (const original of originalRanges) {
          if (tr.doc.textBetween(original.from, original.to, '\n', '\n') !== original.text) continue
          for (const current of candidatesById.get(rangeKey(original)) ?? []) {
            if (!current.mark.eq(original.mark) || current.from > original.from || current.to < original.to) continue
            if (current.from < original.from) tr.removeMark(current.from, original.from, current.mark)
            if (current.to > original.to) tr.removeMark(original.to, current.to, current.mark)
          }
        }
        // Restore only a native boundary rewrite supported by the composition
        // caret and unchanged source edges. Never replace a different author
        // annotation or recover an ID by searching for matching text elsewhere.
        for (const original of integrity?.compositionRanges ?? []) {
          if (!original.restoreBoundary || tr.doc.textBetween(original.from, original.to, '\n', '\n') !== original.text) continue
          const conflict = getReadingRanges(tr.doc).some(range => range.from < original.to && range.to > original.from && !range.mark.eq(original.mark))
          if (!conflict) tr.addMark(original.from, original.to, original.mark)
        }
        // A cancelled IME conversion can temporarily touch a reading and then
        // restore its exact base/range. Judge completed compositions by their
        // final integrity rather than deleting every temporarily touched ID.
        const invalid = invalidRanges(tr.doc)

        for (const transaction of transactions) {
          for (const key of touchedReadings(transaction)) invalid.add(key)
        }

        for (const range of getReadingRanges(tr.doc)) {
          if (invalid.has(rangeKey(range))) tr.removeMark(range.from, range.to, range.mark)
        }
        const reset = pending.size > 0 || integrity?.compositionRanges != null
        if (reset) tr.setMeta('readingIntegrityReset', true)
        if (invalid.size > 0) tr.setMeta('readingInvalidated', [...invalid])
        // Appended edits belong to the same history event, so Undo restores both
        // the original text and its reading. Do not use addToHistory:false here.
        return tr.docChanged || reset ? tr : null
      },
    })]
  },
})
