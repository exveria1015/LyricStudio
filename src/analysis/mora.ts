import type { Unresolved } from './types'

export interface MoraResult {
  confirmedMora: number
  unresolved: Unresolved[]
  complete: boolean
}

const smallKana = new Set('ゃゅょぁぃぅぇぉゎ')
// Explicit supported contractions; an unlisted small kana is never silently ignored.
export const KANA_COMBINATIONS = new Set([
  ...[...'きぎしじちぢにひびぴみり'].flatMap(base => [...'ゃゅょ'].map(small => base + small)),
  'いぇ', 'うぃ', 'うぇ', 'うぉ',
  'くぁ', 'くぃ', 'くぇ', 'くぉ', 'くゎ', 'ぐぁ', 'ぐぃ', 'ぐぇ', 'ぐぉ', 'ぐゎ',
  'すぃ', 'ずぃ', 'しぇ', 'じぇ', 'ちぇ',
  'つぁ', 'つぃ', 'つぇ', 'つぉ', 'てぃ', 'てゅ', 'でぃ', 'でゅ', 'とぅ', 'どぅ',
  'ふぁ', 'ふぃ', 'ふぇ', 'ふぉ', 'ふゃ', 'ふゅ', 'ふょ',
  'ゔぁ', 'ゔぃ', 'ゔぇ', 'ゔぉ', 'ゔゃ', 'ゔゅ', 'ゔょ',
])

const segmenter = new Intl.Segmenter('ja', { granularity: 'grapheme' })
export function graphemes(text: string) {
  return Array.from(segmenter.segment(text), ({ segment, index }) => ({ text: segment, from: index, to: index + segment.length }))
}

export function normalizeKana(text: string): string {
  // Only the analysis view is normalized. Caller retains original UTF-16 coordinates.
  return text.normalize('NFKC').replace(/[\u30a1-\u30f6]/gu, character => String.fromCharCode(character.charCodeAt(0) - 0x60))
}

export function isKanaGrapheme(text: string): boolean {
  return /^[\u3041-\u3096ー]$/u.test(normalizeKana(text))
}

export function isSilentPunctuation(text: string): boolean {
  return /^[\s\p{P}♪♫♬♩♡♥☆★〜～~]+$/u.test(text)
}

/** UTF-16 offsets here are relative to the supplied reading, not a document. */
export function countMora(reading: string): MoraResult {
  let confirmedMora = 0
  let previous = ''
  const unresolved: Unresolved[] = []
  for (const unit of graphemes(reading)) {
    const kana = normalizeKana(unit.text)
    if (smallKana.has(kana)) {
      if (!KANA_COMBINATIONS.has(previous + kana)) {
        unresolved.push({ from: unit.from, to: unit.to, reason: 'unsupported_character', sourceText: unit.text })
      }
      previous = ''
    } else if (/^[\u3041-\u3094ー]$/u.test(kana)) {
      confirmedMora++
      previous = kana
    } else if (isSilentPunctuation(unit.text)) {
      previous = ''
    } else {
      unresolved.push({ from: unit.from, to: unit.to, reason: 'unsupported_character', sourceText: unit.text })
      previous = ''
    }
  }
  return { confirmedMora, unresolved, complete: unresolved.length === 0 }
}
