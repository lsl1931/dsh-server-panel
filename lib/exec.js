// 子进程执行：全程 argv 数组，绝不拼 shell 字符串。
//
// 纪律：
//  - 不用 shell（execFile 而非 exec），因此单元名/路径里的 `; | $()` 之类字符
//    没有第二层解释机会；
//  - 强制超时 + 输出上限，长命令不会把路由挂死或把内存吃穿；
//  - 任何失败都归约成结构化结果，不抛异常给调用方；
//  - 环境变量收敛到最小集合（PATH/LANG），日志里的时间戳与字段名保持可解析。

import { execFile } from "node:child_process";

/** 默认单次子进程输出上限（stdout/stderr 各自）。 */
export const DEFAULT_MAX_BYTES = 512 * 1024;
/** 默认子进程超时。 */
export const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * @param {string[]} argv 命令与参数（argv[0] 是命令名或绝对路径）
 * @param {{ input?: string, timeoutMs?: number, maxBytes?: number, cwd?: string, env?: Record<string,string> }} [options]
 * @returns {Promise<{ ok:boolean, code:number|null, stdout:string, stderr:string, timedOut:boolean, truncated:boolean, spawnError:string|null }>}
 */
export function run(argv, options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : DEFAULT_TIMEOUT_MS;
  const maxBytes = Number.isFinite(options.maxBytes) ? options.maxBytes : DEFAULT_MAX_BYTES;
  const env = {
    PATH: process.env.PATH ?? "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    LANG: "C",
    LC_ALL: "C",
    ...options.env,
  };
  return new Promise((resolve) => {
    let child;
    const done = (result) => resolve(result);
    try {
      child = execFile(
        argv[0],
        argv.slice(1),
        {
          cwd: options.cwd,
          env,
          timeout: timeoutMs,
          maxBuffer: maxBytes,
          killSignal: "SIGKILL",
          windowsHide: true,
        },
        (error, stdout, stderr) => {
          const code = error && typeof error.code === "number" ? error.code : error ? null : 0;
          const truncated = Boolean(error && error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER");
          done({
            ok: !error,
            code,
            stdout: String(stdout ?? ""),
            stderr: String(stderr ?? ""),
            timedOut: Boolean(error && (error.killed === true || error.signal === "SIGKILL")),
            truncated,
            spawnError: error && typeof error.code === "string" ? error.message : null,
          });
        },
      );
    } catch (error) {
      done({
        ok: false,
        code: null,
        stdout: "",
        stderr: "",
        timedOut: false,
        truncated: false,
        spawnError: String(error?.message ?? error),
      });
      return;
    }
    // 有 input：写进去就关流（sudo -S 就是靠这个读密码，命令自身拿不到残留输入）。
    if (child.stdin) {
      child.stdin.on("error", () => {});
      if (typeof options.input === "string") child.stdin.end(options.input);
      else child.stdin.end();
    }
  });
}

/** 命令是否存在（用于降级判断）。 */
export async function hasCommand(name, options = {}) {
  const r = await run(["/usr/bin/env", "sh", "-c", "command -v " + JSON.stringify(name)], options);
  return r.ok && r.stdout.trim().length > 0;
}
