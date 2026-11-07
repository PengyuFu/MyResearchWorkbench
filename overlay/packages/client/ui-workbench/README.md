---
description: "Writing and development panels, assistance conversation, original-file saving and recovery."
kind: "package-reference"
---

# Writing and development work views

English | [中文](README.zh.md)

## Summary

The Workbench places writing and development panels beside the existing conversation, preserving Session, model, Agent preset and permissions. Each physical file has one owning board and one buffer; tabs, selections, scrolling and undo survive board switches. Workspace-relative paths reject obsolete workspace responses.

## Table of Contents

- [Layout and conversation](#layout-and-conversation)
- [Scientific editing](#scientific-editing)
- [Word editing](#word-editing)
- [Review, saving and recovery](#review-saving-and-recovery)
- [Development](#development)
- [Validation](#validation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

<a id="layout-and-conversation"></a>

## Layout and conversation

The divider resizes the two mounted surfaces; arrow keys adjust it and double-click restores the default. Below 880 CSS pixels, focus controls retain both surfaces. Both board headers support pointer-following left/right placement with damped settling; Escape, pointer cancellation and blur cancel movement. Reduced motion disables animation. Immersive view retains the conversation composer, model, permissions and statistics, a compact filename switch, File and More. Document margins remain unchanged. Glass is confined to the rounded shell; text and comparisons remain opaque. Increased contrast and reduced transparency use an opaque shell.

Assist attaches the current file/object/selection to the main composer; it has no separate input. Enter clears the submitted draft while preserving later typing. Quick instructions appear as durable user/result exchanges. Clarification choices are clickable complete plans, and free-text answers use the same composer. Busy rejection, cancellation, partial execution and save failure remain visible. Delegation hides the quick node with its existing identity so the ordinary Agent exchange can continue; withdrawing an already materialized node would break the event feed.

<a id="scientific-editing"></a>

## Scientific editing

Supported LaTeX ranges project into Tiptap/ProseMirror, with MathLive for editable mathematics. Front matter, sections, figures, references and table cells retain source identity. Bounded edits preserve unrelated macros, comments, wrappers and line endings. Unsupported syntax stays intact and is identified. The source buffer remains authoritative; a successful local MiKTeX PDF and SyncTeX snapshot owns final typesetting. Navigation refuses stale build-input positions.

Figures/tables start from conversation with an explicit location and verified attachment/project asset. IndexedDB staging permits eight files, 16 MiB each and 32 MiB total, without automatic expiry. Acceptance saves assets through the source transaction; undo removes the insertion but retains committed assets. Residual/incomplete writes remain inspectable. PNG, JPEG and PDF imports are supported; existing EPS uses an available preview counterpart. Reference discovery reads at most 64 project source/bibliography files and 4 MiB. Keys remain unchanged; missing/duplicate references are reported. Cross-file renaming requires a separate explicit operation.

<a id="word-editing"></a>

## Word editing

The local Apache-2.0 OOXML core owns bytes, layout, native selection and undo. The Host checks binary checkpoints and original-file publication. Existing DOCX parts are retained rather than reconstructed from HTML. Local font bytes are resolved before packaged HarfBuzz initialization; system fonts are not bundled. Initialization failure remains visible and invalidates layout measurements. The viewport scales authored pages between 50% and 100% without changing margins or wrapping.

Typing, formatting and accepted suggestions use the same native editor. A single-paragraph replacement inserts inside the original run before removing the old text, preserving native font/size and related run properties. A multi-paragraph replacement restores the captured base font/size through native commands; arbitrary mixed-style redistribution is not inferred. Table AutoFit supports content/window modes and optional row-height reset. Paragraph pagination and header/footer edits use normal native operations; exact region text and revision are checked. Complex regions and unsupported structural combinations fail explicitly.

The shared operation path publishes current context, validates target/revision, claims a live single-use Agent request, applies, saves and acknowledges. Historical notices and duplicate claims cannot repeat edits. The Host verifies the saved result. A successful operation refreshes its unchanged assistance attachment to the committed revision, allowing the next instruction without reselection; unrelated edits and newer attachments retain their own version checks. See the [routing and learning service](../../context/workbench-assistant/README.md#conditional-learning-and-recovery).

<a id="review-saving-and-recovery"></a>

## Review, saving and recovery

Proposals remain outside the document until acceptance. Accept, Discard, Details and Refine are displayed below the target document; Details shows the comparison without remounting the editor. Scientific changes expose values, units, references and source differences. Acceptance checks captured text/version and creates an undoable transaction. Saving is reported separately. An unaccepted proposal cannot write files or start compilation.

Saves are serialized per file and compare the last disk version. Clean buffers refresh external changes; dirty conflicts retain drafts and show a resolution. Word autosaves after about one second idle; Ctrl+S saves immediately. Typing during save schedules another write. Unchanged originals are not rewritten. Closing a dirty Word file attempts saving, then retains save/discard/cancel choices on failure. Discard affects unsaved changes only. Save a copy requires a new local workspace path.

One application-owned IndexedDB writer atomically checkpoints scenes and drafts by original Session and Host-confirmed workspace within 150 ms, without postponing continuous input. Normal quit captures mounted editors and awaits strict durability before Host teardown. Crash recovery returns the last successful commit; final uncommitted input is not guaranteed. Tabs, both boards, views, selections, PDF position and pending review identities are retained without age/count eviction. Restore never accepts a proposal or reruns a model/job. Word resumes autosaving only after original identity and content agree; conflicts need resolution. Missing or inaccessible files retain their drafts. Scene format 2 preserves checkpoint/proof identities; invalid scenes suspend cleanup, and format 1 cannot authorize collection.

<a id="development"></a>

## Development

CodeMirror supports Python, MATLAB, C++ and CUDA highlighting, board-specific palettes and file identities. Creation/execution remains a conversation action. Run output and images belong to the actual job; interactive input uses the existing PTY terminal from More. Reconnection can reattach only to a process still owned by the same Host. Ctrl+S is shared; Writing also keeps compilation and Ctrl+Alt+B.

<a id="validation"></a>

## Validation

Controller tests cover save conflicts, claims, receipts, undo, selection, reconnects and jobs. The real conversation assembler regression covers incremental quick-to-Agent delegation without interrupting later messages. Scientific and asset tests cover source identity, storage, quotas and hashes. Packaged EXE checks use owned synthetic documents/profiles to verify native AutoFit, Agent execution, learned reuse, font/size preservation, undo and restart. Private manuscripts and runtime evidence stay outside the source tree.
<a id="model-experience"></a>

## Model Experience

### Explicit operations and context

#### What the model sees

Direct supported operations use local/learned routing, bounded parsing and existing Session Agent fallback. The client preserves selection and validates every execution receipt. The menu exposes workspace learning counts, pause/resume and clear without changing model or permissions. Manual editing, saving, switching and compilation do not themselves call a model. Explicit assistance logs selected text, bounded context and instruction. Review decisions are recorded without another model request. Acknowledged context enters the model through `workbench_read_context`.

#### Token effect

Local and learned hits consume no model tokens. Misses send bounded targets, instructions and needed tool results; Agent takeover appends ordinary Session messages.

#### KV Cache effect

Stable tool definitions can retain a shared prefix; changing selections, parameters and results changes later input. Provider cache hit rates are not guaranteed.

<a id="known-limitations-and-deferred-work"></a>

## Known Limitations and Deferred Work

- Visual LaTeX editing does not implement arbitrary TeX expansion or journal pagination. Development is not a debugger, language server or toolchain installer; installed tools determine execution. Browser storage can fail or be evicted. Asset writes use checked recovery journals rather than a filesystem-wide atomic transaction. Unavailable fonts, unsupported OOXML and different machines need separate validation. Legacy unconfirmed text-projection drafts require the earlier application. Manual IME candidate windows and long-duration editing are not covered by automated browser checks.

<a id="dev-note"></a>

### Dev Note

None.
