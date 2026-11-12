import { useMemo } from 'react'
import { ArrowDown, ArrowRight, RotateCcw, X } from 'lucide-react'
import type { LyricsFile } from '../model/document'
import { analyzeDocument } from '../analysis'
import {
  assignAlignmentLine, compareLyrics, createAlignment, insertAlignmentGap, removeAlignmentGap,
} from './comparison'
import type { AlignmentSnapshot, ComparisonDelta, ComparisonLine, ComparisonSide, ComparisonSource, ComparisonSummary } from './comparison'
import './comparison.css'

export interface ComparisonPatch {
  kind?: 'sections' | 'documents'
  leftSectionId?: string | null
  rightSectionId?: string | null
  alignment?: AlignmentSnapshot | null
}
export interface ComparisonPanelProps {
  leftDocument: LyricsFile
  rightDocument: LyricsFile
  kind: 'sections' | 'documents'
  leftSectionId: string | null
  rightSectionId: string | null
  alignment: AlignmentSnapshot | null
  onChange: (patch: ComparisonPatch) => void
  onJump: (side: ComparisonSide, from: number, to: number) => void
  onClose: () => void
}

function deltaText(delta: ComparisonDelta): string {
  if (delta.value === null) return '—'
  return `${delta.value > 0 ? '+' : ''}${delta.value}${delta.provisional ? ' *' : ''}`
}

function Summary({ label, value }: { label: string; value: ComparisonSummary }) {
  return <div className="comparison-summary-side">
    <span>{label}<small>{value.lineCount} 行</small></span>
    <strong>{value.available ? <>{value.confirmedMora}<small>mora</small><span> / </span>{value.confirmedSyllables}<small>syl</small></> : '対象がありません'}</strong>
    {!value.complete && value.available && <small className="comparison-warning">確定部分の合計 · 未確定 {value.unresolvedCount}{value.provisional ? ' · 所属は暫定' : ''}</small>}
  </div>
}

