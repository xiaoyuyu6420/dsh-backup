/**
 * `dsh-backup` 浏览器半边：挂载 `backupPanel` Remote 贡献，并在 Settings
 * 的 Plugins 区注册「备份」标签页（`settings.plugins.tab`，id `backup`）。
 * 所有数据经 `remote.backupPanel` 命名空间往返——标签页不持有其它 RPC，
 * 也不自带除展开/预览以外的状态。
 *
 * 本文件由 scripts/build-client.mjs 打包为 lib/client.js（CJS 工厂包裹，
 * React/Cordis/客户端 UI 包保持 external，zod 内联），无需在仓库内直接运行。
 */

import { z } from 'zod';
import { BackupTab, BackupTabFallback } from './tab.jsx';
import { zh, en } from './locales.js';
import { installPanelStyles } from './styles.js';
import pkg from '../package.json' with { type: 'json' };

/** 字典命名空间（本插件拥有）。 */
export const NS = 'settings.backupPanel';

/** 插件名：取自 package.json name，随包名变（fork 改名自动跟随）。 */
export const name = pkg.name;

/** 标签页读取的服务；`remote.backupPanel` 随本插件挂载贡献后出现。 */
export const inject = ['slots', 'locale', 'remote'];

const statusSchema = z.object({
  destination: z.string(),
  dshHome: z.string(),
  keepDefault: z.number().int(),
  autoHours: z.number().int(),
  lastAuto: z.string().nullable(),
  backups: z.array(z.object({
    name: z.string(),
    size: z.number().int().nullable(),
  })),
  typedBackups: z.array(z.object({
    name: z.string(),
    size: z.number().int().nullable(),
    types: z.array(z.string()),
  })).optional(),
});

const backupSchema = z.object({
  ok: z.boolean(),
  summary: z.string(),
  path: z.string(),
  sha: z.string(),
  stale: z.number().int(),
  keep: z.number().int(),
  encrypted: z.boolean().optional(),
  types: z.array(z.string()).optional(),
  hasCredentials: z.boolean().optional(),
});

const verifySchema = z.object({
  ok: z.boolean(),
  summary: z.string(),
  results: z.array(z.object({
    name: z.string(),
    ok: z.boolean(),
    note: z.string(),
  })),
});

const restoreSchema = z.object({
  ok: z.boolean(),
  dryRun: z.boolean(),
  summary: z.string(),
  archive: z.string().nullable().optional(),
  files: z.number().int().nullable().optional(),
  aside: z.string().nullable().optional(),
  snapshotPath: z.string().nullable().optional(),
  sample: z.array(z.string()).optional(),
  // 恢复预检提示（🔐凭据/📦依赖/⚠️跨机）与目标是否已有数据——预览弹窗渲染用
  preflight: z.array(z.string()).optional(),
  targetExists: z.boolean().nullable().optional(),
  // 分类型 merge 恢复（types 非空时出现）
  merge: z.boolean().optional(),
  types: z.array(z.string()).optional(),
  willOverwrite: z.array(z.string()).optional(),
  restored: z.number().int().optional(),
  kept: z.array(z.string()).optional(),
  // 加密归档（backup({password}) 产出）
  encrypted: z.boolean().optional(),
});

const setAutoSchema = z.object({
  ok: z.boolean(),
  hours: z.number().int(),
  summary: z.string(),
});

const githubStatusSchema = z.object({
  repoRaw: z.string().nullable(),
  repo: z.string().nullable(),
  tokenSet: z.boolean(),
  syncDir: z.string(),
  lastPush: z.string().nullable(),
  lastError: z.string().nullable(),
});

const githubSyncSchema = z.object({
  ok: z.boolean(),
  summary: z.string(),
  pushed: z.boolean(),
  tooBig: z.array(z.string()),
});

const githubPullSchema = z.object({
  ok: z.boolean(),
  summary: z.string(),
  pulled: z.array(z.string()),
  corrupt: z.array(z.string()),
  total: z.number().int(),
});

const removeSchema = z.object({
  ok: z.boolean(),
  summary: z.string(),
});

const setGithubRepoSchema = z.object({
  ok: z.boolean(),
  repo: z.string().nullable(),
  summary: z.string(),
});

