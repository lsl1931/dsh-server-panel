// dsh-server-panel Host 半：本机资源采样。
//
// 数据全部来自内核自己的接口，不用任何估算与外部命令：
//   /proc/stat     CPU jiffies（总量 + 逐核）与 procs_running
//   /proc/meminfo  内存/交换分区账目
//   /proc/net/dev  每网卡收发字节
//   /proc/mounts + statfsSync()  真实文件系统用量
//   /proc/loadavg /proc/uptime /etc/os-release
//
// 两条纪律（沿用本机已跑通的 dsh-resource-bar 的做法）：
//  1. 采样必须廉价：读 /proc 是微秒级，但百分比需要两次采样，所以后台按
//     pollMs 打点，路由只序列化缓存快照；请求进来时若缓存过期才补一次采样。
//  2. 任何一步失败都不能炸掉面板：字段降级为 null，而不是抛异常。
//
// 本文件不 import 任何 DSH 包，纯 Node + 纯函数，便于单测。

import { readFileSync, readdirSync, statfsSync } from "node:fs";
import { arch, cpus, hostname, release } from "node:os";

const toNumber = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

const clampPct = (n) => (Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : null);

const pctOf = (part, total) => {
  if (!Number.isFinite(part) || !Number.isFinite(total) || total <= 0) return null;
  return clampPct((part / total) * 100);
};

const round1 = (n) => (Number.isFinite(n) ? Math.round(n * 10) / 10 : null);

