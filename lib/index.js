/**
 * dsh-backup — 一键备份 DeepSeek Harness 用户数据。
 *
 * 备份 ~/.dsh（会话、配置、技能、凭据、插件配置），排除可重装的
 * node_modules，生成 sha256 校验和，自动轮换旧备份；支持定时自动备份。
 *
 * - `/backup`            立即备份到 ~/Desktop/dsh-backups/
 * - `/backup list`       列出已有备份 + 自动备份状态
 * - `/backup auto`       查询自动备份状态
 * - `/backup auto <N>`   每 N 小时自动备份（1~720；<24h 保留 3 份，否则 7 份）
 * - `/backup auto off`   关闭自动备份
 * - `/backup --keep N`   覆盖保留份数
 * - `backup_dsh` 模型工具：mode=backup|list|auto，keep/hours 可选
 *
 * 安全说明：备份包含明文凭据（.credentials.yaml、qq-bridge/config.json），
 * 备份文件已 chmod 600 仅本人可读写；请勿将备份目录同步到不受信位置。
 */
import { defineTool } from '@deepseek-ai/dsh-tools';

export const name = 'dsh-backup';
export const inject = ['subprocess', 'fs', 'commands', 'timer', 'tools'];

export function apply(ctx) {
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
    const home = env?.get('HOME')?.value;
    const dshHome = env?.get('DSH_HOME')?.value || (home ? `${home}/.dsh` : undefined);
    if (!home || !dshHome) throw new Error('无法解析 HOME 或 DSH_HOME（launchEnvironment 缺失）');
    const root = `${home}/Desktop/dsh-backups`;
    return { home, dshHome, root };
  }

  async function listBackups() {
    const { root } = paths();
    let entries;
    try {
      const target = await ctx.fs.resolve(root);
      entries = await ctx.fs.listDir(target);
    } catch {
      // 备份目录尚不存在（首次使用）——视为空列表而非错误
      return [];
    }
    return entries
      .filter((e) => e.name && e.name.startsWith('dsh-') && e.name.endsWith('.tar.gz'))
      .map((e) => e.name)
      .sort()
      .reverse();
  }

  async function doBackup(keep, signal) {
    const { home, dshHome, root } = paths();
    const keepN = keep && keep > 0 ? Math.floor(keep) : 7;
    const mkdir = await ctx.subprocess.resolveExecutable('mkdir');
    await spawnRun([mkdir, '-p', root], home, signal);

    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}${pad(now.getMilliseconds())}`;
    const out = `${root}/dsh-${stamp}.tar.gz`;
    const base = dshHome.split('/').pop();
    const parent = dshHome.slice(0, -(base.length + 1)) || '/';

    const tar = await ctx.subprocess.resolveExecutable('tar');
    await spawnRun([tar, '--exclude=*node_modules*', '--exclude=.system', '-czf', out, '-C', parent, base], home, signal);

    // 校验和：优先 sha256sum，macOS 回退 shasum -a 256
    const shaText = await (async () => {
      try {
        const sha256sum = await ctx.subprocess.resolveExecutable('sha256sum');
        const r = await spawnRun([sha256sum, out], home, signal);
        return r.out.trim().split(/\s+/)[0];
      } catch {
        const shasum = await ctx.subprocess.resolveExecutable('shasum');
        const r = await spawnRun([shasum, '-a', '256', out], home, signal);
        return r.out.trim().split(/\s+/)[0];
      }
    })();
    await ctx.fs.writeText(await ctx.fs.resolve(`${out}.sha256`), `${shaText}  ${out}\n`);

    // 安全：备份含明文凭据（.credentials.yaml / qq-bridge/config.json），收紧为仅本人可读写
    const chmod = await ctx.subprocess.resolveExecutable('chmod');
    await spawnRun([chmod, '600', out, `${out}.sha256`], home, signal);

    // 轮换：只保留最近 keepN 份
    const rm = await ctx.subprocess.resolveExecutable('rm');
    const all = await listBackups();
    const stale = all.slice(keepN);
    for (const item of stale) {
      await spawnRun([rm, '-f', `${root}/${item}`, `${root}/${item}.sha256`], home, signal);
    }

    return { path: out, sha: shaText, total: all.length, stale: stale.length, keep: keepN };
  }

  // ---------- 自动备份状态（进程内） ----------
  let autoDispose = null;
  let autoHours = 0;
  let lastAuto = null;

  function autoSummary() {
    if (!autoDispose) return '自动备份未开启（/backup auto <N小时> 开启）';
    const next = new Date(Date.now() + autoHours * 3600 * 1000).toLocaleString();
    return `自动备份已开启：每 ${autoHours} 小时一次，下次约 ${next}${lastAuto ? `；上次自动备份: ${lastAuto}` : ''}`;
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

  // ---------- /backup 命令 ----------
  ctx.commands.register({
    name: 'backup',
    description: '备份 DSH 数据到 ~/Desktop/dsh-backups；子命令: list | auto [N小时|off|status] | [--keep N]',
    handler: async (invocation) => {
      const input = invocation.rawInput.trim();
      try {
        const parts = input.split(/\s+/).filter(Boolean);
        const head = parts[0] || '';

        if (head === 'list') {
          const all = await listBackups();
          const text = all.length
            ? `已有备份 (${all.length} 份):\n${all.map((n) => `  ${n}`).join('\n')}\n\n${autoSummary()}`
            : `暂无备份。输入 /backup 执行首次备份。\n\n${autoSummary()}`;
          return { kind: 'success', text };
        }

        if (head === 'auto') {
          const arg = parts[1];
          if (!arg || arg === 'status') return { kind: 'success', text: autoSummary() };
          if (arg === 'off' || arg === '0') {
            if (autoDispose) { autoDispose(); autoDispose = null; autoHours = 0; }
            return { kind: 'success', text: '自动备份已关闭。' };
          }
          const h = Number(arg);
          if (!Number.isFinite(h) || h < 1 || h > 720) {
            return { kind: 'error', text: '小时数需为 1~720 之间的数字（如 /backup auto 12）' };
          }
          if (autoDispose) autoDispose();
          autoHours = h;
          autoDispose = ctx.interval(runAutoBackup, h * 3600 * 1000);
          return { kind: 'success', text: `✅ 自动备份已开启：每 ${h} 小时执行一次（保留 ${h >= 24 ? 7 : 3} 份）。\n${autoSummary()}` };
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
    description: '备份或列出 DSH 用户数据（~/.dsh 的会话、配置、技能、凭据）。mode=backup 立即备份（可选 keep 指定保留份数，默认 7）；mode=list 列出已有备份与自动备份状态；mode=auto 设置自动备份（hours 为间隔小时数，0=关闭，缺省返回当前状态）。注意：备份包含明文凭据，请勿将备份目录同步到不受信位置。',
    parameters: {
      mode: { type: 'string', required: true, enum: ['backup', 'list', 'auto'], description: 'backup=执行备份，list=列出备份与自动备份状态，auto=设置自动备份' },
      keep: { type: 'number', description: '保留的备份份数（默认 7）' },
      hours: { type: 'number', description: '自动备份间隔小时数（mode=auto 时使用；0=关闭；缺省=查询状态）' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: String(value.summary) }],
    },
    execute: async (args, exec) => {
      const mode = args && args.mode ? args.mode : 'backup';
      const signal = exec && exec.signal ? exec.signal : undefined;
      try {
        if (mode === 'list') {
          const all = await listBackups();
          return { ok: true, summary: `已有 ${all.length} 份备份:\n${all.join('\n') || '（无）'}\n\n${autoSummary()}` };
        }
        if (mode === 'auto') {
          const h = args && args.hours !== undefined ? args.hours : null;
          if (h === null) return { ok: true, summary: autoSummary() };
          if (h === 0) {
            if (autoDispose) { autoDispose(); autoDispose = null; autoHours = 0; }
            return { ok: true, summary: '自动备份已关闭。' };
          }
          if (!Number.isFinite(h) || h < 1 || h > 720) return { ok: false, summary: 'hours 需为 1~720' };
          if (autoDispose) autoDispose();
          autoHours = h;
          autoDispose = ctx.interval(runAutoBackup, h * 3600 * 1000);
          return { ok: true, summary: `自动备份已开启：每 ${h} 小时一次。\n${autoSummary()}` };
        }
        const r = await doBackup(args && args.keep ? args.keep : undefined, signal);
        return { ok: true, path: r.path, sha: r.sha, summary: `备份完成: ${r.path}\nsha256: ${r.sha}\n轮换删除 ${r.stale} 份（保留 ${r.keep} 份）` };
      } catch (err) {
        return { ok: false, summary: `备份失败: ${String(err && err.message ? err.message : err)}` };
      }
    },
  }));
}
