# Remote Desktop 插件实现规格（内部）

目标：在本地 DSH Desktop 应用里新增一个侧边栏面板「远程主机」，让用户通过 SSH
连接服务器上运行的 dsh，并把远端 dsh 的 Web GUI 内嵌到面板里直接操作。

## 交付物（bundle 目录 `remote-desktop/`）

| 文件 | 负责人 | 说明 |
|---|---|---|
| `package.json` / `cordis.patch.yml` / `locale/*.json` / `icon.svg` | Lead（已完成） | 不用改 |
| `index.js` | host-dev | Host 半：SSH 连接管理 + HTTP API + 持久化 |
| `client.js` | client-dev | Client 半：侧边栏图标 + 主面板 UI + iframe |
| `README.md` | Lead | 使用说明 |

禁止新增 npm 依赖；只用 Node 内置模块（`node:child_process`、`node:fs`、
`node:net`、`node:http`、`node:os`、`node:path`、`node:crypto`）和浏览器端
`require('react')`。

## 参考实现（照抄其模式，不要改它们）

- `ppt-studio/index.js`：`export const name` / `export const inject` / `apply(ctx)`、
  `ctx.effect(() => ctx.webServer.register({ kind:'prefix', path, handler }))`、
  手写 JSON 响应工具函数。
- `ppt-studio/client.js`：`window.__ModuleLoader__.load({ id, factory(require) {...} })`、
  内联 `<style>` 注入、ZH/EN 字典 + `ctx.locale.register/bind`、`useLocaleRevision`、
  `ctx.slots.inject('sidebar.panellist'/'main', () => ctx.slots.register(...))`。
- 面板注册细节：侧边栏 `{ name:'sidebar.panellist', id:'remote-desktop', order: 40,
  label: () => t('navLabel') }` + 图标组件（接收 `{ size, active }`）；
  主面板 `{ name:'main', key:'remote-desktop' }` + Panel 组件。
- 主题 token 一律用 `var(--dsw-alias-*)`（见 ppt-studio 的样式清单），不要写死颜色。

## Host 半（index.js）

```js
export const name = 'remote-desktop'
export const inject = ['webServer', 'connection']
export function apply(ctx) { ... }
```

### 鉴权（所有 API 请求）

```js
const admission = ctx.connection.admit({ headers: req.headers })
if ('rejection' in admission) return jsonResponse(res, admission.rejection ?? 401, { ok: false, error: 'unauthorized' })
if (admission.peer.principal.kind !== 'owner') return jsonResponse(res, 403, { ok: false, error: 'forbidden' })
```

`admit` 可能抛异常，要 try/catch 包住并回 401。

### HTTP API

前缀 `/remote-desktop/api`，`ctx.webServer.register({ kind: 'prefix', path: PREFIX, handler })`
注册在 `ctx.effect` 里。请求体上限 256 KiB，JSON。

- `GET  /state`
  → `{ ok:true, ssh:{ available:boolean, path:string|null, version:string|null },
        hosts: HostView[], active: Record<id, ConnectionView> }`
- `POST /hosts`      body `{ host: HostInput }` → `{ ok:true, host: HostView }`
- `POST /hosts/delete` body `{ id }` → 先断开再删除 → `{ ok:true }`
- `POST /connect`    body `{ id }` → 立即返回 `{ ok:true }`，后台按「探测 → 常驻启动/复用 → 建隧道」推进，客户端轮询 `/state`
- `POST /disconnect` body `{ id }` → 只拆本地隧道，**不结束远端 dsh** → `{ ok:true }`
- `POST /stop`       body `{ id }` → 唯一会主动结束远端 dsh 的操作：先断开隧道，再结束远端
  `<remotePort>` 上的 dsh 并等端口释放 → `{ ok:true, stopped:boolean }`（未知 id 404）
- `POST /restart`    body `{ id }` → 结束远端端口上的 dsh 并等端口释放，再重建连接与隧道
  → `{ ok:true }`（未知 id 404）
- `POST /test`       body `{ id }` → 同步跑一次 SSH 测试（60s 总超时）→ `{ ok:true, output }` 或 `{ ok:false, error }`
- `POST /client-report` body `{ report }` → 追加一行 JSON 到 `$DSH_HOME/remote-desktop-client.log`
- `POST /open-url`    body `{ url }` → 用 Host 所在机器的默认浏览器打开该链接
  （远端登录授权页用；仅 http(s)、≤4096 字符、不含账号口令）→ `{ ok:true, opened:true, via }`

`HostView = { id, name, host, port, user, identityFile, remotePort, updatedAt }`
`ConnectionView = { id, status, url, error, log, localPort, startedAt }`
- `status`: `'connecting' | 'connected' | 'error' | 'disconnected'`
- `url`: 远端页面地址，仅 `connected` 时有值
- `log`: string[]，最多保留 80 行

**连接方式固定为「SSH + 自动探测」，没有 mode / URL / token / 保活开关等配置**（v0.11.0 起）：
连接时先在远端探测 `<remotePort>`——已有 dsh 就取回令牌复用（正在执行的任务不中断）；没有就用
`setsid nohup` 脱离 ssh 会话常驻启动；端口被别的进程占用则明确失败。隧道只做 `-L`（`-N`，
不执行远端命令），因此本地断开/退出不影响远端。旧版本配置里的 `mode` / `url` / `token` /
`launchCommand` / `installCommand` / `keepRemoteRunning` 字段在读写时一律忽略。

HostInput 校验：`name` ≤80（缺省用 host）；`host` 必填 ≤255；`user` ≤128；
`identityFile` ≤1024（去掉首尾空白）；`port` 默认 22、`remotePort` 默认 39080，范围 1–65535。
远端启动命令固定 `dsh --profile web --port {port} --no-open`，安装命令固定
`npm install -g @deepseek-ai/dsh`。

### 持久化

`$DSH_HOME/remote-desktop.json`（`DSH_HOME` 环境变量，缺省 `path.join(os.homedir(), '.dsh')`；
目录不存在时 mkdir -p）。结构 `{ version: 1, hosts: HostView[] }`，写临时文件再 rename。
启动时读取，坏文件忽略并重命名为 `.bak`。`id` 用 `crypto.randomUUID()`。

### SSH 连接（自动探测 + 永远常驻 + 只建隧道）

首次连接先探测非交互 SSH 会话的 `dsh` 命令（25s 步骤超时）。仅当 SSH **exit 0** 且
stdout 中有唯一、完整的 `DSH_OK` / `DSH_MISSING` 状态行时，才判定命令可用 / 缺失。
仅确切 `DSH_MISSING` 才允许自动执行安装命令；认证失败（exit 255）、网络错误、
超时/null、进程错误、stderr 中的标记、缺失/歧义标记都必须失败并保留 SSH 诊断，不能
当成命令缺失。安装 exit 0 后须同样复查，复查失败不等于仍未安装、更不能报安装完成。
`DSH_MISSING` 表示该 SSH 会话的 PATH 找不到命令，不证明磁盘上从未安装过 dsh。

