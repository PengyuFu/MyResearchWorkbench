# Third-party license texts, source availability and notice inventory

**Scope:** MyResearchWorkbench 0.12.0 Windows x64 pre-release, incorporating DeepSeek Harness dsh-v0.2.2-rc.1, a modified DOCX Editor Core 2.33.0-mrw.5 and the separately compiled Workbench assistant runtime 0.12.0. The component list must be reconciled against the *actual final installed application*, not assumed from build-time lockfiles.

## DeepSeek Harness and Workbench public-source overlay

- Original source: https://github.com/deepseek-ai/deepseek-harness
- Pinned upstream commit: `66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db`, tag `dsh-v0.2.2-rc.1`.
- Original MIT copyright, license and the generated THIRD_PARTY_NOTICES.md are preserved, including nested license attribution.
- Pengyu Fu original Workbench source additions are available for noncommercial use under MRW-NC-1.0, with commercial use requiring Pengyu Fu's prior written authorization. Existing DeepSeek Harness MIT components retain MIT and prior valid MIT grants remain effective; the independently compiled proprietary runtime has its own license.

## EigenPal DOCX Editor Core

- Original source: https://github.com/eigenpal/docx-editor
- Pin: `3cc7bf5d38510940d6e88ffcec4ecff82fd6333e`, free Core `2.33.0`.
- Core license: Apache-2.0; modification NOTICE and bundled third-party notices are provided unaltered except for accurate `mrw.5` version and modification descriptions.
- Source modifications: full text-only `mrw.5` patch from the separately reviewed source repository, SHA-256 `7b162e9b5895e30068d5a832251404f69bc673c9fdea2ad94ce6908994950283`. Free Core patch + official npm `harfbuzzjs@1.6.1` reproduces 3,858 target source files byte for byte.
- No commercial Pro/Editor API source files are included in the public overlay. Distributing the full upstream repository is unnecessary for users who retrieve it from the official source.

## LibreOffice Kit — MPL-2.0

- Installed `@deepseek-ai/libreoffice-kit@0.1.5` and `@deepseek-ai/libreoffice-kit-win32-x64@0.1.5`, original source https://github.com/deepseek-ai/dsh-libreoffice-kit .
- The actual platform package contains `sources/core-source.json` with LibreOffice Core revision `bce0998afefdbc355585ca324285661a2170ba77`, engine source recipes and patches including `sources/core-changes.patch`, a `prebuilds.json` integrity inventory and `licenses/LibreOffice-MPL-2.0.txt`, `licenses/LibreOffice-third-party.html`, `licenses/DeepSeek-Harness-MIT.txt`.
- Original source of the LibreOffice Core: https://github.com/LibreOffice/core/tree/bce0998afefdbc355585ca324285661a2170ba77 .
- **Shipping rule:** preserve the complete selected Windows engine package, including `sources/`, `licenses/`, `prebuilds.json` and modification documentation. Inform users where corresponding MPL-licensed source and modified files may be obtained. The MPL applies to relevant files, not the whole independent proprietary application.
- The original `@deepseek-ai/libreoffice-kit/LICENSE` and NOTICE are copied with original bytes into `THIRD_PARTY_ORIGINALS/`; executable availability alone does not replace the MPL source-availability requirement.

## Sharp Windows and libvips — Apache plus LGPL

- Installed `@img/sharp-win32-x64@0.35.5`, license field `Apache-2.0 AND LGPL-3.0-or-later`.
- The actual Windows package contains `sharp-win32-x64-0.35.5.node`, `libvips-42.dll` and `libvips-cpp-8.18.7.dll`. Its `versions.json` declares libvips `8.18.7` and versions of included image-processing libraries.
- Source and build recipes: https://github.com/lovell/sharp , https://github.com/lovell/sharp-libvips , libvips source: https://github.com/libvips/libvips/releases/tag/v8.18.7 . The Sharp license and dependency license list are preserved in `THIRD_PARTY_ORIGINALS/Sharp-Windows-*`.
- GNU official LGPL/GPL texts are present in `THIRD_PARTY_ORIGINALS/GNU-LGPL-3.0.txt` and `GNU-GPL-3.0.txt`. License texts: https://www.gnu.org/licenses/lgpl-3.0.html and https://www.gnu.org/licenses/gpl-3.0.html .
- **Shipping rule:** retain bundled third-party copyright and license notices and make the corresponding source code for conveyed LGPL-covered libraries available under the applicable terms. Do not contractually prohibit users' LGPL rights to debug or modify those libraries, including applicable library replacement/relinking. Confirm that the actual final signed/unpacked application preserves the DLLs as interface-compatible replaceable libraries and the linked source availability, or comply through another LGPL-permitted method. A package license field alone does not prove full binary compliance.

## Standard Webhooks JavaScript module — MIT

- The **actually packaged** `standardwebhooks@1.1.1` JavaScript module declares `MIT` in its package.json; the distributed source repository `libraries/LICENSE` (Git blob `55b14b3a3ce649a2f1b05428dcc9c6db95b37c04`) is the MIT text naming Svix as copyright holder.
- The upstream **Standard Webhooks specification** is separately labeled `Apache-2.0`; its license must not be substituted for the JavaScript library license. The matching original MIT text is distributed as `THIRD_PARTY_ORIGINALS/StandardWebhooks-MIT.txt`.
- Source location: `https://github.com/standard-webhooks/standard-webhooks/tree/main/libraries/javascript`; the npm package version and actual installed file list remain the controlling evidence for a particular release.

## Other Windows native packages

The current production runtime also includes `sherpa-onnx-win-x64@1.13.8` (native ONNX Runtime DLLs and `sherpa-onnx` binaries) and `@koromix/koffi-win32-x64@3.1.1`. The initial package-level license inventory identifies Apache-2.0 and MIT respectively; verify their actual native subordinate licenses/NOTICE when constructing the final complete application.

## Packages with no *root-level* LICENSE file

The source runtime audit identified 21 packages with no separate root-level `LICENSE`, `COPYING` or `NOTICE`. This is an inventory finding, not a legal violation. The packages' exact names, versions, SPDX declarations, repositories, and publication status are recorded in the internal license-coverage matrix. Direct/indirect licenses retained by upstream source repositories and the actual app's aggregate THIRD_PARTY_NOTICES must be considered together. A final recipient package should present sufficient copyright/permission notices for every actually redistributed component.

## Source of this notice

This source-availability statement is independently drafted from the exact installed packages and their official source locations. The copies of third-party license texts in `THIRD_PARTY_ORIGINALS` remain under the respective upstream licenses. Any unresolved legal owner, native redistribution and linking interpretation must be cleared before publication.
