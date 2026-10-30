# P2 加密 / 导入能力 —— 验收清单（已转 smoke 断言）

> 状态：**已落地**。host-engine 已把宿主半边（`lib/index.js` + `lib/encrypt.js` + `lib/zip.js`）
> 的加密/导入能力落地并 complete task-1。本文的四项硬验收与导出/导入全链路已转成
> `scripts/smoke.mjs` 场景 38（加密）与 39（导出/导入），`docs/ALIGNMENT.md` §7「加密包」项已勾选。
> 下文的「待确认项」保留作为契约记录，供后续核对。

## 0. 前提与契约待确认项

在转成断言前，先与 host-engine 对齐这些方法契约（本文暂按竞品语义起草）：

| 待确认 | 草案默认值 | 说明 |
|---|---|---|
| 加密归档命名/边车 | 归档仍 `.tar.gz`；新增 `meta.encrypted` 字段 | 旧版插件遇新包安全降级：边车**只增不改**（ALIGNMENT §6） |
| 口令派生 | scrypt + AES-256-GCM，随机 salt/IV | 每次备份新随机 salt/IV，不重用 |
| 口令来源 | 命令/面板参数，**不进** settings.yaml / cordis.patch.yml | 口令是瞬态密钥，只活在进程内存 |
| verify 是否免口令 | 是——`verify` 只验 sha256 边车，不解密 | 校验完整性 ≠ 读内容 |
| list 是否免口令 | 是——`list` 只读元数据（大小/时间/🔒 标记），不解密 | 面板列表不能被口令挡在门外 |
| restore 口令错误 | 返回 `error`，**人话**报错（不给 stack / 原始 crypto 异常） | 见 §1.3 |

## 1. 加密归档 —— 四项硬验收（优先级最高）

### 1.1 list 显示 🔒（免口令）

- 用口令加密做一次全量备份，拿到归档名。
- `list` 输出必须含该归档名，且带 🔒（或等价的「已加密」标记）。
- 反例断言：`list` 不得因「无口令」而报错、不得把加密归档当普通归档（无标记）。

### 1.2 verify 免口令

- `verify all`（或 `verify <加密归档>`）不传口令必须**通过**（`kind === 'success'`，含 ✅）。
- 反例断言：verify 不得要求口令、不得因解密失败而误报损坏。

### 1.3 restore 口令错误 → 人话报错

- `restore <加密归档>` 传错误口令 → `kind === 'error'`，文案含「口令」且**不含**：
  - 原始 crypto 异常（`bad decrypt` / `Unsupported state` / `EVP_` 等）；
  - stack trace 片段（`at ` / `node:internal/`）。
- `restore <加密归档>` 传正确口令 → 成功，内容字节与备份时点一致。

### 1.4 密文/口令不进日志、不进 settings.yaml

- 全流程跑完后：
  - `settings.yaml` / profile 覆盖文件（`cordis.patch.yml`）**不得**出现口令明文；
  - `auto.json`（备份目录根）**不得**出现口令明文；
  - 归档内 **不得**出现口令明文（口令不是数据，不入包）；
  - 脱敏断言：`list` / `restore` / `verify` 的文本回执与 `console.log/warn` 均不回显口令；
  - 密文断言：解密前归档内容里不含任何明文凭据（`.credentials.yaml` 的 `api-key` 值以密文形态存在或不在包内）。
- 反例断言：抓取命令回执文本，`includes(口令明文) === false`。

## 2. 加密归档 —— 配套安全降级（ALIGNMENT §6 第 6 行）

- **旧版视角**：`meta.encrypted` 边车只增不改；模拟「旧版插件」读取（不读 `meta.encrypted`）时，
  list/verify 正常、restore 走「老归档无脱敏保障」类降级路径，**不误删、不误读**。
- **跨机**：无口令时 restore 给出「需要口令」的清晰指引，而非静默失败或报「暂无备份」。

## 3. 导出 / 导入单文件 ZIP（P2 第二卖点）

> 与加密并列，是竞品最硬能力。落地后转断言时覆盖以下链路：