远端步骤 stdout/stderr 独立保留、合并 output 继续写日志；等 `close` 排空输出后结算。
准备/旧实例迁移阶段若 SSH 失败或返回未知状态，应停止且不自动清理远端进程；只有
成功执行的准备脚本明确返回新起 `PID:<数字>` 和 `FAILED=no-token` 才可回收本次启动。

1. `net.createServer()` 在 `127.0.0.1:0` 监听拿到空闲 `localPort` 后立刻 close。
2. 找 ssh：`where ssh`（win32）/ `which ssh`，缓存结果；找不到则连接直接报错
   「未找到 ssh 客户端（Windows 可在“设置 → 应用 → 可选功能”中安装 OpenSSH 客户端）」。
3. spawn（`node:child_process`，`windowsHide: true`）：
   ```
   ssh -o BatchMode=yes -o ConnectTimeout=10 -o ExitOnForwardFailure=yes
       -o StrictHostKeyChecking=accept-new -o ServerAliveInterval=15 -o ServerAliveCountMax=3
       -o TCPKeepAlive=yes
       -p <port> [-i <identityFile 展开 ~>]
       -L 127.0.0.1:<localPort>:127.0.0.1:<remotePort> -N <user>@<host>
   ```
   永远带 `-N`：远端 dsh 不挂在 ssh 会话下，断开只影响隧道。
4. 合并 stdout+stderr 进 ring buffer（脱敏：`token=` 值打码；token 本身来自探测脚本，
   不再从 ssh 输出里解析）。
5. 用 `node:http` 请求 `http://127.0.0.1:<localPort>/`（3s 超时，忽略 401/302），
   有响应即 `connected`，`url = http://127.0.0.1:<localPort>/?token=<token>`。
6. 45s 没就绪 → `error`，附最后 20 行日志；进程退出时：未就绪 → `error`，已就绪 →
   `disconnected` 并进入自动重连退避。
7. 断开：`child.kill()`，2 秒后仍活着则 win32 `taskkill /pid <pid> /T /F`；
   **不清理远端进程**。插件卸载（`ctx.effect` 清理）时同样只断开本地隧道。
8. 每次连接都先执行「自动探测 + 常驻启动」（`prepareDetachedRemoteDsh`）：
   1. 远端脚本（base64 交给 `sh`）检查 `<remotePort>`：有 dsh → 从
      `~/.dsh/remote-desktop-web.log` 里按 `:<port>/?token=` 取回令牌并复用（`REUSE=1`）；
      端口空闲 → `setsid nohup sh -c <固定启动命令>` 后台启动，只读本次新增日志行里的令牌
      （`REUSE=0`）；端口被别的进程占用 → `FAILED=port-busy`；有 dsh 但日志里没有令牌
      （旧版本残留）→ 结束该进程后按常驻方式重启一次。
   2. 隧道只做 `-L`（`-N`），远端进程独立于 ssh 会话。
   3. 隧道意外断开（睡眠/断网/Wi-Fi 切换）按 `1.5s/3s/5s/8s/13s/21s` 退避自动重连（最多 6 次），
      沿用原本地端口；重连后复用同一个远端进程。
   4. 远端日志固定为 `~/.dsh/remote-desktop-web.log`（>2 MB 时轮转为 `.1`）。
9. `POST /stop`（停止远端）与 `POST /restart`（重启远端）是唯一会结束远端 dsh 的操作：
   `stop` 结束端口上的 dsh 后不再重连（`userStopped` 抑制自动重连），`restart` 结束等端口释放后
   重新建连（新连接会自动常驻启动）。

SSH 测试：`ssh -o BatchMode=yes -o ConnectTimeout=8 -o StrictHostKeyChecking=accept-new
-p <port> [-i <key>] <user>@<host> "echo dsh-ssh-ok"`，60s 总超时，返回输出或原始错误；
超时文案从 `TEST_TIMEOUT_MS` 动态生成。`ConnectTimeout=8` 仅控制 OpenSSH 自身的连接/握手，
不把认证与远端命令等待强制截成 12s。

注意：Windows 下 `ssh.exe` 可能要求私钥无口令（BatchMode 不弹交互）；报错信息要原样
带给 UI，提示用户用 ssh-agent 或免密密钥。

## Client 半（client.js）

`window.__ModuleLoader__.load({ id: 'dsh-smartremote', factory(require) {...} })`，
`const React = require('react'); const h = React.createElement`。

### 数据

- 挂载后 GET `/remote-desktop/api/state`，之后每 2.5s 轮询（panel 卸载时清 interval）。
- 本地 state：`data`（state 结果）、`draft`（正在编辑的 HostInput|null）、
  `frameId`（当前内嵌的 host id|null）、`error`、`busy`（正在执行的 action 键）。
- POST 统一 `fetch('/remote-desktop/api/...', { method:'POST', credentials:'same-origin',
  headers:{'content-type':'application/json'}, body: JSON.stringify(body) })`，
  `ok:false` 时把 `error` 抛出来显示。

### 视图

1. **iframe 视图**（`frameId` 对应连接 `connected` 且有 url）：整块面板
   `display:flex; flex-direction:column; height:100%; overflow:hidden`。
   顶栏：返回、主机名、状态点、「重新加载」「在浏览器打开」「断开」。
   `<iframe src={url} style={{border:0, width:'100%', height:'100%', flex:'1 1 auto'}} />`。
   返回按钮回到列表。iframe key 加刷新计数以便重新挂载。
2. **列表视图**：
   - 头部：标题「远程主机」、说明、SSH 可用性（可用显示绿色点 + 路径；不可用显示安装提示）。
   - 「添加服务器」按钮 → 打开编辑卡。
   - 主机卡：名称、模式标签、`user@host:port`、状态 pill；按钮：
     `连接 / 断开`、`在面板中打开`（connected 时）、`在浏览器打开`、`测试`、`编辑`、`删除`。
   - 连接中/错误时显示 `log` 最后几行（等宽字体、可滚动）。
   - 空态：说明需要服务器已安装 dsh、可用 SSH 密钥登录、以及三种模式怎么选。
3. **编辑卡**（内联，非弹窗，v0.11.0 起只有 SSH 目标字段）：
   - 名称
   - SSH 主机、SSH 端口、用户名、私钥路径（可选，placeholder `~/.ssh/id_ed25519`）
   - 远端端口（默认 39080），下方说明「连接时自动探测远端 dsh：未运行则后台常驻启动，
     已在运行则直接接入（复用同一进程，任务不中断）」
   - 保存 / 取消；保存成功后刷新 state
