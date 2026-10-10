// v2 路由表：把 v1 的 17 条路由扩成 26 条，并统一"root 身份"的处理。
//
// 两条贯穿全表的新规则：
//  1. 带 `root=1`（或 body.root=true）的请求走 root 传输层。未解锁时**直接**回
//     401 locked —— 不做"先试探再降级"，免得用户以为自己改的是系统文件、其实没改。
//  2. root 身份下写系统目录（/etc /boot /usr /lib* /bin /sbin /var/lib）必须带
//     `confirm=1`，否则回 409 confirm_required，由界面的二次确认框补上。

import { isSystemPath, SYSTEM_WRITE_ROOTS } from "./fsroot.js";

/**
 * @param {{
 *   settings: object,
 *   sampler: object,
 *   sudo: object,
 *   files: object,
 *   rootFiles: object,
 *   packages: object,
 *   network: object,
 *   servicesList: (filter?: string) => Promise<object>,
 *   sendJson: Function,
 *   sendError: Function,
 *   readJson: Function,
 * }} deps
 */
export function createRoutes(deps) {
  const { settings, sampler, sudo, files, rootFiles, packages, network, servicesList, sendJson, sendError, readJson } = deps;

  const wantsRoot = (url, body) => url?.searchParams?.get("root") === "1" || body?.root === true || body?.root === "1";
  const hasConfirm = (url, body) => url?.searchParams?.get("confirm") === "1" || body?.confirm === true;

  /** 选定本次请求使用的文件服务；未解锁时不给 root 通道。 */
  async function fileContext(url, body) {
    if (!wantsRoot(url, body)) return { svc: files, asRoot: false };
    const state = await sudo.state();
    if (state.unlocked !== true) {
      return { error: { error: "locked", message: "需要先解锁 sudo 才能以 root 操作文件" } };
    }
    return { svc: rootFiles, asRoot: true };
  }

  /** 系统目录写入闸门。 */
  function confirmGate(target, asRoot, url, body) {
    if (!asRoot || !isSystemPath(target)) return null;
    if (hasConfirm(url, body)) return null;
    return { error: "confirm_required", message: `这会改动系统文件，需要二次确认：${target}`, path: target };
  }

  /** 把 spawn 出来的 sudo 流接到 HTTP 响应上（root 下载用）。 */
  function pipeRootDownload(result, res) {
    const child = result.spawn();
    let head = false;
    const headers = {
      "content-type": "application/octet-stream",
      "cache-control": "no-store",
      "content-disposition": `attachment; filename="${encodeURIComponent(result.name)}"; filename*=UTF-8''${encodeURIComponent(result.name)}`,
    };
    const start = () => {
      if (head) return;
      head = true;
      res.writeHead(200, headers);
    };
    child.stdout.once("data", (chunk) => {
      start();
      res.write(chunk);
      child.stdout.pipe(res);
    });
    child.stdout.once("end", () => {
      if (!head) {
        start();
        res.end();
      }
    });
    child.once("error", (error) => {
      if (!head) {
        head = true;
        sendError(res, "failed", "无法启动 sudo：" + String(error?.message ?? error));
      }
    });
    child.stderr.resume();
    res.on("close", () => {
      try {
        child.kill("SIGKILL");
      } catch {
        // 已经退出。
      }
    });
  }

  return [
    {
      method: "GET",
      path: "/health",
      handler: (_req, res) =>
        sendJson(res, 200, {
          ok: true,
          name: "dsh-server-panel",
          version: deps.version ?? "0.0.0",
          node: process.version,
          pid: process.pid,
          uptimeSec: Math.floor(process.uptime()),
          panelId: "server",
          systemWriteRoots: SYSTEM_WRITE_ROOTS,
          pathname: process.cwd(),
        }),
    },
    {
      method: "GET",
      path: "/overview",
      handler: (_req, res) => sendJson(res, 200, sampler.snapshot({ force: true })),
    },
    {
      method: "GET",
      path: "/services",
      handler: async (_req, res, url) => {
        const result = await servicesList(url.searchParams.get("filter"));
        if (!result.ok) return sendError(res, result.error ?? "failed", result.message);
        sendJson(res, 200, { ok: true, ts: Date.now(), privileged: result.privileged, units: result.units });
      },
    },
    {
      method: "POST",
      path: "/services/action",
      handler: async (req, res) => {
        const body = await readJson(req, 8 * 1024);
        const unit = body.unit;
        const action = body.action;
        if (!deps.isValidUnit(unit)) return sendError(res, "invalid_unit", "单元名非法（只接受 xxx.service）");
        if (!deps.isValidAction(action)) return sendError(res, "invalid_action", "动作非法");
        const result = await deps.runServiceAction(unit, action, sudo, { timeoutMs: settings.commandTimeoutMs });
        deps.invalidateServices();
        if (!result.ok) return sendError(res, result.error ?? "failed", result.message);
        sendJson(res, 200, result);
      },
    },
    {
      method: "GET",
      path: "/services/logs",
      handler: async (_req, res, url) => {
        const unit = url.searchParams.get("unit");
        if (!deps.isValidUnit(unit)) return sendError(res, "invalid_unit", "单元名非法（只接受 xxx.service）");
        const lines = Number.parseInt(url.searchParams.get("lines") ?? "200", 10);
        const result = await deps.unitLogs(unit, Number.isFinite(lines) ? lines : 200, sudo, { timeoutMs: settings.commandTimeoutMs });
        if (!result.ok) return sendError(res, result.error ?? "failed", result.message);
        sendJson(res, 200, result);
      },
    },
    {
      method: "GET",
      path: "/sudo/state",
      handler: async (_req, res) => sendJson(res, 200, { ok: true, ...(await sudo.state()) }),
    },
    {
      method: "POST",
      path: "/sudo/unlock",
      handler: async (req, res) => {
        const body = await readJson(req, 4 * 1024);
        const result = await sudo.unlock(body.password);
        if (!result.ok) {
          return sendError(res, result.error, result.error === "bad_password" ? "sudo 密码不正确" : "sudo 不可用");
        }
        sendJson(res, 200, { ok: true, unlocked: true, expiresAt: result.expiresAt });
      },
    },
    {
      method: "POST",
      path: "/sudo/lock",
      handler: async (_req, res) => {
        await sudo.lock();
        sendJson(res, 200, { ok: true, unlocked: false });
      },
    },
    {
      method: "GET",
      path: "/files/roots",
      handler: async (_req, res) => {
        const state = await sudo.state();
        sendJson(res, 200, {
          ok: true,
          ...files.roots(),
          rootAvailable: state.unlocked === true,
          systemWriteRoots: SYSTEM_WRITE_ROOTS,
        });
      },
    },
    {
      method: "GET",
      path: "/files/list",
      handler: async (_req, res, url) => {
        const context = await fileContext(url, null);
        if (context.error) return sendError(res, context.error.error, context.error.message);
        const result = await context.svc.list(url.searchParams.get("path"));
        if (!result.ok) return sendError(res, result.error, result.message);
        sendJson(res, 200, { ...result, root: context.asRoot });
      },
    },
    {
      method: "GET",
      path: "/files/read",
      handler: async (_req, res, url) => {
        const context = await fileContext(url, null);
        if (context.error) return sendError(res, context.error.error, context.error.message);
        const result = await context.svc.readText(url.searchParams.get("path"));
        if (!result.ok) return sendError(res, result.error, result.message);
        sendJson(res, 200, { ...result, root: context.asRoot });
      },
    },
    {
      method: "PUT",
      path: "/files/write",
      handler: async (req, res, url) => {
        const body = await readJson(req, 4 * 1024 * 1024);
        const context = await fileContext(url, body);
        if (context.error) return sendError(res, context.error.error, context.error.message);
        const target = url.searchParams.get("path");
        const gate = confirmGate(target, context.asRoot, url, body);
        if (gate) return sendError(res, gate.error, gate.message);
        const mtimeRaw = url.searchParams.get("mtime");
        const expected = mtimeRaw === null || mtimeRaw === "" || mtimeRaw === "null" ? null : Number(mtimeRaw);
        const result = await context.svc.writeText(target, body.text, expected);
        if (!result.ok) return sendError(res, result.error, result.message);
        sendJson(res, 200, { ...result, root: context.asRoot });
      },
    },
    {
      method: "GET",
      path: "/files/download",
      handler: async (_req, res, url) => {
        const context = await fileContext(url, null);
        if (context.error) return sendError(res, context.error.error, context.error.message);
        const result = await context.svc.openDownload(url.searchParams.get("path"));
        if (!result.ok) return sendError(res, result.error, result.message);
        if (typeof result.spawn === "function") {
          pipeRootDownload(result, res);
          return;
        }
        res.writeHead(200, {
          "content-type": "application/octet-stream",
          "content-length": result.sizeBytes,
          "cache-control": "no-store",
          "content-disposition": `attachment; filename="${encodeURIComponent(result.name)}"; filename*=UTF-8''${encodeURIComponent(result.name)}`,
        });
        const stream = result.stream();
        stream.on("error", () => res.destroy());
        res.on("close", () => stream.destroy());
        stream.pipe(res);
      },
    },
    {
      method: "PUT",
      path: "/files/upload",
      handler: async (req, res, url) => {
        const context = await fileContext(url, null);
        if (context.error) return sendError(res, context.error.error, context.error.message);
        const dir = url.searchParams.get("path");
        const name = url.searchParams.get("name");
        const target = typeof dir === "string" && typeof name === "string" ? (dir.endsWith("/") ? dir + name : dir + "/" + name) : null;
        const gate = target === null ? null : confirmGate(target, context.asRoot, url, null);
        if (gate) return sendError(res, gate.error, gate.message);
        const result = await context.svc.saveUpload(dir, name, req);
        if (!result.ok) return sendError(res, result.error, result.message);
        sendJson(res, 200, { ...result, root: context.asRoot });
      },
    },
    {
      method: "POST",
      path: "/files/mkdir",
      handler: async (req, res) => {
        const body = await readJson(req, 8 * 1024);
        const context = await fileContext(null, body);
        if (context.error) return sendError(res, context.error.error, context.error.message);
        const gate = confirmGate(body.path, context.asRoot, null, body);
        if (gate) return sendError(res, gate.error, gate.message);
        const result = await context.svc.makeDirectory(body.path);
        if (!result.ok) return sendError(res, result.error, result.message);
        sendJson(res, 200, { ...result, root: context.asRoot });
      },
    },
    {
      method: "POST",
      path: "/files/rename",
      handler: async (req, res) => {
        const body = await readJson(req, 8 * 1024);
        const context = await fileContext(null, body);
        if (context.error) return sendError(res, context.error.error, context.error.message);
        const gate = confirmGate(body.path, context.asRoot, null, body);
        if (gate) return sendError(res, gate.error, gate.message);
        const result = await context.svc.renameEntry(body.path, body.to);
        if (!result.ok) return sendError(res, result.error, result.message);
        sendJson(res, 200, { ...result, root: context.asRoot });
      },
    },
    {
      method: "POST",
      path: "/files/delete",
      handler: async (req, res) => {
        const body = await readJson(req, 8 * 1024);
        const context = await fileContext(null, body);
        if (context.error) return sendError(res, context.error.error, context.error.message);
        const gate = confirmGate(body.path, context.asRoot, null, body);
        if (gate) return sendError(res, gate.error, gate.message);
        const result = await context.svc.removeEntry(body.path, body.recursive === true);
        if (!result.ok) return sendError(res, result.error, result.message);
        sendJson(res, 200, { ...result, root: context.asRoot });
      },
    },
    {
      method: "POST",
      path: "/files/chmod",
      handler: async (req, res) => {
        const body = await readJson(req, 8 * 1024);
        const context = await fileContext(null, { ...body, root: true });
        if (context.error) return sendError(res, context.error.error, context.error.message);
        const gate = confirmGate(body.path, context.asRoot, null, body);
        if (gate) return sendError(res, gate.error, gate.message);
        const result = await rootFiles.chmodEntry(body.path, body.mode);
        if (!result.ok) return sendError(res, result.error, result.message);
        sendJson(res, 200, result);
      },
    },
    {
      method: "POST",
      path: "/files/chown",
      handler: async (req, res) => {
        const body = await readJson(req, 8 * 1024);
        const context = await fileContext(null, { ...body, root: true });
        if (context.error) return sendError(res, context.error.error, context.error.message);
        const gate = confirmGate(body.path, context.asRoot, null, body);
        if (gate) return sendError(res, gate.error, gate.message);
        const result = await rootFiles.chownEntry(body.path, body.owner);
        if (!result.ok) return sendError(res, result.error, result.message);
        sendJson(res, 200, result);
      },
    },
    {
      method: "GET",
      path: "/packages/upgradable",
      handler: async (_req, res) => {
        const result = await packages.upgradable();
        if (!result.ok) return sendError(res, result.error ?? "failed", result.message);
        sendJson(res, 200, result);
      },
    },
    {
      method: "GET",
      path: "/packages/installed",
      handler: async (_req, res, url) => {
        const limit = Number.parseInt(url.searchParams.get("limit") ?? "300", 10);
        const result = await packages.installed({
          filter: url.searchParams.get("filter"),
          limit: Number.isFinite(limit) ? limit : 300,
        });
        if (!result.ok) return sendError(res, result.error ?? "failed", result.message);
        sendJson(res, 200, result);
      },
    },
    {
      method: "POST",
      path: "/packages/update-index",
      handler: async (_req, res) => {
        const result = await packages.updateIndex();
        if (!result.ok) return sendError(res, result.error ?? "failed", result.message);
        sendJson(res, 200, result);
      },
    },
    {
      method: "POST",
      path: "/packages/upgrade",
      handler: async (req, res) => {
        const body = await readJson(req, 256 * 1024);
        const result = await packages.upgrade({ names: body.names, all: body.all === true });
        if (!result.ok) return sendError(res, result.error ?? "failed", result.message);
        sendJson(res, 200, result);
      },
    },
    {
      method: "GET",
      path: "/network/overview",
      handler: async (_req, res, url) => {
        const state = await sudo.state();
        const asRoot = url.searchParams.get("root") === "1" && state.unlocked === true;
        const [linkResult, listenerResult, connectionResult, firewallResult] = await Promise.all([
          network.interfaces(),
          network.listeners({ asRoot }),
          network.connections({ asRoot }),
          network.firewall(),
        ]);
        if (!linkResult.ok) return sendError(res, linkResult.error ?? "failed", linkResult.message);
        sendJson(res, 200, {
          ok: true,
          ts: Date.now(),
          interfaces: linkResult.interfaces,
          defaultRoute: linkResult.defaultRoute,
          listeners: listenerResult.listeners ?? [],
          listenersPrivileged: listenerResult.privileged === true,
          connections: connectionResult.top ?? [],
          connectionsTotal: connectionResult.total ?? 0,
          firewall: firewallResult,
          privileged: asRoot,
        });
      },
    },
    {
      method: "GET",
      path: "/network/listeners",
      handler: async (_req, res, url) => {
        const state = await sudo.state();
        const asRoot = url.searchParams.get("root") === "1" && state.unlocked === true;
        const result = await network.listeners({ asRoot });
        if (!result.ok) return sendError(res, result.error ?? "failed", result.message);
        sendJson(res, 200, result);
      },
    },
    {
      method: "GET",
      path: "/network/connections",
      handler: async (_req, res, url) => {
        const state = await sudo.state();
        const asRoot = url.searchParams.get("root") === "1" && state.unlocked === true;
        const result = await network.connections({ asRoot });
        if (!result.ok) return sendError(res, result.error ?? "failed", result.message);
        sendJson(res, 200, result);
      },
    },
  ];
}
