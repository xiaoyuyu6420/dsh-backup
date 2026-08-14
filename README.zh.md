# dsh-backup

[![dsh-plugin](https://img.shields.io/badge/ecosystem-dsh--plugin-8b5cf6)](https://github.com/topics/dsh-plugin)

一键备份 DeepSeek Harness 用户数据——`~/.dsh` 下的会话、设置、凭据、技能与
插件配置（排除可重装的 node_modules），自动生成 sha256 校验和、自动轮换，
并支持定时自动备份。

## 功能

- **`/backup`** —— 立即备份 `~/.dsh` 到 `~/Desktop/dsh-backups/dsh-<时间戳>.tar.gz`
- **`/backup list`** —— 列出已有备份与自动备份状态
- **`/backup auto <N>`** —— 每 N 小时自动备份（1~720；<24h 保留 3 份，否则 7 份）
- **`/backup auto` / `/backup auto off`** —— 查询状态 / 关闭
- **`/backup --keep N`** —— 覆盖轮换保留份数（默认 7）
- **`backup_dsh` 工具** —— 模型可调用同一能力（`mode=backup|list|auto`）

每次备份都会生成同名 `.sha256` 校验和文件；轮换会自动删除超出保留份数的
旧备份。

## 安全说明

备份包含明文凭据（`.credentials.yaml`、`qq-bridge/config.json`）。备份文件
已设为 `chmod 600`（仅本人可读写），但请**不要**把备份目录同步到不受信的
位置，并像对待 API key 一样对待备份文件。

## 安装

```sh
dsh plugin --profile web add dsh-backup
```

然后重启 `dsh web`，输入 `/backup` 即可。

## 依赖

- macOS 或 Linux，PATH 中有 `tar`（校验和优先 `sha256sum`，macOS 回退 `shasum`）
- DSH `0.1.0-rc.6` 或兼容版本

## 许可证

MIT
