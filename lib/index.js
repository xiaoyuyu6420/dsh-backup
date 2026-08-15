/**
 * dsh-backup — 一键备份与恢复 DeepSeek Harness 用户数据。
 *
 * 备份 ~/.dsh（会话、配置、技能、凭据、插件配置），排除可重装的
 * node_modules，生成 sha256 校验和，自动轮换旧备份；定时自动备份
 * 状态落盘、重启续跑；跨平台（macOS / Linux / Windows）。
 *
 * - `/backup`                              立即备份（默认到 ~/Desktop/dsh-backups/）
 * - `/backup list`                         列出已有备份（含大小）+ 自动备份状态
 * - `/backup verify [前缀|all]`            校验备份完整性（缺省校验最新一份）
 * - `/backup restore <前缀|latest> [--dry-run]`  恢复（先校验 + 自动快照当前数据）
 * - `/backup auto <N小时>|off|status`      定时自动备份（1~720；<24h 保留 3 份，否则 7 份）
 * - `/backup github status|sync`           GitHub 同步状态 / 立即同步
 * - `/backup --keep N`                     覆盖本次保留份数
 * - `backup_dsh` 模型工具：mode=backup|list|verify|restore|auto
 * - cordis.yml `config`：destination / keep / exclude / githubRepo（见 README）
 * - Settings「备份」标签页（Web）：状态、立即备份、校验、恢复、下载、
 *   自动备份开关与 GitHub 同步，经 `backupPanel` Typert Remote 命名空间访问
 * - Web 下载路由：GET /backup-download/<归档名>（仅 loopback，附件形式）
 *
 * 安全说明：备份包含明文凭据（.credentials.yaml、qq-bridge/config.json），
 * 归档与边车在 POSIX 上 chmod 600 仅本人可读写；请勿将备份目录同步到不受信位置。
 * GitHub 同步前请确认目标仓库是私有仓库。restore 会拒绝恢复含归档根目录之外
 * 条目的文件（tar 路径穿越防护）。
 *
 * 存储说明：插件自有数据（归档、校验和、auto.json）直接经 node:fs 写入
 * （与 dsh-session 持久化、skill-filesystem 同一模式）——ctx.fs 能力是
 * 模型面的沙箱 surface（workspace-write 会拒绝 Desktop），不适用于宿主
 * 插件的自有存储。
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, copyFile, readdir, readFile, stat as fsStat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';

export const name = 'dsh-backup';
export const inject = ['subprocess', 'commands', 'timer', 'tools'];

/** Windows 下的删除/移动没有 POSIX rm/mv 可用，统一走 cmd.exe 内置命令。 */
const IS_WIN = process.platform === 'win32';
/** sha256 回退路径（node:fs 读取 + node:crypto）的内存上限。 */
const HASH_MAX_BYTES = 256 * 1024 * 1024;
/** GitHub 单个文件 100MB 上限，留 10MB 余量。 */
const MAX_GITHUB_BYTES = 90 * 1024 * 1024;
/** 同步工作树目录名（位于备份目录下）。 */
const SYNC_DIR = '.github-sync';
/** Web 下载路由前缀（无尾斜杠：prefix 匹配语义为 pathname.startsWith(prefix + '/')）。 */
const DOWNLOAD_PREFIX = '/backup-download';

/**
 * `backupPanel` Remote 命名空间的调用描述符（src-json codec）。手工经
 * `ctx.typert.register()` 注册——运行时 registry 接受 src-json，免去 zod
 * 依赖；Web 客户端半边（lib/client.js）携带同一套端点的 strict zod 定义。
 */
function panelDescriptor(method, parameters, cancellation) {
  return Object.freeze({
    id: `dsh-backup#backupPanel/${method}`,
    service: 'backupPanel',
    namespace: 'backupPanel',
    method,
    invocation: Object.freeze({ kind: 'direct' }),
    parameters: Object.freeze(parameters.map((p) => Object.freeze({
      name: p,
      wire: p,
      source: 'json',
      codec: Object.freeze({ mode: 'src-json' }),
    }))),
    ...(cancellation ? { cancellation: Object.freeze({ parameter: 'signal' }) } : {}),
    result: Object.freeze({ mode: 'src-json' }),
  });
}

const PANEL_INVOCATIONS = Object.freeze([
  panelDescriptor('status', []),
  panelDescriptor('backup', ['keep'], true),
  panelDescriptor('verify', ['selector'], true),
  panelDescriptor('restore', ['selector', 'dryRun'], true),
  panelDescriptor('setAuto', ['hours']),
  panelDescriptor('githubStatus', []),
  panelDescriptor('githubSyncNow', [], true),
]);

/**
 * `backupPanel` 宿主服务：Settings 标签页的 RPC 面。方法签名与描述符的
 * parameters 顺序一致（取消型方法末位是 signal），实现全部委托 ops 闭包，
 * 与 `/backup` 命令、`backup_dsh` 工具共用同一套核心操作。
 */
class BackupPanelService extends TypertRemoteService {
  /** @param {import('@deepseek-ai/cordis').Context} ctx - 挂载上下文 */
  constructor(ctx, ops) {
    super(ctx, 'backupPanel');
    this.ops = ops;
  }

