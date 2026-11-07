# @deepseek-ai/dsh-personal-plan

Host-side plan-and-task board for MyResearchWorkbench: one durable user-level document holding plans, their tasks, and at most one serial execution batch, independent of Sessions and workspaces.

## Summary

The service stores one board document under `ctx.storageDomain` (backend `json`, unit `personal_plan`, file `$DSH_HOME/storages/personal_plan.json`). A plan carries a stable identity, a required title, an optional note and `YYYY-MM-DD` date, one of the `todo`/`in_progress`/`done` statuses, and the user's own order. A task belongs to exactly one plan with its own position, a title, an optional execution instruction, optional completion requirements, a declared required-artifact list, one of six execution states, the ordinary Harness Session created for it, and the result that Session submitted. Documents written before tasks existed stay readable: a missing task list reads as empty, and a task without the newer fields reads with empty requirements and no required artifacts.

The board's global slot holds the whole document, so every write publishes the complete board and one revision covers plans, tasks, and the batch.

## Tools

Three model-facing tools are registered by the service:

- `plan_read` — read plans and their tasks; never changes the board.
- `plan_propose_changes` — validate a plan or task change set and store it as a pending proposal. It does not write the board. The browser client shows the preview and calls `applyProposal` only after the user confirms; that method refuses a proposal whose `baseRevision` no longer matches the board.
- `plan_task_result` — submit the result of the task the calling Session is executing. Only the running batch's current task, prompted into that task's own Session, accepts it; `done` requires every submitted artifact and every declared required artifact to exist.

## Manual operations

Browser edits call `addItem`, `updateItem`, `deleteItem`, `setStatus`, `reorder`, `addTask`, `updateTask`, `deleteTask`, and `reorderTasks`, each returning the authoritative snapshot. Deleting a plan deletes its task records; the Harness Sessions and generated files survive. A write that targets a task the running batch dispatches is refused until the batch stops. A successful write bumps `revision` and emits `personal-plan/changed`.

## Execution batches

`startRun` fixes the batch (task list, working directory, order) and returns immediately; `stopRun` cancels the current Session and forbids further dispatch. The engine creates one ordinary Session per task through the Session Controller, sends the task instruction as a user message, waits for the Session to reach idle, and only then evaluates the task's submitted result:

- `done` with every submitted and declared required artifact present → the task is done and the next one starts;
- `needs_user` → the task waits for the user and the batch stops;
- `failed`, a missing result, or missing artifacts → the batch stops with the task's real state.

Nothing advances on "the model stopped talking", and the batch never advances while a task is still running. A stored Session that can no longer be opened stops the batch with `needs_user` naming the deleted Session; it is never replaced by a new conversation. A batch left `running` by an exited process is reported as `interrupted` when the next process opens the document; it is never resumed automatically. `revealSession` emits `personal-plan/reveal-session` so another window can show the task's Session in its conversation, `revealTaskSession` checks that Session first and reports `unavailable` when it is gone, and `requestPanel` emits `personal-plan/panel-requested` so the floating window can dock back to the embedded board.

## Model Experience

### `plan_read`

#### What the model sees

Every plan with ids, titles, notes, dates, statuses, and order, each followed by its tasks' statuses, titles, instructions, completion requirements, required artifacts, and ids, plus the board revision.

#### Token effect

The rendered board text only; bounded by the plan item cap (500 plans), the task cap (100 per plan), and the per-field length limits.

#### KV Cache effect

None; the tool appends no Session events and changes no request prefix.

### `plan_propose_changes`

#### What the model sees

A proposal identity, its base revision, and one summary line per change. The rendered result states that nothing was applied and that the user must confirm the preview.

#### Token effect

Proportional to the requested change count.

#### KV Cache effect

None.

### `plan_task_result`

#### What the model sees

A boolean `recorded` and a stable code. The rendered line states that the batch advances after the turn ends, or names why the result was refused and forbids claiming completion.

#### Token effect

Constant.

#### KV Cache effect

None.

## Configuration

None. The batch working directory is chosen by the user for each start.

## Known Limitations and Deferred Work

- The board is one document rewritten per write; per-item writes would need a different storage layout.
- The pending proposal is part of the same document, so a process crash between preview and confirmation leaves the draft stored (not applied).
- Proposals are single-writer: a newer proposal replaces the pending one.
- One batch runs at a time; parallel task execution, retries, and time-based scheduling are out of scope.
- A task's result may be submitted only through the tool, so a Session driven entirely by another client cannot complete a board task.
- Client-side auto-open and notification depend on the forwarded `personal-plan/changed` event.

## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The `./typert`, `./remote`, and `./client` exports are generated/compiled by the repository's Typert pass and TypeScript build; `lib/typert.*` files are not hand-written. Run `pnpm run gen-tsconfig-paths` after adding the package and `tsx scripts/generate-typert.ts` to regenerate the Remote artifacts.

The execution engine takes its Session operations through `PlanRunEngineOptions.gateway`; `PersonalPlanService.sessionGateway()` binds the real Session Controller, and a package test overrides that method to drive the same state machine with a fake.

</details>
