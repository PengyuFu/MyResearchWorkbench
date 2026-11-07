// @vitest-environment jsdom
/**
 * The personal plan panel's user-visible behavior: list order, the collapsed
 * completed section, the add form, inline editing, status changes, delete
 * confirmation, the pending proposal preview, and native drag reordering.
 *
 * The panel receives one framework hook (`usePlan`) plus the injected action
 * face; this suite drives them with a plain mutable state object and spies, and
 * binds `t` to the package's real dictionaries through the shared translate
 * stub, so the assertions read exactly what a user reads.
 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type {
  PlanItem, PlanProposal, PlanProposalChange, PlanRun, PlanSnapshot, PlanTask,
} from '@deepseek-ai/dsh-personal-plan/client'
import { PlanPanel, type PlanPanelProps } from '../src/client/PlanPanel.tsx'
import type { PlanViewState } from '../src/client/plan-source.ts'
import { en, zh } from '../src/client/locales.ts'

afterEach(() => { cleanup() })

/** One durable item with the fields the panel reads. */
function item(overrides: Partial<PlanItem> & Pick<PlanItem, 'id' | 'title'>): PlanItem {
  return {
    note: '', dueDate: null, workdir: '', status: 'todo', order: 0,
    createdAt: '2026-10-21T00:00:00.000Z', updatedAt: '2026-10-21T00:00:00.000Z',
    ...overrides,
  }
}

/** One durable task with the fields the panel reads. */
function task(overrides: Partial<PlanTask> & Pick<PlanTask, 'id' | 'planId' | 'title'>): PlanTask {
  return {
    detail: '', requirement: '', requestedFiles: [], status: 'pending', order: 0, sessionId: null,
    result: null, message: '',
    createdAt: '2026-10-21T00:00:00.000Z', updatedAt: '2026-10-21T00:00:00.000Z',
    ...overrides,
  }
}

/** One run of one plan. */
function runOf(overrides: Partial<PlanRun> = {}): PlanRun {
  return {
    runId: 'run-1', planId: 'a', taskIds: ['t1'], workdir: 'C:\\work', status: 'running',
    currentTaskId: 't1', message: '', startedAt: '2026-10-21T00:00:00.000Z',
    updatedAt: '2026-10-21T00:00:00.000Z', ...overrides,
  }
}

/** One authoritative snapshot. */
function snapshotOf(
  items: readonly PlanItem[],
  proposal: PlanProposal | null = null,
  revision = 1,
  tasks: readonly PlanTask[] = [],
  run: PlanRun | null = null,
): PlanSnapshot {
  return { revision, items, tasks, proposal, run, updatedAt: '2026-10-21T00:00:00.000Z' }
}

/** One proposal change with the fields the preview reads. */
function change(overrides: Partial<PlanProposalChange> & Pick<PlanProposalChange, 'changeId' | 'kind'>): PlanProposalChange {
  return {
    itemId: null, planId: null, taskId: null, before: null, after: null,
    taskBefore: null, taskAfter: null, beforeStatus: null, afterStatus: null,
    beforeOrder: null, afterOrder: null, beforeTaskOrder: null, afterTaskOrder: null,
    ...overrides,
  }
}

/** Three incomplete items in user order, plus one completed item. */
function board(): readonly PlanItem[] {
  return [
    item({ id: 'a', title: 'Alpha', order: 0 }),
    item({ id: 'b', title: 'Beta', order: 1, status: 'in_progress', note: 'Second line' }),
    item({ id: 'c', title: 'Gamma', status: 'done', order: 0 }),
    item({ id: 'd', title: 'Delta', order: 2 }),
  ]
}

interface MountOptions {
  readonly snapshot?: PlanSnapshot | null
  readonly status?: PlanViewState['status']
  readonly saving?: boolean
  readonly saveError?: string | null
  readonly stale?: boolean
  readonly runError?: string | null
  readonly floatOut?: () => void
  readonly dictionary?: typeof zh | typeof en
}

