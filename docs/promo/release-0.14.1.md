# dsh-backup 0.14.1 · 补发说明

## 一句话

0.14.0 的 npm 包在 Codex 支持合并之前就已由 tag 自动发布;0.14.1 把「跨工具聊天记录导入」的双来源(Claude Code / Codex)补齐到 npm 版本,并同步验收数字。**代码面与 v0.14.0 的 GitHub tag 一致**,只是 npm 轨道对齐。

## 装

```sh
dsh plugin --profile web add @xiaoyuyu6420/dsh-backup@0.14.1
```

旧版本迁移(0.13.x → 0.14.x)与 0.14.0 相同:默认目录 `~/Desktop/dsh-backups` → `~/Desktop/DSH Backups` 同盘自动改名,显式配置不动。

## 本版相对 npm 0.14.0 的新增

- **Codex 聊天记录导入**:扫 `~/.codex/sessions/**/rollout-*.jsonl`,解析 `session_meta` / `response_item`(message / reasoning / function_call / custom_tool_call 及其 output)/ `turn_context`;函数调用与结果按 `call_id` 配对成 `tool/call` + `tool/result`;`developer` 指令与仅加密的推理跳过并计数。
- 导入目标仍是**新会话**(`sessions/_no-cwd/<id>/`),原 Codex 数据零改动;流程为 扫描 → 预览(消息/事件/跳过计数)→ 确认。
- 宿主级验收:导入产物通过宿主**严格模式解码**(`recovery:'strict'`)与表面投影(能渲染成 user / assistant / tool 三类消息)。

## 验收

| 套件 | 结果 |
|---|---|
| smoke(宿主零依赖桩) | 587/587(Windows 574) |
| settings | 47/47 |
| client bundle | 60/60 |
| 真机 e2e(DSH 0.2.1-rc.2,从打包产物安装) | 70/70 |

## 已知说明

- npm 上的 `0.14.0` 是 0.14.0 核心大版本(备份目录 UX / 面板重构 / 加密 / 同步 / 市场 / Rewind / Claude Code 导入),**不含** Codex 导入;需要 Codex 导入请装 `0.14.1`。
- GitHub Release `v0.14.0` 附带的 tgz 已含 Codex 导入。
