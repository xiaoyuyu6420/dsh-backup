/**
 * dsh-backup — 一键备份与恢复 DeepSeek Harness 用户数据。
 *
 * 备份 ~/.dsh（会话、配置、技能、凭据、插件配置），排除可重装的
 * node_modules，生成 sha256 校验和，自动轮换旧备份；定时自动备份
 * 状态落盘、重启续跑；跨平台（macOS / Linux / Windows）。
 *
 * - `/backup`                              立即备份（默认到 ~/Desktop/DSH Backups/）
 * - `/backup list`                         列出已有备份（含大小）+ 自动备份状态
 * - `/backup verify [前缀|all]`            校验备份完整性（缺省校验最新一份）
 * - `/backup restore <前缀|latest> [--dry-run]`  恢复（先校验 + 自动快照当前数据）
 * - `/backup auto <N小时>|off|status`      定时自动备份（1~720；保留份数由 config.keep
 *                                          支配，未配置时 <24h 3 份、否则 7 份；重启按
 *                                          上次执行时间推算下次，不重置节奏）
 * - `/backup github status|sync|pull [--restore <前缀|latest>]|repo <地址|off>`
 *                                        GitHub 同步状态 / 立即推送 / 拉取到本地 / 设置仓库
 * - `/backup delete|rm <前缀|latest>`      删除备份（归档 + 校验边车）
 * - `/backup doctor [--repair <前缀|latest>]`  会话日志体检：按帧走查 zstd 拼接
 *                                          日志 + seq 连续性校验，检出损坏文件；
 *                                          --repair 从指定归档定点恢复损坏的会话
 * - `/backup --keep N`                     覆盖本次保留份数
 * - `backup_dsh` 模型工具：mode=backup|list|verify|restore|auto|doctor（restore 支持 syncDeps）
 * - cordis.yml `config`：destination / keep / exclude / redact / githubRepo（见 README）
 * - Settings「备份」标签页（Web）：状态、立即备份、校验、恢复、下载、
 *   自动备份开关与 GitHub 同步（推送 + 拉取），经 `backupPanel` Typert Remote 命名空间访问
 * - Web 下载路由：GET /backup-download/<归档名>（仅 loopback，附件形式）
 * - 救援通道（进程外）：每次备份把 rescue.mjs + 双击启动器（点我恢复.command/.bat/.sh）
 *   + RESCUE.txt 写进备份目录——DSH 起不来时双击/`node rescue.mjs` 打开零依赖
 *   救援网页（列表/校验/恢复/doctor），Node 活着就能自救
 * - 使用说明：每次备份在备份目录根写一份「使用说明.txt」，讲清每个文件是什么、
 *   恢复走哪三条路——第一次打开这个文件夹的用户不用去翻 README
 *
 * 安全说明（v0.7.0 起）：凭据文件（.credentials.yaml / .env / qq-bridge/config.json，
 * config.redact 可增删）默认脱敏——不进归档、不进 GitHub 同步，明文只存备份目录下
 * 的本机 vault（vault/，POSIX 700/600），恢复时自动拷回 ~/.dsh；跨机恢复（vault 为空）
 * 按 .redacted.json 清单提示重填。归档另携 .meta.json（主机/家目录/时间）供恢复预检：
 * 家目录不一致时提示绝对路径风险。config.redact=false/'off' 可回到 v0.6.x 明文行为
 * （不推荐）。归档与校验边车在 POSIX 上 chmod 600 仅本人可读写。
 * restore 会拒绝恢复含归档根目录之外条目的文件（tar 路径穿越防护）。
 * 可选加密备份（P2）：backupPanel 的 backup({password}) 用 scrypt + AES-256-GCM 加密
 * 归档（密文覆盖 .tar.gz 本体、参数进 .encrypted.json 边车、meta.encrypted=true）；
 * 口令只经 RPC 内存态传入、绝不写 settings.yaml/日志/磁盘；list 显示 🔒，verify 只做
 * 完整性（无需口令），restore 需口令、口令错误给明确人话报错。
 * 导出/导入（P2）：把 ~/.dsh 打成单文件 ZIP（节段化、凭据默认脱敏、可选加密），导入
 * 走 importPreview（dry-run 计划：节段/冲突/跨机 remap/兼容性评分）→ importApply
 * （自动快照 → 应用 → 校验 → 失败回滚）；ZIP 视为不可信输入，防 Zip Slip/恶意路径/异常条目。
 * P3：同步多通道（WebDAV / S3 兼容 / GitHub Gist，零依赖签名，凭据只存本机 0600）、
 * GFS 保留（最近 N + 每月/每年各一份）、操作锁 + 残留锁回收（心跳 + 死锁判定，不误踢活锁）、
 * 磁盘占用报告 + 分级清理（快照/同步永不删）、定时备份自定义每周时刻。
 *
 * 存储说明：插件自有数据（归档、校验和、auto.json）直接经 node:fs 写入
 * （与 dsh-session 持久化、skill-filesystem 同一模式）——ctx.fs 能力是
 * 模型面的沙箱 surface（workspace-write 会拒绝 Desktop），不适用于宿主
 * 插件的自有存储。
 */
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, realpathSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { mkdir, open, copyFile, chmod, readdir, readFile, rename, rm, stat as fsStat, lstat, unlink, writeFile, link } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { hostname } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';
import * as zlib from 'node:zlib';
import { decryptFile, encryptFile } from './encrypt.js';
import { buildZip, listZip, extractZip, readZipEntry } from './zip.js';
import { gfsProtectedSet } from './gfs.js';
import { acquireLock, releaseLock, heartbeatLock, reclaimLock as reclaimOplock, isLockStale, LOCK_HEARTBEAT_MS } from './oplock.js';
import { s3Put, webdavPut, gistSync, gistContent } from './sync-channels.js';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import { SettingsConflictError } from '@deepseek-ai/dsh-settings';
import z from '@deepseek-ai/schemastery';

export const name = 'dsh-backup';
export const inject = ['subprocess', 'commands', 'timer', 'tools'];

/** Windows 无 POSIX chmod 语义（用户目录 ACL 默认私有）。 */
const IS_WIN = process.platform === 'win32';
/** 深度校验（会话日志整读入内存）的体积上限；sha256 流式回退不适用此限。 */
const HASH_MAX_BYTES = 256 * 1024 * 1024;
/** 流式 sha256 的分块大小（4MB ≈ 每块几毫秒 CPU，块间让出事件循环）。 */
const HASH_CHUNK_BYTES = 4 * 1024 * 1024;
/**
 * 启动宽限期：插件装配后头 45 秒不启动任何重活（全量 tar/gzip + 哈希要几分钟）。
 * 宿主自己的 boot 预算按 30s 计（#103：DSH Desktop 的 HostRpc 30s 超时），
 * 启动期补跑全量备份会抢 CPU/IO 把宿主 boot 拖超时，进而被判失败强杀。
 */
const AUTO_BOOT_GRACE_MS = 45_000;
/** 自动备份失败后同会话内的重试间隔（只重试一次，避免失败热循环烧 CPU）。 */
const AUTO_RETRY_MS = 30 * 60_000;
/** GitHub 单个文件 100MB 上限，留 10MB 余量。 */
const MAX_GITHUB_BYTES = 90 * 1024 * 1024;
/** 同步工作树目录名（位于备份目录下）。 */
const SYNC_DIR = '.github-sync';
/** Web 下载路由前缀（无尾斜杠：prefix 匹配语义为 pathname.startsWith(prefix + '/')）。 */
const DOWNLOAD_PREFIX = '/backup-download';
/** WebDAV/S3 同步的单文件整读 PUT 上限（内存缓冲护栏；超大归档跳过并上报）。 */
const SYNC_MAX_BYTES = MAX_GITHUB_BYTES;
/** GitHub Gist 单文件上限（GitHub 硬性约 10MB；超限跳过，gist 本就只适合轻量配置）。 */
const GIST_MAX_BYTES = 10 * 1024 * 1024;
/** 多通道同步配置文件名（备份目录根，0600；凭据不进归档不进日志）。 */
const SYNC_CONFIG_FILE = 'sync.json';
/** 操作锁文件名（备份目录根；pid+token+心跳）。 */
const LOCK_FILE = '.oplock.json';
/**
 * 默认脱敏的敏感文件（相对 ~/.dsh 根的 POSIX 路径）：凭据与环境变量文件
 * 明文绝不进归档、绝不进 GitHub 同步——真实值只落本机 vault（备份目录下
 * `vault/`，结构镜像 ~/.dsh）。恢复时从 vault 自动还原；跨机恢复（vault 为
 * 空）则提示重填。config.redact 数组可追加；false/'off' 关闭整套（回到
 * v0.6.x 明文行为，不推荐）。
 */
const SENSITIVE_DEFAULTS = ['.credentials.yaml', '.env', 'qq-bridge/config.json'];
/** 备份目录下保存明文敏感文件的子目录（随备份刷新为最新一份的副本）。 */
const VAULT_DIR = 'vault';
/** vault 下存放「凭据旧布局存底」的子目录：跨升级的长效安全网，备份刷新时不得删除。 */
const PRESERVED_DIR = 'preserved';

/**
 * 分类型备份的内容类型表（相对 ~/.dsh 根的 POSIX 路径）。
 * 每类映射一组路径：文件用具体名、目录用目录名；mcp 用 glob（承载组合
 * 文件，连带其他 cordis 行——MCP 无独立目录，声明嵌在 cordis 组合层里）。
 * credentials 类反转脱敏：明文进归档（跳过 redactExcludeFlags），但这类
 * 归档在 githubSync 里被识别并跳过，永不上一线。旧归档（meta.types 缺省）
 * 视为全量，与分类型归档（dsh-t- 前缀）独立轮换、不进全量列表。
 */
const BACKUP_TYPES = Object.freeze({
  credentials: { label: '凭据/api key', paths: ['.credentials.yaml', '.env', 'qq-bridge/config.json'], credentials: true },
  mcp: { label: 'MCP 配置', paths: ['cordis.patch.yml', 'profiles/*/cordis.patch.yml', 'profiles/*/cordis.yml'] },
  skills: { label: '技能', paths: ['skills'] },
  sessions: { label: '会话', paths: ['sessions'] },
  settings: { label: '设置', paths: ['settings.yaml'] },
  profiles: { label: '插件 profiles', paths: ['profiles'] },
});
/** 分类型归档前缀（与全量 dsh- 区分：独立轮换、不进全量列表、旧版插件不可见不误删）。 */
const TYPED_PREFIX = 'dsh-t-';

/**
 * 导出/导入（P2）的节段表：把 ~/.dsh 顶层内容归入 10 个语义节段 + 一个 `other`
 * 兜底节段。`paths` 是相对 ~/.dsh 根的 POSIX 路径（文件精确名 / 目录名）；
 * credentials 节段默认脱敏（不进 ZIP），仅在 includeCredentials 且加密时入包。
 *
 * 节段划分与 BACKUP_TYPES（分类型备份）一致的最小集，但**按顶层非重叠**组织：
 * profiles（插件）整目录归 plugins，家级 cordis*.yml 归 mcp（profile 内的 cordis
 * 由 plugins 覆盖，避免重复入包）。`other` 收所有未匹配的顶层条目（attachments /
 * cache / storages / dsh-market / .dshw-* 等 DSH 运行数据），保证「换机丢配置」
 * 场景绝不静默丢文件——宁可多一个兜底节段，也不漏。
 */
const EXPORT_SECTIONS = Object.freeze([
  { key: 'settings', label: '设置', paths: ['settings.yaml', 'settings.json'] },
  { key: 'ui', label: '界面设置', paths: ['ui.json', 'ui-state.json', '.ui'] },
  { key: 'providers', label: '模型供应商', paths: ['providers'] },
  { key: 'plugins', label: '插件 profiles', paths: ['profiles'] },
  { key: 'mcp', label: 'MCP 配置', paths: ['cordis.patch.yml', 'cordis.yml'] },
  { key: 'skills', label: '技能', paths: ['skills'] },
  { key: 'prompts', label: '提示词', paths: ['prompts'] },
  { key: 'workspaces', label: '工作区', paths: ['workspaces'] },
  { key: 'sessions', label: '会话', paths: ['sessions'] },
  { key: 'credentials', label: '凭据/api key', paths: ['.credentials.yaml', '.env', 'qq-bridge'], credentials: true },
]);
/** 兜底节段 key：所有未匹配到上面 10 类的顶层文件/目录都归这里，绝不丢弃。 */
const EXPORT_OTHER_KEY = 'other';
/** 导出 manifest 的格式标识与版本（读端据此识别 dsh-config 包、拒绝未知格式）。 */
const EXPORT_FORMAT = 'dsh-config-export';
const EXPORT_FORMAT_VERSION = 1;
/** 导出递归走查的目录/文件上限（防病态目录树把导出拖死）。 */
const EXPORT_MAX_FILES = 100_000;
/** 导出内部快照前缀（importApply 前拍的当前数据安全网，不进用户列表）。 */
const IMPORT_SNAPSHOT_PREFIX = 'dsh-pre-import-';

/**
 * 按类型 globs 匹配归档内条目（restore 侧）：把 BACKUP_TYPES 的相对路径转成
 * 对归档条目（${base}/ 前缀）的匹配——文件精确匹配、目录前缀匹配、含 * 的
 * glob 转正则。返回命中的归档条目数组（去重）。与备份侧 typeTargets（文件
 * 系统展开）对称：备份展开实际路径，恢复匹配归档条目。
 */
function typeEntries(types, entries, base) {
  const out = [];
  const seen = new Set();
  const esc = (s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  for (const key of types) {
    const spec = BACKUP_TYPES[key];
    if (!spec) continue;
    for (const rel of spec.paths) {
      if (rel.includes('*')) {
        const re = new RegExp(`^${esc(base)}/${esc(rel).replace(/\*/g, '[^/]+')}$`);
        for (const e of entries) if (re.test(e) && !seen.has(e)) { seen.add(e); out.push(e); }
      } else {
        const fileEntry = `${base}/${rel}`;
        const dirPrefix = `${base}/${rel}/`;
        for (const e of entries) {
          if ((e === fileEntry || e.startsWith(dirPrefix)) && !seen.has(e)) { seen.add(e); out.push(e); }
        }
      }
    }
  }
  return out;
}

/** 随备份落盘的救援说明：DSH 起不来时，用户打开备份目录第一眼能看到的东西。 */
const RESCUE_TXT = `DSH 出问题时的自救通道（不依赖 DSH 能否启动）
====================================================

最简单：双击「点我恢复」文件（macOS .command / Windows .bat / Linux .sh），
浏览器会自动打开救援页面，点按钮即可校验/恢复/修复。

没有双击文件或想用终端:
  node rescue.mjs                        打开救援网页（同上）
  node rescue.mjs list                   列出备份
  node rescue.mjs verify all             校验完整性
  node rescue.mjs restore latest         预览恢复；加 --yes 执行
  node rescue.mjs doctor                 会话日志体检
  node rescue.mjs doctor --repair        修复损坏的会话日志

恢复是整体替换：现有 .dsh 会先自动快照并挪到一旁（.dsh.pre-restore-*），
凭据从本目录 vault/ 自动补回。rescue.mjs / 启动器 / 本说明由 dsh-backup 每次备份时更新。
`;

/** 备份目录根的使用说明文件名：用户第一次打开文件夹时最该看到的东西。 */
const GUIDE_FILE = '使用说明.txt';

/**
 * 随备份落盘的人话版说明书。
 *
 * 背景（0.14.0 UX 审查）：备份目录里混着归档、校验边车、救援工具、vault 和
 * 调度状态，第一次打开的用户只看到一堆 tar.gz，既不知道能不能删，也不知道
 * 恢复从哪下手。这份文件把「是什么 / 怎么恢复 / 哪些别动 / 怎么换位置」一次
 * 讲清，和 RESCUE.txt（灾时专用）互补。每次备份都会重写，保持最新。
 */
const GUIDE_TXT = `DSH 备份文件夹 —— 使用说明
================================

这个文件夹由 dsh-backup 插件自动生成，保存你本机 DSH 的全部数据
（~/.dsh：会话、设置、技能、插件配置……）。日常不需要手动改动这里。

【怎么恢复】
1. DSH 还能打开：在 DSH 里输入 /backup list 查看，再用 /backup restore latest；
   或者打开 设置 → 插件 → 备份，在面板里点「恢复」。
2. DSH 打不开：双击本文件夹里的「点我恢复」（macOS .command / Windows .bat /
   Linux .sh），浏览器会打开救援页面，按提示校验/恢复。
3. 终端：node rescue.mjs                 打开救援页面
         node rescue.mjs list            列出备份
         node rescue.mjs restore latest  预览恢复；加 --yes 执行

【里面的文件都是什么】
- dsh-<时间戳>.tar.gz    一份完整备份。别手动解压，也别改名。
- 同名 .sha256           校验和，用来验证备份没损坏。
- 同名 .meta.json        元数据（主机、时间等），恢复前预检用。
- 同名 .redacted.json    脱敏清单（哪些凭据没进归档），有它时恢复会提示。
- 点我恢复 / rescue.mjs  进程外救援工具：DSH 坏了也能跑。「RESCUE.txt」是它的说明。
- vault/                 本机凭据明文备份（只有你能读；不要上传、不要分享）。
- auto.json              自动备份的调度状态，删了会重置节奏。
- .github-sync/          GitHub 同步缓存（开了 GitHub 同步才有，别手动改）。

【想换个位置或名字】
DSH 能打开时：设置 → 插件 → 备份 → 备份目录，改完保存立即生效。
注意：改动只影响以后的新备份，已有的旧备份不会自动搬过去。

【保留策略】
默认保留最近 7 份（自动备份间隔不足 24 小时时保留 3 份），更旧的自动删除。
本说明由 dsh-backup 在每次备份时自动更新，不用管它。

【English】
This folder is auto-generated by the dsh-backup plugin
(https://github.com/xiaoyuyu6420/dsh-backup). It holds copies of your DSH data.
To restore: run /backup restore latest inside DSH, or double-click the rescue
launcher, or run "node rescue.mjs". Do not unpack or rename the archives by hand.
`;

/** 双击启动器：起救援服务并自动开浏览器。按当前平台生成，避免目录里躺三个系统的文件。 */
const RESCUE_LAUNCHERS = Object.freeze({
  // 双击 .command 时 GUI 的 PATH 只有 /usr/bin:/bin:...，nvm/Homebrew 装的
  // node 找不到——直接 exec 会静默失败且窗口即关（UX 审查 P1-3）。先依次
  // 探测常见安装位置；全落空时给人话指引并保持窗口不关。
  darwin: ['点我恢复.command', '#!/bin/sh\ncd "$(dirname "$0")" || exit 1\nNODE_BIN="$(command -v node)"\nif [ -z "$NODE_BIN" ]; then\n  for c in /opt/homebrew/bin/node /usr/local/bin/node "$HOME"/.nvm/versions/node/*/bin/node; do\n    if [ -x "$c" ]; then NODE_BIN="$c"; break; fi\n  done\nfi\nif [ -z "$NODE_BIN" ]; then\n  echo "没有找到 node。请先安装 Node.js（https://nodejs.org），然后重新双击本文件。"\n  echo "也可以在终端进入本目录手动执行: node rescue.mjs serve --open"\n  printf "\\n按回车键关闭窗口…"\n  read _\n  exit 1\nfi\nexec "$NODE_BIN" rescue.mjs serve --open\n'],
  win32: ['点我恢复.bat', '@echo off\r\nchcp 65001 >nul\r\ncd /d "%~dp0"\r\nnode rescue.mjs serve --open\r\npause\r\n'],
  linux: ['点我恢复.sh', '#!/bin/sh\ncd "$(dirname "$0")" || exit 1\nNODE_BIN="$(command -v node)"\nif [ -z "$NODE_BIN" ]; then\n  for c in /usr/local/bin/node /opt/node/bin/node "$HOME"/.nvm/versions/node/*/bin/node "$HOME"/.local/bin/node; do\n    if [ -x "$c" ]; then NODE_BIN="$c"; break; fi\n  done\nfi\nif [ -z "$NODE_BIN" ]; then\n  echo "没有找到 node。请先安装 Node.js，然后在终端进入本目录执行: node rescue.mjs serve --open"\n  exit 1\nfi\nexec "$NODE_BIN" rescue.mjs serve --open\n'],
});

/**
 * 从归档名解析自然日（dsh-YYYYMMDD-HHMMSSmmm）；解析不出返回 null。
 * 纯函数、模块级：轮换分层与测试共用。
 */
function archiveDay(name) {
  // dsh-t-（分类型归档）与 dsh-（全量）共用同一时间戳格式；前缀可选 t-。
  const m = /^dsh-(?:t-)?(\d{4})(\d{2})(\d{2})-\d{6}\d{3}\.tar\.gz$/.exec(name);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

/** ISO 周号（周一为首日，YYYY-Www）：跨日/跨周分层保留的桶键。 */
function isoWeekOf(day) {
  const dt = new Date(`${day}T00:00:00Z`);
  const dayNum = (dt.getUTCDay() + 6) % 7;
  dt.setUTCDate(dt.getUTCDate() - dayNum + 3);
  const firstThursday = new Date(Date.UTC(dt.getUTCFullYear(), 0, 4));
  const fday = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - fday + 3);
  return `${dt.getUTCFullYear()}-W${String(1 + Math.round((dt - firstThursday) / 604800000)).padStart(2, '0')}`;
}

/**
 * 分级轮换的保护集：tailDesc（keep 窗口外、新→旧）里，每个自然日的首份受
 * 保护（最多 7 个不同日）；某日已见或日额用尽时，落至周级——该 ISO 周首份
 * 受保护（最多 4 个不同周；日级保护同时登记其所在周，避免同周重复占额）。
 * 今日的档内冗余不保护（keep 窗口已覆盖今日）。返回受保护的归档名集合。
 */
function tierProtectedSet(tailDesc, newestName) {
  const protectedNames = new Set();
  const daySeen = new Set();
  const weekSeen = new Set();
  const today = newestName ? archiveDay(newestName) : null;
  let daysLeft = 7;
  let weeksLeft = 4;
  for (const b of tailDesc) {
    const d = archiveDay(b.name);
    if (!d || d === today) continue;
    const wk = isoWeekOf(d);
    if (!daySeen.has(d) && daysLeft > 0) {
      daySeen.add(d);
      weekSeen.add(wk);
      daysLeft -= 1;
      protectedNames.add(b.name);
    } else if (!weekSeen.has(wk) && weeksLeft > 0) {
      weekSeen.add(wk);
      weeksLeft -= 1;
      protectedNames.add(b.name);
    }
  }
  return protectedNames;
}

/**
 * 探测正在运行的宿主版本（升级前快照的触发依据）。
 * 关键约束：必须测"正在跑的宿主"，而不是 profile 里 hoisted 的 peer 包——
 * 用户经全局 CLI / `npx @deepseek-ai/dsh web` 升级宿主时，profile 的 peer
 * 包纹丝不动，peer 代理会永远 stale、快照永不触发。
 * 优先级：
 *   1. env DSH_VERSION（宿主未来若提供则最准）
 *   2. process.argv[1] 真实路径向上扫：宿主 bin 位于
 *      <...>/node_modules/@deepseek-ai/dsh/ 下（覆盖全局/npm/npx 缓存/
 *      本地目录安装），或自身就在包目录内
 *   3. createRequire 解析 @deepseek-ai/dsh/package.json（解析链恰含宿主时命中）
 *   4. peer @dsh-settings 版本代理（最后兜底：测的是 profile 列车，仅覆盖
 *      "重装插件/刷新 hoisted 包带动列车"的场景）
 * 全部失败返回 null（快照特性静默停用，绝不影响装配）。
 */
function detectHostTrain() {
  const fromEnv = process.env.DSH_VERSION;
  if (typeof fromEnv === 'string' && fromEnv.trim()) return fromEnv.trim();
  try {
    if (process.argv[1]) {
      let dir = dirname(realpathSync(process.argv[1]));
      for (let i = 0; i < 8 && dir !== dirname(dir); i += 1) {
        const candidates = [join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')];
        if (basename(dir) === 'dsh' && basename(dirname(dir)) === '@deepseek-ai') {
          candidates.push(join(dir, 'package.json'));
        }
        for (const c of candidates) {
          try {
            const v = JSON.parse(readFileSync(c, 'utf8')).version;
            if (typeof v === 'string' && v) return v;
          } catch { /* 尝试下一个候选 */ }
        }
        dir = dirname(dir);
      }
    }
  } catch { /* argv 异常走兜底 */ }
  try {
    const v = JSON.parse(readFileSync(createRequire(import.meta.url).resolve('@deepseek-ai/dsh/package.json'), 'utf8')).version;
    if (typeof v === 'string' && v) return v;
  } catch { /* 宿主不在本插件的解析链上 */ }
  const candidates = [];
  try {
    candidates.push(createRequire(import.meta.url).resolve('@deepseek-ai/dsh-settings/package.json'));
  } catch { /* exports 未暴露 package.json */ }
  try {
    for (const rel of ['../node_modules/@deepseek-ai/dsh-settings/package.json', '../../node_modules/@deepseek-ai/dsh-settings/package.json', '../../../node_modules/@deepseek-ai/dsh-settings/package.json']) {
      candidates.push(fileURLToPath(new URL(rel, import.meta.url)));
    }
  } catch { /* URL 解析异常 */ }
  for (const p of candidates) {
    try {
      const v = JSON.parse(readFileSync(p, 'utf8')).version;
      if (typeof v === 'string' && v) return v;
    } catch { /* 尝试下一个候选 */ }
  }
  return null;
}

/** Settings 命名空间：经 `ctx.settings` 提供（持久化到 $DSH_HOME/settings.yaml）。
 * 0.1.2-rc.1 起宿主移除了 settingsNamespace 帮助函数——它运行时本就只返回
 * 这个字符串（纯 TS 类型校验），ctx.settings.register/update/replace/describe
 * 吃的都是同一语法的字符串，直接写常量在两个列车上行为等价。 */
const NS = 'dsh-backup';

/** 本插件自身名称与版本（package.json）：更新检查的"当前版本"基准。 */
const SELF_META = (() => {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    return { name: pkg.name, version: pkg.version };
  } catch {
    return { name: '@xiaoyuyu6420/dsh-backup', version: 'unknown' };
  }
})();

/**
 * 设置默认值。SCHEMA 的 .default() 与 resolveBase 的初始值都引用这里，
 * 避免同一字面量散落多处导致迁移逻辑漏改。
 */
const DEFAULTS = Object.freeze({
  // 0.14.0 起默认目录改名为 `DSH Backups`：旧名 `dsh-backups`（全小写 + 连字符）
  // 在桌面/Finder 里像临时垃圾目录，用户打开也不知道里面是干嘛的。位置仍留在
  // 桌面——救援通道（点我恢复）要求 DSH 彻底起不来时也能被非技术用户一眼找到。
  destination: '~/Desktop/DSH Backups',
  exclude: [],
  redact: [...SENSITIVE_DEFAULTS],
  githubRepo: '',
  updateCheck: false,
  // GFS 保留：keep 窗口外，每月一份 / 每年一份各保留多少个桶。0=关（等价旧行为）。
  gfsMonthly: 0,
  gfsYearly: 0,
  // 配置市场索引地址（空 = 市场禁用；用户填了才拉取）。
  marketUrl: '',
});

/**
 * ≤0.13.4 的默认目录。升级后由 migrateLegacyDefaultDir() 同盘改名为新默认名；
 * 迁移失败时 paths() 会继续使用老目录，保证已有备份不"消失"。
 */
const LEGACY_DEFAULT_DESTINATIONS = Object.freeze(['~/Desktop/dsh-backups']);

/** existsSync 的安全包装：非法路径/权限异常一律按"不存在"处理。 */
const pathExists = (p) => {
  try { return existsSync(p); } catch { return false; }
};

/**
 * 解析 settings 命名空间的 schema，同时定义默认值。
 * Base 层：pluginConfig（cordis.patch.yml，插件级或 profile 级）。
 * User 层：Settings 面板运行时编辑（0.1.6 及更早持久化到 settings.yaml；
 * 0.1.7 起由宿主写入 profile 覆盖层）。
 *
 * **两代模型共用这一份**：
 *  - ≤0.1.6-alpha.1：`ctx.settings.register(NS, SCHEMA)` 自注册命名空间；
 *  - ≥0.1.7（含 0.2.0）：`register` 被移除，宿主改从「条目的 Config schema」
 *    派生表单，且只认**标了 volatile 的字段**（宿主 dsh-settings 的
 *    `volatileForm` 仅当 `meta.volatile` 存在才纳入表单）。故此处导出 Config
 *    并逐字段标注 volatile。
 *
 * `volatileField` 做运行时探测：老载体（@deepseek-ai/schemastery < 3.18.4）
 * 没有 `.volatile()`，探测失败就原样返回——老宿主走 register 路径，不需要它。
 * 这样同一份代码在 0.1.1 → 0.2.0 全列车都能装配，不会因新 API 缺失而崩在装载期。
 */
const volatileField = (schema) => (typeof schema.volatile === 'function' ? schema.volatile() : schema);

const SCHEMA = z.object({
  destination: volatileField(z.string().default(DEFAULTS.destination)),
  keep: volatileField(z.number().min(0).default(0)),
  exclude: volatileField(z.array(z.string()).default(DEFAULTS.exclude)),
  // 'none' 是 v0.6 时代写法（代码里映射为 'off'）：schema 收下它，别让老配置
  // 在新宿主的条目校验里被拒。
  redact: volatileField(z.union([z.array(z.string()), 'off', 'none']).default(DEFAULTS.redact)),
  githubRepo: volatileField(z.string().default(DEFAULTS.githubRepo)),
  updateCheck: volatileField(z.boolean().default(DEFAULTS.updateCheck)),
  gfsMonthly: volatileField(z.number().min(0).default(DEFAULTS.gfsMonthly)),
  gfsYearly: volatileField(z.number().min(0).default(DEFAULTS.gfsYearly)),
  marketUrl: volatileField(z.string().default(DEFAULTS.marketUrl)),
});

/** 宿主装载条目时读取的 Config schema（0.1.7+ 的设置表单来源）。 */
export const Config = SCHEMA;

const SETTINGS_FIELDS = ['destination', 'keep', 'exclude', 'redact', 'githubRepo', 'updateCheck', 'gfsMonthly', 'gfsYearly', 'marketUrl'];

/** 校验并归一化单个字段到 `out`；非法值忽略。 */
function normalizeField(out, field, value) {
  if (field === 'destination') {
    if (typeof value === 'string' && value.trim()) out.destination = value.trim();
  } else if (field === 'keep') {
    const n = Number(value);
    if (Number.isFinite(n) && n >= 0) out.keep = Math.floor(n);
  } else if (field === 'exclude') {
    if (Array.isArray(value)) out.exclude = value.filter((v) => typeof v === 'string');
  } else if (field === 'redact') {
    // 'none' 为旧配置兼容：旧版允许 'none' 关闭脱敏，新版 SCHEMA 只接受数组或 'off'
    if (value === 'off' || value === false || value === 'none') out.redact = 'off';
    else if (Array.isArray(value)) out.redact = value.filter((v) => typeof v === 'string');
  } else if (field === 'githubRepo') {
    if (typeof value === 'string') out.githubRepo = value;
  } else if (field === 'updateCheck') {
    if (typeof value === 'boolean') out.updateCheck = value;
  } else if (field === 'gfsMonthly' || field === 'gfsYearly') {
    const n = Number(value);
    if (Number.isFinite(n) && n >= 0) out[field] = Math.floor(n);
  } else if (field === 'marketUrl') {
    if (typeof value === 'string') out.marketUrl = value.trim();
  }
}

/**
 * 将 loader 提供的 config（cordis.patch.yml）合并到 DEFAULTS 上，逐字段归一化。
 * SCHEMA 的 .default() 与这里共用 DEFAULTS，避免迁移逻辑漏改。
 */
function resolveBase(config) {
  const out = { ...DEFAULTS, redact: [...DEFAULTS.redact] };
  if (config && typeof config === 'object') {
    for (const field of SETTINGS_FIELDS) normalizeField(out, field, config[field]);
  }
  return out;
}

/** 校验 partial 中提供的字段；非法字段名返回给调用方，用于 400 响应。 */
function validatePartial(partial) {
  const invalid = [];
  for (const field of SETTINGS_FIELDS) {
    if (partial[field] === undefined) continue;
    const probe = {};
    normalizeField(probe, field, partial[field]);
    if (probe[field] === undefined) invalid.push(field);
  }
  return invalid;
}

/** 判断是否为 settings seam 的乐观并发冲突错误。 */
function isSettingsConflict(err) {
  return err instanceof SettingsConflictError || (err && err.code === 'SETTINGS_CONFLICT');
}

/** 从 settings 服务中取出本命名空间的描述符（脱敏视图）。 */
function describeOwn(settings, ns) {
  const list = settings.describe({ redactSecrets: true });
  return list.find((descriptor) => descriptor.ns === ns);
}

/** 将命名空间描述符整理为客户端使用的线格式。 */
function describeResponse(descriptor) {
  return {
    ...descriptor.value,
    revision: descriptor.revision,
    hasOverrides: !!(descriptor.user && Object.keys(descriptor.user).length > 0),
  };
}

/**
 * `backupPanel` Remote 命名空间的调用描述符（src-json codec）。手工经
 * `ctx.typert.register()` 注册——运行时 registry 接受 src-json，免去 zod
 * 依赖；Web 客户端半边（lib/client.js）携带同一套端点的 strict zod 定义。
 */
function panelDescriptor(method, parameters, cancellation) {
  return Object.freeze({
    id: `dsh-backup#backupPanel/${method}`,
    service: 'backupPanel',
    namespace: 'backupPanel',
    method,
    invocation: Object.freeze({ kind: 'direct' }),
    parameters: Object.freeze(parameters.map((p) => Object.freeze({
      name: p,
      wire: p,
      source: 'json',
      codec: Object.freeze({ mode: 'src-json' }),
    }))),
    ...(cancellation ? { cancellation: Object.freeze({ parameter: 'signal' }) } : {}),
    result: Object.freeze({ mode: 'src-json' }),
  });
}

/**
 * ============================================================================
 * backupPanel RPC 契约（P2 新增/变更）——客户端 strict descriptor 据此实现
 * ============================================================================
 * 宿主多注册方法不影响客户端挂载（客户端只挂载它声明的子集）。口令一律「只经 RPC
 * 传入、内存态」，绝不写 settings.yaml / 日志 / 磁盘。
 *
 * @method backup(keep?, types?, password?, signal) → { ok, summary, path, sha,
 *         stale, keep, encrypted?, types?, hasCredentials? }
 *   - password: string 可选。非空即加密备份（scrypt+AES-256-GCM，密文覆盖归档、
 *     .encrypted.json 边书记参数，meta.encrypted=true）。
 *
 * @method restore(selector?, dryRun?, types?, syncDeps?, password?, signal)
 *   → 与旧 shape 相同，另加加密归档的恢复：password 提供时用于解密；缺口令或口令
 *     错误 → ok:false + 人话 summary（「口令错误或归档已损坏」）。
 *
 * @method exportConfig(options, signal)
 *   options: { password?: string, includeCredentials?: boolean, sections?: string[] }
 *   → { ok, summary, path, name, size, encrypted, manifest, redactedFiles }
 *   manifest: { format:'dsh-config-export', version:1, createdAt, source:{host,home,
 *              platform,pluginVersion}, redacted[], encrypted, sections:[{key,label,
 *              files,bytes}], totalFiles, totalBytes }
 *
 * @method importPreview(options, signal)  // dry-run，只读
 *   options: { sourcePath: string, password?: string }
 *   → { ok, summary, encrypted, manifest, sections:[{key,label,files,bytes,
 *       conflicts:[{name,rel,exists}]}], totalFiles, totalBytes, conflicts:[{name,rel,
 *       section,exists}], remap:[{section,file,count,sample[]}],
 *       compatibility:{score,reasons[]} }
 *
 * @method importApply(options, signal)  // 自动快照 → 应用 → 校验 → 失败回滚
 *   options: { sourcePath, password?, sections?: string[], decisions?: {[name]:
 *             'keep'|'overwrite'}, remap?: [{from,to}] }
 *   → { ok, summary, encrypted, applied, skipped, overwrote, snapshot, remapped }
 *
 * P3 新增：
 * @method syncStatus() → { ok, channels: {github,webdav,s3,gist}, summary }
 *   每通道：{ channel, type, configured, url?/endpoint?/bucket?/gistId?, tokenSet?/
 *   passwordSet?/secretKeySet?, lastPush, lastError }（凭据一律脱敏，不回显明文）
 * @method syncNow(channel, signal) → { ok, summary, pushed, count?, at, tooBig?, gistUrl? }
 * @method setSyncChannel(channel, config) → { ok, summary, channel? }
 *   config 按通道：webdav{url,username,password} / s3{endpoint,region,bucket,
 *   accessKey,secretKey,pathPrefix?,pathStyle?} / gist{token,gistId?}；凭据只存本机 0600
 * @method removeSyncChannel(channel) → { ok, summary }
 * @method lockStatus() → { ok, held, stale, pid, operation, startedAt, heartbeatAt }
 * @method reclaimLock(force) → { ok, summary, heldBy? }
 * @method diskUsage(signal) → { ok, total, totalText, categories:[{key,label,bytes,files}], summary }
 * @method cleanup(scope, signal) → { ok, removed, names, summary }（scope='cache'|'expired'）
 * @method setWeekly(schedules) → { ok, weekly:[{day,time}], summary }（day 1=周一..7=周日）
 *
 * P4 新增：
 * @method about() → { ok, version, dshVersion, platform, node, profile, pluginDir }
 *   环境信息脱敏：只含版本/平台/路径，绝不含凭据/密钥；home 不单独返回，pluginDir
 *   若位于 home 下则 home 前缀脱敏成 ~（取不到一律 'unknown'）。
 * ============================================================================
 */

const PANEL_INVOCATIONS = Object.freeze([
  panelDescriptor('status', []),
  panelDescriptor('backup', ['keep', 'types', 'password'], true),
  panelDescriptor('verify', ['selector'], true),
  panelDescriptor('restore', ['selector', 'dryRun', 'types', 'syncDeps', 'password'], true),
  panelDescriptor('setAuto', ['hours']),
  panelDescriptor('githubStatus', []),
  panelDescriptor('githubSyncNow', [], true),
  panelDescriptor('githubPull', [], true),
  panelDescriptor('removeEntry', ['selector'], true),
  panelDescriptor('setGithubRepo', ['repo']),
  panelDescriptor('doctorScan', [], true),
  panelDescriptor('doctorRepair', ['selector'], true),
  panelDescriptor('migrateCheck', [], true),
  panelDescriptor('setGithubToken', ['token']),
  panelDescriptor('checkUpdate', [], true),
  panelDescriptor('update', [], true),
  panelDescriptor('exportConfig', ['options'], true),
  panelDescriptor('importPreview', ['options'], true),
  panelDescriptor('importApply', ['options'], true),
  panelDescriptor('syncStatus', []),
  panelDescriptor('syncNow', ['channel'], true),
  panelDescriptor('setSyncChannel', ['channel', 'config']),
  panelDescriptor('removeSyncChannel', ['channel']),
  panelDescriptor('lockStatus', []),
  panelDescriptor('reclaimLock', ['force']),
  panelDescriptor('diskUsage', [], true),
  panelDescriptor('cleanup', ['scope'], true),
  panelDescriptor('setWeekly', ['schedules']),
  panelDescriptor('about', []),
  panelDescriptor('profilesList', []),
  panelDescriptor('profileCreate', ['name']),
  panelDescriptor('profileRename', ['old', 'new']),
  panelDescriptor('profileDelete', ['name']),
  panelDescriptor('profileLaunch', ['name']),
  panelDescriptor('profileStop', ['name']),
  panelDescriptor('marketList', [], true),
  panelDescriptor('marketSearch', ['query'], true),
  panelDescriptor('marketInstall', ['options'], true),
  panelDescriptor('foreignSources', []),
  panelDescriptor('foreignPreview', ['options'], true),
  panelDescriptor('foreignImport', ['options'], true),
  panelDescriptor('sessionRewindList', []),
  panelDescriptor('sessionRewindPreview', ['session', 'seq'], true),
  panelDescriptor('sessionRewindApply', ['options'], true),
  panelDescriptor('chatSources', []),
  panelDescriptor('chatPreview', ['options'], true),
  panelDescriptor('chatApply', ['options'], true),
]);

/**
 * `backupPanel` 宿主服务：Settings 标签页的 RPC 面。方法签名与描述符的
 * parameters 顺序一致（取消型方法末位是 signal），实现全部委托 ops 闭包，
 * 与 `/backup` 命令、`backup_dsh` 工具共用同一套核心操作。
 */
class BackupPanelService extends TypertRemoteService {
  /** @param {import('@deepseek-ai/cordis').Context} ctx - 挂载上下文 */
  constructor(ctx, ops) {
    super(ctx, 'backupPanel');
    this.ops = ops;
  }

  /** 面板快照：目标目录、自动备份状态、备份清单。 */
  status() {
    return this.ops.status();
  }

  /** 立即备份（types 非空时分类型子集备份；password 非空时加密备份——口令内存态，绝不落盘）。 */
  backup(keep, types, password, signal) {
    return this.ops.backup(keep, types, password, signal);
  }

  /** 校验（selector=前缀|all|latest）。 */
  verify(selector, signal) {
    return this.ops.verify(selector, signal);
  }

  /** 恢复（dryRun 仅预览；types 非空时分类型 merge 恢复；syncDeps 恢复后重装 profile 依赖；password 用于加密归档——内存态）。 */
  restore(selector, dryRun, types, syncDeps, password, signal) {
    return this.ops.restore(selector, dryRun, types, syncDeps, password, signal);
  }

  /** 设置自动备份（0=关闭）。 */
  setAuto(hours) {
    return this.ops.setAuto(hours);
  }

  /** GitHub 同步状态。 */
  githubStatus() {
    return this.ops.githubStatus();
  }

  /** 立即推送到 GitHub。 */
  githubSyncNow(signal) {
    return this.ops.githubSyncNow(signal);
  }

  /** 从 GitHub 拉取备份集到本地（新机恢复第一步，不自动恢复）。 */
  githubPull(signal) {
    return this.ops.githubPull(signal);
  }

  /** 删除指定备份（归档 + 校验边车）。 */
  removeEntry(selector, signal) {
    return this.ops.removeEntry(selector, signal);
  }

  /** 设置 GitHub 同步仓库（空串/off 清除，回退配置默认）。 */
  setGithubRepo(repo) {
    return this.ops.setGithubRepo(repo);
  }

  /** 会话日志体检（只读扫描，不写任何文件）。 */
  doctorScan(signal) {
    return this.ops.doctorScan(signal);
  }

  /** 从指定归档定点修复损坏的会话日志（缺省最新一份）。 */
  doctorRepair(selector, signal) {
    return this.ops.doctorRepair(selector, signal);
  }

  /** 迁移预检：只读扫描全部会话日志（v0 起各代，按文件名代判定），预测升级后哪些会话打不开。 */
  migrateCheck(signal) {
    return this.ops.migrateCheck(signal);
  }

  /** 配置/清除 GitHub 同步 token（面板直配；本机存储，不进归档不进同步）。 */
  setGithubToken(token) {
    return this.ops.setGithubToken(token);
  }

  /** 检查 npm 是否有新版本（只读，不写任何文件）。 */
  checkUpdate(signal) {
    return this.ops.checkUpdate(signal);
  }

  /** 一键更新：先留升级前快照，再走官方 dsh plugin update（完成后需重启生效）。 */
  update(signal) {
    return this.ops.update(signal);
  }

  /** 导出配置为单文件 ZIP（options: { password?, includeCredentials?, sections? }）。 */
  exportConfig(options, signal) {
    return this.ops.exportConfig(options, signal);
  }

  /** 导入预览（dry-run）：options: { sourcePath, password? }。 */
  importPreview(options, signal) {
    return this.ops.importPreview(options, signal);
  }

  /** 导入应用：options: { sourcePath, password?, sections?, decisions?, remap? }。 */
  importApply(options, signal) {
    return this.ops.importApply(options, signal);
  }

  /** 多通道同步状态（含 github/webdav/s3/gist，凭据脱敏）。 */
  syncStatus() {
    return this.ops.syncStatus();
  }

  /** 立即推送到指定通道（github/webdav/s3/gist）。 */
  syncNow(channel, signal) {
    return this.ops.syncNow(channel, signal);
  }

  /** 设置同步通道配置（config 含凭据，只存本机 0600，不回显明文）。 */
  setSyncChannel(channel, config) {
    return this.ops.setSyncChannel(channel, config);
  }

  /** 清除同步通道。 */
  removeSyncChannel(channel) {
    return this.ops.removeSyncChannel(channel);
  }

  /** 操作锁状态。 */
  lockStatus() {
    return this.ops.lockStatus();
  }

  /** 回收操作锁（force=true 强删活锁，慎用）。 */
  reclaimLock(force) {
    return this.ops.reclaimLock(force);
  }

  /** 磁盘占用报告。 */
  diskUsage(signal) {
    return this.ops.diskUsage(signal);
  }

  /** 分级清理（scope='cache' 只清可再生缓存；'expired' 再加过期备份，快照/同步永不删）。 */
  cleanup(scope, signal) {
    return this.ops.cleanup(scope, signal);
  }

  /** 设置每周调度：[{ day: 1-7, time: 'HH:MM' }]；空数组关闭。 */
  setWeekly(schedules) {
    return this.ops.setWeekly(schedules);
  }

  /** About 环境信息（版本/平台/路径，脱敏，供 About 面板 + 一键复制）。 */
  about() {
    return this.ops.about();
  }

  /** 列出 profiles（app-owned 标注只读）。 */
  profilesList() {
    return this.ops.profilesList();
  }

  /** 从内置模板创建 profile。 */
  profileCreate(name) {
    return this.ops.profileCreate(name);
  }

  /** 重命名 profile（内置只读，目标已存在拒绝）。 */
  profileRename(oldName, newName) {
    return this.ops.profileRename(oldName, newName);
  }

  /** 硬删 profile（内置只读，二次确认语义由客户端承担）。 */
  profileDelete(name) {
    return this.ops.profileDelete(name);
  }

  /** 启动独立 profile 实例（detached+unref）。 */
  profileLaunch(name) {
    return this.ops.profileLaunch(name);
  }

  /** 停止独立 profile 实例。 */
  profileStop(name) {
    return this.ops.profileStop(name);
  }

  /** 配置市场：列出市场条目（只读；marketUrl 索引，不执行任何 bundle 代码）。 */
  marketList(signal) {
    return this.ops.marketList(signal);
  }

  /** 配置市场：搜索条目（只读，本地过滤 name/desc）。 */
  marketSearch(query, signal) {
    return this.ops.marketSearch(query, signal);
  }

  /** 配置市场：安装条目（默认 dry-run；confirm:true 才写，走 importPreview/importApply + 快照回滚）。 */
  marketInstall(options, signal) {
    return this.ops.marketInstall(options, signal);
  }

  /** 外部 agent：列出本机可导入来源（只读检测）。 */
  foreignSources() {
    return this.ops.foreignSources();
  }

  /** 外部 agent：预览导入计划（只读，不写 ~/.dsh）。 */
  foreignPreview(options, signal) {
    return this.ops.foreignPreview(options, signal);
  }

  /** 外部 agent：导入（默认 dry-run；confirm:true 才写，走 importPreview/importApply）。 */
  foreignImport(options, signal) {
    return this.ops.foreignImport(options, signal);
  }

  /** 会话 Rewind：列出可回退会话（只读）。 */
  sessionRewindList(signal) {
    return this.ops.sessionRewindList(signal);
  }

  /** 会话 Rewind：预览分叉计划（只读，不写盘）。 */
  sessionRewindPreview(session, seq, signal) {
    return this.ops.sessionRewindPreview(session, seq, signal);
  }

  /** 会话 Rewind：执行分叉（默认 dry-run；confirm:true 才写；原会话永不修改）。 */
  sessionRewindApply(options, signal) {
    return this.ops.sessionRewindApply(options, signal);
  }

  /** 外部聊天记录：列出可导入来源（v1 仅 Claude Code）。 */
  chatSources() {
    return this.ops.chatSources();
  }

  /** 外部聊天记录：预览导入计划（只读）。 */
  chatPreview(options, signal) {
    return this.ops.chatPreview(options, signal);
  }

  /** 外部聊天记录：导入为新会话（默认 dry-run；confirm:true 才写）。 */
  chatApply(options, signal) {
    return this.ops.chatApply(options, signal);
  }
}

export function apply(ctx, pluginConfig) {
  // ---------- Settings seam ----------
  // settings 服务可选：无该服务的 profile（非 Web）回退到 pluginConfig base 层。
  let settingsService;
  ctx.inject(['settings'], (sctx) => {
    settingsService = sctx.settings;
    // 0.1.7 起宿主移除了 settings.register（新模型改由「profile 条目自带的
    // Config schema」派生表单）；旧宿主（≤0.1.6-alpha.1）仍走自注册命名空间。
    // 两级都留：有 register 就注册，没有就跳过——请求侧按「命名空间缺失」显式
    // 降级，而不是在装配期抛错（旧实现在新宿主上是静默 TypeError）。
    if (typeof settingsService.register === 'function') {
      settingsService.register(NS, SCHEMA, { base: resolveBase(pluginConfig) });
    }
    // detach 清理：服务中途 dispose 时置空，resolvedConfig() 自动降级到 pluginConfig
    return () => { settingsService = undefined; };
  });

  // 旧配置兼容警告：redact: 'none' 在新版映射为 'off'
  if (pluginConfig && pluginConfig.redact === 'none') {
    console.warn("[dsh-backup] config.redact: 'none' 已废弃，请改用 'off'（行为相同，'none' 将在未来版本移除）");
  }

  /**
   * 解析后的生效配置：schema 默认值 ← base（cordis.patch.yml）←
   * 用户层（settings.yaml）。settings 服务不可用时回退到 pluginConfig。
   */
  function resolvedConfig() {
    if (settingsService) {
      const descriptor = describeOwn(settingsService, NS);
      if (descriptor && descriptor.value) return descriptor.value;
    }
    return resolveBase(pluginConfig);
  }

  /** 读取并解析 JSON 请求体（上限 1 MiB）。 */
  function readJsonBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > 1024 * 1024) {
          reject(new Error('request body too large'));
          req.once('error', () => {});
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (text.trim() === '') return resolve({});
        try {
          resolve(JSON.parse(text));
        } catch {
          reject(new Error('invalid JSON body'));
        }
      });
      req.on('error', reject);
    });
  }

  /** 写入 JSON 响应。 */
  function sendJson(res, status, data) {
    const body = JSON.stringify(data);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(body);
  }

  // ---------- 工具函数 ----------
  /**
   * 读取 subprocess 收集的输出流（诊断/小输出用）。dsh-subprocess 的收集契约：
   * 输出超过 maxBytes（8192）时内存窗口只保留尾部（readFrom 返回 lossy: true），
   * 完整输出 spill 到 spillPath。
   *
   * ⚠️ **不要用它读体积不可控、且结果参与安全判定的输出**（#119）：spill 自身还有
   * 上限，宿主对超过上限的流会**丢弃 spill 文件**（`discardSpill()`），此时
   * `readFrom` 只给内存尾窗、`lossy: true` 且**没有 spillPath**——旧实现把这段
   * 截断文本原样返回，`tar -tvzf` 校验清单因此把"断在文件名中间的碎片"当成不安全
   * 条目，整包被拒绝恢复（备份成功、verify 报完整、面板正常列出，只在恢复时炸）。
   * 这类输出请走 {@link streamListingLines}（原始流逐行消费，无上限）。
   */
  async function collectOutput(col) {
    const read = col?.readFrom(0);
    if (!read) return '';
    if (read.lossy && read.spillPath) {
      try {
        return await readFile(read.spillPath, 'utf8');
      } catch {
        // spill 文件不可读时降级为内存尾窗文本（截断，但比失败好）
      }
    }
    return read.text ?? '';
  }

  /**
   * 逐行消费一条命令的 stdout（`stdio: 'pipe'` 原始流形态），把每一行交给
   * `onLine`；`onLine` 返回 false 时立即终止子进程并提前返回（"发现违规就不必读完"）。
   *
   * 为什么不用有界收集（#119）：见 {@link collectOutput} 的 ⚠️。这里内存只保留
   * "尚未收尾的一行"，清单多大都不截断，也不会把碎片当成一行；stderr 仍走有界
   * 收集（只作诊断，几 KB 足够）。
   */
  async function streamListingLines(argv, cwd, signal, onLine) {
    const proc = ctx.subprocess.spawn({
      argv,
      cwd,
      graceMs: 5000,
      signal,
      stdio: { stdin: 'ignore', stdout: 'pipe', stderr: { maxBytes: 8192, spill: { maxBytes: 1 << 20 } } },
    });
    const stream = proc.stdout;
    if (!stream) throw new Error('宿主未提供原始输出流（subprocess stdout:"pipe" 不可用）——请升级宿主后重试');
    // 单行长度的护栏：tar -tv 的一行正常不过几百字节；给足余量后仍设上限，
    // 避免被构造出的超长名字把 carry 撑成内存炸弹。
    const MAX_LINE_BYTES = 16 * 1024 * 1024;
    const decoder = new StringDecoder('utf8');
    let bytes = 0;
    let lines = 0;
    let carry = '';
    let stopped = false;
    for await (const chunk of stream) {
      bytes += chunk.length;
      carry += decoder.write(chunk);
      let idx;
      while ((idx = carry.indexOf('\n')) >= 0) {
        const line = carry.slice(0, idx);
        carry = carry.slice(idx + 1);
        lines += 1;
        if (onLine(line) === false) { stopped = true; break; }
      }
      if (stopped) break;
      if (carry.length > MAX_LINE_BYTES) throw new Error(`输出单行超过 ${MAX_LINE_BYTES} 字节上限——拒绝继续解析`);
    }
    if (stopped) {
      proc.terminate();
    } else {
      carry += decoder.end();
      if (carry.length) { lines += 1; onLine(carry); }
    }
    let err = '';
    try {
      err = await collectOutput(proc.collected?.stderr);
    } catch { /* 诊断文本尽力而为 */ }
    const outcome = await proc.done;
    // 取消优先于一切结果分类（与 spawnRun 同款取舍）
    if (signal?.aborted) throw new Error('操作已取消');
    if (!stopped) {
      if (outcome.signal != null) throw new Error(`命令被终止（signal=${outcome.signal}）`);
      if (outcome.exitCode !== 0) throw new Error(`命令失败 exit=${outcome.exitCode}: ${err}`);
    }
    return { bytes, lines, stopped };
  }

  async function spawnRun(argv, cwd, signal) {
    const proc = ctx.subprocess.spawn({
      argv,
      cwd,
      graceMs: 5000,
      signal,
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: 8192, spill: { maxBytes: 1 << 20 } },
        stderr: { maxBytes: 8192, spill: { maxBytes: 1 << 20 } },
      },
    });
    const outcome = await proc.done;
    const out = await collectOutput(proc.collected?.stdout);
    const err = await collectOutput(proc.collected?.stderr);
    // 取消优先于一切结果分类：用户取消不是"命令失败"。进程已正常退出后、
    // 结果返回前的毫秒窗口内 abort 同样报"操作已取消"——刻意取舍：真取消
    // 绝不得误报成功，窗口期误报取消（R7 的反向错误）比误报成功危害小。
    if (signal?.aborted) {
      throw new Error('操作已取消');
    }
    // loose 检查：smoke 桩与部分平台下 signal 字段可能为 undefined。
    if (outcome.signal != null) {
      throw new Error(`命令被终止（signal=${outcome.signal}）`);
    }
    if (outcome.exitCode !== 0) {
      throw new Error(`命令失败 exit=${outcome.exitCode}: ${err || out}`);
    }
    return { out, err };
  }

  /**
   * 错误翻译层：把底层错误（fs 错误码、tar/git 的英文 stderr、JS 异常）映射
   * 成「人话原因 + 折叠的技术细节」。所有面向用户的 catch 出口统一经此——
   * 直接拼 err.message 会把 ENOENT/tar stderr 甩给最慌的用户（UX 审查
   * P1-4：19 处直拼的模式级问题），在这里一处收口。
   */
  function friendlyReason(err) {
    const raw = String(err && err.message ? err.message : err);
    // 内层（如 restoreArchive 的解压失败分支）已翻译过——不重复包一层
    if (raw.includes('技术细节: ')) return raw;
    if (/gzip decompression failed|not in gzip format|invalid distance|unexpected end of file|Canto open|damaged|failed to open|cannot open/i.test(raw)) {
      return `归档内容损坏或不是有效的压缩包（技术细节: ${snippet(raw, 160)}）`;
    }
    if (/\bENOENT\b/.test(raw)) {
      return `需要的文件不存在——可能已被轮换清理，或路径变动（技术细节: ${snippet(raw, 160)}）`;
    }
    if (/\b(ENOSPC|EDQUOT)\b/.test(raw)) {
      return `磁盘空间不足，请释放空间后重试（技术细节: ${snippet(raw, 160)}）`;
    }
    if (/\b(EACCES|EPERM|EROFS)\b/.test(raw)) {
      return `权限不足，无法读写目标位置（技术细节: ${snippet(raw, 160)}）`;
    }
    if (/Cannot read propert|is not a function|undefined is not/i.test(raw)) {
      return `程序内部错误，请带着下面的细节反馈给作者（技术细节: ${snippet(raw, 160)}）`;
    }
    return raw;
  }

  function paths() {
    const env = ctx.get('launchEnvironment');
    // Windows 上 launchEnvironment 无 HOME 时退回 USERPROFILE。
    // 统一成正斜杠：msys GNU tar 对反斜杠盘符路径的参数转换不可靠，
    // 而正斜杠路径 msys/bsdtar/POSIX tar 与 Node fs 都接受。
    const toFwd = (p) => (p.includes('\\') ? p.split('\\').join('/') : p);
    const homeRaw = env?.get('HOME')?.value || env?.get('USERPROFILE')?.value;
    const home = homeRaw ? toFwd(homeRaw.replace(/\/+$/, '')) : undefined;
    // DSH_HOME 与 HOME 一样去尾斜杠（#88）：'D:/dsh_data/' 会让 base 变空串、
    // parent 退化为源目录本身，tar 位置参数成空串，产出 0 字节坏归档。
    const dshHomeRaw = env?.get('DSH_HOME')?.value || (home ? `${home}/.dsh` : undefined);
    const dshHome = dshHomeRaw ? toFwd(dshHomeRaw).replace(/\/+$/, '') || '/' : undefined;
    if (!home || !dshHome) throw new Error('无法解析 HOME/USERPROFILE 或 DSH_HOME（launchEnvironment 缺失）');
    const cfg = resolvedConfig();
    const raw = typeof cfg.destination === 'string' && cfg.destination.trim()
      ? cfg.destination.trim()
      : DEFAULTS.destination;
    const expandHome = (p) => (p.startsWith('~') ? `${home}${p.slice(1)}` : toFwd(p));
    let root = expandHome(raw);
    // 0.14.0 改了默认目录名；还没完成迁移（或迁移失败）时继续用老默认目录，
    // 避免用户升级后看到"备份全没了"。用户显式配置过的目录不走这段兜底。
    if (raw === DEFAULTS.destination && !pathExists(root)) {
      for (const legacyRaw of LEGACY_DEFAULT_DESTINATIONS) {
        const legacyRoot = expandHome(legacyRaw);
        if (pathExists(legacyRoot)) { root = legacyRoot; break; }
      }
    }
    return { home, dshHome: toFwd(dshHome), root };
  }

  // #88：parent 由字符串截取求得，DSH_HOME 直接挂在盘符根时退化为 'D:'——
  // bsdtar/GNU tar 都把裸盘符解析为"该盘符当前目录"，-C D: 必然失败并留下
  // 空壳归档。tar 的 -C 一律传补过分隔符的值；fs 侧继续用原 parent
  // （'D:' + '/' + name 仍是合法路径，renameBeside 等不受影响）。
  const parentTar = (p) => (p.endsWith('/') ? p : `${p}/`);

  /** 仓库地址：CLI 首次备份的 star 提示用（面板侧另有常驻入口，见 src/client.js）。 */
  const STAR_URL = 'https://github.com/xiaoyuyu6420/dsh-backup';

  /** semver 比较（常见形态，含 prerelease）：a > b 才返回 true；解析失败保守降为 false。 */
  function semverGt(a, b) {
    const parse = (s) => {
      const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(String(s));
      if (!m) return null;
      return { n: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ?? null };
    };
    const A = parse(a);
    const B = parse(b);
    if (!A || !B) return false;
    for (let i = 0; i < 3; i += 1) {
      if (A.n[i] !== B.n[i]) return A.n[i] > B.n[i];
    }
    if (A.pre === B.pre) return false;
    return A.pre === null; // 无 prerelease 视为 release：同元组下 release > prerelease
  }

  /**
   * 检查 npm 最新版（更新感知，A）。纯只读，失败静默——返回 error 文案交给
   * 调用方，插件正常运行绝不因网络问题阻断。fetch 为 Node >=20 全局。
   */
  async function checkUpdate(signal) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    const onHostAbort = () => ctrl.abort();
    signal?.addEventListener('abort', onHostAbort, { once: true });
    try {
      const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(SELF_META.name)}`, {
        signal: ctrl.signal,
        headers: { accept: 'application/vnd.npm.install-v1+json' },
      });
      if (!res.ok) return { error: `npm registry 返回 ${res.status}` };
      const meta = await res.json();
      const latest = meta?.['dist-tags']?.latest;
      if (typeof latest !== 'string' || !latest) return { error: 'registry 响应缺少 dist-tags.latest' };
      return { current: SELF_META.version, latest, update: semverGt(latest, SELF_META.version) };
    } catch (err) {
      if (err && err.name === 'AbortError') return { error: '检查超时（8 秒）' };
      return { error: String(err && err.message ? err.message : err) };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onHostAbort);
    }
  }

  /** 读回 profile 内实际解析到的本插件版本（pnpm 把直接依赖链接在 profile 的
   *  node_modules 下）；路径异常或读不到时返回 null，调用方按「无法核对」处理。 */
  async function installedVersion(profile) {
    try {
      const meta = JSON.parse(await readFile(join(paths().dshHome, 'profiles', profile, 'node_modules', SELF_META.name, 'package.json'), 'utf8'));
      return typeof meta?.version === 'string' && meta.version ? meta.version : null;
    } catch {
      return null;
    }
  }

  /**
   * About 环境信息（P4）：只含版本/平台/路径，**绝不含凭据/密钥/home 明文**。
   * home 不单独返回；pluginDir 若位于 home 下则把 home 前缀脱敏成 `~`。
   * dshVersion 用 detectHostTrain()（测正在跑的宿主，而非 profile 里 hoisted
   * 的 peer 包）；取不到一律 'unknown'，绝不让 About 面板因环境探测失败而崩。
   */
  async function aboutInfo() {
    let dshVersion = 'unknown';
    try { dshVersion = detectHostTrain() || 'unknown'; } catch { dshVersion = 'unknown'; }
    let pluginDir = 'unknown';
    try {
      pluginDir = (fileURLToPath(new URL('..', import.meta.url)) || '').replace(/\/+$/, '') || '/';
    } catch { pluginDir = 'unknown'; }
    let home = null;
    try { home = paths().home; } catch { home = null; }
    // 脱敏：pluginDir 绝对路径若含 home 明文，替换成 ~ 前缀
    const maskHome = (p) => (home && typeof p === 'string' && p.startsWith(home)) ? `~${p.slice(home.length)}` : p;
    return {
      version: SELF_META.version,
      dshVersion,
      platform: process.platform,
      node: process.version,
      profile: 'web', // Web 面板 profile（launchEnvironment 无独立 profile 键时按默认）
      pluginDir: maskHome(pluginDir),
    };
  }

  /**
   * 一键更新（B）：先拍升级前快照（未过期的退路），再走官方 `dsh plugin
   * --profile <p> update --latest <pkg>`（pnpm 语义——profile 是 pnpm 项目，
   * 插件绝不自己覆写依赖文件，否则 lockfile 失配）。完成后提示重启生效：宿主
   * 在启动时结算 Loader 树，Node 半不可在运行中热替换。
   *
   * `--latest` 不可省：pnpm update <pkg> 只在 profile 声明的版本范围内升级
   * （安装时写入的是 ^x.y.z），跨 minor 会停在旧 minor 上——而升级按钮承诺的
   * 目标通常正是新 minor，少了它就是「点了更新、版本没动」。命令跑完再读回
   * profile 内的真实版本核对，不拿 registry 的 latest 冒充结果。
   */
  async function runUpdate(signal, profileArg) {
    const profile = profileArg || 'web';
    const chk = await checkUpdate(signal);
    if (chk.error) {
      return { ok: false, updated: false, summary: `检查更新失败：${chk.error}\n可手动执行: dsh plugin --profile ${profile} update --latest ${SELF_META.name}` };
    }
    if (!chk.update) {
      return { ok: true, updated: false, current: chk.current, latest: chk.latest, summary: `已是最新版本 ${chk.current}` };
    }
    // 更新前快照：与启动钩子的升级前快照同一语义（不阻断更新，失败如实提示）
    let snap = null;
    try {
      const s = await doBackup(undefined, signal, { namePrefix: 'dsh-pre-upgrade-' });
      prunePrefixedSnapshots('dsh-pre-upgrade-', 2, s.name).catch(() => {});
      snap = s.name;
    } catch { /* 快照失败不阻断更新 */ }
    // 解析 dsh CLI：优先 PATH（resolveExecutable），兜底用当前宿主入口（与
    // detectHostTrain 同款定位——`node <入口> plugin ...` 与运行中的宿主同源）
    let argv = null;
    try {
      argv = [await ctx.subprocess.resolveExecutable('dsh'), 'plugin', '--profile', profile, 'update', '--latest', SELF_META.name];
    } catch {
      try {
        argv = [process.execPath, realpathSync(process.argv[1]), 'plugin', '--profile', profile, 'update', '--latest', SELF_META.name];
      } catch {
        return { ok: false, updated: false, summary: `找不到 dsh 命令，请手动执行: dsh plugin --profile ${profile} update --latest ${SELF_META.name}${snap ? `\n更新前快照已留: ${snap}` : ''}` };
      }
    }
    try {
      const { root } = paths();
      await spawnRun(argv, root, signal);
    } catch (err) {
      return { ok: false, updated: false, summary: `更新失败：${friendlyReason(err)}${snap ? `\n已有升级前快照 ${snap}，可 /backup restore ${snap} 回滚。` : ''}` };
    }
    // 命令跑完 ≠ 版本已变：profile 里锁着精确版本、pnpm 配置忽略 --latest 等情况
    // 都会让结果停在旧版，读回真实版本再回执（否则用户重启后仍是旧版，无从解释）。
    const after = await installedVersion(profile);
    if (after && after !== chk.latest) {
      return {
        ok: false,
        updated: false,
        current: after,
        latest: chk.latest,
        summary: `更新命令已执行，但 profile 内解析到的仍是 ${after}（目标 ${chk.latest}）。`
          + `\n请手动执行: dsh plugin --profile ${profile} update --latest ${SELF_META.name}`
          + (snap ? `\n更新前已留升级前快照 ${snap}。` : ''),
      };
    }
    return {
      ok: true,
      updated: true,
      current: after || chk.latest,
      latest: chk.latest,
      summary: `已更新到 ${after || chk.latest}。${snap ? `\n更新前已留升级前快照 ${snap}（想回退：/backup restore ${snap}）。` : '\n更新前快照未生成（不影响本次更新）。'}\n请重启 dsh web 使新版本生效（宿主 0.2.1-rc.1+ 开启热重载时部分插件可免重启，面板没变化就重启）。`,
    };
  }

  function defaultKeep() {
    const cfg = resolvedConfig();
    const k = Number(cfg.keep);
    return Number.isFinite(k) && k > 0 ? Math.floor(k) : 7;
  }

  function extraExcludes() {
    const cfg = resolvedConfig();
    const list = Array.isArray(cfg.exclude) ? cfg.exclude : [];
    return list.filter((p) => typeof p === 'string' && p.length > 0).map((p) => `--exclude=${p}`);
  }

  /** 生效的脱敏清单：默认集 + config.redact 追加（false/'off' 整体关闭）。 */
  function sensitivePaths() {
    const cfg = resolvedConfig();
    const redactCfg = cfg.redact;
    if (redactCfg === false || redactCfg === 'off' || redactCfg === 'none') return [];
    const extra = Array.isArray(redactCfg) ? redactCfg.filter((p) => typeof p === 'string' && p.trim().length) : [];
    return [...new Set([...SENSITIVE_DEFAULTS, ...extra.map((p) => p.trim())])];
  }

  /**
   * 归档排除模式（tar 成员路径以 `<base>/` 开头，如 `.dsh/.credentials.yaml`）。
   * GNU/bsdtar 的 --exclude 对成员路径做 glob 匹配：`<base>/<rel>` 精确
   * 命中根级文件，再加一条任意目录前缀的同名模式覆盖深层出现
   * （rel 本身可含 glob）。
   */
  function redactExcludeFlags(base) {
    return sensitivePaths().flatMap((rel) => [`--exclude=${base}/${rel}`, `--exclude=*/${rel}`]);
  }

  /**
   * 列出 ~/.dsh 中现存的敏感文件（相对路径），不拷贝。供跳过 vault 刷新
   * 的内部快照（pre-restore）仍能记录正确的脱敏清单边车。
   */
  async function existingSensitive(dshHome) {
    const out = [];
    for (const rel of sensitivePaths()) {
      const ok = await fsStat(`${dshHome}/${rel}`).then(() => true, () => false);
      if (ok) out.push(rel);
    }
    return out;
  }

  /**
   * vault 串行锁：同一进程内「备份刷新镜像」与「凭据存底」（启动钩子 / migrate
   * 预检）都写同一个 vault 目录。旧实现是"整目录 rm -rf 再重写"，两路并发时
   * 互相踩——Linux 上实测 ENOTEMPTY 直接让整个备份失败（CI 稳定复现）。
   */
  let vaultChain = Promise.resolve();
  function withVaultLock(task) {
    const next = vaultChain.then(task, task);
    vaultChain = next.then(() => {}, () => {});
    return next;
  }

  /**
   * 刷新本机 vault：把 ~/.dsh 中现存的敏感文件按相对路径镜像到
   * `<备份目录>/vault/`（先清空旧镜像，vault 永远对应最新一次备份）。
   * 返回实际入库的相对路径列表。目录 700 / 文件 600（POSIX）。
   */
  async function refreshVault(dshHome, home, signal) {
    const { root } = paths();
    const rels = sensitivePaths();
    const vaultDir = `${root}/${VAULT_DIR}`;
    if (!rels.length) return [];
    if (signal?.aborted) throw new Error('操作已取消');
    return withVaultLock(async () => {
      // 只清 vault 里的**镜像条目**：`preserved/`（凭据存底）绝不能被下一次备份
      // 抹掉——它正是为"升级后想回退"留的后路。镜像文件随后会被 copyFile 覆盖成
      // 最新内容，所以清理失败（另一实例正在写）一律容忍，不值得让备份失败。
      let names = [];
      try {
        names = await readdir(vaultDir);
      } catch { /* vault 尚不存在：下面逐文件 mkdir 会建 */ }
      for (const n of names) {
        if (n === PRESERVED_DIR) continue;
        await rm(`${vaultDir}/${n}`, { recursive: true, force: true }).catch(() => {});
      }
      const stored = [];
      for (const rel of rels) {
        const src = `${dshHome}/${rel}`;
        const ok = await fsStat(src).then(() => true, (err) => {
          if (err && err.code === 'ENOENT') return false;
          throw err;
        });
        if (!ok) continue;
        const dst = `${vaultDir}/${rel}`;
        await mkdir(dirname(dst), { recursive: true });
        await copyFile(src, dst);
        stored.push(rel);
      }
      if (stored.length && !IS_WIN) {
        const chmod = await ctx.subprocess.resolveExecutable('chmod');
        try {
          await spawnRun([chmod, '-R', 'go-rwx', vaultDir], home, signal);
        } catch {
          // chmod 失败不阻断备份：vault 已在用户私有目录下，权限收紧是纵深防御
        }
      }
      return stored;
    });
  }

  function stampNow() {
    const now = new Date();
    const pad = (n, w = 2) => String(n).padStart(w, '0');
    return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}${pad(now.getMilliseconds(), 3)}`;
  }

  /**
   * 从 http(s) URL 中剥离 userinfo（`user:pass@` 段，含 token-as-username
   * 形态）。GitHub 同步的认证始终走环境变量 token → 同步工作树的
   * .git-credentials，不依赖 URL 内嵌凭据；但用户可能把 PAT 写进 repo
   * URL，此时 token 会明文落入 auto.json 并被 `/backup github status` 与
   * 面板 repoRaw 回显。此处在存/显前剥离。
   * 仅作用于 http(s)——ssh://git@、file://、owner/repo、本地路径等保持原样
   * （不同认证模型，剥 username 会破坏如 ssh://git@host）。用 URL 解析处理
   * port/IPv6/path 含已编码 @ 等；非 URL / 无 userinfo / 解析异常原样返回。
   */
  function stripUserinfo(raw) {
    if (typeof raw !== 'string' || !/^https?:\/\//i.test(raw)) return raw;
    try {
      const u = new URL(raw);
      if (u.username || u.password) {
        u.username = '';
        u.password = '';
        return u.toString();
      }
      return raw;
    } catch {
      return raw;
    }
  }

  /**
   * 删除 dir 下的文件。纯 Node fs.unlink（零 shell）：文件名来自备份目录
   * 内容，拼接进 cmd/rm 命令行会构成命令注入面（Windows 下 cmd 的
   * `del /f /q ${names}` 可被 `dsh-x & calc &x.tar.gz` 之类文件名利用）。
   */
  async function removeFiles(names, dir, signal) {
    if (!names.length) return;
    if (signal?.aborted) throw new Error('操作已取消');
    await Promise.all(names.map((n) => unlink(`${dir}/${n}`).catch((err) => {
      // 目标已不存在等价 rm -f 的静默成功；其余错误照常抛出
      if (err && err.code === 'ENOENT') return;
      throw err;
    })));
  }

  /** 把 dir 下的文件/目录改名为同目录下的另一个名字（恢复时挪开现有数据）。 */
  async function renameBeside(dir, srcName, dstName, signal) {
    if (signal?.aborted) throw new Error('操作已取消');
    await rename(`${dir}/${srcName}`, `${dir}/${dstName}`);
  }

  /** 清理内部快照（pre-restore / pre-upgrade 共用）：只保留最近 keepN 份；protect 里的归档即使落在窗口外也强制保留。 */
  async function prunePrefixedSnapshots(prefix, keepN, keepNames, signal) {
    const protect = Array.isArray(keepNames) ? keepNames : [keepNames];
    const { root } = paths();
    let dirents;
    try {
      dirents = await readdir(root, { withFileTypes: true });
    } catch {
      return;
    }
    const names = dirents
      .filter((d) => d.name.startsWith(prefix) && (d.name.endsWith('.tar.gz') || d.name.endsWith('.sha256') || d.name.endsWith('.meta.json') || d.name.endsWith('.redacted.json') || d.name.endsWith('.encrypted.json')))
      .map((d) => d.name)
      .sort()
      .reverse();
    // 归档名排序即时间序；边车跟宿主同名排序紧邻其后，按"每份归档一组"数份数
    const archiveCount = names.filter((n) => n.endsWith('.tar.gz'));
    const staleArchives = archiveCount.slice(keepN).filter((n) => !protect.includes(n));
    const staleSet = new Set(staleArchives.flatMap((n) => sidecarsFor(n)));
    if (staleSet.size) await removeFiles([...staleSet], root, signal);
  }

  /**
   * 恢复流程收尾的快照清理。keepNames 必须同时含新拍的快照与本次恢复的
   * 目标归档——目标本身可能就是一份 dsh-pre-restore-* 快照，只保护新快照
   * 会把正在恢复的归档清掉，解压必然 ENOENT（UX 审查实测的自毁死路）。
   */
  async function prunePreRestoreSnapshots(keepNames, signal) {
    await prunePrefixedSnapshots('dsh-pre-restore-', 1, keepNames, signal);
  }

  /** 归档伴生边车集：轮换、删除与 GitHub 同步对同一归档统一处理的文件列表。 */
  function sidecarsFor(name) {
    return [name, `${name}.sha256`, `${name}.meta.json`, `${name}.redacted.json`, `${name}.encrypted.json`];
  }

  /** 内部快照前缀（恢复前 / 升级前 / 导入前）：不进用户列表、不参与轮换与 keep 配额。 */
  const SNAPSHOT_PREFIXES = Object.freeze(['dsh-pre-restore-', 'dsh-pre-upgrade-', IMPORT_SNAPSHOT_PREFIX]);

  async function listBackups() {
    const { root } = paths();
    let dirents;
    try {
      dirents = await readdir(root, { withFileTypes: true });
    } catch {
      // 备份目录缺失或不可读时视为空列表（首次使用前 / EACCES 容错）
      return [];
    }
    const backups = [];
    for (const d of dirents) {
      // 内部快照（dsh-pre-restore-* / dsh-pre-upgrade-*）不进用户列表、
      // 不参与轮换、不被 pickArchive 的 latest 误选；显式前缀仍可选中
      // （见 pickArchive 的快照回退分支）。
      if (!d.name.startsWith('dsh-') || SNAPSHOT_PREFIXES.some((p) => d.name.startsWith(p)) || d.name.startsWith(TYPED_PREFIX) || !d.name.endsWith('.tar.gz')) continue;
      let size;
      try {
        const st = await fsStat(`${root}/${d.name}`);
        // 正在写入的归档（tar 直写最终文件名，写完前 size=0）先不进列表——
        // 用户刷新撞见 0 字节条目会以为备份坏了（UX 审查 P1-7）；写入失败
        // 残留的 0 字节文件 60 秒后仍会显示出来，不会被永久隐藏。
        if (st.size === 0 && Date.now() - st.mtimeMs < 60_000) continue;
        size = st.size;
      } catch {
        // 归档在列表与 stat 之间被删除（轮换/删除竞态）——大小显示为未知而非报错
        size = undefined;
      }
      // 加密归档带 .encrypted.json 边车：列表标记 🔒，供 CLI/面板/工具展示。
      const encrypted = await existsStat(`${root}/${d.name}.encrypted.json`);
      backups.push({ name: d.name, size, encrypted });
    }
    return backups.sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));
  }

  /** 列出内部快照归档名（新→旧），prefix 传 'dsh-pre-' 可同时取两类。 */
  async function listSnapshotNames(prefix = 'dsh-pre-') {
    const { root } = paths();
    let dirents;
    try {
      dirents = await readdir(root, { withFileTypes: true });
    } catch {
      return [];
    }
    return dirents
      .filter((d) => d.name.endsWith('.tar.gz') && SNAPSHOT_PREFIXES.some((p) => d.name.startsWith(p)) && d.name.startsWith(prefix))
      .map((d) => d.name)
      .sort()
      .reverse();
  }

  async function writeOwned(p, content) {
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, content, 'utf8');
  }

  /** 二进制写盘（密文归档、解密的临时 tar.gz 等——绝不能用 utf8 写，会毁掉字节）。 */
  async function writeBinary(p, buf) {
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, buf);
  }

  // 校验和：POSIX 优先 sha256sum（macOS 回退 shasum）流式计算；
  // 都不可用时（Windows 典型）回退 node:crypto 流式哈希。
  // #103：旧实现是 readFile 整包进内存 + 同步 update，且 >256MB 直接抛错——
  // Windows 上 3GB 级归档因此**必然失败**，备份写完 tar 却永远收不了尾，
  // 锚点不前进 → 每次启动重跑一次全量 tar → 宿主 boot 窗口被拖死。
  // 改为 createReadStream 分块喂哈希：不整包入内存、每块之间让出事件循环、无体积上限。
  async function sha256File(absPath, home, signal) {
    for (const candidate of [['sha256sum', []], ['shasum', ['-a', '256']]]) {
      try {
        const bin = await ctx.subprocess.resolveExecutable(candidate[0]);
        const r = await spawnRun([bin, ...candidate[1], absPath], home, signal);
        const h = r.out.trim().split(/\s+/)[0];
        if (/^[0-9a-f]{64}$/.test(h)) return h;
        throw new Error(`无法解析 ${candidate[0]} 输出`);
      } catch {
        // 尝试下一个
      }
    }
    const hash = createHash('sha256');
    const stream = createReadStream(absPath, { highWaterMark: HASH_CHUNK_BYTES });
    try {
      for await (const chunk of stream) {
        if (signal?.aborted) throw new Error('操作已取消');
        hash.update(chunk);
      }
    } catch (err) {
      stream.destroy();
      throw err;
    }
    return hash.digest('hex');
  }

  async function existsStat(p) {
    try { await fsStat(p); return true; } catch { return false; }
  }

  /**
   * 递归展开相对 ~/.dsh 的星号通配（spawnRun 不经 shell，tar 位置参数需字面
   * 路径）。只返回实际存在的路径。mcp 类 profiles 下各 profile 的
   * cordis.yml / cordis.patch.yml 靠它展开。
   */
  async function expandGlob(rel, root) {
    const parts = rel.split('/');
    const out = [];
    async function walk(i, dir, acc) {
      if (i >= parts.length) { if (acc) out.push(acc); return; }
      const seg = parts[i];
      if (seg === '*') {
        let dirents;
        try { dirents = await readdir(dir, { withFileTypes: true }); } catch { return; }
        for (const d of dirents) {
          if (!d.isDirectory()) continue;
          await walk(i + 1, `${dir}/${d.name}`, acc ? `${acc}/${d.name}` : d.name);
        }
      } else {
        const next = `${dir}/${seg}`;
        if (!(await existsStat(next))) return;
        await walk(i + 1, next, acc ? `${acc}/${seg}` : seg);
      }
    }
    await walk(0, root, '');
    return out;
  }

  /**
   * 把分类型名展开成归档内相对路径（${base}/ 前缀），预检存在性、展开 glob。
   * 返回 { targets, hasCredentials }：targets 供 tar 位置参数（-C parent ...targets）；
   * hasCredentials 标记是否含凭据类——凭据明文进归档，githubSync 据此跳过上云。
   * 不存在的路径跳过（tar 对不存在路径会报错中止）；glob 展开后同样预检。
   */
  async function typeTargets(types, dshHome, base) {
    const targets = [];
    let hasCredentials = false;
    const seen = new Set();
    for (const key of types) {
      const spec = BACKUP_TYPES[key];
      if (!spec) continue;
      if (spec.credentials) hasCredentials = true;
      for (const rel of spec.paths) {
        const matched = rel.includes('*') ? await expandGlob(rel, dshHome) : ((await existsStat(`${dshHome}/${rel}`)) ? [rel] : []);
        for (const m of matched) {
          const entry = `${base}/${m}`;
          if (!seen.has(entry)) { seen.add(entry); targets.push(entry); }
        }
      }
    }
    return { targets, hasCredentials };
  }

  /** 列分类型归档（dsh-t-*，新→旧），供独立轮换与列表展示。 */
  async function listTypedBackups() {
    const { root } = paths();
    let dirents;
    try { dirents = await readdir(root, { withFileTypes: true }); } catch { return []; }
    const backups = [];
    for (const d of dirents) {
      if (!d.name.startsWith(TYPED_PREFIX) || !d.name.endsWith('.tar.gz')) continue;
      let size;
      try { size = (await fsStat(`${root}/${d.name}`)).size; } catch { size = undefined; }
      backups.push({ name: d.name, size });
    }
    return backups.sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));
  }

  // ---------- 操作锁（跨进程互斥 + 死锁回收，P3） ----------
  // 备份/恢复/导入/同步/doctor 这类重活会动 ~/.dsh 与备份目录（vault 刷新、
  // .dsh 挪旁、归档轮换），多实例/多 profile 并发会互相踩。锁文件在备份目录根
  // .oplock.json，记 pid+token+心跳；死锁（pid 已死）下次自动回收，活锁绝不误踢。
  // 同进程重入（restore 内部的快照 doBackup 等）经 heldLock 内存标记直接放行。
  let heldLock = null;
  let heartbeatTimer = null;

  async function withOperationLock(operation, fn) {
    if (heldLock) return fn(); // 同进程重入：本进程已持锁，直接跑
    const { root } = paths();
    const lockPath = `${root}/${LOCK_FILE}`;
    const r = await acquireLock(lockPath, operation);
    if (!r.acquired) {
      throw new Error(`另一操作正在进行（${r.heldBy?.operation ?? '未知'}，pid=${r.heldBy?.pid}）——请稍后重试；若确认是残留死锁可用 /backup lock reclaim 回收`);
    }
    heldLock = r.lock;
    heartbeatTimer = setInterval(() => { heartbeatLock(lockPath, r.lock.token).catch(() => {}); }, LOCK_HEARTBEAT_MS);
    try {
      return await fn();
    } finally {
      if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
      await releaseLock(lockPath, r.lock.token).catch(() => {});
      heldLock = null;
    }
  }

  async function doBackup(keep, signal, opts = {}) {
    return withOperationLock('backup', () => doBackupInner(keep, signal, opts));
  }

  async function doBackupInner(keep, signal, opts = {}) {
    const { home, dshHome, root } = paths();
    const keepN = keep && keep > 0 ? Math.floor(keep) : defaultKeep();
    // 状态文件先写：writeText 会自动创建备份目录，替代 mkdir -p（Windows 无 mkdir.exe）。
    await saveAutoState();

    // 分类型备份：opts.types 非空时用 dsh-t- 前缀（独立轮换、旧版不可见），
    // tar 按 typeTargets 子集打包而非整个 .dsh。
    const types = Array.isArray(opts?.types) && opts.types.length
      ? [...new Set(opts.types.filter((t) => BACKUP_TYPES[t]))]
      : null;
    const prefix = types ? TYPED_PREFIX : (typeof opts?.namePrefix === 'string' && opts.namePrefix ? opts.namePrefix : 'dsh-');
    const name = `${prefix}${stampNow()}.tar.gz`;
    const out = `${root}/${name}`;
    const base = dshHome.split('/').pop();
    const parent = dshHome.slice(0, -(base.length + 1)) || '/';

    // 备份前体检联动：损坏的会话日志**不入档**——坏字节一旦进了归档，轮换会在
    // 不知情的情况下删掉最后一份好副本。检出项记入 meta.quarantined，恢复侧
    // 如实提示。体检失败不阻断备份（fail-open）。
    let quarantined = [];
    if (!opts?.skipScan) {
      try {
        quarantined = (await runDoctorScan(signal)).corrupt.map((c) => c.rel);
      } catch { /* 扫描异常按无隔离处理 */ }
    }
    const quarantineFlags = quarantined.map((rel) => `--exclude=${base}/${rel}`);

    // tar 以备份目录为 cwd、用纯文件名传 -f：Windows 上 GNU tar（msys）会把
    // 含盘符冒号的绝对路径当远程归档（"Cannot connect to C"），bsdtar 则两者皆可。
    // 敏感文件先从归档排除（redactExcludeFlags），其明文副本进本机 vault。
    // skipVault（pre-restore 快照）：数据可能正待恢复/已损，刷新 vault 会把
    // 仅存的凭据副本清掉——只列清单不拷贝，vault 保持上一次常规备份的状态。
    // 分类型备份：展开选定的类型为 tar 位置参数子集；凭据类要明文进归档，
    // 跳过脱敏排除。types 备份不刷新 vault（归档已自含所选内容，凭据类含明文；
    // 非凭据类子集本不含凭据文件），vault 保持上一次全量备份状态不被干扰。
    let typePaths = null;
    let hasCredentials = false;
    if (types) {
      ({ targets: typePaths, hasCredentials } = await typeTargets(types, dshHome, base));
      if (!typePaths.length) throw new Error('选定的类型在 ~/.dsh 里没有可备份的内容（路径均不存在）');
    }
    const isTyped = !!types;
    const skipVault = opts?.skipVault || isTyped;
    const redacted = skipVault ? await existingSensitive(dshHome) : await refreshVault(dshHome, home, signal);
    const tar = await ctx.subprocess.resolveExecutable('tar');
    const redactFlags = isTyped ? [] : redactExcludeFlags(base);
    try {
      await spawnRun([tar, '--exclude=*node_modules*', '--exclude=.system', ...quarantineFlags, ...redactFlags, ...extraExcludes(), '-czf', name, '-C', parentTar(parent), ...(isTyped ? typePaths : [base])], root, signal);
    } catch (err) {
      // tar 失败前已创建 -f 目标——空壳归档留在备份目录会被面板当正常备份
      // 列出来（#88：29 字节静默空包）。删掉空壳再抛，让失败可见。
      await rm(out, { force: true }).catch(() => {});
      throw err;
    }

    // 可选口令加密（P2）：口令只经内存传入（面板 RPC 的 backup({password})），
    // **绝不写 settings.yaml、绝不进日志、绝不写盘**。密文原地覆盖归档本身，
    // nonce/tag/salt/kdf 参数进 .encrypted.json 边车；下方 sha256 算的是**密文**，
    // 故 verify 无需口令即可做完整性校验。加密前 tar.gz 已是完整明文，此处原地
    // 替换——旧版插件遇到它只会 tar 解不开，边车只增不改、不误删不误读。
    let encrypted = false;
    if (typeof opts?.password === 'string' && opts.password) {
      // 流式加密 + 临时文件后原子替换：绝不在原路径「整包读入 → 原地覆盖」。
      // 中途崩溃只会留下完整明文或完整密文，不会留半截密文（#103 同类教训）。
      const tmpEnc = `${out}.enc-${stampNow()}.tmp`;
      let enc;
      try {
        enc = await encryptFile(out, tmpEnc, opts.password);
        await rename(tmpEnc, out);
      } catch (err) {
        await rm(tmpEnc, { force: true }).catch(() => {});
        throw err;
      }
      await writeOwned(`${out}.encrypted.json`, `${JSON.stringify(enc.sidecar)}\n`);
      encrypted = true;
    }

    const shaText = await sha256File(out, home, signal);
    await writeOwned(`${out}.sha256`, `${shaText}  ${out}\n`);
    // types 归档不写 .redacted.json：凭据类明文已在归档内（不靠 vault 还原），
    // 非凭据类子集本不含凭据。全量归档照旧写脱敏清单供恢复侧从 vault 还原。
    if (!isTyped && sensitivePaths().length) {
      await writeOwned(`${out}.redacted.json`, `${JSON.stringify({ files: redacted })}\n`);
    }
    // 机器元数据边车：跨机恢复的预检依据（home 不一致 → 绝对路径提示）；
    // quarantined 记录体检隔离、未入档的损坏会话文件。
    // meta 记 types（分类型归档标识；缺省=全量，旧版/旧归档照读不误）；types
    // 归档 redacted 记 0（未脱敏），hasCredentials 供 githubSync 跳过上云判断。
    await writeOwned(`${out}.meta.json`, `${JSON.stringify({ host: hostname(), home, dshHome, createdAt: new Date().toISOString(), redacted: isTyped ? 0 : redacted.length, ...(isTyped ? { types, hasCredentials } : {}), ...(encrypted ? { encrypted: true } : {}), ...(quarantined.length ? { quarantined } : {}) })}\n`);

    // 救援通道：每次备份把进程外恢复工具落进备份目录——宿主起不来时
    // `node rescue.mjs`（或双击启动器）仍可恢复（DSH 依赖 Node，宿主死了
    // Node 一定活着）。复制失败不阻断备份：rescue 缺席只影响灾时体验。
    try {
      await copyFile(new URL('../rescue/rescue.mjs', import.meta.url), `${root}/rescue.mjs`);
      await writeOwned(`${root}/RESCUE.txt`, RESCUE_TXT);
      // 人话版使用说明：用户第一次打开备份目录时最该看到的东西（0.14.0）
      await writeOwned(`${root}/${GUIDE_FILE}`, GUIDE_TXT);
      const launcher = RESCUE_LAUNCHERS[process.platform];
      if (launcher) {
        const [name, content] = launcher;
        await writeOwned(`${root}/${name}`, content);
        if (!IS_WIN) {
          const chmod = await ctx.subprocess.resolveExecutable('chmod');
          await spawnRun([chmod, '755', `${root}/${name}`], home, signal);
        }
      }
    } catch { /* 老安装缺文件等场景静默跳过 */ }

    // 安全：备份含明文凭据（.credentials.yaml / qq-bridge/config.json），收紧为仅本人可读写。
    // Windows 无 chmod，用户目录 ACL 默认私有。加密边车同权（无明文，但统一收紧）。
    if (!IS_WIN) {
      const chmod = await ctx.subprocess.resolveExecutable('chmod');
      await spawnRun([chmod, '600', out, `${out}.sha256`, ...(encrypted ? [`${out}.encrypted.json`] : [])], home, signal);
    }

    // 分级轮换：keep 窗口之外的尾巴不再一刀切全删——保留最近 7 个不同自然日
    // 的每日首份、再往前 4 个不同 ISO 周的每周首份（今日的档内冗余仍按 keep
    // 裁剪）。严格只比旧的"全删"多保留，绝不多删；非标准命名（解析不出日期）
    // 保持旧行为不保护。
    // 轮换：types 归档与全量归档分桶独立计 keep 窗口（dsh-t- 前缀），互不挤占。
    // 统一用 rotateBase/rotateStale 变量，使下方 return 在两条路径下都可见。
    // skipRotate：恢复流程中途拍的快照绝不顺带轮换——目标归档可能正落在
    // keep 窗口外，轮换会删掉马上要解压的文件（review P1-3）。
    const rotateBase = isTyped ? await listTypedBackups() : await listBackups();
    const rotateTail = rotateBase.slice(keepN);
    // GFS 保留（P3）：在既有日/周分层之上，再按 gfsMonthly/gfsYearly 各留月/年
    // 首份。缺省 0 = 完全等价旧行为（只 keep N + 日/周分层）。
    const gfsCfg = resolvedConfig();
    const gfsProtect = gfsProtectedSet(rotateTail, rotateBase[0]?.name, {
      monthly: Number(gfsCfg.gfsMonthly) > 0 ? Math.floor(Number(gfsCfg.gfsMonthly)) : 0,
      yearly: Number(gfsCfg.gfsYearly) > 0 ? Math.floor(Number(gfsCfg.gfsYearly)) : 0,
    });
    const rotateStale = opts.skipRotate
      ? []
      : rotateTail.filter((b) => !tierProtectedSet(rotateTail, rotateBase[0]?.name).has(b.name) && !gfsProtect.has(b.name)).map((b) => b.name);
    if (rotateStale.length) await removeFiles(rotateStale.flatMap((n) => sidecarsFor(n)), root, signal);

    // GitHub 同步（失败不回滚备份；状态记入 auto.json）
    let sync = null;
    try {
      sync = await githubSync(signal);
      if (sync.pushed) {
        githubState = { ...githubState, lastPush: sync.at, lastError: null };
        await saveAutoState();
      } else if (sync.error) {
        githubState = { ...githubState, lastError: sync.error };
        await saveAutoState();
      }
    } catch (err) {
      const message = String(err && err.message ? err.message : err);
      sync = { error: message };
      githubState = { ...githubState, lastError: message };
      await saveAutoState();
    }

    return { path: out, name, sha: shaText, total: rotateBase.length, stale: rotateStale.length, keep: keepN, quarantined, sync, ...(encrypted ? { encrypted: true } : {}), ...(isTyped ? { types, hasCredentials } : {}) };
  }

  /** 备份回执的隔离提示行：体检发现坏会话文件未入档时如实告知 + 指路修复。 */
  function quarantineNote(r) {
    return Array.isArray(r?.quarantined) && r.quarantined.length
      ? `\n⚠️ ${r.quarantined.length} 个损坏会话文件未入档（防轮换毁掉好副本）；/backup doctor --repair 修复后可正常备份`
      : '';
  }

  // ---------- GitHub 同步 ----------
  function githubConfig() {
    // 运行时设置（面板/命令，存 auto.json）优先，settings.yaml → cordis.yml 的 githubRepo 是初始默认。
    const cfg = resolvedConfig();
    const raw = githubState && typeof githubState.repo === 'string' && githubState.repo.trim()
      ? githubState.repo.trim()
      : (typeof cfg.githubRepo === 'string' && cfg.githubRepo.trim()
        ? cfg.githubRepo.trim()
        : '');
    if (!raw) return null;
    const env = ctx.get('launchEnvironment');
    // token 来源优先级：面板/聊天配置（本机备份目录 github.token）> 环境变量。
    // 面板值存在本机、不进归档也不进同步，跨机需重填——与凭据脱敏同一哲学。
    const token = storedGithubToken
      || env?.get('DSH_BACKUP_GITHUB_TOKEN')?.value
      || env?.get('GITHUB_TOKEN')?.value;
    // 本地路径（测试/自托管）或 http(s) 全 URL 直接使用，否则视为 owner/repo。
    const repo = raw.includes('://') || /^[A-Za-z]:[\\/]|^\//.test(raw) ? raw : `https://github.com/${raw}.git`;
    return { repo: stripUserinfo(repo.split('\\').join('/')), token };
  }

  // ---------- GitHub token：面板/聊天直配（本机存储） ----------
  const GITHUB_TOKEN_FILE = 'github.token';
  let storedGithubToken = null;

  /** 启动时从备份目录根读入面板配置的 token（0600 文件）；缺失/不可读 = null。 */
  async function loadStoredGithubToken() {
    const { root } = paths();
    try {
      const t = (await readFile(`${root}/${GITHUB_TOKEN_FILE}`, 'utf8')).trim();
      storedGithubToken = t || null;
    } catch {
      storedGithubToken = null;
    }
    return storedGithubToken;
  }

  /** token 形状校验：ghp_…/github_pat_…/40 位经典；拦住整段误粘贴的句子。非法返回原因。 */
  function validateGithubToken(raw) {
    const t = raw.trim();
    if (!t) return 'token 不能为空（清除请用清除按钮或 /backup github token off）';
    if (!/^[A-Za-z0-9_-]{20,255}$/.test(t)) return 'token 形状不对：应为 ghp_…/github_pat_… 或 40 位经典 token（字母数字与 _-，不含空格）';
    return null;
  }

  /** 保存面板 token：备份目录根 github.token，独占创建 0600（同 vault 明文待遇）。 */
  async function writeStoredGithubToken(t) {
    const { root } = paths();
    const file = `${root}/${GITHUB_TOKEN_FILE}`;
    let fh;
    try {
      fh = await open(file, 'wx', 0o600);
    } catch (e) {
      if (!(e && e.code === 'EEXIST')) throw e;
      fh = await open(file, 'w', 0o600);
      if (!IS_WIN) await fh.chmod(0o600);
    }
    try {
      await fh.writeFile(`${t}\n`, 'utf8');
    } finally {
      await fh.close();
    }
    if (!IS_WIN) await chmod(file, 0o600).catch(() => {});
    storedGithubToken = t;
  }

  /** 清除面板 token（文件删除；环境变量不受影响）。 */
  async function clearStoredGithubToken() {
    const { root } = paths();
    await rm(`${root}/${GITHUB_TOKEN_FILE}`, { force: true });
    storedGithubToken = null;
  }

  /** 是否存在任何可用 token（面板存储或环境变量）——与是否配置仓库解耦，供状态徽标。 */
  function hasGithubToken() {
    if (storedGithubToken) return true;
    const env = ctx.get('launchEnvironment');
    return Boolean(env?.get('DSH_BACKUP_GITHUB_TOKEN')?.value || env?.get('GITHUB_TOKEN')?.value);
  }

  /** 校验仓库地址格式（owner/repo、完整 URL 或本地路径），非法返回原因。 */
  function validateRepo(raw) {
    if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(raw)) return null;
    if (raw.includes('://') || /^[A-Za-z]:[\\/]|^\//.test(raw)) return null;
    return '仓库地址应为 owner/repo、完整 URL（http(s)://...）或本地路径';
  }

  /**
   * 校验同步配置并准备好同步工作树（init + remote + token 凭据 + gitignore）。
   * 推送（githubSync）与拉取（githubPull）共用；未配置/缺 token 返回 reason。
   */
  async function ensureSyncWorktree(signal) {
    const { root } = paths();
    const cfg = githubConfig();
    if (!cfg) return { reason: '未配置 githubRepo（cordis.yml config.githubRepo）' };
    if (cfg.repo.startsWith('https://') && !cfg.token) {
      return { reason: 'https 远端缺少 token：可在面板「GitHub Token」或 /backup github token <token> 配置，或环境变量 DSH_BACKUP_GITHUB_TOKEN / GITHUB_TOKEN' };
    }
    const syncDir = `${root}/${SYNC_DIR}`;
    const git = await ctx.subprocess.resolveExecutable('git');
    await mkdir(syncDir, { recursive: true });

    const hasGit = await fsStat(`${syncDir}/.git`).then(() => true, () => false);
    if (!hasGit) {
      try {
        await spawnRun([git, 'init', '-b', 'main'], syncDir, signal);
      } catch {
        // git 版本不支持 -b 时回退 init + branch -M
        await spawnRun([git, 'init'], syncDir, signal);
        await spawnRun([git, 'branch', '-M', 'main'], syncDir, signal);
      }
    }
    const remotes = await spawnRun([git, 'remote', '-v'], syncDir, signal);
    if (!remotes.out.includes('origin')) {
      await spawnRun([git, 'remote', 'add', 'origin', cfg.repo], syncDir, signal);
    }
    if (cfg.token) {
      // 正斜杠路径：msys git 会把反斜杠绝对路径当相对路径解析（怪名化）
      const creds = `${syncDir}/.git-credentials`;
      // 独占创建（0600）：凭据文件不留 umask 默认权限窗口；已存在时普通
      // 打开后显式 chmod 收紧——open 的 mode 参数只作用于新建文件，对已
      // 存在文件（如 0644 残留）不生效。
      let fh;
      try {
        fh = await open(creds, 'wx', 0o600);
      } catch (e) {
        if (!(e && e.code === 'EEXIST')) throw e;
        fh = await open(creds, 'w', 0o600);
        if (!IS_WIN) await fh.chmod(0o600);
      }
      try {
        await fh.writeFile(`https://x-access-token:${cfg.token}@github.com\n`, 'utf8');
      } finally {
        await fh.close();
      }
      await spawnRun([git, 'config', 'credential.helper', `store --file=${creds}`], syncDir, signal);
    }
    // token 文件绝不能进仓库：git add -A 会把它当普通文件提交
    await writeOwned(`${syncDir}/.gitignore`, '.git-credentials\n');
    return { cfg, syncDir, git };
  }

  /**
   * 把当前备份集推送到 GitHub 仓库。工作树位于 `<备份目录>/.github-sync`：
   * 归档与边车复制进去，git add -A 同时记录轮换删除，commit 后
   * `push HEAD:main --force-with-lease`。https 远端的 token 只写入工作树内
   * 的 .git-credentials（credential helper），不进进程参数。
   */
  async function githubSync(signal) {
    const { root } = paths();
    const wt = await ensureSyncWorktree(signal);
    if (wt.reason) return { skipped: wt.reason };
    const { syncDir, git } = wt;
    // pull 之后本地工作树可能领先/分叉：push 前先对齐远端，保证 force-with-lease
    // 有基准（远端被其他机器推送过时直接 reset 到远端再叠加本地备份集）。
    try {
      await spawnRun([git, 'fetch', 'origin', 'main'], syncDir, signal);
      await spawnRun([git, 'reset', '--hard', 'origin/main'], syncDir, signal);
    } catch {
      // 远端尚无 main（首次推送）或不可达：继续走本地提交路径，push 自会报错
    }

    // 镜像工作树：只保留 .gitignore、凭据文件（.git-credentials，token
    // 配置时在 keep 集内保留）与当前备份集（归档+边车），其余文件
    // （旧副本、误入杂物）清理——git add -A 因此只会收录归档；轮换
    // 删除与误入文件一并同步移除。
    // keep 集只含全量归档：listBackups 排除 dsh-t-（分类型归档），故类型归档
    // 不进 GitHub 同步——含 credentials 明文者尤甚，纵深满足"凭据不上云"。
    const keep = new Set(['.gitignore']);
    if (wt.cfg.token) keep.add('.git-credentials');
    for (const b of await listBackups()) {
      for (const f of sidecarsFor(b.name)) keep.add(f);
    }
    let entries = [];
    try {
      entries = await readdir(syncDir, { withFileTypes: true });
    } catch {
      // 同步目录刚创建或不可读时视为空
      entries = [];
    }
    const stale = entries
      .filter((e) => e.isFile() && !keep.has(e.name))
      .map((e) => e.name);
    if (stale.length) await removeFiles(stale, syncDir, signal);

    const tooBig = [];
    for (const b of await listBackups()) {
      const size = b.size ?? (await fsStat(`${root}/${b.name}`).then((s) => s.size, () => 0));
      if (size > MAX_GITHUB_BYTES) {
        tooBig.push(b.name);
        continue;
      }
      for (const f of sidecarsFor(b.name)) {
        await copyFile(`${root}/${f}`, `${syncDir}/${f}`).catch((err) => {
          // .redacted.json 等可选边车随归档存在性浮动：缺失即跳过（ENOENT），
          // 其余复制错误（EACCES 等）照常抛出——同步镜像必须与源一致。
          if (err && err.code === 'ENOENT') return;
          throw err;
        });
      }
    }
    await spawnRun([git, 'add', '-A'], syncDir, signal);
    const status = await spawnRun([git, 'status', '--porcelain'], syncDir, signal);
    if (!status.out.trim()) return { skipped: '无变更', tooBig };

    const message = `backup ${new Date().toISOString()}`;
    await spawnRun([git, '-c', 'user.name=dsh-backup', '-c', 'user.email=dsh-backup@users.noreply.github.com', 'commit', '-m', message], syncDir, signal);
    await spawnRun([git, 'push', 'origin', 'HEAD:main', '--force-with-lease'], syncDir, signal);
    return { pushed: true, at: new Date().toISOString(), tooBig };
  }

  function summarizeSync(s) {
    if (s.error) return `⚠️ GitHub 同步失败: ${s.error}`;
    if (s.pushed) return `✅ GitHub 同步完成: ${s.at}${s.tooBig?.length ? `\n跳过超大文件: ${s.tooBig.join(', ')}` : ''}`;
    return `GitHub 同步: ${s.skipped || '无变更'}${s.tooBig?.length ? `\n跳过超大文件: ${s.tooBig.join(', ')}` : ''}`;
  }

  /**
   * 从 GitHub 同步仓库拉取备份集到本地备份目录（新机恢复的第一步）：
   * fetch + reset --hard origin/main 对齐远端，然后把本地缺失的归档与
   * 边车从工作树拷回备份目录。仅拉取，不自动恢复——覆盖式恢复必须经
   * restore 的校验/预览/快照链，由用户显式发起。
   * 拉回的归档先做 sha256 校验（边车随仓库走），损坏即报且不落列表。
   */
  async function githubPull(signal) {
    const { root, home } = paths();
    const wt = await ensureSyncWorktree(signal);
    if (wt.reason) throw new Error(wt.reason);
    const { syncDir, git } = wt;
    await spawnRun([git, 'fetch', 'origin', 'main'], syncDir, signal);
    await spawnRun([git, 'reset', '--hard', 'origin/main'], syncDir, signal);

    let entries = [];
    try {
      entries = await readdir(syncDir, { withFileTypes: true });
    } catch {
      entries = [];
    }
    const wanted = entries
      .filter((e) => e.isFile() && /^dsh-[A-Za-z0-9._-]+\.tar\.gz$/.test(e.name))
      .map((e) => e.name);
    const pulled = [];
    const corrupt = [];
    for (const name of wanted) {
      const exists = await fsStat(`${root}/${name}`).then(() => true, () => false);
      if (exists) continue;
      // 先拷到临时名，sha256 校验通过再转正：损坏归档绝不进备份列表
      const staging = `${root}/.pull-${name}`;
      await copyFile(`${syncDir}/${name}`, staging);
      let shaOk = false;
      try {
        const text = await readFile(`${syncDir}/${name}.sha256`, 'utf8');
        const expected = text.trim().split(/\s+/)[0];
        const actual = await sha256File(staging, home, signal);
        shaOk = /^[0-9a-f]{64}$/.test(expected) && actual === expected;
      } catch {
        shaOk = false;
      }
      if (!shaOk) {
        await unlink(staging).catch(() => {});
        corrupt.push(name);
        continue;
      }
      await rename(staging, `${root}/${name}`);
      // 边车随归档转正（缺失的可选边车跳过）；.encrypted.json 一并带回来，
      // 否则加密归档拉回后无法解密（P3 补）。
      for (const side of [`${name}.sha256`, `${name}.meta.json`, `${name}.redacted.json`, `${name}.encrypted.json`]) {
        await copyFile(`${syncDir}/${side}`, `${root}/${side}`).catch((err) => {
          if (err && err.code === 'ENOENT') return;
          throw err;
        });
      }
      pulled.push(name);
    }
    return { pulled, corrupt, total: wanted.length };
  }

  // ---------- 多通道同步（WebDAV / S3 兼容 / GitHub Gist，P3） ----------
  // 与现有 GitHub 同步并列：每通道独立配置，持久化到备份目录根 sync.json（0600），
  // 凭据（password/secretKey/token）只存本机、不进归档、不进日志、状态回显一律脱敏。
  // 同步产物与 GitHub 一致：全量归档 + .sha256 + .meta.json + .redacted.json +
  // .encrypted.json 的可移植集合。webdav/s3/gist 本轮只做**推送**（pull 仍走 GitHub）。
  let syncChannels = {};
  const SYNC_CHANNEL_TYPES = new Set(['webdav', 's3', 'gist']);

  /** 校验并归一化通道配置；非法返回原因，合法返回归一化对象。 */
  function normalizeSyncChannel(channel, config) {
    if (!SYNC_CHANNEL_TYPES.has(channel)) return { error: `不支持的通道类型 ${channel}（支持 webdav/s3/gist）` };
    const c = config && typeof config === 'object' ? config : {};
    if (channel === 'webdav') {
      const url = typeof c.url === 'string' ? c.url.trim() : '';
      if (!/^https?:\/\//i.test(url)) return { error: 'WebDAV 需要 http(s):// 开头的 url' };
      return { value: { type: 'webdav', url, username: typeof c.username === 'string' ? c.username : '', password: typeof c.password === 'string' ? c.password : '' } };
    }
    if (channel === 's3') {
      const endpoint = typeof c.endpoint === 'string' ? c.endpoint.trim() : '';
      if (!/^https?:\/\//i.test(endpoint)) return { error: 'S3 需要 http(s):// 开头的 endpoint' };
      const region = typeof c.region === 'string' && c.region.trim() ? c.region.trim() : 'us-east-1';
      const bucket = typeof c.bucket === 'string' ? c.bucket.trim() : '';
      if (!bucket) return { error: 'S3 需要 bucket 名' };
      const accessKey = typeof c.accessKey === 'string' ? c.accessKey.trim() : '';
      const secretKey = typeof c.secretKey === 'string' ? c.secretKey : '';
      if (!accessKey || !secretKey) return { error: 'S3 需要 accessKey 与 secretKey' };
      return { value: { type: 's3', endpoint, region, bucket, accessKey, secretKey, pathPrefix: typeof c.pathPrefix === 'string' ? c.pathPrefix.replace(/^\/+|\/+$/g, '') : '', pathStyle: c.pathStyle !== false } };
    }
    if (channel === 'gist') {
      const token = typeof c.token === 'string' ? c.token.trim() : '';
      if (!/^[A-Za-z0-9_-]{20,255}$/.test(token)) return { error: 'Gist 需要合法 GitHub token（ghp_…/github_pat_…/经典 40 位）' };
      return { value: { type: 'gist', token, gistId: typeof c.gistId === 'string' ? c.gistId.trim() : '' } };
    }
    return { error: `不支持的通道类型 ${channel}` };
  }

  /** 状态回显用脱敏视图：凭据只给「已配置/未配置」，绝不含明文。 */
  function redactSyncChannel(channel, ch) {
    if (!ch) return { channel, type: channel, configured: false };
    const out = { channel, type: ch.type, configured: true, lastPush: ch.lastPush ?? null, lastError: ch.lastError ?? null };
    if (ch.type === 'webdav') { out.url = ch.url; out.username = ch.username; out.passwordSet = Boolean(ch.password); }
    if (ch.type === 's3') { out.endpoint = ch.endpoint; out.region = ch.region; out.bucket = ch.bucket; out.pathPrefix = ch.pathPrefix || ''; out.accessKey = ch.accessKey; out.secretKeySet = Boolean(ch.secretKey); out.pathStyle = ch.pathStyle !== false; }
    if (ch.type === 'gist') { out.gistId = ch.gistId || ''; out.tokenSet = Boolean(ch.token); }
    return out;
  }

  async function loadSyncChannels() {
    const { root } = paths();
    try {
      const parsed = JSON.parse(await readFile(`${root}/${SYNC_CONFIG_FILE}`, 'utf8'));
      const disk = parsed && typeof parsed === 'object' ? parsed : {};
      // 合并而非整对象覆盖：boot 钩子加载若与面板 setSyncChannel 并发，后者可能
      // 已先把某通道写进内存并落盘，此处整对象覆盖会把刚 set 的通道清成空（真实
      // 竞态）。只填充内存里还没有的通道；已有通道一律保留。显式 set/remove 才落盘。
      for (const [k, v] of Object.entries(disk)) {
        if (!(k in syncChannels)) syncChannels[k] = v;
      }
    } catch (err) {
      // ENOENT（首次使用）或读失败都保持内存现状，不覆盖——宁可少回填一次，
      // 也不把并发写入的内存态清掉。
      if (err && err.code !== 'ENOENT') console.warn(`[dsh-backup] 同步通道配置读取失败（不影响备份）: ${String(err && err.message ? err.message : err)}`);
    }
    return syncChannels;
  }

  async function saveSyncChannels() {
    const { root } = paths();
    await mkdir(root, { recursive: true });
    const target = `${root}/${SYNC_CONFIG_FILE}`;
    const tmp = `${target}.${randomUUID()}.tmp`;
    try {
      await writeOwned(tmp, `${JSON.stringify(syncChannels)}\n`);
      await rename(tmp, target);
    } catch (err) {
      await rm(tmp, { force: true }).catch(() => {});
      throw err;
    }
    if (!IS_WIN) await chmod(target, 0o600).catch(() => {});
  }

  /** 全部通道（含 github）的脱敏状态视图。 */
  async function listSyncChannels() {
    const cfg = githubConfig();
    return {
      github: { channel: 'github', type: 'github', configured: Boolean(cfg), repo: cfg ? cfg.repo : null, tokenSet: hasGithubToken(), lastPush: githubState.lastPush, lastError: githubState.lastError },
      webdav: redactSyncChannel('webdav', syncChannels.webdav),
      s3: redactSyncChannel('s3', syncChannels.s3),
      gist: redactSyncChannel('gist', syncChannels.gist),
    };
  }

  async function setSyncChannel(channel, config) {
    const n = normalizeSyncChannel(channel, config);
    if (n.error) return { ok: false, summary: n.error };
    syncChannels[channel] = { ...n.value, lastPush: syncChannels[channel]?.lastPush ?? null, lastError: null };
    await saveSyncChannels();
    return { ok: true, summary: `${channel} 同步通道已保存（凭据仅存本机备份目录 0600，不进归档不进日志）`, channel: redactSyncChannel(channel, syncChannels[channel]) };
  }

  async function removeSyncChannel(channel) {
    delete syncChannels[channel];
    await saveSyncChannels();
    return { ok: true, summary: `${channel} 同步通道已清除` };
  }

  /** 组装同步文件清单（全量归档 + 边车），返回已存在的文件绝对路径列表。 */
  async function syncFileSet() {
    const { root } = paths();
    const out = [];
    for (const b of await listBackups()) {
      for (const f of sidecarsFor(b.name)) {
        if (await existsStat(`${root}/${f}`)) out.push(f);
      }
    }
    return out;
  }

  /**
   * 推送到指定通道。github 复用现有 githubSync（含拉取语义）；webdav/s3/gist
   * 走 lib/sync-channels.js 的传输层，只推送。返回 { pushed, count, at, tooBig,
   * error?, skipped?, gistUrl? }，凭据绝不进返回。
   */
  async function syncNow(channel, signal) {
    if (channel === 'github') return githubSync(signal);
    const ch = syncChannels[channel];
    if (!ch) return { error: `未配置同步通道 ${channel}（/backup sync ${channel} set … 或面板配置）` };
    const { root } = paths();
    const set = await syncFileSet();
    const tooBig = [];
    const max = ch.type === 'gist' ? GIST_MAX_BYTES : SYNC_MAX_BYTES;
    const at = new Date().toISOString();
    try {
      if (ch.type === 'webdav' || ch.type === 's3') {
        let count = 0;
        for (const f of set) {
          if (signal?.aborted) throw new Error('操作已取消');
          const p = `${root}/${f}`;
          const st = await fsStat(p).then((s) => s, () => null);
          if (!st) continue;
          if (st.size > max) { tooBig.push(f); continue; }
          const body = await readFile(p);
          if (ch.type === 'webdav') {
            await webdavPut({ url: ch.url, username: ch.username, password: ch.password, key: f, body, signal });
          } else {
            const key = [ch.pathPrefix, f].filter(Boolean).join('/');
            await s3Put({ endpoint: ch.endpoint, region: ch.region, bucket: ch.bucket, key, body, accessKey: ch.accessKey, secretKey: ch.secretKey, pathStyle: ch.pathStyle !== false, signal });
          }
          count += 1;
        }
        syncChannels[channel] = { ...ch, lastPush: at, lastError: null };
        await saveSyncChannels();
        return { pushed: count > 0, count, at, tooBig };
      }
      if (ch.type === 'gist') {
        const files = {};
        for (const f of set) {
          if (signal?.aborted) throw new Error('操作已取消');
          const p = `${root}/${f}`;
          const st = await fsStat(p).then((s) => s, () => null);
          if (!st) continue;
          if (st.size > max) { tooBig.push(f); continue; }
          const buf = await readFile(p);
          files[f] = { content: gistContent(buf, { binary: f.endsWith('.tar.gz') }) };
        }
        const g = await gistSync({ token: ch.token, gistId: ch.gistId || null, files, description: 'dsh-backup sync', signal });
        if (g.gistId && g.gistId !== ch.gistId) {
          syncChannels[channel] = { ...ch, gistId: g.gistId, lastPush: at, lastError: null };
          await saveSyncChannels();
        } else {
          syncChannels[channel] = { ...ch, lastPush: at, lastError: null };
          await saveSyncChannels();
        }
        return { pushed: Object.keys(files).length > 0, count: Object.keys(files).length, at, tooBig, gistUrl: g.htmlUrl };
      }
      return { error: `未知通道类型 ${ch.type}` };
    } catch (err) {
      const message = String(err && err.message ? err.message : err);
      syncChannels[channel] = { ...ch, lastError: message };
      await saveSyncChannels().catch(() => {});
      return { error: message };
    }
  }

  // ---------- Web 下载路由（仅 loopback，附件形式） ----------
  async function handleDownload(req, res) {
    try {
      const host = String(req.headers?.host || '');
      if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host)) {
        res.writeHead(403);
        res.end('forbidden');
        return;
      }
      const pathname = new URL(req.url || '', 'http://x').pathname;
      const name = decodeURIComponent(pathname.slice(DOWNLOAD_PREFIX.length).replace(/^\//, ''));
      const isTarGz = /^dsh-[A-Za-z0-9._-]+\.tar\.gz$/.test(name);
      const isZip = /^dsh-config-[A-Za-z0-9._-]+\.zip$/.test(name);
      if (!isTarGz && !isZip) {
        res.writeHead(400);
        res.end('bad name');
        return;
      }
      const { root } = paths();
      const abs = `${root}/${name}`;
      await fsStat(abs);
      res.writeHead(200, {
        'Content-Type': isZip ? 'application/zip' : 'application/gzip',
        'Content-Disposition': `attachment; filename="${name}"`,
      });
      createReadStream(abs).on('error', () => { res.destroy(); }).pipe(res);
    } catch {
      // 任何读取/解析失败按 404 处理（下载是尽力而为的附件通道）
      if (!res.headersSent) res.writeHead(404);
      res.end();
    }
  }

  // ---------- 校验与恢复 ----------
  /**
   * 判断归档是否加密：优先看 .encrypted.json 边车（实际密文参数所在），
   * 再回退 meta.encrypted（老边车缺位但 meta 有标记时的兜底）。只增不改：
   * 边车存在即加密，不存在则不是——不把 meta 与边车不一致当作可恢复状态。
   */
  async function isArchiveEncrypted(archiveName) {
    const { root } = paths();
    if (await existsStat(`${root}/${archiveName}.encrypted.json`)) return true;
    try {
      const meta = JSON.parse(await readFile(`${root}/${archiveName}.meta.json`, 'utf8'));
      // 用真值判定而非严格 === true：未来若 meta.encrypted 升级为版本号（如 2），
      // 真值仍会把归档判为「加密」，交给 decryptBuffer 的版本门安全拒绝，而不是
      // 静默当明文 tar 去啃密文。false/缺省仍判未加密。
      return Boolean(meta && meta.encrypted);
    } catch {
      return false;
    }
  }

  /**
   * 把加密归档解密成备份目录内的一份临时 tar.gz，返回 { name, cleanup }。
   * 临时文件用相对名（cwd=备份目录），规避 Windows GNU tar 盘符冒号问题；
   * 解密失败（口令错/边车坏）抛人话报错，调用方直接展示。
   */
  async function decryptArchiveFile(archiveName, password, signal) {
    const { root } = paths();
    if (signal?.aborted) throw new Error('操作已取消');
    if (typeof password !== 'string' || !password) {
      throw new Error('这份备份已加密，恢复需要口令（口令只经面板 RPC 传入、内存态，命令行暂不支持输入口令）');
    }
    let sidecar;
    try {
      sidecar = JSON.parse(await readFile(`${root}/${archiveName}.encrypted.json`, 'utf8'));
    } catch (err) {
      // meta.encrypted 标记了加密但边车缺失：这是不一致状态，拒绝而非猜着解
      throw new Error(`加密边车（.encrypted.json）缺失或损坏，无法解密——请核对备份是否完整（技术细节: ${snippet(String(err && err.message ? err.message : err), 80)}）`);
    }
    const tmpName = `.decrypt-${stampNow()}.tar.gz`;
    // 直接流式解密到目标临时文件：大归档不整包入内存，认证失败时不留半截明文。
    await decryptFile(`${root}/${archiveName}`, `${root}/${tmpName}`, sidecar, password);
    // 隐藏名 `.decrypt-<时间戳>.tar.gz`：listBackups 要求 `dsh-` 前缀，隐藏点开头
    // 的临时文件绝不进用户列表/轮换；位于备份目录内、相对名传 tar，规避 Windows
    // GNU tar 盘符冒号问题。finally 里必清理（明文 tar.gz 不能遗留）。
    return { name: tmpName, cleanup: () => rm(`${root}/${tmpName}`, { force: true }) };
  }

  async function verifyOne(name, home, signal) {
    const { root } = paths();
    const archive = `${root}/${name}`;
    let expected = '';
    try {
      const text = await readFile(`${archive}.sha256`, 'utf8');
      expected = text.trim().split(/\s+/)[0];
    } catch {
      // 边车缺失
    }
    const encrypted = await isArchiveEncrypted(name);
    if (!/^[0-9a-f]{64}$/.test(expected)) {
      return { name, ok: false, encrypted, note: '缺少或无效的配套校验文件（.sha256）——无法确认这份备份是否完好' };
    }
    const actual = await sha256File(archive, home, signal);
    return {
      name,
      ok: actual === expected,
      encrypted,
      // 加密归档的 sha256 是密文的：完整性校验无需口令，口令只影响恢复时的解密。
      note: actual === expected ? (encrypted ? '完整（🔒 加密归档：完整性校验无需口令）' : '完整') : '校验和不匹配（归档或校验文件之一可能损坏）',
    };
  }

  async function pickArchive(selector) {
    const all = await listBackups();
    // 无全量归档时不能早退「暂无备份」——跨机首恢复现场正是只有分类型归档
    // （#126：新机从另一台机器只拷来一份 dsh-t- 归档，全量列表为空）。下面
    // 的显式名/前缀分支会把分类型归档一并纳入候选；仅在候选全空时才报错。
    const wantsLatest = !selector || selector === 'latest';
    if (!all.length && wantsLatest) {
      const typedLatest = await listTypedBackups();
      if (typedLatest.length) throw new Error('本机只有分类型归档（dsh-t- 前缀），没有全量归档可用 latest 选中——请用完整归档名或前缀，并带 --types');
      throw new Error('暂无备份');
    }
    if (wantsLatest) return all[0];
    const exact = all.filter((b) => b.name === selector);
    const hits = exact.length ? exact : all.filter((b) => b.name.startsWith(selector));
    if (hits.length === 1) return hits[0];
    if (!hits.length) {
      // 显式前缀可命中内部快照（升级前/恢复前）——latest 永不落入此分支
      const snaps = await listSnapshotNames('dsh-pre-');
      const sExact = snaps.filter((n) => n === selector);
      const sHits = sExact.length ? sExact : snaps.filter((n) => n.startsWith(selector));
      if (sHits.length === 1) return { name: sHits[0], size: undefined };
      if (sHits.length > 1) {
        throw new Error(`"${selector}" 匹配多份快照，请加长前缀：\n${sHits.slice(0, 5).map((n) => `  ${n}`).join('\n')}`);
      }
      // 分类型归档不在全量列表（旧版视角不可见），显式名/前缀可在此命中
      const typed = await listTypedBackups();
      const tExact = typed.filter((b) => b.name === selector);
      const tHits = tExact.length ? tExact : typed.filter((b) => b.name.startsWith(selector));
      if (tHits.length === 1) return tHits[0];
      if (tHits.length > 1) {
        throw new Error(`"${selector}" 匹配多份分类型归档，请加长前缀：\n${tHits.slice(0, 5).map((n) => `  ${n.name}`).join('\n')}`);
      }
      throw new Error(`没有匹配 "${selector}" 的备份，/backup list 查看`);
    }
    throw new Error(`"${selector}" 匹配多份备份，请加长前缀：\n${hits.slice(0, 5).map((b) => `  ${b.name}`).join('\n')}`);
  }

  /** 删除指定备份（归档 + 全部边车）；选择器经 pickArchive 精确匹配，杜绝路径穿越。 */
  async function removeBackup(selector, signal) {
    const { root } = paths();
    let picked;
    try {
      picked = await pickArchive(selector);
    } catch (err) {
      // 分类型归档不在 listBackups（全量视角不可见），删除时按 dsh-t- 名单单独匹配
      const typed = await listTypedBackups();
      const exact = typed.filter((b) => b.name === selector);
      const hits = exact.length ? exact : typed.filter((b) => b.name.startsWith(selector));
      if (hits.length !== 1) throw err;
      picked = hits[0];
    }
    await removeFiles(sidecarsFor(picked.name), root, signal);
    return { ok: true, name: picked.name, summary: `已删除备份: ${picked.name}` };
  }

  /**
   * 解析 `tar -tvzf` 单行输出，返回 { type, name }；布局不匹配返回 null。
   * 兼容三种 verbose 布局（locale 无关锚定，不依赖英文月份缩写）：
   * 1. GNU tar：mode owner size YYYY-MM-DD 时间|年份 name——以 YYYY-MM-DD
   *    字段为锚，name 起点 = 该字段 + 2（跳过 date 与 time/年份）。
   * 2. bsdtar：mode uid gid size 月 日 时间 name（中文 locale 月份形如
   *    `8月`，英文 `Aug`）——以最后一个 HH:MM 字段为锚，name 起点 = 其后 1。
   * 3. bsdtar 跨年条目无时间字段（月 日 年份）——以最后一个 4 位数字为锚
   *    （年份；size 恰为 4 位数字时年份更靠右仍正确），name 起点 = 其后 1。
   * name 保留含空格路径并去掉目录尾部的斜杠。
   * 已知边界：POSIX 文件名恰为 HH:MM 形态（如 `12:30`）会被误取为时间锚
   * （Windows 文件名禁 `:`，故 Windows 不受影响）——极端误取，保守接受。
   */
  function parseTarEntry(line) {
    const f = line.trim().split(/\s+/);
    if (f.length < 6) return null;
    let nameIdx = -1;
    for (let i = 1; i < f.length; i++) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(f[i])) {
        nameIdx = i + 2;
        break;
      }
    }
    if (nameIdx < 0) {
      for (let i = f.length - 1; i >= 1; i--) {
        if (/^\d{1,2}:\d{2}$/.test(f[i])) {
          nameIdx = i + 1;
          break;
        }
      }
    }
    if (nameIdx < 0) {
      for (let i = f.length - 1; i >= 1; i--) {
        if (/^\d{4}$/.test(f[i])) {
          nameIdx = i + 1;
          break;
        }
      }
    }
    if (nameIdx < 0 || nameIdx >= f.length) return null;
    const rest = f.slice(nameIdx).join(' ');
    // tar -tv 的链接形态：硬链接 `<名> link to <目标>`、符号链接 `<名> -> <目标>`。
    // 必须把目标摘出来单独校验：旧实现把它并进 name，于是硬链接条目的"名字"
    // 天然含空格与目标路径，必然被判非法而整体拒绝（#112），错误信息里也把
    // 目标一起印出来。
    let name = rest;
    let link = null;
    const hardAt = rest.indexOf(' link to ');
    if (hardAt >= 0) {
      name = rest.slice(0, hardAt);
      link = rest.slice(hardAt + ' link to '.length);
    } else {
      const symAt = rest.lastIndexOf(' -> ');
      if (symAt >= 0) {
        name = rest.slice(0, symAt);
        link = rest.slice(symAt + 4);
      }
    }
    return {
      type: f[0][0],
      name: name.replace(/\/$/, ''),
      link: link === null ? null : link.replace(/\/$/, ''),
    };
  }

  /**
   * 读取归档的机器元数据 / 脱敏清单边车，构造恢复预检信息（边车缺失的
   * v0.6.x 老归档返回 redacted=null、host=null，预检静默降级）。
   */
  async function readArchiveMeta(archiveName) {
    const { root } = paths();
    let meta = null;
    let redactedFiles = null;
    try {
      meta = JSON.parse(await readFile(`${root}/${archiveName}.meta.json`, 'utf8'));
    } catch {
      // 老归档无 meta 边车
    }
    try {
      redactedFiles = JSON.parse(await readFile(`${root}/${archiveName}.redacted.json`, 'utf8'))?.files ?? [];
    } catch {
      // 未脱敏（或老归档）无清单
    }
    return { meta, redactedFiles };
  }

  /**
   * 恢复预检：跨机（home 与备份机器不一致）绝对路径提示 + 脱敏归档的
   * vault 可还原性 + 随归档恢复的 profile 依赖（node_modules 被排除，
   * 恢复后需重装）。返回人类可读的提示行数组（无提示返回空）。
   */
  function preflightLines(preflight, profileDirs) {
    const lines = [];
    if (preflight.homeChanged) {
      lines.push(`⚠️ 备份来自另一台机器/用户目录（${preflight.sourceHost ?? '未知主机'}，${preflight.sourceHome}），settings 内的绝对路径可能需要调整`);
    }
    if (Array.isArray(preflight.redactedFiles)) {
      // 0 个凭据文件时"已脱敏"是噪音且误导（让人以为有东西被隐去）——如实说明即可
      lines.push(preflight.redactedFiles.length
        ? `🔐 该归档已脱敏：${preflight.redactedFiles.length} 个凭据文件不随归档走，恢复时从本机 vault 还原（跨机恢复需重填）`
        : '🔐 归档不含凭据文件；本机凭据不受恢复影响');
    }
    if (preflight.legacyUnaccountedCredentials) {
      lines.push('⚠️ 归档未携带脱敏清单（v0.6.x 时代格式）且不含凭据文件——恢复后凭据需从本机 vault 或原机器补齐');
    }
    if (Array.isArray(preflight.quarantinedFiles) && preflight.quarantinedFiles.length) {
      lines.push(`⚠️ 备份时体检隔离了 ${preflight.quarantinedFiles.length} 个损坏会话文件（未入档）——这些会话恢复后缺失，可用 /backup doctor --repair 从更早归档修复`);
    }
    if (profileDirs.length) {
      lines.push(`📦 归档含 ${profileDirs.length} 个 profile 的依赖声明（node_modules 不随归档），恢复后用 --sync-deps 或手动 pnpm install 重装插件`);
    }
    return lines;
  }

  /**
   * 列出归档全部条目并做安全校验（restoreArchive 与 doctorRepair 共用）：
   * cwd 为备份目录、-f 用纯文件名（规避 Windows GNU tar 盘符冒号问题），
   * 逐行解析 -tvzf 输出并拒绝备份根之外的任何条目——含不安全条目直接抛错。
   */
  async function safeArchiveEntries(pickedName, signal) {
    const { root, dshHome } = paths();
    const base = dshHome.split('/').pop();
    const tar = await ctx.subprocess.resolveExecutable('tar');
    // 清单流式读取（#119）：不用有界收集——大归档的清单超过 spill 上限时会被截断，
    // 碎片会被误判成"不安全条目"而拒绝整包（详见 streamListingLines 注释）。
    const entries = [];
    const bad = [];
    // 路径检查（反斜杠归一化后再判）：`.dsh/..\..\escape.txt` 与 `/` 分隔的
    // `..` 段同样拒绝（Windows 风格路径变体）。
    const insideBase = (p) => Boolean(p)
      && !p.startsWith('/') && !/^[A-Za-z]:/.test(p)
      && !p.split('/').includes('..')
      && (p === base || p.startsWith(`${base}/`));
    const onLine = (line) => {
      const s = line.trim();
      if (!s) return true;
      const parsed = parseTarEntry(s);
      const name = parsed ? parsed.name.replace(/\\/g, '/').replace(/\/$/, '') : null;
      const link = parsed && parsed.link ? parsed.link.replace(/\\/g, '/').replace(/\/$/, '') : null;
      // 允许的类型：普通文件 '-'、目录 'd'，以及**目标也在备份根内**的硬链接 'h'。
      // 硬链接是 DSH 附件库（attachments/v1：files/ 与 file-objects/ 同一 inode）的
      // 正常形态，tar 会把第二个路径写成 'h' 条目——旧实现只放行 -/d，于是**带附件的
      // 归档一律被判"不安全条目"整体拒绝**，完整恢复/dry-run/分类型合并/doctor 修复/
      // 救援台全链路失效（#112）。硬链接不能跨文件系统、也不能指向目录，目标同为
      // 归档内相对路径时解压不会逃出备份根；符号链接（l）、设备等仍一律拒绝。
      const plainOk = Boolean(parsed) && Boolean(name) && (parsed.type === '-' || parsed.type === 'd') && insideBase(name);
      const hardOk = Boolean(parsed) && parsed.type === 'h' && insideBase(name) && insideBase(link);
      if (!plainOk && !hardOk) {
        bad.push(parsed ? name : s);
      } else {
        entries.push(name);
      }
      return bad.length === 0; // 发现违规立即停读并终止 tar，不必读完
    };
    const listed = await streamListingLines([tar, '-tvzf', pickedName], root, signal, onLine);
    if (bad.length) {
      throw new Error(`归档包含不安全条目（拒绝恢复）：${bad.slice(0, 3).join(', ')}（已读清单 ${listed.lines} 行 / ${listed.bytes} 字节），恢复已中止`);
    }
    return entries;
  }

  async function restoreArchive(selector, dryRun, signal, opts = {}) {
    return withOperationLock('restore', () => restoreArchiveInner(selector, dryRun, signal, opts));
  }

  async function restoreArchiveInner(selector, dryRun, signal, opts = {}) {
    const { home, dshHome, root } = paths();
    const picked = await pickArchive(selector);
    const archive = `${root}/${picked.name}`;

    // 恢复前强制校验：损坏的归档绝不覆盖现有数据。
    const v = await verifyOne(picked.name, home, signal);
    if (!v.ok) throw new Error(`校验未通过（${v.note}），恢复已中止`);

    // 加密归档：先解密到备份目录内临时 tar.gz（隐藏名 .decrypt-*，不进列表/轮换），
    // 后续 tar 全部针对明文临时文件；口令只经 opts.password（面板 RPC 内存态）传入，
    // 绝不落盘。finally 必清临时文件——它是明文 tar.gz，遗留会绕过加密边界。
    const encrypted = await isArchiveEncrypted(picked.name);
    let workName = picked.name;
    let cleanupArchive = null;
    if (encrypted) {
      const dec = await decryptArchiveFile(picked.name, opts?.password, signal);
      workName = dec.name;
      cleanupArchive = dec.cleanup;
    }
    try {
      return await restoreArchiveFromPlain(picked, workName, archive, dryRun, signal, opts, { home, dshHome, root });
    } finally {
      if (cleanupArchive) await cleanupArchive().catch(() => { /* 清理失败尽力而为 */ });
    }
  }

  async function restoreArchiveFromPlain(picked, workName, archive, dryRun, signal, opts, env) {
    const { home, dshHome, root } = env;
    const base = dshHome.split('/').pop();
    const parent = dshHome.slice(0, -(base.length + 1)) || '/';
    const entries = await safeArchiveEntries(workName, signal);

    // 预检（dry-run 与真实恢复共用）：跨机 home 对比 + 脱敏清单 + profile 依赖。
    const { meta, redactedFiles } = await readArchiveMeta(picked.name);
    const preflight = {
      homeChanged: Boolean(meta && typeof meta.home === 'string' && meta.home !== home),
      sourceHost: meta?.host ?? null,
      sourceHome: meta?.home ?? null,
      redactedFiles,
      quarantinedFiles: Array.isArray(meta?.quarantined) ? meta.quarantined : null,
      // 老归档无 .redacted.json：无法声明凭据保障。若归档里也没有任何敏感
      // 路径条目，恢复出的数据将缺凭据——如实提示，优于静默缺文件。
      legacyUnaccountedCredentials: !Array.isArray(redactedFiles)
        && sensitivePaths().length > 0
        && !entries.some((e) => sensitivePaths().some((rel) => e.endsWith(`/${rel}`))),
    };
    const profileDirs = [...new Set(entries
      .filter((n) => n.startsWith(`${base}/profiles/`) && n.endsWith('/package.json'))
      .map((n) => n.slice(`${base}/profiles/`.length).split('/')[0]))];

    // 现有数据探测：~/.dsh 已缺失（数据全失/新机首恢复）时没有可快照的
    // 内容，跳过快照与挪旁直接解压——先快照后判存在的旧序会让 tar 对不
    // 存在的 .dsh 报错，恢复在最需要的场景反而失败。ENOENT 视为首次恢
    // 复；其他 stat 失败（如 EACCES）中止恢复，不在不明状态下动现有数
    // 据。预览（dry-run）也据此切换「挪旁+快照」与「直接写入」两种口径。
    const targetExists = await fsStat(dshHome).then(
      () => true,
      (err) => {
        if (err && err.code === 'ENOENT') return false;
        throw err;
      },
    );

    // 安全拦截：分类型归档必须带 --types 走 merge。整包路径（挪旁+解压）会把
    // ~/.dsh 替换成子集内容，丢失未包含的类型数据——rescue 同语义拦截。
    if (!opts?.types && meta && Array.isArray(meta.types) && meta.types.length) {
      throw new Error(`${picked.name} 是分类型归档（${meta.types.join(', ')}）。整包恢复会丢失其他类型数据——请带 --types ${meta.types.join(',')} 分类型恢复，或选一份全量归档（dsh- 开头）整包恢复。`);
    }

    // 分类型恢复（merge）：只把选中类型的条目解压进现有 ~/.dsh，不挪旁整包。
    // 复用 doctorRepair 的"留档+子集解压+回滚"哲学——打破现有"绝不合并、整包
    // 覆盖"不变量，用留档兜底。凭据类归档已含明文，直接覆盖；非凭据类
    // mergeTargets 不含凭据文件，不碰 vault（不走下方的 vault 还原）。
    if (Array.isArray(opts?.types) && opts.types.length) {
      const mergeTargets = typeEntries(opts.types, entries, base);
      if (!mergeTargets.length) {
        throw new Error(`归档 ${picked.name} 里没有选中类型（${opts.types.join(', ')}）的条目`);
      }
      // 预检将覆盖的现有文件（留档依据）；目录条目 tar 解压时 mkdir 无覆盖
      // 风险，新增项也不算覆盖——只留档现有文件。
      const willOverwrite = [];
      for (const entry of mergeTargets) {
        const rel = entry.slice(`${base}/`.length);
        const st = await fsStat(`${dshHome}/${rel}`).then((s) => s, () => null);
        if (st && st.isFile()) willOverwrite.push({ entry, rel });
      }
      // 只解压文件条目：目录条目在 GNU tar 下递归消费内容会让显式成员报
      // "Not found in archive"（exit 2），在 bsdtar 下又不递归——传文件列表在
      // 两端行为一致（tar -x 文件成员自动补父目录；doctor 定点修复同模式）。
      const fileTargets = mergeTargets.filter((e) => !mergeTargets.some((o) => o.startsWith(`${e}/`)));
      if (dryRun) {
        return {
          archive, files: fileTargets.length, sample: fileTargets.slice(0, 24), aside: null, snapshotPath: null, dryRun: true,
          merge: true, types: opts.types, willOverwrite: willOverwrite.map((w) => w.rel),
          targetExists, preflight: preflightLines(preflight, profileDirs),
        };
      }
      // 留档将覆盖的现有文件（.pre-merge-<时间戳>），失败可逐个还原。
      const stamp = stampNow();
      const kept = [];
      for (const w of willOverwrite) {
        const keep = `${dshHome}/${w.rel}.pre-merge-${stamp}`;
        await mkdir(dirname(keep), { recursive: true });
        await copyFile(`${dshHome}/${w.rel}`, keep);
        kept.push({ ...w, keep });
      }
      try {
        const tar = await ctx.subprocess.resolveExecutable('tar');
        await spawnRun([tar, '-xzf', workName, '-C', parentTar(parent), ...fileTargets], root, signal);
      } catch (err) {
        // 对齐 #28 / doctorRepair 回滚：从留档还原每个被覆盖项；连还原都失败
        // 时把留档路径交代清楚，绝不静默停在半截状态。
        const reason = err && err.message ? err.message : String(err);
        const restored = new Set();
        for (const w of willOverwrite) {
          try { await copyFile(w.keep, `${dshHome}/${w.rel}`); restored.add(w.rel); } catch { /* 逐个失败落入下方报告 */ }
        }
        if (restored.size === willOverwrite.length) {
          throw new Error(`分类型恢复失败（${reason}）。已从留档还原全部覆盖现场，数据保持恢复前状态；排查后可重试`);
        }
        const missing = willOverwrite.filter((w) => !restored.has(w.rel)).map((w) => w.rel);
        throw new Error(`分类型恢复失败（${reason}），且部分现场未自动还原: ${missing.join(', ')}。对应的 *.pre-merge-${stamp} 留档仍在原目录旁，手工拷回即可`);
      }
      // 可选依赖重装：merge 含 profiles 时对新解出的 profile 跑 pnpm install。
      const deps = { installed: [], failed: [], note: null };
      if (opts?.syncDeps) {
        const mergedProfiles = [...new Set(mergeTargets
          .filter((n) => n.startsWith(`${base}/profiles/`) && n.endsWith('/package.json'))
          .map((n) => n.slice(`${base}/profiles/`.length).split('/')[0]))];
        if (mergedProfiles.length) {
          try {
            const pnpm = await ctx.subprocess.resolveExecutable('pnpm');
            // 单个 profile 装失败记入 failed 并继续（与全量恢复路径同语义）；
            // pnpm 本身缺失才落到外层 note。
            for (const p of mergedProfiles) {
              try {
                await spawnRun([pnpm, 'install', '--frozen-lockfile'], `${dshHome}/profiles/${p}`, signal);
                deps.installed.push(p);
              } catch {
                try {
                  await spawnRun([pnpm, 'install'], `${dshHome}/profiles/${p}`, signal);
                  deps.installed.push(p);
                } catch {
                  deps.failed.push(p);
                }
              }
            }
          } catch {
            deps.note = '未找到 pnpm，请在各 profile 目录手动执行 pnpm install';
          }
        }
      }
      return {
        archive, files: fileTargets.length, aside: null, snapshotPath: null, dryRun: false,
        merge: true, types: opts.types, restored: fileTargets.length,
        kept: kept.map((k) => k.keep), deps, preflight: preflightLines(preflight, profileDirs),
      };
    }

    if (dryRun) {
      return {
        archive, files: entries.length, sample: entries.slice(0, 12), aside: null, snapshotPath: null, dryRun: true,
        targetExists,
        preflight: preflightLines(preflight, profileDirs),
      };
    }

    // 恢复前自动快照当前数据，并把当前数据移到旁边（而非合并覆盖）。
    // 快照用 dsh-pre-restore- 前缀与用户常规备份区分，经 listBackups 过滤
    // 后不进列表/轮换/latest 选择；每次恢复清掉上一次的快照防累积。
    const snapshot = targetExists
      ? await doBackup(undefined, signal, { namePrefix: 'dsh-pre-restore-', skipVault: true, skipRotate: true })
      : null;
    if (snapshot) await prunePreRestoreSnapshots([snapshot.name, picked.name], signal);
    const asideName = `${base}.pre-restore-${stampNow()}`;
    let aside = null;
    if (targetExists) {
      await renameBeside(parent, base, asideName, signal);
      aside = `${parent}/${asideName}`;
    }
    try {
      const tar = await ctx.subprocess.resolveExecutable('tar');
      await spawnRun([tar, '-xzf', workName, '-C', parentTar(parent)], root, signal);
    } catch (err) {
      // 挪旁之后解压失败会让 .dsh 处于空位——这是恢复流程里用户最容易慌
      // 的时刻。尽力自动回滚：清掉半截解压产物、把原数据改回原名；连回滚
      // 都失败时，错误消息必须带上数据位置和手工还原方法，绝不抛裸异常。
      const reason = err && err.message ? err.message : String(err);
      let rolledBack = false;
      try {
        await rm(dshHome, { recursive: true, force: true });
        if (targetExists) await renameBeside(parent, asideName, base, signal);
        rolledBack = true;
      } catch {
        // 回滚失败：落入下方的人工指引分支，把位置交代清楚
      }
      if (rolledBack) {
        throw new Error(`解压归档失败：${friendlyReason(err)}。已自动还原到恢复前状态，数据未丢失，可处理后重试`);
      }
      throw new Error(aside
        ? `解压归档失败：${friendlyReason(err)}，且自动还原未成功。原数据完好保存在 ${aside}，把它改名回 "${dshHome}" 即可回到恢复前状态`
        : `解压归档失败：${friendlyReason(err)}，且清理未成功。半截解压产物在 ${dshHome}，删除后即可重试`);
    }

    // vault 还原：脱敏归档恢复出的 ~/.dsh 不含凭据文件，从本机 vault 拷回。
    // vault 为空（跨机首恢复）时逐项记入 missing，由调用方提示重填——凭据
    // 无法从归档恢复是脱敏设计的直接代价，明确告知优于静默缺文件。
    const vaultRestored = [];
    const vaultMissing = [];
    if (Array.isArray(redactedFiles) && redactedFiles.length) {
      const vaultDir = `${root}/${VAULT_DIR}`;
      for (const rel of redactedFiles) {
        const src = `${vaultDir}/${rel}`;
        const have = await fsStat(src).then(() => true, (err) => {
          if (err && err.code === 'ENOENT') return false;
          throw err;
        });
        if (!have) {
          vaultMissing.push(rel);
          continue;
        }
        const dst = `${dshHome}/${rel}`;
        await mkdir(dirname(dst), { recursive: true });
        await copyFile(src, dst);
        vaultRestored.push(rel);
      }
    }

    // 可选依赖重装：node_modules 不随归档，--sync-deps 对每个恢复出的 profile
    // 跑 pnpm install --frozen-lockfile（与 DSH 自身的装配套路一致）。pnpm
    // 不可用时降级为提示，不判恢复失败——配置与会话已经恢复到位。
    const deps = { installed: [], failed: [], note: null };
    if (opts?.syncDeps && profileDirs.length) {
      try {
        const pnpm = await ctx.subprocess.resolveExecutable('pnpm');
        for (const p of profileDirs) {
          try {
            await spawnRun([pnpm, 'install', '--frozen-lockfile'], `${dshHome}/profiles/${p}`, signal);
            deps.installed.push(p);
          } catch (err) {
            // lockfile 与声明漂移时 frozen 会失败：退回普通 install 再试一次
            try {
              await spawnRun([pnpm, 'install'], `${dshHome}/profiles/${p}`, signal);
              deps.installed.push(p);
            } catch (err2) {
              deps.failed.push(p);
            }
          }
        }
      } catch {
        deps.note = '未找到 pnpm，请在各 profile 目录手动执行 pnpm install';
      }
    }

    return {
      archive, files: entries.length, sample: [], aside, snapshotPath: snapshot ? snapshot.path : null, dryRun: false,
      preflight: preflightLines(preflight, profileDirs), vaultRestored, vaultMissing, deps, profiles: profileDirs,
    };
  }

  /** 恢复结果的人类可读汇总（命令、模型工具与面板共用）。 */
  function summarizeRestore(r) {
    if (r.merge) {
      const types = (r.types ?? []).join(', ');
      if (r.dryRun) {
        const over = r.willOverwrite ?? [];
        const shown = r.sample.length;
        const tail = r.files > shown ? `\n    … 共 ${r.files} 项` : '';
        const overLine = over.length
          ? `\n  其中覆盖现有 ${over.length} 个（先留档 .pre-merge-*）: ${over.slice(0, 8).join(', ')}${over.length > 8 ? ' …' : ''}`
          : '\n  均为新增，不覆盖现有文件';
        return `📦 分类型恢复预览 —— 只预览，还没动磁盘\n  归档: ${r.archive}\n  类型: ${types}\n  将写入: ${r.files} 项${overLine}\n${(r.preflight ?? []).map((l) => `  ${l}`).join('\n')}\n\n  将写入的条目：\n${r.sample.map((s) => `    ${s}`).join('\n')}${tail}`;
      }
      const lines = [
        '✅ 分类型恢复完成',
        `  已合并写入: ${r.restored} 项 ← 来自 ${r.archive.split('/').pop()}（类型: ${types}）`,
      ];
      if (r.kept?.length) lines.push(`  覆盖的旧文件已留档: ${r.kept.length} 个（.pre-merge-*，确认后可自行删除）`);
      for (const p of r.preflight ?? []) if (p.startsWith('⚠️')) lines.push(`  ${p}`);
      if (r.deps?.note) lines.push(`  插件依赖: ${r.deps.note}`);
      else if (r.deps?.installed?.length) lines.push(`  插件依赖: 已装好 ${r.deps.installed.join(', ')}`);
      lines.push('  ⏸️ 待办: 重启 dsh 让恢复的类型内容生效');
      return lines.join('\n');
    }
    if (r.dryRun) {
      // 预览要回答两件事：确认后会发生什么（按目标是否已有数据切换口径）、
      // 凭据/依赖的 preflight 提醒。此时还没动任何文件，标题必须说清。
      const moves = r.targetExists === false
        ? ['   · 目标位置还没有 .dsh（首次恢复）：直接写入，不做挪动和快照']
        : [
          '   · 当前的 .dsh 整个挪到一旁，改名为 .dsh.pre-restore-<时间>，不会和新数据混在一起',
          '   · 挪之前自动做一份快照备份（恢复前快照只保留最近一次）',
          '   · 然后把这份归档的内容原样写回 .dsh',
        ];
      const pre = ['', ...moves, ...(r.preflight ?? []).map((l) => `  ${l}`)].join('\n');
      const shown = r.sample.length;
      const tail = r.files > shown ? `\n    … 共 ${r.files} 项` : '';
      return `📦 恢复预览 —— 只是预览，还没动你磁盘上的任何文件\n  归档: ${r.archive}\n  将写入: ${r.files} 项${pre}\n\n  将写入的文件：\n${r.sample.map((s) => `    ${s}`).join('\n')}${tail}`;
    }
    // 回执按「发生了什么 / 数据在哪 / 接下来做什么」组织；preflight 里只有
    // 跨机路径提醒在恢复后仍然成立（🔐📦 两行会被下面的实际结果取代）。
    const lines = [
      '✅ 恢复完成',
      `  已替换: .dsh 全部内容 ← 来自 ${r.archive.split('/').pop()}（${r.files} 项）`,
    ];
    if (r.aside) lines.push(`  旧数据没丢: 在 ${r.aside}（确认一切正常后可自行删除）`);
    if (r.snapshotPath) lines.push(`  保险快照: ${r.snapshotPath.split('/').pop()}（在备份目录内，只保留最近一次）`);
    for (const p of r.preflight ?? []) {
      if (p.startsWith('⚠️')) lines.push(`  ${p}`);
    }
    if (r.vaultRestored?.length) lines.push(`  凭据: 已从本机 vault 补回 ${r.vaultRestored.length} 个`);
    if (r.vaultMissing?.length) lines.push(`  ⚠️ 凭据缺失需手动重填: ${r.vaultMissing.join(', ')}`);
    const installed = r.deps?.installed ?? [];
    const failed = r.deps?.failed ?? [];
    // 待办必须只有一条且顺序正确：node_modules 不随归档，先重装依赖再重启，
    // 照"直接重启"执行会得到 cannot resolve profile bundle（UX 审查 P1-2）。
    const depsPending = Boolean(r.deps?.note) || failed.length > 0 || (!installed.length && r.profiles?.length);
    if (r.deps?.note) {
      lines.push(`  插件依赖: 还没装 —— ${r.deps.note}；之后也可用 --sync-deps 补装`);
    } else if (failed.length) {
      lines.push(`  ⚠️ 插件依赖安装失败: ${failed.join(', ')}（进对应 profile 目录手动 pnpm install）${installed.length ? `；已装: ${installed.join(', ')}` : ''}`);
    } else if (installed.length) {
      lines.push(`  插件依赖: 已装好 ${installed.join(', ')}`);
    } else if (r.profiles?.length) {
      lines.push('  插件依赖: 还没装');
    }
    lines.push(depsPending
      ? '  ⏸️ 待办: 先重装插件依赖（重开 dsh 前进各 profile 目录跑 pnpm install），再重启 dsh——顺序不能反，否则起不来'
      : '  ⏸️ 待办: 重启 dsh，会话和配置才会切换到恢复的内容');
    return lines.join('\n');
  }

  // ---------- 导出 / 导入（P2 宿主半边） ----------
  //
  // 导出：把 ~/.dsh 打包成单文件 ZIP（零依赖 STORE），节段化（settings/ui/providers/
  // plugins/mcp/skills/prompts/workspaces/sessions/credentials + other 兜底）。凭据节段
  // 默认脱敏（不进 ZIP），仅 includeCredentials + 口令加密才入包。可选加密复用
  // lib/encrypt.js（scrypt + AES-256-GCM），密文覆盖 ZIP 本体、参数进 `<zip>.encrypted.json`
  // 边车。导出 ZIP 落到备份目录 `dsh-config-<时间戳>.zip`，回执给绝对路径。
  //
  // 导入：ZIP 是不可信输入——listZip/extractZip 全套 Zip Slip / 符号链接 / zip bomb /
  // CRC 防线；先 importPreview（dry-run 计划：节段、目标冲突、跨机 remap 需求、
  // 兼容性评分），再 importApply（自动快照 → 应用 → 校验 → 失败回滚）。
  //
  // 节段归类：ZIP 条目名 = 相对 ~/.dsh 的 POSIX 路径；section = 按顶层名归类。
  // 这样既避免「sessions/sessions/…」双重前缀，又让导入目标路径 = dshHome + 条目名。

  /** 按顶层条目名归类节段 key；未匹配 → other 兜底（绝不丢弃任何文件）。 */
  function sectionKeyForTop(top) {
    for (const s of EXPORT_SECTIONS) if (s.paths.includes(top)) return s.key;
    return EXPORT_OTHER_KEY;
  }

  /** 节段 key → 人话标签（含 other 兜底）。 */
  function sectionLabel(key) {
    const hit = EXPORT_SECTIONS.find((s) => s.key === key);
    return hit ? hit.label : (key === EXPORT_OTHER_KEY ? '其他（未归类）' : key);
  }

  /**
   * 递归走查 ~/.dsh 收集可导出的普通文件。跳过符号链接/特殊文件/node_modules/
   * .git/.system（任意深度）；凭据节段按 includeCredentials 决定入包或记入脱敏清单。
   */
  async function walkExportFiles(dshHome, includeCredentials, signal) {
    const files = [];
    const redacted = [];
    const skipDirs = new Set(['node_modules', '.git', '.system']);
    async function walk(abs, rel) {
      if (signal?.aborted) throw new Error('操作已取消');
      if (files.length >= EXPORT_MAX_FILES) throw new Error(`导出文件数超过上限（${EXPORT_MAX_FILES}），请检查 ~/.dsh 是否有异常目录树`);
      let st;
      try { st = await lstat(abs); } catch { return; }
      if (st.isSymbolicLink()) return;
      if (st.isDirectory()) {
        if (rel && skipDirs.has(rel.split('/').pop())) return;
        let names;
        try { names = await readdir(abs); } catch { return; }
        for (const n of names) {
          if (n === '.DS_Store') continue;
          await walk(`${abs}/${n}`, rel ? `${rel}/${n}` : n);
        }
        return;
      }
      if (!st.isFile()) return;
      const section = sectionKeyForTop(rel.split('/')[0]);
      if (section === 'credentials' && !includeCredentials) { redacted.push(rel); return; }
      files.push({ rel, abs, bytes: st.size, section });
    }
    await walk(dshHome, '');
    return { files, redacted };
  }

  /** 组装导出 manifest（JSON，作为 ZIP 首条目写入；导入读端据此识别包）。 */
  function buildManifest(home, encrypted, redacted, sectionStats) {
    const sections = [...sectionStats.entries()].map(([key, v]) => ({ key, label: sectionLabel(key), files: v.files, bytes: v.bytes }));
    return {
      format: EXPORT_FORMAT,
      version: EXPORT_FORMAT_VERSION,
      createdAt: new Date().toISOString(),
      source: { host: hostname(), home, platform: process.platform, pluginVersion: SELF_META.version },
      redacted,
      encrypted,
      sections,
      totalFiles: [...sectionStats.values()].reduce((s, v) => s + v.files, 0),
      totalBytes: [...sectionStats.values()].reduce((s, v) => s + v.bytes, 0),
    };
  }

  /** 导出：把 ~/.dsh 打成单文件 ZIP（可选加密）。 */
  async function exportConfig(opts, signal) {
    const { home, dshHome, root } = paths();
    const includeCredentials = opts?.includeCredentials === true;
    const password = typeof opts?.password === 'string' && opts.password ? opts.password : null;
    // 凭据入包必须加密：明文凭据打成一个可随意拷贝的 ZIP 是自找泄密。
    if (includeCredentials && !password) {
      throw new Error('包含凭据的导出必须加密（口令只经面板 RPC 内存态传入，绝不落盘）——请勾选加密并输入口令');
    }
    const { files, redacted } = await walkExportFiles(dshHome, includeCredentials, signal);
    const sectionStats = new Map();
    for (const f of files) {
      const cur = sectionStats.get(f.section) || { files: 0, bytes: 0 };
      cur.files += 1; cur.bytes += f.bytes;
      sectionStats.set(f.section, cur);
    }
    // 本地 link:/file: 插件迁移：npm pack 成 tarball 打进导出，导入侧解包改 file:
    const localPlugins = await scanLocalPlugins(signal);
    const packedPlugins = localPlugins.filter((p) => p.status === 'packed');
    const encrypted = Boolean(password);
    const manifest = buildManifest(home, encrypted, redacted, sectionStats);
    manifest.localPlugins = localPlugins.map((p) => ({ profile: p.profile, name: p.name, spec: p.spec, status: p.status, tarball: p.tarballName ?? null, warning: p.warning ?? null }));
    const finalName = `dsh-config-${stampNow()}.zip`;
    const finalPath = `${root}/${finalName}`;
    const tmpPath = `${root}/.export-${stampNow()}.tmp.zip`;
    // 备份目录可能尚未创建（用户从没备份过就直接点导出）：先 mkdir，避免
    // buildZip 的 createWriteStream 对不存在的 root 抛未捕获 ENOENT。
    await mkdir(root, { recursive: true });
    try {
      const entryList = [{ name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest)) }];
      for (const f of files) entryList.push({ name: f.rel, sourcePath: f.abs });
      for (const p of packedPlugins) entryList.push({ name: `local-plugins/${p.tarballName}`, sourcePath: p.tarballPath });
      await buildZip(tmpPath, entryList, { signal });
      if (encrypted) {
        const tmpEnc = `${finalPath}.enc-${stampNow()}.tmp`;
        let enc;
        try {
          enc = await encryptFile(tmpPath, tmpEnc, password);
          await rename(tmpEnc, finalPath);
        } catch (err) {
          await rm(tmpEnc, { force: true }).catch(() => {});
          throw err;
        } finally {
          await rm(tmpPath, { force: true }).catch(() => {});
        }
        await writeOwned(`${finalPath}.encrypted.json`, `${JSON.stringify(enc.sidecar)}\n`);
      } else {
        await rename(tmpPath, finalPath);
      }
    } finally {
      await rm(tmpPath, { force: true }).catch(() => {});
    }
    const size = (await fsStat(finalPath)).size;
    const summary = `✅ 导出完成: ${finalName}（${encrypted ? '🔒 已加密' : '未加密'}，${files.length} 个文件）\n位置: ${finalPath}${redacted.length ? `\n🔐 已脱敏 ${redacted.length} 个凭据文件（不在包里，跨机需重填）` : ''}`;
    return { ok: true, path: finalPath, name: finalName, size, encrypted, manifest, redactedFiles: redacted, summary };
  }

  // ---------------- 配置市场（P4b-2） ----------------
  // 索引来自用户配置的 marketUrl，是**不可信输入**：只做 schema 校验与体积/条数
  // 上限，绝不执行 bundle 代码；断网/非法/超大一律优雅降级为空列表并如实说明。
  const MARKET_MAX_ENTRIES = 500;
  const MARKET_MAX_BYTES = 5 * 1024 * 1024;
  const MARKET_TIMEOUT_MS = 8000;

  /** 把市场索引里的一条原始记录归一化；缺 id/name/url 或 URL 非 http(s) 的条目直接丢弃。 */
  function normalizeMarketEntry(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const id = typeof raw.id === 'string' ? raw.id.trim() : '';
    const name = typeof raw.name === 'string' ? raw.name.trim() : '';
    const url = typeof raw.url === 'string' ? raw.url.trim() : '';
    if (!id || !name || !url) return null;
    let parsed;
    try { parsed = new URL(url); } catch { return null; }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return {
      id,
      name,
      desc: typeof raw.desc === 'string' ? raw.desc.slice(0, 500) : '',
      sections: Array.isArray(raw.sections) ? raw.sections.filter((s) => typeof s === 'string').slice(0, 32) : [],
      url,
      source: typeof raw.source === 'string' ? raw.source.slice(0, 200) : '',
      risk: raw.risk === 'high' || raw.risk === 'medium' ? raw.risk : 'low',
      version: typeof raw.version === 'string' ? raw.version.slice(0, 64) : '',
    };
  }

  /** 拉取并校验市场索引。返回 { enabled, entries, notice }，永不抛网络错误。 */
  async function fetchMarketIndex(signal) {
    const cfg = resolvedConfig();
    const url = typeof cfg.marketUrl === 'string' ? cfg.marketUrl.trim() : '';
    if (!url) return { enabled: false, entries: [], notice: '未配置市场地址（设置 → 备份设置 → 市场地址）' };
    let parsed;
    try { parsed = new URL(url); } catch { return { enabled: false, entries: [], notice: '市场地址不是合法 URL' }; }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { enabled: false, entries: [], notice: '市场地址必须是 http(s)' };
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), MARKET_TIMEOUT_MS);
    const onAbort = () => ctrl.abort();
    signal?.addEventListener?.('abort', onAbort, { once: true });
    try {
      const res = await fetch(url, { signal: ctrl.signal, headers: { accept: 'application/json' } });
      if (!res.ok) return { enabled: true, entries: [], notice: `市场索引拉取失败：HTTP ${res.status}` };
      const len = Number(res.headers.get('content-length') || 0);
      if (len > MARKET_MAX_BYTES) return { enabled: true, entries: [], notice: '市场索引过大（>5MB），已拒绝' };
      const text = await res.text();
      if (text.length > MARKET_MAX_BYTES) return { enabled: true, entries: [], notice: '市场索引过大（>5MB），已拒绝' };
      let data;
      try { data = JSON.parse(text); } catch { return { enabled: true, entries: [], notice: '市场索引不是合法 JSON' }; }
      const list = Array.isArray(data) ? data : (Array.isArray(data?.entries) ? data.entries : null);
      if (!list) return { enabled: true, entries: [], notice: '市场索引格式不对（需要数组或 { entries: [...] }）' };
      const entries = list.slice(0, MARKET_MAX_ENTRIES).map(normalizeMarketEntry).filter(Boolean);
      return { enabled: true, entries, notice: entries.length ? '' : '市场里没有有效条目' };
    } catch (err) {
      if (signal?.aborted) throw new Error('操作已取消');
      return { enabled: true, entries: [], notice: `市场索引拉取失败：${String(err && err.message ? err.message : err)}` };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
    }
  }

  /** 市场列表（只读）。 */
  async function marketList(signal) {
    const { enabled, entries, notice } = await fetchMarketIndex(signal);
    let host = '市场';
    try { host = new URL(resolvedConfig().marketUrl).host; } catch { /* 保持默认 */ }
    const summary = enabled
      ? (entries.length
        ? `🛒 市场共 ${entries.length} 个配置（来源：${host}）`
        : `🛒 市场暂无可用配置${notice ? `：${notice}` : ''}`)
      : `🛒 市场未启用${notice ? `：${notice}` : ''}`;
    return { ok: true, enabled, entries, summary };
  }

  /** 市场搜索（只读，本地过滤 name/desc）。 */
  async function marketSearch(query, signal) {
    const r = await marketList(signal);
    const q = typeof query === 'string' ? query.trim().toLowerCase() : '';
    if (!q) return r;
    const entries = r.entries.filter((e) => `${e.name} ${e.desc}`.toLowerCase().includes(q));
    return { ...r, entries, summary: `🛒 搜索「${query.trim()}」：${entries.length} 个结果` };
  }

  /**
   * 市场安装：下载条目 bundle ZIP → importPreview（只读计划）→ importApply
   * （自动快照 + 失败回滚）；默认 dry-run，confirm:true 才真正写入。
   * 供应链提示始终随结果返回，绝不静默安装。
   */
  async function marketInstall(opts, signal) {
    const id = typeof opts?.id === 'string' ? opts.id.trim() : '';
    if (!id) throw new Error('缺少市场条目 id');
    const { entries } = await fetchMarketIndex(signal);
    const entry = entries.find((e) => e.id === id);
    if (!entry) throw new Error(`市场里找不到条目：${id}`);
    const { root } = paths();
    await mkdir(root, { recursive: true });
    const tmp = `${root}/.market-${stampNow()}.zip`;
    const supplyChain = [];
    if (!entry.source) supplyChain.push('⚠️ 该条目未声明来源，无法确认发布者');
    if (entry.risk === 'high') supplyChain.push('⚠️ 该条目被标记为高风险配置');
    try {
      const host = new URL(entry.url).host;
      if (!/(^|\.)(github\.com|githubusercontent\.com|deepseek\.com)$/i.test(host)) {
        supplyChain.push(`⚠️ 下载来源为第三方域名：${host}`);
      }
    } catch { /* URL 已在归一化阶段过滤 */ }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), MARKET_TIMEOUT_MS);
    const onAbort = () => ctrl.abort();
    signal?.addEventListener?.('abort', onAbort, { once: true });
    try {
      const res = await fetch(entry.url, { signal: ctrl.signal });
      if (!res.ok) throw new Error(`下载配置包失败：HTTP ${res.status}`);
      const len = Number(res.headers.get('content-length') || 0);
      if (len > MARKET_MAX_BYTES) throw new Error('配置包过大（>5MB），已拒绝');
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > MARKET_MAX_BYTES) throw new Error('配置包过大（>5MB），已拒绝');
      await writeBinary(tmp, buf);
      const preview = await importPreview({ sourcePath: tmp }, signal);
      if (opts?.confirm !== true) {
        return {
          ok: true,
          dryRun: true,
          entry: { id: entry.id, name: entry.name },
          preview,
          supplyChain,
          summary: `🛒 市场预览：${entry.name}\n${preview.summary}${supplyChain.length ? `\n${supplyChain.join('\n')}` : ''}\n\n确认无误后再执行安装（confirm=true）。`,
        };
      }
      const applied = await importApply({ sourcePath: tmp, decisions: opts?.decisions || {}, sections: opts?.sections }, signal);
      return {
        ok: applied.ok !== false,
        dryRun: false,
        entry: { id: entry.id, name: entry.name },
        applied,
        supplyChain,
        summary: `🛒 市场安装：${entry.name}\n${applied.summary}${supplyChain.length ? `\n${supplyChain.join('\n')}` : ''}`,
      };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
      await rm(tmp, { force: true }).catch(() => {});
    }
  }

  // ---------------- 外部 agent 导入（P4b-3） ----------------
  // 从本机已安装的其它 AI agent 读取「技能 + 全局指令」，翻译成标准 dsh-config
  // 包后走 importPreview/importApply（预览/冲突/快照/回滚）。MCP 服务器只检测
  // 并如实报告——DSH 的 MCP 载体是 cordis 配置，v1 不自动改写，避免装坏。
  const FOREIGN_SOURCES = Object.freeze([
    { id: 'claude-code', label: 'Claude Code', skillsDir: '.claude/skills', instructions: ['.claude/CLAUDE.md'], mcpFiles: ['.claude/settings.json', '.claude.json'] },
    { id: 'cursor', label: 'Cursor', skillsDir: null, instructions: ['.cursorrules'], mcpFiles: ['.cursor/mcp.json'] },
    { id: 'codex', label: 'Codex', skillsDir: null, instructions: ['.codex/AGENTS.md'], mcpFiles: ['.codex/config.toml'] },
  ]);
  const FOREIGN_MAX_FILES = 500;
  const FOREIGN_MAX_BYTES = 10 * 1024 * 1024;
  const FOREIGN_MAX_INSTRUCTION_BYTES = 200 * 1024;

  /** 安全相对路径：拒绝空、绝对路径与 `..` 段。 */
  function safeForeignRel(rel) {
    return typeof rel === 'string' && rel !== '' && !rel.startsWith('/') && !rel.split('/').includes('..');
  }

  async function collectForeignSkills(home, source, signal) {
    const out = [];
    if (!source.skillsDir) return out;
    let names;
    try { names = await readdir(`${home}/${source.skillsDir}`); } catch { return out; }
    const walkDir = async (abs, rel) => {
      let entries;
      try { entries = await readdir(abs); } catch { return; }
      for (const n of entries) {
        if (signal?.aborted) throw new Error('操作已取消');
        if (!safeForeignRel(n)) continue;
        const childAbs = `${abs}/${n}`;
        const childRel = `${rel}/${n}`;
        let st;
        try { st = await lstat(childAbs); } catch { continue; }
        if (st.isSymbolicLink()) continue;
        if (st.isDirectory()) { await walkDir(childAbs, childRel); continue; }
        if (!st.isFile()) continue;
        if (out.length >= FOREIGN_MAX_FILES) throw new Error(`外部技能文件数超过上限（${FOREIGN_MAX_FILES}）`);
        out.push({ rel: childRel, abs: childAbs, bytes: st.size });
      }
    };
    for (const n of names) {
      if (!safeForeignRel(n)) continue;
      const abs = `${home}/${source.skillsDir}/${n}`;
      let st;
      try { st = await lstat(abs); } catch { continue; }
      if (!st.isDirectory()) continue;
      await walkDir(abs, `skills/${n}`);
    }
    return out;
  }

  async function collectForeignInstructions(home, source) {
    for (const rel of source.instructions) {
      try {
        const st = await fsStat(`${home}/${rel}`);
        if (!st.isFile() || st.size > FOREIGN_MAX_INSTRUCTION_BYTES) continue;
        const content = await readFile(`${home}/${rel}`, 'utf8');
        return { rel, content };
      } catch { /* 试下一个 */ }
    }
    return null;
  }

  async function detectForeignSource(home, source) {
    const files = await collectForeignSkills(home, source, null);
    const instructions = await collectForeignInstructions(home, source);
    const mcpServers = [];
    for (const rel of source.mcpFiles) {
      let text;
      try { text = await readFile(`${home}/${rel}`, 'utf8'); } catch { continue; }
      if (!rel.endsWith('.json')) { mcpServers.push(`${rel}（存在，未解析）`); continue; }
      try {
        const data = JSON.parse(text);
        const servers = data?.mcpServers && typeof data.mcpServers === 'object' ? Object.keys(data.mcpServers) : [];
        for (const s of servers) mcpServers.push(`${s}（来自 ${rel}）`);
      } catch { mcpServers.push(`${rel}（存在，JSON 解析失败）`); }
    }
    return {
      id: source.id,
      label: source.label,
      detected: files.length > 0 || Boolean(instructions) || mcpServers.length > 0,
      files,
      instructions,
      mcpServers,
    };
  }

  /** 外部 agent 列表（只读检测）。 */
  async function foreignSources() {
    const { home } = paths();
    const list = [];
    for (const source of FOREIGN_SOURCES) {
      const r = await detectForeignSource(home, source);
      list.push({
        id: r.id,
        label: r.label,
        detected: r.detected,
        skills: r.files.length,
        instructions: r.instructions ? r.instructions.rel : null,
        mcpServers: r.mcpServers,
      });
    }
    const found = list.filter((s) => s.detected).map((s) => s.label);
    return {
      ok: true,
      sources: list,
      summary: found.length ? `🧳 检测到 ${found.length} 个可导入来源：${found.join('、')}` : '🧳 没有检测到可导入的外部 agent 配置',
    };
  }

  /** 把某来源翻译成标准 dsh-config 包（技能 + AGENTS.md），返回 { zipPath, report, cleanup }。 */
  async function buildForeignBundle(sourceId, signal) {
    const { home, root } = paths();
    const source = FOREIGN_SOURCES.find((s) => s.id === sourceId);
    if (!source) throw new Error(`未知来源：${sourceId}`);
    const r = await detectForeignSource(home, source);
    if (!r.detected) throw new Error(`本机没有检测到 ${source.label} 的配置`);
    let bytes = 0;
    for (const f of r.files) bytes += f.bytes;
    if (bytes > FOREIGN_MAX_BYTES) throw new Error(`外部配置体积超过上限（${(FOREIGN_MAX_BYTES / 1048576).toFixed(0)}MB）`);
    const instructionBytes = r.instructions ? Buffer.byteLength(r.instructions.content) : 0;
    const entries = r.files.map((f) => ({ name: f.rel, sourcePath: f.abs }));
    if (r.instructions) entries.unshift({ name: 'AGENTS.md', data: Buffer.from(r.instructions.content) });
    const manifest = {
      format: EXPORT_FORMAT,
      version: EXPORT_FORMAT_VERSION,
      createdAt: new Date().toISOString(),
      source: { host: r.label, platform: process.platform, pluginVersion: SELF_META.version, home: '~' },
      redacted: [],
      encrypted: false,
      sections: [
        ...(r.instructions ? [{ key: 'other', label: '其他（未归类）', files: 1, bytes: instructionBytes }] : []),
        ...(r.files.length ? [{ key: 'skills', label: '技能', files: r.files.length, bytes }] : []),
      ],
      totalFiles: r.files.length + (r.instructions ? 1 : 0),
      totalBytes: bytes + instructionBytes,
      foreign: { source: r.id, label: r.label, mcpServers: r.mcpServers },
    };
    const zipPath = `${root}/.foreign-${stampNow()}.zip`;
    await mkdir(root, { recursive: true });
    try {
      await buildZip(zipPath, [{ name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest)) }, ...entries], { signal });
    } catch (err) {
      await rm(zipPath, { force: true }).catch(() => {});
      throw err;
    }
    return {
      zipPath,
      report: {
        source: r.id,
        label: r.label,
        skills: r.files.length,
        instructions: r.instructions ? r.instructions.rel : null,
        mcpServers: r.mcpServers,
        totalFiles: manifest.totalFiles,
        totalBytes: manifest.totalBytes,
      },
      cleanup: () => rm(zipPath, { force: true }),
    };
  }

  /** 外部 agent 预览（只读计划，不写 ~/.dsh）。 */
  async function foreignPreview(options, signal) {
    const sourceId = typeof options?.source === 'string' ? options.source : '';
    if (!sourceId) throw new Error('缺少来源（source）');
    const bundle = await buildForeignBundle(sourceId, signal);
    try {
      const preview = await importPreview({ sourcePath: bundle.zipPath }, signal);
      const mcp = bundle.report.mcpServers.length
        ? `\n\n检测到 ${bundle.report.mcpServers.length} 个 MCP 服务器（v1 不自动导入，请手动配置）：\n${bundle.report.mcpServers.map((m) => `  · ${m}`).join('\n')}`
        : '';
      return { ok: true, report: bundle.report, preview, summary: `🧳 ${bundle.report.label} 预览\n${preview.summary}${mcp}` };
    } finally {
      await bundle.cleanup().catch(() => {});
    }
  }

  /** 外部 agent 导入：默认 dry-run；confirm:true 才真正写入（自动快照 + 回滚）。 */
  async function foreignImport(options, signal) {
    const sourceId = typeof options?.source === 'string' ? options.source : '';
    if (!sourceId) throw new Error('缺少来源（source）');
    const bundle = await buildForeignBundle(sourceId, signal);
    try {
      if (options?.confirm !== true) {
        const preview = await importPreview({ sourcePath: bundle.zipPath }, signal);
        return { ok: true, dryRun: true, report: bundle.report, preview, summary: `🧳 ${bundle.report.label} 预览（未写入）\n${preview.summary}` };
      }
      const applied = await importApply({ sourcePath: bundle.zipPath, decisions: options?.decisions || {} }, signal);
      return { ok: applied.ok !== false, dryRun: false, report: bundle.report, applied, summary: `🧳 ${bundle.report.label} 导入\n${applied.summary}` };
    } finally {
      await bundle.cleanup().catch(() => {});
    }
  }

  // ---------------- 会话 Rewind（P4b-3b） ----------------
  // 把会话「分叉」到指定轮次：原会话一个字节都不改，新会话写到同一项目目录下
  // 的新会话目录，header.id 换成新 id、parentSession 指向原会话。v1 只复制会话
  // 日志（不做工作区文件回滚、不复制附件），预览里如实标注。
  const REWIND_MAX_SESSIONS = 50;

  /** 与宿主 session-persistence-jsonl 的 encodeSegment 逐字符一致（见其源码注释）。 */
  function encodeSessionSegment(raw) {
    if (typeof raw !== 'string' || raw.length === 0) throw new Error('会话 id 不能为空');
    if (raw === '.') return '~002E';
    if (raw === '..') return '~002E~002E';
    let out = '';
    for (let i = 0; i < raw.length; i++) {
      const code = raw.charCodeAt(i);
      const ch = String.fromCharCode(code);
      if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) out += ch;
      else out += '~' + code.toString(16).toUpperCase().padStart(4, '0');
    }
    return out;
  }

  /** 只解首帧拿 header（列表用，避免整读大日志）。 */
  function readSessionHeader(buf) {
    const frames = walkZstdFrames(buf);
    if (!frames.length) throw new Error('空日志');
    const first = zlib.zstdDecompressSync(buf.subarray(frames[0][0], frames[0][1]));
    const line = first.toString('utf8').split('\n').find((l) => l.length > 0);
    if (!line) throw new Error('首帧没有 header 行');
    const header = JSON.parse(line);
    if (!header || header.type !== 'session' || typeof header.id !== 'string') throw new Error('首帧不是会话 header');
    return header;
  }

  /** 一行记录的 seq 跨度 [start,end)；无 seq 返回 null。 */
  function rowSeqSpan(rec) {
    if (!rec || typeof rec !== 'object') return null;
    if (rec.type === 'text-chunks' || rec.type === 'reasoning-chunks' || rec.type === 'tool-call-chunks') {
      const data = rec.data ?? {};
      const members = Array.isArray(data.texts) ? data.texts.length : Array.isArray(data.args) ? data.args.length : 0;
      if (Number.isSafeInteger(rec.seq0) && members > 0) return [rec.seq0, rec.seq0 + members];
      return null;
    }
    if (typeof rec.seq === 'number') return [rec.seq, rec.seq + 1];
    return null;
  }

  /** 会话日志列表（只读；header + 文件名）。 */
  async function sessionRewindList(signal) {
    const { dshHome } = paths();
    if (!HAS_NODE_ZSTD) return { ok: true, sessions: [], summary: '🧭 运行时 Node 无内置 zstd，无法列出压缩会话日志' };
    const found = [];
    await collectSessionLogs(dshHome, '', 0, found);
    const out = [];
    for (const f of found.slice(0, REWIND_MAX_SESSIONS)) {
      if (signal?.aborted) throw new Error('操作已取消');
      if (!f.abs.endsWith('.zstd')) continue;
      try {
        const header = readSessionHeader(await readFile(f.abs));
        out.push({ id: header.id, rel: f.rel, file: f.rel.split('/').pop(), cwd: header.cwd ?? null, version: Number(header.version) || 0 });
      } catch { /* 损坏/无法解析的日志跳过（doctor 负责体检） */ }
    }
    out.sort((a, b) => a.id.localeCompare(b.id));
    return { ok: true, sessions: out, summary: out.length ? `🧭 找到 ${out.length} 个可回退会话` : '🧭 没有找到可回退的会话日志' };
  }

  /** 按 id 找会话日志：header.id 精确匹配，或目录名 = encodeSegment(id)。 */
  async function findSessionLog(sessionId, signal) {
    const { dshHome } = paths();
    if (!HAS_NODE_ZSTD) throw new Error('运行时 Node 无内置 zstd 支持，无法分叉压缩会话日志');
    const found = [];
    await collectSessionLogs(dshHome, '', 0, found);
    const wantEnc = encodeSessionSegment(sessionId);
    for (const f of found) {
      if (signal?.aborted) throw new Error('操作已取消');
      if (!f.abs.endsWith('.zstd')) continue;
      const parts = f.abs.split('/');
      const dirName = parts[parts.length - 2];
      let header = null;
      try { header = readSessionHeader(await readFile(f.abs)); } catch { /* 坏日志 */ }
      if ((header && header.id === sessionId) || dirName === wantEnc || dirName === sessionId) {
        return { ...f, header };
      }
    }
    return null;
  }

  /** 计算分叉计划（只读）。seq 缺省 = 最后一个用户消息。 */
  async function planSessionRewind(sessionId, seqInput, signal) {
    const target = await findSessionLog(sessionId, signal);
    if (!target) throw new Error(`找不到会话：${sessionId}`);
    const { lines } = decodeZstdLog(await readFile(target.abs));
    if (!lines.length) throw new Error('会话日志为空');
    const header = JSON.parse(lines[0]);
    const rows = lines.slice(1);
    let targetSeq = Number.isInteger(seqInput) ? seqInput : null;
    if (targetSeq === null) {
      for (let i = rows.length - 1; i >= 0; i--) {
        let rec;
        try { rec = JSON.parse(rows[i]); } catch { continue; }
        if (rec && typeof rec.seq === 'number' && (rec.role === 'user' || rec.type === 'user/message')) {
          targetSeq = rec.seq;
          break;
        }
      }
      if (targetSeq === null) targetSeq = rows.length;
    }
    const kept = [];
    let dropped = 0;
    for (const line of rows) {
      let rec;
      try { rec = JSON.parse(line); } catch { throw new Error('会话日志包含非法 JSON 行，拒绝分叉'); }
      const span = rowSeqSpan(rec);
      if (span && span[1] > targetSeq) {
        dropped = rows.length - kept.length;
        break;
      }
      kept.push(line);
    }
    const keptLines = [lines[0], ...kept];
    const defect = validateSessionLines(keptLines);
    if (defect !== null) throw new Error(`分叉后的日志未通过宿主容器校验，已拒绝：${defect}`);
    const newId = `${header.id}-rewind-${stampNow()}`;
    return { target, header, rows, kept, dropped, targetSeq, newId, keptLines };
  }

  /** 预览分叉计划（只读，不写盘）。 */
  async function sessionRewindPreview(sessionId, seq, signal) {
    const plan = await planSessionRewind(sessionId, seq, signal);
    const parts = plan.target.abs.split('/');
    const file = parts[parts.length - 1];
    const projectDir = parts.slice(0, -2).join('/');
    const newPath = `${projectDir}/${encodeSessionSegment(plan.newId)}/${file}`;
    return {
      ok: true,
      session: plan.header.id,
      targetSeq: plan.targetSeq,
      keepRecords: plan.kept.length,
      dropRecords: plan.dropped,
      newId: plan.newId,
      newPath,
      warnings: ['v1 只复制会话日志，不复制附件、不回滚工作区文件'],
      summary: `🧭 回退预览：${plan.header.id}\n保留 ${plan.kept.length} 条记录（回退到 seq < ${plan.targetSeq}）\n原会话保持不变；新分叉：${plan.newId}\n⚠️ v1 只复制会话日志，不复制附件、不回滚工作区文件`,
    };
  }

  /** 执行分叉（默认 dry-run；confirm:true 才写）。原会话永不修改。 */
  /**
   * 分叉日志的宿主不变量：header.isSeeded 必须与「会话内 inherited end-seed 标记」一致，
   * 否则宿主解码器 finish() 直接报错（seeded 缺标记 / unseeded 带标记），分叉根本打不开。
   * 这里统一修正：seeded 缺标记 → 降级为普通会话；unseeded 带标记 → 丢弃标记并重编号。
   */
  const SURFACE_EVENT_TYPES = new Set(['system/message', 'developer/message', 'user/message', 'assistant/message', 'tool/result']);

  function normalizeForkLog(header, rows) {
    // 宿主附加不变量:surface 事件必须带 surfaceOp,log-only 事件必须不带。
    const normalized = rows.map((row) => {
      const surface = SURFACE_EVENT_TYPES.has(row.type);
      if (surface && row.surfaceOp === undefined) return { ...row, surfaceOp: 'append' };
      if (!surface && row.surfaceOp !== undefined) {
        const next = { ...row };
        delete next.surfaceOp;
        return next;
      }
      return row;
    });
    const isMarker = (row) => row.type === 'session/end-seed' && row.data?.inherited === true;
    const markerIndex = normalized.findIndex(isMarker);
    if (header.isSeeded === true) {
      if (markerIndex >= 0) return { header, rows: normalized };
      return { header: { ...header, isSeeded: false }, rows: normalized };
    }
    if (markerIndex < 0) return { header, rows: normalized };
    const kept = normalized.filter((row) => !isMarker(row));
    const map = new Map();
    kept.forEach((row, index) => map.set(row.seq, index));
    const remap = (seq) => (map.has(seq) ? map.get(seq) : undefined);
    const out = kept.map((row) => {
      const next = { ...row, seq: map.get(row.seq) };
      if (Array.isArray(row.sourceEventSeqs)) {
        const mapped = row.sourceEventSeqs.map(remap).filter((value) => value !== undefined);
        if (mapped.length) next.sourceEventSeqs = mapped;
        else delete next.sourceEventSeqs;
      }
      if (row.surfaceOp && typeof row.surfaceOp === 'object') {
        const start = remap(row.surfaceOp.startSeq);
        const end = remap(row.surfaceOp.endSeq);
        next.surfaceOp = start === undefined || end === undefined ? 'append' : { op: 'replace', startSeq: start, endSeq: end };
      }
      return next;
    });
    return { header, rows: out };
  }

  async function sessionRewindApply(opts, signal) {
    const sessionId = typeof opts?.session === 'string' ? opts.session : '';
    if (!sessionId) throw new Error('缺少会话 id');
    const seq = Number.isInteger(opts?.seq) ? opts.seq : undefined;
    if (opts?.confirm !== true) {
      const preview = await sessionRewindPreview(sessionId, seq, signal);
      return { ...preview, dryRun: true };
    }
    const plan = await planSessionRewind(sessionId, seq, signal);
    const parts = plan.target.abs.split('/');
    const file = parts[parts.length - 1];
    const projectDir = parts.slice(0, -2).join('/');
    const newDir = `${projectDir}/${encodeSessionSegment(plan.newId)}`;
    const newPath = `${newDir}/${file}`;
    if (pathExists(newDir)) throw new Error('目标分叉目录已存在，拒绝覆盖');
    const header = { ...plan.header, id: plan.newId, parentSession: plan.header.id };
    const normalized = normalizeForkLog(header, plan.kept.map((line) => JSON.parse(line)));
    const keptLines = normalized.rows.map((row) => JSON.stringify(row));
    const headerLine = JSON.stringify({ ...normalized.header, id: plan.newId, parentSession: plan.header.id });
    let buf;
    if (file.endsWith('.zstd')) {
      const frames = [zlib.zstdCompressSync(Buffer.from(headerLine + '\n'))];
      if (keptLines.length) frames.push(zlib.zstdCompressSync(Buffer.from(keptLines.join('\n') + '\n')));
      buf = Buffer.concat(frames);
    } else {
      buf = Buffer.from([headerLine, ...keptLines].join('\n') + '\n');
    }
    await mkdir(newDir, { recursive: true });
    try {
      await writeFile(newPath, buf);
      // 写完立刻用同一套宿主容器校验回读，坏包不留
      const back = decodeZstdLog(await readFile(newPath));
      const defect = validateSessionLines(back.lines);
      if (defect !== null) throw new Error(`写出的分叉未通过校验：${defect}`);
    } catch (err) {
      await rm(newDir, { recursive: true, force: true }).catch(() => {});
      throw err;
    }
    return {
      ok: true,
      dryRun: false,
      session: plan.header.id,
      newId: plan.newId,
      newPath,
      keepRecords: plan.kept.length,
      summary: `🧭 已分叉会话：${plan.header.id} → ${plan.newId}\n保留 ${plan.kept.length} 条记录；原会话未改动。\n重启 dsh 后可在会话列表看到新分支。`,
    };
  }

  // ---------------- 外部聊天记录导入(多来源) ----------------
  // 把其它 AI 工具的会话日志翻译成 DSH v4 会话日志(新建会话、绝不改原数据)。
  // 支持:claude-code(~/.claude/projects/*/*.jsonl)、codex(~/.codex/sessions/**/rollout-*.jsonl)。
  // 只映射「用户/助手文本 + 推理摘要 + 工具调用/结果」;其余事件跳过并计数。
  // 行格式对齐宿主:{type,seq,time,data} + 消息事件带 surfaceOp:'append'。
  const CLAUDE_PROJECTS_DIR = '.claude/projects';
  const CODEX_SESSIONS_DIR = '.codex/sessions';
  const CHAT_IMPORT_MAX_MESSAGES = 5000;
  const CHAT_SOURCE_LABELS = { 'claude-code': 'Claude Code', codex: 'Codex' };

  function chatSourceOf(id) {
    return String(id || '').startsWith('codex-') ? 'codex' : 'claude-code';
  }

  function chatSessionId(prefix, name) {
    const tail = String(name).replace(/[^A-Za-z0-9]/g, '').slice(-12);
    return `${prefix}-${tail || 'session'}`;
  }

  async function listClaudeSessions() {
    const { home } = paths();
    const root = `${home}/${CLAUDE_PROJECTS_DIR}`;
    let projects;
    try { projects = await readdir(root, { withFileTypes: true }); } catch { return []; }
    const out = [];
    for (const proj of projects) {
      if (!proj.isDirectory()) continue;
      let files;
      try { files = await readdir(`${root}/${proj.name}`); } catch { continue; }
      for (const f of files) {
        if (!f.endsWith('.jsonl')) continue;
        const abs = `${root}/${proj.name}/${f}`;
        let st;
        try { st = await fsStat(abs); } catch { continue; }
        out.push({ abs, rel: `${CLAUDE_PROJECTS_DIR}/${proj.name}/${f}`, project: proj.name, file: f, id: chatSessionId('claude', `${proj.name}${f}`), bytes: st.size, mtime: st.mtimeMs });
      }
    }
    return out;
  }

  async function listCodexSessions() {
    const { home } = paths();
    const root = `${home}/${CODEX_SESSIONS_DIR}`;
    const out = [];
    const walk = async (dir, depth) => {
      if (depth > 6 || out.length >= 200) return;
      let entries;
      try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const abs = `${dir}/${e.name}`;
        if (e.isDirectory()) { await walk(abs, depth + 1); continue; }
        if (!e.name.endsWith('.jsonl')) continue;
        let st;
        try { st = await fsStat(abs); } catch { continue; }
        const stem = e.name.replace(/^rollout-/, '').replace(/\.jsonl$/, '');
        out.push({ abs, rel: abs.slice(home.length + 1), project: stem.slice(0, 10), file: e.name, id: chatSessionId('codex', stem), bytes: st.size, mtime: st.mtimeMs });
      }
    };
    await walk(root, 0);
    return out;
  }

  function textBlocks(blocks) {
    if (!Array.isArray(blocks)) return [];
    return blocks.filter((b) => b && typeof b.text === 'string' && b.text).map((b) => b.text);
  }

  /** 解析 Claude Code JSONL → 归一化消息序列。 */
  async function parseClaudeSession(abs) {
    const text = await readFile(abs, 'utf8');
    const messages = [];
    let skipped = 0;
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      if (messages.length >= CHAT_IMPORT_MAX_MESSAGES) break;
      let rec;
      try { rec = JSON.parse(line); } catch { skipped += 1; continue; }
      const type = rec.type || rec.message?.role;
      const msg = rec.message;
      if (!msg || (type !== 'user' && type !== 'assistant')) { skipped += 1; continue; }
      const blocks = Array.isArray(msg.content)
        ? msg.content
        : (typeof msg.content === 'string' ? [{ type: 'text', text: msg.content }] : []);
      const time = rec.timestamp ? (Date.parse(rec.timestamp) || 0) : 0;
      if (type === 'user') {
        const texts = [];
        const results = [];
        for (const b of blocks) {
          if (b && b.type === 'text' && typeof b.text === 'string') texts.push(b.text);
          else if (b && b.type === 'tool_result') {
            results.push({
              callId: String(b.tool_use_id || b.toolUseId || ''),
              text: typeof b.content === 'string' ? b.content : JSON.stringify(b.content ?? ''),
              isError: b.is_error === true,
            });
          } else skipped += 1;
        }
        if (texts.length) messages.push({ role: 'user', texts, reasoning: [], toolCalls: [], time });
        for (const r of results) messages.push({ role: 'tool', texts: [r.text], reasoning: [], toolCalls: [], callId: r.callId, isError: r.isError, time });
      } else {
        const texts = [];
        const reasoning = [];
        const toolCalls = [];
        for (const b of blocks) {
          if (b && b.type === 'text' && typeof b.text === 'string') texts.push(b.text);
          else if (b && b.type === 'thinking' && typeof b.thinking === 'string') reasoning.push(b.thinking);
          else if (b && b.type === 'tool_use') toolCalls.push({ id: String(b.id || `call-${toolCalls.length}`), name: String(b.name || 'tool'), arguments: JSON.stringify(b.input ?? {}) });
          else skipped += 1;
        }
        if (texts.length || reasoning.length || toolCalls.length) {
          messages.push({ role: 'assistant', texts, reasoning, toolCalls, time });
        }
      }
    }
    return { messages, skipped, cwd: null, model: null };
  }

  /** 解析 Codex rollout JSONL → 归一化消息序列(函数调用与结果按 call_id 配对)。 */
  async function parseCodexSession(abs) {
    const text = await readFile(abs, 'utf8');
    const messages = [];
    const calls = new Map();
    let skipped = 0;
    let cwd = null;
    let model = null;
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      if (messages.length >= CHAT_IMPORT_MAX_MESSAGES) break;
      let rec;
      try { rec = JSON.parse(line); } catch { skipped += 1; continue; }
      const p = rec.payload || {};
      if (rec.type === 'session_meta') {
        if (typeof p.cwd === 'string') cwd = p.cwd;
        continue;
      }
      if (rec.type === 'turn_context') {
        if (typeof p.model === 'string') model = p.model;
        continue;
      }
      if (rec.type !== 'response_item') { skipped += 1; continue; }
      const time = rec.timestamp ? (Date.parse(rec.timestamp) || 0) : 0;
      const kind = p.type;
      if (kind === 'message') {
        if (p.role === 'user') messages.push({ role: 'user', texts: textBlocks(p.content), reasoning: [], toolCalls: [], time });
        else if (p.role === 'assistant') messages.push({ role: 'assistant', texts: textBlocks(p.content), reasoning: [], toolCalls: [], time });
        else skipped += 1; // developer / system 指令不导入
      } else if (kind === 'reasoning') {
        const summary = textBlocks(p.summary).join('\n').trim();
        if (summary) messages.push({ role: 'assistant', texts: [], reasoning: [summary], toolCalls: [], time });
        else skipped += 1; // 只有加密推理,无法还原
      } else if (kind === 'function_call' || kind === 'custom_tool_call') {
        const callId = String(p.call_id || p.id || '');
        const args = typeof p.arguments === 'string'
          ? p.arguments
          : (typeof p.input === 'string' ? JSON.stringify({ input: p.input }) : '{}');
        calls.set(callId, { name: String(p.name || 'tool'), arguments: args });
      } else if (kind === 'function_call_output' || kind === 'custom_tool_call_output') {
        const callId = String(p.call_id || '');
        const call = calls.get(callId);
        const body = typeof p.output === 'string' ? p.output : textBlocks(p.output).join('\n');
        messages.push({
          role: 'tool',
          texts: [body],
          reasoning: [],
          toolCalls: [],
          callId,
          name: call?.name,
          arguments: call?.arguments,
          time,
        });
      } else {
        skipped += 1; // compaction / agent_message / world_state 等
      }
    }
    const kept = messages.filter((m) => m.role === 'tool' ? m.texts.length > 0 : (m.texts.length > 0 || m.reasoning.length > 0));
    return { messages: kept, skipped, cwd, model };
  }

  /** 归一化消息 → DSH v4 事件行(seq 连续;消息事件带 surfaceOp)。 */
  function chatMessagesToEvents(messages, baseTime) {
    const rows = [];
    let seq = 0;
    let turn = 0;
    const push = (type, data, surface = false) => {
      const row = { type, seq, time: baseTime + seq, data };
      if (surface) row.surfaceOp = 'append';
      rows.push(row);
      seq += 1;
    };
    for (const m of messages) {
      turn += 1;
      push('turn/start', { turn });
      push('step/start', { turn, step: 1 });
      if (m.role === 'user') {
        push('user/message', { id: `u${turn}`, role: 'user', content: m.texts.map((t) => ({ type: 'text', text: t })), source: { kind: 'user' } }, true);
      } else if (m.role === 'tool') {
        // Codex 的调用与结果分两条记录:同一回合内先补 tool/call,再落 tool/result。
        if (m.name) push('tool/call', { turn, step: 1, callId: m.callId, name: m.name, arguments: m.arguments || '{}' });
        push('tool/result', {
          turn,
          step: 1,
          message: {
            id: `t${turn}`,
            role: 'tool',
            toolCallId: m.callId,
            content: [{ type: 'text', text: m.texts.join('') }],
            source: { kind: 'tool', callId: m.callId },
            ...(m.isError ? { isError: true } : {}),
          },
        }, true);
      } else {
        const content = [];
        for (const r of m.reasoning) content.push({ type: 'reasoning', text: r });
        for (const t of m.texts) content.push({ type: 'text', text: t });
        for (const c of m.toolCalls) content.push({ type: 'tool-call', id: c.id, name: c.name, arguments: c.arguments });
        if (!content.length) {
          rows.pop();
          rows.pop();
          turn -= 1;
          continue;
        }
        push('assistant/message', {
          turn,
          step: 1,
          message: { id: `a${turn}`, role: 'assistant', content, source: { kind: 'model', provider: 'imported', model: 'imported' } },
          stream: [],
        }, true);
      }
      push('step/end', { turn, step: 1 });
      push('turn/end', { turn, reason: { kind: 'completed' } });
    }
    return rows;
  }

  /** 外部聊天来源汇总(检测 + 会话清单)。 */
  async function chatSources() {
    const [claude, codex] = await Promise.all([listClaudeSessions(), listCodexSessions()]);
    const sessions = [];
    const sources = [];
    const collect = async (sourceId, list) => {
      sources.push({ id: sourceId, label: CHAT_SOURCE_LABELS[sourceId], detected: list.length > 0, count: list.length });
      for (const s of list.slice(0, 50)) {
        try {
          const parsed = sourceId === 'codex' ? await parseCodexSession(s.abs) : await parseClaudeSession(s.abs);
          const firstUser = parsed.messages.find((m) => m.role === 'user');
          sessions.push({
            source: sourceId,
            id: s.id,
            file: s.file,
            project: s.project,
            messages: parsed.messages.length,
            title: firstUser ? String(firstUser.texts[0] || '').slice(0, 60) : '',
          });
        } catch { /* 单文件解析失败不影响其它会话 */ }
      }
    };
    await collect('claude-code', claude);
    await collect('codex', codex);
    const detected = sources.filter((s) => s.detected);
    return {
      ok: true,
      sources,
      detected: detected.length > 0,
      sessions,
      summary: detected.length
        ? `💬 检测到 ${detected.map((s) => `${s.label} ${s.count}`).join(' · ')} 个会话`
        : '💬 没有检测到可导入的聊天记录(Claude Code / Codex)',
    };
  }

  async function buildChatImport(source, sessionId) {
    const src = source === 'codex' ? 'codex' : 'claude-code';
    const list = src === 'codex' ? await listCodexSessions() : await listClaudeSessions();
    const target = list.find((s) => s.id === sessionId || s.file === sessionId || s.abs === sessionId);
    if (!target) throw new Error(`找不到 ${CHAT_SOURCE_LABELS[src]} 会话:${sessionId}`);
    const parsed = src === 'codex' ? await parseCodexSession(target.abs) : await parseClaudeSession(target.abs);
    if (!parsed.messages.length) throw new Error('该会话没有可导入的文本消息');
    // 宿主要求 time 是安全整数:毫秒时间戳必须取整(mtimeMs 可能是小数)。
    const rows = chatMessagesToEvents(parsed.messages, Math.floor(target.mtime || Date.now()));
    const id = `${target.id}-${stampNow()}`;
    const header = { type: 'session', version: 4, id, createdAt: Math.floor(target.mtime || Date.now()), isSeeded: false, delegationDepth: 0, ...(parsed.cwd ? { cwd: parsed.cwd } : {}) };
    const lines = [JSON.stringify(header), ...rows.map((r) => JSON.stringify(r))];
    const defect = validateSessionLines(lines);
    if (defect !== null) throw new Error(`导入会话未通过宿主容器校验,已中止:${defect}`);
    return { source: src, target, parsed, rows, header, id, lines };
  }

  /** 预览:只读,不写盘。 */
  async function chatPreview(opts, signal) {
    const sessionId = typeof opts?.session === 'string' ? opts.session : '';
    if (!sessionId) throw new Error('缺少会话 id');
    if (signal?.aborted) throw new Error('操作已取消');
    const source = typeof opts?.source === 'string' && opts.source ? opts.source : chatSourceOf(sessionId);
    const bundle = await buildChatImport(source, sessionId);
    const userCount = bundle.parsed.messages.filter((m) => m.role === 'user').length;
    const asstCount = bundle.parsed.messages.filter((m) => m.role === 'assistant').length;
    const toolCount = bundle.parsed.messages.filter((m) => m.role === 'tool').length;
    const label = CHAT_SOURCE_LABELS[bundle.source];
    return {
      ok: true,
      dryRun: true,
      source: bundle.source,
      session: bundle.target.id,
      file: bundle.target.file,
      messages: bundle.parsed.messages.length,
      userCount,
      asstCount,
      toolCount,
      skipped: bundle.parsed.skipped,
      events: bundle.rows.length,
      newId: bundle.id,
      warnings: ['仅导入文本、推理摘要与工具调用/结果;图片/文件块与私有事件已跳过', '导入为新的 DSH 会话,不改动原会话'],
      summary: `💬 ${label} 导入预览\n${bundle.parsed.messages.length} 条消息(用户 ${userCount} / 助手 ${asstCount} / 工具结果 ${toolCount})→ ${bundle.rows.length} 个事件\n跳过 ${bundle.parsed.skipped} 个非文本事件;导入为新会话,原会话不动`,
    };
  }

  /** 执行导入:默认 dry-run;confirm:true 才写(新会话目录,绝不覆盖)。 */
  async function chatApply(opts, signal) {
    const sessionId = typeof opts?.session === 'string' ? opts.session : '';
    if (!sessionId) throw new Error('缺少会话 id');
    if (opts?.confirm !== true) return chatPreview(opts, signal);
    const source = typeof opts?.source === 'string' && opts.source ? opts.source : chatSourceOf(sessionId);
    const bundle = await buildChatImport(source, sessionId);
    const { dshHome } = paths();
    const dir = `${dshHome}/sessions/_no-cwd/${encodeSessionSegment(bundle.id)}`;
    if (pathExists(dir)) throw new Error('目标会话目录已存在,拒绝覆盖');
    await mkdir(dir, { recursive: true });
    const headerFrame = zlib.zstdCompressSync(Buffer.from(`${JSON.stringify(bundle.header)}\n`));
    const bodyFrame = zlib.zstdCompressSync(Buffer.from(`${bundle.rows.map((r) => JSON.stringify(r)).join('\n')}\n`));
    const file = `${dir}/session.v4.jsonl.zstd`;
    try {
      await writeFile(file, Buffer.concat([headerFrame, bodyFrame]));
      // 回读校验:同一套容器契约(首帧恰好一行 header + seq 连续)
      const back = decodeZstdLog(await readFile(file));
      const defect = validateSessionLines(back.lines);
      if (defect !== null) throw new Error(defect);
    } catch (err) {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
      throw new Error(`写出的会话未通过校验:${String(err && err.message ? err.message : err)}`);
    }
    return {
      ok: true,
      dryRun: false,
      source: bundle.source,
      newId: bundle.id,
      path: file,
      messages: bundle.parsed.messages.length,
      events: bundle.rows.length,
      summary: `💬 已导入 ${CHAT_SOURCE_LABELS[bundle.source]} 会话:${bundle.parsed.messages.length} 条消息(${bundle.rows.length} 个事件)\n新会话 id: ${bundle.id}\n重启 dsh 后可在会话列表看到(仅文本、推理摘要与工具调用/结果)`,
    };
  }
  /**
   * 打开导出 ZIP（必要时用口令解密到备份目录临时文件）。返回 { zipPath, encrypted,
   * cleanup }；调用方在 finally 里必调 cleanup（解密出的明文 ZIP 不能遗留）。
   */
  async function openExportZip(sourcePath, password, signal) {
    const src = typeof sourcePath === 'string' ? sourcePath : '';
    if (!src || !src.endsWith('.zip')) throw new Error('导出文件路径无效（需指向 .zip 文件）');
    if (signal?.aborted) throw new Error('操作已取消');
    const sidecarPath = `${src}.encrypted.json`;
    const encrypted = await existsStat(sidecarPath);
    if (encrypted) {
      if (!password) throw new Error('这份导出已加密，需要口令才能读取（口令只经面板 RPC 内存态传入，绝不落盘）');
      const sidecar = JSON.parse(await readFile(sidecarPath, 'utf8'));
      const { root } = paths();
      const tmp = `${root}/.export-dec-${stampNow()}.zip`;
      await decryptFile(src, tmp, sidecar, password);
      return { zipPath: tmp, encrypted: true, cleanup: () => rm(tmp, { force: true }) };
    }
    return { zipPath: src, encrypted: false, cleanup: null };
  }

  /** 读取并校验导出 manifest（未知格式/过新版本一律拒绝）。 */
  async function readExportManifest(zipPath) {
    let manifest;
    try {
      manifest = JSON.parse((await readZipEntry(zipPath, 'manifest.json')).toString('utf8'));
    } catch (err) {
      throw new Error(`不是有效的 dsh-config 导出包（缺少 manifest.json）: ${String(err && err.message ? err.message : err)}`);
    }
    if (manifest?.format !== EXPORT_FORMAT) throw new Error('不是 dsh-config 导出包（manifest.format 不匹配）——请选择本插件导出的 ZIP');
    if (Number(manifest?.version) > EXPORT_FORMAT_VERSION) {
      throw new Error(`导出包版本过新（version=${manifest.version}，本机支持 ${EXPORT_FORMAT_VERSION}）——请升级插件后导入`);
    }
    return manifest;
  }

  /** 兼容性评分：来源平台/家目录/插件版本 vs 本地，结构化给原因（只提示，不阻断）。 */
  function compatScore(manifest, home) {
    const reasons = [];
    let score = 100;
    const src = manifest?.source || {};
    if (src.platform && src.platform !== process.platform) {
      score -= 30;
      reasons.push('来源平台与本机不同：绝对路径、换行符与权限语义可能需要调整');
    }
    if (src.home && src.home !== home) {
      score -= 25;
      reasons.push('来源家目录与本机不同：settings 里的绝对路径需要 remap');
    }
    if (src.pluginVersion && SELF_META.version !== 'unknown' && semverGt(src.pluginVersion, SELF_META.version)) {
      score -= 15;
      reasons.push(`导出由更新版本插件生成（${src.pluginVersion}），本机 ${SELF_META.version}，个别新字段可能被忽略`);
    }
    return { score: Math.max(0, score), reasons };
  }

  /** 按节段聚合条目并探测目标冲突（只读，不写盘）。 */
  async function buildImportPlan(entries, dshHome) {
    const sectionStats = new Map();
    const conflicts = [];
    for (const e of entries) {
      if (e.isDirectory || e.name === 'manifest.json') continue;
      const section = sectionKeyForTop(e.name.split('/')[0]);
      const cur = sectionStats.get(section) || { files: 0, bytes: 0, conflictNames: [] };
      cur.files += 1; cur.bytes += e.usize;
      const targetAbs = `${dshHome}/${e.name}`;
      if (await existsStat(targetAbs)) {
        cur.conflictNames.push(e.name);
        conflicts.push({ name: e.name, rel: e.name, section, exists: true });
      }
      sectionStats.set(section, cur);
    }
    const sections = [...sectionStats.entries()].map(([key, v]) => ({
      key, label: sectionLabel(key), files: v.files, bytes: v.bytes,
      conflicts: v.conflictNames.map((n) => ({ name: n, rel: n, exists: true })),
    }));
    return { sections, conflicts };
  }

  /** 跨机 remap 需求扫描：settings 里出现来源家目录绝对路径时提示（只读）。 */
  async function remapScan(zipPath, manifest, home) {
    const srcHome = manifest?.source?.home;
    if (!srcHome || srcHome === home) return [];
    const out = [];
    for (const rel of ['settings.yaml', 'settings.json']) {
      let text;
      try { text = (await readZipEntry(zipPath, rel)).toString('utf8'); } catch { continue; }
      let count = 0;
      let idx = text.indexOf(srcHome);
      const sample = new Set();
      while (idx >= 0 && count < 20) {
        count += 1;
        if (sample.size < 3) sample.add(text.slice(Math.max(0, idx - 20), idx + srcHome.length + 20));
        idx = text.indexOf(srcHome, idx + 1);
      }
      if (count) out.push({ section: 'settings', file: rel, count, sample: [...sample] });
    }
    return out;
  }

  /** 导入预览（dry-run）：返回计划（节段 / 冲突 / remap / 兼容性评分），不写任何文件。 */
  async function importPreview(opts, signal) {
    const { home, dshHome } = paths();
    const { zipPath, encrypted, cleanup } = await openExportZip(opts?.sourcePath, opts?.password, signal);
    try {
      const manifest = await readExportManifest(zipPath);
      const entries = await listZip(zipPath);
      const { sections, conflicts } = await buildImportPlan(entries, dshHome);
      const remap = await remapScan(zipPath, manifest, home);
      const compatibility = compatScore(manifest, home);
      const totalFiles = sections.reduce((s, x) => s + x.files, 0);
      const summary = `📦 导入预览 —— 只读，还没动磁盘\n来源: ${manifest.source?.host ?? '未知'}（${manifest.source?.platform ?? '未知平台'}）\n将导入 ${totalFiles} 个文件、${sections.length} 个节段${conflicts.length ? `\n⚠️ 其中 ${conflicts.length} 个目标文件已存在（默认保留本机，不改动已有文件）` : ''}${remap.length ? '\n⚠️ 需要跨机绝对路径 remap（见 remap 列表）' : ''}\n兼容性: ${compatibility.score}/100${compatibility.reasons.length ? `（${compatibility.reasons.join('；')}）` : ''}`;
      return { ok: true, encrypted, manifest, sections, totalFiles, totalBytes: manifest.totalBytes ?? 0, conflicts, remap, compatibility, summary };
    } finally {
      if (cleanup) await cleanup().catch(() => {});
    }
  }

  /** 导入应用：自动快照 → 解压到暂存 → 按决策拷入 → 校验 → 失败回滚。 */
  async function importApply(opts, signal) {
    return withOperationLock('import', () => importApplyInner(opts, signal));
  }

  async function importApplyInner(opts, signal) {
    const { dshHome, root } = paths();
    const { zipPath, encrypted, cleanup } = await openExportZip(opts?.sourcePath, opts?.password, signal);
    let staging = null;
    try {
      const manifest = await readExportManifest(zipPath);
      const entries = await listZip(zipPath);
      // 选节段：显式 opts.sections 则用；否则导入全部非凭据节段（凭据需显式点选，默认不碰）
      const wantedSections = Array.isArray(opts?.sections) && opts.sections.length ? new Set(opts.sections) : null;
      const decisions = opts?.decisions && typeof opts.decisions === 'object' ? opts.decisions : {};
      const fileEntries = entries.filter((e) => !e.isDirectory && e.name !== 'manifest.json');
      const selected = fileEntries.filter((e) => {
        const section = sectionKeyForTop(e.name.split('/')[0]);
        if (section === 'credentials') return wantedSections ? wantedSections.has('credentials') : false;
        return wantedSections ? wantedSections.has(section) : true;
      });
      if (!selected.length) throw new Error('没有可导入的内容（未选中任何节段，或所选节段在包里为空）');

      // 决定写集：默认 keep（目标已存在就跳过，绝不静默覆盖）
      const willWrite = [];
      const willSkip = [];
      for (const e of selected) {
        const targetAbs = `${dshHome}/${e.name}`;
        const exists = await existsStat(targetAbs);
        if (exists && decisions[e.name] !== 'overwrite') { willSkip.push(e.name); continue; }
        willWrite.push({ ...e, targetAbs, conflict: exists });
      }
      if (!willWrite.length) {
        // 全部冲突都选「保留本机」且没有新增文件：这是合法的无操作成功，而非错误。
        // 明确告知没改任何文件，别让用户以为导入失败。
        return {
          ok: true,
          encrypted,
          applied: 0,
          skipped: willSkip.length,
          overwrote: 0,
          snapshot: null,
          remapped: 0,
          summary: `✅ 导入完成（无需写入）\n  所有 ${willSkip.length} 个选中条目都已存在于本机且选择「保留本机」，未改动任何文件。`,
        };
      }

      // 自动快照当前数据（导入前安全网）；失败不阻断，如实告知。
      let snapshotName = null;
      try {
        const snap = await doBackup(undefined, signal, { namePrefix: IMPORT_SNAPSHOT_PREFIX, skipVault: true, skipRotate: true });
        snapshotName = snap.name;
        await prunePrefixedSnapshots(IMPORT_SNAPSHOT_PREFIX, 1, snap.name);
      } catch { /* 快照失败不阻断导入 */ }

      
      // 解压到暂存目录（extractZip 内 Zip Slip/符号链接/zip bomb/CRC 全套防线），再拷入 ~/.dsh
      staging = `${root}/.import-stage-${stampNow()}`;
      await extractZip(zipPath, staging, { names: new Set(willWrite.map((e) => e.name)), signal });
      const stamp = stampNow();
      const backups = [];
      const applied = [];
      const overwrote = [];
      try {
        for (const e of willWrite) {
          if (signal?.aborted) throw new Error('操作已取消');
          await mkdir(dirname(e.targetAbs), { recursive: true });
          if (e.conflict) {
            const keep = `${e.targetAbs}.pre-import-${stamp}`;
            await copyFile(e.targetAbs, keep);
            backups.push({ name: e.name, targetAbs: e.targetAbs, keep });
          }
          await copyFile(`${staging}/${e.name}`, e.targetAbs);
          applied.push(e.name);
          if (e.conflict) overwrote.push(e.name);
        }
      } catch (err) {
        // 回滚：覆盖的先还原留档，新增的删除；回滚再失败则给出快照/留档指引，绝不静默停在半截。
        const failed = [];
        for (const b of backups) {
          try { await copyFile(b.keep, b.targetAbs); } catch { failed.push(b.name); }
        }
        for (const n of applied) {
          if (!backups.some((b) => b.name === n)) await rm(`${dshHome}/${n}`, { force: true }).catch(() => {});
        }
        const snapNote = snapshotName ? `\n已自动快照: ${snapshotName}，可 /backup restore ${snapshotName} 整体回滚。` : '';
        if (failed.length) {
          throw new Error(`导入失败并已尽力回滚：${friendlyReason(err)}。部分留档未还原: ${failed.join(', ')}（对应 *.pre-import-${stamp} 留档在原目录旁）。${snapNote}`);
        }
        throw new Error(`导入失败，已自动回滚到导入前状态：${friendlyReason(err)}。${snapNote}`);
      }

      // 校验：写入的文件必须存在（防半截写入被误判成功）
      const missing = [];
      for (const e of willWrite) if (!(await existsStat(e.targetAbs))) missing.push(e.name);
      if (missing.length) throw new Error(`导入校验失败，部分文件未落盘: ${missing.slice(0, 5).join(', ')}（快照: ${snapshotName ?? '未生成'}）`);

      // 跨机 remap：对写入的文本配置做 from→to 前缀替换（settings / cordis）
      let remapped = 0;
      if (Array.isArray(opts?.remap) && opts.remap.length) {
        for (const m of opts.remap) {
          if (!m || typeof m.from !== 'string' || !m.from || typeof m.to !== 'string') continue;
          for (const rel of ['settings.yaml', 'settings.json', 'cordis.yml', 'cordis.patch.yml']) {
            if (!willWrite.some((e) => e.name === rel)) continue;
            const p = `${dshHome}/${rel}`;
            if (!(await existsStat(p))) continue;
            const text = await readFile(p, 'utf8');
            const next = text.split(m.from).join(m.to);
            if (next !== text) { await writeFile(p, next, 'utf8'); remapped += 1; }
          }
        }
      }

      // 本地 link:/file: 插件迁移：解包 local-plugins tarball 到 ~/.dsh/local-plugins/ 并改回 file:
      const localPluginEntries = entries.filter((e) => !e.isDirectory && e.name.startsWith('local-plugins/'));
      let pluginsRestored = { restored: [], skipped: [] };
      if (localPluginEntries.length && Array.isArray(manifest?.localPlugins)) {
        await extractZip(zipPath, dshHome, { names: new Set(localPluginEntries.map((e) => e.name)), signal });
        pluginsRestored = await restoreLocalPlugins(manifest.localPlugins, signal);
      }

      const summary = `✅ 导入完成\n  已写入: ${applied.length} 个文件（覆盖 ${overwrote.length}、新增 ${applied.length - overwrote.length}、跳过已存在 ${willSkip.length}）${remapped ? `\n  已 remap: ${remapped} 个配置文件` : ''}${pluginsRestored.restored.length ? `\n  本地插件已装回 file:: ${pluginsRestored.restored.map((p) => p.name).join(', ')}` : ''}${pluginsRestored.skipped.length ? `\n  ⚠️ 本地插件需手动处理: ${pluginsRestored.skipped.map((p) => `${p.name}（${p.reason}）`).join(', ')}` : ''}${snapshotName ? `\n  导入前快照: ${snapshotName}` : '\n  ⚠️ 导入前快照未生成（建议确认无误后手动备份一次）'}${backups.length ? `\n  覆盖的旧文件已留档 *.pre-import-${stamp}（确认后可删）` : ''}\n  ⏸️ 待办: 重启 dsh 生效`;
      return { ok: true, encrypted, applied: applied.length, skipped: willSkip.length, overwrote: overwrote.length, snapshot: snapshotName, remapped, pluginsRestored, summary };
    } finally {
      if (staging) await rm(staging, { recursive: true, force: true }).catch(() => {});
      if (cleanup) await cleanup().catch(() => {});
    }
  }

  // ---------- 会话日志体检（doctor） ----------
  //
  // 布局与格式依据宿主内置的 @deepseek-ai/dsh-session-persistence-jsonl：
  //   <会话根>/--<项目目录>--/<编码后 id>/session.jsonl.zstd（compression:'none' 时为 .jsonl）
  // zstd 文件是独立帧的拼接：首帧是带校验和的 SessionHeader 行，其后每个追加批一帧。
  // 两条硬契约都对齐宿主读端：①行级——首行 SessionHeader、seq 连续；②容器级——
  // 首帧解出来恰好一行 header（宿主 assertZstdHeaderFrame；外部工具把整份日志
  // 压成单帧时内容完整可解、宿主却拒载，行级校验覆盖不到，必须单独判）。
  // Node 内置 zstd 解码器不跨帧续读，因此先按 RFC 8878 走帧字节边界
  // （魔数/帧头/块序列/校验和），再逐帧解出逻辑行。检测目标正是社区高频的
  // "corrupt session log"灾难：并发写 seq 撞号、坏帧、尾部截断、单帧重写。
  const ZSTD_MAGIC = 0xfd2fb528;
  // 会话日志文件名 = 宿主 sessionFormatLogFilename 的形态：session[.v<N>].jsonl[.zstd]
  // （N≥1 可多位；无 .vN 后缀即第 0 代）。**代数是文件名的一部分、会随格式换代前进**，
  // 写死具体名字会在换代当天整体失明（#117：v4 机器上 doctor/migrate 一份都看不见），
  // 故按形态匹配，让新代文件至少进入校验/预检流程（代的判定另见迁移预检）。
  const SESSION_LOG_RE = /^session(?:\.v([1-9][0-9]*))?\.jsonl(?:\.zstd)?$/;
  const isSessionLogName = (name) => SESSION_LOG_RE.test(name);
  /** 从会话日志文件名取格式代；非会话日志名返回 null（无 .vN 后缀即 v0）。 */
  function sessionLogVersion(name) {
    const m = SESSION_LOG_RE.exec(name);
    return m ? Number(m[1] ?? 0) : null;
  }
  const SCAN_SKIP_DIRS = new Set(['node_modules', '.system', '.git', 'vault']);
  const SCAN_MAX_FILES = 4000;
  const SCAN_MAX_DEPTH = 8;
  // Node 内置 zstd API 要 v22.15 / v23.8 才进 node:zlib；更老运行时没有这个
  // 导出。必须用命名空间导入 + 运行时探测——具名导入是静态校验的，在缺导出
  // 的运行时上会让整个插件模块加载失败，比少一个体检功能严重得多。
  const HAS_NODE_ZSTD = typeof zlib.zstdDecompressSync === 'function';

  /** 截断超长内容用于缺陷描述。 */
  function snippet(text, max = 60) {
    return text.length > max ? `${text.slice(0, max)}…` : text;
  }

  /**
   * 按 RFC 8878 结构走查拼接帧的字节边界（不解压）：返回 [start,end] 区间数组；
   * 结构不合法（截断/未知魔数/保留位/越界块）抛错。
   * skippable 帧直接判非法——宿主 scanZstdFrames 拒绝一切非数据帧魔数，
   * 这类文件宿主整体拒载，容忍它们会造成「doctor 报 OK、宿主编译系统读不了」。
   */
  function walkZstdFrames(buf) {
    const frames = [];
    let off = 0;
    while (off < buf.length) {
      if (buf.length - off < 4) throw new Error(`尾部截断（余 ${buf.length - off} 字节不成帧）`);
      const magic = buf.readUInt32LE(off);
      if (magic === ZSTD_MAGIC) {
        let pos = off + 4;
        if (pos >= buf.length) throw new Error('帧头描述符缺失');
        const desc = buf[pos++];
        if (desc & 0x08) throw new Error('帧头保留位置位');
        const singleSegment = Boolean(desc & 0x20);
        const checksum = Boolean(desc & 0x04);
        const dictSize = [0, 1, 2, 4][desc & 0x03];
        const fcsSize = singleSegment ? [1, 2, 4, 8][desc >> 6] : [0, 2, 4, 8][desc >> 6];
        if (!singleSegment) pos += 1; // Window_Descriptor
        pos += dictSize + fcsSize;
        if (pos > buf.length) throw new Error('帧头越界');
        let last = false;
        while (!last) {
          if (buf.length - pos < 3) throw new Error('块头截断');
          const bh = buf.readUIntLE(pos, 3);
          last = Boolean(bh & 0x01);
          const btype = (bh >> 1) & 0x03;
          const bsize = bh >> 3;
          if (btype === 3) throw new Error('保留块类型');
          // Raw/Compressed 块占 bsize 字节；RLE 块只占 1 字节
          pos += 3 + (btype === 1 ? 1 : bsize);
          if (pos > buf.length) throw new Error('块数据越界');
        }
        if (checksum) {
          if (buf.length - pos < 4) throw new Error('帧校验和截断');
          pos += 4;
        }
        frames.push([off, pos]);
        off = pos;
      } else if (magic >= 0x184d2a50 && magic <= 0x184d2a5f) {
        throw new Error('遇 skippable 帧——宿主读端不支持任何非数据帧魔数，整个文件将被拒载');
      } else {
        throw new Error(`偏移 ${off} 处不是 zstd 帧魔数`);
      }
    }
    return frames;
  }

  /**
   * 解出 .zstd 会话日志的全部逻辑行；任一帧损坏即抛错（错误含偏移信息）。
   * 同时对首个数据帧做宿主容器契约判定 headerFrameOk——宿主 assertZstdHeaderFrame
   * 是字节精确的：首帧解出必须非空、且首个换行符恰在最后一个字节（即「恰好
   * 一行、以单个 \n 结尾」）。行流拼接校验覆盖不到这条（#66）。
   */
  function decodeZstdLog(buf) {
    const parts = [];
    let frameNo = 0;
    let headerFrameOk;
    for (const [s, e] of walkZstdFrames(buf)) {
      frameNo += 1;
      try {
        const out = zlib.zstdDecompressSync(buf.subarray(s, e));
        parts.push(out);
        if (headerFrameOk === undefined) {
          headerFrameOk = out.length > 0 && out.indexOf(10) === out.length - 1;
        }
      } catch (err) {
        throw new Error(`第 ${frameNo} 帧解压失败（${e - s}B）：${String(err && err.message ? err.message : err)}`);
      }
    }
    return {
      lines: Buffer.concat(parts).toString('utf8').split('\n').filter((l) => l.length > 0),
      headerFrameOk,
    };
  }

  /**
   * 校验逻辑行流：首行必须是 SessionHeader（type:"session"），其后每行是一条存储
   * 记录——裸事件要求 seq 精确连续（events[i].seq === i），packed chunk 行按成员数
   * 推进游标（语义对齐 dsh-session 的 buildRow/expandRow：成员 k 的 seq = seq0+k，
   * 成员数 = texts/args 长度）。返回缺陷描述；无缺陷返回 null。
   */
  function validateSessionLines(lines) {
    let header;
    try {
      header = JSON.parse(lines[0]);
    } catch {
      return `首行不是 JSON（${snippet(String(lines[0]))}）`;
    }
  if (!header || typeof header !== 'object') return '首行不是对象';
  // 行级 SessionHeader 校验对齐宿主 isHeaderLine（0.1.2-rc.1 是 0.1.1-rc.2 的严格
  // 超集——多查 seedLength；以严格者为准覆盖双列车）。宿主读端 isHeaderLine 通过后，
  // fromHeaderLine 还会拒绝退役字段 sandboxMode/approvalPolicy——两者合并即"能否加载"，
  // 故 doctor 全检。字段语义取自 @deepseek-ai/dsh-session-persistence-jsonl format.ts。
  if (header.type !== 'session') return `首行 type 不是 "session"（${snippet(JSON.stringify(header.type) ?? String(header.type))}）`;
  if (typeof header.version !== 'number') return `首行 version 不是 number（${snippet(typeof header.version)}）`;
  if (typeof header.id !== 'string') return '首行 id 不是 string';
  if (typeof header.createdAt !== 'number' || !Number.isSafeInteger(header.createdAt) || header.createdAt < 0 || Object.is(header.createdAt, -0)) return `首行 createdAt 非法（须非负安全整数，实际 ${snippet(String(header.createdAt))}）`;
  if (typeof header.delegationDepth !== 'number' || !Number.isSafeInteger(header.delegationDepth) || header.delegationDepth < 0 || Object.is(header.delegationDepth, -0)) return `首行 delegationDepth 非法（须非负安全整数，实际 ${snippet(String(header.delegationDepth))}）`;
  if (header.seedLength !== undefined && (typeof header.seedLength !== 'number' || !Number.isSafeInteger(header.seedLength) || header.seedLength < 0 || Object.is(header.seedLength, -0))) return '首行 seedLength 非法（须 undefined 或非负安全整数）';
  if (header.origin !== undefined && header.origin !== 'subagent') return '首行 origin 非法（须 undefined 或 "subagent"）';
  if (header.agentPreset !== undefined && typeof header.agentPreset !== 'string') return '首行 agentPreset 非法（须 undefined 或 string）';
  if (Object.hasOwn(header, 'sandboxMode') || Object.hasOwn(header, 'approvalPolicy')) return '首行含退役字段 sandboxMode/approvalPolicy——宿主读端拒绝';
    let nextSeq = 0;
    for (let i = 1; i < lines.length; i++) {
      let rec;
      try {
        rec = JSON.parse(lines[i]);
      } catch {
        return `第 ${i + 1} 行不是合法 JSON（${snippet(String(lines[i]))}）`;
      }
      if (!rec || typeof rec !== 'object') return `第 ${i + 1} 行记录不是对象`;
      if (rec.type === 'text-chunks' || rec.type === 'reasoning-chunks' || rec.type === 'tool-call-chunks') {
        const data = rec.data ?? {};
        const members = Array.isArray(data.texts) ? data.texts.length : Array.isArray(data.args) ? data.args.length : 0;
        if (!Number.isSafeInteger(rec.seq0) || members <= 0) return `第 ${i + 1} 行 packed 行缺少 seq0 或成员列表`;
        if (rec.seq0 !== nextSeq) return `第 ${i + 1} 行 packed 行 seq0=${rec.seq0} 与游标 ${nextSeq} 不接续`;
        nextSeq += members;
      } else if (typeof rec.seq === 'number') {
        if (rec.seq !== nextSeq) return `第 ${i + 1} 行 seq=${rec.seq} 撞号/跳号（期望 ${nextSeq}）`;
        nextSeq = rec.seq + 1;
      }
      // 无 seq 且非 packed 的行（未来格式扩展）：放行，交由宿主自身加载判定
    }
    return null;
  }

  /** 有界递归收集会话日志文件（相对 ~/.dsh 路径）；跳过依赖/系统目录。 */
  async function collectSessionLogs(dir, relPrefix, depth, out, isLogName = isSessionLogName) {
    if (depth > SCAN_MAX_DEPTH || out.length >= SCAN_MAX_FILES) return;
    let dirents;
    try {
      dirents = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // 不可读目录静默跳过（权限/竞态不构成体检故障）
    }
    for (const d of dirents) {
      if (out.length >= SCAN_MAX_FILES) return;
      const rel = relPrefix ? `${relPrefix}/${d.name}` : d.name;
      if (d.isDirectory()) {
        if (SCAN_SKIP_DIRS.has(d.name)) continue;
        await collectSessionLogs(`${dir}/${d.name}`, rel, depth + 1, out, isLogName);
      } else if (isLogName(d.name)) {
        out.push({ abs: `${dir}/${d.name}`, rel });
      }
    }
  }

  /**
   * 单个会话日志体检：非空 → 可解码（zstd 帧走查+逐帧解压，或原样文本）→
   * SessionHeader + 存储记录流校验。返回 { state:'ok' } 或
   * { state:'bad', reason }（缺陷描述）或 { state:'skipped', reason }
   * （无法深度校验：运行时缺 zstd 支持，或文件超过读入上限——不算损坏）。
   */
  async function validateSessionFile(f) {
    try {
      const info = await fsStat(f.abs);
      if (info.size === 0) return { state: 'bad', reason: '空文件（0 字节）' };
      if (f.abs.endsWith('.zstd') && !HAS_NODE_ZSTD) {
        return { state: 'skipped', reason: `运行时 Node（${process.version}）无内置 zstd 解码，跳过深度校验（需 ≥22.15/23.8）` };
      }
      if (info.size > HASH_MAX_BYTES) {
        return { state: 'skipped', reason: `文件 ${Math.floor(info.size / 1048576)}MB 超过深度校验上限（${Math.floor(HASH_MAX_BYTES / 1048576)}MB），不整读入内存` };
      }
      let lines;
      let headerFrameOk;
      if (f.abs.endsWith('.zstd')) {
        ({ lines, headerFrameOk } = decodeZstdLog(await readFile(f.abs)));
        // 容器契约（#66/#1047）：首帧必须解出「恰好一行 header、以单个换行
        // 结尾」（字节精确，对齐宿主 assertZstdHeaderFrame）。单帧重写、帧内
        // 多余空行、缺行尾的文件内容完整可解、行级校验全过，宿主却整体拒载。
        if (headerFrameOk === false) {
          return { state: 'bad', reason: '首帧不是恰好一行 header——违反容器契约（首帧应解出一行 SessionHeader 且以单个换行结尾；单帧重写/多余空行/缺行尾的典型形态，宿主读端会拒载）' };
        }
      } else {
        lines = (await readFile(f.abs, 'utf8')).split('\n').filter((l) => l.length > 0);
      }
      if (!lines.length) return { state: 'bad', reason: '解出的逻辑行为空' };
      const defect = validateSessionLines(lines);
      return defect === null ? { state: 'ok' } : { state: 'bad', reason: defect };
    } catch (err) {
      return { state: 'bad', reason: String(err && err.message ? err.message : err) };
    }
  }

  function summarizeDoctorScan(r, opts = {}) {
    if (!r.files.length) return '未找到任何会话日志——可能还没有产生过会话，或布局与预期不同。';
    const healthy = r.scanned - r.corruptCount - (r.skippedCount ?? 0);
    let head = `扫描 ${r.scanned} 个会话日志：${healthy} 健康、${r.corruptCount} 损坏`;
    if (r.skippedCount) head += `、${r.skippedCount} 个未能深度校验（运行时缺 zstd 支持或文件过大）`;
    if (!r.corruptCount) return `✅ ${head}`;
    const shown = r.corrupt.slice(0, 15);
    const more = r.corrupt.length > shown.length ? `\n  …另有 ${r.corrupt.length - shown.length} 个损坏文件` : '';
    const detail = shown.map((c) => `  ❌ ${c.rel}\n     ${c.reason}`).join('\n');
    // 修复入口按调用面分流：聊天面指聊天命令；面板没有 doctor UI，指到真实可用路径
    const hint = opts.repairHint ?? '可从备份定点修复：/backup doctor --repair [前缀|latest]（修复前会把损坏文件留档为 *.corrupt-*）';
    return `${head}\n${detail}${more}\n\n${hint}`;
  }

  /** 只读扫描 ~/.dsh 下全部会话日志；不写任何文件。 */
  async function runDoctorScan(signal) {
    const { dshHome } = paths();
    if (signal?.aborted) throw new Error('操作已取消');
    const found = [];
    await collectSessionLogs(dshHome, '', 0, found);
    const files = [];
    for (const f of found) {
      if (signal?.aborted) throw new Error('操作已取消');
      const verdict = await validateSessionFile(f);
      files.push({ rel: f.rel, ok: verdict.state === 'ok', skipped: verdict.state === 'skipped', reason: verdict.reason });
    }
    const corrupt = files.filter((x) => !x.ok && !x.skipped);
    const skippedCount = files.filter((x) => x.skipped).length;
    return { scanned: files.length, files, corrupt, corruptCount: corrupt.length, skippedCount };
  }

  // ---------- 迁移预检（migrate-check） ----------
  //
  // 预测「宿主升级 / 旧会话被再次打开」后哪些会话会打不开。宿主的会话格式迁移
  // 是读时触发的纯函数：任何 open 都会跑迁移解码，写开再把旧代日志发布成 v3
  // 新代文件——旧代文件永不改写，POSIX 硬链接原子发布（exFAT 等无硬链接文件
  // 系统在这一步 ENOTSUP，官方讨论 #6358）。本预检把宿主
  // @deepseek-ai/dsh-session-format* 的冻结事件清单与静态拒绝规则烤入本地
  // （0.1.5-rc.2 校准，与 0.11.2 对齐 isHeaderLine 同一套路），覆盖"解析即判"
  // 的规则；需要重放迁移过程的规则（chunk 折叠溯源、引用重映射、worker 复核）
  // 不在覆盖范围，结果里如实标注。三层判定：fail=会话将打不开；migratable=
  // 旧代但静态规则全过（首次写开会发布当前代新文件）；ok=已是当前代。
  //
  // **校准代（#117）**：宿主会随格式换代推进文件名与 header 的 version（0.1.7 起
  // 为 v4——迁移包只到 `v3-to-v4`、无 `v4-to-v5`）。此常数是本插件**规则**覆盖到的
  // 最高代，换代时须同步更新；比它更新的日志只提示、不判"打不开"（见
  // newer-generation）——"宿主读不读得了"取决于宿主版本，不是我们这张注定滞后的表。
  const MIGRATE_CALIBRATED_VERSION = 4;
  // 冻结事件清单（RELEASED_V0_EVENT_TYPES / RELEASED_V2_EVENT_TYPES，宿主
  // 按契约不增长旧代清单）；migration 对清单外类型连 ignorable 也拒（#6355）。
  const MIGRATE_V0_EVENT_TYPES = new Set(['agent-preset/selected', 'agent/inbox/spliced', 'approval/asked', 'approval/decided', 'approval/policy', 'assistant/chunk', 'assistant/message', 'command/done', 'command/run', 'compaction/end', 'compaction/prune', 'compaction/start', 'compaction/summary', 'feedback/record', 'goal/change', 'hook/invoked', 'hook/result', 'llm/retry', 'llm/retry-started', 'model/selection', 'permission/preset', 'plan/mode', 'request/context', 'request/header', 'sandbox/mode', 'schedule/change', 'session-log-deepseek/delivery-accepted', 'session/end-seed', 'session/title', 'session/title-llm-request', 'step/end', 'step/start', 'subagent/descriptor', 'subagent/model-selection-policy', 'team/member', 'team/message/delivered', 'team/message/queued', 'team/task', 'todo/write', 'tool-workflow/agent-end', 'tool-workflow/agent-start', 'tool-workflow/run-end', 'tool-workflow/run-start', 'tool/call', 'tool/code-dispatch', 'tool/code-dispatch-start', 'tool/result', 'turn/end', 'turn/start', 'user/message', 'web/deepseek-search-llm-request']);
  const MIGRATE_V2_EVENT_TYPES = new Set(['agent-preset/selected', 'agent/inbox/spliced', 'approval/asked', 'approval/decided', 'approval/policy', 'assistant/attempt', 'assistant/message', 'command/done', 'command/run', 'compaction/end', 'compaction/prune', 'compaction/start', 'compaction/summary', 'feedback/record', 'goal/change', 'hook/invoked', 'hook/result', 'llm/retry', 'llm/retry-started', 'model/selection', 'permission/preset', 'plan/mode', 'request/context', 'request/header', 'sandbox/mode', 'schedule/change', 'session-log-deepseek/delivery-accepted', 'session/end-seed', 'session/title', 'session/title-llm-request', 'step/end', 'step/start', 'subagent/descriptor', 'subagent/model-selection-policy', 'team/member', 'team/message/delivered', 'team/message/queued', 'team/task', 'todo/write', 'tool-workflow/agent-end', 'tool-workflow/agent-start', 'tool-workflow/run-end', 'tool-workflow/run-start', 'tool/call', 'tool/code-dispatch', 'tool/code-dispatch-start', 'tool/result', 'turn/end', 'turn/start', 'user/message', 'web/deepseek-search-llm-request']);
  /** v0 侧退役类型（pre-react-loop 预发布形态；宿主点名拒绝）。 */
  const MIGRATE_V0_RETIRED_TYPES = new Set(['request/header-delta', 'mode/set']);
  /** 消息来源 kind 白名单（v3 侧 15 类；未知 kind 在 v2→v3 边被拒——#6355 主症状）。 */
  /**
   * 「消息来源 kind」的**已知**集合（#113）。注意语义：宿主的 `source.kind` 是
   * **可合并扩展的联合类型**——每个生产者在自己的模块里声明自己的 kind，没有
   * 统一的兜底值，所以任何硬编码清单都**不可能完整**。这里的集合因此只当"已知
   * 名单"用：命中的静默通过，没命中的记一条**提示**（不再判为"打不开"，见
   * 下方 unknown-source-kind）——真正会拒载的是旧代**事件类型**的冻结清单。
   *
   * 内容来自宿主 `@deepseek-ai/dsh-session-format-v3-to-v4` 自带的
   * `RENAMED_PRODUCERS` 取值与 `RELEASED_SAME_NAME_PRODUCERS` 名单
   * （2026-09-29 从 0.2.0-rc.1 实装包逐行核对），外加 `producerKind()` 的兜底
   * 形态 `plugin:<插件名>`（用前缀匹配，见 MIGRATE_KIND_KNOWN）。
   */
  const MIGRATE_SOURCE_KINDS = new Set(['user', 'plugin', 'model', 'tool', 'agent-instructions', 'session-reference', 'team-message', 'goal', 'skill-invocation', 'skill-catalog', 'coordinator', 'subagent-report', 'subagent-settled', 'webhook', 'agent-message', 'compact-checkpoint', 'ptc-mode', 'compact-basic', 'runtime-context', 'system-prompt', 'model-selection', 'plan-mode', 'time-context', 'tmux-context', 'user-approval', 'repeat-tool-reminder', 'tool-cordis', 'cordis-host-runner', 'tool-goal', 'tool-jobs', 'hooks-codex', 'hooks-claude-code', 'schedule', 'dsh-session-title-llm', 'fallback', 'provider']);
  const MIGRATE_MAX_FINDINGS = 3;
  /** kind 是否在已知名单内：精确命中，或宿主兜底形态 `plugin:<插件名>`（可任意长尾，故用前缀判定）。 */
  const MIGRATE_KIND_KNOWN = (kind) => MIGRATE_SOURCE_KINDS.has(kind) || kind.startsWith('plugin:');

  /** 非代文件名（未来扩展）返回 null；代的判定与 doctor 共用 SESSION_LOG_RE。 */
  function migrateFilenameVersion(fileName) {
    return sessionLogVersion(fileName);
  }

  /**
   * 对一个解出的逻辑行流做迁移静态判定。header 解析失败返回 null（交给
   * doctor 的损坏判定，这里不重复报）。返回 { sourceVersion, findings, total }
   * ——findings 截断到前 MIGRATE_MAX_FINDINGS 条，total 是全量计数。
   */
  function migrateAnalyzeLines(lines, fileVersion) {
    let header;
    try {
      header = JSON.parse(lines[0]);
    } catch {
      return null;
    }
    if (!header || typeof header !== 'object' || typeof header.version !== 'number') return null;
    const sourceVersion = header.version;
    const findings = [];
    const warnings = [];
    let total = 0;
    const fail = (rule, detail) => {
      total += 1;
      if (findings.length < MIGRATE_MAX_FINDINGS) findings.push({ rule, detail });
    };
    // 提示（不判"打不开"）：用于**开放集合**上的命中失败——最典型的是
    // source.kind（可合并扩展的联合类型，硬编码清单天生补不全，#113）。
    const warn = (rule, detail) => {
      if (warnings.length < MIGRATE_MAX_FINDINGS) warnings.push({ rule, detail });
    };
    if (sourceVersion > MIGRATE_CALIBRATED_VERSION) {
      // 更新的格式代：本插件的规则表对它是盲区，但"能不能读"由宿主决定（同代/更新可读、
      // 降级运行被拒）——按开放集合纪律只提示、不替宿主下"打不开"的判决（#117/#113）。
      warn('newer-generation', `header version=${sourceVersion} 高于本插件校准到的 v${MIGRATE_CALIBRATED_VERSION}——日志由更新的格式代写出。能否打开取决于宿主：宿主同代或更新即可读，**降级运行会被拒**；若你的宿主已是这一代，说明本插件校准滞后，欢迎反馈。仅提示，不判为打不开`);
      return { sourceVersion, findings, warnings, total };
    }
    if (fileVersion !== null && fileVersion !== sourceVersion) {
      fail('name-version-mismatch', `文件名标 v${fileVersion}，header 标 v${sourceVersion}——宿主按不一致直接拒载`);
      return { sourceVersion, findings, warnings, total };
    }
    // 事件行静态规则。seq 游标语义与 validateSessionLines 一致：v0 有 packed 行
    //（一条行多个 chunk），v1 起一行一事件。
    let nextSeq = 0;
    for (let i = 1; i < lines.length; i++) {
      let rec;
      try {
        rec = JSON.parse(lines[i]);
      } catch {
        fail('bad-json', `第 ${i + 1} 行不是合法 JSON（${snippet(String(lines[i]))}）`);
        continue;
      }
      if (!rec || typeof rec !== 'object') continue;
      const type = typeof rec.type === 'string' ? rec.type : undefined;
      const isPacked = type === 'text-chunks' || type === 'reasoning-chunks' || type === 'tool-call-chunks';
      // seq 密度：宿主要求 seq 与位置严格一致（手工改号不同步引用即打不开——#6348 根因）
      if (isPacked) {
        const members = Array.isArray(rec.data?.texts) ? rec.data.texts.length : Array.isArray(rec.data?.args) ? rec.data.args.length : 0;
        nextSeq += Math.max(members, 0);
      } else if (typeof rec.seq === 'number') {
        if (rec.seq !== nextSeq) fail('seq-gap', `第 ${i + 1} 行 seq=${rec.seq}，期望 ${nextSeq}——seq 与位置不一致，宿主判 non-dense seq 拒载`);
        nextSeq = rec.seq + 1;
      }
      if (sourceVersion === 0 && type) {
        if (MIGRATE_V0_RETIRED_TYPES.has(type)) fail('retired-type', `第 ${i + 1} 行 ${type} 是预发布退役类型，迁移点名拒绝`);
        else if (!MIGRATE_V0_EVENT_TYPES.has(type)) fail('unknown-type-v0', `第 ${i + 1} 行事件类型 "${type}" 不在 v0 冻结清单——迁移连 ignorable 也拒（第三方插件注入的历史事件，#6297/#6355）`);
        if (type === 'request/header' && rec.data?.reason === 'fallback') fail('request-fallback', `第 ${i + 1} 行 request/header reason="fallback" 是预发布遗留，迁移拒绝`);
        if (type === 'subagent/descriptor' && rec.data?.version !== 3) fail('descriptor-version', `第 ${i + 1} 行 subagent/descriptor version=${JSON.stringify(rec.data?.version)}——迁移只认 3（0.1.0/0.1.1 写的是 2，#6297/#6045 主症状）`);
        if (type === 'permission/preset') {
          const keys = Object.keys(rec.data ?? {});
          if (!keys.every((k) => k === 'preset') || typeof rec.data?.preset !== 'string' || !rec.data.preset) fail('permission-preset-members', `第 ${i + 1} 行 permission/preset data 含 preset 之外的成员（如 origin）或 preset 非非空字符串——0.1.1 起写入 origin 的历史日志，迁移拒绝（#6297）`);
        }
      }
      if (sourceVersion === 2 && type && !MIGRATE_V2_EVENT_TYPES.has(type)) fail('unknown-type-v2', `第 ${i + 1} 行事件类型 "${type}" 不在 v2 冻结清单——v2→v3 无法安全变换（ignorable 也拒）`);
      if (sourceVersion === 2 && (type === 'tool/code-dispatch' || type === 'tool/code-dispatch-start')) fail('ptc-reserved-v2', `第 ${i + 1} 行 ${type} 是 v3 保留 PTC 标签，v2→v3 拒绝（ignorable 也拒）`);
      if ((sourceVersion === 2 || sourceVersion === 3) && type === 'request/header' && rec.data?.header?.system !== undefined) fail('retired-header-system', `第 ${i + 1} 行 request/header 携带退役的 header.system——v2→v3 无法保留时序地提升它${sourceVersion === 3 ? '，当前代读取同样拒绝' : ''}`);
      const kind = rec?.data?.source?.kind;
      // kind 只作提示，不作判据（#113）：宿主把它设计成可合并扩展的联合类型，
      // 每个生产者（含任意社区插件）都能加自己的 kind，且生产端对未知 kind 照读
      // ——旧实现把"不在白名单"直接判成"打不开"，在一台真实机器上把 81/82 份
      // 完全健康的日志报成不可打开。
      if (typeof kind === 'string' && !MIGRATE_KIND_KNOWN(kind)) {
        warn('unknown-source-kind', `第 ${i + 1} 行消息来源 kind="${kind}" 不在已知名单（宿主为可合并扩展的联合类型，官方/社区插件都能新增）——仅提示，不判为打不开；真正会拒载的是旧代事件类型不在冻结清单内`);
      }
    }
    return { sourceVersion, findings, warnings, total };
  }

  /**
   * 单文件迁移预检：解码（复用 doctor 的帧走查）→ 判代 → 静态规则。
   * 返回 { verdict: 'fail'|'migratable'|'ok'|'skipped', version, findings, warnings, total, reason }——
   * findings 是"判为打不开"的硬伤，warnings 是开放集合上的命中失败（如未知
   * source.kind），只提示不改变 verdict（#113）。
   */
  async function migrateAnalyzeFile(f) {
    const fileVersion = migrateFilenameVersion(f.abs.split('/').pop());
    try {
      const info = await fsStat(f.abs);
      if (info.size === 0) return { verdict: 'fail', version: fileVersion, findings: [{ rule: 'empty', detail: '空文件（0 字节）' }], total: 1 };
      if (f.abs.endsWith('.zstd') && !HAS_NODE_ZSTD) return { verdict: 'skipped', version: fileVersion, findings: [], total: 0, reason: `运行时无内置 zstd 解码（需 Node ≥22.15/23.8），跳过预检` };
      if (info.size > HASH_MAX_BYTES) return { verdict: 'skipped', version: fileVersion, findings: [], total: 0, reason: '文件超过读入上限，未预检' };
      let lines;
      if (f.abs.endsWith('.zstd')) ({ lines } = decodeZstdLog(await readFile(f.abs)));
      else lines = (await readFile(f.abs, 'utf8')).split('\n').filter((l) => l.length > 0);
      if (!lines.length) return { verdict: 'fail', version: fileVersion, findings: [{ rule: 'empty', detail: '解出的逻辑行为空' }], total: 1 };
      const r = migrateAnalyzeLines(lines, fileVersion);
      if (!r) return { verdict: 'skipped', version: fileVersion, findings: [], total: 0, reason: 'header 行不可解析——按损坏处理（doctor 体检覆盖），迁移预检跳过' };
      if (r.total > 0) return { verdict: 'fail', version: r.sourceVersion, findings: r.findings, warnings: r.warnings, total: r.total };
      return { verdict: r.sourceVersion < MIGRATE_CALIBRATED_VERSION ? 'migratable' : 'ok', version: r.sourceVersion, findings: [], warnings: r.warnings, total: 0 };
    } catch (err) {
      return { verdict: 'skipped', version: fileVersion, findings: [], total: 0, reason: `解码失败（${String(err && err.message ? err.message : err)}）——doctor 体检会按损坏处理` };
    }
  }

  /** .credentials.yaml 是否还是扁平布局（顶层无 version 键）——宿主首次读档会原子替换成 version:1 且不可逆（#6358：旧宿主读不回 versioned）。 */
  async function credentialsIsFlatLayout(dshHome) {
    let text;
    try {
      text = await readFile(`${dshHome}/.credentials.yaml`, 'utf8');
    } catch {
      return false; // 不存在/读不了 → 无事可做
    }
    if (!text.trim()) return false;
    return !/^version\s*:/m.test(text) && !/^"version"\s*:/m.test(text);
  }

  /** 凭据哨兵：把扁平布局的凭据文件存进 vault/preserved（保留最近 3 份），返回存档路径。 */
  async function preserveFlatCredentials() {
    const { dshHome, root } = paths();
    if (!(await credentialsIsFlatLayout(dshHome))) return null;
    // 与备份侧的 vault 刷新共用串行锁：并发写入同一 vault 目录互相踩（ENOTEMPTY）
    return withVaultLock(async () => {
      const dir = `${root}/${VAULT_DIR}/${PRESERVED_DIR}`;
      await mkdir(dir, { recursive: true });
      const dest = `${dir}/credentials-flat-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.yaml`;
      await copyFile(`${dshHome}/.credentials.yaml`, dest);
      // 轮换：只留最近 3 份（按文件名时间戳排序即时间序）
      const old = (await readdir(dir)).filter((n) => n.startsWith('credentials-flat-')).sort();
      for (const n of old.slice(0, Math.max(old.length - 3, 0))) await rm(`${dir}/${n}`, { force: true });
      return dest;
    });
  }

  /** 环境级探测：硬链接支持（v3 发布用 fs.link，exFAT 等会 ENOTSUP）+ 凭据布局。 */
  async function migrateProbeEnvironment() {
    const { dshHome, root } = paths();
    const env = { hardlink: true, hardlinkNote: null, credentialsFlat: false, credentialsPreserved: null };
    const probe = `${dshHome}/.dsh-backup-migrate-probe-${process.pid}`;
    try {
      await writeFile(probe, 'dsh-backup link probe');
      try {
        await link(probe, `${probe}.lnk`);
      } finally {
        await rm(`${probe}.lnk`, { force: true });
        await rm(probe, { force: true });
      }
    } catch (err) {
      env.hardlink = false;
      env.hardlinkNote = String(err && err.code ? err.code : err);
    }
    env.credentialsFlat = await credentialsIsFlatLayout(dshHome);
    if (env.credentialsFlat) {
      try {
        env.credentialsPreserved = await preserveFlatCredentials();
      } catch { /* 哨兵失败不阻塞预检：vault 不可写等，摘要里仍会提示 */ }
    }
    return env;
  }

  /** 只读扫描：全部代文件迁移静态预检 + 环境探测；不写会话文件。 */
  async function runMigrateCheck(signal) {
    const { dshHome, root } = paths();
    if (signal?.aborted) throw new Error('操作已取消');
    const found = [];
    await collectSessionLogs(dshHome, '', 0, found);
    const sessions = [];
    for (const f of found) {
      if (signal?.aborted) throw new Error('操作已取消');
      sessions.push({ rel: f.rel, ...(await migrateAnalyzeFile(f)) });
    }
    const env = await migrateProbeEnvironment();
    const fails = sessions.filter((s) => s.verdict === 'fail');
    const migratable = sessions.filter((s) => s.verdict === 'migratable');
    const skipped = sessions.filter((s) => s.verdict === 'skipped');
    const warned = sessions.filter((s) => (s.warnings?.length ?? 0) > 0);
    const lines = [];
    lines.push(`扫描 ${sessions.length} 个会话日志（v0 起各代，按文件名代判定）：${fails.length} 个升级后将打不开、${migratable.length} 个旧代待迁移（静态规则全过）、${skipped.length} 个未能判定${warned.length ? `、${warned.length} 个带提示（不影响打开）` : ''}`);
    if (fails.length) {
      lines.push('');
      for (const s of fails.slice(0, 15)) {
        lines.push(`  ❌ ${s.rel}（v${s.version}）`);
        for (const fd of s.findings) lines.push(`     · [${fd.rule}] ${fd.detail}`);
        if (s.total > s.findings.length) lines.push(`     …另有 ${s.total - s.findings.length} 处问题`);
      }
      if (fails.length > 15) lines.push(`  …另有 ${fails.length - 15} 个文件`);
      lines.push('');
      lines.push('升级前建议：先拍一份升级前快照（/backup），坏的会话可从更早归档定点修复（/backup doctor --repair）。');
    }
    if (warned.length) {
      lines.push('');
      lines.push(`ℹ️ ${warned.length} 个日志带提示（**不计入"打不开"**，逐条看原因）：`);
      for (const s of warned.slice(0, 5)) {
        for (const w of s.warnings) lines.push(`  · ${s.rel}：${w.detail}`);
      }
      if (warned.length > 5) lines.push(`  …另有 ${warned.length - 5} 个文件`);
    }
    if (!env.hardlink) {
      lines.push('');
      lines.push(`⚠️ 文件系统不支持硬链接（${env.hardlinkNote}）——宿主发布新代文件会失败（官方 #6358 场景）：旧会话读得了、写开就报错，且升级无法继续。建议把 ~/.dsh 挪回 APFS/ext4 等本地文件系统。`);
    }
    if (env.credentialsFlat) {
      lines.push('');
      lines.push(`⚠️ .credentials.yaml 还是旧扁平布局——宿主下次读档会把它原子替换成 version:1（不可逆，旧宿主将读不回）。${env.credentialsPreserved ? `已自动存底：${env.credentialsPreserved.replace(`${root}/`, '')}` : '自动存底失败（vault 不可写？），建议立即手动 /backup 一次。'}`);
    }
    lines.push('');
    lines.push(`覆盖说明：以上为静态规则判定（宿主 ${detectHostTrain() || '未知列车'} 校准；格式代校准到 v${MIGRATE_CALIBRATED_VERSION}）。需要重放迁移过程的检查（chunk 折叠溯源、引用重映射、发布前 worker 复核）不在本版覆盖内——静态全过仍可能在新代发布时被宿主拒载。`);
    const head = fails.length || !env.hardlink || env.credentialsFlat ? '⚠️' : '✅';
    return {
      scanned: sessions.length,
      sessions: sessions.map((s) => ({ rel: s.rel, verdict: s.verdict, version: s.version, total: s.total, findings: s.findings, ...(s.warnings?.length ? { warnings: s.warnings } : {}), ...(s.reason ? { reason: s.reason } : {}) })),
      env,
      failCount: fails.length,
      migratableCount: migratable.length,
      skippedCount: skipped.length,
      warningCount: warned.length,
      summary: `${head} ${lines.join('\n')}`,
    };
  }

  /**
   * 定点修复：扫描出损坏的会话日志后，从指定归档（缺省最新一份，须通过
   * sha256 校验）里提取同名条目覆盖。只动损坏的文件本身——不做整库 aside
   * 切换；每个被覆盖的损坏文件先就地留档为 `<原名>.corrupt-<时间戳>`。
   * 归档里没有对应条目的文件列入 unrecoverable（提示改用全量恢复）。
   */
  async function runDoctorRepair(selector, signal) {
    return withOperationLock('doctor-repair', () => runDoctorRepairInner(selector, signal));
  }

  async function runDoctorRepairInner(selector, signal) {
    const { home, dshHome, root } = paths();
    const scan = await runDoctorScan(signal);
    if (!scan.corruptCount) return { repaired: [], unrecoverable: [], stillBad: [], scanned: scan.scanned, summary: summarizeDoctorScan(scan) };

    const picked = await pickArchive(selector || 'latest');
    const v = await verifyOne(picked.name, home, signal);
    if (!v.ok) throw new Error(`归档校验未通过（${v.note}），定点修复已中止`);
    // 加密归档的定点修复暂不支持：doctor 定点修复直接从归档解出单个会话文件，
    // 解密整包再解压的成本与泄密面都更高（明文临时 tar.gz）。这里给清晰指引而非
    // 让 tar 去啃密文报一堆英文。用户可在面板先恢复（支持口令解密），或用未加密归档。
    if (await isArchiveEncrypted(picked.name)) {
      throw new Error('定点修复暂不支持加密归档——请在设置面板用「恢复」先解密恢复，或选一份未加密归档（dsh- 开头且无 🔒）再修复');
    }
    const base = dshHome.split('/').pop();
    const parent = dshHome.slice(0, -(base.length + 1)) || '/';
    const entries = await safeArchiveEntries(picked.name, signal);
    const entrySet = new Set(entries);

    const targets = [];
    const unrecoverable = [];
    for (const c of scan.corrupt) {
      const entry = `${base}/${c.rel}`;
      if (entrySet.has(entry)) targets.push({ ...c, entry });
      else unrecoverable.push(c.rel);
    }

    // 覆盖前留档损坏现场：文件名即证据链（seq 撞号样本对排查宿主 bug 有价值）
    const stamp = stampNow();
    const kept = [];
    for (const t of targets) {
      const keep = `${dshHome}/${t.rel}.corrupt-${stamp}`;
      await mkdir(dirname(keep), { recursive: true });
      await copyFile(`${dshHome}/${t.rel}`, keep);
      kept.push(keep);
    }

    // #131（Windows）：bsdtar 遇到「同名已存在对象」会拒绝覆盖（附件对象/硬链接
    // 目标与活树同名时刷 `Can't unlink already-existing object` 并整条非零退出）。
    // 改为「解到备份目录下的暂存区 → 只把目标文件 copyFile 到位」，与平台 tar 的
    // 覆盖语义解耦；同时 guard 住「targets 为空时会退化成整包解压」的危险路径。
    let stage = null;
    try {
      if (targets.length) {
        stage = `${root}/.repair-stage-${stamp}`;
        await mkdir(stage, { recursive: true });
        const tar = await ctx.subprocess.resolveExecutable('tar');
        await spawnRun([tar, '-xzf', picked.name, '-C', stage, ...targets.map((t) => t.entry)], root, signal);
        for (const t of targets) {
          const dest = `${dshHome}/${t.rel}`;
          await mkdir(dirname(dest), { recursive: true });
          await copyFile(`${stage}/${t.entry}`, dest);
        }
      }
    } catch (err) {
      const restored = new Set();
      for (let i = 0; i < targets.length; i++) {
        try {
          await copyFile(kept[i], `${dshHome}/${targets[i].rel}`);
          restored.add(targets[i].rel);
        } catch { /* 单个还原失败：落入下方如实报告 */ }
      }
      if (restored.size === targets.length) {
        throw new Error(`定点修复失败：${friendlyReason(err)}。已从留档还原全部损坏现场，数据保持修复前状态，可处理后重试`);
      }
      const missing = targets.filter((t) => !restored.has(t.rel)).map((t) => t.rel);
      throw new Error(`定点修复失败：${friendlyReason(err)}，且部分现场未自动还原: ${missing.join(', ')}。对应的 *.corrupt-${stamp} 留档仍在原目录旁，手工拷回原位即可`);
    } finally {
      if (stage) await rm(stage, { recursive: true, force: true }).catch(() => {});
    }

    // 修完复检：从归档解出的副本必须健康，否则如实报告（skipped 不算失败——
    // 缺 zstd 支持的运行时根本检不出 zstd 文件损坏，能进 targets 的都是可校验的）
    const stillBad = [];
    for (const t of targets) {
      const verdict = await validateSessionFile({ abs: `${dshHome}/${t.rel}`, rel: t.rel });
      if (verdict.state === 'bad') stillBad.push(`${t.rel}（${verdict.reason}）`);
    }

    const lines = [`🩹 定点修复完成（来源: ${picked.name}）`];
    if (targets.length) lines.push(`  已恢复 ${targets.length} 个文件${stillBad.length ? '' : '，复检全部健康'}`);
    for (const k of kept) lines.push(`  损坏现场已留档: ${k}`);
    if (unrecoverable.length) lines.push(`  ⚠️ 归档中无对应副本、无法定点修复: ${unrecoverable.join(', ')}`);
    if (stillBad.length) lines.push(`  ❌ 修复后复检仍异常: ${stillBad.join('; ')}`);
    lines.push('  请重启 dsh 后确认会话历史加载正常。');
    return { repaired: targets.map((t) => t.rel), unrecoverable, stillBad, scanned: scan.scanned, summary: lines.join('\n') };
  }

  // ---------- 自动备份与 GitHub 同步状态（落盘，重启续跑） ----------
  let autoDispose = null;
  let autoHours = 0;
  // 每周调度（P3）：[{ day: 1-7 (1=周一..7=周日), time: 'HH:MM' }]，可多个。
  // 与 autoHours 互斥：设置 weekly 时 autoHours 归 0（反之亦然）。空数组=未设置。
  let weeklySchedules = [];
  let lastAuto = null;
  let lastAutoAt = null;
  let githubState = { repo: null, lastPush: null, lastError: null };
  // 上次见到的宿主列车（detectHostTrain 代理值）：null=尚未记录（首启动只记
  // 录不拍快照），非 null 且变化 → 升/降级 → 自动拍 dsh-pre-upgrade- 快照。
  let lastTrain = null;
  // 增长：CLI 回执的 star 提示只出现一次（持久化在 auto.json；旧版读未知字段安全忽略）
  let starHinted = false;
  // #103 循环防护三件套：
  //  - lastAutoAttemptAt：每次自动备份**起跑即记**（不等到成功）。写盘后即使进程
  //    被强杀（重活干到一半被杀正是本 issue 的形态），下次启动也知道"刚试过"，
  //    不会以 delay≤0 立刻重跑；旧版读未知字段安全忽略。
  //  - newestArchiveAt：备份目录里最新归档的 mtime，调度锚点的最终兜底——磁盘上
  //    躺着新归档就说明不必马上再打一份，避免锚点丢失导致的重跑。
  //  - lastAutoError：上次失败原因（成功即清），让"备份一直在失败"这件事在
  //    /backup 与面板上可见，而不是只躺在没人看的宿主日志里。
  let lastAutoAttemptAt = null;
  let newestArchiveAt = 0;
  let lastAutoError = null;
  // 连续失败次数（内存态）：失败重试按 30min × 2^(n-1) 退避、封顶一个周期，
  // 避免确定性失败（磁盘满/权限）变成每 30 分钟烧一次 CPU 的热循环。
  let autoFailStreak = 0;
  // 无人值守的重活串行队列：开机补跑与列车快照可能同时到点，两份 GB 级 tar
  // 并行会把机器彻底压死。手动备份/恢复快照是用户在等结果的显式操作，不入队。
  let heavyChain = Promise.resolve();
  function enqueueHeavy(task) {
    const next = heavyChain.then(task, task);
    heavyChain = next.then(() => {}, () => {});
    return next;
  }

  /**
   * 旧默认目录 → 新默认目录的一次性改名（0.14.0）。
   *
   * 只处理「从未配置过 destination」的用户：≤0.13.4 的默认值
   * `~/Desktop/dsh-backups` 同盘 rename 成 `~/Desktop/DSH Backups`——原子、
   * 不拷贝数据、不丢备份；用户显式配置过的目录一律不碰。迁移失败时
   * paths() 的兜底逻辑会继续用老目录，功能不受影响。
   */
  async function migrateLegacyDefaultDir() {
    const cfg = resolvedConfig();
    if (cfg.destination !== DEFAULTS.destination) return;
    const { home } = paths();
    const expandHome = (p) => (p.startsWith('~') ? `${home}${p.slice(1)}` : p);
    const target = expandHome(DEFAULTS.destination);
    if (pathExists(target)) {
      // 新旧目录同时存在（用户手动建过新目录，或迁移后手动放回了老目录）：
      // 继续用新默认目录，老目录不自动合并——只提示一次，避免静默丢视角。
      if (LEGACY_DEFAULT_DESTINATIONS.some((p) => pathExists(expandHome(p)))) {
        console.warn(`[dsh-backup] 检测到旧备份目录与 ${DEFAULTS.destination} 同时存在，继续使用新目录；旧目录里的备份如需保留请手动移入`);
      }
      return;
    }
    for (const legacyRaw of LEGACY_DEFAULT_DESTINATIONS) {
      const legacy = expandHome(legacyRaw);
      if (!pathExists(legacy)) continue;
      try {
        await rename(legacy, target);
        console.log(`[dsh-backup] 备份目录已改名为 ${DEFAULTS.destination}（旧版默认名不再使用；可在设置面板自定义位置）`);
      } catch (err) {
        console.warn(`[dsh-backup] 备份目录改名失败，继续使用旧目录 ${legacyRaw}: ${String(err && err.message ? err.message : err)}`);
      }
      return;
    }
  }

  /**
   * 等待 settings 用户层加载完成（describe 出现 revision）。启动钩子若在
   * settings 装配完成前运行，resolvedConfig 会拿到 base 默认值——升级快照
   * 就会落进默认目录而不是用户配置的目的地（e2e 实测的分裂写场景）。
   * 注意两段等待：先等 services 异步装配出 settingsService（ctx.inject 的
   * 回调在宿主组合期才触发），再等用户层装载出 revision。全程无 settings
   * 的 profile（headless 等）等满上限后按默认目的地继续——钩子是异步的，
   * 不阻塞装配。
   */
  async function waitForSettingsReady(capMs = 10000) {
    const t0 = Date.now();
    while (!settingsService && Date.now() - t0 < capMs) {
      await new Promise((r) => setTimeout(r, 100));
    }
    while (settingsService && Date.now() - t0 < capMs) {
      try {
        const desc = describeOwn(settingsService, NS);
        if (desc && typeof desc.revision === 'number') return;
      } catch { /* 未就绪，继续等 */ }
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  /** 自动备份的保留份数：config.keep 支配（未配置时 <24h 3 份、否则 7 份）。 */
  function autoKeep() {
    const cfg = resolvedConfig();
    const k = Number(cfg.keep);
    return Number.isFinite(k) && k > 0 ? Math.floor(k) : (autoHours >= 24 ? 7 : 3);
  }

  // 启动钩子与备份链路可能并发保存 auto.json（多实例/多 profile 亦然）——
  // 并发 writeFile 同一路径会撕裂（实测产出 A+B 拼接体）。走"临时文件 +
  // 原子改名"：读者要么见到旧完整文件、要么见到新完整文件，绝不撕裂；
  // 与宿主 settings 持久化的 writeFileAtomic 同一模式。
  async function saveAutoState() {
    const { root } = paths();
    const target = `${root}/auto.json`;
    // 临时名用 UUID：时间戳+实例内序号在"多实例同毫秒启动"时仍会撞名
    // （先到者 rename 走，后到者 ENOENT），UUID 跨实例唯一
    const tmp = `${target}.${randomUUID()}.tmp`;
    try {
      await writeOwned(tmp, `${JSON.stringify({ hours: autoHours, weekly: weeklySchedules, lastAutoAt, github: githubState, lastTrain, starHinted, lastAutoAttemptAt, lastAutoError })}\n`);
      await rename(tmp, target);
    } catch (err) {
      await rm(tmp, { force: true }).catch(() => {});
      throw err;
    }
  }

  /**
   * 磁盘上最新全量归档的 mtime（#103 兜底锚点）：锚点丢失/不前进时，只要备份
   * 目录里躺着新归档就不该马上再打一份——这是"失败→重跑→再失败"死循环的
   * 第二道断路（第一道是 lastAutoAttemptAt）。口径与 listBackups 一致：
   * 只看用户可见的全量归档，不含内部快照与分类型归档。
   */
  async function refreshNewestArchiveAt() {
    const { root } = paths();
    let dirents;
    try {
      dirents = await readdir(root, { withFileTypes: true });
    } catch {
      return; // 备份目录还没有/不可读：锚点保持 0
    }
    let newest = 0;
    for (const d of dirents) {
      if (!d.name.startsWith('dsh-') || !d.name.endsWith('.tar.gz')) continue;
      if (SNAPSHOT_PREFIXES.some((p) => d.name.startsWith(p)) || d.name.startsWith(TYPED_PREFIX)) continue;
      try {
        const st = await fsStat(`${root}/${d.name}`);
        if (st.mtimeMs > newest) newest = st.mtimeMs;
      } catch { /* 与轮换/删除竞态：忽略 */ }
    }
    newestArchiveAt = newest;
  }

  async function loadAutoState() {
    try {
      const { root } = paths();
      const parsed = JSON.parse(await readFile(`${root}/auto.json`, 'utf8'));
      const h = Number(parsed?.hours);
      if (parsed?.github && typeof parsed.github === 'object') {
        githubState = {
          repo: typeof parsed.github.repo === 'string' ? parsed.github.repo : null,
          lastPush: typeof parsed.github.lastPush === 'string' ? parsed.github.lastPush : null,
          lastError: typeof parsed.github.lastError === 'string' ? parsed.github.lastError : null,
        };
      }
      // lastAutoAt 是「上次执行」时间戳，不可能在未来。未来日期（注入或时钟
      // 漂移）会使 nextAutoAt 算出超大延迟、auto 静默失效却仍显示已开启，
      // 故一律视为非法 → null，从当前时间起算 catch-up。
      const lastTs = typeof parsed?.lastAutoAt === 'string' ? Date.parse(parsed.lastAutoAt) : NaN;
      lastAutoAt = Number.isNaN(lastTs) || lastTs > Date.now() ? null : parsed.lastAutoAt;
      const attTs = typeof parsed?.lastAutoAttemptAt === 'string' ? Date.parse(parsed.lastAutoAttemptAt) : NaN;
      lastAutoAttemptAt = Number.isNaN(attTs) || attTs > Date.now() ? null : parsed.lastAutoAttemptAt;
      lastTrain = typeof parsed?.lastTrain === 'string' && parsed.lastTrain ? parsed.lastTrain : null;
      starHinted = parsed?.starHinted === true;
      const e = parsed?.lastAutoError;
      lastAutoError = e && typeof e === 'object' && typeof e.message === 'string'
        ? { at: typeof e.at === 'string' ? e.at : '', message: e.message }
        : null;
      // weekly（P3）：数组形态，每项 { day: 1-7, time: 'HH:MM' }；非法项过滤
      weeklySchedules = Array.isArray(parsed?.weekly)
        ? parsed.weekly.filter((s) => s && typeof s === 'object' && Number.isInteger(Number(s.day)) && Number(s.day) >= 1 && Number(s.day) <= 7 && /^\d{2}:\d{2}$/.test(String(s.time || '')))
          .map((s) => ({ day: Number(s.day), time: String(s.time) }))
        : [];
      // 旧版写的 auto.json 没有这些字段 → 全部按缺失处理，行为与旧版一致
      await refreshNewestArchiveAt();
      return Number.isFinite(h) && h >= 1 && h <= 720 ? Math.floor(h) : 0;
    } catch (err) {
      // ENOENT = 首次使用还没有 auto.json，是正常初始状态，静默按未配置处理；
      // 其他读取失败（解析错误/权限）才值得告警，且文案要给"影响 + 出路"。
      if (err && err.code !== 'ENOENT') {
        console.warn(`[dsh-backup] 自动备份计划文件读取失败，定时备份已暂停（不影响已有备份）：执行 /backup auto <小时数> 可重新开启（${String(err && err.message ? err.message : err)}）`);
      }
      await refreshNewestArchiveAt();
      return 0;
    }
  }

  /** 调度锚点（毫秒）：上次成功 / 磁盘最新归档，取最晚者；皆无则 0。 */
  function autoAnchorAt() {
    return Math.max(Number(new Date(lastAutoAt)) || 0, newestArchiveAt || 0);
  }

  /** 调度是否开启：每小时或每周任一模式非空即开启。 */
  function autoEnabled() {
    return autoHours > 0 || weeklySchedules.length > 0;
  }

  /** 下一个每周触发时刻（毫秒）；无 weekly 返回 Infinity。 */
  function nextWeeklyOccurrence(now = Date.now()) {
    let best = Infinity;
    for (const s of weeklySchedules) {
      const hh = Number(String(s.time || '').slice(0, 2));
      const mm = Number(String(s.time || '').slice(3, 5));
      const day = Number(s.day);
      if (!Number.isFinite(hh) || !Number.isFinite(mm) || !Number.isInteger(day) || day < 1 || day > 7) continue;
      const dow = day === 7 ? 0 : day; // ISO(1=周一..7=周日) → JS getDay(0=周日..6=周六)
      const base = new Date(now);
      const addDays = (dow - base.getDay() + 7) % 7;
      const cand = new Date(base);
      cand.setDate(cand.getDate() + addDays);
      cand.setHours(hh, mm, 0, 0);
      if (cand.getTime() < now) cand.setDate(cand.getDate() + 7); // 本周该时刻已过 → 下周
      if (cand.getTime() < best) best = cand.getTime();
    }
    return best;
  }

  /** 下次自动备份触发时间（毫秒）：每小时与每周取更早者；无锚点从当前时间起算。 */
  function nextAutoAt() {
    let at = Infinity;
    if (autoHours > 0) at = Math.max(autoAnchorAt() + autoHours * 3600 * 1000, Date.now());
    if (weeklySchedules.length) at = Math.min(at, nextWeeklyOccurrence());
    return at === Infinity ? Date.now() : at;
  }

  /** 本地时间显示：YYYY-MM-DD HH:mm——不依赖运行时 locale（裸跑环境会落 en-US）。 */
  function formatWhen(ts) {
    const d = new Date(ts);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  /** 失败提示（若有）：让"备份一直在失败"在 /backup 与面板上可见，而不是只躺在宿主日志里。 */
  function autoErrorNote() {
    if (!lastAutoError) return '';
    const when = lastAutoError.at ? formatWhen(Date.parse(lastAutoError.at)) : '';
    const msg = lastAutoError.message.length > 200 ? `${lastAutoError.message.slice(0, 200)}…` : lastAutoError.message;
    return `\n⚠️ 上次自动备份未完成${when ? `（${when}）` : ''}：${msg}`;
  }

  function autoSummary() {
    if (!autoDispose) return `自动备份未开启（/backup auto <N小时> 开启，或 /backup auto weekly <周几-时:分>）${autoErrorNote()}`;
    // 绝对节奏：下次 = 锚点 + 周期；错过（重启间隔超周期）则按现在显示，调度会在启动宽限后补跑。
    const mode = weeklySchedules.length
      ? `每周 ${weeklySchedules.map((s) => `${s.day}-${s.time}`).join('、')}`
      : `每 ${autoHours} 小时一次`;
    return `自动备份已开启：${mode}（已持久化，重启续跑），下次 ${formatWhen(nextAutoAt())}${lastAuto ? `；上次自动备份: ${lastAuto}` : ''}${autoErrorNote()}`;
  }

  /**
   * 链式 timeout 调度：每次触发后按锚点推算下一次，重启后节奏不重置。
   * #103 两条断路，缺一不可：
   *  1. boot 宽限——启动路径的首次触发绝不落在宿主 boot 窗口内（delay≤0 的补跑
   *     正是把 GB 级 tar 塞进 boot 窗口、拖垮 HostRpc 的元凶）；
   *  2. 尝试冷却——上次**起跑**（不要求成功）之后 30 分钟（失败按 2^n 退避）内
   *     不再起跑。锚点落盘，所以"干到一半被强杀 → 下次启动又立刻重跑"的循环断开。
   */
  function scheduleAuto(opts = {}) {
    // 关闭竞态保护：auto off 时 in-flight 备份完成后的续链会以 autoHours=0
    // 算出 delay=0，形成无限备份循环——关闭后绝不续链。
    if (!autoEnabled()) return;
    const cycle = autoHours > 0 ? autoHours * 3600 * 1000 : 7 * 24 * 3600 * 1000;
    let delay = nextAutoAt() - Date.now();
    const attemptAt = Number(new Date(lastAutoAttemptAt)) || 0;
    const cooldown = autoFailStreak > 0
      ? Math.min(AUTO_RETRY_MS * 2 ** (autoFailStreak - 1), cycle)
      : AUTO_RETRY_MS;
    if (attemptAt) delay = Math.max(delay, attemptAt + cooldown - Date.now());
    if (opts.boot) delay = Math.max(delay, AUTO_BOOT_GRACE_MS);
    autoDispose = ctx.timeout(async () => {
      // 无人值守重活串行：与列车快照等其它无人值守任务排队，不并行抢机器
      await enqueueHeavy(runAutoBackup);
      scheduleAuto();
    }, delay);
  }

  async function runAutoBackup() {
    // 起跑留痕（先写盘再干活）：进程被强杀也不丢"刚试过"这个事实，
    // 下次启动据此冷却，不会在 boot 窗口里重跑（#103）。
    lastAutoAttemptAt = new Date().toISOString();
    await saveAutoState().catch(() => { /* 记录失败不阻断备份本身 */ });
    try {
      const r = await doBackup(autoKeep());
      lastAuto = r.path.split('/').pop();
      lastAutoAt = new Date().toISOString();
      lastAutoError = null;
      autoFailStreak = 0;
      newestArchiveAt = Date.now();
      await saveAutoState();
      console.log(`[dsh-backup] 自动备份完成: ${r.path} (sha ${r.sha.slice(0, 12)}…)`);
    } catch (err) {
      // 失败不再"只推进内存锚点"（旧实现不落盘 → 每次启动 delay≤0 重跑，
      // 3GB 归档必然失败时就是无限重跑；#103）。改记失败原因 + 退避重试，
      // 由 lastAutoAttemptAt（已落盘）负责跨重启冷却。
      autoFailStreak += 1;
      const message = String(err && err.message ? err.message : err);
      lastAutoError = { at: new Date().toISOString(), message };
      await saveAutoState().catch(() => { /* 失败路径写盘也可能失败，不影响内存退避 */ });
      console.error(`[dsh-backup] 自动备份失败（第 ${autoFailStreak} 次，${Math.round(Math.min(AUTO_RETRY_MS * 2 ** (autoFailStreak - 1), autoHours * 3600 * 1000) / 60000)} 分钟后重试）: ${message}`);
    }
  }

  async function setAuto(h) {
    if (autoDispose) { autoDispose(); autoDispose = null; }
    autoHours = h;
    weeklySchedules = []; // 每小时与每周互斥：设置每小时即清掉每周调度
    // 开启/重设 = 用户要一次基线备份：清掉旧锚点与失败退避，让下次触发落在"现在"
    lastAutoAt = null;
    lastAutoAttemptAt = null;
    newestArchiveAt = 0;
    autoFailStreak = 0;
    lastAutoError = null;
    if (autoEnabled()) scheduleAuto();
    await saveAutoState();
  }

  /** 校验并归一化每周调度列表：[{ day: 1-7, time: 'HH:MM' }]；非法返回原因。 */
  function normalizeWeekly(schedules) {
    if (schedules === undefined || schedules === null || schedules === '') return { value: [] };
    if (!Array.isArray(schedules)) return { error: 'weekly 需为 [{ day: 1-7, time: "HH:MM" }] 数组（1=周一..7=周日）' };
    const out = [];
    const seen = new Set();
    for (const s of schedules) {
      if (!s || typeof s !== 'object') return { error: 'weekly 每项需为 { day, time } 对象' };
      const day = Number(s.day);
      const time = String(s.time || '');
      if (!Number.isInteger(day) || day < 1 || day > 7) return { error: `weekly 的 day 需为 1-7（1=周一..7=周日），收到 ${s.day}` };
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) return { error: `weekly 的 time 需为 HH:MM（00:00-23:59），收到 ${s.time}` };
      const key = `${day}-${time}`;
      if (seen.has(key)) continue; // 去重
      seen.add(key);
      out.push({ day, time });
    }
    return { value: out };
  }

  /** 设置每周调度（可多个）；空数组=关闭每周模式。与每小时互斥：设置后 autoHours 归 0。 */
  async function setWeekly(schedules) {
    const n = normalizeWeekly(schedules);
    if (n.error) return { ok: false, summary: n.error };
    if (autoDispose) { autoDispose(); autoDispose = null; }
    weeklySchedules = n.value;
    if (weeklySchedules.length) autoHours = 0;
    lastAutoAt = null;
    lastAutoAttemptAt = null;
    newestArchiveAt = 0;
    autoFailStreak = 0;
    lastAutoError = null;
    if (autoEnabled()) scheduleAuto();
    await saveAutoState();
    return { ok: true, weekly: weeklySchedules, summary: weeklySchedules.length ? `每周备份已开启：${weeklySchedules.map((s) => `${s.day}-${s.time}`).join('、')}\n${autoSummary()}` : '自动备份已关闭。' };
  }

  // ---------- 磁盘占用报告 + 分级清理（P3） ----------
  // 报告归档/快照/同步副本/缓存/暂存各自占用；一键清理只删**可再生缓存**与
  // **过期备份**，快照与同步数据永不删（它们是不可再生的安全网）。

  async function diskUsage() {
    const { root } = paths();
    const cat = { archives: 0, typed: 0, snapshots: 0, sync: 0, vault: 0, cache: 0, other: 0 };
    const files = { archives: 0, typed: 0, snapshots: 0, sync: 0, vault: 0, cache: 0, other: 0 };
    async function du(dir) {
      let total = 0;
      let count = 0;
      let dirents;
      try { dirents = await readdir(dir, { withFileTypes: true }); } catch { return { total, count }; }
      for (const d of dirents) {
        if (d.isDirectory()) {
          const sub = await du(`${dir}/${d.name}`);
          total += sub.total; count += sub.count;
        } else if (d.isFile()) {
          try { total += (await fsStat(`${dir}/${d.name}`)).size; } catch { /* 竞态忽略 */ }
          count += 1;
        }
      }
      return { total, count };
    }
    let dirents;
    try { dirents = await readdir(root, { withFileTypes: true }); } catch { dirents = []; }
    for (const d of dirents) {
      const name = d.name;
      const isFile = d.isFile();
      const size = isFile ? await fsStat(`${root}/${name}`).then((s) => s.size, () => 0) : 0;
      if (name === '.github-sync') { const s = await du(`${root}/${name}`); cat.sync += s.total; files.sync += s.count; }
      else if (name === 'vault') { const s = await du(`${root}/${name}`); cat.vault += s.total; files.vault += s.count; }
      else if (name.startsWith('.import-stage-') || name.startsWith('.export-') || name.startsWith('.decrypt-') || name.startsWith('.pull-')) { cat.cache += size; files.cache += 1; }
      else if (SNAPSHOT_PREFIXES.some((p) => name.startsWith(p))) { cat.snapshots += size; files.snapshots += 1; }
      else if (name.startsWith(TYPED_PREFIX) && name.endsWith('.tar.gz')) { cat.typed += size; files.typed += 1; }
      else if (name.startsWith('dsh-') && name.endsWith('.tar.gz')) { cat.archives += size; files.archives += 1; }
      else if (isFile) { cat.other += size; files.other += 1; }
    }
    const labels = { archives: '全量归档', typed: '分类型归档', snapshots: '内部快照', sync: '同步副本', vault: '凭据 vault', cache: '缓存/暂存', other: '其他' };
    const categories = Object.keys(cat).map((k) => ({ key: k, label: labels[k], bytes: cat[k], files: files[k] }));
    const total = categories.reduce((s, c) => s + c.bytes, 0);
    const mb = (b) => `${(b / 1048576).toFixed(1)}MB`;
    const lines = categories.filter((c) => c.bytes > 0).map((c) => `  ${c.label}: ${mb(c.bytes)}（${c.files} 个）`);
    return { total, totalText: mb(total), categories, summary: `磁盘占用（备份目录）: 共 ${mb(total)}\n${lines.join('\n') || '  （空）'}` };
  }

  /** 分级清理：'cache' 只删可再生缓存/暂存；'expired' 再删过期备份（快照/同步/vault 永不删）。 */
  async function cleanup(scope, signal) {
    const { root } = paths();
    const removed = [];
    const rmdir = (dir) => rm(`${root}/${dir}`, { recursive: true, force: true });
    // 可再生缓存/暂存：永远安全删除
    let dirents;
    try { dirents = await readdir(root, { withFileTypes: true }); } catch { dirents = []; }
    for (const d of dirents) {
      const n = d.name;
      if (n.startsWith('.import-stage-') || n.startsWith('.export-') || n.startsWith('.decrypt-') || n.startsWith('.pull-')) {
        await rm(`${root}/${n}`, { recursive: true, force: true });
        removed.push(n);
      }
    }
    if (scope === 'expired') {
      // 过期备份：keep 窗口外且不在日/周/月/年分层保护内的全量归档才删
      const keepN = defaultKeep();
      const all = await listBackups();
      const tail = all.slice(keepN);
      const cfg = resolvedConfig();
      const gfsProtect = gfsProtectedSet(tail, all[0]?.name, {
        monthly: Number(cfg.gfsMonthly) > 0 ? Math.floor(Number(cfg.gfsMonthly)) : 0,
        yearly: Number(cfg.gfsYearly) > 0 ? Math.floor(Number(cfg.gfsYearly)) : 0,
      });
      const tierProtect = tierProtectedSet(tail, all[0]?.name);
      const stale = tail.filter((b) => !tierProtect.has(b.name) && !gfsProtect.has(b.name)).map((b) => b.name);
      if (stale.length) {
        await removeFiles(stale.flatMap((n) => sidecarsFor(n)), root, signal);
        removed.push(...stale);
      }
    }
    return { ok: true, removed: removed.length, names: removed, summary: removed.length ? `已清理 ${removed.length} 项（快照/同步/vault 未动）:\n${removed.slice(0, 10).map((n) => `  ${n}`).join('\n')}` : '没有可清理的内容（快照/同步/vault 永不删）。' };
  }

  // ---------- 操作锁：状态 + 回收入口（P3） ----------
  async function lockStatus() {
    const { root } = paths();
    const lockPath = `${root}/${LOCK_FILE}`;
    try {
      const lock = JSON.parse(await readFile(lockPath, 'utf8'));
      return { held: true, stale: isLockStale(lock), pid: lock.pid, operation: lock.operation, startedAt: lock.startedAt, heartbeatAt: lock.heartbeatAt };
    } catch (err) {
      if (err && err.code === 'ENOENT') return { held: false, stale: false, pid: null, operation: null, startedAt: null, heartbeatAt: null };
      return { held: true, stale: false, pid: null, operation: 'unreadable', startedAt: null, heartbeatAt: null };
    }
  }

  async function reclaimLockEntry(force) {
    const { root } = paths();
    const r = await reclaimOplock(`${root}/${LOCK_FILE}`, { force: force === true });
    return { ok: r.reclaimed, summary: r.reclaimed ? `操作锁已回收${r.heldBy ? `（原 pid=${r.heldBy.pid}，operation=${r.heldBy.operation}）` : ''}` : (r.reason || '回收失败'), heldBy: r.heldBy ?? null };
  }

  // ---------- Profiles 管理（P4b-1：list/create/rename/delete/launch/stop） ----------
  // 「应用自己的 desktop profile」与面板所在的 web profile 都是宿主内置、只读：
  // 官方说明应用运行期间命令行改不了它——本插件对二者只标注 app-owned，拒绝任何写/启停。
  const APP_OWNED_PROFILES = new Set(['desktop', 'web']);
  /** 独立实例的运行态（内存态 Map：name → { child, pid, startedAt }）。 */
  const runningProfiles = new Map();

  function profilesDir() {
    return `${paths().dshHome}/profiles`;
  }

  /** 校验 profile 名（拒绝空/路径段/非法字符/保留名）。 */
  function validateProfileName(name) {
    if (typeof name !== 'string' || !name.trim()) return 'profile 名不能为空';
    if (!/^[A-Za-z0-9._-]+$/.test(name)) return `profile 名只能含字母数字 . _ -（收到 ${name}）`;
    if (APP_OWNED_PROFILES.has(name)) return `profile ${name} 是应用内置 profile，只读不可改`;
    return null;
  }

  async function profilesList() {
    const dir = profilesDir();
    let dirents;
    try { dirents = await readdir(dir, { withFileTypes: true }); } catch { return []; }
    const out = [];
    for (const d of dirents) {
      if (!d.isDirectory()) continue;
      let meta = null;
      try { meta = JSON.parse(await readFile(`${dir}/${d.name}/package.json`, 'utf8')); } catch { meta = null; }
      const appOwned = APP_OWNED_PROFILES.has(d.name);
      out.push({
        name: d.name,
        version: meta?.version ?? null,
        appOwned,
        readonly: appOwned,
        running: runningProfiles.has(d.name),
        pid: runningProfiles.get(d.name)?.pid ?? null,
      });
    }
    return out.sort((a, b) => (a.name < b.name ? -1 : 1));
  }

  async function profileCreate(name) {
    const err = validateProfileName(name);
    if (err) return { ok: false, summary: err };
    const dir = `${profilesDir()}/${name}`;
    if (await existsStat(dir)) return { ok: false, summary: `profile ${name} 已存在` };
    await mkdir(dir, { recursive: true });
    await writeOwned(`${dir}/package.json`, `${JSON.stringify({ name, version: '0.1.0', private: true })}\n`);
    await writeOwned(`${dir}/cordis.yml`, '# dsh-backup 从内置模板创建的空 profile\n# 在此写插件条目，然后 dsh web --profile <name> 启动\n');
    return { ok: true, name, summary: `已创建 profile: ${name}（模板：package.json + cordis.yml）` };
  }

  async function profileRename(oldName, newName) {
    const errOld = validateProfileName(oldName);
    if (errOld) return { ok: false, summary: errOld };
    const errNew = validateProfileName(newName);
    if (errNew) return { ok: false, summary: errNew };
    const dir = profilesDir();
    if (!(await existsStat(`${dir}/${oldName}`))) return { ok: false, summary: `profile ${oldName} 不存在` };
    if (await existsStat(`${dir}/${newName}`)) return { ok: false, summary: `目标 ${newName} 已存在` };
    await rename(`${dir}/${oldName}`, `${dir}/${newName}`);
    return { ok: true, from: oldName, to: newName, summary: `已把 profile ${oldName} 改名为 ${newName}` };
  }

  /** 硬删（二次确认语义由客户端/CLI --yes 承担；宿主绝不删内置 profile）。 */
  async function profileDelete(name) {
    const err = validateProfileName(name);
    if (err) return { ok: false, summary: err };
    const dir = `${profilesDir()}/${name}`;
    if (!(await existsStat(dir))) return { ok: false, summary: `profile ${name} 不存在` };
    if (runningProfiles.has(name)) return { ok: false, summary: `profile ${name} 有正在运行的独立实例，请先 stop 再删除` };
    await rm(dir, { recursive: true, force: true });
    return { ok: true, name, summary: `已硬删 profile: ${name}（不可恢复）` };
  }

  /** 启动独立实例：detached + unref，绝不把宿主进程拖死；找不到 dsh 给人话。 */
  async function profileLaunch(name) {
    const err = validateProfileName(name);
    if (err) return { ok: false, summary: err };
    const dir = `${profilesDir()}/${name}`;
    if (!(await existsStat(dir))) return { ok: false, summary: `profile ${name} 不存在` };
    if (runningProfiles.has(name)) return { ok: true, pid: runningProfiles.get(name).pid, running: true, summary: `profile ${name} 已在运行（pid=${runningProfiles.get(name).pid}）` };
    let dsh;
    try {
      dsh = await ctx.subprocess.resolveExecutable('dsh');
    } catch {
      return { ok: false, summary: '找不到 dsh 命令——请先安装 DeepSeek Harness CLI（npm i -g @deepseek-ai/dsh）或从官方入口启动' };
    }
    try {
      const child = spawn(dsh, ['web', '--profile', name], { detached: true, stdio: 'ignore', cwd: profilesDir() });
      child.unref();
      child.on('exit', () => { runningProfiles.delete(name); });
      runningProfiles.set(name, { child, pid: child.pid, startedAt: new Date().toISOString() });
      return { ok: true, pid: child.pid, running: true, summary: `已启动独立实例 ${name}（pid=${child.pid}）` };
    } catch (err) {
      return { ok: false, summary: `启动失败: ${friendlyReason(err)}` };
    }
  }

  /** 停止独立实例（运行态按钮翻转）。 */
  async function profileStop(name) {
    const r = runningProfiles.get(name);
    if (!r) return { ok: true, running: false, summary: `profile ${name} 没有正在运行的独立实例（或已退出）` };
    try { r.child.kill(); } catch { /* 可能已退出 */ }
    runningProfiles.delete(name);
    return { ok: true, running: false, summary: `已停止独立实例 ${name}（pid=${r.pid}）` };
  }

  // ---------- 本地 link:/file: 插件迁移（P4b-1） ----------
  /** 单个插件打包上限：>100MB 跳过并警告（避免导出包被巨型 node_modules 撑爆）。 */
  const PLUGIN_PACK_MAX_BYTES = 100 * 1024 * 1024;

  /** 递归计算目录大小（用于 100MB 门槛）。 */
  async function dirSize(dir) {
    let total = 0;
    let dirents;
    try { dirents = await readdir(dir, { withFileTypes: true }); } catch { return 0; }
    for (const d of dirents) {
      if (d.isDirectory()) total += await dirSize(`${dir}/${d.name}`);
      else if (d.isFile()) total += await fsStat(`${dir}/${d.name}`).then((s) => s.size, () => 0);
    }
    return total;
  }

  /**
   * 扫描 profile 依赖里 link:/file: 的本地开发插件，npm pack 打包成 tarball。
   * 返回 [{ profile, name, spec, status, tarballName?, tarballPath?, warning? }]。
   * status: packed=已打包 / too-big=超 100MB 跳过 / npm-missing=无 npm 回退 / missing=路径不存在 / pack-failed。
   */
  async function scanLocalPlugins(signal) {
    const { dshHome, root } = paths();
    const result = [];
    const profilesRoot = `${dshHome}/profiles`;
    let dirents;
    try { dirents = await readdir(profilesRoot, { withFileTypes: true }); } catch { return result; }
    for (const d of dirents) {
      if (!d.isDirectory()) continue;
      const profile = d.name;
      let pkg;
      try { pkg = JSON.parse(await readFile(`${profilesRoot}/${profile}/package.json`, 'utf8')); } catch { continue; }
      const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
      for (const [name, spec] of Object.entries(deps)) {
        if (typeof spec !== 'string') continue;
        const m = /^(link|file):(.*)$/.exec(spec);
        if (!m) continue;
        const ref = m[2];
        const abs = ref.startsWith('/') || /^[A-Za-z]:/.test(ref) ? ref : `${profilesRoot}/${profile}/${ref}`;
        const resolved = resolve(abs);
        if (!(await existsStat(resolved))) {
          result.push({ profile, name, spec, status: 'missing', warning: `本地插件 ${name} 路径不存在（${spec}）` });
          continue;
        }
        if (await dirSize(resolved) > PLUGIN_PACK_MAX_BYTES) {
          result.push({ profile, name, spec, status: 'too-big', warning: `本地插件 ${name} 超过 100MB，跳过打包（新机需手动装）` });
          continue;
        }
        let npm;
        try { npm = await ctx.subprocess.resolveExecutable(IS_WIN ? 'npm.cmd' : 'npm'); }
        catch { result.push({ profile, name, spec, status: 'npm-missing', warning: '本机无 npm，保留原 spec（新机需手动装）' }); continue; }
        const packDir = `${root}/.plugin-pack-${stampNow()}`;
        await mkdir(packDir, { recursive: true });
        try {
          const r = await spawnRun([npm, 'pack', resolved, '--pack-destination', packDir], dshHome, signal);
          const tarballName = r.out.trim().split('\n').filter((l) => l.endsWith('.tgz')).pop()?.trim();
          if (!tarballName) throw new Error('npm pack 未产出 .tgz');
          result.push({ profile, name, spec, status: 'packed', tarballName, tarballPath: `${packDir}/${tarballName}` });
        } catch (err) {
          result.push({ profile, name, spec, status: 'pack-failed', warning: `npm pack 失败（${String(err && err.message ? err.message : err).slice(0, 120)}）` });
        }
      }
    }
    return result;
  }

  /** 导入侧：把打包的本地插件解包到 `<dshHome>/local-plugins/<name>/` 并改回 file:。 */
  async function restoreLocalPlugins(localPlugins, signal) {
    const { dshHome, root } = paths();
    const restored = [];
    const skipped = [];
    for (const p of Array.isArray(localPlugins) ? localPlugins : []) {
      if (p.status !== 'packed' || !p.tarballName) { skipped.push({ name: p.name, reason: p.warning || p.status }); continue; }
      // 导入包内 tarball 已随 export 打进了 ZIP（importApply 解压到暂存后经 names 落盘到 dshHome 下）
      const src = `${dshHome}/local-plugins/${p.tarballName}`;
      if (!(await existsStat(src))) { skipped.push({ name: p.name, reason: 'tarball 不在导入包内' }); continue; }
      const targetDir = `${dshHome}/local-plugins/${p.name}`;
      await mkdir(targetDir, { recursive: true });
      const tar = await ctx.subprocess.resolveExecutable('tar');
      await spawnRun([tar, '-xzf', src, '-C', parentTar(targetDir)], dshHome, signal);
      // 把 profile 的 package.json 里 link:/file: 改回 file: 指向解包目录
      const pkgPath = `${dshHome}/profiles/${p.profile}/package.json`;
      try {
        const pkg = JSON.parse(await readFile(pkgPath, 'utf8'));
        for (const field of ['dependencies', 'devDependencies']) {
          if (pkg[field] && typeof pkg[field] === 'object' && pkg[field][p.name]) {
            pkg[field][p.name] = `file:${targetDir}`;
          }
        }
        await writeOwned(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
      } catch { /* package.json 改不了就跳过，如实标注 */ }
      restored.push({ name: p.name, profile: p.profile, dir: targetDir });
    }
    return { restored, skipped };
  }

  // ---------- /backup 命令 ----------
  ctx.commands.register({
    name: 'backup',
    description: '备份/恢复 DSH 数据；子命令: list | verify [前缀|all] | restore <前缀|latest> [--dry-run] [--sync-deps] | doctor [--repair <前缀|latest>] | migrate-check | auto [N小时|off] | github status|sync|pull|repo|token <token|off> | market list|search|install | foreign list|preview|import | rewind list|preview|apply | chat list|preview|import | check-update | update [--profile <名>] | [--keep N]',
    handler: async (invocation) => {
      const input = invocation.rawInput.trim();
      try {
        const parts = input.split(/\s+/).filter(Boolean);
        const head = parts[0] || '';
        const { home } = paths();

        if (head === 'market') {
          const sub = parts[1] || 'list';
          if (sub === 'list' || sub === 'search') {
            const r = sub === 'search'
              ? await marketSearch(parts.slice(2).join(' '), invocation.signal)
              : await marketList(invocation.signal);
            const lines = r.entries.map((e) => `  ${e.id}  ${e.name}${e.risk === 'high' ? '  ⚠️高风险' : ''}${e.source ? `  来源:${e.source}` : ''}`);
            return { kind: 'success', text: `${r.summary}${lines.length ? `\n${lines.join('\n')}\n\n安装：/backup market install <id> [--yes]` : ''}` };
          }
          if (sub === 'install') {
            const id = parts[2];
            if (!id) return { kind: 'error', text: '用法：/backup market install <id> [--yes]' };
            const r = await marketInstall({ id, confirm: parts.includes('--yes') }, invocation.signal);
            return { kind: r.ok === false ? 'error' : 'success', text: r.summary };
          }
          return { kind: 'error', text: '用法：/backup market list | search <q> | install <id> [--yes]' };
        }

        if (head === 'foreign') {
          const sub = parts[1] || 'list';
          if (sub === 'list') {
            const r = await foreignSources();
            const lines = r.sources.map((s) => `  ${s.detected ? '✅' : '·'} ${s.id}  ${s.label}${s.detected ? `（技能 ${s.skills} · 指令 ${s.instructions ? '有' : '无'} · MCP ${s.mcpServers.length}）` : ''}`);
            return { kind: 'success', text: `${r.summary}\n${lines.join('\n')}\n\n预览：/backup foreign preview <id>；导入：/backup foreign import <id> [--yes]` };
          }
          if (sub === 'preview' || sub === 'import') {
            const sourceId = parts[2];
            if (!sourceId) return { kind: 'error', text: `用法：/backup foreign ${sub} <来源 id>${sub === 'import' ? ' [--yes]' : ''}` };
            const r = sub === 'preview'
              ? await foreignPreview({ source: sourceId }, invocation.signal)
              : await foreignImport({ source: sourceId, confirm: parts.includes('--yes') }, invocation.signal);
            return { kind: r.ok === false ? 'error' : 'success', text: r.summary };
          }
          return { kind: 'error', text: '用法：/backup foreign list | preview <id> | import <id> [--yes]' };
        }

        if (head === 'rewind') {
          const sub = parts[1] || 'list';
          if (sub === 'list') {
            const r = await sessionRewindList(invocation.signal);
            const lines = r.sessions.map((s) => `  ${s.id}  ${s.cwd ? `项目 ${s.cwd}` : ''}  ${s.file}`);
            return { kind: 'success', text: `${r.summary}${lines.length ? `\n${lines.join('\n')}\n\n预览：/backup rewind preview <id> [seq]；分叉：/backup rewind apply <id> [seq] [--yes]` : ''}` };
          }
          if (sub === 'preview' || sub === 'apply') {
            const id = parts[2];
            if (!id) return { kind: 'error', text: `用法：/backup rewind ${sub} <会话 id> [seq]${sub === 'apply' ? ' [--yes]' : ''}` };
            const seqArg = parts[3] && !parts[3].startsWith('--') ? Number(parts[3]) : undefined;
            const seq = Number.isInteger(seqArg) ? seqArg : undefined;
            const r = sub === 'preview'
              ? await sessionRewindPreview(id, seq, invocation.signal)
              : await sessionRewindApply({ session: id, seq, confirm: parts.includes('--yes') }, invocation.signal);
            return { kind: r.ok === false ? 'error' : 'success', text: r.summary };
          }
          return { kind: 'error', text: '用法：/backup rewind list | preview <id> [seq] | apply <id> [seq] [--yes]' };
        }

        if (head === 'chat') {
          const sub = parts[1] || 'list';
          if (sub === 'list') {
            const r = await chatSources();
            const lines = r.sessions.map((s) => `  ${CHAT_SOURCE_LABELS[s.source] ?? s.source}  ${s.id}  ${s.messages} 条  ${s.title ? `「${s.title}」` : ''}`);
            return { kind: 'success', text: `${r.summary}${lines.length ? `\n${lines.join('\n')}\n\n预览：/backup chat preview <id>；导入：/backup chat import <id> [--yes]` : ''}` };
          }
          if (sub === 'preview' || sub === 'import') {
            const id = parts[2];
            if (!id) return { kind: 'error', text: `用法：/backup chat ${sub} <会话 id>${sub === 'import' ? ' [--yes]' : ''}` };
            const r = sub === 'preview'
              ? await chatPreview({ session: id }, invocation.signal)
              : await chatApply({ session: id, confirm: parts.includes('--yes') }, invocation.signal);
            return { kind: r.ok === false ? 'error' : 'success', text: r.summary };
          }
          return { kind: 'error', text: '用法：/backup chat list | preview <id> | import <id> [--yes]' };
        }

        if (head === 'list') {
          const all = await listBackups();
          const total = all.reduce((s, b) => s + (b.size || 0), 0);
          const lines = all.map((b) => `  ${b.encrypted ? '🔒 ' : ''}${b.name}${b.size !== undefined ? `  ${(b.size / 1048576).toFixed(1)}MB` : ''}`);
          // 内部快照分区展示：升级前（最多 2 份）/ 恢复前（最近 1 份），可按前缀选用
          const snaps = await listSnapshotNames('dsh-pre-');
          const snapLines = snaps.map((n) => `  ${n}${n.startsWith('dsh-pre-upgrade-') ? '  （升级前快照）' : n.startsWith(IMPORT_SNAPSHOT_PREFIX) ? '  （导入前快照）' : '  （恢复前快照）'}`);
          const snapText = snapLines.length ? `\n\n内部快照（可 restore 前缀选用，不占保留配额）:\n${snapLines.join('\n')}` : '';
          const text = all.length
            ? `已有备份 (${all.length} 份，共 ${(total / 1048576).toFixed(1)}MB):\n${lines.join('\n')}${snapText}\n\n${autoSummary()}`
            : `暂无备份。输入 /backup 执行首次备份。${snapText}\n\n${autoSummary()}`;
          return { kind: 'success', text };
        }

        if (head === 'verify') {
          const sel = parts[1] || 'latest';
          const names = sel === 'all'
            ? (await listBackups()).map((b) => b.name)
            : [(await pickArchive(sel)).name];
          const results = [];
          for (const n of names) results.push(await verifyOne(n, home, invocation.signal));
          const bad = results.filter((r) => !r.ok);
          const text = results.map((r) => `${r.ok ? '✅' : '❌'} ${r.name} — ${r.note}`).join('\n');
          return bad.length
            ? { kind: 'error', text: `${text}\n${bad.length} 份校验失败；损坏归档可删除后重新 /backup。` }
            : { kind: 'success', text: text || '暂无备份可校验。' };
        }

        if (head === 'restore') {
          const dryRun = parts.includes('--dry-run');
          const syncDeps = parts.includes('--sync-deps');
          const sel = parts.slice(1).find((t) => !t.startsWith('--')) || 'latest';
          // 分类型恢复：--types skills（只把选中类型 merge 进现有 ~/.dsh，不挪旁整包）
          const typesMatch = input.match(/--(?:types|only)\s+([\w,]+)/);
          const types = typesMatch ? [...new Set(typesMatch[1].split(',').map((s) => s.trim()).filter(Boolean))] : undefined;
          const r = await restoreArchive(sel, dryRun, invocation.signal, { syncDeps, ...(types ? { types } : {}) });
          return { kind: 'success', text: summarizeRestore(r) };
        }

        if (head === 'doctor') {
          const repairIdx = parts.indexOf('--repair');
          if (repairIdx < 0) {
            const r = await runDoctorScan(invocation.signal);
            return { kind: r.corruptCount ? 'error' : 'success', text: summarizeDoctorScan(r) };
          }
          const selArg = parts[repairIdx + 1];
          const sel = selArg && !selArg.startsWith('--') ? selArg : 'latest';
          const r = await runDoctorRepair(sel, invocation.signal);
          return { kind: 'success', text: r.summary };
        }

        if (head === 'migrate-check' || head === 'migrate') {
          const r = await runMigrateCheck(invocation.signal);
          return { kind: r.failCount || !r.env.hardlink || r.env.credentialsFlat ? 'error' : 'success', text: r.summary };
        }

        if (head === 'check-update' || head === 'update') {
          const profileIdx = parts.indexOf('--profile');
          const profile = profileIdx >= 0 && parts[profileIdx + 1] && !parts[profileIdx + 1].startsWith('--')
            ? parts[profileIdx + 1]
            : 'web';
          if (head === 'check-update') {
            const u = await checkUpdate(invocation.signal);
            if (u.error) return { kind: 'error', text: `检查更新失败：${u.error}` };
            return {
              kind: 'success',
              text: u.update
                ? `发现新版本：${u.current} → ${u.latest}\n输入 /backup update 一键更新（更新前自动留升级前快照）`
                : `已是最新版本：${u.current}`,
            };
          }
          const r = await runUpdate(invocation.signal, profile);
          return { kind: r.ok ? 'success' : 'error', text: r.summary };
        }

        if (head === 'github') {
          const arg = parts[1] || 'status';
          if (arg === 'repo') {
            const value = parts.slice(2).join(' ');
            if (!value || value === 'off') {
              githubState = { ...githubState, repo: null, lastError: null };
              await saveAutoState();
              return { kind: 'success', text: 'GitHub 同步仓库已清除（回退到 cordis.yml 配置，若有）。' };
            }
            const invalid = validateRepo(value);
            if (invalid) return { kind: 'error', text: invalid };
            const clean = stripUserinfo(value);
            githubState = { ...githubState, repo: clean, lastError: null };
            await saveAutoState();
            return { kind: 'success', text: `GitHub 同步仓库已设为: ${clean}\n${autoSummary()}` };
          }
          if (arg === 'token') {
            // 面板同款：存本机备份目录 github.token（0600）；off 清除。任何回执不回显 token。
            const value = parts.slice(2).join(' ').trim();
            if (!value || value === 'off') {
              await clearStoredGithubToken();
              return { kind: 'success', text: `GitHub token 已清除。${githubConfig()?.token ? '环境变量 token 仍在生效。' : ''}` };
            }
            const invalid = validateGithubToken(value);
            if (invalid) return { kind: 'error', text: invalid };
            await writeStoredGithubToken(value);
            return { kind: 'success', text: 'GitHub token 已保存：存在本机备份目录（0600），不进归档、不进 GitHub 同步。' };
          }
          if (arg === 'sync') {
            const s = await githubSync(invocation.signal);
            if (s.pushed) {
              githubState = { ...githubState, lastPush: s.at, lastError: null };
              await saveAutoState();
            } else if (s.error) {
              githubState = { ...githubState, lastError: s.error };
              await saveAutoState();
            }
            return { kind: 'success', text: summarizeSync(s) };
          }
          if (arg === 'pull') {
            // /backup github pull [--restore <前缀|latest>]：拉取不自动恢复（覆盖
            // 式恢复必须走显式 restore），--restore 由用户点名后才执行。
            const restoreIdx = parts.indexOf('--restore');
            const restoreSel = restoreIdx >= 0 ? parts[restoreIdx + 1] : null;
            const p = await githubPull(invocation.signal);
            const lines = [];
            if (p.pulled.length) {
              lines.push(`✅ 已拉取 ${p.pulled.length} 份备份:\n${p.pulled.map((n) => `  ${n}`).join('\n')}`);
            } else {
              lines.push(`远端共 ${p.total} 份备份，本地均已存在。`);
            }
            if (p.corrupt.length) lines.push(`⚠️ sha256 校验失败、已跳过: ${p.corrupt.join(', ')}`);
            if (restoreSel) {
              const r = await restoreArchive(restoreSel, false, invocation.signal);
              lines.push(summarizeRestore(r));
            } else {
              lines.push('用 /backup restore <前缀|latest> [--dry-run] 恢复；跨机恢复后凭据需按提示重填。');
            }
            return { kind: 'success', text: lines.join('\n') };
          }
          if (arg === 'status') {
            const cfg = githubConfig();
            const text = cfg
              ? `GitHub 同步: ${cfg.repo}\n  token: ${cfg.token ? '已配置' : '未配置（https 远端需要）'}\n  ${githubState.lastPush ? `上次推送: ${githubState.lastPush}` : '尚未推送过'}\n  ${githubState.lastError ? `上次错误: ${githubState.lastError}` : ''}\n  /backup github repo <地址> 可修改`
              : 'GitHub 同步未配置：/backup github repo <owner/repo> 设置，或在 cordis.yml 的 config.githubRepo 配置。';
            return { kind: 'success', text };
          }
          return { kind: 'error', text: '用法: /backup github status|sync|pull [--restore <前缀|latest>]|repo <地址|off>' };
        }

        if (head === 'sync') {
          const channel = parts[1];
          if (!channel) {
            const chs = await listSyncChannels();
            const text = Object.entries(chs).map(([k, c]) => `  ${k}: ${c.configured ? '已配置' : '未配置'}${c.url ? ` (${c.url})` : ''}${c.bucket ? ` (${c.bucket})` : ''}${c.lastPush ? ` · 上次 ${c.lastPush}` : ''}${c.lastError ? ` · ⚠️ ${c.lastError}` : ''}`).join('\n');
            return { kind: 'success', text: `同步通道:\n${text}\n/backup sync <webdav|s3|gist|github> sync 立即推送` };
          }
          const action = parts[2] || 'status';
          if (action === 'off') {
            const r = await removeSyncChannel(channel);
            return { kind: r.ok ? 'success' : 'error', text: r.summary };
          }
          if (action === 'status') {
            const chs = await listSyncChannels();
            const c = chs[channel];
            return { kind: 'success', text: c?.configured ? `通道 ${channel} 已配置: ${JSON.stringify(c)}` : `通道 ${channel} 未配置（/backup sync ${channel} set <JSON> 配置）` };
          }
          if (action === 'sync') {
            const s = await syncNow(channel, invocation.signal);
            if (s.error) return { kind: 'error', text: `同步失败: ${s.error}` };
            const text = s.pushed
              ? `✅ ${channel} 同步完成: 推送 ${s.count ?? 'N'} 个文件，${s.at}${s.gistUrl ? `\nGist: ${s.gistUrl}` : ''}${s.tooBig?.length ? `\n跳过超大文件: ${s.tooBig.join(', ')}` : ''}`
              : `${channel} 同步: ${s.skipped || '无变更'}${s.tooBig?.length ? `\n跳过超大文件: ${s.tooBig.join(', ')}` : ''}`;
            return { kind: 'success', text };
          }
          if (action === 'set') {
            const jsonText = parts.slice(3).join(' ').trim();
            if (!jsonText) return { kind: 'error', text: '用法: /backup sync <channel> set \'{"url":"...",...}\'（JSON 配置，凭据只存本机 0600）' };
            let cfg;
            try { cfg = JSON.parse(jsonText); } catch { return { kind: 'error', text: '配置需为合法 JSON 对象' }; }
            const r = await setSyncChannel(channel, cfg);
            return { kind: r.ok ? 'success' : 'error', text: r.summary };
          }
          return { kind: 'error', text: '用法: /backup sync <channel> status|sync|set <JSON>|off' };
        }

        if (head === 'lock') {
          const arg = parts[1] || 'status';
          if (arg === 'reclaim') {
            const r = await reclaimLockEntry(parts.includes('--force'));
            return { kind: r.ok ? 'success' : 'error', text: r.summary };
          }
          const st = await lockStatus();
          if (!st.held) return { kind: 'success', text: '操作锁: 空闲' };
          return { kind: 'success', text: `操作锁: 已被持有（pid=${st.pid}, operation=${st.operation}${st.stale ? '，已失效（死锁，下次操作会自动回收）' : ''}）\n回收: /backup lock reclaim${st.stale ? '' : ' --force'}（--force 会强删活锁，慎用）` };
        }

        if (head === 'disk' || head === 'usage') {
          const arg = parts[1];
          if (arg === 'clean') { const r = await cleanup('cache', invocation.signal); return { kind: 'success', text: r.summary }; }
          if (arg === 'clean-expired') { const r = await cleanup('expired', invocation.signal); return { kind: 'success', text: r.summary }; }
          const u = await diskUsage();
          return { kind: 'success', text: u.summary };
        }

        if (head === 'profiles') {
          const sub = parts[1] || 'list';
          if (sub === 'list') {
            const list = await profilesList();
            const text = list.length
              ? `Profiles (${list.length}):\n${list.map((p) => `  ${p.name}${p.appOwned ? '（app-owned，只读）' : ''}${p.version ? `  v${p.version}` : ''}${p.running ? `  ▶ 运行中(pid=${p.pid})` : ''}`).join('\n')}`
              : '还没有 profile（可用 /backup profiles create <名> 创建）';
            return { kind: 'success', text };
          }
          if (sub === 'create') {
            const name = parts[2];
            if (!name) return { kind: 'error', text: '用法: /backup profiles create <名>' };
            const r = await profileCreate(name);
            return { kind: r.ok ? 'success' : 'error', text: r.summary };
          }
          if (sub === 'rename') {
            const r = await profileRename(parts[2], parts[3]);
            if (!parts[2] || !parts[3]) return { kind: 'error', text: '用法: /backup profiles rename <旧名> <新名>' };
            return { kind: r.ok ? 'success' : 'error', text: r.summary };
          }
          if (sub === 'delete') {
            const name = parts[2];
            if (!name) return { kind: 'error', text: '用法: /backup profiles delete <名> --yes（硬删，不可恢复）' };
            if (!parts.includes('--yes')) return { kind: 'error', text: `硬删不可恢复——确认删除 ${name} 请加 --yes` };
            const r = await profileDelete(name);
            return { kind: r.ok ? 'success' : 'error', text: r.summary };
          }
          if (sub === 'launch') {
            const name = parts[2];
            if (!name) return { kind: 'error', text: '用法: /backup profiles launch <名>' };
            const r = await profileLaunch(name);
            return { kind: r.ok ? 'success' : 'error', text: r.summary };
          }
          if (sub === 'stop') {
            const name = parts[2];
            if (!name) return { kind: 'error', text: '用法: /backup profiles stop <名>' };
            const r = await profileStop(name);
            return { kind: r.ok ? 'success' : 'error', text: r.summary };
          }
          return { kind: 'error', text: '用法: /backup profiles list|create <名>|rename <旧> <新>|delete <名> --yes|launch <名>|stop <名>' };
        }

        if (head === 'delete' || head === 'rm') {
          const sel = parts[1];
          if (!sel) return { kind: 'error', text: '用法: /backup delete <归档名前缀|latest>（删除不可恢复，需要时可用 /backup 重新备份）' };
          const r = await removeBackup(sel, invocation.signal);
          return { kind: 'success', text: `🗑️ ${r.summary}` };
        }

        if (head === 'auto') {
          const arg = parts[1];
          if (!arg || arg === 'status') return { kind: 'success', text: autoSummary() };
          if (arg === 'off' || arg === '0') {
            await setAuto(0);
            return { kind: 'success', text: '自动备份已关闭。' };
          }
          if (arg === 'weekly') {
            const specs = parts.slice(2).filter(Boolean);
            if (!specs.length || specs[0] === 'status') return { kind: 'success', text: autoSummary() };
            if (specs[0] === 'off') { const r = await setWeekly([]); return { kind: r.ok ? 'success' : 'error', text: r.summary }; }
            const list = [];
            for (const spec of specs) {
              const m = /^([1-7])-(\d{2}:\d{2})$/.exec(spec);
              if (!m) return { kind: 'error', text: `每周时刻格式应为「周几-时:分」（周几 1=周一..7=周日，可多个空格分隔），收到 ${spec}` };
              list.push({ day: Number(m[1]), time: m[2] });
            }
            const r = await setWeekly(list);
            return { kind: r.ok ? 'success' : 'error', text: r.summary };
          }
          const h = Number(arg);
          if (!Number.isFinite(h) || h < 1 || h > 720) {
            return { kind: 'error', text: '小时数需为 1~720 之间的数字（如 /backup auto 12）；或 /backup auto weekly 1-09:00 5-18:00' };
          }
          await setAuto(h);
          return { kind: 'success', text: `✅ 自动备份已开启：每 ${h} 小时执行一次（保留 ${autoKeep()} 份，已持久化）。\n首次备份正在执行，之后每 ${h} 小时一次。\n${autoSummary()}` };
        }

        let keep;
        const m = input.match(/--keep\s+(\d+)/);
        if (m) keep = Number(m[1]);
        // 分类型备份：--types api,mcp,skills（逗号分隔，可多类；--only 同义）。缺省=全量。
        const typesMatch = input.match(/--(?:types|only)\s+([\w,]+)/);
        const types = typesMatch ? [...new Set(typesMatch[1].split(',').map((s) => s.trim()).filter(Boolean))] : undefined;
        const r = await doBackup(keep, invocation.signal, types ? { types } : {});
        // 增长（每周增长仪表盘配套）：首次手动备份成功后给一次 star 提示，此后永不再现；
        // 自动备份的日志不加（噪音），面板有常驻入口。
        let starNote = '';
        if (!starHinted) {
          starNote = `\n\n💡 觉得好用的话，给个 Star 是对我们最大的支持: ${STAR_URL}`;
          starHinted = true;
          await saveAutoState().catch(() => { /* 记录失败不影响回执内容 */ });
        }
        return {
          kind: 'success',
          text: `✅ 备份完成${types ? `（类型: ${types.join(', ')}${r.hasCredentials ? '，含明文凭据·不进 GitHub 同步' : ''}）` : ''}\n  文件: ${r.path}\n  校验和: ${r.sha.slice(0, 16)}…\n  轮换: 删除 ${r.stale} 份旧备份（保留 ${r.keep} 份）${quarantineNote(r)}\n  ${autoSummary()}${starNote}`,
        };
      } catch (err) {
        return { kind: 'error', text: `备份失败: ${friendlyReason(err)}` };
      }
    },
  });

  // ---------- 配置管理 agent 工具（P4：1 → 5，对齐竞品语义） ----------
  // 安全不变量：config_restore 默认 dry-run、config_sync_pull 只读不写用户数据、
  // config_sync_push 是显式写远端、口令/密文值绝不进工具入参/输出/日志。

  /** 列本地回滚快照（恢复前/升级前/导入前内部安全网）：id/时间/来源/状态/条目数。 */
  async function listRollbackSnapshots(signal) {
    const { root } = paths();
    const names = await listSnapshotNames('dsh-pre-');
    const out = [];
    for (const name of names) {
      let meta = null;
      try { meta = JSON.parse(await readFile(`${root}/${name}.meta.json`, 'utf8')); } catch { /* 边车缺失 */ }
      const source = name.startsWith('dsh-pre-upgrade-') ? 'upgrade' : name.startsWith(IMPORT_SNAPSHOT_PREFIX) ? 'import' : 'restore';
      let entries = 0;
      try { entries = (await safeArchiveEntries(name, signal)).length; } catch { entries = 0; }
      const size = await fsStat(`${root}/${name}`).then((s) => s.size, () => 0);
      out.push({ id: name, time: meta?.createdAt ?? null, source, status: 'ok', entries, size });
    }
    return out;
  }

  /** 拉取 diff 预览（零写用户数据：只更新同步缓存工作树，绝不写 ~/.dsh 或本地归档集）。 */
  async function configSyncPullPreview(channel, signal) {
    if (channel !== 'github') {
      return { ok: true, channel, total: 0, missing: [], alreadyHave: 0, summary: `通道 ${channel} 本轮仅支持推送，暂不支持拉取（拉取请用 github）` };
    }
    const { root } = paths();
    const wt = await ensureSyncWorktree(signal);
    if (wt.reason) return { ok: false, channel, total: 0, missing: [], alreadyHave: 0, summary: wt.reason };
    const { syncDir, git } = wt;
    await spawnRun([git, 'fetch', 'origin', 'main'], syncDir, signal);
    await spawnRun([git, 'reset', '--hard', 'origin/main'], syncDir, signal);
    let names = [];
    try {
      names = (await readdir(syncDir, { withFileTypes: true }))
        .filter((e) => e.isFile() && /^dsh-[A-Za-z0-9._-]+\.tar\.gz$/.test(e.name))
        .map((e) => e.name);
    } catch { names = []; }
    const missing = [];
    for (const n of names) if (!(await existsStat(`${root}/${n}`))) missing.push(n);
    const summary = `远端共 ${names.length} 份备份，本地缺 ${missing.length} 份${missing.length ? `:\n${missing.map((n) => `  ${n}`).join('\n')}` : '（本地均已存在）'}。落地请走 confirm 恢复流程（config_restore）。`;
    return { ok: true, channel, total: names.length, missing, alreadyHave: names.length - missing.length, summary };
  }

  ctx.tools.register(defineTool({
    name: 'config_backup',
    description: '把 ~/.dsh 配置打包成单文件 ZIP（节段化 settings/ui/providers/plugins/mcp/skills/prompts/workspaces/sessions/credentials + other 兜底）。默认脱敏（凭据不入包）；password 提供时加密（scrypt+AES-256-GCM），并允许 includeCredentials 入包。口令只经工具参数内存态传入，绝不落盘/入日志，密文值绝不进输出。',
    parameters: {
      password: { type: 'string', description: '可选口令：提供则加密导出（凭据可入包）；不提供则明文导出且凭据脱敏' },
      includeCredentials: { type: 'boolean', description: '是否把凭据节段打入导出包（必须配 password 加密，否则拒绝）' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => [{ type: 'text', text: String(v.summary) }] },
    execute: async (args, exec) => {
      const signal = exec && exec.signal ? exec.signal : undefined;
      try {
        const password = typeof args?.password === 'string' && args.password ? args.password : undefined;
        const r = await exportConfig({ password, includeCredentials: args?.includeCredentials === true }, signal);
        return { ok: true, name: r.name, size: r.size, encrypted: r.encrypted, sections: r.manifest?.sections ?? [], redactedFiles: r.redactedFiles ?? [], summary: r.summary };
      } catch (err) {
        return { ok: false, summary: `操作失败: ${friendlyReason(err)}` };
      }
    },
  }));

  ctx.tools.register(defineTool({
    name: 'config_list_snapshots',
    description: '列出本地回滚快照（恢复前/升级前/导入前自动拍的内部安全网）。每项给 id/时间/来源/状态/条目数。只读，不写任何文件。',
    parameters: {},
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => [{ type: 'text', text: String(v.summary) }] },
    execute: async (_args, exec) => {
      const signal = exec && exec.signal ? exec.signal : undefined;
      try {
        const snapshots = await listRollbackSnapshots(signal);
        const summary = snapshots.length
          ? `本地回滚快照 ${snapshots.length} 份:\n${snapshots.map((s) => `  ${s.id}（${s.source}，${s.entries} 项${s.time ? `，${s.time}` : ''}）`).join('\n')}`
          : '暂无回滚快照';
        return { ok: true, snapshots, summary };
      } catch (err) {
        return { ok: false, snapshots: [], summary: `操作失败: ${friendlyReason(err)}` };
      }
    },
  }));

  ctx.tools.register(defineTool({
    name: 'config_restore',
    description: '从本地回滚快照恢复（整体替换 ~/.dsh，破坏性）。默认 dry-run=true 只出计划、零写入；confirm:true 才真正执行（执行前自动校验 + 再拍当前数据快照，解压失败自动回滚）。真实恢复前必须先 dry-run 预览并向用户展示确认。',
    parameters: {
      snapshot: { type: 'string', description: '快照 id/前缀（config_list_snapshots 里的 id；缺省 latest=最新全量备份）' },
      confirm: { type: 'boolean', description: 'true=真正执行恢复（破坏性）；false/缺省=仅 dry-run 预览，零写入' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => [{ type: 'text', text: String(v.summary) }] },
    execute: async (args, exec) => {
      const signal = exec && exec.signal ? exec.signal : undefined;
      try {
        const selector = typeof args?.snapshot === 'string' && args.snapshot ? args.snapshot : 'latest';
        const confirm = args?.confirm === true;
        const r = await restoreArchive(selector, !confirm, signal);
        return { ok: true, dryRun: !confirm, archive: r.archive, files: r.files, preflight: r.preflight ?? [], summary: summarizeRestore(r) };
      } catch (err) {
        return { ok: false, dryRun: args?.confirm !== true, summary: `操作失败: ${friendlyReason(err)}` };
      }
    },
  }));

  ctx.tools.register(defineTool({
    name: 'config_sync_push',
    description: '把本地备份集推送到指定同步通道（github/webdav/s3/gist），显式写远端。归档默认脱敏（凭据不进包）；password 提供时先做一份加密全量备份再推送（引擎强制加密后同步）。口令绝不回显/落日志，密文值绝不进输出。',
    parameters: {
      channel: { type: 'string', required: true, description: '通道名：github/webdav/s3/gist' },
      password: { type: 'string', description: '可选口令：提供则先做加密全量备份再推送（强制加密后同步）' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => [{ type: 'text', text: String(v.summary) }] },
    execute: async (args, exec) => {
      const signal = exec && exec.signal ? exec.signal : undefined;
      try {
        const channel = typeof args?.channel === 'string' && args.channel ? args.channel : 'github';
        if (typeof args?.password === 'string' && args.password) {
          // 强制加密：先做一份加密全量备份（口令内存态），再推远端
          await doBackup(undefined, signal, { password: args.password });
        }
        const s = await syncNow(channel, signal);
        if (s.error) return { ok: false, summary: `同步失败: ${s.error}` };
        return { ok: true, pushed: Boolean(s.pushed), count: s.count ?? null, tooBig: s.tooBig ?? [], gistUrl: s.gistUrl ?? null, summary: s.pushed ? `✅ ${channel} 推送完成（${s.count ?? 'N'} 个文件）` : `无变更` };
      } catch (err) {
        return { ok: false, summary: `操作失败: ${friendlyReason(err)}` };
      }
    },
  }));

  ctx.tools.register(defineTool({
    name: 'config_sync_pull',
    description: '拉取远端备份集的 diff 预览（只下载+分析，绝不写 ~/.dsh 或本地归档集合）。返回远端有哪些、本地缺哪些；落地导入走独立 confirm 流程（config_restore）。webdav/s3/gist 本轮仅推送。',
    parameters: {
      channel: { type: 'string', description: '通道名（缺省 github）' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => [{ type: 'text', text: String(v.summary) }] },
    execute: async (args, exec) => {
      const signal = exec && exec.signal ? exec.signal : undefined;
      try {
        const channel = typeof args?.channel === 'string' && args.channel ? args.channel : 'github';
        const p = await configSyncPullPreview(channel, signal);
        return { ok: true, ...p };
      } catch (err) {
        return { ok: false, summary: `操作失败: ${friendlyReason(err)}` };
      }
    },
  }));


  // ---------- backup_dsh 模型工具 ----------
  ctx.tools.register(defineTool({
    name: 'backup_dsh',
    description: '备份、校验、恢复或体检 DSH 用户数据（~/.dsh 的会话、配置、技能）。凭据文件默认脱敏：不进归档、不进 GitHub 同步，明文只存本机 vault，恢复时自动还原。mode=backup 立即备份（keep 指定保留份数）；mode=list 列出备份；mode=verify 校验完整性（selector=前缀或 all，缺省最新一份）；mode=restore 恢复（selector=前缀或 latest，syncDeps 恢复后重装 profile 依赖；恢复前自动校验并快照当前数据，解压失败自动还原；真实恢复前必须先 dryRun=true 预览并向用户展示确认）；mode=auto 设置定时备份（hours 间隔小时数，0=关闭，缺省查询）；mode=doctor 会话日志体检——检测损坏的会话历史（seq 撞号/坏帧/截断），repair=true 时从 selector 归档定点修复；mode=migrate 迁移预检——静态扫描全部代会话日志（v0 起各代），预测宿主升级后哪些会话会打不开、挂在哪条规则，并探测文件系统硬链接支持与凭据文件旧布局',
    parameters: {
      mode: { type: 'string', required: true, enum: ['backup', 'list', 'verify', 'restore', 'auto', 'doctor', 'migrate'], description: 'backup=执行备份，list=列出备份，verify=校验完整性，restore=恢复，auto=定时备份，doctor=会话日志体检，migrate=升级迁移预检' },
      keep: { type: 'number', description: '保留的备份份数（mode=backup，默认 7）' },
      hours: { type: 'number', description: '定时备份间隔小时数（mode=auto；0=关闭；缺省=查询状态）' },
      selector: { type: 'string', description: '备份选择器（mode=verify/restore/doctor）：归档名前缀、latest 或 all' },
      dryRun: { type: 'boolean', description: 'mode=restore 时仅预览（不写入）；真实恢复前必须先预览并向用户展示确认' },
      syncDeps: { type: 'boolean', description: 'mode=restore 时恢复后对各 profile 执行 pnpm install 重装插件依赖' },
      repair: { type: 'boolean', description: 'mode=doctor 时从 selector 归档定点修复损坏的会话日志（缺省仅扫描）' },
      types: { type: 'string', description: 'mode=backup/restore 时按内容类型子集操作（逗号分隔，如 credentials,mcp,skills）。backup=只打选中类型子集归档；restore=只把选中类型 merge 进现有 ~/.dsh（不挪旁整包，覆盖前留档）' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: String(value.summary) }],
    },
    execute: async (args, exec) => {
      const mode = args && args.mode ? args.mode : 'backup';
      const signal = exec && exec.signal ? exec.signal : undefined;
      const selector = args && typeof args.selector === 'string' && args.selector ? args.selector : undefined;
      try {
        if (mode === 'list') {
          const all = await listBackups();
          return { ok: true, summary: `已有 ${all.length} 份备份:\n${all.map((b) => `  ${b.encrypted ? '🔒 ' : ''}${b.name}`).join('\n') || '（无）'}\n\n${autoSummary()}` };
        }
        if (mode === 'verify') {
          const { home } = paths();
          const sel = selector || 'latest';
          const names = sel === 'all' ? (await listBackups()).map((b) => b.name) : [(await pickArchive(sel)).name];
          const lines = [];
          let bad = 0;
          for (const n of names) {
            const r = await verifyOne(n, home, signal);
            if (!r.ok) bad += 1;
            lines.push(`${r.ok ? '✅' : '❌'} ${r.name} — ${r.note}`);
          }
          return { ok: bad === 0, summary: lines.join('\n') || '暂无备份可校验。' };
        }
        if (mode === 'restore') {
          const types = typeof args?.types === 'string' && args.types.trim() ? [...new Set(args.types.split(',').map((s) => s.trim()).filter(Boolean))] : undefined;
          const r = await restoreArchive(selector || 'latest', Boolean(args && args.dryRun), signal, { syncDeps: Boolean(args && args.syncDeps), ...(types ? { types } : {}) });
          return { ok: true, path: r.archive, summary: summarizeRestore(r) };
        }
        if (mode === 'doctor') {
          if (args && args.repair) {
            const r = await runDoctorRepair(selector || 'latest', signal);
            return { ok: r.stillBad.length === 0 && r.unrecoverable.length === 0, summary: r.summary, repaired: r.repaired, unrecoverable: r.unrecoverable, stillBad: r.stillBad };
          }
          const r = await runDoctorScan(signal);
          return {
            ok: r.corruptCount === 0,
            scanned: r.scanned,
            corruptCount: r.corruptCount,
            skippedCount: r.skippedCount,
            summary: summarizeDoctorScan(r),
            corrupt: r.corrupt.map((c) => ({ path: c.rel, reason: c.reason })),
          };
        }
        if (mode === 'migrate') {
          const r = await runMigrateCheck(signal);
          return {
            ok: r.failCount === 0 && r.env.hardlink && !r.env.credentialsFlat,
            scanned: r.scanned,
            failCount: r.failCount,
            migratableCount: r.migratableCount,
            skippedCount: r.skippedCount,
            warningCount: r.warningCount ?? 0,
            summary: r.summary,
            // fail 项照旧全带；带提示（不判打不开）的条目也带上 warnings——否则
            // UI 只能看到"没问题"，用户无从知道有哪些开放集合上的命中失败（#113）。
            sessions: r.sessions.filter((s) => s.verdict === 'fail' || s.warnings?.length).map((s) => ({ path: s.rel, version: s.version, findings: s.findings, ...(s.warnings?.length ? { warnings: s.warnings } : {}) })),
            env: r.env,
          };
        }
        if (mode === 'auto') {
          const h = args && args.hours !== undefined ? args.hours : null;
          if (h === null) return { ok: true, summary: autoSummary() };
          if (h === 0) {
            await setAuto(0);
            return { ok: true, summary: '自动备份已关闭。' };
          }
          if (!Number.isFinite(h) || h < 1 || h > 720) return { ok: false, summary: 'hours 需为 1~720 的整数（0=关闭）' };
          await setAuto(h);
          return { ok: true, summary: `自动备份已开启：每 ${h} 小时一次（已持久化）。\n首次备份正在执行，之后每 ${h} 小时一次。\n${autoSummary()}` };
        }
        const types = typeof args?.types === 'string' && args.types.trim()
          ? [...new Set(args.types.split(',').map((s) => s.trim()).filter(Boolean))]
          : undefined;
        const r = await doBackup(args && args.keep ? args.keep : undefined, signal, types ? { types } : {});
        return { ok: true, path: r.path, sha: r.sha, summary: `备份完成: ${r.path}${types ? `（类型: ${types.join(', ')}${r.hasCredentials ? '，含明文凭据·不进 GitHub 同步' : ''}）` : ''}\nsha256: ${r.sha}\n轮换删除 ${r.stale} 份（保留 ${r.keep} 份）${quarantineNote(r)}` };
      } catch (err) {
        return { ok: false, summary: `操作失败: ${friendlyReason(err)}` };
      }
    },
  }));

  // ---------- Settings 面板（Web）：backupPanel Remote ----------
  const panelOps = {
    status: async () => {
      const all = await listBackups();
      const typed = await listTypedBackups();
      const { root, dshHome } = paths();
      // 分类型归档单独列出并带类型清单（读各自 meta.types），供面板分区展示
      const typedBackups = [];
      for (const b of typed) {
        let types = [];
        try { types = JSON.parse(await readFile(`${root}/${b.name}.meta.json`, 'utf8')).types ?? []; } catch { /* 边车缺失 */ }
        typedBackups.push({ name: b.name, size: typeof b.size === 'number' ? b.size : null, types });
      }
      return {
        destination: root,
        dshHome,
        keepDefault: defaultKeep(),
        autoHours,
        weeklySchedules,
        lastAuto,
        backups: all.map((b) => ({ name: b.name, size: typeof b.size === 'number' ? b.size : null, encrypted: Boolean(b.encrypted) })),
        typedBackups,
      };
    },
    backup: async (keep, types, password, signal) => {
      const validTypes = Array.isArray(types) && types.length ? [...new Set(types.filter((t) => BACKUP_TYPES[t]))] : undefined;
      const pass = typeof password === 'string' && password ? password : undefined;
      const r = await doBackup(keep, signal, { ...(validTypes ? { types: validTypes } : {}), ...(pass ? { password: pass } : {}) });
      // 面板回执给"成了、叫什么、存哪了"；64 位 sha 全文是噪音（完整值就在
      // 归档旁的 .sha256），路径用文件名——目录已显示在上方总览卡
      return {
        ok: true,
        summary: `备份完成: ${r.path.split('/').pop()}${r.encrypted ? ' 🔒' : ''}${validTypes ? `（类型: ${validTypes.join(', ')}${r.hasCredentials ? '，含明文凭据·不进 GitHub 同步' : ''}）` : ''}\nsha256: ${r.sha.slice(0, 16)}…（完整校验值在归档旁的 .sha256 文件）${r.stale ? `\n轮换删除 ${r.stale} 份旧备份（保留 ${r.keep} 份）` : ''}${quarantineNote(r)}`,
        path: r.path,
        sha: r.sha,
        stale: r.stale,
        keep: r.keep,
        ...(r.encrypted ? { encrypted: true } : {}),
        ...(validTypes ? { types: validTypes, hasCredentials: Boolean(r.hasCredentials) } : {}),
      };
    },
    verify: async (selector, signal) => {
      const { home } = paths();
      const sel = selector || 'latest';
      const names = sel === 'all'
        ? (await listBackups()).map((b) => b.name)
        : [(await pickArchive(sel)).name];
      const results = [];
      let bad = 0;
      for (const n of names) {
        const r = await verifyOne(n, home, signal);
        if (!r.ok) bad += 1;
        results.push({ name: r.name, ok: r.ok, note: r.note });
      }
      return { ok: bad === 0, summary: results.map((r) => `${r.ok ? '✅' : '❌'} ${r.name} — ${r.note}`).join('\n') || '暂无备份可校验。', results };
    },
    restore: async (selector, dryRun, types, syncDeps, password, signal) => {
      try {
        const validTypes = Array.isArray(types) && types.length ? [...new Set(types.filter((t) => BACKUP_TYPES[t]))] : undefined;
        const pass = typeof password === 'string' && password ? password : undefined;
        const r = await restoreArchive(selector || 'latest', Boolean(dryRun), signal, { syncDeps: Boolean(syncDeps), ...(validTypes ? { types: validTypes } : {}), ...(pass ? { password: pass } : {}) });
        if (r.dryRun) {
          return { ok: true, dryRun: true, archive: r.archive, files: r.files, sample: r.sample, preflight: r.preflight ?? [], targetExists: r.targetExists, ...(r.merge ? { merge: true, types: r.types, willOverwrite: r.willOverwrite ?? [] } : {}), summary: summarizeRestore(r) };
        }
        return {
          ok: true,
          dryRun: false,
          archive: r.archive,
          files: r.files,
          aside: r.aside,
          snapshotPath: r.snapshotPath,
          preflight: r.preflight ?? [],
          vaultRestored: r.vaultRestored ?? [],
          vaultMissing: r.vaultMissing ?? [],
          ...(r.merge ? { merge: true, types: r.types, restored: r.restored, kept: r.kept ?? [] } : {}),
          deps: r.deps,
          summary: summarizeRestore(r),
        };
      } catch (err) {
        return { ok: false, dryRun: Boolean(dryRun), summary: friendlyReason(err) };
      }
    },
    setAuto: async (hours) => {
      if (hours === 0) {
        await setAuto(0);
        return { ok: true, hours: 0, summary: '自动备份已关闭。' };
      }
      if (!Number.isFinite(hours) || hours < 1 || hours > 720) {
        return { ok: false, summary: '间隔需为 1~720 的整数小时（填 12 表示每 12 小时一次）' };
      }
      await setAuto(Math.floor(hours));
      return { ok: true, hours: Math.floor(hours), summary: `自动备份已开启：每 ${Math.floor(hours)} 小时一次。\n首次备份正在执行，之后每 ${Math.floor(hours)} 小时一次。\n${autoSummary()}` };
    },
    githubStatus: async () => {
      const cfg = githubConfig();
      const { root } = paths();
      const resolved = resolvedConfig();
      return {
        // repoRaw 是用户原始输入（运行时值优先，否则 settings.yaml → cordis.yml 默认），供面板编辑框回填
        // 两路都经 stripUserinfo：避免 cordis.yml config.githubRepo 内嵌 token 时经面板泄露
        repoRaw: githubState.repo ?? (typeof resolved.githubRepo === 'string' ? stripUserinfo(resolved.githubRepo) : null),
        repo: cfg ? cfg.repo : null,
        tokenSet: hasGithubToken(),
        syncDir: `${root}/${SYNC_DIR}`,
        lastPush: githubState.lastPush,
        lastError: githubState.lastError,
      };
    },
    githubSyncNow: async (signal) => {
      try {
        const s = await githubSync(signal);
        if (s.pushed) {
          githubState = { repo: githubState.repo ?? null, lastPush: s.at, lastError: null };
          await saveAutoState();
        } else if (s.error) {
          githubState = { ...githubState, lastError: s.error };
          await saveAutoState();
        }
        return { ok: true, summary: summarizeSync(s), pushed: Boolean(s.pushed), tooBig: s.tooBig ?? [] };
      } catch (err) {
        const message = String(err && err.message ? err.message : err);
        githubState = { ...githubState, lastError: message };
        await saveAutoState();
        return { ok: false, summary: message, pushed: false, tooBig: [] };
      }
    },
    githubPull: async (signal) => {
      try {
        const p = await githubPull(signal);
        const lines = [];
        if (p.pulled.length) lines.push(`已拉取 ${p.pulled.length} 份备份`);
        else lines.push(`远端共 ${p.total} 份备份，本地均已存在。`);
        if (p.corrupt.length) lines.push(`sha256 校验失败、已跳过: ${p.corrupt.join(', ')}`);
        lines.push('在上方备份列表中选择归档恢复；跨机恢复后凭据需按提示重填。');
        return { ok: true, summary: lines.join('\n'), pulled: p.pulled, corrupt: p.corrupt, total: p.total };
      } catch (err) {
        return { ok: false, summary: String(err && err.message ? err.message : err), pulled: [], corrupt: [], total: 0 };
      }
    },
    removeEntry: async (selector, signal) => {
      try {
        const r = await removeBackup(selector || 'latest', signal);
        return { ok: true, summary: r.summary };
      } catch (err) {
        return { ok: false, summary: friendlyReason(err) };
      }
    },
    setGithubRepo: async (repo) => {
      const raw = typeof repo === 'string' ? repo.trim() : '';
      if (!raw) {
        githubState = { ...githubState, repo: null, lastError: null };
        await saveAutoState();
        // 清除用户层的 githubRepo，让 base 层（cordis.patch.yml）透传回来
        if (settingsService) {
          try {
            // 读取当前用户层，移除 githubRepo 字段后 replace 回去
            const desc = describeOwn(settingsService, NS);
            const userLayer = desc?.user ? { ...desc.user } : {};
            delete userLayer.githubRepo;
            await settingsService.replace(NS, userLayer);
          } catch (err) {
            return { ok: false, summary: String(err && err.message ? err.message : err) };
          }
        }
        return { ok: true, repo: null, summary: 'GitHub 同步仓库已清除用户层覆盖（回退到 cordis.yml 配置，若有）。' };
      }
      const invalid = validateRepo(raw);
      if (invalid) return { ok: false, summary: invalid };
      const clean = stripUserinfo(raw);
      githubState = { ...githubState, repo: clean, lastError: null };
      await saveAutoState();
      // 同步写入 settings.yaml
      if (settingsService) {
        try {
          await settingsService.update(NS, { githubRepo: clean });
        } catch (err) {
          return { ok: false, summary: String(err && err.message ? err.message : err) };
        }
      }
      return { ok: true, repo: clean, summary: `GitHub 同步仓库已设为: ${clean}` };
    },
    doctorScan: async (signal) => {
      try {
        const r = await runDoctorScan(signal);
        return {
          ok: r.corruptCount === 0,
          scanned: r.scanned,
          corruptCount: r.corruptCount,
          // 面板没有 doctor UI，指路必须指向真实可用的入口（聊天命令或救援页）
          summary: summarizeDoctorScan(r, { repairHint: '定点修复目前要在聊天窗执行：/backup doctor --repair [前缀|latest]（修复前会把损坏文件留档为 *.corrupt-*）；DSH 起不来时可用备份目录里的救援页「体检并修复」' }),
          corrupt: r.corrupt.map((c) => ({ path: c.rel, reason: c.reason })),
        };
      } catch (err) {
        return { ok: false, summary: String(err && err.message ? err.message : err), corrupt: [] };
      }
    },
    doctorRepair: async (selector, signal) => {
      try {
        const r = await runDoctorRepair(typeof selector === 'string' && selector ? selector : undefined, signal);
        return {
          ok: r.stillBad.length === 0 && r.unrecoverable.length === 0,
          summary: r.summary,
          repaired: r.repaired,
          unrecoverable: r.unrecoverable,
          stillBad: r.stillBad,
        };
      } catch (err) {
        return { ok: false, summary: String(err && err.message ? err.message : err), repaired: [], unrecoverable: [], stillBad: [] };
      }
    },
    migrateCheck: async (signal) => {
      try {
        const r = await runMigrateCheck(signal);
        return { ok: r.failCount === 0 && r.env.hardlink && !r.env.credentialsFlat, ...r };
      } catch (err) {
        return { ok: false, summary: String(err && err.message ? err.message : err), sessions: [], scanned: 0, failCount: 0, migratableCount: 0, skippedCount: 0, env: {} };
      }
    },
    setGithubToken: async (token) => {
      const raw = typeof token === 'string' ? token.trim() : '';
      if (!raw || raw === 'off') {
        await clearStoredGithubToken();
        return { ok: true, tokenSet: hasGithubToken(), summary: `GitHub token 已清除。${hasGithubToken() ? '环境变量 token 仍在生效。' : ''}` };
      }
      const invalid = validateGithubToken(raw);
      if (invalid) return { ok: false, tokenSet: hasGithubToken(), summary: invalid };
      await writeStoredGithubToken(raw);
      return { ok: true, tokenSet: true, summary: 'GitHub token 已保存：存在本机备份目录（0600），不进归档、不进 GitHub 同步。' };
    },
    checkUpdate: async (signal) => {
      const u = await checkUpdate(signal);
      if (u.error) return { ok: false, current: SELF_META.version, latest: null, update: false, error: u.error, summary: `检查更新失败：${u.error}` };
      return {
        ok: true,
        current: u.current,
        latest: u.latest,
        update: u.update,
        error: null,
        summary: u.update ? `发现新版本：${u.current} → ${u.latest}` : `已是最新版本：${u.current}`,
      };
    },
    update: async (signal) => {
      const r = await runUpdate(signal, 'web');
      return { ok: r.ok, updated: r.updated, current: r.current ?? null, latest: r.latest ?? null, summary: r.summary };
    },
    exportConfig: async (options, signal) => {
      try {
        return await exportConfig(options || {}, signal);
      } catch (err) {
        return { ok: false, summary: friendlyReason(err) };
      }
    },
    importPreview: async (options, signal) => {
      try {
        return await importPreview(options || {}, signal);
      } catch (err) {
        return { ok: false, summary: friendlyReason(err) };
      }
    },
    importApply: async (options, signal) => {
      try {
        return await importApply(options || {}, signal);
      } catch (err) {
        return { ok: false, summary: friendlyReason(err) };
      }
    },
    syncStatus: async () => {
      try {
        const chs = await listSyncChannels();
        return { ok: true, channels: chs, summary: Object.entries(chs).map(([k, c]) => `${k}: ${c.configured ? '已配置' : '未配置'}`).join('\n') };
      } catch (err) {
        return { ok: false, channels: {}, summary: friendlyReason(err) };
      }
    },
    syncNow: async (channel, signal) => {
      try {
        const s = await syncNow(channel, signal);
        if (s.error) return { ok: false, summary: s.error, ...s };
        return { ok: true, summary: s.pushed ? `✅ ${channel} 同步完成` : `无变更`, ...s };
      } catch (err) {
        return { ok: false, summary: friendlyReason(err) };
      }
    },
    setSyncChannel: async (channel, config) => {
      try {
        return await setSyncChannel(channel, config);
      } catch (err) {
        return { ok: false, summary: friendlyReason(err) };
      }
    },
    removeSyncChannel: async (channel) => {
      try {
        return await removeSyncChannel(channel);
      } catch (err) {
        return { ok: false, summary: friendlyReason(err) };
      }
    },
    lockStatus: async () => {
      try { return { ok: true, ...(await lockStatus()) }; } catch (err) { return { ok: false, summary: friendlyReason(err) }; }
    },
    reclaimLock: async (force) => {
      try { return await reclaimLockEntry(force === true); } catch (err) { return { ok: false, summary: friendlyReason(err) }; }
    },
    diskUsage: async () => {
      try { const u = await diskUsage(); return { ok: true, ...u }; } catch (err) { return { ok: false, summary: friendlyReason(err) }; }
    },
    cleanup: async (scope, signal) => {
      try { return await cleanup(scope === 'expired' ? 'expired' : 'cache', signal); } catch (err) { return { ok: false, summary: friendlyReason(err) }; }
    },
    setWeekly: async (schedules) => {
      try { return await setWeekly(schedules); } catch (err) { return { ok: false, summary: friendlyReason(err) }; }
    },
    about: async () => {
      try { return { ok: true, ...(await aboutInfo()) }; } catch (err) { return { ok: false, summary: friendlyReason(err) }; }
    },
    profilesList: async () => {
      try { const list = await profilesList(); return { ok: true, profiles: list, summary: `${list.length} 个 profile` }; } catch (err) { return { ok: false, profiles: [], summary: friendlyReason(err) }; }
    },
    profileCreate: async (name) => {
      try { return await profileCreate(name); } catch (err) { return { ok: false, summary: friendlyReason(err) }; }
    },
    profileRename: async (oldName, newName) => {
      try { return await profileRename(oldName, newName); } catch (err) { return { ok: false, summary: friendlyReason(err) }; }
    },
    profileDelete: async (name) => {
      try { return await profileDelete(name); } catch (err) { return { ok: false, summary: friendlyReason(err) }; }
    },
    profileLaunch: async (name) => {
      try { return await profileLaunch(name); } catch (err) { return { ok: false, summary: friendlyReason(err) }; }
    },
    profileStop: async (name) => {
      try { return await profileStop(name); } catch (err) { return { ok: false, summary: friendlyReason(err) }; }
    },
    marketList: async (signal) => {
      try { return await marketList(signal); } catch (err) { return { ok: false, enabled: false, entries: [], summary: friendlyReason(err) }; }
    },
    marketSearch: async (query, signal) => {
      try { return await marketSearch(query, signal); } catch (err) { return { ok: false, enabled: false, entries: [], summary: friendlyReason(err) }; }
    },
    marketInstall: async (options, signal) => {
      try { return await marketInstall(options || {}, signal); } catch (err) { return { ok: false, summary: friendlyReason(err) }; }
    },
    foreignSources: async () => {
      try { return await foreignSources(); } catch (err) { return { ok: false, sources: [], summary: friendlyReason(err) }; }
    },
    foreignPreview: async (options, signal) => {
      try { return await foreignPreview(options || {}, signal); } catch (err) { return { ok: false, summary: friendlyReason(err) }; }
    },
    foreignImport: async (options, signal) => {
      try { return await foreignImport(options || {}, signal); } catch (err) { return { ok: false, summary: friendlyReason(err) }; }
    },
    sessionRewindList: async (signal) => {
      try { return await sessionRewindList(signal); } catch (err) { return { ok: false, sessions: [], summary: friendlyReason(err) }; }
    },
    sessionRewindPreview: async (session, seq, signal) => {
      try { return await sessionRewindPreview(session, seq, signal); } catch (err) { return { ok: false, summary: friendlyReason(err) }; }
    },
    sessionRewindApply: async (options, signal) => {
      try { return await sessionRewindApply(options || {}, signal); } catch (err) { return { ok: false, summary: friendlyReason(err) }; }
    },
    chatSources: async () => {
      try { return await chatSources(); } catch (err) { return { ok: false, detected: false, sessions: [], summary: friendlyReason(err) }; }
    },
    chatPreview: async (options, signal) => {
      try { return await chatPreview(options || {}, signal); } catch (err) { return { ok: false, summary: friendlyReason(err) }; }
    },
    chatApply: async (options, signal) => {
      try { return await chatApply(options || {}, signal); } catch (err) { return { ok: false, summary: friendlyReason(err) }; }
    },
  };

  // 仅在装配了 Typert registry 的 profile（Web）里挂载面板服务；其余 profile 安静跳过。
  ctx.inject(['typert'], (scope) => {
    scope.effect(() => scope.typert.register({
      package: 'dsh-backup',
      face: 'host',
      schemas: [],
      invocations: PANEL_INVOCATIONS,
      model: Object.freeze({ services: Object.freeze([]), events: Object.freeze([]), objects: Object.freeze([]) }),
    }), 'dsh-backup: typert invocations');
    scope.plugin(BackupPanelService, panelOps);
  });

  // Web 下载路由（仅 loopback；归档含明文凭据，绝不对非本机来源开放）。
  ctx.inject(['webServer'], (scope) => {
    scope.effect(() => scope.webServer.register({
      kind: 'prefix',
      path: DOWNLOAD_PREFIX,
      handler: (req, res) => { void handleDownload(req, res); },
    }), 'dsh-backup: download route');
  });

  // Settings 薄代理：经 ctx.settings 官方 seam 的 GET/POST 接口。
  // 用户编辑持久化到 $DSH_HOME/settings.yaml；base 层（cordis.patch.yml）
  // 本插件从不写入。
  ctx.inject(['webServer'], (scope) => {
    scope.effect(() => scope.webServer.register({
      kind: 'exact',
      path: '/dsh-backup/settings',
      handler: async (req, res) => {
        try {
          // 与 /backup-download 同一 loopback 校验：settings 路由更敏感，绝不对非本机暴露
          const host = String(req.headers?.host || '');
          if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host)) {
            sendJson(res, 403, { error: 'forbidden' });
            return;
          }
          if (!settingsService) {
            sendJson(res, 503, { error: 'settings-unavailable' });
            return;
          }
          // 0.1.7 起宿主换了 settings 模型：插件的 register(ns, schema) 被移除，
          // 描述符改由「profile 条目自带的 Config schema」派生——我们自注册的
          // 命名空间因此不在 describe() 里（0.1.6-alpha.1 及更早仍是旧模型）。
          // 旧实现在这里直接抛 TypeError（读 undefined.value），面板只看到一句
          // 原始报错、编辑还静默失败。改为显式降级：如实说明并指向配置出路。
          const desc = describeOwn(settingsService, NS);
          if (!desc) {
            sendJson(res, 200, {
              unavailable: true,
              reason: 'settings-namespace-missing',
              note: '此宿主版本的设置面板由宿主自带的配置表单接管（0.1.7 起插件自注册的设置命名空间不再生效）；本插件的选项请写在 profile 的 cordis.yml / cordis.patch.yml 的插件条目 config 下。',
            });
            return;
          }
          if (req.method === 'GET' || req.method === 'HEAD') {
            sendJson(res, 200, describeResponse(desc));
            return;
          }
          if (req.method !== 'POST') {
            sendJson(res, 405, { error: 'method-not-allowed' });
            return;
          }
          const body = await readJsonBody(req);
          const expectedRevision = typeof body.revision === 'number' ? body.revision : undefined;
          try {
            if (body.reset === true) {
              // 重置：清除用户层，值回退到 base 层
              await settingsService.replace(NS, {}, expectedRevision);
            } else {
              const invalid = validatePartial(body);
              if (invalid.length > 0) {
                sendJson(res, 400, { error: 'invalid-field', fields: invalid });
                return;
              }
              // 保存：仅合并提供的字段到用户层
              const patch = {};
              for (const field of SETTINGS_FIELDS) {
                if (body[field] !== undefined) normalizeField(patch, field, body[field]);
              }
              await settingsService.update(NS, patch, expectedRevision);
            }
          } catch (err) {
            if (isSettingsConflict(err)) {
              sendJson(res, 409, { error: 'settings-conflict', revision: err.actual });
              return;
            }
            throw err;
          }
          sendJson(res, 200, describeResponse(describeOwn(settingsService, NS) ?? desc));
        } catch (err) {
          sendJson(res, 400, { error: String(err && err.message ? err.message : err) });
        }
      },
    }), 'dsh-backup: settings route');
  });

  // 启动时恢复持久化的定时备份计划（不阻塞插件装配）；错过则在**启动宽限期之后**
  // 补跑——绝不在宿主 boot 窗口内启动 GB 级 tar（#103）。
  // 同处做升级前快照：宿主列车变化（升/降级）先拍一份 dsh-pre-upgrade- 安全网
  // 再继续——命中社区"想试新版怕搞坏"的最大恐惧。首见列车只记录不拍。
  void (async () => {
    await waitForSettingsReady();
    // 0.14.0：旧默认目录改名（只动从未配置过 destination 的用户）
    await migrateLegacyDefaultDir();
    await loadStoredGithubToken();
    await loadSyncChannels();
    const h = await loadAutoState();
    autoHours = h;
    if (autoEnabled() && !autoDispose) {
      scheduleAuto({ boot: true });
    }
    // 凭据哨兵：宿主首次读档会把扁平布局的 .credentials.yaml 原子替换成
    // version:1（不可逆——旧宿主读不回 versioned，官方 #6358）。启动即检测，
    // 是扁平就先存一份进 vault/preserved，给「升级失败想回退」留后路。
    try {
      const kept = await preserveFlatCredentials();
      if (kept) console.log(`[dsh-backup] 检测到旧版扁平布局凭据文件，已先存底再让宿主迁移: ${kept}`);
    } catch (err) {
      console.warn(`[dsh-backup] 凭据存底失败（不影响运行）: ${String(err && err.message ? err.message : err)}`);
    }
    const train = detectHostTrain();
    if (!train) return;
    if (lastTrain === null) {
      lastTrain = train;
      try {
        await saveAutoState();
      } catch { /* 记录失败不致命：下次启动重新记录 */ }
      return;
    }
    if (lastTrain === train) return;
    const oldTrain = lastTrain;
    // 列车快照同样是 GB 级重活：与自动补跑一样推迟到 boot 窗口之外，并走同一条
    // 无人值守队列（两者同时到点时串行而非并行）。失败时不更新 lastTrain，
    // 下次启动重试——语义与旧版一致。
    ctx.timeout(() => {
      void enqueueHeavy(async () => {
        try {
          const snap = await doBackup(undefined, undefined, { namePrefix: 'dsh-pre-upgrade-' });
          await prunePrefixedSnapshots('dsh-pre-upgrade-', 2, snap.name);
          lastTrain = train;
          await saveAutoState();
          console.log(`[dsh-backup] 宿主列车变化（${oldTrain} → ${train}），已自动拍升级前快照: ${snap.name}${snap.quarantined?.length ? `（${snap.quarantined.length} 个损坏会话文件未入档）` : ''}`);
        } catch (err) {
          console.warn(`[dsh-backup] 升级前快照失败（不影响运行，下次启动会重试）: ${String(err && err.message ? err.message : err)}`);
        }
      });
    }, AUTO_BOOT_GRACE_MS);
  })();
}
