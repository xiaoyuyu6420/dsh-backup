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
 *   4. doctor RPC 往返：备份 → 弄坏会话日志 → 扫描检出 → 定点修复 → 复扫全绿；
 *      老归档（删 meta/redacted 边车）dry-run 恢复静默降级
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
let packDir = null;
let bootLogPath = null;
let bootLogStream = null;

function startBoot() {
  bootLogPath = path.join(home, 'boot.log');
  bootLogStream = fs.createWriteStream(bootLogPath);
  bootProc = spawn('dsh', ['web', '--no-open'], {
    cwd: home,
    // HOME 一并隔离：默认备份目的地（~/Desktop/dsh-backups）与 auto.json 都
    // 派生自 HOME——不隔离会把启动钩子的状态写进开发者真实备份目录
    // （实测污染事故，见 PR #30 讨论）。
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
    console.error(`[e2e-host] boot 日志（${reason}）最后 40 行:\n${text.split('\n').slice(-40).join('\n')}`);
  } catch (e) {
    console.error(`[e2e-host] boot 日志不可读: ${e.message}`);
  }
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
      dumpBootLog(`提前退出 code ${bootProc.exitCode}`);
      throw new Error(`dsh web 提前退出 (code ${bootProc.exitCode})——见上方 boot 日志`);
    }
    try {
      const res = await fetch(BASE, { signal: AbortSignal.timeout(1500) });
      if (res.ok) return res;
    } catch { /* 未就绪 */ }
    await new Promise((r) => setTimeout(r, 2000));
  }
  dumpBootLog('等待超时');
  throw new Error(`boot 超时（${BOOT_TIMEOUT_MS / 1000}s 内未在 ${BASE} 就绪）`);
}

