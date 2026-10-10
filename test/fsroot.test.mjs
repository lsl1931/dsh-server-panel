import { isSystemPath, createRootFileService, SYSTEM_WRITE_ROOTS } from "../src/fsroot.js";
import { eq, ok, summary, test, testAsync } from "./harness.mjs";

console.log("fsroot(root 文件传输层)");

function fakeSudo(handler) {
  const calls = [];
  return {
    calls,
    state: async () => ({ unlocked: true }),
    runRoot: async (argv, options) => {
      calls.push({ argv, options });
      return handler(argv, options);
    },
    spawnRoot: () => {
      throw new Error("测试里不应调用 spawnRoot");
    },
  };
}

test("系统目录判定：只有写入这些目录才要二次确认", () => {
  ok(isSystemPath("/etc/passwd"));
  ok(isSystemPath("/etc"));
  ok(isSystemPath("/boot/grub/grub.cfg"));
  ok(isSystemPath("/usr/lib/systemd/system/x.service"));
  ok(isSystemPath("/var/lib/dpkg/status"));
  ok(!isSystemPath("/etca/passwd"), "/etca 不是 /etc");
  ok(!isSystemPath("/home/user/x"));
  ok(!isSystemPath("/var/log/syslog"));
  ok(!isSystemPath("etc/passwd"), "相对路径一律不算");
  eq(SYSTEM_WRITE_ROOTS.includes("/etc"), true);
});

await testAsync("list：解析 find 输出、目录优先排序", async () => {
  const sudo = fakeSudo(() => ({
    ok: true,
    stdout:
      "z.txt\tf\t12\t1700000000.5000000000\t644\tuser\tuser\n" +
      "sub\td\t4096\t1700000001.0000000000\t755\troot\troot\n" +
      "link\tl\t9\t1700000002.2500000000\t777\tuser\tuser\n",
    stderr: "",
  }));
  const svc = createRootFileService({ sudo, spawnRoot: sudo.spawnRoot });
  const r = await svc.list("/etc");
  ok(r.ok);
  eq(r.entries.length, 3);
  eq(r.entries[0].name, "sub", "目录排在前");
  eq(r.entries[0].type, "dir");
  eq(r.entries[0].owner, "root");
  eq(r.entries[1].name, "link");
  eq(r.entries[1].symlink, true);
  eq(r.entries[2].mtimeMs, 1700000000500);
  eq(r.parent, "/");
  eq(r.root, true);
  // 命令必须是 argv 数组，且带 --maxdepth 限制（不许跑到子树里去）
  const argv = sudo.calls[0].argv;
  eq(argv[0], "find");
  ok(argv.includes("-maxdepth") && argv.includes("1"), "find 必须限制深度");
});

await testAsync("readText：太大与二进制都被挡", async () => {
  const big = fakeSudo(() => ({ ok: true, stdout: "100000000\t1700000000\t644\troot\troot\tregular file\n", stderr: "" }));
  const bigSvc = createRootFileService({ sudo: big, spawnRoot: big.spawnRoot });
  eq((await bigSvc.readText("/var/log/huge.log")).error, "too_large");

  const binary = fakeSudo((argv) =>
    argv[0] === "stat"
      ? { ok: true, stdout: "8\t1700000000\t644\troot\troot\tregular file\n", stderr: "" }
      : { ok: true, stdout: "a\u0000b", stderr: "" },
  );
  const binarySvc = createRootFileService({ sudo: binary, spawnRoot: binary.spawnRoot });
  eq((await binarySvc.readText("/bin/ls")).error, "binary");
});

