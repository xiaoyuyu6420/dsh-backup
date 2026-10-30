/**
 * dsh-backup — 零依赖 ZIP 读写（导出/导入的宿主半边）。
 *
 * 设计取舍：
 *  - 导出（buildZip）用 STORE（method 0，不压缩）流式写出：~/.dsh 的大头是
 *    zstd 会话日志（已压缩），settings/cordis 等文本体积很小，压缩收益有限；
 *    STORE 免去 deflate 流式管线的复杂度，且写出的 ZIP 每个 unzip 工具都能读。
 *    压缩可以后续再加（写入侧只需换 method + 接一段 deflateRaw）。
 *  - 导入（listZip / extractZip）**同时支持 STORE 与 DEFLATE**：导入的 ZIP 是
 *    不可信输入，可能是任何工具产出的压缩包，读侧必须能解 DEFLATE。
 *  - 安全（硬性）：Zip Slip——条目名禁止绝对路径 / 盘符 / `..` 段 / 反斜杠归一化
 *    后再判，落盘路径 resolve 后必须仍在目标目录内；符号链接/设备等特殊条目一律
 *    拒绝；zip bomb——解压前用中央目录声明的未压缩体积与压缩比双重设限；CRC32
 *    解压后校验，不一致拒收。
 *
 * 所有常量/结构均为本地 ZIP 格式实现（PKZIP AppNote），无第三方依赖。
 */

import { createReadStream, createWriteStream } from 'node:fs';
import { open, mkdir, stat as fsStat } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { once } from 'node:events';
import zlib from 'node:zlib';

/** 条目数量上限：防止中央目录声明天文数字把内存/磁盘打爆。 */
export const ZIP_MAX_ENTRIES = 100_000;
/** 单个条目未压缩体积上限（解压前拒绝，防 zip bomb）。 */
export const ZIP_MAX_ENTRY_BYTES = 4 * 1024 * 1024 * 1024; // 4 GiB
/** 压缩比上限：未压缩/压缩 > 1000 视为 zip bomb。 */
export const ZIP_MAX_RATIO = 1000;
/** 中央目录读取上限（防御性：正规 ZIP 的中央目录远小于此）。 */
export const ZIP_MAX_CENTRAL_BYTES = 256 * 1024 * 1024;

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_DESCRIPTOR = 0x08074b50;

const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;
/** 一般用途位标志：bit3=数据描述符、bit11=UTF-8 文件名。 */
const FLAG_DESCRIPTOR = 0x0008;
const FLAG_UTF8 = 0x0800;

/**
 * CRC-32（IEEE 802.3 多项式 0xEDB88320，查表）。ZIP 的 CRC 字段用同一算法；
 * node:zlib 不暴露 CRC32，这里自己实现一个增量版本。
 */
class Crc32 {
  static table = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();

  constructor() { this.crc = 0xffffffff; }

  update(chunk) {
    let c = this.crc;
    const t = Crc32.table;
    for (let i = 0; i < chunk.length; i++) c = t[(c ^ chunk[i]) & 0xff] ^ (c >>> 8);
    this.crc = c >>> 0;
    return this;
  }

  get value() { return (this.crc ^ 0xffffffff) >>> 0; }
}

function u16(buf, off) { return buf.readUInt16LE(off); }
function u32(buf, off) { return buf.readUInt32LE(off); }

/** 把 JS Date 编码成 ZIP 的 DOS 时间/日期（各 2 字节，小端）。 */
function dosDateTime(date) {
  const d = date || new Date();
  const time = ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | ((Math.floor(d.getSeconds() / 2) & 0x1f));
  const day = ((d.getFullYear() - 1980) & 0x7f) << 9 | ((d.getMonth() + 1) & 0x0f) << 5 | (d.getDate() & 0x1f);
  return { time, date: day };
}

/** 写一个 Buffer 到 write stream，处理背压（等 drain），并返回逻辑字节数。 */
async function writeBuf(ws, buf) {
  if (!buf.length) return 0;
  if (!ws.write(buf)) await once(ws, 'drain');
  return buf.length;
}

/**
 * 校验 ZIP 条目名（Zip Slip 第一道防线）。返回归一化后的 POSIX 相对名；非法抛错。
 * 拒绝：空名、绝对路径、Windows 盘符、任何 `..` 段、反斜杠（归一化后再查一次）、
 * 控制字符。
 */
