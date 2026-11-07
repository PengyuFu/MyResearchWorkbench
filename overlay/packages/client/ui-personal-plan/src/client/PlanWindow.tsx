/**
 * The floating window's whole surface: the shared plan-and-task board, rendered
 * only in a Desktop window opened with the plan-window flag.
 *
 * The window is a real BrowserWindow over the same Host, so the board reads and
 * writes the same document as the embedded panel. Docking back hides this window
 * and asks the main window to show the embedded board again; closing only hides
 * this window and leaves any running batch alone.
 *
 * The surface is portalled to the document body: the overlay slot may sit inside
 * a transformed shell column, and the board has to cover the whole window rather
 * than that column.
 */
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { createPortal } from 'react-dom'
import { PlanBoard } from './PlanBoard.tsx'
import { NS } from './locales.ts'
import type { PlanInjected } from './plan-source.ts'
import css from './PlanWindow.module.css'

/** Props of the floating plan window surface. */
export type PlanWindowProps = PropsRuntime<'shell.overlay'>
  & PropsLocale<typeof NS>
  & InjectFace<PlanInjected & { readonly dockBack: () => void }>

/**
 * Render the floating window surface.
 * @param props - localized copy, the shared plan face, and the dock action.
 * @returns the full-window plan and task board.
 */
export function PlanWindow(props: PlanWindowProps): React.ReactNode {
  const closeWindow = (): void => {
    const bridge = (globalThis as {
      dshDesktop?: { planWindow?: { close: () => Promise<void> } }
    }).dshDesktop
    void bridge?.planWindow?.close()
  }
  return createPortal(
    <div className={css.window} data-plan-window="">
      <PlanBoard
        usePlan={props.usePlan}
        face={props}
        t={props.t}
        variant="window"
        dockBack={() => { props.dockBack() }}
        closeWindow={closeWindow}
      />
    </div>,
    document.body,
  )
}
