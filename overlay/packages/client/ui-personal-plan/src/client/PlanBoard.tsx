/**
 * The plan-and-task surface shared by the right-Sidebar tab and the floating
 * desktop window: plans on top, the selected plan's tasks below.
 *
 * Rendering reads the shared plan source through `usePlan`; every mutation goes
 * through the injected action face, which publishes the Host's answer and keeps
 * a failed write visible in the save status. Drag reordering is native HTML5
 * drag and drop on the row's non-input area; a plain click opens the editor, and
 * a dedicated button selects the plan whose tasks are shown.
 */
import { useMemo, useRef, useState, type DragEvent, type CSSProperties } from 'react'
import { Button, IconChecklistOutlineRegular, IconTrashOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SnapshotSelectorHook, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  PlanItem, PlanItemStatus, PlanProposal, PlanProposalChange, PlanRun, PlanTask, PlanTaskStatus,
} from '@deepseek-ai/dsh-personal-plan/client'
import type { PlanInjected, PlanViewState } from './plan-source.ts'
import { NS } from './locales.ts'
import css from './PlanPanel.module.css'

/** One drop destination: before or after the row the pointer is over. */
interface DropTarget {
  readonly id: string
  readonly before: boolean
}

const STATUS_ORDER: readonly PlanItemStatus[] = ['todo', 'in_progress', 'done']

/** Surface the board renders into: the sidebar tab or the floating window. */
export type PlanBoardVariant = 'panel' | 'window'

/** Props of the shared board. */
export interface PlanBoardProps {
  /** Selector hook over the shared plan source. */
  readonly usePlan: SnapshotSelectorHook<PlanViewState>
  /** The Host action face; the hook seat is passed separately as `usePlan`. */
  readonly face: Omit<PlanInjected, 'hooks'>
  /** Namespace-bound translate. */
  readonly t: TranslateNS<typeof NS>
  /** Which surface is rendering, so the window splits its two scroll areas. */
  readonly variant: PlanBoardVariant
  /** Move the board into the floating window; omitted on surfaces that cannot float. */
  readonly floatOut?: () => void
  /** Hide the floating window and show the embedded board; set only in that window. */
  readonly dockBack?: () => void
  /** Hide the floating window without touching the embedded board; set only in that window. */
  readonly closeWindow?: () => void
}

/**
 * Render the plan board.
 * @param props - the shared source hook, action face, copy, surface variant, and surface actions.
 * @returns the plan and task surface.
 */
