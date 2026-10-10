# 把 DSH WebUI 改造成服务器管理面板 — 实施方案

> 结论先行：不改 DSH 内核、不动 Web 前端产物，写**一个 Cordis 插件包**（Host 半 + Client 半），
> 用官方的 `main` 面板槽 + `webServer` 路由注册进现有 WebUI。隧道、认证、主题、语言全部沿用 DSH 自己的，
> 不引入 nginx、不新开端口、不需要图形界面。

---

## 1. 已核实的环境事实（方案的地基）

| 项目 | 实测结果 | 对方案的影响 |
|---|---|---|
| 服务器 | `your-host` / Debian 13 / `192.0.2.10` / 4 核 / 3.8G 内存 / `/` 108G（用 5%） | 面板管理对象就是本机 |
| DSH | `dsh 0.2.1-alpha.1`，进程 `dsh web --no-open --port 3080` | 插件宿主 |
| 监听 | 只监听 `127.0.0.1:3080`（另有 sshd 22） | 面板**不会**新增局域网暴露面，安全性 = 现有 DSH 的边界 |
| 访问方式 | 浏览器 → 隧道 → `127.0.0.1:3080`，URL 带 `?token=`，之后走 Cookie（profile 里已把 `cookieMaxAgeDays` 设为 3650 天） | 面板沿用同一套认证，无需自建登录 |
| 权限 | 用户 `$USER` 在 `sudo` 组，但 **`sudo` 需要密码**（无法免密） | 特权操作必须走"面板内输入密码"通道 |
| journalctl | `$USER` 不在 `adm` / `systemd-journal` 组 | 读全量日志也要 sudo |
| 环境 | 无 docker / nginx / tmux / htop；有 `systemctl`、`journalctl`、`apt` | 第一期不做容器板块 |
| 已有插件先例 | `~/dsh-resource-bar`（Host 采样 + 自注册 HTTP 路由 + 客户端槽注入，已在本机跑通）、`~/dsh-xiaoba-brand` | 直接照它们的成功范式写，风险低 |
| DSH 官方范式 | `dsh-client-ui-plugin-manager` / `dsh-client-ui-schedule` 自己就是这么加"侧栏图标 + 整页面板"的 | 面板接法是官方支持的，不是 hack |

**关键结论：DSH 插件跑在 dsh 的 Node 进程里 = 本机 `$USER` 用户的权限，所以"管理服务器"和"读本机文件/进程"是同一件事，不需要额外的 agent 或远程通道。**

---

## 2. 用户已确认的需求边界

1. **管理对象**：就是这台跑 `dsh web` 的机器（192.0.2.10）。
2. **权限方式**：面板里输入 sudo 密码，**只存内存、用完即弃**。
3. **第一期功能**（三块，做到"基本可用"）：
   - 概览监控：CPU / 内存 / 磁盘 / 负载 / 网络 / 开机时长
   - systemd 服务：列表 + 状态 + 启停/重启 + 日志
   - 文件管理：浏览 / 查看 / 编辑 / 上传下载
4. **界面形态**：左侧栏加一个图标 → 点开是**整页独立管理面板**。
5. 不做（第一期）：Docker、apt 图形化、Web 终端、多主机 SSH、给 AI 注册工具（都放进 P2，架构预留）。

---

## 3. 总体架构

```
你的电脑浏览器
   │  (现有 SSH 隧道，无需改动)
   ▼
127.0.0.1:3080  ── dsh web（HTTP + WebSocket，Cookie 认证 + 信任栅栏）
   │
   ├── DSH 原有 UI（对话 / 设置 / 插件管理 …）
   │
   └── 【新插件 dsh-server-panel】
        ├── Client 半（浏览器内，React）
        │     ├─ 注册 sidebar.panellist  → 侧栏"服务器"图标
        │     ├─ 注册 main[key="server"] → 整页管理面板（3 个标签页）
        │     └─ 用 fetch 调自己的 Host 路由，Cookie 同源自动携带
        └── Host 半（Node，与 dsh 同进程、同权限）
              ├─ webServer.register  → /dsh-server-panel/* 路由
              ├─ 采样器：/proc/stat、/proc/meminfo、/proc/net/dev、statfs，1s 缓存
              ├─ systemctl / journalctl 封装（argv 数组，不走 shell）
              ├─ 文件读写（路径规范化 + mtime 乐观锁）
              └─ sudo 会话（密码仅在内存，锁定/空闲即清除）
```

