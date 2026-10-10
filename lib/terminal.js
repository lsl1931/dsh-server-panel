// 终端会话：基于 dsh 自带的 subprocess.spawnTerminal（真 PTY）。
//
// 一个 WebSocket 连接 = 一个 PTY 会话，这样"多标签"在客户端就是多条连接，
// 服务端不需要会话路由表；连接断开即结束进程，不留孤儿。
//
// root shell：
//   - 已解锁（sudo 时间戳热）→ `sudo -n -i`，直接进 root，不再问密码；
//   - 未解锁 → `sudo -i`，由 sudo 在终端里自己向用户要密码（密码全程不经过插件）。
//
// 输出带一个环形回放缓冲：客户端刷新/重连时能先看到最近的输出，不至于一片空白。

import { homedir, userInfo } from "node:os";

export const DEFAULT_SCROLLBACK_BYTES = 128 * 1024;

/**
 * @param {{
 *   subprocess: { spawnTerminal: Function },
 *   sudo: { state: Function },
 *   shell?: string,
 *   cwd?: string,
 *   maxSessions?: number,
 *   graceMs?: number,
 *   scrollbackBytes?: number,
 * }} deps
 */
export function createTerminalService(deps) {
  const shell = deps.shell ?? "/bin/bash";
  const cwd = deps.cwd ?? homedir();
  const maxSessions = Number.isFinite(deps.maxSessions) ? Math.max(1, deps.maxSessions) : 4;
  const graceMs = Number.isFinite(deps.graceMs) ? deps.graceMs : 3000;
  const scrollbackBytes = Number.isFinite(deps.scrollbackBytes) ? deps.scrollbackBytes : DEFAULT_SCROLLBACK_BYTES;

  const sessions = new Map();
  let seq = 0;

  function environment() {
    let user = "user";
    try {
      user = userInfo().username;
    } catch {
      user = process.env.USER ?? "user";
    }
    return {
      PATH: process.env.PATH ?? "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      HOME: homedir(),
      USER: user,
      LOGNAME: user,
      SHELL: shell,
      LANG: process.env.LANG ?? "C.UTF-8",
      TERM: "xterm-256color",
    };
  }

  /** root 会话的命令行：解锁就直接免密，没解锁让 sudo 在终端里问。 */
  async function argvFor(kind) {
    if (kind !== "root") return [shell, "-l"];
    let unlocked = false;
    try {
      unlocked = (await deps.sudo.state()).unlocked === true;
    } catch {
      unlocked = false;
    }
    return unlocked ? ["sudo", "-n", "-i"] : ["sudo", "-i"];
  }

  function pushScrollback(session, text) {
    session.scrollback.push(text);
    session.scrollbackBytes += Buffer.byteLength(text, "utf8");
    while (session.scrollbackBytes > scrollbackBytes && session.scrollback.length > 1) {
      const dropped = session.scrollback.shift();
      session.scrollbackBytes -= Buffer.byteLength(dropped, "utf8");
    }
  }

  function broadcast(session, message) {
    for (const peer of session.peers) {
      if (!peer.closed) peer.sendJson(message);
    }
  }

  async function create(options = {}) {
    if (sessions.size >= maxSessions) {
      return { ok: false, error: "failed", message: `同时最多 ${maxSessions} 个终端会话，请先关掉一个` };
    }
    const cols = clamp(options.cols, 20, 500, 100);
    const rows = clamp(options.rows, 5, 200, 30);
    const kind = options.shell === "root" ? "root" : "user";
    const argv = await argvFor(kind);
    let handle;
    try {
      handle = await deps.subprocess.spawnTerminal({
        argv,
        cwd,
        env: environment(),
        rows,
        cols,
        terminalType: "xterm-256color",
        shellActivity: false,
        graceMs,
      });
    } catch (error) {
      return { ok: false, error: "failed", message: "无法启动终端：" + String(error?.message ?? error) };
    }
    seq += 1;
    const session = {
      id: "t" + seq,
      pid: handle.pid,
      handle,
      kind,
      argv,
      cols,
      rows,
      peers: new Set(),
      scrollback: [],
      scrollbackBytes: 0,
      exitCode: null,
      createdAt: Date.now(),
    };
    sessions.set(session.id, session);

    handle.output.on("data", (chunk) => {
      const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
      pushScrollback(session, text);
      broadcast(session, { t: "output", d: text });
    });
    handle.output.on("error", () => {});
    Promise.resolve(handle.done)
      .then((outcome) => {
        session.exitCode = outcome?.exitCode ?? null;
        broadcast(session, { t: "exit", code: session.exitCode });
      })
      .catch(() => {
        broadcast(session, { t: "exit", code: null });
      })
      .finally(() => {
        sessions.delete(session.id);
      });

    return { ok: true, id: session.id, pid: session.pid, shell: kind, cols, rows, argv };
  }

  function get(id) {
    return sessions.get(id) ?? null;
  }

  function attach(session, peer) {
    session.peers.add(peer);
    peer.sendJson({ t: "ready", id: session.id, pid: session.pid, shell: session.kind, cols: session.cols, rows: session.rows });
    if (session.scrollback.length > 0) peer.sendJson({ t: "output", d: session.scrollback.join("") });
  }

  function detach(session, peer) {
    session.peers.delete(peer);
  }

  async function write(session, data) {
    if (typeof data !== "string" || data.length === 0) return;
    // 单次输入的硬上限，避免恶意端把内存打满。
    const text = data.length > 64 * 1024 ? data.slice(0, 64 * 1024) : data;
    try {
      await session.handle.write(text);
    } catch {
      // 进程已退出：忽略。
    }
  }

  async function resize(session, cols, rows) {
    const nextCols = clamp(cols, 20, 500, session.cols);
    const nextRows = clamp(rows, 5, 200, session.rows);
    if (nextCols === session.cols && nextRows === session.rows) return;
    session.cols = nextCols;
    session.rows = nextRows;
    try {
      await session.handle.resize(nextCols, nextRows);
    } catch {
      // 忽略：进程已退出。
    }
  }

  async function kill(session) {
    sessions.delete(session.id);
    try {
      await session.handle.terminate();
    } catch {
      // 忽略。
    }
  }

  function disposeAll() {
    for (const session of sessions.values()) {
      try {
        session.handle.terminate();
      } catch {
        // 忽略。
      }
      for (const peer of session.peers) peer.close(1001, "服务端关闭");
    }
    sessions.clear();
  }

  return { create, get, attach, detach, write, resize, kill, disposeAll, count: () => sessions.size, maxSessions };
}

function clamp(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}