4. **远端视图**（连接就绪后接管中央区域，无地址栏 webview）：
   顶栏 返回 / 主机名 / 重新加载 / 重启远端 / 停止远端（页内二次确认）/ 断开。
   「停止远端」「重启远端」是唯一会结束远端进程的入口，其余按钮只影响本地视图。

### 文案与样式

- ZH/EN 字典 + `ctx.locale.register('remoteDesktop','zh'|'en', dict)` +
  `ctx.locale.bind('remoteDesktop')`，用 `useLocaleRevision` 订阅（照抄 ppt-studio）。
- 样式：一个 `<style>` 元素作为组件内 React 节点渲染（面板卸载时随之移除），
  类名前缀 `rd-`，颜色全部 `var(--dsw-alias-*)`。不往 `document.head`/`document.body`
  挂 DOM。
- 不访问其他插件 DOM，不 append 到 document.body。

## 本地 SSH 自动发现（Host 半扩展）

目标：从本机已有的 SSH 客户端配置里自动发现「远端服务器」，让用户一键导入为连接配置，
不用手抄 host/user/port/private key。

### 数据来源

按顺序读取并合并：

1. `~/.ssh/config`（OpenSSH 用户配置；支持 `Include`，相对路径相对 `~/.ssh`，递归深度 ≤3、
   文件数 ≤20、单文件 ≤512 KiB）。
2. `~/.ssh/known_hosts`（仅取明文 host，跳过 `|1|` 哈希条目、`@cert-authority`/`@revoked`、
   含通配符的条目；支持 `[host]:port` 语法；默认端口 22；用户未知留空）。
3. 环境变量 `DSH_REMOTE_DESKTOP_SSH_DIR` 可覆盖 `~/.ssh` 目录（测试用；也允许指向自定义位置）。

解析 ssh_config 规则（务实简化版）：
- 关键字大小写不敏感；`Key value` 与 `Key=value` 均可；值两侧引号去掉。
- `Host` 可带多个 pattern：只保留「具体」别名（不含 `* ? [ !`）；含 glob 的 pattern 跳过。
- `Match` 块忽略（其后的设置不归属任何别名，直到下一个 `Host`）。
- 每个别名取该块内**第一次**出现的 `HostName` / `User` / `Port` / `IdentityFile`；
  顶层（首个 `Host` 之前）的 `User` / `Port` / `IdentityFile` 作为全局缺省。
- `HostName` 支持 `%h`（别名）与 `%n`；`%%` → `%`，其余未知 token 时回退用别名。
- `IdentityFile` 支持 `~` 前缀与 `%d`（用户家目录）；`Port` 非法时回退 22。
- 去重键：`host|port|user`（小写 host）；同键保留第一条（优先 ssh config，其次 known_hosts）。
- 每类来源最多 100 条；输出按名称排序。

`ssh-agent` / 默认密钥（best-effort，不读取任何密钥内容）：
- `ssh-add -l`（3 秒超时）：退出码 0 → 有 N 个身份；1 → agent 可用但无身份；2/失败 → 不可用。
- 检查 `~/.ssh/id_ed25519`、`id_rsa`、`id_ecdsa` 是否存在，返回存在的路径（≤3）。

### API

`GET /remote-desktop/api/discover`（鉴权规则同其他端点；结果缓存 5 秒）

```json
{
  "ok": true,
  "sources": [
    { "path": "C:\\Users\\x\\.ssh\\config", "exists": true, "entries": 3, "skipped": 0 },
    { "path": "C:\\Users\\x\\.ssh\\known_hosts", "exists": true, "entries": 8, "hashed": 4 }
  ],
  "agent": { "available": true, "keys": 2, "detail": "ssh-add -l 原始首行或错误" },
  "defaultKeys": ["~/.ssh/id_ed25519"],
  "candidates": [
    {
      "key": "ssh-config:prod",
      "source": "ssh-config",
      "sourcePath": "C:\\Users\\x\\.ssh\\config",
      "name": "prod",
      "alias": "prod",
      "host": "10.0.0.5",
      "port": 22,
      "user": "root",
      "identityFile": "~/.ssh/prod_key",
      "imported": false
    }
  ]
}
```

- `candidates[].key`：稳定去重键（`ssh-config:<alias>` / `known-hosts:<host>:<port>`）。
- `imported`：与已保存 host 匹配（host 相等 + port 相等 + user 为空或相等）。
- 读文件失败不报错：`sources[].exists=false`，接口仍返回 200。

### Client 半 UI

- 面板挂载时自动请求一次 `/remote-desktop/api/discover`；不参与 2.5s 轮询。
- 列表视图在主机卡列表上方显示「发现」卡片（仅当存在未导入候选）：
  - 标题「发现 N 个本地 SSH 主机」，副标题显示来源摘要（config/known_hosts 路径与条数、
    ssh-agent 身份数、默认密钥）。
  - 「刷新」「全部导入」按钮；每行显示名称、来源标签、`user@host:port`、密钥提示，
    右侧「导入」按钮（`imported` 候选显示「已导入」且禁用）。
  - 导入 = `POST /hosts`（v0.11.0 起不再有 mode），默认 `remotePort:39080`，
    `identityFile` 用候选值；成功后刷新 state 与 discover。
  - 读取失败时卡片内显示错误与「重试」，不影响主机列表。
- 全部导入串行执行（避免并发写 profile），完成后统一刷新。

## 交互验收点

- 侧边栏出现「远程主机」图标，点击打开主面板。
- 添加一台可 SSH 的服务器，点侧栏图标自动探测：远端没有 dsh 就后台常驻启动，已有就复用。
- 点「返回」/「断开」/关掉应用，远端任务继续运行；重新点图标复用同一进程。
- 「停止远端」页内二次确认后结束远端 dsh；「重启远端」结束并重新拉起。
- 未配置 ssh 的机器上点 SSH 连接，能看到明确错误日志，不卡死、不崩面板。
- 面板关闭再打开，state 仍在；应用重启后 host 配置仍在（持久化）。
- API 未鉴权请求返回 401。

## 修订记录

### v0.3.0 — 界面承载从中央 iframe 改为右侧 Browser 面板

中央 iframe 方案不可行：桌面页顶层来源是 `dsh-app://app`，iframe 属跨站上下文，
Chromium 不发送远端 dsh 的 `SameSite=Strict` 会话 cookie，页面报
“dsh web authentication required”。自定义 `<webview>` 又受主进程 guest-lease 策略
限制（只有官方 Sidebar Browser 能申请），本地反向代理会与宿主自身 `/api` 路由冲突。

改为调用 Desktop 内置能力（与官方 Chat 插件打开链接的路径一致）：

