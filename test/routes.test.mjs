// 路由层测试：用假的 ctx / req / res 走完整的注册与分发路径，
// 覆盖方法校验、信任栅栏、错误码映射与文件白名单。
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { apply } from "../src/index.js";
import { eq, ok, summary, test, testAsync } from "./harness.mjs";

console.log("routes");

const BASE = "/dsh-server-panel";
const tmp = mkdtempSync(join(tmpdir(), "dsp-routes-"));
mkdirSync(join(tmp, "sub"), { recursive: true });
writeFileSync(join(tmp, "note.txt"), "hello\n");

/** 假 ctx：只实现插件真正用到的两件事（webServer.register / effect / get）。 */
function makeCtx({ withConnection = true } = {}) {
  const routes = new Map();
  const effects = [];
  const ctx = {
    get(name) {
      if (name === "connection") return withConnection ? { requestRejection: () => undefined } : undefined;
      return undefined;
    },
    webServer: {
      register(route) {
        const key = route.kind + " " + route.path;
        if (routes.has(key)) throw new Error("重复注册 " + key);
        routes.set(key, route);
        return () => routes.delete(key);
      },
    },
    effect(fn, label) {
      const dispose = fn();
      effects.push({ label, dispose: typeof dispose === "function" ? dispose : () => {} });
      return () => {};
    },
  };
  return { ctx, routes, effects };
}

function makeReq({ method = "GET", url = "/", body = null } = {}) {
  const req = Readable.from(body === null ? [] : [Buffer.from(body)]);
  req.method = method;
  req.url = url;
  req.headers = { host: "127.0.0.1:3080" };
  return req;
}

function makeRes() {
  return {
    statusCode: 0,
    headers: {},
    body: "",
    headersSent: false,
    writeHead(code, headers = {}) {
      this.statusCode = code;
      Object.assign(this.headers, headers);
      this.headersSent = true;
      return this;
    },
    end(chunk) {
      if (chunk !== undefined && chunk !== null) this.body += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
      this.ended = true;
      return this;
    },
    destroy() {},
    on() {
      return this;
    },
  };
}

async function call(routes, method, url, body = null) {
  const path = url.split("?")[0];
  const route = routes.get("exact " + path);
  if (!route) throw new Error("路由未注册：" + path);
  const res = makeRes();
  await route.handler(makeReq({ method, url, body }), res);
  let json = null;
  if (res.body) {
    try {
      json = JSON.parse(res.body);
    } catch {
      json = null;
    }
  }
  return { status: res.statusCode, json, headers: res.headers };
}

const { ctx, routes, effects } = makeCtx();
apply(ctx, { allowedReadRoots: [tmp], allowedWriteRoots: [tmp], pollMs: 60_000, servicesCacheMs: 0 });

test("注册了全部契约路由，且都在同一前缀下", () => {
  eq(routes.size, 26, "路由数量");
  for (const key of routes.keys()) {
    ok(key.startsWith("exact " + BASE + "/"), "路由前缀：" + key);
    ok(key.split(" ")[1] !== BASE, "不允许裸前缀路由");
  }
  ok(
    effects.some((e) => String(e.label).includes("sampler")),
    "采样器 effect 已注册",
  );
});

await testAsync("GET /health 自报家门", async () => {
  const r = await call(routes, "GET", BASE + "/health");
  eq(r.status, 200);
  eq(r.json.ok, true);
  eq(r.json.panelId, "server");
  ok(typeof r.json.version === "string");
});

await testAsync("GET /overview 返回可渲染的结构", async () => {
  const r = await call(routes, "GET", BASE + "/overview");
  eq(r.status, 200);
  eq(r.json.ok, true);
  for (const key of ["ts", "host", "cpu", "memory", "disks", "network", "processes", "uptimeSec"]) {
    ok(key in r.json, "缺少字段 " + key);
  }
  ok(Array.isArray(r.json.cpu.cores) && r.json.cpu.cores.length > 0, "逐核数据");
  ok(r.json.memory.totalBytes > 0, "内存总量");
});

