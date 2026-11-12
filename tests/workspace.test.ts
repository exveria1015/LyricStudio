import { describe, expect, it } from 'vitest'
import { createDemoFile, createLyricsFile, documentToText, parseLyricsFile, serializeLyricsFile } from '../src/model/document'
import { createWorkspace, parseWorkspaceFile, serializeWorkspaceFile } from '../src/model/workspace'

function pairedWorkspace() {
  const workspace = createWorkspace(createDemoFile(), createLyricsFile('[Verse 1]\nEchoes in the rain\n', 'English adaptation'))
  workspace.activePane = 'b'
  workspace.layout = { mode: 'horizontal', ratio: 0.37 }
  workspace.comparison = {
    visible: true, kind: 'documents', leftSectionId: 'section-a', rightSectionId: 'section-b',
    alignment: {
      leftDocumentId: workspace.documents.a.documentId,
      rightDocumentId: workspace.documents.b!.documentId,
      leftSectionId: 'section-a', rightSectionId: 'section-b',
      leftLines: ['響く声を Break the night', 'まだ見ぬ光へ'],
      rightLines: ['Echoes in the rain'],
      rows: [{ left: 0, right: 0 }, { left: 1, right: null }],
    },
  }
  return workspace
}

describe('workspace native round-trip', () => {
  it('preserves both originals, readings, identities, active pane, ratio and explicit pairing', () => {
    const workspace = pairedWorkspace()
    expect(parseWorkspaceFile(serializeWorkspaceFile(workspace))).toEqual(workspace)
    expect(serializeWorkspaceFile(workspace)).toContain('author_ruby')
  })

  it('keeps the existing single-document format unchanged and independently exportable', () => {
    const source = createDemoFile()
    const native = serializeLyricsFile(source)
    const workspace = createWorkspace(source)
    expect(workspace.documents.a).toEqual(source)
    expect(workspace.documents.b).toBeNull()
    expect(workspace.activePane).toBe('a')
    expect(workspace.layout).toEqual({ mode: 'single', ratio: 0.5 })
    expect(serializeLyricsFile(workspace.documents.a)).toBe(native)
    expect(parseLyricsFile(native)).toEqual(source)
    expect(() => parseWorkspaceFile(native)).toThrow('単独の歌詞ファイル')
    expect(() => parseLyricsFile(serializeWorkspaceFile(workspace))).toThrow('Lyrics Studio形式')
  })

  it('isolates pane documents from each other and the caller, even for the same imported source', () => {
    const source = createDemoFile()
    const original = structuredClone(source)
    const workspace = createWorkspace(source, source)
    workspace.documents.b!.title = 'B only'
    workspace.documents.b!.editorDocument.content![1].content![0].marks![0].attrs!.reading = 'べつ'
    expect(workspace.documents.a).toEqual(original)
    expect(source).toEqual(original)
    // Loading the same native document twice does not rewrite its source identity.
    expect(workspace.documents.a.documentId).toBe(workspace.documents.b!.documentId)
  })

  it('retains a hidden B document when returning to single-pane layout', () => {
    const workspace = pairedWorkspace()
    workspace.layout.mode = 'single'
    const restored = parseWorkspaceFile(serializeWorkspaceFile(workspace))
    expect(restored.documents.b).toEqual(workspace.documents.b)
    expect(restored.activePane).toBe('b')
  })

  it('preserves stale author pairing for the comparison UI to flag, without changing source text', () => {
    const workspace = pairedWorkspace()
    workspace.documents.b!.editorDocument.content![1].content![0].text = 'A changed English line'
    const restored = parseWorkspaceFile(serializeWorkspaceFile(workspace))
    expect(restored.comparison.alignment!.rightLines).toEqual(['Echoes in the rain'])
    expect(documentToText(restored.documents.b!.editorDocument)).toContain('A changed English line')
  })

  it('preserves explicitly reordered translation pairing when every line remains represented', () => {
    const workspace = pairedWorkspace()
    workspace.comparison.alignment!.rows = [{ left: 1, right: 0 }, { left: 0, right: null }]
    expect(parseWorkspaceFile(serializeWorkspaceFile(workspace)).comparison.alignment).toEqual(workspace.comparison.alignment)
  })
})

describe('workspace validation protects stored drafts', () => {
  it('rejects malformed and future files without mutating the current workspace', () => {
    const workspace = pairedWorkspace()
    const original = structuredClone(workspace)
    expect(() => parseWorkspaceFile('{')).toThrow('JSON')
    expect(() => parseWorkspaceFile(JSON.stringify({ ...workspace, schemaVersion: 2 }))).toThrow('新しい形式')
    expect(workspace).toEqual(original)
  })

  it.each([0, 1, -0.5, 2, '0.5', null])('rejects invalid split ratio %s', ratio => {
    const workspace = pairedWorkspace()
    expect(() => parseWorkspaceFile(JSON.stringify({ ...workspace, layout: { ...workspace.layout, ratio } }))).toThrow('分割比率')
  })

  it.each(['activePane', 'split', 'documentComparison'])('rejects absent B for %s', which => {
    const workspace = createWorkspace(createLyricsFile())
    if (which === 'activePane') workspace.activePane = 'b'
    if (which === 'split') workspace.layout.mode = 'vertical'
    if (which === 'documentComparison') workspace.comparison.kind = 'documents'
    expect(() => serializeWorkspaceFile(workspace)).toThrow('文書B')
  })

  it('validates each embedded native document before accepting a workspace', () => {
    const workspace = pairedWorkspace()
    const invalid = { ...workspace, documents: { ...workspace.documents, b: { ...workspace.documents.b, schemaVersion: 9 } } }
    expect(() => parseWorkspaceFile(JSON.stringify(invalid))).toThrow('documents.b')
    expect(() => parseWorkspaceFile(JSON.stringify(invalid))).toThrow('新しい形式')
  })

  it('rejects unknown attributes and suspicious object keys', () => {
    const workspace = pairedWorkspace()
    expect(() => parseWorkspaceFile(JSON.stringify({ ...workspace, onload: 'alert(1)' }))).toThrow('未対応の属性')
    expect(() => parseWorkspaceFile(JSON.stringify({ ...workspace, layout: JSON.parse('{"mode":"single","ratio":0.5,"__proto__":{}}') }))).toThrow('未対応の属性')
  })

  it.each([
    [{ left: null, right: null }],
    [{ left: 3, right: 0 }],
    [{ left: -1, right: 0 }],
    [{ left: 0.5, right: 0 }],
    [{ left: '0', right: 0 }],
    [{ left: 0, right: 0 }, { left: 0, right: null }],
    [{ left: 0, right: 0 }, { left: 1, right: 0 }],
    [{ left: 0, right: 0 }],
    [],
  ].map(rows => ({ rows })))('rejects impossible, missing or duplicate pairing $rows', ({ rows }) => {
    const workspace = pairedWorkspace()
    const alignment = { ...workspace.comparison.alignment, rows }
    const invalid = { ...workspace, comparison: { ...workspace.comparison, alignment } }
    expect(() => parseWorkspaceFile(JSON.stringify(invalid))).toThrow('comparison.alignment')
  })

  it('rejects multiline snapshot entries', () => {
    const workspace = pairedWorkspace()
    workspace.comparison.alignment!.leftLines = ['かな\nうた']
    expect(() => serializeWorkspaceFile(workspace)).toThrow('改行を含まない')
  })
})
