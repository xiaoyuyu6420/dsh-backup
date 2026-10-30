# 便携安装与配置指南（dsh-backup）

> 适用：DSH Web（`dsh web`）与 DSH Desktop。macOS / Linux / Windows 10+（自带 `tar`）。
> 一句话：装上插件 → 重启 → 输入 `/backup`，之后用面板或命令都行。

## 1. 安装

### 方式 A：插件市场（推荐给桌面端）

DSH Desktop：**设置 → 插件 → 添加插件**，输入：

- npm 包名：`@xiaoyuyu6420/dsh-backup`
- 或 GitHub 地址：`https://github.com/xiaoyuyu6420/dsh-backup`
- 或本地 tarball 绝对路径（例如 `/path/to/xiaoyuyu6420-dsh-backup-0.14.0.tgz`）

> 桌面端的 profile 归**应用的插件管理器**所有；应用运行期间不要用命令行改它。Web profile 用下面的命令。

### 方式 B：命令行（Web / headless）

```sh
# 从 npm
dsh plugin --profile web add @xiaoyuyu6420/dsh-backup

# 或从 GitHub（跟随 main）
dsh plugin --profile web add github:xiaoyuyu6420/dsh-backup
```

装完重启 `dsh web` 生效。

### 方式 C：离线 / 单文件（换机、内网）

```sh
dsh plugin --profile web add /path/to/xiaoyuyu6420-dsh-backup-0.14.0.tgz
```

tarball 可离线拷贝；`lib/`、`rescue/`、`cordis.patch.yml` 全在包内，不需要在目标机器上构建。

> 安装时可能刷出 `✕ missing peer @deepseek-ai/...` 警告，属预期：这些 peer 由宿主在运行时提供。只要以 `Done` 结尾即安装成功。

## 2. 装完先做这 5 步

1. 重启 DSH（Web 重启 `dsh web`；桌面端按提示重启或热加载）。
2. **设置 → 插件 → 备份**：能看到三个 Tab（备份 / 恢复 / 设置）。
3. 点「立即备份」，确认回执与文件落点（默认 `~/Desktop/DSH Backups/`）。
4. 打开备份目录：应能看到归档、`.sha256`、`点我恢复`、`使用说明.txt`。
5. 点一次「恢复…」但只做**预览**（不点确认），确认能列出覆盖范围。

## 3. 配置

优先级：`settings.yaml`（面板保存）> `cordis.patch.yml`（base 层）> Schema 默认值。

### 面板（推荐）

设置 → 插件 → 备份 → **设置** Tab：备份目录、保留份数、排除模式、市场地址、自动检查更新；保存后立即生效，无需重启。

### `cordis.patch.yml`

```yaml
- id: dsh-backup
  name: '@xiaoyuyu6420/dsh-backup'
  config:
    destination: '~/Desktop/DSH Backups'  # 备份目录
    keep: 7                                # 保留份数
    exclude: ['*cache*']                   # 额外排除
    redact: ['some-plugin/token.json']     # 追加脱敏文件
    gfsMonthly: 1                          # 每月保留 1 份（0=关）
    gfsYearly: 1                           # 每年保留 1 份（0=关）
    marketUrl: ''                          # 配置市场索引地址（空=关闭）
    githubRepo: 'owner/private-repo'       # 可选：GitHub 同步
```

## 4. 升级与迁移

- **升级**：`dsh plugin --profile web update @xiaoyuyu6420/dsh-backup`，或面板「检查更新 → 更新」；升级前自动留 `dsh-pre-upgrade-` 快照。
- **0.13.x → 0.14.0**：旧默认目录 `~/Desktop/dsh-backups` 会在首次启动时同盘自动改名为 `DSH Backups`；显式配置过目录的不动；旧归档与旧设置照常读取。
- **换机**：设置页「导出配置（.zip）」→ 新机「预览导入 → 确认导入」；本地 `link:`/`file:` 插件会一并打包并装回 `file:`。

## 5. 卸载

```sh
dsh plugin --profile web remove @xiaoyuyu6420/dsh-backup
```

备份文件在备份目录里，卸载插件不会删它们。

## 6. 故障排查

| 症状 | 处理 |
|---|---|
| 安装报 `EPERM ... npm cache`（本机 npm 缓存有 root-owned 文件） | `sudo chown -R $(id -u):$(id -g) ~/.npm` 后重试 |
| 面板「备份」标签消失 | 重启 DSH；仍无则看浏览器 console；插件会用降级标签页提示原因 |
| 装了插件 DSH 启动卡住 | 多为超大 `~/.dsh` 首次备份抢 IO；等 45s 启动宽限，或先排除大目录；必要时安全模式启动后卸载 |
| 桌面端命令行改 profile 不生效 | 桌面端 profile 归应用插件管理器所有，请在应用内操作 |
| 想确认插件是否生效 | `设置 → 插件 → 备份` 三个 Tab 可见 + `/backup` 可用 |