/** The panel's action face, as the plugin injects it. */
interface ActionSpies {
  readonly addItem: ReturnType<typeof vi.fn<(input: unknown) => Promise<boolean>>>
  readonly updateItem: ReturnType<typeof vi.fn<(input: unknown) => Promise<boolean>>>
  readonly deleteItem: ReturnType<typeof vi.fn<(id: string) => Promise<boolean>>>
  readonly setStatus: ReturnType<typeof vi.fn<(id: string, status: string) => Promise<boolean>>>
  readonly reorder: ReturnType<typeof vi.fn<(order: readonly string[]) => Promise<boolean>>>
  readonly addTask: ReturnType<typeof vi.fn<(input: unknown) => Promise<boolean>>>
  readonly updateTask: ReturnType<typeof vi.fn<(input: unknown) => Promise<boolean>>>
  readonly deleteTask: ReturnType<typeof vi.fn<(id: string) => Promise<boolean>>>
  readonly reorderTasks: ReturnType<typeof vi.fn<(planId: string, order: readonly string[]) => Promise<boolean>>>
  readonly applyProposal: ReturnType<typeof vi.fn<(proposalId: string, changeIds: readonly string[]) => Promise<boolean>>>
  readonly discardProposal: ReturnType<typeof vi.fn<(proposalId: string) => Promise<boolean>>>
  readonly startRun: ReturnType<typeof vi.fn<(input: unknown) => Promise<string>>>
  readonly stopRun: ReturnType<typeof vi.fn<() => Promise<string>>>
  readonly revealSession: ReturnType<typeof vi.fn<(sessionId: string) => Promise<boolean>>>
  readonly revealTaskSession: ReturnType<typeof vi.fn<(taskId: string) => Promise<string>>>
  readonly requestPanel: ReturnType<typeof vi.fn<() => Promise<boolean>>>
  readonly retry: ReturnType<typeof vi.fn<() => Promise<void>>>
}

/**
 * Render the panel over one mutable view state.
 * @param options - the snapshot and save/read state the first render sees.
 * @returns the rendered view, the mutable state, and the action spies.
 */
function mount(options: MountOptions = {}) {
  const state: PlanViewState = {
    snapshot: options.snapshot === undefined ? snapshotOf(board()) : options.snapshot,
    status: options.status ?? 'ready',
    saving: options.saving ?? false,
    saveError: options.saveError ?? null,
    stale: options.stale ?? false,
    runError: options.runError ?? null,
  }
  const actions: ActionSpies = {
    addItem: vi.fn(async () => true),
    updateItem: vi.fn(async () => true),
    deleteItem: vi.fn(async () => true),
    setStatus: vi.fn(async () => true),
    reorder: vi.fn(async () => true),
    addTask: vi.fn(async () => true),
    updateTask: vi.fn(async () => true),
    deleteTask: vi.fn(async () => true),
    reorderTasks: vi.fn(async () => true),
    applyProposal: vi.fn(async () => true),
    discardProposal: vi.fn(async () => true),
    startRun: vi.fn(async () => 'ok'),
    stopRun: vi.fn(async () => 'ok'),
    revealSession: vi.fn(async () => true),
    revealTaskSession: vi.fn(async () => 'ok'),
    requestPanel: vi.fn(async () => true),
    retry: vi.fn(async () => {}),
  }
  const props: Partial<PlanPanelProps> = {
    usePlan: <T,>(select: (value: PlanViewState) => T): T => select(state),
    t: makeTranslate(options.dictionary ?? zh) as PlanPanelProps['t'],
    ...(options.floatOut === undefined ? {} : { floatOut: options.floatOut }),
    ...actions,
  }
  const view = render(<PlanPanel {...(props as PlanPanelProps)} />)
  return { ...view, state, actions }
}

/** Accessible names of every list row, in document order. */
function rowNames(): readonly (string | null)[] {
  return screen.getAllByRole('listitem').map(row => row.getAttribute('aria-label'))
}

/** One rect every drag handler agrees on, so the midpoint rule is deterministic. */
const ROW_RECT = {
  top: 0, height: 40, bottom: 40, left: 0, right: 200, width: 200, x: 0, y: 0,
  toJSON: (): Record<string, number> => ({}),
}