1. **导出**：把 `~/.dsh` 打成单文件 ZIP（`dsh-config-<时间>.zip`），节段化
   （settings/UI/providers/plugins/MCP/skills/prompts/workspaces/sessions/credentials），
   默认脱敏、可选加密。
2. **导入**：`分析 → 预览 → 逐项/冲突选择（保留/采用，含批量）→ 自动快照 → 应用 → 校验 → 失败回滚`。
3. **跨机绝对路径 remap**：批量前缀映射；目标路径在另一台机器上仍可用。
4. **兼容性评分**：source 版本/平台 → 本地，给出结构化原因（导入前评分卡）。

### 3.1 导入验收骨架（转断言时按此拆）

- 分析：`import <zip> --analyze` 返回节段清单 + 冲突预览（保留/采用逐项）。
- 预览：`--dry-run` 只预览，磁盘零改动。
- 快照：实际导入前自动留 `dsh-pre-import-*` 快照，失败可回滚。
- 回滚：注入一个「应用阶段必失败」的桩，验证导入失败后现场还原、快照仍在。
- remap：`--remap 'C:/Users/a=>C:/Users/b'` 后，恢复出的绝对路径被正确改写。

## 4. 转成 smoke 断言的落地清单

已按下面顺序在 `scripts/smoke.mjs` 增补场景（沿用现有 `makeCtx` / `ok()` / 真实 tar/git 桩，零新依赖）：

- [x] 加密备份 → list 带 🔒 → verify 免口令 → 口令错误人话 → 口令正确恢复（**smoke 38**）。
- [x] 密文/口令不进 settings.yaml / auto.json / 归档 / 回执文本（**smoke 38f**）。
- [x] 导出 → importPreview 节段/冲突 → importApply keep/overwrite + 快照 + 错口令拒绝（**smoke 39**）。
- [ ] 旧版视角安全降级（读不到 `meta.encrypted` 不误删不误读）——零依赖 smoke 无法加载「旧版插件」，暂靠 `isArchiveEncrypted` 的 meta 回退 + 老归档场景 21 兜底。
- [ ] 导入失败「应用阶段必失败」回滚注入桩——零依赖 smoke 无故障注入 seam，暂以「快照安全网 + 非法输入不半截写」替代（smoke 39g）。

> 已完成项已同步 `docs/compatibility.md`（smoke 411 / settings 47 / client 32）与
> `docs/ALIGNMENT.md` §7（「加密包」项勾选）。

## 5. 跨工具聊天记录导入 v1(Claude Code → DSH 会话,2026-10-25)

实现:宿主 3 个新 RPC(`chatSources` / `chatPreview` / `chatApply`,共 47),CLI `/backup chat list|preview|import [--yes]`,
客户端新增「聊天记录导入」卡片 + FAQ 一条。导入为**新会话**(`sessions/_no-cwd/<id>/session.v4.jsonl.zstd`),原 Claude 数据零改动。

验收判据(比"自己校验通过"更硬):
- [x] **宿主自带解码器严格模式**解码导入产物(`recovery:'strict'`):15/15 事件、header v4;
- [x] **宿主表面投影** `foldSurface` + `deriveEventMessage` 得到 `user,assistant,tool` 三条可渲染消息;
- [x] 同上两判据也用于 rewind 分叉产物 → 修掉两个真实缺陷:
  1. 分叉沿用 `isSeeded` 却缺 `session/end-seed` 标记时,宿主 `finish()` 判定会话打不开 → 分叉时统一修正(缺标记降级 / 多标记丢弃并重编号);
  2. 导入行 `time` 用 `mtimeMs`(小数)违反"safe integer" → 取整;
  3. 附带:surface 事件缺 `surfaceOp` 的分叉自动补 `'append'`。
- [x] smoke 场景 53(11 项)、e2e 新增 7 项(chat 5 + rewind 宿主校验 2 + Codex 4)全绿。

最终验收:smoke **594/594**(Windows 581)、settings **47/47**、client **60/60**、真机 e2e **70/70**(DSH 0.2.1-rc.2)。
