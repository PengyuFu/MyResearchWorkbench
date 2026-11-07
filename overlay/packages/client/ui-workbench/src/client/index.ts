/** Compose the editor, source selections, and existing Harness Remote services. */
import type { Context } from '@deepseek-ai/cordis'
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-workbench-workspace/remote'
import type {} from '@deepseek-ai/dsh-workbench-word/remote'
import type {} from '@deepseek-ai/dsh-workbench-assistant/remote'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkbenchJobId } from '@deepseek-ai/dsh-workbench-workspace/types'
import type { WorkbenchActionId } from '@deepseek-ai/dsh-workbench-assistant/types'
import type { WorkbenchConversationView } from '@deepseek-ai/dsh-workbench-assistant/types'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionFace } from '@deepseek-ai/dsh-api-session-controller/client'
import { sessionFileAddress } from '@deepseek-ai/dsh-util-workspace-path'
import { bytesToBase64 } from '@deepseek-ai/dsh-util-crypto'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { WorkbenchController } from './controller.ts'
import { WorkbenchStateStore } from './workbench-state.ts'
import { WordSceneRetention } from './word-retention.ts'
import { WorkViewControl, SelectionCard } from './Workbench.tsx'
import { registerWorkbenchWorkspace } from './workspace-registration.ts'
import { NS, en, zh, type WorkbenchKey } from './locales.ts'
import { SelectionMessage, selectionMessageRule } from './SelectionMessage.tsx'
import { ReviewMessage, reviewMessageRule } from './ReviewMessage.tsx'
import { QuickMessage, quickMessageDefinition } from './QuickMessage.tsx'
import type { WorkbenchIO, WorkbenchInjected } from './types.ts'

export type { WorkbenchInjected } from './types.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { workbench: WorkbenchKey }
}

export const inject = ['slots', 'locale', 'uiConversation', 'conversation', 'remote', 'remote.workbenchWorkspace',
  'remote.workbenchAssistant', 'remote.workbenchWord', 'sidebarRight', 'sessions']

/** Keep Host business failures visible instead of treating a failed envelope as a value. */
async function unwrap<T>(pending: Promise<RemoteResult<T>>): Promise<T> {
  const result = await pending
  if (!result.ok) throw Object.assign(new Error(`${result.error.code}: ${result.error.message}`), {
    code: result.error.code,
    ...('details' in result.error ? { details: result.error.details } : {}),
  })
  return result.value
}

