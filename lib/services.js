// systemd 封装：服务列表 / 动作 / journalctl 日志。
//
// 所有单元名先过正则白名单再进 argv；动作是枚举表，表外一律拒绝。
// 权限：systemctl list-* 与 status 查询不需要 root；start/stop/restart/reload/
// enable/disable 在这台机器上需要 root（polkit 会要求交互认证），所以走 sudo 通道。

import { run } from "./exec.js";
import { normalizeFailure } from "./sudo.js";

/**
 * 单元名白名单：以字母数字开头，只允许字母数字与 @ . _ : - ，必须以 .service 结尾。
 * 这样就排除了 `--now` 这类选项注入、以及路径/空白/分号/引号等一切 shell 与
 * systemd 解析层面的花样。
 */
const UNIT_RE = /^[A-Za-z0-9][A-Za-z0-9@._:-]{0,126}\.service$/;

/** 可执行的动作表（同时是字段白名单）。 */
export const ACTIONS = Object.freeze({
  start: "启动",
  stop: "停止",
  restart: "重启",
  reload: "重载",
  enable: "设为开机自启",
  disable: "取消开机自启",
});

export function isValidUnit(name) {
  return typeof name === "string" && UNIT_RE.test(name);
}

export function isValidAction(action) {
  return typeof action === "string" && Object.hasOwn(ACTIONS, action);
}

/** 解析 `systemctl list-units … --no-legend --plain` 的文本输出（旧版 systemd 兜底）。 */
export function parseUnitsPlain(text) {
  const rows = [];
  for (const line of String(text ?? "").split("\n")) {
    const m = /^(\S+\.service)\s+(\S+)\s+(\S+)\s+(\S+)\s*(.*)$/.exec(line.trim());
    if (!m) continue;
    rows.push({ unit: m[1], load: m[2], active: m[3], sub: m[4], description: m[5] || "" });
  }
  return rows;
}

/** 解析 `systemctl list-unit-files --type=service` 的文本输出 → Map<unit, enabled|null>。 */
export function parseUnitFileStates(text) {
  const map = new Map();
  for (const line of String(text ?? "").split("\n")) {
    const m = /^(\S+\.service)\s+(\S+)/.exec(line.trim());
    if (!m) continue;
    const state = m[2];
    const enabled = state === "enabled" || state === "enabled-runtime" ? true : state === "disabled" || state === "masked" ? false : null;
    map.set(m[1], enabled);
  }
  return map;
}

const LIST_UNITS_ARGS = ["systemctl", "list-units", "--type=service", "--all", "--no-pager"];

/**
 * 服务列表。优先用 systemd 的 JSON 输出（systemd ≥ 246），失败退回文本解析。
 * @returns {Promise<{ ok:boolean, units:Array, privileged:boolean, error?:string, message?:string }>}
 */
export async function listUnits(options = {}) {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const filter = typeof options.filter === "string" ? options.filter.trim().toLowerCase() : "";

  let rows = null;
  const json = await run([...LIST_UNITS_ARGS, "--output=json"], { timeoutMs });
  if (json.ok) {
    try {
      const parsed = JSON.parse(json.stdout);
      if (Array.isArray(parsed)) rows = parsed;
    } catch {
      rows = null;
    }
  }
  if (rows === null) {
    const plain = await run([...LIST_UNITS_ARGS, "--no-legend", "--plain"], { timeoutMs });
    if (!plain.ok && !plain.stdout) {
      return { ok: false, error: "failed", message: normalizeFailure(plain || json) };
    }
    rows = parseUnitsPlain(plain.stdout);
  }

  const files = await run(["systemctl", "list-unit-files", "--type=service", "--no-pager", "--no-legend"], { timeoutMs });
  const enabledMap = files.ok ? parseUnitFileStates(files.stdout) : new Map();

  const units = rows
    .filter((row) => typeof row?.unit === "string")
    .map((row) => ({
      unit: row.unit,
      load: row.load ?? null,
      active: row.active ?? null,
      sub: row.sub ?? null,
      description: row.description ?? "",
      enabled: enabledMap.has(row.unit) ? enabledMap.get(row.unit) : null,
    }))
    .filter((row) => {
      if (!filter) return true;
      return row.unit.toLowerCase().includes(filter) || String(row.description).toLowerCase().includes(filter);
    })
    .sort((a, b) => a.unit.localeCompare(b.unit));

  return { ok: true, units, privileged: false };
}

/** 读单个单元的 ActiveState/SubState（不需要 root）。 */
export async function unitStatus(unit, options = {}) {
  const r = await run(["systemctl", "show", unit, "-p", "ActiveState,SubState"], { timeoutMs: options.timeoutMs ?? 5000 });
  const out = { active: null, sub: null };
  if (!r.ok) return out;
  for (const line of r.stdout.split("\n")) {
    const [k, v] = line.split("=");
    if (k === "ActiveState") out.active = v ?? null;
    if (k === "SubState") out.sub = v ?? null;
  }
  return out;
}

/**
 * 执行服务动作。`sudoSession` 必须是 createSudoSession() 的实例。
 * 未解锁且时间戳不热时返回 { ok:false, error:'locked' }。
 */
export async function runServiceAction(unit, action, sudoSession, options = {}) {
  const r = await sudoSession.runRoot(["systemctl", action, unit]);
  if (!r.ok) return { ok: false, error: r.error ?? "failed", message: r.message ?? "操作失败" };
  const status = await unitStatus(unit, options);
  return {
    ok: true,
    unit,
    action,
    active: status.active,
    sub: status.sub,
    output: tail(String(r.stdout || r.stderr || "").trim(), 4000),
  };
}

/**
 * journalctl 日志。已解锁（或时间戳热）时走 sudo 拿全量；否则退回本用户可见范围，
 * 用 `privileged:false` 让界面提示"解锁后可看完整日志"。
 */
export async function unitLogs(unit, lines, sudoSession, options = {}) {
  const n = Math.min(2000, Math.max(1, Number.isFinite(lines) ? Math.floor(lines) : 200));
  const timeoutMs = options.timeoutMs ?? 10_000;
  const args = ["journalctl", "-q", "-u", unit, "-n", String(n), "--no-pager", "-o", "short-iso"];
  if (sudoSession.isHolding() || (await sudoSession.timestampHot())) {
    const r = await sudoSession.runRoot(args);
    if (r.ok) {
      return { ok: true, unit, lines: splitLines(r.stdout), privileged: true, truncated: Boolean(r.truncated) };
    }
  }
  const r = await run(args, { timeoutMs });
  if (!r.ok && !r.stdout) return { ok: false, error: "failed", message: normalizeFailure(r) };
  return { ok: true, unit, lines: splitLines(r.stdout), privileged: false, truncated: Boolean(r.truncated) };
}

function splitLines(text) {
  return String(text ?? "")
    .split("\n")
    .map((l) => l.replace(/\r$/, ""))
    .filter((l) => l.length > 0);
}

function tail(text, max) {
  return text.length <= max ? text : "…" + text.slice(text.length - max);
}