/** The data-transfer surface the panel's handlers touch. */
interface DragTransfer {
  effectAllowed: string
  dropEffect: string
  readonly setData: (type: string, value: string) => void
  readonly getData: (type: string) => string
}

/**
 * Create the minimal `dataTransfer` a native drag event carries in jsdom.
 * @returns the transfer double.
 */
function makeTransfer(): DragTransfer {
  const data = new Map<string, string>()
  return {
    effectAllowed: 'none',
    dropEffect: 'none',
    setData: (type, value) => { data.set(type, value) },
    getData: type => data.get(type) ?? '',
  }
}

/**
 * Dispatch one native drag event the way a browser gesture would.
 * @param target - the element the event starts from or lands on.
 * @param type - native drag event type.
 * @param options - pointer position and the transfer payload.
 */
function drag(target: Element, type: string, options: { clientY?: number; transfer: DragTransfer }): void {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'dataTransfer', { value: options.transfer })
  Object.defineProperty(event, 'clientY', { value: options.clientY ?? 0 })
  act(() => { target.dispatchEvent(event) })
}

/** Give one row the shared rect every drag assertion compares against. */
function place(element: Element): Element {
  Object.defineProperty(element, 'getBoundingClientRect', { value: () => ROW_RECT })
  return element
}

describe('plan list', () => {
  it('renders incomplete items in user order and keeps the completed section collapsed', () => {
    mount()
    expect(rowNames()).toEqual(['计划条目：Alpha', '计划条目：Beta', '计划条目：Delta'])
    const completed = screen.getByRole('button', { name: /已完成（1）/ })
    expect(completed.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByRole('listitem', { name: '计划条目：Gamma' })).toBeNull()
  })

  it('expands the completed section and restores one item to the to-do list', () => {
    const { actions } = mount()
    fireEvent.click(screen.getByRole('button', { name: /已完成（1）/ }))
    const done = screen.getByRole('listitem', { name: '计划条目：Gamma' })
    expect(within(done).getByText('Gamma')).toBeTruthy()
    fireEvent.click(within(done).getByRole('button', { name: '恢复为待办' }))
    expect(actions.setStatus).toHaveBeenCalledWith('c', 'todo')
  })

  it('explains the empty plan', () => {
    mount({ snapshot: snapshotOf([]) })
    expect(screen.getByText('还没有计划，添加第一条吧。')).toBeTruthy()
  })
})

/** Open the collapsed plan add form. */
function openAddPlan(): void {
  fireEvent.click(screen.getByRole('button', { name: '＋ 计划' }))
}

/** Open the collapsed task add form. */
function openAddTask(): void {
  fireEvent.click(screen.getByRole('button', { name: '＋ 任务' }))
}

describe('add form', () => {
  it('refuses an empty title and never calls addItem', () => {
    const { actions } = mount()
    openAddPlan()
    fireEvent.click(screen.getByRole('button', { name: '添加' }))
    expect(screen.getByText('标题不能为空')).toBeTruthy()
    expect(actions.addItem).not.toHaveBeenCalled()
  })

  it('adds a title with no optional details', async () => {
    const { actions } = mount()
    openAddPlan()
    fireEvent.change(screen.getByPlaceholderText('输入计划标题'), { target: { value: 'Write report' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '添加' })) })
    expect(actions.addItem).toHaveBeenCalledWith({ title: 'Write report', note: '', dueDate: null })
  })

  it('adds the note and date once the optional details are shown', async () => {
    const { actions } = mount()
    openAddPlan()
    fireEvent.click(screen.getByRole('button', { name: '添加备注和日期' }))
    fireEvent.change(screen.getByPlaceholderText('输入计划标题'), { target: { value: 'Plan review' } })
    fireEvent.change(screen.getByLabelText('备注（选填）'), { target: { value: 'Read the draft' } })
    fireEvent.change(screen.getByLabelText('预计完成日期（选填）'), { target: { value: '2026-10-30' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '添加' })) })
    expect(actions.addItem).toHaveBeenCalledWith({
      title: 'Plan review', note: 'Read the draft', dueDate: '2026-10-30',
    })
  })
})

