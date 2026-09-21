// smoke 场景 29 的假 dsh CLI：把收到的参数（argv[3:]）记录到首个参数给出的
// 文件后退出 0——用于断言 `dsh plugin --profile web update <pkg>` 的 argv。
import { writeFileSync } from 'node:fs';

const log = process.argv[2];
const args = process.argv.slice(3);
writeFileSync(log, `${JSON.stringify(args)}\n`);
process.exit(0);