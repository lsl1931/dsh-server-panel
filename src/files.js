// 文件服务：浏览 / 读 / 写 / 上传 / 下载 / 新建 / 重命名 / 删除。
//
// 安全模型（面板跑在 dsh 进程里 = dsh 进程用户的权限，所以这里守的是"被 UI 误用"与
// "经隧道进来的越权请求"两道门）：
//  1. 只接受绝对路径，先 path.resolve，再对已存在的部分做 realpath —— 符号链接
//     逃逸白名单会被识破；
//  2. 读、写各有独立白名单；写入目标所在目录必须真实存在，且最终路径（以及
//     它若是符号链接时解析后的目标）必须落在写入白名单内；
//  3. 不允许把白名单根目录本身删掉；
//  4. 上传先写 `.dsp-part-*` 临时文件再 rename，半截文件不会冒充成品；
//  5. 文本读写有大小上限，超出返回明确错误码而不是把内存吃满。

import { createReadStream, createWriteStream, realpathSync } from "node:fs";
import { lstat, mkdir, readFile, readdir, realpath, rename, rmdir, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { TextDecoder } from "node:util";

export const MAX_TEXT_BYTES = 1024 * 1024; // 单次文本读/写上限
export const MAX_ENTRIES = 2000; // 单次目录列出上限
const MAX_NAME_LEN = 255;

const decodeUtf8 = new TextDecoder("utf-8", { fatal: true });

/** 规范化白名单根：能 realpath 就 realpath（去掉 /home/me/../me 这类形态）。 */
function canonicalRoot(root) {
  const abs = path.resolve(String(root));
  try {
    return realpathSync(abs);
  } catch {
    return abs;
  }
}

function under(target, roots) {
  return roots.some((root) => target === root || target.startsWith(root + path.sep));
}

/** 单段文件名校验：不接受分隔符、目录别名、NUL 与超长名。 */
export function isValidFileName(name) {
  return (
    typeof name === "string" &&
    name.length > 0 &&
    name.length <= MAX_NAME_LEN &&
    name !== "." &&
    name !== ".." &&
    !name.includes("/") &&
    !name.includes("\\") &&
    !name.includes("\0")
  );
}

/**
 * @param {{ readRoots?: string[], writeRoots?: string[] }} [options]
 */
export function createFileService(options = {}) {
  const readRoots = (options.readRoots?.length ? options.readRoots : [homedir()]).map(canonicalRoot);
  const writeRoots = (options.writeRoots?.length ? options.writeRoots : [homedir()]).map(canonicalRoot);

  /** 请求路径必须是绝对路径；否则直接拒绝，免得 cwd 参与解释。 */
  function absolutize(input) {
    if (typeof input !== "string" || input.length === 0 || input.length > 4096 || input.includes("\0")) return null;
    if (!path.isAbsolute(input)) return null;
    return path.normalize(input);
  }

  /** 解析一个必须已存在的路径，并确认其真实位置在白名单内。 */
  async function resolveExisting(input, roots) {
    const abs = absolutize(input);
    if (abs === null) return { ok: false, error: "invalid_path", message: "需要一个绝对路径" };
    let real;
    try {
      real = await realpath(abs);
    } catch (error) {
      if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return { ok: false, error: "not_found", message: "路径不存在" };
      if (error?.code === "EACCES" || error?.code === "EPERM") return { ok: false, error: "forbidden", message: "权限不足" };
      return { ok: false, error: "failed", message: String(error?.message ?? error) };
    }
    if (!under(real, roots)) return { ok: false, error: "forbidden", message: "路径不在允许范围内" };
    return { ok: true, path: real, requested: abs };
  }

  /** 解析一个写入目标（可以尚不存在）：父目录必须存在且真实落在白名单内。 */
  async function resolveForWrite(input, roots) {
    const abs = absolutize(input);
    if (abs === null) return { ok: false, error: "invalid_path", message: "需要一个绝对路径" };
    const base = path.basename(abs);
    if (!isValidFileName(base)) return { ok: false, error: "invalid_path", message: "文件名非法" };
    let realDir;
    try {
      realDir = await realpath(path.dirname(abs));
    } catch (error) {
      if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return { ok: false, error: "not_found", message: "父目录不存在" };
      if (error?.code === "EACCES" || error?.code === "EPERM") return { ok: false, error: "forbidden", message: "父目录权限不足" };
      return { ok: false, error: "failed", message: String(error?.message ?? error) };
    }
    const target = path.join(realDir, base);
    if (!under(target, roots)) return { ok: false, error: "forbidden", message: "路径不在允许写入的范围内" };
    // 目标已存在且是符号链接：按它真实指向再判一次，避免借链接写到白名单外。
    try {
      const st = await lstat(target);
      if (st.isSymbolicLink()) {
        const linkReal = await realpath(target);
        if (!under(linkReal, roots)) return { ok: false, error: "forbidden", message: "符号链接指向允许范围之外" };
        return { ok: true, path: linkReal };
      }
    } catch {
      // 目标不存在：正常情况（新建文件）。
    }
    return { ok: true, path: target };
  }

  function roots() {
    return { readRoots: [...readRoots], writeRoots: [...writeRoots], home: homedir() };
  }

  async function list(input) {
    const resolved = await resolveExisting(input, readRoots);
    if (!resolved.ok) return resolved;
    let st;
    try {
      st = await stat(resolved.path);
    } catch (error) {
      return { ok: false, error: "not_found", message: String(error?.message ?? error) };
    }
    if (!st.isDirectory()) return { ok: false, error: "failed", message: "不是目录" };
    let names;
    try {
      names = await readdir(resolved.path);
    } catch (error) {
      return { ok: false, error: error?.code === "EACCES" ? "forbidden" : "failed", message: String(error?.message ?? error) };
    }
    const truncated = names.length > MAX_ENTRIES;
    const slice = truncated ? names.slice(0, MAX_ENTRIES) : names;
    const entries = await Promise.all(
      slice.map(async (name) => {
        const full = path.join(resolved.path, name);
        try {
          const info = await lstat(full);
          const symlink = info.isSymbolicLink();
          return {
            name,
            path: full,
            type: symlink ? "link" : info.isDirectory() ? "dir" : info.isFile() ? "file" : "other",
            sizeBytes: symlink ? null : info.size,
            mtimeMs: Math.floor(info.mtimeMs),
            mode: (info.mode & 0o777).toString(8).padStart(3, "0"),
            symlink,
          };
        } catch {
          return { name, path: full, type: "other", sizeBytes: null, mtimeMs: null, mode: null, symlink: false };
        }
      }),
    );
    entries.sort((a, b) => {
      const aDir = a.type === "dir" ? 0 : 1;
      const bDir = b.type === "dir" ? 0 : 1;
      if (aDir !== bDir) return aDir - bDir;
      return a.name.localeCompare(b.name, "zh-Hans-CN", { numeric: true });
    });
    const parent = path.dirname(resolved.path);
    return {
      ok: true,
      path: resolved.path,
      parent: parent === resolved.path || !under(parent, readRoots) ? null : parent,
      entries,
      truncated,
    };
  }

  async function readText(input) {
    const resolved = await resolveExisting(input, readRoots);
    if (!resolved.ok) return resolved;
    let st;
    try {
      st = await stat(resolved.path);
    } catch (error) {
      return { ok: false, error: "not_found", message: String(error?.message ?? error) };
    }
    if (st.isDirectory()) return { ok: false, error: "failed", message: "这是目录，不能作为文本打开" };
    if (st.size > MAX_TEXT_BYTES) return { ok: false, error: "too_large", message: `文件超过 ${Math.round(MAX_TEXT_BYTES / 1024)} KiB，请下载查看` };
    let buf;
    try {
      buf = await readFile(resolved.path);
    } catch (error) {
      return { ok: false, error: error?.code === "EACCES" ? "forbidden" : "failed", message: String(error?.message ?? error) };
    }
    if (buf.includes(0)) return { ok: false, error: "binary", message: "二进制文件" };
    let text;
    try {
      text = decodeUtf8.decode(buf);
    } catch {
      return { ok: false, error: "binary", message: "不是 UTF-8 文本" };
    }
    return { ok: true, path: resolved.path, text, sizeBytes: st.size, mtimeMs: Math.floor(st.mtimeMs), binary: false };
  }

  /**
   * @param {string} input 目标路径
   * @param {string} text 内容
   * @param {number|null|undefined} expectedMtime 期望的磁盘 mtime（null = 强制覆盖）
   */
  async function writeText(input, text, expectedMtime) {
    if (typeof text !== "string") return { ok: false, error: "bad_request", message: "缺少 text 字段" };
    if (Buffer.byteLength(text, "utf8") > MAX_TEXT_BYTES) return { ok: false, error: "too_large", message: "内容超过 1 MiB" };
    const resolved = await resolveForWrite(input, writeRoots);
    if (!resolved.ok) return resolved;
    if (expectedMtime !== null && expectedMtime !== undefined) {
      const expected = Number(expectedMtime);
      if (!Number.isFinite(expected)) return { ok: false, error: "bad_request", message: "mtime 非法" };
      let current = null;
      try {
        current = Math.floor((await stat(resolved.path)).mtimeMs);
      } catch {
        current = null;
      }
      if (current === null || current !== Math.floor(expected)) {
        return { ok: false, error: "conflict", message: "文件在别处已被修改，请重新载入后再保存", mtimeMs: current };
      }
    }
    try {
      await writeFile(resolved.path, text, "utf8");
    } catch (error) {
      return { ok: false, error: error?.code === "EACCES" || error?.code === "EPERM" ? "forbidden" : "failed", message: String(error?.message ?? error) };
    }
    const st = await stat(resolved.path);
    return { ok: true, path: resolved.path, sizeBytes: st.size, mtimeMs: Math.floor(st.mtimeMs) };
  }

  async function openDownload(input) {
    const resolved = await resolveExisting(input, readRoots);
    if (!resolved.ok) return resolved;
    let st;
    try {
      st = await stat(resolved.path);
    } catch (error) {
      return { ok: false, error: "not_found", message: String(error?.message ?? error) };
    }
    if (st.isDirectory()) return { ok: false, error: "failed", message: "这是目录，不能下载" };
    return {
      ok: true,
      path: resolved.path,
      name: path.basename(resolved.path),
      sizeBytes: st.size,
      mtimeMs: Math.floor(st.mtimeMs),
      stream: () => createReadStream(resolved.path),
    };
  }

  /** 保存上传流：先写临时文件，成功后原子改名。 */
  async function saveUpload(dirInput, fileName, readable) {
    if (!isValidFileName(fileName)) return { ok: false, error: "invalid_path", message: "文件名非法" };
    const dir = await resolveExisting(dirInput, writeRoots);
    if (!dir.ok) return dir;
    let st;
    try {
      st = await stat(dir.path);
    } catch (error) {
      return { ok: false, error: "not_found", message: String(error?.message ?? error) };
    }
    if (!st.isDirectory()) return { ok: false, error: "failed", message: "目标不是目录" };
    const target = path.join(dir.path, fileName);
    if (!under(target, writeRoots)) return { ok: false, error: "forbidden", message: "不在允许写入的范围内" };
    const temp = target + ".dsp-part-" + randomBytes(4).toString("hex");
    try {
      await pipeline(readable, createWriteStream(temp, { flags: "wx", mode: 0o644 }));
      await rename(temp, target);
    } catch (error) {
      await rm(temp, { force: true }).catch(() => {});
      return { ok: false, error: error?.code === "EACCES" || error?.code === "EPERM" ? "forbidden" : "failed", message: String(error?.message ?? error) };
    }
    const info = await stat(target);
    return { ok: true, path: target, sizeBytes: info.size };
  }

  async function makeDirectory(input) {
    const resolved = await resolveForWrite(input, writeRoots);
    if (!resolved.ok) return resolved;
    try {
      await mkdir(resolved.path);
    } catch (error) {
      if (error?.code === "EEXIST") return { ok: false, error: "failed", message: "同名条目已存在" };
      return { ok: false, error: error?.code === "EACCES" ? "forbidden" : "failed", message: String(error?.message ?? error) };
    }
    return { ok: true, path: resolved.path };
  }

  async function renameEntry(input, to) {
    const from = await resolveExisting(input, writeRoots);
    if (!from.ok) return from;
    const rawTo = typeof to === "string" && to.length > 0 ? to : null;
    if (rawTo === null) return { ok: false, error: "bad_request", message: "缺少 to 字段" };
    const target = path.isAbsolute(rawTo) ? rawTo : path.join(path.dirname(from.path), rawTo);
    const dest = await resolveForWrite(target, writeRoots);
    if (!dest.ok) return dest;
    try {
      await rename(from.path, dest.path);
    } catch (error) {
      return { ok: false, error: error?.code === "EACCES" ? "forbidden" : "failed", message: String(error?.message ?? error) };
    }
    return { ok: true, path: from.path, to: dest.path };
  }

  async function removeEntry(input, recursive) {
    const resolved = await resolveExisting(input, writeRoots);
    if (!resolved.ok) return resolved;
    if (writeRoots.includes(resolved.path) || readRoots.includes(resolved.path)) {
      return { ok: false, error: "forbidden", message: "不允许删除白名单根目录本身" };
    }
    let st;
    try {
      st = await lstat(resolved.path);
    } catch (error) {
      return { ok: false, error: "not_found", message: String(error?.message ?? error) };
    }
    if (st.isDirectory() && !recursive) {
      try {
        const rest = await readdir(resolved.path);
        if (rest.length > 0) return { ok: false, error: "failed", message: "目录非空（需勾选递归删除）" };
      } catch (error) {
        return { ok: false, error: "failed", message: String(error?.message ?? error) };
      }
    }
    try {
      if (st.isDirectory()) {
        // 空目录删除必须走 rmdir：Node 的 rm(path, {recursive:false}) 对目录一律报 EISDIR。
        if (recursive) await rm(resolved.path, { recursive: true, force: false });
        else await rmdir(resolved.path);
      } else {
        await rm(resolved.path, { force: false });
      }
    } catch (error) {
      return { ok: false, error: error?.code === "EACCES" ? "forbidden" : "failed", message: String(error?.message ?? error) };
    }
    return { ok: true, path: resolved.path };
  }

  return { roots, list, readText, writeText, openDownload, saveUpload, makeDirectory, renameEntry, removeEntry, readRoots, writeRoots };
}
