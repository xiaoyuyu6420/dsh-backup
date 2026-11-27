/** #143: synthetic logs only, through the command/tool/panel/timer/rescue entry points. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import * as zlib from 'node:zlib';
import { SESSION_LIMITS, decodeZstdLog, decodePlainLog, readSessionBytes, SessionLimitError, SessionCorruptError } from '../lib/session-log.js';
import { installSmokeStubs, makeCtx, mkTmpHome, tarList, rmTemp } from './smoke.mjs';
await installSmokeStubs();
const { apply } = await import('../lib/index.js');
const header = JSON.stringify({ type: 'session', version: 4, id: 'synthetic-143', createdAt: 0, delegationDepth: 0 }) + '\n';
const line = JSON.stringify({ type: 'future', data: 'x'.repeat(1024 * 1024) }) + '\n';
const compress = (s) => zlib.zstdCompressSync(Buffer.from(s));
const hasZstd = typeof zlib.zstdCompressSync === 'function';
let checks = 0;
function check(name, fn) { fn(); checks++; console.log(`PASS ${name}`); }
const exists = (p) => fs.stat(p).then(() => true, () => false);
const t = await mkTmpHome();
try {
  // Git may check out text as CRLF on Windows; compare source after normalizing EOLs.
  const sourceText = async (rel) => (await fs.readFile(new URL(rel, import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
  const lib = await sourceText('../lib/session-log.js');
  const rescue = await sourceText('../rescue/rescue.mjs');
  check('standalone rescue reader stays identical to shared reader', () => assert.equal(
    rescue.split('// BEGIN BOUNDED SESSION READER\n')[1].split('// END BOUNDED SESSION READER')[0],
    lib.slice(lib.indexOf('// Mirrored'), lib.indexOf('\nexport {'))));
  check('plain line budget and empty-line semantics', () => {
    assert.deepEqual(decodePlainLog(Buffer.from(header + '\n{}')), [header.trim(), '{}']);
    assert.throws(() => decodePlainLog(Buffer.from('{}\n'.repeat(SESSION_LIMITS.lines + 1))), SessionLimitError);
    assert.throws(() => decodePlainLog(Buffer.alloc(SESSION_LIMITS.line + 1, 120)), SessionLimitError);
  });
  const sparse = `${t.dir}/over-limit`;
  const fd = await fs.open(sparse, 'w'); await fd.truncate(SESSION_LIMITS.input + 1); await fd.close();
  await assert.rejects(readSessionBytes(sparse), SessionLimitError); checks++;
  await assert.rejects(readSessionBytes(`${t.dir}/missing`), { code: 'ENOENT' }); checks++;
  await fs.writeFile(`${t.dsh}/.credentials.yaml`, 'version: 1\nkey: synthetic\n');
  const sessionDir = `${t.dsh}/sessions/synthetic-143`;
  await fs.mkdir(sessionDir, { recursive: true });
  const rel = `sessions/synthetic-143/session.v4.jsonl${hasZstd ? '.zstd' : ''}`;
  const largeFile = `${t.dsh}/${rel}`;
  const good = hasZstd ? compress(header) : Buffer.from(header);
  // 65 small, highly compressible frames exceed the cumulative decoded budget without
  // allocating a 65 MiB string. The bytes on disk are only a few KiB.
  const large = hasZstd ? Buffer.concat([good, ...Array(65).fill(compress(line))]) : Buffer.from(header + '{}\n'.repeat(SESSION_LIMITS.lines));
  if (hasZstd) {
    check('cumulative decoded budget, one-frame bomb and frame-count budget are unverified', () => {
      assert.throws(() => decodeZstdLog(large), SessionLimitError);
      assert.throws(() => decodeZstdLog(Buffer.concat([good, compress(Buffer.alloc(SESSION_LIMITS.frame + 1, 120))])), SessionLimitError);
      assert.throws(() => decodeZstdLog(Buffer.concat([good, ...Array(SESSION_LIMITS.frames).fill(compress(''))])), SessionLimitError);
    });
    check('UTF-8 and logical lines can cross frame boundaries', () => {
      const raw = Buffer.from('{"text":"鱼"}\n'); const cut = raw.indexOf(Buffer.from('鱼')) + 1;
      const r = decodeZstdLog(Buffer.concat([good, compress(raw.subarray(0, cut)), compress(raw.subarray(cut))]));
      assert.equal(r.lines[1], '{"text":"鱼"}');
    });
    check('container corruption remains corruption', () => {
      assert.throws(() => decodeZstdLog(Buffer.concat([good, Buffer.from([1])])), SessionCorruptError);
      assert.throws(() => decodeZstdLog(compress(header + '{}\n'), { checkHeaderFrame: true }), SessionCorruptError);
    });
  }
  await fs.writeFile(largeFile, large);
  const mock = makeCtx(t); apply(mock.ctx, { keep: 1 });
  await new Promise((r) => setTimeout(r, 80));
  const panel = mock.services.find((s) => s.name === 'backupPanel');
  let scan = await panel.doctorScan();
  check('panel Doctor marks over-limit content unverified with no repair candidates', () => {
    assert.equal(scan.corruptCount, 0); assert.equal(scan.skippedCount, 1);
    assert.equal(scan.unverified[0].rel, rel); assert.match(scan.summary, /未能深度校验/);
  });
  if (hasZstd) {
    const brokenHeader = compress('{"type":"model/selection","seq":13311}\n');
    await fs.writeFile(largeFile, Buffer.concat([brokenHeader, ...Array(65).fill(compress(line))]));
    const provenBad = await panel.doctorScan();
    check('proven bad first header still wins before a later resource limit', () => { assert.equal(provenBad.corruptCount, 1); assert.equal(provenBad.skippedCount, 0); });
    const checksum = zlib.zstdCompressSync(Buffer.from(header), { params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } });
    checksum[checksum.length - 1] ^= 1;
    await fs.writeFile(largeFile, checksum);
    const damaged = await panel.doctorScan();
    check('native checksum failure remains confirmed corruption', () => { assert.equal(damaged.corruptCount, 1); assert.equal(damaged.skippedCount, 0); });
    await fs.writeFile(largeFile, large);
  }
  const repairNone = await mock.handler('doctor --repair');
  check('command repair does not require an archive or touch an unverified file', () => {
    assert.equal(repairNone.kind, 'success'); assert.match(repairNone.text, /未能深度校验/);
  });
  assert.deepEqual(await fs.readFile(largeFile), large);
  const toolScan = await mock.tool().execute({ mode: 'doctor' }, {});
  check('model tool reports skipped coverage separately', () => assert.equal(toolScan.skippedCount, 1));
  if (hasZstd) {
    const rewind = await panel.sessionRewindPreview('synthetic-143');
    check('oversize rewind preview fails safely without a new session', () => { assert.equal(rewind.ok, false); assert.match(rewind.summary, /资源上限/); });
    assert.deepEqual(await fs.readFile(largeFile), large);
  }
  const migration = await mock.handler('migrate-check');
  check('migration preflight does not declare oversize logs broken', () => {
    assert.match(migration.text, /跳过|未预检|未验证|未能判定/); assert.doesNotMatch(migration.text, /doctor 体检会按损坏处理/);
  });
  await fs.mkdir(t.root, { recursive: true });
  const today = new Date().toISOString().slice(0, 10).replaceAll('-', '');
  const old = ['000000001', '000000002'].map((stamp) => `${t.root}/dsh-${today}-${stamp}.tar.gz`);
  for (const p of old) await fs.writeFile(p, 'synthetic rotation sentinel');
  const backup = await panel.backup(1);
  const entries = await tarList(t.root, backup.path.split('/').pop());
  check('real tar backup includes unverified sessions and keeps rotation active', () => {
    assert.equal(backup.archiveStatus, 'unverified'); assert.equal(backup.retentionPaused, false);
    assert.deepEqual(backup.quarantined, []); assert.ok(backup.stale > 0);
    assert.ok(entries.includes(`.dsh/${rel}`));
  });
  assert.ok((await Promise.all(old.map(exists))).some((present) => !present));
  const extracted = spawnSync('tar', ['-xOzf', backup.path.split('/').pop(), `.dsh/${rel}`], { cwd: t.root, maxBuffer: large.length + 1024 });
  check('archived unverified bytes are exact', () => { assert.equal(extracted.status, 0); assert.deepEqual(extracted.stdout, large); });
  const meta = JSON.parse(await fs.readFile(`${backup.path}.meta.json`, 'utf8'));
  check('archive metadata persists verification limits', () => { assert.equal(meta.archiveStatus, 'unverified'); assert.equal(meta.validation.unverified[0].rel, rel); });
  const standalone = spawnSync(process.execPath, [`${t.root}/rescue.mjs`, 'doctor', '--repair'], { env: { ...process.env, DSH_HOME: t.dsh }, encoding: 'utf8' });
  check('copied standalone rescue never repairs over-limit content', () => { assert.equal(standalone.status, 0, standalone.stderr); assert.match(standalone.stdout, /未能深度校验/); });
  assert.deepEqual(await fs.readFile(largeFile), large);
  const preview = await mock.handler(`restore ${backup.path.split('/').pop()} --dry-run`);
  check('restore preview carries unverified-content warning', () => assert.match(preview.text, /会话未全部验证/));
  // A broken current log restored from an oversized backup must not claim healthy.
  await fs.writeFile(largeFile, hasZstd ? compress('{"type":"model/selection","seq":13311}\n') : Buffer.from('{"type":"model/selection","seq":13311}\n'));
  const repaired = await panel.doctorRepair(backup.path.split('/').pop());
  check('repair from unverified archive does not claim a healthy recheck', () => { assert.match(repaired.summary, /恢复后未验证/); assert.doesNotMatch(repaired.summary, /复检全部健康/); });
  assert.deepEqual(await fs.readFile(largeFile), large);
  if (process.platform !== 'win32') {
    const unreadable = `${sessionDir}/session.v2.jsonl`;
    await fs.symlink(`${t.dir}/nonexistent`, unreadable);
    const unavailable = await panel.doctorScan();
    check('read errors are unverified and cannot authorize repair', () => { assert.equal(unavailable.corruptCount, 0); assert.equal(unavailable.skippedCount, 2); });
    await fs.unlink(unreadable);
  }
  const bad = `${sessionDir}/session.v3.jsonl`;
  await fs.writeFile(bad, '{"type":"model/selection","seq":13311}\n');
  scan = await panel.doctorScan();
  check('missing session header is still proven corruption alongside unverified content', () => {
    assert.equal(scan.corruptCount, 1); assert.equal(scan.skippedCount, 1); assert.match(scan.corrupt[0].reason, /type 不是/);
  });
  const sentinel = `${t.root}/dsh-${today}-000000003.tar.gz`; await fs.writeFile(sentinel, 'preserve me');
  const logs = [], warnings = [], errors = [];
  const orig = { log: console.log, warn: console.warn, error: console.error };
  async function tick() {
    const index = mock.timeouts.length;
    await mock.handler('auto 2');
    console.log = (...a) => logs.push(a.join(' ')); console.warn = (...a) => warnings.push(a.join(' ')); console.error = (...a) => errors.push(a.join(' '));
    try { await mock.timeouts[index].fn(); } finally { Object.assign(console, orig); }
    return JSON.parse(await fs.readFile(`${t.root}/auto.json`, 'utf8'));
  }
  let state = await tick();
  check('automatic incomplete archive is a persistent warning, not fatal failure or clean success', () => {
    assert.equal(state.lastAutoWarning.status, 'incomplete'); assert.equal(state.lastAutoError, null);
    assert.ok(state.lastAutoAt); assert.ok(warnings.some((s) => s.includes('归档不完整')));
    assert.ok(!logs.some((s) => s.includes('自动备份完成'))); assert.equal(errors.length, 0);
  });
  assert.ok(await exists(sentinel));
  const archiveNames = (await fs.readdir(t.root)).filter((n) => /^dsh-\d.*\.tar\.gz$/.test(n)).sort();
  const incomplete = `${t.root}/${archiveNames.at(-1)}`;
  const autoEntries = await tarList(t.root, incomplete.split('/').pop());
  check('automatic tar excludes only proven corruption', () => {
    assert.ok(autoEntries.includes(`.dsh/${rel}`)); assert.ok(!autoEntries.includes('.dsh/sessions/synthetic-143/session.v3.jsonl'));
  });
  const mock2 = makeCtx(t); apply(mock2.ctx, { keep: 1 }); await new Promise((r) => setTimeout(r, 80));
  const resumed = await mock2.handler('auto status');
  check('warning survives restart in command and panel status', () => assert.match(resumed.text, /归档不完整/));
  assert.match((await mock2.services.find((s) => s.name === 'backupPanel').status()).autoNotice, /归档不完整/);
  await fs.rm(bad); state = await tick();
  check('only oversized content produces unverified warning, with no retention pause', () => { assert.equal(state.lastAutoWarning.status, 'unverified'); assert.equal(state.lastAutoError, null); });
  assert.equal(await exists(sentinel), false);
  const originalResolve = mock.ctx.subprocess.resolveExecutable;
  mock.ctx.subprocess.resolveExecutable = async () => { throw new Error('synthetic fatal spawn failure'); };
  state = await tick();
  check('fatal archive failure stays distinct from verification warnings', () => { assert.match(state.lastAutoError.message, /synthetic fatal/); assert.equal(state.lastAutoWarning, null); });
  mock.ctx.subprocess.resolveExecutable = originalResolve;
  await fs.writeFile(largeFile, good); state = await tick();
  check('subsequent healthy success clears both warning and failure', () => { assert.equal(state.lastAutoWarning, null); assert.equal(state.lastAutoError, null); });
  assert.ok((await fs.readdir(sessionDir)).filter((n) => n.includes('.corrupt-')).length === 1, 'only the deliberately broken log was repaired');
  const deepRoot = `${t.dsh}/deep-synthetic`;
  await fs.mkdir(`${deepRoot}/${Array(9).fill('d').join('/')}`, { recursive: true });
  const partialScan = await panel.doctorScan();
  const partialBackup = await panel.backup(1);
  check('directory scan limits remain explicit and preserve retention safety', () => {
    assert.equal(partialScan.incomplete, true); assert.equal(partialBackup.archiveStatus, 'unverified');
    assert.equal(partialBackup.retentionPaused, true); assert.equal(partialBackup.validation.scanIncomplete, true);
  });
  await fs.rm(deepRoot, { recursive: true });
  console.log(`PASS ${checks} Doctor/backup regressions (${process.version}; zstd=${hasZstd})`);
} finally { await rmTemp(t.dir); }
