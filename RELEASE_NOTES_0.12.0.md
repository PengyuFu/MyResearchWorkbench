# MyResearchWorkbench 0.12.0

Windows x64 完整便携程序。普通用户下载 `MyResearchWorkbench_0.12.0_Windows_x64.zip`，核对 `SHA256SUMS.txt`，解压后运行 `MyResearchWorkbench.exe`。具体配置和数据位置见 [Windows 使用说明](README_WINDOWS.md)。

本版本提供对话与 API 配置、计划板、代码开发板、LaTeX 写作与 PDF 校样、嵌入式 DOCX 写作、终端及工作区文件操作。API 服务需用户自行配置；LaTeX 编译需要本机 TeX 环境。原生 Office/WPS 的能力取决于用户本机安装和所选模式。0.13.x 独立 PDF 阅读/批注板、0.14.x 文献工作流不属于本版本。

## 下载文件

- `MyResearchWorkbench_0.12.0_Windows_x64.zip`：普通 Windows 用户程序。
- `MyResearchWorkbench_0.12.0_SourceBuildAssets.zip`：按 [源码安装说明](AI_SETUP.md) 组装所需的固定 DOCX Core 和专有执行组件、EULA；不包含专有实现源码。
- `MyResearchWorkbench_0.12.0_ThirdParty_Source.zip`：对应第三方源码、修改/构建配方、工具链信息、许可证与替换说明。
- `SHA256SUMS.txt`：以上三份 ZIP 的 SHA-256。

源码以 GitHub `v0.12.0` 标签为准。GitHub 自动生成的 Source code 归档包含公开覆盖层；源码构建还需要 SourceBuildAssets，不能将其当作完整 Windows 程序。

## 发行说明

已处理 Windows Git 换行符、固定 pnpm 识别、受支持的代理/localhost 设置以及 DOCX 运行资源问题。生成的工作台及检查器脚本不再带开发机绝对目录。构建继续校验固定资源，不需要关闭 Defender 或防火墙。

这是未签名的便携版；没有自动更新服务。用户项目应放在程序目录之外。手动更新前备份并保留 README_WINDOWS.md 指定的 profile、Host 数据目录及工作区；不要把后续版本自动恢复说成 0.12.0 已实现的功能，后续版本负责迁移这些现有数据。

Pengyu Fu 的原创部分允许免费学习、科研及其他非商业使用；商业利用须取得书面许可。第三方分别遵守原始 MIT、Apache、LGPL、MPL、GPL 等条款，相关权利不受原创非商业许可限制。Sherpa 原生语音库包含 GPL-covered eSpeak NG，其源码和构建资料与程序同时提供，详见 [第三方源码说明](THIRD_PARTY_SOURCE_ACCESS.md)。

若本 Release 尚未公开，或上述文件未全部可取得，则公开下载与源码安装入口尚未开放。发布后请以实际下载内容和校验文件为准。
