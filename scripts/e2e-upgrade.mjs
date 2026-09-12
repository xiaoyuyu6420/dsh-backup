#!/usr/bin/env node
/**
 * 原地升级 e2e：模拟老用户从 npm 上的旧正式版（UPGRADE_OLD_SPEC）更新到本地打包的新版 tarball（UPGRADE_TARBALL），
 * 新旧期望版本分别从 spec 与 tarball 动态推导。
 *
 * 用法：UPGRADE_TARBALL=/path/to/xiaoyuyu6420-dsh-backup-0.11.1.tgz node scripts/e2e-upgrade.mjs
 * 前提：PATH 里有 `dsh` CLI。可用 PHASE1_DSH/PHASE2_DSH 指定两个不同列车的
 * dsh 可执行文件，模拟「宿主先升级（旧插件挂掉）→ 再更新插件脱困」的跨列车救援。
 *
 * 覆盖（发布前的"老用户能不能平滑更新"验收）：
 *   1. 旧版从 npm registry 安装成功且版本正确（真实老用户状态）
 *   2. 旧版世界里：自定义设置落盘 + 健康会话日志 + 归档 A（由旧版创建）
 *   3. tarball 覆盖更新成功且安装目录版本变为新版期望版本
 *   4. 更新后：设置无损（keep 保留）、归档 A 仍在列表、老归档 dry-run 可恢复、
 *      doctorScan 干净、新版还能继续产生归档 B
 *
 * 零依赖；退出码 0=全过，1=有失败。
 */

import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { zstdCompressSync } from 'node:zlib';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.E2E_PORT || 13141);
const BASE = `http://127.0.0.1:${PORT}`;
const BOOT_TIMEOUT_MS = 90_000;
const OLD_SPEC = process.env.UPGRADE_OLD_SPEC || '@xiaoyuyu6420/dsh-backup@0.11.0';
const NEW_TARBALL = process.env.UPGRADE_TARBALL || '/tmp/dsh-pack-0111/xiaoyuyu6420-dsh-backup-0.11.1.tgz';
// 新版期望版本从 NEW_TARBALL 内 package.json 读取（与旧版断言同思路：不写死，换版本对不改脚本）
const NEW_VERSION = (() => {
  const r = spawnSync('tar', ['-xOf', NEW_TARBALL, 'package/package.json'], { encoding: 'utf8' });
  try { return JSON.parse(r.stdout).version || ''; } catch { return ''; }
})();
// 旧版期望版本从 UPGRADE_OLD_SPEC 的 @version 段推导（无 @ 段时视为 latest，跳过版本断言）
const OLD_VERSION = (() => { const m = OLD_SPEC.match(/@([^@/]+)$/); return m ? m[1] : ''; })();
const SKIP_OLD_VERSION_ASSERT = OLD_VERSION === '';
const PHASE1_DSH = process.env.PHASE1_DSH || 'dsh';
const PHASE2_DSH = process.env.PHASE2_DSH || 'dsh';

let bootToken = '';
let authCookie = '';
const CK = () => (authCookie ? { Cookie: authCookie } : {});
const req = (url, opts = {}) => fetch(url, { ...opts, headers: { ...(opts.headers || {}), ...CK() } });

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? '✅' : '❌'} ${name}${detail && !ok ? ` — ${detail}` : ''}`);
  return ok;
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 180_000, ...opts });
  if (r.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} 失败 (exit ${r.status}):\n${(r.stderr || r.stdout || '').slice(-2000)}`);
  }
  return r.stdout;
}

let bootProc = null;
let home = null;
let bootLogPath = null;
let bootLogStream = null;

