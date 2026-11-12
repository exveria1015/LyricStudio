import { documentToText, serializeLyricsFile, type LyricsFile } from '../model/document'

function filename(title: string, extension: string): string {
  const safeTitle = title.replace(/[<>:"/\\|?*\p{Cc}]/gu, '_').replace(/[. ]+$/, '').trim()
  return `${safeTitle || '無題の歌詞'}${extension}`
}

export function download(content: string, name: string, type: string): void {
  const url = URL.createObjectURL(new Blob([content], { type }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = name
  document.body.append(anchor)
  try { anchor.click() } finally {
    anchor.remove()
    // Let the browser begin reading the blob before releasing its URL.
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
}

export function downloadNative(file: LyricsFile): void {
  download(serializeLyricsFile(file), filename(file.title, '.lyrics.json'), 'application/json;charset=utf-8')
}

export function downloadText(file: LyricsFile): void {
  download(documentToText(file.editorDocument), filename(file.title, '.txt'), 'text/plain;charset=utf-8')
}