export function PlanBoard({ usePlan, face, t, variant, floatOut, dockBack, closeWindow }: PlanBoardProps) {
  const {
    addItem, updateItem, deleteItem, setStatus, reorder,
    addTask, updateTask, deleteTask, reorderTasks,
    applyProposal, discardProposal, startRun, stopRun, revealTaskSession, retry,
  } = face
  const state = usePlan(value => value)
  const snapshot = state.snapshot
  const [planPercent, setPlanPercent] = useState(50)
  const [selectedPlanId, setSelectedPlanId] = useState<string | null>(null)
  const [editingPlanId, setEditingPlanId] = useState<string | null>(null)
  const [menuPlanId, setMenuPlanId] = useState<string | null>(null)
  const [statusMenuPlanId, setStatusMenuPlanId] = useState<string | null>(null)
  const [deletePlanId, setDeletePlanId] = useState<string | null>(null)
  const [workdirEditId, setWorkdirEditId] = useState<string | null>(null)
  const [workdirEditValue, setWorkdirEditValue] = useState('')
  const [showAddPlan, setShowAddPlan] = useState(false)
  const [completedOpen, setCompletedOpen] = useState(false)
  const [addPlanTitle, setAddPlanTitle] = useState('')
  const [addPlanNote, setAddPlanNote] = useState('')
  const [addPlanDate, setAddPlanDate] = useState('')
  const [showAddPlanDetails, setShowAddPlanDetails] = useState(false)
  const [addPlanError, setAddPlanError] = useState(false)
  const [planDragId, setPlanDragId] = useState<string | null>(null)
  const [planDropTarget, setPlanDropTarget] = useState<DropTarget | null>(null)
  const [addTaskTitle, setAddTaskTitle] = useState('')
  const [addTaskDetail, setAddTaskDetail] = useState('')
  const [addTaskRequirement, setAddTaskRequirement] = useState('')
  const [addTaskFiles, setAddTaskFiles] = useState('')
  const [showAddTaskDetail, setShowAddTaskDetail] = useState(false)
  const [addTaskError, setAddTaskError] = useState(false)
  const [editingTaskId, setEditingTaskId] = useState<string | null>(null)
  const [taskMenuId, setTaskMenuId] = useState<string | null>(null)
  const [deleteTaskId, setDeleteTaskId] = useState<string | null>(null)
  const [sessionNotice, setSessionNotice] = useState<string | null>(null)
  const [showAddTask, setShowAddTask] = useState(false)
  const [taskDragId, setTaskDragId] = useState<string | null>(null)
  const [taskDropTarget, setTaskDropTarget] = useState<DropTarget | null>(null)
  const planScrollRef = useRef<HTMLDivElement>(null)
  const taskScrollRef = useRef<HTMLDivElement>(null)

  const items = useMemo(() => snapshot?.items ?? [], [snapshot])
  const tasks = useMemo(() => snapshot?.tasks ?? [], [snapshot])
  const incomplete = useMemo(() => items.filter(item => item.status !== 'done'), [items])
  const completed = useMemo(() => items.filter(item => item.status === 'done'), [items])
  const currentPlan = useMemo(() => {
    if (selectedPlanId === null) return null
    return items.find(item => item.id === selectedPlanId) ?? null
  }, [items, selectedPlanId])
  const planTasks = useMemo(() => currentPlan === null
    ? []
    : tasks.filter(task => task.planId === currentPlan.id), [tasks, currentPlan])
  const run = snapshot?.run ?? null
  const runActive = run !== null && run.status === 'running'
  const doneCount = planTasks.filter(task => task.status === 'done').length

  if (state.status === 'loading' && snapshot === null) {
    return <div className={css.center}>{t('loading')}</div>
  }
  if (state.status === 'error' && snapshot === null) {
    return (
      <div className={css.center}>
        <span>{t('load.error')}</span>
        <Button variant="outline" size="sm" onClick={() => { void retry() }}>{t('retry')}</Button>
      </div>
    )
  }
  if (snapshot === null) return <div className={css.center}>{t('loading')}</div>

  const submitAddPlan = async (): Promise<void> => {
    if (addPlanTitle.trim() === '') {
      setAddPlanError(true)
      return
    }
    setAddPlanError(false)
    const ok = await addItem({
      title: addPlanTitle,
      note: showAddPlanDetails ? addPlanNote : '',
      dueDate: showAddPlanDetails && addPlanDate !== '' ? addPlanDate : null,
    })
    if (!ok) return
    setAddPlanTitle('')
    setAddPlanNote('')
    setAddPlanDate('')
  }

  const movePlan = (movingId: string, target: DropTarget | null): void => {
    const ids = incomplete.map(item => item.id)
    if (!ids.includes(movingId)) return
    const remaining = ids.filter(id => id !== movingId)
    if (target === null) {
      remaining.push(movingId)
    } else {
      const index = remaining.indexOf(target.id)
      if (index === -1) return
      remaining.splice(target.before ? index : index + 1, 0, movingId)
    }
    if (remaining.join('\u0000') === ids.join('\u0000')) return
    void reorder(remaining)
  }

  const onPlanDragStart = (event: DragEvent<HTMLDivElement>, item: PlanItem): void => {
    if (editingPlanId === item.id) {
      event.preventDefault()
      return
    }
    setPlanDragId(item.id)
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', item.id)
  }

  const onPlanDragOver = (event: DragEvent<HTMLDivElement>, item: PlanItem): void => {
    if (planDragId === null || planDragId === item.id) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    const rect = event.currentTarget.getBoundingClientRect()
    setPlanDropTarget({ id: item.id, before: event.clientY < rect.top + rect.height / 2 })
  }

  const onPlanDrop = (event: DragEvent<HTMLDivElement>, item: PlanItem): void => {
    event.preventDefault()
    if (planDragId !== null) {
      const rect = event.currentTarget.getBoundingClientRect()
      movePlan(planDragId, { id: item.id, before: event.clientY < rect.top + rect.height / 2 })
    }
    setPlanDragId(null)
    setPlanDropTarget(null)
  }

  const scrollOnDrag = (element: HTMLDivElement | null, event: DragEvent<HTMLDivElement>): void => {
    if (element === null) return
    const rect = element.getBoundingClientRect()
    if (event.clientY < rect.top + 32) element.scrollTop -= 24
    else if (event.clientY > rect.bottom - 32) element.scrollTop += 24
  }

  const submitAddTask = async (): Promise<void> => {
    if (currentPlan === null) return
    if (addTaskTitle.trim() === '') {
      setAddTaskError(true)
      return
    }
    setAddTaskError(false)
    const ok = await addTask({
      planId: currentPlan.id,
      title: addTaskTitle,
      detail: showAddTaskDetail ? addTaskDetail : '',
      requirement: showAddTaskDetail ? addTaskRequirement : '',
      requestedFiles: showAddTaskDetail ? splitLines(addTaskFiles) : [],
    })
    if (!ok) return
    setAddTaskTitle('')
    setAddTaskDetail('')
    setAddTaskRequirement('')
    setAddTaskFiles('')
  }

  const moveTask = (movingId: string, target: DropTarget | null): void => {
    if (currentPlan === null) return
    const ids = planTasks.map(task => task.id)
    if (!ids.includes(movingId)) return
    const remaining = ids.filter(id => id !== movingId)
    if (target === null) {
      remaining.push(movingId)
    } else {
      const index = remaining.indexOf(target.id)
      if (index === -1) return
      remaining.splice(target.before ? index : index + 1, 0, movingId)
    }
    if (remaining.join('\u0000') === ids.join('\u0000')) return
    void reorderTasks(currentPlan.id, remaining)
  }

  /**
   * Ask the Desktop shell for a directory, or fall back to typing one.
   * @returns the chosen path, or null when the user cancelled.
   */
  const chooseDirectory = async (): Promise<string | null> => {
    const picker = (globalThis as { __DSH_DIRECTORY_PICKER__?: { pick: () => Promise<string | null> } }).__DSH_DIRECTORY_PICKER__
    if (picker === undefined) return null
    return await picker.pick().catch(() => null)
  }

  /** Put the directory chosen in the plan editor into that plan. */
  const pickWorkdirForEdit = async (): Promise<void> => {
    const picked = await chooseDirectory()
    if (picked !== null && picked !== '') setWorkdirEditValue(picked)
  }

  /**
   * Save one plan's working directory.
   * @param itemId - plan identity whose working directory changes.
   */
  const saveWorkdir = async (itemId: string): Promise<void> => {
    const ok = await updateItem({ id: itemId, workdir: workdirEditValue })
    if (ok) setWorkdirEditId(null)
  }

  const beginRun = async (planId: string, taskId?: string): Promise<void> => {
    await startRun(taskId === undefined ? { planId } : { planId, taskId })
  }

  /**
   * Open one task's Session, reporting a Session that is gone instead of
   * pretending it still works.
   * @param taskId - task whose Session should be shown.
   */
  const openTaskSession = async (taskId: string): Promise<void> => {
    setSessionNotice(null)
    const code = await revealTaskSession(taskId)
    if (code === 'ok') return
    setSessionNotice(code === 'unavailable'
      ? t('task.session.unavailable')
      : code === 'no-session'
        ? t('task.session.none')
        : t('task.session.failed'))
  }

  const runErrorText = state.runError === null
    ? null
    : state.runError === 'run-active'
      ? t('run.error.run-active')
      : state.runError === 'nothing-to-run'
        ? t('run.error.nothing-to-run')
        : state.runError === 'missing-plan'
          ? t('run.error.missing-plan')
          : state.runError === 'missing-task'
            ? t('run.error.missing-task')
            : state.runError === 'missing-workdir'
              ? t('run.error.missing-workdir')
              : state.runError === 'invalid-workdir'
                ? t('run.error.invalid-workdir')
                : t('run.error.failed', { reason: state.runError })

  const planSection = (
    <div className={css.section} data-plan-section="">
      <div className={css.sectionHeader}>
        <span className={css.heading}>{t('plans.title')}</span>
        <span className={css.headerActions}>
          {state.saveError !== null && (
            <Button variant="outline" size="sm" onClick={() => { void retry() }}>{t('retry')}</Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            data-plan-add-open=""
            onClick={() => { setShowAddPlan(value => !value) }}
          >
            {t('add.plan.action')}
          </Button>
          {floatOut !== undefined && (
            <Button variant="ghost" size="sm" data-plan-float-out="" onClick={floatOut}>{t('float.out')}</Button>
          )}
          {dockBack !== undefined && (
            <Button variant="ghost" size="sm" data-plan-window-dock="" onClick={dockBack}>{t('window.dock')}</Button>
          )}
          {closeWindow !== undefined && (
            <Button variant="ghost" size="sm" data-plan-window-close="" onClick={closeWindow}>{t('window.close')}</Button>
          )}
        </span>
      </div>
      {state.saveError !== null && (
        <div className={css.warning} role="alert" data-plan-save-error="">
          {t('save.failed', { reason: state.saveError })}
        </div>
      )}
      <div
        className={css.scroll}
        ref={planScrollRef}
        onDragOver={(event) => { if (planDragId !== null) { event.preventDefault(); scrollOnDrag(planScrollRef.current, event) } }}
      >
        {snapshot.proposal !== null && (
          <ProposalCard
            key={snapshot.proposal.proposalId}
            proposal={snapshot.proposal}
            revision={snapshot.revision}
            stale={state.stale}
            t={t}
            onApply={applyProposal}
            onDiscard={discardProposal}
          />
        )}

        {state.applyError !== null && state.applyError !== undefined && (
          <div className={css.warning} role="alert" data-plan-apply-error={state.applyError}>
            {state.applyError === 'nothing-selected'
              ? t('proposal.none')
              : state.applyError === 'missing-proposal'
                ? t('proposal.missing')
                : t('proposal.failed')}
          </div>
        )}

        {showAddPlan && (
          <div className={css.addBox}>
            <div className={css.addRow}>
              <input
                className={css.addInput}
                value={addPlanTitle}
                data-plan-add-input=""
                placeholder={t('add.placeholder')}
                aria-label={t('add.placeholder')}
                onChange={(event) => { setAddPlanTitle(event.target.value); setAddPlanError(false) }}
                onKeyDown={(event) => { if (event.key === 'Enter') void submitAddPlan() }}
              />
              <Button variant="primary" size="sm" onClick={() => { void submitAddPlan() }}>{t('add.action')}</Button>
            </div>
            {showAddPlanDetails && (
              <div className={css.details}>
                <textarea
                  className={css.textarea}
                  value={addPlanNote}
                  placeholder={t('add.note')}
                  aria-label={t('add.note')}
                  rows={2}
                  onChange={(event) => { setAddPlanNote(event.target.value) }}
                />
                <input
                  className={css.dateInput}
                  type="date"
                  value={addPlanDate}
                  aria-label={t('add.date')}
                  onChange={(event) => { setAddPlanDate(event.target.value) }}
                />
              </div>
            )}
            <div className={css.addFooter}>
              <button type="button" className={css.linkButton} onClick={() => { setShowAddPlanDetails(value => !value) }}>
                {showAddPlanDetails ? t('add.hideDetails') : t('add.details')}
              </button>
              {addPlanError && <span className={css.errorText}>{t('add.invalid')}</span>}
            </div>
          </div>
        )}

        <div className={css.list} aria-label={t('tab.title')}>
          {incomplete.length === 0 && completed.length === 0 && <div className={css.empty}>{t('empty')}</div>}
          {incomplete.map(item => (
            <div
              key={item.id}
              className={[
                css.row,
                planDragId === item.id ? css.rowDragging : '',
                selectedPlanId === item.id ? css.rowSelected : '',
                planDropTarget !== null && planDropTarget.id === item.id && planDropTarget.before ? css.dropBefore : '',
                planDropTarget !== null && planDropTarget.id === item.id && !planDropTarget.before ? css.dropAfter : '',
              ].filter(Boolean).join(' ')}
              draggable={editingPlanId !== item.id && workdirEditId !== item.id}
              onDragStart={event => onPlanDragStart(event, item)}
              onDragOver={event => onPlanDragOver(event, item)}
              onDrop={event => onPlanDrop(event, item)}
              onDragEnd={() => { setPlanDragId(null); setPlanDropTarget(null) }}
              onClick={() => { if (editingPlanId !== item.id) setEditingPlanId(item.id) }}
              role="listitem"
              data-plan-row=""
              data-plan-item-id={item.id}
              {...(planDropTarget !== null && planDropTarget.id === item.id
                ? { [planDropTarget.before ? 'data-plan-drop-before' : 'data-plan-drop-after']: '' }
                : {})}
              aria-label={t('row.aria', { title: item.title })}
            >
              {editingPlanId === item.id ? (
                <PlanEditor
                  item={item}
                  t={t}
                  onCancel={() => { setEditingPlanId(null) }}
                  onSave={async (draft) => {
                    const ok = await updateItem({ id: item.id, ...draft })
                    if (ok) setEditingPlanId(null)
                  }}
                />
              ) : (
                <>
                  <button
                    type="button"
                    className={css.statusDot}
                    data-plan-status-dot={item.status}
                    aria-label={t('plan.status.aria', { title: item.title, status: statusLabel(t, item.status) })}
                    title={statusLabel(t, item.status)}
                    onClick={(event) => {
                      event.stopPropagation()
                      setStatusMenuPlanId(statusMenuPlanId === item.id ? null : item.id)
                      setMenuPlanId(null)
                    }}
                  >
                    <span className={css.dot} data-state={item.status} aria-hidden="true" />
                  </button>
                  <div className={css.rowBody}>
                    <div className={css.rowTitle}>{item.title}</div>
                    {item.note !== '' && <div className={css.rowNote}>{item.note}</div>}
                    {item.dueDate !== null && <div className={css.rowDue}>{t('due', { date: item.dueDate })}</div>}
                    <div className={css.rowDue} data-plan-workdir={item.workdir}>
                      {item.workdir === '' ? t('plan.workdir.none') : t('plan.workdir', { path: item.workdir })}
                    </div>
                    {tasks.some(task => task.planId === item.id) && (
                      <div className={css.rowDue}>
                        {t('tasks.count', {
                          done: String(tasks.filter(task => task.planId === item.id && task.status === 'done').length),
                          total: String(tasks.filter(task => task.planId === item.id).length),
                        })}
                      </div>
                    )}
                  </div>
                  <div className={css.rowActions}>
                    <button
                      type="button"
                      className={selectedPlanId === item.id ? css.selectButtonActive : css.selectButton}
                      data-plan-select={item.id}
                      aria-label={t('select.plan.aria', { title: item.title })}
                      title={t('select.plan')}
                      onClick={(event) => {
                        event.stopPropagation()
                        setSelectedPlanId(item.id)
                      }}
                    >
                      <IconChecklistOutlineRegular size={16} />
                    </button>
                    <button
                      type="button"
                      className={css.menuButton}
                      aria-label={t('menu.aria', { title: item.title })}
                      onClick={(event) => {
                        event.stopPropagation()
                        setMenuPlanId(menuPlanId === item.id ? null : item.id)
                        setStatusMenuPlanId(null)
                        setDeletePlanId(null)
                      }}
                    >
                      ⋯                    </button>
                  </div>
                  {statusMenuPlanId === item.id && (
                    <div className={css.menu} onClick={(event) => { event.stopPropagation() }}>
                      {STATUS_ORDER.map(status => (
                        <Button
                          key={status}
                          variant="ghost"
                          size="sm"
                          data-plan-set-status={status}
                          onClick={() => { setStatusMenuPlanId(null); void setStatus(item.id, status) }}
                        >
                          {statusLabel(t, status)}
                        </Button>
                      ))}
                    </div>
                  )}
                </>
              )}
              {workdirEditId === item.id && (
                <div className={css.workdirEditor} onClick={(event) => { event.stopPropagation() }}>
                  <input
                    className={css.addInput}
                    value={workdirEditValue}
                    data-plan-workdir-input=""
                    placeholder={t('plan.workdir.placeholder')}
                    aria-label={t('plan.workdir.placeholder')}
                    onChange={(event) => { setWorkdirEditValue(event.target.value) }}
                    onKeyDown={(event) => { if (event.key === 'Enter') void saveWorkdir(item.id) }}
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    data-plan-workdir-pick=""
                    onClick={() => { void pickWorkdirForEdit() }}
                  >
                    {t('plan.workdir.pick')}
                  </Button>
                  <Button variant="primary" size="sm" data-plan-workdir-save="" onClick={() => { void saveWorkdir(item.id) }}>
                    {t('edit.save')}
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => { setWorkdirEditId(null) }}>{t('edit.cancel')}</Button>
                </div>
              )}
              {menuPlanId === item.id && deletePlanId !== item.id && (
                <div className={css.menu} onClick={(event) => { event.stopPropagation() }}>
                  <Button
                    variant="ghost"
                    size="sm"
                    data-plan-workdir-set=""
                    onClick={() => {
                      setMenuPlanId(null)
                      setWorkdirEditId(item.id)
                      setWorkdirEditValue(item.workdir)
                    }}
                  >
                    {t('plan.workdir.set')}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    icon={<IconTrashOutlineRegular size={16} />}
                    onClick={() => { setDeletePlanId(item.id) }}
                  >
                    {t('menu.delete')}
                  </Button>
                </div>
              )}
              {deletePlanId === item.id && (
                <div className={css.confirm} onClick={(event) => { event.stopPropagation() }}>
                  <span>{t('delete.confirm', { title: item.title })}</span>
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={async () => {
                      setDeletePlanId(null)
                      setMenuPlanId(null)
                      if (selectedPlanId === item.id) setSelectedPlanId(null)
                      await deleteItem(item.id)
                    }}
                  >
                    {t('delete.confirm.action')}
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => { setDeletePlanId(null); setMenuPlanId(null) }}>{t('delete.cancel')}</Button>
                </div>
              )}
            </div>
          ))}
          {incomplete.length > 0 && (
            <div
              className={css.dropEnd}
              data-plan-drop-end=""
              onDragOver={(event) => { if (planDragId !== null) { event.preventDefault(); setPlanDropTarget(null) } }}
              onDrop={(event) => {
                event.preventDefault()
                if (planDragId !== null) movePlan(planDragId, null)
                setPlanDragId(null)
                setPlanDropTarget(null)
              }}
            >
              {t('drag.hint')}
            </div>
          )}
        </div>

        {completed.length > 0 && (
          <div className={css.completed}>
            <button
              type="button"
              className={css.completedHeader}
              aria-expanded={completedOpen}
              onClick={() => { setCompletedOpen(value => !value) }}
            >
              <IconChecklistOutlineRegular size={16} />
              <span>{t('completed.title', { count: String(completed.length) })}</span>
            </button>
            {completedOpen && (
              <div className={css.list}>
                {completed.map(item => (
                  <div
                    key={item.id}
                    className={`${css.row} ${css.rowDone}${selectedPlanId === item.id ? ` ${css.rowSelected}` : ''}`}
                    role="listitem"
                    data-plan-row=""
                    data-plan-item-id={item.id}
                    aria-label={t('row.aria', { title: item.title })}
                  >
                    <button
                      type="button"
                      className={selectedPlanId === item.id ? css.selectButtonActive : css.selectButton}
                      data-plan-select={item.id}
                      aria-label={t('select.plan.aria', { title: item.title })}
                      onClick={() => { setSelectedPlanId(item.id) }}
                    >
                      <IconChecklistOutlineRegular size={16} />
                    </button>
                    <div className={css.rowBody}>
                      <div className={css.rowTitle}>{item.title}</div>
                      {item.note !== '' && <div className={css.rowNote}>{item.note}</div>}
                      {item.dueDate !== null && <div className={css.rowDue}>{t('due', { date: item.dueDate })}</div>}
                    </div>
                    <Button variant="ghost" size="sm" onClick={() => { void setStatus(item.id, 'todo') }}>
                      {t('completed.restore')}
                    </Button>
                    <button
                      type="button"
                      className={css.menuButton}
                      aria-label={t('menu.aria', { title: item.title })}
                      onClick={() => { setDeletePlanId(deletePlanId === item.id ? null : item.id); setMenuPlanId(null) }}
                    >
                      ⋯                    </button>
                    {deletePlanId === item.id && (
                      <div className={css.confirm}>
                        <span>{t('delete.confirm', { title: item.title })}</span>
                        <Button variant="primary" size="sm" onClick={async () => {
                          setDeletePlanId(null)
                          if (selectedPlanId === item.id) setSelectedPlanId(null)
                          await deleteItem(item.id)
                        }}>
                          {t('delete.confirm.action')}
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => { setDeletePlanId(null) }}>{t('delete.cancel')}</Button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )

  const taskSection = (
    <div className={css.section} data-plan-task-section={variant}>
      <div className={css.sectionHeader}>
        <span className={css.heading} data-plan-current-title="">
          {t('tasks.title')}
          {currentPlan !== null && <span className={css.headingContext}>{currentPlan.title}</span>}
        </span>
        <span className={css.headerActions}>
          {currentPlan !== null && planTasks.length > 0 && (
            <span className={css.status} data-plan-progress="">
              {t('tasks.count', { done: String(doneCount), total: String(planTasks.length) })}
            </span>
          )}
          {currentPlan !== null && (
            <Button
              variant="ghost"
              size="sm"
              data-plan-task-add-open=""
              onClick={() => { setShowAddTask(value => !value) }}
            >
              {t('task.add.open')}
            </Button>
          )}
          {currentPlan !== null && (
            runActive
              ? <Button variant="outline" size="sm" data-plan-run-stop="" onClick={() => { void stopRun() }}>{t('task.run.stop')}</Button>
              : <Button variant="primary" size="sm" data-plan-run-plan="" onClick={() => { void beginRun(currentPlan.id) }}>{t('task.run.plan')}</Button>
          )}
        </span>
      </div>
      {runErrorText !== null && <div className={css.warning} role="alert" data-plan-run-error="">{runErrorText}</div>}
      {sessionNotice !== null && (
        <div className={css.warning} role="alert" data-plan-session-notice="">{sessionNotice}</div>
      )}
      {run !== null && (
        <div className={css.runBar} data-plan-run-status={run.status}>
          <span>
            {run.status === 'running'
              ? t('run.active')
              : run.status === 'done'
                ? t('run.done')
                : run.status === 'interrupted' ? t('run.interrupted') : t('run.stopped')}
          </span>
          {run.message !== '' && <span className={css.runMessage}>{run.message}</span>}
        </div>
      )}
      <div
        className={css.taskScroll}
        ref={taskScrollRef}
        onDragOver={(event) => { if (taskDragId !== null) { event.preventDefault(); scrollOnDrag(taskScrollRef.current, event) } }}
      >
        {currentPlan === null && <div className={css.empty}>{t('tasks.none')}</div>}
        {currentPlan !== null && (
          <>
            {planTasks.length === 0 && <div className={css.empty}>{t('tasks.empty')}</div>}
            <div className={css.list} aria-label={t('tasks.heading')}>
              {planTasks.map(task => (
                <div
                  key={task.id}
                  className={[
                    css.taskRow,
                    task.status === 'running' ? css.taskRunning : '',
                    taskDragId === task.id ? css.rowDragging : '',
                    taskDropTarget !== null && taskDropTarget.id === task.id && taskDropTarget.before ? css.dropBefore : '',
                    taskDropTarget !== null && taskDropTarget.id === task.id && !taskDropTarget.before ? css.dropAfter : '',
                  ].filter(Boolean).join(' ')}
                  draggable={editingTaskId !== task.id && !runActive}
                  onDragStart={(event) => {
                    if (editingTaskId === task.id || runActive) { event.preventDefault(); return }
                    setTaskDragId(task.id)
                    event.dataTransfer.effectAllowed = 'move'
                    event.dataTransfer.setData('text/plain', task.id)
                  }}
                  onDragOver={(event) => {
                    if (taskDragId === null || taskDragId === task.id) return
                    event.preventDefault()
                    event.dataTransfer.dropEffect = 'move'
                    const rect = event.currentTarget.getBoundingClientRect()
                    setTaskDropTarget({ id: task.id, before: event.clientY < rect.top + rect.height / 2 })
                  }}
                  onDrop={(event) => {
                    event.preventDefault()
                    if (taskDragId !== null) {
                      const rect = event.currentTarget.getBoundingClientRect()
                      moveTask(taskDragId, { id: task.id, before: event.clientY < rect.top + rect.height / 2 })
                    }
                    setTaskDragId(null)
                    setTaskDropTarget(null)
                  }}
                  onDragEnd={() => { setTaskDragId(null); setTaskDropTarget(null) }}
                  onClick={() => {
                    if (runActive || editingTaskId === task.id) return
                    setEditingTaskId(task.id)
                  }}
                  role="listitem"
                  data-plan-task=""
                  data-plan-task-id={task.id}
                  data-plan-task-status={task.status}
                  aria-label={t('task.aria', { title: task.title })}
                >
                  {editingTaskId === task.id ? (
                    <TaskEditor
                      task={task}
                      t={t}
                      onCancel={() => { setEditingTaskId(null) }}
                      onSave={async (draft) => {
                        const ok = await updateTask({ id: task.id, ...draft })
                        if (ok) setEditingTaskId(null)
                      }}
                    />
                  ) : (
                    <>
                      <span className={taskStatusClass(task.status)} data-plan-task-badge={task.status}>
                        {taskStatusLabel(t, task.status)}
                      </span>
                      <div className={css.rowBody}>
                        <div className={css.rowTitle}>{task.title}</div>
                        {task.message !== '' && <div className={css.rowNote} data-plan-task-message="">{task.message}</div>}
                        {task.detail !== '' && <div className={css.taskDetail}>{task.detail}</div>}
                        {task.requirement !== '' && (
                          <div className={css.taskDetail} data-plan-task-requirement="">
                            {t('task.requirement.label', { text: task.requirement })}
                          </div>
                        )}
                        {task.requestedFiles.length > 0 && (
                          <div className={css.taskDetail} data-plan-task-files="">
                            {t('task.files.label', { files: task.requestedFiles.join('\u3001') })}
                          </div>
                        )}
                        {task.sessionId === null
                          ? <div className={css.rowDue}>{t('task.no-session')}</div>
                          : (
                            <button
                              type="button"
                              className={css.linkButton}
                              data-plan-task-view=""
                              onClick={(event) => {
                                event.stopPropagation()
                                void openTaskSession(task.id)
                              }}
                            >
                              {t('task.view')}
                            </button>
                          )}
                      </div>
                      {!runActive && (
                        <Button
                          variant="outline"
                          size="sm"
                          data-plan-task-run=""
                          onClick={(event) => {
                            event.stopPropagation()
                            void beginRun(task.planId, task.id)
                          }}
                        >
                          {t('task.run.one')}
                        </Button>
                      )}
                      {!runActive && (
                        <button
                          type="button"
                          className={css.menuButton}
                          aria-label={t('task.menu.aria', { title: task.title })}
                          onClick={(event) => {
                            event.stopPropagation()
                            setTaskMenuId(taskMenuId === task.id ? null : task.id)
                            setDeleteTaskId(null)
                          }}
                        >
                          ⋯                        </button>
                      )}
                    </>
                  )}
                  {taskMenuId === task.id && deleteTaskId !== task.id && (
                    <div className={css.menu} onClick={(event) => { event.stopPropagation() }}>
                      <Button
                        variant="ghost"
                        size="sm"
                        icon={<IconTrashOutlineRegular size={16} />}
                        onClick={() => { setDeleteTaskId(task.id) }}
                      >
                        {t('task.delete')}
                      </Button>
                    </div>
                  )}
                  {deleteTaskId === task.id && (
                    <div className={css.confirm} onClick={(event) => { event.stopPropagation() }}>
                      <span>{t('task.delete.confirm', { title: task.title })}</span>
                      <Button
                        variant="primary"
                        size="sm"
                        onClick={async () => {
                          setDeleteTaskId(null)
                          setTaskMenuId(null)
                          await deleteTask(task.id)
                        }}
                      >
                        {t('delete.confirm.action')}
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => { setDeleteTaskId(null); setTaskMenuId(null) }}>{t('delete.cancel')}</Button>
                    </div>
                  )}
                </div>
              ))}
              {planTasks.length > 0 && !runActive && (
                <div
                  className={css.dropEnd}
                  data-plan-task-drop-end=""
                  onDragOver={(event) => { if (taskDragId !== null) { event.preventDefault(); setTaskDropTarget(null) } }}
                  onDrop={(event) => {
                    event.preventDefault()
                    if (taskDragId !== null) moveTask(taskDragId, null)
                    setTaskDragId(null)
                    setTaskDropTarget(null)
                  }}
                >
                  {t('task.drag.hint')}
                </div>
              )}
            </div>
            {!runActive && showAddTask && (
              <div className={css.addBox}>
                <div className={css.addRow}>
                  <input
                    className={css.addInput}
                    value={addTaskTitle}
                    data-plan-task-add-input=""
                    placeholder={t('task.add.placeholder')}
                    aria-label={t('task.add.placeholder')}
                    onChange={(event) => { setAddTaskTitle(event.target.value); setAddTaskError(false) }}
                    onKeyDown={(event) => { if (event.key === 'Enter') void submitAddTask() }}
                  />
                  <Button variant="primary" size="sm" data-plan-task-add="" onClick={() => { void submitAddTask() }}>{t('task.add.action')}</Button>
                </div>
                {showAddTaskDetail && (
                  <>
                    <textarea
                      className={css.textarea}
                      value={addTaskDetail}
                      placeholder={t('task.add.detail')}
                      aria-label={t('task.add.detail')}
                      rows={2}
                      onChange={(event) => { setAddTaskDetail(event.target.value) }}
                    />
                    <textarea
                      className={css.textarea}
                      value={addTaskRequirement}
                      placeholder={t('task.add.requirement')}
                      aria-label={t('task.add.requirement')}
                      rows={2}
                      onChange={(event) => { setAddTaskRequirement(event.target.value) }}
                    />
                    <textarea
                      className={css.textarea}
                      value={addTaskFiles}
                      placeholder={t('task.add.files')}
                      aria-label={t('task.add.files')}
                      rows={2}
                      onChange={(event) => { setAddTaskFiles(event.target.value) }}
                    />
                  </>
                )}
                <div className={css.addFooter}>
                  <button type="button" className={css.linkButton} onClick={() => { setShowAddTaskDetail(value => !value) }}>
                    {showAddTaskDetail ? t('task.add.hideDetails') : t('task.add.details')}
                  </button>
                  {addTaskError && <span className={css.errorText}>{t('task.add.invalid')}</span>}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )

  return (
    <div className={css.panel} data-plan-panel="" data-plan-board={variant}
      style={{ '--mrw-plan-fraction': planPercent, '--mrw-task-fraction': 100 - planPercent } as CSSProperties}>
      {planSection}
      <div className={css.sectionSplitter} role="separator" tabIndex={0} aria-orientation="horizontal"
        aria-label={t('split.resize')} title={t('split.resize')} aria-valuemin={20} aria-valuemax={80} aria-valuenow={planPercent}
        data-plan-splitter=""
        onPointerDown={(event) => {
          if (event.button === 0) { event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId) }
        }}
        onPointerMove={(event) => {
          if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
          const bounds = event.currentTarget.parentElement?.getBoundingClientRect()
          if (bounds !== undefined) setPlanPercent(Math.max(20, Math.min(80, (event.clientY - bounds.top) / bounds.height * 100)))
        }}
        onPointerUp={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
        }}
        onDoubleClick={() => setPlanPercent(50)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
            event.preventDefault(); setPlanPercent(value => Math.max(20, Math.min(80, value + (event.key === 'ArrowUp' ? -2 : 2))))
          } else if (event.key === 'Home') { event.preventDefault(); setPlanPercent(50) }
        }} />
      {taskSection}
    </div>
  )
}

/**
 * The pending proposal preview with per-change keep toggles.
 * @param props - the proposal, the board revision it was built against, and the apply callbacks.
 * @returns the preview card.
 */
function ProposalCard({ proposal, revision, stale, t, onApply, onDiscard }: {
  readonly proposal: PlanProposal
  readonly revision: number
  readonly stale: boolean
  readonly t: TranslateNS<typeof NS>
  readonly onApply: (proposalId: string, changeIds: readonly string[]) => Promise<boolean>
  readonly onDiscard: (proposalId: string) => Promise<boolean>
}) {
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set(proposal.changes.map(change => change.changeId)))
  const isStale = stale || proposal.baseRevision !== revision
  const toggle = (changeId: string): void => {
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(changeId)) next.delete(changeId)
      else next.add(changeId)
      return next
    })
  }
  const apply = async (): Promise<void> => {
    const ids = proposal.changes.filter(change => selected.has(change.changeId)).map(change => change.changeId)
    if (ids.length === 0) return
    await onApply(proposal.proposalId, ids)
  }
  return (
    <div className={css.proposal} data-plan-proposal="">
      <div className={css.proposalHeader}>
        <span className={css.proposalTitle}>{t('proposal.title')}</span>
        {isStale
          ? <span className={css.warning}>{t('proposal.stale')}</span>
          : <span className={css.proposalIntro}>{t('proposal.intro')}</span>}
      </div>
      <div className={css.proposalList}>
        {proposal.changes.map(change => (
          <label key={change.changeId} className={css.proposalRow} data-plan-change-id={change.changeId}>
            <input
              type="checkbox"
              checked={selected.has(change.changeId)}
              aria-label={t('proposal.change.aria')}
              onChange={() => { toggle(change.changeId) }}
            />
            <span>{describeChange(change, t)}</span>
          </label>
        ))}
      </div>
      <div className={css.proposalActions}>
        {isStale
          ? (
            <Button variant="outline" size="sm" onClick={() => { void onDiscard(proposal.proposalId) }}>
              {t('proposal.stale.action')}
            </Button>
          )
          : (
            <>
              <Button
                variant="primary"
                size="sm"
                disabled={selected.size === 0}
                onClick={() => { void apply() }}
              >
                {t('proposal.apply')}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => { void onDiscard(proposal.proposalId) }}>{t('proposal.cancel')}</Button>
              <button
                type="button"
                className={css.linkButton}
                onClick={() => { setSelected(new Set(proposal.changes.map(change => change.changeId))) }}
              >
                {t('proposal.selectAll')}
              </button>
            </>
          )}
      </div>
    </div>
  )
}

/**
 * Inline editor for one plan.
 * @param props - the plan, copy, and save/cancel callbacks.
 * @returns the editor form.
 */
function PlanEditor({ item, t, onSave, onCancel }: {
  readonly item: PlanItem
  readonly t: TranslateNS<typeof NS>
  readonly onSave: (draft: { title: string; note: string; dueDate: string | null }) => Promise<void>
  readonly onCancel: () => void
}) {
  const [title, setTitle] = useState(item.title)
  const [note, setNote] = useState(item.note)
  const [dueDate, setDueDate] = useState(item.dueDate ?? '')
  const [invalid, setInvalid] = useState(false)
  const invalidRef = useRef(false)
  const save = async (): Promise<void> => {
    if (title.trim() === '') {
      invalidRef.current = true
      setInvalid(true)
      return
    }
    invalidRef.current = false
    setInvalid(false)
    await onSave({ title, note, dueDate: dueDate === '' ? null : dueDate })
  }
  return (
    <div className={css.editor} onClick={(event) => { event.stopPropagation() }} onDragStart={(event) => { event.preventDefault() }}>
      <input
        className={css.input}
        value={title}
        aria-label={t('edit.title')}
        onChange={(event) => { setTitle(event.target.value); if (invalidRef.current) setInvalid(false) }}
        onKeyDown={(event) => { if (event.key === 'Enter') void save() }}
      />
      {invalid && <span className={css.errorText}>{t('edit.invalid')}</span>}
      <textarea
        className={css.textarea}
        value={note}
        rows={2}
        aria-label={t('edit.note')}
        onChange={(event) => { setNote(event.target.value) }}
      />
      <input
        className={css.dateInput}
        type="date"
        value={dueDate}
        aria-label={t('edit.date')}
        onChange={(event) => { setDueDate(event.target.value) }}
      />
      <div className={css.editorActions}>
        <Button variant="primary" size="sm" onClick={() => { void save() }}>{t('edit.save')}</Button>
        <Button variant="ghost" size="sm" onClick={onCancel}>{t('edit.cancel')}</Button>
      </div>
    </div>
  )
}

/**
 * Inline editor for one task.
 * @param props - the task, copy, and save/cancel callbacks.
 * @returns the editor form.
 */
function TaskEditor({ task, t, onSave, onCancel }: {
  readonly task: PlanTask
  readonly t: TranslateNS<typeof NS>
  readonly onSave: (draft: {
    title: string
    detail: string
    requirement: string
    requestedFiles: readonly string[]
  }) => Promise<void>
  readonly onCancel: () => void
}) {
  const [title, setTitle] = useState(task.title)
  const [detail, setDetail] = useState(task.detail)
  const [requirement, setRequirement] = useState(task.requirement)
  const [files, setFiles] = useState(task.requestedFiles.join('\n'))
  const [invalid, setInvalid] = useState(false)
  const save = async (): Promise<void> => {
    if (title.trim() === '') {
      setInvalid(true)
      return
    }
    setInvalid(false)
    await onSave({ title, detail, requirement, requestedFiles: splitLines(files) })
  }
  return (
    <div className={css.editor} onClick={(event) => { event.stopPropagation() }} onDragStart={(event) => { event.preventDefault() }}>
      <input
        className={css.input}
        value={title}
        aria-label={t('task.edit.title')}
        onChange={(event) => { setTitle(event.target.value); setInvalid(false) }}
        onKeyDown={(event) => { if (event.key === 'Enter') void save() }}
      />
      {invalid && <span className={css.errorText}>{t('task.add.invalid')}</span>}
      <textarea
        className={css.textarea}
        value={detail}
        rows={3}
        aria-label={t('task.edit.detail')}
        placeholder={t('task.detail.missing')}
        onChange={(event) => { setDetail(event.target.value) }}
      />
      <textarea
        className={css.textarea}
        value={requirement}
        rows={2}
        aria-label={t('task.edit.requirement')}
        placeholder={t('task.add.requirement')}
        onChange={(event) => { setRequirement(event.target.value) }}
      />
      <textarea
        className={css.textarea}
        value={files}
        rows={2}
        aria-label={t('task.edit.files')}
        placeholder={t('task.add.files')}
        onChange={(event) => { setFiles(event.target.value) }}
      />
      <div className={css.editorActions}>
        <Button variant="primary" size="sm" onClick={() => { void save() }}>{t('edit.save')}</Button>
        <Button variant="ghost" size="sm" onClick={onCancel}>{t('edit.cancel')}</Button>
      </div>
    </div>
  )
}

/**
 * Split one line-per-item editor value into trimmed, non-empty entries.
 * @param text - raw textarea value.
 * @returns the entries in typed order.
 */
function splitLines(text: string): readonly string[] {
  return text.split(/\r?\n/u).map(line => line.trim()).filter(line => line !== '')
}

/**
 * Localized label for one plan status.
 * @param t - namespace-bound translate.
 * @param status - status to label.
 * @returns the localized label.
 */
function statusLabel(t: TranslateNS<typeof NS>, status: PlanItemStatus): string {
  switch (status) {
    case 'todo': return t('status.todo')
    case 'in_progress': return t('status.in_progress')
    case 'done': return t('status.done')
  }
}

/**
 * Localized label for one task status.
 * @param t - namespace-bound translate.
 * @param status - task status to label.
 * @returns the localized label.
 */
function taskStatusLabel(t: TranslateNS<typeof NS>, status: PlanTaskStatus): string {
  switch (status) {
    case 'pending': return t('task.status.pending')
    case 'running': return t('task.status.running')
    case 'needs_user': return t('task.status.needs_user')
    case 'done': return t('task.status.done')
    case 'stopped': return t('task.status.stopped')
    case 'failed': return t('task.status.failed')
  }
}

/**
 * Status badge class for one task status.
 * @param status - task status.
 * @returns the CSS-module class names.
 */
function taskStatusClass(status: PlanTaskStatus): string {
  switch (status) {
    case 'pending': return css.taskBadge ?? ''
    case 'running': return `${css.taskBadge} ${css.taskBadgeRunning}`
    case 'needs_user': return `${css.taskBadge} ${css.taskBadgeNeedsUser}`
    case 'done': return `${css.taskBadge} ${css.taskBadgeDone}`
    case 'stopped': return `${css.taskBadge} ${css.taskBadgeStopped}`
    case 'failed': return `${css.taskBadge} ${css.taskBadgeFailed}`
  }
}

/**
 * One-line localized description of a proposal change.
 * @param change - the change to describe.
 * @param t - namespace-bound translate.
 * @returns the description.
 */
function describeChange(change: PlanProposalChange, t: TranslateNS<typeof NS>): string {
  switch (change.kind) {
    case 'add':
      return t('proposal.add', { title: change.after?.title ?? '' })
    case 'edit': {
      const fields: string[] = []
      if (change.before?.title !== change.after?.title) fields.push(t('field.title'))
      if (change.before?.note !== change.after?.note) fields.push(t('field.note'))
      if (change.before?.dueDate !== change.after?.dueDate) fields.push(t('field.dueDate'))
      return t('proposal.edit', { before: change.before?.title ?? '', after: change.after?.title ?? '' })
        + (fields.length === 0 ? '' : t('proposal.edit.fields', { fields: fields.join('\u3001') }))
    }
    case 'delete':
      return t('proposal.delete', { title: change.before?.title ?? '' })
    case 'status':
      return t('proposal.status', {
        title: change.itemId ?? '',
        before: statusLabel(t, change.beforeStatus ?? 'todo'),
        after: statusLabel(t, change.afterStatus ?? 'todo'),
      })
    case 'reorder':
      return t('proposal.reorder', { count: String(change.afterOrder?.length ?? 0) })
    case 'task-add':
      return t('proposal.task.add', { title: change.taskAfter?.title ?? '' })
    case 'task-edit': {
      const fields: string[] = []
      if (change.taskBefore?.title !== change.taskAfter?.title) fields.push(t('field.title'))
      if (change.taskBefore?.detail !== change.taskAfter?.detail) fields.push(t('field.detail'))
      return t('proposal.task.edit', { before: change.taskBefore?.title ?? '', after: change.taskAfter?.title ?? '' })
        + (fields.length === 0 ? '' : t('proposal.edit.fields', { fields: fields.join('\u3001') }))
    }
    case 'task-delete':
      return t('proposal.task.delete', { title: change.taskBefore?.title ?? '' })
    case 'task-reorder':
      return t('proposal.task.reorder', { count: String(change.afterTaskOrder?.length ?? 0) })
    default:
      return ''
  }
}

/** Re-exported for the surfaces that only need the plan run state type. */
export type { PlanRun }
