// 顺序跑 test/*.test.mjs，聚合退出码。用子进程隔离，一个测试文件崩了不影响其余。
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = dirname(fileURLToPath(import.meta.url));
const files = readdirSync(dir)
  .filter((name) => name.endsWith(".test.mjs"))
  .sort();

let failed = 0;
for (const file of files) {
  console.log(`\n=== ${file} ===`);
  const result = spawnSync(process.execPath, [join(dir, file)], { stdio: "inherit" });
  if (result.status !== 0) failed += 1;
}

console.log(`\n${files.length - failed}/${files.length} 个测试文件通过`);
process.exit(failed === 0 ? 0 : 1);
