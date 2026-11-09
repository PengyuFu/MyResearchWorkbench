# 源码安装指南（Windows x64，0.12.0）

[简体中文](#) | [English](AI_SETUP.en.md)

本指南对应官方 `v0.12.0` 标签和同版本发行资产。普通用户建议直接使用 Windows ZIP；本方案供具备开发环境的用户组装编译完整程序。

## 1. 获取相同版本的源码和资产

从 [官方 v0.12.0 Release](https://github.com/PengyuFu/MyResearchWorkbench/releases/tag/v0.12.0) 取得 `MyResearchWorkbench_0.12.0_SourceBuildAssets.zip` 和 `SHA256SUMS.txt`。哈希一致后解压资产 ZIP，目录中应有：

| 文件 | SHA-256 |
| --- | --- |
| `docx-editor-core-2.33.0-mrw.5.tgz` | `ed3568c0cc94acd313b744a1de7a941738fd34c65f297c8136483c4db3940dd8` |
| `deepseek-ai-dsh-workbench-assistant-0.12.0.tgz` | `d11ce8d3b06a9d40dbdc57f4b195c21dec607bbb2c86039f4c41e58169f8efdc` |
| `LICENSE_PRIVATE_RUNTIME_0.12.0.zh-CN.txt` | `005e9919d0093771c438fdf5aeede6f9a294620e0182fbc365087dfc642af1b4` |

源码可使用 Release 的源码 ZIP，或：

```powershell
git clone --branch v0.12.0 --depth 1 https://github.com/PengyuFu/MyResearchWorkbench.git
Set-Location MyResearchWorkbench
```

不要从不明镜像替换文件、生成空白专有模块或跳过校验。

## 2. 环境与网络

需要 Windows x64、Git、Node.js 24（至少 24.9.0，建议 24.21.0）和 Corepack。在源码仓库的 `overlay` 目录执行 `corepack pnpm --version`，应为 **11.28.5**。脚本会在正确目录识别固定版本，不依赖全局 pnpm。

默认使用官方 GitHub、npm、Node.js、Electron 和 Python 依赖来源。直连可用时无需设置代理。使用 HTTP 代理时，在启动构建的同一个 PowerShell 中设置自己的实际端口：

```powershell
$env:HTTP_PROXY = 'http://127.0.0.1:7890'  # 替换为自己的 HTTP 代理地址
$env:HTTPS_PROXY = $env:HTTP_PROXY
$env:NO_PROXY = 'localhost,127.0.0.1,::1'
```

`assemble.ps1` 在设置 HTTP(S)_PROXY 时，为子进程启用 Node 和 Electron 的环境代理支持，并将本机地址排除；结束后恢复脚本调整过的进程环境。仅有系统代理或 ALL_PROXY 不等于所有构建工具都能使用它。Git 如有自己的代理设置，应与选定网络一致。

下载失败时检查失败 URL、网络和证书；保留版本与哈希验证，勿关闭 Defender/防火墙，勿删除失败检查。脚本不再强制指定第三方 Electron 镜像。Windows 常见 `core.autocrlf=true` 由仓库 `.gitattributes` 统一处理，用户无需手动转换文件换行。

## 3. 组装与构建

选择事先不存在的较短目标目录，资产目录与目标目录由自己指定：

```powershell
.\assemble.ps1 -AssetsDir 'D:\MRWAssets' -Destination 'D:\MRWBuild'
```

脚本按顺序校验资产、克隆固定 Harness 标签、核对 commit/tree、校验并应用源码覆盖层、安装锁定依赖、编译、检查并封包。许可材料会复制到成品 `licenses/`；必要资源、API 密钥、用户 profile 不从开发者电脑复制。

成功后的入口是目标目录下的 `MyResearchWorkbench-0.12.0\MyResearchWorkbench.exe`。保留整个程序目录，再按 [README_WINDOWS.md](README_WINDOWS.md) 使用。构建成功的判断包含脚本退出码及真实成品，不能仅看屏幕上的一条“成功”。

失败时保留构建日志，报告具体失败步骤。再次完整组装应使用另一个未存在的目标目录；不要自动删除旧构建、稳定程序或用户数据。

## 4. 对应源码与修改

- Harness：`SOURCES.lock.json` 固定的官方提交；`overlay/` 是批准公开的修改。
- DOCX Core：官方 `eigenpal/docx-editor` 提交 `3cc7bf5d38510940d6e88ffcec4ecff82fd6333e`，应用 `patches/docx-core-2.33.0-mrw5.patch`。HarfBuzzJS 1.6.1 的官方 npm 来源和 SHA-256 也在锁文件中。该修改包属于免费 Apache-2.0 Core，Pro/Editor API 不在范围内。
- 自行复现 DOCX Core 时，将 HarfBuzzJS 的 `dist/harfbuzz.d.ts`、`harfbuzz.js`、`harfbuzz.wasm`、`index.d.mts`、`index.mjs` 与 `LICENSE` 放入上游 `packages/core/src/layout/harfbuzz-runtime/`，先 `git apply --check` 再应用补丁，按上游构建。源码补丁已核对；未宣称不同环境编译结果与现有 TGZ 字节相同。
- 专有执行核心使用固定 TGZ，不包含内部实现源码。已批准公开的 Assistant 合同、类型和集成源码保留。
- libvips/LGPL/MPL 对应源码、固定构建脚本和替换方法随同一 Release 的第三方源码 ZIP 提供。

## 5. 授权与用户数据

Pengyu Fu 原创部分依据 MRW-NC-1.0 免费供学习、教学、非商业科研和其他获准的非商业使用，商用需书面许可。专有原创运行模块依资产包 EULA。第三方的使用、修改和再分发依据原许可证，第三方权利不受原创非商业条款限制；旧有效 MIT 授权不追溯撤销。

程序、工作区和 profile 的保存/更新方法见 Windows 安装说明。跨版本迁移属于后续版本的工作，勿通过删 profile 处理更新问题。
