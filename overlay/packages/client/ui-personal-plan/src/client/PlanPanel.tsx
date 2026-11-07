/**
 * The right-Sidebar plan tab body: the shared plan-and-task surface inside a
 * panel. The board itself lives in {@link PlanBoard}, which the floating desktop
 * window renders too, so both surfaces stay one implementation.
 *
 * On the Desktop the panel owns the float action: the board moves into its own
 * window and this tab closes, so exactly one surface shows at a time. The Web
 * client has no desktop bridge and therefore no float action.
 */
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { PlanBoard } from './PlanBoard.tsx'
import { NS } from './locales.ts'
import type { PlanInjected } from './plan-source.ts'

/** Props of the personal plan tab body. */
export type PlanPanelProps = PropsRuntime<'sidebar.right.pane.tab'>
  & PropsLocale<typeof NS>
  & InjectFace<PlanInjected & { readonly floatOut?: () => void }>

/**
 * Render the plan board inside the right Sidebar.
 * @param props - tab information, localized copy, the shared plan face, and the float action.
 * @returns the plan panel.
 */
export function PlanPanel(props: PlanPanelProps): React.ReactNode {
  return (
    <PlanBoard
      usePlan={props.usePlan}
      face={props}
      t={props.t}
      variant="panel"
      {...(props.floatOut === undefined ? {} : { floatOut: props.floatOut })}
    />
  )
}
