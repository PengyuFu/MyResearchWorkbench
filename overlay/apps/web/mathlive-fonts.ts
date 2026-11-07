/** Ship MathLive's named fonts with the application; editing never needs a CDN. */
import { readdir, readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Plugin } from 'vite'

export function mathliveFonts(): Plugin {
  const require = createRequire(fileURLToPath(new URL('../../packages/client/ui-workbench/package.json', import.meta.url)))
  const packageRoot = dirname(require.resolve('mathlive'))
  return {
    name: 'mrw-mathlive-offline-fonts',
    async generateBundle() {
      const directory = join(packageRoot, 'fonts')
      const files = (await readdir(directory)).filter(name => name.endsWith('.woff2'))
      if (files.length === 0) throw new Error('MathLive offline fonts are missing')
      for (const name of files) this.emitFile({ type: 'asset', fileName: 'workbench/mathlive/fonts/' + name, source: await readFile(join(directory, name)) })
      this.emitFile({ type: 'asset', fileName: 'workbench/mathlive/LICENSE.txt', source: await readFile(join(packageRoot, 'LICENSE.txt')) })
    },
  }
}