function startBoot(dshBin) {
  bootLogPath = path.join(home, 'boot.log');
  bootLogStream = fs.createWriteStream(bootLogPath);
  bootProc = spawn(dshBin, ['web', '--no-open'], {
    cwd: home,
    env: { ...process.env, DSH_HOME: home, HOME: home, USERPROFILE: home },
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  bootProc.stdout.pipe(bootLogStream);
  bootProc.stderr.pipe(bootLogStream);
  bootProc.unref();
}

function dumpBootLog(reason) {
  try {
    const text = fs.readFileSync(bootLogPath, 'utf8').trim();
    console.error(`[e2e-upgrade] boot 日志（${reason}）最后 40 行:\n${text.split('\n').slice(-40).join('\n')}`);
  } catch { /* 无日志 */ }
}

async function stopBoot() {
  if (!bootProc) return;
  const p = bootProc;
  bootProc = null;
  try {
    if (process.platform !== 'win32') process.kill(-p.pid, 'SIGTERM');
    else p.kill();
  } catch { /* 已退出 */ }
  for (let i = 0; i < 20; i++) {
    try {
      await fetch(BASE, { signal: AbortSignal.timeout(500) });
      await new Promise((r) => setTimeout(r, 300));
    } catch { break; }
  }
  await new Promise((r) => setTimeout(r, 500));
}

async function waitBoot() {
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (bootProc && bootProc.exitCode !== null) {
      dumpBootLog(`提前退出 code ${bootProc.exitCode}`);
      throw new Error(`dsh web 提前退出 (code ${bootProc.exitCode})`);
    }
    try {
      const log = fs.readFileSync(bootLogPath, 'utf8');
      const m = log.match(/dsh web: \S+\?token=(\S+)/);
      if (m) bootToken = m[1];
    } catch { /* 日志尚未写入 */ }
    try {
      const res = await fetch(bootToken ? `${BASE}/?token=${bootToken}` : BASE, {
        redirect: 'manual',
        signal: AbortSignal.timeout(1500),
      });
      if (res.ok) return res;
      if (res.status === 303 && bootToken) {
        const cookies = res.headers.getSetCookie?.() ?? [];
        authCookie = cookies.map((c) => c.split(';')[0]).join('; ');
        const page = await req(BASE, { signal: AbortSignal.timeout(1500) });
        if (page.ok) return page;
      }
    } catch { /* 未就绪 */ }
    await new Promise((r) => setTimeout(r, 2000));
  }
  dumpBootLog('等待超时');
  throw new Error(`boot 超时（${BOOT_TIMEOUT_MS / 1000}s 内未在 ${BASE} 就绪）`);
}

// 定位已安装插件的 package.json（全树浅扫，跳过纯运行时噪声目录）
function installedPluginJson() {
  const hits = [];
  const walk = (dir, depth) => {
    if (depth > 7 || !fs.existsSync(dir)) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(p, depth + 1);
      } else if (e.name === 'package.json') {
        try {
          const j = JSON.parse(fs.readFileSync(p, 'utf8'));
          if (j.name === '@xiaoyuyu6420/dsh-backup') hits.push({ dir: path.dirname(p), json: j });
        } catch { /* 非 JSON */ }
      }
    }
  };
  walk(home, 0);
  return hits[0] ?? null;
}

