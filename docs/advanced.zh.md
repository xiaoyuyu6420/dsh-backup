# dsh-backup 进阶文档

日常使用看 [README](../README.zh.md) 即可；这里放完整细节：定时备份策略、GitHub 同步、敏感文件脱敏、恢复保护、配置、故障排查和开发说明。

## 定时自动备份

```
/backup auto 12
```

从现在起每 12 小时自动备份一次（间隔可设 1~720 小时）。

- `/backup auto off` —— 关闭
- `/backup auto status` —— 查看状态

状态记录在备份目录的 `auto.json` 里。重启 DSH 后会接着上次的节奏排期，不会重新计时。保留份数：间隔不足 24 小时的默认留 3 份，更长的留 7 份（可用配置 `keep` 覆盖）。

## 智能备份

三个自动行为，无需配置：

**升级前自动快照** —— 启动时检测宿主版本变化：升/降级都先自动拍一份 `dsh-pre-upgrade-*` 快照再继续，"想试新版怕搞坏"的后悔药常备。探测的是**正在运行的宿主**（从进程启动入口向上定位 `@deepseek-ai/dsh` 官方包读版本，全局 / npm / `npx @deepseek-ai/dsh web` 缓存等安装形态都覆盖），而不是 profile 里 hoisted 的旧 peer 副本——所以 `npx` 升级宿主也能正确触发。首见列车只记录不拍；快照最多保留 2 份，不占 keep 配额、不进轮换；`/backup list` 在「内部快照」分区展示，可用 `/backup restore dsh-pre-upgrade-<时间>` 显式恢复。钩子会等 settings 装配完成再动手，快照落在你配置的备份目录里。

**备份前体检联动** —— 每次备份前先做一遍会话体检：损坏的会话日志**不入档**（防止坏字节进归档后，轮换在不知情中删掉最后一份好副本）。隔离清单记入归档的 `.meta.json`，回执会警告，恢复预检也会提示这些会话缺失——用 `/backup doctor --repair` 从更早归档修复后即可正常入档。

**分级轮换** —— keep 窗口之外的旧备份不再一刀切全删：保留最近 7 个不同自然日的每日首份、再往前 4 个不同 ISO 周的每周首份，其余才删除。同日多次备份的冗余仍按 keep 裁剪。严格只比旧的"全删"多保留，不会多删任何东西。

## GitHub 同步（可选）

在插件配置里填上 `githubRepo`，之后每次备份（手动、定时、面板点的）都会自动推送到这个 Git 仓库，删除旧备份也会一并同步：

```yaml
- id: dsh-backup
  name: 'dsh-backup'
  config:
    githubRepo: '你的账号/dsh-backups'   # 支持 owner/repo、完整 URL 或本地路径
```

几个要点：

- **务必用私有仓库** —— 备份虽然不含密码明文，但有你的会话内容。
- 走 https 需要 token：环境变量 `DSH_BACKUP_GITHUB_TOKEN` 或 `GITHUB_TOKEN`。token 只写进同步工作树的凭据文件，不会出现在进程参数里。
- 推送方式是 `HEAD:main --force-with-lease`，也就是远端 main 会被对齐成本地备份目录的状态——别往这个仓库里手动放别的东西。
- 单个备份超过 90MB 会跳过推送并提示。
- 同步状态（上次推送、最近错误）在 `/backup github status` 和面板里都能看到；`/backup github sync` 可以不等下一次备份，立即推送一次。

## 敏感文件的处理（密码、token）

`.credentials.yaml`、`.env`、`qq-bridge/config.json` 这类存凭据的文件，默认**不打进备份包**：

- 备份时：明文复制到备份目录下的 `vault/` 文件夹，权限收紧到只有你能读（目录 700、文件 600）。备份包和云端同步的都是脱敏后的版本。
- 同一台电脑恢复：凭据自动从 `vault/` 放回原位，不用你动手。
- 新电脑恢复：本机没有 `vault/`，恢复报告会列出缺了哪些文件，重新填一遍即可。
- 想增减敏感文件：改配置里的 `redact` 列表；`redact: false` 可整个关闭这个机制（不推荐，等于回到 v0.7 之前的明文行为）。

每个备份还附带两个信息文件：`.meta.json`（备份来自哪台机器、哪个用户目录、什么时间）和 `.redacted.json`（哪些文件被脱敏了）。恢复前的预检会读取它们，跨机器恢复时提前给出提醒。

备份文件和校验文件在 macOS / Linux 上权限都是 600（只有你能读）；Windows 靠用户目录的访问控制。

## 可视化面板

打开 `dsh web` 的 **Settings → Plugins → 备份** 标签页：查看备份列表与大小、自动备份状态、GitHub 同步状态，支持一键备份、逐份校验、**下载**备份、恢复（先预览再二次确认），以及**从 GitHub 拉取**备份（新电脑恢复的第一步）。下载只走本机回环地址的接口，不对外暴露。

