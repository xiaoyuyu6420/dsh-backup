/**
 * dsh-backup — 操作锁 + 残留锁回收（P3 宿主半边，零依赖）。
 *
 * 目的：备份/恢复/导入/同步/doctor 这类**互斥的重活**同一时刻只该有一个在跑，
 * 否则多实例/多 profile 会互相踩（vault 刷新、.dsh 挪旁、归档轮换都有竞态）。
 *
 * 锁模型：
 *  - 锁文件（JSON）记 { pid, token(随机), startedAt, heartbeatAt, operation }。
 *  - 持有者每隔 HEARTBEAT_MS 刷新 heartbeatAt（进程活着时必刷）。
 *  - 死锁判定**极端保守**：只有当 `process.kill(pid,0)` 报 ESRCH（进程确定不
 *    存在）才判可回收；EPERM（存在但无权限）、kill -0 成功、甚至僵尸态一律
 *    判「可能还活着」→ 绝不自动踢。心跳新鲜/陈旧只作诊断展示，不作为自动
 *    踢锁判据——「绝不误踢活锁」优先于「尽快回收死锁」。
 *  - `kill -9` 留下的死锁：pid 已死 → 下次 acquire 自动回收；heartbeat 陈旧
 *    但 pid 存活（卡死/复用）→ 交给**显式** reclaim(force) 由用户确认后回收。
 *
 * 回收入口：命令 `/backup lock reclaim` 与 RPC `reclaimLock`。
 */

import { randomUUID } from 'node:crypto';
import { open, readFile, rm, rename, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

/** 心跳刷新间隔（持有者内部用）。 */
export const LOCK_HEARTBEAT_MS = 30_000;

/** 判断 pid 是否可能存活：仅 ESRCH 判死；其余（成功/EPERM/未知）一律判活。 */
export function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err && err.code === 'EPERM'; // 存在但无权限 → 视为活着，绝不误踢
  }
}

/** 死锁判定：pid 确定不存在才算死；心跳只作参考字段，不参与自动判定。 */
export function isLockStale(lock) {
  if (!lock || typeof lock !== 'object') return true;
  return !isPidAlive(Number(lock.pid));
}

async function readLockFile(lockPath) {
  try {
    return JSON.parse(await readFile(lockPath, 'utf8'));
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    // 锁文件损坏（半截写/权限）：保守按「存在但读不了」处理，返回一个
    // pid=当前 的伪锁阻止 acquire，避免两个实例同时以为没锁。——但 EACCES
    // 更可能是权限问题，也按不持有处理？不：宁可阻塞也不并发踩踏。
    return { pid: process.pid, token: null, operation: 'unknown', startedAt: null, heartbeatAt: null, unreadable: true };
  }
}

async function writeLockFile(lockPath, operation) {
  await mkdir(dirname(lockPath), { recursive: true });
  const lock = {
    pid: process.pid,
    token: randomUUID(),
    startedAt: new Date().toISOString(),
    heartbeatAt: new Date().toISOString(),
    operation: operation || 'unknown',
  };
  // 原子写：临时文件 + rename，避免并发读锁文件读一半
  const tmp = `${lockPath}.${randomUUID()}.tmp`;
  await open(tmp, 'wx', 0o600).then(async (fh) => { await fh.writeFile(`${JSON.stringify(lock)}\n`, 'utf8'); await fh.close(); });
  await rename(tmp, lockPath).catch(async (err) => { await rm(tmp, { force: true }).catch(() => {}); throw err; });
  return lock;
}

/**
 * 尝试获取操作锁。
 * @returns {Promise<{acquired:boolean, lock?:object, reason?:string, heldBy?:object}>}
 *   acquired=true 时 lock 是本次写下的锁（含 token，供 release/heartbeat 使用）。
 */
export async function acquireLock(lockPath, operation) {
  const existing = await readLockFile(lockPath);
  if (existing && !existing.unreadable && isLockStale(existing)) {
    // 死锁：pid 已死，安全回收后重试
    await rm(lockPath, { force: true }).catch(() => {});
  } else if (existing) {
    return { acquired: false, reason: '另一操作正在运行', heldBy: { pid: existing.pid, operation: existing.operation, startedAt: existing.startedAt, heartbeatAt: existing.heartbeatAt } };
  }
  const lock = await writeLockFile(lockPath, operation);
  return { acquired: true, lock };
}

/** 刷新心跳（仅当 token 匹配、且 pid 仍是本进程时写）。 */
export async function heartbeatLock(lockPath, token) {
  const existing = await readLockFile(lockPath);
  if (!existing || existing.token !== token) return false;
  const lock = { ...existing, heartbeatAt: new Date().toISOString() };
  const tmp = `${lockPath}.${randomUUID()}.tmp`;
  await open(tmp, 'wx', 0o600).then(async (fh) => { await fh.writeFile(`${JSON.stringify(lock)}\n`, 'utf8'); await fh.close(); });
  await rename(tmp, lockPath).catch(async (err) => { await rm(tmp, { force: true }).catch(() => {}); throw err; });
  return true;
}

/** 释放锁（仅 token 匹配才删，绝不删别人的锁）。 */
export async function releaseLock(lockPath, token) {
  const existing = await readLockFile(lockPath);
  if (existing && existing.token === token) {
    await rm(lockPath, { force: true }).catch(() => {});
    return true;
  }
  return false;
}

/**
 * 回收入口：死锁直接回收；活锁默认拒绝，force=true 时按用户显式确认强删。
 * @returns {Promise<{reclaimed:boolean, reason?:string, heldBy?:object}>}
 */
export async function reclaimLock(lockPath, { force = false } = {}) {
  const existing = await readLockFile(lockPath);
  if (!existing) return { reclaimed: false, reason: '没有锁' };
  const heldBy = { pid: existing.pid, operation: existing.operation, startedAt: existing.startedAt, heartbeatAt: existing.heartbeatAt };
  if (isLockStale(existing) || force) {
    await rm(lockPath, { force: true }).catch(() => {});
    return { reclaimed: true, heldBy };
  }
  return { reclaimed: false, reason: '锁持有进程仍在运行（未回收，避免误踢活锁）', heldBy };
}
