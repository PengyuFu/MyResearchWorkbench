/** In-process editor retention uses Tiptap's public mount lifecycle, not private history serialization. */
import type { Editor } from '@tiptap/core'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import type { PluginKey } from '@tiptap/pm/state'
import type { DecorationSet } from '@tiptap/pm/view'
import type { VisualRuntime } from './visual-schema.ts'
import type { WorkbenchActions } from './types.ts'

export interface RetainedVisualEditor {
  editor: Editor
  source: string
  targetKey: PluginKey<DecorationSet>
  live: { runtime: () => VisualRuntime; validate: (document: ProseMirrorNode) => boolean }
}

// The controller's stable edit callback owns this cache and its lifetime.
// Retained editors have no view, DOM listeners, image requests or React listeners.
const retained = new WeakMap<WorkbenchActions['edit'], Map<string, RetainedVisualEditor>>()

export function takeVisualEditor(owner: WorkbenchActions['edit'], path: string, source: string): RetainedVisualEditor | null {
  const records = retained.get(owner)
  const record = records?.get(path)
  if (record === undefined) return null
  records?.delete(path)
  if (record.source !== source) { record.editor.destroy(); return null }
  return record
}

export function retainVisualEditor(owner: WorkbenchActions['edit'], path: string, record: RetainedVisualEditor): void {
  let records = retained.get(owner)
  if (records === undefined) { records = new Map(); retained.set(owner, records) }
  records.get(path)?.editor.destroy()
  records.delete(path)
  records.set(path, record)
  while (records.size > 8) {
    const oldest = records.keys().next().value
    if (oldest === undefined) break
    records.get(oldest)?.editor.destroy()
    records.delete(oldest)
  }
}