/** 读取一个 /proc（或 /etc）文本文件；失败返回 null，绝不抛。 */
function readTextSafe(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 纯解析
// ---------------------------------------------------------------------------

/**
 * 解析 /proc/stat：`cpu` 是总量行，`cpu0..cpuN` 是逐核行。
 * guest/guest_nice 已计入 user/nice，故不重复计入 total，否则虚拟机会报 >100%。
 * procs_running / procs_blocked 也在这里一并取出。
 * @param {string} text
 * @returns {{ aggregate: object|null, cores: object[], running: number|null, blocked: number|null }}
 */
export function parseProcStat(text) {
  const norm = (fields) => {
    if (!fields || fields.length < 4) return null;
    const [user, nice, system, idle, iowait = 0, irq = 0, softirq = 0, steal = 0] = fields;
    return {
      user,
      nice,
      system,
      idle,
      iowait,
      irq,
      softirq,
      steal,
      total: user + nice + system + idle + iowait + irq + softirq + steal,
      idleAll: idle + iowait,
    };
  };
  let aggregate = null;
  let running = null;
  let blocked = null;
  const cores = [];
  for (const line of String(text ?? "").split("\n")) {
    if (line.startsWith("procs_running")) {
      running = toNumber(line.split(/\s+/)[1]);
      continue;
    }
    if (line.startsWith("procs_blocked")) {
      blocked = toNumber(line.split(/\s+/)[1]);
      continue;
    }
    if (!line.startsWith("cpu")) continue;
    const parts = line.trim().split(/\s+/);
    const label = parts[0];
    const fields = parts.slice(1).map(toNumber);
    if (label === "cpu") {
      aggregate = norm(fields);
      continue;
    }
    if (!/^cpu\d+$/.test(label)) continue;
    const core = norm(fields);
    if (core) cores.push(core);
  }
  return { aggregate, cores, running, blocked };
}

/**
 * 两次 /proc/stat 快照之间的占用率。计数器单调递增，所以非正增量视为"暂无读数"
 * （null）而不是 0%，避免刚启动时显示假的 0% 或 100%。
 * @returns {{ busyPct:number|null, breakdown:object|null, cores:Array<{id:number,pct:number|null}>, totalDelta:number }}
 */
export function cpuPercents(prev, next) {
  if (!prev?.aggregate || !next?.aggregate) return { busyPct: null, breakdown: null, cores: [], totalDelta: 0 };
  const share = (a, b, key) => {
    const dt = b.total - a.total;
    if (dt <= 0) return null;
    return clampPct(((b[key] - a[key]) / dt) * 100);
  };
  const totalDelta = next.aggregate.total - prev.aggregate.total;
  let busyPct = null;
  let breakdown = null;
  if (totalDelta > 0) {
    const a = prev.aggregate;
    const b = next.aggregate;
    const di = b.idleAll - a.idleAll;
    busyPct = di >= 0 ? clampPct(((totalDelta - di) / totalDelta) * 100) : null;
    breakdown = {
      user: share(a, b, "user"),
      nice: share(a, b, "nice"),
      system: share(a, b, "system"),
      iowait: share(a, b, "iowait"),
      irq: (() => {
        const i = share(a, b, "irq");
        const s = share(a, b, "softirq");
        return i === null && s === null ? null : clampPct((i ?? 0) + (s ?? 0));
      })(),
      steal: share(a, b, "steal"),
      idle: share(a, b, "idle"),
    };
  }
  const cores = [];
  const n = Math.min(prev.cores.length, next.cores.length);
  for (let i = 0; i < n; i += 1) {
    const a = prev.cores[i];
    const b = next.cores[i];
    const dt = b.total - a.total;
    const di = b.idleAll - a.idleAll;
    cores.push({ id: i, pct: dt > 0 && di >= 0 ? clampPct(((dt - di) / dt) * 100) : null });
  }
  return { busyPct, breakdown, cores, totalDelta: Math.max(0, totalDelta) };
}

/**
 * 解析 /proc/meminfo，值统一换算成字节。
 * @param {string} text
 * @returns {Record<string, number>}
 */
export function parseMeminfo(text) {
  const out = {};
  for (const line of String(text ?? "").split("\n")) {
    const m = /^([A-Za-z_()0-9]+):\s+(\d+)(?:\s+kB)?\s*$/.exec(line.trim());
    if (!m) continue;
    out[m[1]] = toNumber(m[2]) * 1024;
  }
  return out;
}

/**
 * 内存快照。available 优先用 MemAvailable，缺失时退化到 free+buffers+cached。
 * @param {Record<string, number>} mi
 */
export function memoryFrom(mi) {
  const total = mi.MemTotal ?? null;
  const cached = (mi.Cached ?? 0) + (mi.SReclaimable ?? 0) - (mi.Shmem ?? 0);
  const available = mi.MemAvailable ?? (mi.MemFree !== undefined ? (mi.MemFree + (mi.Buffers ?? 0) + Math.max(0, cached)) : null);
  const used = total !== null && available !== null ? Math.max(0, total - available) : null;
  const swapTotal = mi.SwapTotal ?? null;
  const swapFree = mi.SwapFree ?? null;
  const swapUsed = swapTotal !== null && swapFree !== null ? Math.max(0, swapTotal - swapFree) : null;
  return {
    totalBytes: total,
    availableBytes: available,
    usedBytes: used,
    usedPct: used !== null ? pctOf(used, total) : null,
    cachedBytes: mi.Cached === undefined ? null : Math.max(0, cached),
    buffersBytes: mi.Buffers ?? null,
    swapTotalBytes: swapTotal,
    swapUsedBytes: swapUsed,
    swapUsedPct: swapUsed !== null ? pctOf(swapUsed, swapTotal) : null,
  };
}

/**
 * 解析 /proc/net/dev 的累计收发字节。lo 默认排除（噪音，且无意义）。
 * @param {string} text
 * @param {{ includeLoopback?: boolean }} [opts]
 */
export function parseNetDev(text, opts = {}) {
  const rows = [];
  for (const line of String(text ?? "").split("\n")) {
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const name = line.slice(0, idx).trim();
    if (!name || /^(Inter-|face|lo)$/.test(name)) continue;
    if (name === "lo" && !opts.includeLoopback) continue;
    const f = line.slice(idx + 1).trim().split(/\s+/).map(toNumber);
    if (f.length < 9) continue;
    rows.push({ name, rxBytes: f[0], rxPackets: f[1], txBytes: f[8], txPackets: f[9] ?? 0 });
  }
  return rows;
}

/** 两次网卡快照之间的速率（字节/秒）。计数器回绕或重启时该网卡速率记 0。 */
export function netRates(prev, next, dtMs) {
  const prevByName = new Map((prev ?? []).map((r) => [r.name, r]));
  const out = [];
  for (const row of next ?? []) {
    const before = prevByName.get(row.name);
    let rxBytesPerSec = 0;
    let txBytesPerSec = 0;
    if (before && dtMs > 0) {
      const drx = row.rxBytes - before.rxBytes;
      const dtx = row.txBytes - before.txBytes;
      rxBytesPerSec = drx >= 0 ? Math.round((drx * 1000) / dtMs) : 0;
      txBytesPerSec = dtx >= 0 ? Math.round((dtx * 1000) / dtMs) : 0;
    }
    out.push({
      name: row.name,
      rxBytesPerSec,
      txBytesPerSec,
      rxTotalBytes: row.rxBytes,
      txTotalBytes: row.txBytes,
    });
  }
  return out;
}

/** /proc/loadavg → [1min, 5min, 15min]，缺失为 null。 */
export function parseLoadavg(text) {
  const f = String(text ?? "").trim().split(/\s+/);
  if (f.length < 3) return [null, null, null];
  return [toNumber(f[0]), toNumber(f[1]), toNumber(f[2])];
}

/** /proc/uptime → 秒（整数）。 */
export function parseUptime(text) {
  const n = Number.parseFloat(String(text ?? "").trim().split(/\s+/)[0]);
  return Number.isFinite(n) ? Math.floor(n) : null;
}

/**
 * 解析 /proc/mounts，只保留真实块设备上的文件系统（排除 tmpfs/proc/sysfs 等）。
 * @param {string} text
 */
export function parseMounts(text) {
  const fstypes = new Set(["ext2", "ext3", "ext4", "xfs", "btrfs", "zfs", "f2fs", "vfat", "exfat", "ntfs", "ntfs3", "nfs", "nfs4", "cifs", "overlay", "fuseblk"]);
  const skipPrefix = ["/proc", "/sys", "/dev", "/run", "/snap"];
  const seen = new Set();
  const out = [];
  for (const line of String(text ?? "").split("\n")) {
    const p = line.trim().split(/\s+/);
    if (p.length < 3) continue;
    const [device, mount, fstype] = p;
    if (!fstypes.has(fstype)) continue;
    if (skipPrefix.some((prefix) => mount === prefix || mount.startsWith(prefix + "/"))) continue;
    const key = device + " " + mount;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ device, mount, fstype });
  }
  return out;
}

