import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { stagePublicRuntime } from './runtime-build.ts'

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'mrw-public-runtime-'))
  const src = join(dir, 'contents', 'package')
  const root = join(dir, 'public')
  const payload = {
    'lib/private-runtime.js': 'export const valid = true\n',
    'assets/workbench-runtime.json': '{"policy":"test"}\n',
    'assets/NOTICE.txt': 'Synthetic runtime only\n',
    'assets/manifest.json': '{"version":"0.11.2"}\n',
    'package.json': '{"name":"@deepseek-ai/dsh-workbench-assistant","version":"0.11.2"}\n',
  }
  for (const [name, body] of Object.entries(payload)) {
    const target = join(src, name)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, body)
  }
  const archive = join(dir, 'runtime.tgz')
  execFileSync('tar', ['-czf', archive, '-C', join(dir, 'contents'), 'package'])
  mkdirSync(join(root, 'scripts', 'mrw'), { recursive: true })
  writeFileSync(join(root, 'package.json'), '{"version":"0.11.2"}\n')
  const hash = createHash('sha256').update(readFileSync(archive)).digest('hex')
  const lock = join(root, 'scripts', 'mrw', 'public-runtime.lock.json')
  writeFileSync(lock, JSON.stringify({ productVersion: '0.11.2', packageName: '@deepseek-ai/dsh-workbench-assistant', sha256: hash }))
  return { dir, root, archive, lock }
}

describe('Public runtime bootstrap', () => {
  it('stages only verified binaries and approved runtime assets without a private source tree', () => {
    const f = fixture()
    try {
      stagePublicRuntime(f.root, f.archive)
      expect(readFileSync(join(f.root, 'packages/context/workbench-assistant/lib/private-runtime.js'), 'utf8'))
        .toBe('export const valid = true\n')
      expect(readFileSync(join(f.root, 'packages/context/workbench-assistant/assets/NOTICE.txt'), 'utf8'))
        .toContain('Synthetic runtime')
    } finally { rmSync(f.dir, { recursive: true, force: true }) }
  })
  it('rejects a different archive before writing runtime resources', () => {
    const f = fixture()
    try {
      writeFileSync(f.lock, JSON.stringify({ productVersion: '0.11.2', packageName: '@deepseek-ai/dsh-workbench-assistant', sha256: '0'.repeat(64) }))
      expect(() => stagePublicRuntime(f.root, f.archive)).toThrow('SHA-256')
    } finally { rmSync(f.dir, { recursive: true, force: true }) }
  })
})
