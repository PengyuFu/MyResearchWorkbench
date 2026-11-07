---
description: "Workbench AI assistance and editor integration runtime."
kind: "package-reference"
---

# Workbench conversation and selected-text assistant

English | [中文](README.zh.md)

This component connects MyResearchWorkbench writing and development boards with the current DeepSeek Harness conversation and supported editor actions.

## Publicly documented capabilities

- Open an existing workspace file in the writing or development board.
- Inspect selected text or an explicit document context through the current conversation.
- Prepare a reviewable edit proposal and let the user accept or decline it.
- Use supported native Word editing commands with revision and file-target checks.
- Keep the conversation and editor synchronized when switching between boards.

The complete application may include separately licensed components for enhanced natural-language execution. Their source code is not part of the public integration-source distribution. Capability availability depends on the actual release.

## Building and licensing

Developers should use the version-pinned integration instructions provided with the corresponding MyResearchWorkbench source release. The complete runtime package is supplied as a prebuilt dependency when the proprietary module is needed; no internal development assets or reconstructed proprietary sources are required.

The package-level license declaration refers to [LICENSE-MIXED.md](LICENSE-MIXED.md). Existing upstream and third-party notices remain applicable. Access to publicly licensed integration source does not grant an independent redistribution license for proprietary runtime components.

## Limitations

A locally installed runtime bundle may be examined by its recipient. The project does not claim that JavaScript bundling or Electron packaging provides absolute reverse-engineering protection. Full release tests and actual component licenses apply to the distributed version.