```js
// 守卫：tab type 注册了就说明 Desktop Browser 可用
ctx.get('sidebarRightTabs')?.get('browser') !== undefined
// 打开标签：Desktop 下是独立 Electron webview（第一方 cookie 分区）
ctx.get('sidebarRight').openTab('browser', { params: { url } })
```

主面板占中央栏时没有“在屏会话”，`openTab` 会抛错，因此先
`ctx.get('layout').selectPanel('conversation')` 切回对话，再延时重试一次；
仍失败则退回 `window.open`（系统浏览器）。原中央 iframe 视图与相关状态已删除。

### v0.3.1 — 修复“点打开却弹出系统浏览器”

首版只重试一次（150ms）且用 `ctx.get` 取服务。实测主面板占中央栏时
`openTab` 抛 “sidebarRight: no session surface is mounted”，切回对话后 150ms
内会话面板可能尚未就绪，于是直接落到了外部浏览器兜底。

修复：改用显式 `ctx.inject(['sidebarRight','sidebarRightTabs','layout'], cb)` 拿服务；
先直接尝试，失败后 `layout.selectPanel(null)` 切回对话，再每 100ms 轮询 `openTab`
最多 3 秒（等待在屏会话与 Browser 标签类型就绪），只有彻底失败才打开系统浏览器。

### v0.4.0 — 连接后自动接管窗口

需求：连接远端后自动用远端 agent 界面替代本地 agent 界面（含远端自己的左侧栏与
右侧文件管理器）。

可行性结论：DSH Desktop 的窗口外壳由 Electron 主进程 + 本地 Host 驱动，
`lib/main.js` 只暴露 boot/browser/shortcuts 等 IPC，没有导航或“切换 Host”接口，
主窗口还被 `will-navigate` 拦截；插件无法把本地 React 外壳原地换成远端外壳，
也无法让主窗口加载远端 URL（且单向，无法返回）。

采用的官方支持路径：连接成功后自动

1. `openRemoteInApp(url)`：右侧 Browser 标签打开远端 URL（第一方 webview 会话）；
2. `presentRemoteView()`：等侧栏自身 `syncPresentation` 报告完普通布局后（450ms），
   调 `sidebarRight.toggleFullscreen(commandTarget())` 把该 Browser 面板切全屏；
   拿不到 dock pane 目标时退回 `layout.openRightbar(false, true)`；
3. 全屏的 Browser 面板覆盖窗口内容区，远端页面自带左侧栏/会话/文件管理器。

每个连接（`hostId|startedAt`）只自动接管一次；全部断连后复位
`remoteViewPresented`，允许下次连接重新接管。本地应用外壳（最左侧栏、系统标题栏、
应用控件）无法被插件替换，属于已知限制；文档中说明可用应用自带按钮收起左侧栏。

### v0.5.0 — 中央无地址栏 webview 接管 + 自动收起本地左侧栏

v0.4.0 用右侧 Browser 面板全屏，仍有面板自带的地址栏/工具栏，且左侧栏无法自动收起。
v0.5.0 改为插件自己的 `RemoteView`：用 preload 暴露的官方 *Browser guest 租约*
（`globalThis.dshDesktop.browser.acquire(workspaceKey)` → `{ lease, partition }`）
在中央面板内直接创建一个无工具栏的 `<webview>`：

1. `document.createElement('webview')`，`name=lease`、`partition=partition`、
   `src='about:blank#<lease>'`（主进程 `will-attach-webview` 按这三个值校验并放行），
   追加到面板容器；主进程在 `dom-ready` 后接管输入并设置 guest；
2. `dom-ready` 后 `webview.loadURL(remoteUrl)`（同官方 Browser 面板的时序），
   之后 `did-stop-loading` → ready、`did-fail-load` → 错误提示；
3. 卸载/返回时移除元素并 `bridge.release(lease)`。

本地左侧栏：通过注入的 `layout.toggleSidebar()` 在接管时收起、退出时恢复；
展开状态用框架变量 `--dsh-windows-sidebar-width`（>64px 视为展开）判断，
变量不存在（非 Windows）时按“未展开”处理以避免误展开。

接管入口：连接成功自动进入（每个 `hostId|startedAt` 一次；无 `dshDesktop.browser`
桥时（Web profile）不自动接管），或手动点「在桌面中打开」。退出：顶部「返回」或「断开」。
本地系统标题栏/窗口控件仍保留，插件无法替换。

### v0.6.0/v0.7.0 — 配置进设置，左侧栏只留一个按钮

v0.6.0 曾把每台已配置主机注册成独立 `sidebar.panellist` 入口；按用户要求回退：

- **配置**移到 `settings.section` 槽位的「远程主机」设置页（id
  `remote-desktop-settings`），保留增删改、测试、SSH 自动发现导入；
- **左侧栏只保留一个** `remote-desktop` 按钮，其 `main` 面板改为 `Launcher`：
  列出已配置主机并连接/打开；只有一台主机时进入面板即自动连接并接管；
- 每台主机的独立入口、`main` key `rd-host:*`、5 秒同步逻辑全部删除；
- 设置页复用原配置面板（`Panel` 的 `settingsMode` 变体）：隐藏连接/打开动作，
  只留测试/编辑/删除。

### v0.8.0 — 每主机左侧栏图标 + 返回本地界面 + 设置页二级结构

按用户要求再调整：

- **左侧栏按主机显示**：`syncHostEntries()` 每 5 秒同步 `GET /state`，为每台已保存主机
  注册一个 `sidebar.panellist` 入口（`id=rd-host:<hostId>`，`label=主机名`）和同名
  `main` 面板；改名/删除会重新注册或注销。左侧栏不再有固定的「远程主机」入口。
- **返回本地界面**：远端视图顶部「返回」调用 `layout.selectPanel(null)` 回到本地
  会话界面（不是配置页），并恢复本地左侧栏。
- **设置页二级结构**：`settings.section` 的页面只显示主机列表（名称 + 地址 + chevron）
  与两个入口按钮「添加远程主机」「从本机 SSH 配置发现」；表单与发现候选都放在二级
  视图，列表 → 二级页用 `back` 返回。
- 旧的 `Launcher`/`Panel` 组件删除，改为 `RemoteHostPage`（每主机页）+
  `RemoteSettingsPage`（列表/表单/发现三视图）。

### v0.9.0 — 首次连接自动安装远端 dsh

Host 半新增字段与启动前置步骤：

- `HostInput`/`HostView` 新增 `installCommand`（默认
  `npm install -g @deepseek-ai/dsh`；仅 launch 模式保留，其它模式强制空串）。
