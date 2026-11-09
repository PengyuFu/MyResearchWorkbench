# MyResearchWorkbench 0.12.0 — Windows x64

[简体中文](#) | [English](README_WINDOWS.en.md)

## 取得、校验与启动

1. 从 [官方 v0.12.0 Release](https://github.com/PengyuFu/MyResearchWorkbench/releases/tag/v0.12.0) 下载 `MyResearchWorkbench_0.12.0_Windows_x64.zip` 和 `SHA256SUMS.txt`。第三方对应源码 ZIP 同页提供。
2. 在 PowerShell 执行下面的命令，将结果与同一 Release 的清单逐字核对。哈希不一致时重新取得文件，勿继续运行。
3. 把整个 ZIP 解压到可写、便于管理的新目录；保留全部文件和子目录。
4. 启动目录中的 `MyResearchWorkbench.exe`，选择自己的工作区，按需配置模型服务/API。

```powershell
Get-FileHash -Algorithm SHA256 .\MyResearchWorkbench_0.12.0_Windows_x64.zip
```

完整包附带必要的 Node/Python 运行环境，用户无需另装开发工具。请保持目录完整，不单独搬走 EXE。若长路径导致外部工具报错，可先选较短的解压目录。此版本为未签名便携包；遇到发布者提示时先确认官方来源与哈希，保留系统安全防护。

## 功能依赖

- 本地计划、工作区文件与代码编辑不要求模型 API 先配置。
- AI 对话和协助需要自行配置可用的模型接口；网络、额度和费用由所选服务决定。
- LaTeX 编译需要用户安装合适的 TeX 环境。缺少 TeX 时，可继续使用其他不依赖它的功能。
- Word 文档通过内嵌 DOCX 编辑器处理；本版不提供原生 Word/WPS OLE 宿主。
- 0.12.0 包括写作板内 PDF 预览/阅读能力；后续版本新增的独立 PDF 板、文献工作流不属于此包。

## 用户数据、重启与升级

把文档和项目工作区放在自己选择的独立目录，不放进软件解压目录。0.12.0 的默认应用状态和配置位于：

- `%APPDATA%\MyResearchWorkbench\0.12.0\electron`
- `%LOCALAPPDATA%\MyResearchWorkbench\0.12.0\home`

普通重启或搬动同版本程序目录时，应继续使用同一 Windows 用户及原 profile。自定义环境或显式 profile 参数可能改变数据位置，使用者应一并保留这些设置。

更新前关闭软件，备份自己的工作区和以上两个用户目录。把新版解压到新目录并阅读该版迁移说明；确认项目和状态恢复后，再整理旧程序目录。不要删除旧 profile，也不要把“清理缓存/重装”作为找回项目的方法。

**跨版本恢复兼容将由后续版本提供。0.12.0 未实现也未承诺跨版本自动迁移。** 本版本使用手动下载更新，未连接自动更新服务。普通重启可恢复的证据不能替代未来版本的升级验收。

## 许可、源码与隐私

本目录 `licenses/` 包含原创许可、专有运行 EULA 和第三方原始通知。第三方对应源码及 DLL 替换说明见 `THIRD_PARTY_SOURCE_ACCESS.md` 和同一 Release 的第三方源码包。第三方授权保持独立，原创非商业许可不覆盖其原有权利。

使用外部 AI 接口时，为完成操作所需的内容可能发送到所配置的服务商。分享错误日志前先去除 API Key、账号信息和私人文档路径。

源码：https://github.com/PengyuFu/MyResearchWorkbench
授权联系：fpy19941225@163.com
