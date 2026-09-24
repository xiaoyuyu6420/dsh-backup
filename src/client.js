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

/** strict codec：0.1.5 读 `schema`；0.1.6 起强制 `create()` 惰性工厂（#94）。
 * 两者指向同一 zod 实例——两代宿主各取所需，行为一致。 */
function strictCodec(typeSymbol, schema) {
  return Object.freeze({ mode: 'strict', typeSymbol, schema, create: () => schema });
}

const keepParam = { name: 'keep', wire: 'keep', source: 'json', codec: strictCodec('dsh-backup/types#keep', z.number().int().positive().optional()), acceptsUndefined: true };
const selectorParam = { name: 'selector', wire: 'selector', source: 'json', codec: strictCodec('dsh-backup/types#selector', z.string().optional()), acceptsUndefined: true };
const dryRunParam = { name: 'dryRun', wire: 'dryRun', source: 'json', codec: strictCodec('dsh-backup/types#dryRun', z.boolean().optional()), acceptsUndefined: true };
const syncDepsParam = { name: 'syncDeps', wire: 'syncDeps', source: 'json', codec: strictCodec('dsh-backup/types#syncDeps', z.boolean().optional()), acceptsUndefined: true };
const hoursParam = { name: 'hours', wire: 'hours', source: 'json', codec: strictCodec('dsh-backup/types#hours', z.number().int().min(0).max(720)), acceptsUndefined: true };
const repoParam = { name: 'repo', wire: 'repo', source: 'json', codec: strictCodec('dsh-backup/types#repo', z.string().optional()), acceptsUndefined: true };
const typesParam = { name: 'types', wire: 'types', source: 'json', codec: strictCodec('dsh-backup/types#types', z.array(z.string()).optional()), acceptsUndefined: true };

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
    strictDescriptor('backup', [keepParam, typesParam], backupSchema, true),
    strictDescriptor('verify', [selectorParam], verifySchema, true),
    strictDescriptor('restore', [selectorParam, dryRunParam, typesParam, syncDepsParam], restoreSchema, true),
    strictDescriptor('setAuto', [hoursParam], setAutoSchema, false),
    strictDescriptor('githubStatus', [], githubStatusSchema, false),
    strictDescriptor('githubSyncNow', [], githubSyncSchema, true),
    strictDescriptor('githubPull', [], githubPullSchema, true),
    strictDescriptor('removeEntry', [selectorParam], removeSchema, true),
    strictDescriptor('setGithubRepo', [repoParam], setGithubRepoSchema, false),
    strictDescriptor('checkUpdate', [], updateCheckSchema, true),
    strictDescriptor('update', [], updateSchema, true),
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
        backup: async (keep, types) => unwrap(await ns().backup(keep, types)),
        verify: async (selector) => unwrap(await ns().verify(selector)),
        restore: async (selector, dryRun, types, syncDeps) => unwrap(await ns().restore(selector, dryRun, types, syncDeps)),
        setAuto: async (hours) => unwrap(await ns().setAuto(hours)),
        githubStatus: async () => unwrap(await ns().githubStatus()),
        githubSyncNow: async () => unwrap(await ns().githubSyncNow()),
        githubPull: async () => unwrap(await ns().githubPull()),
        removeEntry: async (selector) => unwrap(await ns().removeEntry(selector)),
        setGithubRepo: async (repo) => unwrap(await ns().setGithubRepo(repo)),
        setGithubToken: async (token) => unwrap(await ns().setGithubToken(token)),
        checkUpdate: async () => unwrap(await ns().checkUpdate()),
        update: async () => unwrap(await ns().update()),
      };
      registerTab(scope, BackupTab, panel);
    });
  });
}
