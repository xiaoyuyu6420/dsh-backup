import { open as openSessionFile } from 'node:fs/promises';
import { StringDecoder } from 'node:string_decoder';
import * as zlib from 'node:zlib';
const ZSTD_MAGIC = 0xfd2fb528;

// Mirrored into standalone rescue.mjs; regression-doctor.mjs checks exact parity.
const SESSION_LIMITS = Object.freeze({ input: 64 * 1024 * 1024, decoded: 64 * 1024 * 1024,
  frame: 16 * 1024 * 1024, line: 8 * 1024 * 1024, lines: 200000, frames: 200000 });
class SessionLimitError extends Error {
  constructor(limit) { super(`会话校验达到资源上限（${limit}），未验证；不代表文件损坏`); this.code = 'SESSION_VALIDATION_LIMIT'; }
}
class SessionCorruptError extends Error {}

// Bound the read itself, including a file growing after stat; never readFile then check.
async function readSessionBytes(file) {
  const handle = await openSessionFile(file, 'r');
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error('不是普通会话文件，未验证');
    if (before.size > SESSION_LIMITS.input) throw new SessionLimitError('输入字节数');
    const chunks = [];
    let total = 0;
    while (true) {
      const chunk = Buffer.alloc(Math.min(65536, SESSION_LIMITS.input + 1 - total));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (!bytesRead) break;
      total += bytesRead;
      if (total > SESSION_LIMITS.input) throw new SessionLimitError('输入字节数');
      chunks.push(chunk.subarray(0, bytesRead));
    }
    const after = await handle.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs)
      throw new Error('读取时会话发生变化，未验证');
    return Buffer.concat(chunks, total);
  } finally { await handle.close(); }
}

function sessionLineCollector() {
  const decoder = new StringDecoder('utf8');
  const lines = [];
  let pending = '', decoded = 0;
  function consume(text) {
    let start = 0, end;
    while ((end = text.indexOf('\n', start)) !== -1) {
      pending += text.slice(start, end);
      if (Buffer.byteLength(pending) > SESSION_LIMITS.line) throw new SessionLimitError('单行字节数');
      if (pending.length) {
        if (lines.length >= SESSION_LIMITS.lines) throw new SessionLimitError('逻辑行数');
        lines.push(pending);
      }
      pending = ''; start = end + 1;
    }
    pending += text.slice(start);
    if (Buffer.byteLength(pending) > SESSION_LIMITS.line) throw new SessionLimitError('单行字节数');
  }
  return {
    remaining: () => SESSION_LIMITS.decoded - decoded,
    push(out) {
      decoded += out.length;
      if (decoded > SESSION_LIMITS.decoded) throw new SessionLimitError('解压总字节数');
      consume(decoder.write(out));
    },
    finish() { consume(decoder.end() + '\n'); return lines; },
  };
}

function decompressSessionFrame(buf, maxOutputLength = SESSION_LIMITS.frame) {
  try {
    return zlib.zstdDecompressSync(buf, { maxOutputLength,
      params: { [zlib.constants.ZSTD_d_windowLogMax]: 26 } });
  } catch (err) {
    if (err.code === 'ERR_BUFFER_TOO_LARGE' || err.code === 'ZSTD_error_frameParameter_windowTooLarge')
      throw new SessionLimitError('单帧/解压总字节数或解码窗口');
    // Only proven format/decompression defects are corruption. Capability, allocation,
    // I/O and unexpected runtime errors must never authorize destructive repair.
    if (['ZSTD_error_prefix_unknown', 'ZSTD_error_corruption_detected', 'ZSTD_error_checksum_wrong',
      'ZSTD_error_srcSize_wrong', 'ZSTD_error_literals_headerWrong'].includes(err.code))
      throw new SessionCorruptError(err.message);
    throw err;
  }
}