async function main() {
  console.log(`[e2e-host] repo=${repoRoot} port=${PORT}`);

  // ---------- 准备：隔离 DSH_HOME + tarball 安装 ----------
  // 不用 `dsh plugin add <repo>`（link 方式）：link 引导的 profile 里 panel RPC 报
  // `active Service "backupPanel" is unavailable`（宿主 link 路径的差异，npm/tarball 正常）。
  // tarball 安装 = 真实用户路径，且顺带验证发布物内容。
  if (!spawnSync('dsh', ['--version']).status === 0) throw new Error('PATH 里找不到 dsh CLI');
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-e2e-'));
  packDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-e2e-pack-'));
  console.log(`[e2e-host] 打包 tarball...`);
  run('pnpm', ['pack', '--pack-destination', packDir], { cwd: repoRoot });
  const tarball = fs.readdirSync(packDir).find((f) => f.endsWith('.tgz'));
  if (!tarball) throw new Error('pnpm pack 未产出 tarball');
  run('dsh', ['plugin', '--profile', 'web', 'add', path.join(packDir, tarball)], { env: { ...process.env, DSH_HOME: home }, cwd: path.dirname(home) });

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

  // panel RPC 可用性（link 安装的 profile 会报 service-unavailable，tarball/npm 正常）
  let rpcDetail = '请求失败';
  let rpcOk = false;
  try {
    const rpcRes = await fetch(`${BASE}/api/backupPanel/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: randomUUID(),
        method: 'backupPanel/status',
        payload: { args: {} },
      }),
    });
    const rpcText = await rpcRes.text();
    try {
      const rpc = JSON.parse(rpcText);
      rpcOk = rpc?.type === 'server-response' && rpc?.result?.ok === true;
      rpcDetail = `HTTP ${rpcRes.status} ${rpcText.slice(0, 200)}`;
    } catch {
      rpcDetail = `HTTP ${rpcRes.status} 非JSON: ${rpcText.slice(0, 120)}`;
    }
  } catch (err) {
    rpcDetail = `fetch 异常: ${err.message}`;
  }
  check('panel RPC backupPanel/status 可调用', rpcOk, rpcDetail);

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

  // ---------- doctor：体检/定点修复 RPC 往返 + 老归档静默降级 ----------
  if (!seamPresent) {
    console.log('  ⏭️  无 settings 路由（<0.8.0），跳过 doctor / 老归档断言');
  } else {
    const rpc = async (method, args = {}) => {
      try {
        const res = await fetch(`${BASE}/api/backupPanel/${method}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method: `backupPanel/${method}`, payload: { args } }),
        });
        const json = JSON.parse(await res.text());
        if (json?.type !== 'server-response') return { ok: false, raw: JSON.stringify(json).slice(0, 200) };
        // typert 直接调用把返回值包在 result.value 里
        return json.result?.value ?? json.result;
      } catch (err) {
        return { ok: false, raw: err.message };
      }
    };

    // 备份目的地指进隔离 home，避免污染开发机真实的备份目录
    const cur0 = await fetch(`${BASE}/dsh-backup/settings`).then((r) => r.json());
    await fetch(`${BASE}/dsh-backup/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ revision: cur0.revision, destination: path.join(home, 'bkdest') }),
    }).then((r) => r.json());

    // 会话日志布局对齐 @deepseek-ai/dsh-session-persistence-jsonl：
    // 两份都先写健康内容 → 备份（归档持健康副本）→ 再弄坏一份现场
    const sessRoot = path.join(home, 'sessions', '--e2e--');
    const headerLine = JSON.stringify({ type: 'session', version: 0, id: 'sess-e2e', createdAt: '2026-08-25T00:00:00.000Z', delegationDepth: 0 });
    const healthy = Buffer.concat([
      zstdCompressSync(`${headerLine}\n`),
      zstdCompressSync(`${JSON.stringify({ type: 'user/message', seq: 0 })}\n${JSON.stringify({ type: 'user/message', seq: 1 })}\n`),
    ]);
    for (const dirName of ['enc-good', 'enc-bad']) {
      fs.mkdirSync(path.join(sessRoot, dirName), { recursive: true });
      fs.writeFileSync(path.join(sessRoot, dirName, 'session.jsonl.zstd'), healthy);
    }
    const bk = await rpc('backup');
    check('RPC backup 成功', bk?.ok === true, JSON.stringify(bk).slice(0, 160));
    fs.writeFileSync(path.join(sessRoot, 'enc-bad', 'session.jsonl.zstd'), Buffer.from('corrupt payload, not zstd'));

    const scan = await rpc('doctorScan');
    check(
      'RPC doctorScan 检出损坏会话日志',
      scan?.ok === false && scan?.corruptCount === 1 && String(scan?.corrupt?.[0]?.path).includes('enc-bad'),
      JSON.stringify(scan).slice(0, 200),
    );

    const repair = await rpc('doctorRepair', { selector: 'latest' });
    let repairedBytesOk = false;
    try {
      repairedBytesOk = fs.readFileSync(path.join(sessRoot, 'enc-bad', 'session.jsonl.zstd')).equals(healthy);
    } catch { /* 文件缺失视为未修复 */ }
    check(
      'RPC doctorRepair 从归档定点还原损坏文件',
      repair?.ok === true && repair?.repaired?.length === 1 && repairedBytesOk,
      `${JSON.stringify(repair).slice(0, 160)} bytes=${repairedBytesOk}`,
    );

    const rescan = await rpc('doctorScan');
    check('修复后复扫全绿', rescan?.ok === true && rescan?.corruptCount === 0, JSON.stringify(rescan).slice(0, 160));

    // 老归档兼容：删 meta/redacted 边车（v0.6.x 形态）→ dry-run 静默降级仍可预览
    const bkdest = path.join(home, 'bkdest');
    const legacyName = fs.readdirSync(bkdest).filter((f) => /^dsh-\d.*\.tar\.gz$/.test(f)).sort().pop();
    for (const suffix of ['.meta.json', '.redacted.json']) fs.rmSync(path.join(bkdest, legacyName + suffix), { force: true });
    const legacyPre = await rpc('restore', { selector: legacyName.replace(/\.tar\.gz$/, ''), dryRun: true });
    check(
      '无边车老归档 dry-run 静默降级（无脱敏提示、有老格式提醒）',
      legacyPre?.ok === true && !String(legacyPre?.summary).includes('🔐') && String(legacyPre?.summary).includes('未携带脱敏清单'),
      JSON.stringify(legacyPre).slice(0, 220),
    );

    // ---------- 智能备份全流程：真宿主版本探测 + 模拟升级 + 体检隔离链路 ----------
    // 1) 启动即记录"正在运行的宿主版本"，且与 CLI 报告一致（argv 解析实证，
    //    覆盖全局/npm/npx 缓存安装形态）。auto.json 跟随生效备份目录：首次
    //    启动在默认目的地（HOME 已隔离），设置 destination 后迁移到 bkdest。
    const verOut = spawnSync('dsh', ['--version'], { encoding: 'utf8' });
    const cliVersion = (verOut.stdout || '').trim();
    const defaultAuto = () => path.join(home, 'Desktop', 'dsh-backups', 'auto.json');
    const bkdestAuto = () => path.join(home, 'bkdest', 'auto.json');
    const readAuto = () => {
      for (const p of [defaultAuto(), bkdestAuto()]) {
        try {
          return JSON.parse(fs.readFileSync(p, 'utf8'));
        } catch { /* 尝试下一个位置 */ }
      }
      return null;
    };
    let bootedTrain = null;
    for (let i = 0; i < 20 && bootedTrain === null; i += 1) {
      await new Promise((r) => setTimeout(r, 250));
      const a = readAuto();
      if (a && typeof a.lastTrain === 'string') bootedTrain = a.lastTrain;
    }
    check('启动记录运行中宿主版本，与 dsh --version 一致', typeof bootedTrain === 'string' && bootedTrain === cliVersion, `auto=${bootedTrain} cli=${cliVersion}`);

    // 2) 模拟升级：改写全部已知 auto.json 的 lastTrain → 重启宿主 → 钩子自动拍快照
    for (const p of [defaultAuto(), bkdestAuto()]) {
      try {
        const o = JSON.parse(fs.readFileSync(p, 'utf8'));
        fs.writeFileSync(p, JSON.stringify({ ...o, lastTrain: '0.0.0-e2e-old' }));
      } catch { /* 该位置尚无文件 */ }
    }
    await stopBoot();
    startBoot();
    await waitBoot();
    let snapName = null;
    // 快照落在"生效备份目录"——seam 块的 reset 会把 destination 打回默认，
    // 两个候选目录都要扫
    for (let i = 0; i < 40 && !snapName; i += 1) {
      await new Promise((r) => setTimeout(r, 250));
      for (const p of [defaultAuto(), bkdestAuto()]) {
        const dir = path.dirname(p);
        try {
          snapName = fs.readdirSync(dir).find((n) => n.startsWith('dsh-pre-upgrade-') && n.endsWith('.tar.gz')) || null;
        } catch { /* 目录尚不存在 */ }
        if (snapName) break;
      }
      if (snapName) break;
    }
    check('模拟升级后自动产生 dsh-pre-upgrade- 快照', Boolean(snapName), `snap=${snapName}`);
    if (!snapName) {
      // 现场转储：两个候选备份目录的内容 + 本次 boot 日志中本插件相关行
      const dumpDir = (p) => {
        try {
          return `${p} → ${fs.readdirSync(p).join(', ')}`;
        } catch (e) {
          return `${p} → (${e.code})`;
        }
      };
      console.error(`[e2e-host][debug] ${dumpDir(path.join(home, 'Desktop', 'dsh-backups'))}`);
      console.error(`[e2e-host][debug] ${dumpDir(bkdest)}`);
      try {
        const hits = fs.readFileSync(path.join(home, 'boot.log'), 'utf8')
          .split('\n')
          .filter((l) => l.includes('dsh-backup') || /error|异常|失败/i.test(l))
          .slice(-15);
        console.error(`[e2e-host][debug] boot.log 相关行:\n${hits.join('\n')}`);
      } catch { /* 日志不可读 */ }
    }
    // 钩子在快照文件落盘后还有 prune/回写 lastTrain 的尾巴，且回写目标是
    // "生效备份目录"的 auto.json——两个候选任一回写为真实版本即通过
    let trainOk = false;
    for (let i = 0; i < 20 && !trainOk; i += 1) {
      await new Promise((r) => setTimeout(r, 250));
      trainOk = [defaultAuto(), bkdestAuto()].some((p) => {
        try {
          return JSON.parse(fs.readFileSync(p, 'utf8')).lastTrain === cliVersion;
        } catch {
          return false;
        }
      });
    }
    const rawAutos = [defaultAuto(), bkdestAuto()].map((p) => {
      try {
        return `${path.basename(path.dirname(path.dirname(p)))}:${JSON.parse(fs.readFileSync(p, 'utf8')).lastTrain}`;
      } catch {
        return `${path.basename(path.dirname(p))}:(-)`;
      }
    }).join(' | ');
    check('快照后 lastTrain 回写为真实宿主版本', trainOk, `raw[${rawAutos}]`);
    const stSnap = await rpc('status');
    console.log(`[e2e-host][info] rpcDestination=${stSnap?.destination} backups=${JSON.stringify((stSnap?.backups ?? []).map((b) => b.name))}`);
    console.log(`[e2e-host][info] defaultAuto exists=${fs.existsSync(defaultAuto())} bkdestAuto exists=${fs.existsSync(bkdestAuto())}`);
    check(
      '内部快照不进用户备份列表',
      Array.isArray(stSnap?.backups) && stSnap.backups.length > 0 && !stSnap.backups.some((b) => b.name.startsWith('dsh-pre-upgrade-')),
      `rpcDestination=${stSnap?.destination} backups=${JSON.stringify(stSnap?.backups?.slice(0, 2))}`,
    );
    if (snapName) {
      const preDry = await rpc('restore', { selector: snapName.replace(/\.tar\.gz$/, ''), dryRun: true });
      check('显式前缀可恢复升级前快照（dry-run）', preDry?.ok === true, JSON.stringify(preDry).slice(0, 160));
    }

    // 3) 体检隔离全流程：好文件入档(A) → 弄坏 → 再备份(B)被隔离 → 从 A 定点修复
    const qDir = path.join(home, 'sessions', '--e2e-q--', 'raw-x');
    fs.mkdirSync(qDir, { recursive: true });
    const healthyText = [
      JSON.stringify({ type: 'session', version: 0, id: 'sess-q', createdAt: '2026-08-26T00:00:00.000Z', delegationDepth: 0 }),
      JSON.stringify({ type: 'user/message', seq: 0 }),
      JSON.stringify({ type: 'user/message', seq: 1 }),
    ].join('\n');
    fs.writeFileSync(path.join(qDir, 'session.jsonl'), healthyText);
    await rpc('backup');
    const nameA = (await rpc('status')).backups[0].name;
    fs.writeFileSync(path.join(qDir, 'session.jsonl'), `${healthyText}\n${JSON.stringify({ type: 'user/message', seq: 7 })}`);
    const bkB = await rpc('backup');
    check('隔离备份回执出现警告', bkB?.ok === true && String(bkB?.summary).includes('未入档'), JSON.stringify(bkB).slice(0, 160));
    const nameB = (await rpc('status')).backups[0].name;
    const bTar = spawnSync('tar', ['-tzf', path.join(bkdest, nameB)], { encoding: 'utf8' }).stdout;
    check('损坏会话文件不入档 B', !bTar.includes('raw-x/session.jsonl'), bTar.split('\n').filter((l) => l.includes('raw-x')).join(','));
    const metaB = JSON.parse(fs.readFileSync(path.join(bkdest, `${nameB}.meta.json`), 'utf8'));
    check('B 的 meta.quarantined 记录隔离清单', Array.isArray(metaB.quarantined) && metaB.quarantined.some((p) => p.includes('raw-x')), JSON.stringify(metaB.quarantined));
    const scanQ = await rpc('doctorScan');
    check('doctorScan 检出该损坏文件', scanQ?.corruptCount === 1 && String(scanQ?.corrupt?.[0]?.path).includes('--e2e-q--'), JSON.stringify(scanQ).slice(0, 160));
    const repQ = await rpc('doctorRepair', { selector: nameA.replace(/\.tar\.gz$/, '') });
    let bytesOk = false;
    try {
      bytesOk = fs.readFileSync(path.join(qDir, 'session.jsonl'), 'utf8') === healthyText;
    } catch { /* 缺失即失败 */ }
    check('从更早归档 A 定点修复且字节一致', repQ?.ok === true && repQ?.repaired?.length === 1 && bytesOk, `${JSON.stringify(repQ).slice(0, 160)} bytes=${bytesOk}`);
    const rescanQ = await rpc('doctorScan');
    check('修复后复扫全绿', rescanQ?.ok === true && rescanQ?.corruptCount === 0, JSON.stringify(rescanQ).slice(0, 120));
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
  if (packDir) fs.rmSync(packDir, { recursive: true, force: true });
}
