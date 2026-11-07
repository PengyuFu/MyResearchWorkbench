/** A bounded project bibliography and label catalog built from authoritative source buffers. */
import { parseBibtexKeys, parseLatexDocument } from './latex-source.ts'

export interface ReferenceEntry {
  key: string
  kind: 'citation' | 'label'
  path?: string
}

export interface ReferenceCatalog {
  entries: ReferenceEntry[]
  warnings?: string[]
}

/** Resolve a literal TeX child path relative to its containing source.
 * @param source Workspace-relative source path.
 * @param target Literal include, bibliography, or asset path.
 * @returns A normalized path; the existing file service still enforces containment.
 */
export function relativeProjectPath(source: string, target: string): string {
  if (/^(?:[a-z]:[\\/]|\/)/iu.test(target)) return target
  const parts = source.replaceAll('\\', '/').split('/').slice(0, -1)
  for (const part of target.replaceAll('\\', '/').split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..' && parts.length > 0 && parts.at(-1) !== '..') parts.pop()
    else parts.push(part)
  }
  return parts.join('/')
}

/** Read only the selected manuscript graph and its named bibliographies.
 * @param sourcePath Current source identity.
 * @param mainFile Configured manuscript root, or the current source.
 * @param kind Requested keys.
 * @param read Reads an unsaved editor buffer first, otherwise the bounded workspace service.
 * @returns Existing keys, preserving duplicate definitions and explicit unreadable-file warnings.
 */
export async function projectReferences(
  sourcePath: string,
  mainFile: string,
  kind: 'citation' | 'label',
  read: (path: string) => Promise<{ path: string; text: string }>,
): Promise<ReferenceCatalog> {
  const queue = [...new Set([mainFile || sourcePath, sourcePath])]
  const visited = new Set<string>()
  const entries: ReferenceEntry[] = []
  const warnings: string[] = []
  let total = 0
  while (queue.length > 0) {
    const path = queue.shift()
    if (path === undefined) break
    if (visited.has(path)) continue
    if (visited.size >= 64) { warnings.push('Reference lookup reached its 64-file limit.'); break }
    visited.add(path)
    try {
      const source = await read(path)
      if (source.path !== path && visited.has(source.path)) continue
      visited.add(source.path)
      total += source.text.length
      if (total > 4 * 1024 * 1024) { warnings.push('Reference lookup reached its 4 MiB text limit.'); break }
      if (/\.bib$/iu.test(source.path)) {
        if (kind === 'citation') {
          entries.push(...parseBibtexKeys(source.text).map(key => ({ key, kind, path: source.path })))
        }
        continue
      }
      const document = parseLatexDocument(source.text, source.path)
      if (kind === 'label') {
        entries.push(...document.labels.map(label => ({ key: label.key, kind, path: source.path })))
      }
      for (const include of document.includes) {
        const target = /\.[^/]+$/u.test(include.path) ? include.path : include.path + '.tex'
        queue.push(relativeProjectPath(source.path, target))
      }
      if (kind === 'citation') {
        for (const bibliography of document.bibliography) {
          const target = /\.bib$/iu.test(bibliography) ? bibliography : bibliography + '.bib'
          queue.push(relativeProjectPath(source.path, target))
        }
      }
    } catch (error) {
      warnings.push(path + ': ' + (error instanceof Error ? error.message : String(error)))
    }
  }
  entries.sort((a, b) => a.key.localeCompare(b.key) || (a.path ?? '').localeCompare(b.path ?? ''))
  return { entries, ...(warnings.length === 0 ? {} : { warnings }) }
}
