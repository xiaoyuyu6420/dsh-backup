/**
 * dsh-backup — 可选口令加密（P2 宿主半边）。
 *
 * 纯 node:crypto 实现，零外部依赖：scrypt（KDF，内存难哈希，抗口令穷举）派生
 * 256 位密钥，AES-256-GCM（AEAD，密文自带认证）加密。每次加密随机生成
 * salt 与 nonce（IV），GCM 的认证标签一并写入边车——口令错误或密文被篡改都会
 * 让 final() 抛认证失败，绝无「解密出半个错文件」的可能。
 *
 * 安全边界（硬性）：
 *  - 口令只作为函数入参在内存里流转，**绝不写 settings.yaml、绝不进日志、
 *    绝不写盘**。调用方（backupPanel RPC）在客户端内存里持口令，传过来用完即弃。
 *  - 密文布局：归档文件本身只存 ciphertext（不含 nonce/tag），nonce/tag/salt/
 *    kdf 参数全在 `.encrypted.json` 边车里。边车是恢复时唯一需要的参数来源，
 *    不含任何明文内容，可随密文一起备份/同步。
 *
 * 版本契约：sidecar.version 递增；读端对未知 version 一律拒绝（宁可不恢复，
 * 也不拿不认识的参数猜着解）。
 */

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scrypt as scryptCb,
} from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb);

/** 边车/密文格式版本。 */
export const ENCRYPT_VERSION = 1;
/** 加密算法标识（写进边车供读端核对，避免未来换算法时静默误解密）。 */
export const CIPHER = 'aes-256-gcm';
/** scrypt 参数：N=16384（2^14）、r=8、p=1——行业常见默认，约 16MB 内存、~50ms。 */
export const KDF_PARAMS = Object.freeze({ algorithm: 'scrypt', N: 16384, r: 8, p: 1, keyLen: 32 });
/** GCM 推荐 nonce 长度（12 字节）与认证标签长度（16 字节）。 */
export const NONCE_BYTES = 12;
export const SALT_BYTES = 16;
export const TAG_BYTES = 16;

/**
 * 由口令 + 边车里的参数派生 AES 密钥。scrypt 的 maxmem 显式放宽到参数所需
 * 内存的两倍余量（N=16384,r=8 → 128*N*r = 16MB），避免默认 32MB 上限在未来
 * 参数升级时误杀。
 */
async function deriveKey(password, params) {
  const N = Number(params?.N) || KDF_PARAMS.N;
  const r = Number(params?.r) || KDF_PARAMS.r;
  const p = Number(params?.p) || KDF_PARAMS.p;
  const keyLen = Number(params?.keyLen) || KDF_PARAMS.keyLen;
  const maxmem = 128 * N * r * 2 + 1024 * 1024;
  return scrypt(password, params.salt, keyLen, { N, r, p, maxmem });
}

/**
 * 加密一段明文，返回 { ciphertext, sidecar }。
 *
 * @param {Buffer|Uint8Array} plaintext 明文（tar.gz 字节）
 * @param {string} password 口令（内存态，绝不落盘）
 * @returns {Promise<{ ciphertext: Buffer, sidecar: object }>}
 */