await testAsync("writeText：先落临时文件再 sudo cp，目标新文件补 0644", async () => {
  const sudo = fakeSudo((argv) => {
    if (argv[0] === "stat") return { ok: false, error: "failed", stderr: "stat: cannot statx: No such file or directory", code: 1 };
    if (argv[0] === "cp") return { ok: true, stdout: "", stderr: "" };
    if (argv[0] === "chmod") return { ok: true, stdout: "", stderr: "" };
    return { ok: true, stdout: "", stderr: "" };
  });
  const svc = createRootFileService({ sudo, spawnRoot: sudo.spawnRoot });
  const r = await svc.writeText("/etc/dsp-test.conf", "hello", null);
  ok(r.ok, JSON.stringify(r));
  const cp = sudo.calls.find((c) => c.argv[0] === "cp");
  ok(cp, "必须用 cp 落盘");
  eq(cp.argv[1], "-f");
  eq(cp.argv[2], "--");
  ok(cp.argv[3].includes(".dsp-stage-"), "源是用户可写的临时文件");
  eq(cp.argv[4], "/etc/dsp-test.conf");
  const chmod = sudo.calls.find((c) => c.argv[0] === "chmod");
  ok(chmod, "新建文件要补权限位");
  eq(chmod.argv[1], "644");
  // 任何一次调用都不允许把密码塞进 argv
  for (const call of sudo.calls) ok(!call.argv.some((a) => String(a).includes("password")), "argv 里不允许出现密码");
});

await testAsync("writeText：mtime 冲突不落盘", async () => {
  const sudo = fakeSudo(() => ({ ok: true, stdout: "3\t1700000000\t644\troot\troot\tregular file\n", stderr: "" }));
  const svc = createRootFileService({ sudo, spawnRoot: sudo.spawnRoot });
  // 磁盘上是 1700000000s，调用方拿的是更早的时间戳 → 必须报冲突
  const stale = await svc.writeText("/etc/x.conf", "changed", 1600000000000);
  eq(stale.error, "conflict");
  eq(stale.mtimeMs, 1700000000000, "要回传磁盘上的真实 mtime");
  ok(!sudo.calls.some((c) => c.argv[0] === "cp"), "冲突时不得执行 cp");
  // mtime 一致时正常落盘
  const fresh = await svc.writeText("/etc/x.conf", "changed", 1700000000000);
  ok(fresh.ok, JSON.stringify(fresh));
  ok(sudo.calls.some((c) => c.argv[0] === "cp"), "mtime 一致时才写");
});

await testAsync("removeEntry：关键目录一律拒绝删除", async () => {
  const sudo = fakeSudo(() => ({ ok: true, stdout: "", stderr: "" }));
  const svc = createRootFileService({ sudo, spawnRoot: sudo.spawnRoot });
  for (const target of ["/", "/etc", "/usr", "/home", "/boot"]) {
    const r = await svc.removeEntry(target, true);
    eq(r.error, "forbidden", target);
  }
  eq(sudo.calls.filter((c) => c.argv[0] === "rm").length, 0, "不得执行任何 rm");
});

await testAsync("chmod / chown 校验参数", async () => {
  const sudo = fakeSudo(() => ({ ok: true, stdout: "", stderr: "" }));
  const svc = createRootFileService({ sudo, spawnRoot: sudo.spawnRoot });
  eq((await svc.chmodEntry("/etc/x", "u+rwx")).error, "bad_request");
  eq((await svc.chmodEntry("/etc/x", "9999")).error, "bad_request");
  ok((await svc.chmodEntry("/etc/x", "0644")).ok);
  eq((await svc.chownEntry("/etc/x", "www-data; rm -rf /")).error, "bad_request");
  ok((await svc.chownEntry("/etc/x", "www-data:www-data")).ok);
  const chown = sudo.calls.find((c) => c.argv[0] === "chown");
  eq(chown.argv[1], "--", "chown 必须用 -- 终止选项解析");
});

await testAsync("未解锁：sudo 返回 locked 时如实上抛", async () => {
  const sudo = fakeSudo(() => ({ ok: false, error: "locked", message: "需要先解锁 sudo" }));
  const svc = createRootFileService({ sudo, spawnRoot: sudo.spawnRoot });
  eq((await svc.list("/root")).error, "locked");
  eq((await svc.writeText("/root/x", "x", null)).error, "locked");
});

summary();