/** Register one resident editor controller for each Session-backed composition. */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }))
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.uiConversation.userText.register(selectionMessageRule))
  ctx.effect(() => ctx.uiConversation.userText.register(reviewMessageRule))
  ctx.effect(() => ctx.slots.inject('conversation.user.text.node', () => ctx.slots.register({
    name: 'conversation.user.text.node', key: 'workbench-selection', locale: NS,
  }, SelectionMessage)))
  ctx.effect(() => ctx.slots.inject('conversation.user.text.node', () => ctx.slots.register({
    name: 'conversation.user.text.node', key: 'workbench-review', locale: NS,
  }, ReviewMessage)))
  const files = ctx.remote.workbenchWorkspace
  const assistant = ctx.remote.workbenchAssistant
  const word = ctx.remote.workbenchWord
  const io: WorkbenchIO = {
    rejectQuick: (sessionId, instruction, requestId, path, selectedText, reason) => unwrap(assistant.rejectQuick({
      sessionId, instruction, requestId, path, selectedText, reason,
    })),
    quickEdit: (sessionId, instruction, signal, requestId, reply) => unwrap(assistant.quickEdit({
      sessionId, instruction, requestId, ...(reply ? { reply } : {}),
    }, signal)),
    completeQuickEdit: (sessionId, requestId, error) => unwrap(assistant.completeQuickEdit({ sessionId, requestId, error })),
    claimAgentOperation: (sessionId, requestId, editorId) => unwrap(assistant.claimAgentOperation({ sessionId, requestId, editorId })),
    quickLearning: (sessionId, action) => unwrap(assistant.quickLearning({ sessionId, action })),
    word: {
      commit: (id, request) => unwrap(word.commit(id, request)),
      resolveOperation: (id, documentId, requestId, error) => unwrap(word.resolveOperation(id, documentId, requestId, error)),
      resources: (id, families) => unwrap(word.resources(id, families)),
      open: (id, path, create, recovery) => unwrap(word.open(id, path, create, recovery)),
      mutate: (id, request) => unwrap(word.mutate(id, request)),
      save: (id, documentId, revision, requestId, path) => unwrap(word.save(id, documentId, revision, requestId, path)),
      proof: (id, documentId, revision, cached, reference) => unwrap(word.proof(id, documentId, revision, cached, reference)),
      stop: (id, documentId) => unwrap(word.stop(id, documentId)),
      checkpoint: (id, documentId) => unwrap(word.checkpoint(id, documentId)),
      close: (id, documentId, discard = false) => unwrap(word.close(id, documentId, discard)),
    },
    publishEditor: publication => unwrap(assistant.publishEditor(publication)),
    attachment: (sessionId, actionId, path) => unwrap(assistant.attachment({
      sessionId, actionId: actionId as WorkbenchActionId, path,
    })),
    read: (id, path) => unwrap(files.read(id, path)),
    environments: id => unwrap(files.environments(id)),
    preview: (id, path) => ctx.sidebarRight.openResourceIn(id, sessionFileAddress(id, path)),
    asset: (id, path, sourcePath, graphicsPaths) => unwrap(files.asset(id, path, sourcePath, graphicsPaths)),
    stat: (id, path) => unwrap(files.stat(id, path)),
    save: (id, request) => {
      const { assets, ...source } = request
      return unwrap(files.save(id, { ...source,
        ...(assets === undefined ? {} : { assets: assets.map(asset => ({ ...asset, data: bytesToBase64(asset.data) })) }),
      }))
    },
    assetRecovery: id => unwrap(files.assetRecovery(id)),
    list: (id, path) => unwrap(files.list(id, path)),
    start: (id, request) => unwrap(files.start(id, request)),
    current: id => unwrap(files.current(id)),
    status: (id, jobId) => unwrap(files.status(id, jobId as WorkbenchJobId)),
    stop: (id, jobId) => unwrap(files.stop(id, jobId as WorkbenchJobId)),
    pdf: (id, path) => unwrap(files.pdf(id, path)),
    synctexForward: (id, path, line, column, rootPath) => unwrap(files.synctexForward(id, path, line, column, rootPath)),
    synctexReverse: (id, path, page, x, y) => unwrap(files.synctexReverse(id, path, page, x, y)),
    request: request => unwrap(assistant.request(request)),
    getAction: (sessionId, actionId) => unwrap(assistant.get({ sessionId, actionId: actionId as WorkbenchActionId })),
    cancelAction: (sessionId, actionId) => unwrap(assistant.cancel({ sessionId, actionId: actionId as WorkbenchActionId })),
    review: async (sessionId, actionId, decision, appliedText, baseVersion) => {
      await unwrap(assistant.review({
        sessionId, actionId: actionId as WorkbenchActionId, decision,
        ...(appliedText === undefined ? {} : { appliedText }),
        ...(baseVersion === undefined ? {} : { baseVersion }),
      }))
    },
  }
  const retentionError = (error: unknown) => { console.warn('[workbench-word] Storage maintenance deferred; drafts retained.', error) }
  const retention = new WordSceneRetention((sessionId, references) =>
    unwrap(word.retain(sessionId as SessionId, references)), retentionError)
  const persistence = new WorkbenchStateStore(indexedDB, (records, sequence) => retention.committed(records, sequence), retentionError)
  void persistence.retainCommitted()
  const stateSubscriptions: (() => void)[] = []
  const controllers = new Map<SessionId | undefined, WorkbenchController>()
  const operationStreams = new Map<SessionId, { controller: AbortController; ready: Promise<void>; done: Promise<void> }>()
  const followOperations = (sessionId: SessionId, owner: WorkbenchController): Promise<void> => {
    const existing = operationStreams.get(sessionId)
    if (existing !== undefined) return existing.ready
    const abort = new AbortController()
    let connected!: () => void, failed!: (error: unknown) => void
    const ready = new Promise<void>((resolve, reject) => { connected = resolve; failed = reject })
    // Background subscriptions report through the controller; submissions await ready.
    void ready.catch(() => undefined)
    const done = (async () => {
      try {
        for await (const notice of word.followOperations(sessionId, abort.signal)) {
          if (notice.kind === 'ready') connected()
          else await owner.receiveWordOperation(notice)
        }
      } catch (error) {
        failed(error)
        if (!abort.signal.aborted) owner.persistenceStatus(error)
      } finally {
        failed(new Error('The writing board connection closed before becoming ready.'))
        if (operationStreams.get(sessionId)?.controller === abort) operationStreams.delete(sessionId)
      }
    })()
    operationStreams.set(sessionId, { controller: abort, ready, done })
    return ready
  }
  const disconnectOperations = (sessionId: SessionId): void => {
    operationStreams.get(sessionId)?.controller.abort()
    operationStreams.delete(sessionId)
  }
  const projections = new Map<SessionId, { session: SessionFace; dispose(): void }>()
  const observeProjections = (): void => {
    for (const [sessionId, subscribed] of projections) {
      if (ctx.sessions.binding(sessionId)?.session === subscribed.session) continue
      subscribed.dispose()
      projections.delete(sessionId)
      disconnectOperations(sessionId)
    }
    for (const [sessionId, controller] of controllers) {
      if (sessionId === undefined || projections.has(sessionId)) continue
      const binding = ctx.sessions.binding(sessionId)
      if (binding === undefined) continue
      const face = binding.session.projections.faceOf('workbench')
      let available = false
      const publish = () => {
        const view = face.getSnapshot() as WorkbenchConversationView | undefined
        if (view !== undefined && !available) {
          controller.synchronizeEditor()
          void unwrap(assistant.resumeQuick({ sessionId })).catch(error => controller.persistenceStatus(error))
          void followOperations(sessionId, controller)
        } else if (view === undefined && available) disconnectOperations(sessionId)
        available = view !== undefined
        controller.observeConversation(view)
      }
      projections.set(sessionId, { session: binding.session, dispose: face.subscribe(publish) })
      publish()
    }
  }
  ctx.effect(() => {
    const dispose = ctx.sessions.list.subscribe(observeProjections)
    return () => { dispose(); for (const item of projections.values()) item.dispose(); projections.clear() }
  })
  let visible: WorkbenchController | undefined
  ctx.effect(() => ctx.conversation.registerTextHandler(async (sessionId, text, signal, submission) => {
    const controller = controllers.get(sessionId)
    if (controller === undefined || visible !== controller || submission === undefined) return undefined
    await followOperations(sessionId, controller)
    const result = await controller.submitText(text, signal ?? new AbortController().signal, submission.requestId, submission.acknowledge)
    return result === null ? undefined : result
  }))
  const face = (sessionId: SessionId | undefined): WorkbenchInjected => {
    let controller = controllers.get(sessionId)
    if (controller === undefined) {
      controller = new WorkbenchController(sessionId, io, t, 1000, persistence)
      controllers.set(sessionId, controller)
      const owner = controller
      let offeredInstruction = ''
      stateSubscriptions.push(owner.state.subscribe(() => {
        const state = owner.state.getSnapshot()
        if (sessionId !== undefined && state.selection !== null && state.action === null && state.instruction !== '' && state.instruction !== offeredInstruction) {
          offeredInstruction = state.instruction
          const binding = ctx.sessions.binding(sessionId)
          if (binding) ctx.conversation.input.requestDraftInitialization(binding, { prompt: state.instruction })
        }
        if (state.selection === null || state.instruction === '') offeredInstruction = ''
        if (visible === owner && sessionId !== undefined && state.workspaceRoot !== null && !state.restoring) {
          persistence.setForeground(sessionId, state.workspaceRoot)
        }
      }))
      void controller.restoreJob()
      if (sessionId !== undefined) void controller.actions.list('.')
      observeProjections()
    }
    return { ...controller.actions, hooks: { workbench: controller.state } }
  }
  ctx.effect(() => ctx.uiConversation.events.register(quickMessageDefinition))
  ctx.effect(() => ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
    name: 'conversation.chat.node', key: 'workbench-quick', locale: NS,
    inject: (sessionId: SessionId) => ({
      answerQuick: async (requestId: string, choice: number, label: string) => {
        const controller = controllers.get(sessionId)
        const session = ctx.sessions.binding(sessionId)?.session
        if (!controller || !session) return
        const submission = session.beginSubmission({ mode: 'queue', text: label, attachments: [] })
        try {
          await followOperations(sessionId, controller)
          await controller.quickCommand(label, new AbortController().signal, submission.requestId,
            { requestId, choice }, submission.acknowledge)
          submission.acknowledge()
        } catch (error) { submission.abandon(); controller.persistenceStatus(error) }
      },
      stopQuick: () => controllers.get(sessionId)?.stopQuick(),
    }),
  }, QuickMessage)))
  ctx.effect(() => ctx.slots.inject('conversation.workspace', () => registerWorkbenchWorkspace(ctx.slots,
    (sessionId: SessionId | undefined): WorkbenchInjected => {
      const injected = face(sessionId)
      visible = controllers.get(sessionId)
      return injected
    },
  )))
  ctx.effect(() => ctx.slots.inject('conversation.workview.control', () => ctx.slots.register({
    name: 'conversation.workview.control', locale: NS, inject: face,
  }, WorkViewControl)))
  ctx.effect(() => ctx.slots.inject('conversation.workview.selection', () => ctx.slots.register({
    name: 'conversation.workview.selection', locale: NS, inject: face,
  }, SelectionCard)))
  ctx.effect(() => {
    const focus = () => { void visible?.actions.checkExternal(); void visible?.restoreJob() }
    const captureEditors = () => window.dispatchEvent(new Event('mrw:checkpoint-editors'))
    const flush = async (saveOriginals = false) => {
      captureEditors()
      await Promise.all([...controllers.values()].map(controller => controller.ready(saveOriginals)))
      for (const controller of controllers.values()) controller.checkpoint()
      await persistence.flush()
      if ([...controllers.values()].some(controller => controller.state.getSnapshot().recoveryError !== null)) {
        throw new Error(t('stateSaveFailed'))
      }
    }
    const prepareClose = (event: Event) => {
      const pending = flush(true).catch((error: unknown) => {
        for (const controller of controllers.values()) controller.persistenceStatus(error)
        throw error
      })
      ;(event as CustomEvent<{ waitUntil(operation: Promise<void>): void }>).detail.waitUntil(pending)
    }
    const hidden = () => {
      if (document.visibilityState === 'hidden') void flush().catch((error: unknown) => {
        for (const controller of controllers.values()) controller.persistenceStatus(error)
      })
    }
    const beforeUnload = (event: BeforeUnloadEvent) => {
      captureEditors()
      for (const controller of controllers.values()) controller.checkpoint()
      if (!Array.from(controllers.values()).some(controller => controller.hasUnsaved || controller.hasPendingAction)) return
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('focus', focus)
    window.addEventListener('dsh:prepare-close', prepareClose)
    document.addEventListener('visibilitychange', hidden)
    window.addEventListener('beforeunload', beforeUnload)
    const externalTimer = window.setInterval(() => { if (document.visibilityState === 'visible') focus() }, 6000)
    return async () => {
      window.clearInterval(externalTimer)
      window.removeEventListener('focus', focus)
      window.removeEventListener('dsh:prepare-close', prepareClose)
      document.removeEventListener('visibilitychange', hidden)
      for (const dispose of stateSubscriptions) dispose()
      for (const stream of operationStreams.values()) stream.controller.abort()
      await Promise.allSettled([...operationStreams.values()].map(stream => stream.done))
      operationStreams.clear()
      window.removeEventListener('beforeunload', beforeUnload)
      await Promise.all([...controllers.values()].map(controller => controller.dispose()))
      await persistence.close()
    }
  })
}
