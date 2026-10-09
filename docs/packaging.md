# 桌面打包与验证

当前提供 Apple Silicon（arm64）的本地测试包，并配置了 Windows x64 安装版与便携版 EXE。Windows、Intel、Universal 和 Linux 安装包尚未做实机验收。源码构建和 Electron 开发运行不等于安装包验证。

## macOS 构建

在 macOS 安装 Node.js 24+、npm 和 Git，然后执行：

```sh
npm ci
npm run dist:mac
```

此命令先做 TypeScript 检查和前后端构建，再使用锁定的 electron-builder 26.15.3 生成：

- `release/mac-arm64/Harness Manager.app`
- `release/harness-manager-0.1.3-mac-arm64.dmg`
- `release/harness-manager-0.1.3-mac-arm64.zip`

文件名中的版本来自 `package.json`。首次打包需要联网下载 Electron 和镜像工具。产物、blockmap 和诊断文件位于 Git 忽略的 `release/`，不会随源码推送。命令明确使用 `--publish never`，不会创建 GitHub Release 或上传安装包。

主进程和 preload 由 esbuild 打包依赖，安装包只收录 `dist` 和应用元数据，排除源码映射、开发依赖、测试和用户资料库。应用图标位于 `assets/icons/`，macOS 打包使用 `harness-manager.icns`。修改图标后需要重新打包，已有 DMG 不会自动更新。

## Windows 构建

在 Windows 安装 Node.js 24+（x64）、npm 和 Git。在项目目录的 PowerShell 中执行：

```powershell
git pull --ff-only origin main
npm ci
npm run dist:win
```

首次检出可先执行 `git clone https://github.com/xuhuanhello/harness-manager.git`，再 `cd harness-manager`。打包命令生成：

- `release/win-unpacked/Harness Manager.exe`：解包后的应用，可直接启动；移动时需要保留整个 `win-unpacked` 目录。
- `release/harness-manager-0.1.3-win-x64-setup.exe`：NSIS 安装程序，可选择安装目录。
- `release/harness-manager-0.1.3-win-x64-portable.exe`：无需安装的便携启动包。

两个 EXE 使用不同文件名，避免覆盖。Windows 图标由 electron-builder 从 `assets/icons/harness-manager-1024.png` 转换。命令明确使用 `--publish never`；产物留在 Git 忽略的 `release/`。首次打包需要联网下载 Windows Electron、NSIS 等构建工具。

当前 Windows 构建关闭代码签名，但保留图标和版本元数据编辑，是本地测试包。若系统因未签名而显示提示，应核对是否为自己刚生成的包。

## Windows 实机验收

先检查打包后的程序能否贯通 renderer、preload IPC、SQLite、本地导入、链接应用/移除、健康检查和管理开关：

```powershell
npm run smoke:packaged
```

Windows 默认验证 `release/win-unpacked/Harness Manager.exe`；安装版可传入实际安装后的应用路径：

```powershell
npm run smoke:packaged -- 'C:\实际安装目录\Harness Manager.exe'
```

请传入应用本体，不要传入 `setup.exe`。随后分别启动安装版和便携版，检查中文显示、窗口缩放、来源扫描、工作区选择、技能应用/移除、更新和退出后重启。Windows 的“软链接”策略使用目录 junction，创建受管目录入口无需管理员或开发者模式；复制策略仍需显式选择。跨卷、网络共享目录和技能内容中自带的符号链接仍需实机验证。

Windows 默认 profile 位于 `%APPDATA%\harness-manager`，资料库位于其 `library` 子目录。便携包只省去安装步骤，默认仍使用同一资料库。需要隔离手动测试时，可在启动前设置：

```powershell
$env:HARNESS_PROFILE_ROOT = Join-Path $env:TEMP 'hm-win-profile'
$env:HARNESS_LIBRARY_ROOT = Join-Path $env:TEMP 'hm-win-library'
& '.\release\win-unpacked\Harness Manager.exe'
```

自动 smoke 会自行创建和清理独立临时目录。已在 Apple Silicon macOS 上用锁定版本的 electron-builder 成功交叉生成上述安装版与便携版 EXE；Windows 实机打包、安装和运行仍待验收。

## macOS 验证实际应用

```sh
npm run smoke:packaged
```

验证脚本使用临时 profile 和资料库，启动真正打包的应用，检查 renderer、preload IPC、内置 SQLite、本地技能导入、软链应用/移除、健康检查和管理开关，确认移除入口保留中央内容，然后关闭应用并删除临时测试数据。也可以传入 DMG 挂载后的 `.app` 路径：