describe('inline editing', () => {
  it('opens on a row click and saves the edited values', async () => {
    const { actions } = mount()
    fireEvent.click(screen.getByRole('listitem', { name: '计划条目：Alpha' }))
    const title = screen.getByLabelText('标题')
    expect((title as HTMLInputElement).value).toBe('Alpha')
    fireEvent.change(title, { target: { value: 'Alpha revised' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '保存' })) })
    expect(actions.updateItem).toHaveBeenCalledWith({
      id: 'a', title: 'Alpha revised', note: '', dueDate: null,
    })
  })

  it('blocks a blank title and keeps the editor open', () => {
    const { actions } = mount()
    fireEvent.click(screen.getByRole('listitem', { name: '计划条目：Beta' }))
    fireEvent.change(screen.getByLabelText('标题'), { target: { value: '   ' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    expect(screen.getByText('标题不能为空')).toBeTruthy()
    expect(actions.updateItem).not.toHaveBeenCalled()
    expect(screen.getByLabelText('标题')).toBeTruthy()
  })

  it('discards the draft on cancel', () => {
    const { actions } = mount()
    fireEvent.click(screen.getByRole('listitem', { name: '计划条目：Alpha' }))
    fireEvent.change(screen.getByLabelText('标题'), { target: { value: 'Not saved' } })
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(actions.updateItem).not.toHaveBeenCalled()
    expect(screen.queryByLabelText('标题')).toBeNull()
  })
})

describe('status and delete', () => {
  it('changes one item status from its dot menu', () => {
    const { actions } = mount()
    const row = screen.getByRole('listitem', { name: '计划条目：Alpha' })
    fireEvent.click(within(row).getByRole('button', { name: '“Alpha”的状态：待办' }))
    fireEvent.click(within(row).getByRole('button', { name: '已完成' }))
    expect(actions.setStatus).toHaveBeenCalledWith('a', 'done')
  })

  it('names the deleted item and requires confirmation', async () => {
    const { actions } = mount()
    const row = screen.getByRole('listitem', { name: '计划条目：Beta' })
    fireEvent.click(within(row).getByRole('button', { name: '“Beta”的更多操作' }))
    fireEvent.click(within(row).getByRole('button', { name: '删除' }))
    expect(within(row).getByText('删除“Beta”？其下的任务记录也会一并删除。')).toBeTruthy()
    expect(actions.deleteItem).not.toHaveBeenCalled()
    await act(async () => { fireEvent.click(within(row).getByRole('button', { name: '确认删除' })) })
    expect(actions.deleteItem).toHaveBeenCalledWith('b')
  })
})

describe('proposal preview', () => {
  /** A pending proposal against revision 3 with one add, one edit, and one reorder. */
  function pendingProposal(baseRevision = 3): PlanProposal {
    return {
      proposalId: 'proposal-1',
      baseRevision,
      createdAt: '2026-10-21T00:00:00.000Z',
      changes: [
        change({
          changeId: 'chg-add', kind: 'add', itemId: 'new-1',
          after: { title: 'New thing', note: '', dueDate: null, workdir: '' },
        }),
        change({
          changeId: 'chg-edit', kind: 'edit', itemId: 'a',
          before: { title: 'Alpha', note: '', dueDate: null, workdir: '' },
          after: { title: 'Alpha revised', note: '', dueDate: null, workdir: '' },
        }),
        change({
          changeId: 'chg-reorder', kind: 'reorder',
          beforeOrder: ['a', 'b', 'd'], afterOrder: ['d', 'b', 'a'],
        }),
      ],
    }
  }

  it('lists every change and applies only the kept ones', async () => {
    const { actions } = mount({ snapshot: snapshotOf(board(), pendingProposal(), 3) })
    expect(screen.getByText('待确认的 AI 变更')).toBeTruthy()
    expect(screen.getByText('新增：New thing')).toBeTruthy()
    expect(screen.getByText('修改：“Alpha” → “Alpha revised”（标题）')).toBeTruthy()
    expect(screen.getByText('顺序调整：3 项')).toBeTruthy()
    const boxes = screen.getAllByRole('checkbox')
    expect(boxes).toHaveLength(3)
    const second = boxes[1]
    if (second === undefined) throw new Error('expected a second change checkbox')
    fireEvent.click(second)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '确认应用' })) })
    expect(actions.applyProposal).toHaveBeenCalledWith('proposal-1', ['chg-add', 'chg-reorder'])
  })

  it('refuses to apply when every change was cancelled out', () => {
    mount({ snapshot: snapshotOf(board(), pendingProposal(), 3) })
    for (const box of screen.getAllByRole('checkbox')) fireEvent.click(box)
    const apply = screen.getByRole('button', { name: '确认应用' })
    expect((apply as HTMLButtonElement).disabled).toBe(true)
  })

  it('marks a proposal built against an older revision stale and offers only discard', async () => {
    const { actions } = mount({ snapshot: snapshotOf(board(), pendingProposal(2), 3) })
    expect(screen.getByText('计划在预览后已发生变化，请让 AI 基于最新计划重新生成预览。')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '确认应用' })).toBeNull()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '取消本次预览' }))
    })
    expect(actions.discardProposal).toHaveBeenCalledWith('proposal-1')
  })

  it('discards a fresh proposal without applying it', async () => {
    const { actions } = mount({ snapshot: snapshotOf(board(), pendingProposal(), 3) })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '取消' })) })
    expect(actions.discardProposal).toHaveBeenCalledWith('proposal-1')
    expect(actions.applyProposal).not.toHaveBeenCalled()
  })
})

