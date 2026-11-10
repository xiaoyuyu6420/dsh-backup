// Launched by ctx.subprocess, never directly from the plugin process. On Windows
// this Node process and its non-detached children stay in the same host Job.
import { spawn } from 'node:child_process';

const [executable, ...args] = process.argv.slice(2);
if (!executable) {
  process.stderr.write('tar 启动失败: 缺少程序路径\n');
  process.exitCode = 1;
} else {
  // No shell, argument rewriting, environment restoration, or output buffering.
  const child = spawn(executable, args, { windowsHide: true, detached: false, stdio: ['ignore', 'inherit', 'inherit'] });
  let failed = false;
  child.once('error', error => {
    failed = true;
    process.stderr.write(`tar 启动失败: ${error.message}\n`);
    process.exitCode = 1;
  });
  child.once('close', (code, signal) => {
    if (failed) return;
    if (signal) process.stderr.write(`tar 被终止: ${signal}\n`);
    process.exitCode = code ?? 1;
  });
}