- `beginSshConnection` 在分配本地端口之前，launch 模式先执行 `ensureRemoteDsh()`：
  1. `ssh <target> "command -v dsh >/dev/null 2>&1 && echo DSH_OK || echo DSH_MISSING"`
     （超时 25s）；
  2. 旧行为是「输出无 `DSH_OK` 就安装」；**v0.11.1 已修正**为仅 SSH exit 0 且 stdout
     明确返回唯一完整 `DSH_MISSING` 才执行 `installCommand`（超时 600s，输出实时写入
     连接日志）。其它错误停止并保留诊断，不得自动安装；
  3. 安装后再探测一次；仍无 `dsh` 则 `failConnection` 并给出可操作提示
     （npm 缺失 / 修改安装命令 / 手动安装）；成功则日志 `[setup] dsh 安装完成` 后
     继续原有隧道+启动流程。
- 远端命令执行复用流式日志缓冲（`runRemoteStep`），安装期间 `conn.child` 指向当前
  ssh 子进程，用户断开时沿用 `terminateChild` 终止。
- 客户端设置表单（launch 模式）新增「自动安装命令」字段与说明；连接中界面显示
  连接日志最后 8 行，便于观察安装进度。

### v0.9.1 — 远端端口自愈 + 失败信息带日志

实测问题：插件重载/应用重启会杀掉本地 ssh，但远端 dsh 进程可能不退出，继续占用
`remotePort`（默认 39080）；下次 launch 时远端 dsh 绑定失败，ssh 以 code 1 退出，
界面只显示「SSH 进程在连接就绪前退出（code 1）」。

修复：

1. launch 模式在建立隧道前新增 `prepareRemotePort()`：用 base64 编码的远端 sh 脚本
   （避免引号/换行被远端 shell 破坏）执行：
   - `fuser -n tcp <port>` 找监听进程，`/proc/<pid>/cmdline` 含 `dsh` 时 kill（视为
     上一次连接残留），等待 1 秒；
   - 从配置端口向后最多 30 个端口用 `ss -ltn`（无 ss 时 netstat）找空闲；
   - 输出 `PORT=<n>` 或 `PORT=none`；结果写入 `conn.remotePort`，后续 `-L` 转发与
     启动命令的 `{port}` 都用最终端口。
2. `disconnectHost()` / `disconnectAllConnections()` / 启动失败时调用
   `cleanupRemotePort()`：尽力结束该端口上的 dsh，避免残留（仅 launch 模式）。
3. `handleSshExit` 在连接未就绪时把最近 8 行日志并入 `conn.error`，界面能看到远端
   真实报错（端口占用/权限等）。

### v0.9.5/v0.9.6 — 诊断降噪 + 远端登录转发到本地浏览器

- v0.9.5：页面自身的 `console.error`（如 `[deepseek-account] account read failed`）
  只写入 `~/.dsh/remote-desktop-client.log`，不再占用界面诊断条；诊断条只在探测到
  白屏（`#root` 未渲染/资源失败）时出现。`POST /client-report` 接收并追加诊断。
- v0.9.6：`RemoteView` 订阅 `dshDesktop.browser.onOpenRequested(lease, cb)`。远端页面
  的 `window.open` 弹窗（典型是 DeepSeek 账号授权页）会被主进程转成
  `browserOpenRequested` 并 deny；插件改为在**本地系统浏览器**打开该 URL。
  授权完成后回调地址是本机隧道 origin（`http://127.0.0.1:<localPort>/…`），
  经 SSH 隧道回到远端 dsh 完成登录，远端页面通过账号流自动刷新状态。

### v0.9.7 — 页面内登录链接兜底捕获

v0.9.6 实测仍未自动打开浏览器。日志显示主进程的 `browserOpenRequested` 只在
`postBody === undefined` 时转发，远端登录 UI 有的路径不经过它。补充页面内挂钩：
`RemoteView` 用 `executeJavaScript` 注入一次 `window.__rdLoginHook`，拦截

- `window.open(...)` 的第一个字符串参数；
- `document` 捕获阶段的 `a[href]` 点击（外部 http(s) 链接）；
- `navigator.clipboard.writeText(...)` 的入参（「复制登录链接」按钮）；

把 URL 暂存到 `window.__rdLoginUrl`，由 1500ms 轮询取走并清空，命中后打开本地浏览器，
同时 `POST /client-report {kind:'login-link'}` 写入 `~/.dsh/remote-desktop-client.log`
便于排查。

### v0.9.8 — Host 进程打开本机浏览器 + 登录提示与红字分离

v0.9.7 实测（日志两条 `login-link` 已捕获）：链接能捕获，但**没有自动打开浏览器**，
点「复制登录链接」后才打开。原因是渲染层 `window.open` 在定时器回调里调用没有用户
手势，被 Chromium 弹窗拦截器拦掉，`setWindowOpenHandler` 根本不会触发。

修复：

1. Host 半新增 `POST /remote-desktop/api/open-url`（鉴权同其他端点）：
   - 校验：仅 `http:`/`https:`、长度 ≤4096、不含账号口令，否则 400；
   - 用 `node:child_process` 在本机拉起默认浏览器
     （Windows `rundll32.exe url.dll,FileProtocolHandler <url>`、
     macOS `open <url>`、Linux `xdg-open <url>`），`detached + stdio:'ignore'`，
     `spawn` 事件或 2.5s 兜底即返回 `{ok:true, opened:true, via}`；
   - 结果追加到客户端诊断日志（`kind:'open-url'`）。
2. Client 半：`openExternalUrl(url)` 在 Desktop 宿主下优先走 Host 打开
   （任意时机都有效，不受弹窗拦截影响），失败才退回 `window.open`；
   `openWithWindow`/`copyText`（Clipboard API + textarea 兜底）抽成工具函数。
3. 远端视图新增**登录操作条**（主题色边框）：捕获到授权链接时显示
   「远端登录需要在本机浏览器完成授权」+「在浏览器打开」「复制链接」「知道了」，
   悬停可看到完整 URL；即使自动打开失败也能一键手动打开。
4. 提示与错误分离：正常事件（登录已打开/已复制）走中性的信息条
   （`.rd-remoteInfo`，次要文字色）；红色诊断条 `.rd-remoteDiag` 只留给真正的问题
   （页面加载失败、白屏探测）。此前登录提示也渲染成红字，属于误用错误样式。

### v0.9.9 — 「假弹窗」接管远端登录跳转（真正的根因）

v0.9.8 上线后实测仍卡在「等待登录」，日志显示本地浏览器只在点「复制登录链接」时
才被打开（`kind:"login-link" via` 缺省、`open-url opened:true`）。查
`dsh-client-ui-settings-account` 的 `BrowserLogin` 源码后确认根因：

```js
begin() {                                  // 在用户点击「登录」时同步执行
  this.popup = window.open('about:blank', '_blank')   // ① 预开标签页
}
update(view) {                             // Host 的登录尝试返回后才拿到地址
  if (!attempt?.authorizeUrl || this.navigated) return
  this.navigated = true
  this.popup.location.replace(this.destination(attempt.authorizeUrl))  // ② 事后跳转
}
```