describe('drag reordering', () => {
  it('moves a row after the row it is dropped on and saves the new order', () => {
    const { actions } = mount()
    const transfer = makeTransfer()
    const alpha = place(screen.getByRole('listitem', { name: '计划条目：Alpha' }))
    const delta = place(screen.getByRole('listitem', { name: '计划条目：Delta' }))
    drag(alpha, 'dragstart', { transfer })
    drag(delta, 'dragover', { transfer, clientY: 35 })
    drag(delta, 'drop', { transfer, clientY: 35 })
    expect(actions.reorder).toHaveBeenCalledWith(['b', 'd', 'a'])
  })

  it('moves a row before the row it is dropped on', () => {
    const { actions } = mount()
    const transfer = makeTransfer()
    const beta = place(screen.getByRole('listitem', { name: '计划条目：Beta' }))
    const alpha = place(screen.getByRole('listitem', { name: '计划条目：Alpha' }))
    drag(beta, 'dragstart', { transfer })
    drag(alpha, 'dragover', { transfer, clientY: 5 })
    drag(alpha, 'drop', { transfer, clientY: 5 })
    expect(actions.reorder).toHaveBeenCalledWith(['b', 'a', 'd'])
  })

  it('offers no up, down, or move control', () => {
    mount()
    const names = screen.getAllByRole('button')
      .map(button => button.getAttribute('aria-label') ?? button.textContent ?? '')
    expect(names.some(name => /上移|下移|移动|排序|up|down|move/i.test(name))).toBe(false)
  })
})

