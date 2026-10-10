# dsh-server-panel

把 DSH WebUI 变成**本机服务器运维控制台**：侧栏一枚"服务器"图标，点开是整页面板。
不新开端口、不引 nginx、不需要图形界面——插件挂在 dsh 自己的 Web 服务与 UI 上，
自动继承它的认证、主题、暗色模式与语言。

```
浏览器（经你的 SSH 隧道）
   └── 127.0.0.1:3080  dsh web
         ├── DSH 原有 UI
         └── dsh-server-panel
               ├── Client 半：左导航面板（总览/服务/文件/日志/软件包/网络）+ 命令面板
               └── Host 半：26 条 /dsh-server-panel/* 路由 + 采样器 + root 通道
```

## 界面（v2）

**顶栏**：主机名 · 发行版/负载/内存摘要 · 命令面板（⌘K / Ctrl+K）· 自动刷新开关 · root 身份胶囊。
**左导航**：总览 / 服务 / 文件 / 日志 / 软件包 / 网络。

| 页面 | 能力 |
|---|---|
| **总览** | 异常横幅（failed 单元、磁盘 ≥85%、内存 ≥90%、负载超核数、可升级包）→ CPU/内存/磁盘/系统四张 KPI 卡 → 常用服务快启（可收藏）→ 本次会话操作事件流 |
| **服务** | 分组（失败/运行中/开机自启/全部）+ 搜索；行内启停重启；**右侧抽屉**看状态与实时跟随的 journalctl 日志 |
| **文件** | 面包屑 + 常用位置书签；列表（名称/大小/时间/权限/属主）；覆盖层大编辑器（mtime 冲突检测）；上传/下载/新建/重命名/删除/chmod/chown |
| **日志** | 按单元 + 关键字过滤，**实时跟随**，行数可选（100–1000） |
| **软件包** | apt 模拟升级得出的可升级列表（当前 → 候选）、单包/全部升级、刷新索引、已安装查询 |
| **网络** | 网卡卡片（IP + 实时速率）、监听端口（root 时含全部进程名）、已建立连接 Top、防火墙现状 |

命令面板覆盖：跳页、解锁/锁定 root、刷新、暂停轮询、打开 `/etc`、打开 `/var/log`、刷新 apt 索引、升级全部。

## 权限模型

```
未解锁 ──[面板里输入 sudo 密码]──▶ 已解锁（root 身份，可一键锁定）
  ├ 文件：白名单（~、/etc、/var/log…）   ├ 文件：全盘可读可写
  ├ 日志：仅本用户可见                   ├ 日志：全量
  ├ 服务：只读                           ├ 服务：启停/重启/自启
  └ 软件包：只读                         └ 软件包：更新/升级
```

- 解锁后**所有模块**的请求自动带 `root=1`，不再逐模块判断；未解锁时点到需要权限的操作会直接弹解锁框，解锁后自动重试。
- 写**系统目录**（`/etc` `/boot` `/usr` `/lib*` `/bin` `/sbin` `/var/lib`）必须二次确认；关键目录（`/`、`/etc`、`/usr`、`/home` …）拒绝删除。
- 密码只写进 `sudo -S` 的 stdin，只存 dsh 进程内存；锁定、空闲 10 分钟、插件卸载即清除并 `sudo -k`。错误信息归一化，不回传 PAM 细节。
- 端口仍只监听 `127.0.0.1`，走你的隧道；**不要**把 3080 暴露到局域网。

## 路由

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` `/overview` | 插件自述 / 资源快照 |
| GET | `/services` `/services/logs` | 单元列表 / journalctl |
| POST | `/services/action` | start/stop/restart/reload/enable/disable（需 root） |
| GET/POST | `/sudo/state` `/sudo/unlock` `/sudo/lock` | 身份通道 |
| GET/PUT/POST | `/files/list` `/read` `/write` `/download` `/upload` `/mkdir` `/rename` `/delete` `/chmod` `/chown` `/roots` | 文件管理（`root=1` 走 root；`confirm=1` 过系统目录闸门） |
| GET | `/packages/upgradable` `/packages/installed` | apt 查询 |
| POST | `/packages/update-index` `/packages/upgrade` | 需 root |
| GET | `/network/overview` `/network/listeners` `/network/connections` | 网卡/端口/连接 |

## 目录

```
src/index.js      Host 入口：配置、采样器、sudo 会话、路由注册
src/routes.js     26 条路由：root 切换 + 系统目录闸门 + 错误码映射
src/fsroot.js     root 文件传输层（sudo -n find/cat/cp/mv/rm/chmod/chown）
src/files.js      普通身份文件服务（白名单 + realpath + mtime 乐观锁）
src/metrics.js    /proc 采样（CPU/内存/磁盘/网络/进程）
src/services.js   systemctl / journalctl 封装
src/packages.js   apt 模拟升级解析、索引刷新、升级
src/network.js    ip -j addr / ss 解析
src/sudo.js       内存态 sudo 会话（unlock/runRoot/spawnRoot/lock/dispose）
build.mjs         零依赖构建：src/*.js → lib/*.js，客户端包进模块加载器工厂
```

## 安装与迭代

```bash
node build.mjs          # 构建
node test/run.mjs       # 10 个测试文件、90+ 断言
# 安装：plugin_manager → install_bundle，target = 本目录绝对路径
```

**重要**：Host 半是 Node 模块，同一路径的模块在同一进程里只会求值一次——
改了 `src/*.js` 之后必须**重启 dsh**（电源按钮）才会加载新世代；只改
`cordis.patch.yml` 的 config 会即时生效。客户端半由页面加载，重启后一并刷新。

## License

[MIT](LICENSE) © 2026 lsl1931 — 仓库：<https://github.com/lsl1931/dsh-server-panel>

> 这个插件能在解锁后以 root 操作本机（改系统配置、启停服务、开 root 终端）。
> 请只在本机或可信隧道后面运行它，不要把端口直接暴露到公网。
