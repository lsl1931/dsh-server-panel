// dsh-server-panel Host 半入口（v2）。
//
// 职责：
//   1. 组合配置 → 采样器 / sudo 会话 / 文件（普通 + root 两套）/ 软件包 / 网络
//   2. 把路由注册到 dsh 自己的 Web 服务上（不开新端口、不引反向代理）
//   3. 每个路由一个 ctx.effect：插件卸载即整体摘除
//
// 权限模型（v2）：解锁 sudo 之前一切按 dsh 进程用户（运行 dsh 的那个用户）走白名单；解锁之后
// 所有模块都可以切到 root —— 由请求上的 `root=1` 显式选择，闸门在 routes.js。

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { run } from "./exec.js";
import { createFileService } from "./files.js";
import { createRootFileService, isSystemPath, SYSTEM_WRITE_ROOTS } from "./fsroot.js";
import { createSampler } from "./metrics.js";
import { createNetworkService } from "./network.js";
import { createPackageService } from "./packages.js";
import { createRoutes } from "./routes.js";
import { ACTIONS, isValidAction, isValidUnit, listUnits, runServiceAction, unitLogs } from "./services.js";
import { createSudoSession } from "./sudo.js";
import { createTerminalService } from "./terminal.js";
import { acceptUpgrade, createPeer } from "./ws.js";

const NS = "dsh-server-panel";
const BASE = "/dsh-server-panel";

/** 硬依赖：HTTP 载体 + 信任栅栏 + PTY 子进程服务（终端用）。 */
export const inject = ["webServer", "connection", "subprocess"];

const VERSION = (() => {
  try {
    return JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

const DEFAULTS = {
  pollMs: 2000,
  overviewStaleMs: 1000,
  servicesCacheMs: 2000,
  sudoIdleMs: 600_000,
  commandTimeoutMs: 10_000,
  // 白名单默认跟随运行 dsh 的那个用户的家目录，不写死任何具体路径。
  allowedReadRoots: [homedir(), "/etc", "/var/log", "/srv", "/opt"],
  allowedWriteRoots: [homedir()],
  dangerUnits: ["ssh", "sshd", "systemd-logind", "networking", "systemd-networkd", "dsh"],
  terminalEnabled: true,
  terminalMaxSessions: 4,
  terminalShell: "/bin/bash",
};

/** error 码 → HTTP 状态。 */
const STATUS = {
  bad_request: 400,
  invalid_path: 400,
  invalid_unit: 400,
  invalid_action: 400,
  locked: 401,
  bad_password: 401,
  forbidden: 403,
  not_found: 404,
  method_not_allowed: 405,
  conflict: 409,
  confirm_required: 409,
  too_large: 413,
  binary: 415,
  sudo_unavailable: 503,
  trust_fence_unavailable: 503,
  failed: 500,
};

function statusOf(error) {
  return STATUS[error] ?? 400;
}

/** 把用户写在 cordis.patch.yml 里的 config 收敛成可信数值/数组，非法值退回默认。 */
export function normalizeSettings(raw) {
  const cfg = raw && typeof raw === "object" ? raw : {};
  const num = (value, fallback, min, max) => {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
  };
  const roots = (value, fallback) => {
    if (!Array.isArray(value)) return fallback;
    const list = value.filter((v) => typeof v === "string" && v.startsWith("/"));
    return list.length > 0 ? list : fallback;
  };
  const units = (value, fallback) => {
    if (!Array.isArray(value)) return fallback;
    return value.filter((v) => typeof v === "string" && v.length > 0);
  };
  return {
    pollMs: num(cfg.pollMs, DEFAULTS.pollMs, 250, 60_000),
    overviewStaleMs: num(cfg.overviewStaleMs, DEFAULTS.overviewStaleMs, 0, 60_000),
    servicesCacheMs: num(cfg.servicesCacheMs, DEFAULTS.servicesCacheMs, 0, 60_000),
    sudoIdleMs: num(cfg.sudoIdleMs, DEFAULTS.sudoIdleMs, 0, 24 * 3600_000),
    commandTimeoutMs: num(cfg.commandTimeoutMs, DEFAULTS.commandTimeoutMs, 1000, 120_000),
    allowedReadRoots: roots(cfg.allowedReadRoots, DEFAULTS.allowedReadRoots),
    allowedWriteRoots: roots(cfg.allowedWriteRoots, DEFAULTS.allowedWriteRoots),
    dangerUnits: units(cfg.dangerUnits, DEFAULTS.dangerUnits),
    terminalEnabled: cfg.terminalEnabled === undefined ? DEFAULTS.terminalEnabled : cfg.terminalEnabled !== false,
    terminalMaxSessions: num(cfg.terminalMaxSessions, DEFAULTS.terminalMaxSessions, 1, 16),
    terminalShell: typeof cfg.terminalShell === "string" && cfg.terminalShell.startsWith("/") ? cfg.terminalShell : DEFAULTS.terminalShell,
  };
}

// ---------------------------------------------------------------------------
// HTTP 工具
// ---------------------------------------------------------------------------

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(text),
  });
  res.end(text);
}

