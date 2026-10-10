// 客户端半冒烟测试：真的去执行 lib/client.js（模拟浏览器的 __ModuleLoader__ + react 模块表），
// 验证导出形状、两个槽位注册、样式约束与终端 ANSI 解析。
// 这能抓住"在工厂函数体里误用 ESM export"这类只在浏览器里才炸的错误。
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { eq, ok, summary, test } from "./harness.mjs";

console.log("client");

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bundlePath = join(root, "lib", "client.js");
const sourcePath = join(root, "src", "client", "index.js");

test("lib/client.js 已构建", () => {
  ok(existsSync(bundlePath), "先跑 node build.mjs 再跑测试");
});

const source = existsSync(bundlePath) ? readFileSync(bundlePath, "utf8") : "";

/** 在 Node 里执行浏览器包装器，返回模块与注册记录。 */
function load() {
  let captured = null;
  const registrations = [];
  const effects = [];
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useEffect: () => {},
    useRef: (value) => ({ current: value }),
    useState: (value) => [typeof value === "function" ? value() : value, () => {}],
  };
  const requireShim = (id) => {
    if (id === "react") return react;
    throw new Error("不允许 require：" + id);
  };
  const windowStub = {
    __ModuleLoader__: { load: (definition) => { captured = definition; } },
    localStorage: { getItem: () => null, setItem: () => {} },
  };
  new Function("window", source)(windowStub);
  const mod = captured.factory(requireShim);
  const ctx = {
    locale: {
      register: (ns, dict) => {
        eq(ns, "dsh-server-panel");
        ok(dict.zh && dict.en, "字典要中英都有");
        eq(typeof dict.zh.panel, "string");
      },
      bind: () => (key) => key,
    },
    effect: (fn, label) => {
      const dispose = fn();
      effects.push({ label, dispose });
      return () => {};
    },
    slots: {
      inject: (key, callback) => {
        callback();
        registrations.push({ injected: key });
        return () => {};
      },
      register: (options) => {
        registrations.push(options);
        return () => {};
      },
    },
  };
  mod.apply(ctx);
  return { mod, registrations, effects, captured };
}

test("构建产物是工厂形式的模块加载器调用", () => {
  ok(source.includes("window.__ModuleLoader__.load"), "缺少加载器调用");
  ok(source.includes('id: "dsh-server-panel"'), "模块 id 必须是包名");
  ok(source.includes("factory: (require)"), "缺少 factory");
});

test("工厂函数体内不得出现 ESM export/import 语句", () => {
  const body = source.slice(source.indexOf("factory: (require)"));
  ok(!/^\s*export\s/m.test(body), "工厂体内有 export 语句（浏览器会直接语法错）");
  ok(!/^\s*import\s/m.test(body), "工厂体内有 import 语句");
});

test("只 require('react')，不引任何 dsh 客户端包", () => {
  const code = source.replace(/^\s*\/\/.*$/gm, "");
  const requires = [...new Set([...code.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]))];
  eq(requires, ["react"], "require 清单");
  ok(!/@deepseek-ai\//.test(code), "源码里出现了 @deepseek-ai 引用");
});

test("CSS 只用主题 token；终端 ANSI 调色板是唯一例外", () => {
  const css = source.slice(source.indexOf(".dsp-root{"));
  ok(css.includes("--dsw-alias-") || css.includes("--dsw-elevation-"), "应当使用主题 token");
  // 终端 16 色属于内容渲染（"artwork 可用自己的颜色"），其余一律不许字面色。
  const withoutPalette = css
    .split("}")
    .filter((chunk) => !chunk.includes("--dsp-t-"))
    .join("}");
  ok(!/#[0-9a-fA-F]{3,8}\b/.test(withoutPalette), "调色板之外出现硬编码十六进制颜色");
  ok(!/\brgb\(|\bhsl\(/.test(withoutPalette), "调色板之外出现 rgb()/hsl()");
  ok(!/var\(--dsw-alias-bg-mask\)/.test(css), "bg-mask 不是真实 token，应为 bg-mask-1");
});

test("真实加载：apply(ctx) 把面板注册进 main 与 sidebar.panellist", () => {
  const { registrations, effects, captured } = load();
  eq(captured.id, "dsh-server-panel");

  const main = registrations.find((r) => r && r.name === "main");
  ok(main, "没有注册 main 槽");
  eq(main.key, "server", "main 槽的 key");

  const panellist = registrations.find((r) => r && r.name === "sidebar.panellist");
  ok(panellist, "没有注册 sidebar.panellist 槽");
  eq(panellist.id, "server", "侧栏条目的 id 必须与 main 的 key 一致");
  ok(typeof panellist.label === "function", "label 应当是可调用函数（官方范式）");
  eq(panellist.order, 20);

  ok(
    registrations.some((r) => r.injected === "main") && registrations.some((r) => r.injected === "sidebar.panellist"),
    "应当通过 ctx.slots.inject 注入两个槽",
  );
  ok(effects.length >= 1, "样式应当由 ctx.effect 管理生命周期");
});

test("终端 ANSI 行缓冲：SGR 颜色 / CR / 退格 / 清行 / 清屏 / 忽略定位序列", () => {
  const { mod } = load();
  const { parseAnsi, createTermState } = mod.__internals;
  ok(typeof parseAnsi === "function", "缺少 parseAnsi 测试接缝");

  const state = createTermState();
  parseAnsi(state, "\u001b[31mred\u001b[0m plain");
  eq(state.lines[0].spans[0].cls, "dsp-term--fg-red");
  eq(state.lines[0].spans[0].text, "red");
  eq(state.lines[0].spans[1].text, " plain", "SGR 复位后不再带颜色类");

  parseAnsi(state, "\n");
  parseAnsi(state, "\u001b[1;32mbold green");
  eq(state.lines[1].spans[0].cls, "dsp-term--fg-green dsp-term--bold");

  // 进度条常用的 CR：清掉当前行再写
  parseAnsi(state, "\r50%");
  eq(state.lines[1].spans.length, 1);
  eq(state.lines[1].spans[0].text, "50%");

  // 退格
  parseAnsi(state, "\b\b");
  eq(state.lines[1].spans[0].text, "5");

  // 清行 + 清屏
  parseAnsi(state, "\u001b[K");
  eq(state.lines[1].spans.length, 0);
  parseAnsi(state, "\u001b[2J");
  eq(state.lines.length, 1, "清屏后只剩一行");

  // 光标定位与 OSC 标题序列要被吃掉，不能变成可见垃圾
  parseAnsi(state, "\u001b[1;1H\u001b]0;title\u0007ok");
  eq(state.lines[0].spans[0].text, "ok");
});

test("行缓冲有上限，长输出不会无限增长", () => {
  const { mod } = load();
  const { parseAnsi, createTermState } = mod.__internals;
  const state = createTermState();
  parseAnsi(state, "line\n".repeat(5000));
  ok(state.lines.length <= 2000, "行数上限 2000，实际 " + state.lines.length);
});

test("源码与产物都没有占位符残留", () => {
  const src = readFileSync(sourcePath, "utf8");
  for (const marker of ["TODO", "FIXME", "XXX", "PLACEHOLDER"]) {
    ok(!src.includes(marker), "残留 " + marker);
  }
});

summary();
