import type { Editor } from '@tiptap/core'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import { closeHistory } from '@tiptap/pm/history'
import { analyzeDocument, countMora, parseTagLine } from '../analysis'
import { getReadingRanges } from './Reading'
import { analysisKey } from './Analysis'

export interface BatchReadingWrite { from: number; to: number; base: string; reading: string }

/** Validate every row before dispatching a single, isolated history event. */
export function applyBatchReadings(editor: Editor, expected: { doc: ProseMirrorNode; from: number; to: number }, writes: BatchReadingWrite[]): number {
  if (editor.isDestroyed || editor.view.composing || analysisKey.getState(editor.state)?.frozen || editor.state.doc !== expected.doc) throw new Error('探索後に歌詞や入力状態が変わりました。選び直して探索してください。')
  if (!writes.length || writes.length > 128 || !Number.isSafeInteger(expected.from) || !Number.isSafeInteger(expected.to)
    || expected.from < 0 || expected.to > expected.doc.content.size || expected.from >= expected.to) throw new Error('一括適用する範囲を確認できません。')
  const markType = editor.schema.marks.rubyReading
  if (!markType) throw new Error('このエディターでは読みを設定できません。')
  const lines = analyzeDocument(expected.doc.toJSON()).lines
  const existing = getReadingRanges(expected.doc)
  const sorted = [...writes].sort((a, b) => a.from - b.from || a.to - b.to)
  let previousEnd = expected.from
  for (const item of sorted) {
    const line = lines.find(line => line.from <= item.from && item.to <= line.to)
    const count = countMora(item.reading)
    if (!Number.isSafeInteger(item.from) || !Number.isSafeInteger(item.to) || item.from < previousEnd || item.to <= item.from || item.to > expected.to
      || !line || !item.base || item.base.length > 64 || expected.doc.textBetween(item.from, item.to, '\n', '\n') !== item.base
      || item.reading.length > 512 || /[\r\n]/u.test(item.reading) || !count.complete || count.confirmedMora < 1
      || existing.some(range => range.from < item.to && range.to > item.from)
      || parseTagLine(line.text).excluded.some(range => line.from + range.from < item.to && line.from + range.to > item.from)) {
      throw new Error('一括適用する範囲や読みが不正です。歌詞は変更していません。')
    }
    for (const position of [item.from - line.from, item.to - line.from]) {
      if (position > 0 && position < line.text.length && /[\uD800-\uDBFF]/.test(line.text[position - 1]) && /[\uDC00-\uDFFF]/.test(line.text[position])) {
        throw new Error('文字の途中を読みの範囲にできません。歌詞は変更していません。')
      }
    }
    previousEnd = item.to
  }
  const transaction = closeHistory(editor.state.tr)
  for (const item of sorted) transaction.addMark(item.from, item.to, markType.create({ id: crypto.randomUUID(), base: item.base, reading: item.reading, source: 'author_ruby' }))
  editor.view.focus()
  if (editor.view.composing || analysisKey.getState(editor.state)?.frozen || editor.state.doc !== expected.doc) throw new Error('入力状態が変わったため一括適用を中止しました。探索し直してください。')
  editor.view.dispatch(transaction)
  // Fence following immediate typing as well as the edits preceding this command.
  editor.view.dispatch(closeHistory(editor.state.tr))
  return sorted.length
}
