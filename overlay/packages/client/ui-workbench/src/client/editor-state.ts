/** Each board owns its current file and view; file buffers retain a single save/undo identity. */
import type { EditorBuffer, EditorMode, EditorPane, WorkbenchSnapshot, WorkView } from './types.ts'

/** Explicit manuscript/code suffixes win; other text belongs to the board that opened it. */
export function fileMode(path: string, requested: WorkView): EditorMode {
  if (/\.(docx|tex|bib|sty|cls|md|markdown)$/iu.test(path)) return 'writing'
  if (/\.(py|pyw|pyi|m|c|cpp|cc|cxx|h|hpp|cu|cuh|js|jsx|ts|tsx|json|yaml|yml|toml|html|css|rs|go|java|sh|ps1)$/iu.test(path)) return 'development'
  return requested === 'writing' ? 'writing' : 'development'
}

export function activePath(state: WorkbenchSnapshot): string | null {
  return state.mode === 'chat' ? null : state.activePaths[state.mode]
}

export function activeBuffer(state: WorkbenchSnapshot): EditorBuffer | undefined {
  const path = activePath(state)
  return path === null ? undefined : state.buffers[path]
}

export function activePane(state: WorkbenchSnapshot): EditorPane {
  return state.mode === 'chat' ? 'source' : state.panes[state.mode]
}
