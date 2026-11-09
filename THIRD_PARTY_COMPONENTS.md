# 第三方组件与许可边界

简体中文 | [English](THIRD_PARTY_COMPONENTS.en.md)

本公开覆盖层不能替代各上游项目或实际程序内的 LICENSE/NOTICE。

| 组件 | 固定来源 | 许可与通知 | 提供方式 |
| --- | --- | --- | --- |
| DeepSeek Harness | [官方仓库](https://github.com/deepseek-ai/deepseek-harness)，`dsh-v0.2.2-rc.1` | MIT，保留原版权与归属 | 组装时取得固定官方源码 |
| EigenPal DOCX Editor Core | [官方仓库](https://github.com/eigenpal/docx-editor)，`3cc7bf5d38510940d6e88ffcec4ecff82fd6333e` | Apache-2.0，保留版权、许可、修改声明及适用 NOTICE | 上游源码加 mrw.5 补丁，或同版本已批准 Core 包；不含 Pro/Editor API |
| HarfBuzzJS | 官方 npm，1.6.1 | MIT，保留许可及修改声明 | 官方包用于复现补丁；批准的 overlay 也包含随程序使用的 WASM 和许可 |
| Electron / Chromium / FFmpeg | 固定版本见锁文件及源码包清单 | 保留 Electron、Chromium 和原生依赖原始通知；FFmpeg LGPL 对应材料单独提供 | 上游打包流程获取，源码包提供对应资料 |
| Tiptap、CodeMirror、MathLive | overlay 锁文件固定版本 | 各自原始许可及资源通知 | 按锁定依赖安装 |
| LibreOffice Kit | `@deepseek-ai/libreoffice-kit` 与 Windows 载荷 0.1.5 | MPL-2.0，对应源码、修改与通知 | 固定运行依赖，实际随包源码与通知另在配套 ZIP 提供 |
| Sharp Windows | `@img/sharp-win32-x64@0.35.5` | 清单为 Apache-2.0 AND LGPL-3.0-or-later；按实际原生组件保留相应权利 | 上游依赖闭包；libvips 与静态依赖源码、构建配方及替换说明随包提供 |
| 原生语音 | Sherpa 1.13.8、eSpeak NG/Piper、ONNX Runtime 1.28.2 等 | 原生组合含 GPL 组件，不能只按 Apache 描述 | 固定源码、构建资料、MIT worker 和原始通知见源码包及许可索引 |
| Standard Webhooks JavaScript | `standardwebhooks@1.1.1`，[官方来源](https://github.com/standard-webhooks/standard-webhooks/tree/main/libraries/javascript) | npm 库为 MIT（Svix）；独立协议规范标示 Apache-2.0 | 固定 npm 依赖；原文在 `LICENSES/THIRD_PARTY_ORIGINALS/StandardWebhooks-MIT.txt` |
| Python 与 Windows Python 桥接 | 上游固定版本 | 各 Python/原生包的独立许可与通知 | 锁定依赖；不包含用户本机 Microsoft Office |

overlay 中的上游 `THIRD_PARTY_NOTICES.md` 来自其直接依赖及已登记运行成员，不能用作所有传递和原生依赖的完整清单。实际源码和通知获取见 [第三方源码说明](THIRD_PARTY_SOURCE_ACCESS.md) 及 `LICENSES/` 中的组件索引。

**Pengyu Fu 原创部分仅在 [明确范围](LICENSE-SCOPE.md) 内适用 MRW-NC-1.0，允许规定的免费非商业使用；商业利用需事先书面授权。** 第三方 MIT、Apache、MPL、LGPL、GPL 等既有权利保持有效。专有编译执行模块依据独立 EULA，不提供其内部源码。以前具体版本已有效授予的 MIT 权利不追溯取消。

完整程序的专有运行 EULA、原生通知、对应源码及构建/替换资料随本次发行提供。全部适用许可义务仍然有效；仅取得公开源码不意味着获得任意再分发受限专有二进制的授权。
