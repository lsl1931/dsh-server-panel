// 清单自检：bundle 的元数据必须完整（插件管理/设置页要读它，官方 display checklist 要求）。
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { eq, ok, summary, test } from "./harness.mjs";

console.log("manifest");

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

test("bundle 声明了 patch 与 client 半", () => {
  eq(pkg.name, "dsh-server-panel");
  eq(pkg.dsh?.bundle?.patch, "./cordis.patch.yml");
  eq(pkg.dsh?.client?.platform, "web");
  ok(existsSync(join(root, "cordis.patch.yml")), "cordis.patch.yml 存在");
});

test("exports 覆盖运行期入口 / 客户端 / 语言 / 图标", () => {
  ok(pkg.exports?.["."], "缺少 . 导出");
  eq(pkg.exports?.["./client"], "./lib/client.js");
  ok(pkg.exports?.["./locale/*.json"], "缺少 locale 导出");
  ok(pkg.exports?.["./icon"], "缺少 icon 导出");
  ok(existsSync(join(root, "icon.svg")), "icon.svg 存在");
});

test("files 清单覆盖 patch / locale / icon / lib", () => {
  const files = pkg.files ?? [];
  for (const required of ["lib", "cordis.patch.yml", "locale/*.json", "icon.svg"]) {
    ok(files.includes(required), `files 缺少 ${required}`);
  }
});

test("patch 插入了插件行，且 config 键与代码里的默认值一致", () => {
  const patch = readFileSync(join(root, "cordis.patch.yml"), "utf8");
  ok(/id:\s*dsh-server-panel/.test(patch), "patch 里没有插件行 id");
  ok(/name:\s*'dsh-server-panel'/.test(patch), "patch 里没有包名");
  const source = readFileSync(join(root, "src", "index.js"), "utf8");
  // patch 里显式声明的可调项
  for (const key of [
    "pollMs",
    "overviewStaleMs",
    "servicesCacheMs",
    "sudoIdleMs",
    "commandTimeoutMs",
    "dangerUnits",
    "terminalEnabled",
    "terminalMaxSessions",
    "terminalShell",
  ]) {
    ok(patch.includes(key + ":"), `patch 未声明 ${key}`);
    ok(source.includes(key + ":"), `代码里的 DEFAULTS 缺少 ${key}`);
  }
  // 文件白名单允许省略（走内置默认：运行 dsh 的用户家目录），但代码里必须有默认值
  for (const key of ["allowedReadRoots", "allowedWriteRoots"]) {
    ok(source.includes(key + ":"), `代码里的 DEFAULTS 缺少 ${key}`);
  }
});

test("两种语言的 meta.title / meta.description 都不是模板占位", () => {
  for (const lang of ["zh", "en"]) {
    const dict = JSON.parse(readFileSync(join(root, "locale", `${lang}.json`), "utf8"));
    ok(typeof dict.meta?.title === "string" && dict.meta.title.length > 1, `${lang} meta.title`);
    ok(typeof dict.meta?.description === "string" && dict.meta.description.length > 10, `${lang} meta.description`);
    ok(!/template|lorem|TODO|my-plugin/i.test(dict.meta.description), `${lang} 描述里还有模板文案`);
    ok(typeof dict.panel === "string" && dict.panel.length > 0, `${lang} panel 标签`);
  }
});

test("图标是合法 SVG 且体积在限制内（≤256 KiB）", () => {
  const iconPath = join(root, "icon.svg");
  const bytes = statSync(iconPath).size;
  ok(bytes > 0 && bytes <= 256 * 1024, `图标体积 ${bytes} 字节`);
  const svg = readFileSync(iconPath, "utf8");
  ok(/^<svg[\s>]/.test(svg.trim()), "必须以 <svg 开头");
  ok(svg.includes("</svg>"), "缺少 </svg>");
  ok(svg.includes("viewBox="), "缺少 viewBox");
});

test("Host 半不 import 任何 dsh 包（零依赖原则）", () => {
  for (const file of ["index.js", "metrics.js", "services.js", "files.js", "sudo.js", "exec.js"]) {
    const source = readFileSync(join(root, "src", file), "utf8");
    // 去掉注释后再找真正的 import/require，JSDoc 里的类型引用不算依赖。
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    ok(!/(?:from|require\()\s*["'](@deepseek-ai|dsh-)/.test(code), `${file} 引入了 dsh 包`);
    ok(!/\brequire\(/.test(code), `${file} 用了 require（Host 半必须是 ESM）`);
  }
});

test("lib 产物必须包含全部 Host 模块（否则相对 import 解析失败 = 插件激活失败）", () => {
  const libDir = join(root, "lib");
  if (!existsSync(join(libDir, "index.js"))) {
    ok(true, "尚未构建，跳过（先跑 node build.mjs）");
    return;
  }
  const srcModules = readdirSync(join(root, "src"), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".js"))
    .map((entry) => entry.name);
  for (const name of srcModules) {
    ok(existsSync(join(libDir, name)), `lib/ 缺少 ${name}（build.mjs 应当复制它）`);
  }
  const entry = readFileSync(join(libDir, "index.js"), "utf8");
  for (const match of entry.matchAll(/from\s+"(\.[^"]+)"/g)) {
    ok(existsSync(join(libDir, match[1])), `lib/index.js 的 import ${match[1]} 解析不到`);
  }
});

test("公开仓库卫生：不得写死家目录，也不得出现内网地址字面量", () => {
  const targets = [
    join(root, "src", "index.js"),
    join(root, "src", "client", "index.js"),
    join(root, "cordis.patch.yml"),
  ];
  for (const full of targets) {
    const text = readFileSync(full, "utf8");
    // 白名单/快捷入口必须来自 homedir() 或 Host 下发，不能写死某个用户的家目录
    ok(!/(?:allowedReadRoots|allowedWriteRoots|quickPaths)[^\n]*\/home\/[a-z]/.test(text), full + " 写死了家目录");
    // 私有网段字面量（10/8、192.168/16、172.16-31/12）
    ok(!/\b(?:10|192\.168|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/.test(text), full + " 出现内网地址");
  }
});

summary();
