/** Resident conversation beside a retractable writing or code panel. */
import { AssetRecoveryDetails } from './AssetImport.tsx'
import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react'
import clsx from 'clsx'
import { Modal, Menu, IconNewChatOutlineRegular, IconEditOutlineRegular, IconCodeOutlineRegular, IconChevronDownOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRenderFactories, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-terminal/client'
import { activeBuffer, activePane } from './editor-state.ts'
import { WordPageEditor } from './WordPageEditor.tsx'
import { CodeEditor } from './CodeEditor.tsx'
import { VisualEditor } from './VisualEditor.tsx'
import { DevelopmentLanguageControl, RunArtifacts, developmentLanguage } from './DevelopmentControls.tsx'
import type { DevelopmentLanguage } from './DevelopmentControls.tsx'
import { Proposal } from './Proposal.tsx'
import { PdfPreview } from './PdfPreview.tsx'
import type { WorkbenchInjected, RunRequest, EditorBuffer } from './types.ts'
import type { QuickLearningStatus } from '@deepseek-ai/dsh-workbench-assistant/types'
import type { WorkbenchKey } from './locales.ts'
import css from './Workbench.module.css'
import { usePanelMotion } from './panel-motion.ts'

export type WorkbenchProps = PropsRuntime<'conversation.workspace'> & PropsRenderFactories & InjectFace<WorkbenchInjected> & PropsLocale<'workbench'>
export type WorkViewControlProps = PropsRuntime<'conversation.workview.control'> & InjectFace<WorkbenchInjected> & PropsLocale<'workbench'>
export type SelectionCardProps = PropsRuntime<'conversation.workview.selection'> & InjectFace<WorkbenchInjected> & PropsLocale<'workbench'>

function basename(path: string) { return path.split(/[\\/]/).at(-1) ?? path }
function parentPath(path: string) { const parts = path.replaceAll('\\', '/').split('/').filter(part => part !== '.'); parts.pop(); return parts.join('/') || '.' }
function childPath(parent: string, name: string) { return parent === '.' || parent === '' ? name : `${parent.replace(/[\\/]$/, '')}/${name}` }
function saveLabel(file: EditorBuffer | undefined, t: (key: WorkbenchKey) => string) {
  if (file?.kind === 'word') {
    if (file.saveState === 'error' || file.saveState === 'conflict') return t('saveFailed')
    if (file.saveState === 'saving') return t('saving')
    if (file.pendingWord !== undefined || file.wordSync === 'syncing') return t('wordDraftSaved')
    return t(file.revision === file.word.savedRevision ? 'wordSaved' : 'wordDraftSaved')
  }
  if (file === undefined || file.saveState === 'clean') return ''
  if (file.saveState === 'saving') return t('saving')
  if (file.saveState === 'error' || file.saveState === 'conflict') return t('saveFailed')
  return t('unsaved')
}

/** Work-view selector is available in both blank and active conversations. */
export function WorkViewControl({ useWorkbench, setMode, setFocus, retryRecovery, t }: WorkViewControlProps) {
  const mode = useWorkbench(state => state.mode)
  const focus = useWorkbench(state => state.focus)
  const recoveryError = useWorkbench(state => state.recoveryError)
  const buffers = useWorkbench(state => state.buffers)
  const [open, setOpen] = useState(false)
  const Icon = mode === 'writing' ? IconEditOutlineRegular : mode === 'development' ? IconCodeOutlineRegular : IconNewChatOutlineRegular
  return <div className={css.modeControl} data-workbench-mode-selector="">
    <Menu open={open} onClose={() => setOpen(false)} selectedId={mode} align="start" portal
      items={(['chat', 'writing', 'development'] as const).map(view => ({ id: view, label: t(view) }))}
      onSelect={(view) => {
        if (view === 'chat' || view === 'writing' || view === 'development') {
          setMode(view); setFocus(view === 'chat' ? 'chat' : 'editor')
        }
        setOpen(false)
      }}
      anchor={<button type="button" className={css.modeButton} aria-label={t('view')} aria-haspopup="menu" aria-expanded={open}
        onClick={() => setOpen(value => !value)}
        onKeyDown={(event) => { if (!open && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) { event.preventDefault(); setOpen(true) } }}>
        <Icon className={css.modeIcon} /><span className={css.modeLabel}>{t(mode)}</span>
        <IconChevronDownOutlineRegular className={css.modeChevron} />
      </button>} />
    {(mode === 'chat' || focus === 'chat') && (['writing', 'development'] as const)
      .filter(view => Object.values(buffers).some(file => file.mode === view))
      .map(view => <button key={view} type="button" className={css.resumeButton}
        onClick={() => { setMode(view); setFocus('editor') }}>{t(view === 'writing' ? 'resumeWriting' : 'resumeDevelopment')}</button>)}
    {recoveryError !== null && <span role="alert"><button type="button" className={css.quietButton}
      title={recoveryError} aria-label={recoveryError} onClick={() => { void retryRecovery() }}>{t('retryRecovery')}</button></span>}
  </div>
}

/** A compact attached reference scopes the single main conversation input. */
export function SelectionCard({ useWorkbench, t, clearSelection, locateSelection }: SelectionCardProps) {
  const selection = useWorkbench(state => state.selection)
  if (selection === null) return null
  return <section className={css.selectionReference} aria-label={t('selection')} data-workbench-selection="">
    <details className={css.selectionDetails}>
      <summary><strong>{t('assistSelection')}</strong> · {basename(selection.path)} · {selection.selectedText.length} {t('selectionCount')}</summary>
      <pre>{selection.selectedText}</pre>
    </details>
    <button type="button" className={css.quietButton} onClick={locateSelection}>{t('locate')}</button>
    <button type="button" className={css.iconButton} aria-label={t('clearSelection')} onClick={clearSelection}>×</button>
  </section>
}

/** Keep the same conversation mounted beside the active writing or code panel. */
export function Workbench(props: WorkbenchProps) {
  const { useWorkbench, t, renderFactorySlot, phase, hero, sessionId } = props
  const state = useWorkbench(value => value)
  const file = activeBuffer(state)
  const pane = activePane(state)
  const files = Object.values(state.buffers).filter(buffer => buffer.mode === state.mode)
  const [chatPercent, setChatPercent] = useState(40)
  const motion = usePanelMotion()
  const [immersiveRequested, setImmersive] = useState(false)
  const immersive = immersiveRequested && state.mode !== 'chat' && state.focus === 'editor'
  useEffect(() => {
    if (!immersive) return
    // Fullscreen transitions can publish an older windowed state before the
    // enter acknowledgement. Only a subsequent leave exits this layout.
    let enteredFullscreen = document.documentElement.dataset.fullscreen === 'true'
    const exit = (event: Event) => {
      if (!(event instanceof CustomEvent)) return
      if (event.detail === true) enteredFullscreen = true
      else if (event.detail === false && enteredFullscreen) setImmersive(false)
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented && motion.editor.current?.dataset.dragging !== 'true') setImmersive(false)
    }
    window.addEventListener('mrw:fullscreen-change', exit)
    window.addEventListener('keydown', escape)
    window.dispatchEvent(new CustomEvent('mrw:immersive', { detail: true }))
    return () => {
      window.removeEventListener('mrw:fullscreen-change', exit)
      window.removeEventListener('keydown', escape)
      window.dispatchEvent(new CustomEvent('mrw:immersive', { detail: false }))
    }
  }, [immersive])
  const [viewMenuOpen, setViewMenuOpen] = useState(false)
  const [fileMenuOpen, setFileMenuOpen] = useState(false)
  const [wordOutline, setWordOutline] = useState(false)
  const [pathInput, setPathInput] = useState('')
  const [creating, setCreating] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [actionsOpen, setActionsOpen] = useState(false)
  const [learning, setLearning] = useState<QuickLearningStatus | null>(null)
  const [learningError, setLearningError] = useState('')
  const [learningBusy, setLearningBusy] = useState(false)
  const updateLearning = async (action: 'inspect' | 'pause' | 'resume' | 'clear') => {
    setLearningBusy(true); setLearningError('')
    try { setLearning(await props.learning(action)) }
    catch (error) { setLearningError(error instanceof Error ? error.message : String(error)) }
    finally { setLearningBusy(false) }
  }
  const [detailedProposal, setDetailedProposal] = useState<string | null>(null)
  const proposalPercent = state.proposalHeight ?? 32
  const setProposalPercent = (value: number | ((previous: number) => number)) => props.setProposalHeight(typeof value === 'number' ? value : value(proposalPercent))
  const [codePalette, setCodePalette] = useState<'auto' | 'vscode' | 'scientific'>('auto')
  const [paletteMenuOpen, setPaletteMenuOpen] = useState(false)
  const [recipe, setRecipe] = useState<NonNullable<RunRequest['recipe']>>('auto')
  const [editorCommand, setEditorCommand] = useState<{ type: 'undo' | 'redo' | 'find'; token: number; path: string; revision: number; surface: 'source' | 'visual' } | null>(null)
  const [languageOverrides, setLanguageOverrides] = useState<Record<string, DevelopmentLanguage>>({})
  const [terminalOpen, setTerminalOpen] = useState(false)
  const visualEdit = useCallback<WorkbenchInjected['edit']>((path, text, selection, editorState, scrollTop) => {
    props.edit(path, text, selection, editorState, scrollTop, 'visual')
  }, [props.edit])
  const save = useCallback(() => { void props.save().catch(() => undefined) }, [props.save])
  const include = useCallback((path: string) => {
    if (file === undefined) return
    const target = /(?:^|[\\/])[^./\\]+$/u.test(path) ? path + '.tex' : path
    void props.open(/^(?:[a-z]:[\\/]|\/)/iu.test(target) ? target : childPath(parentPath(file.path), target))
  }, [file?.path, props.open])
  const mathFontsDirectory = useMemo(() => new URL('workbench/mathlive/fonts', document.baseURI).href, [])
  const isWord = file?.kind === 'word'
  useEffect(() => {
    if (file?.kind === 'word' && file.word.engine !== 'ooxml' && (pane === 'pdf' || state.pdf?.sourcePath !== file.path) && !state.restoring && !file.unavailable
      && file.pendingWord === undefined && file.wordSync === 'idle') void props.refreshPdf(true)
  }, [file?.absolutePath, file?.revision, file?.unavailable,
    file?.kind === 'word' ? file.wordSync : undefined,
    file?.kind === 'word' ? file.pendingWord : undefined, pane, state.restoring, props.refreshPdf])
  const isLatex = file !== undefined && /\.tex$/iu.test(file.path)
  const language = file === undefined ? 'text' : languageOverrides[file.absolutePath] ?? developmentLanguage(file.path)
  const issueCommand = (type: 'undo' | 'redo' | 'find') => {
    if (file === undefined) return
    if (file.kind === 'word' && (type === 'undo' || type === 'redo')) { void props.wordMutate(file.path, { kind: type }); return }
    const surface = state.mode === 'writing' && (isLatex || isWord) && pane !== 'source' ? 'visual' : 'source'
    if (pane === 'pdf') props.setPane(surface)
    setEditorCommand({ type, token: Date.now(), path: file.path, revision: file.revision, surface })
  }
  const command = editorCommand?.path === file?.path && editorCommand?.revision === file?.revision ? editorCommand : null
  const [diskComparison, setDiskComparison] = useState<{ session: string | undefined; path: string; version: string } | null>(null)
  const [reloadConfirmation, setReloadConfirmation] = useState<{
    session: string | undefined
    path: string
    version: string
    revision: number
  } | null>(null)
  const external = file?.external
  const externalVersion = external?.version
  const compareDisk = file !== undefined && externalVersion !== undefined && diskComparison !== null
    && diskComparison.session === sessionId && diskComparison.path === file.path && diskComparison.version === externalVersion
  const confirmReload = file !== undefined && externalVersion !== undefined && compareDisk && reloadConfirmation !== null
    && reloadConfirmation.session === sessionId && reloadConfirmation.path === file.path
    && reloadConfirmation.version === externalVersion && reloadConfirmation.revision === file.revision
  const content = useMemo(() => renderFactorySlot('conversation.content', { variant: 'embedded', phase, hero }), [renderFactorySlot, phase, hero])
  const proposal = state.action?.proposal?.base.path === file?.path ? state.action?.proposal : undefined
  const showingDetails = proposal !== undefined && detailedProposal === state.action?.actionId
  const palette = state.mode !== 'development' ? undefined : codePalette !== 'auto' ? codePalette
    : language === 'matlab' ? 'scientific' : language === 'text' ? undefined : 'vscode'
  const proposalFile = proposal === undefined ? undefined : state.buffers[proposal.base.path]
  const stale = proposal !== undefined && (proposalFile === undefined || proposalFile.saveState === 'conflict'
    || String(proposalFile.revision) !== proposal.base.bufferVersion
    || proposalFile.text.slice(proposal.base.from, proposal.base.to) !== proposal.base.selectedText
    || proposalFile.kind === 'word' && (proposalFile.pendingWord !== undefined || proposalFile.wordSync !== 'idle'))
  const selected = file !== undefined && file.selection.from !== file.selection.to
  const running = isWord ? state.wordProofBusy != null : state.job?.state === 'running'
  const pdfRoot = state.pdf === null ? undefined : state.buffers[state.pdf.sourcePath]
  const pdfStale = state.pdfDirty || state.pdf?.stale === true || (pdfRoot !== undefined
    && (pdfRoot.kind === 'word' ? String(pdfRoot.revision) !== state.pdf?.sourceVersion || pdfRoot.pendingWord !== undefined
      : pdfRoot.text !== pdfRoot.savedText || pdfRoot.diskVersion !== state.pdf?.sourceVersion))
  const requestRun = () => {
    if (isWord) { void props.save(); return }
    if (file !== undefined) void props.run({ kind: 'latex', path: state.mainFile.trim() || file.path, recipe })
  }
  const browserOpen = state.mode !== 'chat' && state.browserOpen
  const writing = state.mode === 'writing'
  const panelActions = [
    ...(writing ? [
      { id: 'save', label: t('save'), disabled: file === undefined },
      ...(isWord ? [{ id: 'saveAs', label: t('saveAs') }] : []),
      { id: 'search', label: t('search'), disabled: file === undefined },
      { id: 'undo', label: t('undo'), disabled: file === undefined },
      { id: 'redo', label: t('redo'), disabled: file === undefined },
      ...(isLatex ? [{ id: 'source', label: t('advancedSource') }] : []),
      { id: 'locatePdf', label: t('sourceToPdf'), disabled: file === undefined },
    ] : [{ id: 'terminal', label: t('terminal') }]),
    ...(writing && (!isLatex || pane === 'source') ? [
      { id: 'assist', label: t('assistSelection'), disabled: !selected },
    ] : []),
    ...(isWord ? [{ id: 'outline', label: t('wordOutlineToggle') }] : []),
    { id: 'move-left', label: t('movePanelLeft'), disabled: motion.side === 'left' },
    { id: 'move-right', label: t('movePanelRight'), disabled: motion.side === 'right' },
    { id: 'close-file', label: t('closeFile'), disabled: file === undefined },
    { id: 'display', label: t('displaySettings') },
    { id: 'learning', label: t('quickLearning') },
  ]
  const panelAction = (id: string) => {
    setActionsOpen(false)
    if (id === 'move-left' || id === 'move-right') motion.place(id === 'move-left' ? 'left' : 'right')
    else if (id === 'outline') setWordOutline(!wordOutline)
    else if (id === 'close-file' && file !== undefined) props.close(file.path)
    else if (id === 'files') { setSettingsOpen(false); props.setBrowserOpen(!browserOpen) }
    else if (id === 'save') save()
    else if (id === 'saveAs') { setSettingsOpen(true); props.setBrowserOpen(false) }
    else if (id === 'search') issueCommand('find')
    else if (id === 'undo' || id === 'redo') issueCommand(id)
    else if (id === 'source') props.setPane('source')
    else if (id === 'locatePdf') void props.locatePdf()
    else if (id === 'terminal') setTerminalOpen(!terminalOpen)
    else if (id === 'assist') props.select('assist')
    else if (id === 'display') { props.setBrowserOpen(false); setSettingsOpen(!settingsOpen) }
    else if (id === 'learning') void updateLearning('inspect')
  }

  return <div className={css.workbench} data-workbench="" data-mode={state.mode} data-focus={state.focus} data-immersive={immersive || undefined}>
    <Modal open={learning !== null || learningBusy || learningError !== ''} title={t('quickLearning')} closeLabel={t('cancel')}
      description={t('quickLearningInfo')} onClose={() => { if (!learningBusy) { setLearning(null); setLearningError('') } }}>
      {learning && <>
        <p>{t('quickLearningCounts').replace('{active}', String(learning.active)).replace('{candidates}', String(learning.candidates)).replace('{stopped}', String(learning.stopped))}</p>
        <button type="button" className={css.quietButton} disabled={learningBusy} onClick={() => { void updateLearning(learning.enabled ? 'pause' : 'resume') }}>{t(learning.enabled ? 'quickLearningPause' : 'quickLearningResume')}</button>
        <button type="button" className={css.quietButton} disabled={learningBusy} onClick={() => { void updateLearning('clear') }}>{t('quickLearningClear')}</button>
      </>}
      {learningError && <p className={css.errorText} role="alert">{learningError}</p>}
    </Modal>
    <Modal open={state.closePrompt != null} title={t('closeQuestion')} closeLabel={t('cancel')}
      description={t('closeExplanation')} onClose={() => { if (!state.closeBusy && state.closePrompt) props.close(state.closePrompt, 'cancel') }}
      footer={<>
        <button type="button" className={css.quietButton} disabled={state.closeBusy} data-modal-autofocus onClick={() => { if (state.closePrompt) props.close(state.closePrompt, 'cancel') }}>{t('cancel')}</button>
        <button type="button" className={css.quietButton} disabled={state.closeBusy} onClick={() => { if (state.closePrompt) props.close(state.closePrompt, 'discard') }}>{t('closeDiscard')}</button>
        <button type="button" className={css.quietButton} disabled={state.closeBusy} onClick={() => { if (state.closePrompt) props.close(state.closePrompt, 'save') }}>{state.closeBusy ? t('saving') : t('save')}</button>
      </>}>
      <p>{state.closePrompt}</p>
      {state.error && <p className={css.errorText} role="alert">{state.error}</p>}
    </Modal>
    <div className={css.compactSwitch}>
      <button type="button" className={css.quietButton} aria-pressed={state.focus === 'chat'} onClick={() => props.setFocus('chat')}>{t('chat')}</button>
      <button type="button" className={css.quietButton} aria-pressed={state.focus === 'editor'} onClick={() => props.setFocus('editor')}>{t(writing ? 'writing' : 'development')}</button>
    </div>
    <div ref={motion.stage} className={css.stage} data-editor-side={motion.side} style={{ '--mrw-chat-width': `${chatPercent}%` } as CSSProperties}>
      <div ref={motion.chat} className={css.chat} data-workbench-chat="">{content}</div>
      <div className={css.splitter} role="separator" tabIndex={0} aria-label={t('resizeWorkspace')}
        aria-orientation="vertical" aria-valuemin={25} aria-valuemax={60} aria-valuenow={chatPercent}
        title={t('resizeWorkspace')} data-workbench-splitter=""
        onPointerDown={(event) => {
          if (event.button === 0) { event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId) }
        }}
        onPointerMove={(event) => {
          if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
          const bounds = event.currentTarget.parentElement?.getBoundingClientRect()
          if (bounds !== undefined) setChatPercent(Math.max(25, Math.min(60, (motion.side === 'right' ? event.clientX - bounds.left : bounds.right - event.clientX) / bounds.width * 100)))
        }}
        onPointerUp={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
        }}
        onDoubleClick={() => setChatPercent(40)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
            event.preventDefault(); setChatPercent(value => Math.max(25, Math.min(60, value + (event.key === 'ArrowLeft' ? -2 : 2) * (motion.side === 'right' ? 1 : -1))))
          } else if (event.key === 'Home') { event.preventDefault(); setChatPercent(40) }
        }} />
      <section ref={motion.editor} className={css.editor} aria-label={writing ? t('writing') : t('development')}
        data-workbench-editor="" data-workbench-code-theme={palette} data-reviewing={showingDetails ? 'true' : undefined} style={{ '--mrw-proposal-height': `${proposalPercent}%` } as CSSProperties}
        onKeyDown={(event) => {
          if (event.defaultPrevented) return
          if (isWord && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
            event.preventDefault(); save()
          } else if (writing && (event.ctrlKey || event.metaKey) && event.altKey && event.key.toLowerCase() === 'b') {
            event.preventDefault(); requestRun()
          }
        }}>
        <header className={css.editorHeader} onPointerDown={motion.start} title={t('dragPanel')} data-workbench-drag-handle="">
          <Menu open={viewMenuOpen} onClose={() => setViewMenuOpen(false)} align="start" portal
            items={[{ id: 'immersive', label: t(immersive ? 'exitImmersive' : 'enterImmersive') }]}
            onSelect={() => { setImmersive(!immersive); setViewMenuOpen(false) }}
            anchor={<button type="button" className={css.panelModeButton} aria-label={t('panelView')}
              title={t('panelView')} aria-haspopup="menu" aria-expanded={viewMenuOpen} data-workbench-view=""
              onClick={() => setViewMenuOpen(!viewMenuOpen)}>
              {writing ? <IconEditOutlineRegular className={css.modeIcon} /> : <IconCodeOutlineRegular className={css.modeIcon} />}
            </button>} />
          <div className={css.editorHeading}>
            {writing ? <strong>{t('writing')}</strong>
              : <DevelopmentLanguageControl language={language}
                onLanguage={(value) => {
                  if (file !== undefined) setLanguageOverrides(previous => ({ ...previous, [file.absolutePath]: value }))
                }} t={t} />}
            {immersive && file !== undefined && <Menu open={fileMenuOpen} onClose={() => setFileMenuOpen(false)}
              selectedId={file.path} align="start" portal
              items={files.map(buffer => ({ id: buffer.path, label: basename(buffer.path) }))}
              onSelect={(path) => { void props.open(path); setFileMenuOpen(false) }}
              anchor={<button type="button" className={css.compactFile} title={file.path} aria-label={t('switchFile')}
                aria-haspopup="menu" aria-expanded={fileMenuOpen} disabled={files.length < 2}
                onClick={() => setFileMenuOpen(!fileMenuOpen)}><span>{basename(file.path)}</span>
                {files.length > 1 && <IconChevronDownOutlineRegular className={css.modeChevron} />}
              </button>} />}
            <span className={css.saveState} role="status" title={saveLabel(file, t)}>{saveLabel(file, t)}</span>
          </div>
          {writing && !isWord && file !== undefined && <div className={css.paneTabs} aria-label={t('view')}>
            <button type="button" className={css.quietButton} aria-pressed={pane === (isLatex ? 'visual' : 'source')}
              onClick={() => props.setPane(isLatex ? 'visual' : 'source')}>{t(isLatex ? 'visual' : 'source')}</button>
            <button type="button" className={css.quietButton} aria-pressed={pane === 'pdf'}
              onClick={() => props.setPane('pdf')}>{t('pdf')}</button>
          </div>}
          {writing && !isWord && file !== undefined && (running
            ? <button type="button" className={css.button} onClick={() => { void props.stop() }}>{t('stop')}</button>
            : <button type="button" className={css.primaryButton} disabled={state.restoring}
              title={t('compileShortcut')} onClick={requestRun}>{t('compile')}</button>)}
          <button type="button" className={css.quietButton} aria-expanded={browserOpen}
            onClick={() => panelAction('files')}>{t('files')}</button>
          {selected && (!writing || file?.kind === 'word') && <button type="button" className={css.quietButton}
            onClick={() => props.select('assist')}>{t('assistSelection')}</button>}
          <Menu open={actionsOpen} onClose={() => setActionsOpen(false)} items={panelActions} onSelect={panelAction}
            align="end" portal anchor={<button type="button" className={css.quietButton} aria-label={t('advanced')}
              aria-haspopup="menu" aria-expanded={actionsOpen} onClick={() => setActionsOpen(!actionsOpen)}>
              {t('advanced')}<IconChevronDownOutlineRegular className={css.modeChevron} />
            </button>} />
          {!immersive && <button type="button" className={css.quietButton} onClick={() => props.setFocus('chat')}
            data-workbench-collapse="">{t('collapseWorkspace')}</button>}
        </header>
        {state.recoveryError !== null && <div className={css.errorBanner} role="alert"><span>{state.recoveryError}</span>
          <button type="button" className={css.button} onClick={() => { void props.retryRecovery() }}>{t('retryRecovery')}</button></div>}
        <AssetRecoveryDetails history={state.assetRecovery} t={t} />
        {state.error !== null && !browserOpen && <div className={css.errorBanner} role="alert"><span>{state.error}</span><button className={css.iconButton} type="button" aria-label={t('dismiss')} onClick={props.clearError}>×</button></div>}
        {browserOpen && <section className={css.fileBrowser} aria-label={t('files')}>
          <div className={css.filePathRow}>
            <strong>{t('files')}</strong><span className={css.spacer} />
            <button type="button" className={css.quietButton} onClick={() => props.setBrowserOpen(false)}>{t('close')}</button>
          </div>
          {state.error !== null && <div className={css.errorBanner} role="alert"><span>{state.error}</span>
            <button className={css.iconButton} type="button" aria-label={t('dismiss')} onClick={props.clearError}>×</button></div>}
          <div className={css.filePathRow}>
            <button type="button" className={css.button} disabled={state.browserPath === '.'}
              onClick={() => { void props.list(parentPath(state.browserPath)) }}>{t('back')}</button>
            <span className={css.pathLabel} title={state.browserPath}>{state.browserPath}</span>
            <button type="button" className={css.quietButton}
              onClick={() => { void props.list(state.browserPath) }}>{t('refresh')}</button>
            <button type="button" className={css.button} onClick={() => setCreating(!creating)}>{t('newFile')}</button>
          </div>
          <form className={css.openPath} onSubmit={(event) => {
            event.preventDefault()
            if (pathInput.trim() !== '') { if (creating) void props.create(pathInput.trim()); else void props.open(pathInput.trim()) }
          }}>
            <input value={pathInput} onChange={event => setPathInput(event.target.value)}
              aria-label={t('filePath')} placeholder={t('filePath')} />
            <button type="submit" className={css.button} disabled={pathInput.trim() === ''}>{creating ? t('create') : t('open')}</button>
          </form>
          <div className={css.fileList}>
            {state.filesLoading ? <p className={css.hint}>{t('loading')}</p> : state.entries.length === 0
              ? <p className={css.hint}>{t('emptyFolder')}</p>
              : state.entries.map(entry => <button type="button" className={css.fileEntry} key={entry.name} onClick={() => {
                const path = childPath(state.browserPath, entry.name)
                if (entry.type === 'directory') void props.list(path)
                else void props.open(path)
              }}><span aria-hidden="true">{entry.type === 'directory' ? '▸' : '·'}</span><span>{entry.name}</span></button>)}
          </div>
        </section>}
        {settingsOpen && <section className={css.settings} aria-label={t('displaySettings')}>
          <button type="button" className={css.quietButton} onClick={() => setSettingsOpen(false)}>{t('close')}</button>
          <label>{t('font')}<input type="number" min={12} max={28} value={state.mode === 'development' ? state.codeFontSize : state.fontSize} onChange={event => props.setFontSize(Number(event.target.value) || 16)} /></label>
          {state.mode === 'writing' && <button type="button" className={css.quietButton}
            onClick={() => { void props.inspectAssetRecovery() }}>{t('assetWriteHistory')}</button>}
          <label className={css.checkLabel}><input type="checkbox" checked={state.wrap} onChange={event => props.setWrap(event.target.checked)} />{t('wrap')}</label>
          {state.mode === 'development' && <Menu open={paletteMenuOpen} onClose={() => setPaletteMenuOpen(false)}
            selectedId={codePalette} align="start" portal
            items={(['auto', 'vscode', 'scientific'] as const).map(id => ({ id, label: t(id === 'auto' ? 'paletteAuto' : id === 'vscode' ? 'paletteVscode' : 'paletteScientific') }))}
            onSelect={(id) => { if (id === 'auto' || id === 'vscode' || id === 'scientific') setCodePalette(id); setPaletteMenuOpen(false) }}
            anchor={<button type="button" className={css.button} aria-haspopup="menu" aria-expanded={paletteMenuOpen}
              onClick={() => setPaletteMenuOpen(!paletteMenuOpen)}>{t('codePalette')} · {t(codePalette === 'auto' ? 'paletteAuto' : codePalette === 'vscode' ? 'paletteVscode' : 'paletteScientific')}</button>} />}
          {state.mode === 'writing' && isWord && <form className={css.openPath} onSubmit={(event) => { event.preventDefault(); if (pathInput.trim()) void props.saveAs(pathInput.trim()) }}>
            <input aria-label={t('filePath')} placeholder={t('filePath')} value={pathInput} onChange={event => setPathInput(event.target.value)} />
            <button type="submit" className={css.button} disabled={!pathInput.trim()}>{t('saveAs')}</button>
          </form>}
          {state.mode === 'writing' && !isWord ? <>
            <label className={css.wideField}>{t('mainFile')}<input value={state.mainFile} onChange={event => props.setMainFile(event.target.value)} placeholder={file?.path ?? ''} title={t('mainFileHint')} /></label>
            <fieldset className={css.recipe}><legend>{t('compileRecipe')}</legend>{(['auto', 'latexmk', 'pdflatex', 'xelatex', 'lualatex'] as const).map(value => <button type="button" key={value} className={css.button} aria-pressed={recipe === value} onClick={() => setRecipe(value)}>{value === 'auto' ? t('automatic') : value}</button>)}</fieldset>
            {isLatex && <button type="button" className={css.button} onClick={() => { props.setPane('source'); setSettingsOpen(false) }}>{t('advancedSource')}</button>}
          </> : null}
        </section>}
        {!immersive && files.length > 0 && <div className={css.fileTabs} role="tablist" aria-label={t('files')}>{files.map(buffer => <div key={buffer.path} className={clsx(css.fileTab, buffer.path === file?.path && css.activeFile)}>
          <button type="button" role="tab" aria-selected={buffer.path === file?.path} title={buffer.path} onClick={() => { void props.open(buffer.path) }}><span className={css.fileName}>{basename(buffer.path)}</span>{(buffer.kind === 'word' ? buffer.revision !== buffer.word.savedRevision || buffer.pendingWord !== undefined : buffer.text !== buffer.savedText) && <span className={css.fileDirty} aria-label={t('unsaved')}>•</span>}</button>
          <button type="button" className={css.tabClose} aria-label={`${t('close')} ${basename(buffer.path)}`} onClick={() => props.close(buffer.path)}>×</button>
        </div>)}</div>}
        {state.restoring ? <div className={css.empty}><p>{t('loading')}</p></div> : file === undefined ? <div className={css.empty}>
          <h2>{t('chooseFile')}</h2><p>{t(writing ? 'writingConversationHint' : 'developmentConversationHint')}</p>
          {sessionId === undefined && <p className={css.hint}>{t('needWorkspace')}</p>}
          <button type="button" className={css.button} disabled={sessionId === undefined}
            onClick={() => props.setBrowserOpen(true)}>{t('openFile')}</button>
        </div> : <>
          {(file.saveState === 'conflict' || file.saveState === 'error') && <div className={css.errorBanner} role="alert">
            <span>{file.kind === 'word' ? t(file.word.originalStatus === 'conflict' ? 'wordOriginalConflict'
              : file.word.originalStatus === 'unavailable' ? 'wordOriginalUnavailable' : 'wordSaveFailure') : file.error ?? t('conflict')}</span>
            {file.kind === 'word' && <>
              <button type="button" className={css.button} onClick={() => { void props.save(file.path).catch(() => undefined) }}>{t('save')}</button>
              <button type="button" className={css.button} onClick={() => setSettingsOpen(true)}>{t('saveAs')}</button>
            </>}
            {file.unavailable && <button type="button" className={css.button} onClick={() => { void props.retryRecovery() }}>{t('retryRecovery')}</button>}
            {external !== undefined && <button type="button" className={css.button} onClick={() => {
              setDiskComparison(compareDisk ? null : { session: sessionId, path: file.path, version: external.version })
              setReloadConfirmation(null)
            }}>{t('compareDisk')}</button>}
          </div>}
          {compareDisk && external !== undefined && <section className={css.externalCompare}>
            <strong>{t('diskVersion')}</strong><pre>{external.text}</pre>
            {confirmReload && <p>{t('replaceWithDisk')}</p>}
            <button type="button" className={css.button} onClick={() => {
              if (!confirmReload) setReloadConfirmation({
                session: sessionId, path: file.path, version: external.version, revision: file.revision,
              })
              else { props.reloadExternal(); setDiskComparison(null); setReloadConfirmation(null) }
            }}>{t('reloadDisk')}</button>
            <button type="button" className={css.quietButton} onClick={() => { setDiskComparison(null); setReloadConfirmation(null) }}>{t('keepBuffer')}</button>
            <form className={css.openPath} onSubmit={(event) => { event.preventDefault(); if (pathInput.trim() !== '') void props.saveAs(pathInput.trim()) }}>
              <input value={pathInput} onChange={event => setPathInput(event.target.value)} aria-label={t('filePath')} placeholder={t('filePath')} />
              <button type="submit" className={css.button} disabled={pathInput.trim() === ''}>{t('saveAs')}</button>
            </form>
          </section>}
          <div className={css.documentArea}>
            {!isWord && <div className={css.sourcePane} hidden={file.unavailable !== true && state.mode === 'writing' && (pane === 'pdf' || (isLatex && pane === 'visual'))}>
              <CodeEditor file={file} palette={palette} fontSize={state.codeFontSize} wrap={state.wrap} selection={state.selection}
                {...(state.mode === 'development' ? { language } : {})}
                sourceTarget={state.sourceTarget} command={command?.surface === 'source' ? command : null} onEdit={props.edit}
                onSave={save} onSelect={props.select} t={t} />
            </div>}
            {isLatex && file.unavailable !== true && <div className={css.visualPane} hidden={state.mode !== 'writing' || pane !== 'visual'}>
              <VisualEditor file={file} fontSize={state.fontSize} selection={state.selection}
                sourceTarget={state.sourceTarget} command={command?.surface === 'visual' ? command : null} onEdit={visualEdit}
                onSave={save} onSelect={props.select} onNavigateInclude={include} resolveAsset={props.resolveAsset}
                queryReferences={props.queryReferences} mathFontsDirectory={mathFontsDirectory} t={t} />
            </div>}
            {state.mode === 'writing' && file.kind === 'word' && file.wordSync === 'failed' && <div className={css.pdfNotice} role="alert">
              {t('wordPendingRecovery')} <button type="button" disabled={state.restoring}
                onClick={() => { void props.wordResume(file.path).then(() => props.refreshPdf()) }}>{t('wordResume')}</button>
              {file.pendingWord !== undefined && <details><summary>{t('wordPendingInput')}</summary><pre>{file.pendingWord.text}</pre></details>}
            </div>}
            {state.mode === 'writing' && (pane === 'pdf' || isWord) && file.unavailable !== true && <div className={css.pdfPane}>
              {file.kind === 'word' ? <WordPageEditor key={file.word.id} file={file}
                sourceTarget={state.sourceTarget} mount={props.wordMount} navigate={props.wordNavigate}
                command={command?.surface === 'visual' ? command : null} save={save} t={t}
                compact={immersive} outlineOpen={wordOutline} onOutline={() => setWordOutline(!wordOutline)} />
                : state.pdf === null ? <p className={css.hint} role="status">{t('noPdf')}</p>
                  : <PdfPreview key={state.pdfSourcePath} position={state.pdfPositions[state.pdfSourcePath ?? '']} onPosition={props.setPdfPosition} renderFactorySlot={renderFactorySlot} pdf={state.pdf} target={state.pdfTarget} onSource={props.locateSource} onSelection={props.selectPdf} t={t} />}
              {(state.job?.state === 'failed' || state.job?.state === 'cancelled') && state.pdf !== null && <div className={css.pdfNotice}>{t('pdfOld')}</div>}
              {!isWord && state.pdf !== null && pdfStale && <div className={css.pdfNotice}>{t(isWord ? 'wordPageStale' : 'pdfStale')}</div>}
            </div>}
          </div>
        </>}
        {proposal !== undefined && !showingDetails && <div className={css.proposalSplitter} role="separator" tabIndex={0}
          aria-label={t('resizeProposal')} aria-orientation="horizontal" aria-valuemin={18} aria-valuemax={65} aria-valuenow={proposalPercent}
          data-workbench-proposal-splitter=""
          onPointerDown={(event) => {
            if (event.button === 0) { event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId) }
          }}
          onPointerMove={(event) => {
            if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
            const bounds = event.currentTarget.parentElement?.getBoundingClientRect()
            if (bounds !== undefined && bounds.height > 0) {
              setProposalPercent(Math.max(18, Math.min(65, (bounds.bottom - event.clientY - 36) / bounds.height * 100)))
            }
          }}
          onPointerUp={(event) => {
            if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
          }}
          onKeyDown={(event) => {
            if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return
            event.preventDefault()
            setProposalPercent(value => event.key === 'Home' ? 18 : event.key === 'End' ? 65 : Math.max(18, Math.min(65, value + (event.key === 'ArrowUp' ? 5 : -5))))
          }} />}
        {proposal !== undefined && <Proposal proposal={proposal} presentation={showingDetails ? 'detail' : 'compact'}
          onDetails={() => setDetailedProposal(state.action?.actionId ?? null)} onDocument={() => setDetailedProposal(null)}
          selection={state.selection} stale={stale}
          accept={props.accept} discard={props.discard} refine={props.refine}
          locate={() => { setDetailedProposal(null); props.locateSelection() }}
          resolveAsset={props.resolveAsset} mathFontsDirectory={mathFontsDirectory} fontSize={state.fontSize} t={t} />}
        {state.job !== null && (state.job.kind !== 'latex' || state.outputOpen) && <section className={css.jobOutput} aria-label={t('output')}>
          <button type="button" className={css.outputHeader} onClick={() => props.setOutputOpen(!state.outputOpen)} aria-expanded={state.outputOpen}>
            <span>{t(state.job.kind === 'latex' ? 'compileInfo' : 'output')} · {t(state.job.state === 'running' ? 'running' : state.job.state === 'succeeded' ? 'succeeded' : state.job.state === 'cancelled' ? 'jobCancelled' : 'jobFailed')}</span>
            <span>{state.outputOpen ? '⌄' : '⌃'}</span>
          </button>
          {state.outputOpen && <div className={css.outputBody}>
            {state.job.pollError !== undefined && <p className={css.hint} role="status" title={state.job.pollError}>{t('reconnecting')}</p>}
            {state.job.diagnostics.map((diagnostic, index) => <button type="button" className={css.diagnostic} key={`${diagnostic.path}:${diagnostic.line}:${index}`} onClick={() => { void props.locateDiagnostic(diagnostic) }}><strong>{basename(diagnostic.path)}:{diagnostic.line}</strong><span>{diagnostic.message}</span></button>)}
            {state.job.error !== undefined && <p className={css.errorText}>{state.job.error}</p>}
            <pre>{state.job.output}</pre>
            <RunArtifacts job={state.job} resolveAsset={props.resolveAsset} open={props.open} t={t} />
          </div>}
        </section>}
        <div className={css.terminalPane} hidden={state.mode !== 'development' || !terminalOpen}>{renderFactorySlot('workbench.terminal', { sessionId, visible: state.mode === 'development' && terminalOpen })}</div>
        <footer className={css.statusBar} hidden={immersive && writing && isWord}>
          {state.job?.kind === 'latex' && <button type="button" className={css.quietButton} aria-expanded={state.outputOpen}
            onClick={() => props.setOutputOpen(!state.outputOpen)}>{t('compileInfo')} · {t(state.job.state === 'running' ? 'running' : state.job.state === 'succeeded' ? 'succeeded' : state.job.state === 'cancelled' ? 'jobCancelled' : 'jobFailed')}</button>}<span title={file?.path}>{file?.path ?? ''}</span><span className={css.spacer} /><span>{file === undefined ? '' : `${t('line')} ${file.text.slice(0, file.selection.from).split('\n').length}`}</span></footer>
      </section>
    </div>
  </div>
}
