/* global fetch, AbortSignal */
/** Start only our own local processes; never terminate an existing editor. */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import process from 'node:process'
import { log, error } from 'node:console'
import { root, python } from './python.mjs'

const production = process.argv[2] === 'serve'
const extra = process.argv.slice(3)
const children = new Set()
let stopping = false
function stop(code = 0) {
  if (stopping) return
  stopping = true
  for (const child of children) {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) continue
    if (process.platform === 'win32') {
      // Windows venv launchers can have a Python child; stop only our process tree.
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true })
      killer.on('error', () => child.kill())
    } else child.kill('SIGTERM')
  }
  process.exitCode = code
}
process.on('SIGINT', () => stop())
process.on('SIGTERM', () => stop())

function start(command, args, primary = false) {
  const child = spawn(command, args, { cwd: root, stdio: 'inherit', windowsHide: true })
  children.add(child)
  child.on('error', cause => { error(cause.message); children.delete(child); if (primary) stop(1) })
  child.on('exit', code => { children.delete(child); if (primary) stop(code ?? 0) })
  return child
}

if (production) {
  if (!existsSync(python) || !existsSync(resolve(root, 'dist/index.html'))) {
    error('先に npm run setup:readings と npm run build を実行してください。')
    process.exitCode = 1
  } else start(python, ['backend/server.py', '--static', 'dist', '--port', '4173', ...extra], true)
} else {
  let running = false
  try {
    const response = await fetch('http://127.0.0.1:8787/api/readings/health', { signal: AbortSignal.timeout(1500) })
    const health = await response.json()
    running = health.service === 'lyrics-studio-readings'
    if (!running) throw new Error('port 8787 is used by another service')
  } catch (cause) {
    if (cause instanceof Error && cause.message === 'port 8787 is used by another service') {
      error('8787番ポートを別のサービスが使用しています。読み探索の起動を見送りました。')
      running = true // Do not try to bind over an unrelated service.
    }
  }
  if (!running && existsSync(python)) start(python, ['backend/server.py', '--port', '8787'])
  else if (!running) log('読み探索を使うには npm run setup:readings を実行してください。歌詞の編集画面を起動します。')
  if (!stopping) start(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', ...extra], true)
}