①在 Electron 里必然被 deny（guest `setWindowOpenHandler` 只放行 http(s) 且
`postBody === undefined`；`about:blank` 直接拒绝）→ `this.popup === null`；
②因此真正的 `authorizeUrl` 永远不会经过 `window.open` 的入参。v0.9.7 的挂钩只能在
①看到 `about:blank`，所以永远等不到地址；「复制登录链接」按钮是平台给的兜底，
点它才触发 `navigator.clipboard.writeText(授权地址)`，被剪贴板挂钩捕获后才打开浏览器。

修复：注入的 `window.open` 对 `about:blank`/空 URL 返回一个**假弹窗**对象
（`opener`、`closed`、`close()`、`location.replace/assign/href` setter），
登录 UI 的②跳转落到我们的 setter 上，授权地址即被取走并由 Host 打开；页面看到
`popup` 非空，行为与真实弹窗一致（`popup.opener = null`、`popup.closed` 判断都成立）。
其余兜底保留：外链点击、剪贴板写入、JSON 响应体里的 `…/dsh/authorize?` 扫描。
捕获结果带 `via` 字段（`popup.replace` / `popup.href` / `window.open` /
`clipboard` / `anchor` / `fetch`）写入客户端诊断日志，便于区分来源。
另外每次主文档 `did-finish-load` 后立刻补装挂钩，缩小「页面已就绪但钩子未装」的窗口。

### v0.9.10/v0.9.11 — 远端登录失败的取证通道

v0.9.9 上线后实测（日志）：点击「登录」即自动在本地浏览器打开授权页，
`kind:"login-link" via:"popup.replace" opened:true channel:"host"` —— 假弹窗方案生效；
随后远端账号登录成功，`/root/.dsh/.credentials.yaml` 写入
`deepseek-account-platform/default` 授权记录。

排障期间补了两条取证通道（对功能无影响）：

- v0.9.10：`RemoteHostPage` 在连接就绪后每 3 秒读取 `GET /state` 的 `active[id].log`
  （SSH 通道合并输出，含远端 dsh 自己的 stderr），最后一行变化时回传
  `POST /client-report {kind:'remote-log', lines}`，写入
  `~/.dsh/remote-desktop-client.log`。
- v0.9.11：Host 半把同一份 SSH 输出镜像到 `$DSH_HOME/remote-desktop-ssh.log`
  （512 KiB 轮转、脱敏后写入、400ms 合并刷盘，插件卸载时 flush），
  不依赖客户端是否停留在远端面板。

已知遗留（不影响使用）：远端 `GET /auth-api/v0/users/current` 返回 403，
表现为账号资料/余额读取失败（`[deepseek-account] account read failed`，已被 UI 抑制）；
而 `https://api.deepseek.com/models` 正常返回 2 个模型，对话可用。

### v0.10.0 — 「断开后保持远端运行」+「重启远端」

需求：点「返回」后远端任务要能继续跑；关掉本机应用也不该杀掉远端任务；并且需要一个
手动重启远端 dsh 的按钮。

设计取舍：launch 模式的远端 dsh 原本是 ssh 会话的子进程，SSH 一断就被 SIGHUP 带走，
而且插件还会主动 `fuser` 清理端口。为此新增 `HostInput.keepRemoteRunning`（默认 false，
保持原有行为）：

- 启动：远端脚本用 `setsid nohup sh -c '<launchCommand>' >> ~/.dsh/remote-desktop-web.log`
  脱离会话常驻，令牌从日志里按 `:<port>/?token=` 读回（只读本次新增行，避免拿到旧进程令牌）；
  隧道改为 `-N` 纯转发。远端实测：启动 5s 内拿到令牌，SSH 退出后进程 PPID=1 仍存活。
- 复用：再次连接时探测端口，命中 dsh 就复用同一进程（`REUSE=1`，令牌不变），任务不中断。
- 断开：`cleanupRemotePort()` 对保活主机直接返回，不杀远端；插件卸载/退出应用同理。
- 端口策略：保活模式固定用配置的 `remotePort`（不自动换端口），被别人占用则明确报错，
  避免悄悄起第二个进程或复用到无关实例。

「重启远端」：新增 `POST /restart`，先结束远端端口上的 dsh（最多等 6s 释放端口，保活模式
也强制结束——这正是「重启」的语义），再重建连接与隧道；attach 模式只重建隧道。客户端在
远端视图顶栏加了「重启远端」按钮（连接失败页也有），点击后重新走一遍连接流程。

对应测试：`test/detached-smoke.mjs`（argv 与脚本约束）、host-smoke 新增保活字段与
`/restart` 校验；远端脚本的语法与行为在真实 Linux 服务器上用 `sh -n` + 两次运行验证。

### v0.10.1 — 保活改为默认开启 + 断链自动重连

实测事故：本机睡眠导致 SSH 断开（日志 `[ssh] 连接已退出（code 255）`），远端 dsh 随
会话终止，重连后远端崩溃恢复把正在跑的轮次标记为「已中止」。排查发现该主机配置仍是
v0.10.0 之前保存的旧记录（没有 `keepRemoteRunning` 字段），因此走的是「挂在 SSH 会话下」
的旧路径 —— 保活能力存在但没被启用。

修复：

1. **默认值改为开启**：`validateHostInput` 对 launch 模式用 `rawHost.keepRemoteRunning !== false`，
   即缺省（含旧配置迁移）为 true；显式存过 `false` 的主机保持关闭。这样升级后既有主机
   自动切到常驻模式，本机睡眠/断链不再影响远端任务。
2. **断链自动重连**（仅保持远端运行）：`handleSshExit` 在连接曾被意外中断时按
   `[1.5s, 3s, 5s, 8s, 13s, 21s]` 退避重试，最多 6 次；重试**沿用同一本地端口**，
   让远端页面自带的断线重连直接接回原 URL，任务与界面都不中断。用户主动「断开」/「重启」
   /删除主机时置 `userStopped` 并清除重连定时器，不会把连接拉回来。
3. **客户端提示与一键开启**：主机未开启保活时，远端视图顶部显示提示条
   （「本机睡眠、断网或断开连接会终止远端正在执行的任务」）和「开启并重启远端」按钮：
   按钮先 `POST /hosts` 写入 `keepRemoteRunning: true`，再走 `/restart` 切到常驻模式。
   设置表单的开关说明也改为「默认开启」。

### v0.10.2 — 频繁断线重连的定位与缓解

现象：v0.10.1 之后仍「频繁断线重连、远端 GUI 刷新」。

取证（三段互相印证）：