**为什么这样最省事**：
- 面板页面是真正的 React 组件（不是 iframe），自动继承 DSH 主题、暗色模式、字号、语言；
- 走 `webServer.register` 的 HTTP 路由，与页面同源，DSH 的 Cookie 认证与 `connection.requestRejection()` 信任栅栏直接复用（`~/dsh-resource-bar/src/index.js:521-583` 已验证的写法）；
- 无需 nginx / 反向代理 / 新端口 / 系统服务，**插件随 dsh 进程生命周期启停**。

---

## 4. 目录与文件结构

位置沿用你其它插件的惯例：`/path/to/dsh-server-panel/`

```
dsh-server-panel/
├── package.json          # bundle 清单：dsh.bundle.patch + dsh.client{platform:"web"} + exports
├── cordis.patch.yml      # insert 一行插件 + 可调 config（目录范围、轮询间隔、sudo 空闲锁定）
├── build.mjs             # 零依赖构建：src → lib（Host 半 ESM 直拷，Client 半包成工厂 CJS）
├── icon.svg              # 原创图标（服务器机架线条），供插件管理/设置页显示
├── locale/
│   ├── zh.json           # meta.title / meta.description + 面板 UI 文案
│   └── en.json
├── src/
│   ├── index.js          # Host 半入口：apply() 装配采样器 + 路由 + sudo 会话
│   ├── metrics.js        # /proc 解析与百分比折算（纯函数，可单测）
│   ├── services.js       # systemctl / journalctl 封装（CV 校验、argv 数组、超时、输出上限）
│   ├── files.js          # 路径规范化、读写、上传下载流、mtime 冲突检测
│   └── client/index.js   # Client 半：图标 + 整页面板 + 各标签页组件（JSX-free）
├── lib/                  # 构建产物（index.js / client.js），插件实际加载这两个
└── test/
    ├── parse.test.mjs        # metrics 纯函数
    ├── validate.test.mjs     # 单元名 / 路径 / 动作校验的负例
    └── routes.test.mjs       # 用 mock req/res 跑路由：方法、栅栏、错误码
```

规模预估：Host 半 ≈ 700 行，Client 半 ≈ 700 行，测试 ≈ 250 行。不需要任何 npm 依赖（`react` 由浏览器模块表提供）。

---

## 5. 界面实现（已核实的官方 API）

### 5.1 侧栏图标

```js
// Client 半：id 即面板 id，order 决定图标在侧栏的排序
ctx.slots.inject("sidebar.panellist", () => ctx.slots.register(
  { name: "sidebar.panellist", id: "server", order: 20, label: () => t("panel"), locale: NS },
  ServerIcon,                        // 组件收到 { size, active }，只画 SVG
));
```
侧栏自己负责按钮、Tooltip、`aria-current`，点击时调用 `ctx.layout.selectPanel("server")`。

### 5.2 整页面板

```js
ctx.slots.inject("main", () => ctx.slots.register(
  { name: "main", key: "server", locale: NS },
  ServerPanelPage,
));
```
（`dsh-client-ui-plugin-manager/lib/client.js:3851-3918` 与 `dsh-client-ui-schedule/lib/client.js:7474-7490` 是官方同款写法。）

面板内部结构：
```
┌─ 服务器 ────────────────────────────────┬─ [概览][服务][文件] ─┐
│ 概览：CPU/内存/磁盘环形 + 负载/网络/开机时长实时卡片（2s 轮询，仅面板可见时）
│ 服务：可搜索单元列表 → 行内 启/停/重启/自启 开关，点开看 journalctl 日志尾部
│ 文件：面包屑目录浏览、文本查看/编辑、上传下载、新建/重命名/删除
└─ 右下角：🔓 状态胶囊（未解锁 / 已解锁 · 剩余 mm:ss / 锁定）
```
- 只在面板处于激活态时轮询：`ctx.layout.panelInfo.getSnapshot().activePanelId`（`dsh-client-ui-plugin-manager/lib/client.js:3898` 同款用法）为 `"server"` 时才发请求，离开即停；兜底再加 `document.visibilityState` 判断，做到"没人看就不采样"。
- 样式只用 `--dsw-alias-*` 主题 token，自带 CSS 以 `<style data-plugin-css="dsh-server-panel/style.css">` 注入并在 `ctx.effect` 清理。
- 文案全部走 `ctx.locale.register(NS, { zh, en })`。
- 不引 `@deepseek-ai/dsh-client-ui-primitives`，控件自己写（官方插件规范要求）。