describe('save feedback', () => {
  it('shows the failure with its reason instead of a saved state', () => {
    mount({ saveError: 'disk full' })
    expect(screen.getByText('未保存：disk full')).toBeTruthy()
    expect(screen.getByRole('button', { name: '重试' })).toBeTruthy()
  })

  it('renders the read failure and retries', () => {
    const { actions } = mount({ snapshot: null, status: 'error' })
    expect(screen.getByText('无法加载计划。')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    expect(actions.retry).toHaveBeenCalledTimes(1)
  })

  it('renders the loading placeholder before the first answer', () => {
    mount({ snapshot: null, status: 'loading' })
    expect(screen.getByText('正在加载计划…')).toBeTruthy()
  })
})

/** Three tasks of plan `a`, one of them already done. */
function planTasks(): readonly PlanTask[] {
  return [
    task({ id: 't1', planId: 'a', title: 'Gather data', order: 0 }),
    task({ id: 't2', planId: 'a', title: 'Plot results', order: 1, status: 'running', message: 'reading data.csv' }),
    task({ id: 't3', planId: 'a', title: 'Write report', order: 2, status: 'done', sessionId: 'se-3', result: {
      outcome: 'done', summary: 'wrote weekly.md', files: ['C:\\work\\weekly.md'], sessionId: 'se-3',
      runId: 'run-1', recordedAt: '2026-10-21T00:00:00.000Z',
    } }),
  ]
}

describe('task list', () => {
  it('selects a plan with its own button and shows only that plan\'s tasks', () => {
    mount({ snapshot: snapshotOf(board(), null, 1, planTasks()) })
    expect(document.querySelector('[data-plan-current-title]')?.textContent).toContain('任务')
    fireEvent.click(screen.getByRole('button', { name: '选择“Alpha”查看其任务' }))
    expect(document.querySelector('[data-plan-current-title]')?.textContent).toContain('Alpha')
    const tasks = screen.getAllByRole('listitem')
      .filter(row => row.getAttribute('aria-label')?.startsWith('任务：') === true)
    expect(tasks.map(row => row.getAttribute('aria-label'))).toEqual([
      '任务：Gather data', '任务：Plot results', '任务：Write report',
    ])
  })

  it('shows each task status, progress line, and the batch progress', () => {
    mount({ snapshot: snapshotOf(board(), null, 1, planTasks()) })
    fireEvent.click(screen.getByRole('button', { name: '选择“Alpha”查看其任务' }))
    expect(screen.getByText('待开始')).toBeTruthy()
    expect(screen.getByText('执行中')).toBeTruthy()
    expect(screen.getByText('reading data.csv')).toBeTruthy()
    const progress = document.querySelector('[data-plan-progress]')
    expect(progress?.textContent).toBe('已完成 1/3')
  })

  it('asks for a plan before showing tasks and explains an empty plan', () => {
    mount({ snapshot: snapshotOf(board(), null, 1, planTasks()) })
    expect(screen.getByText('请先在上方选择一个计划。')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '选择“Delta”查看其任务' }))
    expect(screen.getByText('该计划还没有任务。添加任务，或让 AI 帮你拆分。')).toBeTruthy()
  })

  it('adds a task to the selected plan with and without details', async () => {
    const { actions } = mount({ snapshot: snapshotOf(board(), null, 1, planTasks()) })
    fireEvent.click(screen.getByRole('button', { name: '选择“Alpha”查看其任务' }))
    openAddTask()
    fireEvent.change(screen.getByPlaceholderText('输入任务标题'), { target: { value: 'Check totals' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '添加任务' })) })
    expect(actions.addTask).toHaveBeenCalledWith({
      planId: 'a', title: 'Check totals', detail: '', requirement: '', requestedFiles: [],
    })

    fireEvent.click(screen.getByRole('button', { name: '添加执行说明与完成要求' }))
    fireEvent.change(screen.getByPlaceholderText('输入任务标题'), { target: { value: 'Draft summary' } })
    fireEvent.change(screen.getByLabelText('执行说明（选填）'), { target: { value: 'Two lines' } })
    fireEvent.change(screen.getByLabelText('完成要求（选填）'), { target: { value: 'Both means listed' } })
    fireEvent.change(screen.getByLabelText('必须生成的文件，每行一个（选填）'), { target: { value: 'summary.csv\nchart.png' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '添加任务' })) })
    expect(actions.addTask).toHaveBeenLastCalledWith({
      planId: 'a',
      title: 'Draft summary',
      detail: 'Two lines',
      requirement: 'Both means listed',
      requestedFiles: ['summary.csv', 'chart.png'],
    })
  })

  it('refuses an empty task title', () => {
    const { actions } = mount({ snapshot: snapshotOf(board(), null, 1, planTasks()) })
    fireEvent.click(screen.getByRole('button', { name: '选择“Alpha”查看其任务' }))
    openAddTask()
    fireEvent.click(screen.getByRole('button', { name: '添加任务' }))
    expect(screen.getByText('任务标题不能为空')).toBeTruthy()
    expect(actions.addTask).not.toHaveBeenCalled()
  })

  it('edits a task title, instruction, completion requirements and required files', async () => {
    const { actions } = mount({ snapshot: snapshotOf(board(), null, 1, planTasks()) })
    fireEvent.click(screen.getByRole('button', { name: '选择“Alpha”查看其任务' }))
    fireEvent.click(screen.getByRole('listitem', { name: '任务：Gather data' }))
    fireEvent.change(screen.getByLabelText('任务标题'), { target: { value: 'Gather all data' } })
    fireEvent.change(screen.getByLabelText('执行说明'), { target: { value: 'Read data.csv twice' } })
    fireEvent.change(screen.getByLabelText('完成要求'), { target: { value: 'summary.csv lists both means' } })
    fireEvent.change(screen.getByLabelText('必须生成的文件'), { target: { value: 'summary.csv\n\nnotes.md' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '保存' })) })
    expect(actions.updateTask).toHaveBeenCalledWith({
      id: 't1',
      title: 'Gather all data',
      detail: 'Read data.csv twice',
      requirement: 'summary.csv lists both means',
      requestedFiles: ['summary.csv', 'notes.md'],
    })
  })

  it('shows completion requirements and required files on the task row', () => {
    mount({
      snapshot: snapshotOf(board(), null, 1, [
        task({ id: 't1', planId: 'a', title: 'Gather data', requirement: 'both means', requestedFiles: ['summary.csv'] }),
      ]),
    })
    fireEvent.click(screen.getByRole('button', { name: '选择“Alpha”查看其任务' }))
    expect(screen.getByText('完成要求：both means')).toBeTruthy()
    expect(screen.getByText('必须生成：summary.csv')).toBeTruthy()
  })

  it('deletes a task only after the confirmation', async () => {
    const { actions } = mount({ snapshot: snapshotOf(board(), null, 1, planTasks()) })
    fireEvent.click(screen.getByRole('button', { name: '选择“Alpha”查看其任务' }))
    const row = screen.getByRole('listitem', { name: '任务：Gather data' })
    fireEvent.click(within(row).getByRole('button', { name: '任务“Gather data”的更多操作' }))
    fireEvent.click(within(row).getByRole('button', { name: '删除任务' }))
    expect(within(row).getByText('删除任务“Gather data”？此操作不可撤销。')).toBeTruthy()
    expect(actions.deleteTask).not.toHaveBeenCalled()
    await act(async () => { fireEvent.click(within(row).getByRole('button', { name: '确认删除' })) })
    expect(actions.deleteTask).toHaveBeenCalledWith('t1')
  })

  it('opens the latest task Session in the main window through the task identity', async () => {
    const { actions } = mount({ snapshot: snapshotOf(board(), null, 1, planTasks()) })
    fireEvent.click(screen.getByRole('button', { name: '选择“Alpha”查看其任务' }))
    const row = screen.getByRole('listitem', { name: '任务：Write report' })
    await act(async () => { fireEvent.click(within(row).getByRole('button', { name: '查看过程' })) })
    expect(actions.revealTaskSession).toHaveBeenCalledWith('t3')
    expect(screen.queryByText('原任务会话已删除或不可用。')).toBeNull()
  })

  it('reports a task Session that no longer exists instead of opening one', async () => {
    const { actions } = mount({ snapshot: snapshotOf(board(), null, 1, planTasks()) })
    actions.revealTaskSession.mockResolvedValueOnce('unavailable')
    fireEvent.click(screen.getByRole('button', { name: '选择“Alpha”查看其任务' }))
    const row = screen.getByRole('listitem', { name: '任务：Write report' })
    await act(async () => { fireEvent.click(within(row).getByRole('button', { name: '查看过程' })) })
    expect(screen.getByText('原任务会话已删除或不可用。')).toBeTruthy()
  })

  it('reorders tasks by dragging, not by move buttons', () => {
    const { actions } = mount({ snapshot: snapshotOf(board(), null, 1, planTasks()) })
    fireEvent.click(screen.getByRole('button', { name: '选择“Alpha”查看其任务' }))
    const transfer = makeTransfer()
    const first = place(screen.getByRole('listitem', { name: '任务：Gather data' }))
    const last = place(screen.getByRole('listitem', { name: '任务：Write report' }))
    drag(first, 'dragstart', { transfer })
    drag(last, 'dragover', { transfer, clientY: 35 })
    drag(last, 'drop', { transfer, clientY: 35 })
    expect(actions.reorderTasks).toHaveBeenCalledWith('a', ['t2', 't3', 't1'])
  })
})

