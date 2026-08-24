/**
 * normalizeField / validatePartial 单元测试
 *
 * 验证 settings seam 的字段校验与归一化逻辑：
 * - destination: 非空字符串
 * - keep: >= 1 的数字（字符串数字自动转 floor）
 * - exclude: 字符串数组
 * - redact: 字符串数组 / 'off' / false / 'none'（旧配置兼容）
 * - githubRepo: 任意字符串（含空串）
 *
 * 用法：node scripts/smoke-settings.mjs
 */

// ---------- 从 lib/index.js 提取的归一化/校验逻辑（纯函数，无副作用） ----------

const SETTINGS_FIELDS = ['destination', 'keep', 'exclude', 'redact', 'githubRepo'];

function normalizeField(out, field, value) {
  if (field === 'destination') {
    if (typeof value === 'string' && value.trim()) out.destination = value.trim();
  } else if (field === 'keep') {
    const n = Number(value);
    if (Number.isFinite(n) && n >= 0) out.keep = Math.floor(n);
  } else if (field === 'exclude') {
    if (Array.isArray(value)) out.exclude = value.filter((v) => typeof v === 'string');
  } else if (field === 'redact') {
    if (value === 'off' || value === false || value === 'none') out.redact = 'off';
    else if (Array.isArray(value)) out.redact = value.filter((v) => typeof v === 'string');
  } else if (field === 'githubRepo') {
    if (typeof value === 'string') out.githubRepo = value;
  }
}

function validatePartial(partial) {
  const invalid = [];
  for (const field of SETTINGS_FIELDS) {
    if (partial[field] === undefined) continue;
    const probe = {};
    normalizeField(probe, field, partial[field]);
    if (probe[field] === undefined) invalid.push(field);
  }
  return invalid;
}

// ---------- 测试框架 ----------

let failures = 0;
let checks = 0;

function ok(cond, msg) {
  checks += 1;
  if (cond) {
    console.log(`  ✅ ${msg}`);
  } else {
    failures += 1;
    console.error(`  ❌ ${msg}`);
  }
}

