import { parseLyricsFile, type LyricsFile } from './document'
import type { AlignmentSnapshot } from '../features/comparison'

export type PaneId = 'a' | 'b'
export type SplitMode = 'single' | 'vertical' | 'horizontal'

/** Both panes and their pairing are one atomic saved source of truth. */
export interface WorkspaceFile {
  format: 'lyrics-studio-workspace'
  schemaVersion: 1
  workspaceId: string
  documents: { a: LyricsFile; b: LyricsFile | null }
  activePane: PaneId
  layout: { mode: SplitMode; ratio: number }
  comparison: {
    visible: boolean
    kind: 'sections' | 'documents'
    leftSectionId: string | null
    rightSectionId: string | null
    alignment: AlignmentSnapshot | null
  }
}

const MAX_WORKSPACE_BYTES = 40 * 1024 * 1024

export function createWorkspace(a: LyricsFile, b: LyricsFile | null = null): WorkspaceFile {
  return {
    format: 'lyrics-studio-workspace',
    schemaVersion: 1,
    workspaceId: crypto.randomUUID(),
    documents: { a: structuredClone(a), b: b === null ? null : structuredClone(b) },
    activePane: 'a',
    layout: { mode: b === null ? 'single' : 'vertical', ratio: 0.5 },
    comparison: { visible: false, kind: b === null ? 'sections' : 'documents', leftSectionId: null, rightSectionId: null, alignment: null },
  }
}

function fail(path: string, reason: string): never {
  throw new Error(`ワークスペースを読み込めません（${path}）：${reason}`)
}

function object(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(path, 'オブジェクトが必要です。')
  return value as Record<string, unknown>
}

function exactKeys(value: Record<string, unknown>, keys: string[], path: string): void {
  for (const name of Object.keys(value)) {
    if (!keys.includes(name)) fail(path, `未対応の属性「${name}」があります。元ファイルは変更されません。`)
  }
  for (const name of keys) {
    if (!Object.prototype.hasOwnProperty.call(value, name)) fail(`${path}.${name}`, '必須項目がありません。')
  }
}

function identifier(value: unknown, path: string, nullable = false): void {
  if (nullable && value === null) return
  if (typeof value !== 'string' || !value.trim() || value.length > 256 || /\p{Cc}/u.test(value)) fail(path, '識別子が不正です。')
}

function validateAlignment(value: unknown): void {
  if (value === null) return
  const path = 'comparison.alignment'
  const alignment = object(value, path)
  exactKeys(alignment, ['leftDocumentId', 'rightDocumentId', 'leftSectionId', 'rightSectionId', 'leftLines', 'rightLines', 'rows'], path)
  for (const name of ['leftDocumentId', 'rightDocumentId']) identifier(alignment[name], `${path}.${name}`)
  for (const name of ['leftSectionId', 'rightSectionId']) identifier(alignment[name], `${path}.${name}`, true)
  for (const name of ['leftLines', 'rightLines']) {
    const lines = alignment[name]
    if (!Array.isArray(lines) || lines.some(line => typeof line !== 'string' || /[\r\n]/u.test(line))) fail(`${path}.${name}`, '改行を含まない原文行の配列が必要です。')
  }
  if (!Array.isArray(alignment.rows)) fail(`${path}.rows`, '対応行の配列が必要です。')
  const leftLength = (alignment.leftLines as string[]).length
  const rightLength = (alignment.rightLines as string[]).length
  const seenLeft = new Set<number>()
  const seenRight = new Set<number>()
  for (const [index, entry] of alignment.rows.entries()) {
    const row = object(entry, `${path}.rows[${index}]`)
    exactKeys(row, ['left', 'right'], `${path}.rows[${index}]`)
    if (row.left === null && row.right === null) fail(path, '両側とも空の対応行は保存できません。')
    for (const [side, length, seen] of [['left', leftLength, seenLeft], ['right', rightLength, seenRight]] as const) {
      const value = row[side]
      if (value === null) continue
      if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) >= length) fail(`${path}.rows[${index}].${side}`, '対応先の行番号が原文行の範囲外です。')
      if (seen.has(value as number)) fail(path, '同じ原文行が複数の対応行に重複しています。')
      seen.add(value as number)
    }
  }
  if (seenLeft.size !== leftLength || seenRight.size !== rightLength) fail(path, 'すべての原文行を対応行に1回ずつ含めてください。')
}

