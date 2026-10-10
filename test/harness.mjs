// 极简测试框架：没有依赖，失败即抛，进程退出码反映结果。
// 用法：import { test, eq, ok, close, summary } from "./harness.mjs";
const results = { pass: 0, fail: 0 };
const failures = [];

export function test(name, fn) {
  try {
    fn();
    results.pass += 1;
    console.log("  ✓ " + name);
  } catch (error) {
    results.fail += 1;
    failures.push({ name, error });
    console.log("  ✗ " + name + "\n      " + String(error?.message ?? error).split("\n").join("\n      "));
  }
}

export async function testAsync(name, fn) {
  try {
    await fn();
    results.pass += 1;
    console.log("  ✓ " + name);
  } catch (error) {
    results.fail += 1;
    failures.push({ name, error });
    console.log("  ✗ " + name + "\n      " + String(error?.message ?? error).split("\n").join("\n      "));
  }
}

export function eq(actual, expected, label = "") {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${label ? label + ": " : ""}期望 ${b}，实际 ${a}`);
}

export function ok(value, label = "断言失败") {
  if (!value) throw new Error(label);
}

export function close(actual, expected, tolerance = 0.01, label = "") {
  if (typeof actual !== "number" || Math.abs(actual - expected) > tolerance) {
    throw new Error(`${label ? label + ": " : ""}期望 ≈${expected}（±${tolerance}），实际 ${actual}`);
  }
}

export function throws(fn, label = "应当抛错") {
  try {
    fn();
  } catch {
    return;
  }
  throw new Error(label);
}

export function summary() {
  console.log(`\n  ${results.pass} 通过 / ${results.fail} 失败`);
  if (results.fail > 0) {
    for (const f of failures) console.log("  失败：" + f.name);
    process.exitCode = 1;
  }
  return results.fail === 0;
}
