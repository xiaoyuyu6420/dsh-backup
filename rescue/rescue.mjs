#!/usr/bin/env node
/**
 * dsh-rescue —— dsh-backup 的进程外救援通道（零依赖，单文件）。
 *
 * 为什么存在：dsh-backup 插件跑在 DSH 宿主进程里，宿主起不来时插件也死；
 * 而 DSH 依赖 Node 才能跑，所以"DSH 坏了"的场景里 Node 一定活着。本脚本
 * 只用 Node 内置能力（fs/crypto/zlib/child_process）+ 系统 tar，不依赖
 * 任何 @deepseek-ai 包——`node rescue.mjs` 在任何损坏等级下都能恢复。
 *
 * 每次备份时插件会把本文件复制进备份目录；备份目录在哪，救援工具就在哪。
 * 根目录缺省 = 本文件所在目录。
 *
 * 用法：
 *   node rescue.mjs                       # 启动救援网页（本机回环，推荐）
 *   node rescue.mjs list                  # 列出备份
 *   node rescue.mjs verify [前缀|all]     # 校验完整性（缺省最新一份）
 *   node rescue.mjs restore <前缀|latest> # 恢复预览；加 --yes 执行
 *   node rescue.mjs doctor                # 会话日志体检
 *   node rescue.mjs doctor --repair [前缀] # 从备份定点修复损坏的会话日志
 *   node rescue.mjs --root <目录> …       # 指定备份目录（缺省脚本所在目录）
 *
 * 恢复语义与插件对齐（#28/#26）：先校验 → 路径穿越防护 → 现有数据自动快照
 * 后挪旁（.dsh.pre-restore-*）→ 解压（失败自动回滚）→ vault 凭据还原。
 * 老归档（无边车 v0.6.x）静默降级，与插件一致。
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as zlib from 'node:zlib';

const IS_WIN = process.platform === 'win32';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SENSITIVE_DEFAULTS = ['.credentials.yaml', '.env', 'qq-bridge/config.json'];
const VAULT_DIR = 'vault';
const ZSTD_MAGIC = 0xfd2fb528;
const SESSION_LOG_NAMES = new Set(['session.jsonl.zstd', 'session.jsonl']);
const SCAN_SKIP_DIRS = new Set(['node_modules', '.system', '.git', 'vault']);
const SCAN_MAX_FILES = 4000;
const SCAN_MAX_DEPTH = 8;
const HASH_MAX_BYTES = 256 * 1024 * 1024;
// 命名空间导入 + 运行时探测：zstd 导出在 Node <22.15/23.8 不存在，具名导入
// 会让本脚本直接加载失败。缺能力时 .zstd 体检降级为 skipped（与插件一致）。
const HAS_NODE_ZSTD = typeof zlib.zstdDecompressSync === 'function';

// ---------- 基础解析 ----------

function toFwd(p) {
  return p && p.includes('\\') ? p.split('\\').join('/') : p;
}

function resolveRoot(explicit) {
  if (explicit) return toFwd(path.resolve(explicit));
  return toFwd(HERE);
}

function resolveDshHome() {
  if (process.env.DSH_HOME) return toFwd(process.env.DSH_HOME.replace(/\/+$/, ''));
  const home = toFwd(IS_WIN ? process.env.USERPROFILE : process.env.HOME);
  if (!home) throw new Error('无法解析 HOME/USERPROFILE（可用 DSH_HOME 环境变量指定）');
  return `${home}/.dsh`;
}

function userHome() {
  const h = toFwd(IS_WIN ? process.env.USERPROFILE : process.env.HOME);
  return h ? h.replace(/\/+$/, '') : null;
}

function stampNow() {
  const now = new Date();
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}${pad(now.getMilliseconds(), 3)}`;
}

function run(argv, cwd) {
  const r = spawnSync(argv[0], argv.slice(1), { cwd, encoding: 'buffer', maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) {
    const text = Buffer.concat([r.stdout, r.stderr]).toString('utf8').slice(0, 800);
    throw new Error(`${argv[0]} ${argv.slice(1).join(' ')} 失败 (exit ${r.status}): ${text}`);
  }
  return r.stdout.toString('utf8');
}

async function sha256File(absPath) {
  const info = await fs.stat(absPath);
  if (info.size > HASH_MAX_BYTES) throw new Error(`文件 ${Math.floor(info.size / 1048576)}MB 超过哈希上限`);
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(absPath).on('data', (d) => h.update(d)).on('error', reject).on('end', () => resolve(h.digest('hex')));
  });
}

// ---------- 备份清单 / 校验（与插件 listBackups/verifyOne 同语义） ----------

async function listBackups(root) {
  let dirents;
  try {
    dirents = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const backups = [];
  for (const d of dirents) {
    if (!d.name.startsWith('dsh-') || d.name.startsWith('dsh-pre-restore-') || d.name.startsWith('dsh-t-') || !d.name.endsWith('.tar.gz')) continue;
    let size;
    try {
      size = (await fs.stat(`${root}/${d.name}`)).size;
    } catch {
      size = undefined;
    }
    backups.push({ name: d.name, size });
  }
  return backups.sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));
}

async function readArchiveMeta(root, archiveName) {
  let meta = null;
  let redactedFiles = null;
  try {
    meta = JSON.parse(await fs.readFile(`${root}/${archiveName}.meta.json`, 'utf8'));
  } catch { /* 老归档无边车 */ }
  try {
    redactedFiles = JSON.parse(await fs.readFile(`${root}/${archiveName}.redacted.json`, 'utf8'))?.files ?? [];
  } catch { /* 未脱敏或老归档 */ }
  return { meta, redactedFiles };
}

