/**
 * dsh-backup — 多通道同步的传输层（P3 宿主半边）。
 *
 * 零 npm 依赖：只用 node:crypto（签名/哈希）+ 全局 fetch（Node ≥18）。
 * 三个通道共享同一套「可移植集合」产物：归档 + .sha256 + .meta.json +
 * .redacted.json + .encrypted.json 边车（调用方负责组装文件清单，这里只做
 * 「把一个字节流 PUT 到远端某个路径」的原子动作）。
 *
 * 安全边界（硬性）：
 *  - 凭据（password/secretKey/token）只作为函数入参内存态流转，绝不写
 *    settings.yaml、绝不进日志——下方任何错误信息都不回显凭据本身。
 *  - 签名密钥只进 HMAC，不进 Authorization 之外的任何输出。
 */

import { createHash, createHmac } from 'node:crypto';

const sha256hex = (buf) => createHash('sha256').update(buf).digest('hex');
const hmac = (key, data) => createHmac('sha256', key).update(data).digest();

/** 把 Buffer 切成 ASCII 十六进制（S3 SigV4 需要） */
const hmacHex = (key, data) => createHmac('sha256', key).update(data).digest('hex');

/**
 * 计算 AWS Signature V4 请求签名。仅覆盖本插件需要的 PUT（无 query、无
 * content-type、固定头集 host;x-amz-content-sha256;x-amz-date）。路径只做
 * 「按 / 分段 encodeURIComponent」的保守编码——我们的 key 都是 `dsh-…` /
 * `dsh-config-…` 这类安全文件名，不出现需要特殊处理的字符。
 *
 * @returns {{authorization:string, amzDate:string, payloadHash:string, host:string}}
 */
function sigv4Sign({ method, host, path, region, accessKey, secretKey, body, service = 's3' }) {
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, ''); // YYYYMMDDTHHMMSSZ
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256hex(body);
  // 规范路径：按段编码，保留段内已有的 / 分隔（我们的 key 不含需编码字符）
  const canonicalUri = path.split('/').map((seg) => encodeURIComponent(seg)).join('/');
  const canonicalHeaders = `host:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
  const canonicalRequest = [method, canonicalUri, '', canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(Buffer.from(canonicalRequest, 'utf8'))].join('\n');
  const kDate = hmac(Buffer.from(`AWS4${secretKey}`, 'utf8'), dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  const kSigning = hmac(kService, 'aws4_request');
  const signature = hmacHex(kSigning, stringToSign);
  const authorization = `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return { authorization, amzDate, payloadHash, host };
}

/** 读一个 Buffer 走 fetch，2xx 视为成功；非 2xx 抛「人话 + HTTP 状态」，不回显凭据。 */
async function fetchPut(url, { headers, body, signal, auth = null }) {
  const h = { ...headers };
  if (auth) h.authorization = auth;
  let res;
  try {
    res = await fetch(url, { method: 'PUT', headers: h, body, signal, redirect: 'follow' });
  } catch (err) {
    if (err && err.name === 'AbortError') throw new Error('操作已取消');
    throw new Error(`网络请求失败（${String(err && err.message ? err.message : err).slice(0, 160)}）`);
  }
  if (res.ok) return { ok: true };
  let detail = '';
  try { detail = (await res.text()).slice(0, 200); } catch { /* 忽略响应体读取失败 */ }
  throw new Error(`远端返回 HTTP ${res.status}（${detail || res.statusText}）`);
}

/**
 * S3 兼容 PUT（AWS S3 / MinIO / Aliyun OSS / Tencent COS / Qiniu KODO 的
 * S3 兼容入口均走同一套 SigV4 + 可配置 endpoint）。pathStyle=true 用
 * `/{bucket}/{key}`（MinIO/自托管/大多数兼容层）；false 用虚拟主机风格
 * `https://{bucket}.{host}/{key}`。
 *
 * @param {{endpoint:string, region:string, bucket:string, key:string, body:Buffer,
 *          accessKey:string, secretKey:string, pathStyle?:boolean, signal?:AbortSignal}} cfg
 * @returns {Promise<{ok:boolean}>}
 */
