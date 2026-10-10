// 网络模块：网卡地址、监听端口、已建立连接、防火墙现状、默认路由。
//
// 只读模块，数据来自内核与 iproute2：
//   ip -j addr / ip -j route   网卡与默认路由（JSON，解析稳定）
//   ss -H -tulpn               监听端口（root 时能看到别人家进程的名字）
//   ss -H -tn state established 已建立连接（按对端聚合）
//
// 解析函数全部导出，便于单测；拿不到的工具（本机没装 nft/ufw）如实报告"不可用"，
// 不编造一个空表格。

/** 解析 `ss` 的一行（纯函数）。 */
export function parseSsLine(line) {
  const m = /^(\S+)\s+(\S+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s*(.*)$/.exec(String(line ?? "").trim());
  if (!m) return null;
  const [, netid, state, recvQ, sendQ, local, peer, rest] = m;
  const splitHostPort = (value) => {
    const idx = value.lastIndexOf(":");
    if (idx < 0) return { host: value, port: null };
    const port = Number(value.slice(idx + 1));
    return { host: value.slice(0, idx), port: Number.isFinite(port) ? port : null };
  };
  const l = splitHostPort(local);
  const p = splitHostPort(peer);
  const proc = /users:\(\((?:"([^"]+)",)?pid=(\d+)/.exec(rest ?? "");
  const uid = /uid:(\d+)/.exec(rest ?? "");
  return {
    proto: netid,
    state,
    recvQ: Number(recvQ),
    sendQ: Number(sendQ),
    localHost: l.host,
    localPort: l.port,
    peerHost: p.host,
    peerPort: p.port,
    process: proc ? proc[1] ?? null : null,
    pid: proc ? Number(proc[2]) : null,
    uid: uid ? Number(uid[1]) : null,
  };
}

/** 解析 `ss -H -tulpn` 的整段输出（纯函数）。 */
export function parseListeners(text) {
  const rows = [];
  for (const line of String(text ?? "").split("\n")) {
    if (!line.trim()) continue;
    const parsed = parseSsLine(line);
    if (parsed) rows.push(parsed);
  }
  return rows;
}

/** 按对端主机聚合已建立连接（纯函数）。 */
export function summarizeConnections(rows, limit = 10) {
  const byHost = new Map();
  for (const row of rows ?? []) {
    const host = row?.peerHost;
    if (!host) continue;
    const key = host.replace(/^\[|\]$/g, "");
    const entry = byHost.get(key) ?? { host: key, count: 0, ports: new Set() };
    entry.count += 1;
    if (row.peerPort !== null) entry.ports.add(row.peerPort);
    byHost.set(key, entry);
  }
  return [...byHost.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, Math.max(1, limit))
    .map((entry) => ({ host: entry.host, count: entry.count, ports: [...entry.ports].sort((a, b) => a - b).slice(0, 8) }));
}

/** 解析 `ip -j addr`（纯函数）。 */
export function parseIpAddr(json) {
  const rows = Array.isArray(json) ? json : [];
  return rows.map((row) => ({
    name: row.ifname ?? "?",
    state: row.operstate ?? null,
    loopback: row.link_type === "loopback",
    mtu: row.mtu ?? null,
    mac: row.address ?? null,
    addresses: (row.addr_info ?? []).map((info) => ({
      family: info.family ?? null,
      local: info.local ?? null,
      prefixlen: info.prefixlen ?? null,
      scope: info.scope ?? null,
    })),
  }));
}

/** 解析 `ip -j route show default`（纯函数）。 */
export function parseDefaultRoute(json) {
  const row = Array.isArray(json) ? json[0] : null;
  if (!row) return null;
  return { gateway: row.gateway ?? null, device: row.dev ?? null, metric: row.metric ?? null };
}

const FIREWALL_CANDIDATES = [
  { tool: "nft", argv: ["nft", "list", "ruleset"], label: "nftables" },
  { tool: "ufw", argv: ["ufw", "status"], label: "ufw" },
];

/**
 * @param {{ run: Function, sudo: { runRoot: Function, state: Function }, timeoutMs?: number }} deps
 */
export function createNetworkService(deps) {
  const run = deps.run;
  const sudo = deps.sudo;
  const timeoutMs = deps.timeoutMs ?? 10_000;

  async function interfaces() {
    const r = await run(["ip", "-j", "addr"], { timeoutMs, maxBytes: 1024 * 1024 });
    if (!r.ok) return { ok: false, error: "failed", message: r.stderr.trim() || "ip addr 失败" };
    let json = [];
    try {
      json = JSON.parse(r.stdout);
    } catch {
      return { ok: false, error: "failed", message: "ip addr 输出无法解析" };
    }
    const route = await run(["ip", "-j", "route", "show", "default"], { timeoutMs: 5000 });
    let def = null;
    if (route.ok) {
      try {
        def = parseDefaultRoute(JSON.parse(route.stdout));
      } catch {
        def = null;
      }
    }
    return { ok: true, interfaces: parseIpAddr(json), defaultRoute: def };
  }

  async function listeners(options = {}) {
    const asRoot = options.asRoot === true;
    const argv = ["ss", "-H", "-tulpn"];
    const r = asRoot ? await sudo.runRoot(argv, { timeoutMs, maxBytes: 1024 * 1024 }) : await run(argv, { timeoutMs, maxBytes: 1024 * 1024 });
    if (!r.ok) {
      if (!asRoot && r.error) return { ok: false, error: r.error, message: r.message };
      return { ok: false, error: "failed", message: (r.stderr ?? "").trim() || "ss 失败" };
    }
    const rows = parseListeners(r.stdout);
    rows.sort((a, b) => (a.localPort ?? 0) - (b.localPort ?? 0));
    return { ok: true, listeners: rows, privileged: asRoot };
  }

  async function connections(options = {}) {
    const asRoot = options.asRoot === true;
    const argv = ["ss", "-H", "-tn", "state", "established"];
    const r = asRoot ? await sudo.runRoot(argv, { timeoutMs, maxBytes: 1024 * 1024 }) : await run(argv, { timeoutMs, maxBytes: 1024 * 1024 });
    if (!r.ok) {
      if (!asRoot && r.error) return { ok: false, error: r.error, message: r.message };
      return { ok: false, error: "failed", message: (r.stderr ?? "").trim() || "ss 失败" };
    }
    const rows = parseListeners(r.stdout).filter((row) => row.state === "ESTAB");
    return { ok: true, total: rows.length, top: summarizeConnections(rows, 12), privileged: asRoot };
  }

  /** 防火墙：本机没装 nft/ufw 时如实报告不可用。 */
  async function firewall() {
    for (const candidate of FIREWALL_CANDIDATES) {
      const r = await run(candidate.argv, { timeoutMs: 5000, maxBytes: 256 * 1024 });
      if (r.spawnError && /ENOENT/.test(r.spawnError)) continue;
      if (!r.ok && !r.stdout) continue;
      return { ok: true, available: true, tool: candidate.label, output: String(r.stdout || r.stderr || "").trim().slice(0, 4000) };
    }
    return { ok: true, available: false, tool: null, message: "未安装 nftables 或 ufw，本机没有可读的防火墙规则" };
  }

  return { interfaces, listeners, connections, firewall };
}
