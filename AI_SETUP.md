# AI installation guide / AI 安装指南（Windows x64）

本文供开发者及其使用的 Codex、Claude Code、DeepSeek 等编程助手执行。每一步都以文件哈希、构建退出状态及真实程序为依据，不允许自行替换未批准的依赖版本。

## 1. 先核实发行状态

本仓库收录 MyResearchWorkbench 0.12.0 的**源码可见覆盖层**，其依赖版本和运行包均已锁定。源码仓库的可访问性不代表完整 Windows 程序或其专有编译资源已经获准对外分发，也不能仅因构建成功就宣称发布了可下载的正式 Windows 0.12.0 程序。

此仓库采用 **上游代码 + MyResearchWorkbench 修改覆盖层 + 固定来源补丁** 的方式。无需在 GitHub 中复制 DeepSeek Harness、EigenPal DOCX Editor 或第三方二进制的完整源码。

## 2. 确认所需资源

- Windows x64；已安装 Git、Node.js 24（建议 24.21.0）和 Corepack。进入源码仓库的 `overlay` 目录运行 `corepack pnpm --version`，核验固定的 **pnpm 11.28.5**，无需单独安装另一个 pnpm 版本。
- 可访问 `https://github.com/deepseek-ai/deepseek-harness` 和项目使用的 npm/Node/Electron/Python 原始依赖地址。
- 用户已经通过被授权的单独发行渠道取得 **MyResearchWorkbench 0.12.0 源码构建资产包**，并将以下三个文件解压到同一个目录：
  - `docx-editor-core-2.33.0-mrw.5.tgz`（修改后的免费 Apache-2.0 DOCX Core）。
  - `deepseek-ai-dsh-workbench-assistant-0.12.0.tgz`（编译后的专有 Workbench 运行模块）。
  - `LICENSE_PRIVATE_RUNTIME_0.12.0.zh-CN.txt`（专有部分许可协议，必须随构建结果保留）。

**当前尚未发布或验证这些资产的公开下载链接。** 完整 Windows 发行获批准时，应将构建资产 ZIP 与完整 Windows ZIP、第三方对应源码 ZIP 同时提供于同一官方 GitHub Release。若未获得构建资产 ZIP，暂停完整装配并报告缺项。不要从第三方镜像替代文件或尝试生成空白的专有模块。

## 3. 建议交给 AI 执行的操作

把本源码仓库与已批准的源码构建资产包（含两个 `.tgz` 和许可证文件）提供给 AI，要求它：

1. 读取本文件、`SOURCES.lock.json`、`THIRD_PARTY_COMPONENTS.md`。
2. 检查工具环境。不要修改系统代理或浏览器账号，也不要复制本机 API Key、真实会话或个人研究文件。
3. 校验两个资产的 SHA-256；不一致立即停止。
4. 在**新的空目录**中克隆官方 DeepSeek Harness 标签 `dsh-v0.2.2-rc.1`，确认 Git commit 和 tree 都与锁文件一致。
5. 将 `overlay/` 中逐文件校验后的源文件覆盖到上游对应相对位置；把已批准的 DOCX Core tgz 放入 `third_party/docx-editor/`。
6. 仅在当前进程中设置 `MRW_BUILD_MODE=public` 和 `MRW_PUBLIC_RUNTIME_TGZ`，使用 `corepack pnpm install --frozen-lockfile` 安装依赖，再执行 Windows x64 无签名目录打包；构建成功后自动向成品 `licenses/` 复制仓库 `LICENSES/` 的第三方许可证原文与原创许可范围说明。
7. 检查构建退出码、`win-unpacked` 中的 EXE、`resources/app.asar`、资源路径及真正的发行后运行时自检。不要把开发态可运行当作已安装验收。
8. 给出完整的构建结果、未验证项和来源声明；不自动上传 GitHub、生成远端 Release 或发布软件。

这些步骤可以通过 PowerShell 调用已提供的 `assemble.ps1`：

```powershell
# 在本源码仓库根目录中执行，以下两个目录都由操作者自行指定。
.\assemble.ps1 -AssetsDir "D:\Approved-Release-Assets" -Destination "D:\Fresh-Workbench-Build"
```

脚本对缺失、版本或哈希不匹配的文件直接报错；`Destination` 必须事先不存在。上述示例路径仅为用户自选路径格式，不代表已存在的文件夹。

## 4. DOCX Core 的源码复现（可选）

如需核查 DOCX 修改内容：

1. 获取官方 `https://github.com/eigenpal/docx-editor` 的 commit `3cc7bf5d38510940d6e88ffcec4ecff82fd6333e`。
2. 从官方 npm 下载 `harfbuzzjs@1.6.1`，核对锁文件中的 SHA-256，将它的 `dist/harfbuzz.d.ts`、`harfbuzz.js`、`harfbuzz.wasm`、`index.d.mts`、`index.mjs` 与 `LICENSE` 放入上游源码的 `packages/core/src/layout/harfbuzz-runtime/`。
3. 在上游根目录执行 `git apply --check <patch>`，再应用 `patches/docx-core-2.33.0-mrw5.patch`。
4. 按 EigenPal Core 自身的构建工具与锁定依赖生成 Core 包，并核对适用的许可证和 NOTICE。

补丁已通过从固定官方源码还原修改后源码的逐文件核对；**干净机器重新编译产生与现有 tgz 相同字节的验证仍未完成**。正式安装优先使用具有已核验哈希的独立发行资产。

## 5. 权利与发布边界

**Pengyu Fu 有权授权的原创 Workbench 源代码依据 MRW-NC-1.0 允许免费学习、教学和非商业科研；商业使用须取得 Pengyu Fu 事先书面许可。** 必须先读取仓库根 [`LICENSE`](LICENSE) 与 [`LICENSE-SCOPE.md`](LICENSE-SCOPE.md)，不要把源码可见误称为 OSI 开源，也不要把这份非商业限制强加于上游组件。

DeepSeek Harness 的 MIT（完整原文见 `THIRD_PARTY_LICENSES/DeepSeek-Harness-MIT.txt`）、EigenPal 免费 Core 的 Apache-2.0、HarfBuzzJS 的 MIT，以及随运行环境分发的其他第三方许可继续有效。Pro/Editor API 不属于本仓库发行范围。编译后的 Workbench 专有执行模块与其源代码的授权按单独正式条款办理；旧版有效 MIT 授权不追溯撤销。

即使上述技术构建成功，也不意味着使用者可自行发布第三方二进制、取得专有源码授权，或已经通过完整商业分发法律审查。未经软件权利人明确授权，不对外推送、签名或分发此候选。
