# dsh-backup 0.14.0 · 发布说明（GitHub Release 草稿）

> 状态：待发。验收数字：smoke 578 / settings 47 / client 60 / 真机 e2e 59（DSH 0.2.1-rc.2）。

## 一句话

一条命令备份、恢复与迁移 DeepSeek Harness（DSH）的全部数据——升级翻车、误删、换机，都能找回来；凭据默认不出本机，还能再上口令加密。

## 为什么现在升级

- **怕升级翻车**：宿主版本一变就自动拍升级前快照，坏了随时回滚。
- **怕误删 / 改坏**：恢复前先预览，当前数据先自动快照，失败自动回滚。
- **怕换机重来**：单文件 ZIP 导出/导入 + 本地插件迁移 + WebDAV / S3 兼容 / Gist 多通道同步。
- **怕凭据上云**：API Key / Token 默认脱敏，明文只留本机 vault；可选口令加密（scrypt + AES-256-GCM）。
- **怕看不懂**：面板重构成三个 Tab（备份 / 恢复 / 设置），首启三步引导，主按钮只有一个「立即备份」。

## 0.14.0 新增

1. **备份目录 UX**
   - 默认 `~/Desktop/dsh-backups` → `~/Desktop/DSH Backups`
   - 从未配置过目录的用户升级后首次启动**同盘自动改名**（原子、不丢备份）；显式配置过的不动；失败继续用旧目录
   - 每次备份在根目录写「使用说明.txt」：每个文件是什么 + 三条恢复路径
2. **面板重构**：三 Tab + 首启引导 + 分类型 chips + 文案去术语 + 响应式
3. **备份能力**：口令加密备份、单文件 ZIP 导出/导入（节段预览 → 冲突默认保留 → 自动快照 → 失败回滚）、本地 `link:`/`file:` 插件迁移
4. **同步与运维**：WebDAV / S3 兼容 / Gist 多通道、GFS 月/年保留、操作锁 + 残留锁回收、磁盘占用报告 + 分级清理、每周调度
5. **生态**：配置市场、从 Claude Code / Cursor / Codex 导入技能与全局指令（MCP 只检测报告）、Profiles 管理、会话 Rewind 分叉、About、agent 工具 6 个、离线 CLI（reinstall / sessions repair / recover-stale-lock）
6. **兼容**：DSH 0.2.1-rc.2 真机 e2e 66/66；peers/engines 仍覆盖 0.2.1 列车，下一边界 0.3.0
7. **跨工具聊天记录导入**:把 Claude Code 的会话导入为新的 DSH 会话(扫描 → 预览 → 确认;原数据零改动,仅文本与工具调用/结果)——导入产物经宿主自带解码器严格解码 + 表面投影双重验证

## 老版本迁移

- 0.13.x → 0.14.0：旧默认目录自动改名；旧归档（无边车 / 0.6.x）照常校验恢复；旧设置 `redact:'none'` 自动归一化
- 升级前建议先 `/backup` 一次（插件也会自动留 `dsh-pre-upgrade-` 快照）

## 安装

```sh
dsh plugin --profile web add @xiaoyuyu6420/dsh-backup
# 或从 GitHub：
dsh plugin --profile web add github:xiaoyuyu6420/dsh-backup
```

桌面端（DSH Desktop）：应用内「设置 → 插件 → 添加插件」，粘贴 npm 包名 / GitHub 地址 / 本地 tarball 绝对路径。

## 安全

- 凭据默认脱敏：不进归档、不进同步；明文只在本机 `vault/`（0700/0600）
- 可选加密：口令只经内存传入，不落盘、不进日志
- 恢复：先快照、先预览、失败回滚；从备份目录到救援控制台全程仅本机

## 验收

| 项 | 结果 |
|---|---|
| smoke（宿主零依赖桩）| 578/578（Windows 552）|
| settings seam | 47/47 |
| client bundle | 60/60 |
| 真机 e2e（DSH 0.2.1-rc.2）| 66/66 |

---

## English (short)

dsh-backup 0.14.0 — one-command backup, restore and migration for DeepSeek Harness. New: friendlier backup folder (`~/Desktop/DSH Backups`) with an auto-generated guide, three-tab panel, password-encrypted backups, single-file ZIP export/import with preview + rollback, WebDAV / S3-compatible / Gist sync, GFS retention, operation locks, disk-usage cleanup, weekly schedules, config market, import from Claude Code / Cursor / Codex, profiles management, conversation rewind forks, cross-tool chat-history import (Claude Code → new DSH session), an About panel, six agent tools and an offline rescue CLI. Verified: smoke 578 / settings 47 / client 60 / real-host e2e 66 on DSH 0.2.1-rc.2.
