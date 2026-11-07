# 应用更新

应用通过公开仓库 `xuhuanhello/harness-manager` 的 GitHub Releases 检查新版本。它与中央技能库的来源更新互相独立。发布工作流、附件命名和 `SHA256SUMS.txt` 保持原样；不使用 electron-updater、Squirrel.Mac、代码签名或额外依赖。

## 检查与界面

默认启用 `settings.appUpdates.autoCheck`。启动约 15 秒后检查一次，此后每 6 小时检查；设置页可关闭自动检查，手动“检查应用更新”始终可用。旧设置没有此字段时按启用处理。安装结果需要处理 App 管理权限时，自动检查不会覆盖该提示，用户可手动重试。

请求由主进程使用 Electron `net.request`（见 `src/main/manual-redirect-fetch.ts`）发出，使用系统代理，不携带 Cookie。每次跳转都先返回给更新器校验地址（GitHub 附件会从 `github.com` 跳转到 `release-assets.githubusercontent.com`），校验通过才请求下一跳。不使用 `net.fetch`，因为它遇到 `redirect: 'manual'` 会直接报 “Redirect was cancelled”。请求地址为 `https://api.github.com/repos/xuhuanhello/harness-manager/releases?per_page=30`，请求头只有应用版本和 GitHub API 格式信息，不加入个人信息。忽略 draft；0.x 或预发布客户端允许 Pre-release，稳定客户端只选择稳定版本。按 SemVer（含预发布段）选择高于当前版本的最高版本。

左下角显示新版本、下载进度、失败重试或“重启以更新”。确认框显示当前版本、目标版本、发布时间、附件大小和纯文本发布说明。关闭确认框不会中断下载；“取消下载”中止请求并删除不完整文件。下载完成后仍需再次确认重启，才会执行安装。

设置页显示当前版本、上次检查时间、检查结果、自动检查开关和“查看所有版本”。当前版本和平台沿用 `appInfo` / `useAppInfo`。界面与主进程提示来自 `src/shared/i18n/zh-CN.ts` 和 `en.ts`。

## 下载、安装与限制

- **macOS arm64 安装版**：下载 `harness-manager-{version}-mac-arm64.zip`。从 DMG、`/Volumes/`、App Translocation 或不可写目录运行时不能安装更新，请先移动到“应用程序”。
- **Windows x64 安装版**：下载 `harness-manager-{version}-win-x64-setup.exe`，确认后以 detached 方式启动 `/S --updated --force-run`，退出当前应用，由 NSIS 完成安装并重启。
- **Windows 便携版**：检测 `PORTABLE_EXECUTABLE_FILE` / `PORTABLE_EXECUTABLE_DIR`，仅提示新版本并提供发布页面。
- **开发模式、其它平台或架构**：可以检查并查看版本与发布说明，不能下载安装。确认框提供发布页面按钮。

下载前先取得同一 Release 的 `SHA256SUMS.txt`，将附件流式写入 `userData/updates/{version}/`。进度事件约每秒最多 10 次。附件最大 1 GiB；API 响应最大 2 MiB，校验文件最大 128 KiB。检查超时 30 秒，下载总超时 15 分钟。字节数或 SHA-256 不符会删除文件并报错；安装前再次以流式方式验证文件摘要。

macOS 使用 `ditto -x -k` 解压到 staging。解压前检查归档路径；解压后检查顶层恰有一个 `Harness Manager.app`，并用 `plutil` 核对 `CFBundleIdentifier=io.github.xuhuanhello.harness-manager` 和目标 `CFBundleShortVersionString`。从 `process.execPath` 向上三级确定当前 `.app`，再次检查父目录可写。

主进程生成并 detached 启动 `/bin/sh` 辅助脚本。所有路径、版本和 PID 都按独立 shell 参数转义。脚本等待原 PID 退出，将旧应用改名为同目录备份，移入新应用；移动或打开失败时尝试还原备份。随后清理新应用的 quarantine 属性（失败不阻断），使用 `open` 启动新应用，删除备份。脚本不申请管理员权限。

