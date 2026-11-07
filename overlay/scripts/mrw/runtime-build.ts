/** Build the private runtime locally, or stage a verified prebuilt module for public builds. */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { pnpmCommand } from '../release/process.ts'

const required = ['lib/private-runtime.js', 'assets/workbench-runtime.json', 'assets/NOTICE.txt', 'assets/manifest.json'] as const

export function buildPrivateRuntime(root: string): void {
  const packageRoot = resolve(root, 'packages/context/workbench-assistant')
  const [command, ...prefix] = pnpmCommand()
  execFileSync(command, [...prefix, 'exec', 'esbuild',
    'packages/context/workbench-assistant/src/internal/private-runtime.ts',
    '--bundle', '--packages=external', '--platform=node', '--format=esm', '--target=es2024',
    '--outfile=packages/context/workbench-assistant/lib/private-runtime.js',
    '--log-level=info',
  ], { cwd: root, stdio: 'inherit' })
  if (!readFileSync(resolve(packageRoot, 'lib/private-runtime.js')).length) {
    throw new Error('The private runtime bundle is empty.')
  }
}

export function stagePublicRuntime(root: string, archive = process.env.MRW_PUBLIC_RUNTIME_TGZ): void {
  if (!archive) throw new Error('Public build requires MRW_PUBLIC_RUNTIME_TGZ pointing to the approved runtime archive.')
  const lock: { productVersion: string; sha256: string; packageName: string } =
    JSON.parse(readFileSync(resolve(root, 'scripts/mrw/public-runtime.lock.json'), 'utf8'))
  const bytes = readFileSync(archive)
  const hash = createHash('sha256').update(bytes).digest('hex')
  if (hash !== lock.sha256) throw new Error('Public runtime artifact SHA-256 does not match the pinned release.')
  const version: { version: string } = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
  if (version.version !== lock.productVersion) throw new Error('Public runtime artifact targets a different product version.')
  const metadata: { name: string; version: string } = JSON.parse(execFileSync('tar', ['-xOf', archive, 'package/package.json'], { maxBuffer: 2 * 1024 * 1024 }).toString())
  if (metadata.name !== lock.packageName || metadata.version !== lock.productVersion) throw new Error('Unexpected runtime package identity.')
  const base = resolve(root, 'packages/context/workbench-assistant')
  for (const name of required) {
    const body = execFileSync('tar', ['-xOf', archive, 'package/' + name], { maxBuffer: 4 * 1024 * 1024 })
    const destination = resolve(base, name)
    mkdirSync(dirname(destination), { recursive: true })
    writeFileSync(destination, body)
  }
}
