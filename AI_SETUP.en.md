# Build MyResearchWorkbench 0.12.0 from source

[简体中文](AI_SETUP.md) | English

This route assembles a Windows x64 application from the fixed official DeepSeek Harness source, the approved public overlay, and separately distributed compiled assets. The proprietary execution implementation is supplied as a compiled module, not as public internal source.

## 1. Prerequisites and downloads

Use Windows x64 with Git, Node.js 24 (at least 24.9.0; 24.21.0 recommended), and Corepack. The project selects pnpm **11.28.5**. Confirm that `git`, `node`, and `corepack` are available in your terminal. If Corepack is missing, install it from its [official project](https://github.com/nodejs/corepack) following the instructions appropriate for your Node installation.

Get the repository at tag `v0.12.0` and download `MyResearchWorkbench_0.12.0_SourceBuildAssets.zip` plus `SHA256SUMS.txt` from the [same official release](https://github.com/PengyuFu/MyResearchWorkbench/releases/tag/v0.12.0). Compare the archive's SHA-256 with the release checksum before extracting it.

```powershell
git -c http.version=HTTP/1.1 clone --branch v0.12.0 https://github.com/PengyuFu/MyResearchWorkbench.git
Get-FileHash -Algorithm SHA256 .\MyResearchWorkbench_0.12.0_SourceBuildAssets.zip
Expand-Archive -LiteralPath .\MyResearchWorkbench_0.12.0_SourceBuildAssets.zip -DestinationPath .\mrw-assets-0.12.0
```

Use a short source checkout path, such as a user-chosen `D:\MRWSource`, to avoid Windows Git's traditional path-length limit. Run these commands from a directory you choose. Keep the source checkout, asset folder, and output build directory separate.

The extracted asset folder must contain:

- `docx-editor-core-2.33.0-mrw.5.tgz`
- `deepseek-ai-dsh-workbench-assistant-0.12.0.tgz`
- `LICENSE_PRIVATE_RUNTIME_0.12.0.zh-CN.txt`

The authoritative versions and individual SHA-256 values are in `SOURCES.lock.json`; `assemble.ps1` verifies them. Explanatory translations do not replace these fixed inputs.

## 2. Assemble and build

From the cloned repository, run the script with your actual asset folder and a **destination that does not already exist**:

```powershell
.\assemble.ps1 -AssetsDir "D:\mrw-assets-0.12.0" -Destination "D:\mrw-build-0.12.0"
```

These are examples of user-chosen paths, not required pre-existing directories.

The script:

1. Verifies the compiled assets, runtime EULA, and DOCX patch against the locked hashes.
2. Runs Corepack from the overlay directory so that it resolves the project-pinned pnpm version.
3. Clones the fixed official Harness tag and checks both its commit and tree identities.
4. Verifies every overlay file before placing it into the matching upstream location.
5. Installs dependencies with the frozen project lockfile and builds the unsigned Windows directory application.
6. Adds original third-party notices, the original-code license/scope, runtime EULA, and user guides to the final application directory.

A successful build produces `MyResearchWorkbench-0.12.0\MyResearchWorkbench.exe` within your chosen destination. Keep the entire application directory together. Follow the [Windows guide](README_WINDOWS.en.md) for first use, external feature dependencies, user-data locations, and upgrades.

## 3. Network and Windows checkout behavior

The tracked Git attributes preserve the required line endings for overlay text and byte-exact binary assets, DOCX patches, and original notices. Do not disable manifest verification or manually rewrite files to bypass a hash failure.

Direct network access can be used where the official upstream services are reachable. On a supported HTTP(S) proxy network, set `HTTP_PROXY` and/or `HTTPS_PROXY` for the current PowerShell process to your actual proxy endpoint before running the assembly script. For example, if your proxy listens on local port 7897:

```powershell
$env:HTTP_PROXY = "http://127.0.0.1:7897"
$env:HTTPS_PROXY = $env:HTTP_PROXY
```

The script enables the relevant Node/Electron environment-proxy behavior and adds `localhost`, `127.0.0.1`, and `::1` to `NO_PROXY` during the build. It restores the environment values it changed afterward. The two proxy variables you set yourself remain in that shell until you remove them or close it.

Use official upstream sources and verify their identities. Do not disable Defender or the firewall, substitute an unknown download mirror, remove checks, or treat a nonzero build exit as success.

## 4. Optional DOCX Core source reproduction

The source patch targets the official EigenPal DOCX Editor commit recorded in `SOURCES.lock.json`. Its HarfBuzzJS input is also pinned by version and hash.

To inspect the modification, obtain that fixed upstream source and the official matching HarfBuzzJS package, place `dist/harfbuzz.d.ts`, `harfbuzz.js`, `harfbuzz.wasm`, `index.d.mts`, `index.mjs`, and `LICENSE` into `packages/core/src/layout/harfbuzz-runtime/`, check and apply `patches/docx-core-2.33.0-mrw5.patch`, then follow Core's own build and dependency instructions.

The patch-to-source correspondence has been checked. A clean-machine build producing bytes identical to the existing TGZ has not been demonstrated. The normal installation path uses the separately distributed, hash-verified asset.

## 5. Licensing and verification scope

Read [MRW-NC-1.0](LICENSE.en.md), [the source scope](LICENSE-SCOPE.en.md), and the runtime EULA. Pengyu Fu's permitted original noncommercial use is free; commercial exploitation requires prior written permission. Third-party MIT, Apache, LGPL, MPL, GPL, and other rights remain independent. Valid historical MIT grants are not revoked retroactively.

A source overlay, a successful build, and a working installation are different evidence. Check actual exit codes and outputs, and report untested functionality honestly. Building the application does not itself authorize redistribution of restricted proprietary assets. Do not copy private API keys, profiles, sessions, or research data into source or release files.
