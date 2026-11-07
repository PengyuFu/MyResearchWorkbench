# Workbench workspace

This Host plugin owns explicit user editor saves and local project compile/run actions. The `workbenchWorkspace` Remote namespace uses the existing Session workspace lookup and access checks. It does not register model tools.

## Editing

`read` returns a complete UTF-8 buffer and its opaque disk version. `save` requires that version, or `null` for a new file. The filesystem provider performs atomic compare-and-write; concurrent external edits are reported as `workbench/conflict`, never silently overwritten. Paths, including resolved parent links, must remain inside the Session workspace. Final symbolic links are refused. The editor preserves supplied newlines and the UTF-8 BOM; no automatic formatter runs on save.

A save may include a bounded group of staged assets. Its Remote payload uses canonical base64; the service verifies size, signatures and SHA-256 before admitting bytes. Asset paths are limited to generated names under `figures/workbench`. The service prechecks the source version and workspace identity, creates assets exclusively, and performs the provider's source compare-and-write last. Existing byte-identical assets may be reused. Failure removes only newly created, unchanged files it still owns; uncertain residuals remain visible in the transaction journal. This is recoverable ordered writing, not a filesystem-wide atomic commit. The group writer requires the active filesystem provider to resolve the same explicit local paths.

`assetRecovery` reads bounded journal history from `.mrw-build/asset-transactions` without changing files. It reports incomplete operations, residual paths, malformed logs and an active lock. Scanning is limited to 256 directory entries, 64 journals and 128 KiB per journal; an active lock is checked separately. Restart does not automatically delete a stale lock or an externally changed asset.

These are user operations, like the existing user terminal. They are independent of the Agent's permission preset. A generated suggestion must be explicitly accepted into the editor buffer before the UI saves it. `list` hides `.git` and Workbench's own `.mrw-build` outputs.

## Builds and runs

`start` returns a running job identity; `status` reports actual completion, bounded output, source diagnostics, timeout, and exit facts. One job can run per Session. `current` recovers only that Session's unfinished job after a renderer reconnect; it returns null after completion or a Host restart. `stop` aborts only that job and awaits its entire managed process range. Provider-managed subprocesses use the standard credential-scrubbed environment. Source and command working directories are explicit and workspace-confined. Relative diagnostic paths resolve from the working directory of the command that produced them, including multi-step recipes. Executables and argument arrays are passed without shell interpolation; relative executable paths resolve from that working directory. Python uses the selected installed interpreter. MATLAB supports the selected installed batch executable; C++, CUDA, and other tools run through an explicit executable and argument array. Environment discovery reports candidates without installing them. Generated image artifacts retain their job and source identity. Workbench does not provision or download toolchains.

