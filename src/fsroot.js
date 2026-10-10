// root 文件传输层：解锁 sudo 之后，文件管理的每一个动作都以 root 执行。
//
// 为什么单独一层：v1 的 files.js 走 Node 的 fs，身份恒为 dsh 进程用户（运行 dsh 的用户），
// 所以 /etc 下的配置、/root、别人的日志一律碰不到。v2 的约定是"解锁即 root"，
// 于是同样的能力用 `sudo -n` 跑系统命令实现，返回结构保持与 files.js 一致，
// 路由层可以按解锁状态透明切换。
//
// 安全边界（这一层是有意放开全盘的，所以护栏在这里）：
//  1. 只接受绝对路径；不做白名单限制（用户明确选择"解锁后全盘可读写"）；
//  2. 写系统目录（/etc /boot /usr /lib* /bin /sbin /var/lib）由路由层要求二次确认；
//  3. 一批关键目录禁止删除（/、/etc、/usr、/home …），避免一条 rm -rf 把机器带走；
//  4. 所有命令都是 argv 数组，密码只出现在 sudo 的 stdin（这里根本不用密码：
//     解锁时已用 `sudo -k -v` 建立过时间戳，这里统一走 `sudo -n`）。
//
// 写文件的实现刻意绕开"密码 + 正文混在同一个 stdin"这条路：先把内容落到用户可写的
// 临时文件，再用 `sudo -n cp` 拷到目标，最后删临时文件。

import { createWriteStream } from "node:fs";
import { randomBytes } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { pipeline } from "node:stream/promises";

export const MAX_TEXT_BYTES = 1024 * 1024;

/** 写入前必须二次确认的系统目录（与前端约定一致）。 */
export const SYSTEM_WRITE_ROOTS = ["/etc", "/boot", "/usr", "/lib", "/lib64", "/bin", "/sbin", "/var/lib"];

/** 无论如何都不允许删除的关键路径。 */
const PROTECTED_FROM_DELETE = [
  "/",
  "/bin",
  "/boot",
  "/dev",
  "/etc",
  "/home",
  "/lib",
  "/lib64",
  "/media",
  "/mnt",
  "/opt",
  "/proc",
  "/root",
  "/run",
  "/sbin",
  "/srv",
  "/sys",
  "/tmp",
  "/usr",
  "/var",
];

/** 目标是否落在需要二次确认的系统目录里。 */
export function isSystemPath(target) {
  if (typeof target !== "string" || !path.isAbsolute(target)) return false;
  const abs = path.normalize(target);
  return SYSTEM_WRITE_ROOTS.some((root) => abs === root || abs.startsWith(root + "/"));
}

function absolutize(input) {
  if (typeof input !== "string" || input.length === 0 || input.length > 4096 || input.includes("\0")) return null;
  if (!path.isAbsolute(input)) return null;
  return path.normalize(input);
}

const TYPE_OF = { f: "file", d: "dir", l: "link", b: "other", c: "other", p: "other", s: "other" };

/**
 * @param {{ sudo: { runRoot: Function, state: Function }, timeoutMs?: number }} deps
 */
