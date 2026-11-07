# @deepseek-ai/dsh-client-ui-personal-plan

The plan board's browser surfaces: the embedded right-Sidebar page, the optional floating Desktop window's whole surface, the entries that open them, and the pending model-proposal preview.

## Summary

The plugin creates one shared plan source from the `personalPlan` Remote namespace. Plans and tasks start embedded: the header entry opens or focuses the `personalPlan` page type, and a Host change that carries a pending proposal opens the page so the preview is visible.

On the Desktop the embedded panel also offers **Open in its own window**. Floating is additive — the embedded board stays open and both surfaces read the same Host document — and the floating window's **Dock to main window** action hides it, reopens the embedded board, and brings the main window forward. Closing the floating window with the native control or **Close window** only hides it. The Web client has no desktop bridge, so it has no float action.

The board renders plans on top and the selected plan's tasks below. Each plan row keeps its status control, inline editor, delete confirmation, and native HTML5 drag reordering, and adds one selection button that decides whose tasks are shown; the task area states the current plan, the per-task status, the short progress line, the execution instruction, the completion requirements, the required artifacts, and a link that opens that task's Session in the main window. A Session that was deleted or is unusable is reported instead of opening a replacement conversation. Tasks can be added, edited, deleted, and drag-reordered; running a single task or the whole plan needs a working directory, which the native directory picker supplies on Desktop.

The proposal preview lists each plan or task change with a keep toggle. Nothing is applied until the user presses **Apply selected**; a proposal whose base revision no longer matches the board shows the stale warning and can only be discarded. The Host re-checks the revision and the selected change identities on apply.

In the Desktop plan window the document URL carries `?mrwPlan=1`; that instance registers a full-window overlay instead of the Sidebar page, ignores the proposal auto-open (it has no Sidebar), and follows no reveal notification — the main window owns conversation navigation and is raised when it opens a task Session.

## Model Experience

None: this package is browser presentation. The model-facing tools belong to `@deepseek-ai/dsh-personal-plan`, which owns the proposal and task-result contracts these surfaces render.

## Known Limitations and Deferred Work

- Reordering is native HTML5 drag and drop; touch or keyboard reordering is not provided in this version.
- The source refreshes on the Host change event and on connection reset; it does not poll while disconnected.
- The floating plan window renders the board over the shell that boots underneath it; the window is a real Desktop window, but the shell in that window is still loaded behind the overlay.
- The remembered working directory lives in browser storage with a session-memory fallback; there is no per-plan directory.
- A task's status is display-only for the user; it changes only through execution or a confirmed AI proposal.

## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The package registers into four surfaces: `ctx.sidebarRightTabs` for the page type, the keyed `sidebar.right.pane.tab` seat for its body, the `conversation.session.header.utilities` and `conversation.hero.options` lists for the entries, and — only in the plan-window instance — the `shell.overlay` list for the whole window. Its peer supply lives in `packages/bundle/web-app` (patch row + dependency) and in the client tsconfig aggregate.

`PlanBoard` is the one board implementation; `PlanPanel` and `PlanWindow` are thin surfaces over it, so the Sidebar page and the floating window cannot drift.

</details>


The shared board has a draggable horizontal divider between plans and tasks in both the embedded panel and independent window. Arrow keys adjust the height allocation; double-click or Home restores equal heights. Each area scrolls independently. The ratio belongs to the mounted view and never changes plan or task data.
