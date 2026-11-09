# MyResearchWorkbench — License scope

[简体中文](LICENSE-SCOPE.md) | English

This repository contains source-visible, noncommercial original Workbench code and independently licensed third-party code. The original portions are not OSI open-source software because their license restricts commercial use.

**Licensor: Pengyu Fu. Contact: fpy19941225@163.com.** Learning, teaching, and noncommercial research are free within the granted scope. Commercial exploitation requires Pengyu Fu's prior written permission.

This English translation describes the same source-contribution scope as the Chinese original. It does not change the underlying rights.

## 1. Scope of original source code

Paths in the following table are relative to this repository's `overlay/`. MRW-NC-1.0 applies only to original portions that Pengyu Fu is entitled to license.

| Directory | Original content covered | Exceptions |
| --- | --- | --- |
| `packages/client/ui-workbench/` | Original writing/development boards, document interactions, styles, tests, and documentation | Third-party Apache/MIT/NOTICE files under `licenses/docx-editor/`, and embedded or referenced third-party code |
| `packages/client/ui-personal-plan/` | Original personal-plan client, styles, tests, and documentation | Independently licensed third-party portions |
| `packages/plan/personal-plan/` | Original plan/task logic, tests, and documentation | Independently licensed third-party portions |
| `packages/workspace/workbench-word/` | Original Word-workspace bridging/processing logic, tests, and documentation | External Office/WPS software and third-party components |
| `packages/workspace/workbench-workspace/` | Original workspace file/build integration code, tests, and documentation | Independently licensed third-party portions |
| `packages/context/workbench-assistant/` | Assistant contracts, types, and integration portions **approved for public disclosure** | `src/internal/**` and compiled `private-runtime.js` are subject to separate proprietary terms; valid historical MIT rights are not retroactively revoked |

These six packages were added beyond the fixed, unmodified Harness upstream snapshot. The packages include code adapting third-party systems; original adapter code is covered by this agreement, while the rights in those external systems and libraries remain unaffected.

The following are also **independent original Workbench files** added to existing Harness packages. Their parent packages retain MIT for pre-existing code; Pengyu Fu's original portions in these specifically listed files use MRW-NC-1.0:

- `apps/desktop/src/mrw-data-roots.ts`, `apps/desktop/src/quit-document.ts`, and their `tests/mrw-data-roots.spec.ts` and `tests/quit-document.spec.ts`.
- `apps/web/mathlive-fonts.ts`: only Workbench font-resource assembly logic; MathLive fonts retain their own licensing.
- `LazyWorkbenchPdf.tsx`, `LazyWorkbenchPdf.module.css`, `WorkbenchPdf.tsx`, `WorkbenchPdf.module.css`, and `workbench-contract.ts` under `packages/client/ui-sidebar-documentpreview/src/client/pdf/`.
- `packages/client/ui-sidebar-terminal/src/client/workbench-contract.ts`.
- `scripts/mrw/prepare-owned-assets.ts`, `scripts/mrw/runtime-build.ts`, and `scripts/mrw/runtime-build.spec.ts`.
- `scripts/primary-runtime/word-bridge.ts`: original Workbench preparation logic for Windows Word bridge dependencies. `scripts/primary-runtime/word-bridge.lock.json`: version, official-source, and SHA-256 locking data for third-party `pywin32`. The original logic uses MRW-NC-1.0; this provision does not restrict `pywin32` or its license.

Only the original content in these exact files is within this provision. Existing third-party files in the same packages and their MIT rights remain unaffected. JSON lock data, third-party source, and packaging patches retain their original data and rights boundaries.

This ownership inventory is not a claim that every historical bridge or external-software mode is an available feature of the 0.12.0 application.

## 2. Code outside the original-code noncommercial restriction

- **Pre-existing DeepSeek Harness upstream files, their MIT code, and independent upstream improvements:** MIT. Retain the upstream copyright and [license text](https://github.com/PengyuFu/MyResearchWorkbench/blob/v0.12.0/THIRD_PARTY_LICENSES/DeepSeek-Harness-MIT.txt).
- Other overlay files modified from Harness upstream: the existing MIT code remains under MIT. An “overlay” label does not establish ownership or restrict commercial use. Any separate licensing of future original additions requires identifying the particular contributions first.
- Original DOCX Editor Core source and EigenPal/third-party portions in `patches/docx-core-2.33.0-mrw5.patch`: Apache-2.0 and their respective licenses, with NOTICE and modification notices retained.
- Third-party code, binaries, and content obtained through npm, Python, Electron, LibreOffice, Sharp, CodeMirror, Tiptap, MathLive, and other channels: their respective licenses.
- Original execution strategies and proprietary runtime retained as internal assets: supplied only under separate formally published terms, with no automatic grant through this public source repository.

## 3. Historical MIT licenses

Where a particular contribution in an earlier version was **validly licensed under MIT**, its recipients may continue to rely on that version's existing MIT terms, including commercial use. MRW-NC-1.0 applies to future licensed versions; changing a package's `license` field does not retroactively revoke an earlier grant.

## 4. The root LICENSE does not rewrite third-party rights

The root `LICENSE` contains MRW-NC-1.0 for Pengyu Fu's **original portions**. Files outside the identified scope do not automatically become noncommercial merely because they share the same GitHub repository. Each component's independent LICENSE, NOTICE, and actual origin determine its terms. Commercial activities allowed by third-party licenses remain allowed.

The licensor does not acquire users' rights in independent papers, data, figures, code, or other results through MRW-NC-1.0. Commercial use of those results and commercial exploitation of the software's original implementation must be considered separately.

**Distribution scope:** This document scopes the identified source contributions only. It does not authorize distribution of the private runtime or a complete Windows application; each third-party license remains independently effective.
