# MyResearchWorkbench — 代码授权范围 / License scope

This repository contains **source-visible, noncommercial original Workbench code** and independently licensed third-party code. The original Workbench portions are **not OSI open-source software** because their license restricts commercial use.

许可方：**Pengyu Fu**。授权联系邮箱：**fpy19941225@163.com**。适用于 Pengyu Fu 拥有权利的原创部分；**非商业学习、教学与科研免费，未经 Pengyu Fu 事先书面许可不得商业利用**。

## 1. 本仓库原创源码的授权范围

下表中的文件路径相对于本仓库的 `overlay/`。仅对 Pengyu Fu 有权授权的原创部分适用 [MyResearchWorkbench 原创代码非商业许可](LICENSE-MYRESEARCHWORKBENCH-NC.md)（MRW-NC-1.0）：

| 目录 | 原创内容范围 | 例外 |
| --- | --- | --- |
| `packages/client/ui-workbench/` | Workbench 写作板、开发板与文档交互原创实现、样式、测试、说明 | `licenses/docx-editor/` 内第三方 Apache/MIT/NOTICE 文件，以及嵌入或引用的第三方代码 |
| `packages/client/ui-personal-plan/` | 个人计划板原创客户端、样式、测试、说明 | 独立授权的第三方部分 |
| `packages/plan/personal-plan/` | 计划与任务原创逻辑、测试、说明 | 独立授权的第三方部分 |
| `packages/workspace/workbench-word/` | Word 工作区原创桥接与处理逻辑、测试、说明 | Office/WPS 等外部软件及第三方组件 |
| `packages/workspace/workbench-workspace/` | 工作区文件及构建整合原创代码、测试、说明 | 独立授权的第三方部分 |
| `packages/context/workbench-assistant/` | **已批准公开的** Assistant 合同、类型和集成部分 | `src/internal/**` 和编译 `private-runtime.js` 是单独的专有授权；历史 MIT 权利不追溯取消 |

以上六个软件包是本 Workbench 在所锁定的纯 Harness 上游快照之外新增的组件；各包内包含与第三方系统通信的适配代码，适配代码的原创部分受本协议保护，外部系统及库自身权利不受影响。

此外，以下是新增到原有 Harness 包中的 **Workbench 独立原创文件**。尽管其父软件包原有源码保留 MIT，下面明确列出的文件中属于 Pengyu Fu 的原创部分采用 MRW-NC-1.0：

- `apps/desktop/src/mrw-data-roots.ts`、`apps/desktop/src/quit-document.ts`，以及对应的 `tests/mrw-data-roots.spec.ts`、`tests/quit-document.spec.ts`。
- `apps/web/mathlive-fonts.ts`（仅 Workbench 的字体资源装配逻辑，MathLive 字体自身保留原授权）。
- `packages/client/ui-sidebar-documentpreview/src/client/pdf/` 下的 `LazyWorkbenchPdf.tsx`、`LazyWorkbenchPdf.module.css`、`WorkbenchPdf.tsx`、`WorkbenchPdf.module.css`、`workbench-contract.ts`。
- `packages/client/ui-sidebar-terminal/src/client/workbench-contract.ts`。
- `scripts/mrw/prepare-owned-assets.ts`、`scripts/mrw/runtime-build.ts`、`scripts/mrw/runtime-build.spec.ts`。
- `scripts/primary-runtime/word-bridge.ts`：Workbench 原创 Windows Word 桥接依赖准备逻辑；`scripts/primary-runtime/word-bridge.lock.json`：第三方 `pywin32` 的版本、官方来源和 SHA-256 锁定数据。原创逻辑遵守 MRW-NC-1.0，`pywin32` 软件及其许可证不受此条限制。

这些精确文件的原创内容才属于本条范围；同包原有的第三方文件及其 MIT 权利不受影响。JSON 锁文件、第三方源码与打包补丁等保留原本数据和权利边界。

## 2. 不受原创非商业限制覆盖的代码

- **DeepSeek Harness 上游原有文件、其 MIT 代码和独立的上游改进**：MIT；保留上游版权与许可文本 [THIRD_PARTY_LICENSES/DeepSeek-Harness-MIT.txt](THIRD_PARTY_LICENSES/DeepSeek-Harness-MIT.txt)。
- `overlay/` 中基于 Harness 上游的其他修改文件：对其中已有的 MIT 代码继续适用 MIT；不以“覆盖文件”名称推定所有权或限制其商业使用。若将来需单独授权其中的新增原创片段，应先识别具体贡献。
- DOCX Editor Core 的原始源码及 `patches/docx-core-2.33.0-mrw5.patch` 中涉及的 EigenPal/第三方部分：遵守 Apache-2.0 及各自许可，须保留 NOTICE 和修改声明。
- 通过 npm、Python、Electron、LibreOffice、Sharp、CodeMirror、Tiptap、MathLive 等渠道取得的第三方代码、二进制和内容：遵守各自许可证。
- 被保留为内部资产的原创执行策略及专有运行模块：仅依据单独正式发行的许可条款提供，不随本公开源码自动授权。

## 3. 历史 MIT 许可证

已有版本中若对具体原创代码作出了**有效的 MIT 授权**，原接收者仍可依据该版本既有 MIT 条款使用（包括商用）。MRW-NC-1.0 对未来授权版本生效，不以更改包的 `license` 字段追溯撤销此前授权。

## 4. 不以仓库根 LICENSE 统一改写第三方权利

仓库根 `LICENSE` 是 Pengyu Fu **原创部分**的 MRW-NC-1.0 条款。已指定目录以外的文件不因同处一个 GitHub 仓库就自动受非商业限制；每个组件的独立 LICENSE、NOTICE 和真实来源优先。第三方许可仍允许的商业活动，不受本协议限制。

产品使用者依法拥有的论文、数据、图表和代码等独立成果不因 MRW-NC-1.0 被许可方取得权利；成果本身的商业利用与软件原创实现的商业利用应分别判断。

**Distribution scope:** This document scopes the identified source contributions only. It does not authorize distribution of the private runtime or a complete Windows application; each third-party license remains independently effective.