export function createRootFileService(deps) {
  const sudo = deps.sudo;
  const timeoutMs = deps.timeoutMs ?? 10_000;

  /** 统一的失败归一化：把 sudo 的结果映射成 files.js 的错误码。 */
  const fail = (result) => ({ ok: false, error: result.error ?? "failed", message: result.message ?? "操作失败" });
  const notFound = (result) => (/No such file or directory|cannot access|not found/i.test(result.stderr ?? "") ? "not_found" : null);

  async function run(argv, options = {}) {
    return sudo.runRoot(argv, { timeoutMs: options.timeoutMs ?? timeoutMs });
  }

  /** 目标是否已经解锁（时间戳热）。 */
  async function available() {
    const state = await sudo.state();
    return state.unlocked === true;
  }

  /** stat：返回 { ok, exists, sizeBytes, mtimeMs, mode, owner, group, isDir }。 */
  async function statPath(input) {
    const abs = absolutize(input);
    if (abs === null) return { ok: false, error: "invalid_path", message: "需要一个绝对路径" };
    const r = await run(["stat", "-c", "%s\t%Y\t%a\t%U\t%G\t%F", "--", abs]);
    if (!r.ok) {
      const code = notFound(r);
      if (code) return { ok: false, error: "not_found", message: "路径不存在" };
      if (r.error) return fail(r);
      return { ok: false, error: "failed", message: r.stderr.trim() || "stat 失败" };
    }
    const [size, mtime, mode, owner, group, kind] = r.stdout.trim().split("\t");
    return {
      ok: true,
      path: abs,
      exists: true,
      sizeBytes: Number(size),
      mtimeMs: Number(mtime) * 1000,
      mode,
      owner,
      group,
      isDir: String(kind).startsWith("directory"),
    };
  }

  async function list(input) {
    const abs = absolutize(input);
    if (abs === null) return { ok: false, error: "invalid_path", message: "需要一个绝对路径" };
    const r = await run(
      ["find", abs, "-maxdepth", "1", "-mindepth", "1", "-printf", "%f\t%y\t%s\t%T@\t%m\t%u\t%g\n"],
      { maxBytes: 4 * 1024 * 1024 },
    );
    if (!r.ok) {
      if (notFound(r)) return { ok: false, error: "not_found", message: "路径不存在" };
      if (r.error) return fail(r);
      return { ok: false, error: "failed", message: r.stderr.trim() || "目录读取失败" };
    }
    const entries = [];
    for (const line of r.stdout.split("\n")) {
      if (!line) continue;
      const parts = line.split("\t");
      if (parts.length < 7) continue;
      const [name, type, size, mtime, mode, owner, group] = parts;
      entries.push({
        name,
        path: path.join(abs, name),
        type: TYPE_OF[type] ?? "other",
        sizeBytes: Number(size),
        mtimeMs: Math.round(Number.parseFloat(mtime) * 1000),
        mode,
        owner,
        group,
        symlink: type === "l",
      });
    }
    entries.sort((a, b) => {
      const aDir = a.type === "dir" ? 0 : 1;
      const bDir = b.type === "dir" ? 0 : 1;
      if (aDir !== bDir) return aDir - bDir;
      return a.name.localeCompare(b.name, "zh-Hans-CN", { numeric: true });
    });
    return {
      ok: true,
      path: abs,
      parent: path.dirname(abs) === abs ? null : path.dirname(abs),
      entries,
      truncated: false,
      root: true,
    };
  }

  async function readText(input) {
    const abs = absolutize(input);
    if (abs === null) return { ok: false, error: "invalid_path", message: "需要一个绝对路径" };
    const info = await statPath(abs);
    if (!info.ok) return info;
    if (info.isDir) return { ok: false, error: "failed", message: "这是目录，不能作为文本打开" };
    if (info.sizeBytes > MAX_TEXT_BYTES) {
      return { ok: false, error: "too_large", message: `文件超过 ${Math.round(MAX_TEXT_BYTES / 1024)} KiB，请下载查看` };
    }
    const r = await run(["cat", "--", abs], { maxBytes: 2 * 1024 * 1024 });
    if (!r.ok) {
      if (notFound(r)) return { ok: false, error: "not_found", message: "路径不存在" };
      if (r.error) return fail(r);
      return { ok: false, error: "failed", message: r.stderr.trim() || "读取失败" };
    }
    if (r.stdout.includes("\u0000")) return { ok: false, error: "binary", message: "二进制文件" };
    return { ok: true, path: abs, text: r.stdout, sizeBytes: info.sizeBytes, mtimeMs: info.mtimeMs, binary: false, root: true };
  }

  /** 把内容写到用户可写的临时文件，再 root 拷到目标。 */
  async function stageAndCopy(text, target, options = {}) {
    const stage = path.join(tmpdir(), ".dsp-stage-" + randomBytes(6).toString("hex"));
    try {
      await writeFile(stage, text, { mode: 0o600 });
      const existed = await statPath(target);
      const copy = await run(["cp", "-f", "--", stage, target], { timeoutMs: 30_000 });
      if (!copy.ok) {
        if (copy.error) return fail(copy);
        return { ok: false, error: "failed", message: copy.stderr.trim() || "写入失败" };
      }
      // 新文件用 0644（从临时文件继承来的 0600 会让系统配置读不出来）。
      if (!existed.ok) await run(["chmod", options.newMode ?? "644", "--", target]);
      return { ok: true };
    } finally {
      await rm(stage, { force: true }).catch(() => {});
    }
  }

  async function writeText(input, text, expectedMtime) {
    if (typeof text !== "string") return { ok: false, error: "bad_request", message: "缺少 text 字段" };
    if (Buffer.byteLength(text, "utf8") > MAX_TEXT_BYTES) return { ok: false, error: "too_large", message: "内容超过 1 MiB" };
    const abs = absolutize(input);
    if (abs === null) return { ok: false, error: "invalid_path", message: "需要一个绝对路径" };
    if (expectedMtime !== null && expectedMtime !== undefined) {
      const expected = Number(expectedMtime);
      if (!Number.isFinite(expected)) return { ok: false, error: "bad_request", message: "mtime 非法" };
      const current = await statPath(abs);
      const currentMs = current.ok ? Math.floor(current.mtimeMs) : null;
      if (currentMs === null || currentMs !== Math.floor(expected)) {
        return { ok: false, error: "conflict", message: "文件在别处已被修改，请重新载入后再保存", mtimeMs: currentMs };
      }
    }
    const staged = await stageAndCopy(text, abs);
    if (!staged.ok) return staged;
    const after = await statPath(abs);
    return { ok: true, path: abs, sizeBytes: after.ok ? after.sizeBytes : Buffer.byteLength(text, "utf8"), mtimeMs: after.ok ? after.mtimeMs : Date.now(), root: true };
  }

  /**
   * 下载：返回一个可读流。未解锁直接给 locked（不做"先试再退"的模糊判断）。
   */
  async function openDownload(input) {
    const abs = absolutize(input);
    if (abs === null) return { ok: false, error: "invalid_path", message: "需要一个绝对路径" };
    const info = await statPath(abs);
    if (!info.ok) return info;
    if (info.isDir) return { ok: false, error: "failed", message: "这是目录，不能下载" };
    return {
      ok: true,
      path: abs,
      name: path.basename(abs),
      sizeBytes: info.sizeBytes,
      mtimeMs: info.mtimeMs,
      root: true,
      // 由路由层用 spawn 接入 HTTP 响应；这里只交出命令。
      spawn: () => deps.spawnRoot(["cat", "--", abs]),
    };
  }

  async function saveUpload(dirInput, fileName, readable) {
    if (typeof fileName !== "string" || fileName.length === 0 || fileName.includes("/") || fileName.includes("\\") || fileName.includes("\0")) {
      return { ok: false, error: "invalid_path", message: "文件名非法" };
    }
    const dir = absolutize(dirInput);
    if (dir === null) return { ok: false, error: "invalid_path", message: "需要一个绝对路径" };
    const dirInfo = await statPath(dir);
    if (!dirInfo.ok) return dirInfo;
    if (!dirInfo.isDir) return { ok: false, error: "failed", message: "目标不是目录" };
    const target = path.join(dir, fileName);
    const stage = path.join(tmpdir(), ".dsp-upload-" + randomBytes(6).toString("hex"));
    try {
      await pipeline(readable, createWriteStream(stage, { mode: 0o600 }));
      const existed = await statPath(target);
      const copy = await run(["cp", "-f", "--", stage, target], { timeoutMs: 60_000 });
      if (!copy.ok) {
        if (copy.error) return fail(copy);
        return { ok: false, error: "failed", message: copy.stderr.trim() || "上传落盘失败" };
      }
      if (!existed.ok) await run(["chmod", "644", "--", target]);
      const after = await statPath(target);
      return { ok: true, path: target, sizeBytes: after.ok ? after.sizeBytes : 0, root: true };
    } catch (error) {
      return { ok: false, error: "failed", message: String(error?.message ?? error) };
    } finally {
      await rm(stage, { force: true }).catch(() => {});
    }
  }

  async function makeDirectory(input) {
    const abs = absolutize(input);
    if (abs === null) return { ok: false, error: "invalid_path", message: "需要一个绝对路径" };
    const r = await run(["mkdir", "--", abs]);
    if (!r.ok) {
      if (/exists/i.test(r.stderr ?? "")) return { ok: false, error: "failed", message: "同名条目已存在" };
      if (r.error) return fail(r);
      return { ok: false, error: "failed", message: r.stderr.trim() || "创建失败" };
    }
    return { ok: true, path: abs, root: true };
  }

  async function renameEntry(input, to) {
    const from = absolutize(input);
    const rawTo = typeof to === "string" && to.length > 0 ? to : null;
    if (from === null || rawTo === null) return { ok: false, error: "invalid_path", message: "路径非法" };
    const target = path.isAbsolute(rawTo) ? path.normalize(rawTo) : path.join(path.dirname(from), rawTo);
    const r = await run(["mv", "-f", "--", from, target]);
    if (!r.ok) {
      if (r.error) return fail(r);
      return { ok: false, error: "failed", message: r.stderr.trim() || "重命名失败" };
    }
    return { ok: true, path: from, to: target, root: true };
  }

  async function removeEntry(input, recursive) {
    const abs = absolutize(input);
    if (abs === null) return { ok: false, error: "invalid_path", message: "需要一个绝对路径" };
    if (PROTECTED_FROM_DELETE.includes(abs)) {
      return { ok: false, error: "forbidden", message: `拒绝删除系统关键目录 ${abs}` };
    }
    const info = await statPath(abs);
    if (!info.ok) return info;
    const r = info.isDir
      ? await run(recursive ? ["rm", "-rf", "--", abs] : ["rmdir", "--", abs])
      : await run(["rm", "-f", "--", abs]);
    if (!r.ok) {
      if (r.error) return fail(r);
      return { ok: false, error: "failed", message: r.stderr.trim() || "删除失败" };
    }
    return { ok: true, path: abs, root: true };
  }

  async function chmodEntry(input, mode) {
    const abs = absolutize(input);
    if (abs === null) return { ok: false, error: "invalid_path", message: "需要一个绝对路径" };
    if (typeof mode !== "string" || !/^[0-7]{3,4}$/.test(mode)) return { ok: false, error: "bad_request", message: "权限位非法（如 644 / 0755）" };
    const r = await run(["chmod", mode, "--", abs]);
    if (!r.ok) return r.error ? fail(r) : { ok: false, error: "failed", message: r.stderr.trim() || "chmod 失败" };
    return { ok: true, path: abs, mode, root: true };
  }

  async function chownEntry(input, owner) {
    const abs = absolutize(input);
    if (abs === null) return { ok: false, error: "invalid_path", message: "需要一个绝对路径" };
    if (typeof owner !== "string" || !/^[A-Za-z0-9_.-]+(:[A-Za-z0-9_.-]+)?$/.test(owner)) {
      return { ok: false, error: "bad_request", message: "属主非法（如 www-data 或 www-data:www-data）" };
    }
    const r = await run(["chown", "--", owner, abs]);
    if (!r.ok) return r.error ? fail(r) : { ok: false, error: "failed", message: r.stderr.trim() || "chown 失败" };
    return { ok: true, path: abs, owner, root: true };
  }

  return { available, list, readText, writeText, openDownload, saveUpload, makeDirectory, renameEntry, removeEntry, chmodEntry, chownEntry, statPath };
}
