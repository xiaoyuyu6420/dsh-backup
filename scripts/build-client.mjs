/**
 * 打包浏览器半边：src/client.js → lib/client.js。
 *
 * 遵循 Web shell 的 client bundle 握手——CJS 工厂包裹在
 * `window.__ModuleLoader__.load({ id, factory })` 中，factory 的 `require`
 * 从 shell 的冻结模块表应答平台模块（React/Cordis/客户端 UI 包），其余
 * 依赖（zod）内联。产物提交进仓库，`dsh plugin add` 的 git 安装路径无需
 * 在用户机器上构建。开发流程：改 src/ 后运行 `node scripts/build-client.mjs`。
 */
import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN_ID = 'dsh-backup';

/** shell 冻结模块表共享的包（packages/client/web/src/platform.ts）；表外一律内联。 */
const PLATFORM_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-attachment',
  '@deepseek-ai/dsh-client-schema-form',
  '@deepseek-ai/dsh-client-runtime/client',
];

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(HERE, '..', 'lib', 'client.js');

await mkdir(path.dirname(OUT), { recursive: true });

await build({
  entryPoints: [path.resolve(HERE, '..', 'src', 'client.js')],
  outfile: OUT,
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  jsx: 'automatic',
  target: 'es2022',
  sourcemap: false,
  external: PLATFORM_EXTERNALS,
  minify: true,
  legalComments: 'none',
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  banner: { js: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PLUGIN_ID)}, factory: (require) => {` },
  footer: { js: 'return module.exports; } });' },
  write: false,
}).then(async (result) => {
  for (const file of result.outputFiles) {
    // 工厂内需要 module.exports 语义；esbuild CJS 输出引用自身作用域，安全。
    let text = file.text;
    text = 'var module = { exports: {} }; var exports = module.exports;\n' + text;
    await writeFile(file.path, text);
  }
  const size = (await readFile(OUT)).length;
  console.log(`built ${path.relative(process.cwd(), OUT)} (${(size / 1024).toFixed(1)} KB)`);
});