function walkZstdFrames(buf) {
  if (buf.length > SESSION_LIMITS.input) throw new SessionLimitError('输入字节数');
  const frames = [];
  let off = 0;
  while (off < buf.length) {
    if (frames.length >= SESSION_LIMITS.frames) throw new SessionLimitError('帧数');
    if (buf.length - off < 4) throw new SessionCorruptError(`尾部截断（余 ${buf.length - off} 字节不成帧）`);
    const magic = buf.readUInt32LE(off);
    if (magic === ZSTD_MAGIC) {
      let pos = off + 4;
      if (pos >= buf.length) throw new SessionCorruptError('帧头描述符缺失');
      const desc = buf[pos++];
      if (desc & 0x08) throw new SessionCorruptError('帧头保留位置位');
      const singleSegment = Boolean(desc & 0x20);
      const checksum = Boolean(desc & 0x04);
      const dictSize = [0, 1, 2, 4][desc & 0x03];
      const fcsSize = singleSegment ? [1, 2, 4, 8][desc >> 6] : [0, 2, 4, 8][desc >> 6];
      if (!singleSegment) pos += 1; // Window_Descriptor
      pos += dictSize + fcsSize;
      if (pos > buf.length) throw new SessionCorruptError('帧头越界');
      let last = false;
      while (!last) {
        if (buf.length - pos < 3) throw new SessionCorruptError('块头截断');
        const bh = buf.readUIntLE(pos, 3);
        last = Boolean(bh & 0x01);
        const btype = (bh >> 1) & 0x03;
        const bsize = bh >> 3;
        if (btype === 3) throw new SessionCorruptError('保留块类型');
        // Raw/Compressed 块占 bsize 字节；RLE 块只占 1 字节
        pos += 3 + (btype === 1 ? 1 : bsize);
        if (pos > buf.length) throw new SessionCorruptError('块数据越界');
      }
      if (checksum) {
        if (buf.length - pos < 4) throw new SessionCorruptError('帧校验和截断');
        pos += 4;
      }
      frames.push([off, pos]);
      off = pos;
    } else if (magic >= 0x184d2a50 && magic <= 0x184d2a5f) {
      throw new SessionCorruptError('遇 skippable 帧——宿主读端不支持任何非数据帧魔数，整个文件将被拒载');
    } else {
      throw new SessionCorruptError(`偏移 ${off} 处不是 zstd 帧魔数`);
    }
  }
  return frames;
}

// Migration/rewind callers historically inspect logical lines without enforcing the
// current container contract. Doctor opts into it; resource bounds apply to all callers.
function decodeZstdLog(buf, { checkHeaderFrame = false, checkHeader } = {}) {
  const collector = sessionLineCollector();
  let headerFrameOk;
  for (const [s, e] of walkZstdFrames(buf)) {
    if (!collector.remaining()) throw new SessionLimitError('解压总字节数');
    const out = decompressSessionFrame(buf.subarray(s, e), Math.min(SESSION_LIMITS.frame, collector.remaining()));
    if (headerFrameOk === undefined) {
      headerFrameOk = out.length > 0 && out.indexOf(10) === out.length - 1;
      if (checkHeaderFrame && !headerFrameOk) throw new SessionCorruptError('首帧不是恰好一行 header——违反容器契约');
    }
    collector.push(out);
    if (checkHeader && headerFrameOk !== undefined) {
      const defect = checkHeader(out.toString('utf8').replace(/\n$/, ''));
      if (defect) throw new SessionCorruptError(defect);
      checkHeader = undefined;
    }
  }
  return { lines: collector.finish(), headerFrameOk };
}

function decodePlainLog(buf) {
  const collector = sessionLineCollector();
  // Also limit temporary strings for uncompressed logs.
  for (let off = 0; off < buf.length; off += 65536) collector.push(buf.subarray(off, off + 65536));
  return collector.finish();
}

export { SESSION_LIMITS, SessionLimitError, SessionCorruptError, readSessionBytes, walkZstdFrames, decompressSessionFrame, decodeZstdLog, decodePlainLog };
