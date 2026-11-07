/** User-operated editor, build, and source/PDF navigation messages. */
import type { Branded } from '@deepseek-ai/dsh-brand'
import type {} from '@deepseek-ai/dsh-typert-protocol'

/** Identity of one Session-owned build or run. */
export type WorkbenchJobId = Branded<'WorkbenchJobId'>

/** File identity for lightweight external-change checks. */
export interface WorkbenchFileStat {
  readonly path: string
  readonly absolutePath: string
  readonly version: string
  readonly bytes?: number
}

/** Complete UTF-8 text and the opaque disk version used by the next save. */
export interface WorkbenchDocument extends WorkbenchFileStat {
  readonly text: string
  readonly bytes: number
}

/** A null version creates a new file and must never overwrite an existing file. */
export interface WorkbenchSaveRequest {
  readonly path: string
  readonly text: string
  readonly version: string | null
  /** Assert the actual file identity observed before editing. */
  readonly expectedPath?: string
  /** Verified staging bytes, committed before the source CAS; omitted for ordinary saves. */
  readonly assets?: readonly WorkbenchStagedAsset[]
}

export interface WorkbenchStagedAsset {
  readonly path: string
  /** Canonical base64; Remote requests use the existing JSON carrier. */
  readonly data: string
  readonly sha256: string
}

/** Bounded local journal inspection; no recovery operation deletes project assets. */
export interface WorkbenchAssetRecovery {
  readonly records: {
    transactionId: string
    sourcePath: string
    phase: string
    createdAt: string
    assets: { path: string; status: string }[]
    residualPaths: string[]
  }[]
  readonly issues: string[]
  readonly truncated: boolean
  readonly activeLock?: string
}

/** One immediate child; listing does not read the child's contents. */
export interface WorkbenchEntry {
  readonly name: string
  readonly type: 'file' | 'directory' | 'other'
  readonly size?: number
}

/** Workspace-relative listing, excluding generated Workbench build files. */
export interface WorkbenchDirectory {
  readonly workspaceRoot: string
  readonly path: string
  readonly entries: WorkbenchEntry[]
  readonly truncated: boolean
}

/** Bounded workspace figure preview; source assets are never modified. */
export interface WorkbenchAsset {
  readonly path: string
  readonly mimeType: string
  readonly version: string
  readonly data: Uint8Array
}

/** Installed executable choices; user-selected paths remain local workspace preferences. */
export interface WorkbenchEnvironments {
  readonly python: string[]
  readonly cpp: string[]
  readonly cuda: string[]
  readonly matlab: string[]
}

/** Explicit compile/run action. Commands are executable plus argv, never shell text. */
export interface WorkbenchRunRequest {
  readonly kind: 'latex' | 'python' | 'command'
  readonly path: string
  /** Auto reads the project's existing recipe or TeX directives; omission means auto. */
  readonly recipe?: 'auto' | 'latexmk' | 'pdflatex' | 'xelatex' | 'lualatex'
  /** Required for command actions; a PATH name or an absolute executable path. */
  readonly command?: string
  /** No arguments when absent. */
  readonly args?: string[]
  /** Workspace-relative directory; omission uses the source file's directory. */
  readonly cwd?: string
}

/** A source-linked compiler/runtime diagnostic. */
export interface WorkbenchDiagnostic {
  readonly path: string
  readonly line: number
  readonly column?: number
  readonly severity: 'error' | 'warning'
  readonly message: string
}

/** Latest successful build identity; failed builds leave this identity unchanged. */
export interface WorkbenchPdfInfo {
  readonly path: string
  readonly version: string
  /** Workspace-relative root source that produced this PDF. */
  readonly sourcePath: string
  readonly sourceVersion: string
  readonly builtAt: string
  /** Versions of authoring inputs bound to this successful build. */
  readonly inputs: { path: string; version: string }[]
}

/** Binary payload is encoded by the generated Remote codec. */
export interface WorkbenchPdf extends WorkbenchPdfInfo {
  readonly data: Uint8Array
  /** A stale PDF is viewable, but source navigation must compile again. */
  readonly stale: boolean
}

/** A job remains running until its managed process range is quiescent. */
export interface WorkbenchJob {
  readonly id: WorkbenchJobId
  readonly kind: WorkbenchRunRequest['kind']
  readonly path: string
  readonly state: 'running' | 'succeeded' | 'failed' | 'cancelled'
  readonly output: string
  readonly truncated: boolean
  readonly timedOut: boolean
  readonly exitCode: number | null
  readonly diagnostics: WorkbenchDiagnostic[]
  readonly error?: string
  readonly pdf?: WorkbenchPdfInfo
  readonly artifacts?: { path: string; version: string }[]
}

/** Forward SyncTeX position, in PDF points from the top-left page corner. */
export interface WorkbenchPdfPosition {
  readonly page: number
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/** Reverse SyncTeX source position; line and column are 1-based. */
export interface WorkbenchSourcePosition {
  readonly path: string
  readonly line: number
  readonly column: number
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    'workbench/conflict': { path: string }
    'workbench/outside-workspace': { path: string }
    'workbench/not-found': { path: string }
    'workbench/not-text': { path: string }
    'workbench/too-large': { path: string; limit: number }
    'workbench/unavailable': { reason: string }
    'workbench/busy': { id: WorkbenchJobId }
    'workbench/asset-transaction': { path: string; transactionId: string; residualPaths: string[]; recoveryLog: string; documentCommitted: boolean }
  }
}
