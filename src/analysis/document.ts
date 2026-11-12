import type { JSONContent } from '@tiptap/core'
import { countEnglishSyllables } from './english'
import { countMora, graphemes, isKanaGrapheme, isSilentPunctuation } from './mora'
import { parseTagLine } from './tags'
import { ENGLISH_DICTIONARY_VERSION, MORA_RULES_VERSION } from './versions'
import type { DocumentAnalysis, LineAnalysis, ProsodyResult, SectionAnalysis, TagSemantic, Unresolved } from './types'

interface Annotation { from: number; to: number; type: string; attrs: Record<string, unknown> }
interface InputLine { text: string; from: number; to: number; annotations: Annotation[] }
interface Contribution extends ProsodyResult { from: number; to: number; hasText: boolean }
interface LocalAnalysis extends ProsodyResult {
  parsed: ReturnType<typeof parseTagLine>
  contributions: Contribution[]
}

const emptyResult = (): ProsodyResult => ({ confirmedMora: 0, confirmedSyllables: 0, unresolved: [], complete: true, evidence: [] })
function addResult(target: ProsodyResult, source: ProsodyResult) {
  target.confirmedMora += source.confirmedMora
  target.confirmedSyllables += source.confirmedSyllables
  target.unresolved.push(...source.unresolved)
  target.evidence = [...new Set([...target.evidence, ...source.evidence])]
  target.complete = target.unresolved.length === 0
}

function documentLines(doc: JSONContent): InputLine[] {
  const lines: InputLine[] = []
  let blockPosition = 0
  for (const paragraph of doc.content ?? []) {
    let position = blockPosition + 1
    let line: InputLine = { text: '', from: position, to: position, annotations: [] }
    for (const node of paragraph.content ?? []) {
      if (node.type === 'hardBreak') {
        line.to = position
        lines.push(line)
        position++
        line = { text: '', from: position, to: position, annotations: [] }
        continue
      }
      const text = node.text ?? ''
      const start = line.text.length
      line.text += text
      for (const mark of node.marks ?? []) {
        if (mark.type !== 'rubyReading' && mark.type !== 'syllableOverride') continue
        const attrs: Record<string, unknown> = mark.attrs ?? {}
        const previous = line.annotations.find(annotation => annotation.type === mark.type && annotation.to === start && JSON.stringify(annotation.attrs) === JSON.stringify(attrs))
        if (previous) previous.to += text.length
        else line.annotations.push({ from: start, to: start + text.length, type: mark.type, attrs })
      }
      position += text.length
    }
    line.to = position
    lines.push(line)
    blockPosition = position + 1
  }
  return lines.length ? lines : [{ text: '', from: 1, to: 1, annotations: [] }]
}

const lineCache = new Map<string, LocalAnalysis>()
const MAX_CACHED_LINES = 512

