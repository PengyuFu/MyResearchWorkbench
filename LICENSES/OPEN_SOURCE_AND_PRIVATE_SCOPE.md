# MyResearchWorkbench 0.12.0 — 组件许可证范围

Copyright (c) 2026 Pengyu Fu. All rights reserved.（限其拥有许可权的原创部分）授权联系邮箱：fpy19941225@163.com。本文件用于标明实际发行候选中各组件的独立权利，不改变第三方原有授权。

## 原创公开源码 — MRW-NC-1.0

**Pengyu Fu 有权授权的 MyResearchWorkbench 原创源码允许免费学习、教学、科研及其他非商业使用；商业使用须事先获得 Pengyu Fu 的书面许可。** 具体文件级范围见源码候选的 `LICENSE-MYRESEARCHWORKBENCH-NC.md` 与 `LICENSE-SCOPE.md`。这一许可属于 *source-available*（非商业源码可见），不属于 OSI 定义的开源许可。

历史上已经向特定代码或版本有效授予的 MIT 权利继续有效；新条款不追溯撤销原接收者的权限。对混合文件仅许可权利人自己的原创贡献，不能以本产品名义修改原上游文件的 MIT 授权。

## 上游与第三方

- **DeepSeek Harness** 原始源码及其已有 MIT 权利：保留原 MIT 版权和许可文本；发行时随附 `THIRD_PARTY_ORIGINALS/DeepSeekHarness-MIT.txt`。
- **EigenPal DOCX Editor Core 2.33.0-mrw.5**：免费 Core 依 Apache-2.0 及第三方通知，现有 MRW 完整文本源补丁应可由源仓库获得；Pro/Editor API 未包含。
- **HarfBuzzJS、Tiptap、CodeMirror、MathLive、Electron、Python**：遵守各自原有条款，具体见实际交付的许可证和构建依赖清单。
- **LibreOffice Kit 0.1.5**：按 MPL-2.0 及所带 sources/licenses/、对应源码可取得要求办理。
- **Sharp Windows 0.35.5 / libvips 8.18.7**：分别遵守 Apache-2.0、LGPL 及其他实际库许可和必要的库替换/源码取得权利。详见 `THIRD_PARTY_SOURCE_AVAILABILITY.md`。

## 专有编译执行组件

`@deepseek-ai/dsh-workbench-assistant@0.12.0` 同时包含源可见契约与独立编译的自然语言执行实现。公开的原创部分遵守 MRW-NC-1.0，专有执行模块按对应版本的独立运行许可；任何源文件的合法第三方 MIT 权利继续有效。

本版本本地候选附 `LICENSE_PRIVATE_RUNTIME_0.12.0_PREPUBLICATION.zh-CN.txt`，**正式对外签发与上传尚未获最终审核**。独立二进制封装不保证反编译不可行；向所选模型/API 提交用户上下文按相应第三方服务条款办理。

用户本人依法享有的论文、数据、图表、代码及其他成果权利不会因软件许可证自动转让；用户成果的商业利用应与软件原创实现本身的商业利用分别判断。
