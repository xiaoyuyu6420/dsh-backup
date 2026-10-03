# 宿主兼容性：验收标准与升列车 SOP

dsh 宿主频繁发布 rc 列车（如 `0.1.0-rc.x` → `0.1.1-rc.x`），本插件的兼容性靠**自动化验收**保证，不靠手工记忆。本文是唯一判据。

## 验收判据（全绿 = 兼容通过）

| # | 判据 | 谁跑 | 命令 |
|---|------|------|------|
| 1 | peer ranges 匹配目标列车（npm semver prerelease 规则） | 人 + CI | 对照 `package.json` peerDependencies |
| 2 | 零依赖桩 smoke 全绿（host 114 项 + client 20 项） | CI / 本地 | `node scripts/smoke.mjs && node scripts/smoke-client.mjs` |
| 3 | 真实宿主 e2e 全绿（boot、HTML 预加载、settings seam、持久化） | compat 巡检 / 本地 | `node scripts/e2e-host.mjs` |
| 4 | 浏览器面板渲染 + 核心动作可用（备份/保存/reset） | 发版前人工抽检一次 | 隔离环境 boot 后浏览器操作 |

e2e 脚本的断言清单见 `scripts/e2e-host.mjs` 头注释；其中 **HTML 预加载官方 client 包**这条专门防"客户端列车陷阱"（见下）。

## 版本矩阵

| dsh-backup | 宿主列车 | 状态 | 备注 |
|---|---|---|---|
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
   - `engines.dsh` **不参与**判定（boot 与 CLI 都不读它）——只声明 engines 不声明 peers 的插件，过不了这道门；
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
