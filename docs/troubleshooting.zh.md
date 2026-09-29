# 故障排查：按症状与报错找答案

> 本文按「你看到的现象 / 报错原文」组织——每个条目给出 **原因 → 处理 → 涉及版本**。
> 命令都在 dsh 会话里以 `/backup` 开头输入；救援通道条目除外。

## 升级 DSH 后，部分老会话打不开（转圈、报错、或打开即空白）

**原因**：会话日志格式有代际（v0/v1/v2/v3），新版宿主会拒绝某些旧形态（subagent descriptor 旧版本、插件注入的历史事件类型、自定义来源 kind、seq 漂移、文件名代际不一致等）。

**处理**：
1. 升级**前**先预检：`/backup migrate-check` —— 静态扫描全部会话日志，列出哪些会话升级后会打不开、各挂在哪条规则，并顺带探测文件系统硬链接支持；
2. 升级前拍一份：`/backup`；
3. 升级后确实打不开的，用更早的归档定点修复：`/backup doctor --repair <前缀|latest>`。

**兜底**：插件在检测到宿主列车变化时会自动留一份 `dsh-pre-upgrade-*` 升级前快照。

## 会话日志损坏：seq 撞号 / 坏帧 / 截断 / 悬空 tool_calls

**处理**：`/backup doctor` 体检（只读，不写任何文件），它逐行校验会话头、seq 连续性、zstd 帧边界与 packed chunk；损坏项用 `/backup doctor --repair <前缀|latest>` 从归档定点修复（先留档 `*.corrupt-*` 再覆盖，失败自动还原现场）。

**机制**：每次备份前都会先体检——损坏的会话日志**不入档**，隔离清单记入 `.meta.json`，防止坏字节进归档后轮换把最后一份好副本也带走。

## 备份「成功」了，但归档只有几十字节（Windows）

**症状**：`dsh-<时间戳>.tar.gz` 大小恒为 29 字节；没有 `.sha256`、没有 `.meta.json`；tar 的 stderr 是 `Couldn't visit directory: No such file or directory`。

**原因**：`DSH_HOME` 直接挂在盘符根目录（如 `D:\dsh_data`）时，旧版求父目录退化成裸盘符 `D:`，`tar -C D:` 必然失败，且失败前已创建文件留下空壳。

**处理**：升级到 **0.12.2+**（该版本已修，并且 tar 失败会删除空壳并报错，不再静默）。升级前如何自查：看备份目录里的归档大小与 `.sha256` 边车是否齐全。

## 装了插件后 DSH 启动卡住（Windows，`~/.dsh` 有几个 GB）

**症状**：每次启动都停在启动画面，宿主日志出现 `DSH Host call cancelled or timed out`（HostRpc 30 秒超时），窗口一直不 ready；安全模式秒开、卸载插件立刻恢复。备份目录里能看到**写完了但缺少 `.sha256` / `.meta.json` 边车**的几 GB 归档。

**原因**（0.13.1 及更早，三个因素叠加）：

1. **哈希回退的体积上限**：Windows 上若没有 `sha256sum` / `shasum`，插件回退到 Node 内存哈希，**超过 256MB 直接报错**——几 GB 的归档因此永远收不了尾，归档是孤儿（有 tar 没有校验和）；
2. **失败不写盘**：收尾失败时"上次执行时间"只改内存不落盘，`auto.json` 里的时间戳永远停在过去；
3. **启动即补跑**：下次启动发现"错过了一轮"，`delay≤0` 立刻补跑一次全量 tar+gzip（几 GB 要几分钟），正好压在宿主 boot 窗口里抢 CPU/IO，宿主 30 秒 RPC 超时 → 被判失败 → 强杀 → 锚点还是没更新 → **每次启动都重演**。

**处理**：升级到 **0.13.2+**。该版本起：哈希改为流式（无体积上限、不整包读入内存）；重活一律推迟到启动 45 秒之后；每次起跑先落盘"尝试时间"，失败/被杀都不会再立刻重跑（失败按 30 分钟起指数退避）；备份目录里最新归档本身也是调度锚点。失败原因会写进 `auto.json` 的 `lastAutoError`，并在 `/backup auto status` 与面板上显示，不再静默。

**临时自救（升级前）**：`/backup auto off` 关掉定时备份即可（关掉后启动路径不再有重活）；彻底一点就在 `cordis.patch.yml` 里把本插件 `disabled: true`。已产生的孤儿归档可以手动删除（它们内容完整但没有校验和，`/backup verify` 会提示缺少边车）。

## 升到 DSH 0.2.0 后装不上本插件：`installation rejected: ... is incompatible with dsh 0.2.0-rc.1`

**原因**：宿主自 **0.1.7-rc.1** 起有**安装期兼容闸门**——声明了 peerDependencies（且名字是 `@deepseek-ai/dsh` 或 `@deepseek-ai/dsh-*`）的插件，若 peer 范围不覆盖当前宿主版本，`dsh plugin add/update` 会直接拒绝安装（不再只是警告）。跨 minor 列车（如 0.1.x → 0.2.x）尤其容易撞上：semver 对带 prerelease 下界的 caret 会把上界压到 `<下一个 minor>-0`，所以每换一个 minor 都要显式加一档范围。