/** 解析 /etc/os-release 的 PRETTY_NAME。 */
export function parseOsRelease(text) {
  const m = /^PRETTY_NAME="?([^"\n]+)"?/m.exec(String(text ?? ""));
  return m ? m[1] : null;
}

/** 逐挂载点取用量（statfs）。used = total - free，可用按非特权用户的 bavail 计。 */
export function diskUsage(mounts, statfsImpl = statfsSync) {
  const out = [];
  for (const entry of mounts ?? []) {
    try {
      const s = statfsImpl(entry.mount);
      const total = s.blocks * s.bsize;
      const free = s.bfree * s.bsize;
      const available = s.bavail * s.bsize;
      const used = Math.max(0, total - free);
      out.push({
        mount: entry.mount,
        fs: entry.fstype,
        totalBytes: total,
        usedBytes: used,
        availableBytes: available,
        usedPct: pctOf(used, used + available),
      });
    } catch {
      // 挂载点刚消失/权限不足：跳过而不是让整张概览失败。
    }
  }
  return out;
}

/** 统计 /proc 下的进程数。 */
export function countProcesses(listDir = () => readdirSync("/proc")) {
  try {
    return listDir().filter((name) => /^\d+$/.test(name)).length;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 采样器
// ---------------------------------------------------------------------------

/**
 * 创建一个带缓存的采样器：后台定时打点保证 CPU 百分比与网卡速率有前后两帧，
 * 路由侧只读缓存；缓存过期时按需补采样。
 *
 * @param {{ pollMs?: number, staleMs?: number, procRoot?: string, statfsImpl?: Function, now?: () => number }} [options]
 */
export function createSampler(options = {}) {
  const pollMs = Number.isFinite(options.pollMs) ? Math.max(250, options.pollMs) : 2000;
  const staleMs = Number.isFinite(options.staleMs) ? Math.max(0, options.staleMs) : 1000;
  const procRoot = options.procRoot ?? "/proc";
  const statfsImpl = options.statfsImpl ?? statfsSync;
  const now = options.now ?? (() => Date.now());

  let latest = null;
  let prev = null;

  const read = (name) => readTextSafe(procRoot + "/" + name);

  function sample() {
    const at = now();
    const stat = parseProcStat(read("stat"));
    const meminfo = parseMeminfo(read("meminfo"));
    const net = parseNetDev(read("net/dev"));
    const cpuDelta = prev ? cpuPercents(prev.stat, stat) : { busyPct: null, breakdown: null, cores: [], totalDelta: 0 };
    const dtMs = prev ? at - prev.at : 0;
    const disks = diskUsage(parseMounts(read("mounts")), statfsImpl);
    const cpusInfo = cpus();
    const overview = {
      ok: true,
      ts: at,
      host: {
        hostname: hostname(),
        distro: parseOsRelease(readTextSafe("/etc/os-release")),
        kernel: release(),
        arch: arch(),
      },
      cpu: {
        count: cpusInfo.length || null,
        model: cpusInfo[0]?.model ?? null,
        busyPct: round1(cpuDelta.busyPct),
        breakdown: cpuDelta.breakdown
          ? {
              user: round1(cpuDelta.breakdown.user),
              nice: round1(cpuDelta.breakdown.nice),
              system: round1(cpuDelta.breakdown.system),
              iowait: round1(cpuDelta.breakdown.iowait),
              irq: round1(cpuDelta.breakdown.irq),
              steal: round1(cpuDelta.breakdown.steal),
              idle: round1(cpuDelta.breakdown.idle),
            }
          : null,
        cores: (cpuDelta.cores.length ? cpuDelta.cores : stat.cores.map((_, id) => ({ id, pct: null }))).map((c) => ({
          id: c.id,
          pct: round1(c.pct),
        })),
        load: parseLoadavg(read("loadavg")),
      },
      memory: memoryFrom(meminfo),
      disks,
      network: { interfaces: netRates(prev?.net, net, dtMs) },
      processes: { total: countProcesses(), running: stat.running },
      uptimeSec: parseUptime(read("uptime")),
    };
    prev = { stat, net, at };
    latest = overview;
    return overview;
  }

  return {
    pollMs,
    tick: sample,
    /** @param {{ force?: boolean }} [opts] */
    snapshot(opts = {}) {
      if (opts.force || latest === null || now() - latest.ts >= staleMs) sample();
      return latest;
    },
    latest: () => latest,
  };
}
