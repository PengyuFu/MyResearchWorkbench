/**
 * The conversation header entry that opens the personal plan panel.
 *
 * The entry is icon-only and its accessible name is its only label; pressing it
 * opens or focuses the plan tab through the right Sidebar controller, so a second
 * press never creates a second page.
 */
import { Button, IconChecklistOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { NS } from './locales.ts'
import css from './PlanHeaderButton.module.css'

/** Props of the conversation-header plan entry. */
export type PlanHeaderButtonProps = PropsRuntime<'conversation.session.header.utilities'>
  & PropsLocale<typeof NS>
  & InjectFace<{ readonly openPlan: () => void }>

/**
 * Render the header entry that opens the plan board.
 * @param props - localized copy and the open callback.
 * @returns the entry button.
 */
export function PlanHeaderButton({ openPlan, t }: PlanHeaderButtonProps) {
  return (
    <span className={css.seat} data-plan-toggle="">
      <Button
        variant="ghost"
        size="sm"
        icon={<IconChecklistOutlineRegular size={16} />}
        aria-label={t('open.aria')}
        title={t('open.label')}
        onClick={openPlan}
      />
    </span>
  )
}
