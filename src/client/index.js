// dsh-server-panel Client 半 v2 —— 服务器运维控制台。
//
// 设计要点（对应 v2 设计文档）：
//  - 面板内左导航 + 顶栏（主机名 / 健康与负载摘要 / 命令面板 / 轮询开关 / root 开关）；
//  - 首屏 = 健康总览：异常横幅（failed 单元、磁盘、内存、负载、可升级包）→ KPI 卡 →
//    常用服务快启 → 本次会话的操作事件流；
//  - 关键操作不跳页：服务详情用右侧抽屉（含实时跟随日志）、文件编辑用覆盖层、
//    危险操作就地确认；
//  - 解锁 sudo 后所有请求自动带 root=1（文件全盘、日志全量、软件包可写、进程名可见）；
//    未解锁时点到需要权限的操作会直接弹解锁框，解锁后自动重试；
//  - ⌘K / Ctrl+K 命令面板覆盖高频操作。
//
// 形态：不用 JSX 的 CJS 函数体，只 require("react")，由 build.mjs 包进
// window.__ModuleLoader__.load({ id, factory })。样式只用 --dsw-alias-* token。

const { createElement: h, useEffect, useMemo, useRef, useState } = require("react");

const NS = "dsh-server-panel";
const BASE = "/dsh-server-panel";
const PANEL_ID = "server";
const STYLE_ID = "dsh-server-panel/style.css";

const OVERVIEW_POLL_MS = 2000;
const SERVICES_POLL_MS = 5000;
const LOG_FOLLOW_MS = 1500;
const NETWORK_POLL_MS = 8000;
const PACKAGES_POLL_MS = 60000;

/** 高危单元：stop/restart 前必须二次确认。 */
const DANGER_UNITS = ["ssh", "sshd", "systemd-logind", "networking", "systemd-networkd", "dsh"];

/** 与 Host 的 fsroot.SYSTEM_WRITE_ROOTS 保持一致：写这些目录要二次确认。 */
const SYSTEM_WRITE_ROOTS = ["/etc", "/boot", "/usr", "/lib", "/lib64", "/bin", "/sbin", "/var/lib"];

const FAVORITES_KEY = "dsh-server-panel:favorites";

const DICT = {
  zh: {
    panel: "服务器",
    "nav.overview": "总览",
    "nav.services": "服务",
    "nav.files": "文件",
    "nav.logs": "日志",
    "nav.packages": "软件包",
    "nav.network": "网络",
    "nav.terminal": "终端",
    "common.refresh": "刷新",
    "common.loading": "载入中…",
    "common.save": "保存",
    "common.close": "关闭",
    "common.cancel": "取消",
    "common.confirm": "确定",
    "common.empty": "暂无数据",
    "sudo.locked": "未解锁",
    "sudo.unlocked": "root",
    "sudo.lock": "锁定",
    "sudo.title": "解锁 sudo",
    "palette.placeholder": "输入操作或页面名，例如：打开 /etc、刷新 apt 索引、升级全部",
  },
  en: {
    panel: "Server",
    "nav.overview": "Overview",
    "nav.services": "Services",
    "nav.files": "Files",
    "nav.logs": "Logs",
    "nav.packages": "Packages",
    "nav.network": "Network",
    "nav.terminal": "Terminal",
    "common.refresh": "Refresh",
    "common.loading": "Loading…",
    "common.save": "Save",
    "common.close": "Close",
    "common.cancel": "Cancel",
    "common.confirm": "OK",
    "common.empty": "No data",
    "sudo.locked": "Locked",
    "sudo.unlocked": "root",
    "sudo.lock": "Lock",
    "sudo.title": "Unlock sudo",
    "palette.placeholder": "Type a command or page name…",
  },
};

const ERROR_TEXT = {
  locked: "需要先解锁 sudo",
  bad_password: "sudo 密码不正确",
  sudo_unavailable: "这台机器上 sudo 不可用",
  forbidden: "不在允许访问的范围内，或权限不足",
  not_found: "路径不存在",
  invalid_path: "路径不合法（需要绝对路径）",
  conflict: "文件已被其他地方修改，请重新载入后再保存",
  confirm_required: "这是系统文件，需要二次确认",
  too_large: "内容过大（文本上限 1 MiB）",
  binary: "这是二进制文件，无法当文本编辑",
  invalid_unit: "单元名不合法",
  invalid_action: "动作不合法",
  bad_request: "请求不合法",
  method_not_allowed: "请求方法不允许",
  trust_fence_unavailable: "DSH 认证通道不可用（已拒绝访问）",
  http_404: "这个接口在运行中的 dsh 里还不存在 —— 重启一次 dsh（电源按钮）即可生效",
  failed: "操作失败",
};

const HOST = { ctx: null, t: (key, fallback) => fallback ?? key };

/** 本次会话在面板里做过的事（首屏"最近事件"用它）。 */
const EVENT_LOG = [];
let eventSeq = 0;

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

function formatBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return "0";
  const units = ["B", "K", "M", "G", "T", "P"];
  let value = n;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return (i === 0 ? String(Math.round(value)) : value.toFixed(value >= 100 ? 0 : 1)) + units[i];
}

const formatRate = (n) => (Number.isFinite(n) ? formatBytes(n) + "/s" : "—");
const formatPct = (n) => (Number.isFinite(n) ? Math.round(n * 10) / 10 + "%" : "—");

