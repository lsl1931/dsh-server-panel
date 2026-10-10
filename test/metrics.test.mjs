import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cpuPercents,
  createSampler,
  diskUsage,
  memoryFrom,
  netRates,
  parseLoadavg,
  parseMeminfo,
  parseMounts,
  parseNetDev,
  parseOsRelease,
  parseProcStat,
  parseUptime,
} from "../src/metrics.js";
import { close, eq, ok, summary, test } from "./harness.mjs";

console.log("metrics");

test("parseProcStat 分开总量与逐核，并读到 procs_running", () => {
  const text = [
    "cpu  100 20 30 400 5 6 7 8 0 0",
    "cpu0 50 10 15 200 2 3 3 4 0 0",
    "cpu1 50 10 15 200 3 3 4 4 0 0",
    "procs_running 2",
    "procs_blocked 0",
    "intr 12345",
  ].join("\n");
  const parsed = parseProcStat(text);
  eq(parsed.aggregate.total, 100 + 20 + 30 + 400 + 5 + 6 + 7 + 8, "total 不含 guest");
  eq(parsed.cores.length, 2);
  eq(parsed.running, 2);
  eq(parsed.blocked, 0);
});

test("parseProcStat 忽略 cpu_foo 之类非核心行", () => {
  const parsed = parseProcStat("cpu 1 1 1 1 0 0 0 0\ncpu_foo 1 1 1 1\ncpu3 2 2 2 2 0 0 0 0\n");
  eq(parsed.cores.length, 1);
  eq(parsed.cores[0].total, 8);
});

test("cpuPercents：50% 占用被算成 50%", () => {
  const prev = parseProcStat("cpu 0 0 0 100 0 0 0 0 0 0\ncpu0 0 0 0 50 0 0 0 0\ncpu1 0 0 0 50 0 0 0 0\n");
  const next = parseProcStat("cpu 50 0 0 150 0 0 0 0 0 0\ncpu0 50 0 0 50 0 0 0 0\ncpu1 0 0 0 100 0 0 0 0\n");
  const delta = cpuPercents(prev, next);
  close(delta.busyPct, 50, 0.01, "总占用");
  eq(delta.cores.length, 2);
  close(delta.cores[0].pct, 100, 0.01, "cpu0");
  close(delta.cores[1].pct, 0, 0.01, "cpu1");
  close(delta.breakdown.user, 50, 0.01, "user 占比");
});

test("cpuPercents：计数器回绕/无增量时返回 null 而不是假 0%", () => {
  const same = parseProcStat("cpu 1 1 1 1 0 0 0 0\n");
  eq(cpuPercents(same, same).busyPct, null);
  eq(cpuPercents(null, same).cores, []);
});

test("parseMeminfo 把 kB 换成字节", () => {
  const mi = parseMeminfo("MemTotal:        4000000 kB\nMemAvailable:    3000000 kB\nSwapTotal:       2000000 kB\nSwapFree:        1999000 kB\n");
  eq(mi.MemTotal, 4000000 * 1024);
  const mem = memoryFrom(mi);
  eq(mem.usedBytes, (4000000 - 3000000) * 1024);
  close(mem.usedPct, 25, 0.01);
  eq(mem.swapUsedBytes, 1000 * 1024);
});

test("parseNetDev 排除 lo / 表头行", () => {
  const text = [
    "Inter-|   Receive                                                |  Transmit",
    " face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed",
    "    lo: 1000     10    0    0    0     0          0         0     1000      10    0    0    0     0       0          0",
    "enp7s0: 5000    50    0    0    0     0          0         0     2000      20    0    0    0     0       0          0",
  ].join("\n");
  const rows = parseNetDev(text);
  eq(rows.length, 1);
  eq(rows[0].name, "enp7s0");
  eq(rows[0].rxBytes, 5000);
  eq(rows[0].txBytes, 2000);
});

test("netRates 按时间差折算速率，回绕记 0", () => {
  const prev = [{ name: "eth0", rxBytes: 1000, txBytes: 1000 }];
  const next = [{ name: "eth0", rxBytes: 3000, txBytes: 1000 }];
  const rates = netRates(prev, next, 1000);
  eq(rates[0].rxBytesPerSec, 2000);
  eq(rates[0].txBytesPerSec, 0);
  eq(netRates(prev, [{ name: "eth0", rxBytes: 500, txBytes: 1 }], 1000)[0].rxBytesPerSec, 0);
});

