// 零依赖构建：src → lib
//   lib/*.js       Host 半：src/ 下的每个模块逐字复制（index.js 及其兄弟模块必须一起搬，
//                  否则 lib/index.js 的相对 import 解析不到文件）
//   lib/client.js  Client 半：把无 JSX 的 CJS 函数体包进 dsh 的模块加载器工厂形式
//
// 刻意不引任何打包器：客户端源码本身已经是加载器期望的导出形状
// （exports.inject / exports.apply），只是需要外面套一层
// window.__ModuleLoader__.load({ id, factory })。这与本机已跑通的
// dsh-resource-bar / dsh-xiaoba-brand 的 build.mjs 是同一套做法。
import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const srcDir = join(root, "src");
const libDir = join(root, "lib");

// 每次全量重建，避免删掉源文件后 lib 里留下过期模块。
rmSync(libDir, { recursive: true, force: true });
mkdirSync(libDir, { recursive: true });

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const id = pkg.name;

// 1) Host 半：src/*.js（不含 src/client/ 子目录）
const hostModules = readdirSync(srcDir, { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith(".js"))
  .map((entry) => entry.name)
  .sort();

if (!hostModules.includes("index.js")) {
  throw new Error("src/index.js 缺失：Host 半入口不存在");
}

for (const name of hostModules) {
  copyFileSync(join(srcDir, name), join(libDir, name));
  console.log(`lib/${name.padEnd(12)}← src/${name}`);
}

// 2) Client 半：包进工厂形式
const body = readFileSync(join(srcDir, "client", "index.js"), "utf8");
if (/^\s*(export|import)\s/m.test(body)) {
  throw new Error("src/client/index.js 里出现了 ESM export/import：它会破坏工厂包装（浏览器语法错）");
}
const wrapped = `window.__ModuleLoader__.load({
\tid: ${JSON.stringify(id)},
\tfactory: (require) => {
\t\tvar module = { exports: {} };
\t\tvar exports = module.exports;
${body}
\t\treturn module.exports;
\t}
});
`;
writeFileSync(join(libDir, "client.js"), wrapped);
console.log("lib/client.js    ← src/client/index.js (wrapped)");

// 3) 自检：lib/index.js 的每个相对 import 都必须落到真实文件上
const entry = readFileSync(join(libDir, "index.js"), "utf8");
const missing = [];
for (const match of entry.matchAll(/from\s+"(\.[^"]+)"/g)) {
  const target = join(libDir, match[1]);
  try {
    readFileSync(target);
  } catch {
    missing.push(match[1]);
  }
}
if (missing.length > 0) {
  throw new Error("lib/index.js 的相对 import 解析不到：" + missing.join(", "));
}
console.log(`自检通过：lib/index.js 的 ${[...entry.matchAll(/from\s+"(\.[^"]+)"/g)].length} 个相对 import 均可解析`);
