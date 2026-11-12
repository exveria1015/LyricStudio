import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import type { DocumentAnalysis } from '../analysis/types'
import { getReadingRanges } from '../editor/Reading'
import type { ReadingSearchTarget, ReadingExample } from './types'

/** Keep original UTF-16 offsets, without slicing through a surrogate pair. */
export function readingContext(text: string, from: number, to: number, radius = 96) {
  let left = Math.max(0, from - radius)
  let right = Math.min(text.length, to + radius)
  if (left > 0 && /[\uDC00-\uDFFF]/.test(text[left])) left--
  if (right < text.length && /[\uDC00-\uDFFF]/.test(text[right])) right++
  return { context: text.slice(left, right), selectionFrom: from - left, selectionTo: to - left }
}

/** A partial replacement cannot preserve the reading of the unselected fragment. */
export function assertWholeReadingRanges(doc: ProseMirrorNode, from: number, to: number) {
  if (getReadingRanges(doc).some(range => range.from < to && range.to > from && (range.from < from || range.to > to))) {
    throw new Error('既存の読みが付いた範囲全体を選択してください。')
  }
}

export function captureReadingTarget(doc: ProseMirrorNode, analysis: DocumentAnalysis, from: number, to: number): ReadingSearchTarget {
  const line = analysis.lines.find(item => item.from <= from && item.to >= to)
  const base = doc.textBetween(from, to, '\n', '\n')
  if (!line || !base.trim() || base.length > 64 || /[\r\n]/.test(base)
    || line.tags.some(tag => tag.from < to && tag.to > from)) throw new Error('タグを含まない、1行内の64文字以内の表記を選択してください。')
  const selected = readingContext(line.text, from - line.from, to - line.from)
  if (selected.context.slice(selected.selectionFrom, selected.selectionTo) !== base) throw new Error('選択範囲を確認できません。選択し直してください。')
  assertWholeReadingRanges(doc, from, to)
  const ranges = getReadingRanges(doc)
  const currentReading = ranges.find(range => range.from === from && range.to === to && range.mark.type.name === 'rubyReading')?.mark.attrs.reading
  const authorReadings = ranges
    .filter(range => range.mark.type.name === 'rubyReading' && range.mark.attrs.source === 'author_ruby'
      && range.text === base && (range.from !== from || range.to !== to))
    .map(range => ({ id: range.mark.attrs.id as string, surface: range.text, reading: range.mark.attrs.reading as string, source: 'document' as const }))
  const examples: ReadingExample[] = []
  for (const otherLine of analysis.lines) {
    let offset = otherLine.text.indexOf(base)
    while (offset >= 0 && examples.length < 3) {
      const start = otherLine.from + offset
      if (start !== from && !otherLine.tags.some(tag => tag.from < start + base.length && tag.to > start)) {
        examples.push({ id: `line-${otherLine.index}-${offset}`, ...readingContext(otherLine.text, offset, offset + base.length) })
      }
      offset = otherLine.text.indexOf(base, offset + Math.max(1, base.length))
    }
    if (examples.length === 3) break
  }
  return {
    snapshotKey: crypto.randomUUID(), base, currentReading: currentReading || null,
    ...selected, authorReadings, examples,
  }
}