export async function encryptBuffer(plaintext, password) {
  if (typeof password !== 'string' || !password) {
    throw new Error('加密需要非空口令（口令只经内存传入，绝不写盘）');
  }
  const salt = randomBytes(SALT_BYTES);
  const nonce = randomBytes(NONCE_BYTES);
  const key = await deriveKey(password, { ...KDF_PARAMS, salt });
  const cipher = createCipheriv(CIPHER, key, nonce);
  const body = Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(plaintext);
  const ciphertext = Buffer.concat([cipher.update(body), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    ciphertext,
    sidecar: {
      version: ENCRYPT_VERSION,
      cipher: CIPHER,
      kdf: KDF_PARAMS.algorithm,
      kdfParams: {
        N: KDF_PARAMS.N,
        r: KDF_PARAMS.r,
        p: KDF_PARAMS.p,
        keyLen: KDF_PARAMS.keyLen,
      },
      salt: salt.toString('base64'),
      nonce: nonce.toString('base64'),
      authTag: authTag.toString('base64'),
      ciphertextSize: ciphertext.length,
    },
  };
}

/**
 * 校验边车并派生出解开这段密文所需的 { key, nonce, authTag }。
 * 版本/算法/字段缺失一律拒绝（宁可不恢复，也不拿不认识的参数猜着解）。
 */
async function unlock(sidecar, password) {
  if (typeof password !== 'string' || !password) {
    throw new Error('这份备份已加密，恢复需要口令（口令只经内存传入，绝不写盘）');
  }
  if (!sidecar || typeof sidecar !== 'object') {
    throw new Error('加密边车缺失或损坏，无法解密（请核对备份是否完整）');
  }
  if (Number(sidecar.version) !== ENCRYPT_VERSION) {
    throw new Error(`加密格式版本不兼容（边车 version=${sidecar.version}，本机支持 ${ENCRYPT_VERSION}）——请用更新版本的插件恢复`);
  }
  // 算法门：未知/缺失 cipher 一律拒绝（严格 !==，宁可不可恢复也不拿错误算法猜着解）。
  if (sidecar.cipher !== CIPHER) {
    throw new Error(`不支持的加密算法: ${sidecar.cipher ?? '（缺失）'}（本机只支持 ${CIPHER}）`);
  }
  const salt = sidecar.salt ? Buffer.from(sidecar.salt, 'base64') : null;
  const nonce = sidecar.nonce ? Buffer.from(sidecar.nonce, 'base64') : null;
  const authTag = sidecar.authTag ? Buffer.from(sidecar.authTag, 'base64') : null;
  if (!salt || !nonce || !authTag) {
    throw new Error('加密边车字段缺失（salt/nonce/authTag），无法解密');
  }
  const key = await deriveKey(password, { ...(sidecar.kdfParams || KDF_PARAMS), salt });
  return { key, nonce, authTag };
}

/** GCM 认证失败的统一人话报错（不泄露具体原因）。 */
function authFailed(err) {
  if (/unable to authenticate|authentication/i.test(String(err && err.message ? err.message : err))) {
    return new Error('口令错误或归档已损坏（AES-GCM 认证失败）——请核对口令后重试');
  }
  return err;
}

/**
 * 解密一段密文（内存版，供小体积数据/测试用）。口令错误 / 密文被篡改时 AES-GCM
 * 认证失败，抛出口令错误人话报错（调用方可直接展示）。
 *
 * @param {Buffer|Uint8Array} ciphertext 密文（归档文件内容）
 * @param {object} sidecar `.encrypted.json` 解析出的对象
 * @param {string} password 口令（内存态）
 * @returns {Promise<Buffer>} 明文（tar.gz 字节）
 */
export async function decryptBuffer(ciphertext, sidecar, password) {
  const { key, nonce, authTag } = await unlock(sidecar, password);
  const decipher = createDecipheriv(CIPHER, key, nonce);
  decipher.setAuthTag(authTag);
  const body = Buffer.isBuffer(ciphertext) ? ciphertext : Buffer.from(ciphertext);
  try {
    return Buffer.concat([decipher.update(body), decipher.final()]);
  } catch (err) {
    throw authFailed(err);
  }
}

/**
 * 加密文件：**分块流式**，不整包入内存（归档可以远超 Buffer 上限）。
 * 调用方负责把输出写到临时路径后自己 `rename` 覆盖（本函数只保证「要么完整
 * 密文、要么失败且不留半截文件」）。
 *
 * @param {string} inPath 明文文件
 * @param {string} outPath 密文输出文件
 * @param {string} password 口令
 * @returns {Promise<{ sidecar: object, ciphertextSize: number }>}
 */
export async function encryptFile(inPath, outPath, password) {
  if (typeof password !== 'string' || !password) {
    throw new Error('加密需要非空口令（口令只经内存传入，绝不写盘）');
  }
  const salt = randomBytes(SALT_BYTES);
  const nonce = randomBytes(NONCE_BYTES);
  const key = await deriveKey(password, { ...KDF_PARAMS, salt });
  const cipher = createCipheriv(CIPHER, key, nonce);
  let ciphertextSize = 0;
  const counter = new Transform({
    transform(chunk, _enc, done) {
      ciphertextSize += chunk.length;
      done(null, chunk);
    },
  });
  try {
    await pipeline(
      createReadStream(inPath),
      cipher,
      counter,
      createWriteStream(outPath, { mode: 0o600 }),
    );
  } catch (err) {
    await rm(outPath, { force: true }).catch(() => {});
    throw err;
  }
  const authTag = cipher.getAuthTag();
  return {
    ciphertextSize,
    sidecar: {
      version: ENCRYPT_VERSION,
      cipher: CIPHER,
      kdf: KDF_PARAMS.algorithm,
      kdfParams: {
        N: KDF_PARAMS.N,
        r: KDF_PARAMS.r,
        p: KDF_PARAMS.p,
        keyLen: KDF_PARAMS.keyLen,
      },
      salt: salt.toString('base64'),
      nonce: nonce.toString('base64'),
      authTag: authTag.toString('base64'),
      ciphertextSize,
    },
  };
}

/**
 * 解密文件：**分块流式**。认证通过才产出完整明文；口令错/密文被改时删除半截
 * 输出并抛人话报错（绝不留下「解了一半」的明文）。
 *
 * @param {string} inPath 密文文件
 * @param {string} outPath 明文输出文件（可能不完整；失败时已被删除）
 * @param {object} sidecar `.encrypted.json` 内容
 * @param {string} password 口令
 */
export async function decryptFile(inPath, outPath, sidecar, password) {
  const { key, nonce, authTag } = await unlock(sidecar, password);
  const decipher = createDecipheriv(CIPHER, key, nonce);
  decipher.setAuthTag(authTag);
  try {
    await pipeline(
      createReadStream(inPath),
      decipher,
      createWriteStream(outPath, { mode: 0o600 }),
    );
  } catch (err) {
    await rm(outPath, { force: true }).catch(() => {});
    throw authFailed(err);
  }
}
