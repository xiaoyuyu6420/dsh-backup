import { rm, stat } from 'node:fs/promises';
import { win32 } from 'node:path';

const ACCESS_VIOLATION = 0xc0000005;
const cancelled = (signal) => {
  if (signal?.aborted) throw new Error('操作已取消');
};
const sameExecutable = (a, b) => win32.normalize(a).toLowerCase() === win32.normalize(b).toLowerCase();

/** Create an archive under host process containment, with one narrow Windows retry.
 * #138 reports MSYS tar crashing only through the host launcher. The native tar
 * avoids that MSYS path without bypassing host cancellation or environment rules.
 * This is a recovery path, not a claim about the underlying native crash cause.
 */
export async function createBackupArchive({
  subprocess, argv, cwd, archive, signal,
  platform = process.platform, systemRoot = process.env.SystemRoot,
}) {
  async function attempt(command) {
    cancelled(signal);
    const proc = subprocess.spawn({
      argv: command, cwd, signal, graceMs: 5000,
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: 8192, spill: { maxBytes: 1 << 20 } },
        stderr: { maxBytes: 8192, spill: { maxBytes: 1 << 20 } },
      },
    });
    let outcome;
    try {
      outcome = await proc.done;
      if (signal?.aborted || outcome.signal != null || outcome.exitCode !== 0) {
        // done describes the direct process. A gzip descendant may still own
        // the output file; settle the managed range before deleting/retrying.
        proc.terminate();
      }
      await proc.waitForExit?.(); // Older supported hosts may lack this method.
    } catch (error) {
      proc.terminate();
      await proc.waitForExit?.();
      cancelled(signal);
      throw error;
    }
    cancelled(signal);
    if (outcome.signal == null && outcome.exitCode === 0) return;
    const bytes = await stat(archive).then(s => s.size, () => 0);
    const stderr = proc.collected?.stderr?.readFrom(0)?.text || '';
    const stdout = proc.collected?.stdout?.readFrom(0)?.text || '';
    const code = outcome.exitCode;
    const hex = platform === 'win32' && Number.isInteger(code)
      ? ` (0x${(code >>> 0).toString(16).padStart(8, '0').toUpperCase()})` : '';
    const status = outcome.signal != null ? `signal=${outcome.signal}` : `exit=${code}${hex}`;
    const error = new Error(`tar 归档失败 ${status}; 已写入 ${bytes} 字节; 程序=${command[0]}; ${stderr || `stderr 为空${stdout ? `; stdout=${stdout}` : ''}`}`);
    Object.assign(error, { exitCode: code, signal: outcome.signal, executable: command[0], archiveBytes: bytes });
    throw error;
  }

  try {
    await attempt(argv);
    return { executable: argv[0], retried: false };
  } catch (original) {
    cancelled(signal);
    if (platform !== 'win32' || original.signal != null ||
        ![ACCESS_VIOLATION, ACCESS_VIOLATION - 2 ** 32].includes(original.exitCode)) throw original;
    let native;
    try {
      if (!systemRoot || !win32.isAbsolute(systemRoot)) throw new Error('SystemRoot 未提供绝对路径');
      const candidate = win32.join(systemRoot, 'System32', 'tar.exe');
      if (sameExecutable(argv[0], candidate)) throw new Error('失败程序已经是系统 tar');
      native = await subprocess.resolveExecutable(candidate, undefined, signal);
      if (sameExecutable(argv[0], native)) throw new Error('系统 tar 与失败程序相同');
      // Windows' bundled bsdtar may narrow Unicode command-line arguments to
      // the ANSI code page (libarchive #2092). A mangled exclusion can leak
      // credentials, so fail closed instead of silently changing its meaning.
      if ([native, ...argv.slice(1)].some(arg => /[^\x00-\x7f]/.test(arg))) {
        throw new Error('系统 tar 无法安全处理含非 ASCII 字符的路径或排除参数，未执行重试');
      }
    } catch (error) {
      cancelled(signal);
      throw new Error(`${original.message}\n系统 tar 重试不可用: ${error.message}`, { cause: original });
    }
    cancelled(signal);
    // A fresh file is required: never append to or publish the incomplete archive.
    await rm(archive, { force: true });
    cancelled(signal);
    try {
      await attempt([native, ...argv.slice(1)]);
      return { executable: native, retried: true };
    } catch (error) {
      cancelled(signal);
      throw new Error(`${original.message}\n系统 tar 重试失败: ${error.message}`, { cause: error });
    }
  }
}