function analyzeLine(input: InputLine, overrides: Record<string, TagSemantic>): LocalAnalysis {
  const key = JSON.stringify([MORA_RULES_VERSION, ENGLISH_DICTIONARY_VERSION, input.text, input.annotations, overrides])
  const cached = lineCache.get(key)
  if (cached) return cached
  const { text, annotations } = input
  const parsed = parseTagLine(text, overrides)
  const textUnits = graphemes(text)
  const unitIndices = new Map(textUnits.map((unit, index) => [unit.from, index]))
  const result: LocalAnalysis = { ...emptyResult(), parsed, contributions: [] }
  function emit(from: number, to: number, values: Partial<ProsodyResult> = {}, hasText = /\S/u.test(text.slice(from, to))) {
    const contribution: Contribution = { ...emptyResult(), from, to, hasText, ...values }
    contribution.complete = contribution.unresolved.length === 0
    result.contributions.push(contribution)
    addResult(result, contribution)
  }
  for (const diagnostic of parsed.unresolved) emit(diagnostic.from, diagnostic.to, { unresolved: [diagnostic] }, false)

  const overlappingAnnotations = new Set<Annotation>()
  for (const annotation of annotations) {
    if (annotations.some(other => other !== annotation && annotation.from < other.to && annotation.to > other.from)) overlappingAnnotations.add(annotation)
    if (parsed.excluded.some(range => annotation.from < range.to && annotation.to > range.from)) overlappingAnnotations.add(annotation)
  }
  let offset = 0
  while (offset < text.length) {
    const exclusion = parsed.excluded.find(range => range.from <= offset && offset < range.to)
    if (exclusion) { offset = exclusion.to; continue }
    const annotation = annotations.find(item => item.from <= offset && offset < item.to)
    if (annotation) {
      const nextExcluded = parsed.excluded.find(range => range.from > offset && range.from < annotation.to)
      const end = nextExcluded?.from ?? annotation.to
      const base = text.slice(annotation.from, annotation.to)
      const validBase = annotation.attrs.base === base && typeof annotation.attrs.id === 'string' && annotation.attrs.id.length > 0 && !overlappingAnnotations.has(annotation)
      if (annotation.type === 'rubyReading') {
        const reading = annotation.attrs.reading
        const mora = typeof reading === 'string' ? countMora(reading) : undefined
        if (!validBase || annotation.attrs.source !== 'author_ruby' || typeof reading !== 'string' || !reading.trim() || !mora?.complete || mora.confirmedMora === 0) {
          emit(offset, end, { unresolved: [{ from: offset, to: end, reason: 'invalid_ruby', sourceText: text.slice(offset, end) }] })
        } else emit(offset, end, { confirmedMora: mora.confirmedMora, evidence: ['author_ruby'] })
      } else {
        const syllables = annotation.attrs.syllables
        if (!validBase || annotation.attrs.source !== 'author_syllables' || typeof syllables !== 'number' || !Number.isSafeInteger(syllables) || syllables < 0) {
          emit(offset, end, { unresolved: [{ from: offset, to: end, reason: 'invalid_ruby', sourceText: text.slice(offset, end) }] })
        } else emit(offset, end, { confirmedSyllables: syllables, evidence: ['author_syllables'] })
      }
      offset = end
      continue
    }
    const boundary = Math.min(text.length,
      ...parsed.excluded.filter(range => range.from > offset).map(range => range.from),
      ...annotations.filter(range => range.from > offset).map(range => range.from))
    const remainder = text.slice(offset, boundary)
    const firstIndex = unitIndices.get(offset)
    const alignedUnit = firstIndex === undefined ? undefined : textUnits[firstIndex]
    const first = alignedUnit && alignedUnit.to <= boundary
      ? { text: alignedUnit.text, from: 0, to: alignedUnit.to - offset }
      : graphemes(remainder)[0]
    if (isKanaGrapheme(first.text)) {
      let length = first.to
      for (let nextIndex = (firstIndex ?? textUnits.length) + 1; nextIndex < textUnits.length; nextIndex++) {
        const unit = textUnits[nextIndex]
        if (unit.to > boundary || !isKanaGrapheme(unit.text)) break
        length = unit.to - offset
      }
      const mora = countMora(remainder.slice(0, length))
      emit(offset, offset + length, { confirmedMora: mora.confirmedMora, evidence: ['kana_rule'], unresolved: mora.unresolved.map(problem => ({ ...problem, from: problem.from + offset, to: problem.to + offset })) })
      offset += length
      continue
    }
    const kanji = remainder.match(/^[\p{Script=Han}]+/u)?.[0]
    if (kanji && !/^[々〆〻]/u.test(kanji)) {
      emit(offset, offset + kanji.length, { unresolved: [{ from: offset, to: offset + kanji.length, reason: 'kanji_without_reading', sourceText: kanji }] })
      offset += kanji.length
      continue
    }
    const english = remainder.match(/^['’]?\p{Script=Latin}[\p{Script=Latin}\p{M}\p{N}]*(?:['’.-][\p{Script=Latin}\p{M}\p{N}]+)*/u)?.[0]
    if (english) {
      const englishResult = countEnglishSyllables(english)
      emit(offset, offset + english.length, {
        confirmedSyllables: englishResult.confirmedSyllables,
        evidence: englishResult.complete ? ['english_dictionary'] : [],
        unresolved: englishResult.reason ? [{ from: offset, to: offset + english.length, reason: englishResult.reason, sourceText: english, candidates: englishResult.candidates }] : [],
      })
      offset += english.length
      continue
    }
    if (isSilentPunctuation(first.text)) emit(offset, offset + first.to)
    else emit(offset, offset + first.to, { unresolved: [{ from: offset, to: offset + first.to, reason: 'unsupported_character', sourceText: first.text }] })
    offset += first.to
  }
  result.contributions.sort((a, b) => a.from - b.from)
  if (lineCache.size >= MAX_CACHED_LINES) lineCache.delete(lineCache.keys().next().value!)
  lineCache.set(key, result)
  return result
}

