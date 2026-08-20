# dsh-backup

[![dsh-plugin](https://img.shields.io/badge/ecosystem-dsh--plugin-8b5cf6)](https://github.com/topics/dsh-plugin)
[![npm](https://img.shields.io/npm/v/@xiaoyuyu6420/dsh-backup)](https://www.npmjs.com/package/@xiaoyuyu6420/dsh-backup)
[![Publish to npm](https://github.com/xiaoyuyu6420/dsh-backup/actions/workflows/publish.yml/badge.svg)](https://github.com/xiaoyuyu6420/dsh-backup/actions/workflows/publish.yml)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

[English](README.md) | 简体中文

**dsh-backup 是 DeepSeek Harness（DSH）的备份插件：一条命令备份 `~/.dsh`，一条命令恢复。**

你在 DSH 里的会话记录、设置、技能、插件配置，全都在 `~/.dsh` 这一个目录里。误删了、改坏了、换电脑了——只要有过备份，就能找回来。

它能做到：

- **一键备份、一键恢复** —— 每份备份自动附带校验文件，随时能检查备份有没有损坏；旧备份自动清理，不会越积越多。
- **定时自动备份** —— 设好间隔就不用管了，重启 DSH 后照常继续。
- **密码等敏感文件不进备份包** —— 明文只留在本机的 `vault/` 目录里，恢复时自动放回原处（详见下文）。
- **换电脑不慌** —— 备份可以自动同步到你的 GitHub 私有仓库，新电脑拉回来就能恢复。
- **有图形界面** —— 不想敲命令，网页设置里有可视化面板。

支持 macOS、Linux、Windows。

## 安装

```sh
dsh plugin --profile web add @xiaoyuyu6420/dsh-backup
# 或者从 GitHub 安装：
dsh plugin --profile web add github:xiaoyuyu6420/dsh-backup
```

装完重启 `dsh web`。

## 快速上手

大约 30 秒：

1. 按上面装好插件，重启 `dsh web`
2. 输入 `/backup`
3. 搞定 —— 备份文件出现在 `~/Desktop/dsh-backups/`，文件名带时间戳

之后日常最常用的就是这一条命令。想定时自动备份？看下文。

## 场景速查

| 遇到什么情况 | 怎么办 |
|---|---|
| 日常备份一次 | `/backup`（或在面板里点「立即备份」） |
| 怕自己忘备份 | `/backup auto 12`（每 12 小时一次，重启不中断） |
| 配置改坏了、插件装坏了 | `/backup restore latest --dry-run` 先预览，确认后去掉 `--dry-run` 真正恢复 |
| `~/.dsh` 整个没了 | `/backup restore latest` |
| 换新电脑 | 见「换新电脑」一节 |
| 怀疑备份文件坏了 | `/backup verify all` |
| 想把备份放云端 | `/backup github repo 账号/dsh-backups`，之后每次备份自动推送（务必用私有仓库） |

## 命令一览

| 命令 | 作用 |
|---|---|
| `/backup` | 立即备份 |
| `/backup list` | 列出所有备份（名称、大小）和自动备份状态 |
| `/backup verify [前缀\|all]` | 校验备份是否完好，默认只查最新一份 |
| `/backup restore <前缀\|latest>` | 恢复，支持 `--dry-run`（只预览不动手）和 `--sync-deps`（恢复后重装插件依赖） |
| `/backup auto <小时数>\|off\|status` | 定时备份的开启、关闭、状态 |
| `/backup --keep N` | 覆盖保留份数（默认 7） |
| `/backup github …` | 云同步相关，见「GitHub 同步」 |
| `/backup delete <前缀\|latest>` | 删除某份备份及其附属文件 |

以上能力模型也能直接调用（工具 `backup_dsh`，`mode=backup|list|verify|restore|auto`，restore 支持 `syncDeps`）。

## 定时自动备份

```
/backup auto 12
```

从现在起每 12 小时自动备份一次（间隔可设 1~720 小时）。

- `/backup auto off` —— 关闭
- `/backup auto status` —— 查看状态

状态记录在备份目录的 `auto.json` 里。重启 DSH 后会接着上次的节奏排期，不会重新计时。保留份数：间隔不足 24 小时的默认留 3 份，更长的留 7 份（可用配置 `keep` 覆盖）。

## 换新电脑

前提：旧电脑已经配置了 GitHub 同步（见下一节）。

1. 新电脑装好插件，配置里填同一个 `githubRepo`
2. `/backup github pull` —— 把云端备份全部拉回本地（每份都做校验，损坏的自动跳过并报告）
3. `/backup restore latest --sync-deps` —— 恢复数据，并重装各 profile 的插件依赖
4. 重启 `dsh`

恢复报告会提示两件事：这份备份来自另一台电脑（留意配置里的绝对路径），以及哪些敏感文件需要重新填（它们不在备份包里，见下节）。想省一步，可以用 `/backup github pull --restore latest` 拉取后直接恢复。

## 敏感文件的处理（密码、token）

`.credentials.yaml`、`.env`、`qq-bridge/config.json` 这类存凭据的文件，默认**不打进备份包**：

- 备份时：明文复制到备份目录下的 `vault/` 文件夹，权限收紧到只有你能读（目录 700、文件 600）。备份包和云端同步的都是脱敏后的版本。
- 同一台电脑恢复：凭据自动从 `vault/` 放回原位，不用你动手。
- 新电脑恢复：本机没有 `vault/`，恢复报告会列出缺了哪些文件，重新填一遍即可。
- 想增减敏感文件：改配置里的 `redact` 列表；`redact: false` 可整个关闭这个机制（不推荐，等于回到 v0.7 之前的明文行为）。

每个备份还附带两个信息文件：`.meta.json`（备份来自哪台机器、哪个用户目录、什么时间）和 `.redacted.json`（哪些文件被脱敏了）。恢复前的预检会读取它们，跨机器恢复时提前给出提醒。

备份文件和校验文件在 macOS / Linux 上权限都是 600（只有你能读）；Windows 靠用户目录的访问控制。

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

## 可视化面板

打开 `dsh web` 的 **Settings → Plugins → 备份** 标签页：查看备份列表与大小、自动备份状态、GitHub 同步状态，支持一键备份、逐份校验、**下载**备份、恢复（先预览再二次确认），以及**从 GitHub 拉取**备份（新电脑恢复的第一步）。下载只走本机回环地址的接口，不对外暴露。

## 恢复是怎么工作的

恢复动的是你现有的数据，所以每一步都有保护：

1. **先校验**：备份文件损坏就直接中止，绝不碰现有数据。
2. **路径检查**：备份包里出现越界路径（tar 路径穿越）就拒绝恢复。
3. **预检提醒**：备份来自别的机器或用户目录时，提示绝对路径风险；脱敏备份则说明凭据会从本机 vault 还原（跨机恢复会列出要重填的）。
4. **先留后路**：现有的 `~/.dsh` 先自动快照，再移到 `~/.dsh.pre-restore-<时间戳>`。恢复是整体替换，不是合并，不会被旧文件搅浑；如果 `~/.dsh` 已经不存在（数据已经丢了，或新机首次恢复），跳过快照直接解压。
5. **解压还原**：解压备份；凭据从 vault 放回；`--sync-deps` 给各 profile 跑 `pnpm install`（node_modules 不进备份包，靠这步重装）。
6. **重启生效**：重启 `dsh`，会话和配置就回来了。

`--dry-run` 只显示概览和预检提示，不写入任何东西。拿不准就先 dry-run 一次。

## 配置（可选）

默认开箱即用，以下都可不配。想调整时，在生效的 cordis profile 里给插件加 `config`：

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

## 系统要求

- macOS、Linux 或 Windows 10+，PATH 里有 `tar`（Windows 自带）
- 校验优先用 `sha256sum` / `shasum`，没有就自动改用内置哈希（Windows 上就是这样）
- DSH `0.1.0-rc.6` 或兼容版本

## 故障排查

- **装错了包** —— 正确的包名是 `@xiaoyuyu6420/dsh-backup`（带前缀）。不带前缀的 `dsh-backup` 是无关的第三方包。检查 profile 的插件列表，用正确名字重装。
- **插件加载失败，报 `client api: method "backupPanel/remove" conflicts with its namespace service`** —— 你装的是 v0.5.0 旧版（详见 [#2](https://github.com/xiaoyuyu6420/dsh-backup/issues/2)、[#5](https://github.com/xiaoyuyu6420/dsh-backup/issues/5)）。v0.5.1 已修复：执行 `dsh plugin --profile web add @xiaoyuyu6420/dsh-backup@latest` 升级，重启 `dsh web` 即可。
- **Windows 上用哪个 `tar`？** 都行。系统自带 System32 里的 bsdtar，Git Bash 里是 GNU tar，校验功能在两种 shell 下都能正常工作。

## 开发

运行时零依赖，宿主插件就是 `lib/index.js`。浏览器端源码在 `src/`，打包产物 `lib/client.js` 直接提交进仓库（zod 内联，React / Cordis 保持 external），从 git 安装不需要构建。面板通过 `backupPanel` 命名空间（`/api` RPC）与宿主通信；下载走仅限本机的 `GET /backup-download/<归档名>` 路由。

存储说明：插件自有数据（归档、校验文件、`auto.json`、`vault/`）直接用 `node:fs` 写入，与 DSH 自身的会话持久化同一模式；`ctx.fs` 是模型侧的沙箱接口，不适用于宿主插件的自有存储。

```sh
node scripts/build-client.mjs   # 改 src/ 后重新打包客户端
node scripts/smoke.mjs          # 宿主冒烟测试（真实临时目录 + 模拟 DSH 服务）
node scripts/smoke-client.mjs   # 客户端 bundle 冒烟（握手 / schema / 标签页注册 / SSR）
```

## 致谢

- [@beastrobin](https://github.com/beastrobin) —— #1 中对保留方法名的根因分析，直接促成 v0.5.1 修复
- [@mlosun](https://github.com/mlosun) —— #2 中详尽的复现与根因报告
- [@Choi-Peng](https://github.com/Choi-Peng) —— #5 中协助把受影响用户指引到修复版本

## 许可证

MIT