---

## 6. Host 半：接口设计

所有路由挂在 `/dsh-server-panel` 前缀下，每个 handler 第一步都是信任栅栏：

```js
const rejected = (req, res) => {                    // 与 dsh-resource-bar 同款，失败关闭
  const connection = ctx.get("connection");
  if (!connection?.requestRejection) { res.writeHead(503).end(...); return true; }
  const rejection = connection.requestRejection(req);
  if (rejection === undefined) return false;
  res.writeHead(rejection); res.end(); return true;
};
```

| 方法 | 路径 | 作用 | 特权 |
|---|---|---|---|
| GET | `/overview` | CPU/内存/交换/负载/磁盘/网卡速率/开机时长 | 否 |
| GET | `/services?filter=` | `systemctl list-units --type=service --all` 解析成 JSON | 否 |
| POST | `/services/action` | `{unit, action}`，action ∈ {start,stop,restart,reload,enable,disable} | **是** |
| GET | `/services/logs?unit=&lines=` | `journalctl -u <unit> -n <n> --no-pager -o short-iso` | **是**（读全量日志需 sudo） |
| POST | `/sudo/unlock` / `/sudo/lock` | 校验密码并记住；`sudo -k` 立即失效 | — |
| GET | `/files/list?path=` | 目录列表（名/类型/大小/mtime/权限） | 否 |
| GET | `/files/read?path=` | 文本读取（≤1 MiB，超限提示走下载） | 否 |
| PUT | `/files/write?path=&mtime=` | 保存，mtime 不符返回 409 | 否 |
| GET | `/files/download?path=` | 流式下载 | 否 |
| PUT | `/files/upload?path=&name=` | 原始 body 流式落盘（同名加 `.part` 再改名） | 否 |
| POST | `/files/mkdir` / `rename` / `delete` | 基本文件操作 | 否 |

### 6.1 sudo 通道（本方案唯一的高风险点，按你选的方式实现）

```
用户在面板输入密码 ──POST /sudo/unlock──▶ Host
   密码只写入缓冲区：child.stdin.write(pw + "\n"); child.stdin.end();
   命令形如：execFile("sudo", ["-S", "-p", "", ...argv], { env: {LANG:"C"} })
   ├─ 成功 → 内存里记住（不落盘、不进日志、不回显），返回解锁态 + 过期倒计时
   └─ 失败 → 归一化为 { ok:false, error:"bad_password" }，绝不回传 stderr 原文

后续特权操作：先试 sudo -n（时间戳还热就直接过），否则用内存密码再跑一次 -S
锁定按钮 / 空闲超时 / 插件卸载 → 立即清空内存密码 + `sudo -k`
```

- 密码字段：`type=password`，只存 React state，不写 localStorage / sessionStorage；请求头 `Cache-Control: no-store`。
- 密码**永远不经过 DSH 的对话/工具链路**（因此不会进 session 日志，符合"仅存内存"的要求）。
- 默认 `sudoIdleMs = 10 * 60_000`（可在 `cordis.patch.yml` 调，设 0 = 每次操作后立即清除）。
- 传输安全：密码只走在 `127.0.0.1` + 你的 SSH 隧道上。**方案里明确禁止把 3080 暴露到局域网**（那会让密码明文过网）。

### 6.2 命令执行安全

- 一律 `execFile` + **argv 数组**，任何地方不出现 shell 字符串拼接；
- `unit` 名白名单校验：`/^[A-Za-z0-9@._:\\-]{1,128}$/`，非法直接 400；
- `action` 是枚举常量表，不在表内即 400；
- 每个子进程带超时（默认 10s）与 stdout 上限（默认 512 KiB），超限截断而不是撑爆内存；
- 单元名以 `-` 开头（如 `--now`）被正则挡掉，避免参数注入。

### 6.3 文件安全