const updateCheckSchema = z.object({
  ok: z.boolean(),
  current: z.string(),
  latest: z.string().nullable(),
  update: z.boolean(),
  error: z.string().nullable(),
  summary: z.string(),
});

const updateSchema = z.object({
  ok: z.boolean(),
  updated: z.boolean(),
  current: z.string().nullable(),
  latest: z.string().nullable(),
  summary: z.string(),
});

// P2：导出 / 导入（宿主契约见 lib/index.js 的 backupPanel RPC 契约注释）。
const exportConfigSchema = z.object({
  ok: z.boolean(),
  summary: z.string(),
  path: z.string().optional(),
  name: z.string().optional(),
  size: z.number().int().optional(),
  encrypted: z.boolean().optional(),
  manifest: z.unknown().optional(),
  redactedFiles: z.array(z.string()).optional(),
});

const importPreviewSchema = z.object({
  ok: z.boolean(),
  summary: z.string(),
  encrypted: z.boolean().optional(),
  manifest: z.unknown().optional(),
  sections: z.array(z.object({
    key: z.string(),
    label: z.string().optional(),
    files: z.number().int().optional(),
    bytes: z.number().optional(),
    conflicts: z.array(z.object({ name: z.string(), rel: z.string().optional(), exists: z.boolean().optional() })).optional(),
  })).optional(),
  totalFiles: z.number().int().optional(),
  totalBytes: z.number().optional(),
  conflicts: z.array(z.object({ name: z.string(), rel: z.string().optional(), section: z.string().optional(), exists: z.boolean().optional() })).optional(),
  remap: z.array(z.unknown()).optional(),
  compatibility: z.object({ score: z.string().optional(), reasons: z.array(z.string()).optional() }).optional(),
});

const importApplySchema = z.object({
  ok: z.boolean(),
  summary: z.string(),
  encrypted: z.boolean().optional(),
  applied: z.number().int().optional(),
  skipped: z.number().int().optional(),
  overwrote: z.number().int().optional(),
  snapshot: z.string().nullable().optional(),
  remapped: z.number().int().optional(),
});

// P3：多通道同步 / GFS / 操作锁 / 磁盘占用 / 每周调度（契约见 lib/index.js 注释）。
const syncStatusSchema = z.object({
  ok: z.boolean(),
  summary: z.string(),
  channels: z.object({
    github: z.unknown().optional(),
    webdav: z.unknown().optional(),
    s3: z.unknown().optional(),
    gist: z.unknown().optional(),
  }).optional(),
});

const syncNowSchema = z.object({
  ok: z.boolean(),
  summary: z.string(),
  pushed: z.boolean().optional(),
  count: z.number().int().optional(),
  at: z.string().optional(),
  tooBig: z.array(z.string()).optional(),
  gistUrl: z.string().nullable().optional(),
});

const setSyncChannelSchema = z.object({ ok: z.boolean(), summary: z.string(), channel: z.string().optional() });
const removeSyncChannelSchema = z.object({ ok: z.boolean(), summary: z.string() });

const lockStatusSchema = z.object({
  ok: z.boolean(),
  held: z.boolean().optional(),
  stale: z.boolean().optional(),
  pid: z.number().int().nullable().optional(),
  operation: z.string().nullable().optional(),
  startedAt: z.string().nullable().optional(),
  heartbeatAt: z.string().nullable().optional(),
});
const reclaimLockSchema = z.object({ ok: z.boolean(), summary: z.string() });

const diskUsageSchema = z.object({
  ok: z.boolean(),
  total: z.number().optional(),
  totalText: z.string().optional(),
  categories: z.array(z.object({ key: z.string(), label: z.string().optional(), bytes: z.number().optional(), files: z.number().int().optional() })).optional(),
  summary: z.string(),
});
const cleanupSchema = z.object({ ok: z.boolean(), removed: z.number().int().optional(), names: z.array(z.string()).optional(), summary: z.string() });
const setWeeklySchema = z.object({ ok: z.boolean(), weekly: z.array(z.object({ day: z.number().int(), time: z.string() })).optional(), summary: z.string() });

