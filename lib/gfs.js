/**
 * dsh-backup — GFS 保留策略（P3 宿主半边，纯函数，可独立自检）。
 *
 * 在现有「最近 keep N」之外补 GFS 两个长尾分层：
 *  - monthly：keep 窗口之外的尾巴里，每个自然月保留**一份**（最早那份），最多
 *    `monthly` 个不同月份；
 *  - yearly：同理，每个自然年保留一份，最多 `yearly` 个不同年份。
 *
 * 默认 `{ monthly: 0, yearly: 0 }` 即等价旧行为（只 keep N + 既有日/周分层），
 * 设置侧由 `gfsMonthly` / `gfsYearly` 两个字段支配，缺省 0 完全不改变现状。
 * 旧 keep 语义不回退：keep 仍是「最近窗口份数」的唯一依据。
 *
 * 与 index.js 的 tierProtectedSet（日/周分层）互补——GFS 只负责月/年两层，
 * 最终受保护集 = tierProtectedSet ∪ gfsProtectedSet。
 */

/** 从归档名解析自然日（YYYY-MM-DD）；解析不出返回 null。 */
function dayOf(name) {
  const m = /^dsh-(?:t-)?(\d{4})(\d{2})(\d{2})-\d{6}\d{3}\.tar\.gz$/.exec(name);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

/**
 * 计算 GFS 月/年分层应保护的归档名集合。
 *
 * @param {Array<{name:string}>} tailDesc keep 窗口外、新→旧排序的归档
 * @param {string|null} newestName 最新归档名（用于跳过「今日」的档内冗余）
 * @param {{monthly?:number, yearly?:number}} opts 月/年分层各保留多少个桶（0=关）
 * @returns {Set<string>} 受保护的归档名
 */
export function gfsProtectedSet(tailDesc, newestName, { monthly = 0, yearly = 0 } = {}) {
  const protectedNames = new Set();
  if ((!monthly || monthly <= 0) && (!yearly || yearly <= 0)) return protectedNames;
  const monthSeen = new Set();
  const yearSeen = new Set();
  const today = newestName ? dayOf(newestName) : null;
  for (const b of tailDesc) {
    const d = dayOf(b.name);
    if (!d || d === today) continue;
    const month = d.slice(0, 7); // YYYY-MM
    const year = d.slice(0, 4); // YYYY
    if (monthly > 0 && !monthSeen.has(month)) {
      monthSeen.add(month);
      if (monthSeen.size <= monthly) protectedNames.add(b.name);
    }
    if (yearly > 0 && !yearSeen.has(year)) {
      yearSeen.add(year);
      if (yearSeen.size <= yearly) protectedNames.add(b.name);
    }
  }
  return protectedNames;
}
