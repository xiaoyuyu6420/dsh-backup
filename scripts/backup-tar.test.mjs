import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createBackupArchive } from '../lib/backup-tar.js';

const GNU = 'C:\\DSH host\\usr\\bin\\tar.exe';
const runner = fileURLToPath(new URL('../lib/backup-tar-runner.js', import.meta.url));
const AV = 0xc0000005;

async function fixture(t, outcomes, overrides = {}) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'backup-tar-'));
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  const archive = path.join(cwd, 'backup.tar.gz');
  const calls = [];
  const subprocess = {
    spawn(spec) {
      const index = calls.length;
      const outcome = outcomes[index];
      assert.ok(outcome, 'Unexpected extra attempt');
      const call = { spec, terminated: false, settled: false };
      calls.push(call);
      return {
        done: (async () => {
          if (index) {
            assert.equal(calls[index - 1].settled, true, 'First process range must exit before retry');
            assert.equal(await fs.stat(archive).then(() => true, () => false), false, 'Remove partial archive before retry');
          }
          await fs.writeFile(archive, outcome.exitCode === 0 ? 'complete' : 'partial');
          await overrides.onDone?.(index);
          return { signal: null, ...outcome };
        })(),
        terminate() { call.terminated = true; },
        async waitForExit() {
          if (outcome.exitCode !== 0 || outcome.signal) assert.equal(call.terminated, true);
          call.settled = true;
        },
        collected: {
          stdout: { readFrom: () => ({ text: '' }) },
          stderr: { readFrom: () => ({ text: outcome.stderr || '' }) },
        },
      };
    },
  };
  const argv = [GNU, '--exclude=*node_modules*', '--exclude=.system', '--exclude=.dsh/.env', '--exclude=.dsh/back[[]ups[]]*', '-czf', 'backup.tar.gz', '-C', 'C:/用户 home/', '.dsh'];
  const options = { subprocess, argv, cwd, archive, platform: 'win32', ...overrides };
  return { options, calls, archive, subprocess };
}

test('normal backup keeps the selected tar and host collection contract', async t => {
  const f = await fixture(t, [{ exitCode: 0 }]);
  assert.deepEqual(await createBackupArchive(f.options), { executable: GNU, retried: false });
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].settled, true);
  assert.equal(f.calls[0].terminated, false);
  assert.deepEqual(f.calls[0].spec.stdio, { stdin: 'ignore', stdout: { maxBytes: 8192, spill: { maxBytes: 1 << 20 } }, stderr: { maxBytes: 8192, spill: { maxBytes: 1 << 20 } } });
});

for (const exitCode of [AV, AV - 2 ** 32]) {
  test(`Windows access violation ${exitCode} retries the same tar via Node once after quiescence`, async t => {
    const controller = new AbortController();
    const f = await fixture(t, [{ exitCode }, { exitCode: 0 }], { signal: controller.signal });
    assert.deepEqual(await createBackupArchive(f.options), { executable: GNU, retried: true });
    assert.equal(f.calls.length, 2);
    assert.equal(f.calls[0].terminated, true);
    assert.deepEqual(f.calls[1].spec, { ...f.calls[0].spec, argv: [process.execPath, runner, ...f.options.argv] });
    assert.equal(await fs.readFile(f.archive, 'utf8'), 'complete');
  });
}

for (const outcome of [{ exitCode: 1 }, { exitCode: 2 }, { exitCode: null, signal: 'SIGTERM' }, { exitCode: 0xc0000017 }]) {
  test(`other failures do not retry: ${JSON.stringify(outcome)}`, async t => {
    const f = await fixture(t, [outcome]);
    await assert.rejects(createBackupArchive(f.options), /tar 归档失败/);
    assert.equal(f.calls.length, 1);
  });
}

for (const platform of ['linux', 'darwin']) {
  test(`${platform} does not interpret exit codes as Windows exceptions`, async t => {
    const f = await fixture(t, [{ exitCode: AV }], { platform });
    await assert.rejects(createBackupArchive(f.options), /exit=3221225477/);
  });
}

test('pre-cancelled backup never spawns or resolves another executable', async t => {
  const f = await fixture(t, [], { signal: AbortSignal.abort() });
  await assert.rejects(createBackupArchive(f.options), /操作已取消/);
  assert.equal(f.calls.length, 0);
});

test('cancellation at failed process completion takes precedence over recovery', async t => {
  const controller = new AbortController();
  const f = await fixture(t, [{ exitCode: AV }], { signal: controller.signal, onDone: () => controller.abort() });
  await assert.rejects(createBackupArchive(f.options), /操作已取消/);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].settled, true);
});

test('retry failure preserves both errors and never tries a third time', async t => {
  const f = await fixture(t, [{ exitCode: AV }, { exitCode: 2, stderr: 'No space left on device' }]);
  await assert.rejects(createBackupArchive(f.options), error => {
    assert.match(error.message, /0xC0000005/);
    assert.match(error.message, /Node 启动器重试失败/);
    assert.match(error.message, /No space left on device/);
    return true;
  });
  assert.equal(f.calls.length, 2);
});

test('failure to clean the partial archive prevents a second writer', async t => {
  const f = await fixture(t, [{ exitCode: AV }], { onDone: async () => {
    await fs.rm(f.archive);
    await fs.mkdir(f.archive);
  } });
  await assert.rejects(createBackupArchive(f.options), /EISDIR|EPERM/);
  assert.equal(f.calls.length, 1);
});

test('host launch rejection is not mistaken for the child access violation', async t => {
  const f = await fixture(t, []);
  f.subprocess.spawn = () => { throw new Error('host launch failed'); };
  await assert.rejects(createBackupArchive(f.options), /host launch failed/);
});

test('a process range that fails to settle cannot trigger a second writer', async t => {
  const f = await fixture(t, [{ exitCode: AV }]);
  const spawn = f.subprocess.spawn;
  f.subprocess.spawn = spec => ({ ...spawn(spec), waitForExit: async () => { throw new Error('range cleanup failed'); } });
  await assert.rejects(createBackupArchive(f.options), /range cleanup failed/);
  assert.equal(f.calls.length, 1);
});

test('cancellation during Node recovery never reports success', async t => {
  const controller = new AbortController();
  const f = await fixture(t, [{ exitCode: AV }, { exitCode: 0 }], {
    signal: controller.signal,
    onDone: index => { if (index === 1) controller.abort(); },
  });
  await assert.rejects(createBackupArchive(f.options), /操作已取消/);
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1].terminated, true);
  assert.equal(f.calls[1].settled, true);
});


test('the real Node runner preserves cwd, Unicode argv, environment and exit status', async t => {
  const f = await fixture(t, []);
  const values = ['用户 home', '--exclude=.dsh/密钥.yaml', 'a"b', '$literal'];
  const script = 'console.log(JSON.stringify({cwd:process.cwd(),args:process.argv.slice(1),env:process.env.BACKUP_TEST_VALUE}));process.exitCode=7';
  const result = spawnSync(process.execPath, [runner, process.execPath, '-e', script, ...values], {
    cwd: f.options.cwd, env: { ...process.env, BACKUP_TEST_VALUE: 'synthetic' }, encoding: 'utf8', timeout: 10000,
  });
  assert.equal(result.status, 7, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { cwd: f.options.cwd, args: values, env: 'synthetic' });
});

test('the real Node runner reports launch failure without claiming success', () => {
  const result = spawnSync(process.execPath, [runner, 'nonexistent-backup-tar-138'], { encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /tar 启动失败/);
});