function sendError(res, error, message) {
  const status = statusOf(error);
  sendJson(res, status, message === undefined ? { ok: false, error } : { ok: false, error, message });
}

/**
 * 信任栅栏：与 dsh-resource-bar 同款，拿不到判定能力时**失败关闭**（503）。
 */
function rejected(ctx, req, res) {
  const connection = ctx.get("connection");
  if (connection === undefined || typeof connection.requestRejection !== "function") {
    sendJson(res, 503, { ok: false, error: "trust_fence_unavailable" });
    return true;
  }
  const rejection = connection.requestRejection(req);
  if (rejection === undefined) return false;
  res.writeHead(rejection);
  res.end();
  return true;
}

async function readBody(req, maxBytes = 256 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) {
      const error = new Error("请求体过大");
      error.code = "too_large";
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJson(req, maxBytes) {
  const buf = await readBody(req, maxBytes);
  if (buf.length === 0) return {};
  try {
    const parsed = JSON.parse(buf.toString("utf8"));
    if (parsed === null || typeof parsed !== "object") {
      const error = new Error("请求体必须是 JSON 对象");
      error.code = "bad_request";
      throw error;
    }
    return parsed;
  } catch (error) {
    if (error?.code === "bad_request") throw error;
    const wrapped = new Error("请求体不是合法 JSON");
    wrapped.code = "bad_request";
    throw wrapped;
  }
}

// ---------------------------------------------------------------------------
// 插件入口
// ---------------------------------------------------------------------------

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} [config]
 */
export function apply(ctx, config) {
  const settings = normalizeSettings(config);
  const sampler = createSampler({ pollMs: settings.pollMs, staleMs: settings.overviewStaleMs });
  const sudo = createSudoSession({ idleMs: settings.sudoIdleMs, timeoutMs: settings.commandTimeoutMs });
  const files = createFileService({ readRoots: settings.allowedReadRoots, writeRoots: settings.allowedWriteRoots });
  const rootFiles = createRootFileService({ sudo, spawnRoot: sudo.spawnRoot, timeoutMs: settings.commandTimeoutMs });
  const packages = createPackageService({ sudo, run, timeoutMs: settings.commandTimeoutMs });
  const network = createNetworkService({ run, sudo, timeoutMs: settings.commandTimeoutMs });
  const terminals = createTerminalService({
    subprocess: ctx.subprocess,
    sudo,
    shell: settings.terminalShell,
    maxSessions: settings.terminalMaxSessions,
    graceMs: 3000,
  });

  // --- 采样：一个定时器，卸载即清 ---------------------------------------
  ctx.effect(
    () => {
      try {
        sampler.tick();
      } catch {
        // 首帧失败不影响注册。
      }
      const timer = setInterval(() => {
        try {
          sampler.tick();
        } catch {
          // 采样失败时保留上一帧。
        }
      }, sampler.pollMs);
      timer.unref?.();
      return () => clearInterval(timer);
    },
    `${NS}: sampler`,
  );

  // --- sudo 会话：卸载时丢密码 + sudo -k --------------------------------
  ctx.effect(() => () => sudo.dispose(), `${NS}: sudo session`);

  // --- 终端：卸载时结束所有 PTY 会话 -------------------------------------
  ctx.effect(() => () => terminals.disposeAll(), `${NS}: terminals`);

  // --- 服务列表缓存（界面 5s 轮询，别每次都 fork systemctl）-------------
  let servicesCache = { at: 0, value: null };
  async function servicesList(filter) {
    const now = Date.now();
    if (servicesCache.value === null || now - servicesCache.at > settings.servicesCacheMs) {
      const fresh = await listUnits({ timeoutMs: settings.commandTimeoutMs });
      if (fresh.ok) servicesCache = { at: Date.now(), value: fresh };
      else if (servicesCache.value === null) return fresh;
    }
    const cached = servicesCache.value;
    const needle = typeof filter === "string" ? filter.trim().toLowerCase() : "";
    const units = needle
      ? cached.units.filter((u) => u.unit.toLowerCase().includes(needle) || String(u.description).toLowerCase().includes(needle))
      : cached.units;
    return { ok: true, units, privileged: cached.privileged };
  }
  const invalidateServices = () => {
    servicesCache = { at: 0, value: null };
  };

  // --- 路由表 ------------------------------------------------------------
  const routes = createRoutes({
    version: VERSION,
    settings,
    sampler,
    sudo,
    files,
    rootFiles,
    packages,
    network,
    servicesList,
    invalidateServices,
    sendJson,
    sendError,
    readJson,
    isValidUnit,
    isValidAction,
    runServiceAction,
    unitLogs,
  });

  for (const route of routes) {
    ctx.effect(
      () =>
        ctx.webServer.register({
          // exact：避免前缀路由把邻居吃掉。
          kind: "exact",
          path: BASE + route.path,
          handler: async (req, res) => {
            if (rejected(ctx, req, res)) return;
            if (req.method !== route.method) {
              res.writeHead(405, {
                allow: route.method,
                "content-type": "application/json; charset=utf-8",
                "cache-control": "no-store",
              });
              res.end(JSON.stringify({ ok: false, error: "method_not_allowed" }));
              return;
            }
            let url;
            try {
              url = new URL(req.url ?? "/", "http://127.0.0.1");
            } catch {
              return sendError(res, "bad_request", "请求 URL 非法");
            }
            try {
              await route.handler(req, res, url);
            } catch (error) {
              const code = typeof error?.code === "string" && STATUS[error.code] ? error.code : "failed";
              if (res.headersSent) {
                res.end();
                return;
              }
              sendError(res, code, String(error?.message ?? error).slice(0, 400));
            }
          },
        }),
      `${NS}: ${route.method} ${route.path}`,
    );
  }
  // --- 终端（WebSocket upgrade）：一个连接 = 一个 PTY 会话 ----------------
  if (settings.terminalEnabled && typeof ctx.webServer.registerUpgrade === "function") {
    ctx.effect(
      () =>
        ctx.webServer.registerUpgrade({
          path: BASE + "/terminal",
          handler: (req, socket) => handleTerminalUpgrade(ctx, terminals, req, socket),
        }),
      `${NS}: WS /terminal`,
    );
  }
}