async function verifyOne(root, name) {
  let expected = '';
  try {
    expected = (await fs.readFile(`${root}/${name}.sha256`, 'utf8')).trim().split(/\s+/)[0];
  } catch { /* 边车缺失 */ }
  if (!/^[0-9a-f]{64}$/.test(expected)) return { name, ok: false, note: '缺少或无效的配套校验文件（.sha256）——无法确认这份备份是否完好' };
  const actual = await sha256File(`${root}/${name}`);
  return { name, ok: actual === expected, note: actual === expected ? '完整' : '校验和不匹配（归档或校验文件之一可能损坏）' };
}

async function pickArchive(root, selector) {
  const all = await listBackups(root);
  if (!all.length) throw new Error('暂无备份');
  if (!selector || selector === 'latest') return all[0];
  const exact = all.filter((b) => b.name === selector);
  const hits = exact.length ? exact : all.filter((b) => b.name.startsWith(selector));
  if (hits.length === 1) return hits[0];
  if (!hits.length) throw new Error(`没有匹配 "${selector}" 的备份`);
  throw new Error(`"${selector}" 匹配多份备份，请加长前缀`);
}

// ---------- tar 条目解析与安全校验（与插件 parseTarEntry/safeArchiveEntries 同语义） ----------

function parseTarEntry(line) {
  const f = line.trim().split(/\s+/);
  if (f.length < 6) return null;
  let nameIdx = -1;
  for (let i = 1; i < f.length; i++) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(f[i])) { nameIdx = i + 2; break; }
  }
  if (nameIdx < 0) {
    for (let i = f.length - 1; i >= 1; i--) {
      if (/^\d{1,2}:\d{2}$/.test(f[i])) { nameIdx = i + 1; break; }
    }
  }
  if (nameIdx < 0) {
    for (let i = f.length - 1; i >= 1; i--) {
      if (/^\d{4}$/.test(f[i])) { nameIdx = i + 1; break; }
    }
  }
  if (nameIdx < 0 || nameIdx >= f.length) return null;
  return { type: f[0][0], name: f.slice(nameIdx).join(' ').replace(/\/$/, '') };
}

function safeEntries(listedText, base) {
  const entries = [];
  const bad = [];
  for (const line of listedText.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    const parsed = parseTarEntry(s);
    const name = parsed ? parsed.name.replace(/\\/g, '/').replace(/\/$/, '') : null;
    if (
      !parsed || !name
      || (parsed.type !== '-' && parsed.type !== 'd')
      || name.startsWith('/') || /^[A-Za-z]:/.test(name)
      || name.split('/').includes('..')
      || (name !== base && !name.startsWith(`${base}/`))
    ) {
      bad.push(parsed ? name : s);
    } else {
      entries.push(name);
    }
  }
  if (bad.length) throw new Error(`归档包含不安全条目（拒绝恢复）：${bad.slice(0, 3).join(', ')}`);
  return entries;
}

// ---------- 会话日志体检（与插件 doctor 同语义） ----------

