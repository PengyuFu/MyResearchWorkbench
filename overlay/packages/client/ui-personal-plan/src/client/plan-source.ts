/**
 * Authoritative plan-board queries and mutations for the browser surfaces.
 *
 * One source instance is created by the plugin's `apply` and shared by the tab
 * body, the floating window, its title, and the header entry. The plugin attaches
 * the Host subscription for its own lifetime, so a proposal arriving while the
 * panel is closed still opens it; component consumers only read the observable. It
 * never applies an optimistic update: a mutation publishes the snapshot the Host
 * returned, and a failure keeps the last authoritative snapshot while recording
 * the failure for the save status.
 */
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type {
  PlanChangedEvent, PlanItemStatus, PlanSnapshot,
} from '@deepseek-ai/dsh-personal-plan/client'

/** The browser-visible state of the plan board. */
export interface PlanViewState {
  /** The last authoritative snapshot; null before the first successful read. */
  readonly snapshot: PlanSnapshot | null
  /** Read state of the source. */
  readonly status: 'loading' | 'ready' | 'error'
  /** Whether a mutation is in flight. */
  readonly saving: boolean
  /** Human-readable save failure shown in the save status, or null. */
  readonly saveError: string | null
  /** Whether the last apply attempt was refused because the board moved. */
  readonly stale: boolean
  /** Why the last apply attempt applied nothing, or null. */
  readonly applyError?: 'failed' | 'nothing-selected' | 'missing-proposal' | null
  /** Why the last start/stop execution request was refused, or null. */
  readonly runError: string | null
}

/** The Host-side operations this source issues. */
export interface PlanRemote {
  snapshot: () => Promise<RemoteResult<PlanSnapshot>>
  addItem: (
    request: { title: string; note?: string; dueDate?: string | null; workdir?: string },
  ) => Promise<RemoteResult<PlanSnapshot>>
  updateItem: (
    request: { id: string; title?: string; note?: string; dueDate?: string | null; workdir?: string },
  ) => Promise<RemoteResult<PlanSnapshot>>
  deleteItem: (request: { id: string }) => Promise<RemoteResult<PlanSnapshot>>
  setStatus: (request: { id: string; status: PlanItemStatus }) => Promise<RemoteResult<PlanSnapshot>>
  reorder: (request: { order: readonly string[] }) => Promise<RemoteResult<PlanSnapshot>>
  addTask: (
    request: { planId: string; title: string; detail?: string; requirement?: string; requestedFiles?: readonly string[] },
  ) => Promise<RemoteResult<PlanSnapshot>>
  updateTask: (
    request: { id: string; title?: string; detail?: string; requirement?: string; requestedFiles?: readonly string[] },
  ) => Promise<RemoteResult<PlanSnapshot>>
  deleteTask: (request: { id: string }) => Promise<RemoteResult<PlanSnapshot>>
  reorderTasks: (
    request: { planId: string; order: readonly string[] },
  ) => Promise<RemoteResult<PlanSnapshot>>
  applyProposal: (
    request: { proposalId: string; changeIds: readonly string[] },
  ) => Promise<RemoteResult<{ applied: boolean; code: string; snapshot: PlanSnapshot }>>
  discardProposal: (request: { proposalId: string }) => Promise<RemoteResult<PlanSnapshot>>
  startRun: (
    request: { planId: string; taskId?: string },
  ) => Promise<RemoteResult<{ started: boolean; code: string; snapshot: PlanSnapshot }>>
  stopRun: () => Promise<RemoteResult<{ stopped: boolean; code: string; snapshot: PlanSnapshot }>>
  revealSession: (request: { sessionId: string }) => Promise<RemoteResult<{ accepted: boolean }>>
  revealTaskSession: (request: { taskId: string }) => Promise<RemoteResult<{ code: string }>>
  requestPanel: () => Promise<RemoteResult<{ accepted: boolean }>>
}

