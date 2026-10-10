// 软件包模块：apt 的可升级列表、索引刷新、单包/整体升级、已安装查询。
//
// 只读部分（模拟升级、dpkg 查询）不需要 root；写操作（apt-get update / upgrade）
// 走 sudo 通道，未解锁时统一返回 `locked`，由界面弹解锁框后重试。
//
// 模拟升级而不是 `apt list --upgradable`：前者的输出带 current → candidate，
// 信息更全，且 LANG=C 下格式稳定。

import { statSync } from "node:fs";

const INST_RE = /^Inst\s+(\S+)\s+\[([^\]]+)\]\s+\(([^ )]+)/;
const SUMMARY_RE = /^(\d+)\s+upgraded,\s+(\d+)\s+newly installed,\s+(\d+)\s+to remove and\s+(\d+)\s+not upgraded/;
const PKG_RE = /^[a-z0-9][a-z0-9+.-]*(?::[a-z0-9-]+)?$/;

/** 解析 `apt-get -s upgrade` 的输出（纯函数，便于单测）。 */
export function parseUpgradeSimulation(text) {
  const packages = [];
  let summary = null;
  for (const line of String(text ?? "").split("\n")) {
    const inst = INST_RE.exec(line.trim());
    if (inst) {
      packages.push({ name: inst[1], current: inst[2], candidate: inst[3] });
      continue;
    }
    const sum = SUMMARY_RE.exec(line.trim());
    if (sum) {
      summary = {
        upgraded: Number(sum[1]),
        newlyInstalled: Number(sum[2]),
        toRemove: Number(sum[3]),
        notUpgraded: Number(sum[4]),
      };
    }
  }
  return { packages, summary };
}

/** 解析 `dpkg-query -W` 的输出（纯函数）。 */
export function parseDpkgQuery(text) {
  const rows = [];
  for (const line of String(text ?? "").split("\n")) {
    if (!line.trim()) continue;
    const [name, version, status, summary] = line.split("\t");
    if (!name) continue;
    if (status && !status.startsWith("install ok installed")) continue;
    rows.push({ name, version: version ?? "", status: status ?? "", summary: summary ?? "" });
  }
  return rows;
}

function isValidPackageName(name) {
  return typeof name === "string" && name.length <= 128 && PKG_RE.test(name) && !name.startsWith("-");
}

/**
 * @param {{ sudo: { runRoot: Function }, timeoutMs?: number, run?: Function }} deps
 */
export function createPackageService(deps) {
  const sudo = deps.sudo;
  const run = deps.run;
  const timeoutMs = deps.timeoutMs ?? 10_000;
  const LONG_MS = 180_000;

  async function upgradable() {
    const r = await run(["apt-get", "-s", "upgrade"], { timeoutMs: Math.max(timeoutMs, 30_000), maxBytes: 2 * 1024 * 1024 });
    if (!r.ok && !r.stdout) {
      return { ok: false, error: "failed", message: r.stderr.trim() || "apt 模拟升级失败" };
    }
    const { packages, summary } = parseUpgradeSimulation(r.stdout);
    let indexUpdatedAt = null;
    try {
      indexUpdatedAt = statSync("/var/lib/apt/lists").mtimeMs;
    } catch {
      indexUpdatedAt = null;
    }
    return { ok: true, packages, summary, indexUpdatedAt, privileged: false };
  }

  async function installed(options = {}) {
    const filter = typeof options.filter === "string" ? options.filter.trim().toLowerCase() : "";
    const limit = Number.isFinite(options.limit) ? Math.min(2000, Math.max(1, options.limit)) : 300;
    const r = await run(["dpkg-query", "-W", "-f", "${Package}\t${Version}\t${Status}\t${binary:Summary}\n"], {
      timeoutMs: Math.max(timeoutMs, 30_000),
      maxBytes: 4 * 1024 * 1024,
    });
    if (!r.ok && !r.stdout) return { ok: false, error: "failed", message: r.stderr.trim() || "dpkg-query 失败" };
    let rows = parseDpkgQuery(r.stdout);
    const total = rows.length;
    if (filter) rows = rows.filter((row) => row.name.toLowerCase().includes(filter) || row.summary.toLowerCase().includes(filter));
    const truncated = rows.length > limit;
    return { ok: true, total, truncated, packages: rows.slice(0, limit) };
  }

  async function updateIndex() {
    const r = await sudo.runRoot(["apt-get", "update"], { timeoutMs: LONG_MS, maxBytes: 1024 * 1024 });
    if (!r.ok) return { ok: false, error: r.error ?? "failed", message: r.message ?? r.stderr?.trim() ?? "apt-get update 失败" };
    return { ok: true, output: String(r.stdout ?? "").trim().split("\n").slice(-12).join("\n") };
  }

  async function upgrade(options = {}) {
    const all = options.all === true;
    const names = Array.isArray(options.names) ? options.names : [];
    if (!all && names.length === 0) return { ok: false, error: "bad_request", message: "需要 names 或 all:true" };
    if (names.length > 200) return { ok: false, error: "bad_request", message: "一次最多升级 200 个包" };
    for (const name of names) {
      if (!isValidPackageName(name)) return { ok: false, error: "bad_request", message: `包名非法：${name}` };
    }
    const argv = all
      ? ["apt-get", "-y", "upgrade"]
      : ["apt-get", "-y", "--only-upgrade", "install", ...names];
    const r = await sudo.runRoot(argv, { timeoutMs: LONG_MS, maxBytes: 2 * 1024 * 1024 });
    if (!r.ok) return { ok: false, error: r.error ?? "failed", message: r.message ?? r.stderr?.trim() ?? "升级失败" };
    return { ok: true, all, names, output: String(r.stdout ?? "").trim().split("\n").slice(-25).join("\n") };
  }

  return { upgradable, installed, updateIndex, upgrade };
}
