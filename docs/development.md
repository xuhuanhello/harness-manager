# 开发指南

本文面向本地开发、代码阅读和功能扩展。架构边界见[架构说明](architecture.md)；贡献和提交流程见[贡献指南](../CONTRIBUTING.md)。

## 环境与启动

需要 Node.js 24 或更高版本、npm 和 Git。GitHub 来源扫描会调用本机 Git；普通单元测试通常使用临时目录，不需要访问真实 Harness 路径。

```sh
npm ci
npm run dev
```

`npm run dev` 先构建 Electron 主进程和 preload，再启动本地 Vite renderer 并打开 Electron。单独运行 `npm run dev:renderer` 只适合检查静态界面；不提供真实 preload、文件访问或 IPC 服务。

完整构建与运行：

```sh
npm run build
npm start
```

`npm run build` 执行类型检查、Vite renderer 构建和 Electron 主进程/preload 打包。打包与分发步骤见 [`packaging.md`](packaging.md)。

构建还会根据安装的生产依赖和锁文件生成 `THIRD_PARTY_NOTICES.md`，安装包包含该文件及项目的 `LICENSE`。变更依赖后请提交锁文件和更新后的第三方许可声明。

主进程或 preload 修改后需要重启开发命令；renderer 由 Vite 热更新。端到端测试使用 `dist`，因此修改源码后应先构建。

macOS 默认数据根目录是 `~/Library/Application Support/harness-manager/library`。隔离开发数据时可设置：

```sh
HARNESS_PROFILE_ROOT=/tmp/hm-profile \
HARNESS_LIBRARY_ROOT=/tmp/hm-library \
npm run dev
```

`HARNESS_PROFILE_ROOT` 隔离 Electron profile，`HARNESS_LIBRARY_ROOT` 指定 SQLite 和技能内容库根目录。请为每个测试或实验使用独立临时目录，不要把实验指向平时使用的技能库、用户级 Agent 目录或真实工作区。

