# MyResearchWorkbench 0.12.0

Windows x64 科研桌面工作台，将对话、计划、写作、代码编辑和工作区文件连接起来。

## 下载与安装

官方发行入口：[v0.12.0 Release](https://github.com/PengyuFu/MyResearchWorkbench/releases/tag/v0.12.0)。以该页面实际列出的附件及校验清单为准；Release 未公开或附件不全时，完整安装资源尚不可用。

| 方式 | 需要取得的文件 | 说明 |
| --- | --- | --- |
| A：直接运行 | `MyResearchWorkbench_0.12.0_Windows_x64.zip`、`SHA256SUMS.txt` | 推荐普通用户使用；校验、完整解压、启动 EXE，无需安装开发用 Node.js 或 Python。见 [Windows 安装说明](README_WINDOWS.md)。 |
| B：源码组装构建 | 本仓库 `v0.12.0` 标签、`MyResearchWorkbench_0.12.0_SourceBuildAssets.zip`、`SHA256SUMS.txt` | 需要 Windows x64、Git、Node.js 24 和 Corepack；运行 [assemble.ps1](assemble.ps1)。详见 [AI_SETUP.md](AI_SETUP.md)。 |
| 第三方对应源码 | `MyResearchWorkbench_0.12.0_ThirdParty_Source.zip` | 与 Windows 包在同一 Release 提供，包含 libvips、LGPL/MPL 依赖源码、固定构建脚本和替换说明；运行程序无需先编译它。 |

GitHub 自动生成的 “Source code (zip)” 是本仓库源码覆盖层，并非 Windows 程序，也不包含源码构建资产包。

## 首次使用与更新

启动后选择自己的工作区，按需要配置模型服务/API。API 服务和 TeX 环境按具体功能配置，各自授权和费用独立。Word 文档通过内嵌 DOCX 编辑器处理，本版不提供原生 Word/WPS OLE 宿主。已有的本地编辑、文件和计划功能不要求模型 API 先配置完成。

0.12.0 使用手动更新。工作区文档与用户 profile 应保留在程序目录之外。跨版本自动迁移由后续版本实现，0.12.0 不承诺已具备这一迁移能力；升级前按 [Windows 安装说明](README_WINDOWS.md) 备份并保留原 profile。

0.12.0 的功能包括计划板、写作板、开发板及其 PDF 预览/阅读能力；独立 PDF 板和后续文献功能属于后续版本。

## 源码与编译资源

- `overlay/`：批准公开的 Workbench 源码和固定 Harness 上游文件的修改。
- `OVERLAY.manifest.json`：覆盖层逐文件 SHA-256；`.gitattributes` 固定相关文本 LF，适用于 Windows 常见 Git 换行配置。
- `SOURCES.lock.json`：上游提交、工具版本和资产哈希。
- `patches/docx-core-2.33.0-mrw5.patch`：免费 DOCX Core 的完整修改。
- `LICENSES/`：第三方原始通知、对应源码入口及组件映射。

源码构建资产包提供 `docx-editor-core-2.33.0-mrw.5.tgz`、`deepseek-ai-dsh-workbench-assistant-0.12.0.tgz` 和专有运行 EULA。两份 TGZ 均有固定来源与哈希；专有运行模块以编译形式提供，其内部源码不在公开仓库中。

## 授权

**Pengyu Fu 原创部分允许免费学习、教学、科研和非商业使用；未经 Pengyu Fu 事先书面许可，不得商业利用。** 范围见 [LICENSE-SCOPE.md](LICENSE-SCOPE.md)，条款见 [LICENSE](LICENSE)。MRW-NC-1.0 是源码可见的非商业许可，不属于 OSI 开源许可。

第三方组件依原始 MIT、Apache、LGPL、MPL 等许可证授权，第三方本身允许的使用、修改、再分发与商用权利保持有效；旧版已有效授予的 MIT 权利不追溯撤销。完整程序中的专有原创执行模块依随包 EULA 授权。用户自己的论文、数据和代码不因使用本软件而改变权属。

授权联系：fpy19941225@163.com。发布包不包含用户 API Key、账号配置或研究文件。
