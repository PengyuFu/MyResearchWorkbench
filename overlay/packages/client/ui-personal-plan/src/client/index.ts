/**
 * Personal plan browser plugin: the shared plan source, the embedded
 * right-Sidebar board, the conversation-header entry that opens it, the optional
 * floating Desktop window, and the task-Session navigation between them.
 *
 * The board is Host-wide, so the page type is opened by kind. Plans and tasks
 * start embedded in the main window; on the Desktop the board can additionally
 * move into its own window and dock back. Exactly one surface is shown at a
 * time: opening the embedded board hides the floating window, and floating the
 * board closes the tab.
 *
 * A Host change carrying a pending proposal opens the embedded page so the
 * preview is visible; the proposal is applied only from the user's confirmation
 * inside the panel. A task Session is shown by the main window, and the floating
 * window asks for it through the Host instead of navigating itself.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-personal-plan/client'
import { PlanHeaderButton } from './PlanHeaderButton.tsx'
import { PlanHeroEntry } from './PlanHeroEntry.tsx'
import { PlanPanel } from './PlanPanel.tsx'
import { PlanWindow } from './PlanWindow.tsx'
import { PLAN_TAB_ID, PLAN_TAB_KIND, personalPlanDefinition } from './definition.ts'
import { NS, en, zh } from './locales.ts'
import { createPlanSource } from './plan-source.ts'

/** Required services: the slot seats, language, Remote assembly, right Sidebar, and main-window navigation. */
export const inject = [
  'slots', 'locale', 'remote', 'remote.personalPlan', 'sidebarRightTabs', 'sidebarRight', 'uiWorkspace',
]

/** Query flag the Desktop plan window carries in its document URL. */
const PLAN_WINDOW_QUERY = 'mrwPlan'

/** Desktop bridge that owns the floating window's lifecycle. */
interface DesktopPlanWindowBridge {
  open?: () => Promise<void>
  close?: () => Promise<void>
  focusMain?: () => Promise<void>
}

/**
 * Whether this document is the Desktop floating plan window.
 * @returns true when the page was opened with the plan-window flag.
 */
function isPlanWindow(): boolean {
  try {
    return new URLSearchParams(globalThis.location.search).get(PLAN_WINDOW_QUERY) === '1'
  } catch {
    return false
  }
}

/**
 * Read the Desktop bridge that can open, hide, or focus the windows.
 * @returns the bridge, or undefined on the Web client.
 */
function planWindowBridge(): DesktopPlanWindowBridge | undefined {
  return (globalThis as { dshDesktop?: { planWindow?: DesktopPlanWindowBridge } }).dshDesktop?.planWindow
}

/**
 * Register the plan page, the floating window surface, the entries, and the shared plan source.
 * @param ctx - browser services used by these contributions.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-personal-plan: dictionaries')
  const t = ctx.locale.bind(NS)
  const floating = isPlanWindow()
  const bridge = planWindowBridge()
  /**
   * Open the embedded board, hiding a floating window first: plans and tasks
   * show in one place, and the entry always means the embedded panel.
   */
  const openEmbedded = (): void => {
    void bridge?.close?.()
    ctx.sidebarRight.openTab(PLAN_TAB_KIND)
  }
  const floatOut = (): void => {
    // Moving the board out leaves the embedded tab empty, so close it: the
    // floating window is the one visible surface until it docks back.
    void bridge?.open?.()
    const tab = ctx.sidebarRight.active()
    if (tab !== undefined && tab.kind === PLAN_TAB_KIND) ctx.sidebarRight.close(tab.id)
  }
  const source = createPlanSource({
    remote: ctx.remote.personalPlan,
    subscribeChanged: listener => ctx.remote.$on('personal-plan/changed', listener),
    subscribeReset: listener => ctx.on('connection/reset', listener),
    onProposal: () => {
      // The proposal stays stored either way; a floating window has no embedded
      // page to open, and the main window may have no Session on screen.
      if (floating) return
      if (ctx.sidebarRight.mounted.getSnapshot() === undefined) return
      openEmbedded()
    },
  })
  const dockBack = (): void => {
    void bridge?.close?.()
    void source.requestPanel()
  }  // Attach for the plugin's lifetime, not for the panel's: a proposal that
  // arrives while the panel is closed must still be able to open it.
  ctx.effect(() => source.attach(), 'ui-personal-plan: host subscription')
  if (floating) {
    ctx.slots.inject('shell.overlay', () => ctx.slots.register({
      name: 'shell.overlay',
      id: 'personal-plan-window',
      order: 0,
      locale: NS,
      inject: () => ({ ...source, dockBack }),
    }, PlanWindow))
  } else {
    ctx.effect(() => ctx.sidebarRightTabs.register(personalPlanDefinition(t)), 'ui-personal-plan: tab type')
    ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
      name: 'sidebar.right.pane.tab',
      key: PLAN_TAB_ID,
      locale: NS,
      inject: () => (bridge?.open === undefined ? source : { ...source, floatOut }),
    }, PlanPanel))
    // A task Session is shown by the main window: the floating window asks
    // through the Host, and this window brings itself forward to show it.
    ctx.effect(() => ctx.remote.$on('personal-plan/reveal-session', (payload) => {
      ctx.uiWorkspace.openSession(payload.sessionId)
      void bridge?.focusMain?.()
    }), 'ui-personal-plan: reveal task session')
    // Docking back reopens the embedded board here and raises the main window.
    ctx.effect(() => ctx.remote.$on('personal-plan/panel-requested', () => {
      openEmbedded()
      void bridge?.focusMain?.()
    }), 'ui-personal-plan: docked panel request')
  }
  // Sits with the header utilities, left of the overflow menu.
  ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
    name: 'conversation.session.header.utilities',
    id: 'personal-plan-open',
    order: 5,
    locale: NS,
    inject: () => ({ openPlan: openEmbedded }),
  }, PlanHeaderButton))
  // The blank-Session page renders hero options instead of a conversation
  // header, so a brand-new Session reaches the same plan surface from here.
  ctx.slots.inject('conversation.hero.options', () => ctx.slots.register({
    name: 'conversation.hero.options',
    id: 'personal-plan-hero',
    order: 5,
    locale: NS,
    inject: () => ({ openPlan: openEmbedded }),
  }, PlanHeroEntry))
}
