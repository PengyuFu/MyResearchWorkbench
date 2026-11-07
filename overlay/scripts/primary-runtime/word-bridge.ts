/** Prepare the private, pinned pywin32 subset used only by the local Word worker. */
import { createHash } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import extractZip from 'extract-zip'
import lock from './word-bridge.lock.json' with { type: 'json' }

const native = new Set(['_win32sysloader', 'win32api', 'win32event', 'win32file', 'win32gui', 'win32job', 'win32process', 'win32security'])
function included(path: string): boolean {
  return path === 'pythoncom.py'
    || /^pywin32_system32\/(?:pythoncom312|pywintypes312)\.dll$/u.test(path)
    || /^win32\/[^/]+\.pyd$/u.test(path) && native.has(path.slice(6, -4))
    || /^win32\/lib\/(?:pywintypes|win32con|winerror|win32timezone)\.py$/u.test(path)
    || /^win32com\/(?:[^/]+\.py|(?:client|server)\/[^/]+\.py)$/u.test(path)
    || /^pywin32-312\.dist-info\/licenses\//u.test(path)
    || path === 'pywin32-312.dist-info/METADATA'
}
/** Assemble only the exercised COM/Windows modules and keep all upstream license texts.
 * @param archive - hash-verified upstream wheel.
 * @param destination - private dependency directory outside site-packages.
 * @returns the actual member inventory recorded beside the files. */
export async function prepareWordBridge(archive: string, destination: string): Promise<void> {
  const bytes = await readFile(archive)
  if (createHash('sha256').update(bytes).digest('hex') !== lock.sha256) throw new Error('Word bridge wheel digest mismatch')
  await mkdir(destination, { recursive: true })
  const staging = await mkdtemp(join(destination, '.extract-'))
  const members: { path: string; sha256: string; bytes: number }[] = []
  try {
    await extractZip(archive, { dir: staging })
    const pending = ['']
    while (pending.length) {
      const directory = pending.pop()
      if (directory === undefined) break
      for (const entry of await readdir(join(staging, directory), { withFileTypes: true })) {
        const path = directory ? directory + '/' + entry.name : entry.name
        if (entry.isDirectory()) { pending.push(path); continue }
        if (!entry.isFile() || !included(path)) continue
        const from = join(staging, path)
        const data = await readFile(from)
        const to = join(destination, path)
        await mkdir(join(to, '..'), { recursive: true })
        await copyFile(from, to)
        members.push({ path, sha256: createHash('sha256').update(data).digest('hex'), bytes: data.length })
      }
    }
    members.sort((a, b) => a.path.localeCompare(b.path))
    await writeFile(join(destination, 'manifest.json'), JSON.stringify({ format: 1, dependency: lock, members }, null, 2) + '\n')
  } finally { await rm(staging, { recursive: true, force: true }) }
}