/** Everything injected into the plan surfaces. */
export interface PlanInjected {
  readonly hooks: { readonly plan: HostObservable<PlanViewState> }
  /** Reload the board after a visible failure. */
  readonly retry: () => Promise<void>
  /**
   * Add one plan item.
   * @param input - title plus optional note and calendar date.
   * @returns whether the write succeeded.
   */
  readonly addItem: (input: { title: string; note?: string; dueDate?: string | null; workdir?: string }) => Promise<boolean>
  /**
   * Edit one plan item.
   * @param input - target identity and the fields to replace.
   * @returns whether the write succeeded.
   */
  readonly updateItem: (input: { id: string; title?: string; note?: string; dueDate?: string | null; workdir?: string }) => Promise<boolean>
  /**
   * Delete one plan item and its tasks.
   * @param id - target identity.
   * @returns whether the write succeeded.
   */
  readonly deleteItem: (id: string) => Promise<boolean>
  /**
   * Change one plan item's status.
   * @param id - target identity.
   * @param status - target status.
   * @returns whether the write succeeded.
   */
  readonly setStatus: (id: string, status: PlanItemStatus) => Promise<boolean>
  /**
   * Save a new incomplete plan order.
   * @param order - every incomplete item identity in the desired order.
   * @returns whether the write succeeded.
   */
  readonly reorder: (order: readonly string[]) => Promise<boolean>
  /**
   * Add one task to a plan.
   * @param input - owning plan, title, and optional instruction, requirements, and artifacts.
   * @returns whether the write succeeded.
   */
  readonly addTask: (input: {
    planId: string
    title: string
    detail?: string
    requirement?: string
    requestedFiles?: readonly string[]
  }) => Promise<boolean>
  /**
   * Edit one task.
   * @param input - target identity and the fields to replace.
   * @returns whether the write succeeded.
   */
  readonly updateTask: (input: {
    id: string
    title?: string
    detail?: string
    requirement?: string
    requestedFiles?: readonly string[]
  }) => Promise<boolean>
  /**
   * Delete one task.
   * @param id - target identity.
   * @returns whether the write succeeded.
   */
  readonly deleteTask: (id: string) => Promise<boolean>
  /**
   * Save a new task order inside one plan.
   * @param planId - owning plan identity.
   * @param order - every task identity of the plan in the desired order.
   * @returns whether the write succeeded.
   */
  readonly reorderTasks: (planId: string, order: readonly string[]) => Promise<boolean>
  /**
   * Apply the kept changes of one proposal.
   * @param proposalId - proposal shown in the preview.
   * @param changeIds - kept change identities.
   * @returns whether the application succeeded and was not stale.
   */
  readonly applyProposal: (proposalId: string, changeIds: readonly string[]) => Promise<boolean>
  /**
   * Discard the pending proposal.
   * @param proposalId - proposal identity.
   * @returns whether the discard succeeded.
   */
  readonly discardProposal: (proposalId: string) => Promise<boolean>
  /**
   * Start one task or one plan's pending tasks.
   * @param input - plan, optional single task, and the working directory.
   * @returns the outcome code the Host answered with.
   */
  readonly startRun: (input: { planId: string; taskId?: string }) => Promise<string>
  /**
   * Stop the running batch.
   * @returns the outcome code the Host answered with.
   */
  readonly stopRun: () => Promise<string>
  /**
   * Ask the main window to show one task Session.
   * @param sessionId - Session to show.
   * @returns whether the request was accepted.
   */
  readonly revealSession: (sessionId: string) => Promise<boolean>
  /**
   * Open one task's Session, or learn that the Session is gone.
   * @param taskId - task whose Session should be shown.
   * @returns `ok`, `no-session`, `unavailable`, or `missing-task`.
   */
  readonly revealTaskSession: (taskId: string) => Promise<string>
  /**
   * Ask the main window to show the embedded plan board again.
   * @returns whether the request was accepted.
   */
  readonly requestPanel: () => Promise<boolean>
}

/** What the plugin supplies to build a source. */
export interface PlanSourceDependencies {
  readonly remote: PlanRemote
  readonly subscribeChanged: (listener: (payload: PlanChangedEvent) => void) => () => void
  readonly subscribeReset: (listener: () => void) => () => void
  /** Called when a change carries a pending proposal, so the panel can open. */
  readonly onProposal: (payload: PlanChangedEvent) => void
}

/**
 * Create the shared plan-board source.
 * @param deps - Host calls and invalidation subscriptions.
 * @returns the observable state plus the action face for the surfaces; `attach`
 * starts the Host subscription independently of component mounts.
 */