function eq(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

// ---------- 测试场景 ----------

console.log('1) normalizeField — destination');
{
  const out = {};
  normalizeField(out, 'destination', '~/backups');
  ok(out.destination === '~/backups', '合法路径被接受');
}
{
  const out = {};
  normalizeField(out, 'destination', '  ~/backups  ');
  ok(out.destination === '~/backups', '前后空白被 trim');
}
{
  const out = {};
  normalizeField(out, 'destination', '');
  ok(out.destination === undefined, '空字符串被拒绝');
}
{
  const out = {};
  normalizeField(out, 'destination', '   ');
  ok(out.destination === undefined, '纯空白被拒绝');
}
{
  const out = {};
  normalizeField(out, 'destination', 123);
  ok(out.destination === undefined, '非字符串被拒绝');
}

console.log('2) normalizeField — keep');
{
  const out = {};
  normalizeField(out, 'keep', 7);
  ok(out.keep === 7, '整数被接受');
}
{
  const out = {};
  normalizeField(out, 'keep', '10');
  ok(out.keep === 10, '字符串数字被转换并 floor');
}
{
  const out = {};
  normalizeField(out, 'keep', 3.7);
  ok(out.keep === 3, '小数被 floor');
}
{
  const out = {};
  normalizeField(out, 'keep', 1);
  ok(out.keep === 1, '最小值 1 被接受');
}
{
  const out = {};
  normalizeField(out, 'keep', 0);
  ok(out.keep === 0, '0 被接受（表示“未配置”，autoKeep 回退）');
}
{
  const out = {};
  normalizeField(out, 'keep', -1);
  ok(out.keep === undefined, '负数被拒绝');
}
{
  const out = {};
  normalizeField(out, 'keep', 'abc');
  ok(out.keep === undefined, '非数字字符串被拒绝');
}
{
  const out = {};
  normalizeField(out, 'keep', NaN);
  ok(out.keep === undefined, 'NaN 被拒绝');
}
{
  const out = {};
  normalizeField(out, 'keep', Infinity);
  ok(out.keep === undefined, 'Infinity 被拒绝');
}

console.log('3) normalizeField — exclude');
{
  const out = {};
  normalizeField(out, 'exclude', ['node_modules', '.cache']);
  ok(eq(out.exclude, ['node_modules', '.cache']), '字符串数组被接受');
}
{
  const out = {};
  normalizeField(out, 'exclude', []);
  ok(eq(out.exclude, []), '空数组被接受');
}
{
  const out = {};
  normalizeField(out, 'exclude', ['a', 123, 'b', null, 'c']);
  ok(eq(out.exclude, ['a', 'b', 'c']), '非字符串元素被过滤');
}
{
  const out = {};
  normalizeField(out, 'exclude', 'not-array');
  ok(out.exclude === undefined, '非数组被拒绝');
}

console.log('4) normalizeField — redact');
{
  const out = {};
  normalizeField(out, 'redact', ['.env', '.credentials.yaml']);
  ok(eq(out.redact, ['.env', '.credentials.yaml']), '字符串数组被接受');
}
{
  const out = {};
  normalizeField(out, 'redact', 'off');
  ok(out.redact === 'off', "'off' 被接受");
}
{
  const out = {};
  normalizeField(out, 'redact', false);
  ok(out.redact === 'off', "false 映射为 'off'");
}
{
  const out = {};
  normalizeField(out, 'redact', 'none');
  ok(out.redact === 'off', "'none' 映射为 'off'（旧配置兼容）");
}
{
  const out = {};
  normalizeField(out, 'redact', ['.env', 123, '.cache']);
  ok(eq(out.redact, ['.env', '.cache']), '数组中非字符串被过滤');
}
{
  const out = {};
  normalizeField(out, 'redact', true);
  ok(out.redact === undefined, 'true 被拒绝');
}
{
  const out = {};
  normalizeField(out, 'redact', 'on');
  ok(out.redact === undefined, "非法字符串 'on' 被拒绝");
}

console.log('5) normalizeField — githubRepo');
{
  const out = {};
  normalizeField(out, 'githubRepo', 'https://github.com/me/backups.git');
  ok(out.githubRepo === 'https://github.com/me/backups.git', 'HTTPS URL 被接受');
}
{
  const out = {};
  normalizeField(out, 'githubRepo', '');
  ok(out.githubRepo === '', '空字符串被接受（用于清除）');
}
{
  const out = {};
  normalizeField(out, 'githubRepo', 'ssh://git@github.com/me/backups.git');
  ok(out.githubRepo === 'ssh://git@github.com/me/backups.git', 'SSH URL 被接受');
}
{
  const out = {};
  normalizeField(out, 'githubRepo', 123);
  ok(out.githubRepo === undefined, '非字符串被拒绝');
}

console.log('6) normalizeField — 未知字段');
{
  const out = {};
  normalizeField(out, 'unknownField', 'value');
  ok(Object.keys(out).length === 0, '未知字段被忽略（out 不变）');
}

console.log('7) validatePartial — 合法输入');
{
  const result = validatePartial({ keep: 5 });
  ok(eq(result, []), '单字段合法返回空数组');
}
{
  const result = validatePartial({ destination: '~/backups', keep: 10, exclude: ['node_modules'] });
  ok(eq(result, []), '多字段合法返回空数组');
}
{
  const result = validatePartial({});
  ok(eq(result, []), '空对象返回空数组（无字段需校验）');
}
{
  const result = validatePartial({ redact: 'off' });
  ok(eq(result, []), "redact: 'off' 合法");
}
{
  const result = validatePartial({ redact: 'none' });
  ok(eq(result, []), "redact: 'none' 合法（旧配置兼容，映射为 'off'）");
}

console.log('8) validatePartial — 非法输入');
{
  const result = validatePartial({ keep: 0 });
  ok(eq(result, []), 'keep: 0 合法（表示“未配置”）');
}
{
  const result = validatePartial({ keep: -1 });
  ok(eq(result, ['keep']), 'keep: -1 被标记非法');
}
{
  const result = validatePartial({ destination: '' });
  ok(eq(result, ['destination']), 'destination: 空串被标记非法');
}
{
  const result = validatePartial({ exclude: 'not-array' });
  ok(eq(result, ['exclude']), 'exclude: 非数组被标记非法');
}
{
  const result = validatePartial({ redact: 'on' });
  ok(eq(result, ['redact']), "redact: 'on' 被标记非法");
}

console.log('9) validatePartial — 混合输入');
{
  const result = validatePartial({ keep: 5, destination: '', exclude: ['a'] });
  ok(eq(result, ['destination']), '仅非法字段被标记');
}
{
  const result = validatePartial({ keep: -1, destination: '' });
  ok(eq(result, ['destination', 'keep']), '多个非法字段全部标记（按 SETTINGS_FIELDS 顺序）');
}
{
  const result = validatePartial({ keep: 5, unknownField: 'x' });
  ok(eq(result, []), '未知字段被忽略（不在 SETTINGS_FIELDS 中）');
}

console.log('10) validatePartial — githubRepo 边界');
{
  const result = validatePartial({ githubRepo: '' });
  ok(eq(result, []), 'githubRepo: 空串合法（用于清除用户层覆盖）');
}
{
  const result = validatePartial({ githubRepo: 'me/backups' });
  ok(eq(result, []), 'githubRepo: owner/repo 格式合法');
}

// ---------- 结果 ----------

console.log(`\n结果: ${checks - failures}/${checks} 通过`);
if (failures > 0) process.exit(1);
