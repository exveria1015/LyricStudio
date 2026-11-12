import type { MetaTag, TagSemantic, Unresolved } from './types'

export const TAG_PRESETS: { name: string; semantic: TagSemantic }[] = [
  ...['Intro', 'Verse', 'Verse 1', 'Verse 2', 'Pre-Chorus', 'Chorus', 'Bridge', 'Final Chorus', 'Post-Chorus', 'Outro'].map(name => ({ name, semantic: 'section' as const })),
  ...['Instrumental', 'Piano Solo', 'Whispered', 'Spoken', 'Ad Lib', 'Fade Out'].map(name => ({ name, semantic: 'instruction' as const })),
]
export const normalizeTagName = (name: string) => name.trim().toLowerCase().replace(/\s+/gu, ' ')
const isEscapeTarget = (character: string | undefined) => character !== undefined && '[]［］\\'.includes(character)

function semanticFor(name: string, overrides: Record<string, TagSemantic>): TagSemantic {
  const normalized = normalizeTagName(name)
  for (const [key, value] of Object.entries(overrides)) {
    if (normalizeTagName(key) === normalized) return value
  }
  const preset = TAG_PRESETS.find(tag => normalizeTagName(tag.name) === normalized)
  if (preset) return preset.semantic
  if (/^(?:verse|chorus|pre-chorus|post-chorus|bridge|intro|outro)\s+\d+$/u.test(normalized)) return 'section'
  return 'unknown'
}

export interface TagLineResult {
  tags: MetaTag[]
  excluded: { from: number; to: number }[]
  unresolved: Unresolved[]
  incomplete: boolean
}

/** Linear, single-line parser. All offsets are relative to this line. */
export function parseTagLine(text: string, overrides: Record<string, TagSemantic> = {}): TagLineResult {
  const tags: MetaTag[] = []
  const excluded: { from: number; to: number }[] = []
  const unresolved: Unresolved[] = []
  let incomplete = false
  for (let index = 0; index < text.length; index++) {
    if (text[index] === '\\' && isEscapeTarget(text[index + 1])) { index++; continue }
    if (text[index] !== '[' && text[index] !== '［') continue
    const start = index
    let closed = false
    for (index++; index < text.length; index++) {
      if (text[index] === '\\' && isEscapeTarget(text[index + 1])) { index++; continue }
      if (text[index] === '[' || text[index] === '［' || text[index] === '\n') break
      if (text[index] === ']' || text[index] === '］') { closed = true; break }
    }
    if (!closed) {
      excluded.push({ from: start, to: text.length })
      unresolved.push({ from: start, to: text.length, reason: 'unclosed_tag', sourceText: text.slice(start) })
      incomplete = true
      break
    }
    const name = text.slice(start + 1, index).trim()
    const semantic = semanticFor(name, overrides)
    tags.push({ from: start, to: index + 1, name, semantic, source: text.slice(start, index + 1), known: semantic !== 'unknown' })
    excluded.push({ from: start, to: index + 1 })
    if (!name) unresolved.push({ from: start, to: index + 1, reason: 'unsupported_character', sourceText: text.slice(start, index + 1) })
  }
  return { tags, excluded, unresolved, incomplete }
}
