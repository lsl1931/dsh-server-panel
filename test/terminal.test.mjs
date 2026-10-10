import { PassThrough } from "node:stream";
import { createTerminalService } from "../src/terminal.js";
import { eq, ok, summary, testAsync } from "./harness.mjs";

console.log("terminal(PTY 会话)");

/** 假的 spawnTerminal：返回可控句柄，并记录被写入的输入与尺寸。 */
function makeFakeSubprocess() {
  const spawned = [];
  const subprocess = {
    async spawnTerminal(spec) {
      const output = new PassThrough();
      const record = {
        spec,
        output,
        writes: [],
        resizes: [],
        terminated: false,
      };
      spawned.push(record);
      return {
        pid: 4000 + spawned.length,
        output,
        done: new Promise((resolve) => {
          record.resolve = resolve;
        }),
        async write(data) {
          record.writes.push(data);
        },
        async resize(cols, rows) {
          record.resizes.push([cols, rows]);
        },
        async inspectForeground() {
          return undefined;
        },
        async inspectActivity() {
          return { state: "unknown", revision: 1 };
        },
        async signalForeground() {
          return 0;
        },
        async terminate() {
          record.terminated = true;
          record.resolve?.({ exitCode: 0, signal: null });
        },
      };
    },
  };
  return { subprocess, spawned };
}

function makePeer() {
  const sent = [];
  return {
    sent,
    closed: false,
    sendJson(value) {
      sent.push(value);
    },
    close() {
      this.closed = true;
    },
  };
}

function makeService(overrides = {}) {
  const { subprocess, spawned } = makeFakeSubprocess();
  let unlocked = overrides.unlocked ?? true;
  const sudo = { state: async () => ({ unlocked }) };
  const service = createTerminalService({ subprocess, sudo, maxSessions: overrides.maxSessions ?? 2, graceMs: 1000 });
  return { service, spawned, setUnlocked: (v) => { unlocked = v; } };
}

await testAsync("创建会话：普通 shell 用 -l 登录 shell，尺寸被夹在合理范围", async () => {
  const { service, spawned } = makeService();
  const created = await service.create({ cols: 120, rows: 40, shell: "user" });
  ok(created.ok, JSON.stringify(created));
  eq(created.shell, "user");
  eq(spawned[0].spec.argv, ["/bin/bash", "-l"]);
  eq(spawned[0].spec.cols, 120);
  eq(spawned[0].spec.rows, 40);
  eq(spawned[0].spec.terminalType, "xterm-256color");
  ok(spawned[0].spec.env.PATH.includes("/usr/bin"), "要带上 PATH");
  eq(service.count(), 1);
  service.disposeAll();
});

await testAsync("创建会话：已解锁时 root 走 sudo -n -i（免密）", async () => {
  const { service, spawned } = makeService({ unlocked: true });
  const created = await service.create({ shell: "root" });
  eq(created.shell, "root");
  eq(spawned[0].spec.argv, ["sudo", "-n", "-i"]);
  service.disposeAll();
});

await testAsync("创建会话：未解锁时 root 走 sudo -i（让 sudo 在终端里问密码）", async () => {
  const { service, spawned } = makeService({ unlocked: false });
  await service.create({ shell: "root" });
  eq(spawned[0].spec.argv, ["sudo", "-i"]);
  service.disposeAll();
});

await testAsync("输出广播 + 回放缓冲：新连接的 peer 先收到 ready 与历史", async () => {
  const { service, spawned } = makeService();
  await service.create({ shell: "user" });
  const session = service.get(service.count() && [...Array(1)].length ? "t1" : "t1");
  const first = makePeer();
  service.attach(session, first);
  eq(first.sent[0].t, "ready");
  eq(first.sent[0].pid, 4001);

  spawned[0].output.write("hello from pty\n");
  await new Promise((resolve) => setTimeout(resolve, 10));
  ok(first.sent.some((m) => m.t === "output" && m.d.includes("hello from pty")), "实时广播");

  const second = makePeer();
  service.attach(session, second);
  eq(second.sent[0].t, "ready");
  ok(second.sent.some((m) => m.t === "output" && m.d.includes("hello from pty")), "回放历史给新连接");
  service.disposeAll();
});

await testAsync("输入与 resize 透传到句柄；输入有硬上限", async () => {
  const { service, spawned } = makeService();
  await service.create({ cols: 80, rows: 24 });
  const session = service.get("t1");
  await service.write(session, "ls -la\r");
  eq(spawned[0].writes, ["ls -la\r"]);
  await service.write(session, "x".repeat(100 * 1024));
  eq(spawned[0].writes[1].length, 64 * 1024, "超长输入被截到 64 KiB");
  await service.resize(session, 100, 30);
  eq(spawned[0].resizes, [[100, 30]]);
  await service.resize(session, 1, 1);
  eq(spawned[0].resizes.length, 2, "越界尺寸也会夹取而不是丢弃");
  eq(spawned[0].resizes[1], [20, 5]);
  service.disposeAll();
});

await testAsync("并发上限：超出 maxSessions 拒绝，释放后可再建", async () => {
  const { service } = makeService({ maxSessions: 1 });
  ok((await service.create({})).ok);
  const second = await service.create({});
  eq(second.ok, false);
  ok(second.message.includes("最多"));
  const session = service.get("t1");
  await service.kill(session);
  ok((await service.create({})).ok, "结束旧会话后应当能新建");
  service.disposeAll();
});

await testAsync("进程退出：广播 exit 并从会话表移除", async () => {
  const { service, spawned } = makeService();
  await service.create({});
  const peer = makePeer();
  service.attach(service.get("t1"), peer);
  spawned[0].resolve({ exitCode: 137, signal: null });
  await new Promise((resolve) => setTimeout(resolve, 10));
  ok(peer.sent.some((m) => m.t === "exit" && m.code === 137), "要通知前端 exit");
  eq(service.count(), 0, "会话表要清掉");
});

await testAsync("disposeAll：结束全部会话并关闭连接", async () => {
  const { service, spawned } = makeService({ maxSessions: 4 });
  await service.create({});
  await service.create({});
  const peer = makePeer();
  service.attach(service.get("t1"), peer);
  service.disposeAll();
  eq(service.count(), 0);
  for (const record of spawned) eq(record.terminated, true);
  eq(peer.closed, true);
});

summary();