function shiftedProblems(problems: Unresolved[], offset: number): Unresolved[] {
  return problems.map(problem => ({ ...problem, from: problem.from + offset, to: problem.to + offset, ...(problem.candidates ? { candidates: [...problem.candidates] } : {}) }))
}

/** Pure projection from the editor's paragraph JSON; all returned positions are ProseMirror positions. */
export function analyzeDocument(doc: JSONContent, tagOverrides: Record<string, TagSemantic> = {}): DocumentAnalysis {
  const result: DocumentAnalysis = { ...emptyResult(), lines: [], sections: [] }
  const sectionLines = new Map<string, Set<number>>()
  const createSection = (name: string, from: number): SectionAnalysis => {
    const section: SectionAnalysis = { ...emptyResult(), id: `section-${from}`, name, from, to: from, lineCount: 0, provisional: false }
    result.sections.push(section)
    sectionLines.set(section.id, new Set())
    return section
  }
  let section = createSection('Intro / Untagged', 0)
  let provisional = false
  for (const [index, input] of documentLines(doc).entries()) {
    const local = analyzeLine(input, tagOverrides)
    const line: LineAnalysis = {
      index, from: input.from, to: input.to, text: input.text,
      confirmedMora: local.confirmedMora, confirmedSyllables: local.confirmedSyllables,
      unresolved: shiftedProblems(local.unresolved, input.from), complete: local.complete,
      evidence: [...local.evidence], tags: local.parsed.tags.map(tag => ({ ...tag, from: tag.from + input.from, to: tag.to + input.from })),
      sectionId: section.id,
    }
    const events = [
      ...local.contributions.map(contribution => ({ from: contribution.from, contribution, tag: undefined })),
      ...local.parsed.tags.filter(tag => tag.semantic === 'section').map(tag => ({ from: tag.from, tag, contribution: undefined })),
    ].sort((a, b) => a.from - b.from)
    for (const event of events) {
      if (event.tag) {
        section.to = input.from + event.from
        if (section.id === 'section-0' && !section.lineCount && !section.unresolved.length) result.sections.pop()
        section = createSection(event.tag.name, input.from + event.from)
        provisional = false
      } else if (event.contribution) {
        const contribution = event.contribution
        const shifted: ProsodyResult = { ...contribution, unresolved: shiftedProblems(contribution.unresolved, input.from), evidence: [...contribution.evidence] }
        if (contribution.unresolved.some(problem => problem.reason === 'unclosed_tag')) provisional = true
        addResult(section, shifted)
        if (contribution.hasText) sectionLines.get(section.id)!.add(index)
        section.lineCount = sectionLines.get(section.id)!.size
        section.provisional ||= provisional
      }
    }
    section.to = input.to
    line.sectionId = section.id
    result.lines.push(line)
    addResult(result, line)
  }
  for (const current of result.sections) current.complete = current.unresolved.length === 0 && !current.provisional
  return result
}