  /** 面板快照：目标目录、自动备份状态、备份清单。 */
  status() {
    return this.ops.status();
  }

  /** 立即备份。 */
  backup(keep, signal) {
    return this.ops.backup(keep, signal);
  }

  /** 校验（selector=前缀|all|latest）。 */
  verify(selector, signal) {
    return this.ops.verify(selector, signal);
  }

  /** 恢复（dryRun 仅预览）。 */
  restore(selector, dryRun, signal) {
    return this.ops.restore(selector, dryRun, signal);
  }

  /** 设置自动备份（0=关闭）。 */
  setAuto(hours) {
    return this.ops.setAuto(hours);
  }

  /** GitHub 同步状态。 */
  githubStatus() {
    return this.ops.githubStatus();
  }

  /** 立即推送到 GitHub。 */
  githubSyncNow(signal) {
    return this.ops.githubSyncNow(signal);
  }
}

export function apply(ctx, pluginConfig) {
  // ---------- 工具函数 ----------
  async function spawnRun(argv, cwd, signal) {
    const proc = ctx.subprocess.spawn({
      argv,
      cwd,
      graceMs: 5000,
      signal,
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: 8192, spill: { maxBytes: 1 << 20 } },
        stderr: { maxBytes: 8192, spill: { maxBytes: 1 << 20 } },
      },
    });
    const outcome = await proc.done;
    const out = proc.collected.stdout?.readFrom(0).text ?? '';
    const err = proc.collected.stderr?.readFrom(0).text ?? '';
    if (outcome.exitCode !== 0) {
      throw new Error(`命令失败 exit=${outcome.exitCode}: ${err || out}`);
    }
    return { out, err };
  }

  function paths() {
    const env = ctx.get('launchEnvironment');
    // Windows 上 launchEnvironment 无 HOME 时退回 USERPROFILE。
    // 统一成正斜杠：msys GNU tar 对反斜杠盘符路径的参数转换不可靠，
    // 而正斜杠路径 msys/bsdtar/POSIX tar 与 Node fs 都接受。
    const toFwd = (p) => (p.includes('\\') ? p.split('\\').join('/') : p);
    const homeRaw = env?.get('HOME')?.value || env?.get('USERPROFILE')?.value;
    const home = homeRaw ? toFwd(homeRaw.replace(/\/+$/, '')) : undefined;
    const dshHome = env?.get('DSH_HOME')?.value || (home ? `${home}/.dsh` : undefined);
    if (!home || !dshHome) throw new Error('无法解析 HOME/USERPROFILE 或 DSH_HOME（launchEnvironment 缺失）');
    const raw = typeof pluginConfig?.destination === 'string' && pluginConfig.destination.trim()
      ? pluginConfig.destination.trim()
      : '~/Desktop/dsh-backups';
    const root = raw.startsWith('~') ? `${home}${raw.slice(1)}` : toFwd(raw);
    return { home, dshHome: toFwd(dshHome), root };
  }

  function defaultKeep() {
    const k = Number(pluginConfig?.keep);
    return Number.isFinite(k) && k > 0 ? Math.floor(k) : 7;
  }

  function extraExcludes() {
    const list = Array.isArray(pluginConfig?.exclude) ? pluginConfig.exclude : [];
    return list.filter((p) => typeof p === 'string' && p.length > 0).map((p) => `--exclude=${p}`);
  }

  function stampNow() {
    const now = new Date();
    const pad = (n, w = 2) => String(n).padStart(w, '0');
    return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}${pad(now.getMilliseconds(), 3)}`;
  }

  /**
   * 删除 dir 下的文件。Windows 走 cmd del：cmd 内置命令不接受正斜杠路径、
   * 经 argv 转义的内嵌引号也会被破坏，因此统一以 dir 为 cwd、用纯文件名调用。
   */
  async function removeFiles(names, dir, signal) {
    if (!names.length) return;
    if (IS_WIN) {
      const cmd = await ctx.subprocess.resolveExecutable('cmd');
      await spawnRun([cmd, '/d', '/c', `del /f /q ${names.join(' ')}`], dir, signal);
    } else {
      const rm = await ctx.subprocess.resolveExecutable('rm');
      await spawnRun([rm, '-f', ...names.map((n) => `${dir}/${n}`)], dir, signal);
    }
  }

  /** 把 dir 下的文件/目录改名为同目录下的另一个名字（恢复时挪开现有数据）。 */
  async function renameBeside(dir, srcName, dstName, signal) {
    if (IS_WIN) {
      const cmd = await ctx.subprocess.resolveExecutable('cmd');
      await spawnRun([cmd, '/d', '/c', `move /y ${srcName} ${dstName}`], dir, signal);
    } else {
      const mv = await ctx.subprocess.resolveExecutable('mv');
      await spawnRun([mv, `${dir}/${srcName}`, `${dir}/${dstName}`], dir, signal);
    }
  }

  async function listBackups() {
    const { root } = paths();
    let dirents;
    try {
      dirents = await readdir(root, { withFileTypes: true });
    } catch {
      // 备份目录尚不存在（首次使用）——视为空列表而非错误
      return [];
    }
    const backups = [];
    for (const d of dirents) {
      if (!d.name.startsWith('dsh-') || !d.name.endsWith('.tar.gz')) continue;
      let size;
      try {
        size = (await fsStat(`${root}/${d.name}`)).size;
      } catch {
        size = undefined;
      }
      backups.push({ name: d.name, size });
    }
    return backups.sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));
  }

  async function writeOwned(p, content) {
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, content, 'utf8');
  }

  // 校验和：POSIX 优先 sha256sum（macOS 回退 shasum）流式计算；
  // 都不可用时（Windows）回退 node:fs 读取 + node:crypto 内存哈希。
  async function sha256File(absPath, home, signal) {
    for (const candidate of [['sha256sum', []], ['shasum', ['-a', '256']]]) {
      try {
        const bin = await ctx.subprocess.resolveExecutable(candidate[0]);
        const r = await spawnRun([bin, ...candidate[1], absPath], home, signal);
        const h = r.out.trim().split(/\s+/)[0];
        if (/^[0-9a-f]{64}$/.test(h)) return h;
        throw new Error(`无法解析 ${candidate[0]} 输出`);
      } catch {
        // 尝试下一个
      }
    }
    const info = await fsStat(absPath);
    if (info.size > HASH_MAX_BYTES) {
      throw new Error(`计算 sha256 失败：文件 ${Math.floor(info.size / 1048576)}MB 超过 ${Math.floor(HASH_MAX_BYTES / 1048576)}MB 回退上限`);
    }
    const bytes = await readFile(absPath);
    return createHash('sha256').update(bytes).digest('hex');
  }

  async function doBackup(keep, signal) {
    const { home, dshHome, root } = paths();
    const keepN = keep && keep > 0 ? Math.floor(keep) : defaultKeep();
    // 状态文件先写：writeText 会自动创建备份目录，替代 mkdir -p（Windows 无 mkdir.exe）。
    await saveAutoState();

    const name = `dsh-${stampNow()}.tar.gz`;
    const out = `${root}/${name}`;
    const base = dshHome.split('/').pop();
    const parent = dshHome.slice(0, -(base.length + 1)) || '/';

    // tar 以备份目录为 cwd、用纯文件名传 -f：Windows 上 GNU tar（msys）会把
    // 含盘符冒号的绝对路径当远程归档（"Cannot connect to C"），bsdtar 则两者皆可。
    const tar = await ctx.subprocess.resolveExecutable('tar');
    await spawnRun([tar, '--exclude=*node_modules*', '--exclude=.system', ...extraExcludes(), '-czf', name, '-C', parent, base], root, signal);

    const shaText = await sha256File(out, home, signal);
    await writeOwned(`${out}.sha256`, `${shaText}  ${out}\n`);

    // 安全：备份含明文凭据（.credentials.yaml / qq-bridge/config.json），收紧为仅本人可读写。
    // Windows 无 chmod，用户目录 ACL 默认私有。
    if (!IS_WIN) {
      const chmod = await ctx.subprocess.resolveExecutable('chmod');
      await spawnRun([chmod, '600', out, `${out}.sha256`], home, signal);
    }

    // 轮换：只保留最近 keepN 份
    const all = await listBackups();
    const stale = all.slice(keepN).map((b) => b.name);
    if (stale.length) {
      await removeFiles(stale.flatMap((n) => [n, `${n}.sha256`]), root, signal);
    }

    // GitHub 同步（失败不回滚备份；状态记入 auto.json）
    let sync = null;
    try {
      sync = await githubSync(signal);
      if (sync.pushed) {
        githubState = { repo: githubConfig()?.repo ?? null, lastPush: sync.at, lastError: null };
        await saveAutoState();
      } else if (sync.error) {
        githubState = { ...githubState, lastError: sync.error };
        await saveAutoState();
      }
    } catch (err) {
      const message = String(err && err.message ? err.message : err);
      sync = { error: message };
      githubState = { ...githubState, lastError: message };
      await saveAutoState();
    }

    return { path: out, sha: shaText, total: all.length, stale: stale.length, keep: keepN, sync };
  }

  // ---------- GitHub 同步 ----------
  function githubConfig() {
    const raw = typeof pluginConfig?.githubRepo === 'string' && pluginConfig.githubRepo.trim()
      ? pluginConfig.githubRepo.trim()
      : '';
    if (!raw) return null;
    const env = ctx.get('launchEnvironment');
    const token = env?.get('DSH_BACKUP_GITHUB_TOKEN')?.value || env?.get('GITHUB_TOKEN')?.value;
    // 本地路径（测试/自托管）或 http(s) 全 URL 直接使用，否则视为 owner/repo。
    const repo = raw.includes('://') || /^[A-Za-z]:[\\/]|^\//.test(raw) ? raw : `https://github.com/${raw}.git`;
    return { repo: repo.split('\\').join('/'), token };
  }

  /**
   * 把当前备份集推送到 GitHub 仓库。工作树位于 `<备份目录>/.github-sync`：
   * 归档与边车复制进去，git add -A 同时记录轮换删除，commit 后
   * `push HEAD:main --force-with-lease`。https 远端的 token 只写入工作树内
   * 的 .git-credentials（credential helper），不进进程参数。
   */
  async function githubSync(signal) {
    const { root } = paths();
    const cfg = githubConfig();
    if (!cfg) return { skipped: '未配置 githubRepo（cordis.yml config.githubRepo）' };
    if (cfg.repo.startsWith('https://') && !cfg.token) {
      return { skipped: 'https 远端缺少 token（环境变量 DSH_BACKUP_GITHUB_TOKEN 或 GITHUB_TOKEN）' };
    }
    const syncDir = `${root}/${SYNC_DIR}`;
    const git = await ctx.subprocess.resolveExecutable('git');
    await mkdir(syncDir, { recursive: true });

    const hasGit = await fsStat(`${syncDir}/.git`).then(() => true, () => false);
    if (!hasGit) {
      try {
        await spawnRun([git, 'init', '-b', 'main'], syncDir, signal);
      } catch {
        await spawnRun([git, 'init'], syncDir, signal);
        await spawnRun([git, 'branch', '-M', 'main'], syncDir, signal);
      }
    }
    const remotes = await spawnRun([git, 'remote', '-v'], syncDir, signal);
    if (!remotes.out.includes('origin')) {
      await spawnRun([git, 'remote', 'add', 'origin', cfg.repo], syncDir, signal);
    }
    if (cfg.token) {
      // 正斜杠路径：msys git 会把反斜杠绝对路径当相对路径解析（怪名化）
      const creds = `${syncDir}/.git-credentials`;
      await writeOwned(creds, `https://x-access-token:${cfg.token}@github.com\n`);
      if (!IS_WIN) {
        const chmod = await ctx.subprocess.resolveExecutable('chmod');
        await spawnRun([chmod, '600', creds], syncDir, signal);
      }
      await spawnRun([git, 'config', 'credential.helper', `store --file=${creds}`], syncDir, signal);
    }
    // token 文件绝不能进仓库：git add -A 会把它当普通文件提交
    await writeOwned(`${syncDir}/.gitignore`, '.git-credentials\n');

    // 镜像工作树：只保留 .gitignore 与当前备份集（归档+边车），其余一切
    // 文件（旧副本、凭据残留、误入杂物）清理——git add -A 因此只会收录
    // 归档；轮换删除与误入文件一并同步移除。
    const keep = new Set(['.gitignore']);
    for (const b of await listBackups()) {
      keep.add(b.name);
      keep.add(`${b.name}.sha256`);
    }
    let entries = [];
    try {
      entries = await readdir(syncDir, { withFileTypes: true });
    } catch {
      entries = [];
    }
    const stale = entries
      .filter((e) => e.isFile() && !keep.has(e.name))
      .map((e) => e.name);
    if (stale.length) await removeFiles(stale, syncDir, signal);

    const tooBig = [];
    for (const b of await listBackups()) {
      const size = b.size ?? (await fsStat(`${root}/${b.name}`).then((s) => s.size, () => 0));
      if (size > MAX_GITHUB_BYTES) {
        tooBig.push(b.name);
        continue;
      }
      await copyFile(`${root}/${b.name}`, `${syncDir}/${b.name}`);
      await copyFile(`${root}/${b.name}.sha256`, `${syncDir}/${b.name}.sha256`);
    }
    await spawnRun([git, 'add', '-A'], syncDir, signal);
    const status = await spawnRun([git, 'status', '--porcelain'], syncDir, signal);
    if (!status.out.trim()) return { skipped: '无变更', tooBig };

    const message = `backup ${new Date().toISOString()}`;
    await spawnRun([git, '-c', 'user.name=dsh-backup', '-c', 'user.email=dsh-backup@users.noreply.github.com', 'commit', '-m', message], syncDir, signal);
    await spawnRun([git, 'push', 'origin', 'HEAD:main', '--force-with-lease'], syncDir, signal);
    return { pushed: true, at: new Date().toISOString(), tooBig };
  }

  function summarizeSync(s) {
    if (s.error) return `⚠️ GitHub 同步失败: ${s.error}`;
    if (s.pushed) return `✅ GitHub 同步完成: ${s.at}${s.tooBig?.length ? `\n跳过超大文件: ${s.tooBig.join(', ')}` : ''}`;
    return `GitHub 同步: ${s.skipped || '无变更'}${s.tooBig?.length ? `\n跳过超大文件: ${s.tooBig.join(', ')}` : ''}`;
  }

  // ---------- Web 下载路由（仅 loopback，附件形式） ----------
  async function handleDownload(req, res) {
    try {
      const host = String(req.headers?.host || '');
      if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host)) {
        res.writeHead(403);
        res.end('forbidden');
        return;
      }
      const pathname = new URL(req.url || '', 'http://x').pathname;
      const name = decodeURIComponent(pathname.slice(DOWNLOAD_PREFIX.length).replace(/^\//, ''));
      if (!/^dsh-[A-Za-z0-9._-]+\.tar\.gz$/.test(name)) {
        res.writeHead(400);
        res.end('bad name');
        return;
      }
      const { root } = paths();
      const abs = `${root}/${name}`;
      await fsStat(abs);
      res.writeHead(200, {
        'Content-Type': 'application/gzip',
        'Content-Disposition': `attachment; filename="${name}"`,
      });
      createReadStream(abs).on('error', () => { res.destroy(); }).pipe(res);
    } catch {
      if (!res.headersSent) res.writeHead(404);
      res.end();
    }
  }

  // ---------- 校验与恢复 ----------
  async function verifyOne(name, home, signal) {
    const { root } = paths();
    const archive = `${root}/${name}`;
    let expected = '';
    try {
      const text = await readFile(`${archive}.sha256`, 'utf8');
      expected = text.trim().split(/\s+/)[0];
    } catch {
      // 边车缺失
    }
    if (!/^[0-9a-f]{64}$/.test(expected)) {
      return { name, ok: false, note: '缺少或无效的 .sha256 边车文件' };
    }
    const actual = await sha256File(archive, home, signal);
    return { name, ok: actual === expected, note: actual === expected ? '完整' : 'sha256 不匹配（归档已损坏）' };
  }

  async function pickArchive(selector) {
    const all = await listBackups();
    if (!all.length) throw new Error('暂无备份');
    if (!selector || selector === 'latest') return all[0];
    const exact = all.filter((b) => b.name === selector);
    const hits = exact.length ? exact : all.filter((b) => b.name.startsWith(selector));
    if (hits.length === 1) return hits[0];
    if (!hits.length) throw new Error(`没有匹配 "${selector}" 的备份，/backup list 查看`);
    throw new Error(`"${selector}" 匹配多份备份，请加长前缀：\n${hits.slice(0, 5).map((b) => `  ${b.name}`).join('\n')}`);
  }

  async function restoreArchive(selector, dryRun, signal) {
    const { home, dshHome, root } = paths();
    const picked = await pickArchive(selector);
    const archive = `${root}/${picked.name}`;

    // 恢复前强制校验：损坏的归档绝不覆盖现有数据。
    const v = await verifyOne(picked.name, home, signal);
    if (!v.ok) throw new Error(`校验未通过（${v.note}），恢复已中止`);

    const base = dshHome.split('/').pop();
    const parent = dshHome.slice(0, -(base.length + 1)) || '/';
    const tar = await ctx.subprocess.resolveExecutable('tar');
    // 同 doBackup：cwd 为备份目录，-f 用纯文件名，规避 Windows GNU tar 的盘符冒号问题。
    const listed = await spawnRun([tar, '-tzf', picked.name], root, signal);
    const entries = listed.out.split('\n').map((s) => s.trim()).filter(Boolean);
    // tar 路径穿越防护：归档由本插件生成，条目必须都在备份根目录之下。
    const bad = entries.filter((e) => e !== base && !e.startsWith(`${base}/`));
    if (bad.length) {
      throw new Error(`归档包含 "${base}/" 之外的条目（疑似被替换）：${bad.slice(0, 3).join(', ')}，恢复已中止`);
    }

    if (dryRun) return { archive, files: entries.length, sample: entries.slice(0, 12), aside: null, snapshotPath: null, dryRun: true };

    // 恢复前自动快照当前数据，并把当前数据移到旁边（而非合并覆盖）。
    const snapshot = await doBackup(undefined, signal);
    let aside = null;
    let current = false;
    try {
      await fsStat(dshHome);
      current = true;
    } catch {
      current = false;
    }
    if (current) {
      const asideName = `${base}.pre-restore-${stampNow()}`;
      await renameBeside(parent, base, asideName, signal);
      aside = `${parent}/${asideName}`;
    }
    await spawnRun([tar, '-xzf', picked.name, '-C', parent], root, signal);
    return { archive, files: entries.length, sample: [], aside, snapshotPath: snapshot.path, dryRun: false };
  }

  // ---------- 自动备份与 GitHub 同步状态（落盘，重启续跑） ----------
  let autoDispose = null;
  let autoHours = 0;
  let lastAuto = null;
  let githubState = { repo: null, lastPush: null, lastError: null };

  async function saveAutoState() {
    const { root } = paths();
    await writeOwned(`${root}/auto.json`, `${JSON.stringify({ hours: autoHours, github: githubState })}\n`);
  }

  async function loadAutoState() {
    try {
      const { root } = paths();
      const parsed = JSON.parse(await readFile(`${root}/auto.json`, 'utf8'));
      const h = Number(parsed?.hours);
      if (parsed?.github && typeof parsed.github === 'object') {
        githubState = {
          repo: typeof parsed.github.repo === 'string' ? parsed.github.repo : null,
          lastPush: typeof parsed.github.lastPush === 'string' ? parsed.github.lastPush : null,
          lastError: typeof parsed.github.lastError === 'string' ? parsed.github.lastError : null,
        };
      }
      return Number.isFinite(h) && h >= 1 && h <= 720 ? Math.floor(h) : 0;
    } catch {
      return 0;
    }
  }

  function autoSummary() {
    if (!autoDispose) return '自动备份未开启（/backup auto <N小时> 开启）';
    const next = new Date(Date.now() + autoHours * 3600 * 1000).toLocaleString();
    return `自动备份已开启：每 ${autoHours} 小时一次（已持久化，重启续跑），下次约 ${next}${lastAuto ? `；上次自动备份: ${lastAuto}` : ''}`;
  }

  async function runAutoBackup() {
    try {
      const r = await doBackup(autoHours >= 24 ? 7 : 3);
      lastAuto = r.path.split('/').pop();
      console.log(`[dsh-backup] 自动备份完成: ${r.path} (sha ${r.sha.slice(0, 12)}…)`);
    } catch (err) {
      console.error(`[dsh-backup] 自动备份失败: ${String(err && err.message ? err.message : err)}`);
    }
  }

  async function setAuto(h) {
    if (autoDispose) { autoDispose(); autoDispose = null; }
    autoHours = h;
    if (h > 0) autoDispose = ctx.interval(runAutoBackup, h * 3600 * 1000);
    await saveAutoState();
  }

  // ---------- /backup 命令 ----------
  ctx.commands.register({
    name: 'backup',
    description: '备份/恢复 DSH 数据；子命令: list | verify [前缀|all] | restore <前缀|latest> [--dry-run] | auto [N小时|off] | [--keep N]',
    handler: async (invocation) => {
      const input = invocation.rawInput.trim();
      try {
        const parts = input.split(/\s+/).filter(Boolean);
        const head = parts[0] || '';
        const { home } = paths();

        if (head === 'list') {
          const all = await listBackups();
          const total = all.reduce((s, b) => s + (b.size || 0), 0);
          const lines = all.map((b) => `  ${b.name}${b.size !== undefined ? `  ${(b.size / 1048576).toFixed(1)}MB` : ''}`);
          const text = all.length
            ? `已有备份 (${all.length} 份，共 ${(total / 1048576).toFixed(1)}MB):\n${lines.join('\n')}\n\n${autoSummary()}`
            : `暂无备份。输入 /backup 执行首次备份。\n\n${autoSummary()}`;
          return { kind: 'success', text };
        }

        if (head === 'verify') {
          const sel = parts[1] || 'latest';
          const names = sel === 'all'
            ? (await listBackups()).map((b) => b.name)
            : [(await pickArchive(sel)).name];
          const results = [];
          for (const n of names) results.push(await verifyOne(n, home, invocation.signal));
          const bad = results.filter((r) => !r.ok);
          const text = results.map((r) => `${r.ok ? '✅' : '❌'} ${r.name} — ${r.note}`).join('\n');
          return bad.length
            ? { kind: 'error', text: `${text}\n${bad.length} 份校验失败；损坏归档可删除后重新 /backup。` }
            : { kind: 'success', text: text || '暂无备份可校验。' };
        }

        if (head === 'restore') {
          const dryRun = parts.includes('--dry-run');
          const sel = parts.slice(1).find((t) => !t.startsWith('--')) || 'latest';
          const r = await restoreArchive(sel, dryRun, invocation.signal);
          if (r.dryRun) {
            return { kind: 'success', text: `📦 恢复预览（未写入）\n  归档: ${r.archive}\n  条目: ${r.files} 项\n${r.sample.map((s) => `    ${s}`).join('\n')}` };
          }
          return {
            kind: 'success',
            text: `✅ 恢复完成\n  来源: ${r.archive}（${r.files} 项）\n  恢复前快照: ${r.snapshotPath}\n${r.aside ? `  旧数据已移至: ${r.aside}\n` : ''}  请重启 dsh 使恢复的会话与配置生效。`,
          };
        }

        if (head === 'github') {
          const arg = parts[1] || 'status';
          if (arg === 'status') {
            const cfg = githubConfig();
            const text = cfg
              ? `GitHub 同步: ${cfg.repo}\n  token: ${cfg.token ? '已配置' : '未配置（https 远端需要）'}\n  ${githubState.lastPush ? `上次推送: ${githubState.lastPush}` : '尚未推送过'}\n  ${githubState.lastError ? `上次错误: ${githubState.lastError}` : ''}`
              : 'GitHub 同步未配置：在 cordis.yml 的 config.githubRepo 设置仓库（如 user/backup-repo）。';
            return { kind: 'success', text };
          }
          if (arg === 'sync') {
            const s = await githubSync(invocation.signal);
            if (s.pushed) {
              githubState = { repo: githubConfig()?.repo ?? null, lastPush: s.at, lastError: null };
              await saveAutoState();
            } else if (s.error) {
              githubState = { ...githubState, lastError: s.error };
              await saveAutoState();
            }
            return { kind: 'success', text: summarizeSync(s) };
          }
          return { kind: 'error', text: '用法: /backup github status|sync' };
        }

        if (head === 'auto') {
          const arg = parts[1];
          if (!arg || arg === 'status') return { kind: 'success', text: autoSummary() };
          if (arg === 'off' || arg === '0') {
            await setAuto(0);
            return { kind: 'success', text: '自动备份已关闭。' };
          }
          const h = Number(arg);
          if (!Number.isFinite(h) || h < 1 || h > 720) {
            return { kind: 'error', text: '小时数需为 1~720 之间的数字（如 /backup auto 12）' };
          }
          await setAuto(h);
          return { kind: 'success', text: `✅ 自动备份已开启：每 ${h} 小时执行一次（保留 ${h >= 24 ? 7 : 3} 份，已持久化）。\n${autoSummary()}` };
        }

        let keep;
        const m = input.match(/--keep\s+(\d+)/);
        if (m) keep = Number(m[1]);
        const r = await doBackup(keep, invocation.signal);
        return {
          kind: 'success',
          text: `✅ 备份完成\n  文件: ${r.path}\n  校验和: ${r.sha.slice(0, 16)}…\n  轮换: 删除 ${r.stale} 份旧备份（保留 ${r.keep} 份）\n  ${autoSummary()}`,
        };
      } catch (err) {
        return { kind: 'error', text: `备份失败: ${String(err && err.message ? err.message : err)}` };
      }
    },
  });

  // ---------- backup_dsh 模型工具 ----------
  ctx.tools.register(defineTool({
    name: 'backup_dsh',
    description: '备份、校验或恢复 DSH 用户数据（~/.dsh 的会话、配置、技能、凭据）。mode=backup 立即备份（keep 指定保留份数）；mode=list 列出备份；mode=verify 校验完整性（selector=前缀或 all，缺省最新一份）；mode=restore 恢复（selector=前缀或 latest，dryRun 仅预览；恢复前自动校验并快照当前数据）；mode=auto 设置定时备份（hours 间隔小时数，0=关闭，缺省查询）。注意：备份包含明文凭据，请勿将备份目录同步到不受信位置。',
    parameters: {
      mode: { type: 'string', required: true, enum: ['backup', 'list', 'verify', 'restore', 'auto'], description: 'backup=执行备份，list=列出备份，verify=校验完整性，restore=恢复，auto=定时备份' },
      keep: { type: 'number', description: '保留的备份份数（mode=backup，默认 7）' },
      hours: { type: 'number', description: '定时备份间隔小时数（mode=auto；0=关闭；缺省=查询状态）' },
      selector: { type: 'string', description: '备份选择器（mode=verify/restore）：归档名前缀、latest 或 all' },
      dryRun: { type: 'boolean', description: 'mode=restore 时仅预览恢复内容，不写入' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: String(value.summary) }],
    },
    execute: async (args, exec) => {
      const mode = args && args.mode ? args.mode : 'backup';
      const signal = exec && exec.signal ? exec.signal : undefined;
      const selector = args && typeof args.selector === 'string' && args.selector ? args.selector : undefined;
      try {
        if (mode === 'list') {
          const all = await listBackups();
          return { ok: true, summary: `已有 ${all.length} 份备份:\n${all.map((b) => `  ${b.name}`).join('\n') || '（无）'}\n\n${autoSummary()}` };
        }
        if (mode === 'verify') {
          const { home } = paths();
          const sel = selector || 'latest';
          const names = sel === 'all' ? (await listBackups()).map((b) => b.name) : [(await pickArchive(sel)).name];
          const lines = [];
          let bad = 0;
          for (const n of names) {
            const r = await verifyOne(n, home, signal);
            if (!r.ok) bad += 1;
            lines.push(`${r.ok ? '✅' : '❌'} ${r.name} — ${r.note}`);
          }
          return { ok: bad === 0, summary: lines.join('\n') || '暂无备份可校验。' };
        }
        if (mode === 'restore') {
          const r = await restoreArchive(selector || 'latest', Boolean(args && args.dryRun), signal);
          if (r.dryRun) return { ok: true, summary: `恢复预览（未写入）: ${r.archive}\n条目 ${r.files} 项，含:\n${r.sample.map((s) => `  ${s}`).join('\n')}` };
          return {
            ok: true,
            path: r.archive,
            summary: `恢复完成: ${r.archive}（${r.files} 项）\n恢复前快照: ${r.snapshotPath}\n${r.aside ? `旧数据已移至: ${r.aside}\n` : ''}请重启 dsh 生效。`,
          };
        }
        if (mode === 'auto') {
          const h = args && args.hours !== undefined ? args.hours : null;
          if (h === null) return { ok: true, summary: autoSummary() };
          if (h === 0) {
            await setAuto(0);
            return { ok: true, summary: '自动备份已关闭。' };
          }
          if (!Number.isFinite(h) || h < 1 || h > 720) return { ok: false, summary: 'hours 需为 1~720' };
          await setAuto(h);
          return { ok: true, summary: `自动备份已开启：每 ${h} 小时一次（已持久化）。\n${autoSummary()}` };
        }
        const r = await doBackup(args && args.keep ? args.keep : undefined, signal);
        return { ok: true, path: r.path, sha: r.sha, summary: `备份完成: ${r.path}\nsha256: ${r.sha}\n轮换删除 ${r.stale} 份（保留 ${r.keep} 份）` };
      } catch (err) {
        return { ok: false, summary: `操作失败: ${String(err && err.message ? err.message : err)}` };
      }
    },
  }));

  // ---------- Settings 面板（Web）：backupPanel Remote ----------
  const panelOps = {
    status: async () => {
      const all = await listBackups();
      const { root, dshHome } = paths();
      return {
        destination: root,
        dshHome,
        keepDefault: defaultKeep(),
        autoHours,
        lastAuto,
        backups: all.map((b) => ({ name: b.name, size: typeof b.size === 'number' ? b.size : null })),
      };
    },
    backup: async (keep, signal) => {
      const r = await doBackup(keep, signal);
      return {
        ok: true,
        summary: `备份完成: ${r.path}\nsha256: ${r.sha}\n轮换删除 ${r.stale} 份（保留 ${r.keep} 份）`,
        path: r.path,
        sha: r.sha,
        stale: r.stale,
        keep: r.keep,
      };
    },
    verify: async (selector, signal) => {
      const { home } = paths();
      const sel = selector || 'latest';
      const names = sel === 'all'
        ? (await listBackups()).map((b) => b.name)
        : [(await pickArchive(sel)).name];
      const results = [];
      let bad = 0;
      for (const n of names) {
        const r = await verifyOne(n, home, signal);
        if (!r.ok) bad += 1;
        results.push({ name: r.name, ok: r.ok, note: r.note });
      }
      return { ok: bad === 0, summary: results.map((r) => `${r.ok ? '✅' : '❌'} ${r.name} — ${r.note}`).join('\n') || '暂无备份可校验。', results };
    },
    restore: async (selector, dryRun, signal) => {
      try {
        const r = await restoreArchive(selector || 'latest', Boolean(dryRun), signal);
        if (r.dryRun) {
          return { ok: true, dryRun: true, archive: r.archive, files: r.files, sample: r.sample, summary: `归档 ${r.files} 项` };
        }
        return {
          ok: true,
          dryRun: false,
          archive: r.archive,
          files: r.files,
          aside: r.aside,
          snapshotPath: r.snapshotPath,
          summary: `恢复完成（${r.files} 项）${r.aside ? `\n旧数据已移至 ${r.aside}` : ''}\n请重启 dsh 生效。`,
        };
      } catch (err) {
        return { ok: false, dryRun: Boolean(dryRun), summary: String(err && err.message ? err.message : err) };
      }
    },
    setAuto: async (hours) => {
      if (hours === 0) {
        await setAuto(0);
        return { ok: true, hours: 0, summary: '自动备份已关闭。' };
      }
      if (!Number.isFinite(hours) || hours < 1 || hours > 720) {
        return { ok: false, summary: 'hours 需为 1~720（0=关闭）' };
      }
      await setAuto(Math.floor(hours));
      return { ok: true, hours: Math.floor(hours), summary: autoSummary() };
    },
    githubStatus: async () => {
      const cfg = githubConfig();
      const { root } = paths();
      return {
        repo: cfg ? cfg.repo : null,
        tokenSet: Boolean(cfg?.token),
        syncDir: `${root}/${SYNC_DIR}`,
        lastPush: githubState.lastPush,
        lastError: githubState.lastError,
      };
    },
    githubSyncNow: async (signal) => {
      try {
        const s = await githubSync(signal);
        if (s.pushed) {
          githubState = { repo: githubConfig()?.repo ?? null, lastPush: s.at, lastError: null };
          await saveAutoState();
        } else if (s.error) {
          githubState = { ...githubState, lastError: s.error };
          await saveAutoState();
        }
        return { ok: true, summary: summarizeSync(s), pushed: Boolean(s.pushed), tooBig: s.tooBig ?? [] };
      } catch (err) {
        const message = String(err && err.message ? err.message : err);
        githubState = { ...githubState, lastError: message };
        await saveAutoState();
        return { ok: false, summary: message, pushed: false, tooBig: [] };
      }
    },
  };

  // 仅在装配了 Typert registry 的 profile（Web）里挂载面板服务；其余 profile 安静跳过。
  ctx.inject(['typert'], (scope) => {
    scope.effect(() => scope.typert.register({
      package: 'dsh-backup',
      face: 'host',
      schemas: [],
      invocations: PANEL_INVOCATIONS,
      model: Object.freeze({ services: Object.freeze([]), events: Object.freeze([]), objects: Object.freeze([]) }),
    }), 'dsh-backup: typert invocations');
    scope.plugin(BackupPanelService, panelOps);
  });

  // Web 下载路由（仅 loopback；归档含明文凭据，绝不对非本机来源开放）。
  ctx.inject(['webServer'], (scope) => {
    scope.effect(() => scope.webServer.register({
      kind: 'prefix',
      path: DOWNLOAD_PREFIX,
      handler: (req, res) => { void handleDownload(req, res); },
    }), 'dsh-backup: download route');
  });

  // 启动时恢复持久化的定时备份计划（不阻塞插件装配）。
  void (async () => {
    const h = await loadAutoState();
    if (h > 0 && !autoDispose) {
      autoHours = h;
      autoDispose = ctx.interval(runAutoBackup, h * 3600 * 1000);
    }
  })();
}
