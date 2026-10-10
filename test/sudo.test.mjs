import { createSudoSession, normalizeFailure } from "../src/sudo.js";
import { eq, ok, summary, testAsync } from "./harness.mjs";

console.log("sudo");

await testAsync("空/超长/非字符串密码立即拒绝（不会启动 sudo）", async () => {
  const sudo = createSudoSession({ idleMs: 0 });
  eq((await sudo.unlock("")).error, "bad_password");
  eq((await sudo.unlock("x".repeat(300))).error, "bad_password");
  eq((await sudo.unlock(null)).error, "bad_password");
  eq((await sudo.unlock(undefined)).error, "bad_password");
  eq(sudo.isHolding(), false);
  await sudo.lock();
});

await testAsync("初始状态：未持有密码；state() 不抛异常", async () => {
  const sudo = createSudoSession({ idleMs: 1000 });
  const state = await sudo.state();
  eq(typeof state.unlocked, "boolean");
  eq(state.passwordHeld, false);
  eq(state.expiresAt, null);
  await sudo.lock();
});

await testAsync("未解锁时 runRoot 只能返回 ok 或 locked（绝不静默失败）", async () => {
  const sudo = createSudoSession({ idleMs: 0 });
  const probe = await sudo.runRoot(["true"]);
  ok(
    probe.ok === true || probe.error === "locked",
    `期望成功或 locked，实际 ${JSON.stringify(probe)}`,
  );
  if (!probe.ok) eq(probe.error, "locked");
  await sudo.lock();
});

await testAsync("错密码：归一化为 bad_password，且任何返回值里都不含密码原文", async () => {
  const sudo = createSudoSession({ idleMs: 0 });
  const probe = await sudo.runRoot(["true"]);
  if (probe.ok) {
    // 这台机器允许免密 sudo：本用例的前提不成立，跳过（仍保证 lock 可用）。
    await sudo.lock();
    return;
  }
  const secret = "dsp-selftest-wrong-password";
  const result = await sudo.unlock(secret);
  eq(result.error, "bad_password");
  ok(!JSON.stringify(result).includes(secret), "返回值里出现了密码原文");
  eq(sudo.isHolding(), false, "失败后不得持有密码");
  await sudo.lock();
});

await testAsync("lock() 之后不再持有密码，且可重复调用", async () => {
  const sudo = createSudoSession({ idleMs: 60_000 });
  await sudo.lock();
  await sudo.lock();
  eq(sudo.isHolding(), false);
  eq((await sudo.state()).passwordHeld, false);
  sudo.dispose();
  sudo.dispose();
});

testAsync("normalizeFailure 把人话留在 message 里", async () => {
  eq(normalizeFailure({ timedOut: true }), "命令超时（已强制结束）");
  eq(normalizeFailure({ truncated: true }), "输出过大（已截断）");
  eq(normalizeFailure({ spawnError: "spawn sudo ENOENT" }), "命令无法执行：spawn sudo ENOENT");
  eq(normalizeFailure({ code: 1, stderr: "第一行\n第二行\n" }), "第二行");
  eq(normalizeFailure({ code: 3, stderr: "" }), "命令失败（退出码 3）");
});

summary();