Windows 默认数据根目录是 `%APPDATA%\harness-manager\library`。PowerShell 的隔离环境变量与 EXE 打包步骤见[打包指南](packaging.md#windows-构建)。

## 代码阅读顺序

建议按数据边界从外向内阅读：

1. `src/shared/types.ts`、`src/shared/ipc-contract.ts`：共享数据模型，以及每个 IPC 动作的输入 schema 和输出类型。
2. `src/main/index.ts`、`src/main/preload.ts`：Electron 窗口、安全配置、IPC 与受限桥接。
3. `src/main/controller.ts`、`src/main/routes.ts`：契约校验、操作队列，以及每个动作对应的服务调用。
4. `src/main/services.ts`、`src/main/store.ts`、`src/main/migrations.ts`、`src/main/journal.ts`：组合根、SQLite 记录存储、数据迁移和操作日志。
5. `src/main/library.ts`、`src/main/updates.ts`：技能扫描、导入与来源更新。
6. `src/main/harness-config.ts`、`src/main/targets.ts`、`src/main/distribution.ts`、`src/main/entries.ts`、`src/main/health.ts`：Harness 配置、目标解析、应用与移除、入口检查和健康检查。
7. `src/main/external-skills.ts`、`src/main/migration.ts`、`src/main/migration-executor.ts`、`src/main/repair.ts`、`src/main/harness-installation.ts`：外部技能、迁移、受管链接修复、安装检测与安全清理。
8. `src/shared/harness-registry.ts`、`src/shared/harness-fields.ts`、`src/shared/harness-paths.ts`：内置兼容声明、Harness 字段分组及统一路径计算。
9. `src/main/marketplaces.ts`、`src/main/marketplace-catalog.ts`：市场入口持久化和固定上游适配器。
10. `src/renderer/App.tsx` 及 `hooks/`、`pages/`、`dialogs/`、`components/`：用户交互与状态呈现。

## 新增或修改 IPC 动作

1. 在 `src/shared/ipc-actions.ts` 的 `ACTIONS` 中加入动作名。
2. 在 `src/shared/ipc-contract.ts` 中写输入 schema 和输出类型。长度、数量等限制使用 `src/shared/limits.ts` 中的常量。
3. 在 `src/main/routes.ts` 中加入路由：写处理函数，并声明 `queue`（读写 SQLite 状态时用 `state`）和 `mutates`（完成后是否通知界面刷新）。

漏掉任何一步都会编译失败。preload 和 renderer 的 `window.harness` 类型会自动得到新方法，不需要手写。输入形状只在契约里校验，服务里不要重复检查，只保留规范化和领域规则。在 `tests/ipc-contract.test.ts` 中更新队列和刷新行为的断言。

## 错误文案

主进程抛出的错误和返回给界面的操作结果文案都放在 `src/main/messages.ts`，用 `appError(code, params)` 抛出，用 `message(code, params)` 取得文本。不要在 `src/main` 里直接 `throw new Error('…')`；`tests/messages.test.ts` 会检查这一点，并确认每条文案都是中文。测试应断言错误码（例如 `rejects.toMatchObject({ code: 'SCAN_EXPIRED' })`），不要匹配文案。

## 修改数据格式

改变已存储记录的格式时，在 `src/main/migrations.ts` 末尾追加一个迁移，版本号加一。已发布的迁移不能修改。迁移函数在事务中执行，应当可以处理旧版本写入的任何记录；启动时会先备份非空的库。在 `tests/store-migrations.test.ts` 中用旧格式的记录验证升级结果。

注册表中的内置 Harness 规则不需要迁移：`HarnessConfigService.syncBuiltins` 每次启动都会把注册表同步到已存储的记录。

## 测试与检查

```sh
npm run lint
npm run build
npm test
npm run test:e2e
```

- `npm run lint` 使用 Biome 检查格式和代码规则；`npm run format` 自动修正格式和可安全修复的问题。CI 会运行 lint。
- `npm run typecheck` 检查整个 TypeScript 项目。
- `npm test` 使用 Vitest 执行主进程服务的单元与集成测试，覆盖临时 SQLite 库、临时技能目录、软链接、哈希校验、恢复和失败路径。
- `npm run test:e2e` 使用 Playwright 启动 Electron，覆盖 renderer、preload、IPC 和服务之间的桌面流程。测试通过隔离的 library/profile 根目录和临时来源运行。验收截图写入每条用例的 `test-results/` 输出目录，不纳入 Git；CI 在单独的 job 中运行 e2e，并将测试输出保存为 GitHub Actions artifact。
- `npm run build` 是交付构建，也会再次执行类型检查。

`tests/recovery.test.ts` 在每个操作日志阶段模拟进程崩溃，再以新实例执行启动恢复。修改导入、应用、移除、迁移或修复的步骤时，先确认这些测试仍然通过；新增阶段时补充对应的崩溃点。

性能基准不在 CI 中运行，修改规划、应用或健康检查时可以对比：

```sh
npm run bench -- --skills=200 --harnesses=3
```

联网 GitHub smoke 可选运行：

```sh
npm run smoke:github -- vercel-labs/agent-skills
```

该命令需要网络和 Git，会扫描真实仓库，但安装结果写入临时测试库并在结束时删除。不要把需要登录的私人仓库或凭据写入公开测试日志。

修改文件操作、迁移、修复、启用状态或市场适配器时，应优先增加覆盖其真实风险边界的测试。例如：目标路径别名、并发/重复请求、旧预览失效、启用状态变化、共享目录和失败后的恢复。测试应以临时路径和可注入的网络、命令、Trash 回调模拟外部效果，不要改动开发者自己的 Harness 配置或技能目录。

## 扩展 Harness 支持

内置 Harness 是共享注册表中的数据，不应在 UI 中另写一份规则。扩展时按以下顺序处理：

1. 先核对工具的官方技能目录、作用域和读取兼容规则，记录来源链接与未验证项。
2. 在 `src/shared/harness-registry.ts` 增加或更新 `Harness` 注册项。保持 ID 稳定，明确用户级与工作区级入口。主路径就是应用时的写入位置，以厂商当前文档或其自带安装器的目标为准；仅为向后兼容而加载的旧目录放在 `extra*` 读取路径中。如需兼容通用目录，使用 `readsUserAgents` 或 `readsWorkspaceAgents`，不要伪造成专属路径。
3. 检查 `src/shared/harness-paths.ts` 中目标及继承路径的去重和隔离行为。实际读取规则与管理入口是不同概念：共享目录可显示继承，但不因此替兼容 Harness 创建独立安装意图。
4. 仅在能确认安装证据时配置 `command`、`versionArgs`、`executablePaths`、`appPaths` 或编辑器扩展身份。技能目录本身存在不能证明应用已安装。
   如需给 `Harness` 类型新增字段，同时把它加入 `src/shared/harness-fields.ts` 中合适的分组、`HarnessConfigService.saveHarness` 的自定义记录，以及契约中的 `saveHarness` schema。前两处缺失会编译失败；schema 是严格模式，缺失时带有该字段的保存请求会被拒绝。
5. 为注册表锁定、路径归一、继承可见性、检测结果和停用引用保护增加或更新测试；在适用的平台验证真实工具是否发现技能。
6. 更新 `docs/research/harness-support.md`，清楚区分官方保证、社区惯例和未验证假设。

内置路径规范对 UI 保持只读；本机安装位置可通过设置补充。自定义 Harness 走用户配置流程，不应被写入共享内置注册表。

## 扩展市场适配器

设置里的自定义市场目前是可持久化的网站入口。要增加应用内目录，需要添加经过核实的数据适配器：

1. 在 `src/shared/types.ts` 定义目录请求和结果，在 `src/shared/ipc-contract.ts` 的 `marketplaceCatalog` schema 中接受新的市场 ID；明确分页、空结果和上游限额的语义。
2. 在 `src/main/marketplace-catalog.ts` 实现服务端适配。固定可信上游 origin，不接受 renderer 传入的任意请求 URL；限制超时、响应大小、重定向和缓存，并把上游错误作为可理解错误返回。
3. 将响应 JSON/HTML 解析成 `MarketplaceSkill`，只保留能验证的 GitHub 来源和技能目录。把远端内容当数据解析，不执行网页脚本。
4. 如需新的 IPC 动作，按上文“新增或修改 IPC 动作”添加契约和路由，然后接入 renderer。上游错误用 `src/main/messages.ts` 中的错误码表达。
5. 为响应解析、分页、错误、限额、去重和缓存编写确定性 mock 测试，并更新 `docs/research/marketplace-integration.md`。
6. 将可识别的仓库与子目录交给既有 `scan` / `install` 流程；市场适配器不应绕过候选校验、用户选择或中央库写入规则。

当前应用内目录适配 skills.sh 和 SkillsMP。skills.sh 榜单有分页接口，搜索接口有上游结果上限；SkillsMP 需要关键词搜索并受匿名请求额度限制。新增市场应基于该市场公开且可复核的接口文档，不能因设置里能保存网址就假设它兼容现有目录协议。

## 当前限制

- 技能更新按整个目录替换，尚无文件差异预览和合并；上游改名的技能不能自动更新，上游新增的技能需重新扫描来源后选择安装。
- 副本安装在中央库更新后标记为待同步，需要重新应用；应用不会自动刷新副本。
- 目标目录创建成功不等于 Harness 已加载技能；实际发现验证需要在具体 Harness 中进行。
- 外部迁移仅处理可检测的已配置 Harness 入口和已登记工作区。
- 自定义市场仅支持打开网站；应用内目录不支持任意自定义 API。
- Windows junction、跨卷行为和各工具目录规范仍需更多实机覆盖。
- 中央库搬迁、完整数据导出、技能删除和签名安装包尚未提供。
