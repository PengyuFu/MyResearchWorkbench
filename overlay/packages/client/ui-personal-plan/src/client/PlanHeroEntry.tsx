/**
 * The New Session row entry that opens the personal plan board.
 *
 * The conversation header exists only once a Session shows a conversation; the
 * blank-Session page renders its hero options instead, so this entry is the way
 * to the same plan page from a brand-new Session.
 */
import { Button, IconChecklistOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { NS } from './locales.ts'

/** Props of the New Session row plan entry. */
export type PlanHeroEntryProps = PropsRuntime<'conversation.hero.options'>
  & PropsLocale<typeof NS>
  & InjectFace<{ readonly openPlan: () => void }>

/**
 * Render the New Session row entry that opens the plan board.
 * @param props - localized copy and the open callback.
 * @returns the compact entry button.
 */
export function PlanHeroEntry({ openPlan, t }: PlanHeroEntryProps) {
  return (
    <Button
      variant="ghost"
      size="sm"
      icon={<IconChecklistOutlineRegular size={16} />}
      aria-label={t('open.aria')}
      title={t('open.label')}
      data-plan-toggle=""
      onClick={openPlan}
    >
      {t('open.label')}
    </Button>
  )
}
