# dsh-smartremote

在本地 DSH Desktop 应用里直接操作**远端服务器上的 dsh**：在 **设置 → 远程主机**
配置服务器，配置好的每台主机会在**左侧栏出现一个以主机名命名的图标**，点图标即通过
SSH 连接、用远端 dsh 界面**接管中央区域**（无地址栏），并自动收起本地左侧栏。返回即
回到本地桌面界面；不需要来回切终端，也不需要单独开浏览器。

- 仓库：<https://github.com/marapapman/dsh-smartremote>
- 版本：`0.9.11`（见 [SPEC.md](SPEC.md) 修订记录）

<details>
<summary><b>English overview</b></summary>

A DSH Desktop (DeepSeek Harness) plugin that operates a `dsh` instance running on a
remote server from the local desktop app.

- Configure hosts in **Settings → Remote Hosts**; each saved host becomes a
  **sidebar icon named after the host**.
- Clicking it opens an SSH tunnel, launches (or attaches to) `dsh web` on the server,
  and takes over the central area with a **toolbar-less Electron `<webview>`** that
  hosts the remote UI (first-party cookie partition, so the remote session works).
- **First connect auto-installs** `dsh` on the server when missing
  (configurable command, default `npm install -g @deepseek-ai/dsh`).
- Port self-healing: leftover remote `dsh` processes are cleaned up, a free remote
  port is chosen when needed, and failures surface the real SSH output.
- **SSH config discovery**: import hosts from `~/.ssh/config` and `~/.ssh/known_hosts`.
- **Remote DeepSeek sign-in is forwarded to your local default browser**; the OAuth
  callback returns through the SSH tunnel to the remote host.
- Three modes: launch remote dsh over SSH, attach to a running dsh, or open a plain URL.

Requirements: DSH Desktop, an OpenSSH client with non-interactive key auth
(`BatchMode=yes`; use ssh-agent for passphrase keys), and Node.js + `dsh` on the server
(auto-installed on first connect if missing).

