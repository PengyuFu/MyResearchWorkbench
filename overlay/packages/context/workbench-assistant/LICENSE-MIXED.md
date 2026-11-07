# MyResearchWorkbench Workbench Assistant: component-level licensing

**Status:** internal pre-release notice for the 0.12.0 preparation branch. It is not a final end-user EULA.

This package historically carried `"license": "MIT"` through 0.11.2. A previous valid MIT grant, if any, remains valid for the corresponding code and version; this notice does not revoke it.

## Public-source candidates (Pengyu Fu original portions: MRW-NC-1.0)

For a future release, Pengyu Fu's own original contributions in the following public contracts and integrations are intended to be source-visible under `LICENSE-MYRESEARCHWORKBENCH-NC.md`: free learning, teaching and noncommercial research, while commercial use requires prior written authorization. Any actual original Harness/MIT fragments or third-party contributions within the same files retain their respective licenses. Historical valid MIT grants remain unaffected.

- `src/types.ts`, `src/quick-contract.ts`, `src/quick-dialogue.ts`
- `src/conversation.ts`, `src/conversation-context.ts`, `src/conversation-assets.ts`
- `src/prompt.ts`, `src/proposal.ts`, `src/recovery.ts`
- `src/word-command.ts`, `src/word-format.ts`, `src/word-page.ts`
- `src/index.ts` (public Assistant host/adapter) and `src/private-runtime-api.d.ts` (type-only contract)

The public release must include the noncommercial license for Pengyu Fu's original portions, applicable upstream MIT copyright/permission notices, and any separate third-party notices. Final inclusion is determined by a reviewed positive file list; no blanket relicensing of upstream code is implied.

## Reserved implementation candidates (source is not approved for public distribution)

- `src/internal/**`: proprietary parsing, execution, learning and strategy source is excluded from the public-source overlay. `lib/private-runtime.js` is the separately built distributable runtime component.
- `src/runtime-asset.ts`, `assets/workbench-runtime.json`: runtime glue and an approved subset of internal strategy content. Their observability in compiled artifacts must be disclosed.

No additional public-source grant is asserted for these candidates by this preparation notice. Their precise proprietary rights remain subject to provenance, prior-license and third-party review. Third-party code, where present, retains its own licenses.

## Distribution rule

The public repository must exclude reserved source, internal design documents, original policy masters, user data and credentials. A complete Windows application may carry a separately licensed, compiled runtime; third-party legal notices still apply to all redistributed artifacts.

A source file's location, a binary wrapper, `private: true`, or an ASAR archive does not change rights that were already granted. This notice governs proposed distribution, not secrecy by technical enforcement.