export async function s3Put(cfg) {
  const { endpoint, region, bucket, key, body, accessKey, secretKey, pathStyle = true, signal } = cfg;
  const u = new URL(endpoint.endsWith('/') ? endpoint : `${endpoint}/`);
  const basePath = u.pathname.replace(/\/+$/, '');
  const objPath = pathStyle
    ? `${basePath}/${bucket}/${key}`.replace(/\/{2,}/g, '/')
    : `${basePath}/${key}`.replace(/\/{2,}/g, '/');
  const host = pathStyle ? u.host : `${bucket}.${u.host}`;
  const sign = sigv4Sign({ method: 'PUT', host, path: objPath, region, accessKey, secretKey, body, service: 's3' });
  const url = `${u.protocol}//${host}${objPath}`;
  return fetchPut(url, {
    headers: {
      'x-amz-date': sign.amzDate,
      'x-amz-content-sha256': sign.payloadHash,
      'content-type': 'application/octet-stream',
    },
    body,
    signal,
    auth: sign.authorization,
  });
}

/**
 * WebDAV PUT：用 Basic auth（username/password）把字节流 PUT 到远端路径，
 * 并先 MKCOL 建立父集合（已存在返回 405 可容忍）。url 形如
 * `https://host/dav/`，key 拼在其后。
 */
export async function webdavPut({ url, username, password, key, body, signal }) {
  const base = url.endsWith('/') ? url : `${url}/`;
  // 逐层 MKCOL 父目录（容错 405/409：已存在）
  const segs = key.split('/').slice(0, -1);
  let dir = base;
  const auth = `Basic ${Buffer.from(`${username || ''}:${password || ''}`, 'utf8').toString('base64')}`;
  for (const seg of segs) {
    if (!seg) continue;
    dir += `${encodeURIComponent(seg)}/`;
    try {
      await fetch(dir, { method: 'MKCOL', headers: { authorization: auth }, signal });
    } catch { /* 网络错误下放到最终 PUT 报错 */ }
  }
  return fetchPut(`${base}${key.split('/').map((s) => encodeURIComponent(s)).join('/')}`, {
    headers: { 'content-type': 'application/octet-stream' },
    body,
    signal,
    auth,
  });
}

/**
 * GitHub Gist 同步：创建/更新一个 gist。gist 内容只能是文本，故二进制归档
 * 以 base64 编码、边车（JSON，已是文本）原样放入。`files` = { [远端文件名]:
 * { content: string } }。gistId 为空则创建（POST），否则更新（PATCH）。
 * 调用方负责 size 上限（gist 有 300MB 总上限、单文件约 10MB）。
 */
export async function gistSync({ token, gistId, files, description, signal, apiBase = 'https://api.github.com' }) {
  const headers = {
    authorization: `token ${token}`,
    accept: 'application/vnd.github+json',
    'content-type': 'application/json',
  };
  const payload = { description: description || 'dsh-backup sync', public: false, files };
  const url = gistId
    ? `${apiBase}/gists/${encodeURIComponent(gistId)}`
    : `${apiBase}/gists`;
  let res;
  try {
    res = await fetch(url, { method: gistId ? 'PATCH' : 'POST', headers, body: JSON.stringify(payload), signal });
  } catch (err) {
    if (err && err.name === 'AbortError') throw new Error('操作已取消');
    throw new Error(`Gist 请求失败（${String(err && err.message ? err.message : err).slice(0, 160)}）`);
  }
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.text()).slice(0, 200); } catch { /* 忽略 */ }
    throw new Error(`Gist API 返回 HTTP ${res.status}（${detail || res.statusText}）`);
  }
  const data = await res.json();
  return { ok: true, gistId: data?.id || gistId, htmlUrl: data?.html_url || null };
}

/** 暴露给调用方：把 Buffer 转 gist 文件内容（二进制 base64、JSON 文本原样）。 */
export function gistContent(buf, { binary = false } = {}) {
  return binary ? buf.toString('base64') : buf.toString('utf8');
}
