// sudo 通道：本方案唯一的高权限点。
//
// 设计（对应用户选择"面板里输入密码、仅存内存、用完即弃"）：
//  1. 密码只存在于本模块的闭包变量里，不落盘、不进日志、不进 session 事件、
//     不出现在任何 argv 里 —— 它只被写进 `sudo -S` 的 stdin。
//  2. 解锁时用 `sudo -k -v` 先作废可能已缓存的时间戳再验证，确保"解锁成功"
//     等价于"这个密码是对的"，而不是"恰好还有热时间戳"。
//  3. 每次特权操作先试 `sudo -n`（时间戳还热就直接过，不碰密码），失败才回到
//     `sudo -S` + 内存密码。
//  4. 手动锁定、空闲超时、插件卸载 → 立即清空内存密码并 `sudo -k`。
//  5. 失败信息一律归一化。绝不把 stderr 原文（可能包含 PAM 细节）回传给浏览器。

import { spawn } from "node:child_process";
import { run } from "./exec.js";

const PASSWORD_REQUIRED = /password is required|a password is required|a terminal is required|no tty present|askpass|sudo: sorry, a password/i;
const WRONG_PASSWORD = /incorrect password|Sorry, try again|authentication failure/i;

/**
 * @param {{ idleMs?: number, timeoutMs?: number, now?: () => number }} [options]
 */
export function createSudoSession(options = {}) {
  const idleMs = Number.isFinite(options.idleMs) ? Math.max(0, options.idleMs) : 600_000;
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 10_000;
  const now = options.now ?? (() => Date.now());

  /** 内存中的密码；null = 未解锁。 */
  let password = null;
  let expiresAt = null;
  let timer = null;
  /** probe 结果的短缓存，避免 UI 轮询不断起子进程。 */
  let probeCache = { at: 0, value: false };
  let disposed = false;

  function clearTimer() {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function forget() {
    password = null;
    expiresAt = null;
    clearTimer();
  }

  function arm() {
    clearTimer();
    if (idleMs > 0) {
      expiresAt = now() + idleMs;
      timer = setTimeout(forget, idleMs);
      timer.unref?.();
    } else {
      // idleMs = 0：本次操作之后立即丢弃（"用完即弃"最严格的形态）。
      expiresAt = now();
    }
  }

  async function unlock(rawPassword) {
    if (typeof rawPassword !== "string" || rawPassword.length === 0 || rawPassword.length > 256) {
      return { ok: false, error: "bad_password" };
    }
    const probe = await run(["sudo", "-S", "-p", "", "-k", "-v"], { input: rawPassword + "\n", timeoutMs });
    if (probe.ok) {
      password = rawPassword;
      arm();
      return { ok: true, unlocked: true, expiresAt };
    }
    if (probe.spawnError) return { ok: false, error: "sudo_unavailable" };
    if (WRONG_PASSWORD.test(probe.stderr)) return { ok: false, error: "bad_password" };
    if (/not allowed|may not run|is not in the sudoers/i.test(probe.stderr)) return { ok: false, error: "sudo_unavailable" };
    return { ok: false, error: "bad_password" };
  }

  /** 时间戳是否仍然热（不涉及内存密码）。结果缓存 3s。 */
  async function timestampHot() {
    if (now() - probeCache.at < 3000) return probeCache.value;
    const r = await run(["sudo", "-n", "true"], { timeoutMs: 4000 });
    probeCache = { at: now(), value: r.ok };
    return r.ok;
  }

  /**
   * 以 root 运行 argv。返回统一结构；`error:'locked'` 表示需要先解锁。
   */
  /**
   * 以 root 运行 argv，返回结构化结果（未解锁时 error:'locked'）。
   * @param {string[]} argv
   * @param {{ timeoutMs?: number, maxBytes?: number }} [options]
   */
  async function runRoot(argv, options = {}) {
    const opts = { timeoutMs: options.timeoutMs ?? timeoutMs, maxBytes: options.maxBytes };
    const bare = await run(["sudo", "-n", ...argv], opts);
    if (bare.ok) {
      probeCache = { at: now(), value: true };
      if (password !== null && idleMs > 0) arm();
      return { ok: true, stdout: bare.stdout, stderr: bare.stderr, code: 0, via: "timestamp" };
    }
    if (password === null) {
      if (PASSWORD_REQUIRED.test(bare.stderr) || /Authentication is required|polkit/i.test(bare.stderr) || bare.code !== 0) {
        return { ok: false, error: "locked", message: "需要先解锁 sudo" };
      }
      return { ok: false, error: "failed", message: normalizeFailure(bare) };
    }
    const r = await run(["sudo", "-S", "-p", "", ...argv], { ...opts, input: password + "\n" });
    if (!r.ok && WRONG_PASSWORD.test(r.stderr)) {
      forget();
      return { ok: false, error: "bad_password", message: "sudo 密码已失效，请重新解锁" };
    }
    if (!r.ok) return { ok: false, error: "failed", message: normalizeFailure(r) };
    probeCache = { at: now(), value: true };
    if (idleMs === 0) forget();
    else arm();
    return { ok: true, stdout: r.stdout, stderr: r.stderr, code: 0, via: "password" };
  }

  /**
   * 流式子进程（下载用）：只走 `sudo -n`。调用方必须先确认会话已解锁，
   * 否则子进程会立刻以非零码退出 —— 这正是我们要的"失败关闭"。
   */
  function spawnRoot(argv) {
    return spawn("sudo", ["-n", ...argv], { stdio: ["ignore", "pipe", "pipe"] });
  }

  async function lock() {
    forget();
    probeCache = { at: now(), value: false };
    await run(["sudo", "-n", "-k"], { timeoutMs: 4000 });
    await run(["sudo", "-k"], { timeoutMs: 4000 });
  }

  async function state() {
    const hot = password === null ? await timestampHot() : true;
    return { unlocked: password !== null || hot, passwordHeld: password !== null, expiresAt: password !== null ? expiresAt : null };
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    forget();
    void run(["sudo", "-n", "-k"], { timeoutMs: 2000 });
  }

  return { unlock, lock, state, runRoot, spawnRoot, dispose, isHolding: () => password !== null, timestampHot };
}

/** 把子进程失败信息压缩成人能读的一句话；不带任何密码/PAM 细节。 */
export function normalizeFailure(result) {
  const text = (result?.stderr || result?.stdout || "").trim().split("\n").filter(Boolean).pop() ?? "";
  if (result?.timedOut) return "命令超时（已强制结束）";
  if (result?.truncated) return "输出过大（已截断）";
  if (result?.spawnError) return "命令无法执行：" + result.spawnError;
  if (text) return text.slice(0, 500);
  return `命令失败（退出码 ${result?.code ?? "?"}）`;
}