function formatUptime(sec) {
  if (!Number.isFinite(sec) || sec <= 0) return "—";
  const d = Math.floor(sec / 86400);
  const hr = Math.floor((sec % 86400) / 3600);
  const min = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d} 天 ${hr} 小时`;
  if (hr > 0) return `${hr} 小时 ${min} 分`;
  return `${min} 分钟`;
}

function formatTime(ms) {
  if (!Number.isFinite(ms)) return "—";
  const d = new Date(ms);
  const pad = (v) => String(v).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatClock(ms) {
  const d = new Date(ms);
  const pad = (v) => String(v).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function remainingText(expiresAt) {
  if (!Number.isFinite(expiresAt)) return "";
  const left = expiresAt - Date.now();
  if (left <= 0) return "";
  const min = Math.floor(left / 60000);
  const sec = Math.floor((left % 60000) / 1000);
  return `${min}:${String(sec).padStart(2, "0")}`;
}

function baseName(p) {
  if (typeof p !== "string" || p.length === 0) return "";
  const idx = p.lastIndexOf("/");
  return idx < 0 ? p : p.slice(idx + 1);
}

function joinPath(dir, name) {
  if (dir === "/") return "/" + name;
  return String(dir).replace(/\/+$/, "") + "/" + name;
}

function enc(value) {
  return encodeURIComponent(String(value ?? ""));
}

function describeError(error) {
  if (!error) return "";
  return ERROR_TEXT[error.code] ?? error.message ?? "未知错误";
}

function isSystemPath(target) {
  if (typeof target !== "string" || target[0] !== "/") return false;
  return SYSTEM_WRITE_ROOTS.some((root) => target === root || target.startsWith(root + "/"));
}

function isDangerUnit(unit) {
  return DANGER_UNITS.includes(String(unit ?? "").replace(/\.service$/, ""));
}

function pushEvent(tone, text) {
  eventSeq += 1;
  EVENT_LOG.unshift({ id: eventSeq, at: Date.now(), tone, text });
  if (EVENT_LOG.length > 40) EVENT_LOG.length = 40;
}

function loadFavorites() {
  try {
    const raw = window.localStorage.getItem(FAVORITES_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list.filter((v) => typeof v === "string") : [];
  } catch {
    return [];
  }
}

function saveFavorites(list) {
  try {
    window.localStorage.setItem(FAVORITES_KEY, JSON.stringify(list));
  } catch {
    // 隐私模式等场景忽略。
  }
}

// ---------------------------------------------------------------------------
// 图标（内联 SVG；h.01 的短横在 round linecap 下渲染成圆点）
// ---------------------------------------------------------------------------

const ICON_PATHS = {
  gauge: ["M12 13l4.5-4.5", "M4 16a8 8 0 1 1 16 0"],
  services: ["M4 7.5h16v9H4z", "M8 12h.01", "M12 12h5"],
  folder: ["M3 7.5A2 2 0 0 1 5 5.5h3.5l2 2H19a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"],
  logs: ["M6 3.5h9l3 3v14H6z", "M9 9h6M9 12.5h6M9 16h4"],
  packages: ["M12 3.5l8 4.2v8.6l-8 4.2-8-4.2V7.7z", "M4 7.7l8 4.2 8-4.2M12 11.9V21"],
  network: ["M12 4v5", "M4 18h16", "M7 14a7 7 0 0 1 10 0", "M10 17a3 3 0 0 1 4 0"],
  server: ["M4 4h16v6H4z", "M4 14h16v6H4z", "M7.5 7h.01", "M7.5 17h.01", "M11 7h5M11 17h5"],
  terminal: ["M4 5h16v14H4z", "M8 10.5l2.5 2L8 15", "M13.5 15h4"],
  search: ["M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14z", "M16.5 16.5L21 21"],
  refresh: ["M20 12a8 8 0 1 1-2.5-5.8", "M20 4v4h-4"],
  lock: ["M6 11h12v9H6z", "M9 11V8a3 3 0 0 1 6 0v3"],
  unlock: ["M6 11h12v9H6z", "M9 11V8a3 3 0 0 1 5.7-1.3"],
  play: ["M8 5.5l11 6.5-11 6.5z"],
  stop: ["M7 7h10v10H7z"],
  restart: ["M4 12a8 8 0 1 0 3-6.2", "M4 5v5h5"],
  power: ["M12 4v8", "M6.5 6.5a8 8 0 1 0 11 0"],
  plus: ["M12 5v14", "M5 12h14"],
  upload: ["M12 20V6", "M7 11l5-5 5 5", "M5 20h14"],
  download: ["M12 4v14", "M7 13l5 5 5-5", "M5 20h14"],
  trash: ["M5 7h14", "M9 7V5h6v2", "M7 7l1 13h8l1-13"],
  pencil: ["M5 19l1-4L16.5 4.5a2 2 0 0 1 3 3L9 18z"],
  check: ["M5 13l4 4L19 7"],
  close: ["M6 6l12 12", "M18 6L6 18"],
  chevron: ["M9 6l6 6-6 6"],
  dots: ["M6 12h.01", "M12 12h.01", "M18 12h.01"],
  key: ["M14 7a4 4 0 1 1-3.2 6.4L4 20v-3h3v-3h2.6", "M17 7h.01"],
  shield: ["M12 3.5l7 3v5c0 4.5-3 8-7 9-4-1-7-4.5-7-9v-5z"],
  alert: ["M12 4l8.5 15h-17z", "M12 10v4", "M12 17h.01"],
  clock: ["M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16z", "M12 8v4.5l3 2"],
};

function Icon(props) {
  const paths = ICON_PATHS[props?.name] ?? ICON_PATHS.dots;
  const size = props?.size ?? 16;
  return h(
    "svg",
    {
      className: props?.className,
      width: size,
      height: size,
      viewBox: "0 0 24 24",
      fill: "none",
      stroke: "currentColor",
      strokeWidth: props?.strokeWidth ?? 1.6,
      strokeLinecap: "round",
      strokeLinejoin: "round",
      "aria-hidden": "true",
      focusable: "false",
    },
    paths.map((d, index) => h("path", { key: index, d })),
  );
}

// ---------------------------------------------------------------------------
// API 层
// ---------------------------------------------------------------------------

/** 解锁后自动以 root 身份请求；调用方可用 root:false 显式降级。 */
const IDENTITY = { root: false };

async function api(path, options) {
  const opts = options ?? {};
  const wantsRoot = opts.root !== undefined ? opts.root : IDENTITY.root;
  let url = BASE + path;
  if (wantsRoot) url += (url.includes("?") ? "&" : "?") + "root=1";
  if (opts.confirm === true) url += (url.includes("?") ? "&" : "?") + "confirm=1";
  const init = {
    cache: "no-store",
    method: opts.method ?? "GET",
    credentials: "same-origin",
    signal: opts.signal,
  };
  if (opts.body !== undefined) init.body = opts.body;
  const headers = Object.assign({}, opts.headers);
  if (typeof opts.body === "string" && !headers["content-type"]) headers["content-type"] = "application/json";
  if (Object.keys(headers).length > 0) init.headers = headers;
  const response = await fetch(url, init);
  let data = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }
  if (!response.ok || !data || data.ok !== true) {
    const error = new Error((data && data.message) || (data && data.error) || `HTTP ${response.status}`);
    error.code = (data && data.error) || `http_${response.status}`;
    error.status = response.status;
    error.detail = data;
    throw error;
  }
  return data;
}

// ---------------------------------------------------------------------------
// 钩子
// ---------------------------------------------------------------------------

function readActivePanelId() {
  try {
    return HOST.ctx?.layout?.panelInfo?.getSnapshot?.().activePanelId ?? null;
  } catch {
    return null;
  }
}

function usePanelActive() {
  const [id, setId] = useState(readActivePanelId);
  useEffect(() => {
    const info = HOST.ctx?.layout?.panelInfo;
    if (!info || typeof info.subscribe !== "function") return undefined;
    const sync = () => setId(readActivePanelId());
    sync();
    return info.subscribe(sync);
  }, []);
  const [visible, setVisible] = useState(() => (typeof document === "undefined" ? true : !document.hidden));
  useEffect(() => {
    if (typeof document === "undefined") return undefined;
    const onVisibility = () => setVisible(!document.hidden);
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);
  const selected = id === null ? true : id === PANEL_ID;
  return selected && visible;
}

/** 轮询：active 变 false 立即停；失败保留上一帧数据。 */
function usePoll(active, intervalMs, loader) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [generation, setGeneration] = useState(0);
  const loaderRef = useRef(loader);
  loaderRef.current = loader;
  useEffect(() => {
    if (!active) return undefined;
    let cancelled = false;
    let timer = null;
    const tick = async () => {
      try {
        const value = await loaderRef.current();
        if (!cancelled) {
          setData(value);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) setError(err);
      } finally {
        if (!cancelled) timer = setTimeout(tick, Math.max(500, intervalMs));
      }
    };
    tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [active, intervalMs, generation]);
  return { data, error, reload: () => setGeneration((g) => g + 1) };
}

// ---------------------------------------------------------------------------
// 基础控件
// ---------------------------------------------------------------------------

function Notice(props) {
  if (!props?.text) return null;
  return h("div", { className: "dsp-notice dsp-notice--" + (props.tone ?? "error") }, props.text);
}

function Bar(props) {
  const pct = Number.isFinite(props?.pct) ? Math.max(0, Math.min(100, props.pct)) : null;
  const tone = pct === null ? 0 : pct >= 90 ? 2 : pct >= 70 ? 1 : 0;
  return h("div", { className: "dsp-bar" }, h("div", { className: "dsp-bar__fill dsp-t" + tone, style: { width: (pct ?? 0) + "%" } }));
}

function Dot(props) {
  return h("span", { className: "dsp-dot dsp-dot--" + (props?.tone ?? "off"), title: props?.title });
}

function Btn(props) {
  const rest = Object.assign({}, props);
  const icon = rest.icon;
  const label = rest.label;
  const tone = rest.tone;
  const size = rest.size;
  delete rest.icon;
  delete rest.label;
  delete rest.tone;
  delete rest.size;
  return h(
    "button",
    Object.assign(
      { className: "dsp-btn" + (tone ? " dsp-btn--" + tone : "") + (size === "mini" ? " dsp-btn--mini" : ""), type: "button" },
      rest,
    ),
    icon ? h(Icon, { name: icon, size: size === "mini" ? 12 : 14 }) : null,
    label ? h("span", null, label) : null,
  );
}

function Tile(props) {
  return h(
    "section",
    { className: "dsp-tile" + (props?.wide ? " dsp-tile--wide" : "") + (props?.onClick ? " dsp-tile--clickable" : ""), onClick: props?.onClick },
    h(
      "header",
      { className: "dsp-tile__head" },
      h("span", { className: "dsp-tile__title" }, props?.title),
      props?.aside ? h("span", { className: "dsp-muted" }, props.aside) : null,
    ),
    props?.value !== undefined ? h("div", { className: "dsp-tile__value" }, props.value) : null,
    props?.children,
  );
}

function Modal(props) {
  const onClose = props?.onClose;
  useEffect(() => {
    const onKey = (event) => {
      if (event.key === "Escape" && typeof onClose === "function") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  return h(
    "div",
    { className: "dsp-mask", onMouseDown: (e) => { if (e.target === e.currentTarget && onClose) onClose(); } },
    h("div", { className: "dsp-modal", role: "dialog", "aria-modal": "true" }, props.title ? h("div", { className: "dsp-modal__title" }, props.title) : null, props.children),
  );
}

function PromptDialog(props) {
  const [value, setValue] = useState(props?.initialValue ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const inputRef = useRef(null);
  useEffect(() => {
    if (inputRef.current?.focus) inputRef.current.focus();
  }, []);
  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await props.onSubmit(value);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };
  return h(
    Modal,
    { title: props.title, onClose: props.onClose },
    props.hint ? h("div", { className: "dsp-modal__hint" }, props.hint) : null,
    h("input", {
      ref: inputRef,
      className: "dsp-input",
      value,
      spellCheck: false,
      onChange: (e) => setValue(e.target.value),
      onKeyDown: (e) => { if (e.key === "Enter") submit(); },
    }),
    h(Notice, { text: error }),
    h("div", { className: "dsp-modal__actions" }, h(Btn, { label: HOST.t("common.cancel", "取消"), onClick: props.onClose, disabled: busy }), h(Btn, { label: HOST.t("common.confirm", "确定"), tone: "primary", onClick: submit, disabled: busy })),
  );
}

function ConfirmDialog(props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await props.onConfirm();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };
  return h(
    Modal,
    { title: props.title, onClose: props.onClose },
    h("div", { className: "dsp-modal__text" }, props.text),
    props.danger ? h("div", { className: "dsp-warn" }, props.danger) : null,
    h(Notice, { text: error }),
    h(
      "div",
      { className: "dsp-modal__actions" },
      h(Btn, { label: HOST.t("common.cancel", "取消"), onClick: props.onClose, disabled: busy }),
      h(Btn, { label: props.confirmText ?? HOST.t("common.confirm", "确定"), tone: props.tone === "danger" ? "danger" : "primary", onClick: submit, disabled: busy }),
    ),
  );
}

function UnlockDialog(props) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const inputRef = useRef(null);
  useEffect(() => {
    if (inputRef.current?.focus) inputRef.current.focus();
  }, []);
  const submit = async () => {
    if (busy || password.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      await props.onUnlock(password);
      setPassword("");
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };
  return h(
    Modal,
    { title: HOST.t("sudo.title", "解锁 sudo"), onClose: props.onClose },
    h(
      "div",
      { className: "dsp-modal__hint" },
      "解锁后：文件可全盘读写、日志看全量、服务可启停、软件包可升级、终端可开 root shell。密码只写进 sudo 的 stdin，只留在 dsh 进程内存；锁定或空闲 10 分钟后自动清除。",
    ),
    h("input", {
      ref: inputRef,
      className: "dsp-input",
      type: "password",
      autoComplete: "off",
      placeholder: "sudo 密码",
      value: password,
      onChange: (e) => setPassword(e.target.value),
      onKeyDown: (e) => { if (e.key === "Enter") submit(); },
    }),
    h(Notice, { text: error }),
    h("div", { className: "dsp-modal__actions" }, h(Btn, { label: HOST.t("common.cancel", "取消"), onClick: props.onClose, disabled: busy }), h(Btn, { label: busy ? "验证中…" : "解锁", tone: "primary", onClick: submit, disabled: busy || password.length === 0 })),
  );
}

function Drawer(props) {
  useEffect(() => {
    const onKey = (event) => {
      if (event.key === "Escape") props.onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [props.onClose]);
  return h(
    "aside",
    { className: "dsp-drawer" },
    h(
      "header",
      { className: "dsp-drawer__head" },
      h("div", { className: "dsp-drawer__title" }, props.title),
      props.subtitle ? h("div", { className: "dsp-muted" }, props.subtitle) : null,
      h("button", { className: "dsp-iconbtn", type: "button", title: "关闭", onClick: props.onClose }, h(Icon, { name: "close" })),
    ),
    h("div", { className: "dsp-drawer__body" }, props.children),
  );
}

// ---------------------------------------------------------------------------
// 命令面板
// ---------------------------------------------------------------------------

function CommandPalette(props) {
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef(null);
  useEffect(() => {
    if (inputRef.current?.focus) inputRef.current.focus();
  }, []);
  const needle = query.trim().toLowerCase();
  const filtered = needle ? props.commands.filter((cmd) => (cmd.title + " " + (cmd.keywords ?? "")).toLowerCase().includes(needle)) : props.commands;
  const list = filtered.slice(0, 12);
  const run = (cmd) => {
    if (!cmd) return;
    props.onClose();
    cmd.run();
  };
  return h(
    "div",
    { className: "dsp-mask dsp-mask--top", onMouseDown: (e) => { if (e.target === e.currentTarget) props.onClose(); } },
    h(
      "div",
      { className: "dsp-palette", role: "dialog", "aria-modal": "true" },
      h(
        "div",
        { className: "dsp-palette__input" },
        h(Icon, { name: "search", size: 16 }),
        h("input", {
          ref: inputRef,
          value: query,
          spellCheck: false,
          placeholder: HOST.t("palette.placeholder", "输入操作或页面名…"),
          onChange: (e) => {
            setQuery(e.target.value);
            setCursor(0);
          },
          onKeyDown: (e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setCursor((c) => Math.min(list.length - 1, c + 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setCursor((c) => Math.max(0, c - 1));
            } else if (e.key === "Enter") {
              e.preventDefault();
              run(list[cursor]);
            } else if (e.key === "Escape") {
              props.onClose();
            }
          },
        }),
      ),
      h(
        "div",
        { className: "dsp-palette__list" },
        list.length === 0 ? h("div", { className: "dsp-muted dsp-palette__empty" }, "没有匹配的操作") : null,
        list.map((cmd, index) =>
          h(
            "button",
            {
              key: cmd.id,
              className: "dsp-palette__item" + (index === cursor ? " dsp-palette__item--active" : ""),
              type: "button",
              onMouseEnter: () => setCursor(index),
              onClick: () => run(cmd),
            },
            h(Icon, { name: cmd.icon ?? "chevron", size: 14 }),
            h("span", { className: "dsp-palette__label" }, cmd.title),
            cmd.hint ? h("span", { className: "dsp-muted" }, cmd.hint) : null,
          ),
        ),
      ),
    ),
  );
}

// ---------------------------------------------------------------------------
// 页面：总览
// ---------------------------------------------------------------------------

function OverviewPage(props) {
  const active = props.active;
  const overview = usePoll(active, OVERVIEW_POLL_MS, () => api("/overview", { root: false }));
  const services = usePoll(active, SERVICES_POLL_MS, () => api("/services", { root: false }));
  const packages = usePoll(active, PACKAGES_POLL_MS, () => api("/packages/upgradable", { root: false }));
  const [favorites, setFavorites] = useState(loadFavorites);
  const [, forceEvents] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => forceEvents((n) => n + 1), 3000);
    timer.unref?.();
    return () => clearInterval(timer);
  }, []);

  const data = overview.data;
  const units = Array.isArray(services.data?.units) ? services.data.units : [];
  const failed = units.filter((u) => u.active === "failed");
  const disk = (data?.disks ?? []).slice().sort((a, b) => (b.usedPct ?? 0) - (a.usedPct ?? 0))[0] ?? null;
  const memPct = data?.memory?.usedPct ?? null;
  const load1 = Array.isArray(data?.cpu?.load) ? data.cpu.load[0] : null;
  const cores = data?.cpu?.count ?? null;
  const upgradable = Array.isArray(packages.data?.packages) ? packages.data.packages.length : null;

  const alerts = [];
  if (failed.length > 0) {
    alerts.push({ tone: "err", text: `${failed.length} 个服务 failed：${failed.slice(0, 3).map((u) => u.unit).join("、")}${failed.length > 3 ? " …" : ""}`, action: () => props.go("services", { filter: "failed" }) });
  }
  if (Number.isFinite(disk?.usedPct) && disk.usedPct >= 85) alerts.push({ tone: "warn", text: `磁盘 ${disk.mount} 已用 ${formatPct(disk.usedPct)}`, action: () => props.go("files", { path: disk.mount }) });
  if (Number.isFinite(memPct) && memPct >= 90) alerts.push({ tone: "warn", text: `内存已用 ${formatPct(memPct)}` });
  if (Number.isFinite(load1) && Number.isFinite(cores) && load1 > cores) alerts.push({ tone: "warn", text: `1 分钟负载 ${load1.toFixed(2)} 超过 ${cores} 核` });
  if (Number.isFinite(upgradable) && upgradable > 0) alerts.push({ tone: "warn", text: `有 ${upgradable} 个软件包可升级`, action: () => props.go("packages", null) });

  const host = data?.host ?? {};
  const interfaces = data?.network?.interfaces ?? [];

  const quickUnits = useMemo(() => {
    const byName = new Map(units.map((u) => [u.unit, u]));
    const chosen = favorites.map((name) => byName.get(name)).filter(Boolean);
    if (chosen.length >= 4) return chosen.slice(0, 8);
    const extra = units.filter((u) => u.active === "active" && !favorites.includes(u.unit)).slice(0, 8 - chosen.length);
    return [...chosen, ...extra];
  }, [units, favorites]);

  const toggleFavorite = (unit) => {
    const next = favorites.includes(unit) ? favorites.filter((v) => v !== unit) : [...favorites, unit];
    setFavorites(next);
    saveFavorites(next);
  };

  return h(
    "div",
    { className: "dsp-page" },
    h(
      "div",
      { className: "dsp-health" + (alerts.length === 0 ? " dsp-health--ok" : "") },
      h(Icon, { name: alerts.length === 0 ? "check" : "alert", size: 18 }),
      h("div", { className: "dsp-health__text" }, alerts.length === 0 ? "一切正常：没有失败的服务，资源充足" : `${alerts.length} 项需要关注`),
      h(
        "div",
        { className: "dsp-health__items" },
        alerts.map((alert, index) =>
          h("button", { key: index, className: "dsp-health__item dsp-health__item--" + alert.tone, type: "button", onClick: alert.action ?? (() => {}) }, alert.text),
        ),
      ),
    ),
    h(Notice, { text: overview.error ? "状态刷新失败：" + describeError(overview.error) : null }),

    h(
      "div",
      { className: "dsp-tiles" },
      h(
        Tile,
        { title: "CPU", aside: cores ? `${cores} 核` : "", value: formatPct(data?.cpu?.busyPct) },
        h(Bar, { pct: data?.cpu?.busyPct }),
        h("div", { className: "dsp-muted" }, "负载 " + (data?.cpu?.load ?? []).map((v) => (Number.isFinite(v) ? v.toFixed(2) : "—")).join(" / ")),
      ),
      h(
        Tile,
        { title: "内存", aside: `${formatBytes(data?.memory?.usedBytes)} / ${formatBytes(data?.memory?.totalBytes)}`, value: formatPct(memPct) },
        h(Bar, { pct: memPct }),
        h("div", { className: "dsp-muted" }, `交换分区 ${formatBytes(data?.memory?.swapUsedBytes)} / ${formatBytes(data?.memory?.swapTotalBytes)}`),
      ),
      h(
        Tile,
        { title: "磁盘", aside: disk ? disk.fs : "", value: formatPct(disk?.usedPct), onClick: disk ? () => props.go("files", { path: disk.mount }) : undefined },
        h(Bar, { pct: disk?.usedPct }),
        h("div", { className: "dsp-muted" }, disk ? `${disk.mount} · 可用 ${formatBytes(disk.availableBytes)}` : "—"),
      ),
      h(
        Tile,
        { title: "系统", aside: host.kernel ?? "", value: formatUptime(data?.uptimeSec) },
        h("div", { className: "dsp-muted" }, host.distro ?? "—"),
        h("div", { className: "dsp-muted" }, `进程 ${data?.processes?.total ?? "—"} · 运行中 ${data?.processes?.running ?? "—"}`),
      ),
    ),

    h(
      "div",
      { className: "dsp-columns" },
      h(
        Tile,
        { title: "常用服务", aside: "行内直接操作；收藏的服务会固定在这里", wide: true },
        h(
          "div",
          { className: "dsp-quick" },
          quickUnits.map((unit) =>
            h(
              "div",
              { key: unit.unit, className: "dsp-quick__row" },
              h(Dot, { tone: unit.active === "active" ? "ok" : unit.active === "failed" ? "err" : "off", title: unit.active }),
              h("button", { className: "dsp-quick__name", type: "button", onClick: () => props.go("services", { expand: unit.unit }) }, unit.unit),
              h("span", { className: "dsp-muted dsp-quick__desc" }, unit.description ?? ""),
              h(
                "span",
                { className: "dsp-quick__actions" },
                h(Btn, { size: "mini", icon: "restart", label: "重启", onClick: () => props.quickAction(unit.unit, "restart") }),
                h(Btn, { size: "mini", icon: favorites.includes(unit.unit) ? "check" : "plus", label: favorites.includes(unit.unit) ? "已收藏" : "收藏", onClick: () => toggleFavorite(unit.unit) }),
              ),
            ),
          ),
        ),
      ),
      h(
        Tile,
        { title: "网卡", wide: true },
        interfaces.length === 0
          ? h("div", { className: "dsp-muted" }, HOST.t("common.empty", "暂无数据"))
          : interfaces.map((iface) =>
              h(
                "div",
                { key: iface.name, className: "dsp-netrow" },
                h("b", null, iface.name),
                h("span", { className: "dsp-netrow__rate" }, "↓ " + formatRate(iface.rxBytesPerSec)),
                h("span", { className: "dsp-netrow__rate" }, "↑ " + formatRate(iface.txBytesPerSec)),
                h("span", { className: "dsp-muted" }, "累计 ↓" + formatBytes(iface.rxTotalBytes) + " / ↑" + formatBytes(iface.txTotalBytes)),
              ),
            ),
      ),
      h(
        Tile,
        { title: "最近事件", aside: "本次会话在面板里的操作", wide: true },
        EVENT_LOG.length === 0
          ? h("div", { className: "dsp-muted" }, "还没有操作记录")
          : h(
              "div",
              { className: "dsp-events" },
              EVENT_LOG.slice(0, 8).map((event) =>
                h("div", { key: event.id, className: "dsp-events__row" }, h("span", { className: "dsp-muted" }, formatClock(event.at)), h("span", { className: "dsp-events__tone dsp-events__tone--" + event.tone }), event.text),
              ),
            ),
      ),
    ),
  );
}

// ---------------------------------------------------------------------------
// 页面：服务
// ---------------------------------------------------------------------------

const SERVICE_GROUPS = [
  ["failed", "失败"],
  ["running", "运行中"],
  ["enabled", "开机自启"],
  ["all", "全部"],
];

function ServicesPage(props) {
  const active = props.active;
  const [group, setGroup] = useState(props.initial?.filter === "failed" ? "failed" : "running");
  const [query, setQuery] = useState("");
  const [notice, setNotice] = useState(null);
  const [busyUnit, setBusyUnit] = useState(null);
  const [detail, setDetail] = useState(props.initial?.expand ? { unit: props.initial.expand, at: Date.now() } : null);
  const { data, error, reload } = usePoll(active, SERVICES_POLL_MS, () => api("/services", { root: false }));

  const units = Array.isArray(data?.units) ? data.units : [];
  const counts = {
    failed: units.filter((u) => u.active === "failed").length,
    running: units.filter((u) => u.active === "active").length,
    enabled: units.filter((u) => u.enabled === true).length,
    all: units.length,
  };
  const needle = query.trim().toLowerCase();
  const filtered = units
    .filter((unit) => {
      if (group === "failed") return unit.active === "failed";
      if (group === "running") return unit.active === "active";
      if (group === "enabled") return unit.enabled === true;
      return true;
    })
    .filter((unit) => (needle ? unit.unit.toLowerCase().includes(needle) || String(unit.description).toLowerCase().includes(needle) : true));

  const runAction = async (unit, action, label) => {
    setBusyUnit(unit);
    setNotice(null);
    try {
      const result = await props.guard(() => api("/services/action", { method: "POST", body: JSON.stringify({ unit, action }), root: false }));
      if (result) {
        pushEvent("ok", `${label} ${unit} 完成（${result.active ?? "?"}/${result.sub ?? "?"}）`);
        setNotice({ tone: "ok", text: `${unit} ${label}完成` });
        reload();
        setDetail((prev) => (prev?.unit === unit ? { unit, at: Date.now() } : prev));
      }
    } catch (err) {
      pushEvent("err", `${label} ${unit} 失败：${describeError(err)}`);
      setNotice({ tone: "error", text: `${unit} ${label}失败：${describeError(err)}` });
    } finally {
      setBusyUnit(null);
    }
  };

  const confirmThenRun = (unit, action, label) => {
    if (isDangerUnit(unit) && (action === "stop" || action === "restart")) {
      props.askConfirm({
        title: `${label} ${unit}`,
        text: `即将对高危单元 ${unit} 执行「${label}」。`,
        danger: "它可能切断你当前的 SSH 隧道连接，导致这个面板立刻失联（需要重新建立隧道才能回来）。",
        tone: "danger",
        confirmText: label,
        onConfirm: () => runAction(unit, action, label),
      });
      return;
    }
    runAction(unit, action, label);
  };

  return h(
    "div",
    { className: "dsp-page" },
    h(
      "div",
      { className: "dsp-toolbar" },
      h(
        "div",
        { className: "dsp-segment" },
        SERVICE_GROUPS.map(([key, label]) =>
          h(
            "button",
            { key, className: "dsp-segment__btn" + (group === key ? " dsp-segment__btn--active" : ""), type: "button", onClick: () => setGroup(key) },
            label,
            h("span", { className: "dsp-segment__count" }, String(counts[key] ?? 0)),
          ),
        ),
      ),
      h("label", { className: "dsp-search" }, h(Icon, { name: "search", size: 14 }), h("input", { value: query, placeholder: "搜索单元名或描述…", spellCheck: false, onChange: (e) => setQuery(e.target.value) })),
      h(Btn, { icon: "refresh", label: HOST.t("common.refresh", "刷新"), onClick: reload }),
    ),
    h(Notice, { text: notice?.text, tone: notice?.tone === "ok" ? "ok" : "error" }),
    h(Notice, { text: error ? "列表刷新失败：" + describeError(error) : null }),
    !data ? h("div", { className: "dsp-muted" }, HOST.t("common.loading", "载入中…")) : null,
    h(
      "div",
      { className: "dsp-list" },
      filtered.slice(0, 400).map((unit) =>
        h(
          "div",
          { key: unit.unit, className: "dsp-svc" + (detail?.unit === unit.unit ? " dsp-svc--open" : "") },
          h(
            "div",
            { className: "dsp-svc__row" },
            h(Dot, { tone: unit.active === "active" ? "ok" : unit.active === "failed" ? "err" : "off", title: `${unit.active}/${unit.sub}` }),
            h("button", { className: "dsp-svc__name", type: "button", onClick: () => setDetail({ unit: unit.unit, at: Date.now() }) }, unit.unit),
            h("span", { className: "dsp-svc__enabled" }, unit.enabled === true ? "自启" : unit.enabled === false ? "—" : ""),
            h("span", { className: "dsp-svc__desc", title: unit.description }, unit.description ?? ""),
            h(
              "span",
              { className: "dsp-svc__actions" },
              unit.active === "active"
                ? h(Btn, { size: "mini", icon: "stop", label: "停止", disabled: busyUnit === unit.unit, onClick: () => confirmThenRun(unit.unit, "stop", "停止") })
                : h(Btn, { size: "mini", icon: "play", label: "启动", disabled: busyUnit === unit.unit, onClick: () => confirmThenRun(unit.unit, "start", "启动") }),
              h(Btn, { size: "mini", icon: "restart", label: "重启", disabled: busyUnit === unit.unit, onClick: () => confirmThenRun(unit.unit, "restart", "重启") }),
              h(Btn, { size: "mini", icon: "logs", label: "详情", onClick: () => setDetail({ unit: unit.unit, at: Date.now() }) }),
            ),
          ),
        ),
      ),
      filtered.length === 0 && data ? h("div", { className: "dsp-muted dsp-list__empty" }, "没有匹配的服务") : null,
    ),
    detail
      ? h(ServiceDrawer, {
          unit: units.find((u) => u.unit === detail.unit) ?? { unit: detail.unit },
          generation: detail.at,
          guard: props.guard,
          onClose: () => setDetail(null),
          onAction: confirmThenRun,
          busy: busyUnit === detail.unit,
        })
      : null,
  );
}

function ServiceDrawer(props) {
  const unit = props.unit;
  const [logs, setLogs] = useState({ loading: true, lines: [], privileged: null, error: null });
  const [follow, setFollow] = useState(true);
  const preRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const result = await props.guard(() => api(`/services/logs?unit=${enc(unit.unit)}&lines=200`));
        if (!cancelled && result) {
          setLogs({ loading: false, lines: result.lines ?? [], privileged: result.privileged === true, error: null });
          const el = preRef.current;
          if (el) el.scrollTop = el.scrollHeight;
        }
      } catch (err) {
        if (!cancelled) setLogs((prev) => ({ ...prev, loading: false, error: describeError(err) }));
      }
    };
    load();
    const timer = follow ? setInterval(load, LOG_FOLLOW_MS) : null;
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [unit.unit, follow, props.generation]);

  return h(
    Drawer,
    { title: unit.unit, subtitle: unit.description ?? "", onClose: props.onClose },
    h(
      "div",
      { className: "dsp-drawer__section" },
      h(Dot, { tone: unit.active === "active" ? "ok" : unit.active === "failed" ? "err" : "off" }),
      h("span", null, `${unit.active ?? "?"} / ${unit.sub ?? "?"}`),
      h("span", { className: "dsp-muted" }, unit.enabled === true ? "开机自启" : unit.enabled === false ? "不自启" : "自启状态未知"),
    ),
    h(
      "div",
      { className: "dsp-drawer__actions" },
      unit.active === "active"
        ? h(Btn, { icon: "stop", label: "停止", disabled: props.busy, onClick: () => props.onAction(unit.unit, "stop", "停止") })
        : h(Btn, { icon: "play", label: "启动", disabled: props.busy, onClick: () => props.onAction(unit.unit, "start", "启动") }),
      h(Btn, { icon: "restart", label: "重启", disabled: props.busy, onClick: () => props.onAction(unit.unit, "restart", "重启") }),
      h(Btn, { icon: "power", label: unit.enabled === true ? "取消自启" : "设为自启", disabled: props.busy, onClick: () => props.onAction(unit.unit, unit.enabled === true ? "disable" : "enable", unit.enabled === true ? "取消自启" : "设为自启") }),
      h(Btn, { icon: follow ? "check" : "clock", label: follow ? "实时跟随中" : "已暂停", onClick: () => setFollow((v) => !v) }),
    ),
    h(Notice, { text: logs.error }),
    logs.privileged === false && follow ? h("div", { className: "dsp-warn dsp-warn--inline" }, "当前只显示本用户可见的日志；解锁 sudo 后自动切到全量。") : null,
    h("pre", { className: "dsp-log__pre dsp-log__pre--drawer", ref: preRef }, logs.loading && logs.lines.length === 0 ? "读取日志…" : logs.lines.join("\n")),
  );
}

// ---------------------------------------------------------------------------
// 页面：文件
// ---------------------------------------------------------------------------

function FilesPage(props) {
  const active = props.active;
  const [cwd, setCwd] = useState(props.initial?.path ?? null);
  const [listing, setListing] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [loading, setLoading] = useState(false);
  const [editor, setEditor] = useState(null);
  const [prompt, setPrompt] = useState(null);
  const [roots, setRoots] = useState(null);
  const uploadRef = useRef(null);

  const load = async (path) => {
    if (!path) return;
    setLoading(true);
    setError(null);
    try {
      const result = await api(`/files/list?path=${enc(path)}`);
      setListing(result);
      setCwd(result.path);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!active) return undefined;
    let cancelled = false;
    api("/files/roots", { root: false })
      .then((result) => {
        if (cancelled) return;
        setRoots(result);
        if (cwd === null) load(result.home || (result.readRoots ?? [])[0] || "/");
      })
      .catch((err) => {
        if (!cancelled) setError(err);
      });
    return () => {
      cancelled = true;
    };
  }, [active, props.generation, props.identityGeneration]);

  useEffect(() => {
    if (active && cwd && listing === null) load(cwd);
  }, [active, cwd, listing]);

  const currentDir = listing?.path ?? cwd ?? "/";
  const entries = Array.isArray(listing?.entries) ? listing.entries : [];

  const crumbs = (() => {
    const parts = String(currentDir).split("/").filter(Boolean);
    const out = [{ label: "/", path: "/" }];
    let acc = "";
    for (const part of parts) {
      acc += "/" + part;
      out.push({ label: part, path: acc });
    }
    return out;
  })();

  const askSystemWrite = async (target, text, confirmText) => {
    if (!(IDENTITY.root && isSystemPath(target))) return true;
    return props.askConfirm({
      title: "系统文件写入确认",
      text,
      danger: "这是系统目录里的文件，改错可能影响服务启动或系统登录。确认这次改动是你想要的吗？",
      confirmText: confirmText ?? "确认写入",
      onConfirm: async () => {},
    });
  };

  const openEditor = async (entry) => {
    try {
      const result = await props.guard(() => api(`/files/read?path=${enc(entry.path)}`));
      if (result) setEditor({ path: result.path, text: result.text, mtimeMs: result.mtimeMs, error: null });
    } catch (err) {
      setEditor({ path: entry.path, text: "", mtimeMs: null, error: describeError(err) });
    }
  };

  const submitPrompt = async (value) => {
    const kind = prompt?.kind;
    if (kind === "mkdir") {
      const target = joinPath(currentDir, value);
      if (!(await askSystemWrite(target, `将在系统目录创建 ${target}`, "创建"))) return;
      await props.guard(() => api("/files/mkdir", { method: "POST", body: JSON.stringify({ path: target, confirm: true }) }));
      pushEvent("ok", "创建目录 " + target);
      setNotice({ tone: "ok", text: "已创建目录" });
    } else if (kind === "newfile") {
      const target = joinPath(currentDir, value);
      if (!(await askSystemWrite(target, `将在系统目录创建 ${target}`, "创建"))) return;
      await props.guard(() => api(`/files/write?path=${enc(target)}&mtime=null&confirm=1`, { method: "PUT", body: JSON.stringify({ text: "" }) }));
      pushEvent("ok", "创建文件 " + target);
      setNotice({ tone: "ok", text: "已创建文件" });
    } else if (kind === "rename" && prompt?.target) {
      if (!(await askSystemWrite(prompt.target.path, `将重命名 ${prompt.target.path}`, "重命名"))) return;
      await props.guard(() => api("/files/rename", { method: "POST", body: JSON.stringify({ path: prompt.target.path, to: value, confirm: true }) }));
      pushEvent("ok", "重命名 " + baseName(prompt.target.path));
      setNotice({ tone: "ok", text: "已重命名" });
    } else if (kind === "chmod" && prompt?.target) {
      await props.guard(() => api("/files/chmod", { method: "POST", body: JSON.stringify({ path: prompt.target.path, mode: value }) }));
      pushEvent("ok", `chmod ${value} ${prompt.target.path}`);
      setNotice({ tone: "ok", text: "已修改权限" });
    } else if (kind === "chown" && prompt?.target) {
      await props.guard(() => api("/files/chown", { method: "POST", body: JSON.stringify({ path: prompt.target.path, owner: value }) }));
      pushEvent("ok", `chown ${value} ${prompt.target.path}`);
      setNotice({ tone: "ok", text: "已修改属主" });
    }
    setPrompt(null);
    load(currentDir);
  };

  const doUpload = async (fileList) => {
    if (!fileList || fileList.length === 0) return;
    const files = Array.from(fileList);
    for (const file of files) {
      const target = joinPath(currentDir, file.name);
      try {
        if (!(await askSystemWrite(target, `将把 ${file.name} 写入 ${target}`, "确认上传"))) continue;
        const query = `path=${enc(currentDir)}&name=${enc(file.name)}&confirm=1${IDENTITY.root ? "&root=1" : ""}`;
        await props.guard(() =>
          fetch(`${BASE}/files/upload?${query}`, { method: "PUT", body: file, cache: "no-store", credentials: "same-origin" }).then(async (response) => {
            let data = null;
            try {
              data = await response.json();
            } catch {
              data = null;
            }
            if (!response.ok || !data || data.ok !== true) {
              const err = new Error((data && data.message) || `HTTP ${response.status}`);
              err.code = (data && data.error) || `http_${response.status}`;
              throw err;
            }
            return data;
          }),
        );
        pushEvent("ok", `上传 ${file.name}（${formatBytes(file.size)}）`);
        setNotice({ tone: "ok", text: `已上传 ${file.name}` });
      } catch (err) {
        pushEvent("err", `上传 ${file.name} 失败：${describeError(err)}`);
        setNotice({ tone: "error", text: `上传 ${file.name} 失败：${describeError(err)}` });
      }
    }
    if (uploadRef.current) uploadRef.current.value = "";
    load(currentDir);
  };

  const removeEntry = async (entry) => {
    const ok = await props.askConfirm({
      title: "删除确认",
      text: `将删除 ${entry.path}${entry.type === "dir" ? "（及其全部内容）" : ""}`,
      danger: entry.type === "dir" ? "目录会连带内容一起删除，不可恢复。" : "删除后不可恢复。",
      tone: "danger",
      confirmText: "删除",
      onConfirm: async () => {},
    });
    if (!ok) return;
    try {
      await props.guard(() => api("/files/delete", { method: "POST", body: JSON.stringify({ path: entry.path, recursive: entry.type === "dir", confirm: true }) }));
      pushEvent("ok", "删除 " + entry.path);
      setNotice({ tone: "ok", text: "已删除 " + baseName(entry.path) });
      load(currentDir);
    } catch (err) {
      setNotice({ tone: "error", text: describeError(err) });
    }
  };

  const download = (entry) => {
    const anchor = document.createElement("a");
    anchor.href = `${BASE}/files/download?path=${enc(entry.path)}${IDENTITY.root ? "&root=1" : ""}`;
    anchor.download = entry.name;
    anchor.click();
  };

  // 常用位置全部来自 Host 下发的白名单（home 由运行 dsh 的用户决定），不写死路径。
  const quickPaths = ["/etc", "/var/log", ...(roots?.home ? [roots.home] : []), ...(roots?.readRoots ?? [])]
    .filter((v, i, arr) => arr.indexOf(v) === i)
    .slice(0, 8);

  return h(
    "div",
    { className: "dsp-page" },
    h(
      "div",
      { className: "dsp-toolbar" },
      h(Btn, { icon: "chevron", label: "上级", disabled: !listing?.parent, onClick: () => load(listing?.parent ?? "/") }),
      h(
        "div",
        { className: "dsp-crumbs" },
        crumbs.map((crumb, index) =>
          h(
            "span",
            { key: crumb.path, className: "dsp-crumbs__item" },
            index > 0 ? h("span", { className: "dsp-crumbs__sep" }, "/") : null,
            h("button", { className: "dsp-crumbs__btn", type: "button", onClick: () => load(crumb.path) }, crumb.label),
          ),
        ),
      ),
      h(Btn, { icon: "refresh", label: "刷新", onClick: () => load(currentDir) }),
      h(Btn, { icon: "plus", label: "新建文件", onClick: () => setPrompt({ kind: "newfile", title: "新建文件", hint: "位置：" + currentDir, initialValue: "untitled.txt" }) }),
      h(Btn, { icon: "folder", label: "新建目录", onClick: () => setPrompt({ kind: "mkdir", title: "新建目录", hint: "位置：" + currentDir, initialValue: "new-folder" }) }),
      h(Btn, { icon: "upload", label: "上传", onClick: () => uploadRef.current && uploadRef.current.click() }),
      h("input", { ref: uploadRef, type: "file", multiple: true, style: { display: "none" }, onChange: (e) => doUpload(e.target.files) }),
    ),
    h(
      "div",
      { className: "dsp-bookmarks" },
      h("span", { className: "dsp-muted" }, "常用位置"),
      quickPaths.map((p) => h("button", { key: p, className: "dsp-chip", type: "button", onClick: () => load(p) }, p)),
      h("span", { className: IDENTITY.root ? "dsp-chip dsp-chip--on" : "dsp-chip" }, IDENTITY.root ? "身份：root（全盘可读写）" : "身份：普通用户（白名单只读）"),
    ),
    h(Notice, { text: notice?.text, tone: notice?.tone === "ok" ? "ok" : "error" }),
    h(Notice, { text: error ? describeError(error) : null }),
    loading ? h("div", { className: "dsp-muted" }, HOST.t("common.loading", "载入中…")) : null,
    h(
      "div",
      { className: "dsp-list" },
      h(
        "div",
        { className: "dsp-file dsp-file--head" },
        h("span", { className: "dsp-file__name" }, "名称"),
        h("span", { className: "dsp-file__size" }, "大小"),
        h("span", { className: "dsp-file__time" }, "修改时间"),
        h("span", { className: "dsp-file__mode" }, "权限"),
        h("span", { className: "dsp-file__owner" }, "属主"),
        h("span", { className: "dsp-file__actions" }, ""),
      ),
      entries.map((entry) =>
        h(
          "div",
          { key: entry.path, className: "dsp-file" },
          h(
            "button",
            { className: "dsp-file__main", type: "button", title: entry.path, onClick: () => (entry.type === "dir" ? load(entry.path) : openEditor(entry)) },
            h(Icon, { name: entry.type === "dir" ? "folder" : "logs", size: 14 }),
            h("span", { className: "dsp-file__name" }, entry.name),
          ),
          h("span", { className: "dsp-file__size" }, entry.type === "dir" ? "—" : formatBytes(entry.sizeBytes)),
          h("span", { className: "dsp-file__time" }, formatTime(entry.mtimeMs)),
          h("span", { className: "dsp-file__mode" }, entry.mode ?? ""),
          h("span", { className: "dsp-file__owner" }, entry.owner ?? ""),
          h(
            "span",
            { className: "dsp-file__actions" },
            entry.type !== "dir" ? h(Btn, { size: "mini", icon: "pencil", label: "编辑", onClick: () => openEditor(entry) }) : null,
            entry.type !== "dir" ? h(Btn, { size: "mini", icon: "download", label: "下载", onClick: () => download(entry) }) : null,
            h(Btn, { size: "mini", icon: "key", label: "权限", onClick: () => setPrompt({ kind: "chmod", title: "修改权限位", hint: entry.path, initialValue: entry.mode ?? "644", target: entry }) }),
            h(Btn, { size: "mini", icon: "shield", label: "属主", onClick: () => setPrompt({ kind: "chown", title: "修改属主", hint: entry.path + "（如 www-data:www-data）", initialValue: entry.owner ?? "root", target: entry }) }),
            h(Btn, { size: "mini", icon: "chevron", label: "改名", onClick: () => setPrompt({ kind: "rename", title: "重命名", hint: entry.path, initialValue: entry.name, target: entry }) }),
            h(Btn, { size: "mini", icon: "trash", label: "删除", tone: "danger", onClick: () => removeEntry(entry) }),
          ),
        ),
      ),
      entries.length === 0 && !loading ? h("div", { className: "dsp-muted dsp-list__empty" }, "空目录（或无权限查看）") : null,
    ),
    editor ? h(FileEditor, { file: editor, onClose: () => setEditor(null), onSaved: (text) => { pushEvent("ok", text); setNotice({ tone: "ok", text }); load(currentDir); } }) : null,
    prompt ? h(PromptDialog, { title: prompt.title, hint: prompt.hint, initialValue: prompt.initialValue, onClose: () => setPrompt(null), onSubmit: submitPrompt }) : null,
  );
}

function FileEditor(props) {
  const file = props.file;
  const [text, setText] = useState(file?.text ?? "");
  const [mtimeMs, setMtimeMs] = useState(file?.mtimeMs ?? null);
  const [dirty, setDirty] = useState(false);
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setText(file?.text ?? "");
    setMtimeMs(file?.mtimeMs ?? null);
    setDirty(false);
    setStatus(file?.error ? { tone: "error", text: file.error } : null);
  }, [file?.path, file?.text, file?.mtimeMs]);

  const save = async (force) => {
    setBusy(true);
    setStatus(null);
    try {
      const query = `path=${enc(file.path)}&mtime=${force || mtimeMs === null ? "null" : mtimeMs}&confirm=1`;
      const result = await api(`/files/write?${query}`, { method: "PUT", body: JSON.stringify({ text }) });
      setMtimeMs(result.mtimeMs);
      setDirty(false);
      setStatus({ tone: "ok", text: "已保存" });
      props.onSaved(`保存 ${baseName(file.path)}（${formatBytes(result.sizeBytes)}）`);
    } catch (err) {
      if (err.code === "conflict") {
        setStatus({ tone: "error", text: "磁盘上的文件已被别处修改。可以「重新载入」（丢弃这里的改动）或「强制覆盖」。" });
        setMtimeMs(err.detail?.mtimeMs ?? null);
      } else {
        setStatus({ tone: "error", text: describeError(err) });
      }
    } finally {
      setBusy(false);
    }
  };

  const reload = async () => {
    setBusy(true);
    try {
      const result = await api(`/files/read?path=${enc(file.path)}`);
      setText(result.text);
      setMtimeMs(result.mtimeMs);
      setDirty(false);
      setStatus({ tone: "ok", text: "已重新载入" });
    } catch (err) {
      setStatus({ tone: "error", text: describeError(err) });
    } finally {
      setBusy(false);
    }
  };

  return h(
    "div",
    { className: "dsp-editor-overlay" },
    h(
      "header",
      { className: "dsp-editor__head" },
      h("b", { className: "dsp-editor__title" }, file.path),
      dirty ? h("span", { className: "dsp-dirty" }, "未保存") : null,
      h("span", { className: "dsp-muted" }, mtimeMs ? "mtime " + formatTime(mtimeMs) : ""),
      file.error ? h("span", { className: "dsp-warn dsp-warn--inline" }, file.error) : null,
      h(
        "span",
        { className: "dsp-editor__actions" },
        h(Btn, { label: "重新载入", onClick: reload, disabled: busy }),
        h(Btn, { label: "强制覆盖", onClick: () => save(true), disabled: busy }),
        h(Btn, { label: busy ? "保存中…" : HOST.t("common.save", "保存"), tone: "primary", onClick: () => save(false), disabled: busy || !dirty }),
        h(Btn, { label: HOST.t("common.close", "关闭"), onClick: props.onClose }),
      ),
    ),
    h(Notice, { text: status?.text, tone: status?.tone === "ok" ? "ok" : "error" }),
    h("textarea", { className: "dsp-editor", value: text, spellCheck: false, onChange: (e) => { setText(e.target.value); setDirty(true); } }),
  );
}

// ---------------------------------------------------------------------------
// 页面：日志
// ---------------------------------------------------------------------------

function LogsPage(props) {
  const active = props.active;
  const [unit, setUnit] = useState("");
  const [filter, setFilter] = useState("");
  const [lines, setLines] = useState("200");
  const [follow, setFollow] = useState(true);
  const [state, setState] = useState({ loading: false, data: null, error: null });
  const services = usePoll(active, SERVICES_POLL_MS, () => api("/services", { root: false }));
  const preRef = useRef(null);
  const pinnedRef = useRef(true);

  const load = async () => {
    if (!unit) return;
    setState((prev) => ({ ...prev, loading: true }));
    try {
      const result = await props.guard(() => api(`/services/logs?unit=${enc(unit)}&lines=${enc(lines)}`));
      if (result) {
        setState({ loading: false, data: result, error: null });
        const el = preRef.current;
        if (el && pinnedRef.current) el.scrollTop = el.scrollHeight;
      } else {
        setState((prev) => ({ ...prev, loading: false }));
      }
    } catch (err) {
      setState((prev) => ({ ...prev, loading: false, error: describeError(err) }));
    }
  };

  useEffect(() => {
    if (!active || !unit) return undefined;
    load();
    if (!follow) return undefined;
    const timer = setInterval(load, LOG_FOLLOW_MS);
    return () => clearInterval(timer);
  }, [active, unit, lines, follow, props.generation]);

  const filteredLines = useMemo(() => {
    const all = state.data?.lines ?? [];
    const needle = filter.trim().toLowerCase();
    return needle ? all.filter((line) => line.toLowerCase().includes(needle)) : all;
  }, [state.data, filter]);

  const units = Array.isArray(services.data?.units) ? services.data.units : [];

  return h(
    "div",
    { className: "dsp-page dsp-page--fill" },
    h(
      "div",
      { className: "dsp-toolbar" },
      h("label", { className: "dsp-search" }, h(Icon, { name: "logs", size: 14 }), h("input", { value: unit, placeholder: "单元名，如 ssh.service", spellCheck: false, list: "dsp-units", onChange: (e) => setUnit(e.target.value), onKeyDown: (e) => { if (e.key === "Enter") load(); } })),
      h("datalist", { id: "dsp-units" }, units.slice(0, 300).map((u) => h("option", { key: u.unit, value: u.unit }))),
      h("label", { className: "dsp-search" }, h(Icon, { name: "search", size: 14 }), h("input", { value: filter, placeholder: "关键字过滤（本地）", spellCheck: false, onChange: (e) => setFilter(e.target.value) })),
      h("select", { className: "dsp-select", value: lines, onChange: (e) => setLines(e.target.value) }, ["100", "200", "500", "1000"].map((v) => h("option", { key: v, value: v }, v + " 行"))),
      h(Btn, { icon: follow ? "check" : "clock", label: follow ? "实时跟随" : "已暂停", onClick: () => setFollow((v) => !v) }),
      h(Btn, { icon: "refresh", label: "刷新", onClick: load, disabled: !unit }),
    ),
    h(Notice, { text: state.error }),
    state.data?.privileged === false ? h("div", { className: "dsp-warn dsp-warn--inline" }, "当前只显示本用户可见的日志；解锁 sudo 后是全量。") : null,
    h(
      "pre",
      {
        className: "dsp-log__pre dsp-log__pre--page",
        ref: preRef,
        onScroll: (e) => {
          const el = e.currentTarget;
          pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        },
      },
      !unit ? "选择一个单元（也可以直接在左边输入，回车加载）" : filteredLines.length === 0 ? "没有日志条目" : filteredLines.join("\n"),
    ),
  );
}

// ---------------------------------------------------------------------------
// 页面：软件包
// ---------------------------------------------------------------------------

function PackagesPage(props) {
  const active = props.active;
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(false);
  const [installedQuery, setInstalledQuery] = useState("");
  const upgradable = usePoll(active, PACKAGES_POLL_MS, () => api("/packages/upgradable", { root: false }));

  const run = async (label, fn) => {
    setBusy(true);
    setNotice(null);
    try {
      const result = await props.guard(fn);
      if (result) {
        pushEvent("ok", label + "完成");
        setNotice({ tone: "ok", text: label + "完成" });
        upgradable.reload();
      }
    } catch (err) {
      pushEvent("err", label + "失败：" + describeError(err));
      setNotice({ tone: "error", text: label + "失败：" + describeError(err) });
    } finally {
      setBusy(false);
    }
  };

  const packages = Array.isArray(upgradable.data?.packages) ? upgradable.data.packages : [];
  const summary = upgradable.data?.summary ?? null;
  const indexAge = upgradable.data?.indexUpdatedAt ?? null;

  return h(
    "div",
    { className: "dsp-page" },
    h(
      "div",
      { className: "dsp-toolbar" },
      h("span", { className: "dsp-badge" + (packages.length > 0 ? " dsp-badge--warn" : "") }, packages.length > 0 ? `${packages.length} 个可升级` : "已是最新"),
      h("span", { className: "dsp-muted" }, indexAge ? "索引更新时间 " + formatTime(indexAge) : "索引时间未知"),
      h(Btn, { icon: "refresh", label: "刷新索引", disabled: busy, onClick: () => run("刷新索引", () => api("/packages/update-index", { method: "POST" })) }),
      h(Btn, {
        icon: "upload",
        label: "全部升级",
        tone: "primary",
        disabled: busy || packages.length === 0,
        onClick: () =>
          props.askConfirm({
            title: "升级全部软件包",
            text: `将执行 apt-get upgrade，升级 ${packages.length} 个包。`,
            danger: "升级期间相关服务可能短暂重启；请勿在此期间关闭面板。",
            confirmText: "开始升级",
            onConfirm: () => run("全部升级", () => api("/packages/upgrade", { method: "POST", body: JSON.stringify({ all: true }) })),
          }),
      }),
      h(Btn, { icon: "refresh", label: "刷新列表", onClick: upgradable.reload }),
    ),
    h(Notice, { text: notice?.text, tone: notice?.tone === "ok" ? "ok" : "error" }),
    h(Notice, { text: upgradable.error ? describeError(upgradable.error) : null }),
    summary ? h("div", { className: "dsp-muted" }, `模拟结果：升级 ${summary.upgraded} · 新装 ${summary.newlyInstalled} · 移除 ${summary.toRemove} · 保持 ${summary.notUpgraded}`) : null,
    h(
      "div",
      { className: "dsp-list" },
      h("div", { className: "dsp-file dsp-file--head" }, h("span", { className: "dsp-file__name" }, "软件包"), h("span", { className: "dsp-file__ver" }, "当前版本"), h("span", { className: "dsp-file__ver" }, "可升级到"), h("span", { className: "dsp-file__actions" }, "")),
      packages.map((pkg) =>
        h(
          "div",
          { key: pkg.name, className: "dsp-file" },
          h("span", { className: "dsp-file__name" }, pkg.name),
          h("span", { className: "dsp-file__ver" }, pkg.current),
          h("span", { className: "dsp-file__ver dsp-file__ver--new" }, pkg.candidate),
          h("span", { className: "dsp-file__actions" }, h(Btn, { size: "mini", icon: "upload", label: "升级", disabled: busy, onClick: () => run(`升级 ${pkg.name}`, () => api("/packages/upgrade", { method: "POST", body: JSON.stringify({ names: [pkg.name] }) })) })),
        ),
      ),
      packages.length === 0 ? h("div", { className: "dsp-muted dsp-list__empty" }, "没有可升级的软件包（索引很旧时先点「刷新索引」）") : null,
    ),
    h(
      Tile,
      { title: "已安装查询", wide: true },
      h("label", { className: "dsp-search" }, h(Icon, { name: "search", size: 14 }), h("input", { value: installedQuery, placeholder: "输入包名关键字（回车查询）", spellCheck: false, onChange: (e) => setInstalledQuery(e.target.value) })),
      h(InstalledList, { query: installedQuery, active }),
    ),
  );
}

function InstalledList(props) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    if (!props.active || !props.query || props.query.trim().length === 0) return undefined;
    let cancelled = false;
    api(`/packages/installed?filter=${enc(props.query.trim())}&limit=100`, { root: false })
      .then((result) => {
        if (!cancelled) {
          setData(result);
          setError(null);
        }
      })
      .catch((err) => {
        if (!cancelled) setError(err);
      });
    return () => {
      cancelled = true;
    };
  }, [props.query, props.active]);
  if (!props.query) return h("div", { className: "dsp-muted" }, "输入关键字搜索已安装的包");
  if (error) return h(Notice, { text: describeError(error) });
  if (!data) return h("div", { className: "dsp-muted" }, "查询中…");
  return h(
    "div",
    { className: "dsp-installed" },
    h("div", { className: "dsp-muted" }, `共 ${data.total} 个匹配，显示前 ${data.packages.length} 个`),
    data.packages.map((pkg) => h("div", { key: pkg.name, className: "dsp-installed__row" }, h("b", null, pkg.name), h("span", { className: "dsp-muted" }, pkg.version), h("span", { className: "dsp-installed__summary" }, pkg.summary))),
  );
}

// ---------------------------------------------------------------------------
// 页面：网络
// ---------------------------------------------------------------------------

function NetworkPage(props) {
  const active = props.active;
  const live = usePoll(active, OVERVIEW_POLL_MS, () => api("/overview", { root: false }));
  const net = usePoll(active, NETWORK_POLL_MS, () => api("/network/overview"));

  const rates = new Map((live.data?.network?.interfaces ?? []).map((i) => [i.name, i]));
  const interfaces = net.data?.interfaces ?? [];
  const listeners = net.data?.listeners ?? [];
  const connections = net.data?.connections ?? [];

  return h(
    "div",
    { className: "dsp-page" },
    h(Notice, { text: net.error ? describeError(net.error) : null }),
    h(
      "div",
      { className: "dsp-tiles" },
      interfaces.map((iface) => {
        const rate = rates.get(iface.name);
        return h(
          Tile,
          { key: iface.name, title: iface.name, aside: iface.state ?? "", value: rate ? formatRate(rate.rxBytesPerSec) : "—" },
          h("div", { className: "dsp-muted" }, (iface.addresses ?? []).filter((a) => a.family === "inet").map((a) => `${a.local}/${a.prefixlen}`).join("  ") || "无 IPv4"),
          h("div", { className: "dsp-muted" }, rate ? `↑ ${formatRate(rate.txBytesPerSec)} · 累计 ↓${formatBytes(rate.rxTotalBytes)}` : ""),
        );
      }),
    ),
    net.data?.defaultRoute ? h("div", { className: "dsp-muted" }, `默认路由：${net.data.defaultRoute.gateway ?? "—"} via ${net.data.defaultRoute.device ?? "—"}`) : null,
    h(
      Tile,
      { title: "监听端口", aside: net.data?.listenersPrivileged ? "root 视角（含全部进程名）" : "解锁 sudo 后可见其他用户的进程名", wide: true },
      h(
        "div",
        { className: "dsp-list dsp-list--flush" },
        h("div", { className: "dsp-file dsp-file--head" }, h("span", { className: "dsp-file__proto" }, "协议"), h("span", { className: "dsp-file__addr" }, "监听地址"), h("span", { className: "dsp-file__proc" }, "进程"), h("span", { className: "dsp-file__pid" }, "PID")),
        listeners.slice(0, 60).map((row, index) =>
          h(
            "div",
            { key: row.proto + row.localHost + row.localPort + index, className: "dsp-file" },
            h("span", { className: "dsp-file__proto" }, row.proto),
            h("span", { className: "dsp-file__addr" }, `${row.localHost}:${row.localPort}`),
            h("span", { className: "dsp-file__proc" }, row.process ?? "—"),
            h("span", { className: "dsp-file__pid" }, row.pid ?? "—"),
          ),
        ),
        listeners.length === 0 ? h("div", { className: "dsp-muted dsp-list__empty" }, "没有监听端口") : null,
      ),
    ),
    h(
      "div",
      { className: "dsp-columns" },
      h(
        Tile,
        { title: "已建立连接", aside: `共 ${net.data?.connectionsTotal ?? 0}`, wide: true },
        connections.length === 0
          ? h("div", { className: "dsp-muted" }, "当前没有已建立的连接")
          : connections.map((row) => h("div", { key: row.host, className: "dsp-netrow" }, h("b", null, row.host), h("span", { className: "dsp-netrow__rate" }, row.count + " 条"), h("span", { className: "dsp-muted" }, (row.ports ?? []).join(", ")))),
      ),
      h(Tile, { title: "防火墙", wide: true }, net.data?.firewall?.available ? h("pre", { className: "dsp-log__pre" }, net.data.firewall.output) : h("div", { className: "dsp-muted" }, net.data?.firewall?.message ?? "不可用")),
    ),
  );
}

// ---------------------------------------------------------------------------
// 页面：终端（WebSocket + 真 PTY）
// ---------------------------------------------------------------------------
//
// 渲染模型是"行缓冲 + ANSI 子集"：处理 CR/LF/BS/TAB、SGR 颜色、清行、清屏，
// 忽略光标定位类序列。因此 `ls --color`、`systemctl status`、`apt`、`journalctl`
// 这类输出正常；htop/top 这类全屏 TUI 会出现残影（界面上已如实提示）。
// 真正的交互（键盘、粘贴、窗口尺寸）全部透传给 PTY。

const TERM_MAX_LINES = 2000;

function createTermState(cols = 100) {
  return { lines: [{ spans: [] }], style: {}, cols };
}

const SGR_FG = {
  30: "black", 31: "red", 32: "green", 33: "yellow", 34: "blue", 35: "magenta", 36: "cyan", 37: "white",
  90: "bright-black", 91: "bright-red", 92: "bright-green", 93: "bright-yellow",
  94: "bright-blue", 95: "bright-magenta", 96: "bright-cyan", 97: "bright-white",
};
const SGR_BG = {
  40: "black", 41: "red", 42: "green", 43: "yellow", 44: "blue", 45: "magenta", 46: "cyan", 47: "white",
  100: "bright-black", 101: "bright-red", 102: "bright-green", 103: "bright-yellow",
  104: "bright-blue", 105: "bright-magenta", 106: "bright-cyan", 107: "bright-white",
};

function termStyleClass(style) {
  const cls = [];
  if (style.fg) cls.push("dsp-term--fg-" + style.fg);
  if (style.bg) cls.push("dsp-term--bg-" + style.bg);
  if (style.bold) cls.push("dsp-term--bold");
  if (style.dim) cls.push("dsp-term--dim");
  if (style.underline) cls.push("dsp-term--underline");
  if (style.reverse) cls.push("dsp-term--reverse");
  return cls.join(" ");
}

function termPush(state, text) {
  if (!text) return;
  const line = state.lines[state.lines.length - 1];
  const cls = termStyleClass(state.style);
  const last = line.spans[line.spans.length - 1];
  if (last && last.cls === cls) last.text += text;
  else line.spans.push({ cls, text });
}

function termNewLine(state) {
  state.lines.push({ spans: [] });
  if (state.lines.length > TERM_MAX_LINES) state.lines.splice(0, state.lines.length - TERM_MAX_LINES);
}

function termApplySgr(state, codes) {
  const list = codes.length === 0 ? [0] : codes;
  for (const code of list) {
    if (code === 0) state.style = {};
    else if (code === 1) state.style.bold = true;
    else if (code === 2) state.style.dim = true;
    else if (code === 4) state.style.underline = true;
    else if (code === 7) state.style.reverse = true;
    else if (code === 22) {
      delete state.style.bold;
      delete state.style.dim;
    } else if (code === 24) delete state.style.underline;
    else if (code === 27) delete state.style.reverse;
    else if (code === 39) delete state.style.fg;
    else if (code === 49) delete state.style.bg;
    else if (SGR_FG[code]) state.style.fg = SGR_FG[code];
    else if (SGR_BG[code]) state.style.bg = SGR_BG[code];
    // 38/48（256 色与真彩）与其余属性：行缓冲模型里忽略，不影响可读性。
  }
}

/** 把一段 PTY 输出吃进行缓冲状态（纯函数式：就地改 state 并返回它）。 */
function parseAnsi(state, text) {
  const src = String(text ?? "");
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === "\u001b") {
      const rest = src.slice(i);
      const csi = /^\u001b\[([0-9;?]*)([A-Za-z@])/.exec(rest);
      if (csi) {
        const params = csi[1]
          .split(";")
          .filter((part) => part !== "")
          .map(Number);
        const final = csi[2];
        if (final === "m") termApplySgr(state, params);
        else if (final === "K") state.lines[state.lines.length - 1].spans = [];
        else if (final === "J" && (params.length === 0 || params[0] === 2)) state.lines = [{ spans: [] }];
        i += csi[0].length;
        continue;
      }
      const osc = /^\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/.exec(rest);
      if (osc) {
        i += osc[0].length;
        continue;
      }
      i += 1;
      continue;
    }
    if (ch === "\n") {
      termNewLine(state);
      i += 1;
      continue;
    }
    if (ch === "\r") {
      state.lines[state.lines.length - 1].spans = [];
      i += 1;
      continue;
    }
    if (ch === "\b") {
      const line = state.lines[state.lines.length - 1];
      const last = line.spans[line.spans.length - 1];
      if (last) {
        last.text = last.text.slice(0, -1);
        if (last.text.length === 0) line.spans.pop();
      }
      i += 1;
      continue;
    }
    if (ch === "\t") {
      termPush(state, "    ");
      i += 1;
      continue;
    }
    if (ch === "\u0007" || ch === "\u0000") {
      i += 1;
      continue;
    }
    const run = /^[^\u001b\n\r\b\t\u0007\u0000]+/.exec(src.slice(i));
    termPush(state, run[0]);
    i += run[0].length;
  }
  return state;
}

function TerminalView(props) {
  const stateRef = useRef(createTermState());
  const [, bump] = useState(0);
  const containerRef = useRef(null);
  const screenRef = useRef(null);
  const charRef = useRef(null);
  const socketRef = useRef(null);
  const rafRef = useRef(0);
  const pinnedRef = useRef(true);
  const [status, setStatus] = useState({ state: "connecting", message: null });
  const [focused, setFocused] = useState(false);

  const scheduleRepaint = () => {
    if (rafRef.current) return;
    const run = () => {
      rafRef.current = 0;
      bump((n) => n + 1);
      const el = screenRef.current;
      if (el && pinnedRef.current) el.scrollTop = el.scrollHeight;
    };
    rafRef.current = typeof requestAnimationFrame === "function" ? requestAnimationFrame(run) : setTimeout(run, 33);
  };

  useEffect(() => {
    const protocol = typeof location !== "undefined" && location.protocol === "https:" ? "wss:" : "ws:";
    const host = typeof location !== "undefined" ? location.host : "127.0.0.1:3080";
    const url = `${protocol}//${host}${BASE}/terminal?shell=${props.shell}&cols=100&rows=30`;
    let socket;
    let closedByUs = false;
    try {
      socket = new WebSocket(url);
    } catch (error) {
      setStatus({ state: "error", message: String(error?.message ?? error) });
      return undefined;
    }
    socketRef.current = socket;
    socket.onopen = () => setStatus((prev) => (prev.state === "open" ? prev : { state: "open", message: null }));
    socket.onmessage = (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (message.t === "output") {
        parseAnsi(stateRef.current, message.d);
        scheduleRepaint();
      } else if (message.t === "ready") {
        setStatus({ state: "open", message: `pid ${message.pid}${message.shell === "root" ? " · root" : ""}` });
      } else if (message.t === "exit") {
        setStatus({ state: "exited", message: `已退出（code ${message.code}）` });
      } else if (message.t === "error") {
        setStatus({ state: "error", message: message.message });
      }
    };
    socket.onclose = () => {
      if (!closedByUs) setStatus((prev) => (prev.state === "exited" || prev.state === "error" ? prev : { state: "closed", message: "连接已关闭" }));
    };
    socket.onerror = () => setStatus((prev) => (prev.state === "error" ? prev : { state: "error", message: "WebSocket 连接失败（认证或接口未生效）" }));
    return () => {
      closedByUs = true;
      try {
        socket.close();
      } catch {
        // 忽略。
      }
      socketRef.current = null;
    };
  }, [props.shell, props.tabKey]);

  useEffect(() => {
    if (typeof ResizeObserver !== "function") return undefined;
    const element = containerRef.current;
    if (!element) return undefined;
    const measure = () => {
      const char = charRef.current;
      const screen = screenRef.current;
      if (!char || !screen) return;
      const rect = char.getBoundingClientRect();
      const width = rect.width > 0 ? rect.width : 7;
      const height = rect.height > 0 ? rect.height : 17;
      const cols = Math.max(20, Math.floor((screen.clientWidth - 20) / width));
      const rows = Math.max(5, Math.floor((screen.clientHeight - 16) / height));
      const socket = socketRef.current;
      if (socket && socket.readyState === 1) socket.send(JSON.stringify({ t: "resize", cols, rows }));
    };
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    const timer = setTimeout(measure, 80);
    return () => {
      observer.disconnect();
      clearTimeout(timer);
    };
  }, []);

  const send = (data) => {
    const socket = socketRef.current;
    if (socket && socket.readyState === 1) socket.send(JSON.stringify({ t: "input", d: data }));
  };

  const onKeyDown = (event) => {
    if (event.metaKey || event.altKey) return;
    const key = event.key;
    if (event.ctrlKey && key.length === 1) {
      const code = key.toUpperCase().charCodeAt(0);
      if (code >= 64 && code < 128) {
        send(String.fromCharCode(code - 64));
        event.preventDefault();
      }
      return;
    }
    switch (key) {
      case "Enter":
        send("\r");
        break;
      case "Backspace":
        send("\u007f");
        break;
      case "Tab":
        send("\t");
        break;
      case "Escape":
        send("\u001b");
        break;
      case "ArrowUp":
        send("\u001b[A");
        break;
      case "ArrowDown":
        send("\u001b[B");
        break;
      case "ArrowRight":
        send("\u001b[C");
        break;
      case "ArrowLeft":
        send("\u001b[D");
        break;
      case "Home":
        send("\u001b[H");
        break;
      case "End":
        send("\u001b[F");
        break;
      case "Delete":
        send("\u001b[3~");
        break;
      default:
        if (key.length !== 1) return;
        send(key);
    }
    event.preventDefault();
  };

  const onPaste = (event) => {
    const text = event.clipboardData?.getData("text");
    if (text) {
      send(text);
      event.preventDefault();
    }
  };

  const lines = stateRef.current.lines;
  const badge = status.state === "open" ? "已连接" : status.state === "exited" ? "已退出" : status.state === "connecting" ? "连接中…" : "未连接";

  return h(
    "div",
    { className: "dsp-term", ref: containerRef },
    h(
      "div",
      { className: "dsp-term__bar" },
      h("span", { className: "dsp-term__badge dsp-term__badge--" + status.state }, badge),
      status.message ? h("span", { className: "dsp-muted" }, status.message) : null,
      h("span", { className: "dsp-muted" }, focused ? "键盘已接管（Ctrl+D 退出 / Ctrl+C 中断）" : "点击下方区域接管键盘"),
      h("span", { className: "dsp-term__hint" }, "全屏 TUI（htop 类）显示不保证"),
    ),
    h(
      "div",
      {
        className: "dsp-term__screen",
        ref: screenRef,
        tabIndex: 0,
        onKeyDown,
        onPaste,
        onFocus: () => setFocused(true),
        onBlur: () => setFocused(false),
        onClick: () => screenRef.current?.focus(),
        onScroll: (e) => {
          const el = e.currentTarget;
          pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        },
      },
      lines.map((line, index) =>
        h(
          "div",
          { key: index, className: "dsp-term__line" },
          line.spans.length === 0
            ? "\u00a0"
            : line.spans.map((span, spanIndex) => h("span", { key: spanIndex, className: span.cls || undefined }, span.text)),
        ),
      ),
      focused ? h("span", { className: "dsp-term__caret" }) : null,
    ),
    h("span", { className: "dsp-term__char", ref: charRef }, "W"),
  );
}