## 恢复的保护机制

恢复动的是你现有的数据，所以每一步都有保护：

1. **先校验**：备份文件损坏就直接中止，绝不碰现有数据。
2. **路径检查**：备份包里出现越界路径（tar 路径穿越）就拒绝恢复。
3. **预检提醒**：备份来自别的机器或用户目录时，提示绝对路径风险；脱敏备份则说明凭据会从本机 vault 还原（跨机恢复会列出要重填的）。
4. **先留后路**：现有的 `~/.dsh` 先自动快照，再移到 `~/.dsh.pre-restore-<时间戳>`。恢复是整体替换，不是合并，不会被旧文件搅浑；如果 `~/.dsh` 已经不存在（数据已经丢了，或新机首次恢复），跳过快照直接解压。
5. **解压还原**：解压备份；凭据从 vault 放回；`--sync-deps` 给各 profile 跑 `pnpm install`（node_modules 不进备份包，靠这步重装）。
6. **重启生效**：重启 `dsh`，会话和配置就回来了。

`--dry-run` 只显示概览和预检提示，不写入任何东西。拿不准就先 dry-run 一次。

## 会话日志体检与定点修复（doctor）

社区里最常见的"数据灾难"是会话日志损坏：两个 DSH 进程并发写同一会话、崩溃恢复时收尾事件撞号，都会报 `corrupt session log: seq gap`，严重时一条坏日志能拖垮整个会话列表。`/backup doctor` 把这种灾难变成小事：

```
/backup doctor                         # 只读体检
/backup doctor --repair                # 从最近一份备份定点修复
/backup doctor --repair <前缀|latest>   # 指定从哪份备份修
```

- **查什么**：扫描 `~/.dsh` 下全部会话日志（`session.jsonl.zstd` / `session.jsonl`），逐个做三件事——zstd 帧结构走查（坏魔数、截断帧、越界块）、逐帧解压校验、逻辑行校验（首行必须是 SessionHeader，其后事件 seq 必须连续；packed chunk 行按成员数推进游标）。全程只读，不写任何文件。
- **怎么修**：`--repair` 只动损坏的文件本身——先通过 sha256 校验选定归档，把损坏现场留档为 `<原名>.corrupt-<时间戳>`（留作排查宿主 bug 的证据），再从归档提取同名条目覆盖，修完自动复检。不做整库恢复、不碰健康数据。
- **修不了怎么办**：归档里没有对应副本（比如损坏发生在首次备份之前）会如实列出；此时用 `/backup restore latest` 走全量恢复。
- **模型工具**：`backup_dsh` 的 `mode=doctor` 同样可用（`repair: true` 触发修复），也可以直接让 Agent 帮你体检。

体检的格式依据宿主内置的 `@deepseek-ai/dsh-session-persistence-jsonl`；若宿主升级后出现成片误报，请提 issue。

## 救援通道（DSH 彻底起不来时）

dsh-backup 是宿主插件——DSH 进程起不来时它也死了。救援通道补的就是这个洞：**每次备份都会往备份目录里写一套进程外自救工具**，只用 Node 内置能力 + 系统 tar，不依赖任何 DSH 组件。DSH 依赖 Node 才能跑，所以宿主坏了 Node 一定活着。

备份目录（默认 `~/Desktop/dsh-backups/`）里躺着：

- **点我恢复.command / .bat / .sh**（按你的系统生成其一）——双击即启动救援网页并自动打开浏览器，全程不用终端
- **RESCUE.txt**——自救说明，双击文件丢了看这个
- **rescue.mjs**——零依赖单文件工具本体

救援网页（127.0.0.1，仅本机）：列出备份、逐份校验、恢复（预览 + 确认弹窗，现有数据先快照挪旁）、会话体检与定点修复。

终端用法：

```
node rescue.mjs                        # 打开救援网页（同双击）
node rescue.mjs list                   # 列出备份
node rescue.mjs verify all            # 校验完整性
node rescue.mjs restore latest --yes  # 恢复（不带 --yes 先预览）
node rescue.mjs doctor --repair       # 会话日志体检/修复
```

恢复语义与插件内完全一致：先校验 → 路径穿越防护 → 现有数据快照挪旁（失败自动回滚）→ vault 凭据还原；老归档（无边车）静默降级。网页接口只监听回环地址，且写操作要求自定义请求头（防浏览器跨站触发）。

新电脑/备份目录也丢了：装过插件后可用 `npx -p @xiaoyuyu6420/dsh-backup dsh-rescue`，再配 GitHub 拉回备份。

## 老备份包兼容（v0.6.x 及更早）

v0.7.0 起每份备份附带 `.meta.json`（机器元数据）与 `.redacted.json`(脱敏清单) 两个边车文件；更早的归档没有边车也能正常校验、恢复（`.sha256` 校验文件自第一个版本就有）：

