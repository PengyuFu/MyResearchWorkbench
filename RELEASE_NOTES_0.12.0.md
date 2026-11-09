# MyResearchWorkbench 0.12.0

## 简体中文

Windows x64 完整便携版。普通用户下载 `MyResearchWorkbench_0.12.0_Windows_x64.zip`，核对 `SHA256SUMS.txt`，完整解压后运行 `MyResearchWorkbench.exe`。

本版提供对话/API 配置、计划板、开发板、LaTeX 写作与 PDF 校样、内嵌 DOCX 编辑、终端和工作区文件操作。AI 功能需要用户自己的模型接口；LaTeX 编译需要 TeX。原生 Word/WPS OLE 宿主、0.13.x 独立 PDF 批注板及 0.14.x 文献工作流不属于本版本。

| 文件 | 用途 |
| --- | --- |
| `MyResearchWorkbench_0.12.0_Windows_x64.zip` | Windows 用户程序，包含必要的 Node/Python 运行环境 |
| `MyResearchWorkbench_0.12.0_SourceBuildAssets.zip` | 源码组装所需两份固定 TGZ、运行 EULA 和说明 |
| `MyResearchWorkbench_0.12.0_ThirdParty_Source.zip` | 对应第三方源码、修改/构建资料、原始通知及替换说明 |
| `SHA256SUMS.txt` | 三份 ZIP 的最终 SHA-256 |

[Windows 安装说明](https://github.com/PengyuFu/MyResearchWorkbench/blob/v0.12.0/README_WINDOWS.md) · [源码安装说明](https://github.com/PengyuFu/MyResearchWorkbench/blob/v0.12.0/AI_SETUP.md) · [许可](https://github.com/PengyuFu/MyResearchWorkbench/blob/v0.12.0/LICENSE)

这是未签名的手动更新版本。项目工作区应放在程序目录之外；升级前备份并保留安装说明列明的两处 AppData 和工作区。0.12.0 不提供跨版本自动迁移，后续版本负责兼容已有数据。

Pengyu Fu 原创部分允许免费学习、教学、科研及条款规定的非商业使用；商业利用须事先书面授权。第三方软件保留原始许可权利。原生语音库中的 GPL-covered eSpeak NG 和 Electron/FFmpeg 的 LGPL 对应资料与程序同时提供。

## English

A complete portable application for Windows x64. Download `MyResearchWorkbench_0.12.0_Windows_x64.zip`, verify it using `SHA256SUMS.txt`, extract every file, and run `MyResearchWorkbench.exe`.

This release provides conversations/API configuration, plans, code editing, LaTeX writing and PDF proofing, embedded DOCX editing, a terminal, and workspace file operations. AI features require your own model endpoint; LaTeX compilation requires TeX. A native Word/WPS OLE host, the 0.13.x standalone PDF annotation board, and the 0.14.x literature workflows are outside this version.

| File | Purpose |
| --- | --- |
| `MyResearchWorkbench_0.12.0_Windows_x64.zip` | Windows application, including required Node/Python runtimes |
| `MyResearchWorkbench_0.12.0_SourceBuildAssets.zip` | Two fixed TGZ build inputs, runtime EULA, and assembly instructions |
| `MyResearchWorkbench_0.12.0_ThirdParty_Source.zip` | Corresponding third-party source, modification/build materials, original notices, and replacement instructions |
| `SHA256SUMS.txt` | Final SHA-256 values for the three ZIP archives |

[Windows installation](https://github.com/PengyuFu/MyResearchWorkbench/blob/v0.12.0/README_WINDOWS.en.md) · [Source installation](https://github.com/PengyuFu/MyResearchWorkbench/blob/v0.12.0/AI_SETUP.en.md) · [License](https://github.com/PengyuFu/MyResearchWorkbench/blob/v0.12.0/LICENSE.en.md)

This is an unsigned release with manual updates. Keep project workspaces outside the application directory. Before upgrading, back up and preserve your workspace and both AppData locations specified in the installation guide. Version 0.12.0 does not implement automatic cross-version migration; compatibility with existing data is to be provided by a subsequent release.

Pengyu Fu's original portions are free for learning, teaching, noncommercial research, and other noncommercial uses permitted by the license; commercial exploitation requires prior written permission. Third-party software retains its original licensing rights. Corresponding material for GPL-covered eSpeak NG in the native speech libraries and LGPL-covered Electron/FFmpeg is supplied with the application.

---

源码以 `v0.12.0` 标签为准。GitHub 自动生成的源码 ZIP 是公开覆盖层，源码构建还需要 SourceBuildAssets。

Use source tag `v0.12.0`. GitHub's automatic source ZIP contains the public overlay; a source build also requires SourceBuildAssets.
