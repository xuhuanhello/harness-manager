# Harness Manager

Harness Manager 是一个本地优先的桌面应用，用来整理 Agent 技能，并把技能链接或复制到已配置的 Harness 目录。技能内容保存在本机中央库中，来源、分组、Harness 配置和安装关系保存在 SQLite。

项目采用 [MIT 许可证](LICENSE)，目前处于早期版本。Apple Silicon macOS 已完成打包与启动验证；Windows x64 安装包和便携包可构建，实机兼容性仍待验证。

## 安装包

安装包通过 [GitHub Releases](https://github.com/xuhuanhello/harness-manager/releases) 提供。若尚无已发布版本，请按下文从源码运行或构建本地测试包。

- macOS Apple Silicon：DMG 安装包或 ZIP 中的应用。
- Windows x64：`setup.exe` 安装版或 `portable.exe` 便携版。

当前测试包未签名。Windows 便携版默认仍将资料库保存在 `%APPDATA%\harness-manager`，与安装版共用数据位置。自建安装包与隔离测试方法见[打包指南](docs/packaging.md)。

## 功能

- 从 GitHub 仓库、仓库子目录或本地目录扫描 `SKILL.md`，由用户选择技能后导入中央库。
- 以来源、Harness、分组或平铺方式浏览技能；分组用于组织，不决定安装状态。按 Harness 分类只列出中央库管理的安装，外部技能在“Agent Harness”页查看。
- 打开中央技能库或点击“检查更新”时检查来源更新。可更新数量显示在分类方式按钮上，“可更新”视图按来源和目录分组选择要更新的技能；有本地修改的技能默认不选，确认替换后原内容移到废纸篓。
- 将技能应用到用户级或已登记工作区中的 Harness。默认使用软链接；复制是显式选项。
- 在设置中启用或停用 Harness Manager 对各 Harness 的管理。停用会保留已有文件、链接、意图与配置。
- 查看外部技能，并在预览和再次校验后将选定来源迁移到中央库。受管链接可单独预览修复。
- 在应用内浏览 skills.sh 榜单和搜索结果、搜索 SkillsMP，并扫描其 GitHub 来源。其他自定义市场目前作为网站入口保存和打开。

## 快速开始

需要 Node.js 24 或更高版本、npm，以及用于 GitHub 来源扫描的 Git。

```sh
git clone https://github.com/xuhuanhello/harness-manager.git
cd harness-manager
npm ci
npm run dev
```

开发命令会启动 Vite 和 Electron 桌面应用。`npm run dev:renderer` 只启动渲染进程开发服务器，不能代替完整桌面应用：文件访问与应用功能通过 Electron 主进程和 preload IPC 提供。

构建并运行：

```sh
npm run build
npm start
```

检查和测试命令见[开发指南](docs/development.md)。执行 `npm run dist:mac` 可生成 Apple Silicon 的 DMG / ZIP 测试包；在 Windows 执行 `npm run dist:win` 可生成 x64 安装版与便携版 EXE。构建、验证和签名边界见[打包指南](docs/packaging.md)。

## 基本使用

1. 在中央技能库中添加 GitHub 或本地来源，扫描后选择要导入的技能。
2. 可按需创建分组；分组只是管理视图，不会自动安装或卸载技能。
3. 在“应用”流程里选 Harness、用户级或工作区级目标，以及软链接或复制策略。工作区级安装需要选择对应工作目录。
4. 在“Agent Harness”查看托管与外部技能。外部迁移先预览来源及已知引用，再由用户确认。
5. 在设置里配置 Harness 与市场来源。内置 Harness 的兼容路径由注册表维护；自定义市场目前只保存网站地址，不会自动接入该网站的技能 API。

`~/.agents/skills` 是一个需要显式选择的用户级通用目标。应用到某个 Harness 时，写入该工具官方文档当前指定的目录；工具仅为兼容而保留的旧目录（例如 Codex 的 `~/.codex/skills`）只作为读取目录。其他 Harness 若配置为读取通用目录，会显示继承关系，不会因此额外创建安装意图。

## 架构概览

应用使用 Electron + React + TypeScript，按权限和数据职责分层：

- **Renderer（React）**：中央库、Harness、工作区、市场与设置界面，只通过 `window.harness` 发起操作。
- **Preload / IPC**：提供窄接口；主进程 controller 校验请求并协调服务，不向界面暴露任意文件或命令执行能力。
- **主进程服务**：扫描与导入、技能分发、迁移与修复、工具检测、市场适配分别实现。涉及文件修改的预览在执行时再次核对。
- **SQLite + 本地文件库**：SQLite 保存来源、分组、配置和安装关系；中央库保存技能内容，Harness 入口通常通过软链引用它。

典型数据流是「扫描来源 → 选择技能 → 导入中央库 → 选择已启用的 Harness 与作用域 → 预览并应用」。市场提供发现入口，复用同一套扫描和安装流程。启用状态决定是否参与统一管理，停用不会删除已安装的内容。

具体目录、数据模型与失败恢复边界见[架构说明](docs/architecture.md)。

## 文档

- [架构说明](docs/architecture.md)：进程边界、IPC、服务、持久化和文件关系。
- [开发指南](docs/development.md)：代码阅读顺序、本地运行、测试分层和扩展步骤。
- [贡献指南](CONTRIBUTING.md)：提交改动前的工作约定与安全要求。
- [安全问题报告](SECURITY.md)：私密报告漏洞与使用问题的入口。
- [打包指南](docs/packaging.md)：macOS / Windows 构建、验证与 Release 附件。
- [Harness 兼容性研究](docs/research/harness-support.md)：内置目录和检测规则的依据与限制。
- [市场适配器研究](docs/research/marketplace-integration.md)：市场数据接口与适配边界。

## 当前限制

- 文件写入成功不代表目标 Harness 已实际发现或加载技能。部分兼容路径尚未在对应工具的实际发现流程中验证。
- 自定义市场来源仅作为网站入口。应用内目录目前只适配 skills.sh 和 SkillsMP；skills.sh 搜索结果存在上游数量限制，SkillsMP 目前只提供关键词搜索。
- GitHub 来源扫描需要网络和本机 Git。扫描和导入不会执行仓库脚本。
- 外部技能迁移只处理当前配置和已登记工作区中检测到的引用；未登记路径不在自动迁移范围内。
- 尚未提供中央库搬迁、完整数据导出、技能删除和签名安装包流程。应用不会承诺跨多个目录事务具备全有或全无语义。
- Apple Silicon macOS 的未签名 DMG 已完成打包和挂载启动验证；Intel Mac、Windows 与各类 Harness 的实机兼容性仍需持续验证。

更多架构与验证边界请见[架构说明](docs/architecture.md)和[开发指南](docs/development.md)。

## 数据与网络

资料库和技能内容保存在本机。浏览市场、扫描 GitHub 来源和检查 GitHub 更新需要访问对应网站；从本地来源导入不需要上传技能内容。提交问题时请移除个人路径、凭据和私人技能内容。

本项目的许可证只涉及 Harness Manager 自身；导入的 Skill、MCP 服务和第三方依赖保留各自的许可证和使用条件。随应用分发的依赖声明见 [Third-party notices](THIRD_PARTY_NOTICES.md)。
