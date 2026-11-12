import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { error } from 'node:console'
import process from 'node:process'
import { findSystemPython, python, requirePython, root, run } from './python.mjs'

const [command, ...extra] = process.argv.slice(2)
try {
  if (command === 'setup') {
    if (extra.length) throw new Error('setup は追加の引数を受け付けません。')
    if (!existsSync(python)) {
      const venv = resolve(root, '.venv-sudachi')
      if (existsSync(venv)) throw new Error('.venv-sudachi にこのOS用のPythonがありません。既存環境を退避してから再実行してください。')
      const system = findSystemPython()
      run(system.command, [...system.args, '-m', 'venv', venv])
    }
    // venv inherits Python's bundled pip, which can predate installer security
    // fixes. Upgrade only this project's installer before fetching dependencies.
    run(python, ['-m', 'pip', 'install', '--disable-pip-version-check', '--upgrade', 'pip==26.3'])
    run(python, ['-m', 'pip', 'install', '--disable-pip-version-check', '-r', 'backend/requirements.txt'])
    run(python, ['backend/server.py', '--check'])
  } else if (command === 'test') {
    run(requirePython(), ['-m', 'unittest', 'discover', '-s', 'backend/tests', '-v', ...extra])
  } else if (command === 'check') {
    run(requirePython(), ['backend/server.py', '--check', ...extra])
  } else if (command === 'serve') {
    run(requirePython(), ['backend/server.py', ...extra])
  } else {
    throw new Error('使用方法: node scripts/readings.mjs <setup|check|test|serve>')
  }
} catch (cause) {
  error(cause.message)
  process.exitCode = 1
}
