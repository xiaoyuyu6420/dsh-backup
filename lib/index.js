/**
 * dsh-backup — 一键备份与恢复 DeepSeek Harness 用户数据。
 *
 * 备份 ~/.dsh（会话、配置、技能、凭据、插件配置），排除可重装的
 * node_modules，生成 sha256 校验和，自动轮换旧备份；定时自动备份
 * 状态落盘、重启续跑；跨平台（macOS / Linux / Windows）。
 *
 * - `/backup`                              立即备份（默认到 ~/Desktop/dsh-backups/）
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
 *
 * 安全说明（v0.7.0 起）：凭据文件（.credentials.yaml / .env / qq-bridge/config.json，
 * config.redact 可增删）默认脱敏——不进归档、不进 GitHub 同步，明文只存备份目录下
 * 的本机 vault（vault/，POSIX 700/600），恢复时自动拷回 ~/.dsh；跨机恢复（vault 为空）
 * 按 .redacted.json 清单提示重填。归档另携 .meta.json（主机/家目录/时间）供恢复预检：
 * 家目录不一致时提示绝对路径风险。config.redact=false/'off' 可回到 v0.6.x 明文行为
 * （不推荐）。归档与校验边车在 POSIX 上 chmod 600 仅本人可读写。
 * restore 会拒绝恢复含归档根目录之外条目的文件（tar 路径穿越防护）。
 *
 * 存储说明：插件自有数据（归档、校验和、auto.json）直接经 node:fs 写入
 * （与 dsh-session 持久化、skill-filesystem 同一模式）——ctx.fs 能力是
 * 模型面的沙箱 surface（workspace-write 会拒绝 Desktop），不适用于宿主
 * 插件的自有存储。
 */
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, readFileSync, realpathSync } from 'node:fs';
import { mkdir, open, copyFile, readdir, readFile, rename, rm, stat as fsStat, unlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { hostname } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as zlib from 'node:zlib';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import { settingsNamespace, SettingsConflictError } from '@deepseek-ai/dsh-settings';
import z from '@deepseek-ai/schemastery';

export const name = 'dsh-backup';
export const inject = ['subprocess', 'commands', 'timer', 'tools'];

/** Windows 无 POSIX chmod 语义（用户目录 ACL 默认私有）。 */
const IS_WIN = process.platform === 'win32';
/** sha256 回退路径（node:fs 读取 + node:crypto）的内存上限。 */
const HASH_MAX_BYTES = 256 * 1024 * 1024;
/** GitHub 单个文件 100MB 上限，留 10MB 余量。 */
const MAX_GITHUB_BYTES = 90 * 1024 * 1024;
/** 同步工作树目录名（位于备份目录下）。 */
const SYNC_DIR = '.github-sync';
/** Web 下载路由前缀（无尾斜杠：prefix 匹配语义为 pathname.startsWith(prefix + '/')）。 */
const DOWNLOAD_PREFIX = '/backup-download';
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
  const m = /^dsh-(\d{4})(\d{2})(\d{2})-\d{6}\d{3}\.tar\.gz$/.exec(name);
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

/** Settings 命名空间：经 `ctx.settings` 提供（持久化到 $DSH_HOME/settings.yaml）。 */
const NS = settingsNamespace('dsh-backup');

/**
 * 设置默认值。SCHEMA 的 .default() 与 resolveBase 的初始值都引用这里，
 * 避免同一字面量散落多处导致迁移逻辑漏改。
 */
const DEFAULTS = Object.freeze({
  destination: '~/Desktop/dsh-backups',
  exclude: [],
  redact: [...SENSITIVE_DEFAULTS],
  githubRepo: '',
});

/**
 * 解析 settings 命名空间的 schema，同时定义默认值。
 * Base 层：pluginConfig（cordis.patch.yml，插件级或 profile 级）。
 * User 层：Settings 面板运行时编辑，持久化到 settings.yaml。
 */
const SCHEMA = z.object({
  destination: z.string().default(DEFAULTS.destination),
  keep: z.number().min(0).default(0),
  exclude: z.array(z.string()).default(DEFAULTS.exclude),
  redact: z.union([z.array(z.string()), 'off']).default(DEFAULTS.redact),
  githubRepo: z.string().default(DEFAULTS.githubRepo),
});

const SETTINGS_FIELDS = ['destination', 'keep', 'exclude', 'redact', 'githubRepo'];

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

const PANEL_INVOCATIONS = Object.freeze([
  panelDescriptor('status', []),
  panelDescriptor('backup', ['keep'], true),
  panelDescriptor('verify', ['selector'], true),
  panelDescriptor('restore', ['selector', 'dryRun', 'syncDeps'], true),
  panelDescriptor('setAuto', ['hours']),
  panelDescriptor('githubStatus', []),
  panelDescriptor('githubSyncNow', [], true),
  panelDescriptor('githubPull', [], true),
  panelDescriptor('removeEntry', ['selector'], true),
  panelDescriptor('setGithubRepo', ['repo']),
  panelDescriptor('doctorScan', [], true),
  panelDescriptor('doctorRepair', ['selector'], true),
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

  /** 立即备份。 */
  backup(keep, signal) {
    return this.ops.backup(keep, signal);
  }

  /** 校验（selector=前缀|all|latest）。 */
  verify(selector, signal) {
    return this.ops.verify(selector, signal);
  }

  /** 恢复（dryRun 仅预览；syncDeps 恢复后重装 profile 依赖）。 */
  restore(selector, dryRun, syncDeps, signal) {
    return this.ops.restore(selector, dryRun, syncDeps, signal);
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
}

export function apply(ctx, pluginConfig) {
  // ---------- Settings seam ----------
  // settings 服务可选：无该服务的 profile（非 Web）回退到 pluginConfig base 层。
  let settingsService;
  ctx.inject(['settings'], (sctx) => {
    settingsService = sctx.settings;
    settingsService.register(NS, SCHEMA, { base: resolveBase(pluginConfig) });
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
   * 读取 subprocess 收集的输出流。dsh-subprocess 的收集契约：输出超过
   * maxBytes（8192）时内存窗口只保留尾部（readFrom 返回 lossy: true），
   * 完整输出 spill 到 spillPath——restore 的 `tar -tvzf` 校验清单必须看
   * 全量，否则大归档的校验可被清单前段的恶意条目绕过（8KB 尾窗看不到）。
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
    const dshHome = env?.get('DSH_HOME')?.value || (home ? `${home}/.dsh` : undefined);
    if (!home || !dshHome) throw new Error('无法解析 HOME/USERPROFILE 或 DSH_HOME（launchEnvironment 缺失）');
    const cfg = resolvedConfig();
    const raw = typeof cfg.destination === 'string' && cfg.destination.trim()
      ? cfg.destination.trim()
      : DEFAULTS.destination;
    const root = raw.startsWith('~') ? `${home}${raw.slice(1)}` : toFwd(raw);
    return { home, dshHome: toFwd(dshHome), root };
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
    await rm(vaultDir, { recursive: true, force: true });
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
      .filter((d) => d.name.startsWith(prefix) && (d.name.endsWith('.tar.gz') || d.name.endsWith('.sha256') || d.name.endsWith('.meta.json') || d.name.endsWith('.redacted.json')))
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
    return [name, `${name}.sha256`, `${name}.meta.json`, `${name}.redacted.json`];
  }

  /** 内部快照前缀（恢复前 / 升级前）：不进用户列表、不参与轮换与 keep 配额。 */
  const SNAPSHOT_PREFIXES = Object.freeze(['dsh-pre-restore-', 'dsh-pre-upgrade-']);

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
      if (!d.name.startsWith('dsh-') || SNAPSHOT_PREFIXES.some((p) => d.name.startsWith(p)) || !d.name.endsWith('.tar.gz')) continue;
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
      backups.push({ name: d.name, size });
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

  // 校验和：POSIX 优先 sha256sum（macOS 回退 shasum）流式计算；
  // 都不可用时（Windows）回退 node:fs 读取 + node:crypto 内存哈希。
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
    const info = await fsStat(absPath);
    if (info.size > HASH_MAX_BYTES) {
      throw new Error(`计算 sha256 失败：文件 ${Math.floor(info.size / 1048576)}MB 超过 ${Math.floor(HASH_MAX_BYTES / 1048576)}MB 回退上限`);
    }
    const bytes = await readFile(absPath);
    return createHash('sha256').update(bytes).digest('hex');
  }

  async function doBackup(keep, signal, opts = {}) {
    const { home, dshHome, root } = paths();
    const keepN = keep && keep > 0 ? Math.floor(keep) : defaultKeep();
    // 状态文件先写：writeText 会自动创建备份目录，替代 mkdir -p（Windows 无 mkdir.exe）。
    await saveAutoState();

    const prefix = typeof opts?.namePrefix === 'string' && opts.namePrefix ? opts.namePrefix : 'dsh-';
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
    const redacted = opts?.skipVault ? await existingSensitive(dshHome) : await refreshVault(dshHome, home, signal);
    const tar = await ctx.subprocess.resolveExecutable('tar');
    await spawnRun([tar, '--exclude=*node_modules*', '--exclude=.system', ...quarantineFlags, ...redactExcludeFlags(base), ...extraExcludes(), '-czf', name, '-C', parent, base], root, signal);

    const shaText = await sha256File(out, home, signal);
    await writeOwned(`${out}.sha256`, `${shaText}  ${out}\n`);
    // 脱敏清单边车：恢复侧据其判断归档是否脱敏、需要从 vault 还原哪些文件。
    if (sensitivePaths().length) {
      await writeOwned(`${out}.redacted.json`, `${JSON.stringify({ files: redacted })}\n`);
    }
    // 机器元数据边车：跨机恢复的预检依据（home 不一致 → 绝对路径提示）；
    // quarantined 记录体检隔离、未入档的损坏会话文件。
    await writeOwned(`${out}.meta.json`, `${JSON.stringify({ host: hostname(), home, dshHome, createdAt: new Date().toISOString(), redacted: redacted.length, ...(quarantined.length ? { quarantined } : {}) })}\n`);

    // 救援通道：每次备份把进程外恢复工具落进备份目录——宿主起不来时
    // `node rescue.mjs`（或双击启动器）仍可恢复（DSH 依赖 Node，宿主死了
    // Node 一定活着）。复制失败不阻断备份：rescue 缺席只影响灾时体验。
    try {
      await copyFile(new URL('../rescue/rescue.mjs', import.meta.url), `${root}/rescue.mjs`);
      await writeOwned(`${root}/RESCUE.txt`, RESCUE_TXT);
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
    // Windows 无 chmod，用户目录 ACL 默认私有。
    if (!IS_WIN) {
      const chmod = await ctx.subprocess.resolveExecutable('chmod');
      await spawnRun([chmod, '600', out, `${out}.sha256`], home, signal);
    }

    // 分级轮换：keep 窗口之外的尾巴不再一刀切全删——保留最近 7 个不同自然日
    // 的每日首份、再往前 4 个不同 ISO 周的每周首份（今日的档内冗余仍按 keep
    // 裁剪）。严格只比旧的"全删"多保留，绝不多删；非标准命名（解析不出日期）
    // 保持旧行为不保护。skipRotate：恢复流程中途拍的快照绝不顺带轮换——
    // 目标归档可能正落在 keep 窗口外，轮换会删掉马上要解压的文件（review P1-3）。
    const all = await listBackups();
    let stale = [];
    if (!opts.skipRotate) {
      const tail = all.slice(keepN);
      stale = tail.filter((b) => !tierProtectedSet(tail, all[0]?.name).has(b.name)).map((b) => b.name);
      if (stale.length) {
        await removeFiles(stale.flatMap((n) => sidecarsFor(n)), root, signal);
      }
    }

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

    return { path: out, name, sha: shaText, total: all.length, stale: stale.length, keep: keepN, quarantined, sync };
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
    const token = env?.get('DSH_BACKUP_GITHUB_TOKEN')?.value || env?.get('GITHUB_TOKEN')?.value;
    // 本地路径（测试/自托管）或 http(s) 全 URL 直接使用，否则视为 owner/repo。
    const repo = raw.includes('://') || /^[A-Za-z]:[\\/]|^\//.test(raw) ? raw : `https://github.com/${raw}.git`;
    return { repo: stripUserinfo(repo.split('\\').join('/')), token };
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
      return { reason: 'https 远端缺少 token（环境变量 DSH_BACKUP_GITHUB_TOKEN 或 GITHUB_TOKEN）' };
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
      // 边车随归档转正（缺失的可选边车跳过）
      for (const side of [`${name}.sha256`, `${name}.meta.json`, `${name}.redacted.json`]) {
        await copyFile(`${syncDir}/${side}`, `${root}/${side}`).catch((err) => {
          if (err && err.code === 'ENOENT') return;
          throw err;
        });
      }
      pulled.push(name);
    }
    return { pulled, corrupt, total: wanted.length };
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
      if (!/^dsh-[A-Za-z0-9._-]+\.tar\.gz$/.test(name)) {
        res.writeHead(400);
        res.end('bad name');
        return;
      }
      const { root } = paths();
      const abs = `${root}/${name}`;
      await fsStat(abs);
      res.writeHead(200, {
        'Content-Type': 'application/gzip',
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
    if (!/^[0-9a-f]{64}$/.test(expected)) {
      return { name, ok: false, note: '缺少或无效的配套校验文件（.sha256）——无法确认这份备份是否完好' };
    }
    const actual = await sha256File(archive, home, signal);
    return { name, ok: actual === expected, note: actual === expected ? '完整' : '校验和不匹配（归档或校验文件之一可能损坏）' };
  }

  async function pickArchive(selector) {
    const all = await listBackups();
    if (!all.length) throw new Error('暂无备份');
    if (!selector || selector === 'latest') return all[0];
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
      throw new Error(`没有匹配 "${selector}" 的备份，/backup list 查看`);
    }
    throw new Error(`"${selector}" 匹配多份备份，请加长前缀：\n${hits.slice(0, 5).map((b) => `  ${b.name}`).join('\n')}`);
  }

  /** 删除指定备份（归档 + 全部边车）；选择器经 pickArchive 精确匹配，杜绝路径穿越。 */
  async function removeBackup(selector, signal) {
    const { root } = paths();
    const picked = await pickArchive(selector);
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
    return { type: f[0][0], name: f.slice(nameIdx).join(' ').replace(/\/$/, '') };
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
    const listed = await spawnRun([tar, '-tvzf', pickedName], root, signal);
    // tar 路径穿越防护：逐行解析 -tvzf 输出（双布局，见 parseTarEntry），
    // 条目必须是普通文件/目录、相对路径且位于备份根目录之下；任一违规
    // 即整体拒绝，恢复绝不触碰备份根之外的文件。
    const entries = [];
    const bad = [];
    for (const line of listed.out.split('\n')) {
      const s = line.trim();
      if (!s) continue;
      const parsed = parseTarEntry(s);
      // 反斜杠归一化后再做全部路径检查：`.dsh/..\..\escape.txt` 与
      // `/` 分隔的 `..` 段同样拒绝（Windows 风格路径变体）
      const name = parsed ? parsed.name.replace(/\\/g, '/').replace(/\/$/, '') : null;
      if (
        !parsed || !name
        || (parsed.type !== '-' && parsed.type !== 'd')
        || name.startsWith('/') || /^[A-Za-z]:/.test(name)
        || name.split('/').includes('..')
        || (name !== base && !name.startsWith(`${base}/`))
      ) {
        bad.push(parsed ? name : s);
      } else {
        entries.push(name);
      }
    }
    if (bad.length) {
      throw new Error(`归档包含不安全条目（拒绝恢复）：${bad.slice(0, 3).join(', ')}，恢复已中止`);
    }
    return entries;
  }

  async function restoreArchive(selector, dryRun, signal, opts = {}) {
    const { home, dshHome, root } = paths();
    const picked = await pickArchive(selector);
    const archive = `${root}/${picked.name}`;

    // 恢复前强制校验：损坏的归档绝不覆盖现有数据。
    const v = await verifyOne(picked.name, home, signal);
    if (!v.ok) throw new Error(`校验未通过（${v.note}），恢复已中止`);

    const base = dshHome.split('/').pop();
    const parent = dshHome.slice(0, -(base.length + 1)) || '/';
    const entries = await safeArchiveEntries(picked.name, signal);

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
      await spawnRun([tar, '-xzf', picked.name, '-C', parent], root, signal);
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

  // ---------- 会话日志体检（doctor） ----------
  //
  // 布局与格式依据宿主内置的 @deepseek-ai/dsh-session-persistence-jsonl：
  //   <会话根>/--<项目目录>--/<编码后 id>/session.jsonl.zstd（compression:'none' 时为 .jsonl）
  // zstd 文件是独立帧的拼接：首帧是带校验和的 SessionHeader 行，其后每个追加批一帧。
  // Node 内置 zstd 解码器不跨帧续读，因此先按 RFC 8878 走帧字节边界
  // （魔数/帧头/块序列/校验和），再逐帧解出逻辑行。检测目标正是社区高频的
  // "corrupt session log"灾难：并发写 seq 撞号、坏帧、尾部截断。
  const ZSTD_MAGIC = 0xfd2fb528;
  const SESSION_LOG_NAMES = new Set(['session.jsonl.zstd', 'session.jsonl']);
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
   * 结构不合法（截断/未知魔数/保留位/越界块）抛错。skippable 帧一并支持。
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
        if (buf.length - off < 8) throw new Error('skippable 帧头截断');
        const size = buf.readUInt32LE(off + 4);
        const end = off + 8 + size;
        if (end > buf.length) throw new Error('skippable 帧数据越界');
        frames.push([off, end]);
        off = end;
      } else {
        throw new Error(`偏移 ${off} 处不是 zstd 帧魔数`);
      }
    }
    return frames;
  }

  /** 解出 .zstd 会话日志的全部逻辑行；任一帧损坏即抛错（错误含偏移信息）。 */
  function decodeZstdLog(buf) {
    const parts = [];
    let frameNo = 0;
    for (const [s, e] of walkZstdFrames(buf)) {
      frameNo += 1;
      try {
        parts.push(zlib.zstdDecompressSync(buf.subarray(s, e)));
      } catch (err) {
        throw new Error(`第 ${frameNo} 帧解压失败（${e - s}B）：${String(err && err.message ? err.message : err)}`);
      }
    }
    return Buffer.concat(parts).toString('utf8').split('\n').filter((l) => l.length > 0);
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
    if (!header || typeof header !== 'object' || header.type !== 'session' || typeof header.id !== 'string') {
      return '首行不是有效的 SessionHeader（缺 type:"session" 或 id）';
    }
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
  async function collectSessionLogs(dir, relPrefix, depth, out) {
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
        await collectSessionLogs(`${dir}/${d.name}`, rel, depth + 1, out);
      } else if (SESSION_LOG_NAMES.has(d.name)) {
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
      if (f.abs.endsWith('.zstd')) {
        lines = decodeZstdLog(await readFile(f.abs));
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

  /**
   * 定点修复：扫描出损坏的会话日志后，从指定归档（缺省最新一份，须通过
   * sha256 校验）里提取同名条目覆盖。只动损坏的文件本身——不做整库 aside
   * 切换；每个被覆盖的损坏文件先就地留档为 `<原名>.corrupt-<时间戳>`。
   * 归档里没有对应条目的文件列入 unrecoverable（提示改用全量恢复）。
   */
  async function runDoctorRepair(selector, signal) {
    const { home, dshHome, root } = paths();
    const scan = await runDoctorScan(signal);
    if (!scan.corruptCount) return { repaired: [], unrecoverable: [], stillBad: [], scanned: scan.scanned, summary: summarizeDoctorScan(scan) };

    const picked = await pickArchive(selector || 'latest');
    const v = await verifyOne(picked.name, home, signal);
    if (!v.ok) throw new Error(`归档校验未通过（${v.note}），定点修复已中止`);
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

    // 提取可能半途失败、只替换了一部分目标——对齐恢复流程 #28 的回滚哲学：
    // 用留档副本尽力还原每个目标的修复前状态；连还原都失败时把留档路径
    // 交代清楚，绝不静默停在最糟的中间态。
    try {
      const tar = await ctx.subprocess.resolveExecutable('tar');
      await spawnRun([tar, '-xzf', picked.name, '-C', parent, ...targets.map((t) => t.entry)], root, signal);
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
  let lastAuto = null;
  let lastAutoAt = null;
  let githubState = { repo: null, lastPush: null, lastError: null };
  // 上次见到的宿主列车（detectHostTrain 代理值）：null=尚未记录（首启动只记
  // 录不拍快照），非 null 且变化 → 升/降级 → 自动拍 dsh-pre-upgrade- 快照。
  let lastTrain = null;

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
      await writeOwned(tmp, `${JSON.stringify({ hours: autoHours, lastAutoAt, github: githubState, lastTrain })}\n`);
      await rename(tmp, target);
    } catch (err) {
      await rm(tmp, { force: true }).catch(() => {});
      throw err;
    }
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
      lastTrain = typeof parsed?.lastTrain === 'string' && parsed.lastTrain ? parsed.lastTrain : null;
      return Number.isFinite(h) && h >= 1 && h <= 720 ? Math.floor(h) : 0;
    } catch (err) {
      // ENOENT = 首次使用还没有 auto.json，是正常初始状态，静默按未配置处理；
      // 其他读取失败（解析错误/权限）才值得告警，且文案要给"影响 + 出路"。
      if (err && err.code !== 'ENOENT') {
        console.warn(`[dsh-backup] 自动备份计划文件读取失败，定时备份已暂停（不影响已有备份）：执行 /backup auto <小时数> 可重新开启（${String(err && err.message ? err.message : err)}）`);
      }
      return 0;
    }
  }

  /** 下次自动备份触发时间（毫秒）：上次执行 + 周期；无锚点从当前时间起算。 */
  function nextAutoAt() {
    const cycle = autoHours * 3600 * 1000;
    // 非法/缺失 lastAutoAt 按 0 处理：从当前时间起算，避免 NaN 传染延迟计算
    const anchor = (Number(new Date(lastAutoAt)) || 0) + cycle;
    return Math.max(anchor, Date.now());
  }

  /** 本地时间显示：YYYY-MM-DD HH:mm——不依赖运行时 locale（裸跑环境会落 en-US）。 */
  function formatWhen(ts) {
    const d = new Date(ts);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  function autoSummary() {
    if (!autoDispose) return '自动备份未开启（/backup auto <N小时> 开启）';
    // 绝对节奏：下次 = 上次执行 + 周期；错过（重启间隔超周期）则按现在显示，调度会立即补跑。
    return `自动备份已开启：每 ${autoHours} 小时一次（已持久化，重启续跑），下次 ${formatWhen(nextAutoAt())}${lastAuto ? `；上次自动备份: ${lastAuto}` : ''}`;
  }

  /** 链式 timeout 调度：每次触发后按上次执行时间推算下一次，重启后节奏不重置。 */
  function scheduleAuto() {
    // 关闭竞态保护：auto off 时 in-flight 备份完成后的续链会以 autoHours=0
    // 算出 delay=0，形成无限备份循环——关闭后绝不续链。
    if (autoHours <= 0) return;
    const delay = nextAutoAt() - Date.now();
    autoDispose = ctx.timeout(async () => {
      await runAutoBackup();
      scheduleAuto();
    }, delay);
  }

  async function runAutoBackup() {
    try {
      const r = await doBackup(autoKeep());
      lastAuto = r.path.split('/').pop();
      lastAutoAt = new Date().toISOString();
      await saveAutoState();
      console.log(`[dsh-backup] 自动备份完成: ${r.path} (sha ${r.sha.slice(0, 12)}…)`);
    } catch (err) {
      // 失败也推进内存锚点：否则下次 delay=0 立即重试形成热循环。不落盘
      // （失败路径 auto.json 大概率也写失败），下次成功备份会持久化。
      lastAutoAt = new Date().toISOString();
      console.error(`[dsh-backup] 自动备份失败: ${String(err && err.message ? err.message : err)}`);
    }
  }

  async function setAuto(h) {
    if (autoDispose) { autoDispose(); autoDispose = null; }
    autoHours = h;
    lastAutoAt = null;
    if (h > 0) scheduleAuto();
    await saveAutoState();
  }

  // ---------- /backup 命令 ----------
  ctx.commands.register({
    name: 'backup',
    description: '备份/恢复 DSH 数据；子命令: list | verify [前缀|all] | restore <前缀|latest> [--dry-run] [--sync-deps] | doctor [--repair <前缀|latest>] | auto [N小时|off] | github status|sync|pull|repo | [--keep N]',
    handler: async (invocation) => {
      const input = invocation.rawInput.trim();
      try {
        const parts = input.split(/\s+/).filter(Boolean);
        const head = parts[0] || '';
        const { home } = paths();

        if (head === 'list') {
          const all = await listBackups();
          const total = all.reduce((s, b) => s + (b.size || 0), 0);
          const lines = all.map((b) => `  ${b.name}${b.size !== undefined ? `  ${(b.size / 1048576).toFixed(1)}MB` : ''}`);
          // 内部快照分区展示：升级前（最多 2 份）/ 恢复前（最近 1 份），可按前缀选用
          const snaps = await listSnapshotNames('dsh-pre-');
          const snapLines = snaps.map((n) => `  ${n}${n.startsWith('dsh-pre-upgrade-') ? '  （升级前快照）' : '  （恢复前快照）'}`);
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
          const r = await restoreArchive(sel, dryRun, invocation.signal, { syncDeps });
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
          const h = Number(arg);
          if (!Number.isFinite(h) || h < 1 || h > 720) {
            return { kind: 'error', text: '小时数需为 1~720 之间的数字（如 /backup auto 12）' };
          }
          await setAuto(h);
          return { kind: 'success', text: `✅ 自动备份已开启：每 ${h} 小时执行一次（保留 ${autoKeep()} 份，已持久化）。\n首次备份正在执行，之后每 ${h} 小时一次。\n${autoSummary()}` };
        }

        let keep;
        const m = input.match(/--keep\s+(\d+)/);
        if (m) keep = Number(m[1]);
        const r = await doBackup(keep, invocation.signal);
        return {
          kind: 'success',
          text: `✅ 备份完成\n  文件: ${r.path}\n  校验和: ${r.sha.slice(0, 16)}…\n  轮换: 删除 ${r.stale} 份旧备份（保留 ${r.keep} 份）${quarantineNote(r)}\n  ${autoSummary()}`,
        };
      } catch (err) {
        return { kind: 'error', text: `备份失败: ${friendlyReason(err)}` };
      }
    },
  });

  // ---------- backup_dsh 模型工具 ----------
  ctx.tools.register(defineTool({
    name: 'backup_dsh',
    description: '备份、校验、恢复或体检 DSH 用户数据（~/.dsh 的会话、配置、技能）。凭据文件默认脱敏：不进归档、不进 GitHub 同步，明文只存本机 vault，恢复时自动还原。mode=backup 立即备份（keep 指定保留份数）；mode=list 列出备份；mode=verify 校验完整性（selector=前缀或 all，缺省最新一份）；mode=restore 恢复（selector=前缀或 latest，syncDeps 恢复后重装 profile 依赖；恢复前自动校验并快照当前数据，解压失败自动还原；真实恢复前必须先 dryRun=true 预览并向用户展示确认）；mode=auto 设置定时备份（hours 间隔小时数，0=关闭，缺省查询）；mode=doctor 会话日志体检——检测损坏的会话历史（seq 撞号/坏帧/截断），repair=true 时从 selector 归档定点修复',
    parameters: {
      mode: { type: 'string', required: true, enum: ['backup', 'list', 'verify', 'restore', 'auto', 'doctor'], description: 'backup=执行备份，list=列出备份，verify=校验完整性，restore=恢复，auto=定时备份，doctor=会话日志体检' },
      keep: { type: 'number', description: '保留的备份份数（mode=backup，默认 7）' },
      hours: { type: 'number', description: '定时备份间隔小时数（mode=auto；0=关闭；缺省=查询状态）' },
      selector: { type: 'string', description: '备份选择器（mode=verify/restore/doctor）：归档名前缀、latest 或 all' },
      dryRun: { type: 'boolean', description: 'mode=restore 时仅预览（不写入）；真实恢复前必须先预览并向用户展示确认' },
      syncDeps: { type: 'boolean', description: 'mode=restore 时恢复后对各 profile 执行 pnpm install 重装插件依赖' },
      repair: { type: 'boolean', description: 'mode=doctor 时从 selector 归档定点修复损坏的会话日志（缺省仅扫描）' },
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
          return { ok: true, summary: `已有 ${all.length} 份备份:\n${all.map((b) => `  ${b.name}`).join('\n') || '（无）'}\n\n${autoSummary()}` };
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
          const r = await restoreArchive(selector || 'latest', Boolean(args && args.dryRun), signal, { syncDeps: Boolean(args && args.syncDeps) });
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
        const r = await doBackup(args && args.keep ? args.keep : undefined, signal);
        return { ok: true, path: r.path, sha: r.sha, summary: `备份完成: ${r.path}\nsha256: ${r.sha}\n轮换删除 ${r.stale} 份（保留 ${r.keep} 份）${quarantineNote(r)}` };
      } catch (err) {
        return { ok: false, summary: `操作失败: ${friendlyReason(err)}` };
      }
    },
  }));

  // ---------- Settings 面板（Web）：backupPanel Remote ----------
  const panelOps = {
    status: async () => {
      const all = await listBackups();
      const { root, dshHome } = paths();
      return {
        destination: root,
        dshHome,
        keepDefault: defaultKeep(),
        autoHours,
        lastAuto,
        backups: all.map((b) => ({ name: b.name, size: typeof b.size === 'number' ? b.size : null })),
      };
    },
    backup: async (keep, signal) => {
      const r = await doBackup(keep, signal);
      // 面板回执给"成了、叫什么、存哪了"；64 位 sha 全文是噪音（完整值就在
      // 归档旁的 .sha256），路径用文件名——目录已显示在上方总览卡
      return {
        ok: true,
        summary: `备份完成: ${r.path.split('/').pop()}\nsha256: ${r.sha.slice(0, 16)}…（完整校验值在归档旁的 .sha256 文件）${r.stale ? `\n轮换删除 ${r.stale} 份旧备份（保留 ${r.keep} 份）` : ''}${quarantineNote(r)}`,
        path: r.path,
        sha: r.sha,
        stale: r.stale,
        keep: r.keep,
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
    restore: async (selector, dryRun, syncDeps, signal) => {
      try {
        const r = await restoreArchive(selector || 'latest', Boolean(dryRun), signal, { syncDeps: Boolean(syncDeps) });
        if (r.dryRun) {
          return { ok: true, dryRun: true, archive: r.archive, files: r.files, sample: r.sample, preflight: r.preflight ?? [], targetExists: r.targetExists, summary: summarizeRestore(r) };
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
        tokenSet: Boolean(cfg?.token),
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
          if (req.method === 'GET' || req.method === 'HEAD') {
            sendJson(res, 200, describeResponse(describeOwn(settingsService, NS)));
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
          sendJson(res, 200, describeResponse(describeOwn(settingsService, NS)));
        } catch (err) {
          sendJson(res, 400, { error: String(err && err.message ? err.message : err) });
        }
      },
    }), 'dsh-backup: settings route');
  });

  // 启动时恢复持久化的定时备份计划（不阻塞插件装配）；错过则 delay=0 立即补跑。
  // 同处做升级前快照：宿主列车变化（升/降级）先拍一份 dsh-pre-upgrade- 安全网
  // 再继续——命中社区"想试新版怕搞坏"的最大恐惧。首见列车只记录不拍。
  void (async () => {
    await waitForSettingsReady();
    const h = await loadAutoState();
    if (h > 0 && !autoDispose) {
      autoHours = h;
      scheduleAuto();
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
    try {
      const snap = await doBackup(undefined, undefined, { namePrefix: 'dsh-pre-upgrade-' });
      await prunePrefixedSnapshots('dsh-pre-upgrade-', 2, snap.name);
      lastTrain = train;
      await saveAutoState();
      console.log(`[dsh-backup] 宿主列车变化（${oldTrain} → ${train}），已自动拍升级前快照: ${snap.name}${snap.quarantined?.length ? `（${snap.quarantined.length} 个损坏会话文件未入档）` : ''}`);
    } catch (err) {
      console.warn(`[dsh-backup] 升级前快照失败（不影响运行，下次启动会重试）: ${String(err && err.message ? err.message : err)}`);
    }
  })();
}
