import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

/** Resolve the CLI and decoders from one installation, including pnpm symlinks. */
export function hostInstallation(root) {
  const packageFile = fs.realpathSync(path.join(root, 'package.json'));
  const pkg = JSON.parse(fs.readFileSync(packageFile, 'utf8'));
  if (pkg.name !== '@deepseek-ai/dsh' || typeof pkg.bin?.dsh !== 'string') {
    throw new Error(`不是 DSH CLI 安装目录: ${root}`);
  }
  const hostRequire = createRequire(packageFile);
  // dsh-base owns these runtime dependencies. Resolve from its real entry so
  // npm hoisting and pnpm's isolated dependency graph both select this host.
  const baseRequire = createRequire(hostRequire.resolve('@deepseek-ai/dsh-base'));
  return {
    version: pkg.version,
    cli: path.resolve(path.dirname(packageFile), pkg.bin.dsh),
    catalog: baseRequire.resolve('@deepseek-ai/dsh-session-format-catalog'),
    session: baseRequire.resolve('@deepseek-ai/dsh-session'),
  };
}
