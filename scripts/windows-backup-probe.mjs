/** #138: synthetic Windows comparison of real host subprocess and Node spawn. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

assert.equal(process.platform, 'win32', 'Run this probe on real Windows');
const dependencyRoot = process.env.BACKUP_PROBE_DEPS;
assert.ok(dependencyRoot, 'BACKUP_PROBE_DEPS must name the isolated npm prefix');
const require = createRequire(path.join(dependencyRoot, 'package.json'));
const { Context } = await import(pathToFileURL(require.resolve('@deepseek-ai/cordis')).href);
const { LocalSubprocessRuntime } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-subprocess-local')).href);
const { scrubbedParentEnv } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-subprocess')).href);
const msys = path.join(dependencyRoot, 'node_modules', '@dsh-ops', 'bash-win32-x64', 'usr', 'bin');
const gnuTar = path.join(msys, 'tar.exe');
const bsdTar = path.join(process.env.SystemRoot, 'System32', 'tar.exe');
process.env.PATH = `${msys}${path.delimiter}${process.env.PATH}`;
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'backup-138-'));
const home = path.join(root, '用户 home');
const source = path.join(home, '.dsh');
const destination = path.join(root, 'DSH Backups');
await fs.mkdir(source, { recursive: true });
await fs.mkdir(destination, { recursive: true });
const ctx = new Context();
const runtime = new LocalSubprocessRuntime(ctx);
const report = { platform: process.platform, os: os.release(), node: process.version, mode: runtime.selectContainmentMode('ordinary'), results: [] };
assert.equal(report.mode, 'windows-job', 'The host must exercise its native Job runner, not silently fall back');
const output = process.env.BACKUP_PROBE_REPORT || path.join(root, 'report.json');
async function saveReport() { await fs.writeFile(output, JSON.stringify(report, null, 2)); }
function tailBuffer(previous, chunk) { return Buffer.concat([previous, chunk]).subarray(-8192); }

async function run(label, executable, transport, stdioMode = 'collect') {
  const archive = path.join(destination, 'probe.tar.gz');
  const argv = [executable, '--exclude=*node_modules*', '--exclude=.system', '-czf', 'probe.tar.gz', '-C', home.replaceAll('\\', '/') + '/', '.dsh'];
  const started = Date.now();
  const result = { label, transport, executable, stdioMode, version: spawnSync(executable, ['--version'], { encoding: 'utf8' }).stdout.trim() };
  let peakBytes = 0;
  const timer = setInterval(() => { fs.stat(archive).then(s => { peakBytes = Math.max(peakBytes, s.size); }, () => {}); }, 500);
  try {
    if (transport === 'host') {
      const collected = { maxBytes: 8192, spill: { maxBytes: 1 << 20 } };
      const child = runtime.spawn({ argv, cwd: destination, graceMs: 5000, stdio: { stdin: 'ignore', stdout: stdioMode === 'pipe' ? 'pipe' : collected, stderr: stdioMode === 'pipe' ? 'pipe' : collected } });
      let out = Buffer.alloc(0); let err = Buffer.alloc(0);
      child.stdout?.on('data', c => { out = tailBuffer(out, c); });
      child.stderr?.on('data', c => { err = tailBuffer(err, c); });
      result.outcome = await child.done;
      await child.waitForExit();
      result.stderr = child.collected?.stderr?.readFrom(0)?.text ?? err.toString();
      result.stdout = child.collected?.stdout?.readFrom(0)?.text ?? out.toString();
    } else {
      result.outcome = await new Promise((resolve, reject) => {
        const child = spawn(executable, argv.slice(1), { cwd: destination, env: scrubbedParentEnv(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        let out = Buffer.alloc(0); let err = Buffer.alloc(0);
        child.stdout.on('data', c => { out = tailBuffer(out, c); });
        child.stderr.on('data', c => { err = tailBuffer(err, c); });
        child.once('error', reject);
        child.once('close', (exitCode, signal) => { result.stdout = out.toString(); result.stderr = err.toString(); resolve({ exitCode, signal }); });
      });
    }
    result.bytes = await fs.stat(archive).then(s => s.size, () => 0);
    if (result.outcome.exitCode === 0) {
      assert.ok(result.bytes > 2 * 1024 ** 3, 'Archive must exceed the reported 244 MB failure and 2 GiB boundaries');
      const listed = spawnSync(bsdTar, ['-tzf', archive], { encoding: 'utf8', maxBuffer: 32 * 1024 ** 2, timeout: 180000 });
      assert.equal(listed.status, 0, listed.stderr);
      result.entries = listed.stdout.trim().split('\n').length;
      assert.ok(result.entries >= 54000);
    }
  } catch (error) { result.error = error.stack; }
  finally {
    clearInterval(timer);
    result.peakBytes = peakBytes;
    result.durationMs = Date.now() - started;
    report.results.push(result);
    console.log(JSON.stringify(result));
    await saveReport();
    await fs.rm(archive, { force: true });
  }
}

try {
  // Random blocks remain incompressible even when reused beyond gzip's window.
  const block = randomBytes(1024 ** 2);
  for (const [name, mib] of [['attachments', 999], ['dsh-ops', 822], ['change-ledger', 681], ['browser', 358], ['electron', 348], ['sessions', 100]]) {
    const dir = path.join(source, name);
    await fs.mkdir(dir, { recursive: true });
    const file = await fs.open(path.join(dir, 'large.bin'), 'w');
    try { for (let i = 0; i < mib; i++) await file.writeFile(block); } finally { await file.close(); }
  }
  for (let dir = 0; dir < 54; dir++) {
    const target = path.join(source, 'small', String(dir));
    await fs.mkdir(target, { recursive: true });
    for (let file = 0; file < 1000; file++) await fs.writeFile(path.join(target, `${file}.txt`), 'synthetic test data\n');
  }
  report.sourceMiB = 3308;
  console.log(JSON.stringify({ fixtureReady: true, ...report }));
  await run('GNU tar / host collect (baseline)', gnuTar, 'host');
  await run('GNU tar / host pipe', gnuTar, 'host', 'pipe');
  await run('GNU tar / Node spawn', gnuTar, 'node');
  await run('System32 bsdtar / host collect', bsdTar, 'host');
} finally {
  await runtime.disposeManagedProcesses();
  await saveReport();
  await fs.rm(root, { recursive: true, force: true });
}
assert.ok(report.results.some(r => r.outcome?.exitCode === 0 && !r.error), 'No comparison produced a valid large archive');