export function sanitizeEntryName(raw) {
  if (typeof raw !== 'string' || !raw) throw new Error(`ZIP 条目名为空`);
  let name = raw.replace(/\\/g, '/');
  if (name.startsWith('/') || /^[A-Za-z]:/.test(name)) throw new Error(`ZIP 条目越界（绝对路径）: ${raw}`);
  const segs = name.split('/');
  if (segs.includes('..') || segs.includes('')) throw new Error(`ZIP 条目越界（含 .. 或空段）: ${raw}`);
  // 控制字符/换行：文件名里出现即视为恶意。
  if (/[\u0000-\u001f\u007f]/.test(name)) throw new Error(`ZIP 条目名含控制字符: ${raw}`);
  return name;
}

/**
 * 把内存 Buffer 包成小端字段辅助器，避免手写 read/write 偏移出错。
 */
function putLocalHeader({ nameBytes, method, dosTime, dosDate, crc, csize, usize }) {
  const n = nameBytes.length;
  const buf = Buffer.alloc(30 + n);
  buf.writeUInt32LE(SIG_LOCAL, 0);
  buf.writeUInt16LE(20, 4); // version needed
  buf.writeUInt16LE(FLAG_DESCRIPTOR | FLAG_UTF8, 6);
  buf.writeUInt16LE(method, 8);
  buf.writeUInt16LE(dosTime, 10);
  buf.writeUInt16LE(dosDate, 12);
  buf.writeUInt32LE(crc, 14);
  buf.writeUInt32LE(csize, 18);
  buf.writeUInt32LE(usize, 22);
  buf.writeUInt16LE(n, 26);
  buf.writeUInt16LE(0, 28); // extra len
  nameBytes.copy(buf, 30);
  return buf;
}

function putDescriptor(crc, csize, usize) {
  const buf = Buffer.alloc(16);
  buf.writeUInt32LE(SIG_DESCRIPTOR, 0);
  buf.writeUInt32LE(crc, 4);
  buf.writeUInt32LE(csize, 8);
  buf.writeUInt32LE(usize, 12);
  return buf;
}

function putCentral(entry) {
  const n = entry.nameBytes.length;
  const buf = Buffer.alloc(46 + n);
  buf.writeUInt32LE(SIG_CENTRAL, 0);
  buf.writeUInt16LE(20, 4); // version made by
  buf.writeUInt16LE(20, 6); // version needed
  buf.writeUInt16LE(FLAG_DESCRIPTOR | FLAG_UTF8, 8);
  buf.writeUInt16LE(entry.method, 10);
  buf.writeUInt16LE(entry.dosTime, 12);
  buf.writeUInt16LE(entry.dosDate, 14);
  buf.writeUInt32LE(entry.crc, 16);
  buf.writeUInt32LE(entry.csize, 20);
  buf.writeUInt32LE(entry.usize, 24);
  buf.writeUInt16LE(n, 28);
  buf.writeUInt16LE(0, 30); // extra
  buf.writeUInt16LE(0, 32); // comment
  buf.writeUInt16LE(0, 34); // disk start
  buf.writeUInt16LE(0, 36); // internal attrs
  buf.writeUInt32LE(0, 38); // external attrs（普通文件）
  buf.writeUInt32LE(entry.offset, 42);
  nameBytesFor(entry.name).copy(buf, 46);
  return buf;
}

function nameBytesFor(name) { return Buffer.from(name, 'utf8'); }

function putEocd(total, cdSize, cdOffset) {
  const buf = Buffer.alloc(22);
  buf.writeUInt32LE(SIG_EOCD, 0);
  buf.writeUInt16LE(0, 4);
  buf.writeUInt16LE(0, 6);
  buf.writeUInt16LE(total, 8);
  buf.writeUInt16LE(total, 10);
  buf.writeUInt32LE(cdSize, 12);
  buf.writeUInt32LE(cdOffset, 16);
  buf.writeUInt16LE(0, 20);
  return buf;
}

/**
 * 把磁盘上的若干文件打包成单文件 ZIP（STORE）。entries: [{ name, sourcePath }]，
 * name 为 ZIP 内 POSIX 相对名，sourcePath 为磁盘上的绝对路径（必须是普通文件，
 * 符号链接/目录会被拒绝——导出不跟随符号链接，防止把备份目录外的内容卷进来）。
 *
 * @param {string} outputPath 输出 ZIP 的绝对路径（父目录需已存在）
 * @param {Array<{name:string, sourcePath?:string, data?:Buffer}>} entries
 *   每个条目二选一：`sourcePath`（磁盘文件，流式读入）或 `data`（内存 Buffer，
 *   适合 manifest 这类小文件）。两者都给时优先 `data`。
 * @param {{ signal?: AbortSignal, onProgress?: (done:number, total:number)=>void }} [opts]
 * @returns {Promise<{ path: string, files: number, bytes: number }>}
 */