const rpc = async (method, args = {}) => {
  try {
    const res = await req(`${BASE}/api/backupPanel/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method: `backupPanel/${method}`, payload: { args } }),
    });
    const json = JSON.parse(await res.text());
    if (json?.type !== 'server-response') return { ok: false, raw: JSON.stringify(json).slice(0, 200) };
    return json.result?.value ?? json.result;
  } catch (err) {
    return { ok: false, raw: err.message };
  }
};

async function main() {
  console.log(`[e2e-upgrade] repo=${repoRoot} port=${PORT}`);
  console.log(`[e2e-upgrade] 旧版=${OLD_SPEC} 新版 tarball=${NEW_TARBALL}`);
  if (!fs.existsSync(NEW_TARBALL)) throw new Error(`找不到新版 tarball：${NEW_TARBALL}`);
  if (!NEW_VERSION) throw new Error(`读不出 tarball 版本（package/package.json）：${NEW_TARBALL}`);
  console.log(`[e2e-upgrade] 期望版本：旧=${OLD_VERSION || 'latest（跳过断言）'} 新=${NEW_VERSION}`);

  const ver1 = run(PHASE1_DSH, ['--version']).trim();
  const ver2 = run(PHASE2_DSH, ['--version']).trim();
  console.log(`[e2e-upgrade] 阶段一宿主: ${ver1}；阶段二宿主: ${ver2}${ver1 === ver2 ? '' : '（跨列车救援场景）'}`);

  home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-upg-'));
  console.log(`[e2e-upgrade] 隔离 home=${home}`);

  // ---------- 阶段一：安装 npm 上的旧正式版 ----------
  console.log(`\n[阶段一] 老用户世界：npm 安装 ${OLD_SPEC}`);
  run('dsh', ['plugin', '--profile', 'web', 'add', OLD_SPEC], { env: { ...process.env, DSH_HOME: home }, cwd: path.dirname(home) });
  let inst = installedPluginJson();
  if (SKIP_OLD_VERSION_ASSERT) {
    console.log(`  ℹ️ 旧版用 latest，跳过版本断言（实际 ${inst?.json?.version}）`);
  } else {
    check(`旧版 ${OLD_VERSION} 从 npm 安装成功`, inst?.json?.version === OLD_VERSION, `实际: ${inst?.json?.version ?? '未找到'}`);
  }

  const patchFile = path.join(home, 'profiles', 'web', 'cordis.patch.yml');
  fs.writeFileSync(patchFile, [
    '# e2e isolated profile: remap webserver port',
    '- id: webserver',
    '  config:',
    '    host: 127.0.0.1',
    `    port: ${PORT}`,
    '',
  ].join('\n'));

  startBoot(PHASE1_DSH);
  await waitBoot();
  check(`旧版 boot 后 webserver 200（${PHASE1_DSH === PHASE2_DSH ? '同列车' : PHASE1_DSH}）`, true);

  const cur0 = await req(`${BASE}/dsh-backup/settings`).then((r) => r.json()).catch(() => null);
  check('旧版 settings GET 正常', cur0 && cur0.revision !== undefined, JSON.stringify(cur0).slice(0, 120));

  // 老用户的自定义：保留份数 + 隔离目的地
  await req(`${BASE}/dsh-backup/settings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ revision: cur0.revision, keep: 5, destination: path.join(home, 'bkdest') }),
  }).then((r) => r.json());
  const saved1 = await req(`${BASE}/dsh-backup/settings`).then((r) => r.json());
  check('旧版保存自定义设置 keep=5', saved1?.settings?.keep === 5 || saved1?.keep === 5, JSON.stringify(saved1).slice(0, 160));

  // 老用户的健康会话日志（升级后归档 A 必须还能恢复它）
  const sessRoot = path.join(home, 'sessions', '--upgrade--');
  const headerLine = JSON.stringify({ type: 'session', version: 0, id: 'sess-upgrade', createdAt: 1757116800000, delegationDepth: 0 });
  const healthy = Buffer.concat([
    zstdCompressSync(`${headerLine}\n`),
    zstdCompressSync(`${JSON.stringify({ type: 'user/message', seq: 0 })}\n${JSON.stringify({ type: 'user/message', seq: 1 })}\n`),
  ]);
  fs.mkdirSync(path.join(sessRoot, 'enc-good'), { recursive: true });
  fs.writeFileSync(path.join(sessRoot, 'enc-good', 'session.jsonl.zstd'), healthy);

  const bk1 = await rpc('backup');
  check('旧版 RPC backup 成功', bk1?.ok === true, JSON.stringify(bk1).slice(0, 160));
  const st1 = await rpc('status');
  const archiveA = st1?.backups?.[0]?.name;
  check('旧版归档 A 已产生', Boolean(archiveA), JSON.stringify(st1).slice(0, 200));

  await stopBoot();

  // ---------- 阶段二：tarball 覆盖更新 ----------
  console.log(`\n[阶段二] 更新：tarball 安装 ${NEW_VERSION}`);
  let updatedVia = 'add';
  try {
    run('dsh', ['plugin', '--profile', 'web', 'add', NEW_TARBALL], { env: { ...process.env, DSH_HOME: home }, cwd: path.dirname(home) });
  } catch (e) {
    // 某些列车 add 已装包会拒绝 → remove+add 兜底（对用户数据等价：只动插件树）
    updatedVia = 'remove+add';
    run('dsh', ['plugin', '--profile', 'web', 'remove', '@xiaoyuyu6420/dsh-backup'], { env: { ...process.env, DSH_HOME: home }, cwd: path.dirname(home) });
    run('dsh', ['plugin', '--profile', 'web', 'add', NEW_TARBALL], { env: { ...process.env, DSH_HOME: home }, cwd: path.dirname(home) });
  }
  inst = installedPluginJson();
  check(`更新后安装目录版本 = ${NEW_VERSION}${updatedVia === 'remove+add' ? '（remove+add 路径）' : ''}`, inst?.json?.version === NEW_VERSION, `实际: ${inst?.json?.version ?? '未找到'}`);

  bootToken = '';
  authCookie = '';
  startBoot(PHASE2_DSH);
  await waitBoot();
  check('新版 boot 后 webserver 200', true);

  // ---------- 阶段三：升级后完整性 ----------
  console.log('\n[阶段三] 升级后完整性');
  const saved2 = await req(`${BASE}/dsh-backup/settings`).then((r) => r.json()).catch(() => null);
  const keepNow = saved2?.settings?.keep ?? saved2?.keep;
  check('设置无损：keep=5 跨版本保留', keepNow === 5, JSON.stringify(saved2).slice(0, 200));

  const st2 = await rpc('status');
  const names = (st2?.backups ?? []).map((b) => b.name);
  check('旧归档 A 仍在列表', names.includes(archiveA), `A=${archiveA} 现有=${names.join(',')}`);

  const dry = await rpc('restore', { selector: archiveA.replace(/\.tar\.gz$/, ''), dryRun: true });
  check('老归档 A dry-run 可恢复', dry?.ok === true || dry?.preview || dry?.plan, JSON.stringify(dry).slice(0, 200));

  const scan = await rpc('doctorScan');
  check('doctorScan 干净运行', scan?.ok === true && (scan?.corruptCount ?? 0) === 0, JSON.stringify(scan).slice(0, 200));

  const bk2 = await rpc('backup');
  check('新版 RPC backup 继续工作', bk2?.ok === true, JSON.stringify(bk2).slice(0, 160));
  const st3 = await rpc('status');
  check('新版归档 B 已产生', (st3?.backups ?? []).length >= 2, JSON.stringify(st3).slice(0, 200));

  await stopBoot();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n[e2e-upgrade] 结果: ${results.length - failed.length}/${results.length} 通过`);
  if (failed.length) {
    for (const f of failed) console.error(`  ❌ ${f.name} — ${f.detail}`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(`[e2e-upgrade] 致命错误: ${err.message}`);
  dumpBootLog('致命错误');
  process.exit(1);
}).finally(async () => {
  await stopBoot();
  bootLogStream?.end();
  if (home && process.env.E2E_KEEP_HOME !== '1') {
    try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* 清理失败不掩盖结果 */ }
  }
});
