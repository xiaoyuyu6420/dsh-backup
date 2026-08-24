#!/usr/bin/env node
/**
 * 真实宿主 e2e：隔离 DSH_HOME + 本地插件 link + boot + HTTP 断言。
 *
 * 用法：node scripts/e2e-host.mjs
 * 前提：PATH 里有 `dsh` CLI（CI 里先 `npm i -g @deepseek-ai/dsh@latest`）。
 *
 * 覆盖（对应 docs/compatibility.md 验收判据第 2/3 条）：
 *   1. cordis 全有或全无：boot 成功 + webserver HTTP 200 = 插件 peer/API 兼容
 *   2. 客户端列车陷阱：HTML 必须预加载官方 client 包（0.1.1-rc+ webserver 行为）
 *   3. settings seam：GET/POST/409/400/重启持久化/reset（<0.8.0 无此路由时自动跳过）
 *
 * 零依赖；退出码 0=全过，1=有失败。
 */

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.E2E_PORT || 13131);
const BASE = `http://127.0.0.1:${PORT}`;
const BOOT_TIMEOUT_MS = 90_000;

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? '✅' : '❌'} ${name}${detail && !ok ? ` — ${detail}` : ''}`);
  return ok;
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 180_000, ...opts });
  if (r.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} 失败 (exit ${r.status}):\n${r.stderr || r.stdout}`);
  }
  return r.stdout;
}

let bootProc = null;
let home = null;

function startBoot() {
  bootProc = spawn('dsh', ['web', '--no-open'], {
    cwd: home,
    env: { ...process.env, DSH_HOME: home },
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  bootProc.unref();
}

async function stopBoot() {
  if (!bootProc) return;
  const p = bootProc;
  bootProc = null;
  try {
    if (process.platform !== 'win32') process.kill(-p.pid, 'SIGTERM');
    else p.kill();
  } catch { /* 已退出 */ }
  // 等端口释放，避免下一次 boot 撞 EADDRINUSE
  for (let i = 0; i < 20; i++) {
    try {
      await fetch(BASE, { signal: AbortSignal.timeout(500) });
      await new Promise((r) => setTimeout(r, 300));
    } catch {
      return; // 端口已无响应
    }
  }
}

async function waitBoot() {
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (bootProc && bootProc.exitCode !== null) {
      throw new Error(`dsh web 提前退出 (code ${bootProc.exitCode})——插件树被拒绝加载`);
    }
    try {
      const res = await fetch(BASE, { signal: AbortSignal.timeout(1500) });
      if (res.ok) return res;
    } catch { /* 未就绪 */ }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`boot 超时（${BOOT_TIMEOUT_MS / 1000}s 内未在 ${BASE} 就绪）`);
}

async function main() {
  console.log(`[e2e-host] repo=${repoRoot} port=${PORT}`);

  // ---------- 准备：隔离 DSH_HOME + link 本地包 ----------
  if (!spawnSync('dsh', ['--version']).status === 0) throw new Error('PATH 里找不到 dsh CLI');
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-e2e-'));
  run('dsh', ['plugin', '--profile', 'web', 'add', repoRoot], { env: { ...process.env, DSH_HOME: home }, cwd: path.dirname(home) });

  const patchFile = path.join(home, 'profiles', 'web', 'cordis.patch.yml');
  fs.writeFileSync(patchFile, [
    '# e2e isolated profile: remap webserver port',
    '- id: webserver',
    '  config:',
    '    host: 127.0.0.1',
    `    port: ${PORT}`,
    '',
  ].join('\n'));

  // ---------- 第一轮 boot ----------
  startBoot();
  const indexHtml = await (await waitBoot()).text();

  check('boot 后 webserver 返回 200（cordis 全有或全无通过）', true);
  check(
    'HTML 预加载官方 client 包（客户端列车兼容）',
    indexHtml.includes('/plugins/@deepseek-ai/dsh-client-modules/client.js'),
    'HTML 缺少 dsh-client-modules/client.js 预加载——宿主可能是旧列车或插件树未进 web 组合',
  );

  // ---------- settings seam ----------
  const settingsRes = await fetch(`${BASE}/dsh-backup/settings`).then((r) => r.json()).catch(() => null);
  const seamPresent = settingsRes && !settingsRes.error && settingsRes.revision !== undefined;

  if (!seamPresent) {
    console.log('  ⏭️  settings 路由不存在（<0.8.0），跳过 seam 断言');
  } else {
    check('settings GET 返回默认结构', typeof settingsRes.revision === 'number' && settingsRes.hasOverrides === false && Array.isArray(settingsRes.redact));

    let cur = settingsRes.revision;
    const saved = await fetch(`${BASE}/dsh-backup/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ revision: cur, keep: 5, destination: path.join(home, 'dest') }),
    }).then((r) => r.json());
    check('POST 保存合并字段并递增 revision', saved.keep === 5 && saved.revision === cur + 1 && saved.hasOverrides === true);
    cur = saved.revision;

    const conflict = await fetch(`${BASE}/dsh-backup/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ revision: settingsRes.revision, keep: 9 }),
    });
    const conflictBody = await conflict.json();
    check('过期 revision 重放返回 409 且带 actual revision', conflict.status === 409 && conflictBody.revision === cur);

    const invalid = await fetch(`${BASE}/dsh-backup/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ revision: cur, keep: -3 }),
    });
    const invalidBody = await invalid.json();
    check('非法 keep 返回 400 invalid-field', invalid.status === 400 && Array.isArray(invalidBody.fields) && invalidBody.fields.includes('keep'));

    const yamlPath = path.join(home, 'settings.yaml');
    const yamlAfterSave = fs.existsSync(yamlPath) ? fs.readFileSync(yamlPath, 'utf8') : '';
    check('保存后 settings.yaml 落盘用户层', yamlAfterSave.includes('dsh-backup:') && yamlAfterSave.includes('keep: 5'));

    // 重启验证持久化
    await stopBoot();
    startBoot();
    await waitBoot();
    const persisted = await fetch(`${BASE}/dsh-backup/settings`).then((r) => r.json());
    check('重启后用户层持久生效', persisted.keep === 5 && persisted.hasOverrides === true);

    const reset = await fetch(`${BASE}/dsh-backup/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reset: true, revision: persisted.revision }),
    }).then((r) => r.json());
    check('reset 清空用户层回退默认值', reset.hasOverrides === false && reset.keep !== 5);
    const yamlAfterReset = fs.existsSync(yamlPath) ? fs.readFileSync(yamlPath, 'utf8') : '';
    check('reset 后 settings.yaml 用户层清空', /dsh-backup:\s*\{\}|dsh-backup:\s*$/.test(yamlAfterReset.trim().split('\n').find((l) => l.startsWith('dsh-backup')) ?? '') || !yamlAfterReset.includes('keep: 5'));
  }

  // ---------- 总结 ----------
  const failed = results.filter((r) => !r.ok);
  console.log(`\n[e2e-host] 结果: ${results.length - failed.length}/${results.length} 通过`);
  if (failed.length > 0) {
    for (const f of failed) console.log(`  ❌ ${f.name}${f.detail ? `\n     ${f.detail}` : ''}`);
    process.exitCode = 1;
  }
}

try {
  await main();
} catch (err) {
  console.error(`[e2e-host] 致命错误: ${err.message}`);
  process.exitCode = 1;
} finally {
  await stopBoot();
  if (home) fs.rmSync(home, { recursive: true, force: true });
}
