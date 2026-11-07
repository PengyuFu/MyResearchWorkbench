/** Copy a hash-checked allowlist of original runtime assets, never the private authoring tree. */
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'

const allowed = ['workbench-runtime.json', 'NOTICE.txt'] as const
/**
 * Materialize the separately managed runtime subset before bundling.
 * @param root - Source repository root.
 * @param source - Private assets root; configurable for portable build environments.
 * @returns Hashes recorded in the distributed asset manifest.
 */
export function prepareOwnedAssets(root: string, source = process.env.MRW_PRIVATE_ASSETS_DIR): Record<string, string> {
  if (!source) throw new Error('MRW_PRIVATE_ASSETS_DIR must identify the approved asset source directory.')
  const manifest: unknown = JSON.parse(readFileSync(resolve(source, 'runtime-manifest.json'), 'utf8'))
  if (typeof manifest !== 'object' || manifest === null || !('version' in manifest) || !('files' in manifest)
    || typeof manifest.files !== 'object' || manifest.files === null) throw new Error('Original runtime asset manifest is invalid.')
  const packageData: { version: string } = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
  if (manifest.version !== packageData.version) throw new Error('Original runtime assets do not match the product version.')
  const expected = new Map(Object.entries(manifest.files))
  if (expected.size !== allowed.length || [...expected.keys()].some(name => !allowed.some(item => item === name))) {
    throw new Error('Original runtime asset manifest contains an unapproved file.')
  }
  const assets = allowed.map((name) => {
    const bytes = readFileSync(resolve(source, 'runtime', name))
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    if (expected.get(name) !== sha256) throw new Error(`Original runtime asset hash differs: ${name}`)
    return { name, bytes, sha256 }
  })
  const destination = resolve(root, 'packages/context/workbench-assistant/assets')
  rmSync(destination, { recursive: true, force: true })
  mkdirSync(destination, { recursive: true })
  for (const asset of assets) writeFileSync(resolve(destination, asset.name), asset.bytes)
  const hashes = Object.fromEntries(assets.map(asset => [asset.name, asset.sha256]))
  writeFileSync(resolve(destination, 'manifest.json'), JSON.stringify({ version: packageData.version,
    classification: 'original-runtime-subset', files: hashes }, null, 2) + '\n')
  return hashes
}
if (import.meta.main) console.log(JSON.stringify(prepareOwnedAssets(resolve(import.meta.dirname, '..', '..'))))
