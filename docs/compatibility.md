# 宿主兼容性：验收标准与升列车 SOP

dsh 宿主频繁发布 rc 列车（如 `0.1.0-rc.x` → `0.1.1-rc.x`），本插件的兼容性靠**自动化验收**保证，不靠手工记忆。本文是唯一判据。

## 验收判据（全绿 = 兼容通过）

| # | 判据 | 谁跑 | 命令 |
|---|------|------|------|
| 1 | peer ranges 匹配目标列车（npm semver prerelease 规则） | 人 + CI | 对照 `package.json` peerDependencies |
| 2 | 零依赖桩 smoke 全绿（host 587 项 + settings 47 项 + client 60 项；Windows 下 smoke 574 项——36c/45b/47a 为 POSIX 专属，有平台守卫） | CI / 本地 | `node scripts/smoke.mjs && node scripts/smoke-settings.mjs && node scripts/smoke-client.mjs` |
| 3 | 真实宿主 e2e 全绿（boot、HTML 预加载、settings seam、持久化） | compat 巡检 / 本地 | `node scripts/e2e-host.mjs` |
| 4 | 浏览器面板渲染 + 核心动作可用（备份/保存/reset） | 发版前人工抽检一次 | 隔离环境 boot 后浏览器操作 |

e2e 脚本的断言清单见 `scripts/e2e-host.mjs` 头注释；其中 **HTML 预加载官方 client 包**这条专门防"客户端列车陷阱"（见下）。

## 版本矩阵

