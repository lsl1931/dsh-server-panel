# dsh-server-panel 接口契约（Host 半 ⇄ Client 半 唯一真源）

包目录：`/path/to/dsh-server-panel/`
面板 id（`PANEL_ID`）：`server`
路由前缀：`/dsh-server-panel`
Client 侧的 host 模块 id：`dsh-server-panel`（= 包名）

所有响应都是 JSON，除 `GET /files/download`（原始字节流）。
约定：成功 `{ "ok": true, ... }`；失败 `{ "ok": false, "error": "<code>", "message"?: string }`。

## 错误码 → HTTP 状态

| error | status |
|---|---|
| `bad_request` / `invalid_unit` / `invalid_action` / `invalid_path` | 400 |
| `forbidden`（路径不在白名单 / 越权） | 403 |
| `not_found` | 404 |
| `method_not_allowed` | 405 |
| `conflict`（mtime 不符） | 409 |
| `too_large` / `binary` | 413 / 415 |
| `locked`（需要 sudo 但未解锁） | 401 |
| `bad_password` / `sudo_unavailable` | 401 / 503 |
| `failed` | 500 |

## 1. `GET /dsh-server-panel/overview`

```jsonc
{
  "ok": true,
  "ts": 1760000000000,                     // 采样时间(ms)
  "host": { "hostname": "your-host", "distro": "Debian GNU/Linux 13", "kernel": "6.12.107+deb13-amd64", "arch": "x64" },
  "cpu": {
    "count": 4,
    "model": "Intel(R) ...",
    "busyPct": 12.3,                        // null = 还没攒够两次采样
    "breakdown": { "user":1,"nice":0,"system":2,"iowait":0,"irq":0,"steal":0,"idle":87 },  // 百分比, 可为 null
    "cores": [ { "id": 0, "pct": 10.2 } ],
    "load": [ 0.52, 0.41, 0.33 ]            // 1/5/15 分钟
  },
  "memory": {
    "totalBytes": 4.0e9, "availableBytes": 3.3e9, "usedBytes": 0.7e9, "usedPct": 18.4,
    "cachedBytes": 0, "buffersBytes": 0,
    "swapTotalBytes": 2.1e9, "swapUsedBytes": 524288, "swapUsedPct": 0.02
  },
  "disks": [ { "mount":"/", "fs":"ext4", "totalBytes":0,"usedBytes":0,"availableBytes":0,"usedPct":0 } ],
  "network": { "interfaces": [ { "name":"enp7s0", "rxBytesPerSec":12, "txBytesPerSec":0, "rxTotalBytes":0, "txTotalBytes":0 } ] },
  "processes": { "total": 210, "running": 2 },
  "uptimeSec": 123456
}
```

字段缺失一律用 `null`，**不要省略键**（客户端按固定键渲染）。

## 2. `GET /dsh-server-panel/services?filter=<子串>`

```jsonc
{ "ok": true, "ts": 1760000000000, "privileged": false,
  "units": [ { "unit":"ssh.service", "load":"loaded", "active":"active", "sub":"running",
               "description":"OpenBSD Secure Shell server", "enabled": true } ] }
```
`enabled` 为 `true|false|null`（未知为 null）。`filter` 对 unit 名与 description 做不区分大小写的子串匹配（客户端也会本地过滤，服务端过滤只是优化）。

## 3. `POST /dsh-server-panel/services/action`  body `{ "unit": "cron.service", "action": "restart" }`

`action ∈ start | stop | restart | reload | enable | disable`。
成功：`{ "ok": true, "unit":"cron.service", "action":"restart", "active":"active", "sub":"running", "output":"…" }`
需 sudo 时未解锁：HTTP 401 `{ "ok": false, "error": "locked", "message": "需要先解锁 sudo" }`
白名单外的单元名 → 400 `invalid_unit`。

## 4. `GET /dsh-server-panel/services/logs?unit=<unit>&lines=<1..2000>`

```jsonc
{ "ok": true, "unit":"ssh.service", "lines": ["2026-10-08T16:00:00+08:00 host sshd[1]: ..."], "privileged": true, "truncated": false }
```
未解锁时仍返回 200，`privileged:false`（可能只有本用户可见的条目），客户端提示"解锁后可看完整日志"。

