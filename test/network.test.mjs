import { createNetworkService, parseDefaultRoute, parseIpAddr, parseListeners, parseSsLine, summarizeConnections } from "../src/network.js";
import { eq, ok, summary, test, testAsync } from "./harness.mjs";

console.log("network(网络)");

const SS_LISTEN = [
  'tcp   LISTEN 0      511          127.0.0.1:3080       0.0.0.0:*    users:(("MainThread",pid=6759,fd=21))',
  'tcp   LISTEN 0      128            0.0.0.0:22         0.0.0.0:*    users:(("sshd",pid=700,fd=3))',
  "udp   UNCONN 0      0              0.0.0.0:68         0.0.0.0:*    users:((\"dhclient\",pid=812,fd=6))",
  'udp   UNCONN 0      0                 [::]:5353          [::]:*',
].join("\n");

test("parseSsLine 拆出协议/监听地址/进程", () => {
  const row = parseSsLine(SS_LISTEN.split("\n")[0]);
  eq(row.proto, "tcp");
  eq(row.state, "LISTEN");
  eq(row.localHost, "127.0.0.1");
  eq(row.localPort, 3080);
  eq(row.process, "MainThread");
  eq(row.pid, 6759);
});

test("parseSsLine 处理没有进程信息与 IPv6 地址", () => {
  const row = parseSsLine('udp   UNCONN 0      0                 [::]:5353          [::]:*');
  eq(row.localHost, "[::]");
  eq(row.localPort, 5353);
  eq(row.process, null);
  eq(parseSsLine("垃圾行"), null);
});

test("parseListeners 跳空行", () => {
  eq(parseListeners(SS_LISTEN).length, 4);
  eq(parseListeners("").length, 0);
});

test("summarizeConnections 按对端聚合、按数量排序", () => {
  const rows = [
    { peerHost: "198.51.100.20", peerPort: 5001 },
    { peerHost: "198.51.100.20", peerPort: 5002 },
    { peerHost: "[2001:db8::1]", peerPort: 443 },
  ];
  const top = summarizeConnections(rows, 5);
  eq(top[0].host, "198.51.100.20");
  eq(top[0].count, 2);
  eq(top[0].ports, [5001, 5002]);
  eq(top[1].host, "2001:db8::1", "IPv6 方括号要去掉");
  eq(summarizeConnections([], 5), []);
});

test("parseIpAddr / parseDefaultRoute 只取关心的字段", () => {
  const json = [
    {
      ifname: "enp7s0",
      operstate: "UP",
      address: "aa:bb:cc:dd:ee:ff",
      mtu: 1500,
      addr_info: [
        { family: "inet", local: "203.0.113.10", prefixlen: 24, scope: "global" },
        { family: "inet6", local: "fe80::1", prefixlen: 64, scope: "link" },
      ],
    },
  ];
  const rows = parseIpAddr(json);
  eq(rows.length, 1);
  eq(rows[0].name, "enp7s0");
  eq(rows[0].addresses.length, 2);
  eq(rows[0].addresses[0].local, "203.0.113.10");
  eq(parseIpAddr(null), []);
  eq(parseDefaultRoute([{ gateway: "203.0.113.1", dev: "enp7s0", metric: 100 }]), { gateway: "203.0.113.1", device: "enp7s0", metric: 100 });
  eq(parseDefaultRoute([]), null);
});

await testAsync("listeners：非 root 也能列，privileged 标记如实", async () => {
  const run = async () => ({ ok: true, stdout: SS_LISTEN, stderr: "" });
  const svc = createNetworkService({ run, sudo: { runRoot: async () => ({ ok: false, error: "locked" }) } });
  const r = await svc.listeners({ asRoot: false });
  ok(r.ok);
  eq(r.listeners.length, 4);
  eq(r.privileged, false);
  eq(r.listeners[0].localPort, 22, "按端口升序");
});

await testAsync("listeners：root 时走 sudo", async () => {
  const calls = [];
  const sudo = {
    runRoot: async (argv) => {
      calls.push(argv);
      return { ok: true, stdout: SS_LISTEN, stderr: "" };
    },
  };
  const svc = createNetworkService({ run: async () => ({ ok: true, stdout: "", stderr: "" }), sudo });
  const r = await svc.listeners({ asRoot: true });
  ok(r.ok);
  eq(r.privileged, true);
  eq(calls[0].slice(0, 3).join(" "), "ss -H -tulpn");
});

await testAsync("firewall：没装 nft/ufw 时如实说不可用", async () => {
  const run = async () => ({ ok: false, spawnError: "spawn nft ENOENT", stdout: "", stderr: "" });
  const svc = createNetworkService({ run, sudo: { runRoot: async () => ({ ok: false }) } });
  const r = await svc.firewall();
  ok(r.ok);
  eq(r.available, false);
  ok(r.message.includes("未安装"));
});

await testAsync("firewall：装了 ufw 就返回规则文本", async () => {
  const run = async (argv) => (argv[0] === "nft" ? { ok: false, spawnError: "spawn nft ENOENT", stdout: "", stderr: "" } : { ok: true, stdout: "Status: inactive\n", stderr: "" });
  const svc = createNetworkService({ run, sudo: { runRoot: async () => ({ ok: false }) } });
  const r = await svc.firewall();
  eq(r.available, true);
  eq(r.tool, "ufw");
  ok(r.output.includes("inactive"));
});

await testAsync("connections：取 ESTAB 行并聚合", async () => {
  const text = [
    "tcp ESTAB 0 0 203.0.113.10:22 198.51.100.20:51234",
    "tcp ESTAB 0 0 203.0.113.10:22 198.51.100.20:51235",
    "tcp ESTAB 0 0 203.0.113.10:3080 127.0.0.1:40000",
    "tcp LISTEN 0 511 127.0.0.1:3080 0.0.0.0:*",
  ].join("\n");
  const svc = createNetworkService({ run: async () => ({ ok: true, stdout: text, stderr: "" }), sudo: { runRoot: async () => ({ ok: false }) } });
  const r = await svc.connections({});
  ok(r.ok);
  eq(r.total, 3, "LISTEN 不算连接");
  eq(r.top[0].host, "198.51.100.20");
  eq(r.top[0].count, 2);
});

summary();
