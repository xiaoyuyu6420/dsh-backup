/**
 * 客户端半边冒烟测试（零依赖除 devDeps 的 react/react-dom/zod）。
 *
 * 1. 以 Web shell 的握手方式加载 lib/client.js（window.__ModuleLoader__ 工厂）。
 * 2. apply() 挂载：字典注册、Remote 贡献（strict zod）、Settings 标签页注册。
 * 3. 用真实 zod 校验每个结果 schema 能解析宿主面板返回的样例负载。
 * 4. react-dom/server SSR 渲染标签页（loading 态 + 通过注入 panel 的结构断言）。
 *
 * 用法：node scripts/smoke-client.mjs
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import * as z from 'zod';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

let failures = 0;
let checks = 0;

function ok(cond, msg) {
  checks += 1;
  console.log(`  ${cond ? '✅' : '❌'} ${msg}`);
  if (!cond) failures += 1;
}

async function main() {
  console.log('1) ModuleLoader 握手加载 bundle');
  let entry;
  globalThis.window = { __ModuleLoader__: { load: (e) => { entry = e; } } };
  const bundle = await readFile(path.join(REPO, 'lib', 'client.js'), 'utf8');
  new Function(bundle)(); // bundle 顶层只声明 var 并调用 window.__ModuleLoader__.load
  const pkgName = JSON.parse(await readFile(path.join(REPO, 'package.json'), 'utf8')).name;
  ok(entry !== undefined && entry.id === pkgName, `bundle 以 id=${entry?.id} 注册`);

  // 经典脚本语义回归（#85）：new Function 会把顶层 var 关进函数作用域，测不出
  // 泄漏；vm.runInContext 的顶层 var 落到沙箱全局，与浏览器 <script> 行为一致。
  console.log('1b) 经典脚本加载不得污染全局');
  {
    const vm = await import('node:vm');
    let entryCs;
    const sandbox = { window: { __ModuleLoader__: { load: (e) => { entryCs = e; } } } };
    vm.createContext(sandbox);
    vm.runInContext(bundle, sandbox, { filename: 'lib/client.js' });
    ok(entryCs !== undefined && entryCs.id === pkgName, '经典脚本路径下握手正常');
    ok(!('module' in sandbox), '顶层 var module 未泄漏为全局');
    ok(!('exports' in sandbox), '顶层 var exports 未泄漏为全局');
  }

  const requireShim = (id) => {
    if (id === 'react') return require('react');
    if (id === 'react/jsx-runtime') return require('react/jsx-runtime');
    throw new Error(`意外的外部依赖: ${id}`);
  };
  const plugin = entry.factory(requireShim);
  ok(plugin.name === pkgName && JSON.stringify(plugin.inject) === JSON.stringify(['slots', 'locale', 'remote']), `插件导出面正确: ${plugin.name}`);

  console.log('2) apply() 挂载（字典 / Remote 贡献 / 标签页）');
  const dict = {};
  const contributions = [];
  const tabRegistrations = [];
  let scopedCallback = null;

  const ctx = {
    effect: (fn) => { const dispose = fn(); return () => dispose?.(); },
    locale: {
      register: (ns, d) => { dict[ns] = d; return () => {}; },
    },
    remote: {
      $mount: async (c) => { contributions.push(c); return async () => {}; },
    },
    inject: (names, cb) => {
      // 新结构（#94 适配）：inject(['slots','locale']) 外层作用域 → inject(['remote'])
      // 等 remote 服务就绪（其回调里 $mount）→ 嵌套 inject(['remote.backupPanel'])。
      // 桩模拟三服务都已就绪、同步回调。
      if (names.includes('slots') || names.includes('locale')) {
        cb({
          locale: { bind: () => (k) => k },
          slots: {
            inject: (seat, fn) => { tabRegistrations.push(fn); },
            register: (def, comp) => ({ def, comp }),
          },
        });
      }
      if (names.includes('remote')) {
        cb({ remote: { $mount: async (c) => { contributions.push(c); return async () => {}; } } });
      }
      if (names.includes('remote.backupPanel')) scopedCallback = cb;
    },
  };

  globalThis.document = {
    createElement: () => ({ style: {}, dataset: {}, set textContent(v) { this._t = v; }, get textContent() { return this._t; } }),
    querySelector: () => null,
    head: { append() {} },
  };
  await plugin.apply(ctx);

  // #94 诉求 2：remote 挂载失败时必须落一个可见的降级标签页，而不是静默消失。
  console.log('2b) remote 挂载失败 → 降级标签页（#94 诉求 2）');
  {
    const degradedTabs = [];
    let mountCalls = 0;
    const ctxDegraded = {
      effect: (fn) => { const d = fn(); return () => d?.(); },
      locale: { register: () => () => {} },
      inject: (names, cb) => {
        if (names.includes('slots') || names.includes('locale')) {
          cb({
            locale: { bind: () => (k) => k },
            slots: {
              inject: (seat, fn) => { degradedTabs.push(fn()); },
              register: (reg, component) => ({ ...reg, component }),
            },
          });
        }
        if (names.includes('remote')) {
          cb({ remote: { $mount: async () => { mountCalls += 1; throw new Error('typert: strict codec has no create() factory'); } } });
        }
      },
    };
    await plugin.apply(ctxDegraded);
    await new Promise((r) => setTimeout(r, 20));
    ok(mountCalls === 1, '$mount 被调用一次（声明式等待 remote 后就绪后挂载）');
    ok(degradedTabs.length === 1 && degradedTabs[0]?.id === 'backup', `挂载失败仍注册标签页（id=${degradedTabs[0]?.id}）`);
    const R = require('react');
    const { renderToStaticMarkup: renderDegraded } = require('react-dom/server');
    const degradedMarkup = renderDegraded(R.createElement(degradedTabs[0].component, { panel: { mountError: new Error('boom') }, t: (k) => k }));
    ok(degradedMarkup.includes('fallbackTitle') && degradedMarkup.includes('fallbackBody'), '降级页渲染出可见提示（不再静默消失）');
  }

  delete globalThis.document;

  ok(dict['settings.backupPanel']?.zh?.tab === '备份' && dict['settings.backupPanel']?.en?.tab === 'Backup', '双语文典已注册');

  const contribution = contributions[0];
  ok(contribution?.package === 'dsh-backup' && contribution.descriptors.length === 43, `Remote 贡献含 ${contribution?.descriptors.length} 个端点`);

  const endpoints = contribution.descriptors.map((d) => `${d.namespace}/${d.method}`);
  ok(JSON.stringify(endpoints) === JSON.stringify(['backupPanel/status', 'backupPanel/backup', 'backupPanel/verify', 'backupPanel/restore', 'backupPanel/setAuto', 'backupPanel/githubStatus', 'backupPanel/githubSyncNow', 'backupPanel/githubPull', 'backupPanel/removeEntry', 'backupPanel/setGithubRepo', 'backupPanel/checkUpdate', 'backupPanel/update', 'backupPanel/exportConfig', 'backupPanel/importPreview', 'backupPanel/importApply', 'backupPanel/syncStatus', 'backupPanel/syncNow', 'backupPanel/setSyncChannel', 'backupPanel/removeSyncChannel', 'backupPanel/lockStatus', 'backupPanel/reclaimLock', 'backupPanel/diskUsage', 'backupPanel/cleanup', 'backupPanel/setWeekly', 'backupPanel/about', 'backupPanel/profilesList', 'backupPanel/profileCreate', 'backupPanel/profileRename', 'backupPanel/profileDelete', 'backupPanel/profileLaunch', 'backupPanel/profileStop', 'backupPanel/marketList', 'backupPanel/marketSearch', 'backupPanel/marketInstall', 'backupPanel/foreignSources', 'backupPanel/foreignPreview', 'backupPanel/foreignImport', 'backupPanel/sessionRewindList', 'backupPanel/sessionRewindPreview', 'backupPanel/sessionRewindApply', 'backupPanel/chatSources', 'backupPanel/chatPreview', 'backupPanel/chatApply']), `端点与宿主半边一致: ${endpoints.join(', ')}`);

  console.log('3) strict schema 解析宿主样例负载');
  const samples = {
    'backupPanel/status': {
      destination: 'C:/Users/u/Desktop/DSH Backups', dshHome: 'C:/Users/u/.dsh',
      keepDefault: 7, autoHours: 3, lastAuto: null,
      backups: [{ name: 'dsh-20260815-095739228.tar.gz', size: 12345 }, { name: 'dsh-x.tar.gz', size: null }],
    },
    'backupPanel/backup': { ok: true, summary: '备份完成', path: '/x/dsh-1.tar.gz', sha: 'ab'.repeat(32), stale: 1, keep: 7 },
    'backupPanel/verify': { ok: false, summary: '❌', results: [{ name: 'dsh-1.tar.gz', ok: false, note: 'sha256 不匹配' }] },
    'backupPanel/restore': { ok: true, dryRun: true, archive: '/x/dsh-1.tar.gz', files: 5, sample: ['.dsh/settings.json'], summary: '5 项' },
    'backupPanel/setAuto': { ok: true, hours: 3, summary: '已开启' },
    'backupPanel/githubStatus': { repoRaw: 'u/backups', repo: 'https://github.com/u/backups.git', tokenSet: true, syncDir: 'C:/x/.github-sync', lastPush: '2026-08-15T10:00:00.000Z', lastError: null },
    'backupPanel/githubSyncNow': { ok: true, summary: '无变更', pushed: false, tooBig: [] },
    'backupPanel/githubPull': { ok: true, summary: '已拉取 1 份备份', pulled: ['dsh-x.tar.gz'], corrupt: [], total: 1 },
    'backupPanel/removeEntry': { ok: true, summary: '已删除备份: dsh-x.tar.gz' },
    'backupPanel/setGithubRepo': { ok: true, repo: 'u/backups', summary: '已设为 u/backups' },
    'backupPanel/checkUpdate': { ok: true, current: '0.12.2', latest: '0.13.0', update: true, error: null, summary: '发现新版本：0.12.2 → 0.13.0' },
    'backupPanel/update': { ok: true, updated: true, current: '0.13.0', latest: '0.13.0', summary: '已更新到 0.13.0。\n请重启 dsh web 使新版本生效。' },
    'backupPanel/exportConfig': { ok: true, summary: '已导出', path: '/x/dsh-config-1.zip', name: 'dsh-config-1.zip', size: 1234, encrypted: false, redactedFiles: [] },
    'backupPanel/importPreview': { ok: true, summary: '预览完成', encrypted: false, sections: [{ key: 'settings', label: '设置', files: 3, bytes: 100, conflicts: [{ name: 'settings.yaml', rel: 'settings.yaml', exists: true }] }], totalFiles: 3, totalBytes: 100, conflicts: [{ name: 'settings.yaml', rel: 'settings.yaml', section: 'settings', exists: true }], remap: [], compatibility: { score: 'Good', reasons: [] } },
    'backupPanel/importApply': { ok: true, summary: '已导入', encrypted: false, applied: 3, skipped: 0, overwrote: 0, snapshot: null, remapped: 0 },
    'backupPanel/syncStatus': { ok: true, summary: '已同步', channels: { github: { repo: 'u/backups' }, webdav: {}, s3: {}, gist: {} } },
    'backupPanel/syncNow': { ok: true, summary: '已推送', pushed: true, count: 1, at: '2026-10-18T00:00:00.000Z', tooBig: [] },
    'backupPanel/setSyncChannel': { ok: true, summary: '已保存', channel: 'webdav' },
    'backupPanel/removeSyncChannel': { ok: true, summary: '已移除' },
    'backupPanel/lockStatus': { ok: true, held: false, stale: false, pid: null, operation: null, startedAt: null, heartbeatAt: null },
    'backupPanel/reclaimLock': { ok: true, summary: '已回收' },
    'backupPanel/diskUsage': { ok: true, total: 1234, totalText: '1.2 MB', categories: [{ key: 'archives', label: '归档', bytes: 1000, files: 1 }], summary: '1.2 MB' },
    'backupPanel/cleanup': { ok: true, removed: 0, names: [], summary: '无需清理' },
    'backupPanel/setWeekly': { ok: true, weekly: [{ day: 1, time: '09:00' }], summary: '已设置每周备份' },
    'backupPanel/about': { ok: true, version: '0.14.0', dshVersion: '0.2.1-rc.2', platform: 'darwin', node: 'v22.22.1', profile: 'web', pluginDir: '~/Desktop/dsh-backup' },
    'backupPanel/profilesList': { ok: true, summary: '2 个 profile', profiles: [{ name: 'desktop', appOwned: true, readonly: true, running: false, pid: null }, { name: 'web', appOwned: false, readonly: false, running: false, pid: null }] },
    'backupPanel/profileCreate': { ok: true, summary: '已创建', name: 'my-profile' },
    'backupPanel/profileRename': { ok: true, summary: '已改名', from: 'a', to: 'b' },
    'backupPanel/profileDelete': { ok: true, summary: '已删除', name: 'my-profile' },
    'backupPanel/profileLaunch': { ok: true, summary: '已启动', pid: 123, running: true },
    'backupPanel/profileStop': { ok: true, summary: '已停止', running: false },
    'backupPanel/marketList': { ok: true, enabled: true, entries: [{ id: 'm1', name: '示例配置', desc: '示例', sections: ['settings'], url: 'https://example.com/a.zip', source: 'github', risk: 'low', version: '1' }], summary: '🛒 市场共 1 个配置' },
    'backupPanel/marketSearch': { ok: true, enabled: true, entries: [{ id: 'm1', name: '示例配置', desc: '示例', sections: ['settings'], url: 'https://example.com/a.zip', source: 'github', risk: 'low', version: '1' }], summary: '🛒 搜索「示例」：1 个结果' },
    'backupPanel/marketInstall': { ok: true, dryRun: true, entry: { id: 'm1', name: '示例配置' }, preview: {}, supplyChain: [], summary: '🛒 市场预览' },
    'backupPanel/foreignSources': { ok: true, sources: [{ id: 'claude-code', label: 'Claude Code', detected: true, skills: 1, instructions: '.claude/CLAUDE.md', mcpServers: ['my-mcp（来自 .claude/settings.json）'] }], summary: '检测到 1 个来源' },
    'backupPanel/foreignPreview': { ok: true, report: { source: 'claude-code', label: 'Claude Code', skills: 1, instructions: '.claude/CLAUDE.md', mcpServers: [], totalFiles: 2 }, preview: {}, summary: '预览' },
    'backupPanel/foreignImport': { ok: true, dryRun: true, report: { source: 'claude-code', label: 'Claude Code', skills: 1, instructions: '.claude/CLAUDE.md', mcpServers: [], totalFiles: 2 }, preview: {}, summary: '预览（未写入）' },
    'backupPanel/sessionRewindList': { ok: true, sessions: [{ id: 'sess-1', rel: 'sessions/--p--/sess-1/session.v4.jsonl.zstd', file: 'session.v4.jsonl.zstd', cwd: '/tmp/p', version: 4 }], summary: '找到 1 个可回退会话' },
    'backupPanel/sessionRewindPreview': { ok: true, session: 'sess-1', targetSeq: 2, keepRecords: 2, dropRecords: 2, newId: 'sess-1-rewind-1', newPath: '/x/sess-1-rewind-1/session.v4.jsonl.zstd', warnings: [], summary: '回退预览' },
    'backupPanel/sessionRewindApply': { ok: true, dryRun: false, session: 'sess-1', newId: 'sess-1-rewind-1', newPath: '/x/sess-1-rewind-1/session.v4.jsonl.zstd', keepRecords: 2, summary: '已分叉' },
    'backupPanel/chatSources': { ok: true, source: 'claude-code', detected: true, sessions: [{ id: 'claude-p-abc', file: 'a.jsonl', project: '-p', messages: 3, title: 'hello' }], summary: '检测到 1 个会话' },
    'backupPanel/chatPreview': { ok: true, dryRun: true, source: 'claude-code', session: 'claude-p-abc', messages: 3, userCount: 1, asstCount: 1, toolCount: 1, skipped: 1, events: 15, newId: 'claude-p-abc-1', warnings: ['仅文本'], summary: '导入预览' },
    'backupPanel/chatApply': { ok: true, dryRun: false, newId: 'claude-p-abc-1', path: '/x/sessions/_no-cwd/claude-p-abc-1/session.v4.jsonl.zstd', messages: 3, events: 15, summary: '已导入' },
  };
  for (const d of contribution.descriptors) {
    const key = `${d.namespace}/${d.method}`;
    try {
      d.result.schema.parse(samples[key]);
      ok(true, `${key} 结果 schema 解析样例通过`);
    } catch (err) {
      ok(false, `${key} 结果 schema 解析失败: ${String(err)}`);
    }
  }
  ok(contribution.descriptors.every((d) => d.parameters.every((p) => p.codec.mode === 'strict' && p.codec.schema)), '参数全部 strict codec（客户端挂载校验要求）');

  console.log('4) 标签页注册与 SSR 渲染');
  if (scopedCallback === null) { ok(false, 'remote.backupPanel 作用域未激活'); }
  else {
    const calls = { status: 0 };
    const fakeNamespace = {
      status: async () => ({ ok: true, value: samples['backupPanel/status'] }),
      backup: async () => ({ ok: true, value: samples['backupPanel/backup'] }),
      verify: async () => ({ ok: true, value: samples['backupPanel/verify'] }),
      restore: async () => ({ ok: true, value: samples['backupPanel/restore'] }),
      setAuto: async () => ({ ok: true, value: samples['backupPanel/setAuto'] }),
      githubStatus: async () => ({ ok: true, value: samples['backupPanel/githubStatus'] }),
      githubSyncNow: async () => ({ ok: true, value: samples['backupPanel/githubSyncNow'] }),
      githubPull: async () => ({ ok: true, value: samples['backupPanel/githubPull'] }),
      removeEntry: async () => ({ ok: true, value: samples['backupPanel/removeEntry'] }),
      setGithubToken: async () => ({ ok: true, value: { ok: true, tokenSet: true, summary: '已保存' } }),
      checkUpdate: async () => ({ ok: true, value: samples['backupPanel/checkUpdate'] }),
      update: async () => ({ ok: true, value: samples['backupPanel/update'] }),
      setGithubRepo: async () => ({ ok: true, value: samples['backupPanel/setGithubRepo'] }),
      exportConfig: async () => ({ ok: true, value: samples['backupPanel/exportConfig'] }),
      importPreview: async () => ({ ok: true, value: samples['backupPanel/importPreview'] }),
      importApply: async () => ({ ok: true, value: samples['backupPanel/importApply'] }),
      syncStatus: async () => ({ ok: true, value: samples['backupPanel/syncStatus'] }),
      syncNow: async () => ({ ok: true, value: samples['backupPanel/syncNow'] }),
      setSyncChannel: async () => ({ ok: true, value: samples['backupPanel/setSyncChannel'] }),
      removeSyncChannel: async () => ({ ok: true, value: samples['backupPanel/removeSyncChannel'] }),
      lockStatus: async () => ({ ok: true, value: samples['backupPanel/lockStatus'] }),
      reclaimLock: async () => ({ ok: true, value: samples['backupPanel/reclaimLock'] }),
      diskUsage: async () => ({ ok: true, value: samples['backupPanel/diskUsage'] }),
      cleanup: async () => ({ ok: true, value: samples['backupPanel/cleanup'] }),
      setWeekly: async () => ({ ok: true, value: samples['backupPanel/setWeekly'] }),
      about: async () => ({ ok: true, value: samples['backupPanel/about'] }),
      profilesList: async () => ({ ok: true, value: samples['backupPanel/profilesList'] }),
      profileCreate: async () => ({ ok: true, value: samples['backupPanel/profileCreate'] }),
      profileRename: async () => ({ ok: true, value: samples['backupPanel/profileRename'] }),
      profileDelete: async () => ({ ok: true, value: samples['backupPanel/profileDelete'] }),
      profileLaunch: async () => ({ ok: true, value: samples['backupPanel/profileLaunch'] }),
      profileStop: async () => ({ ok: true, value: samples['backupPanel/profileStop'] }),
      marketList: async () => ({ ok: true, value: samples['backupPanel/marketList'] }),
      marketSearch: async () => ({ ok: true, value: samples['backupPanel/marketSearch'] }),
      marketInstall: async () => ({ ok: true, value: samples['backupPanel/marketInstall'] }),
      foreignSources: async () => ({ ok: true, value: samples['backupPanel/foreignSources'] }),
      foreignPreview: async () => ({ ok: true, value: samples['backupPanel/foreignPreview'] }),
      foreignImport: async () => ({ ok: true, value: samples['backupPanel/foreignImport'] }),
      sessionRewindList: async () => ({ ok: true, value: samples['backupPanel/sessionRewindList'] }),
      sessionRewindPreview: async () => ({ ok: true, value: samples['backupPanel/sessionRewindPreview'] }),
      sessionRewindApply: async () => ({ ok: true, value: samples['backupPanel/sessionRewindApply'] }),
      chatSources: async () => ({ ok: true, value: samples['backupPanel/chatSources'] }),
      chatPreview: async () => ({ ok: true, value: samples['backupPanel/chatPreview'] }),
      chatApply: async () => ({ ok: true, value: samples['backupPanel/chatApply'] }),
    };
    const scope = {
      locale: {
        bind: (ns) => (key) => {
          calls.status += 0;
          return dict[ns]?.zh?.[key] ?? key;
        },
      },
      remote: { backupPanel: fakeNamespace },
      slots: {
        inject: (slotName, registrar) => { if (slotName === 'settings.plugins.tab') tabRegistrations.push(registrar()); },
        register: (reg, component) => ({ ...reg, component }),
      },
    };
    scopedCallback(scope);
    const tab = tabRegistrations[0];
    ok(tab?.id === 'backup' && tab?.name === 'settings.plugins.tab' && typeof tab?.label === 'function' && tab.label() === '备份', `标签页注册: id=${tab?.id}, label=${tab?.label?.()}`);
    ok(typeof tab?.component === 'function' || typeof tab === 'function', '标签页组件可渲染');
    const Component = tab?.component ?? tab;
    const injected = tab.inject();
    ok(typeof injected.panel?.status === 'function' && typeof injected.panel?.restore === 'function' && typeof injected.panel?.githubSyncNow === 'function' && typeof injected.panel?.githubPull === 'function' && typeof injected.panel?.removeEntry === 'function' && typeof injected.panel?.setGithubRepo === 'function', '注入面提供 panel API（含 removeEntry/github）');
    // #97 防复发：panel 面方法必须与贡献 descriptors 的 method 一一对应——
    // 0.12.0 起宿主半有 setGithubToken 而客户端漏接，0.13.0 面板按钮才踩响。
    const descriptorMethods = new Set(contribution.descriptors.map((d) => d.method));
    const panelMethods = new Set(Object.keys(injected.panel));
    const missing = [...descriptorMethods].filter((m) => !panelMethods.has(m));
    ok(missing.length === 0, `panel 面与 descriptors 一一对应（缺: ${missing.join(',') || '无'}）`);

    const React = require('react');
    const { renderToStaticMarkup } = require('react-dom/server');
    const markup = renderToStaticMarkup(React.createElement(Component, { panel: injected.panel, t: scope.locale.bind('settings.backupPanel') }));
    ok(markup.includes('data-dsh-backup') && markup.includes('正在读取备份状态'), 'SSR 渲染出标签页骨架（loading 态）');
  }

  console.log(`\n结果: ${checks - failures}/${checks} 通过`);
  if (failures) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