// P4：About 环境信息（脱敏：无凭据/密钥/home 明文）。
const aboutSchema = z.object({
  ok: z.boolean(),
  version: z.string().optional(),
  dshVersion: z.string().optional(),
  platform: z.string().optional(),
  node: z.string().optional(),
  profile: z.string().optional(),
  pluginDir: z.string().optional(),
});

// P4b-1：Profiles 管理。
const profilesListSchema = z.object({
  ok: z.boolean(),
  summary: z.string(),
  profiles: z.array(z.object({
    name: z.string(),
    version: z.string().optional(),
    appOwned: z.boolean().optional(),
    readonly: z.boolean().optional(),
    running: z.boolean().optional(),
    pid: z.number().int().nullable().optional(),
  })).optional(),
});
const profileCreateSchema = z.object({ ok: z.boolean(), summary: z.string(), name: z.string().optional() });
const profileRenameSchema = z.object({ ok: z.boolean(), summary: z.string(), from: z.string().optional(), to: z.string().optional() });
const profileDeleteSchema = z.object({ ok: z.boolean(), summary: z.string(), name: z.string().optional() });
const profileLaunchSchema = z.object({ ok: z.boolean(), summary: z.string(), pid: z.number().int().nullable().optional(), running: z.boolean().optional() });
const profileStopSchema = z.object({ ok: z.boolean(), summary: z.string(), running: z.boolean().optional() });

// P4b-2：配置市场。
const marketEntrySchema = z.object({
  id: z.string(),
  name: z.string(),
  desc: z.string().optional(),
  sections: z.array(z.string()).optional(),
  url: z.string().optional(),
  source: z.string().optional(),
  risk: z.string().optional(),
  version: z.string().optional(),
});
const marketListSchema = z.object({ ok: z.boolean(), enabled: z.boolean().optional(), entries: z.array(marketEntrySchema).optional(), summary: z.string() });
const marketSearchSchema = marketListSchema;
const marketInstallSchema = z.object({
  ok: z.boolean(),
  dryRun: z.boolean().optional(),
  entry: z.object({ id: z.string(), name: z.string().optional() }).optional(),
  preview: z.unknown().optional(),
  applied: z.unknown().optional(),
  supplyChain: z.array(z.string()).optional(),
  summary: z.string(),
});

// P4b-3：外部 agent 导入。
const foreignSourceSchema = z.object({
  id: z.string(),
  label: z.string().optional(),
  detected: z.boolean().optional(),
  skills: z.number().int().optional(),
  instructions: z.string().nullable().optional(),
  mcpServers: z.array(z.string()).optional(),
});
const foreignSourcesSchema = z.object({ ok: z.boolean(), sources: z.array(foreignSourceSchema).optional(), summary: z.string() });
const foreignReportSchema = z.object({
  source: z.string(),
  label: z.string().optional(),
  skills: z.number().int().optional(),
  instructions: z.string().nullable().optional(),
  mcpServers: z.array(z.string()).optional(),
  totalFiles: z.number().int().optional(),
  totalBytes: z.number().optional(),
});
const foreignPreviewSchema = z.object({ ok: z.boolean(), report: foreignReportSchema.optional(), preview: z.unknown().optional(), summary: z.string() });
const foreignImportSchema = z.object({ ok: z.boolean(), dryRun: z.boolean().optional(), report: foreignReportSchema.optional(), preview: z.unknown().optional(), applied: z.unknown().optional(), summary: z.string() });

// P4b-3b：会话 Rewind（分叉）。
const rewindSessionSchema = z.object({
  id: z.string(),
  rel: z.string().optional(),
  file: z.string().optional(),
  cwd: z.string().nullable().optional(),
  version: z.number().int().optional(),
});
const sessionRewindListSchema = z.object({ ok: z.boolean(), sessions: z.array(rewindSessionSchema).optional(), summary: z.string() });
const sessionRewindPreviewSchema = z.object({
  ok: z.boolean(),
  session: z.string().optional(),
  targetSeq: z.number().int().optional(),
  keepRecords: z.number().int().optional(),
  dropRecords: z.number().int().optional(),
  newId: z.string().optional(),
  newPath: z.string().optional(),
  warnings: z.array(z.string()).optional(),
  summary: z.string(),
});
const sessionRewindApplySchema = z.object({
  ok: z.boolean(),
  dryRun: z.boolean().optional(),
  session: z.string().optional(),
  newId: z.string().optional(),
  newPath: z.string().optional(),
  keepRecords: z.number().int().optional(),
  summary: z.string(),
});

