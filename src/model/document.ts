import type { JSONContent } from '@tiptap/core'
import { ENGLISH_DICTIONARY_VERSION, MORA_RULES_VERSION } from '../analysis/versions'

export type TagSemantic = 'section' | 'instruction' | 'unknown'
export type ViewMode = 'plain' | 'ruby' | 'analysis'

/** The native source of truth. Analysis results are deliberately not stored here. */
export interface LyricsFile {
  format: 'lyrics-studio'
  schemaVersion: 1
  documentId: string
  title: string
  createdAt: string
  updatedAt: string
  editorDocument: JSONContent
  settings: {
    untaggedSectionName: string
    viewMode: ViewMode
    tagOverrides: Record<string, TagSemantic>
  }
  engine: {
    moraRulesVersion: string
    englishDictionaryVersion: string
  }
}

const MAX_FILE_BYTES = 10 * 1024 * 1024
const hasOwn = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key)

function uniqueId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `lyrics-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

/** Only line boundaries are normalized; spelling, spaces and Unicode stay untouched. */
export function textToDocument(text: string): JSONContent {
  return {
    type: 'doc',
    content: text.split(/\r\n|\r|\n/).map((line) => ({
      type: 'paragraph',
      ...(line ? { content: [{ type: 'text', text: line }] } : {}),
    })),
  }
}

/** Ruby is metadata: a text export always uses the original visible spelling. */
export function documentToText(document: JSONContent): string {
  if (document.type !== 'doc') fail('editorDocument', '文書ノード（doc）が必要です。')
  return (document.content ?? []).map((paragraph) => {
    if (paragraph.type !== 'paragraph') fail('editorDocument', '段落以外のブロックは対応していません。')
    return (paragraph.content ?? []).map((node) => {
      if (node.type === 'hardBreak') return '\n'
      if (node.type !== 'text' || typeof node.text !== 'string') {
        fail('editorDocument', '本文にはテキストと改行だけを使用できます。')
      }
      return node.text
    }).join('')
  }).join('\n')
}

export function createLyricsFile(text = '', title = '無題の歌詞'): LyricsFile {
  const now = new Date().toISOString()
  return {
    format: 'lyrics-studio',
    schemaVersion: 1,
    documentId: uniqueId(),
    title,
    createdAt: now,
    updatedAt: now,
    editorDocument: textToDocument(text),
    settings: { untaggedSectionName: 'Intro / Untagged', viewMode: 'analysis', tagOverrides: {} },
    engine: {
      moraRulesVersion: MORA_RULES_VERSION,
      englishDictionaryVersion: ENGLISH_DICTIONARY_VERSION,
    },
  }
}

function fail(path: string, reason: string): never {
  throw new Error(`歌詞ファイルを読み込めません（${path}）：${reason}`)
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(path, 'オブジェクトが必要です。')
  return value as Record<string, unknown>
}

function keys(value: Record<string, unknown>, allowed: string[], required: string[], path: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail(path, `未対応の属性「${key}」があります。元ファイルは変更されません。`)
  }
  for (const key of required) {
    if (!hasOwn(value, key)) fail(`${path}.${key}`, '必須項目がありません。')
  }
}

function string(value: unknown, path: string, nonempty = false): asserts value is string {
  if (typeof value !== 'string' || (nonempty && !value.trim())) {
    fail(path, nonempty ? '空でない文字列が必要です。' : '文字列が必要です。')
  }
}

function id(value: unknown, path: string, maxLength = 256): asserts value is string {
  string(value, path, true)
  if (value.length > maxLength || /\p{Cc}/u.test(value)) fail(path, '識別子が不正です。')
}

function date(value: unknown, path: string): void {
  string(value, path, true)
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value) || !Number.isFinite(Date.parse(value))) {
    fail(path, 'ISO 8601形式の日時が必要です。')
  }
}

interface AnnotationRun { id: string; base: string; text: string; signature: string }

function validateDocument(value: unknown): void {
  const document = record(value, 'editorDocument')
  keys(document, ['type', 'content'], ['type', 'content'], 'editorDocument')
  if (document.type !== 'doc') fail('editorDocument.type', '「doc」が必要です。')
  if (!Array.isArray(document.content) || !document.content.length) fail('editorDocument.content', '1つ以上の段落が必要です。')

  const seenIds = new Set<string>()
  for (const [paragraphIndex, entry] of document.content.entries()) {
    const path = `editorDocument.content[${paragraphIndex}]`
    const paragraph = record(entry, path)
    keys(paragraph, ['type', 'content'], ['type'], path)
    if (paragraph.type !== 'paragraph') fail(`${path}.type`, '対応しているブロックは「paragraph」だけです。')
    if (hasOwn(paragraph, 'content') && !Array.isArray(paragraph.content)) fail(`${path}.content`, '配列が必要です。')

    let run: AnnotationRun | null = null
    const finishRun = () => {
      if (!run) return
      if (run.text !== run.base) fail(path, '読み指定の元の表記と本文が一致しません。読み範囲の再指定が必要です。')
      if (seenIds.has(run.id)) fail(path, '読み指定の識別子が離れた範囲で重複しています。')
      seenIds.add(run.id)
      run = null
    }

    for (const [textIndex, child] of ((paragraph.content ?? []) as unknown[]).entries()) {
      const nodePath = `${path}.content[${textIndex}]`
      const node = record(child, nodePath)
      if (node.type === 'hardBreak') {
        keys(node, ['type'], ['type'], nodePath)
        finishRun()
        continue
      }
      keys(node, ['type', 'text', 'marks'], ['type', 'text'], nodePath)
      if (node.type !== 'text') fail(`${nodePath}.type`, '本文には「text」と「hardBreak」だけを使用できます。')
      string(node.text, `${nodePath}.text`)
      if (!node.text.length || /[\r\n]/.test(node.text)) fail(`${nodePath}.text`, '空テキストや本文内の改行は使用できません。段落かhardBreakを使用してください。')
      if (hasOwn(node, 'marks') && !Array.isArray(node.marks)) fail(`${nodePath}.marks`, '配列が必要です。')
      const marks = (node.marks ?? []) as unknown[]
      if (marks.length > 1) fail(`${nodePath}.marks`, '同じ範囲に複数の読み・音節指定は重ねられません。')
      if (!marks.length) {
        finishRun()
        continue
      }
      const markPath = `${nodePath}.marks[0]`
      const mark = record(marks[0], markPath)
      keys(mark, ['type', 'attrs'], ['type', 'attrs'], markPath)
      if (mark.type !== 'rubyReading' && mark.type !== 'syllableOverride') fail(`${markPath}.type`, '未対応の読みマークです。')
      const attrs = record(mark.attrs, `${markPath}.attrs`)
      const readingKey = mark.type === 'rubyReading' ? 'reading' : 'syllables'
      const attributeKeys = ['id', readingKey, 'source', 'base']
      keys(attrs, attributeKeys, attributeKeys, `${markPath}.attrs`)
      id(attrs.id, `${markPath}.attrs.id`, 128)
      string(attrs.base, `${markPath}.attrs.base`, true)
      if (/[\r\n]/.test(attrs.base)) fail(markPath, '複数行にまたがる読み指定は使用できません。')
      if (mark.type === 'rubyReading') {
        string(attrs.reading, `${markPath}.attrs.reading`, true)
        if (attrs.reading.length > 512) fail(markPath, '1つの読み指定は512文字以内にしてください。')
        if (/[\r\n]/.test(attrs.reading)) fail(markPath, '読みには改行を含められません。')
        if (attrs.source !== 'author_ruby') fail(markPath, '読みの由来には「author_ruby」が必要です。')
      } else {
        if (!Number.isSafeInteger(attrs.syllables) || (attrs.syllables as number) < 1 || (attrs.syllables as number) > 100) fail(markPath, '作者指定の音節数は1以上100以下の整数が必要です。')
        if (attrs.source !== 'author_syllables') fail(markPath, '音節の由来には「author_syllables」が必要です。')
      }
      // An editor may split adjacent text nodes while keeping one annotation.
      const signature = JSON.stringify([mark.type, attrs.id, attrs.base, attrs.source, attrs[readingKey]])
      const currentRun = run as AnnotationRun | null
      if (currentRun?.signature === signature) {
        currentRun.text += node.text
      } else {
        finishRun()
        run = { id: attrs.id, base: attrs.base, text: node.text, signature }
      }
    }
    finishRun()
  }
}

/** Refuse incompatible data instead of silently dropping fields or replacing a draft. */
export function parseLyricsFile(raw: string): LyricsFile {
  if (new TextEncoder().encode(raw).length > MAX_FILE_BYTES) fail('ファイル容量', '10 MBを超えるファイルには対応していません。')
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { fail('JSON', 'JSONが壊れているか、歌詞のネイティブ保存形式ではありません。') }
  const file = record(parsed, 'ルート')
  if (file.format !== 'lyrics-studio') fail('format', 'Lyrics Studio形式のファイルではありません。')
  if (typeof file.schemaVersion === 'number' && file.schemaVersion > 1) fail('schemaVersion', `新しい形式（${file.schemaVersion}）です。対応する新しいアプリで開いてください。元ファイルと編集中の文書は変更されません。`)
  if (file.schemaVersion !== 1) fail('schemaVersion', '対応している形式バージョンは1です。')
  const fileKeys = ['format', 'schemaVersion', 'documentId', 'title', 'createdAt', 'updatedAt', 'editorDocument', 'settings', 'engine']
  keys(file, fileKeys, fileKeys, 'ルート')
  id(file.documentId, 'documentId')
  string(file.title, 'title')
  date(file.createdAt, 'createdAt')
  date(file.updatedAt, 'updatedAt')
  validateDocument(file.editorDocument)

  const settings = record(file.settings, 'settings')
  const settingKeys = ['untaggedSectionName', 'viewMode', 'tagOverrides']
  keys(settings, settingKeys, settingKeys, 'settings')
  string(settings.untaggedSectionName, 'settings.untaggedSectionName', true)
  if (!['plain', 'ruby', 'analysis'].includes(settings.viewMode as string)) fail('settings.viewMode', '表示モードが不正です。')
  const overrides = record(settings.tagOverrides, 'settings.tagOverrides')
  for (const [name, semantic] of Object.entries(overrides)) {
    if (['__proto__', 'prototype', 'constructor'].includes(name)) fail('settings.tagOverrides', '予約済みの属性名は使用できません。')
    if (!name.trim() || /[\r\n]/.test(name) || !['section', 'instruction', 'unknown'].includes(semantic as string)) fail('settings.tagOverrides', 'タグ名または分類が不正です。')
  }
  const engine = record(file.engine, 'engine')
  keys(engine, ['moraRulesVersion', 'englishDictionaryVersion'], ['moraRulesVersion', 'englishDictionaryVersion'], 'engine')
  string(engine.moraRulesVersion, 'engine.moraRulesVersion', true)
  string(engine.englishDictionaryVersion, 'engine.englishDictionaryVersion', true)
  return parsed as LyricsFile
}

export function serializeLyricsFile(file: LyricsFile): string {
  const serialized = JSON.stringify(file, null, 2)
  parseLyricsFile(serialized)
  return `${serialized}\n`
}

/** These readings are authored sample annotations, never automatic inference. */
export function createDemoFile(): LyricsFile {
  const file = createLyricsFile('', '雨の向こうへ')
  const ruby = (base: string, reading: string): JSONContent => ({
    type: 'text', text: base,
    marks: [{ type: 'rubyReading', attrs: { id: uniqueId(), reading, source: 'author_ruby', base } }],
  })
  const line = (...parts: Array<string | JSONContent>): JSONContent => ({
    type: 'paragraph',
    ...(parts.length ? { content: parts.map((part) => typeof part === 'string' ? { type: 'text', text: part } : part) } : {}),
  })
  file.editorDocument = {
    type: 'doc', content: [
      line('[Verse 1]'),
      line(ruby('響', 'ひび'), 'く', ruby('声', 'こえ'), 'を Break the night'),
      line('まだ', ruby('見', 'み'), 'ぬ', ruby('光', 'ひかり'), 'へ'),
      line(ruby('冷', 'つめ'), 'たい', ruby('雨', 'あめ'), 'を', ruby('照', 'て'), 'らして'),
      line(),
      line('[Pre-Chorus]'),
      line('届かない明日を なぞって'),
      line(),
      line('[Chorus]'),
      line(ruby('鳴', 'な'), 'らして ', ruby('君', 'きみ'), 'のオトを'),
      line('この', ruby('冷', 'つめ'), 'たい', ruby('雨', 'あめ'), ' ', ruby('照', 'て'), 'らして'),
      line(ruby('彩', 'いろど'), 'りを ', ruby('輝', 'かがや'), 'きを ', ruby('見上', 'みあ'), 'げた', ruby('月', 'つき'), 'まで'),
      line(),
    ],
  }
  return file
}
