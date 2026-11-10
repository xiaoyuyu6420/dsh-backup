import { rm, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const ACCESS_VIOLATION = 0xc0000005;
const cancelled = (signal) => {
  if (signal?.aborted) throw new Error('操作已取消');
};
const runner = fileURLToPath(new URL('./backup-tar-runner.js', import.meta.url));

/** Create an archive under host process containment, with one narrow Windows retry.
 * #138 reports MSYS tar crashing through the host launcher while Node spawn
 * succeeds. The Node intermediary remains in the host's Windows Job, and its
 * ordinary (non-detached) tar child inherits that Job and the scrubbed environment.
 * This is a recovery path, not a claim about the underlying native crash cause.
 */
export async function createBackupArchive({
  subprocess, argv, cwd, archive, signal,
  platform = process.platform,
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
    // A fresh file is required: never append to or publish the incomplete archive.
    await rm(archive, { force: true });
    cancelled(signal);
    try {
      await attempt([process.execPath, runner, ...argv]);
      return { executable: argv[0], retried: true };
    } catch (error) {
      cancelled(signal);
      throw new Error(`${original.message}\nNode 启动器重试失败: ${error.message}`, { cause: error });
    }
  }
}
