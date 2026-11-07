/** Load xterm only after a terminal body is mounted. */
import { lazy, Suspense, type ReactNode } from 'react'
import type { TerminalBodyProps } from './terminal.tsx'
import type { WorkbenchTerminalProps } from './workbench-contract.ts'

const loadTerminal = () => import('./terminal.tsx')
const LoadedTerminalBody = lazy(async () => ({ default: (await loadTerminal()).TerminalBody }))
const LoadedWorkbenchTerminal = lazy(async () => ({ default: (await loadTerminal()).WorkbenchTerminal }))

/**
 * Suspend while the package-local terminal chunk arrives.
 * @param props - Terminal body props supplied by the sidebar slot.
 * @returns the deferred terminal renderer.
 */
export function LazyTerminalBody(props: TerminalBodyProps): ReactNode {
  return <Suspense fallback={null}><LoadedTerminalBody {...props} /></Suspense>
}

/** Defer the shared xterm screen until the workbench terminal is actually shown. */
export function LazyWorkbenchTerminal(props: WorkbenchTerminalProps): ReactNode {
  if (!props.visible) return null
  return <Suspense fallback={null}><LoadedWorkbenchTerminal {...props} /></Suspense>
}