export function ComparisonPanel({ leftDocument, rightDocument, kind, leftSectionId, rightSectionId, alignment, onChange, onJump, onClose }: ComparisonPanelProps) {
  const leftAnalysis = useMemo(() => analyzeDocument(leftDocument.editorDocument, leftDocument.settings.tagOverrides), [leftDocument.editorDocument, leftDocument.settings.tagOverrides])
  const rightAnalysis = useMemo(() => analyzeDocument(rightDocument.editorDocument, rightDocument.settings.tagOverrides), [rightDocument.editorDocument, rightDocument.settings.tagOverrides])
  const left = useMemo<ComparisonSource>(() => ({ documentId: leftDocument.documentId, analysis: leftAnalysis, sectionId: leftSectionId }), [leftDocument.documentId, leftAnalysis, leftSectionId])
  const right = useMemo<ComparisonSource>(() => ({ documentId: rightDocument.documentId, analysis: rightAnalysis, sectionId: rightSectionId }), [rightDocument.documentId, rightAnalysis, rightSectionId])
  const comparison = useMemo(() => compareLyrics(left, right, alignment), [left, right, alignment])
  const stale = comparison.alignmentStatus === 'stale'
  const unavailable = comparison.scopeMissing.left || comparison.scopeMissing.right
  const current = () => alignment && comparison.alignmentStatus === 'manual' ? alignment : createAlignment(left, right)
  const sideLabel = (side: ComparisonSide) => side === 'left' ? 'A' : 'B'
  function selectScope(side: ComparisonSide, value: string) {
    onChange({ [side === 'left' ? 'leftSectionId' : 'rightSectionId']: value || null, alignment: null })
  }
  function lineCell(side: ComparisonSide, line: ComparisonLine | null, rowIndex: number) {
    const label = sideLabel(side)
    const allLines = side === 'left' ? comparison.leftLines : comparison.rightLines
    return <div className={`comparison-line-cell ${line ? '' : 'is-gap'}`}>
      {line ? <>
        <button className="comparison-line-text" title={`編集位置へ移動 · 原文: ${line.rawText}`} onClick={() => onJump(side, line.from, line.to)}>
          <span className="comparison-source-number">{line.index + 1}</span><span>{line.bodyText}</span><ArrowRight size={12} />
        </button>
        <span className={`comparison-line-count ${line.complete ? '' : 'comparison-warning'}`}>
          {line.countsAvailable ? <>{line.confirmedMora} mora / {line.confirmedSyllables} syl{line.complete ? '' : ' · 未確定'}</> : 'この行は複数セクションにまたがります'}
        </span>
      </> : <span className="comparison-gap-label">対応する行なし</span>}
      <div className="comparison-row-tools">
        <label><span className="comparison-sr-only">{label} 対応行 {rowIndex + 1}</span><select aria-label={`${label} 対応行 ${rowIndex + 1}`} value={line?.bodyIndex ?? ''} disabled={stale || unavailable} onChange={event => onChange({ alignment: assignAlignmentLine(current(), side, rowIndex, event.target.value === '' ? null : Number(event.target.value)) })}>
          <option value="">対応なし</option>
          {allLines.map(item => <option key={item.bodyIndex} value={item.bodyIndex}>{item.bodyIndex + 1}: {item.bodyText.slice(0, 45)}</option>)}
        </select></label>
        {line ? <button type="button" title={`${label} 側に空きを入れ、以降を1行下へずらす`} aria-label={`${label} ${rowIndex + 1}行目に空きを入れる`} disabled={stale || unavailable} onClick={() => onChange({ alignment: insertAlignmentGap(current(), side, rowIndex) })}><ArrowDown size={12} />空きを入れる</button>
          : <button type="button" title={`${label} 側の空きを詰める`} aria-label={`${label} ${rowIndex + 1}行目の空きを詰める`} disabled={stale || unavailable} onClick={() => onChange({ alignment: removeAlignmentGap(current(), side, rowIndex) })}>空きを詰める</button>}
      </div>
    </div>
  }

  return <section className="comparison-panel" aria-label={kind === 'sections' ? 'セクション比較' : 'A/B 歌詞比較'}>
    <header className="comparison-header"><div><strong>{kind === 'sections' ? 'セクション比較' : 'A/B 歌詞比較'}</strong><span>行順を基準に、音数を見比べる</span></div><button aria-label="比較を閉じる" onClick={onClose}><X size={16} /></button></header>
    <div className="comparison-selectors">{(['left', 'right'] as const).map(side => {
      const document = side === 'left' ? leftDocument : rightDocument
      const analysis = side === 'left' ? leftAnalysis : rightAnalysis
      const id = side === 'left' ? leftSectionId : rightSectionId
      return <label key={side}><span>{sideLabel(side)} <strong>{document.title || '無題の歌詞'}</strong></span><select aria-label={`${sideLabel(side)} 比較するセクション`} value={id ?? ''} onChange={event => selectScope(side, event.target.value)}>
        <option value="">文書全体</option>
        {id && !analysis.sections.some(section => section.id === id) && <option value={id}>対象が変わりました · 再選択</option>}
        {analysis.sections.map((section, index) => <option key={section.id} value={section.id}>{index + 1}. {section.name === 'Intro / Untagged' ? document.settings.untaggedSectionName : section.name}</option>)}
      </select></label>
    })}</div>
    <div className="comparison-summaries"><Summary label="A" value={comparison.summary.left} /><div className="comparison-total-delta"><span>B − A</span><strong>{deltaText(comparison.summary.moraDelta)}<small>mora</small></strong><strong>{deltaText(comparison.summary.syllableDelta)}<small>syl</small></strong></div><Summary label="B" value={comparison.summary.right} /></div>
    {unavailable && <p className="comparison-alert" role="status">選択したセクションが変わりました。比較対象を選び直してください。</p>}
    {stale && <div className="comparison-alert" role="status"><p>本文の行が変わったため、以前の手動対応は適用していません。下には現在の行順を仮表示しています。</p><button disabled={unavailable} onClick={() => onChange({ alignment: createAlignment(left, right) })}>現在の行順で対応を再確認</button></div>}
    <div className="comparison-guide"><span>{comparison.alignmentStatus === 'manual' ? '作者指定の行対応' : stale ? '行順で仮表示' : '行順で比較'} · 空行とタグだけの行は除外</span><button disabled={unavailable || comparison.rows.length === 0} onClick={() => onChange({ alignment: createAlignment(left, right) })}><RotateCcw size={12} />行順へ戻す</button></div>
    <div className="comparison-table" role="table" aria-label="本文行の音数比較"><div className="comparison-table-head" role="row"><span role="columnheader">A 本文</span><span role="columnheader">差 B − A<br /><small>mora / syl</small></span><span role="columnheader">B 本文</span></div>
      {comparison.rows.map((row, index) => <div className="comparison-table-row" role="row" key={row.id}>
        <div role="cell">{lineCell('left', row.left, index)}</div>
        <div role="cell" className={`comparison-delta-cell ${row.moraDelta.provisional || row.syllableDelta.provisional ? 'is-provisional' : ''}`}><span>{deltaText(row.moraDelta)}<small>mora</small></span><span>{deltaText(row.syllableDelta)}<small>syl</small></span>{row.missing && <small>対応なし</small>}</div>
        <div role="cell">{lineCell('right', row.right, index)}</div>
      </div>)}
      {comparison.rows.length === 0 && <div className="comparison-empty">比較する本文行がありません。</div>}
    </div>
    <p className="comparison-footnote">* 未確定を含む差は、確定部分だけを引いた暫定値です。モーラとシラブルは別々に比較します。行対応は作者が指定でき、意味や翻訳の正しさは推定しません。</p>
  </section>
}

export default ComparisonPanel
