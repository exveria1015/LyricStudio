/** Local deterministic fixture benchmark; no user's draft or browser profile is opened. */
import { createServer } from 'vite'
import { performance } from 'node:perf_hooks'
import { cpus, platform, release } from 'node:os'
import { log } from 'node:console'
import process from 'node:process'

const server = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' })
try {
  const { analyzeDocument, countEnglishSyllables } = await server.ssrLoadModule('/src/analysis/index.ts')
  const paragraph = text => ({ type: 'paragraph', content: [{ type: 'text', text }] })
  const document = lines => ({ type: 'doc', content: lines.map(paragraph) })
  const timed = operation => { const before = performance.now(); operation(); return performance.now() - before }
  const summary = values => {
    const sorted = [...values].sort((a, b) => a - b)
    return { samples: sorted.length, minMs: sorted[0], medianMs: sorted[Math.floor(sorted.length / 2)], p95Ms: sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)], maxMs: sorted.at(-1) }
  }
  const kana = 'あいうえおかきくけこさしすせそ'
  const suffix = value => Array.from({ length: 4 }, (_, place) => kana[Math.floor(value / kana.length ** place) % kana.length]).join('')
  const line = index => `${suffix(index)} かなきょう Break the night `.padEnd(50, 'あ').slice(0, 50)
  const lines = Array.from({ length: 200 }, (_, index) => line(index))
  const input = document(lines)
  const initialDictionaryMs = timed(() => countEnglishSyllables('Break'))
  const firstDocumentMs = timed(() => analyzeDocument(input))
  const singleLongLineMs = timed(() => analyzeDocument(document(['かなきょう Break the night '.repeat(500).slice(0, 10_000)])))
  const cold = []
  const edited = []
  const singleLine = []
  for (let run = 0; run < 20; run++) {
    cold.push(timed(() => analyzeDocument(document(lines.map((text, index) => `${suffix((run + 1) * 200 + index)}${text.slice(4)}`)))))
  }
  analyzeDocument(input) // Prime cached line analyses before measuring a single changed line.
  for (let run = 0; run < 20; run++) {
    const changed = lines.map((text, index) => index === 100 ? `${text}${suffix(run)}` : text)
    edited.push(timed(() => analyzeDocument(document(changed))))
    singleLine.push(timed(() => analyzeDocument(document([`${line(run)}${suffix(run + 100)}`]))))
  }
  log(JSON.stringify({
    environment: { node: process.version, os: `${platform()} ${release()}`, cpu: cpus()[0]?.model, logicalCpus: cpus().length, loadControlled: false },
    fixture: { lines: lines.length, charactersExcludingNewlines: lines.join('').length, externalData: false },
    scope: 'Synchronous pure analysis only. This does not measure rendering, physical typing, or OS IME.',
    initialDictionaryMs, firstDocumentMs, singleLongLineMs,
    coldDocument: summary(cold), cachedDocumentWithOneChangedLine: summary(edited), typicalSingleLine: summary(singleLine),
  }, null, 2))
} finally {
  await server.close()
}