结果写到 `userData/updates/last-result.json`，最后一次安装日志写到 `userData/updates/install.log`。下次启动读取结果；如果日志包含权限拒绝，界面提示到“系统设置 → 隐私与安全性 → App 管理”允许 Harness Manager。按钮仅打开固定系统设置 URL。恢复失败时保留备份供手动处理。成功启动目标版本后清理目标版本及更旧版本的下载目录，保留日志和任何更新版本的文件。Windows 使用安装前写入的目标版本标记判断清理时机。

## 状态和 IPC 边界

单一来源为 `AppUpdater`，状态为 `idle → checking → upToDate / available / unsupported / error`；可安装的版本进入 `downloading → downloaded → installing`。取消回到 `available`，校验或安装失败进入 `error`。状态附带 `lastCheckedAt`；`unsupported` 保留版本元数据以展示确认框。

`ipc-contract.ts` 严格校验 `appUpdateState`、`checkAppUpdate`、`downloadAppUpdate`、`cancelAppUpdate`、`installAppUpdate`、`openAppUpdatePage`。另有无参数 `openAppUpdateSettings`，仅允许 macOS 权限错误状态打开固定设置页。操作走现有可信主 frame 校验。`harness:app-update` 只向当前窗口推送状态，由 preload 提供可退订的 `onAppUpdate`，不接受 renderer 提供下载地址或安装路径。

附件起始地址必须处于固定仓库的 `/releases/download/` 前缀。重定向限制为该前缀或 GitHub 的 HTTPS 附件 CDN，最多 5 次。打开浏览器时只允许该仓库发布列表和 `/releases/tag/…` 页面。发布说明不注入 HTML。SHA-256 可发现损坏，但它与附件来自同一发布源，不等同于独立签名或对发布账号失陷的防护。

## 本地验收

`HARNESS_UPDATE_FEED_URL` 只接受 `http://127.0.0.1:<port>/`；拒绝 localhost、远程主机、HTTPS、额外路径和查询参数。此设置在打包版也生效，附件与重定向必须留在同一本地基址。测试源根路径必须返回 Releases JSON 数组。

自动验收使用随机本地端口、假 Release、校验文件、小附件、独立 profile 和资料库：

```sh
npm run test:e2e -- tests/e2e/app-update.spec.ts
```

它验证中英文、版本和纯文本说明、开发模式限制、手动检查，以及开关关闭后跨进程持久化。服务测试覆盖真正的流式下载、摘要失败、取消、限流、平台限制及状态转换，使用注入的 fetch 和内存文件系统。macOS 测试另用临时 `.app`、Info.plist 和自行退出的子进程，执行真实 shell 的替换与回滚；仅将最终 `open` 替换为空操作。非 macOS 跳过这些平台用例。

要手动测试已打包应用，先准备高于当前版本的真实附件：

```sh
node scripts/serve-update-feed.mjs /path/to/release 0.2.0
```

脚本计算实际附件摘要，输出随机端口的 `HARNESS_UPDATE_FEED_URL`。保持服务运行，在另一个终端使用它输出的值启动应用：

```sh
HARNESS_UPDATE_FEED_URL=http://127.0.0.1:实际端口/ \
HARNESS_PROFILE_ROOT=/tmp/hm-update-profile \
HARNESS_LIBRARY_ROOT=/tmp/hm-update-library \
'/path/to/test-copy/Harness Manager.app/Contents/MacOS/Harness Manager'
```

请使用可写目录中的应用副本与独立测试数据；确认安装会替换该副本。Windows 同理先在 PowerShell 设置这些环境变量，再运行隔离安装版的应用本体。不要指向日常使用的应用或资料库。

本机自动验证覆盖 macOS shell 文件替换与失败还原，不代表已经验证 macOS App 管理授权弹窗、不同系统版本的 Gatekeeper 行为或完整真实应用升级。Windows NSIS 静默安装与自动重启仍需 Windows 实机验收。