describe('running a plan', () => {
  it('reports a plan that has no working directory yet', () => {
    mount({ snapshot: snapshotOf(board(), null, 1, planTasks()), runError: 'missing-workdir' })
    fireEvent.click(screen.getByRole('button', { name: '选择“Alpha”查看其任务' }))
    expect(screen.getByText('该计划还没有工作目录，请先在计划的“⋯”里指定。')).toBeTruthy()
  })

  it('runs the whole plan with the plan\'s own working directory', async () => {
    const plans = [item({ id: 'a', title: 'Alpha', workdir: 'C:\\work' }), ...board().slice(1)]
    const { actions } = mount({ snapshot: snapshotOf(plans, null, 1, planTasks()) })
    fireEvent.click(screen.getByRole('button', { name: '选择“Alpha”查看其任务' }))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '执行本计划' })) })
    expect(actions.startRun).toHaveBeenCalledWith({ planId: 'a' })
  })

  it('shows the batch state and stops it instead of running again', async () => {
    const { actions } = mount({ snapshot: snapshotOf(board(), null, 1, planTasks(), runOf()) })
    fireEvent.click(screen.getByRole('button', { name: '选择“Alpha”查看其任务' }))
    expect(screen.getByText('正在执行')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '执行本计划' })).toBeNull()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '停止本计划' })) })
    expect(actions.stopRun).toHaveBeenCalledTimes(1)
  })

  it('reports a refused start and blocks running a single task', () => {
    mount({ snapshot: snapshotOf(board(), null, 1, planTasks()), runError: 'run-active' })
    fireEvent.click(screen.getByRole('button', { name: '选择“Alpha”查看其任务' }))
    expect(screen.getByText('已有执行中的计划，请先停止。')).toBeTruthy()
  })

  it('runs one task alone', async () => {
    const { actions } = mount({ snapshot: snapshotOf(board(), null, 1, planTasks()) })
    fireEvent.click(screen.getByRole('button', { name: '选择“Alpha”查看其任务' }))
    const row = screen.getByRole('listitem', { name: '任务：Gather data' })
    await act(async () => { fireEvent.click(within(row).getByRole('button', { name: '执行任务' })) })
    expect(actions.startRun).toHaveBeenCalledWith({ planId: 'a', taskId: 't1' })
  })
})