## 5. sudo 通道

- `GET  /dsh-server-panel/sudo/state` → `{ "ok": true, "unlocked": false, "expiresAt": null }`
- `POST /dsh-server-panel/sudo/unlock` body `{ "password": "..." }` → `{ "ok": true, "unlocked": true, "expiresAt": 1760000600000 }`；密码错 → 401 `{ "ok": false, "error": "bad_password" }`
- `POST /dsh-server-panel/sudo/lock` → `{ "ok": true, "unlocked": false }`

密码只存在于 Host 进程内存；客户端只在 React state 里持有，输入框 `type="password"`，不得写 localStorage/sessionStorage/cookie。

## 6. 文件

- `GET /dsh-server-panel/files/roots` → `{ "ok": true, "readRoots": ["/home/<user>","/etc","/var/log","/srv","/opt"], "writeRoots": ["/home/<user>"], "home": "/home/<user>" }`
- `GET /dsh-server-panel/files/list?path=<abs>` →
  `{ "ok": true, "path":"/home/<user>", "parent":"/home", "entries": [ { "name":"dsh-server-panel","path":"/path/to/dsh-server-panel","type":"dir","sizeBytes":4096,"mtimeMs":1760000000000,"mode":"755","symlink":false } ], "truncated": false }`
  （`type ∈ dir|file|link|other`；目录在前、再按名字排序；最多 2000 条，超出 `truncated:true`）
- `GET /dsh-server-panel/files/read?path=<abs>` → `{ "ok": true, "path":"…", "text":"…", "sizeBytes":123, "mtimeMs":1760000000000, "binary":false }`
  超过 1 MiB → 413 `too_large`；含 NUL 或非法 UTF-8 → 415 `binary`
- `PUT /dsh-server-panel/files/write?path=<abs>&mtime=<ms|null>` body `{ "text": "..." }`
  成功 `{ "ok": true, "path":"…", "sizeBytes":123, "mtimeMs":1760000000000 }`
  `mtime` 与磁盘现值不符 → 409 `{ "ok": false, "error":"conflict", "mtimeMs": <当前值> }`
  `mtime` 传 `null`/省略 = 强制覆盖
- `GET /dsh-server-panel/files/download?path=<abs>` → 原始字节 + `Content-Disposition: attachment; filename="…"`
- `PUT /dsh-server-panel/files/upload?path=<abs 目录>&name=<文件名>` body = 原始字节流 →
  `{ "ok": true, "path":"/home/<user>/x.bin", "sizeBytes":123 }`
- `POST /dsh-server-panel/files/mkdir` body `{ "path": "<abs>" }` → `{ "ok": true, "path":"…" }`
- `POST /dsh-server-panel/files/rename` body `{ "path":"<abs>", "to":"<abs 或新名字>" }` → `{ "ok": true, "path":"…", "to":"…" }`
- `POST /dsh-server-panel/files/delete` body `{ "path":"<abs>", "recursive": false }` → `{ "ok": true }`

## Client 半必须实现的行为

- 三个标签页：**概览 / 服务 / 文件**，右上角一个 sudo 状态胶囊（🔓 未解锁 / 🔒 已解锁·剩余 mm:ss / 点它可锁定）。
- 轮询：仅在面板为当前激活面板时轮询；概览 2s、服务 5s；切走立即停（用 `ctx.layout.panelInfo.getSnapshot().activePanelId === PANEL_ID` 判断）。日志/文件操作按需触发，不轮询。
- 所有写操作（服务动作、删除、覆盖保存）要有明确结果提示：成功/失败原因（`error` 码翻译成人话）。
- 需 sudo 的操作遇到 401 `locked` 时，直接弹出解锁对话框（输入密码）并在成功后重试一次原操作。
- 危险单元（`dangerUnits` 配置，Host 不会下发——客户端内置同一份默认表）执行 stop/restart 前弹二次确认，文案提示"可能切断你当前的 SSH 隧道连接"。
- 上传/下载用 `<input type="file">` + `fetch(PUT)` 原始 body；下载用 `window.open(url)` 或 `<a download>`。
- 文本编辑器是 `<textarea>` 级别即可（不引 CodeMirror）；带"未保存"标记与保存按钮。