```sh
npm run smoke:packaged -- '/Volumes/Harness Manager/Harness Manager.app'
```

请以实际挂载路径为准。镜像可通过 `hdiutil verify 'release/harness-manager-0.1.3-mac-arm64.dmg'` 校验。DMG 中提供应用和 Applications 快捷入口；手动安装时将应用拖入 Applications。

开发版和安装版默认都使用 `~/Library/Application Support/harness-manager`，库位于其 `library` 子目录。`HARNESS_PROFILE_ROOT` 和 `HARNESS_LIBRARY_ROOT` 可以隔离测试目录；不要让验收用例指向日常使用的数据。

## 首次验收记录

2026-09-23，在 Apple Silicon macOS 上实际生成 DMG 和 ZIP，并完成：

- 启动打包后的 `.app`，通过上述端到端 smoke 验证。
- 校验 DMG 校验和、只读挂载，并启动镜像中的应用执行相同验证。

这不代表已验证其它 Mac、Gatekeeper 下载隔离场景或系统版本组合。正式稳定发布仍需独立机器安装、升级及退出流程验收。

## macOS 签名与正式发布

当前配置明确关闭代码签名、公证及 Hardened Runtime。GitHub Releases 中的早期版本会标明未签名测试包，并以 Pre-release 发布。没有把任何 Apple 证书或凭据写入仓库。

准备正式稳定发布时，需要开发者提供 Apple Developer 的 Developer ID Application 身份及公证凭据，使用受保护的构建环境/仓库 Secrets；启用 Hardened Runtime、审核所需 entitlements，签名后公证并 staple，最后在另一台 Mac 验证正常安装。完成这些步骤后再创建正式稳定 Release。不要通过关闭系统安全机制来替代签名验收。

配置参考：[electron-builder macOS 文档](https://www.electron.build/mac.html)。该网站可能展示下一主版本的配置；本项目固定在 26.x，应以锁定版本的 schema 和类型为准，升级时重新核对签名字段。

## GitHub Releases

`.github/workflows/release.yml` 在版本 tag 推送时运行。先更新 `package.json`、锁文件和第三方许可声明，提交通过检查的源码，再推送完全匹配版本号的 tag。例如当前 `0.1.3` 的首次发布：

```sh
git tag v0.1.3
git push origin v0.1.3
```

Actions 使用 Windows x64 和 macOS Apple Silicon 原生运行器构建，检查版本号、代码规范，并在 macOS 执行服务与桌面回归测试。两边都必须通过打包后应用的 smoke，发布任务才会继续。安装程序的人工安装、升级、具体 Harness 扫描及跨机器体验仍需独立验收。

发布任务只接收四个预期安装包，校验完整文件清单并生成 `SHA256SUMS.txt`，随后上传草稿并发布：

- macOS arm64：DMG 和 ZIP。
- Windows x64：`setup.exe` 和 `portable.exe`。
- 四个文件的 SHA-256 校验文件。

`0.x` 与带预发布后缀的版本标记为 Pre-release，说明中列出未签名、未公证等限制。当前工作流不构建 Intel Mac 或 Linux 安装包。

也可在 Actions 的 Release 页面手动运行，输入已经存在且匹配 `package.json` 的 tag；工作流始终检出该 tag 的源码。已发布的 Release 不会被覆盖。失败后若留下未发布草稿，应检查并删除该草稿后重试；修改源码时使用新的版本和 tag。

`dist:mac` 和 `dist:win` 仍只生成本地文件，明确使用 `--publish never`，不会创建 Release。公开附件应始终从通过检查的工作流发布。

验收截图、Playwright traces 和构建日志作为 GitHub Actions artifacts 保存；内部调研、个人 profile、技能库、证书、调试输出和 `win-unpacked` 等临时目录不作为公开 Release 附件。

## 构建依赖审查

运行 `npm audit --omit=dev` 检查随应用分发的运行时依赖；用 `npm audit` 同时检查开发与打包工具。当前运行时依赖审查无告警。锁定的 electron-builder 26.15.3 仍通过其下载工具的 `global-agent` / `roarr` 链引入 `sprintf-js`，被 npm 记录为中等级拒绝服务告警；该链属于构建依赖，不会打入应用主进程或 renderer。

当前 npm 建议通过强制降级 electron-builder 来避开该链，这会改变本项目已验证的打包 API，因此不自动执行 `npm audit fix --force`。更新构建工具或依赖覆盖规则时，需要重新验证下载、代理环境及两种操作系统的打包流程。