- 恢复预检静默降级：不再显示脱敏 / vault 提示行。
- 若归档未携带脱敏清单且不含凭据文件，预检会提醒"恢复后凭据需补齐"——v0.6.x 时代还没有默认脱敏，跨这个大版本的恢复请留意凭据从哪来。

## 配置参考

默认开箱即用，以下都可不配。配置按优先级从高到低解析：

1. **`settings.yaml`** —— 用户通过 Web 面板保存或 `/dsh-backup/settings` HTTP API 写入；持久化在 `~/.dsh/settings.yaml`，立即生效。
2. **`cordis.patch.yml`** —— profile 级 `config` 块（传统 DSH 插件配置）；作为 base 层。
3. **Schema 默认值** —— 内置默认（`destination: ~/Desktop/dsh-backups`、`keep: 7`、`exclude: []`、`redact: [敏感文件默认]`、`githubRepo: ''`）。

### 通过 Web 面板（推荐）

打开 Settings → Plugins → 备份，在总览卡片中编辑备份目录 / 保留份数 / 排除模式，点击**保存**。修改写入 `settings.yaml`，下次备份即生效，无需重启。点击**恢复默认**可清除用户层覆盖、回退到 `cordis.patch.yml` 的 base 值。

### 通过 `cordis.patch.yml`（管理员 / 批量部署）

在生效的 cordis profile 里给插件加 `config`，作为 base 层；用户在面板中的编辑会覆盖这些值：

```yaml
- id: dsh-backup
  name: 'dsh-backup'
  config:
    destination: '~/Backups/dsh'   # 备份存放位置（默认 ~/Desktop/dsh-backups）
    keep: 10                       # 手动备份保留几份（默认 7）；设了以后定时备份也按这个数
    exclude:                       # 额外排除的内容（tar --exclude 语法）
      - '*cache*'
    redact:                        # 追加敏感文件（相对 ~/.dsh 的路径）；false 或 'off' 关闭脱敏
      - 'some-plugin/token.json'
    githubRepo: '账号/dsh-backups' # GitHub 同步，见上文
```

## 故障排查

- **装错了包** —— 正确的包名是 `@xiaoyuyu6420/dsh-backup`（带前缀）。不带前缀的 `dsh-backup` 是无关的第三方包。检查 profile 的插件列表，用正确名字重装。
- **插件加载失败，报 `client api: method "backupPanel/remove" conflicts with its namespace service`** —— 你装的是 v0.5.0 旧版（详见 [#2](https://github.com/xiaoyuyu6420/dsh-backup/issues/2)、[#5](https://github.com/xiaoyuyu6420/dsh-backup/issues/5)）。v0.5.1 已修复：执行 `dsh plugin --profile web add @xiaoyuyu6420/dsh-backup@latest` 升级，重启 `dsh web` 即可。
- **Windows 上用哪个 `tar`？** 都行。系统自带 System32 里的 bsdtar，Git Bash 里是 GNU tar，校验功能在两种 shell 下都能正常工作。

## 开发

运行时依赖 `@deepseek-ai/dsh-settings` 与 `@deepseek-ai/schemastery`（settings seam，均为 peer dependency），宿主插件就是 `lib/index.js`。浏览器端源码在 `src/`，打包产物 `lib/client.js` 直接提交进仓库（zod 内联，React / Cordis 保持 external），从 git 安装不需要构建。面板通过 `backupPanel` 命名空间（`/api` RPC）与宿主通信；设置经 `/dsh-backup/settings` HTTP 路由走官方 `ctx.settings` seam；下载走仅限本机的 `GET /backup-download/<归档名>` 路由。

**RPC 方法名保留字**（贡献者注意）：`backupPanel` 的新增 RPC 方法名不得撞上宿主 `RemoteNamespaceService` 的命名空间成员——`ctx`、`empty`、`invokeRemote`、`methods`、`name`、`namespace`、`has`、`install`、`installDirect`、`installScoped`、`remove`，以及 `Object.prototype` 名（`toString`、`valueOf` 等）。撞上会在运行时装配阶段让插件整体加载失败（v0.5.0 的 `backupPanel/remove` 事故，见 #2）。`node scripts/smoke.mjs` 场景 19 会对全部注册方法名做预检，提 PR 前先跑一遍。

存储说明：插件自有数据（归档、校验文件、`auto.json`、`vault/`）直接用 `node:fs` 写入，与 DSH 自身的会话持久化同一模式；`ctx.fs` 是模型侧的沙箱接口，不适用于宿主插件的自有存储。

```sh
node scripts/build-client.mjs   # 改 src/ 后重新打包客户端
node scripts/smoke.mjs          # 宿主冒烟测试（真实临时目录 + 模拟 DSH 服务）
node scripts/smoke-client.mjs   # 客户端 bundle 冒烟（握手 / schema / 标签页注册 / SSR）
```