Install (see [安装](#安装) for all three ways):

1. `git clone https://github.com/marapapman/dsh-smartremote.git`
2. In DSH: sidebar **Plugins** → **Add plugin** → paste the absolute path of the clone
   (or run `dsh plugin add /path/to/dsh-smartremote` from a terminal).
3. Open **Settings → Remote Hosts**, add a server, then click its sidebar icon.

</details>

## 它能做什么

- 保存多台服务器的连接配置（名称、SSH 主机/端口/用户、私钥）——配置在
  **设置 → 远程主机** 里管理：设置页是简洁的主机列表，详细字段与「从本机 SSH 配置
  发现」在二级页面里。
- **每配置好一台远程主机，左侧栏就多一个以主机名命名的图标**；点它自动连接并接管
  窗口。远端视图顶部的「返回」回到**本地桌面界面（会话）**，不是配置页。
- **SSH 启动远端 dsh**：面板自动通过 SSH 在服务器上运行
  `dsh --profile web --port 39080 --no-open`，从启动输出里解析访问令牌，建立
  `127.0.0.1:<本地端口> → 127.0.0.1:39080` 的加密端口转发，然后用远端界面接管窗口。
- **断开后保持远端运行（默认开启）**：远端 dsh 会 `setsid` 脱离 SSH 会话在后台常驻。
  点「返回」「断开」、**本机睡眠**、断网甚至**关掉本机应用**，远端正在执行的任务都会继续；
  隧道断开后插件会按退避自动重连（沿用同一本地端口，远端页面自己接回去，任务与界面都不中断），
  下次连接自动复用同一个进程（令牌与日志都在远端 `~/.dsh/remote-desktop-web.log`）。
  可在主机配置里关闭（关闭后远端 dsh 随 SSH 会话结束而终止）。
- **手动重启远端**：远端视图顶栏有「重启远端」按钮，强制结束远端 dsh 并重新拉起
  （连接失败页也有），用于远端卡死或想清空远端状态时。
- **首次连接自动安装 dsh**：连接前先探测远端有没有 `dsh`；没有就自动执行可配置的
  安装命令（默认 `npm install -g @deepseek-ai/dsh`），安装输出实时显示在连接界面上，
  完成后继续启动。需要远端有 npm/Node.js 与网络。
- **SSH 连接已运行的 dsh**：远端已经手动跑着 dsh web 时，只做端口转发，填一下远端
  打印的访问令牌即可。
- **直接 URL**：远端已经有反向代理/公网地址时，直接打开完整 URL。

## 安装

本仓库就是一个完整的 DSH bundle（Host 插件 + Client 面板，含 `dsh.bundle.patch`），
不需要发布到 npm。先克隆到本机任意目录：

```sh
git clone https://github.com/marapapman/dsh-smartremote.git
```

> 桌面版、Web 版都内置了「插件」页和 `dsh plugin` 命令；装完通常立即生效，
> 如果界面提示「请重启 DSH 使更改生效」，按提示重启即可。

### 方式一：应用内安装（推荐，不用改配置文件）

1. 打开 DSH 应用，在左侧栏点 **插件**；
2. 点 **添加插件**（主按钮），或点它右侧箭头 → **安装第三方插件**；
   ——「添加插件」对话框的说明是「输入插件的包名、GitHub 仓库地址或本地目录路径」，
   支持 npm 包、Git 仓库、压缩包和**本地目录**；
3. 在 **包名或地址** 输入框里填下面任意一种，然后点 **安装**：
   - 本地目录绝对路径（推荐，仓库已克隆到本机）：
     - Windows：`C:\Users\me\src\dsh-smartremote`
     - macOS / Linux：`/Users/me/src/dsh-smartremote`
   - Git 地址：`git+https://github.com/marapapman/dsh-smartremote.git`
   - （若仓库不可匿名访问，请用本地目录方式，或换成你能访问的地址）
4. 等待安装任务跑完（对话框里能看到 pnpm 输出）；成功后该插件出现在
   **已安装插件** 列表里，并已加入 profile 的 `dsh.profile.bundles`。
5. 到 **设置 → 远程主机** 添加第一台服务器，保存后左侧栏出现以主机名命名的图标。

升级与卸载都在同一页面：插件详情里点 **卸载**；本插件不是 npm 包，
升级方式是「卸载后重新安装」（或直接 `git pull` 后重装）。

### 方式二：命令行

DSH 自带 `dsh plugin`，它把参数转发给 profile 目录里的 pnpm，并同步组合包选择：

```sh
# 本地目录（路径随便放在哪，指向仓库根目录）
dsh plugin add /Users/me/src/dsh-smartremote

# 或者 Git 仓库
dsh plugin add git+https://github.com/marapapman/dsh-smartremote.git

# 指定 profile（桌面版默认 profile 是 desktop）
dsh plugin --profile desktop add /Users/me/src/dsh-smartremote
```

装好后启动/重启 DSH 即可。卸载：`dsh plugin remove dsh-smartremote`。

> Windows 桌面版若 `dsh` 不在 PATH，可用应用自带的命令行入口：
> `<DSH 安装目录>\resources\runtime\cli\bin\dsh.cmd`。

### 方式三：手动编辑 profile（改代码时用这个）

开发调试时让 profile 直接**链接**源码目录，改完代码重载即可，不必反复安装：

1. 把仓库加入 profile 依赖（以 `desktop` profile 为例，
   `~/.dsh/profiles/desktop/package.json`）：

   ```json
   {
     "dependencies": {
       "dsh-smartremote": "link:/absolute/path/to/dsh-smartremote"
     },
     "dsh": {
       "profile": {
         "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-smartremote"]
       }
     }
   }
   ```

2. 在 profile 目录里安装依赖（生成 workspace 链接）：

   ```sh
   cd ~/.dsh/profiles/desktop
   pnpm install
   ```

3. 重启 DSH Desktop（或用插件页的开关触发一次重新组合）。

安装后左侧栏会出现已配置主机的图标（首次没有主机时，先在 **设置 → 远程主机**
添加一台）。

- Bundle id：`dsh-smartremote`
- Host 插件行：`remote-desktop`（`inject: webServer, connection`）
- Client 面板：`sidebar.panellist` id `remote-desktop` + `main` key `remote-desktop`
- 状态文件：`~/.dsh/remote-desktop.json`

## 使用前提

1. 本地是 DSH Desktop（本插件装在其 `desktop` profile 里）。
2. 本机能用 **SSH 密钥** 登录目标服务器（Windows 自带 OpenSSH 客户端即可：
   `ssh 用户名@服务器` 能免交互登录）。插件以 `BatchMode=yes` 运行，不会弹交互式
   密码/私钥口令输入；私钥有口令的请先启动 ssh-agent 并 `ssh-add`。
3. 服务器上已安装 `dsh` 命令，且非交互 SSH 会话的 PATH 能找到它；没装也没关系——
   首次连接会自动运行「自动安装命令」（默认 `npm install -g @deepseek-ai/dsh`，
   需要远端有 npm 与网络；可在设置里改成绝对路径/镜像源等）。

## 自动发现本机 SSH 配置

打开面板时会自动读取本机的 SSH 客户端配置，把「还没导入」的服务器列成候选，点「导入」
即可生成连接配置（默认用 SSH 启动远端 dsh 模式，远端端口 39080），不用手抄
host / user / port / 私钥路径。

读取来源：

- `~/.ssh/config`：按 `Host` 别名解析 `HostName` / `User` / `Port` / `IdentityFile`，
  支持 `Include`、`%h`/`%n`/`~`/`%d`；含通配符的 `Host` 与 `Match` 块会跳过。
- `~/.ssh/known_hosts`：只取明文 host（`|1|` 哈希条目无法反解，会在摘要里提示条数），
  支持 `[host]:port`。
- `ssh-add -l`：显示 ssh-agent 里有几个身份；同时检查 `~/.ssh/id_ed25519`、`id_rsa`、
  `id_ecdsa` 是否存在，作为「默认密钥」提示。

候选会与已保存的主机去重（host + port + user），已导入的显示为「已导入」并禁用。
`known_hosts` 里没有用户名，导入后使用 SSH 默认用户；密钥留空时由 `~/.ssh` 默认密钥
或 ssh-agent 决定。

如果 SSH 配置不在默认位置，可以设置环境变量 `DSH_REMOTE_DESKTOP_SSH_DIR` 指向实际
目录（例如 WSL 或自定义配置），重启桌面应用后生效。

## 使用步骤

1. **配置全部在 设置 → 远程主机**：页面是一个简洁的主机列表，可添加多台；
   「添加远程主机」进入二级表单，「从本机 SSH 配置发现」进入二级候选页。
   二级表单字段（三种模式）：
   - SSH 启动远端 dsh：SSH 主机、端口（默认 22）、用户名、私钥路径（留空用默认
     `~/.ssh/id_*` 或 ssh-agent）、远端端口（默认 39080），以及可选的
     **「断开后保持远端运行」**开关（见下）。
   - SSH 连接已运行 dsh：同上，另填远端 `dsh web:` 启动行里的 `token=...`。
   - 直接 URL：填完整地址（如 `https://dsh.example.com/?token=...`）。
   保存后可在编辑页点「测试」确认 SSH 能连通。
2. **使用**：每保存一台主机，左侧栏就出现一个**以主机名命名的图标**。点该图标：
   自动连接并把远端界面铺满中央区域（**无地址栏**），本地左侧栏自动收起。
3. 远端视图顶部有 `返回`、主机名、`重新加载`、`重启远端`、`断开`。点
   **「返回」回到本地桌面界面（会话）**，不会停在配置页；本地左侧栏同时恢复。

### 断开后保持远端运行

**默认开启**（主机配置里的「断开后保持远端运行」，可手动关闭）：

- 远端 dsh 用 `setsid nohup` 启动，**脱离 SSH 会话**（远端日志
  `~/.dsh/remote-desktop-web.log`），所以点「返回」「断开」、**本机睡眠**、断网、关掉桌面
  应用都不影响它；
- 远端正在跑的 agent 任务继续执行；隧道意外断开时插件按 `1.5s/3s/5s/8s/13s/21s` 退避
  自动重连（最多 6 次），并**沿用同一本地端口**，所以远端页面自带的重连能接回原地址，
  任务进度与界面都不丢；
- 下次点主机图标会**复用同一个进程**（令牌自动从远端日志读回），不会重启；
- 此时远端端口固定为配置的「远端端口」，不自动换端口；若被别的进程占用会明确报错；
- 关闭该开关后恢复旧行为：远端 dsh 随 SSH 会话一起结束；
- 想让它停下来：点远端视图里的 **「重启远端」**（强制结束并重新拉起），或到服务器上
  `pkill -f "dsh --profile web"`。

> 远端视图顶部如果显示「当前未开启『断开后保持远端运行』」提示条，点右侧
> 「开启并重启远端」即可一键切换（会重启远端一次）。

### 连接健壮性

- 连接前会检查远端端口：如果上一次连接残留的 dsh 还占着端口，会先清理它；仍被别的
  进程占用时自动换一个空闲端口（日志里会有 `[setup]` 提示）。开启「保持远端运行」时
  改为固定端口 + 复用，不做清理。
- 断开或启动失败时会尽力清理远端 dsh，避免残留阻塞下一次连接（保持远端运行时不做清理）。
- 隧道意外断开（睡眠、断网、Wi-Fi 切换）时，保持远端运行的主机会自动退避重连并复用原
  本地端口，远端任务不中断；重连日志里会看到 `[reconnect] …`。
- **远端视图打开期间会阻止本机空闲休眠**（申请屏幕唤醒锁，只在本机页面可见时持有）：
  Windows 现代待机会断开网卡，是「频繁断线重连」的常见原因。离开远端视图即释放，不影响
  正常待机。远端视图顶部在断线期间会显示「正在自动重连」提示，不会让人误以为程序出错。
- 连接失败时错误信息会附带远端最近输出，便于直接定位（端口占用、权限、命令不存在等）。
- **远端卡住或想重置**：点远端视图顶栏的 **「重启远端」**——结束远端 dsh、等端口释放，
  再重建连接（会中断正在执行的任务，所以按钮放在「重新加载」旁边而不是自动触发）。
- **远端登录（DeepSeek 账号授权）会转发到你本地的默认浏览器**：远端页面点登录后，
  授权页在本地浏览器打开；登录完成的回调经本地 SSH 隧道回到远端 dsh，远端视图里
  账号状态会自动更新。登录过程中请保持远端视图（隧道）开着。若状态没刷新，点顶栏
  「重新加载」。

### 实现方式与边界

桌面应用的外壳（窗口、标题栏、左侧栏）由 Electron 主进程和本地 Host 驱动，插件没有
接口把主窗口换成另一个 Host 的外壳，也不能让主窗口导航到远端 URL。可行的官方路径是
应用内置的 **Browser guest 租约**（preload 暴露 `dshDesktop.browser.acquire/release`）：
插件在**自己的中央面板里**创建一个无工具栏的 Electron `<webview>`（独立顶层文档与
cookie 分区），远端 dsh 的 `SameSite=Strict` 登录态是第一方会话，登录与 WebSocket 都
正常。这样中央区域被远端界面完全替代，也没有地址栏。

为什么不能用普通 iframe：iframe 处于 `dsh-app://app` 的跨站上下文，Chromium 不发送
Strict cookie，远端页面会显示 “dsh web authentication required”。

仍无法由插件替换的是本地**系统标题栏**与窗口级控件（属于应用外壳）；左侧栏会在接管
时自动收起、退出时恢复。

## 安全说明

- 端口转发只监听 `127.0.0.1`，远端 dsh 保持默认的回环绑定，流量全程走 SSH 加密通道。
- 连接配置保存在本机 `~/.dsh/remote-desktop.json`，其中包含远端访问 `token`（明文）。
  该文件只有本机当前用户可读，请勿分享。
- 面板里的所有 HTTP 接口都只在 owner（本机已登录的桌面用户）身份下可用，未鉴权请求
  一律 401。

## 已知限制

- 只支持密钥/ssh-agent 认证，不支持在插件里输入密码。
- 接管的是中央内容区：远端界面里自带它的左侧栏、会话和文件管理器；本地**系统标题栏**
  与窗口级控件仍保留（应用外壳，插件无法替换）。本地左侧栏会在接管时自动收起。
- 内嵌 webview 出于应用安全策略拒绝下载与多数浏览器权限，DSH 界面本身不受影响。
- webview 的 cookie 不跨应用重启保留：重启后重新点「连接」会自动重新接管并登录。
- 远端和本地 dsh 版本不一致时，界面以远端版本为准，个别新面板可能缺失。
- 首次连接会 `accept-new` 记录服务器主机密钥（写入系统 known_hosts）。
- 「断开后保持远端运行」要求远端有 `setsid`（util-linux，主流发行版默认有）；没有时自动
  退回 `nohup`。保活期间端口固定、远端日志会持续增长（超过 2 MB 自动轮转为 `.log.1`）。

## 开发与自测

仓库里就是完整源码（Host 半 `index.js`、Client 半 `client.js`，`SPEC.md` 为设计与
协议说明），无需构建步骤：client 侧是浏览器模块，由 DSH 直接按模块加载器执行。

```sh
# Host 半冒烟测试（假 ctx + 真实 HTTP，隔离 DSH_HOME，不触网/不启动 ssh）
node test/host-smoke.mjs

# 「保持远端运行」与「重启远端」的纯函数测试（argv 与远端脚本约束）
node test/detached-smoke.mjs

# Client 半冒烟测试（模块加载、槽位注册、中英文字典键对齐）
node test/client-smoke.mjs

# 语法检查（两个半；index.js 是 ESM）
node --check client.js
cp index.js /tmp/index.mjs && node --check /tmp/index.mjs
```

SSH 隧道与远端界面需要真实服务器联调：添加一台能免密 SSH 登录、且已安装 `dsh` 的
服务器，先点「测试」，再点「连接」。

## 排障

- 面板里展开连接日志看 SSH/dsh 输出；也可在终端手动复现：

  ```sh
  ssh -o BatchMode=yes -p 22 -L 127.0.0.1:40123:127.0.0.1:39080 user@server \
      "dsh --profile web --port 39080 --no-open"
  ```

  看到 `dsh web: http://127.0.0.1:39080/?token=...` 后，本地打开
  `http://127.0.0.1:40123/?token=...` 应能进入远端界面。
- 远端页面提示 `dsh web authentication required`：说明页面没拿到远端会话 cookie。
  用「在桌面中打开」（右侧 Browser 面板，第一方 webview）或「在浏览器打开」，
  不要把远端页面放进中央内嵌 iframe（跨站 Strict cookie 会被浏览器拦截）。
- 远端要登录 DeepSeek 账号：点「登录」后插件会自动把授权页放到**本机默认浏览器**
  （远端页面的登录流程会先 `window.open("about:blank")` 预开标签页、拿到授权地址后
  再跳转；插件接管这次跳转，由本机 Host 进程拉起浏览器，因此不需要用户手势）。
  授权页回调到 `http://127.0.0.1:<本地端口>/…`，经 SSH 隧道回到远端 dsh 完成登录；
  期间保持远端视图打开（隧道断了回调就断了）。远端视图底部也会出现登录操作条
  （「在浏览器打开」「复制链接」）作为手动兜底。排查用
  `~/.dsh/remote-desktop-client.log`（`kind:"login-link"` 的 `via` 字段会说明链接来源，
  `kind:"open-url"` 记录本机浏览器是否被成功拉起，`kind:"remote-log"` 是远端 SSH 通道
  输出）与 `~/.dsh/remote-desktop-ssh.log`（同一份输出的完整镜像，含远端 dsh 自己
  打印的 `[deepseek-account] …` 错误码）。
- 远端账号登录成功但「账号资料/余额」读取失败：平台接口
  `GET /auth-api/v0/users/current` 返回 403，属于平台侧权限问题，不影响对话
  （`https://api.deepseek.com/models` 正常；日志里会反复出现
  `[deepseek-account] request failed … status: 403`）。
- `Permission denied`：确认公钥已装到服务器 `~/.ssh/authorized_keys`，或私钥路径正确。
- `command not found`：在「启动命令」里用 `dsh` 的绝对路径。
- 远端端口被占用：换一个远端端口（同时改启动命令里的 `--port`）。
- 「保持远端运行」下连接报 `远端端口 39080 上已有一个 dsh，但日志里没有它的访问令牌`：
  说明该端口上的 dsh 不是本插件启动的（或日志被清掉）。到服务器上结束该进程
  （`pkill -f "dsh --profile web"`）后重连，或改用「SSH 连接已运行的 dsh」模式手动填令牌。
- 远端卡死、想清空远端状态：点远端视图顶栏「重启远端」；也可以在服务器上执行
  `pkill -f "dsh --profile web"` 后本地点「重新加载」重连。
- **状态在「连接成功」和「重连中」之间反复切换**：这是并发连接导致的抖动，已在 v0.10.3
  修复（重连与手动 `/connect` 复用同一条连接记录，所有 ssh 子进程按集合清理，不再留孤儿
  占用本地端口）。如果仍出现，看 `~/.dsh/remote-desktop-ssh.log`：正常重连应该是
  `[reconnect] → [setup] 复用远端已运行的 dsh → [ready]` 三步，且同一时刻不应出现多条
  `[setup] 步骤超时`。
- **频繁断线重连 / 远端 GUI 反复刷新**：先看 `~/.dsh/remote-desktop-ssh.log`。如果出现
  `Connection reset by <服务器> port 22` 或 `client_loop: send disconnect`，通常是本机
  网络或电源管理导致的（Windows「现代待机」会断开网卡），不是服务器踢人也不是插件出错。
  处理：把远端视图保持打开（插件会阻止空闲休眠触发待机），或延长电池模式的睡眠时间、
  把无线网卡省电模式设为最高性能。
  验证命令：`powercfg /q SCHEME_CURRENT SUB_SLEEP STANDBYIDLE`（看电池模式的待机时间），
  `Get-WinEvent -FilterHashtable @{LogName='System';Id=506,507} -MaxEvents 10`
  （看待机进出记录）。

## 许可

[MIT](LICENSE)