/** Validation is strict, and deliberately retains stale alignment for explicit UI review. */
export function parseWorkspaceFile(raw: string): WorkspaceFile {
  if (new TextEncoder().encode(raw).length > MAX_WORKSPACE_BYTES) fail('ファイル容量', '40 MBを超えるファイルには対応していません。')
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { fail('JSON', 'JSONが壊れているか、ワークスペース形式ではありません。') }
  const workspace = object(parsed, 'ルート')
  if (workspace.format !== 'lyrics-studio-workspace') fail('format', 'Lyrics Studioのワークスペース形式ではありません。単独の歌詞ファイルは文書として開いてください。')
  if (typeof workspace.schemaVersion === 'number' && workspace.schemaVersion > 1) fail('schemaVersion', `新しい形式（${workspace.schemaVersion}）です。対応する新しいアプリで開いてください。保存中の文書は変更されません。`)
  if (workspace.schemaVersion !== 1) fail('schemaVersion', '対応している形式バージョンは1です。')
  exactKeys(workspace, ['format', 'schemaVersion', 'workspaceId', 'documents', 'activePane', 'layout', 'comparison'], 'ルート')
  identifier(workspace.workspaceId, 'workspaceId')
  const documents = object(workspace.documents, 'documents')
  exactKeys(documents, ['a', 'b'], 'documents')
  for (const pane of ['a', 'b'] as const) {
    if (pane === 'b' && documents.b === null) continue
    try { parseLyricsFile(JSON.stringify(documents[pane])) } catch (error) { fail(`documents.${pane}`, error instanceof Error ? error.message : String(error)) }
  }
  if (workspace.activePane !== 'a' && workspace.activePane !== 'b') fail('activePane', '操作中の文書はaまたはbで指定してください。')
  if (workspace.activePane === 'b' && documents.b === null) fail('activePane', '文書Bが存在しません。')
  const layout = object(workspace.layout, 'layout')
  exactKeys(layout, ['mode', 'ratio'], 'layout')
  if (!['single', 'vertical', 'horizontal'].includes(layout.mode as string)) fail('layout.mode', '表示方法が不正です。')
  if (typeof layout.ratio !== 'number' || !Number.isFinite(layout.ratio) || layout.ratio <= 0 || layout.ratio >= 1) fail('layout.ratio', '分割比率は0より大きく1より小さい数値が必要です。')
  if (layout.mode !== 'single' && documents.b === null) fail('layout.mode', '分割表示には文書Bが必要です。')
  const comparison = object(workspace.comparison, 'comparison')
  exactKeys(comparison, ['visible', 'kind', 'leftSectionId', 'rightSectionId', 'alignment'], 'comparison')
  if (typeof comparison.visible !== 'boolean') fail('comparison.visible', '比較表示は真偽値で指定してください。')
  if (comparison.kind !== 'sections' && comparison.kind !== 'documents') fail('comparison.kind', '比較方法が不正です。')
  if (comparison.kind === 'documents' && documents.b === null) fail('comparison.kind', '文書比較には文書Bが必要です。')
  identifier(comparison.leftSectionId, 'comparison.leftSectionId', true)
  identifier(comparison.rightSectionId, 'comparison.rightSectionId', true)
  validateAlignment(comparison.alignment)
  return parsed as WorkspaceFile
}

export function serializeWorkspaceFile(workspace: WorkspaceFile): string {
  const raw = JSON.stringify(workspace, null, 2)
  parseWorkspaceFile(raw)
  return `${raw}\n`
}