/** strict codec：0.1.5 读 `schema`；0.1.6 起强制 `create()` 惰性工厂（#94）。
 * 两者指向同一 zod 实例——两代宿主各取所需，行为一致。 */
// P4c: external chat-history import (Claude Code -> DSH session).
const chatSessionSchema = z.object({
  source: z.string().optional(),
  id: z.string(),
  file: z.string().optional(),
  project: z.string().optional(),
  messages: z.number().int().optional(),
  title: z.string().optional(),
});
const chatSourceSchema = z.object({
  id: z.string(),
  label: z.string().optional(),
  detected: z.boolean().optional(),
  count: z.number().int().optional(),
});
const chatSourcesSchema = z.object({
  ok: z.boolean(),
  sources: z.array(chatSourceSchema).optional(),
  detected: z.boolean().optional(),
  sessions: z.array(chatSessionSchema).optional(),
  summary: z.string(),
});
const chatResultSchema = z.object({
  ok: z.boolean(),
  dryRun: z.boolean().optional(),
  source: z.string().optional(),
  session: z.string().optional(),
  file: z.string().optional(),
  messages: z.number().int().optional(),
  userCount: z.number().int().optional(),
  asstCount: z.number().int().optional(),
  toolCount: z.number().int().optional(),
  skipped: z.number().int().optional(),
  events: z.number().int().optional(),
  newId: z.string().optional(),
  path: z.string().optional(),
  warnings: z.array(z.string()).optional(),
  summary: z.string(),
});

function strictCodec(typeSymbol, schema) {
  return Object.freeze({ mode: 'strict', typeSymbol, schema, create: () => schema });
}

const keepParam = { name: 'keep', wire: 'keep', source: 'json', codec: strictCodec('dsh-backup/types#keep', z.number().int().positive().optional()), acceptsUndefined: true };
const selectorParam = { name: 'selector', wire: 'selector', source: 'json', codec: strictCodec('dsh-backup/types#selector', z.string().optional()), acceptsUndefined: true };
const dryRunParam = { name: 'dryRun', wire: 'dryRun', source: 'json', codec: strictCodec('dsh-backup/types#dryRun', z.boolean().optional()), acceptsUndefined: true };
const syncDepsParam = { name: 'syncDeps', wire: 'syncDeps', source: 'json', codec: strictCodec('dsh-backup/types#syncDeps', z.boolean().optional()), acceptsUndefined: true };
const hoursParam = { name: 'hours', wire: 'hours', source: 'json', codec: strictCodec('dsh-backup/types#hours', z.number().int().min(0).max(720)), acceptsUndefined: true };
const tokenParam = { name: 'token', wire: 'token', source: 'json', codec: strictCodec('dsh-backup/types#token', z.string()), acceptsUndefined: false };
const setGithubTokenSchema = z.object({ ok: z.boolean(), tokenSet: z.boolean().optional(), summary: z.string() });
const repoParam = { name: 'repo', wire: 'repo', source: 'json', codec: strictCodec('dsh-backup/types#repo', z.string().optional()), acceptsUndefined: true };
const typesParam = { name: 'types', wire: 'types', source: 'json', codec: strictCodec('dsh-backup/types#types', z.array(z.string()).optional()), acceptsUndefined: true };
const passwordParam = { name: 'password', wire: 'password', source: 'json', codec: strictCodec('dsh-backup/types#password', z.string().optional()), acceptsUndefined: true };
const optionsParam = { name: 'options', wire: 'options', source: 'json', codec: strictCodec('dsh-backup/types#options', z.object({}).passthrough()) };
const channelParam = { name: 'channel', wire: 'channel', source: 'json', codec: strictCodec('dsh-backup/types#channel', z.string()) };
const configParam = { name: 'config', wire: 'config', source: 'json', codec: strictCodec('dsh-backup/types#config', z.object({}).passthrough()) };
const forceParam = { name: 'force', wire: 'force', source: 'json', codec: strictCodec('dsh-backup/types#force', z.boolean().optional()), acceptsUndefined: true };
const scopeParam = { name: 'scope', wire: 'scope', source: 'json', codec: strictCodec('dsh-backup/types#scope', z.string()) };
const schedulesParam = { name: 'schedules', wire: 'schedules', source: 'json', codec: strictCodec('dsh-backup/types#schedules', z.array(z.object({ day: z.number().int(), time: z.string() }))) };
const nameParam = { name: 'name', wire: 'name', source: 'json', codec: strictCodec('dsh-backup/types#name', z.string()) };
const oldParam = { name: 'old', wire: 'old', source: 'json', codec: strictCodec('dsh-backup/types#old', z.string()) };
const newParam = { name: 'new', wire: 'new', source: 'json', codec: strictCodec('dsh-backup/types#new', z.string()) };
const queryParam = { name: 'query', wire: 'query', source: 'json', codec: strictCodec('dsh-backup/types#query', z.string().optional()), acceptsUndefined: true };
const sessionParam = { name: 'session', wire: 'session', source: 'json', codec: strictCodec('dsh-backup/types#session', z.string()) };
const seqParam = { name: 'seq', wire: 'seq', source: 'json', codec: strictCodec('dsh-backup/types#seq', z.number().int().optional()), acceptsUndefined: true };

