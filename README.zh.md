# dsh-backup

[![dsh-plugin](https://img.shields.io/badge/ecosystem-dsh--plugin-8b5cf6)](https://github.com/topics/dsh-plugin)

一键备份**与恢复** DeepSeek Harness 用户数据——`~/.dsh` 下的会话、设置、凭据、
技能与插件配置（排除可重装的 node_modules），自动生成 sha256 校验和、完整性
校验、自动轮换，定时自动备份状态落盘、重启续跑。支持 macOS / Linux / Windows。

## 命令

- **`/backup`** —— 立即备份 `~/.dsh` 到 `~/Desktop/dsh-backups/dsh-<时间戳>.tar.gz`
- **`/backup list`** —— 列出已有备份（名称 + 大小）与自动备份状态
- **`/backup verify [前缀|all]`** —— 校验归档完整性（缺省校验最新一份）
- **`/backup restore <前缀|latest> [--dry-run]`** —— 从归档恢复 `~/.dsh`
- **`/backup auto <N小时>|off|status`** —— 每 N 小时自动备份（1~720；<24h 保留 3 份，否则 7 份；状态持久化，重启续跑）
- **`/backup --keep N`** —— 覆盖轮换保留份数（默认 7）
- **`backup_dsh` 工具** —— 模型可调用同一能力（`mode=backup|list|verify|restore|auto`）

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
    keep: 10                       # 默认轮换保留份数
    exclude:                       # 额外的 tar --exclude 模式
      - '*cache*'
```

自动备份状态保存在 `<destination>/auto.json`，重启后续跑。

## 安全说明

备份包含明文凭据（`.credentials.yaml`、`qq-bridge/config.json`）。归档与校验
文件在 POSIX 上为 `chmod 600`（Windows 依赖用户目录 ACL），但请**不要**把备份
目录同步到不受信的位置，并像对待 API key 一样对待备份文件。

## 安装

```sh
dsh plugin --profile web add dsh-backup
```

然后重启 `dsh web`，输入 `/backup` 即可。

## 依赖

- macOS、Linux 或 Windows 10+，PATH 中有 `tar`（Windows 自带 System32 的
  bsdtar，Git Bash 的 GNU tar 也可以；校验和优先 `sha256sum`/`shasum`，
  Windows 上回退进程内哈希）
- DSH `0.1.0-rc.6` 或兼容版本

## 开发

零依赖、无构建——插件本体就是 `lib/index.js`。运行跨平台冒烟测试
（真实临时目录 + 模拟的 DSH 服务）：

```sh
node scripts/smoke.mjs
```

## 许可证

MIT