- 客户端 ssh 日志：`Connection reset by <server> port 22` / `client_loop: send disconnect:
  Connection reset`；24 小时内 13 次 `code 255`，集中在 09:54–14:07 本地时间。
- 服务端：`sshd_config` 全是默认值（`ClientAliveInterval 0`），无 OOM（内存 7.4G 用 5.5G），
  断链时刻 sshd **没有任何断开原因日志**（会话凭空消失）→ 不是服务器踢人。
- 本机：`Kernel-Power` 506/507 显示当天进入 **Modern Standby 16 次**（2 秒到 30 分钟），
  且每次「进入待机」时间与断链时间一一对应；电池模式 `STANDBYIDLE=180s`（3 分钟无操作
  即待机），待机期间网卡断开（`Connectivity state in standby: Disconnected, Adaptive`）。

结论：这是本机电源管理导致的链路中断，不是插件或远端的问题。保活本身是生效的 ——
远端 dsh 自 12:54 起持续运行 2 小时以上（PPID=1），期间多次断链都只重建隧道、没有重启远端，
任务未受影响。

缓解：

1. Host：SSH 连接参数增加 `-o TCPKeepAlive=yes`，让中间设备持续看到流量，减少长连接被
   静默回收/重置。
2. Client：远端视图挂载期间申请 `navigator.wakeLock('screen')`（只在本机页面可见时持有，
   `visibilitychange` 时释放），阻止「正在看远端界面时」因空闲进入现代待机；离开视图或
   隐藏页面立即释放，不影响正常待机。
3. Client：连接就绪后每 3 秒同步一次状态（`GET /state`），隧道中断/自动重连期间在远端
   视图顶部显示提示条（`linkReconnecting` / `linkDown`），并在本地端口变化时自动同步新的
   远端 URL（重挂 webview），不再需要用户手动「重新加载」。
4. 用户侧建议（插件无法代劳）：电池模式把「睡眠后」调长或改为插电；
   无线适配器「节能模式」设为最高性能（`powercfg /setdcvalueindex … 12bbebe6-… 0`）。

### v0.10.3 — 修复「连接成功 ↔ 重连中」反复抖动

现象：v0.10.2 之后，远端视图状态在「连接成功」和「连接重连中」之间反复切换。

取证：

- `~/.dsh/remote-desktop-ssh.log`：同一时段出现**交叠**的 `[setup] 步骤超时（约 75 秒）`
  与 `步骤超时（约 25 秒）`，并且已经 `[ready]` 之后仍在继续超时；
- 服务器侧 `ss -tn` 同时看到**多条**来自本机的 `:22` ESTAB 连接；
- 远端 `dsh` 未重启（keep-alive 日志 token 行数不变、进程已运行 2 小时+）。

根因：一次「自动重连」与一次「客户端 `/connect`（面板重挂载/用户点图标）」并发：

1. 两条连接记录各自 `spawn` 自己的 ssh（一次性 setup + 隧道）；
2. `conn.child` 原本是单槽，后启动的进程会覆盖前一个的引用，先启动的隧道因此**失去跟踪
   变成孤儿**，继续占着本地转发端口；
3. 孤儿占用端口 → 新隧道要么换端口（页面 URL 变化、webview 重挂 = 看起来像刷新），
   要么 `ExitOnForwardFailure` 直接退出（255）→ 再触发重连 → 状态来回翻。

修复：

1. `createConnection` 增加 `children: Set`，所有 ssh 子进程（一次性步骤与隧道）都经
   `trackChild()` 登记；`terminateChild()` 按集合全部结束，不再留孤儿。
2. `connectHost`：主机已有记录（disconnected/error）时**复用同一记录**发起重连，并清除
   待重连定时器与残留子进程，不再另起一条记录与自动重连并发。
3. `startConnection`：创建新记录前先停掉同一主机的残留记录（定时器 + 子进程）。
4. `retryConnection`：先 `terminateChild` 清掉残留，再重置状态重连（配合集合清理）。

验证：`test/host-smoke.mjs` 70/70、`test/client-smoke.mjs` 15/15、
`test/detached-smoke.mjs` 22/22；修复后日志不再出现同一时段交叠的 setup 步骤。

### v0.10.4 — 单飞连接尝试（彻底消除并发连接）

v0.10.3 修复后仍能观察到同一时段交叠的 `[setup] 步骤超时`，说明还有第二个入口在发起
连接：客户端 `/connect`（面板重挂载/点图标）、自动重连、重启后重建都可能触发
`beginSshConnection`，而它们之间只有「状态检查」这一层软约束——`beginSshConnection`
返回后状态仍是 `connecting`，但任何一次失败/超时都会把状态改回 `error`，让另一个入口
紧接着再起一份连接，于是表现为状态反复抖动。

修复：引入**连接尝试（attempt）**：

1. 每条连接记录带 `attempt`（编号）与 `attemptPromise`（在飞尝试）；
   `startAttempt(conn, options)` 是唯一入口：有在飞尝试则直接复用，否则编号 +1 并启动，
   在日志里打印 `[connect] 第 N 次连接尝试（initial/manual/auto-reconnect）`。
2. `beginSshConnection` 在每个 `await` 之后检查 `superseded()`（`conn.attempt` 是否已变），
   被作废的旧尝试在任意阶段自行退出，不会继续 spawn ssh 或改状态。
3. 主动断开/重启/新建记录时调用 `supersedeAttempt(conn)` 作废在飞尝试，并清掉定时器与子进程。
4. 客户端提示条加抖动抑制：连续两次 3 秒轮询都非 `connected` 才显示「正在自动重连」，
   避免几秒级中断让界面闪。

验证：host 70/70、client 15/15、detached 22/22；日志里每次连接都以
`[connect] 第 N 次连接尝试（…）` 开头，正常不会有两条尝试同时在飞。

### v0.10.5 — 修复 `runRemoteStep` 的「幽灵步骤超时」

v0.10.4 之后日志仍显示「`[ready]` 之后还不断出现 `[setup] 步骤超时（约 25/75 秒）`」，
据此一度判断为仍有并发连接。实际根因是 `runRemoteStep` 的 **`finish()` 没有清理超时
定时器**：

```js
const timer = setTimeout(() => { log('步骤超时'); kill(child); finish(null) }, timeoutMs)
// finish() 只 resolve，没有 clearTimeout(timer)
```

远端步骤（`ensureRemoteDsh` 25s、`prepareDetachedRemoteDsh` 75s）通常 1–2 秒就成功返回，
但它们的定时器仍在运行，到点后照样打印「步骤超时」（并对已退出的子进程调用 kill，无害）。
于是日志里出现「成功步骤的幽灵超时行」，与真实连接状态无关；每次连接都会留下 1–2 条，
拼接起来就像「一直在超时/重连」。