| dsh-backup | 宿主列车 | 状态 | 备注 |
|---|---|---|---|
| 0.14.1 | 0.2.1-rc.2(同 0.14.0) | ✅ 真机 e2e 70/70 | 补发:npm 上的 0.14.0 先于 Codex 支持发布(tag 触发 publish workflow),0.14.1 把 Codex 聊天记录导入同步到 npm 轨道;smoke 587 / settings 47 / client 60 / e2e 70。代码面与仓库 tag v0.14.0 一致。 |
| 0.14.0（**待发 npm**；本地验收 2026-10-18） | **0.2.1-rc.2**（rc.1 同列车，仅 release note 核对、未单独跑 e2e） | ✅ **真机 e2e 70/70（rc.2，2026-10-18）** | 备份文件夹 UX 重做（默认目录改名 `~/Desktop/DSH Backups`、每次备份写「使用说明.txt」、旧默认目录同盘自动改名，显式配置不动）+ 跟进 0.2.1 rc 列车。**零代码适配面**：六个 `@deepseek-ai/dsh-*` peer 包 alpha.5↔rc.2 **导出面逐包相同**（diff 仅依赖/peer 版本号随列车推进，含 cordis `~4.0.5-alpha.2`→`~4.0.5`、schemastery `~3.18.5-alpha.2`→`~3.18.5`）；该列车无 `session-format-v4-to-v5` 包，**格式代校准 v4 继续成立**；`engines.dsh` 优先规则不变（rc.2 宿主 `dsh-app-boot` 源码复核：`unmetRequirements()` 仍 `includePrerelease:true`、`engines.dsh` 自决）；真实 semver 实测 rc.1 / rc.2 均满足 `^0.2.0-rc.1`（默认规则不满足，与既有 alpha 列车一致——安装闸门按 includePrerelease 判定）。rc.1 release note 相关变更核对：① 插件启停/更新后依赖同步 + 可选热重载（本插件一键更新仍提示重启，文案已放宽为「面板没变化就重启」）；② 移除运行时 invariant 插件与 `./invariant` 导出（本插件未使用）；③ 子路径插件不再读独立 package.json（本插件入口经 exports `.` / `./client`，非子路径插件）；④ 插件安装结果显示真实版本 + 冷却期精确版本说明（与 #115 读回核对方向一致）；⑤ 凭据额外字段不再阻止启动（既有行为）。rc.2 仅新增 DeepSeek-V4.1-Flash-1017 与 Search/Fetch API，**无插件相关变更**。验收：真宿主 e2e **70/70**（基线 42 + 加密 7 / Rewind 7 / 外部导入 5 / 聊天导入 9 共 28 项）、smoke **587**（含迁移矩阵回归 36a–36d 旧默认目录改名边界 + 37 旧设置 `redact:'none'` 归一化 + 38 加密四项硬验收 + 39 导出/导入全链路 + 40 GFS 保留 + 41 操作锁/回收 + 42 磁盘占用/清理 + 43 每周调度 + 44 同步通道脱敏 + 45 about() 脱敏 + 46 配置管理 agent 工具 + 47 离线 CLI reinstall/sessions repair/recover-stale-lock + 48 本地 link/file 插件迁移 + 49 Profiles 管理 + 50 配置市场索引校验/预览/确认安装/供应链提示 + 51 外部 agent 导入（检测/预览/确认导入，MCP 只报告）+ 52 会话 Rewind 分叉 + 53 聊天记录导入(Claude Code)+ 54 聊天记录导入(Codex)(扫描/预览/导入为新会话,原数据零改动)|
| 0.13.4(npm latest;元数据版,2026-10-10) | **0.2.1-alpha.5** | ✅ **真机实测通过(2026-10-16)** | 0.13.4 只有 npm 元数据/文案变更(描述与关键词),功能与 0.13.3 完全一致;本轮把 0.2.1-alpha 列车连续推进到 **alpha.5**(alpha.3→4→5)并逐个跑真宿主 e2e:0.13.3 的修复面(#112/#119/#117/#115)在该列车全部成立,**e2e 41/41**(含大清单归档、v4 会话识别、附件硬链接、GitHub Token 保存/清除往返)。校验:peer 范围 `^0.2.0-rc.1` 仍天然覆盖(真实 semver `includePrerelease` 实测 `0.2.1-alpha.3` 满足);alpha.2→alpha.3 依赖键零增删、我们依赖的 6 个 `@deepseek-ai/dsh-*` 包版本号未变;该列车无 `session-format-v4-to-v5` 包,**格式代校准 v4 继续成立**;**下一 peer 边界仍为 0.3.0**。另据 alpha.3 release note 核对两条相关变更均**不构成影响**:「凭据文件额外字段不再阻止启动」——我们只读取/存底 `~/.credentials.yaml` 到自己的 vault,从不向宿主凭据文件写入字段;「插件更新后不再运行旧代码(支持热重载)」——我们的一键更新本就是「跑官方 update + 提示重启」,宿主新增热重载只会让流程更顺。 |
| 0.13.3（2026-10-03 已发 npm） | 0.1.5-rc.3 / 0.1.7-rc.2 / **0.2.0-rc.2** / 0.2.1-alpha.1 | ✅ **真机实测通过（2026-10-02/03）** | 内容=五项修复：#112 归档硬链接恢复（条目与目标都在备份根内放行）+ #113 迁移预检未知 kind 降级为提示 + #115 一键更新 `--latest` 并读回真实版本 + #117 会话日志按文件名世代识别（校准代 v4）+ #119 归档清单改原始流逐行校验（修大归档被 spill 截断误拒）。验证：smoke **337**、settings 47、client 29；真宿主 e2e 四条列车各 **41/41**。peers 不变（`0.2.1-alpha.1` 天然落在 `^0.2.0-rc.1` 内，**下一 peer 边界 0.3.0**）；会话格式代校准 v4（该列车无 `session-format-v4-to-v5` 包、文件名正则未变） |
| ≤0.6.x | 0.1.0-rc.6+ | 历史版本，不再维护 | |
| 0.7.0–0.7.1 | 0.1.0-rc.8 | ⚠️ 仅 node 侧可用 | web 客户端在旧列车上报 "HTML did not preload"（陷阱②） |
| 0.7.2 | 0.1.1-rc.2 | 历史版本 | peers `^0.1.1-rc.2` |
| 0.8.0 | 0.1.1-rc.2 | 历史版本 | settings seam |
| 0.9.0 | 0.1.1-rc.2 | 历史版本 | doctor 体检/救援通道/智能备份三件/恢复保护；发版前全量兼容实测：9 个历史版本真实归档恢复 + 0.7.2/0.8.0→main 真实宿主升级 + 自动备份真定时全绿（598 断言） |
| 0.11.3（2026-09-12 已发 npm） | 0.1.5-rc.1 / rc.2 | ✅ 本地全量验收绿（2026-09-12） | peers 追加 `^0.1.5-rc.1`（semver 同元组规则覆盖 rc.2）。rc.2 适配面实测为零：六个 node 侧 peer 包 rc.1↔rc.2 **逐字节相同**（tarball diff，导出面零增删），client 包列车未动（dsh-client-runtime 最新仍为 0.1.1-rc.2）。rc.2 真机 e2e 32/32；跨列车原地升级 e2e（rc.1 宿主 + 0.11.2 → rc.2 宿主 + 0.11.3）14/14，设置与归档无损 |
| 0.12.0（2026-09-12 已发 npm） | ✅ 本地全量验收绿（2026-09-12：smoke 256 + e2e-host 34 + 跨列车升级 14） | 新增迁移预检（拒绝规则校准自宿主 0.1.5-rc.2 的冻结清单：v0 51 类 / v2 51 类 / 来源 kind 15 类）与凭据哨兵；peers 不变，声明 `engines.dsh` |
| 0.13.0（2026-09-21 已发 npm） | 0.1.5-rc.1 / rc.2 | ✅ 本地全量验收绿：smoke 283 + e2e-host 37 + settings 47 + client 25 | 更新感知（`/backup check-update` + 面板卡）与一键更新（`/backup update`，更新前自动留升级前快照）；peers 不变 |
| 0.13.2（2026-09-29 已发 npm，**当前 latest**） | 0.1.5-rc.2 / rc.3 / 0.1.7-rc.2 / **0.2.0-rc.1 / rc.2** | ✅ **真机实测通过（2026-09-29）** | 适配 0.2.0 列车：① peers/engines 追加 `^0.2.0-rc.1`——宿主自 **0.1.7-rc.1** 起就有**安装期兼容闸门**（`packages/boot/app-boot/src/plugin-compatibility.ts`，我们当时的 `^0.1.7-alpha.1` 恰好覆盖同元组 rc.1，所以直到换 minor 才撞上）；0.2.0 列车若不覆盖则直接拒绝安装（实测报 `installation rejected: ... is incompatible with dsh 0.2.0-rc.1`，用户只能靠 `dsh plugin allow-version` 手动豁免）；② **修复 0.1.7 起失效的设置表单**：宿主在 0.1.7 移除了 `ctx.settings.register(ns, schema)`，改为从「条目的 Config schema」派生表单且**只认标了 `volatile` 的字段**（宿主 `volatileForm` 仅当 `meta.volatile` 存在才纳入）。本插件导出 `Config` 并逐字段 `.volatile()`（运行时探测：老 schemastery 无此方法则原样返回），0.1.7/0.2.0 上设置卡片从「400 报错」恢复为可读可写、用户层写入 profile 覆盖文件并跨重启生效；③ 命名空间万一仍缺失时显式降级（200 + `unavailable` + 说明），不再抛原始 TypeError。验证：smoke 312、settings 47、client 29；真宿主 e2e 0.1.7-rc.2 **37/37**、0.2.0-rc.1 **37/37**、0.2.0-rc.2（现 latest）**37/37**（设置 seam 全程真跑）；0.1.5-rc.2 老模型回归：设置 GET/POST 正常；0.1.5-rc.3 于 2026-09-30 以主线（0.13.2 + #112/#113）补验 e2e **37/37**（含 GitHub Token 保存/清除往返）；**待发版批次（#112 归档硬链接 + #113 预检误报 + #115 更新跨 minor + #117 v4 会话识别 + #119 大清单恢复）于 2026-10-02 在 0.1.5-rc.3 / 0.1.7-rc.2 / 0.2.0-rc.2 三条列车真机复验 e2e 各 41/41**（含大清单备份→恢复、v4 日志识别、附件硬链接恢复——#119 的 `stdout:'pipe'` 流式校验在最老受支持列车上同样成立）；**下一列车侦察：`0.2.1-alpha.1`（2026-10-03 发布当天）真机 e2e 41/41**——peer 范围 `^0.2.0-rc.1` 天然覆盖（`0.2.1-alpha.1` 落在 `>=0.2.0-rc.1 <0.3.0-0` 内，无需改 peers；**下一个 peer 边界是 0.3.0**），且该列车会话格式代仍为 **v4**（无 `session-format-v4-to-v5` 包、文件名正则未变），故 `MIGRATE_CALIBRATED_VERSION = 4` 继续成立；另含 #104 调度器启动卡死修复（#103）与 #107 review P2 债清偿 |
| 0.13.1（2026-09-25 已发 npm） | 0.1.6-alpha.1 / 0.1.7-alpha.1（含 **0.1.7-rc.1**） | ✅ **真机实测通过（2026-09-23，#94 修复；0.1.7-rc.1 于 09-24 补测）** | 修 0.1.6+ 面板标签静默消失（#94）：① strict codec 补 `create()` 惰性工厂（0.1.6 起强制，缺失时 `$mount` 抛 "strict codec has no create() factory"）；② `$mount` 改为声明式等待 `remote` 服务就绪；③ 挂载失败注册可见降级标签页。peers 追加 `^0.1.6-alpha.1 \|\| ^0.1.7-alpha.1`。验证：0.1.6-alpha.2 / 0.1.7-alpha.2 / **0.1.7-rc.1** 隔离环境实机（Built-in plugins 标签页出现、面板各卡片可用）。`^0.1.7-alpha.1` 语义覆盖同元组 rc.1，peer 无需再改 |

## 归档格式兼容（插件自身）

归档格式变更必须双向兼容：**新版本能读旧归档**（新 meta 字段缺省视为旧行为，如 `meta.types` 缺省 = 全量归档）、**旧版本遇新归档安全降级**（新前缀归档如 `dsh-t-` 不进旧版 listBackups/轮换——看不见、不误删）、meta/边车字段只增不改。smoke.mjs 的"老归档无边车兼容"与分类型场景是这一节的回归防线。

## 已知陷阱（升列车前先读）

1. **semver prerelease 陷阱**：`^0.1.0-rc.6` 匹配不了 `0.1.1-rc.2`——npm 只允许同 `[major,minor,patch]` 元组的 prerelease 互相满足。每发新 rc 列车，peerDependencies 必须跟着升。
2. **客户端列车陷阱**：插件 web 面板依赖宿主 HTML 预加载 `/plugins/<pkg>/client.js`。0.1.1-rc+ 的 webserver 才生成预加载；旧列车上 node 侧一切正常但浏览器报 `client-modules: HTML did not preload @deepseek-ai/dsh-client-modules/client.js`。peerDependencies 表达不了这个约束——e2e 判据 #3 的 HTML 断言就是它的回归防线。
3. **pnpm 默认 24h 冷却期**：pnpm 10 在 CI 默认启用 `minimumReleaseAge`（供应链保护），新列车发布后 24h 内日常 CI 装 peers 会红。这是**有意保留的防线**：等满即可，不要在日常 CI 加豁免。compat 巡检 job 因职责是追新，显式豁免。
4. **strict codec 必须带 `create()`（0.1.6 起）**：客户端 Remote 贡献的 strict codec 在 0.1.5 只校验 `schema` 字段，0.1.6 起强制要求惰性工厂 `create()`（缺失时 `$mount` 抛 `strict codec has no create() factory`，且失败是静默的——面板标签直接消失，见 #94）。本仓库 `src/client.js` 的 `strictCodec()` helper 同时提供 `schema`（0.1.5 读）与 `create: () => schema`（0.1.6 读），两代共用同一 zod 实例。
6. **设置表单模型换了（0.1.7 起）**：`ctx.settings.register(ns, schema)` 被移除，宿主改从「插件条目的 Config schema」派生设置表单，且**只有标了 `volatile` 的字段会出现在表单里**（`dsh-settings` 的 `volatileForm` 只认 `meta.volatile`，非对象字段尤其如此）。插件必须 `export const Config`（Schemastery，需带 `toJSON`）并给可运行时修改的字段加 `.volatile()`。漏了不会报错——设置项在宿主里**静默消失**：插件自注册的命名空间不在 `describe()` 里，读设置会读到 `undefined`（旧实现直接抛 `Cannot read properties of undefined (reading 'value')`），写设置静默失败。本仓库的回归防线：smoke 场景 31（Config/volatile 形状 + 显式降级）与 e2e 的 settings seam 断言（真跑而非跳过）。
   衍生坑：`.volatile()` 是 `@deepseek-ai/schemastery` **3.18.4** 才有的方法（3.18.1 没有）——插件代码要用运行时探测（本仓库 `volatileField`）兜住老载体，否则老宿主上装载期就崩。
   另一处随列车变化：设置的用户层落点。≤0.1.6 写 `$DSH_HOME/settings.yaml`；0.1.7 起由宿主写 profile 覆盖文件（`profiles/<name>/cordis.patch.yml` 的条目 `config`）。断言/文档别写死其中一个。

7. **安装期兼容闸门（0.1.7-rc.1 起）**：宿主在 `dsh plugin add/update` 时校验插件 manifest 的 peerDependencies，**只检查名字为 `@deepseek-ai/dsh` 或以 `@deepseek-ai/dsh-` 开头的项**，判定式是 `semver.satisfies(宿主版本, 范围, { includePrerelease: true })`（读自宿主 `dsh-app-boot` 实现，2026-09-29 核实）；不匹配即**拒绝安装**，给出 `dsh plugin allow-version <pkg>@<ver> --dsh-version <v> --accept-risk` 的按版本豁免口子。两点推论：
   - ⚠️ **`engines.dsh` 的地位在 0.2.1-alpha.4 变了（2026-10-16 读宿主实现核实）**：此前 `engines.dsh` 不参与判定（boot 与 CLI 都不读它）；**0.2.1-alpha.4 起，插件 manifest 若自有 `engines.dsh` 声明，就由它单独决定**（宿主 `dsh-app-boot` 的 `unmetRequirements()`：`Object.hasOwn(engines,"dsh")` 命中即 `return`，不再看 peerDependencies）；**未声明 `engines.dsh` 的插件沿用原 peer 规则**。对本插件**无实际影响**——我们的 `engines.dsh` 与 `@deepseek-ai/dsh-*` peers 声明**逐字符相同**，故两种规则下判定结果一致；已用真实 semver（`includePrerelease`）复算五条受支持列车（0.1.1-rc.2 / 0.1.5-rc.3 / 0.1.7-rc.2 / 0.2.0-rc.2 / 0.2.1-alpha.4）**全部满足**。**给其他插件作者的提醒**：升级到 0.2.1-alpha.4+ 后，`engines.dsh` 写窄了会被直接拒（且不再有 peers 兜底），声明时务必覆盖你实际支持的列车。
   - 由于 semver 对**带 prerelease 下界**的 caret 会把上界压到 `<下一个 minor>-0`（`^0.1.7-alpha.1` → `<0.2.0-0`），每个新 minor 列车都要**显式加一档范围**，`includePrerelease` 也救不了跨 minor 的场景（`0.2.0-rc.1` 不满足 `^0.1.7-alpha.1`，已用宿主自带 semver 复算确认）。
   附一条实测事实（dshworks 维护者 lroolle 交叉验证）：profile 安装走 pnpm 且 **`autoInstallPeers: false`**，profile 的 `node_modules` 里不会出现 `@deepseek-ai/dsh-*`，宿主包的 import 由 dsh 解析器指回宿主自身——所以插件放宽 peer 范围**不会**把宿主包拖进 profile（不必担心版本冲突）。

## 升列车 SOP

1. 确认上游变更面：diff 新旧列车各依赖包（重点 dsh-commands / dsh-settings / typert-protocol 的导出面）。
2. 升 `package.json` peerDependencies 到新列车 → 开 PR。
3. 等 pnpm 冷却期满（≤24h），CI 绿。
4. 手动触发 compat workflow（Actions → Host compat → Run workflow）或等每日巡检 → e2e 绿。
5. 合并 → 打 tag `vX.Y.Z` 自动发 npm（publish.yml）。
6. 更新上面的版本矩阵。

若 compat 巡检红了而仓库代码未变：优先怀疑上游列车破坏，看 [host-compat issue](../../issues?q=label%3Ahost-compat) 里的 run 链接定位。