function TerminalPage(props) {
  const [tabs, setTabs] = useState(() => [{ key: 1, shell: IDENTITY.root ? "root" : "user" }]);
  const [active, setActive] = useState(1);
  const [counter, setCounter] = useState(2);
  const [notice, setNotice] = useState(null);

  const addTab = (shell) => {
    setTabs((list) => [...list, { key: counter, shell }]);
    setActive(counter);
    setCounter((n) => n + 1);
  };

  const closeTab = (key) => {
    setTabs((list) => {
      const next = list.filter((tab) => tab.key !== key);
      if (next.length > 0) {
        if (active === key) setActive(next[next.length - 1].key);
        return next;
      }
      const fresh = { key: counter, shell: IDENTITY.root ? "root" : "user" };
      setActive(counter);
      setCounter((n) => n + 1);
      return [fresh];
    });
  };

  return h(
    "div",
    { className: "dsp-page dsp-page--fill" },
    h(
      "div",
      { className: "dsp-toolbar" },
      h(
        "div",
        { className: "dsp-segment" },
        tabs.map((tab) =>
          h(
            "button",
            { key: tab.key, className: "dsp-segment__btn" + (active === tab.key ? " dsp-segment__btn--active" : ""), type: "button", onClick: () => setActive(tab.key) },
            h(Icon, { name: "terminal", size: 12 }),
            `${tab.shell === "root" ? "root" : "shell"} #${tab.key}`,
            h("span", { className: "dsp-segment__count", title: "关闭这个会话", onClick: (e) => { e.stopPropagation(); closeTab(tab.key); } }, "×"),
          ),
        ),
      ),
      h(Btn, { icon: "plus", label: "普通 shell", onClick: () => addTab("user") }),
      h(Btn, { icon: "unlock", label: "root shell", onClick: () => addTab("root") }),
      h("span", { className: "dsp-muted" }, IDENTITY.root ? "已解锁：root 会话免密直进" : "root 会话会在终端里向你要 sudo 密码"),
    ),
    h(Notice, { text: notice }),
    tabs.map((tab) =>
      h("div", { key: tab.key, className: "dsp-term__tab" + (active === tab.key ? "" : " dsp-term__tab--hidden") }, h(TerminalView, { shell: tab.shell, tabKey: tab.key })),
    ),
  );
}

