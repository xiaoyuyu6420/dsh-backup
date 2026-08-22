# dsh-backup

[![dsh-plugin](https://img.shields.io/badge/ecosystem-dsh--plugin-8b5cf6)](https://github.com/topics/dsh-plugin)
[![npm](https://img.shields.io/npm/v/@xiaoyuyu6420/dsh-backup)](https://www.npmjs.com/package/@xiaoyuyu6420/dsh-backup)
[![Publish to npm](https://github.com/xiaoyuyu6420/dsh-backup/actions/workflows/publish.yml/badge.svg)](https://github.com/xiaoyuyu6420/dsh-backup/actions/workflows/publish.yml)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

[English](README.md) | 简体中文

**dsh-backup 是 DeepSeek Harness（DSH）的备份插件：一条命令备份 `~/.dsh`，一条命令恢复。**

会话记录、设置、技能、插件配置全在 `~/.dsh` 一个目录里。误删了、改坏了、换电脑了——有备份就能找回来。密码等敏感文件不进备份包，还支持定时自动备份和 GitHub 云同步（细节见[进阶文档](docs/advanced.zh.md)）。

## 安装

```sh
dsh plugin --profile web add @xiaoyuyu6420/dsh-backup
# 或者从 GitHub 安装：
dsh plugin --profile web add github:xiaoyuyu6420/dsh-backup
```

装完重启 `dsh web`。要求：macOS / Linux / Windows 10+（自带 `tar`），DSH `0.1.1-rc.2` 或兼容版本。

## 快速上手

1. 按上面装好插件，重启 `dsh web`
2. 输入 `/backup`
3. 搞定 —— 备份出现在 `~/Desktop/dsh-backups/`，文件名带时间戳

想定时自动跑？`/backup auto 12`（每 12 小时一次，重启不中断）。

## 命令速查

| 场景 | 命令 |
|---|---|
| 立即备份 | `/backup` |
| 定时备份 | `/backup auto 12`（`off` 关闭，`status` 看状态） |
| 恢复 | `/backup restore latest`（`--dry-run` 先预览） |
| 列出备份 | `/backup list` |
| 校验是否完好 | `/backup verify [前缀\|all]` |
| 删除某份备份 | `/backup delete <前缀\|latest>` |
| 保留份数（默认 7） | `/backup --keep N` |

不想敲命令？`dsh web` 设置里有可视化面板。

## 换新电脑

前提：旧电脑配过 GitHub 同步（[配置方法](docs/advanced.zh.md#github-同步可选)）。

1. 新电脑装好插件，配置里填同一个 `githubRepo`
2. `/backup github pull` —— 拉回云端备份
3. `/backup restore latest --sync-deps` —— 恢复并重装插件依赖
4. 重启 `dsh`

## 更多

定时备份策略、敏感文件脱敏、GitHub 同步、恢复的保护机制、配置参考、故障排查、开发说明——都在[进阶文档](docs/advanced.zh.md)。

## 致谢

- [@beastrobin](https://github.com/beastrobin) —— #1 中对保留方法名的根因分析，直接促成 v0.5.1 修复
- [@mlosun](https://github.com/mlosun) —— #2 中详尽的复现与根因报告
- [@Choi-Peng](https://github.com/Choi-Peng) —— #5 中协助把受影响用户指引到修复版本

## 许可证

MIT
