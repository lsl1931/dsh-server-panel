import { createPackageService, parseDpkgQuery, parseUpgradeSimulation } from "../src/packages.js";
import { eq, ok, summary, test, testAsync } from "./harness.mjs";

console.log("packages(软件包)");

const SIM = [
  "Reading package lists...",
  "Building dependency tree...",
  "Reading state information...",
  "Calculating upgrade...",
  "The following packages will be upgraded:",
  "  libssl3 openssh-server",
  "2 upgraded, 0 newly installed, 0 to remove and 1 not upgraded.",
  "Inst libssl3 [3.0.11-1] (3.0.12-1 Debian-Security:13/stable-security [amd64])",
  "Inst openssh-server [1:9.2p1-2] (1:9.2p1-3 Debian:13/stable [amd64])",
].join("\n");

test("parseUpgradeSimulation 取出 current → candidate 与汇总", () => {
  const { packages, summary } = parseUpgradeSimulation(SIM);
  eq(packages.length, 2);
  eq(packages[0], { name: "libssl3", current: "3.0.11-1", candidate: "3.0.12-1" });
  eq(packages[1].name, "openssh-server");
  eq(summary, { upgraded: 2, newlyInstalled: 0, toRemove: 0, notUpgraded: 1 });
});

test("parseUpgradeSimulation 对空输出安全", () => {
  const { packages, summary } = parseUpgradeSimulation("");
  eq(packages, []);
  eq(summary, null);
});

test("parseDpkgQuery 只留已安装的包", () => {
  const text = [
    "bash\t5.2.15-2\tinstall ok installed\tGNU Bourne Again SHell",
    "foo\t1.0\tdeinstall ok config-files\tShould be skipped",
    "bar\t2.0\tinstall ok installed\tBar",
  ].join("\n");
  const rows = parseDpkgQuery(text);
  eq(rows.length, 2);
  eq(rows[0].name, "bash");
  eq(rows[1].summary, "Bar");
});

await testAsync("upgradable(): 走 apt 模拟，不碰 root", async () => {
  const calls = [];
  const run = async (argv, options) => {
    calls.push({ argv, options });
    return { ok: true, stdout: SIM, stderr: "", code: 0 };
  };
  const svc = createPackageService({ sudo: { runRoot: async () => ({ ok: false, error: "locked" }) }, run });
  const r = await svc.upgradable();
  ok(r.ok);
  eq(r.packages.length, 2);
  eq(r.summary.upgraded, 2);
  ok(calls[0].argv.includes("-s"), "必须用模拟模式，不能真的升级");
  ok(Number.isFinite(r.indexUpdatedAt) || r.indexUpdatedAt === null);
});

await testAsync("installed(): 过滤 + 截断标记", async () => {
  const run = async () => ({
    ok: true,
    stdout: "bash\t5.2\tinstall ok installed\tShell\ncoreutils\t9.1\tinstall ok installed\tCore\n",
    stderr: "",
  });
  const svc = createPackageService({ sudo: { runRoot: async () => ({ ok: false }) }, run });
  const all = await svc.installed({});
  eq(all.total, 2);
  const filtered = await svc.installed({ filter: "bash" });
  eq(filtered.packages.length, 1);
  eq(filtered.packages[0].name, "bash");
  const limited = await svc.installed({ limit: 1 });
  eq(limited.truncated, true);
});

await testAsync("upgrade(): 只走 sudo，且包名与数量都校验", async () => {
  const calls = [];
  const sudo = {
    runRoot: async (argv, options) => {
      calls.push({ argv, options });
      return { ok: true, stdout: "0 upgraded, 0 newly installed", stderr: "" };
    },
  };
  const svc = createPackageService({ sudo, run: async () => ({ ok: true, stdout: "", stderr: "" }) });
  eq((await svc.upgrade({})).error, "bad_request");
  eq((await svc.upgrade({ names: ["bash; rm -rf /"] })).error, "bad_request");
  eq((await svc.upgrade({ names: ["-y"] })).error, "bad_request");
  eq((await svc.upgrade({ names: new Array(201).fill("bash") })).error, "bad_request");
  const single = await svc.upgrade({ names: ["bash", "curl:amd64"] });
  ok(single.ok, JSON.stringify(single));
  eq(calls[0].argv[0], "apt-get");
  ok(calls[0].argv.includes("--only-upgrade"));
  ok(calls[0].argv.includes("bash"));
  const all = await svc.upgrade({ all: true });
  ok(all.ok);
  ok(!calls[1].argv.includes("--only-upgrade"), "全部升级走 apt-get upgrade");
});

summary();
