/**
 * dsh-backup 冒烟测试（零依赖，跨平台）。
 *
 * 用 node:fs + node:child_process 模拟 DSH 的 fs / subprocess / commands /
 * tools / timer 服务接口，在临时目录中对 lib/index.js 跑完整场景：
 * 备份 → 列表/校验 → 篡改数据 → 预览/恢复 → 损坏检测 → 恢复拒绝 →
 * 恶意归档拒绝（.. 段 / symlink 逃逸）→ 取消分类 → 定时持久化续跑
 * （按上次执行时间锚定）→ 轮换 → GitHub 凭据保留 → auto keep 可配 →
 * doctor 体检/定点修复 → 老归档无边车兼容 → 空目标机恢复。
 * 在 Windows 上运行即验证 win32 分支
 * （fs.unlink/rename、tar.exe、crypto 哈希回退）。
 *
 * 用法：node scripts/smoke.mjs
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
// 命名空间导入：zstd 系导出在 Node <22.15/23.8 不存在，具名导入会让整个
// 套件加载失败——套件本身要能跨运行时启动才能测插件的降级路径。
import * as zlib from 'node:zlib';

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

// ---------- RPC 方法名保留字（issue #9） ----------
// 镜像宿主 dsh-api-gateway 的 RemoteNamespaceService.assertMethodAvailable 语义：
// REMOTE_NAMESPACE_FIELDS ∪ 原型链成员（含 Object.prototype，`in` 检查会命中）。
// 提取自 @deepseek-ai/dsh-api-gateway@0.1.1-rc.2 的 client.js；宿主升级若
// 新增成员，需同步此清单。
const REMOTE_NAMESPACE_FIELDS = new Set(['ctx', 'empty', 'invokeRemote', 'methods', 'name', 'namespace']);
const REMOTE_NAMESPACE_PROTOTYPE = new Set([
  'assertMethodAvailable', 'constructor', 'empty', 'has', 'install',
  'installDirect', 'installScoped', 'remove',
]);
const OBJECT_PROTOTYPE_MEMBERS = new Set([
  'toString', 'toLocaleString', 'valueOf', 'hasOwnProperty',
  'isPrototypeOf', 'propertyIsEnumerable',
]);
function assertPanelMethodAvailable(namespace, method) {
  if (REMOTE_NAMESPACE_FIELDS.has(method) || REMOTE_NAMESPACE_PROTOTYPE.has(method) || OBJECT_PROTOTYPE_MEMBERS.has(method)) {
    throw new Error(`client api: method ${JSON.stringify(`${namespace}/${method}`)} conflicts with its namespace service`);
  }
}

// ---------- DSH 服务桩 ----------
function makeCtx({ home, dsh, env }) {
  const intervals = [];
  const timeouts = [];
  const handlers = new Map();
  const typertContribs = [];
  const services = [];
  const routes = [];
  let tool = null;

  async function resolveExecutable(name) {
    if (IS_WIN) {
      if (name === 'tar') return 'tar'; // Windows 10+ 自带 System32\tar.exe
      if (name === 'git') return 'git'; // Git Bash / Git for Windows
      throw new Error(`mock: ${name} not found on win32`);
    }
    return name; // POSIX 依赖 PATH
  }

  function spawnProc(spec) {
    if (spec.signal?.aborted) {
      // 已取消的调用不再启动子进程：立即按被终止分类返回
      const done = Promise.resolve({ exitCode: null, signal: 'SIGTERM' });
      return {
        done,
        collected: {
          stdout: { readFrom: () => ({ get text() { return ''; } }) },
          stderr: { readFrom: () => ({ get text() { return ''; } }) },
        },
      };
    }
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
        resolve(code === null ? { exitCode: null, signal: 'SIGTERM' } : { exitCode: code, signal: null });
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
            if (env && name in env) return { value: env[name] };
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
    timeout: (fn, ms) => {
      timeouts.push({ fn, ms });
      return () => {};
    },
    // cordis Context.inject 的桩：typert / webServer / settings 存在时立即激活
    // 作用域回调。settings 桩模拟"已装载"状态（describe 立即给出 revision），
    // 让启动钩子的 waitForSettingsReady 第一拍就通过——与真实 Web profile 的
    // 稳态一致；headless 无 settings 的慢路径由 cap 兜底。
    inject: (names, callback) => {
      if (names.includes('typert')) {
        const scope = {
          typert: { register: (c) => { typertContribs.push(c); return () => {}; } },
          effect: (fn) => { const dispose = fn(); return () => dispose?.(); },
          plugin: (Class, opts) => { const instance = new Class(scope, opts); services.push(instance); return instance; },
        };
        callback(scope);
      }
      if (names.includes('webServer')) {
        const scope = {
          webServer: { register: (route) => { routes.push(route); return () => {}; } },
          effect: (fn) => { const dispose = fn(); return () => dispose?.(); },
        };
        callback(scope);
      }
      if (names.includes('settings')) {
        // 模拟真实 settings 服务的合并语义：register 收到的 base 即
        // resolveBase(pluginConfig)，describe.value 返回合并结果——否则
        // value:{} 会遮蔽 pluginConfig（githubRepo/keep 等全部丢失）
        let registeredBase = {};
        const scope = {
          settings: {
            register: (_ns, _schema, opts) => { registeredBase = (opts && opts.base) || {}; },
            update: () => {},
            replace: () => {},
            describe: () => [{ ns: 'dsh-backup', revision: 0, value: { ...registeredBase } }],
          },
        };
        callback(scope);
      }
    },
  };
  return { ctx, intervals, timeouts, typertContribs, services, routes, handler: (raw, signal) => handlers.get('backup')({ rawInput: raw, signal }), tool: () => tool };
}

async function listArchives(root) {
  try {
    const names = await fs.readdir(root);
    // 与插件 listBackups 一致：排除全部内部快照（pre-restore/pre-upgrade），只数用户可见备份
    return names.filter((n) => n.startsWith('dsh-') && !n.startsWith('dsh-pre-restore-') && !n.startsWith('dsh-pre-upgrade-') && n.endsWith('.tar.gz')).sort().reverse();
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

/**
 * 零依赖 UStar tar 生成器（node:zlib gzip 压缩）：smoke 用它制造真实
 * tar 工具能读取的恶意归档（.. 段 / symlink 逃逸），restore 的
 * tar -tvzf 校验必须拒绝。entries: [{ name, type: 'file'|'symlink'|'dir',
 * content?, linkName? }]。
 */
function makeTarGz(entries) {
  const blocks = [];
  for (const e of entries) {
    const isFile = e.type === 'file';
    const isLink = e.type === 'symlink';
    const isDir = e.type === 'dir';
    const content = isFile ? Buffer.from(e.content ?? '', 'utf8') : Buffer.alloc(0);
    const header = Buffer.alloc(512);
    const name = Buffer.from(e.name, 'utf8');
    name.copy(header, 0, 0, Math.min(name.length, 100));
    header.write('0000644\0', 100, 'ascii');
    header.write('0000000\0', 108, 'ascii');
    header.write('0000000\0', 116, 'ascii');
    header.write(`${content.length.toString(8).padStart(11, '0')}\0`, 124, 'ascii');
    header.write(`${Math.floor(Date.now() / 1000).toString(8).padStart(11, '0')}\0`, 136, 'ascii');
    header.fill(0x20, 148, 156); // chksum 占位：8 个空格
    header.write(isLink ? '2' : isDir ? '5' : '0', 156, 'ascii');
    if (isLink) {
      const link = Buffer.from(e.linkName ?? '', 'utf8');
      link.copy(header, 157, 0, Math.min(link.length, 100));
    }
    header.write('ustar\0', 257, 'ascii');
    header.write('00', 263, 'ascii');
    let sum = 0;
    for (const b of header) sum += b;
    header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii');
    blocks.push(header);
    if (content.length) blocks.push(content);
    const pad = (512 - (content.length % 512)) % 512;
    if (pad) blocks.push(Buffer.alloc(pad));
  }
  blocks.push(Buffer.alloc(512), Buffer.alloc(512)); // 结尾两个零块
  return zlib.gzipSync(Buffer.concat(blocks));
}