Windows MATLAB batch invocations add `-wait` so the launcher returns MATLAB's actual exit status. After that result arrives, Workbench terminates only surviving descendants in that invocation's provider-managed process range and awaits their exit before publishing completion. Other MATLAB sessions and pre-existing vendor services are outside this range. Interactive MATLAB and generic commands keep their normal lifecycle. The startup option follows the [MATLAB Windows command documentation](https://www.mathworks.com/help/releases/R2024b/matlab/ref/matlabwindows.html).

For those Windows batch jobs, Workbench queries the execution environment's ANSI encoding with Windows PowerShell and captures raw stdout/stderr through streaming decoders. Valid UTF-8 is retained; legacy native-code-page text is decoded using the measured encoding, with bounded complete-character tails. This preserves Chinese paths and localized MATLAB errors without changing global locale, console settings or MATLAB startup preferences. Active-source `Error using`/`Error in` and Chinese `错误使用`/`出错` locations become source diagnostics; ambiguous bare names for other MATLAB-path functions do not produce invented project paths.

LaTeX follows `% !TeX root`, reads a project `.vscode/settings.json` as JSONC, and uses its configured LaTeX Workshop recipe in auto mode. The supported source/output placeholders follow [LaTeX Workshop's definitions](https://github.com/James-Yu/LaTeX-Workshop/wiki/Compile#placeholders). Without a project recipe, `% !TeX program` selects the engine; otherwise an installed `latexmk` is preferred and `pdflatex` is the fallback. Direct engine builds run bibliography tools when generated BCF/AUX files require them, then complete the reference passes. Explicit engine selection bypasses the project recipe.

Default builds write to a unique `.mrw-build/latex` directory. A successful build publishes a small `latest.json` and an immutable PDF/SyncTeX pair. A failed or cancelled build leaves the last successful pair intact. A project recipe keeps its configured output directory; the successful PDF and SyncTeX files are copied into the immutable build directory. The PDF endpoint returns only a published successful snapshot. Its metadata records the root and participating build input versions. Forward and reverse navigation recheck those inputs and refuse stale positions instead of reusing old line numbers. Source/PDF navigation honors the project's `latex-workshop.synctex.path`, falling back to the configured `synctexCommand`, and confines reverse locations to the workspace.

Existing figure previews read workspace-contained assets. PNG and JPEG render directly; PDF can render through the client PDF viewer. EPS uses a matching available PDF/image counterpart for preview while preserving the original asset and TeX reference. Missing counterparts are reported rather than substituted with invented images.

## Configuration

Defaults are a 2 MiB text-buffer limit, 32 MiB PDF limit, 1,000 directory entries, 256 KiB retained output, 16 retained jobs per Session, a five-minute job timeout, and a 1.5-second process termination grace. `pythonCommands` and `synctexCommand` accept installed PATH names or explicitly configured absolute executable paths. All limits are configurable through the plugin's validated config.

Asset limits are eight files per operation, 16 MiB per file and 32 MiB total. Journal history is bounded during reads; persisted project outputs and diagnostic journals are not deleted automatically. The ordinary editor save path continues to work without an asset group or a local native filesystem provider.

## Optional installed MATLAB smoke

After building, run `node packages/workspace/workbench-workspace/tests/matlab-host-smoke.mjs --source-root <built-tree> --evidence-root <new-directory> --matlab <installed-executable>` on Windows. The smoke boots the built Web profile with an isolated home and drives the public Remote methods against a synthetic project. It checks successful plotting and numeric output, exact UTF-8 cwd metadata and matching console text, a real nonzero exit with a Chinese error and line-2 source diagnostic, explicit stop, and preservation of pre-existing MATLAB/vendor processes. The evidence directory retains the fixtures, bounded job results, artifact hashes and Host shutdown result. No model request or original research input is involved.

## Optional local TeX smoke tests

`tests/latex.spec.ts` uses only already-installed tools and self-owned temporary fixtures. `MRW_LATEX_EXECUTABLE` enables the direct-engine failure-recovery smoke. `MRW_LATEXMK_EXECUTABLE` enables a separate project-recipe smoke containing a main document, included chapter, BibTeX bibliography, vector figure, equation, and Chinese/space project path. It checks resolved citations and labels, the successful PDF snapshot, and forward/reverse SyncTeX into the included chapter. MiKTeX child commands explicitly disable package installation; missing dependencies fail instead of being provisioned.

Set `MRW_SYNCTEX_EXECUTABLE` to the existing SyncTeX executable when it is not on PATH. For the latexmk smoke, `MRW_LATEXMK_PATH` may supply the existing tool PATH (including Git's `usr/bin` Perl on Windows); otherwise the inherited PATH is used. The latexmk executable directory is prepended, and the recipe's TEMP/TMP point into the disposable fixture. No original paper or global TeX setting is edited.

## Model Experience

This plugin adds no prompt, tool schema, or model request. User builds consume no model tokens. Source text becomes model-visible only through the separate selection interaction, whose owner records that input in the Session. The plugin does not alter KV-cache behavior.

## Known Limitations and Deferred Work

Editing supports UTF-8 text, not automatic legacy-encoding conversion. Build output directories remain on disk for inspection; no automatic cleanup removes user build artifacts. Job state is Host-lifetime state, while the successful PDF pointer persists in the workspace. Custom recipe snapshot copying currently requires a local filesystem provider. Global VS Code settings, VS Code extensions, language-server installation, interactive stdin for these noninteractive jobs, GPU provisioning, and debugging are outside this plugin. Build input versions bind the published PDF/SyncTeX snapshot; the UI also marks preview state stale when its current buffer has newer or unsaved edits. A project with several roots must select the intended root or declare it through `% !TeX root`.
