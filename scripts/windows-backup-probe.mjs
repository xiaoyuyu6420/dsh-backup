/** #138: synthetic Windows comparison of real host subprocess and Node spawn. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createBackupArchive } from '../lib/backup-tar.js';
import { tarLiteralPattern } from '../lib/paths.js';

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
// Match the report's ASCII home path. Native Windows bsdtar cannot safely
// receive Unicode argv; the recovery unit tests require that case to fail closed.
const home = path.join(root, 'user home');
const source = path.join(home, '.dsh');
const destination = path.join(root, 'DSH Backups');
await fs.mkdir(source, { recursive: true });
await fs.mkdir(destination, { recursive: true });
const ctx = new Context();
const runtime = new LocalSubprocessRuntime(ctx);
const quick = process.argv.includes('--quick');
const report = { platform: process.platform, os: os.release(), node: process.version, quick, mode: runtime.selectContainmentMode('ordinary'), results: [] };
assert.equal(report.mode, 'windows-job', 'The host must exercise its native Job runner, not silently fall back');
const output = process.env.BACKUP_PROBE_REPORT || `${root}-report.json`;
async function saveReport() { await fs.writeFile(output, JSON.stringify(report, null, 2)); }
function tailBuffer(previous, chunk) { return Buffer.concat([previous, chunk]).subarray(-8192); }
async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function run(label, executable, transport, stdioMode = 'collect') {
  const archive = path.join(destination, 'probe.tar.gz');
  const argv = [executable, '--exclude=*node_modules*', '--exclude=.system', '--exclude=.dsh/.env', '--exclude=*/.credentials.yaml', `--exclude=${tarLiteralPattern('.dsh/back[ups]')}`, '-czf', 'probe.tar.gz', '-C', home.replaceAll('\\', '/') + '/', '.dsh'];
  const started = Date.now();
  const version = spawnSync(executable, ['--version'], { encoding: 'utf8', timeout: 10000 });
  const result = { label, transport, executable, stdioMode, version: version.stdout?.trim() || version.error?.message || version.stderr?.trim() };
  let peakBytes = 0;
  const timer = setInterval(() => { fs.stat(archive).then(s => { peakBytes = Math.max(peakBytes, s.size); }, () => {}); }, 500);
  try {
    if (transport === 'injected-recovery') {
      let injected = false;
      const subprocess = {
        resolveExecutable: runtime.resolveExecutable.bind(runtime),
        spawn(spec) {
          if (!injected) {
            injected = true;
            // Exercise a real Windows exit status and managed range, while
            // clearly labelling this as fault injection, not crash reproduction.
            return runtime.spawn({ ...spec, argv: [process.execPath, '-e', "require('node:fs').writeFileSync('probe.tar.gz', 'partial');process.exit(0xC0000005)"] });
          }
          return runtime.spawn(spec);
        },
      };
      result.recovery = await createBackupArchive({ subprocess, argv, cwd: destination, archive });
      assert.equal(result.recovery.retried, true);
      assert.equal(result.recovery.executable.toLowerCase(), bsdTar.toLowerCase());
      result.outcome = { exitCode: 0, signal: null };
    } else if (transport === 'host') {
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
      assert.ok(result.bytes > (quick ? 1024 ** 2 : 2 * 1024 ** 3), 'Archive must exceed the fixture size boundary');
      // Native bsdtar's console output can replace Unicode with '?'. GNU tar
      // supplies a UTF-8 listing; native tar is still used for actual extraction.
      const listed = spawnSync(gnuTar, ['--quoting-style=literal', '-tzf', 'probe.tar.gz'], { cwd: destination, encoding: 'utf8', maxBuffer: 32 * 1024 ** 2, timeout: 180000 });
      assert.equal(listed.status, 0, listed.stderr);
      const names = listed.stdout.trim().split(/\r?\n/);
      result.entries = names.length;
      assert.ok(result.entries >= (quick ? 12 : 54000));
      result.unexpectedExcludedNames = names.filter(n => /node_modules|\.env$|\.credentials\.yaml$|back\[ups\]/.test(n));
      assert.deepEqual(result.unexpectedExcludedNames, [], 'Preserve backup exclusions with either tar');
      assert.ok(names.includes('.dsh/unicode/中文 文件.txt'), 'Preserve Unicode and spaces');
      const restored = path.join(root, 'restore');
      await fs.mkdir(restored, { recursive: true });
      const extracted = spawnSync(bsdTar, ['-xzf', archive, '-C', restored, '.dsh/sessions/large.bin', '.dsh/unicode'], { encoding: 'utf8', timeout: 180000 });
      assert.equal(extracted.status, 0, extracted.stderr);
      assert.equal(await sha256(path.join(restored, '.dsh/sessions/large.bin')), await sha256(path.join(source, 'sessions/large.bin')));
      assert.equal(await fs.readFile(path.join(restored, '.dsh/unicode/中文 文件.txt'), 'utf8'), 'Unicode fixture');
      result.restoredHashVerified = true;
      await fs.rm(restored, { recursive: true, force: true });
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
    try { for (let i = 0; i < (quick ? 1 : mib); i++) await file.writeFile(block); } finally { await file.close(); }
  }
  for (let dir = 0; dir < (quick ? 3 : 54); dir++) {
    const target = path.join(source, 'small', String(dir));
    await fs.mkdir(target, { recursive: true });
    for (let file = 0; file < (quick ? 4 : 1000); file++) await fs.writeFile(path.join(target, `${file}.txt`), 'synthetic test data\n');
  }
  await fs.mkdir(path.join(source, 'unicode'));
  await fs.writeFile(path.join(source, 'unicode/中文 文件.txt'), 'Unicode fixture');
  await fs.writeFile(path.join(source, '.env'), 'synthetic secret');
  await fs.writeFile(path.join(source, '.credentials.yaml'), 'synthetic secret');
  for (const dir of ['node_modules', 'nested/node_modules', 'back[ups]']) {
    await fs.mkdir(path.join(source, dir), { recursive: true });
    await fs.writeFile(path.join(source, dir, 'excluded.txt'), 'excluded fixture');
  }
  report.sourceMiB = quick ? 6 : 3308;
  console.log(JSON.stringify({ fixtureReady: true, ...report }));
  await run('GNU tar / host collect (baseline)', gnuTar, 'host');
  await run('GNU tar / host pipe', gnuTar, 'host', 'pipe');
  await run('GNU tar / Node spawn', gnuTar, 'node');
  await run('System32 bsdtar / host collect', bsdTar, 'host');
  await run('Plugin recovery / injected access violation / native host tar', gnuTar, 'injected-recovery');
} finally {
  await runtime.disposeManagedProcesses();
  await saveReport();
  await fs.rm(root, { recursive: true, force: true });
}
assert.ok(report.results.some(r => r.outcome?.exitCode === 0 && !r.error), 'No comparison produced a valid large archive');
assert.ok(report.results.some(r => r.transport === 'injected-recovery' && r.outcome?.exitCode === 0 && !r.error), 'Plugin recovery must produce a valid large archive');