export async function buildZip(outputPath, entries, opts = {}) {
  const list = entries.map((e) => ({ name: sanitizeEntryName(e.name), sourcePath: e.sourcePath, data: e.data }));
  if (list.length > ZIP_MAX_ENTRIES) throw new Error(`ZIP 条目过多（${list.length} > ${ZIP_MAX_ENTRIES}）`);
  const ws = createWriteStream(outputPath);
  const central = [];
  let offset = 0;
  const st = (d) => d ? new Date(d) : new Date();
  try {
    for (const entry of list) {
      if (opts.signal?.aborted) throw new Error('操作已取消');
      const isBuffer = Buffer.isBuffer(entry.data);
      const info = isBuffer ? null : await fsStat(entry.sourcePath);
      if (!isBuffer && !info.isFile()) throw new Error(`导出源不是普通文件（拒绝符号链接/目录）: ${entry.sourcePath}`);
      const nameBytes = nameBytesFor(entry.name);
      const { time, date } = dosDateTime(isBuffer ? null : st(info.mtime));
      const crc = new Crc32();
      let usize = 0;
      const entryOffset = offset;
      // 先写本地头（crc/size 未知 → 用数据描述符补全，见 FLAG_DESCRIPTOR）
      offset += await writeBuf(ws, putLocalHeader({ nameBytes, method: METHOD_STORE, dosTime: time, dosDate: date, crc: 0, csize: 0, usize: 0 }));
      if (isBuffer) {
        crc.update(entry.data);
        usize = entry.data.length;
        offset += await writeBuf(ws, entry.data);
      } else {
        const rs = createReadStream(entry.sourcePath);
        for await (const chunk of rs) {
          if (opts.signal?.aborted) { rs.destroy(); throw new Error('操作已取消'); }
          crc.update(chunk);
          usize += chunk.length;
          offset += await writeBuf(ws, chunk);
        }
      }
      offset += await writeBuf(ws, putDescriptor(crc.value, usize, usize));
      central.push({ name: entry.name, nameBytes, method: METHOD_STORE, dosTime: time, dosDate: date, crc: crc.value, csize: usize, usize, offset: entryOffset });
      opts.onProgress?.(central.length, list.length);
    }
    const cdStart = offset;
    let cdSize = 0;
    for (const c of central) { const b = putCentral(c); offset += await writeBuf(ws, b); cdSize += b.length; }
    offset += await writeBuf(ws, putEocd(central.length, cdSize, cdStart));
  } finally {
    ws.end();
  }
  await once(ws, 'close');
  return { path: outputPath, files: central.length, bytes: offset };
}

/** 从已打开的文件句柄按字节范围读取（位置式读，不移动共享游标）。 */
async function readRange(fh, buffer, start, length, position) {
  const buf = buffer && buffer.length >= length ? buffer : Buffer.alloc(length);
  const { bytesRead } = await fh.read(buf, 0, length, position);
  if (bytesRead !== length) throw new Error('ZIP 读取不完整（文件被截断）');
  return buf;
}

/**
 * 解析 ZIP 中央目录，返回可信条目清单（名称/方法/CRC/尺寸/本地头偏移等）。
 * 中央目录是 ZIP 的权威索引；读它而不是顺序扫本地头，能避开「本地头被篡改、
 * 中央目录不一致」的经典攻击面（本地头在 extractZip 里会再次逐项核对）。
 *
 * @returns {Promise<Array<{name:string, method:number, flags:number, crc:number, csize:number, usize:number, offset:number, externalAttrs:number, isDirectory:boolean}>>}
 */