/**
 * 构造健康的会话日志（zstd 拼接帧或 raw 文本），布局对齐
 * @deepseek-ai/dsh-session-persistence-jsonl：首帧 SessionHeader，
 * 其后每批一帧；packed 行（text-chunks）横跨 seq2..4，随后裸事件接续。
 */
function makeSessionLogLines(id) {
  const header = JSON.stringify({ type: 'session', version: 0, id, createdAt: '2026-08-25T00:00:00.000Z', delegationDepth: 0 });
  const ev = (seq) => JSON.stringify({ type: 'user/message', seq });
  const packedRow = JSON.stringify({ type: 'text-chunks', seq0: 2, time0: 1000, data: { turn: 0, step: 0, index: 0, dt: [5, 7], texts: ['a', 'b', 'c'] } });
  return [header, ev(0), ev(1), packedRow, ev(5), ev(6)];
}

function makeZstdSessionLog(id) {
  // 无 zstd 运行时（Node <22.15/23.8）：内容无所谓——体检对这些文件走 skipped
  if (typeof zlib.zstdCompressSync !== 'function') {
    return Buffer.from(`placeholder-zstd-log-${id}`);
  }
  // 三帧：header / 裸事件两行 / packed 行 + 后续裸事件
  return Buffer.concat([
    zlib.zstdCompressSync(`${makeSessionLogLines(id).slice(0, 1).join('\n')}\n`),
    zlib.zstdCompressSync(`${makeSessionLogLines(id).slice(1, 3).join('\n')}\n`),
    zlib.zstdCompressSync(`${makeSessionLogLines(id).slice(3).join('\n')}\n`),
  ]);
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
    // 根外条目：旧实现报「之外」，统一后的实现并入「不安全条目」——两者都算拒绝
    ok(r6.kind === 'error' && (r6.text.includes('之外') || r6.text.includes('不安全条目')), `拒绝归档外条目: ${r6.text.replace(/\n/g, ' ').slice(0, 80)}`);
    ok(await fs.readFile(path.join(dsh, 'settings.json'), 'utf8') === '{"a":1}', '现有数据未被 evil 归档触碰');

    console.log('4b) 恶意归档拒绝（.. 段条目 / symlink 逃逸）');
    const dotdotArchive = makeTarGz([
      { name: '.dsh/../../evil.txt', type: 'file', content: 'pwned' },
    ]);
    await fs.writeFile(`${root}/dsh-0000dotdot.tar.gz`, dotdotArchive);
    const dotdotSha = createHash('sha256').update(dotdotArchive).digest('hex');
    await fs.writeFile(`${root}/dsh-0000dotdot.tar.gz.sha256`, `${dotdotSha}  dsh-0000dotdot.tar.gz\n`);
    const rDot = await run('restore dsh-0000dotdot');
    ok(rDot.kind === 'error' && rDot.text.includes('不安全条目'), `拒绝 .. 段条目: ${rDot.text.replace(/\n/g, ' ').slice(0, 80)}`);
    const backslashArchive = makeTarGz([
      { name: '.dsh/..\\..\\evil.txt', type: 'file', content: 'pwned' },
    ]);
    await fs.writeFile(`${root}/dsh-0000backslash.tar.gz`, backslashArchive);
    const backslashSha = createHash('sha256').update(backslashArchive).digest('hex');
    await fs.writeFile(`${root}/dsh-0000backslash.tar.gz.sha256`, `${backslashSha}  dsh-0000backslash.tar.gz\n`);
    const rBackslash = await run('restore dsh-0000backslash');
    ok(rBackslash.kind === 'error' && rBackslash.text.includes('不安全条目'), `拒绝 ..\\ 反斜杠变体: ${rBackslash.text.replace(/\n/g, ' ').slice(0, 80)}`);
    const linkArchive = makeTarGz([
      { name: '.dsh/ln', type: 'symlink', linkName: '/etc/passwd' },
      { name: '.dsh/ln/x', type: 'file', content: 'x' },
    ]);
    await fs.writeFile(`${root}/dsh-0000link.tar.gz`, linkArchive);
    const linkSha = createHash('sha256').update(linkArchive).digest('hex');
    await fs.writeFile(`${root}/dsh-0000link.tar.gz.sha256`, `${linkSha}  dsh-0000link.tar.gz\n`);
    const rLink = await run('restore dsh-0000link');
    ok(rLink.kind === 'error' && rLink.text.includes('不安全条目'), `拒绝 symlink 逃逸: ${rLink.text.replace(/\n/g, ' ').slice(0, 80)}`);

    console.log('4c) 用户取消分类（不报命令失败）');
    const ac = new AbortController();
    ac.abort();
    const rCancel = await run('', ac.signal);
    ok(rCancel.kind === 'error' && rCancel.text.includes('已取消') && !rCancel.text.includes('命令失败'), `取消报已取消而非命令失败: ${rCancel.text.replace(/\n/g, ' ').slice(0, 80)}`);

    console.log('5) 损坏检测');
    // 再建一份用户可见备份，使「最新」与「首份」区分开（pre-restore 快照已排除在 listArchives 外）
    await run('');
    const archives5 = await listArchives(root);
    const newest = archives5[0]; // 最新用户可见备份
    const fh = await fs.open(`${root}/${newest}`, 'r+');
    const stat = await fh.stat();
    await fh.write(Buffer.from('X'), 0, 1, Math.max(0, Math.floor(stat.size / 2)));
    await fh.close();
    const r7 = await run('verify all');
    ok(r7.kind === 'error' && r7.text.includes('❌'), `损坏被检出: ${r7.text.replace(/\n/g, ' | ').slice(0, 100)}`);
    const r8 = await run('restore latest');
    ok(r8.kind === 'error' && r8.text.includes('校验未通过'), '恢复损坏归档被拒绝（latest=损坏的最新份）');
    const r9 = await run(`restore ${first}`);
    ok(r9.kind === 'success', `按前缀恢复完好的首份归档: ${r9.kind === 'success' ? '' : r9.text}`);

    console.log('6) 定时备份持久化（链式 timeout + 时间戳续跑）');
    const t0 = mock.timeouts.length; // 基线：只认本次开启注册的调度，不依赖全局末尾
    const r10 = await run('auto 2');
    ok(r10.kind === 'success' && r10.text.includes('持久化'), '开启 auto 2');
    ok(await fs.readFile(`${root}/auto.json`, 'utf8').then((t) => JSON.parse(t).hours === 2), 'auto.json hours=2');
    // 开启即立即调度（delay=0，新计划锚点=now）为当前实现行为，非契约承诺
    ok(mock.timeouts[t0]?.ms === 0, 'auto 2 注册链式调度（新计划锚点=now）');

    // 触发一次自动备份：lastAutoAt 落盘，重启后按上次执行时间推算下次触发（不重置节奏）
    await mock.timeouts[t0].fn();
    ok(await fs.readFile(`${root}/auto.json`, 'utf8').then((t) => typeof JSON.parse(t).lastAutoAt === 'string'), '自动备份后持久化 lastAutoAt');

    const mock2 = makeCtx({ home, dsh });
    plugin(mock2.ctx, config);
    await new Promise((resolve) => setTimeout(resolve, 50)); // 等待启动恢复的异步读取
    // mock2 是全新 ctx：重启注册的调度从索引 0 起（基线相对，无全局末尾依赖）
    const delayMs = mock2.timeouts[0]?.ms;
    ok(mock2.timeouts.length === 1 && delayMs > 2 * 3600 * 1000 - 5000 && delayMs <= 2 * 3600 * 1000, `重启后按 上次执行+2h 续跑（${Math.round((delayMs ?? 0) / 1000)}s，期望 ≈7200s）`);
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
    const sidecars = (await fs.readdir(root)).filter((n) => n.endsWith('.sha256') && !n.startsWith('dsh-pre-restore-'));
    ok(sidecars.length === archives7.length, `边车与归档同数（${sidecars.length}/${archives7.length}）`);

    console.log('8) Settings 面板服务（backupPanel Remote）');
    const contrib = mock.typertContribs[0];
    ok(contrib !== undefined && contrib.package === 'dsh-backup' && contrib.face === 'host', 'typert 贡献已注册（host 面）');
    const endpoints = contrib ? contrib.invocations.map((d) => `${d.namespace}/${d.method}`) : [];
    ok(JSON.stringify(endpoints) === JSON.stringify(['backupPanel/status', 'backupPanel/backup', 'backupPanel/verify', 'backupPanel/restore', 'backupPanel/setAuto', 'backupPanel/githubStatus', 'backupPanel/githubSyncNow', 'backupPanel/githubPull', 'backupPanel/removeEntry', 'backupPanel/setGithubRepo', 'backupPanel/doctorScan', 'backupPanel/doctorRepair']), `12 个端点齐全: ${endpoints.join(', ')}`);
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

    console.log('9) Web 下载路由');
    const route = mock.routes.find((r) => r.path === '/backup-download');
    ok(route !== undefined && route.kind === 'prefix', '下载路由已注册（prefix）');
    const mkRes = () => {
      const chunks = [];
      return {
        status: 200, headers: null, done: false, body: null, destroyed: false,
        writeHead(s, h) { this.status = s; this.headers = h; },
        write(c) { chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)); return true; },
        end(b) { if (b !== undefined) chunks.push(Buffer.isBuffer(b) ? b : Buffer.from(b)); this.done = true; this.body = Buffer.concat(chunks); },
        destroy() { this.destroyed = true; this.done = true; this.body = Buffer.concat(chunks); },
        // pipe() 需要目标具备事件接口（真实 http.ServerResponse 有）
        on() {}, once() {}, removeListener() {}, emit() { return false; },
      };
    };
    const waitDone = async (res) => {
      const t0 = Date.now();
      while (!res.done && Date.now() - t0 < 3000) await new Promise((r) => setTimeout(r, 20));
    };
    if (route) {
      const target = (await listArchives(root))[0];
      const good = mkRes();
      await route.handler({ url: `/backup-download/${target}`, headers: { host: '127.0.0.1:3081' } }, good);
      await waitDone(good);
      ok(good.status === 200 && good.body !== null && good.body.length > 0 && String(good.headers['Content-Disposition']).includes(target), `下载 200（${good.body ? good.body.length : 0} 字节，attachment）`);
      const evil = mkRes();
      await route.handler({ url: '/backup-download/..%2F..%2Fevil.tar.gz', headers: { host: '127.0.0.1:3081' } }, evil);
      await waitDone(evil);
      ok(evil.status === 400, '路径穿越名被拒（400）');
      const foreign = mkRes();
      await route.handler({ url: `/backup-download/${target}`, headers: { host: 'evil.example' } }, foreign);
      await waitDone(foreign);
      ok(foreign.status === 403, '非 loopback Host 被拒（403）');
    }

    console.log('10) GitHub 同步（本地 bare 仓库端到端）');
    const ghBare = path.join(dir, 'gh-bare.git');
    await new Promise((resolve) => {
      // -b main：与插件推送的分支一致，便于用 git log/ls-tree 直接检查
      const c = spawn('git', ['init', '--bare', '-b', 'main', ghBare], { stdio: 'ignore' });
      c.on('close', resolve);
    });
    const gitOut = (args) => new Promise((resolve) => {
      const c = spawn('git', args, { stdio: ['ignore', 'pipe', 'ignore'] });
      let out = '';
      c.stdout.on('data', (d) => { out += d; });
      c.on('close', () => resolve(out.trim()));
    });
    const mock3 = makeCtx({ home, dsh });
    plugin(mock3.ctx, { destination: config.destination, githubRepo: ghBare.split(path.sep).join('/') });
    const rSync1 = await mock3.handler('');
    ok(rSync1.kind === 'success' && rSync1.text.includes('备份完成'), '备份成功（githubRepo 已配置）');
    const syncDir2 = path.join(home, 'Desktop', 'dsh-backups', '.github-sync');
    ok(await fs.stat(path.join(syncDir2, '.git')).then(() => true, () => false), '同步工作树已初始化');
    const bareLog = await gitOut(['--git-dir', ghBare, 'log', '--oneline', '-1']);
    ok(bareLog.includes('backup'), `bare 仓库存在同步提交: ${bareLog}`);
    const bareFiles = await gitOut(['--git-dir', ghBare, 'ls-tree', '-r', '--name-only', 'HEAD']).then((s) => s.split('\n').filter(Boolean));
    ok(bareFiles.some((f) => f.endsWith('.tar.gz')) && bareFiles.some((f) => f.endsWith('.sha256')), `归档与边车已推送（${bareFiles.length} 个文件）`);
    ok(!bareFiles.includes('.git-credentials'), '凭据文件未被推送');
    ok(await fs.readFile(path.join(syncDir2, '.gitignore'), 'utf8').then((t) => t.includes('.git-credentials')), '.gitignore 排除凭据文件');
    await fs.writeFile(path.join(syncDir2, 'junk-file.txt'), 'junk');
    await mock3.handler('github sync');
    ok(await fs.stat(path.join(syncDir2, 'junk-file.txt')).then(() => false, () => true), '工作树杂物被镜像清理');
    ok(!(await gitOut(['--git-dir', ghBare, 'ls-tree', '-r', '--name-only', 'HEAD'])).includes('junk-file.txt'), '杂物未进入远端');
    const st10 = JSON.parse(await fs.readFile(path.join(root, 'auto.json'), 'utf8'));
    ok(st10.github && st10.github.lastPush, 'auto.json 记录 github.lastPush');
    const stCmd = await mock3.handler('github status');
    ok(stCmd.kind === 'success' && stCmd.text.includes('gh-bare.git'), 'github status 显示仓库');
    const panel2 = mock3.services.find((s) => s.name === 'backupPanel');
    const ghStatus = await panel2.githubStatus();
    ok(ghStatus.repo && ghStatus.lastPush !== null && ghStatus.syncDir.includes('.github-sync'), '面板 githubStatus 正常');
    const ghNow = await panel2.githubSyncNow(undefined);
    ok(ghNow.ok === true && ghNow.pushed === false, '面板 githubSyncNow（无变更）ok');
    for (let i = 0; i < 3; i += 1) await mock3.handler('--keep 1');
    const bareFiles2 = await gitOut(['--git-dir', ghBare, 'ls-tree', '-r', '--name-only', 'HEAD']).then((s) => s.split('\n').filter(Boolean));
    ok(bareFiles2.filter((f) => f.endsWith('.tar.gz')).length === 1, `轮换删除已同步（bare 仓库剩 1 份归档，实际 ${bareFiles2.filter((f) => f.endsWith('.tar.gz')).length}）`);

    console.log('10b) GitHub 凭据保留（token 写入 .git-credentials，镜像清理不删）');
    const mockCred = makeCtx({ home, dsh, env: { DSH_BACKUP_GITHUB_TOKEN: 'test-token' } });
    plugin(mockCred.ctx, { destination: config.destination, githubRepo: ghBare.split(path.sep).join('/') });
    const rCred = await mockCred.handler('');
    ok(rCred.kind === 'success', '带 token 的备份成功（https 远端检查通过）');
    const credsPath = `${root}/.github-sync/.git-credentials`;
    ok(await fs.readFile(credsPath, 'utf8').then((t) => t.includes('test-token'), () => false), '.git-credentials 存在且含 test-token');
    if (!IS_WIN) {
      const credMode = (await fs.stat(credsPath)).mode & 0o777;
      ok(credMode === 0o600, `.git-credentials 权限 0600（实际 ${credMode.toString(8)}）`);
    }
    await fs.writeFile(`${root}/.github-sync/junk-cred-test.txt`, 'junk');
    await mockCred.handler('github sync');
    ok(await fs.readFile(credsPath, 'utf8').then((t) => t.includes('test-token'), () => false), '镜像清理后凭据文件仍在（keep 集保留）');
    const bareFilesCred = await gitOut(['--git-dir', ghBare, 'ls-tree', '-r', '--name-only', 'HEAD']).then((s) => s.split('\n').filter(Boolean));
    ok(!bareFilesCred.includes('.git-credentials'), 'bare 仓库不含 .git-credentials');

    console.log('11) 删除备份 + GitHub 地址运行时修改');
    for (let i = 0; i < 2; i += 1) await mock3.handler('--keep 2');
    const before = (await listArchives(root)).length;
    const del = await panel2.removeEntry(undefined, undefined);
    ok(del.ok === true && del.summary.includes('已删除'), `面板 remove 成功: ${del.summary}`);
    ok((await listArchives(root)).length === before - 1, `归档已从磁盘删除（${before - 1} 份剩余）`);
    const delBad = await panel2.removeEntry('no-such-archive', undefined);
    ok(delBad.ok === false, '删除不存在的备份被拒');
    const rmCmd = await mock3.handler('delete latest');
    ok(rmCmd.kind === 'success' && rmCmd.text.includes('🗑️'), `命令删除: ${rmCmd.text}`);
    const repoSet = await panel2.setGithubRepo('other-user/some-backups');
    ok(repoSet.ok === true, 'setGithubRepo 设置成功');
    const ghAfter = await panel2.githubStatus();
    ok(ghAfter.repoRaw === 'other-user/some-backups' && ghAfter.repo === 'https://github.com/other-user/some-backups.git', '运行时地址优先并生效');
    ok(JSON.parse(await fs.readFile(path.join(root, 'auto.json'), 'utf8')).github.repo === 'other-user/some-backups', 'auto.json 持久化运行时地址');
    const repoBad = await panel2.setGithubRepo('no-slashes-here');
    ok(repoBad.ok === false, '非法仓库格式被拒');
    const repoClear = await panel2.setGithubRepo('');
    const ghAfterClear = await panel2.githubStatus();
    ok(repoClear.ok === true && ghAfterClear.repoRaw === ghBare.split(path.sep).join('/'), '清除后回退到 config 默认仓库');

    console.log('12) auto keep 可配（config.keep 覆盖自动备份保留数）');
    const mock6 = makeCtx({ home, dsh });
    plugin(mock6.ctx, { destination: config.destination, keep: 10 });
    // 基线：auto 6 注册的调度索引（启动恢复可能已注册 hours=3 的调度）
    const t6 = mock6.timeouts.length;
    const rKeepAuto = await mock6.handler('auto 6');
    ok(rKeepAuto.kind === 'success' && rKeepAuto.text.includes('保留 10 份'), `auto 文案按 config.keep 显示保留数: ${rKeepAuto.text.replace(/\n/g, ' ').slice(0, 60)}`);
    for (let i = 0; i < 5; i += 1) {
      const rr = await mock6.handler('--keep 3');
      if (rr.kind !== 'success') { ok(false, `第 ${i} 次手动备份失败: ${rr.text}`); break; }
    }
    ok((await listArchives(root)).length === 3, '手动 --keep 3 轮换后剩 3 份');
    await mock6.timeouts[t6].fn(); // 触发自动备份：保留数应取 config.keep=10 而非 <24h 默认 3
    const archivesKeep = await listArchives(root);
    ok(archivesKeep.length === 4, `auto 备份按 config.keep=10 保留 ${archivesKeep.length} 份（旧逻辑会截到 3）`);

    console.log('13) F1 — GitHub token 嵌入 URL 不泄露');
    {
      const mockT = makeCtx({ home, dsh });
      plugin(mockT.ctx, config);
      const panelT = mockT.services[0]?.panel ?? null;
      const runT = mockT.handler;
      const secret = 'ghp_SECRETOKEN_0123456789';
      const repoUrl = `https://x-access-token:${secret}@github.com/me/private-backups.git`;
      // 命令路径
      const setC = await runT(`github repo ${repoUrl}`);
      ok(setC.kind === 'success' && !setC.text.includes(secret), `命令回显不含 token: ${setC.text.replace(/\n/g, ' ').slice(0, 60)}`);
      const autoC = JSON.parse(await fs.readFile(`${root}/auto.json`, 'utf8'));
      ok(typeof autoC.github.repo === 'string' && !autoC.github.repo.includes(secret), `auto.json 不含 token（${autoC.github.repo}）`);
      const stC = await runT('github status');
      ok(stC.kind === 'success' && !stC.text.includes(secret), `/backup github status 不回显 token`);
      ok(autoC.github.repo === 'https://github.com/me/private-backups.git', `repo 已剥离 userinfo（${autoC.github.repo}）`);
      // 面板路径 + repoRaw 不泄露
      if (panelT) {
        const setP = await panelT.setGithubRepo(repoUrl);
        ok(setP.ok === true && !setP.summary.includes(secret) && !setP.repo.includes(secret), `面板 setGithubRepo 不回显 token`);
        const stP = await panelT.githubStatus();
        ok(typeof stP.repoRaw === 'string' && !stP.repoRaw.includes(secret), `面板 repoRaw 不含 token（${stP.repoRaw}）`);
      }
      // 非法/无 userinfo 输入不被 strip 破坏
      const setOwner = await runT('github repo me/backups');
      ok(setOwner.kind === 'success' && setOwner.text.includes('me/backups'), 'owner/repo 不受 strip 影响');
      // ssh://git@ 不被 strip（保留 git 用户名，避免破坏 SSH 同步）
      const setSsh = await runT('github repo ssh://git@github.com/me/backups.git');
      ok(setSsh.kind === 'success' && setSsh.text.includes('git@github.com'), `ssh://git@ 保持原样（${setSsh.text.replace(/\n/g, ' ').slice(0, 50)}）`);
      await runT('github repo off');
      // F4：cordis.yml config.githubRepo 内嵌 token 时，面板 repoRaw 回退到 config 也须 strip
      const cfgSecret = 'ghp_CFGTOKEN_9876543210';
      const mockCfg = makeCtx({ home, dsh });
      plugin(mockCfg.ctx, { destination: config.destination, githubRepo: `https://x-access-token:${cfgSecret}@github.com/me/cfg-backups.git` });
      const panelCfg = mockCfg.services[0]?.panel ?? null;
      if (panelCfg) {
        const stCfg = await panelCfg.githubStatus();
        ok(typeof stCfg.repoRaw === 'string' && !stCfg.repoRaw.includes(cfgSecret), `config.githubRepo 回退的 repoRaw 不含 token（${stCfg.repoRaw}）`);
        ok(stCfg.repo === 'https://github.com/me/cfg-backups.git', `config 回退的 canonical repo 已剥离（${stCfg.repo}）`);
      }
    }


  // 原子写：测试注入的 auto.json 与前序用例仍在跑的 saveAutoState(rename)
  // 竞争时，非原子 writeFile 会被 truncate+write 交错出空文件（CI 实测 flaky）
  const atomicWriteJson = async (p, obj) => {
    const tmp = `${p}.${Math.random().toString(36).slice(2)}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(obj));
    await fs.rename(tmp, p);
  };

    console.log('14) F2 — lastAutoAt 未来日期被拒（不静默失效）');
    {
      // 写入未来日期 lastAutoAt（auto 已开启 hours=2 的场景下注入）
      const future = '2525-01-01T00:00:00.000Z';
      await atomicWriteJson(`${root}/auto.json`, { hours: 2, lastAutoAt: future, github: {} });
      const mockF2 = makeCtx({ home, dsh });
      plugin(mockF2.ctx, config);
      await new Promise((r) => setTimeout(r, 50));
      // 未来日期必须被拒 → 视为无锚点 → 从 now 起算，delay 应在 0 ~ 2h 之间，而非 500 年
      const delayMs = mockF2.timeouts[0]?.ms ?? -1;
      ok(delayMs >= 0 && delayMs <= 2 * 3600 * 1000, `未来日期被拒，delay 合理（${Math.round((delayMs) / 1000)}s，期望 ≤7200s）`);
      const stF = await mockF2.handler('auto status');
      ok(stF.text.includes('每 2 小时'), `auto 状态正常: ${stF.text.replace(/\n/g, ' ').slice(0, 60)}`);
      // 损坏的旧 auto.json（合法过去日期）仍能续跑
      const past = new Date(Date.now() - 3 * 3600 * 1000).toISOString();
      await atomicWriteJson(`${root}/auto.json`, { hours: 2, lastAutoAt: past, github: {} });
      const mockF3 = makeCtx({ home, dsh });
      plugin(mockF3.ctx, config);
      await new Promise((r) => setTimeout(r, 50));
      const delayPast = mockF3.timeouts[0]?.ms ?? -1;
      ok(delayPast >= 0 && delayPast <= 2 * 3600 * 1000, `过去合法 lastAutoAt 触发 catch-up（${Math.round(delayPast / 1000)}s）`);
    }

    console.log('15) F3 — 恢复前快照隔离（不进 list / latest 不误选 / 旧快照清理）');
    {
      const mockR = makeCtx({ home, dsh });
      plugin(mockR.ctx, config);
      const runR = mockR.handler;
      const beforeList = (await listArchives(root)).length;
      // 造一份干净备份用于恢复
      await runR('');
      const goodList = await listArchives(root);
      const good = goodList[0];
      await fs.writeFile(path.join(dsh, 'marker-f3.txt'), 'before-restore');
      // 实恢复（会生成 dsh-pre-restore-* 快照）
      const rR = await runR(`restore ${good}`);
      ok(rR.kind === 'success', `恢复成功（用于触发 pre-restore 快照）`);
      // (a) /backup list 不把它混进用户备份区，但在「内部快照」分区展示（可前缀选用）
      const listOut = await runR('list');
      ok(!listOut.text.includes(`已有备份`) || !/已有备份[^\n]*\n[^\n]*dsh-pre-restore-/.test(listOut.text), '用户备份区不含 pre-restore 快照');
      ok(listOut.text.includes('内部快照') && listOut.text.includes('dsh-pre-restore-') && listOut.text.includes('恢复前快照'), '内部快照分区展示 pre-restore');
      // (b) 磁盘上确实存在 pre-restore 快照（证明快照仍被创建，只是隔离）
      const diskAll = (await fs.readdir(root)).filter((n) => n.startsWith('dsh-pre-restore-') && n.endsWith('.tar.gz'));
      ok(diskAll.length === 1, `磁盘有 1 份 pre-restore 快照（实际 ${diskAll.length}）`);
      // (c) pre-restore 快照不在 listArchives → latest/前缀选择域不会误选快照
      const preName = diskAll[0];
      ok(!(await listArchives(root)).some((n) => n === preName), `pre-restore 快照不在 listArchives（${preName}）`);
      // (d) 再恢复一次 → 旧 pre-restore 快照被清理（仅留最新一份）
      await fs.writeFile(path.join(dsh, 'marker-f3b.txt'), 'second-restore');
      await runR(`restore ${good}`);
      const diskAll2 = (await fs.readdir(root)).filter((n) => n.startsWith('dsh-pre-restore-') && n.endsWith('.tar.gz'));
      ok(diskAll2.length === 1, `二次恢复后旧 pre-restore 快照已清理（仅留 1 份，实际 ${diskAll2.length}）`);
    }

    console.log('16) 凭据脱敏 + 本机 vault（P0）');
    {
      // 干净环境：新 home + 新 root，验证默认脱敏全链路
      const env16 = await mkTmpHome();
      try {
        const mock16 = makeCtx({ home: env16.home, dsh: env16.dsh });
        plugin(mock16.ctx, { destination: `~/Desktop/dsh-backups` });
        const r16 = await mock16.handler('');
        ok(r16.kind === 'success', '脱敏备份成功');
        const arch16 = (await listArchives(env16.root))[0];
        const list16 = await tarList(env16.root, arch16);
        ok(!list16.some((e) => e.includes('.credentials.yaml')), '归档不含 .credentials.yaml（脱敏生效）');
        const vaultFile = `${env16.root}/vault/.credentials.yaml`;
        ok(await fs.readFile(vaultFile, 'utf8').then((t) => t === 'api-key: secret', () => false), 'vault 保存明文凭据');
        const redacted16 = JSON.parse(await fs.readFile(`${env16.root}/${arch16}.redacted.json`, 'utf8'));
        ok(Array.isArray(redacted16.files) && redacted16.files.includes('.credentials.yaml'), '.redacted.json 边车记录脱敏清单');
        const meta16 = JSON.parse(await fs.readFile(`${env16.root}/${arch16}.meta.json`, 'utf8'));
        ok(typeof meta16.home === 'string' && meta16.home === env16.home && typeof meta16.host === 'string', '.meta.json 边车含主机/家目录');
        // 恢复（本机）：vault 自动还原凭据
        await fs.rm(env16.dsh, { recursive: true, force: true });
        const r16r = await mock16.handler('restore latest');
        ok(r16r.kind === 'success' && r16r.text.includes('已从本机 vault 补回'), `恢复后 vault 自动还原: ${r16r.text.split('\n').filter((l) => l.includes('vault')).join(' ')}`);
        ok(await fs.readFile(`${env16.dsh}/.credentials.yaml`, 'utf8').then((t) => t === 'api-key: secret', () => false), '~/.dsh 凭据从 vault 还原（内容一致）');
        // 跨机模拟：vault 清空后恢复 → 提示重填而非静默缺失
        await fs.rm(env16.dsh, { recursive: true, force: true });
        await fs.rm(`${env16.root}/vault`, { recursive: true, force: true });
        const r16x = await mock16.handler('restore latest');
        ok(r16x.kind === 'success' && r16x.text.includes('重填') && r16x.text.includes('.credentials.yaml'), `跨机恢复提示重填: ${r16x.text.split('\n').filter((l) => l.includes('重填')).join(' ')}`);
      } finally {
        await fs.rm(env16.dir, { recursive: true, force: true });
      }
    }

    console.log('17) 恢复预检：跨机 home 提示 + 脱敏/依赖提示（P1）');
    {
      const env17 = await mkTmpHome();
      try {
        await fs.mkdir(path.join(env17.dsh, 'profiles', 'web'), { recursive: true });
        await fs.writeFile(path.join(env17.dsh, 'profiles', 'web', 'package.json'), '{"dependencies":{"some-plugin":"^1.0.0"}}');
        const mockA = makeCtx({ home: env17.home, dsh: env17.dsh });
        plugin(mockA.ctx, { destination: `~/Desktop/dsh-backups` });
        await mockA.handler('');
        // “新机器”：同一备份目录，不同 home —— meta.home 不一致触发跨机提示
        const homeB = path.join(env17.dir, 'home-b');
        await fs.mkdir(homeB, { recursive: true });
        const mockB = makeCtx({ home: homeB, dsh: path.join(homeB, '.dsh') });
        plugin(mockB.ctx, { destination: env17.root });
        const pre = await mockB.handler('restore latest --dry-run');
        ok(pre.kind === 'success' && pre.text.includes('另一台机器'), `跨机 home 提示: ${pre.text.split('\n').filter((l) => l.includes('另一台')).join(' ')}`);
        ok(pre.text.includes('脱敏'), '预览提示归档已脱敏');
        ok(pre.text.includes('profile') && pre.text.includes('sync-deps'), '预览提示依赖需重装（--sync-deps）');
      } finally {
        await fs.rm(env17.dir, { recursive: true, force: true });
      }
    }

    console.log('18) github pull：新机拉取 + 校验转正（P1）');
    {
      const env18 = await mkTmpHome();
      try {
        // “旧机器”推送到 bare 远端
        const ghBare18 = path.join(env18.dir, 'bare.git');
        await new Promise((resolve) => {
          const c = spawn('git', ['init', '--bare', '-b', 'main', ghBare18], { stdio: 'ignore' });
          c.on('close', resolve);
        });
        const mockOld = makeCtx({ home: env18.home, dsh: env18.dsh });
        plugin(mockOld.ctx, { destination: `~/Desktop/dsh-backups`, githubRepo: ghBare18.split(path.sep).join('/') });
        await mockOld.handler('');
        const pushed18 = (await listArchives(env18.root)).slice();
        ok(pushed18.length === 1, '旧机器已推送 1 份');
        // “新机器”：同 root 但清空本地归档（模拟新机无备份），pull 拉回
        for (const n of pushed18) {
          await fs.rm(`${env18.root}/${n}`, { force: true });
          await fs.rm(`${env18.root}/${n}.sha256`, { force: true });
          await fs.rm(`${env18.root}/${n}.meta.json`, { force: true });
          await fs.rm(`${env18.root}/${n}.redacted.json`, { force: true });
        }
        const pullR = await mockOld.handler('github pull');
        ok(pullR.kind === 'success' && pullR.text.includes('已拉取 1 份'), `pull 拉回备份: ${pullR.text.split('\n')[0]}`);
        ok((await listArchives(env18.root)).length === 1, '拉回的归档已入列表');
        const ver18 = await mockOld.handler('verify');
        ok(ver18.kind === 'success', '拉回的归档校验通过');
        // 重复 pull：本地均已存在
        const pullR2 = await mockOld.handler('github pull');
        ok(pullR2.kind === 'success' && pullR2.text.includes('均已存在'), `重复 pull 幂等: ${pullR2.text.split('\n')[0]}`);
      } finally {
        await fs.rm(env18.dir, { recursive: true, force: true });
      }
    }

    console.log('19) RPC 方法名保留字预检（#2 事故防复发，issue #9）');
    const contrib19 = mock.typertContribs[0];
    const methods19 = contrib19 ? contrib19.invocations.map((d) => d.method) : [];
    ok(methods19.length === 12, `注册了 ${methods19.length} 个 RPC 方法（期望 12）`);
    let reservedHit = null;
    for (const name of methods19) {
      try { assertPanelMethodAvailable('backupPanel', name); } catch { reservedHit = name; }
    }
    ok(reservedHit === null, `现有方法名全部避开保留字${reservedHit ? `（撞上 ${reservedHit}）` : ''}`);
    let removeRejected = false;
    try { assertPanelMethodAvailable('backupPanel', 'remove'); } catch { removeRejected = true; }
    ok(removeRejected, '保留名 remove 会被预检拒绝');
    let toStringRejected = false;
    try { assertPanelMethodAvailable('backupPanel', 'toString'); } catch { toStringRejected = true; }
    ok(toStringRejected, 'Object.prototype 名 toString 会被预检拒绝');

    console.log('20) doctor：会话日志体检 + 定点修复');
    {
      const env20 = await mkTmpHome();
      try {
        const mock20 = makeCtx({ home: env20.home, dsh: env20.dsh });
        plugin(mock20.ctx, {});
        const sessDir = path.join(env20.dsh, 'sessions', '--proj--');
        // 五个会话目录先全部写入健康内容，再备份（归档持健康副本），最后弄坏三个现场
        const good = makeZstdSessionLog('sess-good');
        const rawLines = makeSessionLogLines('sess-raw');
        // raw 样本只取 header + 两条裸事件（packed 行属 zstd 帧布局，raw 版不带）
        const rawGood = Buffer.from(rawLines.slice(0, 3).join('\n'), 'utf8');
        const files = [
          ['enc-good', 'session.jsonl.zstd', good],
          ['raw-good', 'session.jsonl', rawGood],
          ['enc-magic', 'session.jsonl.zstd', good],
          ['enc-trunc', 'session.jsonl.zstd', makeZstdSessionLog('sess-trunc')],
          ['raw-gap', 'session.jsonl', rawGood],
        ];
        for (const [dirName, fileName, content] of files) {
          await fs.mkdir(path.join(sessDir, dirName), { recursive: true });
          await fs.writeFile(path.join(sessDir, dirName, fileName), content);
        }
        ok((await mock20.tool().execute({ mode: 'backup' }, {})).ok === true, 'doctor 场景备份成功');

        // 弄坏三个现场：坏魔数 / 截断帧 / seq 跳号
        await fs.writeFile(path.join(sessDir, 'enc-magic', 'session.jsonl.zstd'), Buffer.from('definitely not zstd output!!'));
        await fs.writeFile(path.join(sessDir, 'enc-trunc', 'session.jsonl.zstd'), good.subarray(0, good.length - 4));
        await fs.writeFile(
          path.join(sessDir, 'raw-gap', 'session.jsonl'),
          [makeSessionLogLines('x')[0], JSON.stringify({ type: 'user/message', seq: 0 }), JSON.stringify({ type: 'user/message', seq: 2 })].join('\n'),
        );

        const scan = await mock20.tool().execute({ mode: 'doctor' }, {});
        // 运行时自适应：Node ≥22.15/23.8 才有内置 zstd 解码。有 → 3 个损坏全检出；
        // 无（如 Node 20）→ zstd 文件进 skipped、只有 raw 跳号可检出——这正是
        // HAS_NODE_ZSTD 降级路径的实测。
        const { zstdDecompressSync: probe } = await import('node:zlib');
        const zstdOk = typeof probe === 'function';
        const expectBad = zstdOk ? 3 : 1;
        const dump = scan.corrupt.map((c) => `${c.path} ← ${c.reason}`).join(' | ');
        ok(scan.ok === false && scan.corruptCount === expectBad, `扫描检出 ${expectBad} 个损坏（实际 ${scan.corruptCount}）`);
        if (zstdOk) {
          ok(scan.corrupt.some((c) => c.path.includes('enc-magic')), `坏魔数检出: ${dump}`);
          ok(scan.corrupt.some((c) => c.path.includes('enc-trunc')), '截断帧检出');
        } else {
          ok(scan.skippedCount === 3, `无 zstd 运行时：3 个 .zstd 全部标记 skipped 而非损坏（实际 ${scan.skippedCount}）`);
          ok(scan.corrupt.every((c) => !c.path.endsWith('.zstd')), `损坏清单只含 raw 文件: ${dump}`);
          ok(scan.summary.includes('未能深度校验'), '扫描汇总提示 skipped');
        }
        ok(scan.corrupt.some((c) => c.path.includes('raw-gap') && c.reason.includes('期望 1')), 'seq 跳号检出');
        ok(!scan.corrupt.some((c) => c.path.includes('-good')), `健康文件零误报: ${dump}`);

        const cmdScan = await mock20.handler('doctor');
        ok(cmdScan.kind === 'error' && cmdScan.text.includes('/backup doctor --repair'), '命令面 doctor 报告损坏并提示修复用法');

        const repairTargets = zstdOk ? ['enc-magic', 'enc-trunc', 'raw-gap'] : ['raw-gap'];
        const repair = await mock20.tool().execute({ mode: 'doctor', selector: 'latest', repair: true }, {});
        ok(repair.ok === true && repair.repaired.length === expectBad, `定点修复 ${expectBad} 个（实际 ${repair.repaired.length}）`);
        if (zstdOk) {
          ok(await fs.readFile(path.join(sessDir, 'enc-magic', 'session.jsonl.zstd')).then((b) => b.equals(good)), '坏魔数文件已还原为健康字节');
        }
        ok(await fs.readFile(path.join(sessDir, 'raw-gap', 'session.jsonl'), 'utf8').then((t) => t === rawGood.toString('utf8')), 'seq 跳号文件已还原');
        let keptCount = 0;
        for (const dirName of repairTargets) {
          const names = await fs.readdir(path.join(sessDir, dirName));
          keptCount += names.filter((n) => n.includes('.corrupt-')).length;
        }
        ok(keptCount === expectBad, `损坏现场留档 *.corrupt-* ×${expectBad}（实际 ${keptCount}）`);

        const rescanCmd = await mock20.handler('doctor');
        ok(rescanCmd.kind === 'success', `修复后复扫全绿: ${rescanCmd.kind === 'error' ? rescanCmd.text.split('\n')[0] : ''}`);
      } finally {
        await fs.rm(env20.dir, { recursive: true, force: true });
      }
    }

    console.log('21) 老归档兼容：缺 meta/redacted 边车（v0.6.x 形态）');
    {
      const env21 = await mkTmpHome();
      try {
        const mock21 = makeCtx({ home: env21.home, dsh: env21.dsh });
        plugin(mock21.ctx, {});
        await mock21.handler('');
        const arch21 = (await listArchives(env21.root))[0];
        await fs.rm(`${env21.root}/${arch21}.meta.json`, { force: true });
        await fs.rm(`${env21.root}/${arch21}.redacted.json`, { force: true });
        const ver21 = await mock21.handler('verify');
        ok(ver21.kind === 'success', '无边车老归档 verify 通过（.sha256 自首版就有）');
        await fs.writeFile(path.join(env21.dsh, 'settings.json'), '{"a":9}');
        const pre21 = await mock21.handler('restore latest --dry-run');
        ok(pre21.kind === 'success', 'dry-run 预览成功');
        ok(!pre21.text.includes('🔐'), '不再出现脱敏预检行（静默降级）');
        ok(pre21.text.includes('未携带脱敏清单'), '提示老归档无凭据保障');
        const res21 = await mock21.handler('restore latest');
        ok(res21.kind === 'success', `全量恢复成功: ${res21.kind === 'success' ? '' : res21.text}`);
        ok(await fs.readFile(path.join(env21.dsh, 'settings.json'), 'utf8') === '{"a":1}', '内容回到备份时点');
      } finally {
        await fs.rm(env21.dir, { recursive: true, force: true });
      }
    }

    console.log('22) 空目标机恢复：~/.dsh 整个不存在');
    {
      const env22 = await mkTmpHome();
      const outside22 = path.join(env22.dir, 'outside-backups').split(path.sep).join('/');
      try {
        const mock22 = makeCtx({ home: env22.home, dsh: env22.dsh });
        plugin(mock22.ctx, { destination: outside22 });
        await mock22.handler('');
        await fs.rm(env22.dsh, { recursive: true, force: true });
        const res22 = await mock22.handler('restore latest');
        ok(res22.kind === 'success', `目标缺失时恢复成功: ${res22.kind === 'success' ? '' : res22.text}`);
        ok(!res22.text.includes('旧数据没丢') && !res22.text.includes('保险快照'), '无现有数据时不快照、不 aside');
        ok(await fs.readFile(path.join(env22.dsh, 'settings.json'), 'utf8') === '{"a":1}', '数据已解回 ~/.dsh');
        ok(await fs.readFile(path.join(env22.dsh, '.credentials.yaml'), 'utf8').then(() => true, () => false), '凭据从 vault 自动还原');
      } finally {
        await fs.rm(env22.dir, { recursive: true, force: true });
      }
    }

    console.log('23) 救援通道：进程外 rescue.mjs 实弹（CLI + webui HTTP）');
    {
      const env23 = await mkTmpHome();
      try {
        const mock23 = makeCtx({ home: env23.home, dsh: env23.dsh });
        plugin(mock23.ctx, {});
        const sessDir = path.join(env23.dsh, 'sessions', '--proj--');
        const good = makeZstdSessionLog('sess-r');
        const rawLines = makeSessionLogLines('sess-raw');
        const rawGood = Buffer.from(rawLines.slice(0, 3).join('\n'), 'utf8');
        await fs.mkdir(path.join(sessDir, 'enc-a'), { recursive: true });
        await fs.writeFile(path.join(sessDir, 'enc-a', 'session.jsonl.zstd'), good);
        await fs.mkdir(path.join(sessDir, 'raw-b'), { recursive: true });
        await fs.writeFile(path.join(sessDir, 'raw-b', 'session.jsonl'), rawGood);
        await mock23.handler('');

        const rescueFile = path.join(env23.root, 'rescue.mjs');
        ok(await fs.stat(rescueFile).then(() => true, () => false), 'rescue.mjs 已随备份落盘');
        ok(await fs.readFile(path.join(env23.root, 'RESCUE.txt'), 'utf8').then((t) => t.includes('双击'), () => false), 'RESCUE.txt 引导双击');
        const launcherName = process.platform === 'win32' ? '点我恢复.bat' : process.platform === 'darwin' ? '点我恢复.command' : '点我恢复.sh';
        ok(await fs.stat(path.join(env23.root, launcherName)).then(() => true, () => false), `双击启动器已生成（${launcherName}）`);

        const r = (args) => spawnSync(process.execPath, [rescueFile, ...args], { encoding: 'utf8', timeout: 120_000, env: { ...process.env, DSH_HOME: env23.dsh } });
        const list = r(['list']);
        ok(list.status === 0 && list.stdout.includes('dsh-'), `rescue list: ${(list.stdout || list.stderr).split('\n')[0]}`);
        const ver = r(['verify']);
        ok(ver.status === 0 && ver.stdout.includes('✅'), 'rescue verify 通过');

        // webui HTTP：页面可访问、缺自定义头的写操作被 403（CSRF 防御）
        const srv = spawn(process.execPath, [rescueFile, 'serve', '--port', '13197'], { env: { ...process.env, DSH_HOME: env23.dsh }, stdio: 'ignore' });
        try {
          let up = false;
          for (let i = 0; i < 24 && !up; i++) {
            await new Promise((rr) => setTimeout(rr, 250));
            up = await fetch('http://127.0.0.1:13197/').then((x) => x.ok).catch(() => false);
          }
          ok(up, '救援网页 serve 启动并响应');
          if (up) {
            const page = await fetch('http://127.0.0.1:13197/').then((x) => x.text());
            ok(page.includes('dsh-rescue') && page.includes('恢复'), '页面渲染（标题/恢复入口）');
            const noHdr = await fetch('http://127.0.0.1:13197/api/list', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
            ok(noHdr.status === 403, `缺自定义头的 POST 被拒（实际 ${noHdr.status}）`);
            const withHdr = await fetch('http://127.0.0.1:13197/api/list', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Dsh-Rescue': '1' }, body: '{}' }).then((x) => x.json());
            ok(withHdr.ok === true && Array.isArray(withHdr.backups), 'API list 正常返回备份');
          }
        } finally {
          srv.kill();
        }

        // doctor：弄坏 raw 文件 → rescue 检出并定点修复
        await fs.writeFile(path.join(sessDir, 'raw-b', 'session.jsonl'), [rawLines[0], JSON.stringify({ type: 'user/message', seq: 0 }), JSON.stringify({ type: 'user/message', seq: 5 })].join('\n'));
        const doc = r(['doctor']);
        ok(doc.status === 1 && doc.stdout.includes('raw-b'), `rescue doctor 检出损坏: ${(doc.stdout.match(/❌[^\n]*/) || ['(无)']).join(' ')}`);
        const rep = r(['doctor', '--repair']);
        ok(rep.status === 0 && rep.stdout.includes('复检全部健康'), `rescue doctor --repair: ${(rep.stdout || rep.stderr).split('\n')[0]}`);
        ok(await fs.readFile(path.join(sessDir, 'raw-b', 'session.jsonl'), 'utf8').then((t) => t === rawGood.toString('utf8')), 'rescue 修复后字节一致');

        // 空目标机恢复：整个 .dsh 删掉，rescue 独立拉回（vault 凭据还原）
        await fs.rm(env23.dsh, { recursive: true, force: true });
        const res = r(['restore', 'latest', '--yes']);
        ok(res.status === 0 && res.stdout.includes('恢复完成'), `rescue restore --yes: ${(res.stdout || res.stderr).split('\n').slice(0, 2).join(' | ')}`);
        ok(await fs.readFile(path.join(env23.dsh, 'settings.json'), 'utf8') === '{"a":1}', 'rescue 恢复出 settings.json');
        ok(await fs.readFile(path.join(env23.dsh, '.credentials.yaml'), 'utf8').then(() => true, () => false), 'rescue 从 vault 还原凭据');
      } finally {
        await fs.rm(env23.dir, { recursive: true, force: true });
      }
    }

    console.log('24) 智能备份：升级前快照 + 备份前体检联动 + 分级轮换');
    {
      const env24 = await mkTmpHome();
      const pad24 = (v, w = 2) => String(v).padStart(w, '0');
      const dayStr = (d) => `${d.getFullYear()}-${pad24(d.getMonth() + 1)}-${pad24(d.getDate())}`;
      try {
        // ---- B1 升级前快照：首见列车只记录；篡改 lastTrain 后重启触发 ----
        const mock24 = makeCtx({ home: env24.home, dsh: env24.dsh });
        plugin(mock24.ctx, {});
        // 二次备份压轴：首备份的落盘可能与钩子的"列车记录"乱序到达（原子写
        // last-wins），再备一次让其以赋值后的闭包状态收尾——终态确定可断言
        await mock24.handler('');
        await new Promise((rr) => setTimeout(rr, 60));
        await mock24.handler('');
        const pre0 = (await fs.readdir(env24.root)).filter((n) => n.startsWith('dsh-pre-upgrade-') && n.endsWith('.tar.gz'));
        ok(pre0.length === 0, '首次启动只记录列车，不拍升级快照');
        const autoPath = path.join(env24.root, 'auto.json');
        // 升级前快照的首次记录由启动钩子异步落盘（与首次备份并发），轮询等待
        let auto1 = null;
        for (let i = 0; i < 16 && !(auto1 && typeof auto1.lastTrain === 'string'); i += 1) {
          await new Promise((rr) => setTimeout(rr, 250));
          try {
            auto1 = JSON.parse(await fs.readFile(autoPath, 'utf8'));
          } catch { /* 尚未落盘 */ }
        }
        ok(auto1 && typeof auto1.lastTrain === 'string' && auto1.lastTrain, `auto.json 已记录宿主列车: ${JSON.stringify(auto1)}`);
        await fs.writeFile(autoPath, JSON.stringify({ ...auto1, lastTrain: '0.0.1-test-old' }));
        plugin(makeCtx({ home: env24.home, dsh: env24.dsh }).ctx, {});
        let preUpgrade = [];
        for (let i = 0; i < 40 && !(preUpgrade = (await fs.readdir(env24.root)).filter((n) => n.startsWith('dsh-pre-upgrade-') && n.endsWith('.tar.gz'))).length; i += 1) {
          await new Promise((rr) => setTimeout(rr, 250));
        }
        ok(preUpgrade.length === 1, `列车变化触发升级前快照（实际 ${preUpgrade.length}）`);
        ok(JSON.parse(await fs.readFile(autoPath, 'utf8')).lastTrain !== '0.0.1-test-old', 'lastTrain 已更新');
        const l24 = await mock24.handler('list');
        ok(l24.text.includes('内部快照') && l24.text.includes('升级前快照'), 'list 分区展示内部快照');
        ok(!(await listArchives(env24.root)).some((n) => n.startsWith('dsh-pre-upgrade-')), '用户备份列表不含内部快照');
        const preRestore24 = await mock24.handler(`restore ${preUpgrade[0].replace('.tar.gz', '')} --dry-run`);
        ok(preRestore24.kind === 'success' && preRestore24.text.includes('恢复预览'), '显式前缀可选中升级前快照');
        if (auto1 && typeof auto1.lastTrain === 'string') {
          // 再触发两次列车变化：快照最多保留最近 2 份
          const trainReal = auto1.lastTrain;
          for (const fake of ['0.0.2-test-old', '0.0.3-test-old']) {
            const aObj = JSON.parse(await fs.readFile(autoPath, 'utf8'));
            await fs.writeFile(autoPath, JSON.stringify({ ...aObj, lastTrain: fake }));
            plugin(makeCtx({ home: env24.home, dsh: env24.dsh }).ctx, {});
            for (let i = 0; i < 40; i += 1) {
              await new Promise((rr) => setTimeout(rr, 250));
              try {
                if (JSON.parse(await fs.readFile(autoPath, 'utf8')).lastTrain === trainReal) break;
              } catch { /* 等待落盘 */ }
            }
          }
          const preAll = (await fs.readdir(env24.root)).filter((n) => n.startsWith('dsh-pre-upgrade-') && n.endsWith('.tar.gz'));
          ok(preAll.length === 2, `升级前快照至多保留 2 份（实际 ${preAll.length}）`);
        }

        // ---- B2 备份前体检联动：坏会话不入档 + meta 记录 + 恢复预检提示 ----
        const sessDir = path.join(env24.dsh, 'sessions', '--proj--');
        const rawLines = makeSessionLogLines('q-raw');
        const rawGood = Buffer.from(rawLines.slice(0, 3).join('\n'), 'utf8');
        await fs.mkdir(path.join(sessDir, 'raw-q'), { recursive: true });
        await fs.writeFile(path.join(sessDir, 'raw-q', 'session.jsonl'), rawGood);
        // 先备一份含健康副本的归档，作为后续 doctor 定点修复的来源
        await mock24.handler('');
        const goodBk = (await listArchives(env24.root))[0];
        await fs.writeFile(
          path.join(sessDir, 'raw-q', 'session.jsonl'),
          [rawLines[0], JSON.stringify({ type: 'user/message', seq: 0 }), JSON.stringify({ type: 'user/message', seq: 9 })].join('\n'),
        );
        const bkQ = await mock24.handler('');
        ok(bkQ.kind === 'success' && bkQ.text.includes('未入档'), `回执出现隔离警告: ${(bkQ.text.match(/⚠️[^\n]*/) || ['(无)']).join('')}`);
        const qArchive = (await listArchives(env24.root))[0];
        ok(!((await tarList(env24.root, qArchive)).some((e) => e.includes('raw-q/session.jsonl'))), '损坏会话文件不在归档内（目录壳可有）');
        const qMeta = JSON.parse(await fs.readFile(`${env24.root}/${qArchive}.meta.json`, 'utf8'));
        ok(Array.isArray(qMeta.quarantined) && qMeta.quarantined.some((p) => p.includes('raw-q')), 'meta.quarantined 记录隔离清单');
        const preQ = await mock24.handler(`restore ${qArchive.replace('.tar.gz', '')} --dry-run`);
        ok(preQ.kind === 'success' && preQ.text.includes('体检隔离'), '恢复预检提示隔离文件');
        const repQ = await mock24.tool().execute({ mode: 'doctor', selector: goodBk.replace('.tar.gz', ''), repair: true }, {});
        ok(repQ.ok === true && repQ.repaired.length === 1, `doctor 从更早归档定点修复: ${repQ.summary.split('\n')[0]}`);

        // ---- B3 分级轮换：keep=1 之外，日级保 7 天、周级再保 4 周，其余删除 ----
        // 伪造旧归档（日期在名字里；内容复制现有归档，sha 边车同步复制仍有效）
        const srcArc = path.join(env24.root, qArchive);
        const fakeDays = [1, 2, 3, 4, 5, 6, 7, 30, 30, 37, 44, 51, 58];
        for (let i = 0; i < fakeDays.length; i += 1) {
          const dte = new Date(Date.now() - fakeDays[i] * 86400000);
          const name = `dsh-${dte.getFullYear()}${pad24(dte.getMonth() + 1)}${pad24(dte.getDate())}-${pad24(i % 24)}${pad24((i * 7) % 60)}${pad24((i * 13) % 60)}${pad24(i, 3)}.tar.gz`;
          for (const suf of ['', '.sha256', '.meta.json']) {
            await fs.copyFile(`${srcArc}${suf}`, `${env24.root}/${name}${suf}`);
          }
        }
        const bkT = await mock24.handler('--keep 1');
        ok(bkT.kind === 'success', `keep=1 备份成功: ${bkT.kind === 'success' ? '' : bkT.text}`);
        const afterNames = await listArchives(env24.root);
        const keptDays = new Set(afterNames.map((n) => { const m = /^dsh-(\d{4})(\d{2})(\d{2})-/.exec(n); return m ? `${m[1]}-${m[2]}-${m[3]}` : null; }));
        for (let dd = 1; dd <= 7; dd += 1) {
          ok(keptDays.has(dayStr(new Date(Date.now() - dd * 86400000))), `D-${dd} 的每日首份被分级保留`);
        }
        for (const dd of [30, 37, 44, 51]) {
          ok(keptDays.has(dayStr(new Date(Date.now() - dd * 86400000))), `D-${dd}（周级）被保留`);
        }
        ok(!keptDays.has(dayStr(new Date(Date.now() - 58 * 86400000))), 'D-58 超出周级预算被删除');
        const d30Count = afterNames.filter((n) => n.includes(`-${dayStr(new Date(Date.now() - 30 * 86400000)).split('-').join('')}`)).length;
        ok(d30Count === 1, `同日冗余只留首份（D-30 留 ${d30Count} 份）`);
      } finally {
        await fs.rm(env24.dir, { recursive: true, force: true });
      }
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
