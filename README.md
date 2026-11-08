# MyResearchWorkbench

A Windows desktop research workbench integrating a conversational AI interface with writing, development, document editing, and personal planning.

**Source distribution scope:** This repository contains the source-visible MyResearchWorkbench integration overlay, with pinned application package metadata 0.12.0. Repository access does not constitute distribution of a complete Windows application. A complete Windows 0.12.0 binary is not released by this repository.

## Repository layout

- `overlay/` — selected Workbench integration and workspace changes applied to a fixed, upstream DeepSeek Harness source checkout.
- `patches/docx-core-2.33.0-mrw5.patch` — the full free-Core DOCX Editor source delta relative to the pinned EigenPal upstream, with npm HarfBuzz assets supplied separately.
- `SOURCES.lock.json` — immutable source commits, local modified package hashes, and declared build requirements.
- `AI_SETUP.md` — step-by-step instructions suitable for a developer or an AI coding assistant.
- `assemble.ps1` — a minimal Windows assembly and directory-build entry point. It does not change system proxy settings or install software system-wide.
- `THIRD_PARTY_COMPONENTS.md` — key upstream ownership and license boundaries.

The complete DeepSeek Harness repository, third-party source archives, Node.js, Python, Electron, Microsoft Office/WPS, and proprietary runtime source code are **not** checked into this overlay.

## Build prerequisites

Windows x64, Git, Node.js 24 with Corepack (which runs pinned pnpm `11.28.5`), and access to the official upstream sources. Building the currently pinned complete workbench also requires two approved local release inputs:

1. The SHA-256-pinned `@docx-editor.dev/core` `2.33.0-mrw.5` package.
2. The SHA-256-pinned compiled `@deepseek-ai/dsh-workbench-assistant` runtime `0.12.0`.

The compiled assets and the accompanying proprietary-runtime EULA are not part of this source repository. Once the Windows release is authorized, the matching official GitHub Release must offer a separate `MyResearchWorkbench_0.12.0_SourceBuildAssets.zip` containing both approved archives and `LICENSE_PRIVATE_RUNTIME_0.12.0.zh-CN.txt`. **No public download URLs are currently specified**, and a complete build cannot be assembled without these approved assets. See `AI_SETUP.md` and `SOURCES.lock.json`.

## License / 授权

**Pengyu Fu 原创 Workbench 代码：免费学习、教学、非商业科研和非商业使用；商业使用须事先获得 Pengyu Fu 的书面授权。** 适用范围见 [LICENSE-SCOPE.md](LICENSE-SCOPE.md)；完整条款见 [LICENSE](LICENSE)（MRW-NC-1.0）。这是 *source-available*（源码可见）的非商业许可，不能称为 OSI 定义的开源许可证。

**第三方依原许可证**：DeepSeek Harness 和上游文件的 MIT 许可文本已原样保留于 [THIRD_PARTY_LICENSES/DeepSeek-Harness-MIT.txt](THIRD_PARTY_LICENSES/DeepSeek-Harness-MIT.txt)；DOCX Editor Core 是 Apache-2.0，Pro/Editor API 不在发行范围；其他第三方继续使用各自原许可证。对旧版本已经合法授予的 MIT 权利不作追溯撤销。单独编译的专有 Workbench 执行核心仍按其独立许可授权，不随本仓库发布源码。

已整理的第三方原始许可证、NOTICE 与 MPL/LGPL 源码取得说明位于 [`LICENSES/`](LICENSES/)。`assemble.ps1` 构建完成后会将这些公开材料与原创许可范围说明复制到程序旁的 `licenses/`。尚未签发的专有运行模块 EULA 不包含在源码仓库中；完整 Windows 程序与受控编译资源的对外分发另行审核。

The compiled runtime is JavaScript and may be inspected by recipients. Packaging must not be presented as reverse-engineering protection.

No service API credentials or personal documents are supplied. User changes in Word or other editors remain subject to the application's normal confirmation and save behavior.
