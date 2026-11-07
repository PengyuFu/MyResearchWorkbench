/**
 * Stage one of the personal plan tab type's registration: what it IS.
 *
 * A page type: the plan is one Host-wide document, not a resource address, so it
 * is opened by kind and recognized by no pattern.
 */
import type { TranslateNS } from '@deepseek-ai/dsh-client-locale/client'
import type { SidebarRightTabDefinition } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'

/** This implementation's identity in the tab system: the key its body and title register under. */
export const PLAN_TAB_ID = '@deepseek-ai/dsh-client-ui-personal-plan/board'

/** The tab kind this package owns. */
export const PLAN_TAB_KIND = 'personalPlan'

/**
 * The plan page type's registry definition.
 * @param t - namespace-bound translate, read fresh on every title call.
 * @returns the definition to register.
 */
export function personalPlanDefinition(t: TranslateNS<'personalPlan'>): SidebarRightTabDefinition {
  return {
    id: PLAN_TAB_ID,
    kind: PLAN_TAB_KIND,
    priority: 'builtin',
    title: () => t('tab.title'),
  }
}
