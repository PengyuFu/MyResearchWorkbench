/** Bounded source locations extracted from common TeX, Python, MATLAB, C++, and CUDA output. */
import { posix, win32 } from 'node:path'
import type { WorkbenchDiagnostic } from './types.ts'

/**
 * Extract compiler locations without treating arbitrary output as executable content.
 * @param output - bounded retained output.
 * @param source - fallback source path for classic TeX diagnostics.
 * @param cwd - actual command working directory; when present, relative locations resolve here.
 * @returns at most 100 unique source diagnostics.
 */
export function parseDiagnostics(output: string, source: string, cwd?: string): WorkbenchDiagnostic[] {
  const result: WorkbenchDiagnostic[] = []
  const seen = new Set<string>()
  const add = (diagnostic: WorkbenchDiagnostic): void => {
    const item = cwd === undefined ? diagnostic : { ...diagnostic, path: (cwd.startsWith('/') ? posix : win32).resolve(cwd, diagnostic.path) }
    const key = `${item.path}:${item.line}:${item.message}`
    if (result.length < 100 && !seen.has(key)) { seen.add(key); result.push(item) }
  }
  let texError: string | undefined
  let pythonLocation: { path: string; line: number } | undefined
  let matlabLocation: { path: string; line: number; header: string } | undefined
  const sourcePaths = source.startsWith('/') ? posix : win32
  const matlabName = /\.m$/iu.test(source) ? sourcePaths.basename(source, sourcePaths.extname(source)) : undefined
  for (const line of output.split(/\r?\n/u)) {
    if (matlabName !== undefined) {
      const text = line.replaceAll('\b', '').replace(/^\{/u, '').trim()
      const header = /^(?:Error using|Error in|错误使用|出错)\s+(.+?)\s*\((?:line\s+|第\s*)(\d+)(?:\s*行)?\)/iu.exec(text)
      if (matlabLocation !== undefined && text !== '') {
        add({ path: matlabLocation.path, line: matlabLocation.line, severity: 'error',
          message: header === null ? text : matlabLocation.header })
        matlabLocation = undefined
      }
      if (header !== null) {
        const symbol = header[1]?.trim()
        // Bare function names can be elsewhere on MATLAB's path. Only the active source is unambiguous.
        const file = symbol !== undefined && /\.m$/iu.test(symbol) ? symbol
          : symbol?.split('>')[0] === matlabName ? source : undefined
        if (file !== undefined) matlabLocation = { path: file, line: Number(header[2]), header: text }
      }
    }
    const compiler = /^(.*?):(\d+)(?::(\d+))?:\s*(?:(fatal error|error|warning):\s*)?(.+)$/u.exec(line)
    if (compiler !== null) {
      const path = compiler[1]?.trim()
      if (path !== undefined && /\.(?:tex|bib|py|cpp|cc|cxx|c|h|hpp|cu|cuh)$/iu.test(path)) {
        add({ path, line: Number(compiler[2]), ...(compiler[3] === undefined ? {} : { column: Number(compiler[3]) }),
          severity: compiler[4] === 'warning' ? 'warning' : 'error', message: compiler[5] ?? line })
      }
    }
    const nvcc = /^(.*?)\((\d+)\):\s*(error|warning)(?:\s+#\w+)?:?\s*(.+)$/u.exec(line)
    if (nvcc !== null) add({ path: nvcc[1] ?? source, line: Number(nvcc[2]), severity: nvcc[3] === 'warning' ? 'warning' : 'error', message: nvcc[4] ?? line })
    if (line.startsWith('! ')) texError = line.slice(2)
    const texLine = /^l\.(\d+)\s/u.exec(line)
    if (texLine !== null && texError !== undefined) { add({ path: source, line: Number(texLine[1]), severity: 'error', message: texError }); texError = undefined }
    const warning = /(?:LaTeX|Package .*?) Warning:\s*(.+?)(?: on input line (\d+)\.?|$)/u.exec(line)
    if (warning !== null) add({ path: source, line: Number(warning[2] ?? 1), severity: 'warning', message: warning[1] ?? line })
    const python = /^\s*File "(.+)", line (\d+)/u.exec(line)
    if (python !== null) pythonLocation = { path: python[1] ?? source, line: Number(python[2]) }
    if (pythonLocation !== undefined && /^[A-Za-z_][\w.]*?(?:Error|Exception):/u.test(line)) {
      add({ ...pythonLocation, severity: 'error', message: line }); pythonLocation = undefined
    }
  }
  if (matlabLocation !== undefined) {
    add({ path: matlabLocation.path, line: matlabLocation.line, severity: 'error', message: matlabLocation.header })
  }
  return result
}
