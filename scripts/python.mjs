import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, URL } from 'node:url'
import { resolve } from 'node:path'
import process from 'node:process'

export const root = fileURLToPath(new URL('../', import.meta.url))
export const python = resolve(root, '.venv-sudachi', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')

export function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', windowsHide: true })
  if (result.error) throw new Error(`実行できません: ${command} (${result.error.message})`)
  if (result.status !== 0) throw new Error(`処理が失敗しました (終了コード: ${result.status ?? result.signal})。上の出力を確認してください。`)
}

export function requirePython() {
  if (!existsSync(python)) throw new Error('先に npm run setup:readings を実行してください。')
  return python
}

export function findSystemPython() {
  // An override is an executable path, never a shell command. Paths may contain spaces.
  const candidates = process.env.LYRICS_PYTHON
    ? [[process.env.LYRICS_PYTHON, []]]
    : process.platform === 'win32'
      ? [['py', ['-3']], ['python', []], ['python3', []]]
      : [['python3', []], ['python', []]]
  for (const [command, args] of candidates) {
    const result = spawnSync(command, [...args, '-c', 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)'], {
      cwd: root, stdio: 'ignore', windowsHide: true, timeout: 15_000,
    })
    if (!result.error && result.status === 0) return { command, args }
  }
  throw new Error('Python 3.10 以上をインストールしてください。必要なら LYRICS_PYTHON に python 実行ファイルのフルパスを指定してください。')
}
