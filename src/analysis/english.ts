import { CMUDICT_DATA } from './cmudict-data'

let dictionary: Map<string, number[]> | undefined
function getDictionary(): Map<string, number[]> {
  dictionary ??= new Map(CMUDICT_DATA.split('\n').map(line => {
    const [word, counts] = line.split('\t')
    return [word, counts.split(',').map(Number)]
  }))
  return dictionary
}

export interface EnglishResult {
  confirmedSyllables: number
  complete: boolean
  candidates: number[]
  reason?: 'english_oov' | 'ambiguous_pronunciation'
}

export function countEnglishSyllables(word: string): EnglishResult {
  const normalized = word.normalize('NFC').replaceAll('’', "'").toLowerCase()
  const candidates = getDictionary().get(normalized)
  if (!candidates) return { confirmedSyllables: 0, complete: false, candidates: [], reason: 'english_oov' }
  if (candidates.length !== 1 || candidates[0] === 0) return { confirmedSyllables: 0, complete: false, candidates: [...candidates], reason: 'ambiguous_pronunciation' }
  return { confirmedSyllables: candidates[0], complete: true, candidates: [...candidates] }
}
