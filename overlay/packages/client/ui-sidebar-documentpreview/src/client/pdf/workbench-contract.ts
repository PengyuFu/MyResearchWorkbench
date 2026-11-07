/** Reusable PDF surface inputs, independent from sidebar-tab ownership. */
import type { FactoryComponentPropsOf } from '@deepseek-ai/dsh-client-ui-slots'

/** Coordinates are PDF points; the caller owns document mutations and durable input. */
export interface PdfTextEditing {
  regions: { id: string; page: number; x: number; y: number; width: number; height: number }[]
  active: {
    id: string
    page: number
    value: string
    font: string
    size: number
    alignment: number
    selection: { from: number; to: number }
  } | null
  disabled: boolean
  label: string
  done: string
  onActivate(id: string, page: number): void
  onChange(value: string, from: number, to: number, composing: boolean): void
  onFinish(): void
  onCommand(command: 'undo' | 'redo' | 'save'): void
}
export interface WorkbenchPdfInput {
  editing?: PdfTextEditing | undefined
  data: Uint8Array
  version: string
  target: { page: number; x: number; y: number; width: number; height: number; token: number } | null
  position?: { page: number; offset: number; left: number; zoom: 'fit' | number } | undefined
  onPosition?(position: { page: number; offset: number; left: number; zoom: 'fit' | number }): void
  onSource(page: number, x: number, y: number): Promise<void>
  onSelection(text: string, page: number): void
  labels: { loading: string; failed: string; zoom: string; fitWidth: string; page: string; sourceHint: string; askSelection: string }
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotFactoryMap {
    /** Selectable PDF pages backed by the document-preview package's existing engine. */
    'documentpreview.pdf': { scope: 'root'; props: WorkbenchPdfInput }
  }
}

export type WorkbenchPdfProps = FactoryComponentPropsOf<'documentpreview.pdf'>