await testAsync("方法不符返回 405 且带 Allow 头", async () => {
  const r = await call(routes, "POST", BASE + "/files/list?path=" + tmp);
  eq(r.status, 405);
  eq(r.json.error, "method_not_allowed");
  eq(r.headers.allow, "GET");
});

await testAsync("文件：roots / list / read / write / conflict / delete 全链路", async () => {
  const roots = await call(routes, "GET", BASE + "/files/roots");
  eq(roots.json.writeRoots[0], tmp);

  const list = await call(routes, "GET", BASE + "/files/list?path=" + encodeURIComponent(tmp));
  eq(list.status, 200);
  eq(list.json.entries.some((e) => e.name === "note.txt"), true);
  eq(list.json.parent, null, "白名单之外的父目录不下发");

  const read = await call(routes, "GET", BASE + "/files/read?path=" + encodeURIComponent(join(tmp, "note.txt")));
  eq(read.json.text, "hello\n");

  const write = await call(
    routes,
    "PUT",
    BASE + "/files/write?path=" + encodeURIComponent(join(tmp, "note.txt")) + "&mtime=" + read.json.mtimeMs,
    JSON.stringify({ text: "hello again\n" }),
  );
  eq(write.status, 200);
  eq(readFileSync(join(tmp, "note.txt"), "utf8"), "hello again\n");

  const conflict = await call(
    routes,
    "PUT",
    BASE + "/files/write?path=" + encodeURIComponent(join(tmp, "note.txt")) + "&mtime=" + (read.json.mtimeMs - 5000),
    JSON.stringify({ text: "被覆盖" }),
  );
  eq(conflict.status, 409);
  eq(conflict.json.error, "conflict");
  eq(readFileSync(join(tmp, "note.txt"), "utf8"), "hello again\n", "冲突时不得写入");

  const mk = await call(routes, "POST", BASE + "/files/mkdir", JSON.stringify({ path: join(tmp, "newdir") }));
  eq(mk.status, 200);
  const del = await call(routes, "POST", BASE + "/files/delete", JSON.stringify({ path: join(tmp, "newdir") }));
  eq(del.status, 200);
  const delRoot = await call(routes, "POST", BASE + "/files/delete", JSON.stringify({ path: tmp, recursive: true }));
  eq(delRoot.status, 403, "根目录不可删");
});

await testAsync("文件：越权与畸形请求", async () => {
  const outside = await call(routes, "GET", BASE + "/files/read?path=" + encodeURIComponent("/etc/hostname"));
  eq(outside.status, 403);
  eq(outside.json.error, "forbidden");
  const relative = await call(routes, "GET", BASE + "/files/read?path=note.txt");
  eq(relative.status, 400);
  eq(relative.json.error, "invalid_path");
  const missing = await call(routes, "GET", BASE + "/files/read?path=" + encodeURIComponent(join(tmp, "nope.txt")));
  eq(missing.status, 404);
  const download = await call(routes, "GET", BASE + "/files/download?path=" + encodeURIComponent(join(tmp, "nope.txt")));
  eq(download.status, 404);
  const badJson = await call(routes, "POST", BASE + "/files/mkdir", "{不是 JSON");
  eq(badJson.status, 400);
  eq(badJson.json.error, "bad_request");
});

await testAsync("文件：上传走原始 body 流", async () => {
  const r = await call(routes, "PUT", BASE + "/files/upload?path=" + encodeURIComponent(tmp) + "&name=up.txt", "streamed payload");
  eq(r.status, 200);
  eq(readFileSync(join(tmp, "up.txt"), "utf8"), "streamed payload");
});

await testAsync("服务：非法单元名/动作在触碰 systemd 之前就被拒", async () => {
  const badUnit = await call(routes, "POST", BASE + "/services/action", JSON.stringify({ unit: "cron.service; rm -rf /", action: "restart" }));
  eq(badUnit.status, 400);
  eq(badUnit.json.error, "invalid_unit");
  const badAction = await call(routes, "POST", BASE + "/services/action", JSON.stringify({ unit: "cron.service", action: "kill" }));
  eq(badAction.status, 400);
  eq(badAction.json.error, "invalid_action");
  const badLogUnit = await call(routes, "GET", BASE + "/services/logs?unit=../../etc/shadow");
  eq(badLogUnit.status, 400);
  eq(badLogUnit.json.error, "invalid_unit");
});

