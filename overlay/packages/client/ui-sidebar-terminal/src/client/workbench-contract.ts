/** Root factory for the workbench's existing Session-owned terminal model. */
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { TerminalView, TerminalViewState } from '@deepseek-ai/dsh-api-terminal-controller/client'
import type { FactoryComponentPropsOf, HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { ThemeSnapshot } from '@deepseek-ai/dsh-client-ui-theme/client'
import type {} from './locales.ts'

/** The workspace supplies its selected Session and actual panel visibility. */
export interface WorkbenchTerminalInput {
  readonly sessionId: SessionId | undefined
  readonly visible: boolean
}

/** Terminal services stay in the existing provider and preserve its input ownership. */
export interface WorkbenchTerminalInjected {
  /** @param sessionId - owning Session. @returns its stable workbench occurrence. */
  readonly viewWorkbenchTerminal: (sessionId: SessionId) => TerminalView
  /** Replace an ended or missing occurrence after the user requests a new terminal. */
  readonly newWorkbenchTerminal: (sessionId: SessionId) => void
  readonly keyedHooks: { readonly workbenchTerminal: (sessionId: string) => HostObservable<TerminalViewState> }
  readonly hooks: { readonly theme: HostObservable<ThemeSnapshot> }
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotFactoryMap {
    /** Interactive terminal backed by the standard ClientTerminals service. */
    'workbench.terminal': {
      scope: 'root'
      props: WorkbenchTerminalInput
      inject: WorkbenchTerminalInjected
      locale: 'sidebarTerminal'
    }
  }
}

/** Complete framework-owned terminal factory props. */
export type WorkbenchTerminalProps = FactoryComponentPropsOf<'workbench.terminal'>
