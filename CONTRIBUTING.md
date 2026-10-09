# 贡献指南

感谢参与 Harness Manager。项目采用 [MIT 许可证](LICENSE)。提交功能请求、问题报告或 Pull Request 前，请先阅读以下约定。

## 提交改动的流程

1. 先阅读[架构说明](docs/architecture.md)和[开发指南](docs/development.md)，确认修改属于哪个进程、服务或 UI 层。
2. 问题报告请说明预期行为、实际行为、复现步骤和相关操作系统。避免附带本机目录、用户数据、访问令牌或私人仓库内容。
3. 将改动保持在一个清楚的目标内。涉及 IPC 时，按[开发指南](docs/development.md#新增或修改-ipc-动作)更新动作列表、契约和路由；preload 与界面类型会自动得到新方法。行为变更和纯重构分开提交。
4. 使用临时 library/profile 根目录、临时工作区和 mock 外部效果编写测试。不要让测试扫描、安装、迁移或清理维护者的真实技能目录。
5. 运行与改动相关的检查。通常包括：

   ```sh
   npm run lint
   npm run build
   npm test
   npm run test:e2e
   ```

   如果某项无法运行，请在提交说明中写清环境和原因，不要把未执行描述为通过。

6. 从最新 `main` 建立主题分支，提交并推送后向 `main` 发起 Pull Request：

   ```sh
   git clone https://github.com/xuhuanhello/harness-manager.git
   cd harness-manager
   git switch -c codex/your-change
   # 完成修改与验证后
   git add <changed-files>
   git commit -m "Describe the change"
   git push -u origin feat/your-change
   ```

   已有本地仓库时，先同步 `main` 再创建分支；以上命令仅示意流程。PR 使用仓库模板，说明用户可见行为、设计选择、验证结果和未验证的平台。等待 CI 和维护者复核，按反馈修改；合并后删除主题分支。CI 在 macOS 上执行 lint、构建、服务测试和 Electron 端到端测试。

   外部贡献者请先 fork 仓库，再在自己的 fork 建立分支并提交 PR。

## 源码与产物

- Git 跟踪源码、测试、锁文件、维护中的文档与打包需要的图标。
- `test-results/`、`artifacts/`、`reports/`、本地资料库与内部工作记录不提交。测试截图和 traces 使用 GitHub Actions artifacts 留存。
- `release/` 和安装包不提交到源码分支；经过验证的安装包作为 GitHub Release 附件发布。
- 不提交 `.env`、API token、签名证书、私人邮箱、个人绝对路径或真实用户技能内容。

## 工程约定

- 文件系统与 SQLite 操作留在 Electron 主进程。Renderer 通过 `window.harness` 调用 preload 提供的窄 API，不直接获得 Node 权限。
- 外部输入在 IPC 契约处校验一次，服务只保留规范化和领域规则（路径包含、归属、重名、内置规则锁定等）。预览结果在执行时重新核对路径、内容、引用和状态；不要把 renderer 的判断当作安全边界。
- 主进程的错误和操作结果文案放在 `src/main/messages.ts`，以错误码区分；代码和测试比较错误码，不匹配文案。
- 改变已存储数据的格式时追加数据迁移，不修改已发布的迁移。
- 不覆盖无法确认由应用管理的文件，不对复制策略静默降级，不执行从技能仓库或市场页面下载的脚本。
- Harness 兼容规则集中维护在共享注册表。清楚区分显式管理路径、兼容读取路径和实际安装状态；目录存在本身不代表工具已安装或发现技能。
- 对涉及多步文件写入的功能，考虑记录操作阶段、重复执行、失败回滚/恢复和停用 Harness 的保护。跨目标文件操作不可假定具备数据库式原子性。
- 市场适配器应使用固定可信上游地址，校验响应结构并限制请求时间、响应大小和重定向；不能把任意 URL 请求能力暴露给 renderer。
- 用户文档以中文撰写，描述经过源码或实机验证的行为，并明确未验证的范围。
- 代码格式由 Biome 统一，提交前可运行 `npm run format`。

## 测试原则

主进程服务测试位于 `tests/`，Electron 桌面流程测试位于 `tests/e2e/`。优先在相关服务测试中覆盖输入校验、共享路径、状态变化、文件冲突、部分失败和恢复；需要验证 preload/IPC/界面贯通时再增加端到端流程。

测试应使用临时文件夹和可注入的命令、HTTP 响应、系统废纸篓回调。不要以本机存在某个 Agent、个人目录可写或真实网络接口始终稳定作为普通测试通过条件。

## 许可证与发布

提交的贡献按项目的 [MIT 许可证](LICENSE) 提供。提交前请确认有权贡献相关代码；第三方代码和素材必须保留原许可与版权声明。本地测试包、签名与发布边界见[打包指南](docs/packaging.md)。