await testAsync("权限：未解锁时 sudo 相关动作返回 401 locked，且不执行动作", async () => {
  const state = await call(routes, "GET", BASE + "/sudo/state");
  eq(state.status, 200);
  eq(typeof state.json.unlocked, "boolean");
  const unlock = await call(routes, "POST", BASE + "/sudo/unlock", JSON.stringify({ password: "" }));
  eq(unlock.status, 401);
  eq(unlock.json.error, "bad_password");
  const lock = await call(routes, "POST", BASE + "/sudo/lock");
  eq(lock.status, 200);
  eq(lock.json.unlocked, false);
});

await testAsync("信任栅栏不可用时失败关闭（503）", async () => {
  const bare = makeCtx({ withConnection: false });
  apply(bare.ctx, { pollMs: 60_000 });
  const r = await call(bare.routes, "GET", BASE + "/health");
  eq(r.status, 503);
  eq(r.json.error, "trust_fence_unavailable");
});

await testAsync("服务列表真实可读（systemd 存在时）", async () => {
  const r = await call(routes, "GET", BASE + "/services");
  eq(r.status, 200);
  eq(r.json.ok, true);
  ok(Array.isArray(r.json.units));
  ok(r.json.units.every((u) => typeof u.unit === "string"));
});

await testAsync("v2：root 通道未解锁时直接 401 locked（不做静默降级）", async () => {
  const state = await call(routes, "GET", BASE + "/sudo/state");
  if (state.json.unlocked === true) return; // 本机若允许免密 sudo，本用例前提不成立
  const list = await call(routes, "GET", BASE + "/files/list?path=" + encodeURIComponent("/etc") + "&root=1");
  eq(list.status, 401);
  eq(list.json.error, "locked");
  const write = await call(routes, "PUT", BASE + "/files/write?path=" + encodeURIComponent("/etc/hosts") + "&root=1&mtime=null", JSON.stringify({ text: "x" }));
  eq(write.status, 401, "root 写入同样被拦");
});

await testAsync("v2：普通身份访问 /etc 仍然受限（白名单不变）", async () => {
  const r = await call(routes, "GET", BASE + "/files/list?path=" + encodeURIComponent("/etc"));
  eq(r.status, 403);
  eq(r.json.error, "forbidden");
});

await testAsync("v2：软件包页走 apt 模拟，不改动系统", async () => {
  const r = await call(routes, "GET", BASE + "/packages/upgradable");
  eq(r.status, 200);
  eq(r.json.ok, true);
  ok(Array.isArray(r.json.packages), "packages 是数组");
  const methodNotAllowed = await call(routes, "POST", BASE + "/packages/upgradable");
  eq(methodNotAllowed.status, 405);
});

await testAsync("v2：网络概览同时给出网卡、监听、连接与防火墙现状", async () => {
  const r = await call(routes, "GET", BASE + "/network/overview");
  eq(r.status, 200);
  eq(r.json.ok, true);
  ok(Array.isArray(r.json.interfaces));
  ok(Array.isArray(r.json.listeners));
  ok(Array.isArray(r.json.connections));
  ok(r.json.firewall && typeof r.json.firewall.available === "boolean", "防火墙状态要如实");
});

await testAsync("v2：files/roots 暴露 root 可用性与系统目录清单", async () => {
  const r = await call(routes, "GET", BASE + "/files/roots");
  eq(r.status, 200);
  eq(typeof r.json.rootAvailable, "boolean");
  ok(Array.isArray(r.json.systemWriteRoots) && r.json.systemWriteRoots.includes("/etc"));
});

rmSync(tmp, { recursive: true, force: true });
summary();
