import { lstat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

/** Portable relative paths only; metadata is untrusted even when ZIP names are safe. */
export function safeRelativePath(value) {
  if (typeof value !== 'string' || !value || /[\\\u0000-\u001f\u007f:]/.test(value)
    || value.startsWith('/') || value.split('/').some((part) => !part || part === '.' || part === '..'
      || /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
    throw new Error(`不安全的相对路径: ${String(value)}`);
  }
  return value;
}

/** Reject existing symlinks as well as lexical traversal before writing into a tree. */
export async function safeDestination(root, rel) {
  safeRelativePath(rel);
  const base = resolve(root);
  const target = resolve(base, rel);
  const inside = relative(base, target);
  if (!inside || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
    throw new Error(`写入路径越界: ${rel}`);
  }
  let current = base;
  for (const part of ['', ...rel.split('/')]) {
    if (part) current = resolve(current, part);
    const info = await lstat(current).catch((err) => {
      if (err.code === 'ENOENT') return null;
      throw err;
    });
    if (info?.isSymbolicLink()) throw new Error(`写入路径含符号链接: ${rel}`);
  }
  return target;
}