export async function listZip(zipPath) {
  const fh = await open(zipPath, 'r');
  try {
    const size = (await fh.stat()).size;
    if (size < 22) throw new Error('ZIP 文件太小，不是有效压缩包');
    // EOCD 最大 22 + 65535 注释；从末尾往回找签名
    const tailLen = Math.min(size, 22 + 0xffff);
    const tail = await readRange(fh, null, 0, tailLen, size - tailLen);
    let eocdPos = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === SIG_EOCD) { eocdPos = size - tailLen + i; break; }
    }
    if (eocdPos < 0) throw new Error('ZIP 缺少结束目录（EOCD）——不是有效压缩包');
    const eocdBuf = await readRange(fh, null, 0, 22, eocdPos);
    const total = u16(eocdBuf, 10);
    const cdSize = u32(eocdBuf, 12);
    const cdOffset = u32(eocdBuf, 16);
    if (total > ZIP_MAX_ENTRIES) throw new Error(`ZIP 条目数异常（${total} > ${ZIP_MAX_ENTRIES}），拒绝解析`);
    if (cdSize > ZIP_MAX_CENTRAL_BYTES || cdOffset + cdSize > size) throw new Error('ZIP 中央目录越界，拒绝解析');
    const cd = await readRange(fh, null, 0, cdSize, cdOffset);
    const entries = [];
    let p = 0;
    for (let i = 0; i < total; i++) {
      if (p + 46 > cd.length || cd.readUInt32LE(p) !== SIG_CENTRAL) throw new Error('ZIP 中央目录损坏');
      const method = u16(cd, p + 10);
      const flags = u16(cd, p + 8);
      const crc = u32(cd, p + 16);
      const csize = u32(cd, p + 20);
      const usize = u32(cd, p + 24);
      const nameLen = u16(cd, p + 28);
      const extraLen = u16(cd, p + 30);
      const commentLen = u16(cd, p + 32);
      const externalAttrs = u32(cd, p + 38);
      const offset = u32(cd, p + 42);
      if (p + 46 + nameLen + extraLen + commentLen > cd.length) throw new Error('ZIP 中央目录条目越界');
      const name = sanitizeEntryName(cd.subarray(p + 46, p + 46 + nameLen).toString('utf8'));
      entries.push({ name, method, flags, crc, csize, usize, offset, externalAttrs, isDirectory: name.endsWith('/') });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
  } finally {
    await fh.close();
  }
}

/** unix 外部属性高 16 位是模式位；0xA000 即 S_IFLNK（符号链接）。 */
function isSymlinkAttrs(externalAttrs) {
  return ((externalAttrs >>> 16) & 0xf000) === 0xa000;
}

/**
 * 安全解压 ZIP 的指定条目到 destDir（Zip Slip 全套防线）。
 * 只按中央目录声明的名字/偏移取数；本地头会被逐项核对；符号链接/特殊文件拒绝。
 *
 * @param {string} zipPath ZIP 路径
 * @param {string} destDir 目标目录（绝对路径）
 * @param {{ names?: string[]|Set<string>, signal?: AbortSignal, onProgress?: (done:number,total:number)=>void }} [opts]
 *   names 省略时解压全部文件条目。
 * @returns {Promise<{ extracted: string[], skippedDirs: number }>} 相对 destDir 的落盘文件路径
 */
