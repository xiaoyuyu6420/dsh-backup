/** Security and recovery regressions from the 0.14.2 review. All data is synthetic. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installSmokeStubs, makeCtx, mkTmpHome, makeTarGz, tarList, rmTemp } from './smoke.mjs';
import { acquireLock, releaseLock, heartbeatLock } from '../lib/oplock.js';
import { buildZip, readZipEntry } from '../lib/zip.js';
import { hostInstallation } from './host-installation.mjs';

await installSmokeStubs();
const { apply } = await import('../lib/index.js');
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
let passed = 0;
let failed = 0;
let fixtures = [];
const exists = (p) => fs.stat(p).then(() => true, () => false);

async function setup(config = {}, extra = {}) {
  const t = await mkTmpHome(); fixtures.push(t.dir);
  await fs.writeFile(`${t.dsh}/.credentials.yaml`, 'version: 1\nkey: synthetic-secret\n');
  const cfg = typeof config === 'function' ? config(t) : config;
  if (cfg.destination) t.root = cfg.destination.replace(/^~/, t.home);
  const mock = makeCtx({ ...t, ...extra });
  apply(mock.ctx, cfg);
  // Wait for the asynchronous boot state load, but do not fire scheduled backup work.
  await new Promise((r) => setTimeout(r, 40));
  return { ...t, mock, panel: mock.services.find((s) => s.name === 'backupPanel') };
}

async function test(name, fn) {
  fixtures = [];
  try { await fn(); passed++; console.log(`PASS ${name}`); }
  catch (err) { failed++; console.error(`FAIL ${name}\n${err.stack}`); }
  finally { for (const dir of fixtures) await rmTemp(dir); }
}

async function archive(t, entries, name = 'dsh-t-20990101-010101001.tar.gz') {
  await fs.mkdir(t.root, { recursive: true });
  const bytes = makeTarGz(entries);
  await fs.writeFile(`${t.root}/${name}`, bytes);
  await fs.writeFile(`${t.root}/${name}.sha256`, `${createHash('sha256').update(bytes).digest('hex')}\n`);
  return name;
}

const packageTar = (name = 'review-demo', extra = []) => makeTarGz([
  { name: 'package/package.json', type: 'file', content: JSON.stringify({ name, version: '1.0.0', main: 'index.js' }) },
  { name: 'package/index.js', type: 'file', content: 'module.exports = 42;\n' },
  ...extra,
]);

async function bundle(t, { plugin = {}, tar = packageTar(), entries = [] } = {}) {
  await fs.mkdir(t.root, { recursive: true });
  const sourcePath = `${t.root}/test.zip`;
  const p = { name: 'review-demo', profile: 'web', status: 'packed', tarball: 'demo.tgz', ...plugin };
  await buildZip(sourcePath, [
    { name: 'manifest.json', data: Buffer.from(JSON.stringify({ format: 'dsh-config-export', version: 1, localPlugins: [p] })) },
    { name: 'settings.yaml', data: Buffer.from('theme: imported\n') },
    { name: 'profiles/web/package.json', data: Buffer.from(JSON.stringify({ dependencies: { 'review-demo': 'link:/old/machine/plugin' } })) },
    { name: 'local-plugins/demo.tgz', data: tar },
    ...entries,
  ]);
  return sourcePath;
}

await test('host decoders and CLI resolve from the selected npm or pnpm installation', async () => {
  const t = await mkTmpHome(); fixtures.push(t.dir);
  for (const layout of ['npm-global', 'pnpm']) {
    const root = `${t.dir}/${layout}/node_modules/@deepseek-ai/dsh`;
    const base = layout === 'pnpm' ? `${t.dir}/${layout}/store/base` : `${path.dirname(root)}/dsh-base`;
    const modules = layout === 'pnpm' ? `${base}/node_modules/@deepseek-ai` : path.dirname(root);
    for (const dir of [root, base, `${modules}/dsh-session`, `${modules}/dsh-session-format-catalog`]) {
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(`${dir}/package.json`, JSON.stringify({ name: dir === root ? '@deepseek-ai/dsh' : path.basename(dir), main: 'index.js', version: layout, bin: { dsh: 'bin.js' } }));
      await fs.writeFile(`${dir}/index.js`, '');
    }
    if (layout === 'pnpm') {
      await fs.mkdir(`${root}/node_modules/@deepseek-ai`, { recursive: true });
      await fs.symlink(base, `${root}/node_modules/@deepseek-ai/dsh-base`, 'dir');
    }
    const resolved = hostInstallation(root);
    assert.equal(resolved.version, layout);
    assert.equal(resolved.cli, `${root}/bin.js`);
    assert.equal(resolved.session, `${modules}/dsh-session/index.js`);
    assert.equal(resolved.catalog, `${modules}/dsh-session-format-catalog/index.js`);
  }
});

await test('nested backup roots stay out of full, typed, encrypted archives and ZIP exports', async () => {
  // Literal glob characters must not broaden the exclusion to neighbouring data.
  const t = await setup((t) => ({ destination: `${t.dsh}/skills/back[ups]*?` }));
  await fs.mkdir(t.root, { recursive: true });
  await fs.writeFile(`${t.root}/old-backup.tar.gz`, 'previous archive');
  await fs.mkdir(`${t.root}/vault/preserved`, { recursive: true });
  await fs.writeFile(`${t.root}/vault/preserved/private.txt`, 'synthetic private data');
  await fs.mkdir(`${t.dsh}/skills/backuZZ`, { recursive: true });
  await fs.writeFile(`${t.dsh}/skills/backuZZ/keep.txt`, 'keep me');
  for (const options of [{}, { types: ['skills'] }, { password: 'synthetic-pass' }]) {
    const result = await t.panel.backup(undefined, options.types, options.password);
    assert.equal(result.ok, true, result.summary);
    if (options.password) {
      const { decryptFile } = await import('../lib/encrypt.js');
      const meta = JSON.parse(await fs.readFile(`${result.path}.encrypted.json`, 'utf8'));
      await decryptFile(result.path, `${t.dir}/plain.tar.gz`, meta, options.password);
      const names = await tarList(t.dir, 'plain.tar.gz');
      assert.equal(names.some((n) => n.includes('back[ups]*?')), false);
    } else {
      const names = await tarList(t.root, path.basename(result.path));
      assert.equal(names.some((n) => n.includes('back[ups]*?')), false);
      assert.ok(names.includes('.dsh/skills/backuZZ/keep.txt'));
    }
  }
  const exp = await t.panel.exportConfig({});
  assert.equal(exp.ok, true, exp.summary);
  await assert.rejects(readZipEntry(exp.path, 'skills/back[ups]*?/vault/preserved/private.txt'), /没有条目/);
  assert.equal((await readZipEntry(exp.path, 'skills/backuZZ/keep.txt')).toString(), 'keep me');
});

await test('symlink aliases cannot hide a nested destination from archive exclusion', async () => {
  const t = await setup((t) => ({ destination: `${t.home}/backup-alias` }));
  await fs.mkdir(`${t.dsh}/nested-backups`, { recursive: true });
  // setup may have created root while loading automatic state.
  await fs.rm(t.root, { recursive: true, force: true });
  await fs.symlink(`${t.dsh}/nested-backups`, t.root, 'dir');
  await fs.writeFile(`${t.root}/private.txt`, 'synthetic private data');
  const b = await t.panel.backup();
  assert.equal(b.ok, true, b.summary);
  assert.equal((await tarList(t.root, path.basename(b.path))).some((n) => n.includes('nested-backups')), false);
  const e = await t.panel.exportConfig({});
  assert.equal(e.ok, true, e.summary);
  await assert.rejects(readZipEntry(e.path, 'nested-backups/private.txt'), /没有条目/);
});

await test('a destination equal to DSH_HOME fails instead of creating an empty backup', async () => {
  const t = await setup((t) => ({ destination: t.dsh }));
  await assert.rejects(t.panel.backup(), /不能等于 DSH_HOME/);
  const result = await t.panel.exportConfig({});
  assert.equal(result.ok, false);
  assert.match(result.summary, /不能等于 DSH_HOME/);
});

await test('a tar crash removes the partial backup without publishing sidecars or rotating good backups', async () => {
  const t = await setup();
  const previous = await t.panel.backup();
  assert.equal(previous.ok, true, previous.summary);
  const original = await fs.readFile(previous.path);
  const spawn = t.mock.ctx.subprocess.spawn;
  t.mock.ctx.subprocess.spawn = (spec) => {
    const create = spec.argv.indexOf('-czf');
    if (create < 0) return spawn(spec);
    return {
      done: fs.writeFile(path.join(spec.cwd, spec.argv[create + 1]), 'partial').then(() => ({ exitCode: 0xc0000005, signal: null })),
      terminate() {},
      waitForExit: async () => {},
      collected: { stderr: { readFrom: () => ({ text: '' }) } },
    };
  };
  await assert.rejects(t.panel.backup(1), /3221225477/);
  const archives = (await fs.readdir(t.root)).filter(n => /^dsh-.*\.tar\.gz(?:\.|$)/.test(n));
  assert.ok(archives.length > 0);
  assert.ok(archives.every(n => n.startsWith(path.basename(previous.path))));
  assert.deepEqual(await fs.readFile(previous.path), original);
});

await test('host and standalone rescue reject destructive replacement with an internal backup root', async () => {
  const t = await setup((t) => ({ destination: `${t.dsh}/backups` }));
  const b = await t.panel.backup();
  assert.equal(b.ok, true, b.summary);
  const selector = path.basename(b.path);
  assert.equal((await t.panel.restore(selector, true)).ok, true);
  const r = await t.panel.restore(selector, false);
  assert.equal(r.ok, false);
  assert.match(r.summary, /移到 DSH_HOME 外/);
  const rescue = spawnSync(process.execPath, [`${repo}/rescue/rescue.mjs`, 'restore', selector, '--yes', '--root', t.root], { encoding: 'utf8', env: { ...process.env, DSH_HOME: t.dsh } });
  assert.notEqual(rescue.status, 0);
  assert.match(rescue.stderr + rescue.stdout, /移到 DSH_HOME 外/);
  assert.equal(await exists(b.path), true);
  assert.equal(await fs.readFile(`${t.dsh}/.credentials.yaml`, 'utf8'), 'version: 1\nkey: synthetic-secret\n');
  assert.equal((await fs.readdir(t.home)).some((n) => n.includes('.pre-restore-')), false);
});

await test('untrusted plugin metadata is rejected before preview/apply writes', async () => {
  const t = await setup();
  const marker = `${t.home}/outside/marker.txt`;
  await fs.mkdir(path.dirname(marker), { recursive: true });
  await fs.writeFile(marker, 'original');
  for (const plugin of [
    { name: '../../outside' }, { name: '..' }, { name: 'C:\\outside' },
    { profile: '../../outside' }, { profile: '..' }, { profile: 'web.' },
    { name: 'NUL' }, { tarball: '../../payload.tgz' },
  ]) {
    const sourcePath = await bundle(t, { plugin });
    assert.equal((await t.panel.importPreview({ sourcePath })).ok, false);
    assert.equal((await t.panel.importApply({ sourcePath, sections: ['settings'] })).ok, false);
    assert.equal(await fs.readFile(marker, 'utf8'), 'original');
    assert.equal(await exists(`${t.dsh}/settings.yaml`), false);
  }
});

await test('settings-only import never extracts or installs plugin contents', async () => {
  const t = await setup();
  const sourcePath = await bundle(t);
  const r = await t.panel.importApply({ sourcePath, sections: ['settings'] });
  assert.equal(r.ok, true, r.summary);
  assert.equal(r.applied, 1);
  assert.equal(await exists(`${t.dsh}/local-plugins`), false);
  assert.equal(await exists(`${t.dsh}/profiles`), false);
});

await test('keeping an existing profile also prevents hidden dependency rewrites', async () => {
  const t = await setup();
  await fs.mkdir(`${t.dsh}/profiles/web`, { recursive: true });
  const original = JSON.stringify({ dependencies: { 'review-demo': 'link:/keep/my/plugin' } });
  await fs.writeFile(`${t.dsh}/profiles/web/package.json`, original);
  const r = await t.panel.importApply({ sourcePath: await bundle(t), sections: ['plugins'] });
  assert.equal(r.ok, true, r.summary);
  assert.deepEqual(r.pluginsRestored.restored, []);
  assert.equal(await fs.readFile(`${t.dsh}/profiles/web/package.json`, 'utf8'), original);
});

await test('nested tar traversal and links cannot escape, and late failure rolls back', async () => {
  const t = await setup();
  await fs.writeFile(`${t.dsh}/settings.yaml`, 'theme: current\n');
  for (const bad of [
    { name: 'package/../../escape.txt', type: 'file', content: 'escaped' },
    { name: 'package/link', type: 'symlink', linkName: `${t.home}/outside` },
    { name: 'elsewhere/escape.txt', type: 'file', content: 'escaped' },
  ]) {
    const r = await t.panel.importApply({ sourcePath: await bundle(t, { tar: packageTar('review-demo', [bad]) }), decisions: { 'settings.yaml': 'overwrite' } });
    assert.equal(r.ok, false);
    assert.equal(await fs.readFile(`${t.dsh}/settings.yaml`, 'utf8'), 'theme: current\n');
    assert.equal(await exists(`${t.dsh}/profiles/web/package.json`), false);
    assert.equal(await exists(`${t.home}/escape.txt`), false);
  }
});

await test('existing target symlinks are rejected before ZIP import', async () => {
  if (process.platform === 'win32') { console.log('  symlink fixture skipped on Windows without developer-mode privileges'); return; }
  const t = await setup();
  await fs.mkdir(`${t.home}/outside`, { recursive: true });
  await fs.symlink(`${t.home}/outside`, `${t.dsh}/skills`);
  const sourcePath = await bundle(t, { entries: [{ name: 'skills/escape.txt', data: Buffer.from('escape') }] });
  const r = await t.panel.importApply({ sourcePath, sections: ['skills'] });
  assert.equal(r.ok, false);
  assert.equal(await exists(`${t.home}/outside/escape.txt`), false);
});

await test('local plugin export/import roundtrip produces a usable file: package root', async () => {
  const t = await setup();
  const local = `${t.home}/local-demo`;
  await fs.mkdir(local, { recursive: true });
  await fs.writeFile(`${local}/package.json`, JSON.stringify({ name: 'review-demo', version: '1.0.0' }));
  await fs.writeFile(`${local}/index.js`, 'module.exports = 42;\n');
  await fs.mkdir(`${t.dsh}/profiles/web`, { recursive: true });
  await fs.writeFile(`${t.dsh}/profiles/web/package.json`, JSON.stringify({ dependencies: { 'review-demo': `link:${local}` } }));
  // Real local npm pack (no dependencies or lifecycle scripts), with an isolated
  // writable cache. ZIP/tar serialization and dependency rewriting are real too.
  const previousCache = process.env.npm_config_cache;
  process.env.npm_config_cache = `${t.dir}/npm-cache`;
  let exp;
  try { exp = await t.panel.exportConfig({}); }
  finally {
    if (previousCache === undefined) delete process.env.npm_config_cache;
    else process.env.npm_config_cache = previousCache;
  }
  assert.equal(exp.ok, true, exp.summary);
  assert.equal(exp.manifest.localPlugins[0].status, 'packed');
  const fresh = await setup();
  const r = await fresh.panel.importApply({ sourcePath: exp.path });
  assert.equal(r.ok, true, r.summary);
  assert.equal(r.pluginsRestored.restored.length, 1);
  const pkg = JSON.parse(await fs.readFile(`${fresh.dsh}/profiles/web/package.json`, 'utf8'));
  const root = pkg.dependencies['review-demo'].slice('file:'.length);
  assert.ok(root.startsWith(`${fresh.dsh}/local-plugins/`));
  assert.equal(JSON.parse(await fs.readFile(`${root}/package.json`, 'utf8')).name, 'review-demo');
  assert.equal(await fs.readFile(`${root}/index.js`, 'utf8'), 'module.exports = 42;\n');
});

await test('legacy tarballName spelling remains readable', async () => {
  const t = await setup();
  const sourcePath = await bundle(t, { plugin: { tarball: undefined, tarballName: 'demo.tgz' } });
  const r = await t.panel.importApply({ sourcePath });
  assert.equal(r.ok, true, r.summary);
  assert.equal(r.pluginsRestored.restored.length, 1);
});

await test('plugin installation works with a backup destination on another filesystem', async () => {
  const destination = await fs.mkdtemp(path.join(repo, '.review-destination-'));
  fixtures.push(destination);
  const t = await setup({ destination });
  const separate = (await fs.stat(destination)).dev !== (await fs.stat(t.dsh)).dev;
  console.log(`  fixture uses ${separate ? 'separate filesystems' : 'one filesystem (cross-device coverage unavailable)'}`);
  const r = await t.panel.importApply({ sourcePath: await bundle(t) });
  assert.equal(r.ok, true, r.summary);
  const pkg = JSON.parse(await fs.readFile(`${t.dsh}/profiles/web/package.json`, 'utf8'));
  assert.equal(JSON.parse(await fs.readFile(`${pkg.dependencies['review-demo'].slice(5)}/package.json`, 'utf8')).name, 'review-demo');
});

await test('a second plugin failure removes the first installation and restores all selected files', async () => {
  const t = await setup();
  await fs.mkdir(`${t.dsh}/profiles/web`, { recursive: true });
  const original = JSON.stringify({ dependencies: { 'review-demo': 'file:/current' } });
  await fs.writeFile(`${t.dsh}/profiles/web/package.json`, original);
  await fs.mkdir(t.root, { recursive: true });
  const sourcePath = `${t.root}/two-plugins.zip`;
  await buildZip(sourcePath, [
    { name: 'manifest.json', data: Buffer.from(JSON.stringify({ format: 'dsh-config-export', version: 1, localPlugins: ['review-demo', 'second'].map((name) => ({ name, profile: 'web', status: 'packed', tarball: `${name}.tgz` })) })) },
    { name: 'profiles/web/package.json', data: Buffer.from(JSON.stringify({ dependencies: { 'review-demo': 'file:/old', second: 'file:/old' } })) },
    { name: 'local-plugins/review-demo.tgz', data: packageTar() },
    { name: 'local-plugins/second.tgz', data: packageTar('second', [{ name: 'package/../../escape', type: 'file', content: 'bad' }]) },
  ]);
  const r = await t.panel.importApply({ sourcePath, decisions: { 'profiles/web/package.json': 'overwrite' } });
  assert.equal(r.ok, false);
  assert.equal(await fs.readFile(`${t.dsh}/profiles/web/package.json`, 'utf8'), original);
  assert.deepEqual(await fs.readdir(`${t.dsh}/local-plugins`), []);
});

await test('dot profile names cannot delete settings or protected profiles', async () => {
  const t = await setup();
  await fs.mkdir(`${t.dsh}/profiles/web`, { recursive: true });
  await fs.writeFile(`${t.dsh}/profiles/web/package.json`, '{}');
  for (const name of ['.', '..', 'web.', 'WEB', 'desktop.', 'NUL']) {
    assert.equal((await t.panel.profileDelete(name)).ok, false);
    assert.equal((await t.panel.profileRename(name, 'renamed')).ok, false);
  }
  assert.equal(await fs.readFile(`${t.dsh}/settings.json`, 'utf8'), '{"a":1}');
  assert.equal(await exists(`${t.dsh}/profiles/web/package.json`), true);
});

await test('plain ZIP and tar consistently redact nested, custom, and legacy retained credentials', async () => {
  const t = await setup({ redact: ['custom-key.json', 'private/*.key', 'tokens/[ab].txt', 'keys/[!x].txt', 'codes/[[:digit:]].txt'] });
  const secrets = ['profiles/web/.env', 'custom-key.json', '.credentials.yaml.pre-merge-old', 'private/a.key', 'tokens/a.txt', 'keys/a.txt', 'codes/1.txt'];
  for (const rel of secrets) {
    await fs.mkdir(path.dirname(`${t.dsh}/${rel}`), { recursive: true });
    await fs.writeFile(`${t.dsh}/${rel}`, 'SYNTHETIC-SECRET');
  }
  const b = await t.panel.backup();
  const e = await t.panel.exportConfig({});
  assert.equal(e.ok, true, e.summary);
  const names = await tarList(t.root, path.basename(b.path));
  for (const rel of secrets) {
    assert.equal(names.includes(`.dsh/${rel}`), false, rel);
    await assert.rejects(readZipEntry(e.path, rel), /没有条目/);
  }
});

await test('credential import rollback copies remain private and outside exported data', async () => {
  const t = await setup();
  await fs.chmod(`${t.dsh}/.credentials.yaml`, 0o644);
  const sourcePath = await bundle(t, { entries: [{ name: '.credentials.yaml', data: Buffer.from('version: 1\nkey: imported\n') }] });
  const r = await t.panel.importApply({ sourcePath, sections: ['credentials'], decisions: { '.credentials.yaml': 'overwrite' } });
  assert.equal(r.ok, true, r.summary);
  assert.match(await fs.readFile(`${t.dsh}/.credentials.yaml`, 'utf8'), /imported/);
  const dirs = await fs.readdir(`${t.root}/vault/preserved`);
  const keep = `${t.root}/vault/preserved/${dirs.find((n) => n.startsWith('import-'))}/.credentials.yaml`;
  assert.match(await fs.readFile(keep, 'utf8'), /synthetic-secret/);
  if (process.platform !== 'win32') assert.equal((await fs.stat(keep)).mode & 0o077, 0);
  const full = await t.panel.backup();
  assert.equal((await tarList(t.root, path.basename(full.path))).some((n) => n.includes('.credentials.yaml')), false);
});

await test('credential merge retention stays in vault and never enters later archives', async () => {
  const t = await setup();
  const b = await t.panel.backup(7, ['credentials']);
  await fs.writeFile(`${t.dsh}/.credentials.yaml`, 'version: 1\nkey: CURRENT-SECRET\n');
  await fs.chmod(`${t.dsh}/.credentials.yaml`, 0o644);
  const r = await t.panel.restore(path.basename(b.path), false, ['credentials']);
  assert.equal(r.ok, true, r.summary);
  assert.ok(r.kept.every((p) => p.startsWith(`${t.root}/vault/preserved/`)));
  assert.ok((await fs.readFile(r.kept[0], 'utf8')).includes('CURRENT-SECRET'));
  if (process.platform !== 'win32') assert.equal((await fs.stat(r.kept[0])).mode & 0o077, 0);
  const full = await t.panel.backup();
  assert.equal((await tarList(t.root, path.basename(full.path))).some((n) => n.includes('.credentials.yaml')), false);
});

await test('quarantine protects the last healthy archive from rotation and expired cleanup', async () => {
  const t = await setup({ keep: 1 });
  const rel = 'sessions/p/s/session.jsonl';
  await fs.mkdir(path.dirname(`${t.dsh}/${rel}`), { recursive: true });
  const healthy = JSON.stringify({ type: 'session', version: 0, id: 's', createdAt: 1, delegationDepth: 0 }) + '\n';
  await fs.writeFile(`${t.dsh}/${rel}`, healthy);
  const first = await t.panel.backup(1);
  await fs.writeFile(`${t.dsh}/${rel}`, 'BROKEN');
  const second = await t.panel.backup(1);
  assert.equal(second.stale, 0);
  assert.equal(await exists(first.path), true);
  const clean = await t.panel.cleanup('expired');
  assert.equal(clean.ok, true, clean.summary);
  assert.equal(await exists(first.path), true);
  await fs.writeFile(`${t.dsh}/${rel}`, healthy);
  await t.panel.backup(1);
  assert.equal(await exists(first.path), false, 'rotation resumes after repair');
});

await test('partial typed extraction rolls back overwrites and removes new files', async () => {
  const t = await setup();
  await fs.mkdir(`${t.dsh}/skills`, { recursive: true });
  await fs.writeFile(`${t.dsh}/skills/a.txt`, 'CURRENT');
  const name = await archive(t, [
    { name: '.dsh/skills/a.txt', type: 'file', content: 'OLD' },
    { name: '.dsh/skills/new.txt', type: 'file', content: 'NEW' },
    { name: '.dsh/skills/b.txt', type: 'hardlink', linkName: '.dsh/skills/missing.txt' },
  ]);
  assert.equal((await t.panel.restore(name, true, ['skills'])).ok, true);
  const r = await t.panel.restore(name, false, ['skills']);
  assert.equal(r.ok, false);
  assert.match(r.summary, /已从留档还原/);
  assert.equal(await fs.readFile(`${t.dsh}/skills/a.txt`, 'utf8'), 'CURRENT');
  assert.equal(await exists(`${t.dsh}/skills/new.txt`), false);
});

await test('concurrent acquisition and stale recovery each elect exactly one owner', async () => {
  const t = await setup();
  const lock = `${t.root}/test-lock.json`;
  for (const stale of [false, true]) {
    if (stale) await fs.writeFile(lock, JSON.stringify({ pid: 99999999, token: 'dead' }));
    const results = await Promise.all(Array.from({ length: 24 }, () => acquireLock(lock, 'test')));
    const winners = results.filter((r) => r.acquired);
    assert.equal(winners.length, 1);
    assert.equal(await heartbeatLock(lock, 'wrong'), false);
    assert.equal(await releaseLock(lock, 'wrong'), false);
    assert.equal(await releaseLock(lock, winners[0].lock.token), true);
  }
});

await test('independent processes cannot acquire the same operation lock', async () => {
  const t = await setup();
  const lock = `${t.root}/process-lock.json`;
  const moduleUrl = new URL('../lib/oplock.js', import.meta.url).href;
  const workers = [];
  try {
    for (let i = 0; i < 6; i++) {
      const code = `import {acquireLock} from ${JSON.stringify(moduleUrl)}; import {createInterface} from 'node:readline'; console.log('ready'); for await (const line of createInterface({input:process.stdin})) { if(line==='go') console.log(JSON.stringify(await acquireLock(${JSON.stringify(lock)},'process-test'))); }`;
      const child = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['pipe', 'pipe', 'inherit'] });
      const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
      workers.push({ child, lines });
    }
    await Promise.all(workers.map(async (w) => assert.equal((await w.lines.next()).value, 'ready')));
    for (const w of workers) w.child.stdin.write('go\n');
    const results = await Promise.all(workers.map(async (w) => JSON.parse((await w.lines.next()).value)));
    assert.equal(results.filter((r) => r.acquired).length, 1);
    await releaseLock(lock, results.find((r) => r.acquired).lock.token);
  } finally {
    await Promise.all(workers.map((w) => new Promise((resolve) => { w.child.once('close', resolve); w.child.stdin.end(); })));
  }
});

await test('unrelated RPC is not mistaken for nested operation reentry', async () => {
  const t = await setup();
  let unlock; const gate = new Promise((r) => { unlock = r; });
  let started; const running = new Promise((r) => { started = r; });
  const original = t.mock.ctx.subprocess.spawn;
  t.mock.ctx.subprocess.spawn = (spec) => {
    const handle = original(spec);
    if (spec.argv.includes('-czf')) {
      started();
      return { ...handle, done: handle.done.then(async (r) => { await gate; return r; }) };
    }
    return handle;
  };
  const first = t.panel.backup();
  await running;
  try { await assert.rejects(t.panel.backup(), /另一操作/); }
  finally { unlock(); }
  assert.equal((await first).ok, true);
});

await test('configured Git helper reads tokens from paths containing spaces and quotes', async () => {
  for (const suffix of ['DSH Backups', "DSH Backups' review"]) {
    const t = await setup((t) => ({ destination: `${t.home}/${suffix}`, githubRepo: `${t.dir}/empty.git` }), { env: { GITHUB_TOKEN: 'synthetic-token-not-real' } });
    const init = spawnSync('git', ['init', '--bare', `${t.dir}/empty.git`], { encoding: 'utf8' });
    assert.equal(init.status, 0, init.stderr);
    await t.panel.githubPull(); // Empty remote fails fetch, after preparing the real credential helper.
    const cwd = `${t.root}/.github-sync`;
    const helper = spawnSync('git', ['config', '--get', 'credential.helper'], { cwd, encoding: 'utf8' }).stdout.trim();
    const nullFile = process.platform === 'win32' ? 'NUL' : '/dev/null';
    const r = spawnSync('git', ['-c', 'credential.helper=', '-c', `credential.helper=${helper}`, 'credential', 'fill'], {
      cwd, input: 'protocol=https\nhost=github.com\n\n', encoding: 'utf8',
      env: { ...process.env, GIT_CONFIG_GLOBAL: nullFile, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '' },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout.includes('password=synthetic-token-not-real'));
  }
});

await test('actual client bundle accepts the actual host import preview', async () => {
  const t = await setup();
  const exp = await t.panel.exportConfig({});
  const preview = await t.panel.importPreview({ sourcePath: exp.path });
  assert.equal(preview.ok, true);
  let entry;
  globalThis.window = { __ModuleLoader__: { load: (e) => { entry = e; } } };
  globalThis.document = { createElement: () => ({ style: {}, dataset: {} }), querySelector: () => null, head: { append() {} } };
  const contributions = [];
  try {
    new Function(await fs.readFile(`${repo}/lib/client.js`, 'utf8'))();
    const client = entry.factory(require);
    client.apply({
      effect: (fn) => { fn(); return () => {}; }, locale: { register: () => () => {} },
      inject: (names, cb) => {
        if (names.includes('slots') || names.includes('locale')) cb({ locale: { bind: () => (k) => k }, slots: { inject() {}, register() {} } });
        if (names.includes('remote')) cb({ remote: { $mount: async (c) => { contributions.push(c); return () => {}; } } });
      },
    });
    const schema = contributions[0].descriptors.find((d) => d.method === 'importPreview').result.schema;
    assert.equal(schema.parse(preview).compatibility.score, 100);
  } finally { delete globalThis.window; delete globalThis.document; }
});

await test('rescue and host both verify archives larger than 256 MiB', async () => {
  const t = await setup();
  const name = await archive(t, [{ name: '.dsh/settings.json', type: 'file', content: '{}' }], 'dsh-20990101-010101001.tar.gz');
  const abs = `${t.root}/${name}`;
  await fs.truncate(abs, 257 * 1024 * 1024); // Sparse zero padding: bounded physical storage.
  const hash = createHash('sha256'); for await (const chunk of createReadStream(abs)) hash.update(chunk);
  await fs.writeFile(`${abs}.sha256`, `${hash.digest('hex')}\n`);
  assert.equal((await t.panel.verify(name)).ok, true);
  const r = spawnSync(process.execPath, [`${repo}/rescue/rescue.mjs`, 'verify', name, '--root', t.root], { encoding: 'utf8', env: { ...process.env, DSH_HOME: t.dsh } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /完整/);
});

console.log(`Review regressions: ${passed}/${passed + failed} passed`);
if (failed) process.exitCode = 1;