function strictDescriptor(method, parameters, schema, cancellation) {
  return Object.freeze({
    id: `dsh-backup#backupPanel/${method}`,
    service: 'backupPanel',
    namespace: 'backupPanel',
    method,
    invocation: Object.freeze({ kind: 'direct' }),
    parameters: Object.freeze(parameters.map((p) => Object.freeze({ ...p, codec: Object.freeze(p.codec) }))),
    ...(cancellation ? { cancellation: Object.freeze({ parameter: 'signal' }) } : {}),
    // create 是 0.1.6 起强制的惰性 schema 工厂（#94）——见 strictCodec。
    result: strictCodec(`dsh-backup/types#${method}Result`, schema),
  });
}

/**
 * `backupPanel` 的客户端 Remote 贡献：与宿主半边（lib/index.js 的
 * PANEL_INVOCATIONS）共享同一组端点；此处携带 strict zod codec（客户端
 * 挂载校验强制 strict），宿主为 src-json——两端按同一 wire 契约工作。
 */
export const BACKUP_REMOTE = Object.freeze({
  package: 'dsh-backup',
  descriptors: Object.freeze([
    strictDescriptor('status', [], statusSchema, false),
    strictDescriptor('backup', [keepParam, typesParam, passwordParam], backupSchema, true),
    strictDescriptor('verify', [selectorParam], verifySchema, true),
    strictDescriptor('restore', [selectorParam, dryRunParam, typesParam, syncDepsParam, passwordParam], restoreSchema, true),
    strictDescriptor('setAuto', [hoursParam], setAutoSchema, false),
    strictDescriptor('githubStatus', [], githubStatusSchema, false),
    strictDescriptor('githubSyncNow', [], githubSyncSchema, true),
    strictDescriptor('githubPull', [], githubPullSchema, true),
    strictDescriptor('removeEntry', [selectorParam], removeSchema, true),
    strictDescriptor('setGithubRepo', [repoParam], setGithubRepoSchema, false),
    strictDescriptor('setGithubToken', [tokenParam], setGithubTokenSchema, false),
    strictDescriptor('checkUpdate', [], updateCheckSchema, true),
    strictDescriptor('update', [], updateSchema, true),
    strictDescriptor('exportConfig', [optionsParam], exportConfigSchema, true),
    strictDescriptor('importPreview', [optionsParam], importPreviewSchema, true),
    strictDescriptor('importApply', [optionsParam], importApplySchema, true),
    strictDescriptor('syncStatus', [], syncStatusSchema, false),
    strictDescriptor('syncNow', [channelParam], syncNowSchema, true),
    strictDescriptor('setSyncChannel', [channelParam, configParam], setSyncChannelSchema, false),
    strictDescriptor('removeSyncChannel', [channelParam], removeSyncChannelSchema, false),
    strictDescriptor('lockStatus', [], lockStatusSchema, false),
    strictDescriptor('reclaimLock', [forceParam], reclaimLockSchema, false),
    strictDescriptor('diskUsage', [], diskUsageSchema, true),
    strictDescriptor('cleanup', [scopeParam], cleanupSchema, true),
    strictDescriptor('setWeekly', [schedulesParam], setWeeklySchema, false),
    strictDescriptor('about', [], aboutSchema, false),
    strictDescriptor('profilesList', [], profilesListSchema, false),
    strictDescriptor('profileCreate', [nameParam], profileCreateSchema, false),
    strictDescriptor('profileRename', [oldParam, newParam], profileRenameSchema, false),
    strictDescriptor('profileDelete', [nameParam], profileDeleteSchema, false),
    strictDescriptor('profileLaunch', [nameParam], profileLaunchSchema, false),
    strictDescriptor('profileStop', [nameParam], profileStopSchema, false),
    strictDescriptor('marketList', [], marketListSchema, true),
    strictDescriptor('marketSearch', [queryParam], marketSearchSchema, true),
    strictDescriptor('marketInstall', [optionsParam], marketInstallSchema, true),
    strictDescriptor('foreignSources', [], foreignSourcesSchema, false),
    strictDescriptor('foreignPreview', [optionsParam], foreignPreviewSchema, true),
    strictDescriptor('foreignImport', [optionsParam], foreignImportSchema, true),
    strictDescriptor('sessionRewindList', [], sessionRewindListSchema, false),
    strictDescriptor('sessionRewindPreview', [sessionParam, seqParam], sessionRewindPreviewSchema, true),
    strictDescriptor('sessionRewindApply', [optionsParam], sessionRewindApplySchema, true),
    strictDescriptor('chatSources', [], chatSourcesSchema, false),
    strictDescriptor('chatPreview', [optionsParam], chatResultSchema, true),
    strictDescriptor('chatApply', [optionsParam], chatResultSchema, true),
  ]),
});