function snippet(text, max = 60) {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function walkZstdFrames(buf) {
  const frames = [];
  let off = 0;
  while (off < buf.length) {
    if (buf.length - off < 4) throw new Error(`尾部截断（余 ${buf.length - off} 字节不成帧）`);
    const magic = buf.readUInt32LE(off);
    if (magic === ZSTD_MAGIC) {
      let pos = off + 4;
      if (pos >= buf.length) throw new Error('帧头描述符缺失');
      const desc = buf[pos++];
      if (desc & 0x08) throw new Error('帧头保留位置位');
      const singleSegment = Boolean(desc & 0x20);
      const checksum = Boolean(desc & 0x04);
      const dictSize = [0, 1, 2, 4][desc & 0x03];
      const fcsSize = singleSegment ? [1, 2, 4, 8][desc >> 6] : [0, 2, 4, 8][desc >> 6];
      if (!singleSegment) pos += 1;
      pos += dictSize + fcsSize;
      if (pos > buf.length) throw new Error('帧头越界');
      let last = false;
      while (!last) {
        if (buf.length - pos < 3) throw new Error('块头截断');
        const bh = buf.readUIntLE(pos, 3);
        last = Boolean(bh & 0x01);
        const btype = (bh >> 1) & 0x03;
        const bsize = bh >> 3;
        if (btype === 3) throw new Error('保留块类型');
        pos += 3 + (btype === 1 ? 1 : bsize);
        if (pos > buf.length) throw new Error('块数据越界');
      }
      if (checksum) {
        if (buf.length - pos < 4) throw new Error('帧校验和截断');
        pos += 4;
      }
      frames.push([off, pos]);
      off = pos;
    } else if (magic >= 0x184d2a50 && magic <= 0x184d2a5f) {
      if (buf.length - off < 8) throw new Error('skippable 帧头截断');
      const size = buf.readUInt32LE(off + 4);
      const end = off + 8 + size;
      if (end > buf.length) throw new Error('skippable 帧数据越界');
      frames.push([off, end]);
      off = end;
    } else {
      throw new Error(`偏移 ${off} 处不是 zstd 帧魔数`);
    }
  }
  return frames;
}

function decodeZstdLog(buf) {
  const parts = [];
  let frameNo = 0;
  for (const [s, e] of walkZstdFrames(buf)) {
    frameNo += 1;
    try {
      parts.push(zlib.zstdDecompressSync(buf.subarray(s, e)));
    } catch (err) {
      throw new Error(`第 ${frameNo} 帧解压失败：${String(err && err.message ? err.message : err)}`);
    }
  }
  return Buffer.concat(parts).toString('utf8').split('\n').filter((l) => l.length > 0);
}

function validateSessionLines(lines) {
  let header;
  try {
    header = JSON.parse(lines[0]);
  } catch {
    return `首行不是 JSON（${snippet(String(lines[0]))}）`;
  }
  if (!header || typeof header !== 'object' || header.type !== 'session' || typeof header.id !== 'string') {
    return '首行不是有效的 SessionHeader（缺 type:"session" 或 id）';
  }
  let nextSeq = 0;
  for (let i = 1; i < lines.length; i++) {
    let rec;
    try {
      rec = JSON.parse(lines[i]);
    } catch {
      return `第 ${i + 1} 行不是合法 JSON（${snippet(String(lines[i]))}）`;
    }
    if (!rec || typeof rec !== 'object') return `第 ${i + 1} 行记录不是对象`;
    if (rec.type === 'text-chunks' || rec.type === 'reasoning-chunks' || rec.type === 'tool-call-chunks') {
      const data = rec.data ?? {};
      const members = Array.isArray(data.texts) ? data.texts.length : Array.isArray(data.args) ? data.args.length : 0;
      if (!Number.isSafeInteger(rec.seq0) || members <= 0) return `第 ${i + 1} 行 packed 行缺少 seq0 或成员列表`;
      if (rec.seq0 !== nextSeq) return `第 ${i + 1} 行 packed 行 seq0=${rec.seq0} 与游标 ${nextSeq} 不接续`;
      nextSeq += members;
    } else if (typeof rec.seq === 'number') {
      if (rec.seq !== nextSeq) return `第 ${i + 1} 行 seq=${rec.seq} 撞号/跳号（期望 ${nextSeq}）`;
      nextSeq = rec.seq + 1;
    }
  }
  return null;
}

async function collectSessionLogs(dir, relPrefix, depth, out) {
  if (depth > SCAN_MAX_DEPTH || out.length >= SCAN_MAX_FILES) return;
  let dirents;
  try {
    dirents = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const d of dirents) {
    if (out.length >= SCAN_MAX_FILES) return;
    const rel = relPrefix ? `${relPrefix}/${d.name}` : d.name;
    if (d.isDirectory()) {
      if (SCAN_SKIP_DIRS.has(d.name)) continue;
      await collectSessionLogs(`${dir}/${d.name}`, rel, depth + 1, out);
    } else if (SESSION_LOG_NAMES.has(d.name)) {
      out.push({ abs: `${dir}/${d.name}`, rel });
    }
  }
}

async function validateSessionFile(f) {
  try {
    const info = await fs.stat(f.abs);
    if (info.size === 0) return { state: 'bad', reason: '空文件（0 字节）' };
    if (f.abs.endsWith('.zstd') && !HAS_NODE_ZSTD) {
      return { state: 'skipped', reason: `运行时 Node（${process.version}）无内置 zstd 解码，跳过深度校验` };
    }
    if (info.size > HASH_MAX_BYTES) {
      return { state: 'skipped', reason: `文件 ${Math.floor(info.size / 1048576)}MB 超过深度校验上限` };
    }
    let lines;
    if (f.abs.endsWith('.zstd')) {
      lines = decodeZstdLog(await fs.readFile(f.abs));
    } else {
      lines = (await fs.readFile(f.abs, 'utf8')).split('\n').filter((l) => l.length > 0);
    }
    if (!lines.length) return { state: 'bad', reason: '解出的逻辑行为空' };
    const defect = validateSessionLines(lines);
    return defect === null ? { state: 'ok' } : { state: 'bad', reason: defect };
  } catch (err) {
    return { state: 'bad', reason: String(err && err.message ? err.message : err) };
  }
}

async function runDoctorScan(dshHome) {
  const found = [];
  await collectSessionLogs(dshHome, '', 0, found);
  const files = [];
  for (const f of found) {
    const verdict = await validateSessionFile(f);
    files.push({ rel: f.rel, ok: verdict.state === 'ok', skipped: verdict.state === 'skipped', reason: verdict.reason });
  }
  const corrupt = files.filter((x) => !x.ok && !x.skipped);
  return { scanned: files.length, files, corrupt, corruptCount: corrupt.length, skippedCount: files.filter((x) => x.skipped).length };
}

function summarizeDoctorScan(r) {
  if (!r.files.length) return '未找到任何会话日志。';
  const healthy = r.scanned - r.corruptCount - r.skippedCount;
  let head = `扫描 ${r.scanned} 个会话日志：${healthy} 健康、${r.corruptCount} 损坏`;
  if (r.skippedCount) head += `、${r.skippedCount} 个未能深度校验`;
  if (!r.corruptCount) return `✅ ${head}`;
  const shown = r.corrupt.slice(0, 15);
  const more = r.corrupt.length > shown.length ? `\n  …另有 ${r.corrupt.length - shown.length} 个` : '';
  return `${head}\n${shown.map((c) => `  ❌ ${c.rel}\n     ${c.reason}`).join('\n')}${more}`;
}

// ---------- 定点修复（与插件 runDoctorRepair 同语义，含失败回滚） ----------

async function doctorRepair(root, dshHome, selector) {
  const scan = await runDoctorScan(dshHome);
  if (!scan.corruptCount) return { repaired: [], unrecoverable: [], stillBad: [], summary: summarizeDoctorScan(scan) };
  const picked = await pickArchive(root, selector || 'latest');
  const v = await verifyOne(root, picked.name);
  if (!v.ok) throw new Error(`归档校验未通过（${v.note}），定点修复已中止`);
  const base = dshHome.split('/').pop();
  const parent = dshHome.slice(0, -(base.length + 1)) || '/';
  const entries = safeEntries(run(['tar', '-tvzf', picked.name], root), base);
  const entrySet = new Set(entries);
  const targets = [];
  const unrecoverable = [];
  for (const c of scan.corrupt) {
    const entry = `${base}/${c.rel}`;
    if (entrySet.has(entry)) targets.push({ ...c, entry });
    else unrecoverable.push(c.rel);
  }
  const stamp = stampNow();
  const kept = [];
  for (const t of targets) {
    const keep = `${dshHome}/${t.rel}.corrupt-${stamp}`;
    await fs.mkdir(path.dirname(keep), { recursive: true });
    await fs.copyFile(`${dshHome}/${t.rel}`, keep);
    kept.push(keep);
  }
  try {
    run(['tar', '-xzf', picked.name, '-C', parent, ...targets.map((t) => t.entry)], root);
  } catch (err) {
    const reason = err && err.message ? err.message : String(err);
    const restored = new Set();
    for (let i = 0; i < targets.length; i++) {
      try {
        await fs.copyFile(kept[i], `${dshHome}/${targets[i].rel}`);
        restored.add(targets[i].rel);
      } catch { /* 如实报告 */ }
    }
    if (restored.size === targets.length) throw new Error(`定点修复失败（${reason}）。已从留档还原全部损坏现场，数据保持修复前状态`);
    const missing = targets.filter((t) => !restored.has(t.rel)).map((t) => t.rel);
    throw new Error(`定点修复失败（${reason}），且部分现场未自动还原: ${missing.join(', ')}；*.corrupt-${stamp} 留档在原目录旁，可手工拷回`);
  }
  const stillBad = [];
  for (const t of targets) {
    const verdict = await validateSessionFile({ abs: `${dshHome}/${t.rel}`, rel: t.rel });
    if (verdict.state === 'bad') stillBad.push(`${t.rel}（${verdict.reason}）`);
  }
  const lines = [`🩹 定点修复完成（来源: ${picked.name}）`, `  已恢复 ${targets.length} 个文件${stillBad.length ? '' : '，复检全部健康'}`];
  for (const k of kept) lines.push(`  损坏现场已留档: ${k}`);
  if (unrecoverable.length) lines.push(`  ⚠️ 归档中无对应副本: ${unrecoverable.join(', ')}（改用 restore 全量恢复）`);
  if (stillBad.length) lines.push(`  ❌ 修复后复检仍异常: ${stillBad.join('; ')}`);
  return { repaired: targets.map((t) => t.rel), unrecoverable, stillBad, summary: lines.join('\n') };
}

// ---------- 恢复（与插件 restoreArchive 同语义：快照/挪旁/回滚/vault） ----------

async function restoreArchive(root, selector, apply) {
  const dshHome = resolveDshHome();
  const picked = await pickArchive(root, selector);
  const v = await verifyOne(root, picked.name);
  if (!v.ok) throw new Error(`校验未通过（${v.note}），恢复已中止`);
  const base = dshHome.split('/').pop();
  const parent = dshHome.slice(0, -(base.length + 1)) || '/';
  const entries = safeEntries(run(['tar', '-tvzf', picked.name], root), base);
  const { meta, redactedFiles } = await readArchiveMeta(root, picked.name);
  // 分类型归档是子集，整包恢复会挪旁 ~/.dsh 后只解压子集 → 丢失未包含的类型
  // 数据。灾时请用全量归档（dsh-）整包恢复；分类型恢复走 dsh 的 --types。
  if (meta && Array.isArray(meta.types) && meta.types.length) {
    throw new Error(`${picked.name} 是分类型归档（${meta.types.join(', ')}），整包恢复会丢失其他类型数据。请选一份全量归档（dsh- 开头）整包恢复，或用 dsh 的「/backup restore ${picked.name} --types ${meta.types.join(',')}」分类型恢复。`);
  }
  const home = userHome();
  const preflight = [];
  if (meta && typeof meta.home === 'string' && home && meta.home !== home) {
    preflight.push(`⚠️ 备份来自另一台机器/用户目录（${meta.host ?? '未知'}，${meta.home}），settings 内的绝对路径可能需要调整`);
  }
  if (Array.isArray(redactedFiles)) {
    preflight.push(`🔐 该归档已脱敏：${redactedFiles.length} 个凭据文件恢复时从本机 vault 还原（跨机需重填）`);
  }
  const profileDirs = [...new Set(entries
    .filter((n) => n.startsWith(`${base}/profiles/`) && n.endsWith('/package.json'))
    .map((n) => n.slice(`${base}/profiles/`.length).split('/')[0]))];

  if (!apply) {
    return { dryRun: true, archive: picked.name, files: entries.length, sample: entries.slice(0, 12), preflight, profileDirs };
  }

  // 现有数据：快照 + 挪旁；缺失（新机/全失）则直接解压
  let targetExists = true;
  try {
    await fs.stat(dshHome);
  } catch (err) {
    if (err && err.code === 'ENOENT') targetExists = false;
    else throw err;
  }
  let snapshotName = null;
  if (targetExists) {
    snapshotName = `dsh-pre-restore-${stampNow()}.tar.gz`;
    // 快照排除与插件一致：可重装的 node_modules/.system + 敏感文件（明文留本机 vault）
    const sensitiveNow = new Set(SENSITIVE_DEFAULTS);
    if (Array.isArray(redactedFiles)) for (const rel of redactedFiles) sensitiveNow.add(rel);
    const redactFlags = [...sensitiveNow].flatMap((rel) => [`--exclude=${base}/${rel}`, `--exclude=*/${rel}`]);
    run(['tar', '--exclude=*node_modules*', '--exclude=.system', ...redactFlags, '-czf', snapshotName, '-C', parent, base], root);
    // 清掉上一次的 pre-restore 快照（只保留本次），防累积
    for (const name of await fs.readdir(root)) {
      if (name.startsWith('dsh-pre-restore-') && name !== snapshotName) {
        await fs.rm(`${root}/${name}`, { force: true });
      }
    }
    const sha = await sha256File(`${root}/${snapshotName}`);
    await fs.writeFile(`${root}/${snapshotName}.sha256`, `${sha}  ${root}/${snapshotName}\n`, 'utf8');
  }
  const asideName = `${base}.pre-restore-${stampNow()}`;
  let aside = null;
  if (targetExists) {
    await fs.rename(dshHome, `${parent}/${asideName}`);
    aside = `${parent}/${asideName}`;
  }
  try {
    run(['tar', '-xzf', picked.name, '-C', parent], root);
  } catch (err) {
    const reason = err && err.message ? err.message : String(err);
    let rolledBack = false;
    try {
      await fs.rm(dshHome, { recursive: true, force: true });
      if (targetExists) await fs.rename(`${parent}/${asideName}`, dshHome);
      rolledBack = true;
    } catch { /* 人工指引分支 */ }
    if (rolledBack) throw new Error(`解压归档失败（${reason}）。已自动还原到恢复前状态，数据未丢失`);
    throw new Error(aside
      ? `解压归档失败（${reason}），且自动还原未成功。原数据在 ${aside}，改名回 "${dshHome}" 即可`
      : `解压归档失败（${reason}），且清理未成功。半截产物在 ${dshHome}，删除后重试`);
  }

  // vault 还原
  const vaultRestored = [];
  const vaultMissing = [];
  if (Array.isArray(redactedFiles) && redactedFiles.length) {
    for (const rel of redactedFiles) {
      const src = `${root}/${VAULT_DIR}/${rel}`;
      const have = await fs.stat(src).then(() => true, (e) => (e.code === 'ENOENT' ? false : Promise.reject(e)));
      if (!have) { vaultMissing.push(rel); continue; }
      const dst = `${dshHome}/${rel}`;
      await fs.mkdir(path.dirname(dst), { recursive: true });
      await fs.copyFile(src, dst);
      vaultRestored.push(rel);
    }
  }
  const lines = ['✅ 恢复完成', `  已替换: .dsh 全部内容 ← ${picked.name}（${entries.length} 项）`];
  if (aside) lines.push(`  旧数据没丢: 在 ${aside}（确认正常后可自行删除）`);
  if (snapshotName) lines.push(`  保险快照: ${snapshotName}（只保留最近一次）`);
  for (const p of preflight) if (p.startsWith('⚠️')) lines.push(`  ${p}`);
  if (vaultRestored.length) lines.push(`  凭据: 已从本机 vault 补回 ${vaultRestored.length} 个`);
  if (vaultMissing.length) lines.push(`  ⚠️ 凭据缺失需手动重填: ${vaultMissing.join(', ')}`);
  if (profileDirs.length) lines.push(`  插件依赖: 进各 profile 目录手动 pnpm install（或宿主内用 --sync-deps）`);
  lines.push('  ⏸️ 待办: 重启 dsh，会话和配置才会切换到恢复的内容');
  return { dryRun: false, archive: picked.name, files: entries.length, aside, snapshotName, vaultRestored, vaultMissing, summary: lines.join('\n') };
}

// ---------- 救援网页（loopback + 自定义头防 CSRF） ----------

const PAGE = `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>dsh-rescue · 救援控制台</title><style>
body{font-family:system-ui,-apple-system,sans-serif;max-width:760px;margin:40px auto;padding:0 16px;color:#1f2937}
h1{font-size:22px}h1 small{font-weight:400;color:#6b7280;font-size:14px}
table{border-collapse:collapse;width:100%;margin-top:12px}th,td{text-align:left;padding:8px;border-bottom:1px solid #e5e7eb;font-size:14px}
button{margin:2px;padding:5px 12px;border:1px solid #d1d5db;border-radius:6px;background:#fff;cursor:pointer;font-size:13px}
button:hover{background:#f3f4f6}button.danger{background:#dc2626;color:#fff;border-color:#dc2626}
#log{white-space:pre-wrap;background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:12px;margin-top:16px;font:12px/1.6 ui-monospace,monospace;min-height:80px}
.bar{display:flex;gap:8px;margin-top:16px}
.note{color:#6b7280;font-size:13px;margin-top:8px}
dialog{border:1px solid #d1d5db;border-radius:10px;padding:20px;max-width:420px}
dialog::backdrop{background:rgba(0,0,0,.4)}
</style></head><body>
<h1>🩺 dsh-rescue <small>进程外救援控制台——不依赖 DSH 运行状态</small></h1>
<div class="bar">
  <button onclick="api('list')">刷新备份列表</button>
  <button onclick="doctor(false)">会话体检</button>
  <button onclick="doctor(true)" class="danger">体检并修复</button>
</div>
<div id="list"></div>
<div id="log">（操作结果会显示在这里）</div>
<dialog id="confirm"><p id="confirmText"></p>
  <div class="bar"><button onclick="dlg.close(false)">取消</button>
  <button class="danger" id="confirmGo">确认恢复</button></div></dialog>
<p class="note">恢复是整体替换：现有数据会先自动快照再挪到一旁（.dsh.pre-restore-*），凭据从本机 vault 补回。只监听本机回环地址。</p>
<script>
const ERR_TEXT = {
  'not-found': '接口不存在（可能是浏览器缓存了旧页面），请刷新后重试',
  'missing-rescue-header': '页面安全校验未通过，请刷新页面后重试',
  'confirm-required': '该操作需要先在确认框里确认',
  'unknown-op': '未知的操作类型，请刷新页面后重试',
  'bad-json': '请求内容无法解析，请刷新页面后重试',
  'too-large': '请求内容过大',
  'no-archive': '备份目录里没有可用的归档，请先确认备份目录位置',
};
// 失败结果按"出了什么问题 + 怎么办"展示；未知错误再回退 JSON 细节
const show = (r) => {
  if (r.ok !== false) return typeof r === 'string' ? r : JSON.stringify(r, null, 2);
  // 校验类失败（verify/restore 拦截）没有 error 码，note/summary 本身就是人话主文案
  const note = typeof (r.note || r.summary) === 'string' ? (r.note || r.summary) : null;
  const human = ERR_TEXT[r.error] || note || '操作失败';
  const detail = r.summary || r.note || r.error;
  return '❌ ' + human + (detail && detail !== r.error && detail !== human ? '\\n技术细节: ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : '');
};
const log = (t) => { document.getElementById('log').textContent = typeof t === 'string' ? t : show(t); };
const dlg = document.getElementById('confirm');
const fmtSize = (n) => typeof n !== 'number' ? '?' : n >= 1048576 ? (n/1048576).toFixed(1) + 'MB' : Math.max(1, Math.round(n/1024)) + 'KB';
async function api(op, body) {
  const res = await fetch('/api/' + op, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Dsh-Rescue': '1' }, body: JSON.stringify(body || {}) });
  return res.json();
}
async function renderList() {
  const r = await api('list');
  if (!r.ok) { log(r); return; }
  const rows = r.backups.map(b => '<tr><td>' + b.name + '</td><td>' + fmtSize(b.size) +
    '</td><td><button onclick="verify(\\'' + b.name + '\\')">校验</button> ' +
    '<button class="danger" onclick="restore(\\'' + b.name + '\\')">恢复…</button></td></tr>').join('');
  document.getElementById('list').innerHTML = r.backups.length
    ? '<table><tr><th>备份</th><th>大小</th><th></th></tr>' + rows + '</table>'
    : '<p>备份目录里没有找到归档。</p>';
  log(r.summary || '');
}
async function verify(name) { log(await api('verify', { selector: name })); }
async function restore(name) {
  const pre = await api('restore', { selector: name, dryRun: true });
  log(pre);
  if (!pre.ok) return;
  document.getElementById('confirmText').textContent = pre.summary + '\\n\\n确认用这份归档整体替换 ' + (pre.targetExists === false ? '（目标不存在，直接写入）' : '当前 .dsh？');
  document.getElementById('confirmGo').onclick = async () => { dlg.close(true); log(await api('restore', { selector: name, confirm: true })); renderList(); };
  dlg.showModal();
}
async function doctor(repair) {
  if (repair) {
    if (!confirm('将对损坏的会话日志执行定点修复（损坏文件会留档 *.corrupt-*）。继续？')) return;
  }
  log(await api('doctor', { repair }));
}
renderList();
</script></body></html>`;

/** 跨平台尽力打开浏览器（serve --open）：失败静默——URL 已打印在终端。 */
function openBrowser(url) {
  try {
    const cmd = IS_WIN ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
    const args = IS_WIN ? ['/c', 'start', '', url] : [url];
    spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
  } catch { /* 打不开就手输 URL */ }
}

function serve(root, port, autoOpen) {
  const server = http.createServer(async (req, res) => {
    const send = (status, data, type = 'application/json') => {
      res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
      res.end(typeof data === 'string' && type === 'text/html' ? data : JSON.stringify(data));
    };
    try {
      if (req.method === 'GET' || req.method === 'HEAD') return send(200, PAGE, 'text/html');
      if (req.method !== 'POST' || !req.url.startsWith('/api/')) return send(404, { ok: false, error: 'not-found' });
      // 防 CSRF：浏览器跨站表单/简单请求带不了自定义头；页面内 fetch 一律带
      if (req.headers['x-dsh-rescue'] !== '1') return send(403, { ok: false, error: 'missing-rescue-header' });
      const op = req.url.slice(5);
      const body = await new Promise((resolve) => {
        let raw = '';
        req.on('data', (c) => { raw += c; });
        req.on('end', () => { try { resolve(JSON.parse(raw || '{}')); } catch { resolve({}); } });
      });
      const dshHome = resolveDshHome();
      if (op === 'list') {
        const backups = await listBackups(root);
        return send(200, { ok: true, backups, dshHome, root, node: process.version, zstd: HAS_NODE_ZSTD });
      }
      if (op === 'verify') {
        const sel = body.selector || 'latest';
        const names = sel === 'all' ? (await listBackups(root)).map((b) => b.name) : [(await pickArchive(root, sel)).name];
        const results = [];
        for (const n of names) results.push(await verifyOne(root, n));
        return send(200, { ok: results.every((r) => r.ok), summary: results.map((r) => `${r.ok ? '✅' : '❌'} ${r.name} — ${r.note}`).join('\n') || '暂无备份。', results });
      }
      if (op === 'restore') {
        if (body.dryRun) {
          const r = await restoreArchive(root, body.selector || 'latest', false);
          return send(200, { ok: true, ...r, summary: r.summary ?? `📦 恢复预览：${r.files} 项\n${(r.preflight || []).join('\n')}` });
        }
        if (body.confirm !== true) return send(400, { ok: false, error: 'confirm-required' });
        return send(200, await restoreArchive(root, body.selector || 'latest', true).then((r) => ({ ok: true, ...r })));
      }
      if (op === 'doctor') {
        if (body.repair) {
          const r = await doctorRepair(root, dshHome, body.selector);
          return send(200, { ok: r.stillBad.length === 0 && r.unrecoverable.length === 0, ...r });
        }
        const r = await runDoctorScan(dshHome);
        return send(200, { ok: r.corruptCount === 0, corruptCount: r.corruptCount, skippedCount: r.skippedCount, scanned: r.scanned, summary: summarizeDoctorScan(r), corrupt: r.corrupt });
      }
      return send(404, { ok: false, error: 'unknown-op' });
    } catch (err) {
      return send(500, { ok: false, error: String(err && err.message ? err.message : err) });
    }
  });
  server.listen(port, '127.0.0.1', () => {
    console.log(`🩺 dsh-rescue 救援控制台已启动: http://127.0.0.1:${port}`);
    console.log(`   备份目录: ${root}`);
    console.log(`   DSH_HOME: ${resolveDshHome()}   (Ctrl+C 退出)`);
    if (autoOpen) openBrowser(`http://127.0.0.1:${port}`);
  });
  return server;
}

// ---------- CLI ----------

const HELP = `dsh-rescue —— dsh-backup 的进程外救援通道（零依赖）

用法:
  node rescue.mjs                       启动救援网页（本机回环）
  node rescue.mjs list                  列出备份
  node rescue.mjs verify [前缀|all]     校验完整性（缺省最新一份）
  node rescue.mjs restore <前缀|latest> 恢复预览；确认无误后加 --yes 执行
  node rescue.mjs doctor                会话日志体检
  node rescue.mjs doctor --repair [前缀] 从备份定点修复损坏的会话日志
  node rescue.mjs serve [--port N]      同无参数：启动救援网页

选项:
  --root <目录>    备份目录（缺省 = 本文件所在目录）
  --yes            restore 的执行确认
  --port N         网页端口（缺省 13190）`;

async function main() {
  const argv = process.argv.slice(2);
  const rootArgIdx = argv.indexOf('--root');
  const root = resolveRoot(rootArgIdx >= 0 ? argv[rootArgIdx + 1] : undefined);
  const portIdx = argv.indexOf('--port');
  const port = Number(portIdx >= 0 ? argv[portIdx + 1] : 13190);
  // 只剔除选项及其取值位置；--root/--port 缺席时 indexOf 返回 -1，
  // 若直接用 i !== idx+1 会把第 0 位误删（首命令变 serve）
  const skipIdx = new Set();
  if (rootArgIdx >= 0) { skipIdx.add(rootArgIdx); skipIdx.add(rootArgIdx + 1); }
  if (portIdx >= 0) { skipIdx.add(portIdx); skipIdx.add(portIdx + 1); }
  const pos = argv.filter((a, i) => !skipIdx.has(i) && a !== '--yes' && a !== '--repair');
  const cmd = pos[0] || 'serve';
  const dshHome = resolveDshHome();
  if (cmd === '--help' || cmd === '-h' || cmd === 'help') return console.log(HELP);
  if (cmd === 'serve') return serve(root, port, argv.includes('--open'));
  if (cmd === 'list') {
    const all = await listBackups(root);
    const total = all.reduce((s, b) => s + (b.size || 0), 0);
    console.log(all.length ? `备份目录 ${root}（${all.length} 份，共 ${(total / 1048576).toFixed(1)}MB）:\n${all.map((b) => `  ${b.name}${b.size !== undefined ? `  ${(b.size / 1048576).toFixed(1)}MB` : ''}`).join('\n')}` : `备份目录 ${root} 里没有归档。`);
    return;
  }
  if (cmd === 'verify') {
    const sel = pos[1] || 'latest';
    const names = sel === 'all' ? (await listBackups(root)).map((b) => b.name) : [(await pickArchive(root, sel)).name];
    const results = [];
    for (const n of names) results.push(await verifyOne(root, n));
    console.log(results.map((r) => `${r.ok ? '✅' : '❌'} ${r.name} — ${r.note}`).join('\n') || '暂无备份可校验。');
    if (results.some((r) => !r.ok)) process.exitCode = 1;
    return;
  }
  if (cmd === 'restore') {
    const apply = argv.includes('--yes');
    const r = await restoreArchive(root, pos[1] || 'latest', apply);
    console.log(r.summary ?? `📦 恢复预览（未写入）\n  归档: ${r.archive}\n  条目: ${r.files} 项\n${(r.preflight || []).join('\n')}\n${(r.sample || []).map((s) => `    ${s}`).join('\n')}`);
    if (!apply) console.log(`\n确认无误后执行: node rescue.mjs restore ${pos[1] || 'latest'} --yes`);
    return;
  }
  if (cmd === 'doctor') {
    if (argv.includes('--repair')) {
      const r = await doctorRepair(root, dshHome, pos[1]);
      console.log(r.summary);
      return;
    }
    const r = await runDoctorScan(dshHome);
    console.log(summarizeDoctorScan(r));
    if (r.corruptCount) console.log('\n修复: node rescue.mjs doctor --repair [前缀|latest]');
    if (r.corruptCount) process.exitCode = 1;
    return;
  }
  console.error(`未知命令: ${cmd}\n\n${HELP}`);
  process.exitCode = 1;
}

main().catch((err) => {
  console.error(`❌ ${err && err.message ? err.message : err}`);
  process.exitCode = 1;
});