/**
 * WebSocket 终端入口：先过信任栅栏（未认证的连接一律拒绝），再握手、再建会话。
 * 协议（文本帧 JSON）：
 *   客户端 → 服务端：{t:'input',d} / {t:'resize',cols,rows} / {t:'ping'}
 *   服务端 → 客户端：{t:'ready',id,pid,shell} / {t:'output',d} / {t:'exit',code} / {t:'error',message}
 */
function handleTerminalUpgrade(ctx, terminals, req, socket) {
  const connection = ctx.get("connection");
  if (connection === undefined || typeof connection.requestRejection !== "function") {
    socket.write("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }
  const rejection = connection.requestRejection(req);
  if (rejection !== undefined) {
    socket.write(`HTTP/1.1 ${rejection} Forbidden\r\nConnection: close\r\n\r\n`);
    socket.destroy();
    return;
  }
  if (!acceptUpgrade(req, socket)) {
    socket.destroy();
    return;
  }

  let url;
  try {
    url = new URL(req.url ?? "/", "http://127.0.0.1");
  } catch {
    url = new URL("http://127.0.0.1/");
  }
  const requestedShell = url.searchParams.get("shell") === "root" ? "root" : "user";
  const cols = Number(url.searchParams.get("cols"));
  const rows = Number(url.searchParams.get("rows"));

  const peer = createPeer(socket, {
    onMessage: async (text) => {
      let message;
      try {
        message = JSON.parse(text);
      } catch {
        return;
      }
      if (message.t === "input") {
        if (session) await terminals.write(session, message.d);
        return;
      }
      if (message.t === "resize") {
        if (session) await terminals.resize(session, message.cols, message.rows);
        return;
      }
      if (message.t === "ping") peer.sendJson({ t: "pong" });
    },
    onClose: () => {
      if (session) {
        terminals.detach(session, peer);
        void terminals.kill(session);
      }
    },
  });

  let session = null;
  terminals
    .create({ cols, rows, shell: requestedShell })
    .then((created) => {
      if (!created.ok) {
        peer.sendJson({ t: "error", message: created.message ?? "无法创建终端会话" });
        peer.close(1011, "terminal unavailable");
        return;
      }
      session = terminals.get(created.id);
      if (session) terminals.attach(session, peer);
    })
    .catch((error) => {
      peer.sendJson({ t: "error", message: String(error?.message ?? error) });
      peer.close(1011, "terminal unavailable");
    });
}

export { isSystemPath, SYSTEM_WRITE_ROOTS, ACTIONS };