修复：`finish()` 中 `clearTimeout(timer)`，定时器回调内再判一次 `settled`；`[ready]`
日志追加连接尝试编号，方便区分「多次尝试」与「一次成功 + 幽灵行」。

说明：v0.10.3/v0.10.4 的孤儿进程清理与单飞尝试仍然有效（更硬的加固），但「状态反复
切换」的另一半原因是这些日志误导；真实重连只应由 `code 255` 触发。

### v0.10.6 — 远端页面周期性重连的根因（远端账号令牌失效）

现象：远端页面每 10–20 秒报 `[connection] connection lost, retry #1`，界面像在反复重连。

取证：

- 远端 `dsh` 进程稳定、`/?token=…` 返回 303（1–2 ms）、无 OOM、远端日志无网关/流错误；
- 自建独立隧道 + 真实 WebSocket 握手（自动回 Pong，服务端每 ~1.5 s Ping、错过 2 次
  `terminate()`），连接持续 5 分钟以上不断 —— 排除隧道与网络；
- 远端账号令牌自测：`/auth-api/v0/users/current` → **403**、`api.deepseek.com/models` → 401；
  远端 `remote-desktop-web.log` 里该接口持续报错（累计 966 次）。

根因：远端保存的 DeepSeek 账号令牌失效；客户端把 **Remote 流报错**视为连接失效
（`client-connection` 的 generation 语义），于是页面周期性重建连接。

处理：备份后从远端 `~/.dsh/.credentials.yaml` 删除 `deepseek-account-platform/default` 记录
（保留 `device`、其它 provider 与顶层 `refs:` 结构），重启远端 dsh；远端默认模型是
`omp/deepseek-v4.1-flash`，不依赖该账号，对话不受影响。要恢复账号就重新走登录流程。
另加 `kind:"ws"` 诊断（webview 内包装 `WebSocket`，记录 close code/reason/存活时长），
以后再遇到可直接区分「网络断开（1006）」与「对端主动关闭（1000/4xxx）」。

### v0.11.0 — 去掉连接方式/保活选项，改为「自动探测 + 永远常驻 + 停止远端」

需求：用户不希望再配置「SSH 启动 / SSH 连接已运行 / 直接 URL」三种模式，也不想要
「断开后保持远端运行」开关；期望的连接语义是——连接时自动探测远端有没有 dsh，没有就
后台常驻启动，有就直接接入；本地返回/断开/睡眠/关应用都不影响远端任务，除非本地显式
「停止远端」或「重启远端」。

Host 半：

- `HostInput`/`HostView` 收敛为 `{ id, name, host, port, user, identityFile, remotePort,
  updatedAt }`；`validateHostInput` 忽略旧字段（`mode`/`url`/`token`/`launchCommand`/
  `installCommand`/`keepRemoteRunning`），旧配置文件可直接读入（旧 `url` 模式记录因缺 host
  被丢弃）。启动/安装命令固定为常量。
- 每次连接都走 `prepareDetachedRemoteDsh`：探测端口 → 有 dsh 复用（`REUSE=1`）/
  没有则 `setsid nohup` 常驻启动（`REUSE=0`）/ 被非 dsh 进程占用明确失败
  （`FAILED=port-busy`）；有 dsh 但日志无令牌时结束并按常驻方式重启一次。
- `buildSshArgs` 永远带 `-N`，不再把启动命令交给 ssh；`cleanupRemotePort` 只记日志，
  `POST /disconnect`、插件卸载、应用退出都不结束远端 dsh。
- 新增 `POST /stop`（`buildRemoteStopScript`：`fuser` 找 dsh → `kill` → 等端口释放 →
  `kill -9` 兜底 → `STOPPED=0/1`），先断开隧道再结束远端，是唯一主动结束远端任务的操作；
  `POST /restart` 移除 `url` 模式 400 分支，`stop`/`restart` 未知 id 仍是 404。
- 删除 `prepareRemotePort`/`buildRemotePortPrepScript`/`isDetachedLaunch`/ssh 输出抓 token；
  导出改为 `{ buildRemoteDetachedLaunchScript, buildRemoteStopScript, buildSshArgs }`。

Client 半：

- 表单只剩六个字段 + `autoConnectHint`；删除模式选择器、URL/token/启动/安装命令输入、
  保活复选框及相关 i18n（中英同步，112→113 键）。
- 远端视图顶栏：返回 / 重新加载 / 重启远端 / 停止远端（页内二次确认，
  不再用原生 `window.confirm`）/ 断开；「断开」从危险样式改为普通样式；
  ready 时显示一行 `remoteKeepsRunning` 说明（返回/断开/睡眠/关应用都不影响远端）。
- 连接失败页也可直接「重启远端」「停止远端」。

测试：`host-smoke` 重写为新契约（102 项，含旧字段忽略、8 字段 HostView、`/stop` 404、
旧配置重载迁移）；`detached-smoke` 27 项（`-N` argv、启动/停止脚本约束）；
`client-smoke` 15 项。真机集成：在阿里云服务器（非 39080 测试端口）验证脚本 `sh -n`、
常驻启动、复用同 token、`ssh -N -L` 隧道 HTTP 303、`STOPPED=1/0`、端口释放且 39080
上的 dsh 不受影响。

### v0.11.1 — SSH 慢连接测试与探测失败误判修复

- `POST /test` 总超时由 12s 调整为 60s，超时文案从常量动态生成。实机曾在约 22s
  后成功认证，旧上限会提前报错；OpenSSH 的 `ConnectTimeout=8` 选项不变。
- `runRemoteStep` 分离 stdout/stderr、保留合并诊断与超时/进程错误，使用 `close` 等待输出
  排空。`ensureRemoteDsh` 采用 installed / missing / failed 三态：仅 exit 0 + stdout 的
  唯一完整状态标记可信，只有明确命令缺失才能自动安装；SSH 认证/网络/超时/未知输出不
  再伪装成未安装。安装后复查失败保留原始原因；确认仍缺命令时给出 PATH/手动安装提示。
- 远端准备/旧实例迁移同样检查 SSH 退出状态，失败时不接受部分 token、不触发清理。
  未知输出也不清理；只有本次新起 PID + 明确 `FAILED=no-token` 才回收。正常常驻启动
  日志区分「未运行」与「未安装」。不改正常连接/重连/停止/重启的生命周期。
- 新增 `test/ssh-regression.mjs`：可注入步骤/假子进程 + 虚拟时钟，不连接远端、不读私钥；
  覆盖三态、exit255、stderr 假标记、null/超时/未知/歧义输出、原始错误脱敏、安装后复查、
  未知状态不清理，以及 21.6s 成功/60s 边界。另用本机 node 子进程验证分流、close、
  进程失败与超时，未新增 npm 依赖。
