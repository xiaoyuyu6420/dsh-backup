# dsh-backup

[![dsh-plugin](https://img.shields.io/badge/ecosystem-dsh--plugin-8b5cf6)](https://github.com/topics/dsh-plugin)
[![npm](https://img.shields.io/npm/v/@xiaoyuyu6420/dsh-backup)](https://www.npmjs.com/package/@xiaoyuyu6420/dsh-backup)
[![Publish to npm](https://github.com/xiaoyuyu6420/dsh-backup/actions/workflows/publish.yml/badge.svg)](https://github.com/xiaoyuyu6420/dsh-backup/actions/workflows/publish.yml)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

[English](README.md) | 简体中文

一键备份**与恢复** DeepSeek Harness 用户数据——`~/.dsh` 下的会话、设置、凭据、
技能与插件配置（排除可重装的 node_modules），自动生成 sha256 校验和、完整性
校验、自动轮换，定时自动备份状态落盘、重启续跑。支持 macOS / Linux / Windows。

## 命令

- **`/backup`** —— 立即备份 `~/.dsh` 到 `~/Desktop/dsh-backups/dsh-<时间戳>.tar.gz`
- **`/backup list`** —— 列出已有备份（名称 + 大小）与自动备份状态
- **`/backup verify [前缀|all]`** —— 校验归档完整性（缺省校验最新一份）
- **`/backup restore <前缀|latest> [--dry-run]`** —— 从归档恢复 `~/.dsh`
- **`/backup auto <N小时>|off|status`** —— 每 N 小时自动备份（1~720；保留份数默认 <24h 3 份、否则 7 份，config.keep 可覆盖；状态持久化，重启续跑）
- **`/backup --keep N`** —— 覆盖轮换保留份数（默认 7）
- **`/backup github status|sync|repo <地址|off>`** —— GitHub 同步状态 / 立即推送 / 设置同步仓库
- **`/backup delete|rm <前缀|latest>`** —— 删除指定备份（归档 + 校验边车）
- **`backup_dsh` 工具** —— 模型可调用同一能力（`mode=backup|list|verify|restore|auto`）

## GitHub 同步

配置 `config.githubRepo` 后，每次备份（手动 / 定时 / 面板）都会把归档、校验
边车与轮换删除一并推送到 Git 仓库：

```yaml
- id: dsh-backup
  name: 'dsh-backup'
  config:
    githubRepo: '你的账号/dsh-backups'   # owner/repo、完整 URL 或本地路径
```

**请使用私有仓库**——归档含明文凭据。https 远端需要环境变量 token
（`DSH_BACKUP_GITHUB_TOKEN` 或 `GITHUB_TOKEN`），token 只写入同步工作树的
credential 文件（不进进程参数）。推送为 `HEAD:main --force-with-lease`；
超过 90MB 的归档会跳过并提示。同步状态（上次推送 / 错误）存于
`<destination>/auto.json`，面板与 `/backup github status` 可见。

## Settings 可视面板（Web）

同样的能力在 `dsh web` 的 **Settings → Plugins → 备份** 标签页有可视化入口：
显示备份目录、自动备份状态、GitHub 同步状态和每份归档的大小，支持一键立即
备份、逐份校验、**下载**、带 dry-run 预览与二次确认的恢复。下载走仅限本机的
`GET /backup-download/<归档名>` 路由。面板经 `backupPanel` Typert Remote
命名空间（`/api` RPC）与宿主通信；浏览器 bundle 预构建在 `lib/client.js`，
安装时无需构建。

## 恢复的工作方式

恢复安全性是设计出来的：

1. 先校验归档 sha256——损坏的归档绝不触碰现有数据。
2. 列出归档条目，任何超出备份根目录的路径都会拒绝恢复（tar 路径穿越防护）。
3. 当前 `~/.dsh` 先自动快照，再移动到 `~/.dsh.pre-restore-<时间戳>`——恢复是替换而不是合并。
4. 解压归档后重启 `dsh`，恢复的会话与配置即生效。

`--dry-run` 只显示归档概要，不写入任何内容。

## 配置（可选）

在生效的 cordis profile 中为插件声明 `config`：

```yaml
- id: dsh-backup
  name: 'dsh-backup'
  config:
    destination: '~/Backups/dsh'   # 默认 ~/Desktop/dsh-backups
    keep: 10                       # 手动备份轮换份数（默认 7）；配置后同时作为自动备份保留份数（未配置时 auto 默认 <24h 3 份 / 否则 7 份）
    exclude:                       # 额外的 tar --exclude 模式
      - '*cache*'
    githubRepo: '账号/dsh-backups' # 可选 GitHub 同步（见下文）
```

自动备份状态保存在 `<destination>/auto.json`，重启后按上次自动执行时间推算下次触发（不重置节奏）。

## 安全说明

备份包含明文凭据（`.credentials.yaml`、`qq-bridge/config.json`）。归档与校验
文件在 POSIX 上为 `chmod 600`（Windows 依赖用户目录 ACL），但请**不要**把备份
目录同步到不受信的位置，并像对待 API key 一样对待备份文件。

存储说明：插件自有数据（归档、校验和、`auto.json`）直接经 `node:fs` 写入，
与 DSH 自身的会话持久化同一模式——`ctx.fs` 能力是模型面的沙箱 surface，
不适用于宿主插件的自有存储。

## 安装

```sh
dsh plugin --profile web add @xiaoyuyu6420/dsh-backup
# 或从 git 安装：
dsh plugin --profile web add github:xiaoyuyu6420/dsh-backup
```

> ⚠️ npm 包名是 **scoped** 的 `@xiaoyuyu6420/dsh-backup`。npm 上不带 scope
> 的 `dsh-backup` 是无关的第三方包，请勿安装。

## 快速上手

约 30 秒拿到第一个备份：

1. 安装插件 —— `dsh plugin --profile web add @xiaoyuyu6420/dsh-backup`
2. 重启 `dsh web` —— 插件发现按进程缓存。
3. 跑 `/backup` —— 归档连同 sha256 校验文件落到 `~/Desktop/dsh-backups/`。

更喜欢点鼠标？同一套流程在 Settings → Plugins → 备份 标签页。

## 依赖

- macOS、Linux 或 Windows 10+，PATH 中有 `tar`（Windows 自带 System32 的
  bsdtar，Git Bash 的 GNU tar 也可以；校验和优先 `sha256sum`/`shasum`，
  Windows 上回退进程内哈希）
- DSH `0.1.0-rc.6` 或兼容版本

## 故障排查

- **插件加载失败，报 `client api: method "backupPanel/remove" conflicts with its namespace service`** —— 你装的是 v0.5.0：删除接口的方法名撞上了 DSH 客户端的保留方法名（见 [#2](https://github.com/xiaoyuyu6420/dsh-backup/issues/2)、[#5](https://github.com/xiaoyuyu6420/dsh-backup/issues/5)）。v0.5.1 已将方法改名 `removeEntry` 修复；执行 `dsh plugin --profile web add @xiaoyuyu6420/dsh-backup@latest` 升级后重启 `dsh web` 即可。
- **Windows 上用哪个 `tar`？** 都可以——Windows 自带 System32 里的 bsdtar，Git Bash 里则是 GNU tar。校验和优先用 `sha256sum`/`shasum`，缺失时自动回退进程内哈希，两种 shell 下 `/backup verify` 都能正常工作。
- **装错了包** —— npm 包名是 **scoped** 的 `@xiaoyuyu6420/dsh-backup`；不带 scope 的 `dsh-backup` 是无关的第三方包。检查 profile 的插件列表，改用 scoped 名重装。

## 开发

运行时零依赖——宿主插件就是 `lib/index.js`。浏览器半边源码在 `src/`，
打包（zod 内联、React/Cordis 保持 external）产物 `lib/client.js` 提交进仓库，
git 安装无需构建：

```sh
node scripts/build-client.mjs   # 改 src/ 后重新打包客户端
node scripts/smoke.mjs          # 宿主冒烟（真实临时目录 + 模拟 DSH 服务）
node scripts/smoke-client.mjs   # 客户端 bundle：握手/schema/标签页注册/SSR
```

## 致谢

- [@beastrobin](https://github.com/beastrobin) —— #1 中对保留方法名的根因分析，直接促成 v0.5.1 修复
- [@mlosun](https://github.com/mlosun) —— #2 中详尽的复现与根因报告
- [@Choi-Peng](https://github.com/Choi-Peng) —— #5 中协助把受影响用户指引到修复版本

## 许可证

MIT