**处理**：升级到 **0.13.2+**（peers/engines 已包含 `^0.2.0-rc.1`）。若你暂时不能升级，可按宿主的提示手动豁免（仅限你确认过风险时）：

```sh
dsh plugin --profile web allow-version @xiaoyuyu6420/dsh-backup@<版本> --dsh-version 0.2.0-rc.1 --accept-risk
```

## 设置卡片打不开 / 改了不生效（宿主 0.1.7 及以上）

**症状**：设置 → 插件 → 备份里的「设置」卡片读不出当前配置（或浏览器控制台可见 `/dsh-backup/settings` 返回 400 `Cannot read properties of undefined (reading 'value')`）；改了值保存后重启又回默认。

**原因**：宿主 **0.1.7 起换了设置模型**——`ctx.settings.register(ns, schema)` 被移除，改由「插件条目的 Config schema」派生表单，且只有标了 `volatile` 的字段会进表单。0.13.1 及更早没有导出 `Config`，于是本插件的设置项在宿主侧**静默不存在**（0.1.6 及更早仍是旧模型，不受影响）。

**处理**：升级到 **0.13.2+**（导出 `Config` + 逐字段 volatile 标注；设置的用户层改由宿主写入 profile 覆盖文件，跨重启生效）。

**临时绕行（升级前）**：把选项写在 profile 配置里，功能完全等价：

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml
- id: dsh-backup
  name: "@xiaoyuyu6420/dsh-backup"
  config:
    destination: ~/Desktop/dsh-backups
    keep: 7
```

## 设置里找不到「备份」面板（宿主 0.1.6 及以上）

**症状**：设置 → 插件（内置插件）里只有「插件列表」，没有「备份」标签页；浏览器控制台有 `strict codec has no create() factory`。命令行与定时备份不受影响。

**原因**：宿主 0.1.6 起要求客户端 Remote 贡献的 strict codec 带 `create()` 惰性工厂，旧版插件缺失时挂载失败且只有控制台日志。

**处理**：升级到 **0.13.1+**。该版本起：两代契约兼容；万一挂载失败也会显示**可见的降级页**（含技术细节与命令指路），不再静默消失。

## 面板点「保存」GitHub Token 报 `t.setGithubToken is not a function`

**影响版本**：0.12.0 – 0.13.0。**处理**：升级到 **0.13.1+**。临时绕过：用命令 `/backup github token <token>`（宿主半通路一直正常）。

## 装了本插件后，同页面的其它插件失灵（如 dsh-vscode-mode 的 Monaco 编辑器坏了）

**影响版本**：≤ 0.12.0。**原因**：client bundle 顶层 `var module` 泄漏成 `window.module`，让页面上其它 AMD 加载器误判成 Node 环境。

**处理**：升级到 **0.12.1+**（已修，并加了经典脚本全局泄漏的回归断言）。

## 换电脑：怎么把 `~/.dsh` 搬过去

1. 旧机配置好 GitHub 私库同步（见[进阶文档](advanced.zh.md#github-同步可选)）并推一次：`/backup github sync`；
2. 新机装好插件后拉取：`/backup github pull` —— 只下载备份集，**不会自动覆盖**本机数据；
3. 恢复前先预览：`/backup restore latest --dry-run`，会给出跨机提示（目录不同、依赖需重装、凭据需从 vault 还原）；
4. 确认后 `/backup restore latest`（可选 `--sync-deps` 恢复后重装 profile 依赖）。

## API Key / 凭据：会不会进备份、会不会上云

已知的凭据文件（`.credentials.yaml` 等）默认**脱敏**：不进归档、不进 GitHub 同步，明文只留在本机备份目录的 vault 里，恢复时自动还原。分类型备份中 `--types credentials` 的归档会**明文含凭据**（为整机迁移设计）——这类归档永不参与 GitHub 同步，救援通道也不整包恢复它们。

宿主首次读档会把旧扁平布局的 `.credentials.yaml` 原子替换成 versioned（不可逆）——插件在检测到扁平布局时会先自动存底到 `vault/preserved/` 再让宿主动它。

## DSH 根本起不来了，怎么恢复

每次备份都会往备份目录写一个**零依赖救援控制台**：双击备份目录里的「点我恢复」（macOS `.command` / Windows `.bat` / Linux `.sh`），或在终端 `node rescue.mjs` / `npx dsh-rescue`。它不依赖 DSH，只用普通 Node 起一个本地页面：列备份、校验、恢复、体检修复。

## 排错工具总览

| 工具 | 用途 |
| --- | --- |
| `/backup verify [前缀\|all]` | 校验归档完整性（sha256） |
| `/backup doctor` · `--repair <前缀\|latest>` | 会话体检 · 从归档定点修复 |
| `/backup migrate-check` | 升级前迁移预检（代会话日志规则扫描 + 硬链接探测） |
| `/backup check-update` · `update` | 插件自身更新检查 / 一键更新（更新前自动留快照） |
| `rescue.mjs`（备份目录内） | 宿主起不来时的进程外恢复通道 |
| `/backup list` | 列出备份与内部快照（升级前 / 恢复前） |

> 遇到本文没覆盖的问题：到[反馈帖](https://github.com/xiaoyuyu6420/dsh-backup/discussions/32)留言，附上报错原文与 `/backup doctor` 输出，一般能快速定位。
