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
import { BackupTab } from './tab.jsx';
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
});

const backupSchema = z.object({
  ok: z.boolean(),
  summary: z.string(),
  path: z.string(),
  sha: z.string(),
  stale: z.number().int(),
  keep: z.number().int(),
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

const removeSchema = z.object({
  ok: z.boolean(),
  summary: z.string(),
});

const setGithubRepoSchema = z.object({
  ok: z.boolean(),
  repo: z.string().nullable(),
  summary: z.string(),
});

const keepParam = { name: 'keep', wire: 'keep', source: 'json', codec: { mode: 'strict', typeSymbol: 'dsh-backup/types#keep', schema: z.number().int().positive().optional() }, acceptsUndefined: true };
const selectorParam = { name: 'selector', wire: 'selector', source: 'json', codec: { mode: 'strict', typeSymbol: 'dsh-backup/types#selector', schema: z.string().optional() }, acceptsUndefined: true };
const dryRunParam = { name: 'dryRun', wire: 'dryRun', source: 'json', codec: { mode: 'strict', typeSymbol: 'dsh-backup/types#dryRun', schema: z.boolean().optional() }, acceptsUndefined: true };
const hoursParam = { name: 'hours', wire: 'hours', source: 'json', codec: { mode: 'strict', typeSymbol: 'dsh-backup/types#hours', schema: z.number().int().min(0).max(720) }, acceptsUndefined: true };
const repoParam = { name: 'repo', wire: 'repo', source: 'json', codec: { mode: 'strict', typeSymbol: 'dsh-backup/types#repo', schema: z.string().optional() }, acceptsUndefined: true };

function strictDescriptor(method, parameters, schema, cancellation) {
  return Object.freeze({
    id: `dsh-backup#backupPanel/${method}`,
    service: 'backupPanel',
    namespace: 'backupPanel',
    method,
    invocation: Object.freeze({ kind: 'direct' }),
    parameters: Object.freeze(parameters.map((p) => Object.freeze({ ...p, codec: Object.freeze(p.codec) }))),
    ...(cancellation ? { cancellation: Object.freeze({ parameter: 'signal' }) } : {}),
    result: Object.freeze({ mode: 'strict', typeSymbol: `dsh-backup/types#${method}Result`, schema }),
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
    strictDescriptor('backup', [keepParam], backupSchema, true),
    strictDescriptor('verify', [selectorParam], verifySchema, true),
    strictDescriptor('restore', [selectorParam, dryRunParam], restoreSchema, true),
    strictDescriptor('setAuto', [hoursParam], setAutoSchema, false),
    strictDescriptor('githubStatus', [], githubStatusSchema, false),
    strictDescriptor('githubSyncNow', [], githubSyncSchema, true),
    strictDescriptor('removeEntry', [selectorParam], removeSchema, true),
    strictDescriptor('setGithubRepo', [repoParam], setGithubRepoSchema, false),
  ]),
});

function unwrap(result) {
  if (!result.ok) {
    const err = result.error;
    throw new Error(err && err.message ? `${err.code}: ${err.message}` : 'backupPanel 调用失败');
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
  ctx.effect(() => {
    let mounted = null;
    let pending = true;
    let unloaded = false;
    void (async () => {
      try {
        mounted = await ctx.remote.$mount(BACKUP_REMOTE);
      } catch (error) {
        console.error('dsh-backup: backupPanel mount failed:', error);
      }
      pending = false;
      if (unloaded) void mounted?.();
    })();
    return () => {
      unloaded = true;
      if (!pending) void mounted?.();
    };
  }, 'dsh-backup: remote contribution');

  ctx.inject(['remote.backupPanel'], (scope) => {
    const t = scope.locale.bind(NS);
    const ns = () => scope.remote.backupPanel;
    const panel = {
      status: async () => unwrap(await ns().status()),
      backup: async (keep) => unwrap(await ns().backup(keep)),
      verify: async (selector) => unwrap(await ns().verify(selector)),
      restore: async (selector, dryRun) => unwrap(await ns().restore(selector, dryRun)),
      setAuto: async (hours) => unwrap(await ns().setAuto(hours)),
      githubStatus: async () => unwrap(await ns().githubStatus()),
      githubSyncNow: async () => unwrap(await ns().githubSyncNow()),
      removeEntry: async (selector) => unwrap(await ns().removeEntry(selector)),
      setGithubRepo: async (repo) => unwrap(await ns().setGithubRepo(repo)),
    };
    scope.slots.inject('settings.plugins.tab', () => scope.slots.register({
      name: 'settings.plugins.tab',
      id: 'backup',
      order: 35,
      label: () => t('tab'),
      locale: NS,
      inject: () => ({ panel }),
    }, BackupTab));
  });
}