test("parseMounts 只留真实文件系统并去掉伪挂载", () => {
  const text = [
    "/dev/sdb1 / ext4 rw,relatime 0 0",
    "tmpfs /run tmpfs rw 0 0",
    "proc /proc proc rw 0 0",
    "/dev/sda1 /mnt/data xfs rw 0 0",
  ].join("\n");
  const mounts = parseMounts(text);
  eq(mounts.length, 2);
  eq(mounts[0].mount, "/");
  eq(mounts[1].fstype, "xfs");
});

test("diskUsage 用 statfs 算用量，挂载点报错则跳过", () => {
  const statfs = (mount) => {
    if (mount === "/bad") throw new Error("ENOENT");
    return { bsize: 4096, blocks: 1000, bfree: 400, bavail: 300 };
  };
  const rows = diskUsage([{ mount: "/", fstype: "ext4" }, { mount: "/bad", fstype: "xfs" }], statfs);
  eq(rows.length, 1);
  eq(rows[0].totalBytes, 4096 * 1000);
  eq(rows[0].usedBytes, 4096 * 600);
  close(rows[0].usedPct, (600 / 900) * 100, 0.01);
});

test("parseLoadavg / parseUptime / parseOsRelease 降级安全", () => {
  eq(parseLoadavg("0.52 0.41 0.33 1/210 12345"), [0.52, 0.41, 0.33]);
  eq(parseLoadavg("坏数据"), [null, null, null]);
  eq(parseUptime("12345.67 98765.43"), 12345);
  eq(parseUptime(""), null);
  eq(parseOsRelease('PRETTY_NAME="Debian GNU/Linux 13 (trixie)"\n'), "Debian GNU/Linux 13 (trixie)");
  eq(parseOsRelease(""), null);
});

test("createSampler：首帧无百分比，第二帧给出 CPU% 与网卡速率", () => {
  const dir = mkdtempSync(join(tmpdir(), "dsp-metrics-"));
  try {
    const write = (name, text) => {
      mkdirSync(join(dir, name, ".."), { recursive: true });
      writeFileSync(join(dir, name), text);
    };
    write("stat", "cpu 0 0 0 100 0 0 0 0\ncpu0 0 0 0 100 0 0 0 0\nprocs_running 1\n");
    write("meminfo", "MemTotal: 1000000 kB\nMemAvailable: 500000 kB\n");
    write("net/dev", "enp7s0: 1000 1 0 0 0 0 0 0 500 1 0 0 0 0 0 0\n");
    write("loadavg", "0.10 0.20 0.30 1/100 999\n");
    write("uptime", "100.5 200.0\n");
    write("mounts", "/dev/sdb1 / ext4 rw 0 0\n");
    let clock = 1000;
    const sampler = createSampler({ procRoot: dir, statfsImpl: () => ({ bsize: 4096, blocks: 100, bfree: 50, bavail: 40 }), now: () => clock });
    const first = sampler.tick();
    ok(first.ok, "ok 字段");
    eq(first.cpu.busyPct, null, "首帧没有百分比");
    eq(first.memory.usedBytes, 500000 * 1024);
    eq(first.disks.length, 1);
    eq(first.network.interfaces[0].rxBytesPerSec, 0, "首帧速率为 0");
    eq(first.uptimeSec, 100);
    // 第二帧：CPU 跑了 50 jiffies，网卡多了 3000 字节
    write("stat", "cpu 50 0 0 150 0 0 0 0\ncpu0 50 0 0 150 0 0 0 0\nprocs_running 1\n");
    write("net/dev", "enp7s0: 4000 1 0 0 0 0 0 0 2500 1 0 0 0 0 0 0\n");
    clock += 1000;
    const second = sampler.tick();
    close(second.cpu.busyPct, 50, 0.01, "总占用");
    eq(second.network.interfaces[0].rxBytesPerSec, 3000);
    eq(second.network.interfaces[0].txBytesPerSec, 2000);
    // 缓存过期才补采样：同毫秒内 snapshot() 不应再打点
    const cached = sampler.snapshot();
    eq(cached.ts, second.ts, "未过期时应返回缓存");
    const forced = sampler.snapshot({ force: true });
    ok(forced.ts >= second.ts);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

summary();