describe('floating the embedded board', () => {
  it('offers the float action only when the surface can float', () => {
    mount({ snapshot: snapshotOf(board(), null, 1, planTasks()) })
    expect(screen.queryByRole('button', { name: '浮出为独立窗口' })).toBeNull()
  })

  it('moves the board out through the injected float action', () => {
    const floatOut = vi.fn()
    mount({ snapshot: snapshotOf(board(), null, 1, planTasks()), floatOut })
    fireEvent.click(screen.getByRole('button', { name: '浮出为独立窗口' }))
    expect(floatOut).toHaveBeenCalledTimes(1)
  })

  it('keeps editing available while embedded', () => {
    mount({ snapshot: snapshotOf(board(), null, 1, planTasks()), floatOut: vi.fn() })
    fireEvent.click(screen.getByRole('listitem', { name: '计划条目：Alpha' }))
    expect(screen.getByLabelText('标题')).toBeTruthy()
  })
})



it('resizes the plan/task sections without changing their data', () => {
  const { state, actions } = mount()
  const before = JSON.stringify(state.snapshot)
  const divider = screen.getByRole('separator')
  expect(divider.getAttribute('aria-valuenow')).toBe('50')
  fireEvent.keyDown(divider, { key: 'ArrowDown' })
  expect(divider.getAttribute('aria-valuenow')).toBe('52')
  for (let i = 0; i < 30; i++) fireEvent.keyDown(divider, { key: 'ArrowUp' })
  expect(divider.getAttribute('aria-valuenow')).toBe('20')
  fireEvent.doubleClick(divider)
  expect(divider.getAttribute('aria-valuenow')).toBe('50')
  expect(JSON.stringify(state.snapshot)).toBe(before)
  for (const action of Object.values(actions)) expect(action).not.toHaveBeenCalled()
})
