# Workbench Word

English | [中文](README.zh.md)

The Windows Host service retains binary DOCX drafts for the continuous writing board. Its authenticated, workspace-scoped `workbenchWord` Remote namespace does not add model tools.

## Ownership and editing

The browser owns one retained OOXML editor per document. Typing, accepted AI replacements, formatting, undo and redo use that same editor. Detaching a tab changes its view without replacing its model or history. The Host receives serialized DOCX bytes and read-only text context; it never rebuilds a document from HTML or invokes Word or WPS.

The bundled Apache-2.0 core, source commit, local layout patch and package digest are recorded in `third_party/docx-editor/manifest.json`. Shaping code is bundled and requested fonts come from the installed Windows font catalog. Missing fonts can affect fidelity and are reported by the editor.

Conversation formatting is queued against the acknowledged document revision. The browser applies or refuses it through its editor and resolves the queue record. A queued response is not an applied result. Paragraph-style configuration edits only the authored styles part in one guarded package transaction.

## Saving and recovery

The Desktop supplies absolute bundled Python, private filesystem dependencies and profile-data locations. The worker verifies serialized bytes, rejects stale checkpoints and deduplicates requests. Editing retains private drafts and schedules original-file saving after about one second idle. Ctrl+S requests an immediate save through the same serialized writer. Recovery checks the original once: changed or unreadable originals retain the draft with a visible paused-save state. Automatic saving resumes for matching originals; an explicit retry or a new Save As destination resolves a blocked write.

Save checks the original file's identity and content while excluding competing writers. A flushed backup precedes publication; a durable journal can restore a missing original without replacing a new external file. Save As refuses to overwrite an existing destination.

The scene stores acknowledged checkpoint references, open tabs, view state and unconfirmed binary input. Recovery verifies the exact checkpoint hash. Unconfirmed input requires explicit retry; it is never silently replayed. Retention protects complete scene references, recent unacknowledged checkpoints and unresolved save journals. Other profiles are not scanned or deleted.

## Model Experience

The selection assistant receives bounded acknowledged text. Text suggestions remain review-only until accepted. Acceptance checks the captured revision and original text, then uses the same editor and undo history as manual input. The service does not call models.

## Known Limitations and Deferred Work

The current Host is Windows-only. Macro, encrypted, externally linked and actively protected documents are refused. Unsupported OOXML structures retain their package content but may not support direct editing or exact rendering. Fidelity is validated against the scoped report and recorded control documents, not every Word feature. Undo history survives tab switches within the running editor; persisted checkpoints restore content and view state without claiming to restore an earlier process's undo stack. Native Word proof generation and paragraph overlays are retired.
