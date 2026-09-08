# 用户自动更新 / Automatic updates

## 给安装用户 / For users

从 **v1.2.0** 起，本项目提供独立的用户级安装器和更新器。它更新整个 Codex 插件（MCP、看盘资源、Skills 和插件配置），不是只更新网页数据。自动更新是**明确选择启用**的功能；普通的两条 `codex plugin` 安装命令不会为你注册后台任务。

Starting with **v1.2.0**, the managed installer can update the complete Codex plugin. Automatic updates are **opt-in** and separate from quote refresh. Plain marketplace installation does not register this updater.

### 首次安装 / First installation

1. 需要 Node.js 20+ 和支持 `codex plugin` 的 Codex CLI。使用已有运行环境，无需 `sudo`，不安装全局 npm 包、不修改 PATH。
2. 从 [官方 Releases](https://github.com/honestTai/hrouter-market-pulse/releases/latest) 下载最新正式版 `hrouter-market-pulse-<version>.zip`，解压后在该目录打开终端。不要只下载单个 `install.mjs` 文件。
3. 运行：

```bash
node scripts/install.mjs --auto-update
```

此命令明确授权：**安装来自 `honestTai/hrouter-market-pulse` 正式 Releases 的后续代码**，并注册当前用户的后台更新任务。如果只想手动更新，省略 `--auto-update`。如果找不到 Codex，传入 `--codex /absolute/path/to/codex`。Windows 支持官方 npm 安装的 Codex shim，也可指定原生 `codex.exe`。

The command above explicitly opts in to future code published by this repository and registers a per-user background job. Omit `--auto-update` for manual updates. No API key, GitHub token, administrator password, or additional model subscription is required by the updater.

安装完成后**新建 Codex 任务**并选择 Hrouter Market Pulse。安装器会保存独立副本；原始 ZIP 解压目录或开发 checkout 可以移走。后台任务调用稳定的本地入口，不依赖原始下载目录。

### 已使用旧安装方式 / Migrating an existing installation

先关闭正在使用 Market Pulse 的旧 Codex 任务/进程，再下载带更新器的新版本并运行：

```bash
node scripts/install.mjs --auto-update --migrate
```

`--migrate` 明确允许将同名的 GitHub/本地 marketplace 切换为更新器管理的本地来源。安装器保留 Codex 标准 Git marketplace 配置中的分支/tag 固定设置；遇到无法可靠解析的自定义配置（例如 sparse 配置）会拒绝自动迁移，要求用户明确移除旧来源后再安装。旧版本没有运行租约，安装器无法保证识别所有旧进程，因此**迁移前需要手动关闭旧插件任务**。不会修改开发仓库、报告目录、自选股、持仓或历史记录。

Close old Market Pulse processes before migration: versions before 1.2.0 do not publish runtime leases. Migration is a one-time opt-in, not a capability that can be retroactively pushed into already installed old versions.

### 如何更新 / Behavior

- **更新来源**：固定为官方仓库的 GitHub Releases `latest`，只接受严格 `vX.Y.Z` 正式版本。忽略旧版本，不跟随 `main`、草稿或预发布版本。
- **频率**：大约每 6 小时检查一次。macOS 使用用户 LaunchAgent，Linux 使用 systemd user timer，Windows 使用当前用户的计划任务。电脑需要联网且相应用户会话/调度器可运行；不是关机、睡眠或退出登录时仍保证升级的云服务。Linux 不自动开启 linger，也不修改系统级服务。
- **校验**：仅下载固定 GitHub 仓库的资产，限制响应大小和解压大小，校验 SHA-256、版本、文件清单及路径，然后用隔离数据目录验证 MCP 初始化、工具列表和看盘资源。不运行 `npm install`、远程 shell 或安装包 lifecycle scripts。
- **空闲安装**：下载可以在使用期间进行；有活跃 Market Pulse MCP/看盘进程时只暂存，不删除当前 Codex 缓存。关闭这些任务/进程后，下次检查才安装。升级后**新建任务**加载新 Skills/工具，不承诺热替换现有任务。
- **保留与回退**：用户业务数据不在更新目录中，更新器不迁移或删除这些数据。仅保留一个之前的完整安装副本。安装失败尝试恢复原安装；进程中断时，下次更新调用根据事务记录恢复。
- **尊重停用**：如果在 Codex 中停用、卸载插件，或切换了它的来源/版本，后台更新器不会擅自重新启用或覆盖它。重新采用托管安装需明确执行安装器。
- **失败可见**：网络、校验、健康检查或注册调度器失败不会被当成成功；旧版本继续保留。`status` 显示最近错误，后台日志有大小轮转限制。

The scheduler does not need Codex's GUI to remain open, but it needs a working Codex CLI and a runnable local user session. Moving/removing the recorded Node or Codex executable requires rerunning the installer. Linux environments without a user systemd session retain a working manual installation; enabling scheduling fails with an actionable error.

### 状态、停用与回退 / Controls

可在任何完整 Release 解压目录中运行以下命令。原下载目录删除后，可改用更新目录内的 `runner.mjs` 执行相同子命令。

```bash
node scripts/updater.mjs status
node scripts/updater.mjs check       # 立即检查；仍等待活跃进程退出
node scripts/updater.mjs disable     # 关闭自动更新并移除本项目的用户级定时任务
node scripts/updater.mjs enable      # 重新启用
node scripts/updater.mjs rollback    # 关闭自动更新，恢复上一个托管版本
```

回退不会删除用户数据，也不会逆向修改业务数据格式。未来如发生不向后兼容的数据格式变更，发布者必须提供迁移方案，不能依赖代码回退自动恢复数据。

Default updater directories (separate from report/preferences storage):

| OS | Directory |
| --- | --- |
| macOS / Linux | `$XDG_DATA_HOME/hrouter-market-pulse-updater`, or `~/.local/share/hrouter-market-pulse-updater` |
| Windows | `%LOCALAPPDATA%\HrouterMarketPulseUpdater` |

The directory contains `state.json`, `updates.log` (one bounded previous log), `runner.mjs`, `marketplace/`, and at most one `previous-marketplace/` plus a pending update. Runtime leases and transaction metadata also live here. `HROUTER_UPDATE_HOME` or `--update-home` can override the location; the managed installer binds the plugin's MCP environment to that location. Do not change it without reinstalling.

完全停用后可通过 Codex 卸载插件/marketplace，再删除这个专用更新目录。不要删除独立的业务报告目录。`disable` **不会**卸载插件。

### 信任边界 / Trust and integrity

启用自动更新代表信任这个仓库后续发布的可执行代码。HTTPS、GitHub 资产 digest（如有）和 SHA-256 能检测损坏/不一致，**不是独立发布者签名**，不能防止维护者账号或发布流水线被攻陷。不收集遥测；检查版本会连接 GitHub。未配置 GitHub 凭证，遇到匿名 API 限流时保留旧版并记录错误。

The updater is not a sandbox for malicious maintainer code. It uses only this repository's GitHub release endpoint and a small allowlist of GitHub asset redirect hosts, never URLs supplied by user watchlists or arbitrary mirrors. Review this trust decision before enabling automatic updates.

## 给发布者 / For maintainers

### 首次上线

把更新器、安装说明及 `.github/workflows/release.yml` 合并到仓库，并发布 **v1.2.0**。已有用户需要使用上面的迁移命令一次。GitHub 上尚未发布带更新资产的版本前，不能宣称所有现有安装都已经具备自动升级能力。

### 后续发版

示例：当前为 1.2.0 时，下面准备 1.2.1。`npm version` 的项目 lifecycle 会同步插件版本；`build` 同步安装包。不要复用已发布版本号或移动已有 tag。

```bash
npm ci
npm version patch --no-git-tag-version
npm run build
npm test
npm run check
npm run smoke
npm run release:pack
# 审核变更并补充 CHANGELOG.md，然后提交生成的插件包与源码。
git add package.json package-lock.json .codex-plugin .mcp.json .agents plugins mcp scripts tests docs assets schemas skills README.md README.en.md SECURITY.md CHANGELOG.md .github
git commit -m "Release 1.2.1"
git tag v1.2.1
git push origin main
git push origin v1.2.1
```

Tag 必须与 `package.json`、根插件 manifest、安装包 manifest 的基础版本一致。流水线在 Linux / Windows / macOS、Node 20 / 24 上构建和测试，通过后才创建/补全 **draft Release**。所有资产上传完毕才公开发布并标为 latest；失败或半上传版本不会暴露给更新器。已经公开的 Release 不会被流水线覆盖。

Generated release assets:

- `hrouter-market-pulse-X.Y.Z.zip`: complete installable marketplace and installer for humans.
- `hrouter-market-pulse-X.Y.Z.bundle.json.gz`: bounded, checksummed file manifest for the updater; avoids platform-specific archive extraction and symlink handling.
- `hrouter-market-pulse-X.Y.Z.update.json`: version, bundle size, and SHA-256.
- `SHA256SUMS.txt`: checksums for the downloadable artifacts.

自动更新依赖正式 Release，不依赖个人 Codex 自动化、不消耗定时模型调用，也不要求最终用户安装 Git 或 npm 依赖。

### Native Codex integration test

Maintainers with a local Codex CLI can also run `npm run smoke:updater`. It uses an isolated `CODEX_HOME`, simulated release downloads and intercepted scheduler calls to exercise real plugin installation, active-runtime deferral, upgrade and rollback without creating user OS jobs. Pure regression and MCP tests run in CI; native Codex integration requires a compatible CLI on the test machine.
