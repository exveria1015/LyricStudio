export type TagSemantic = 'section' | 'instruction' | 'unknown'
export type UnresolvedReason =
  | 'kanji_without_reading' | 'english_oov' | 'ambiguous_pronunciation'
  | 'unclosed_tag' | 'invalid_ruby' | 'unsupported_character'
export interface Unresolved {
  from: number
  to: number
  reason: UnresolvedReason
  sourceText: string
  candidates?: number[]
}
export type EvidenceSource = 'kana_rule' | 'author_ruby' | 'author_syllables' | 'english_dictionary'
export interface ProsodyResult {
  confirmedMora: number
  confirmedSyllables: number
  unresolved: Unresolved[]
  complete: boolean
  evidence: EvidenceSource[]
}
export interface MetaTag {
  from: number
  to: number
  name: string
  semantic: TagSemantic
  source: string
  known: boolean
}
export interface LineAnalysis extends ProsodyResult {
  index: number
  from: number
  to: number
  text: string
  tags: MetaTag[]
  sectionId: string
}
export interface SectionAnalysis extends ProsodyResult {
  id: string
  name: string
  from: number
  to: number
  lineCount: number
  provisional: boolean
}
export interface DocumentAnalysis extends ProsodyResult {
  lines: LineAnalysis[]
  sections: SectionAnalysis[]
}
