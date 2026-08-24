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
| **0.8.0** | 0.1.1-rc.2 | ✅ **当前 latest**（2026-08-25） | settings seam；e2e 11/11（含 panel RPC）+ 浏览器实操全绿；compat 首次实弹绿 |

## 已知陷阱（升列车前先读）

1. **semver prerelease 陷阱**：`^0.1.0-rc.6` 匹配不了 `0.1.1-rc.2`——npm 只允许同 `[major,minor,patch]` 元组的 prerelease 互相满足。每发新 rc 列车，peerDependencies 必须跟着升。
2. **客户端列车陷阱**：插件 web 面板依赖宿主 HTML 预加载 `/plugins/<pkg>/client.js`。0.1.1-rc+ 的 webserver 才生成预加载；旧列车上 node 侧一切正常但浏览器报 `client-modules: HTML did not preload @deepseek-ai/dsh-client-modules/client.js`。peerDependencies 表达不了这个约束——e2e 判据 #3 的 HTML 断言就是它的回归防线。
3. **pnpm 默认 24h 冷却期**：pnpm 10 在 CI 默认启用 `minimumReleaseAge`（供应链保护），新列车发布后 24h 内日常 CI 装 peers 会红。这是**有意保留的防线**：等满即可，不要在日常 CI 加豁免。compat 巡检 job 因职责是追新，显式豁免。

## 升列车 SOP

1. 确认上游变更面：diff 新旧列车各依赖包（重点 dsh-commands / dsh-settings / typert-protocol 的导出面）。
2. 升 `package.json` peerDependencies 到新列车 → 开 PR。
3. 等 pnpm 冷却期满（≤24h），CI 绿。
4. 手动触发 compat workflow（Actions → Host compat → Run workflow）或等每日巡检 → e2e 绿。
5. 合并 → 打 tag `vX.Y.Z` 自动发 npm（publish.yml）。
6. 更新上面的版本矩阵。

若 compat 巡检红了而仓库代码未变：优先怀疑上游列车破坏，看 [host-compat issue](../../issues?q=label%3Ahost-compat) 里的 run 链接定位。
