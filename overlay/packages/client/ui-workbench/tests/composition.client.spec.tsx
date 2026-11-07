// @vitest-environment jsdom
/** Exercise the real plugin registration against SlotCore's shadowing and renderer. */
import { useEffect } from 'react'
import { act, fireEvent, render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import {
  SlotCore, type FactoryComponentPropsOf, type PropsRenderFactories, type PropsRenderSlots, type PropsRuntime,
  type SlotRendererHost, type SlotScopeAdapter, type StandardSourceBinding,
} from '@deepseek-ai/dsh-client-ui-slots'
import { createSlotRenderer } from '@deepseek-ai/dsh-client-ui-renderer/src/client/scoped-slots.tsx'
import type { ConversationInjected } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { registerWorkbenchWorkspace } from '../src/client/workspace-registration.ts'
import { Workbench, WorkViewControl } from '../src/client/Workbench.tsx'
import { WorkbenchController } from '../src/client/controller.ts'
import type { WorkbenchIO } from '../src/client/types.ts'
import type {} from '../src/client/index.ts'
import { en, NS } from '../src/client/locales.ts'

/** Domain services are absent in this blank-session fixture; slot election is real. */
function hostOver(core: SlotCore): SlotRendererHost {
  const absent: StandardSourceBinding = { key: undefined, hooks: {}, keyedHooks: {}, props: {} }
  const binding = { getSnapshot: () => absent, subscribe: () => () => {} }
  const adapter: SlotScopeAdapter = {
    current: binding,
    bindingSource: () => binding,
    renderArea: (current, { empty, children }) => current.key === undefined ? empty?.() ?? null : children,
  }
  const localeSnapshot = { revision: 0 }
  const dictionary: Readonly<Record<string, string>> = en
  return {
    subscribe: (key, listener) => core.subscribe(key, listener),
    getVersion: key => core.getVersion(key),
    entriesOf: key => core.entries(key),
    entriesOfSlot: key => core.entriesOfSlot(key),
    reportEntryError: (key, entry, error, info) => core.reportEntryError(key, entry, error, info),
    reportFactoryError: (name, definition, error) => core.reportFactoryError(name, definition, error),
    specOf: key => core.specDynamic(key),
    isLive: entry => core.isLive(entry),
    storeOf: () => undefined,
    factoryStoreOf: () => undefined,
    retainFactoryOccurrence: () => () => {},
    subscribeFactory: (name, listener) => core.subscribeFactory(name, listener),
    getFactoryVersion: name => core.factoryVersion(name),
    factoryOf: name => core.factory(name),
    isFactoryLive: definition => core.isFactoryLive(definition),
    root: binding,
    scopeRevision: { getSnapshot: () => 0, subscribe: () => () => {} },
    scope: () => adapter,
    locale: {
      getSnapshot: () => localeSnapshot, subscribe: () => () => {},
      bind: () => key => dictionary[key] ?? key,
    },
  }
}

describe('workbench conversation composition', () => {
  it('elects the actual workbench registration over the fallback and mounts conversation content once', async () => {
    const core = new SlotCore()
    const contentInjected: ConversationInjected = {
      hooks: { composerBlock: { getSnapshot: () => undefined, subscribe: () => () => {} } },
      selectWorkspace: async () => { throw new Error('Composition fixture must not open a workspace') },
    }
    let activeContentMounts = 0
    let totalContentMounts = 0
    let fallbackMounts = 0
    const Content = ({ variant, renderSlot }: FactoryComponentPropsOf<'conversation.content'>) => {
      useEffect(() => {
        activeContentMounts++
        totalContentMounts++
        return () => { activeContentMounts-- }
      }, [])
      return <div data-test-conversation-content={variant}>{renderSlot('conversation.workview.control', {})}<textarea aria-label="Fixture draft" /></div>
    }
    const Fallback = ({ renderFactorySlot, phase, hero }: PropsRuntime<'conversation.workspace'> & PropsRenderFactories) => {
      useEffect(() => { fallbackMounts++ }, [])
      return <div data-test-conversation-fallback="">{renderFactorySlot('conversation.content', { variant: 'main', phase, hero })}</div>
    }
    core.register({ name: 'root', children: {
      'conversation.workspace': { kind: 'single', scope: 'session-maybe' },
    } }, ({ renderSlot }: PropsRenderSlots<'conversation.workspace'>) => renderSlot('conversation.workspace', { phase: 'hero', hero: true }))
    core.registerFactory({ name: 'conversation.content', scope: 'session-maybe', locale: 'conversation',
      inject: (_sessionId: SessionId | undefined): ConversationInjected => contentInjected,
      slots: { views: { scope: 'session' }, widthControls: { scope: 'root' } },
      children: {
        'conversation.session': { kind: 'single', scope: 'session' },
        'conversation.composer': { kind: 'chain', scope: 'session' },
        'conversation.composer.bar': { kind: 'single', scope: 'session-maybe' },
        'conversation.input.dock': { kind: 'list', scope: 'session' },
        'conversation.hero.brand.mark': { kind: 'single', scope: 'root' },
        'conversation.hero.workspace': { kind: 'single', scope: 'root' },
        'conversation.hero.agentPreset': { kind: 'single', scope: 'session-maybe' },
        'conversation.hero.options': { kind: 'list', scope: 'session' },
        'conversation.workview.control': { kind: 'single', scope: 'session-maybe' },
        'conversation.workview.selection': { kind: 'single', scope: 'session-maybe' },
      } }, Content)
    core.register({ name: 'conversation.workspace', priority: -100 }, Fallback)

    // A blank-session controller needs no remote operations. The typed boundary
    // rejects an unexpected call rather than impersonating unrelated services.
    const unexpectedIO = async (): Promise<never> => { throw new Error('Blank composition unexpectedly invoked workspace I/O') }
    const io: WorkbenchIO = {
      publishEditor: unexpectedIO, attachment: unexpectedIO,
      assetRecovery: async () => ({ records: [], issues: [], truncated: false }),
      preview: () => { throw new Error('Unexpected preview') }, environments: unexpectedIO, asset: unexpectedIO,
      read: unexpectedIO, stat: unexpectedIO, save: unexpectedIO, list: unexpectedIO,
      start: unexpectedIO, current: unexpectedIO, status: unexpectedIO, stop: unexpectedIO,
      pdf: unexpectedIO, synctexForward: unexpectedIO, synctexReverse: unexpectedIO,
      request: unexpectedIO, getAction: unexpectedIO, cancelAction: unexpectedIO, review: unexpectedIO,
    }
    const controller = new WorkbenchController(undefined, io, key => en[key])
    // The production helper supplies the component and rank; neither is copied
    // into this fixture. SlotCore and the real renderer perform the election.
    const disposeWorkspace = registerWorkbenchWorkspace(core, () => ({
      ...controller.actions, hooks: { workbench: controller.state },
    }))
    const disposeControl = core.register({ name: 'conversation.workview.control', locale: NS, inject: () => ({ ...controller.actions, hooks: { workbench: controller.state } }) }, WorkViewControl)
    const view = render(<>{createSlotRenderer().renderRoot(hostOver(core), {})}</>)
    try {
      expect(core.entriesOfSlot('conversation.workspace')).toHaveLength(1)
      expect(core.entriesOfSlot('conversation.workspace')[0]?.component).toBe(Workbench)
      expect(view.container.querySelectorAll('[data-workbench]')).toHaveLength(1)
      expect(view.container.querySelectorAll('[data-test-conversation-content]')).toHaveLength(1)
      expect(view.container.querySelector('[data-test-conversation-content]')?.getAttribute('data-test-conversation-content')).toBe('embedded')
      expect(activeContentMounts).toBe(1)
      expect(totalContentMounts).toBe(1)
      expect(fallbackMounts).toBe(0)
      const draft = view.getByRole('textbox', { name: 'Fixture draft' })
      if (!(draft instanceof HTMLTextAreaElement)) throw new Error('Fixture draft must be a textarea')
      draft.value = 'Keep the current conversation draft'
      draft.focus()
      for (const mode of ['writing', 'development', 'chat'] as const) {
        await act(async () => { controller.actions.setMode(mode); controller.actions.setFocus('editor') })
        await act(async () => { controller.actions.setFocus('chat') })
        expect(view.getByRole('textbox', { name: 'Fixture draft' })).toBe(draft)
        expect(draft.value).toBe('Keep the current conversation draft')
        expect(document.activeElement).toBe(draft)
        expect(totalContentMounts).toBe(1)
      }

      await act(async () => {
        controller.state.set({ ...controller.state.getSnapshot(), mode: 'development', focus: 'chat',
          activePaths: { writing: 'draft.txt', development: 'sample.py' }, panes: { writing: 'source', development: 'source' },
          buffers: Object.fromEntries((['writing', 'development'] as const).map((mode) => {
            const path = mode === 'writing' ? 'draft.txt' : 'sample.py'
            const text = mode === 'writing' ? 'Writing content.' : 'print(1)'
            return [path, { mode, path, absolutePath: '/fixture/' + path, text, savedText: text, savedRawText: text,
              diskVersion: '1', revision: 0, selection: { from: 0, to: 0 }, lineEnding: 'lf' as const, scrollTop: 0, saveState: 'clean' as const }]
          })),
        })
      })
      expect(view.getByRole('button', { name: en.resumeWriting })).toBeTruthy()
      expect(view.getByRole('button', { name: en.resumeDevelopment })).toBeTruthy()
      await act(async () => { fireEvent.click(view.getByRole('button', { name: en.resumeWriting })) })
      expect(controller.state.getSnapshot().mode).toBe('writing')
      expect(view.getByRole('tab', { name: 'draft.txt' })).toBeTruthy()
      expect(view.queryByRole('tab', { name: 'sample.py' })).toBeNull()
      await act(async () => { controller.actions.setFocus('chat') })
      await act(async () => { fireEvent.click(view.getByRole('button', { name: en.resumeDevelopment })) })
      expect(controller.state.getSnapshot().mode).toBe('development')
      expect(view.getByRole('tab', { name: 'sample.py' })).toBeTruthy()
      expect(view.queryByRole('tab', { name: 'draft.txt' })).toBeNull()
      // Both boards reuse the same conversation/editor nodes while changing layout.
      for (const mode of ['development', 'writing'] as const) {
        await act(async () => { controller.actions.setMode(mode); controller.actions.setFocus('editor') })
        const panel = view.container.querySelector('[data-workbench-editor]')
        await act(async () => { fireEvent.click(view.getByRole('button', { name: en.panelView })) })
        await act(async () => { fireEvent.click(view.getByRole('menuitem', { name: en.enterImmersive })) })
        expect(view.container.querySelector('[data-workbench]')?.getAttribute('data-immersive')).toBe('true')
        expect(view.container.querySelector('[data-workbench-collapse]')).toBeNull()
        expect(view.queryByRole('tab')).toBeNull()
        expect(view.container.querySelector('[data-workbench-editor]')).toBe(panel)
        expect(view.getByRole('textbox', { name: 'Fixture draft' })).toBe(draft)
        expect(draft.value).toBe('Keep the current conversation draft')
        await act(async () => { fireEvent.click(view.getByRole('button', { name: en.panelView })) })
        await act(async () => { fireEvent.click(view.getByRole('menuitem', { name: en.exitImmersive })) })
        expect(view.container.querySelector('[data-workbench]')?.hasAttribute('data-immersive')).toBe(false)
        expect(view.container.querySelector('[data-workbench-editor]')).toBe(panel)
      }
      await act(async () => { controller.actions.setMode('chat') })
      expect(view.getByRole('button', { name: en.resumeWriting })).toBeTruthy()
      expect(view.getByRole('button', { name: en.resumeDevelopment })).toBeTruthy()
      expect(totalContentMounts).toBe(1)
      disposeControl()

      await act(async () => { disposeWorkspace() })
      expect(view.container.querySelector('[data-workbench]')).toBeNull()
      expect(view.container.querySelectorAll('[data-test-conversation-content]')).toHaveLength(1)
      expect(activeContentMounts).toBe(1)
      expect(fallbackMounts).toBe(1)
    } finally {
      view.unmount()
      disposeWorkspace()
      controller.dispose()
    }
  })
})
