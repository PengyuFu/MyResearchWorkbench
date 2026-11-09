# MyResearchWorkbench 0.12.0

[简体中文](README.md) | English

A Windows x64 research workbench that brings conversations, plans, document writing, code editing, and workspace files together.

## Download and install

Use the official [v0.12.0 Release](https://github.com/PengyuFu/MyResearchWorkbench/releases/tag/v0.12.0). Download the files actually listed there and check their hashes.

| Route | Required downloads | Instructions |
| --- | --- | --- |
| A — Run the Windows application | `MyResearchWorkbench_0.12.0_Windows_x64.zip` and `SHA256SUMS.txt` | Recommended for ordinary users. Verify the archive, extract it completely, and run the EXE. Development installations of Node.js and Python are not required. See [Windows installation](README_WINDOWS.en.md). |
| B — Assemble and build from source | This repository at tag `v0.12.0`, `MyResearchWorkbench_0.12.0_SourceBuildAssets.zip`, and `SHA256SUMS.txt` | Requires Windows x64, Git, Node.js 24, and Corepack. Follow [source installation](AI_SETUP.en.md). |
| Third-party corresponding source | `MyResearchWorkbench_0.12.0_ThirdParty_Source.zip` | Provided with the Windows application in the same release. It contains the covered source archives, patches, fixed build recipes, license notices, and replacement instructions. Building it is not required to run the application. |

GitHub's automatically generated “Source code (zip)” contains the public source overlay. It is neither the Windows application nor the separate source-build asset bundle.

## First use and updates

Select your own workspace and configure a model service/API when you want AI features. Local planning, file access, and code editing do not require an API to be configured first. LaTeX compilation requires a suitable TeX installation.

Word documents are handled by the embedded DOCX editor. This release does not provide a native Word/WPS OLE host.

Version 0.12.0 provides the planning, writing, and development boards and PDF viewing/proofing within the writing workflow. The separate PDF annotation board and literature workflows belong to later versions.

Updates are manual. Keep workspace documents outside the application directory. Preserve and back up the existing user-data locations described in the [Windows guide](README_WINDOWS.en.md). Cross-version migration is to be implemented by a subsequent version; it is not an implemented capability of 0.12.0.

## Source and build assets

- `overlay/`: approved public Workbench source and modifications to the fixed Harness upstream.
- `OVERLAY.manifest.json`: per-file SHA-256 values. The checkout attributes preserve verified source and binary bytes under common Windows Git settings.
- `SOURCES.lock.json`: fixed upstream identities, tool versions, and asset hashes.
- `patches/docx-core-2.33.0-mrw5.patch`: modifications to the free DOCX Core.
- `LICENSES/`: original third-party notices, corresponding-source information, and component mappings.

The source-build asset bundle supplies `docx-editor-core-2.33.0-mrw.5.tgz`, `deepseek-ai-dsh-workbench-assistant-0.12.0.tgz`, and the proprietary runtime EULA. Their fixed hashes and sources are recorded. The proprietary execution implementation is supplied in compiled form; its internal source is not included in this public repository.

## Licensing

**Pengyu Fu's original portions are available without charge for learning, teaching, noncommercial research, and other permitted noncommercial use. Commercial exploitation requires Pengyu Fu's prior written permission.**

Read the full [original-code license in English](LICENSE.en.md) or [Chinese](LICENSE), and the [scope in English](LICENSE-SCOPE.en.md) or [Chinese](LICENSE-SCOPE.md). MRW-NC-1.0 is a noncommercial source-available license and is not an OSI open-source license.

Third-party software retains its original MIT, Apache, LGPL, MPL, GPL, and other licenses, including the commercial-use, modification, source-access, and redistribution rights those licenses grant. Previously valid MIT grants are not revoked retroactively. The separately compiled proprietary runtime is governed by its own EULA. Users retain their rights in their papers, data, code, and other independent results.

See the [bilingual licensing guide](LICENSES/README.md) and [third-party source guide](THIRD_PARTY_SOURCE_ACCESS.en.md).

Licensing contact: **fpy19941225@163.com**.