// ---------------------------------------------------------------------------
// 面板外壳
// ---------------------------------------------------------------------------

const NAV = [
  { id: "overview", icon: "gauge", key: "nav.overview", fallback: "总览" },
  { id: "services", icon: "services", key: "nav.services", fallback: "服务" },
  { id: "files", icon: "folder", key: "nav.files", fallback: "文件" },
  { id: "logs", icon: "logs", key: "nav.logs", fallback: "日志" },
  { id: "packages", icon: "packages", key: "nav.packages", fallback: "软件包" },
  { id: "network", icon: "network", key: "nav.network", fallback: "网络" },
  { id: "terminal", icon: "terminal", key: "nav.terminal", fallback: "终端" },
];

function ServerPanel() {
  const active = usePanelActive();
  const [page, setPage] = useState("overview");
  const [pageInit, setPageInit] = useState(null);
  const [sudoState, setSudoState] = useState({ unlocked: false, expiresAt: null });
  const [identityGeneration, setIdentityGeneration] = useState(0);
  const [unlockOpen, setUnlockOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [confirm, setConfirm] = useState(null);
  const [generation, setGeneration] = useState(0);
  const [paused, setPaused] = useState(false);
  const pendingRef = useRef(null);
  const header = usePoll(active && !paused, 5000, () => api("/overview", { root: false }));

  IDENTITY.root = sudoState.unlocked === true;

  const refreshSudo = async () => {
    try {
      const state = await api("/sudo/state", { root: false });
      setSudoState({ unlocked: state.unlocked === true, expiresAt: state.expiresAt ?? null });
    } catch {
      setSudoState({ unlocked: false, expiresAt: null });
    }
  };

  useEffect(() => {
    if (!active) return undefined;
    refreshSudo();
    const timer = setInterval(refreshSudo, 10000);
    timer.unref?.();
    return () => clearInterval(timer);
  }, [active]);

  useEffect(() => {
    const onKey = (event) => {
      if ((event.metaKey || event.ctrlKey) && String(event.key).toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen(true);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const askConfirm = (options) =>
    new Promise((resolve) => {
      setConfirm({
        title: options.title,
        text: options.text,
        danger: options.danger,
        tone: options.tone,
        confirmText: options.confirmText,
        onConfirm: async () => {
          try {
            await options.onConfirm?.();
          } finally {
            setConfirm(null);
            resolve(true);
          }
        },
        onClose: () => {
          setConfirm(null);
          resolve(false);
        },
      });
    });

  const guard = async (fn) => {
    try {
      return await fn();
    } catch (err) {
      if (err?.code === "locked") {
        pendingRef.current = fn;
        setUnlockOpen(true);
        return null;
      }
      throw err;
    }
  };

  const onUnlock = async (password) => {
    await api("/sudo/unlock", { method: "POST", body: JSON.stringify({ password }), root: false });
    setUnlockOpen(false);
    await refreshSudo();
    IDENTITY.root = true;
    pushEvent("ok", "已解锁 root");
    setIdentityGeneration((g) => g + 1);
    const pending = pendingRef.current;
    pendingRef.current = null;
    if (pending) {
      try {
        await pending();
      } catch {
        // 各页自己的错误条会呈现结果。
      }
      setGeneration((g) => g + 1);
    }
  };

  const onLock = async () => {
    try {
      await api("/sudo/lock", { method: "POST", root: false });
      pushEvent("ok", "已锁定 root");
    } catch {
      // 锁定失败也要把界面切回未解锁。
    }
    IDENTITY.root = false;
    setSudoState({ unlocked: false, expiresAt: null });
    setIdentityGeneration((g) => g + 1);
    setGeneration((g) => g + 1);
  };

  const go = (target, init) => {
    setPage(target);
    setPageInit(init ?? null);
  };

  const quickAction = (unit, action) => {
    const run = async () => {
      try {
        const result = await guard(() => api("/services/action", { method: "POST", body: JSON.stringify({ unit, action }), root: false }));
        if (result) {
          pushEvent("ok", `${action === "restart" ? "重启" : action} ${unit} 完成`);
          setGeneration((g) => g + 1);
        }
      } catch (err) {
        pushEvent("err", `${unit} 操作失败：${describeError(err)}`);
      }
    };
    if (isDangerUnit(unit)) {
      askConfirm({ title: `重启 ${unit}`, text: "这是高危单元。", danger: "可能切断你当前的 SSH 隧道连接，导致面板失联。", tone: "danger", confirmText: "重启", onConfirm: run });
      return;
    }
    run();
  };

  const commands = [
    ...NAV.map((item) => ({
      id: "nav-" + item.id,
      title: `打开「${HOST.t(item.key, item.fallback)}」`,
      hint: "页面",
      icon: item.icon,
      keywords: item.id + " " + item.fallback,
      run: () => go(item.id, null),
    })),
    { id: "sudo-unlock", title: "解锁 sudo（切换 root 身份）", icon: "unlock", keywords: "root sudo 解锁 提权", run: () => setUnlockOpen(true) },
    { id: "sudo-lock", title: "锁定 root", icon: "lock", keywords: "锁定 退出 root", run: onLock },
    { id: "refresh", title: "刷新当前页面", icon: "refresh", keywords: "刷新 reload", run: () => setGeneration((g) => g + 1) },
    { id: "pause", title: paused ? "恢复自动刷新" : "暂停自动刷新", icon: "clock", keywords: "暂停 刷新 polling", run: () => setPaused((v) => !v) },
    { id: "open-etc", title: "打开 /etc", icon: "folder", keywords: "配置 目录", run: () => go("files", { path: "/etc" }) },
    { id: "open-varlog", title: "打开 /var/log", icon: "folder", keywords: "日志 目录", run: () => go("files", { path: "/var/log" }) },
    { id: "apt-update", title: "刷新 apt 索引", icon: "refresh", keywords: "软件包 更新 apt update", run: () => guard(() => api("/packages/update-index", { method: "POST" })).then((r) => r && pushEvent("ok", "apt 索引已刷新")) },
    {
      id: "upgrade-all",
      title: "升级全部软件包",
      icon: "upload",
      keywords: "apt upgrade 更新 安全补丁",
      run: () =>
        askConfirm({
          title: "升级全部软件包",
          text: "将执行 apt-get upgrade。",
          danger: "升级期间相关服务可能短暂重启。",
          confirmText: "开始升级",
          onConfirm: () => guard(() => api("/packages/upgrade", { method: "POST", body: JSON.stringify({ all: true }) })).then((r) => r && pushEvent("ok", "全部升级完成")),
        }),
    },
  ];

  const host = header.data?.host ?? {};
  const cpuLoad = (header.data?.cpu?.load ?? []).map((v) => (Number.isFinite(v) ? v.toFixed(2) : "—")).join(" / ");

  return h(
    "div",
    { className: "dsp-root" },
    h(
      "header",
      { className: "dsp-topbar" },
      h("div", { className: "dsp-topbar__host" }, h(Icon, { name: "server", size: 16 }), h("b", null, host.hostname ?? "服务器")),
      h(
        "div",
        { className: "dsp-topbar__meta" },
        host.distro ? h("span", { className: "dsp-muted" }, host.distro) : null,
        header.data ? h("span", { className: "dsp-muted" }, `负载 ${cpuLoad}`) : null,
        header.data ? h("span", { className: "dsp-muted" }, `内存 ${formatPct(header.data.memory?.usedPct)}`) : null,
      ),
      h(
        "button",
        { className: "dsp-palette-trigger", type: "button", onClick: () => setPaletteOpen(true) },
        h(Icon, { name: "search", size: 14 }),
        h("span", null, "命令面板"),
        h("kbd", null, "⌘K"),
      ),
      h(Btn, { size: "mini", icon: paused ? "play" : "clock", label: paused ? "已暂停" : "自动刷新", onClick: () => setPaused((v) => !v) }),
      sudoState.unlocked
        ? h(SudoCapsuleOn, { sudoState, onLock })
        : h(
            "button",
            { className: "dsp-capsule", type: "button", onClick: () => setUnlockOpen(true), title: "输入 sudo 密码后所有模块都以 root 执行" },
            h(Icon, { name: "lock", size: 14 }),
            h("span", null, HOST.t("sudo.locked", "未解锁")),
          ),
    ),
    h(
      "div",
      { className: "dsp-main" },
      h(
        "nav",
        { className: "dsp-nav" },
        NAV.map((item) =>
          h(
            "button",
            { key: item.id, className: "dsp-nav__btn" + (page === item.id ? " dsp-nav__btn--active" : ""), type: "button", onClick: () => go(item.id, null) },
            h(Icon, { name: item.icon, size: 16 }),
            h("span", null, HOST.t(item.key, item.fallback)),
          ),
        ),
      ),
      h(
        "section",
        { className: "dsp-content" },
        page === "overview" ? h(OverviewPage, { active: active && !paused, go, quickAction, generation }) : null,
        page === "services" ? h(ServicesPage, { active: active && !paused, guard, initial: pageInit, askConfirm, generation }) : null,
        page === "files" ? h(FilesPage, { active, guard, initial: pageInit, askConfirm, generation, identityGeneration }) : null,
        page === "logs" ? h(LogsPage, { active, guard, generation }) : null,
        page === "packages" ? h(PackagesPage, { active, guard, askConfirm, generation }) : null,
        page === "network" ? h(NetworkPage, { active, guard, generation }) : null,
        page === "terminal" ? h(TerminalPage, { active }) : null,
      ),
    ),
    unlockOpen ? h(UnlockDialog, { onClose: () => setUnlockOpen(false), onUnlock }) : null,
    paletteOpen ? h(CommandPalette, { commands, onClose: () => setPaletteOpen(false) }) : null,
    confirm
      ? h(ConfirmDialog, {
          title: confirm.title,
          text: confirm.text,
          danger: confirm.danger,
          tone: confirm.tone,
          confirmText: confirm.confirmText,
          onClose: confirm.onClose,
          onConfirm: confirm.onConfirm,
        })
      : null,
  );
}

function SudoCapsuleOn(props) {
  const state = props.sudoState;
  const [, tick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => tick((n) => n + 1), 1000);
    timer.unref?.();
    return () => clearInterval(timer);
  }, []);
  const left = remainingText(state.expiresAt);
  return h(
    "button",
    { className: "dsp-capsule dsp-capsule--on", type: "button", onClick: props.onLock, title: "点击立即锁定：清除内存中的密码并 sudo -k" },
    h(Icon, { name: "unlock", size: 14 }),
    h("span", null, `${HOST.t("sudo.unlocked", "root")}${left ? " · " + left : ""} · ${HOST.t("sudo.lock", "锁定")}`),
  );
}

// ---------------------------------------------------------------------------
// 样式（只用主题 token；亮/暗自动跟随）
// ---------------------------------------------------------------------------

const CSS =
  ".dsp-root{display:flex;flex-direction:column;height:100%;min-height:0;color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.5}" +
  ".dsp-topbar{display:flex;align-items:center;gap:10px;padding:10px 16px;border-bottom:1px solid var(--dsw-alias-border-l3);flex:none}" +
  ".dsp-topbar__host{display:flex;align-items:center;gap:7px;font-size:14px}" +
  ".dsp-topbar__meta{display:flex;align-items:center;gap:12px;flex:1;min-width:0;overflow:hidden;white-space:nowrap}" +
  ".dsp-palette-trigger{display:flex;align-items:center;gap:7px;cursor:pointer;border:1px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-tertiary);font-family:inherit;font-size:12px;padding:4px 9px;border-radius:9px}" +
  ".dsp-palette-trigger:hover{background:var(--dsw-alias-interactive-bg-hover)}" +
  ".dsp-palette-trigger kbd{font-family:inherit;font-size:10px;padding:1px 5px;border:1px solid var(--dsw-alias-border-l3);border-radius:5px}" +
  ".dsp-capsule{display:flex;align-items:center;gap:6px;cursor:pointer;border:1px solid var(--dsw-alias-border-l3);background:transparent;color:var(--dsw-alias-label-secondary);font-family:inherit;font-size:12px;padding:4px 10px;border-radius:999px;white-space:nowrap}" +
  ".dsp-capsule--on{border-color:var(--dsw-alias-link);color:var(--dsw-alias-link)}" +
  ".dsp-main{flex:1;display:flex;min-height:0}" +
  ".dsp-nav{flex:none;width:132px;display:flex;flex-direction:column;gap:2px;padding:10px 8px;border-right:1px solid var(--dsw-alias-border-l3)}" +
  ".dsp-nav__btn{display:flex;align-items:center;gap:8px;cursor:pointer;border:none;background:transparent;color:var(--dsw-alias-label-secondary);font-family:inherit;font-size:13px;padding:7px 9px;border-radius:9px;text-align:left}" +
  ".dsp-nav__btn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}" +
  ".dsp-nav__btn--active{background:var(--dsw-alias-interactive-bg-active);color:var(--dsw-alias-label-primary);font-weight:600}" +
  ".dsp-content{flex:1;min-width:0;overflow:auto;padding:16px 18px 40px}" +
  ".dsp-page{display:flex;flex-direction:column;gap:12px}" +
  ".dsp-page--fill{height:100%}" +
  ".dsp-muted{color:var(--dsw-alias-label-tertiary);font-size:12px}" +
  ".dsp-toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap}" +
  ".dsp-health{display:flex;align-items:center;gap:10px;padding:10px 14px;border-radius:12px;border:1px solid var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-state-warn-primary);background:var(--dsw-alias-bg-layer-2);flex-wrap:wrap}" +
  ".dsp-health--ok{border-color:var(--dsw-alias-border-l3);color:var(--dsw-alias-label-secondary)}" +
  ".dsp-health__text{font-weight:600}" +
  ".dsp-health__items{display:flex;gap:8px;flex-wrap:wrap}" +
  ".dsp-health__item{cursor:pointer;border:1px solid currentColor;background:transparent;color:inherit;font-family:inherit;font-size:12px;padding:2px 9px;border-radius:999px}" +
  ".dsp-health__item--err{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}" +
  ".dsp-tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:12px}" +
  ".dsp-tile{display:flex;flex-direction:column;gap:7px;padding:12px 14px;border:1px solid var(--dsw-alias-border-l3);border-radius:12px;background:var(--dsw-alias-bg-layer-2)}" +
  ".dsp-tile--wide{flex:1}" +
  ".dsp-tile--clickable{cursor:pointer}" +
  ".dsp-tile--clickable:hover{background:var(--dsw-alias-interactive-bg-hover)}" +
  ".dsp-tile__head{display:flex;align-items:baseline;justify-content:space-between;gap:8px}" +
  ".dsp-tile__title{font-weight:600}" +
  ".dsp-tile__value{font-size:24px;font-weight:600;font-variant-numeric:tabular-nums;line-height:1.15}" +
  ".dsp-columns{display:flex;flex-direction:column;gap:12px}" +
  ".dsp-bar{height:6px;border-radius:3px;background:var(--dsw-alias-border-l3);overflow:hidden}" +
  ".dsp-bar__fill{height:100%;border-radius:3px;transition:width .35s ease}" +
  ".dsp-t0{background:var(--dsw-alias-link)}" +
  ".dsp-t1{background:var(--dsw-alias-state-warn-primary)}" +
  ".dsp-t2{background:var(--dsw-alias-state-error-primary)}" +
  ".dsp-list{display:flex;flex-direction:column;border:1px solid var(--dsw-alias-border-l3);border-radius:12px;overflow:hidden}" +
  ".dsp-list--flush{border:none}" +
  ".dsp-list__empty{padding:12px}" +
  ".dsp-svc{border-bottom:1px solid var(--dsw-alias-border-l3)}" +
  ".dsp-svc:last-child{border-bottom:none}" +
  ".dsp-svc--open{background:var(--dsw-alias-interactive-bg-hover)}" +
  ".dsp-svc__row{display:flex;align-items:center;gap:10px;padding:7px 12px}" +
  ".dsp-svc__name{cursor:pointer;border:none;background:transparent;color:inherit;font-family:inherit;font-size:13px;font-weight:600;padding:0;min-width:170px;text-align:left}" +
  ".dsp-svc__name:hover{color:var(--dsw-alias-link)}" +
  ".dsp-svc__enabled{font-size:11px;color:var(--dsw-alias-label-tertiary);min-width:32px}" +
  ".dsp-svc__desc{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary);font-size:12px}" +
  ".dsp-svc__actions{display:flex;gap:5px;flex:none}" +
  ".dsp-dot{width:8px;height:8px;border-radius:50%;flex:none;display:inline-block}" +
  ".dsp-dot--ok{background:var(--dsw-alias-link)}" +
  ".dsp-dot--off{background:var(--dsw-alias-border-l3)}" +
  ".dsp-dot--err{background:var(--dsw-alias-state-error-primary)}" +
  ".dsp-btn{display:inline-flex;align-items:center;gap:5px;cursor:pointer;border:1px solid var(--dsw-alias-border-l3);background:transparent;color:var(--dsw-alias-label-secondary);font-family:inherit;font-size:12px;padding:4px 10px;border-radius:9px;white-space:nowrap}" +
  ".dsp-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}" +
  ".dsp-btn:disabled{opacity:.5;cursor:default}" +
  ".dsp-btn--primary{border-color:var(--dsw-alias-link);color:var(--dsw-alias-link)}" +
  ".dsp-btn--danger{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}" +
  ".dsp-btn--mini{padding:2px 8px;font-size:11px;border-radius:7px}" +
  ".dsp-iconbtn{display:inline-flex;align-items:center;justify-content:center;cursor:pointer;border:none;background:transparent;color:var(--dsw-alias-label-tertiary);padding:4px;border-radius:7px}" +
  ".dsp-iconbtn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}" +
  ".dsp-segment{display:flex;gap:2px;padding:2px;border:1px solid var(--dsw-alias-border-l3);border-radius:10px}" +
  ".dsp-segment__btn{display:flex;align-items:center;gap:5px;cursor:pointer;border:none;background:transparent;color:var(--dsw-alias-label-secondary);font-family:inherit;font-size:12px;padding:3px 9px;border-radius:8px}" +
  ".dsp-segment__btn--active{background:var(--dsw-alias-interactive-bg-active);color:var(--dsw-alias-label-primary);font-weight:600}" +
  ".dsp-segment__count{font-size:11px;color:var(--dsw-alias-label-tertiary)}" +
  ".dsp-search{display:flex;align-items:center;gap:6px;flex:1 1 200px;min-width:160px;padding:4px 9px;border:1px solid var(--dsw-alias-border-l3);border-radius:9px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-tertiary)}" +
  ".dsp-search input{flex:1;min-width:0;border:none;outline:none;background:transparent;color:var(--dsw-alias-label-primary);font-family:inherit;font-size:13px}" +
  ".dsp-select{border:1px solid var(--dsw-alias-border-l3);border-radius:9px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-family:inherit;font-size:12px;padding:4px 8px}" +
  ".dsp-input{box-sizing:border-box;width:100%;padding:6px 9px;border:1px solid var(--dsw-alias-border-l3);border-radius:9px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-family:inherit;font-size:13px}" +
  ".dsp-crumbs{display:flex;align-items:center;flex-wrap:wrap;gap:2px;flex:1 1 220px;min-width:0;font-size:12px}" +
  ".dsp-crumbs__sep{color:var(--dsw-alias-label-tertiary)}" +
  ".dsp-crumbs__btn{cursor:pointer;border:none;background:transparent;color:var(--dsw-alias-link);font-family:inherit;font-size:12px;padding:1px 4px;border-radius:6px}" +
  ".dsp-crumbs__btn:hover{background:var(--dsw-alias-interactive-bg-hover)}" +
  ".dsp-bookmarks{display:flex;align-items:center;gap:6px;flex-wrap:wrap}" +
  ".dsp-chip{cursor:pointer;border:1px solid var(--dsw-alias-border-l3);background:transparent;color:var(--dsw-alias-label-secondary);font-family:inherit;font-size:11px;padding:2px 8px;border-radius:999px}" +
  ".dsp-chip:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}" +
  ".dsp-chip--on{border-color:var(--dsw-alias-link);color:var(--dsw-alias-link);cursor:default}" +
  ".dsp-badge{font-size:12px;padding:3px 10px;border-radius:999px;border:1px solid var(--dsw-alias-border-l3);color:var(--dsw-alias-label-secondary)}" +
  ".dsp-badge--warn{border-color:var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-state-warn-primary)}" +
  ".dsp-file{display:flex;align-items:center;gap:10px;padding:5px 12px;border-bottom:1px solid var(--dsw-alias-border-l3)}" +
  ".dsp-file:last-child{border-bottom:none}" +
  ".dsp-file:hover{background:var(--dsw-alias-interactive-bg-hover)}" +
  ".dsp-file--head{color:var(--dsw-alias-label-tertiary);font-size:11px;background:var(--dsw-alias-bg-layer-1)}" +
  ".dsp-file__main{display:flex;align-items:center;gap:8px;flex:1;min-width:0;cursor:pointer;border:none;background:transparent;color:inherit;font-family:inherit;font-size:13px;text-align:left;padding:0}" +
  ".dsp-file__name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0}" +
  ".dsp-file__size{width:70px;text-align:right;color:var(--dsw-alias-label-secondary);font-size:12px;font-variant-numeric:tabular-nums;flex:none}" +
  ".dsp-file__time{width:120px;color:var(--dsw-alias-label-tertiary);font-size:12px;font-variant-numeric:tabular-nums;flex:none}" +
  ".dsp-file__mode{width:44px;color:var(--dsw-alias-label-tertiary);font-size:11px;font-family:ui-monospace,Menlo,Consolas,monospace;flex:none}" +
  ".dsp-file__owner{width:74px;color:var(--dsw-alias-label-tertiary);font-size:11px;flex:none;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}" +
  ".dsp-file__ver{width:180px;color:var(--dsw-alias-label-secondary);font-size:12px;font-variant-numeric:tabular-nums;flex:none;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}" +
  ".dsp-file__ver--new{color:var(--dsw-alias-link)}" +
  ".dsp-file__proto{width:56px;flex:none;font-size:12px}" +
  ".dsp-file__addr{width:220px;flex:none;font-size:12px;font-variant-numeric:tabular-nums}" +
  ".dsp-file__proc{flex:1;min-width:0;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}" +
  ".dsp-file__pid{width:70px;flex:none;font-size:12px;color:var(--dsw-alias-label-tertiary)}" +
  ".dsp-file__actions{display:flex;gap:5px;flex:none;margin-left:auto}" +
  ".dsp-editor-overlay{position:fixed;inset:0;z-index:70;display:flex;flex-direction:column;gap:10px;padding:18px 22px;background:var(--dsw-alias-bg-layer-2);box-shadow:var(--dsw-elevation-prominent)}" +
  ".dsp-editor__head{display:flex;align-items:center;gap:10px;flex-wrap:wrap}" +
  ".dsp-editor__title{font-size:13px;font-weight:600;word-break:break-all;min-width:0}" +
  ".dsp-editor__actions{display:flex;gap:6px;margin-left:auto}" +
  ".dsp-editor{flex:1;min-height:0;width:100%;box-sizing:border-box;resize:none;padding:12px;border:1px solid var(--dsw-alias-border-l3);border-radius:12px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;line-height:1.55}" +
  ".dsp-dirty{font-size:11px;padding:1px 7px;border-radius:999px;border:1px solid var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-state-warn-primary)}" +
  ".dsp-log__pre{margin:0;padding:10px 12px;border-radius:10px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;line-height:1.55;white-space:pre-wrap;word-break:break-all;overflow:auto}" +
  ".dsp-log__pre--drawer{max-height:52vh;margin-top:8px}" +
  ".dsp-log__pre--page{flex:1;min-height:240px;max-height:none}" +
  ".dsp-drawer{position:fixed;top:0;right:0;bottom:0;width:min(560px,92vw);z-index:60;display:flex;flex-direction:column;background:var(--dsw-alias-bg-layer-2);border-left:1px solid var(--dsw-alias-border-l3);box-shadow:var(--dsw-elevation-prominent)}" +
  ".dsp-drawer__head{display:flex;align-items:center;gap:10px;padding:12px 16px;border-bottom:1px solid var(--dsw-alias-border-l3)}" +
  ".dsp-drawer__title{font-size:14px;font-weight:600;word-break:break-all}" +
  ".dsp-drawer__head .dsp-iconbtn{margin-left:auto}" +
  ".dsp-drawer__body{flex:1;min-height:0;overflow:auto;padding:14px 16px 28px}" +
  ".dsp-drawer__section{display:flex;align-items:center;gap:8px;font-size:12px;margin-bottom:10px}" +
  ".dsp-drawer__actions{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px}" +
  ".dsp-quick{display:flex;flex-direction:column}" +
  ".dsp-quick__row{display:flex;align-items:center;gap:10px;padding:5px 0;border-bottom:1px solid var(--dsw-alias-border-l3)}" +
  ".dsp-quick__row:last-child{border-bottom:none}" +
  ".dsp-quick__name{cursor:pointer;border:none;background:transparent;color:inherit;font-family:inherit;font-size:13px;font-weight:600;padding:0;min-width:150px;text-align:left}" +
  ".dsp-quick__name:hover{color:var(--dsw-alias-link)}" +
  ".dsp-quick__desc{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}" +
  ".dsp-quick__actions{display:flex;gap:5px;margin-left:auto}" +
  ".dsp-netrow{display:flex;align-items:baseline;gap:12px;font-size:12px;font-variant-numeric:tabular-nums;padding:3px 0;flex-wrap:wrap}" +
  ".dsp-netrow__rate{min-width:90px}" +
  ".dsp-events{display:flex;flex-direction:column;gap:3px}" +
  ".dsp-events__row{display:flex;align-items:center;gap:8px;font-size:12px}" +
  ".dsp-events__tone{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-border-l3)}" +
  ".dsp-events__tone--ok{background:var(--dsw-alias-link)}" +
  ".dsp-events__tone--err{background:var(--dsw-alias-state-error-primary)}" +
  ".dsp-installed{display:flex;flex-direction:column;gap:3px;max-height:320px;overflow:auto;margin-top:8px}" +
  ".dsp-installed__row{display:flex;align-items:baseline;gap:10px;font-size:12px}" +
  ".dsp-installed__summary{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary)}" +
  ".dsp-notice{padding:7px 11px;border-radius:9px;font-size:12px;border:1px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-layer-2)}" +
  ".dsp-notice--error{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}" +
  ".dsp-notice--ok{border-color:var(--dsw-alias-link);color:var(--dsw-alias-link)}" +
  ".dsp-warn{padding:7px 11px;border-radius:9px;font-size:12px;border:1px solid var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-state-warn-primary)}" +
  ".dsp-warn--inline{padding:3px 8px;font-size:11px}" +
  ".dsp-mask{position:fixed;inset:0;z-index:80;display:flex;align-items:center;justify-content:center;background:var(--dsw-alias-bg-mask-1)}" +
  ".dsp-mask--top{align-items:flex-start;padding-top:12vh}" +
  ".dsp-modal{width:min(540px,92vw);display:flex;flex-direction:column;gap:10px;padding:16px 18px;border-radius:14px;border:1px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-layer-2);box-shadow:var(--dsw-elevation-prominent)}" +
  ".dsp-modal__title{font-size:14px;font-weight:600}" +
  ".dsp-modal__hint{font-size:12px;color:var(--dsw-alias-label-tertiary);line-height:1.6}" +
  ".dsp-modal__text{font-size:13px;word-break:break-all}" +
  ".dsp-modal__actions{display:flex;justify-content:flex-end;gap:8px}" +
  ".dsp-palette{width:min(680px,92vw);display:flex;flex-direction:column;border-radius:14px;border:1px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-layer-2);box-shadow:var(--dsw-elevation-prominent);overflow:hidden}" +
  ".dsp-palette__input{display:flex;align-items:center;gap:8px;padding:10px 14px;border-bottom:1px solid var(--dsw-alias-border-l3);color:var(--dsw-alias-label-tertiary)}" +
  ".dsp-palette__input input{flex:1;border:none;outline:none;background:transparent;color:var(--dsw-alias-label-primary);font-family:inherit;font-size:14px}" +
  ".dsp-palette__list{display:flex;flex-direction:column;max-height:52vh;overflow:auto;padding:6px}" +
  ".dsp-palette__empty{padding:10px}" +
  ".dsp-palette__item{display:flex;align-items:center;gap:9px;cursor:pointer;border:none;background:transparent;color:var(--dsw-alias-label-primary);font-family:inherit;font-size:13px;padding:8px 10px;border-radius:9px;text-align:left}" +
  ".dsp-palette__item--active{background:var(--dsw-alias-interactive-bg-active)}" +
  ".dsp-palette__label{flex:1;min-width:0}" +
  // --- 终端 ---
  // 终端配色是"内容渲染"而非界面装饰：ANSI 16 色必须可分辨，所以这一段是唯一
  // 使用字面颜色的地方（对应 skill 里"artwork may use its own colors"的例外）。
  ".dsp-term{display:flex;flex-direction:column;gap:6px;flex:1;min-height:0;" +
  "--dsp-t-black:#3f3f46;--dsp-t-red:#dc2626;--dsp-t-green:#16a34a;--dsp-t-yellow:#ca8a04;--dsp-t-blue:#2563eb;--dsp-t-magenta:#c026d3;--dsp-t-cyan:#0891b2;--dsp-t-white:#d4d4d8;" +
  "--dsp-t-bright-black:#71717a;--dsp-t-bright-red:#f87171;--dsp-t-bright-green:#4ade80;--dsp-t-bright-yellow:#facc15;--dsp-t-bright-blue:#60a5fa;--dsp-t-bright-magenta:#e879f9;--dsp-t-bright-cyan:#22d3ee;--dsp-t-bright-white:#fafafa}" +
  ".dsp-term__tab{display:flex;flex-direction:column;flex:1;min-height:0}" +
  ".dsp-term__tab--hidden{display:none}" +
  ".dsp-term__bar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;font-size:12px}" +
  ".dsp-term__badge{padding:1px 8px;border-radius:999px;border:1px solid var(--dsw-alias-border-l3);color:var(--dsw-alias-label-secondary);font-size:11px}" +
  ".dsp-term__badge--open{border-color:var(--dsw-alias-link);color:var(--dsw-alias-link)}" +
  ".dsp-term__badge--error,.dsp-term__badge--closed,.dsp-term__badge--exited{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}" +
  ".dsp-term__screen{position:relative;flex:1;min-height:260px;overflow:auto;padding:8px 10px;border:1px solid var(--dsw-alias-border-l3);border-radius:10px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;line-height:1.45;white-space:pre-wrap;word-break:break-all;outline:none;cursor:text}" +
  ".dsp-term__screen:focus{border-color:var(--dsw-alias-link)}" +
  ".dsp-term__line{min-height:1.45em}" +
  ".dsp-term__caret{display:inline-block;width:7px;height:13px;vertical-align:-2px;background:var(--dsw-alias-link);animation:dsp-term-blink 1.1s steps(2) infinite}" +
  "@keyframes dsp-term-blink{50%{opacity:0}}" +
  ".dsp-term__char{position:absolute;visibility:hidden;white-space:pre;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px}" +
  ".dsp-term__hint{color:var(--dsw-alias-label-tertiary);font-size:11px;margin-left:auto}" +
  ".dsp-term--bold{font-weight:700}" +
  ".dsp-term--dim{opacity:.7}" +
  ".dsp-term--underline{text-decoration:underline}" +
  ".dsp-term--reverse{background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-base)}" +
  ".dsp-term--fg-black{color:var(--dsp-t-black)}.dsp-term--fg-red{color:var(--dsp-t-red)}.dsp-term--fg-green{color:var(--dsp-t-green)}.dsp-term--fg-yellow{color:var(--dsp-t-yellow)}" +
  ".dsp-term--fg-blue{color:var(--dsp-t-blue)}.dsp-term--fg-magenta{color:var(--dsp-t-magenta)}.dsp-term--fg-cyan{color:var(--dsp-t-cyan)}.dsp-term--fg-white{color:var(--dsp-t-white)}" +
  ".dsp-term--fg-bright-black{color:var(--dsp-t-bright-black)}.dsp-term--fg-bright-red{color:var(--dsp-t-bright-red)}.dsp-term--fg-bright-green{color:var(--dsp-t-bright-green)}.dsp-term--fg-bright-yellow{color:var(--dsp-t-bright-yellow)}" +
  ".dsp-term--fg-bright-blue{color:var(--dsp-t-bright-blue)}.dsp-term--fg-bright-magenta{color:var(--dsp-t-bright-magenta)}.dsp-term--fg-bright-cyan{color:var(--dsp-t-bright-cyan)}.dsp-term--fg-bright-white{color:var(--dsp-t-bright-white)}" +
  ".dsp-term--bg-black{background:var(--dsp-t-black);color:var(--dsw-alias-bg-base)}.dsp-term--bg-red{background:var(--dsp-t-red);color:var(--dsw-alias-bg-base)}.dsp-term--bg-green{background:var(--dsp-t-green);color:var(--dsw-alias-bg-base)}.dsp-term--bg-yellow{background:var(--dsp-t-yellow);color:var(--dsw-alias-bg-base)}" +
  ".dsp-term--bg-blue{background:var(--dsp-t-blue);color:var(--dsw-alias-bg-base)}.dsp-term--bg-magenta{background:var(--dsp-t-magenta);color:var(--dsw-alias-bg-base)}.dsp-term--bg-cyan{background:var(--dsp-t-cyan);color:var(--dsw-alias-bg-base)}.dsp-term--bg-white{background:var(--dsp-t-white);color:var(--dsw-alias-bg-base)}" +
  ".dsp-term--bg-bright-black{background:var(--dsp-t-bright-black);color:var(--dsw-alias-bg-base)}.dsp-term--bg-bright-red{background:var(--dsp-t-bright-red);color:var(--dsw-alias-bg-base)}.dsp-term--bg-bright-green{background:var(--dsp-t-bright-green);color:var(--dsw-alias-bg-base)}.dsp-term--bg-bright-yellow{background:var(--dsp-t-bright-yellow);color:var(--dsw-alias-bg-base)}" +
  ".dsp-term--bg-bright-blue{background:var(--dsp-t-bright-blue);color:var(--dsw-alias-bg-base)}.dsp-term--bg-bright-magenta{background:var(--dsp-t-bright-magenta);color:var(--dsw-alias-bg-base)}.dsp-term--bg-bright-cyan{background:var(--dsp-t-bright-cyan);color:var(--dsw-alias-bg-base)}.dsp-term--bg-bright-white{background:var(--dsp-t-bright-white);color:var(--dsw-alias-bg-base)}" +
  "@media (max-width:720px){.dsp-nav{width:52px}.dsp-nav__btn span{display:none}.dsp-drawer{width:100vw}.dsp-file__time,.dsp-file__owner{display:none}}";

// ---------------------------------------------------------------------------
// 插件入口
// ---------------------------------------------------------------------------

const inject = ["slots", "layout", "locale"];

function apply(ctx) {
  HOST.ctx = ctx;
  HOST.t = bindTranslator(ctx);

  ctx.locale?.register?.(NS, DICT);

  ctx.effect(
    () => {
      if (typeof document === "undefined") return () => {};
      const selector = 'style[data-plugin-css=' + JSON.stringify(STYLE_ID) + "]";
      if (document.querySelector(selector) === null) {
        const tag = document.createElement("style");
        tag.dataset.pluginCss = STYLE_ID;
        tag.textContent = CSS;
        document.head.appendChild(tag);
      }
      return () => {
        const existing = document.querySelector(selector);
        if (existing) existing.remove();
      };
    },
    "dsh-server-panel: stylesheet",
  );

  ctx.slots.inject("main", () => ctx.slots.register({ name: "main", key: PANEL_ID, locale: NS }, ServerPanel));

  ctx.slots.inject("sidebar.panellist", () =>
    ctx.slots.register(
      { name: "sidebar.panellist", id: PANEL_ID, order: 20, label: () => HOST.t("panel", "服务器"), locale: NS },
      function ServerPanelIcon(props) {
        return h(Icon, { name: "server", size: props?.size ?? 18, strokeWidth: props?.active ? 1.9 : 1.6 });
      },
    ),
  );
}

function bindTranslator(ctx) {
  const bound = typeof ctx.locale?.bind === "function" ? ctx.locale.bind(NS) : null;
  return (key, fallback) => {
    if (bound) {
      try {
        const value = bound(key);
        if (typeof value === "string" && value.length > 0 && value !== key) return value;
      } catch {
        // 字典缺失时退回内置文案。
      }
    }
    return fallback ?? key;
  };
}

exports.inject = inject;
exports.apply = apply;
// 测试接缝：ANSI 行缓冲解析是纯函数，单独暴露出来好做断言（不影响运行时）。
exports.__internals = { parseAnsi, createTermState };