export function createPlanSource(deps: PlanSourceDependencies): PlanInjected & { attach: () => () => void } {
  let state: PlanViewState = {
    snapshot: null, status: 'loading', saving: false, saveError: null, stale: false, applyError: null, runError: null,
  }
  const listeners = new Set<() => void>()
  let attached = false
  let pluginAttached = false
  let consumerOwned = false
  let subscriptions: readonly (() => void)[] = []
  let epoch = 0

  const publish = (next: PlanViewState): void => {
    state = next
    for (const listener of listeners) listener()
  }

  const start = (): void => {
    if (attached) return
    attached = true
    epoch++
    publish({ ...state, status: state.snapshot === null ? 'loading' : state.status })
    subscriptions = [
      deps.subscribeChanged((payload) => {
        if (payload.proposalId !== null) deps.onProposal(payload)
        void read()
      }),
      deps.subscribeReset(() => { void read() }),
    ]
    void read()
  }

  const stop = (): void => {
    if (!attached) return
    attached = false
    for (const dispose of subscriptions) dispose()
    subscriptions = []
    epoch++
  }

  const read = async (): Promise<void> => {
    const current = ++epoch
    try {
      const result = await deps.remote.snapshot()
      if (current !== epoch) return
      if (result.ok) {
        publish({ ...state, snapshot: result.value, status: 'ready', stale: false, applyError: null })
        return
      }
      publish({ ...state, status: 'error' })
    } catch {
      if (current !== epoch) return
      publish({ ...state, status: 'error' })
    }
  }

  const mutate = async (call: () => Promise<RemoteResult<PlanSnapshot>>): Promise<boolean> => {
    publish({ ...state, saving: true, saveError: null, stale: false, applyError: null, runError: null })
    let result: RemoteResult<PlanSnapshot>
    try {
      result = await call()
    } catch (error: unknown) {
      publish({ ...state, saving: false, saveError: error instanceof Error ? error.message : 'request failed' })
      return false
    }
    if (!result.ok) {
      publish({ ...state, saving: false, saveError: result.error.message })
      return false
    }
    epoch++
    publish({ ...state, snapshot: result.value, status: 'ready', saving: false, saveError: null })
    return true
  }

  return {
    hooks: {
      plan: {
        getSnapshot: () => state,
        subscribe(listener) {
          listeners.add(listener)
          if (!attached) {
            consumerOwned = true
            start()
          }
          return () => {
            listeners.delete(listener)
            if (listeners.size !== 0 || !consumerOwned) return
            consumerOwned = false
            if (!pluginAttached) stop()
          }
        },
      },
    },
    attach() {
      pluginAttached = true
      start()
      return () => {
        pluginAttached = false
        if (listeners.size === 0) stop()
      }
    },
    retry: async () => {
      if (!attached) return
      await read()
    },
    addItem: input => mutate(() => deps.remote.addItem(input)),
    updateItem: input => mutate(() => deps.remote.updateItem(input)),
    deleteItem: id => mutate(() => deps.remote.deleteItem({ id })),
    setStatus: (id, status) => mutate(() => deps.remote.setStatus({ id, status })),
    reorder: order => mutate(() => deps.remote.reorder({ order })),
    addTask: input => mutate(() => deps.remote.addTask(input)),
    updateTask: input => mutate(() => deps.remote.updateTask(input)),
    deleteTask: id => mutate(() => deps.remote.deleteTask({ id })),
    reorderTasks: (planId, order) => mutate(() => deps.remote.reorderTasks({ planId, order })),
    applyProposal: async (proposalId, changeIds) => {
      publish({ ...state, saving: true, saveError: null, stale: false, applyError: null })
      let result: RemoteResult<{ applied: boolean; code: string; snapshot: PlanSnapshot }>
      try {
        result = await deps.remote.applyProposal({ proposalId, changeIds })
      } catch (error: unknown) {
        publish({ ...state, saving: false, applyError: 'failed', saveError: error instanceof Error ? error.message : 'request failed' })
        return false
      }
      if (!result.ok) {
        publish({ ...state, saving: false, applyError: 'failed', saveError: result.error.message })
        return false
      }
      epoch++
      if (result.value.applied) {
        publish({ ...state, snapshot: result.value.snapshot, status: 'ready', saving: false, saveError: null, stale: false, applyError: null })
        return true
      }
      publish({
        ...state,
        snapshot: result.value.snapshot,
        status: 'ready',
        saving: false,
        stale: result.value.code === 'stale',
        applyError: result.value.code === 'stale'
          ? null
          : result.value.code === 'nothing-selected' || result.value.code === 'missing-proposal'
            ? result.value.code
            : 'failed',
      })
      return false
    },
    discardProposal: proposalId => mutate(() => deps.remote.discardProposal({ proposalId })),
    startRun: async (input) => {
      publish({ ...state, saving: true, saveError: null, runError: null })
      let result: RemoteResult<{ started: boolean; code: string; snapshot: PlanSnapshot }>
      try {
        result = await deps.remote.startRun(input)
      } catch (error: unknown) {
        publish({ ...state, saving: false, runError: error instanceof Error ? error.message : 'request failed' })
        return 'failed'
      }
      if (!result.ok) {
        publish({ ...state, saving: false, runError: result.error.message })
        return 'failed'
      }
      epoch++
      publish({
        ...state,
        snapshot: result.value.snapshot,
        status: 'ready',
        saving: false,
        runError: result.value.started ? null : result.value.code,
      })
      if (result.value.started) return result.value.code
      return result.value.code
    },
    stopRun: async () => {
      let result: RemoteResult<{ stopped: boolean; code: string; snapshot: PlanSnapshot }>
      try {
        result = await deps.remote.stopRun()
      } catch (error: unknown) {
        publish({ ...state, runError: error instanceof Error ? error.message : 'request failed' })
        return 'failed'
      }
      if (!result.ok) {
        publish({ ...state, runError: result.error.message })
        return 'failed'
      }
      epoch++
      publish({ ...state, snapshot: result.value.snapshot, status: 'ready', runError: result.value.stopped ? null : result.value.code })
      return result.value.code
    },
    revealSession: async (sessionId) => {
      try {
        const result = await deps.remote.revealSession({ sessionId })
        return result.ok && result.value.accepted
      } catch {
        return false
      }
    },
    revealTaskSession: async (taskId) => {
      try {
        const result = await deps.remote.revealTaskSession({ taskId })
        return result.ok ? result.value.code : 'failed'
      } catch {
        return 'failed'
      }
    },
    requestPanel: async () => {
      try {
        const result = await deps.remote.requestPanel()
        return result.ok && result.value.accepted
      } catch {
        return false
      }
    },
  }
}