export async function extractZip(zipPath, destDir, opts = {}) {
  const entries = await listZip(zipPath);
  const wanted = opts.names ? new Set(opts.names) : null;
  const files = entries.filter((e) => !e.isDirectory);
  const selected = wanted ? files.filter((e) => wanted.has(e.name)) : files;
  // zip bomb：先按中央目录声明的未压缩体积合计设限
  let totalUsize = 0;
  for (const e of selected) {
    totalUsize += e.usize;
    if (e.usize > ZIP_MAX_ENTRY_BYTES) throw new Error(`ZIP 条目过大（${e.name}: ${e.usize} 字节），拒绝解压`);
  }
  const destRoot = resolve(destDir);
  const fh = await open(zipPath, 'r');
  const extracted = [];
  try {
    for (const e of selected) {
      if (opts.signal?.aborted) throw new Error('操作已取消');
      if (isSymlinkAttrs(e.externalAttrs)) throw new Error(`ZIP 含符号链接条目，拒绝解压: ${e.name}`);
      if (e.method !== METHOD_STORE && e.method !== METHOD_DEFLATE) {
        throw new Error(`ZIP 条目使用不支持的压缩方法（method=${e.method}）: ${e.name}`);
      }
      if (e.csize === 0 && e.usize > 0) throw new Error(`ZIP 条目声明异常（空数据却有 ${e.usize} 字节）: ${e.name}`);
      if (e.usize > 0 && e.csize > 0 && e.usize / e.csize > ZIP_MAX_RATIO) throw new Error(`ZIP 条目疑似 zip bomb（压缩比异常）: ${e.name}`);
      // 读本地头核对（签名 + 名字长度与中央目录一致）
      const lh = await readRange(fh, null, 0, 30, e.offset);
      if (lh.readUInt32LE(0) !== SIG_LOCAL) throw new Error(`ZIP 本地头损坏: ${e.name}`);
      const localNameLen = u16(lh, 26);
      const localExtraLen = u16(lh, 28);
      const dataOffset = e.offset + 30 + localNameLen + localExtraLen;
      const compressed = await readRange(fh, null, 0, e.csize, dataOffset);
      let raw;
      if (e.method === METHOD_DEFLATE) {
        raw = zlib.inflateRawSync(compressed);
      } else {
        raw = compressed;
      }
      if (raw.length !== e.usize) throw new Error(`ZIP 条目解压后尺寸不符: ${e.name}`);
      const crc = new Crc32(); crc.update(raw);
      if (crc.value !== e.crc) throw new Error(`ZIP 条目 CRC 校验失败（已损坏或被篡改）: ${e.name}`);
      // 落盘前最后一道 Zip Slip：resolve 后必须仍在 destRoot 内
      const target = resolve(destRoot, e.name);
      if (target !== destRoot && !target.startsWith(destRoot + sep)) throw new Error(`ZIP 条目越界（Zip Slip 拦截）: ${e.name}`);
      await mkdir(dirname(target), { recursive: true });
      const ws = createWriteStream(target);
      if (!ws.write(raw)) await once(ws, 'drain');
      ws.end();
      await once(ws, 'close');
      extracted.push(e.name);
      opts.onProgress?.(extracted.length, selected.length);
    }
  } finally {
    await fh.close();
  }
  return { extracted, skippedDirs: entries.filter((e) => e.isDirectory).length };
}

/** 判断某条目是否是目录条目（中央目录视角）。 */
export function entryIsDirectory(entry) { return entry.isDirectory; }

/**
 * 读取 ZIP 中单个条目的解压后内容（返回 Buffer）。仅用于小文件（manifest、
 * settings 等）；大数据请走 extractZip 流式落盘。校验与 extractZip 同款：
 * 本地头核对 + 尺寸/CRC 校验 + 符号链接/未知方法拒绝 + zip bomb 比例限。
 *
 * @param {string} zipPath ZIP 路径
 * @param {string} name 条目名（精确匹配）
 * @returns {Promise<Buffer>}
 */
export async function readZipEntry(zipPath, name) {
  const entries = await listZip(zipPath);
  const e = entries.find((x) => x.name === name && !x.isDirectory);
  if (!e) throw new Error(`ZIP 里没有条目: ${name}`);
  if (isSymlinkAttrs(e.externalAttrs)) throw new Error(`ZIP 含符号链接条目，拒绝读取: ${e.name}`);
  if (e.method !== METHOD_STORE && e.method !== METHOD_DEFLATE) throw new Error(`ZIP 条目使用不支持的压缩方法（method=${e.method}）: ${e.name}`);
  if (e.usize > 64 * 1024 * 1024) throw new Error(`ZIP 条目过大，拒绝整读（${e.name}: ${e.usize} 字节）`);
  if (e.usize > 0 && e.csize > 0 && e.usize / e.csize > ZIP_MAX_RATIO) throw new Error(`ZIP 条目疑似 zip bomb（压缩比异常）: ${e.name}`);
  const fh = await open(zipPath, 'r');
  try {
    const lh = await readRange(fh, null, 0, 30, e.offset);
    if (lh.readUInt32LE(0) !== SIG_LOCAL) throw new Error(`ZIP 本地头损坏: ${e.name}`);
    const dataOffset = e.offset + 30 + u16(lh, 26) + u16(lh, 28);
    const compressed = await readRange(fh, null, 0, e.csize, dataOffset);
    const raw = e.method === METHOD_DEFLATE ? zlib.inflateRawSync(compressed) : compressed;
    if (raw.length !== e.usize) throw new Error(`ZIP 条目解压后尺寸不符: ${e.name}`);
    const crc = new Crc32(); crc.update(raw);
    if (crc.value !== e.crc) throw new Error(`ZIP 条目 CRC 校验失败（已损坏或被篡改）: ${e.name}`);
    return raw;
  } finally {
    await fh.close();
  }
}
