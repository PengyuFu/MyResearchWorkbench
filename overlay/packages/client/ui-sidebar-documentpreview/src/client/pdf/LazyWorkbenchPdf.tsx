/** Load the existing PDF engine only when the writing pane requests it. */
import { Component, lazy, Suspense, type ReactNode } from 'react'
import type { WorkbenchPdfProps } from './workbench-contract.ts'
import { LoadingIndicator } from '../LoadingIndicator.tsx'
import css from './LazyWorkbenchPdf.module.css'

// Keep both PDF surfaces behind the existing lazy entry so the client module
// loader receives their shared runtime and stylesheet in the same module graph.
const Loaded = lazy(async () => ({ default: (await import('./pdf.tsx')).WorkbenchPdf }))

interface LoadingBoundaryProps {
  children: ReactNode
  failed: string
}

interface LoadingBoundaryState {
  error: string | null
}

class LoadingBoundary extends Component<LoadingBoundaryProps, LoadingBoundaryState> {
  override state: LoadingBoundaryState = { error: null }

  static getDerivedStateFromError(error: unknown): LoadingBoundaryState {
    return { error: error instanceof Error ? error.message : String(error) }
  }

  override render() {
    if (this.state.error !== null) {
      return <div className={css.failure} role="alert">
        <strong>{this.props.failed}</strong>
        <pre className={css.detail}>{this.state.error}</pre>
      </div>
    }
    return this.props.children
  }
}

export function LazyWorkbenchPdf(props: WorkbenchPdfProps) {
  return <LoadingBoundary key={props.version} failed={props.labels.failed}>
    <Suspense fallback={<LoadingIndicator label={props.labels.loading} />}><Loaded {...props} /></Suspense>
  </LoadingBoundary>
}
