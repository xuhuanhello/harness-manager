# Harness Manager 图标

应用图标由生成式图像工具创建，经尺寸和格式转换后用于打包。

- harness-manager-1024.png：1024 × 1024 通用 PNG。
- harness-manager.icns：macOS 多尺寸图标，已配置为 electron-builder 的 mac.icon。

Windows 打包使用 `harness-manager-1024.png`，由 electron-builder 在构建时转换为 ICO。已有安装包仍使用旧图标；下次构建生效。
