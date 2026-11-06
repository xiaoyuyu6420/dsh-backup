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
    return err?.code !== 'ESRCH'; // Only a confirmed missing process may be reclaimed
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

/**
 * A short filesystem transaction serializes all lock mutations across processes.
 * mkdir is exclusive; atomic rename of JSON alone is not mutual exclusion.
 * An unreadable/orphaned guard fails closed (never steal a potentially live writer).
 * The owner record identifies the process for manual recovery after an interrupted
 * metadata transaction. Normal crash recovery uses the main lock's dead PID.
 */
export async function withLockGuard(lockPath, fn, { wait = false } = {}) {
  const guard = `${lockPath}.guard`;
  await mkdir(dirname(lockPath), { recursive: true });
  for (let attempt = 0; ; attempt++) {
    try {
      await mkdir(guard, { mode: 0o700 });
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      if (!wait || attempt >= 100) return { busy: true, guard };
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  try {
    const fh = await open(`${guard}/owner.json`, 'wx', 0o600);
    try { await fh.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })); }
    finally { await fh.close(); }
    return { value: await fn() };
  } finally {
    await rm(guard, { recursive: true, force: true });
  }
}

async function writeLockFile(lockPath, lock) {
  const tmp = `${lockPath}.${randomUUID()}.tmp`;
  try {
    const fh = await open(tmp, 'wx', 0o600);
    try { await fh.writeFile(`${JSON.stringify(lock)}\n`, 'utf8'); }
    finally { await fh.close(); }
    await rename(tmp, lockPath);
  } finally {
    await rm(tmp, { force: true }).catch(() => {});
  }
}

const heldBy = (lock) => ({ pid: lock.pid, operation: lock.operation, startedAt: lock.startedAt, heartbeatAt: lock.heartbeatAt });
const busyReason = (guard) => `锁元数据正在更新（${guard}）；若进程异常退出，请先确认 guard/owner.json 中的进程已结束再清理该目录`;

export async function acquireLock(lockPath, operation) {
  const result = await withLockGuard(lockPath, async () => {
    const existing = await readLockFile(lockPath);
    if (existing && (existing.unreadable || !isLockStale(existing))) {
      return { acquired: false, reason: '另一操作正在运行', heldBy: heldBy(existing) };
    }
    const now = new Date().toISOString();
    const lock = { pid: process.pid, token: randomUUID(), startedAt: now, heartbeatAt: now, operation: operation || 'unknown' };
    await writeLockFile(lockPath, lock);
    return { acquired: true, lock };
  });
  return result.busy ? { acquired: false, reason: busyReason(result.guard) } : result.value;
}

export async function heartbeatLock(lockPath, token) {
  const result = await withLockGuard(lockPath, async () => {
    const existing = await readLockFile(lockPath);
    if (!existing || existing.token !== token || existing.pid !== process.pid) return false;
    await writeLockFile(lockPath, { ...existing, heartbeatAt: new Date().toISOString() });
    return true;
  }, { wait: true });
  return result.busy ? false : result.value;
}

export async function releaseLock(lockPath, token) {
  const result = await withLockGuard(lockPath, async () => {
    const existing = await readLockFile(lockPath);
    if (!existing || existing.token !== token) return false;
    await rm(lockPath, { force: true });
    return true;
  }, { wait: true });
  if (result.busy) throw new Error(busyReason(result.guard));
  return result.value;
}

export async function reclaimLock(lockPath, { force = false } = {}) {
  const result = await withLockGuard(lockPath, async () => {
    const existing = await readLockFile(lockPath);
    if (!existing) return { reclaimed: false, reason: '没有锁' };
    if (isLockStale(existing) || force) {
      await rm(lockPath, { force: true });
      return { reclaimed: true, heldBy: heldBy(existing) };
    }
    return { reclaimed: false, reason: '锁持有进程仍在运行（未回收，避免误踢活锁）', heldBy: heldBy(existing) };
  });
  return result.busy ? { reclaimed: false, reason: busyReason(result.guard) } : result.value;
}
