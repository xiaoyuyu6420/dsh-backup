/**
 * dsh-backup 冒烟测试（零依赖，跨平台）。
 *
 * 用 node:fs + node:child_process 模拟 DSH 的 fs / subprocess / commands /
 * tools / timer 服务接口，在临时目录中对 lib/index.js 跑完整场景：
 * 备份 → 列表/校验 → 篡改数据 → 预览/恢复 → 损坏检测 → 恢复拒绝 →
 * 定时持久化续跑 → 轮换。在 Windows 上运行即验证 win32 分支
 * （cmd del/move、tar.exe、crypto 哈希回退）。
 *
 * 用法：node scripts/smoke.mjs
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const IS_WIN = process.platform === 'win32';
let failures = 0;
let checks = 0;

function ok(cond, msg) {
  checks += 1;
  if (cond) {
    console.log(`  ✅ ${msg}`);
  } else {
    failures += 1;
    console.error(`  ❌ ${msg}`);
  }
}

async function mkTmpHome() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-backup-smoke-'));
  const home = path.join(dir, 'home');
  const root = `${home}${path.sep}Desktop${path.sep}dsh-backups`;
  const dsh = path.join(home, '.dsh');
  await fs.mkdir(path.join(dsh, 'sessions'), { recursive: true });
  await fs.mkdir(path.join(dsh, 'node_modules', 'some-pkg'), { recursive: true });
  await fs.mkdir(path.join(dsh, '.system'), { recursive: true });
  await fs.writeFile(path.join(dsh, 'settings.json'), '{"a":1}');
  await fs.writeFile(path.join(dsh, '.credentials.yaml'), 'api-key: secret');
  await fs.writeFile(path.join(dsh, 'sessions', 's1.log'), 'session one');
  await fs.writeFile(path.join(dsh, 'node_modules', 'some-pkg', 'junk.js'), 'junk');
  await fs.writeFile(path.join(dsh, '.system', 'cache.bin'), 'cache');
  return { dir, home, root: root.split(path.sep).join('/'), dsh };
}

// ---------- DSH 服务桩 ----------
function makeCtx({ home, dsh }) {
  const intervals = [];
  const handlers = new Map();
  const typertContribs = [];
  const services = [];
  let tool = null;

  async function resolveExecutable(name) {
    if (IS_WIN) {
      if (name === 'cmd') return process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe';
      if (name === 'tar') return 'tar'; // Windows 10+ 自带 System32\tar.exe
      throw new Error(`mock: ${name} not found on win32`);
    }
    return name; // POSIX 依赖 PATH
  }

  function spawnProc(spec) {
    const child = spawn(spec.argv[0], spec.argv.slice(1), { cwd: spec.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    const onAbort = () => child.kill();
    spec.signal?.addEventListener('abort', onAbort, { once: true });
    const done = new Promise((resolve) => {
      child.on('close', (code) => {
        spec.signal?.removeEventListener('abort', onAbort);
        resolve({ exitCode: code === null ? -1 : code });
      });
    });
    return {
      done,
      collected: {
        stdout: { readFrom: () => ({ get text() { return out; } }) },
        stderr: { readFrom: () => ({ get text() { return err; } }) },
      },
    };
  }

  const ctx = {
    get: (key) => {
      if (key === 'launchEnvironment') {
        return {
          get: (name) => {
            if (name === 'HOME') return { value: home };
            if (name === 'DSH_HOME') return { value: `${home}/.dsh` };
            return undefined;
          },
        };
      }
      return undefined;
    },
    subprocess: { resolveExecutable, spawn: spawnProc },
    commands: { register: (cmd) => handlers.set(cmd.name, cmd.handler) },
    tools: { register: (t) => { tool = t; } },
    interval: (fn, ms) => {
      intervals.push({ fn, ms });
      return () => {};
    },
    // cordis Context.inject 的桩：typert 存在时立即激活作用域回调。
    inject: (names, callback) => {
      if (!names.includes('typert')) return;
      const scope = {
        typert: { register: (c) => { typertContribs.push(c); return () => {}; } },
        effect: (fn) => { const dispose = fn(); return () => dispose?.(); },
        plugin: (Class, opts) => { const instance = new Class(scope, opts); services.push(instance); return instance; },
      };
      callback(scope);
    },
  };
  return { ctx, intervals, typertContribs, services, handler: (raw) => handlers.get('backup')({ rawInput: raw, signal: undefined }), tool: () => tool };
}

async function listArchives(root) {
  try {
    const names = await fs.readdir(root);
    return names.filter((n) => n.startsWith('dsh-') && n.endsWith('.tar.gz')).sort().reverse();
  } catch {
    return [];
  }
}

async function tarList(root, name) {
  // 与插件一致：cwd 为备份目录 + 纯文件名，规避 msys GNU tar 的盘符冒号问题。
  const out = await new Promise((resolve) => {
    const c = spawn('tar', ['-tzf', name], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] });
    let buf = '';
    c.stdout.on('data', (d) => { buf += d; });
    c.on('close', () => resolve(buf));
  });
  return out.split('\n').map((s) => s.trim()).filter(Boolean);
}

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const REPO = path.resolve(HERE, '..');

async function main() {
  // 提供 @deepseek-ai/dsh-tools 与 dsh-typert-protocol 桩（插件的运行时导入）。
  const stubRoot = path.join(REPO, 'node_modules', '@deepseek-ai');
  for (const pkg of ['dsh-tools', 'dsh-typert-protocol']) {
    const stubDir = path.join(stubRoot, pkg);
    await fs.mkdir(stubDir, { recursive: true });
    const fixture = path.join(REPO, 'scripts', 'fixtures', pkg);
    await fs.copyFile(path.join(fixture, 'package.json'), path.join(stubDir, 'package.json'));
    await fs.copyFile(path.join(fixture, 'index.js'), path.join(stubDir, 'index.js'));
  }

  const plugin = (await import(new URL('../lib/index.js', import.meta.url).href)).apply;

  const { dir, home, root, dsh } = await mkTmpHome();
  try {
    const config = { destination: `~/Desktop/dsh-backups`, keep: 7 };
    const mock = makeCtx({ home, dsh });
    plugin(mock.ctx, config);
    const run = mock.handler;

    console.log('1) 手动备份');
    const r1 = await run('');
    ok(r1.kind === 'success', `/backup 成功: ${r1.kind === 'success' ? r1.text.split('\n')[0] : r1.text}`);
    const archives1 = await listArchives(root);
    ok(archives1.length === 1, `生成 1 份归档（实际 ${archives1.length}）`);
    const first = archives1[0];
    ok(await fs.stat(`${root}/${first}.sha256`).then(() => true, () => false), '边车 .sha256 存在');
    const entries1 = await tarList(root, first);
    ok(entries1.some((e) => e.includes('settings.json')), '归档含 settings.json');
    ok(!entries1.some((e) => e.includes('node_modules')), '归档排除 node_modules');
    ok(!entries1.some((e) => e.includes('.system')), '归档排除 .system');
    ok(await fs.readFile(`${root}/auto.json`, 'utf8').then((t) => JSON.parse(t).hours === 0), 'auto.json 已写入（hours=0）');

    console.log('2) 列表 + 校验');
    const r2 = await run('list');
    ok(r2.kind === 'success' && r2.text.includes(first) && r2.text.includes('MB'), 'list 显示名称与大小');
    const r3 = await run('verify all');
    ok(r3.kind === 'success' && r3.text.includes('✅'), `verify all 通过: ${r3.text.replace(/\n/g, ' | ')}`);
    const t3 = await mock.tool().execute({ mode: 'verify', selector: 'all' }, {});
    ok(t3.ok === true, '工具 mode=verify ok');

    console.log('3) 恢复（dry-run + 实恢复）');
    await fs.writeFile(path.join(dsh, 'settings.json'), '{"a":2}');
    await fs.rm(path.join(dsh, 'sessions', 's1.log'));
    const r4 = await run('restore latest --dry-run');
    ok(r4.kind === 'success' && r4.text.includes('预览') && !r4.text.includes('恢复完成'), 'dry-run 只预览');
    const r5 = await run('restore latest');
    ok(r5.kind === 'success', `恢复成功: ${r5.kind === 'success' ? '' : r5.text}`);
    ok(await fs.readFile(path.join(dsh, 'settings.json'), 'utf8') === '{"a":1}', 'settings.json 恢复为原始内容');
    ok(await fs.stat(path.join(dsh, 'sessions', 's1.log')).then(() => true, () => false), 'sessions/s1.log 恢复');
    ok(!await fs.stat(path.join(dsh, 'node_modules')).then(() => true, () => false), 'node_modules 保持排除');
    const homeEntries = await fs.readdir(home);
    const aside = homeEntries.find((n) => n.startsWith('.dsh.pre-restore-'));
    ok(Boolean(aside), '旧数据移至 .dsh.pre-restore-*');
    if (aside) {
      ok(await fs.readFile(path.join(home, aside, 'settings.json'), 'utf8') === '{"a":2}', '旧数据保留了篡改后的内容');
    }

    console.log('4) 路径穿越防护');
    const evilDir = path.join(dir, 'evil');
    await fs.mkdir(evilDir, { recursive: true });
    await fs.writeFile(path.join(evilDir, 'evil.txt'), 'pwned');
    await new Promise((resolve) => {
      const c = spawn('tar', ['-czf', 'dsh-0000evil.tar.gz', '-C', evilDir, 'evil.txt'], { cwd: root, stdio: 'ignore' });
      c.on('close', resolve);
    });
    const evilBytes = await fs.readFile(`${root}/dsh-0000evil.tar.gz`);
    const evilSha = createHash('sha256').update(evilBytes).digest('hex');
    await fs.writeFile(`${root}/dsh-0000evil.tar.gz.sha256`, `${evilSha}  evil\n`);
    const r6 = await run('restore dsh-0000evil');
    ok(r6.kind === 'error' && r6.text.includes('之外'), `拒绝归档外条目: ${r6.text.replace(/\n/g, ' ').slice(0, 80)}`);
    ok(await fs.readFile(path.join(dsh, 'settings.json'), 'utf8') === '{"a":1}', '现有数据未被 evil 归档触碰');

    console.log('5) 损坏检测');
    const archives5 = await listArchives(root);
    const newest = archives5.find((n) => !n.includes('evil')); // 恢复过程生成的快照
    const fh = await fs.open(`${root}/${newest}`, 'r+');
    const stat = await fh.stat();
    await fh.write(Buffer.from('X'), 0, 1, Math.max(0, Math.floor(stat.size / 2)));
    await fh.close();
    const r7 = await run('verify all');
    ok(r7.kind === 'error' && r7.text.includes('❌'), `损坏被检出: ${r7.text.replace(/\n/g, ' | ').slice(0, 100)}`);
    const r8 = await run('restore latest');
    ok(r8.kind === 'error' && r8.text.includes('校验未通过'), '恢复损坏归档被拒绝');
    const r9 = await run(`restore ${first}`);
    ok(r9.kind === 'success', `按前缀恢复完好的首份归档: ${r9.kind === 'success' ? '' : r9.text}`);

    console.log('6) 定时备份持久化');
    const r10 = await run('auto 2');
    ok(r10.kind === 'success' && r10.text.includes('持久化'), '开启 auto 2');
    ok(await fs.readFile(`${root}/auto.json`, 'utf8').then((t) => JSON.parse(t).hours === 2), 'auto.json hours=2');
    ok(mock.intervals.at(-1)?.ms === 2 * 3600 * 1000, 'interval 注册 2 小时');

    const mock2 = makeCtx({ home, dsh });
    plugin(mock2.ctx, config);
    await new Promise((resolve) => setTimeout(resolve, 50)); // 等待启动恢复的异步读取
    ok(mock2.intervals.length === 1 && mock2.intervals[0].ms === 2 * 3600 * 1000, '重启后续跑 interval');
    const r11 = await mock2.handler('auto status');
    ok(r11.text.includes('每 2 小时'), `重启后状态正确: ${r11.text}`);

    console.log('7) 轮换');
    for (let i = 0; i < 12; i += 1) {
      const rr = await mock2.handler('--keep 3');
      if (rr.kind !== 'success') { ok(false, `第 ${i} 次备份失败: ${rr.text}`); break; }
    }
    const archives7 = await listArchives(root);
    ok(archives7.length === 3, `轮换后剩 3 份（实际 ${archives7.length}）`);
    ok(await fs.stat(`${root}/auto.json`).then(() => true, () => false), 'auto.json 未被轮换删除');
    const sidecars = (await fs.readdir(root)).filter((n) => n.endsWith('.sha256'));
    ok(sidecars.length === archives7.length, `边车与归档同数（${sidecars.length}/${archives7.length}）`);

    console.log('8) Settings 面板服务（backupPanel Remote）');
    const contrib = mock.typertContribs[0];
    ok(contrib !== undefined && contrib.package === 'dsh-backup' && contrib.face === 'host', 'typert 贡献已注册（host 面）');
    const endpoints = contrib ? contrib.invocations.map((d) => `${d.namespace}/${d.method}`) : [];
    ok(JSON.stringify(endpoints) === JSON.stringify(['backupPanel/status', 'backupPanel/backup', 'backupPanel/verify', 'backupPanel/restore', 'backupPanel/setAuto']), `5 个端点齐全: ${endpoints.join(', ')}`);
    ok(contrib && contrib.invocations.every((d) => d.service === 'backupPanel' && d.result.mode === 'src-json'), '描述符 service/result codec 正确');
    const panel = mock.services.find((s) => s.name === 'backupPanel');
    ok(panel !== undefined, 'backupPanel 服务已挂载');
    if (panel) {
      const snap = await panel.status();
      ok(snap.destination.includes('Desktop/dsh-backups') && snap.dshHome.endsWith('/.dsh') && Number.isInteger(snap.keepDefault), `status 快照: dest=${snap.destination}`);
      ok(Array.isArray(snap.backups) && snap.backups.length === 3 && typeof snap.backups[0].size === 'number', `快照含 ${snap.backups.length} 份备份与大小`);
      const vb = await panel.backup(undefined, undefined);
      ok(vb.ok === true && typeof vb.path === 'string' && vb.path.endsWith('.tar.gz'), `面板 backup 成功: ${vb.path.split('/').pop()}`);
      const vv = await panel.verify('all', undefined);
      ok(vv.ok === true && vv.results.every((r) => r.ok), `面板 verify all 全部通过（${vv.results.length} 份）`);
      const vr = await panel.restore(undefined, true, undefined);
      ok(vr.ok === true && vr.dryRun === true && Number.isInteger(vr.files), `面板 restore dry-run 预览: ${vr.files} 项`);
      const va0 = await panel.setAuto(0);
      const va3 = await panel.setAuto(3);
      ok(va0.ok === true && va3.ok === true && va3.hours === 3 && (await fs.readFile(`${root}/auto.json`, 'utf8')).includes('"hours":3'), '面板 setAuto 0/3 生效并持久化');
      const bad = await panel.setAuto(999);
      ok(bad.ok === false, '面板 setAuto 越界被拒');
    }

    console.log(`\n结果: ${checks - failures}/${checks} 通过`);
    if (failures) process.exitCode = 1;
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
