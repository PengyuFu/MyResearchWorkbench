# 第三方源码获取 — MyResearchWorkbench 0.12.0 Windows x64

简体中文 | [English](THIRD_PARTY_SOURCE_ACCESS.en.md)

[官方 v0.12.0 Release](https://github.com/PengyuFu/MyResearchWorkbench/releases/tag/v0.12.0) 同时提供 Windows 程序、`MyResearchWorkbench_0.12.0_ThirdParty_Source.zip`、`MyResearchWorkbench_0.12.0_SourceBuildAssets.zip` 及 `SHA256SUMS.txt`。下载源码无需 API 账户或产品激活。请使用同一版本并核对校验值。

## LGPL 库和 Cairo

第三方源码 ZIP 包含 libvips 8.18.7、GLib 2.90.0、FriBidi 1.0.17、libexif 0.6.26、libheif 1.23.5、librsvg 2.63.2、Pango 1.58.2、proxy-libintl 0.5 和 Cairo 1.18.6 的固定上游源码归档，以及 Windows 构建配方、补丁与固定 MXE 工具链源码。准确身份和哈希见包内 `SOURCE_MANIFEST.json`。

程序使用官方 static-web 系列 libvips，以可替换 DLL 的形式链接；其依赖库静态链接在该 DLL 内。构建目标、替换步骤和 Sharp ABI 要求见源码包 `BUILD_AND_REPLACE.md`。GNU GPL/LGPL 原文和原生依赖通知保留在 `licenses/THIRD_PARTY_ORIGINALS/`。

## Electron 和 FFmpeg

源码包 `electron-ffmpeg/` 包含固定 Electron 44.7.0 源码、FFmpeg 补丁、构建说明，以及 Chromium 对应的 FFmpeg 源码提交 `2b68d2babae73714846961fb0ee47e3b3d2e39a9`。程序根目录 `ffmpeg.dll` 与官方 Electron 归档一致。Electron/Chromium 原始通知位于 `LICENSE.electron.txt`、`LICENSES.chromium.html`；LGPL FFmpeg 构建与替换步骤见源码包对应目录。

## LibreOffice Kit（MPL-2.0）

实际分发的 `@deepseek-ai/libreoffice-kit-win32-x64@0.1.5` 保留了 `sources/`、补丁、源码元数据、构建脚本和 `licenses/`。LibreOffice Core 固定提交为 [bce0998afefdbc355585ca324285661a2170ba77](https://github.com/LibreOffice/core/tree/bce0998afefdbc355585ca324285661a2170ba77)，整合源码来自 [deepseek-ai/dsh-libreoffice-kit](https://github.com/deepseek-ai/dsh-libreoffice-kit)。

源码配套包还将实际随程序分发的整合源码和通知作为普通文件放在 `libreoffice-kit/`，无需解包 ASAR 即可阅读。准确上游来源和修改见 `sources/core-source.json` 与 `core-changes.patch`。MPL 覆盖的源码仍遵守 MPL，Workbench 原创许可不限制其既有权利。

## 原生语音库（包含 GPL 覆盖的 eSpeak NG）

Sherpa 1.13.8 Windows DLL 通过 Piper phonemize 包含 eSpeak NG，不能仅用 npm 清单中的 Apache 许可描述整个原生组合。源码包 `speech-native/` 提供固定 Sherpa/eSpeak/Piper、依赖源码、构建配方、MIT Harness 语音 worker 源码、哈希及替换说明。ONNX Runtime 1.28.2 的版权与第三方通知已保留。组件身份、GPL 权利与独立语音进程边界见程序 `licenses/SPEECH_NATIVE_NOTICE.md`。

## Harness、DOCX Core 与其他组件

- [Workbench 公开源码覆盖层](https://github.com/PengyuFu/MyResearchWorkbench/tree/v0.12.0) 固定官方 [Harness](https://github.com/deepseek-ai/deepseek-harness) 提交，并提供完整 DOCX Core 修改补丁。
- [EigenPal DOCX Editor](https://github.com/eigenpal/docx-editor) Core 2.33.0 与 mrw.5 补丁遵守 Apache-2.0；Pro/Editor API 不在本次范围内。
- `licenses/THIRD_PARTY_COMPONENT_NOTICE_INDEX.json` 将补充通知映射到真实组件版本、原始通知和来源证据；已有包级通知保留。
- `licenses/THIRD_PARTY_SOURCE_AVAILABILITY.md` 提供更多组件信息。

所有第三方版权、许可、修改及再分发权利保持独立。MRW-NC-1.0 和专有运行 EULA 仅适用于各自明确的原创范围，不限制 LGPL 组件的修改、替换或调试权利；替换这些 DLL 不需要 Workbench 专有源码。

## 验证范围

源码归档、补丁和固定构建配方随包提供。额外编译器、SDK 和部分宽松许可依赖仍按固定上游配方获取；本包不宣称是完整离线工具链。

此前兼容的官方 libvips DLL 替换已验证图像转换。用户修改源码后完整重建各原生库栈尚未独立执行；源码对应检查不等于这一测试通过，也不等于全面法律认证。中英文说明不替代或改写第三方原始许可证。

缺失源码或许可材料请联系 **fpy19941225@163.com**，说明版本 **0.12.0** 和具体组件。
