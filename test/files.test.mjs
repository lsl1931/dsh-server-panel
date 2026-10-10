import { mkdtempSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { rmSync } from "node:fs";
import { createFileService, isValidFileName } from "../src/files.js";
import { eq, ok, summary, test, testAsync } from "./harness.mjs";

console.log("files");

const base = mkdtempSync(join(tmpdir(), "dsp-files-"));
const root = join(base, "root");
mkdirSync(join(root, "sub"), { recursive: true });
writeFileSync(join(root, "hello.txt"), "你好 world\n");
writeFileSync(join(root, "sub", "inner.txt"), "inner\n");
writeFileSync(join(root, "big.txt"), Buffer.alloc(1024 * 1024 + 1, 0x61));
writeFileSync(join(root, "bin.dat"), Buffer.from([0x00, 0x01, 0x02]));
symlinkSync("/etc", join(root, "escape-link"));
symlinkSync(join(root, "hello.txt"), join(root, "link-to-hello"));

const files = createFileService({ readRoots: [root], writeRoots: [root] });

await testAsync("list 目录优先、字段齐全", async () => {
  const r = await files.list(root);
  ok(r.ok, "应成功");
  eq(r.entries[0].name, "sub", "目录排在前面");
  const hello = r.entries.find((e) => e.name === "hello.txt");
  eq(hello.type, "file");
  eq(hello.sizeBytes, Buffer.byteLength("你好 world\n"));
  ok(Number.isFinite(hello.mtimeMs));
  eq(hello.mode.length, 3);
});

await testAsync("list 支持符号链接类型且不跟随越界链接", async () => {
  const r = await files.list(root);
  const link = r.entries.find((e) => e.name === "escape-link");
  eq(link.type, "link");
  eq(link.symlink, true);
});

await testAsync("read 文本内容正确，二进制返回 binary", async () => {
  const text = await files.readText(join(root, "hello.txt"));
  ok(text.ok);
  eq(text.text, "你好 world\n");
  ok(Number.isFinite(text.mtimeMs));
  const binary = await files.readText(join(root, "bin.dat"));
  eq(binary.error, "binary");
});

await testAsync("超过 1 MiB 的文本返回 too_large", async () => {
  const r = await files.readText(join(root, "big.txt"));
  eq(r.error, "too_large");
});

await testAsync("写入新建文件并返回新 mtime", async () => {
  const r = await files.writeText(join(root, "new.txt"), "abc", null);
  ok(r.ok);
  eq(readFileSync(join(root, "new.txt"), "utf8"), "abc");
  ok(Number.isFinite(r.mtimeMs));
});

await testAsync("mtime 乐观锁：过期 mtime 返回 conflict，不覆盖文件", async () => {
  const before = await files.readText(join(root, "hello.txt"));
  const stale = before.mtimeMs - 10_000;
  const conflict = await files.writeText(join(root, "hello.txt"), "改坏了", stale);
  eq(conflict.error, "conflict");
  eq(conflict.mtimeMs, before.mtimeMs);
  eq(readFileSync(join(root, "hello.txt"), "utf8"), "你好 world\n", "内容必须原样");
  const good = await files.writeText(join(root, "hello.txt"), "改好了\n", before.mtimeMs);
  ok(good.ok);
  eq(readFileSync(join(root, "hello.txt"), "utf8"), "改好了\n");
});

await testAsync("白名单外一律 forbidden（读、写、列目录）", async () => {
  for (const [name, call] of [
    ["read /etc/hostname", () => files.readText("/etc/hostname")],
    ["list /etc", () => files.list("/etc")],
    ["write /etc/x", () => files.writeText("/etc/x", "x", null)],
    ["read /root", () => files.readText("/root")],
  ]) {
    const r = await call();
    eq(r.error, "forbidden", name);
  }
});

await testAsync("相对路径与 NUL 被拒", async () => {
  eq((await files.readText("hello.txt")).error, "invalid_path");
  eq((await files.list(".")).error, "invalid_path");
  eq((await files.readText(root + "/he\0llo")).error, "invalid_path");
});

await testAsync("符号链接不能成为越界跳板", async () => {
  const r = await files.readText(join(root, "escape-link", "hostname"));
  eq(r.error, "forbidden");
  const w = await files.writeText(join(root, "escape-link", "pwn"), "x", null);
  eq(w.error, "forbidden");
});

await testAsync("mkdir / rename / delete 正常，根目录不可删", async () => {
  ok((await files.makeDirectory(join(root, "made"))).ok);
  eq((await files.makeDirectory(join(root, "made"))).error, "failed", "重复创建要报错");
  const renamed = await files.renameEntry(join(root, "made"), "made2");
  ok(renamed.ok);
  eq(readdirSync(root).includes("made2"), true);
  ok((await files.removeEntry(join(root, "made2"), false)).ok);
  eq((await files.removeEntry(root, true)).error, "forbidden", "不许删白名单根");
  // 非空目录必须显式递归
  eq((await files.removeEntry(join(root, "sub"), false)).error, "failed");
  ok((await files.removeEntry(join(root, "sub"), true)).ok);
});

await testAsync("上传：临时文件改名后落盘，文件名非法被拒", async () => {
  const up = await files.saveUpload(root, "uploaded.bin", Readable.from([Buffer.from("payload")]));
  ok(up.ok, JSON.stringify(up));
  eq(readFileSync(up.path, "utf8"), "payload");
  ok(!readdirSync(root).some((n) => n.includes(".dsp-part-")), "不应残留临时文件");
  eq((await files.saveUpload(root, "../evil", Readable.from(["x"]))).error, "invalid_path");
  eq((await files.saveUpload(root, "a/b", Readable.from(["x"]))).error, "invalid_path");
});

test("文件名校验规则", () => {
  ok(isValidFileName("normal.txt"));
  ok(isValidFileName("中文 名字.md"));
  for (const bad of ["", ".", "..", "a/b", "a\\b", "x\0y", "n".repeat(300)]) ok(!isValidFileName(bad), bad);
});

await testAsync("下载句柄：目录报错、文件给出大小与流", async () => {
  eq((await files.openDownload(root)).error, "failed");
  const d = await files.openDownload(join(root, "new.txt"));
  ok(d.ok);
  eq(d.name, "new.txt");
  eq(d.sizeBytes, 3);
});

await testAsync("roots() 暴露白名单给界面", async () => {
  const r = files.roots();
  eq(r.writeRoots.length, 1);
  ok(r.home.startsWith("/"));
});

rmSync(base, { recursive: true, force: true });
summary();