function unwrap(result) {
  if (!result.ok) {
    const err = result.error;
    // 机器错误码不直接面向用户：给人话 + 折叠技术细节（文案审计 W3）
    const raw = err && err.message ? `${err.code}: ${err.message}` : 'backupPanel 调用失败';
    throw new Error(`操作没有完成：面板暂时连不上后台，请重试；若反复出现请重启 dsh web（技术细节: ${raw}）`);
  }
  return result.value;
}

/**
 * 浏览器插件主体：字典、样式表、Remote 贡献挂载、Settings 标签页注册。
 * @param ctx - 客户端根上下文。
 */
export function apply(ctx) {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-backup: dictionaries');
  ctx.effect(() => installPanelStyles(), 'dsh-backup: stylesheet');

  // apply 必须保持同步：宿主 Cordis 会卸载 async apply 里 await 之后注册的
  // ctx.effect（$mount 的 namespace 随即清空，tab 注册被级联销毁）。因此
  // $mount 在这里同步注册的 effect 工厂内部异步完成，失败落 console.error；
  // ctx.inject 与宿主插件一样留在同步帧。
  //
  // 0.1.6 起客户端模块按依赖图分批结算（#94）：apply 执行时 `remote` 服务
  // 未必已就绪——直接 `ctx.remote.$mount` 会 TypeError 且被静默吞掉，面板
  // 标签随之消失。改为声明式等待 `remote` 服务本身（两代宿主语义一致），
  // mount 失败再注册可见的降级标签页，不再静默消失。
  let degraded = false;
  const registerTab = (scope, component, panel) => {
    if (degraded && component !== BackupTabFallback) return;
    const t = scope.locale.bind(NS);
    scope.slots.inject('settings.plugins.tab', () => scope.slots.register({
      name: 'settings.plugins.tab',
      id: 'backup',
      order: 35,
      label: () => t('tab'),
      locale: NS,
      inject: () => ({ panel }),
    }, component));
  };

  ctx.inject(['slots', 'locale'], (scope) => {
    ctx.inject(['remote'], (rscope) => {
      ctx.effect(() => {
        let mounted = null;
        let pending = true;
        let unloaded = false;
        void (async () => {
          try {
            mounted = await rscope.remote.$mount(BACKUP_REMOTE);
          } catch (error) {
            console.error('dsh-backup: backupPanel mount failed:', error);
            degraded = true;
            registerTab(scope, BackupTabFallback, { mountError: error });
          }
          pending = false;
          if (unloaded) void mounted?.();
        })();
        return () => {
          unloaded = true;
          if (!pending) void mounted?.();
        };
      }, 'dsh-backup: remote contribution');
    });

    ctx.inject(['remote.backupPanel'], (scope) => {
      const ns = () => scope.remote.backupPanel;
      const panel = {
        status: async () => unwrap(await ns().status()),
        backup: async (keep, types, password) => unwrap(await ns().backup(keep, types, password)),
        verify: async (selector) => unwrap(await ns().verify(selector)),
        restore: async (selector, dryRun, types, syncDeps, password) => unwrap(await ns().restore(selector, dryRun, types, syncDeps, password)),
        setAuto: async (hours) => unwrap(await ns().setAuto(hours)),
        githubStatus: async () => unwrap(await ns().githubStatus()),
        githubSyncNow: async () => unwrap(await ns().githubSyncNow()),
        githubPull: async () => unwrap(await ns().githubPull()),
        removeEntry: async (selector) => unwrap(await ns().removeEntry(selector)),
        setGithubRepo: async (repo) => unwrap(await ns().setGithubRepo(repo)),
        setGithubToken: async (token) => unwrap(await ns().setGithubToken(token)),
        checkUpdate: async () => unwrap(await ns().checkUpdate()),
        update: async () => unwrap(await ns().update()),
        exportConfig: async (options) => unwrap(await ns().exportConfig(options)),
        importPreview: async (options) => unwrap(await ns().importPreview(options)),
        importApply: async (options) => unwrap(await ns().importApply(options)),
        syncStatus: async () => unwrap(await ns().syncStatus()),
        syncNow: async (channel) => unwrap(await ns().syncNow(channel)),
        setSyncChannel: async (channel, config) => unwrap(await ns().setSyncChannel(channel, config)),
        removeSyncChannel: async (channel) => unwrap(await ns().removeSyncChannel(channel)),
        lockStatus: async () => unwrap(await ns().lockStatus()),
        reclaimLock: async (force) => unwrap(await ns().reclaimLock(force)),
        diskUsage: async () => unwrap(await ns().diskUsage()),
        cleanup: async (scope) => unwrap(await ns().cleanup(scope)),
        setWeekly: async (schedules) => unwrap(await ns().setWeekly(schedules)),
        about: async () => unwrap(await ns().about()),
        profilesList: async () => unwrap(await ns().profilesList()),
        profileCreate: async (name) => unwrap(await ns().profileCreate(name)),
        profileRename: async (oldName, newName) => unwrap(await ns().profileRename(oldName, newName)),
        profileDelete: async (name) => unwrap(await ns().profileDelete(name)),
        profileLaunch: async (name) => unwrap(await ns().profileLaunch(name)),
        profileStop: async (name) => unwrap(await ns().profileStop(name)),
        marketList: async () => unwrap(await ns().marketList()),
        marketSearch: async (query) => unwrap(await ns().marketSearch(query)),
        marketInstall: async (options) => unwrap(await ns().marketInstall(options)),
        foreignSources: async () => unwrap(await ns().foreignSources()),
        foreignPreview: async (options) => unwrap(await ns().foreignPreview(options)),
        foreignImport: async (options) => unwrap(await ns().foreignImport(options)),
        sessionRewindList: async () => unwrap(await ns().sessionRewindList()),
        sessionRewindPreview: async (session, seq) => unwrap(await ns().sessionRewindPreview(session, seq)),
        sessionRewindApply: async (options) => unwrap(await ns().sessionRewindApply(options)),
        chatSources: async () => unwrap(await ns().chatSources()),
        chatPreview: async (options) => unwrap(await ns().chatPreview(options)),
        chatApply: async (options) => unwrap(await ns().chatApply(options)),
      };
      registerTab(scope, BackupTab, panel);
    });
  });
}