- 路径先 `path.resolve` 再 `fs.realpath`（允许尚不存在的最后一段），禁止 `..` 逃逸；可配置 `allowedRoots`（默认 `["/home/<user>", "/etc", "/var/log", "/srv", "/opt"]`，读取放行、写入默认限 `["/home/<user>"]`）。
- 写入带 mtime 乐观锁，防止"面板里改了、终端里也改了"互相覆盖。
- 下载/上传走流，不整文件进内存；上传先写 `.part` 再 `rename`。

### 6.4 危险操作护栏（因为你是**通过隧道**连的）

- 高危单元黑名单默认 `["ssh", "sshd", "systemd-logind", "networking", "systemd-networkd", "dsh"]`：点"停止/重启"要二次确认，确认框里写明"可能切断你当前的连接"。
- 面板自己不做"关机/重启主机"（避免自锁）；要就放 P2 并且二次输入确认词。
- `dsh` 进程本身不提供任何"重启自己"的按钮（已有的 `dsh-power-button` 更合适）。

---

## 7. 打包与安装

`package.json`（要点，照 `dsh-resource-bar` / `dsh-xiaoba-brand` 的成熟形态）：

```json
{
  "name": "dsh-server-panel",
  "version": "0.1.0",
  "type": "module",
  "main": "lib/index.js",
  "exports": { ".": "./lib/index.js", "./client": "./lib/client.js",
               "./locale/*.json": "./locale/*.json", "./icon": "./icon.svg" },
  "files": ["lib", "cordis.patch.yml", "locale/*.json", "icon.svg"],
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": { "platform": "web", "inject": ["@deepseek-ai/dsh-client-ui-layout"] }
  }
}
```

`cordis.patch.yml`：

```yaml
- insert:
    - id: dsh-server-panel
      name: 'dsh-server-panel'
      config:
        pollMs: 1000              # Host 采样间隔
        sudoIdleMs: 600000        # 解锁空闲自动清除
        allowedReadRoots: ['/home/<user>', '/etc', '/var/log', '/srv', '/opt']
        allowedWriteRoots: ['/home/<user>']
        dangerUnits: ['ssh', 'sshd', 'systemd-logind', 'networking', 'systemd-networkd', 'dsh']
```

安装：`plugin_manager` → `install_bundle`（target = `/path/to/dsh-server-panel` 绝对路径）。它负责写 profile 的 `package.json`/patch 与依赖解析，**不要手改 profile 目录**。
> 迭代提示：首次安装可 HMR 生效；之后改动代码需要重新构建 `lib/` 并重装/重启 dsh 才会加载新的 JS 世代（插件规范的明确要求）。

---

## 8. 实施步骤（按顺序，每步有可验证产出）

| # | 步骤 | 产出 / 验证 |
|---|---|---|
| 1 | 建包骨架：`package.json`、`cordis.patch.yml`、`icon.svg`、`locale/{zh,en}.json` | `node -e "require('./package.json')"` 通过；locale 有 `meta.title/description` |
| 2 | Host：`metrics.js` + 采样器（`ctx.effect` 内启动、unref 定时器、dispose 清理） | 单测通过；`GET /overview` 返回合理数值 |
| 3 | Host：路由骨架 + 信任栅栏 + 方法校验 + 错误码 | 单测（mock req/res）覆盖 405/503/400 |
| 4 | Host：`services.js`（列表/动作/日志）+ 单元名与动作校验 | 负例单测；真机 `GET /services` 能列出 ssh/cron/avahi… |
| 5 | Host：`files.js`（列表/读/写/上传/下载）+ 路径校验 + mtime 锁 | 负例单测（`../../etc/shadow` 被拒）；真机往返写读一个临时文件 |
| 6 | Host：sudo 会话（unlock/lock/空闲清除/`sudo -n` 快路径） | 无密码时操作返回 `locked`；错密码返回 `bad_password` 且不泄漏 stderr |
| 7 | Client：图标 + 面板骨架 + 概览页 | 侧栏出现"服务器"图标，点击切到整页面板 |
| 8 | Client：服务页（列表/搜索/动作/日志抽屉） | 列表、动作按钮、日志滚动可用 |
| 9 | Client：文件页（浏览/编辑/上传下载） | 目录浏览、文本保存、上传下载可用 |
| 10 | 联调：主题/暗色/语言、离开面板停轮询、错误提示 | 见 §9 |
| 11 | 收尾：README、`files` 清单校验、图标与标题在插件管理页正确显示 | 见 §9 |

