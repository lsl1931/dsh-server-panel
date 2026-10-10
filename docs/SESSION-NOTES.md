# 会话产出说明：dsh-server-panel（v1 → v2）

本仓库是 **2026-10-08 那次会话**把 DSH WebUI 改造成"本机服务器运维控制台"的全部产出。
归档时间：2026-10-10。代码仍在 `/path/to/dsh-server-panel` 原地运行（作为 `web` profile 的
bundle 被 dsh 加载），本仓库就是它的 git 树。

---

## 一、这次会话写了什么

| 路径 | 说明 |
|---|---|
| `src/index.js` | Host 入口：配置归一化、采样器、sudo 会话、终端服务装配、26 条路由注册、信任栅栏 |
| `src/routes.js` | 路由表：v1 的 17 条 → v2 的 26 条，统一 `root=1` 身份切换与系统目录二次确认 |
| `src/fsroot.js` | **root 文件传输层**：解锁后文件管理以 root 执行（`sudo -n find/cat/cp/mv/rm/chmod/chown`） |
| `src/files.js` | 普通身份文件服务：白名单 + realpath 防符号链接逃逸 + mtime 乐观锁 |
| `src/sudo.js` | 内存态 sudo 会话：unlock / runRoot / spawnRoot / lock / dispose，密码不落盘不进 argv |
| `src/services.js` | systemctl / journalctl 封装：单元名白名单、动作枚举、超时与输出上限 |
| `src/packages.js` | apt：模拟升级解析（当前→候选）、索引刷新、单包/全部升级 |
| `src/network.js` | 网络：`ip -j addr`、`ss -tulpn` 监听端口、已建立连接聚合、防火墙现状 |
| `src/terminal.js` | **终端会话**：基于 dsh 自带 `subprocess.spawnTerminal` 的真 PTY，一 WS 一会话 |
| `src/ws.js` | 零依赖 WebSocket 服务端（握手/帧编解码/分片/ping-pong/close） |
| `src/metrics.js` | /proc 采样：CPU（总量+逐核）、内存、磁盘、网卡速率、负载、进程数 |
| `src/client/index.js` | Client 半（约 2000 行）：左导航 + 命令面板 + 六个页面 + 终端页 + ANSI 行缓冲渲染 |
| `build.mjs` | 零依赖构建：`src/*.js → lib/*.js`，客户端包进 dsh 模块加载器工厂形式 |
| `test/*.test.mjs` | 12 个测试文件、**107 条断言** |
| `locale/{zh,en}.json`、`icon.svg`、`cordis.patch.yml` | 插件元数据、图标、bundle 清单与可调配置 |
| `docs/` | 同一次会话写的三份文档（原文件在会话工作区，这里是快照） |

界面（v2）：顶栏（主机名 / 负载内存摘要 / 命令面板 ⌘K / 轮询开关 / root 身份胶囊）+
左导航（总览 / 服务 / 文件 / 日志 / 软件包 / 网络 / 终端）。总览首屏是"这机器有没有问题"：
异常横幅 → 四张 KPI 卡 → 常用服务快启 → 本次会话操作事件流。

权限模型：解锁一次 sudo → **所有模块**自动以 root 执行（文件全盘、日志全量、服务启停、
软件包升级、监听端口的进程名）；系统目录写入二次确认；关键目录拒绝删除；可一键锁定，
空闲 10 分钟自动清除密码。

---

## 二、验证状态

**已验证（可复现）**

```
node build.mjs      # 构建；自检 lib/index.js 的 11 个相对 import 均可解析
node test/run.mjs   # 12/12 测试文件通过，107 条断言
```

- 测试覆盖：/proc 解析、采样器前后帧、服务单元名注入负例（18 种）、动作枚举、文件白名单与
  符号链接逃逸、mtime 冲突不覆盖、上传原子性、root 层的删除保护与 argv 形状、
  apt 包名与数量校验、ss/ip 解析、WebSocket 握手向量与分片/ping-pong、PTY 会话生命周期与并发上限、
  客户端真实加载（模拟 `__ModuleLoader__`）与 ANSI 行缓冲。
- 线上探针（未认证请求，`http://192.0.2.10:3080`）：
  `/dsh-server-panel/health`、`/packages/upgradable`、`/network/overview` 均返回 **401**
  ——证明路由已注册到 dsh 的 Web 服务、且被信任栅栏挡在认证之外；
  不存在的路径返回 404（对照组成立）。
- 插件行 live：`include:dsh-server-panel` 处于 active；`Slots` 显示 `main` 的 `server` 键与
  `sidebar.panellist` 的 `server` 条目均已注册。

**未验证（需要人在页面上看）**

- 终端页的端到端交互（键盘透传、resize、root shell 提示符）——需要真实浏览器与 sudo 密码。
- sudo 密码流程（解锁 → 重启服务 → 锁定）——只有持有密码的人能验。
- 视觉与暗色主题观感、窄窗口下的抽屉布局。

---

## 三、迭代注意

- **Host 半是 Node 模块，同一路径在同一进程里只求值一次**：改 `src/*.js` 之后必须重启 dsh
  才会加载新世代（实测：改入口文件名、停用再启用插件行、`remove_bundle` 重装都无法免重启）。
  只改 `cordis.patch.yml` 的 `config` 会即时生效。
- 安装/重装：`plugin_manager` → `remove_bundle` 后 `install_bundle`（target 为本目录绝对路径）。
- 配置文件：`cordis.patch.yml`（采样间隔、sudo 空闲锁定、文件白名单、危险单元、终端参数）。

---

## 四、已知限制与风险

1. **终端是行缓冲渲染**：ANSI 颜色、CR/LF/退格、清行清屏正常；`htop`/`top` 这类全屏 TUI
   会显示残影（界面里已标注"全屏 TUI 显示不保证"）。
2. **端口暴露**：归档时 dsh 已改为监听 `192.0.2.10:3080`（局域网可见）。面板的 sudo
   密码走的是明文 HTTP —— 局域网内任何能访问该端口且持有 DSH Cookie 的人都可能提权。
   建议恢复 `127.0.0.1` + SSH 隧道，或在前端加 TLS 反代后再暴露。
3. **未做**：容器（本机没装 docker/podman）、多主机 SSH、告警规则、把操作接给 AI 对话。
