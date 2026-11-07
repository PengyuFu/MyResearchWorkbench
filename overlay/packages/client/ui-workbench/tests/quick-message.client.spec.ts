/** Live delegation must not interrupt the ordinary conversation event feed. */
import { describe, expect, it } from 'vitest'
import { SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session/types'
import { ConversationNodeAssembler, type ConversationNodeDefinition,
  type ConversationViewDefinition, type ConversationViewNode } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { quickMessageDefinition } from '../src/client/QuickMessage.tsx'

describe('Workbench live conversation handoff', () => {
  it('hides the prior quick node and continues receiving Agent output incrementally', () => {
    const ordinary: ConversationNodeDefinition = {
      kind: 'ordinary-probe', target: 'chat',
      match: event => event.type === 'assistant/message' ? { id: String(event.seq), role: 'start' } : null,
      start: (_context, match) => match.event.data, update: context => context.state,
      buildViewNode: context => ({ key: context.key, id: context.id, kind: context.kind, target: 'chat', data: context.state }),
    }
    const seen = new Map<string, ConversationViewNode>()
    const view: ConversationViewDefinition = { target: 'chat', create: () => ({
      empty: [],
      replace: ({ nodes }) => { seen.clear(); for (const node of nodes) seen.set(node.key, node); return nodes },
      apply: ({ upserts }) => { for (const node of upserts) seen.set(node.key, node); return [...seen.values()] },
    }) }
    const assembler = new ConversationNodeAssembler(
      { entries: () => [quickMessageDefinition, ordinary], fallbackEntry: () => undefined },
      { entries: () => [view] },
    )
    assembler.activateTarget('chat')
    const event = (seq: number, type: string, data: unknown) => ({
      type: 'event' as const, event: { seq: SessionSeq(seq), time: seq, type, data } as SessionEvent,
    })
    assembler.replaceWindow([event(1, 'workbench/quick-message', {
      requestId: 'request-1', taskId: 'request-1', instruction: '整理选中段落', path: 'paper.docx', selectedText: 'example', time: 1,
    })], false)
    assembler.flush()
    expect([...seen.values()][0]).toMatchObject({ visibility: 'visible' })
    assembler.append(event(2, 'workbench/quick-status', {
      requestId: 'request-1', phase: 'delegated', text: '交给当前会话助手', elapsedMs: 20,
    }))
    expect(() => assembler.flush()).not.toThrow()
    expect([...seen.values()][0]).toMatchObject({ visibility: 'hidden' })
    assembler.append(event(3, 'assistant/message', { turn: 1, step: 1,
      message: { role: 'assistant', content: [{ type: 'text', text: '已修改并保存。' }] } }))
    expect(() => assembler.flush()).not.toThrow()
    expect([...seen.values()].some(node => node.kind === 'ordinary-probe')).toBe(true)
  })
})