---

## 9. 验收标准

**我可以自动验证的：**
1. 注册到位：`cordis_inspect_query` → client `Slots.listSubTree(root="sidebar.panellist")` 出现 `id=dsh-server-panel`；`root="main"` 的 key 集合里出现面板 id。
2. 无崩溃/无违规：客户端不 import 任何 `@deepseek-ai/dsh-client-*` 包；CSS 里只出现 `--dsw-alias-*` / `--dsw-elevation-*` token（写成自检脚本）。
3. HTTP 层：用日志里最新的 token 建 Cookie 后
   `curl -b jar .../dsh-server-panel/overview | jq .` 返回数值；
   `/services` 单元数与 `systemctl --type=service --all | wc -l` 同量级；
   无 Cookie 请求被栅栏拒绝；
   `/files/read?path=../../etc/shadow` → 400（负例）。
4. 资源纪律：卸载插件后无残留定时器/路由（`ss` 无新端口、`ctx.effect` 清理有单测断言）。
5. 纯函数单测与路由单测全绿（`node run-tests.mjs`）。

**需要你在页面上确认（我无法截图，也没有浏览器控制）：**
6. 侧栏图标样式、面板在亮/暗主题下的观感、字号跟随 DSH 设置。
7. 输入 sudo 密码解锁 → 重启一个无害单元（建议 `cron` 或 `avahi-daemon`）→ 列表状态变化 → 点"锁定"后同一操作被拒。
8. 上传一个小文件到 `~/下载` 之类目录、在文件页编辑保存、再从终端 `cat` 核对内容一致。

---

## 10. 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| sudo 密码驻留内存 | 面板被第三方控制 = root | 只走 127.0.0.1+隧道、Cookie 栅栏、空闲自动清除、显式锁定、绝不落盘/进日志 |
| 3080 被暴露到局域网 | 密码明文过网 + 任何人可管理服务器 | 方案约定不暴露；如要远程，用 SSH 隧道或加 TLS 反代（P2） |
| 误停 `ssh`/网络单元 | 你当前隧道断开、面板失联 | 危险单元黑名单 + 二次确认 + 明确提示 |
| 全量 journalctl 需 sudo | 未解锁时日志页空 | 面板明确提示"看全量日志请先解锁"；或你在服务器上把 `$USER` 加入 `systemd-journal` 组（一次操作，免 sudo 只读日志） |
| 长命令阻塞 | 页面转圈、路由挂住 | 子进程超时 + 输出上限 + 前端 loading/取消 |
| 页面轮询拖累小内存机器 | 3.8G 内存下无谓开销 | 采样缓存 + 面板不可见即停 + 前端降频 |
| 迭代后浏览器仍是旧 JS | "改了没反应" | 明确：改代码 → 重建 → 重装/重启 dsh → 刷新页面 |

---

## 11. 分期路线

- **P1（本方案）**：概览 / systemd / 文件 + sudo 通道 + 侧栏整页面板。
- **P2（可选，架构已预留）**：
  - 同一套 Host 方法再暴露成 **Agent 工具**，让你在对话里直接说"重启 cron 并看日志"（密码永不作为工具参数）；
  - Web 终端标签页：复用 DSH 自带 `terminals` / `terminalController`（已有 PTY 服务与流式通道，无需自写）；
  - apt 板块：可升级列表、单包升级、`apt-get dist-upgrade` 需二次确认；
  - systemd timer / cron 面板；
  - 多主机：复用 DSH 自带 `ssh` 服务管理局域网其它机器（你选的是"先本机"，这里只留接口形状）。

---

## 12. 三个默认决定（不回复就按默认做）

1. **文件浏览范围**：默认只读白名单 `['/home/<user>','/etc','/var/log','/srv','/opt']`，写入只允许 `/home/<user>`。（想要全盘就改成 `/`）
2. **危险单元黑名单**：默认 `ssh, sshd, systemd-logind, networking, systemd-networkd, dsh`（二次确认而非禁止）。
3. **AI 工具入口**：第一期**不做**（纯界面操作）；P2 再加，且工具层不接受密码。
