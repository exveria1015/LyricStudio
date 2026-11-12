/** Include original license/notice texts for locked runtime dependencies. */
import { readFile, readdir, writeFile, copyFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { log } from 'node:console'
import { root } from './python.mjs'

const lock = JSON.parse(await readFile(resolve(root, 'package-lock.json'), 'utf8'))
const sections = ['LyricStudio — third-party JavaScript license notices',
  'This inventory includes all locked non-dev dependencies, even if tree-shaken from the bundle.']
let count = 0
for (const [path, entry] of Object.entries(lock.packages).sort(([a], [b]) => a.localeCompare(b, 'en'))) {
  if (!path || entry.dev) continue
  const directory = resolve(root, path)
  const metadata = JSON.parse(await readFile(resolve(directory, 'package.json'), 'utf8'))
  if (metadata.version !== entry.version) throw new Error(`Installed version differs from lockfile: ${path}. Run npm ci.`)
  const notices = (await readdir(directory, { withFileTypes: true }))
    .filter(file => file.isFile() && /^(license|licence|copying|notice)(\.|$)/i.test(file.name))
    .map(file => file.name).sort()
  if (!notices.length) throw new Error(`License text missing for ${metadata.name}; review its distribution terms before building.`)
  sections.push(`\n${'='.repeat(72)}\n${metadata.name}@${entry.version} (${entry.license ?? 'see text'})`)
  for (const name of notices) sections.push(`\n--- ${name} ---\n${await readFile(resolve(directory, name), 'utf8')}`)
  count++
}
await writeFile(resolve(root, 'dist/THIRD_PARTY_LICENSES.txt'), sections.join('\n') + '\n')
await copyFile(resolve(root, 'LICENSE'), resolve(root, 'dist/LICENSE.txt'))
log(`Included license texts for ${count} runtime dependencies.`)
