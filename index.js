/**
 * Host half of the Remote Desktop bundle（远程主机 / Remote Desktop）。
 *
 * 通过系统 ssh 连接远程服务器，把远端 dsh 的 Web GUI 内嵌到本地面板：
 * - 连接时自动探测远端 dsh：没有就 setsid/nohup 脱离 ssh 会话后台常驻启动，
 *   已有就直接复用同一进程（正在执行的任务不中断）；随后建立 127.0.0.1 本地端口转发。
 * - 返回/断开/本机睡眠/关闭应用都不结束远端 dsh；只有「停止远端」「重启远端」
 *   会主动结束它，隧道意外断开时自动重连。
 *
 * 本文件只负责 Host 半：SSH 进程管理、HTTP API、配置持久化。Client 半见
 * client.js；两侧的字段与状态机契约见同目录 SPEC.md，改动时必须保持同步。
 */
import { execFile, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { appendFile } from 'node:fs/promises'
import { get as httpGet } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'

export const name = 'remote-desktop'
export const inject = ['webServer', 'connection']

/* ========================================================================== *
 * 常量
 * ========================================================================== */

const API_PREFIX = '/remote-desktop/api'
const STORE_FILE_NAME = 'remote-desktop.json'
const STORE_VERSION = 1

const MAX_BODY_BYTES = 256 * 1024
const MAX_LOG_LINES = 80
const MAX_LINE_CHARS = 2000
const MAX_TEST_OUTPUT = 16 * 1024

const CONNECT_TIMEOUT_MS = 45_000
const INSTALL_TIMEOUT_MS = 600_000
const SETUP_PROBE_TIMEOUT_MS = 25_000
const PROBE_TIMEOUT_MS = 3_000
const PROBE_INTERVAL_MS = 750
const TEST_TIMEOUT_MS = 60_000
const KILL_GRACE_MS = 2_000
const COMMAND_TIMEOUT_MS = 5_000

const DEFAULT_LAUNCH_COMMAND = 'dsh --profile web --port {port} --no-open'
const DEFAULT_INSTALL_COMMAND = 'npm install -g @deepseek-ai/dsh'
const REMOTE_DSH_CHECK_COMMAND = 'command -v dsh >/dev/null 2>&1 && echo DSH_OK || echo DSH_MISSING'
const SSH_MISSING_MESSAGE =
  '未找到 ssh 客户端（Windows 可在“设置 → 应用 → 可选功能”中安装 OpenSSH 客户端）'

/** 建立转发连接时的 ssh 参数（SPEC 固定值，顺序即命令行顺序）。 */
const SSH_CONNECT_OPTIONS = [
  '-o', 'BatchMode=yes',
  '-o', 'ConnectTimeout=10',
  '-o', 'ExitOnForwardFailure=yes',
  '-o', 'StrictHostKeyChecking=accept-new',
  '-o', 'ServerAliveInterval=15',
  '-o', 'ServerAliveCountMax=3',
  // TCP 层保活：让链路中间设备看到持续流量，减少长连接被静默回收/重置。
  '-o', 'TCPKeepAlive=yes',
]

/** SSH 测试用的精简参数（SPEC 固定值）。 */
const SSH_TEST_OPTIONS = [
  '-o', 'BatchMode=yes',
  '-o', 'ConnectTimeout=8',
  '-o', 'StrictHostKeyChecking=accept-new',
]

const TOKEN_REDACT_PATTERN = /([?&]token=)[A-Za-z0-9._~-]+/g
const ANSI_ESCAPE_PATTERN = /\u001b\[[0-9;]*[A-Za-z]/g

/* 本地 SSH 自动发现（GET /discover）相关常量。 */
const DISCOVER_CACHE_MS = 5_000
const DISCOVER_MAX_ENTRIES = 100
const SSH_CONFIG_MAX_BYTES = 512 * 1024
const SSH_CONFIG_INCLUDE_DEPTH = 3
const SSH_CONFIG_INCLUDE_FILES = 20
const SSH_KNOWN_HOSTS_MAX_BYTES = 2 * 1024 * 1024
const SSH_ADD_TIMEOUT_MS = 3_000
const DEFAULT_KEY_NAMES = ['id_ed25519', 'id_rsa', 'id_ecdsa']

/* ========================================================================== *
 * 运行期状态
 *
 * 插件在 profile 中只挂载一次；状态放在模块作用域，apply 时初始化，卸载时清理。
 * ========================================================================== */

/** 已持久化的 HostView 列表（内存中的最新副本）。 */
let hosts = []
/** 配置加载 Promise（成功/失败都只执行一次），所有请求先 await 它。 */
let storeReady = null
/** 串行化的写盘队列，避免并发请求原子写互相覆盖。 */
let writeChain = Promise.resolve()
/** id -> 内部连接记录（ConnectionView 是它的对外投影）。 */
const connections = new Map()
/** 缓存的 ssh 探测结果 { available, path, version }；null 表示尚未探测。 */
let sshCache = null
/** 进行中的 ssh 探测 Promise，避免并发请求重复执行 where/which。 */
let sshPending = null
/** /discover 结果缓存（SPEC：5 秒；ssh 目录变化或 host 变更时提前失效）。 */
let discoverCache = { at: 0, sshDir: null, value: null }

/* ========================================================================== *
 * 基础工具
 * ========================================================================== */

function jsonResponse(res, status, value) {
  if (res.writableEnded) return
  const body = JSON.stringify(value)
  try {
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Length': Buffer.byteLength(body),
    })
    res.end(body)
  } catch {
    // 客户端可能在响应前断开，写失败不影响服务端状态。
  }
}

function httpError(statusCode, message) {
  const error = new Error(message)
  error.statusCode = statusCode
  return error
}

function toMessage(error) {
  return String(error?.message ?? error ?? 'unknown error')
}

/** 读取并解析 JSON 请求体，默认上限 256 KiB（与 SPEC 一致）。 */
function readJsonBody(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolvePromise, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(httpError(413, '请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8')
        resolvePromise(text ? JSON.parse(text) : {})
      } catch {
        reject(httpError(400, '请求体不是合法 JSON'))
      }
    })
    req.on('error', reject)
  })
}

/** 字符串字段统一 trim 并按 SPEC 上限截断。 */
function normalizeText(value, max) {
  if (typeof value !== 'string') return ''
  const text = value.trim()
  return text.length > max ? text.slice(0, max) : text
}

/** 端口字段：缺省取默认值，越界直接 400。 */
function parsePort(value, fallback, label) {
  if (value === undefined || value === null || value === '') return fallback
  if (typeof value !== 'number' && typeof value !== 'string') {
    throw httpError(400, `${label}格式不正确`)
  }
  const port = Number(value)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw httpError(400, `${label}必须是 1-65535 之间的整数`)
  }
  return port
}

/** 展开 `~` / `~/...`（SSH 私钥路径）。 */
function expandHomePath(value) {
  const text = String(value ?? '').trim()
  if (text === '~') return homedir()
  if (text.startsWith('~/') || text.startsWith('~\\')) return join(homedir(), text.slice(2))
  return text
}

function formatExit(code, signal) {
  if (signal) return `signal ${signal}`
  return `code ${code ?? 'unknown'}`
}

/** 把 argv 拼成可读命令行（仅用于日志展示）。 */
function formatCommand(file, args) {
  const parts = [file, ...args].map((part) => {
    const text = String(part)
    return /[\s"']/.test(text) ? `"${text.replaceAll('"', '\\"')}"` : text
  })
  return parts.join(' ')
}

/** 日志/输出脱敏：去掉 ANSI 控制符，隐去 token 值（私钥内容从不进入日志）。 */
function sanitizeOutputText(value) {
  return String(value ?? '')
    .replace(ANSI_ESCAPE_PATTERN, '')
    .replace(TOKEN_REDACT_PATTERN, '$1***')
}

/* ========================================================================== *
 * 配置持久化：$DSH_HOME/remote-desktop.json
 * ========================================================================== */

function dshHomeDirectory() {
  const fromEnv = typeof process.env.DSH_HOME === 'string' ? process.env.DSH_HOME.trim() : ''
  return fromEnv || join(homedir(), '.dsh')
}

function storeFilePath() {
  return join(dshHomeDirectory(), STORE_FILE_NAME)
}

/* 客户端诊断日志：webview 内页面状态与错误，便于排查白屏。 */
const CLIENT_REPORT_FILE = 'remote-desktop-client.log'
const CLIENT_REPORT_MAX_BYTES = 256 * 1024

async function appendClientReport(body) {
  const report = body && typeof body === 'object' ? body.report ?? body : null
  const line = JSON.stringify({ at: new Date().toISOString(), report }).slice(0, 20_000)
  const file = join(dshHomeDirectory(), CLIENT_REPORT_FILE)
  await mkdir(dshHomeDirectory(), { recursive: true })
  try {
    const info = await stat(file)
    if (info.size > CLIENT_REPORT_MAX_BYTES) await unlink(file)
  } catch {
    // 文件不存在时忽略。
  }
  await appendFile(file, `${line}\n`, 'utf8')
  return { ok: true }
}

/* ========================================================================== *
 * 本机浏览器：远端登录授权页必须由用户桌面上的默认浏览器打开
 * ========================================================================== */

/** 本机打开浏览器时允许的协议（避免把 file:/javascript: 之类交给系统）。 */
const OPEN_URL_PROTOCOLS = new Set(['http:', 'https:'])
const OPEN_URL_MAX_CHARS = 4096
const OPEN_URL_SETTLE_MS = 2_500

/**
 * 用 Host 所在机器的默认浏览器打开链接。
 * Host 与用户桌面同机（DSH Desktop 场景），因此比渲染层 window.open 可靠：
 * 定时器/后台逻辑里调用不会被 Chromium 弹窗拦截器拦掉。
 */
function openLocalBrowser(rawUrl) {
  const text = normalizeText(typeof rawUrl === 'string' ? rawUrl : '', OPEN_URL_MAX_CHARS)
  if (text === '') throw httpError(400, '缺少要打开的链接')
  let parsed
  try {
    parsed = new URL(text)
  } catch {
    throw httpError(400, '登录链接不是合法 URL')
  }
  if (!OPEN_URL_PROTOCOLS.has(parsed.protocol)) throw httpError(400, '仅支持 http/https 链接')
  if (parsed.username !== '' || parsed.password !== '') throw httpError(400, '登录链接不能包含账号口令')
  const target = parsed.href

  const command =
    process.platform === 'win32'
      ? { file: 'rundll32.exe', args: ['url.dll,FileProtocolHandler', target] }
      : process.platform === 'darwin'
        ? { file: 'open', args: [target] }
        : { file: 'xdg-open', args: [target] }

  return new Promise((resolvePromise, rejectPromise) => {
    let child
    try {
      child = spawn(command.file, command.args, { detached: true, stdio: 'ignore', windowsHide: true })
    } catch (cause) {
      rejectPromise(httpError(500, `无法调用系统浏览器：${toMessage(cause)}`))
      return
    }
    let settled = false
    const settle = (fn, value) => {
      if (settled) return
      settled = true
      fn(value)
    }
    // 定时器兜底：部分平台不会触发 spawn 事件，但进程已启动也不报错。
    const timer = setTimeout(() => settle(resolvePromise, { ok: true, opened: true, via: command.file }), OPEN_URL_SETTLE_MS)
    child.once('spawn', () => {
      clearTimeout(timer)
      try {
        child.unref()
      } catch {
        // 忽略 unref 失败。
      }
      settle(resolvePromise, { ok: true, opened: true, via: command.file })
    })
    child.once('error', (cause) => {
      clearTimeout(timer)
      settle(rejectPromise, httpError(500, `无法调用系统浏览器：${toMessage(cause)}`))
    })
  })
}

/** 把持久化记录还原为 HostView；校验失败的记录直接丢弃。 */
function restoreHost(record) {
  if (record === null || typeof record !== 'object' || Array.isArray(record)) return null
  let input
  try {
    input = validateHostInput(record)
  } catch {
    return null
  }
  const id = typeof record.id === 'string' && record.id.trim() ? record.id.trim() : randomUUID()
  const updatedAt =
    typeof record.updatedAt === 'string' && record.updatedAt ? record.updatedAt : new Date().toISOString()
  return {
    id,
    name: input.name,
    host: input.host,
    port: input.port,
    user: input.user,
    identityFile: input.identityFile,
    remotePort: input.remotePort,
    updatedAt,
  }
}

/** 损坏的配置文件重命名为 .bak，不阻塞插件启动。 */
async function quarantineStoreFile(file) {
  const backup = `${file}.bak`
  try {
    await rename(file, backup)
    return
  } catch {
    // Windows 上目标已存在或占用时，先删掉旧备份再重试一次。
  }
  try {
    await unlink(backup)
    await rename(file, backup)
  } catch {
    // 备份失败也不能影响面板启动。
  }
}

async function readStoreFile() {
  const file = storeFilePath()
  let raw
  try {
    raw = await readFile(file, 'utf8')
  } catch {
    return []
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('invalid store shape')
    }
  } catch {
    await quarantineStoreFile(file)
    return []
  }
  if (!Array.isArray(parsed.hosts)) return []
  const restored = []
  for (const record of parsed.hosts) {
    const host = restoreHost(record)
    if (host !== null) restored.push(host)
  }
  return restored
}

/** 原子写：同目录临时文件 + rename；配置里可能有访问令牌，权限收紧到 0600。 */
async function writeStoreSnapshot() {
  const file = storeFilePath()
  await mkdir(dirname(file), { recursive: true })
  const payload = `${JSON.stringify({ version: STORE_VERSION, hosts }, null, 2)}\n`
  const tempFile = `${file}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tempFile, payload, { encoding: 'utf8', mode: 0o600 })
  try {
    await rename(tempFile, file)
  } catch (error) {
    try {
      await unlink(tempFile)
    } catch {
      // 临时文件清理失败时忽略，避免掩盖真正的写盘错误。
    }
    throw error
  }
}

/** 串行排队写盘，返回本次写盘的 Promise。 */
function persistHosts() {
  const task = writeChain.then(() => writeStoreSnapshot())
  writeChain = task.catch(() => {})
  return task
}

/** 懒加载配置：apply 时预热一次，之后请求复用同一个 Promise。 */
function ensureStore() {
  if (storeReady === null) {
    storeReady = readStoreFile()
      .then((loaded) => {
        hosts = loaded
        return hosts
      })
      .catch(() => {
        hosts = []
        return hosts
      })
  }
  return storeReady
}

/* ========================================================================== *
 * HostInput 校验与 HostView 构造
 * ========================================================================== */

function defaultHostName(host) {
  return host ? host.slice(0, 80) : '远程服务器'
}

/** 按 SPEC 校验/归一化 HostInput，返回规范化的输入字段。 */
function validateHostInput(rawHost) {
  if (rawHost === null || typeof rawHost !== 'object' || Array.isArray(rawHost)) {
    throw httpError(400, '缺少 host 配置')
  }
  // 连接方式已固定为「SSH + 自动探测」：远端没有 dsh 就后台常驻启动，有就复用。
  // 旧配置里的 mode/url/token/launchCommand/installCommand/keepRemoteRunning 等字段
  // 一律忽略（只保留 SSH 目标本身），这样用户不再需要选择连接方式或保活策略。
  const host = normalizeText(rawHost.host, 255)
  if (!host) throw httpError(400, '请填写 SSH 主机地址')
  const user = normalizeText(rawHost.user, 128)
  const identityFile = normalizeText(rawHost.identityFile, 1024)
  const port = parsePort(rawHost.port, 22, 'SSH 端口')
  const remotePort = parsePort(rawHost.remotePort, 39080, '远端端口')
  let name = normalizeText(rawHost.name, 80)
  if (!name) name = defaultHostName(host)

  return { name, host, port, user, identityFile, remotePort }
}

/** 构造 HostView（字段名与顺序与 SPEC 一致）。 */
function makeHostView(input, existingId) {
  return {
    id: existingId ?? randomUUID(),
    name: input.name,
    host: input.host,
    port: input.port,
    user: input.user,
    identityFile: input.identityFile,
    remotePort: input.remotePort,
    updatedAt: new Date().toISOString(),
  }
}

function findHost(rawId) {
  if (typeof rawId !== 'string' || !rawId.trim()) return null
  const wanted = rawId.trim()
  return hosts.find((host) => host.id === wanted) ?? null
}

/* ========================================================================== *
 * 本地环境探测：ssh 可执行文件、版本、空闲本地端口
 * ========================================================================== */

/** 执行一次短命令并收集 stdout/stderr；调用失败（含 spawn 同步抛错）也永不 reject。 */
function runCommand(file, args, timeoutMs) {
  return new Promise((resolvePromise) => {
    try {
      execFile(file, args, { windowsHide: true, timeout: timeoutMs }, (error, stdout, stderr) => {
        resolvePromise({
          error: error ?? null,
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
        })
      })
    } catch (error) {
      // 极少数环境（受限沙箱/无法创建管道）会同步抛错；按命令失败降级。
      resolvePromise({ error: error ?? new Error('spawn failed'), stdout: '', stderr: '' })
    }
  })
}

async function locateSshPath() {
  const finder = process.platform === 'win32' ? 'where' : 'which'
  const result = await runCommand(finder, ['ssh'], COMMAND_TIMEOUT_MS)
  if (result.error) return null
  const lines = `${result.stdout}\n${result.stderr}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  return lines[0] ?? null
}

async function detectSshVersion(sshPath) {
  const result = await runCommand(sshPath, ['-V'], COMMAND_TIMEOUT_MS)
  const text = `${result.stderr}\n${result.stdout}`.trim()
  const firstLine = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean)
  return firstLine ? sanitizeOutputText(firstLine).slice(0, 200) : null
}

async function detectSsh() {
  const sshPath = await locateSshPath()
  if (!sshPath) return { available: false, path: null, version: null }
  const version = await detectSshVersion(sshPath)
  return { available: true, path: sshPath, version }
}

/** ssh 探测结果缓存（SPEC 要求缓存），并发请求共享同一个探测。 */
function resolveSsh() {
  if (sshCache !== null) return Promise.resolve(sshCache)
  if (sshPending !== null) return sshPending
  sshPending = detectSsh()
    .then((info) => {
      sshCache = info
      return info
    })
    .catch(() => {
      sshCache = { available: false, path: null, version: null }
      return sshCache
    })
    .then((info) => {
      sshPending = null
      return info
    })
  return sshPending
}

/** 在 127.0.0.1 上监听 0 号端口拿到空闲端口后立刻关闭（SPEC 步骤 1）。 */
function allocateLocalPort() {
  return new Promise((resolvePromise, rejectPromise) => {
    const server = createNetServer()
    server.unref()
    server.once('error', (error) => rejectPromise(error))
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = address !== null && typeof address === 'object' ? address.port : 0
      server.close(() => {
        if (typeof port === 'number' && port > 0) resolvePromise(port)
        else rejectPromise(new Error('无法分配本地端口'))
      })
    })
  })
}

/**
 * 优先复用指定本地端口（断链自动重连时用）：远端页面原本指向该端口的 URL，
 * 端口不变则页面自带的断线重连能直接接回去；端口被占时退回随机空闲端口。
 */
async function allocateLocalPortPreferring(preferred) {
  if (typeof preferred === 'number' && preferred > 0) {
    const free = await new Promise((resolvePromise) => {
      const server = createNetServer()
      server.unref()
      server.once('error', () => resolvePromise(false))
      server.listen(preferred, '127.0.0.1', () => {
        server.close(() => resolvePromise(true))
      })
    })
    if (free) return preferred
  }
  try {
    return await allocateLocalPort()
  } catch {
    return null
  }
}

/* ========================================================================== *
 * ssh 参数构造
 * ========================================================================== */

function sshTarget(host) {
  return host.user ? `${host.user}@${host.host}` : host.host
}

/** 意外断链后的自动重连退避（远端 dsh 常驻，隧道断开只影响本机显示）。 */
const AUTO_RECONNECT_DELAYS_MS = [1500, 3000, 5000, 8000, 13000, 21000]

/**
 * 建立转发连接的 argv：远端 dsh 由准备步骤常驻启动/复用，这里只建隧道（-N），
 * 不执行远端命令，因此本地 ssh 断开不会结束远端 dsh。
 */
function buildSshArgs(host, localPort, remotePort = host.remotePort) {
  const args = [...SSH_CONNECT_OPTIONS, '-p', String(host.port)]
  if (host.identityFile) args.push('-i', expandHomePath(host.identityFile))
  args.push('-L', `127.0.0.1:${localPort}:127.0.0.1:${remotePort}`)
  args.push('-N', sshTarget(host))
  return args
}

function buildTestArgs(host) {
  const args = [...SSH_TEST_OPTIONS, '-p', String(host.port)]
  if (host.identityFile) args.push('-i', expandHomePath(host.identityFile))
  args.push(sshTarget(host), 'echo dsh-ssh-ok')
  return args
}

/** 用 ssh 在远端执行一条命令（供首次安装探测/安装使用）。 */
function buildRemoteCommandArgs(host, command) {
  const args = [...SSH_TEST_OPTIONS, '-p', String(host.port)]
  if (host.identityFile) args.push('-i', expandHomePath(host.identityFile))
  args.push(sshTarget(host), command)
  return args
}

/**
 * 单次远端命令：stdout/stderr 分开保留，合并的 output 实时写入连接日志。
 * 超时/进程错误时 code 为 null，并保留 error；取消由调用方检查 conn.status。
 * 等 close 而非 exit，确保最后一段输出已读取，协议标记只能来自 stdout。
 */
function runRemoteStep(conn, sshPath, args, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false
    let stdout = ''
    let stderr = ''
    let output = ''
    let child = null
    let timer = null
    const finish = (code, error = null) => {
      if (settled) return
      settled = true
      // 成功/失败都清掉超时定时器，避免步骤结束后出现「幽灵步骤超时」。
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
      if (child && conn.child === child) conn.child = null
      resolve({ code, stdout, stderr, output, error })
    }
    try {
      child = spawn(sshPath, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      appendLogLine(conn, `[setup] 无法启动 ssh：${toMessage(error)}`)
      finish(null, toMessage(error))
      return
    }
    trackChild(conn, child)
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    const collect = (chunk, isStderr) => {
      const text = String(chunk ?? '')
      if (!text || settled) return
      if (isStderr) stderr = (stderr + text).slice(-MAX_TEST_OUTPUT)
      else stdout = (stdout + text).slice(-MAX_TEST_OUTPUT)
      output = (output + text).slice(-MAX_TEST_OUTPUT)
      appendLogText(conn, text)
    }
    child.stdout?.on('data', (chunk) => collect(chunk, false))
    child.stderr?.on('data', (chunk) => collect(chunk, true))
    child.on('error', (error) => {
      appendLogLine(conn, `[setup] ssh 进程错误：${toMessage(error)}`)
      finish(null, toMessage(error))
    })
    child.on('close', (code, signal) => {
      flushLineBuffer(conn)
      finish(typeof code === 'number' ? code : null, signal ? `signal ${signal}` : null)
    })
    timer = setTimeout(() => {
      timer = null
      if (settled) return
      const error = `步骤超时（约 ${Math.round(timeoutMs / 1000)} 秒）`
      appendLogLine(conn, `[setup] ${error}`)
      killProcessTree(child)
      finish(null, error)
    }, timeoutMs)
    if (typeof timer.unref === 'function') timer.unref()
  })
}

/** 仅接受成功 SSH 命令 stdout 中唯一的完整状态行；其它结果不能证明 dsh 缺失。 */
function parseRemoteDshCheck(step) {
  if (step?.code !== 0 || step.error) return 'failed'
  const markers = String(step.stdout ?? '').split(/\r?\n/).filter((line) => line === 'DSH_OK' || line === 'DSH_MISSING')
  if (markers.length !== 1) return 'failed'
  return markers[0] === 'DSH_OK' ? 'installed' : 'missing'
}

/** 保留原始 SSH 错误/进程状态，脱敏并限制 UI 中显示的诊断长度。 */
function remoteStepFailureDetail(step) {
  const status = step?.code === 0
    ? 'SSH 命令已退出，但未返回有效状态标记'
    : `SSH 命令未成功完成（${formatExit(step?.code)}）`
  const cause = step?.error ? `：${sanitizeOutputText(step.error)}` : ''
  const output = step?.output ?? `${step?.stdout ?? ''}\n${step?.stderr ?? ''}`
  const tail = sanitizeOutputText(output).trim().split(/\r?\n/).filter(Boolean).slice(-8).join('\n')
  return `${status}${cause}${tail ? `\n最近输出：\n${tail}` : ''}`
}

/**
 * 把一段远端 shell 脚本编码成 ssh 命令（base64，避免引号/换行在远端 shell 中被破坏）。
 */
function encodeRemoteScript(script) {
  const encoded = Buffer.from(String(script), 'utf8').toString('base64')
  return `echo ${encoded} | base64 -d | sh`
}

/** 远端端口清理脚本：仅结束该端口上确实是 dsh 的进程（尽力而为）。 */
function buildRemotePortCleanupScript(port) {
  return [
    'if command -v fuser >/dev/null 2>&1; then',
    `  for pid in $(fuser -n tcp "${port}" 2>/dev/null); do`,
    '    if tr "\\0" " " < "/proc/$pid/cmdline" 2>/dev/null | grep -q dsh; then',
    '      kill "$pid" 2>/dev/null',
    '    fi',
    '  done',
    'fi',
    'echo DONE',
  ].join('\n')
}

/**
 * 远端重启脚本：结束端口上的 dsh，并等端口释放（最多约 6 秒）。
 * 输出 `PORT=FREE` 或 `PORT=BUSY`，供「重启远端」在重建连接前确认。
 */
function buildRemoteRestartScript(port) {
  return [
    `PORT=${port}`,
    'kill_dsh() {',
    '  if command -v fuser >/dev/null 2>&1; then',
    '    for pid in $(fuser -n tcp "$PORT" 2>/dev/null); do',
    '      if tr "\\0" " " < "/proc/$pid/cmdline" 2>/dev/null | grep -q dsh; then',
    '        kill "$pid" 2>/dev/null',
    '      fi',
    '    done',
    '  fi',
    '}',
    'check_port() {',
    '  if command -v ss >/dev/null 2>&1; then',
    '    ss -ltn 2>/dev/null | grep -qE "[:.]$PORT[[:space:]]"',
    '  else',
    '    netstat -ltn 2>/dev/null | grep -qE "[:.]$PORT[[:space:]]"',
    '  fi',
    '}',
    'kill_dsh',
    'i=0',
    'while [ "$i" -lt 12 ]; do',
    '  if ! check_port; then echo "PORT=FREE"; exit 0; fi',
    '  if [ "$i" -eq 3 ]; then kill_dsh; fi',
    '  sleep 0.5',
    '  i=$((i + 1))',
    'done',
    'echo "PORT=BUSY"',
  ].join('\n')
}

/**
 * 远端停止脚本（「停止远端」专用）：结束端口上的 dsh 并确认端口释放。
 * 输出 `STOPPED=1`（确实结束了进程）或 `STOPPED=0`（端口上本来就没有 dsh）。
 */
function buildRemoteStopScript(port) {
  return [
    `PORT=${port}`,
    'FOUND=0',
    'kill_dsh() {',
    '  if command -v fuser >/dev/null 2>&1; then',
    '    for pid in $(fuser -n tcp "$PORT" 2>/dev/null | tr -d " "); do',
    '      if tr "\\0" " " < "/proc/$pid/cmdline" 2>/dev/null | grep -q dsh; then',
    '        if kill "$pid" 2>/dev/null; then FOUND=1; fi',
    '      fi',
    '    done',
    '  fi',
    '}',
    'check_port() {',
    '  if command -v ss >/dev/null 2>&1; then',
    '    ss -ltn 2>/dev/null | grep -qE "[:.]$PORT[[:space:]]"',
    '  else',
    '    netstat -ltn 2>/dev/null | grep -qE "[:.]$PORT[[:space:]]"',
    '  fi',
    '}',
    'kill_dsh',
    'i=0',
    'while [ "$i" -lt 8 ]; do',
    '  if ! check_port; then echo "STOPPED=$FOUND"; exit 0; fi',
    '  if [ "$i" -eq 3 ]; then',
    '    if command -v fuser >/dev/null 2>&1; then',
    '      for pid in $(fuser -n tcp "$PORT" 2>/dev/null | tr -d " "); do',
    '        kill -9 "$pid" 2>/dev/null && FOUND=1',
    '      done',
    '    fi',
    '  fi',
    '  sleep 0.5',
    '  i=$((i + 1))',
    'done',
    'echo "STOPPED=$FOUND"',
  ].join('\n')
}

/** 把任意字符串包成 POSIX shell 单引号字面量。 */
function shellSingleQuote(text) {
  return `'${String(text).replaceAll("'", "'\\''")}'`
}

/** 保持远端运行时，远端 dsh 的输出与访问令牌记录在这里（跨 ssh 会话保留）。 */
const REMOTE_LAUNCH_LOG = '~/.dsh/remote-desktop-web.log'
const DETACHED_WAIT_SECONDS = 40

/**
 * 自动探测 + 常驻启动的远端准备脚本：
 * - 端口上已有一个 dsh → 从日志里取回它的令牌，直接复用（正在执行的任务不中断）；
 * - 端口空闲 → 用 setsid/nohup 把 dsh 脱离 ssh 会话常驻启动，等日志出现令牌后返回；
 * - 端口被别的进程占用 → 明确失败，提示换远端端口或先结束那个进程。
 * 只读取该端口的令牌，避免拿到别的实例的旧令牌。
 */
function buildRemoteDetachedLaunchScript(port, launchCommand) {
  const command = shellSingleQuote(launchCommand)
  return [
    `PORT=${port}`,
    'LOG="$HOME/.dsh/remote-desktop-web.log"',
    'mkdir -p "$HOME/.dsh" 2>/dev/null || true',
    'touch "$LOG" 2>/dev/null || true',
    'check_port() {',
    '  if command -v ss >/dev/null 2>&1; then',
    '    ss -ltn 2>/dev/null | grep -qE "[:.]$1[[:space:]]"',
    '  else',
    '    netstat -ltn 2>/dev/null | grep -qE "[:.]$1[[:space:]]"',
    '  fi',
    '}',
    'read_token() {',
    '  tail -n +"$1" "$LOG" 2>/dev/null | grep -o ":$PORT/?token=[^ ]*" | tail -n 1 | sed "s#.*token=##"',
    '}',
    'pid_is_dsh() {',
    '  [ -n "$1" ] && tr "\\0" " " < "/proc/$1/cmdline" 2>/dev/null | grep -q dsh',
    '}',
    'if check_port "$PORT"; then',
    '  PID=$(fuser -n tcp "$PORT" 2>/dev/null | tr -d " ")',
    '  if pid_is_dsh "$PID"; then',
    '    TOKEN=$(read_token 1)',
    '    if [ -n "$TOKEN" ]; then',
    '      echo "REUSE=1"',
    '      echo "PORT=$PORT"',
    '      echo "TOKEN=$TOKEN"',
    '      exit 0',
    '    fi',
    '    echo "FAILED=reuse-no-token"',
    '    exit 0',
    '  fi',
    '  echo "FAILED=port-busy"',
    '  exit 0',
    'fi',
    'if [ -f "$LOG" ] && [ "$(wc -c < "$LOG" 2>/dev/null || echo 0)" -gt 2000000 ]; then mv "$LOG" "$LOG.1"; fi',
    'START=$(wc -l < "$LOG" 2>/dev/null || echo 0)',
    'cd "$HOME" 2>/dev/null || true',
    'if command -v setsid >/dev/null 2>&1; then',
    `  setsid nohup sh -c ${command} >> "$LOG" 2>&1 < /dev/null &`,
    'else',
    `  nohup sh -c ${command} >> "$LOG" 2>&1 < /dev/null &`,
    'fi',
    'echo "PID:$!"',
    'i=0',
    `while [ "$i" -lt ${DETACHED_WAIT_SECONDS} ]; do`,
    '  TOKEN=$(read_token $((START + 1)))',
    '  if [ -n "$TOKEN" ]; then',
    '    echo "REUSE=0"',
    '    echo "PORT=$PORT"',
    '    echo "TOKEN=$TOKEN"',
    '    exit 0',
    '  fi',
    '  sleep 1',
    '  i=$((i + 1))',
    'done',
    'echo "FAILED=no-token"',
    'tail -n 25 "$LOG" 2>/dev/null',
  ].join('\n')
}

/**
 * 自动探测 + 常驻启动远端 dsh：
 * 远端 dsh 以 setsid 脱离 ssh 会话常驻，令牌写入远端日志；再次连接时复用同一进程，
 * 因此断开/退出本机不会中断远端正在执行的任务。
 * 成功后设置 conn.remotePort 与 conn.token。
 */
function parseDetachedLaunchResult(stdout) {
  const unknown = { reuse: false, token: null, failed: null, started: false }
  const fields = { reuse: [], token: [], failed: [], pid: [] }
  for (const line of String(stdout ?? '').split(/\r?\n/)) {
    const marker = /^(REUSE|TOKEN|FAILED)=(.*)$|^(PID):(.*)$/.exec(line)
    if (marker === null) continue
    fields[(marker[1] ?? marker[3]).toLowerCase()].push(marker[2] ?? marker[4])
  }
  // 不取「第一个看起来像标记的子串」：重复、格式错误和冲突状态都视为未知。
  if (Object.values(fields).some((values) => values.length > 1)) return unknown
  const reuse = fields.reuse[0]
  const token = fields.token[0]
  const failed = fields.failed[0]
  const pid = fields.pid[0]
  if (reuse !== undefined && reuse !== '0' && reuse !== '1') return unknown
  if (token !== undefined && !/^\S+$/.test(token)) return unknown
  if (pid !== undefined && !/^[1-9]\d*$/.test(pid)) return unknown
  const started = pid !== undefined
  if (failed !== undefined) {
    if (!['port-busy', 'reuse-no-token', 'no-token'].includes(failed)) return unknown
    if (token !== undefined || reuse !== undefined || (started && failed !== 'no-token')) return unknown
    return { ...unknown, failed, started }
  }
  if (token === undefined || reuse === undefined) return unknown
  if ((reuse === '1' && started) || (reuse === '0' && !started)) return unknown
  return { reuse: reuse === '1', token, failed: null, started }
}

async function prepareDetachedRemoteDsh(conn, sshPath, runStep = runRemoteStep, cleanupRemote = killRemoteDshOnPort) {
  const port = conn.host.remotePort
  const launchCommand = DEFAULT_LAUNCH_COMMAND.replaceAll('{port}', String(port))
  const launchArgs = buildRemoteCommandArgs(
    conn.host,
    encodeRemoteScript(buildRemoteDetachedLaunchScript(port, launchCommand)),
  )
  const stepSucceeded = (step) => {
    if (step?.code === 0 && !step.error) return true
    failConnection(
      conn,
      `SSH 执行远端 dsh 准备命令失败，无法确认远端状态；不会自动清理远端进程。\n${remoteStepFailureDetail(step)}`,
      '[setup] SSH 远端准备命令失败',
    )
    return false
  }
  let step = await runStep(conn, sshPath, launchArgs, SETUP_PROBE_TIMEOUT_MS * 3)
  if (conn.status !== 'connecting' || !stepSucceeded(step)) return false
  let result = parseDetachedLaunchResult(step.stdout)

  // 迁移场景：端口上有一个 dsh，但它不是以常驻模式启动的（日志里没有令牌，例如
  // v0.10.0 之前启动的旧实例）。结束它并以常驻模式重启一次，而不是把用户卡在错误上。
  if (result.failed === 'reuse-no-token') {
    appendLogLine(
      conn,
      `[setup] 远端端口 ${port} 上的 dsh 不是常驻模式启动的（没有令牌记录），正在重启为常驻模式`,
    )
    const restart = await runStep(
      conn,
      sshPath,
      buildRemoteCommandArgs(conn.host, encodeRemoteScript(buildRemoteRestartScript(port))),
      SETUP_PROBE_TIMEOUT_MS * 2,
    )
    if (conn.status !== 'connecting' || !stepSucceeded(restart)) return false
    step = await runStep(conn, sshPath, launchArgs, SETUP_PROBE_TIMEOUT_MS * 3)
    if (conn.status !== 'connecting' || !stepSucceeded(step)) return false
    result = parseDetachedLaunchResult(step.stdout)
  }

  if (result.token !== null && result.failed === null) {
    conn.remotePort = port
    conn.token = result.token
    appendLogLine(
      conn,
      result.reuse
        ? `[setup] 检测到远端已在运行的 dsh（端口 ${port}），直接接入，此前任务继续运行`
        : `[setup] 远端未检测到运行中的 dsh，已在后台常驻启动（端口 ${port}，日志 ${REMOTE_LAUNCH_LOG}）`,
    )
    return true
  }

  const code = result.failed ?? 'unknown'
  const reason =
    code === 'port-busy'
      ? `远端端口 ${port} 被其他进程占用。请把该主机的「远端端口」改成别的端口，或先在远端结束占用该端口的进程。`
      : code === 'reuse-no-token'
        ? `远端端口 ${port} 上已有一个 dsh，但 ${REMOTE_LAUNCH_LOG} 里没有它的访问令牌，重启后仍未拿到令牌。请查看远端日志 ${REMOTE_LAUNCH_LOG}。`
        : code === 'no-token' && result.started
          ? `远端 dsh 在后台启动后没有输出访问令牌。请查看远端日志 ${REMOTE_LAUNCH_LOG}。`
          : `远端准备命令未返回有效状态或访问令牌；无法确认远端 dsh 状态。\n${remoteStepFailureDetail(step)}`
  // 只有脚本明确返回本次新起的 PID 才清理；SSH 失败/未知输出不能证明启动过进程。
  if (result.started && result.failed === 'no-token' && !result.reuse) cleanupRemote(conn.host, port)
  failConnection(conn, `启动远端 dsh 失败：${reason}`, `[setup] 后台启动失败（${code}）`)
  return false
}

/** 结束远端端口上的 dsh 进程（可等待；用于失败回收、重启与关闭保活时的清理）。 */
function killRemoteDshNow(host, port) {
  if (!host || typeof port !== 'number') return Promise.resolve(false)
  return resolveSsh()
    .then(
      (ssh) =>
        new Promise((resolvePromise) => {
          if (!ssh.available) {
            resolvePromise(false)
            return
          }
          const command = encodeRemoteScript(buildRemotePortCleanupScript(port))
          execFile(
            ssh.path,
            buildRemoteCommandArgs(host, command),
            { windowsHide: true, timeout: 8000 },
            () => resolvePromise(true),
          )
        }),
    )
    .catch(() => false)
}

/** 结束远端端口上的 dsh 进程（尽力而为，不等待结果）。 */
function killRemoteDshOnPort(host, port) {
  void killRemoteDshNow(host, port)
}

/**
 * 断开连接时只保留日志：远端 dsh 始终后台常驻，本机断开/退出不影响远端任务。
 * 只有「停止远端」(/stop) 与「重启远端」(/restart) 会主动结束远端进程。
 */
function cleanupRemotePort(conn) {
  if (!conn) return
  appendLogLine(conn, '[disconnect] 已保留远端 dsh（后台常驻，远端任务继续运行）')
}

/** 在远端同步执行一段脚本（base64 编码），返回输出；供停止/重启远端使用。 */
function runRemoteScriptOnce(host, sshPath, script, timeoutMs) {
  return new Promise((resolvePromise) => {
    try {
      execFile(
        sshPath,
        buildRemoteCommandArgs(host, encodeRemoteScript(script)),
        { windowsHide: true, timeout: timeoutMs },
        (error, stdout) => {
          resolvePromise({ ok: !error, stdout: String(stdout ?? '') })
        },
      )
    } catch {
      resolvePromise({ ok: false, stdout: '' })
    }
  })
}

/**
 * 首次连接探测远端 dsh；缺失时自动安装（npm install -g @deepseek-ai/dsh）。
 * 返回 true 表示可以继续启动；失败时已通过 failConnection 设置连接错误。
 */
async function ensureRemoteDsh(conn, sshPath, runStep = runRemoteStep) {
  const check = await runStep(
    conn,
    sshPath,
    buildRemoteCommandArgs(conn.host, REMOTE_DSH_CHECK_COMMAND),
    SETUP_PROBE_TIMEOUT_MS,
  )
  if (conn.status !== 'connecting') return false
  const state = parseRemoteDshCheck(check)
  if (state === 'installed') {
    appendLogLine(conn, '[setup] 远端已安装 dsh')
    return true
  }
  if (state !== 'missing') {
    failConnection(
      conn,
      `SSH 探测远端 dsh 失败，无法确认是否已安装 dsh；已停止自动安装。\n${remoteStepFailureDetail(check)}`,
      '[setup] SSH 探测 dsh 失败，未执行自动安装',
    )
    return false
  }

  const installCommand = DEFAULT_INSTALL_COMMAND
  appendLogLine(conn, `[setup] 已确认远端 SSH 会话中未找到 dsh 命令，开始自动安装：${installCommand}`)
  const install = await runStep(
    conn,
    sshPath,
    buildRemoteCommandArgs(conn.host, installCommand),
    INSTALL_TIMEOUT_MS,
  )
  if (conn.status !== 'connecting') return false
  if (install?.code !== 0 || install.error) {
    const output = install?.output ?? `${install?.stdout ?? ''}\n${install?.stderr ?? ''}`
    const npmMissing = /npm: (command )?not found|command not found/i.test(output)
    const hint = npmMissing
      ? '远端没有可用的 npm/Node.js：请先在远端安装 Node.js（含 npm），再重新连接。'
      : '请检查 SSH 错误和远端安装输出，或先在远端手动安装 dsh（npm install -g @deepseek-ai/dsh）。'
    failConnection(
      conn,
      `远端 dsh 自动安装命令未成功完成。${hint}\n${remoteStepFailureDetail(install)}`,
      '[setup] 自动安装失败',
    )
    return false
  }

  const recheck = await runStep(
    conn,
    sshPath,
    buildRemoteCommandArgs(conn.host, REMOTE_DSH_CHECK_COMMAND),
    SETUP_PROBE_TIMEOUT_MS,
  )
  if (conn.status !== 'connecting') return false
  const recheckState = parseRemoteDshCheck(recheck)
  if (recheckState === 'failed') {
    failConnection(
      conn,
      `自动安装命令执行完成，但安装后 SSH 复查失败，无法确认 dsh 是否可用。\n${remoteStepFailureDetail(recheck)}`,
      '[setup] 安装后 SSH 复查失败',
    )
    return false
  }
  if (recheckState === 'missing') {
    failConnection(
      conn,
      '自动安装命令执行完成，但远端仍找不到 dsh 命令；请检查非交互 SSH 会话的 PATH，或先在远端手动安装。',
      '[setup] 安装后仍未找到 dsh',
    )
    return false
  }
  appendLogLine(conn, '[setup] dsh 安装完成')
  return true
}

/* ========================================================================== *
 * 连接日志：合并 stdout+stderr 的 ring buffer（最多 80 行，脱敏后入库）
 * ========================================================================== */

/* SSH 通道输出镜像：远端 dsh 自己的 stderr（账号登录的错误码等）只出现在这里。 */
const SSH_LOG_FILE = 'remote-desktop-ssh.log'
const SSH_LOG_MAX_BYTES = 512 * 1024

let sshLogQueue = []
let sshLogTimer = null

function flushSshLogQueue() {
  sshLogTimer = null
  const pending = sshLogQueue
  sshLogQueue = []
  if (pending.length === 0) return
  const file = join(dshHomeDirectory(), SSH_LOG_FILE)
  void (async () => {
    try {
      await mkdir(dshHomeDirectory(), { recursive: true })
      try {
        const info = await stat(file)
        if (info.size > SSH_LOG_MAX_BYTES) await unlink(file)
      } catch {
        // 文件不存在时忽略。
      }
      await appendFile(file, `${pending.join('\n')}\n`, 'utf8')
    } catch {
      // 诊断日志写失败不影响连接。
    }
  })()
}

/** 记录一行 SSH 输出到本地镜像文件（合并写入，避免高频 append）。 */
function mirrorSshLog(conn, line) {
  const hostId = typeof conn?.id === 'string' ? conn.id : ''
  const text = String(line ?? '').trim()
  if (!text) return
  const stamp = new Date().toISOString()
  sshLogQueue.push(`${stamp} [${hostId.slice(0, 8)}] ${text.slice(0, 4000)}`)
  if (sshLogQueue.length > 200) flushSshLogQueue()
  if (sshLogTimer === null) sshLogTimer = setTimeout(flushSshLogQueue, 400)
}

function appendLogLine(conn, line) {
  const text = sanitizeOutputText(line).trimEnd().slice(0, MAX_LINE_CHARS)
  if (!text) return
  mirrorSshLog(conn, text)
  conn.log.push(text)
  if (conn.log.length > MAX_LOG_LINES) conn.log.splice(0, conn.log.length - MAX_LOG_LINES)
}

function appendLogText(conn, chunk) {
  const text = String(chunk ?? '')
  if (!text) return
  conn.lineBuffer += text
  const lines = conn.lineBuffer.split(/\r?\n/)
  conn.lineBuffer = lines.pop() ?? ''
  for (const line of lines) appendLogLine(conn, line)
  if (conn.lineBuffer.length > MAX_LINE_CHARS) {
    appendLogLine(conn, conn.lineBuffer)
    conn.lineBuffer = ''
  }
}

function flushLineBuffer(conn) {
  if (!conn.lineBuffer) return
  const line = conn.lineBuffer
  conn.lineBuffer = ''
  appendLogLine(conn, line)
}

/* ========================================================================== *
 * 连接记录与生命周期
 * ========================================================================== */

/** 建立一次连接尝试的内部记录（每次 connect 都新建，避免旧回调污染新连接）。 */
function createConnection(host) {
  return {
    id: host.id,
    host,
    status: 'connecting',
    url: null,
    error: null,
    log: [],
    localPort: null,
    // 本次连接实际使用的远端端口（启动前探测到占用时会变化）。
    remotePort: host.remotePort,
    startedAt: new Date().toISOString(),
    // 访问令牌由远端准备步骤（探测/常驻启动）解析得到。
    token: null,
    lineBuffer: '',
    outputTail: '',
    child: null,
    // 本次连接尝试创建过的所有 ssh 子进程（一次性步骤 + 隧道），清理时按集合结束，避免孤儿。
    children: new Set(),
    deadlineTimer: null,
    probeTimer: null,
    // 意外断链自动重连（仅保持远端运行）：已重试次数与定时器。
    reconnectAttempt: 0,
    reconnectTimer: null,
    // 连接尝试编号与在飞尝试；同一主机任何时刻只允许一个连接尝试，重复请求合并。
    attempt: 0,
    attemptPromise: null,
    // 用户主动断开/重启时置位，避免自动重连把它拉回来。
    userStopped: false,
  }
}

/** 对外投影，字段与 ConnectionView 完全一致。 */
function viewConnection(conn) {
  return {
    id: conn.id,
    status: conn.status,
    url: conn.url,
    error: conn.error,
    log: conn.log.slice(),
    localPort: conn.localPort,
    startedAt: conn.startedAt,
  }
}

function clearConnectionTimers(conn) {
  if (conn.deadlineTimer !== null) {
    clearTimeout(conn.deadlineTimer)
    conn.deadlineTimer = null
  }
  if (conn.probeTimer !== null) {
    clearTimeout(conn.probeTimer)
    conn.probeTimer = null
  }
  if (conn.reconnectTimer !== null && conn.reconnectTimer !== undefined) {
    clearTimeout(conn.reconnectTimer)
    conn.reconnectTimer = null
  }
}

/** 结束进程：先 kill，2 秒后仍存活时在 win32 用 taskkill /T /F 兜底。 */
function killProcessTree(child) {
  if (!child || child.exitCode !== null) return
  try {
    child.kill()
  } catch {
    // 进程可能已经退出。
  }
  if (process.platform !== 'win32') return
  const pid = typeof child.pid === 'number' ? child.pid : null
  if (pid === null) return
  const timer = setTimeout(() => {
    if (child.exitCode !== null) return
    execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, () => {
      // 进程已退出或 taskkill 不可用时都无需额外处理。
    })
  }, KILL_GRACE_MS)
  if (typeof timer.unref === 'function') timer.unref()
}

/** 记录本次连接尝试创建的 ssh 子进程（一次性步骤与隧道都要跟踪，避免清理不干净留下孤儿）。 */
function trackChild(conn, child) {
  if (!child) return
  if (!conn.children) conn.children = new Set()
  conn.children.add(child)
  const forget = () => {
    if (conn.children) conn.children.delete(child)
  }
  child.once('exit', forget)
  child.once('error', forget)
  conn.child = child
}

function terminateChild(conn) {
  const all = new Set(conn.children ? [...conn.children] : [])
  if (conn.child) all.add(conn.child)
  conn.child = null
  if (conn.children) conn.children.clear()
  for (const child of all) killProcessTree(child)
}

function buildConnectionUrl(localPort, token) {
  const base = `http://127.0.0.1:${localPort}/`
  return token ? `${base}?token=${token}` : base
}

function markConnected(conn) {
  if (conn.status !== 'connecting') return
  clearConnectionTimers(conn)
  flushLineBuffer(conn)
  conn.status = 'connected'
  conn.error = null
  conn.reconnectAttempt = 0
  conn.url = buildConnectionUrl(conn.localPort, conn.token)
  appendLogLine(
    conn,
    `[ready] 本地端口转发已就绪：127.0.0.1:${conn.localPort}（连接尝试 ${conn.attempt || 1}）`,
  )
}

/** 置为 error 并清理进程；已经断开/就绪时忽略迟到的失败回调。 */
function failConnection(conn, message, logMessage = null) {
  if (conn.status !== 'connecting') return
  clearConnectionTimers(conn)
  terminateChild(conn)
  conn.status = 'error'
  conn.error = message
  conn.url = null
  conn.localPort = null
  flushLineBuffer(conn)
  appendLogLine(conn, logMessage ?? `[error] ${message}`)
}

/** 45 秒超时的错误文案：按 SPEC 附上最后 20 行日志。 */
function buildConnectTimeoutMessage(conn) {
  const headline =
    conn.token === null
      ? 'SSH 连接超时（45 秒）：没有拿到远端 dsh 的访问令牌（远端可能仍在启动）。请查看远端日志 ~/.dsh/remote-desktop-web.log。'
      : 'SSH 连接超时（45 秒）：未能建立到远端 dsh 的端口转发或服务未就绪。'
  const tail = conn.log.slice(-20)
  if (tail.length === 0) return headline
  return `${headline}\n最近日志：\n${tail.join('\n')}`
}

/** 启动后按 SPEC 参数拉起 ssh，并挂上输出/退出/超时处理。 */
/**
 * 单飞连接尝试：同一主机任何时刻只允许一个连接尝试在飞。
 * 重复请求（客户端 /connect、自动重连、重启后重建）直接复用现有尝试，
 * 不会各自 spawn 一份 ssh —— 那正是此前「连上又断开」抖动的根源。
 */
function startAttempt(conn, options = {}) {
  if (conn.attemptPromise !== null) return conn.attemptPromise
  const attempt = (conn.attempt || 0) + 1
  conn.attempt = attempt
  const reason = typeof options.reason === 'string' && options.reason ? options.reason : 'connect'
  appendLogLine(conn, `[connect] 第 ${attempt} 次连接尝试（${reason}）`)
  const promise = beginSshConnection(conn, { ...options, attempt })
    .catch((error) => {
      if (conn.attempt === attempt) failConnection(conn, `建立 SSH 连接失败：${toMessage(error)}`)
    })
    .finally(() => {
      if (conn.attempt === attempt) conn.attemptPromise = null
    })
  conn.attemptPromise = promise
  return promise
}

/** 作废当前连接尝试（旧尝试的后续步骤会因 attempt 不匹配而自行退出）。 */
function supersedeAttempt(conn) {
  if (!conn) return
  conn.attempt = (conn.attempt || 0) + 1
  conn.attemptPromise = null
}

async function beginSshConnection(conn, options = {}) {
  const myAttempt = typeof options.attempt === 'number' ? options.attempt : conn.attempt
  const superseded = () => conn.attempt !== myAttempt
  const preferredLocalPort = typeof options.preferredLocalPort === 'number' ? options.preferredLocalPort : null
  const skipDshCheck = options.skipDshCheck === true
  try {
    const ssh = await resolveSsh()
    if (superseded() || conn.status !== 'connecting') return
    if (!ssh.available) {
      failConnection(conn, SSH_MISSING_MESSAGE)
      return
    }

    // 首次连接先确认远端有 dsh，缺失则自动安装；随后探测远端是否已有 dsh：
    // 有就复用（正在执行的任务不中断），没有就后台常驻启动；拿到令牌后只建隧道。
    if (!skipDshCheck) {
      const ready = await ensureRemoteDsh(conn, ssh.path)
      if (superseded() || !ready || conn.status !== 'connecting') return
    }
    const prepared = await prepareDetachedRemoteDsh(conn, ssh.path)
    if (superseded() || !prepared || conn.status !== 'connecting') return

    const localPort = await allocateLocalPortPreferring(preferredLocalPort)
    if (superseded()) return
    if (localPort === null) {
      failConnection(conn, '无法分配本地端口（可能是本机端口耗尽）。')
      return
    }
    if (conn.status !== 'connecting') return
    conn.localPort = localPort

    const args = buildSshArgs(conn.host, localPort, conn.remotePort)
    appendLogLine(conn, `$ ${formatCommand(ssh.path, args)}`)
    const child = spawn(ssh.path, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    if (superseded()) {
      killProcessTree(child)
      return
    }
    trackChild(conn, child)
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk) => handleSshOutput(conn, chunk))
    child.stderr?.on('data', (chunk) => handleSshOutput(conn, chunk))
    child.on('error', (error) => {
      if (conn.child === child) conn.child = null
      failConnection(conn, `无法启动 ssh 进程：${toMessage(error)}`)
    })
    child.on('exit', (code, signal) => {
      if (conn.child === child) conn.child = null
      handleSshExit(conn, code, signal)
    })

    conn.deadlineTimer = setTimeout(() => {
      conn.deadlineTimer = null
      if (conn.status !== 'connecting') return
      failConnection(conn, buildConnectTimeoutMessage(conn), 'SSH 连接超时（45 秒）')
    }, CONNECT_TIMEOUT_MS)
    if (typeof conn.deadlineTimer.unref === 'function') conn.deadlineTimer.unref()

    // 令牌已由准备步骤拿到，只等隧道就绪，spawn 后立即开始探活。
    beginProbe(conn)
  } catch (error) {
    failConnection(conn, `建立 SSH 连接失败：${toMessage(error)}`)
  }
}

/** 处理合并后的 stdout/stderr：只写 ring buffer（访问令牌来自准备步骤）。 */
function handleSshOutput(conn, chunk) {
  if (conn.status === 'error' || conn.status === 'disconnected') return
  appendLogText(conn, chunk)
}

/** ssh 进程退出：已就绪 → disconnected（保持远端运行则自动重连）；未就绪 → error。 */
function handleSshExit(conn, code, signal) {
  clearConnectionTimers(conn)
  flushLineBuffer(conn)
  if (conn.status === 'connected') {
    conn.status = 'disconnected'
    conn.url = null
    appendLogLine(conn, `[ssh] 连接已退出（${formatExit(code, signal)}）`)
    // 保持远端运行时，远端 dsh 还在跑：本机睡眠/断网后自动重连隧道，
    // 并沿用同一本地端口，让远端页面自带的断线重连直接接回去。
    if (!conn.userStopped && scheduleAutoReconnect(conn)) return
    conn.localPort = null
    return
  }
  if (conn.status === 'connecting') {
    const tail = conn.log.slice(-8)
    conn.error = `SSH 进程在连接就绪前退出（${formatExit(code, signal)}）${tail.length > 0 ? `\n最近输出：\n${tail.join('\n')}` : ''}`
    conn.status = 'error'
    conn.url = null
    conn.localPort = null
    appendLogLine(conn, `[error] SSH 进程在连接就绪前退出（${formatExit(code, signal)}）`)
    // 启动失败时也尽力清理远端监听，避免残留阻塞下一次连接。
    cleanupRemotePort(conn)
    // 自动重连期间网络可能尚未恢复：同样进入退避重试。
    if (!conn.userStopped && scheduleAutoReconnect(conn)) return
    return
  }
  appendLogLine(conn, `[ssh] 进程已退出（${formatExit(code, signal)}）`)
}

/** 安排一次自动重连；返回 false 表示不重连（用户已停止或次数用尽）。 */
function scheduleAutoReconnect(conn) {
  if (conn.userStopped) return false
  const attempt = typeof conn.reconnectAttempt === 'number' ? conn.reconnectAttempt : 0
  if (attempt >= AUTO_RECONNECT_DELAYS_MS.length) {
    appendLogLine(conn, '[reconnect] 自动重连次数已用尽，请手动点「重新加载」或「重启远端」')
    conn.localPort = null
    return false
  }
  conn.reconnectAttempt = attempt + 1
  const delay = AUTO_RECONNECT_DELAYS_MS[attempt]
  appendLogLine(
    conn,
    `[reconnect] 隧道已断开，${Math.round(delay / 1000)} 秒后自动重连（远端任务保持运行；第 ${attempt + 1}/${AUTO_RECONNECT_DELAYS_MS.length} 次）`,
  )
  conn.reconnectTimer = setTimeout(() => {
    conn.reconnectTimer = null
    retryConnection(conn)
  }, delay)
  if (typeof conn.reconnectTimer.unref === 'function') conn.reconnectTimer.unref()
  return true
}

/** 用现有记录重试连接：沿用本地端口，跳过重复的 dsh 安装探测以加快恢复。 */
function retryConnection(conn) {
  if (conn.userStopped) return
  if (conn.status === 'connecting' || conn.status === 'connected') return
  const preferred = conn.localPort
  clearConnectionTimers(conn)
  terminateChild(conn)
  flushLineBuffer(conn)
  conn.status = 'connecting'
  conn.error = null
  conn.url = null
  conn.token = null
  startAttempt(conn, { preferredLocalPort: preferred, skipDshCheck: true, reason: 'auto-reconnect' })
}

/** 隧道建立后开始探活，直到远端 dsh 有响应。 */
function beginProbe(conn) {
  if (conn.status !== 'connecting') return
  probeRemoteOnce(conn)
}

/** 用 node:http 请求本机转发端口；有任意响应（含 401/302）即视为已就绪。 */
function probeRemoteOnce(conn) {
  if (conn.status !== 'connecting' || typeof conn.localPort !== 'number') return
  let settled = false
  const onFailure = () => {
    if (settled) return
    settled = true
    if (conn.status !== 'connecting') return
    conn.probeTimer = setTimeout(() => {
      conn.probeTimer = null
      probeRemoteOnce(conn)
    }, PROBE_INTERVAL_MS)
    if (typeof conn.probeTimer.unref === 'function') conn.probeTimer.unref()
  }

  let request
  try {
    request = httpGet(
      {
        host: '127.0.0.1',
        port: conn.localPort,
        path: '/',
        timeout: PROBE_TIMEOUT_MS,
        agent: false,
        headers: { 'user-agent': 'dsh-remote-desktop/0.1' },
      },
      (response) => {
        // 忽略状态码（401/302 也说明远端服务已就绪），读取并丢弃响应体。
        response.resume()
        if (settled) return
        settled = true
        markConnected(conn)
      },
    )
  } catch {
    onFailure()
    return
  }
  request.on('timeout', () => request.destroy(new Error('probe timeout')))
  request.on('error', onFailure)
}

/** 发起连接（立即返回，后台推进状态，Client 轮询 /state）。 */
function startConnection(host) {
  // 防御：同一条主机若有残留记录（含待重连定时器与未退出的 ssh 子进程），先彻底停掉，
  // 否则两份连接会并发抢本地端口，表现为「连上又断开」抖动。
  const stale = connections.get(host.id) ?? null
  if (stale !== null) {
    stale.userStopped = true
    supersedeAttempt(stale)
    clearConnectionTimers(stale)
    terminateChild(stale)
  }
  const record = createConnection(host)
  connections.set(host.id, record)
  // beginSshConnection 内部已兜底错误，这里再挂一次 catch 以防未捕获 rejection。
  startAttempt(record, { reason: 'initial' })
}

/** 主动断开：kill 进程并把视图置为 disconnected（保留日志）。 */
function disconnectHost(id, reason = '已断开连接') {
  const conn = connections.get(id)
  if (!conn) return
  conn.userStopped = true
  supersedeAttempt(conn)
  clearConnectionTimers(conn)
  terminateChild(conn)
  flushLineBuffer(conn)
  conn.status = 'disconnected'
  conn.url = null
  conn.error = null
  conn.localPort = null
  appendLogLine(conn, `[disconnect] ${reason}`)
  // 远端进程可能不会随 ssh 退出：尽力清理该端口的 dsh，避免下次连接端口被占。
  cleanupRemotePort(conn)
}

/** 插件卸载时断开所有连接（SPEC 要求）。 */
function disconnectAllConnections() {
  for (const conn of connections.values()) {
    conn.userStopped = true
    supersedeAttempt(conn)
    clearConnectionTimers(conn)
    terminateChild(conn)
    flushLineBuffer(conn)
    conn.status = 'disconnected'
    conn.url = null
    conn.error = null
    conn.localPort = null
    cleanupRemotePort(conn)
  }
  connections.clear()
}

/* ========================================================================== *
 * SSH 测试（POST /test，同步跑一次 ssh echo，60 秒总超时）
 * ========================================================================== */

function runSshTest(host) {
  return resolveSsh().then((ssh) => {
    if (!ssh.available) return { ok: false, error: SSH_MISSING_MESSAGE }
    return executeSshTest(ssh.path, host)
  })
}

function executeSshTest(sshPath, host, spawnProcess = spawn) {
  const args = buildTestArgs(host)
  return new Promise((resolvePromise) => {
    let settled = false
    let timer = null
    let child = null
    let output = ''
    let truncated = false

    const finish = (result) => {
      if (settled) return
      settled = true
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
      if (child !== null) killProcessTree(child)
      resolvePromise(result)
    }

    const collect = (chunk) => {
      if (truncated) return
      output += String(chunk ?? '')
      if (output.length > MAX_TEST_OUTPUT) {
        output = output.slice(0, MAX_TEST_OUTPUT)
        truncated = true
      }
    }

    try {
      child = spawnProcess(sshPath, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      finish({ ok: false, error: `无法启动 ssh 进程：${toMessage(error)}` })
      return
    }

    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', collect)
    child.stderr?.on('data', collect)
    child.on('error', (error) => finish({ ok: false, error: `无法启动 ssh 进程：${toMessage(error)}` }))
    child.on('close', (code, signal) => {
      const text = sanitizeOutputText(output).trim()
      const detail = truncated ? `${text}\n…（输出已截断）` : text
      if (code === 0) {
        finish({ ok: true, output: detail || 'dsh-ssh-ok' })
        return
      }
      finish({ ok: false, error: detail || `SSH 测试失败（${formatExit(code, signal)}）` })
    })

    timer = setTimeout(
      () => finish({ ok: false, error: `SSH 测试超时（${Math.round(TEST_TIMEOUT_MS / 1000)} 秒）` }),
      TEST_TIMEOUT_MS,
    )
  })
}

/* ========================================================================== *
 * 本地 SSH 自动发现（GET /discover）
 *
 * 只读解析本机 ~/.ssh/config 与 ~/.ssh/known_hosts，best-effort 探测 ssh-agent
 * 和默认密钥；所有 IO 失败都静默降级（sources[].exists=false），接口仍 200。
 * 绝不读取任何私钥内容：默认密钥只做存在性检查，ssh-add 只取 `-l` 的文本输出。
 * ========================================================================== */

/** ssh 目录：测试/自定义位置可用 DSH_REMOTE_DESKTOP_SSH_DIR 覆盖，否则 ~/.ssh。 */
function discoverSshDirectory() {
  const override =
    typeof process.env.DSH_REMOTE_DESKTOP_SSH_DIR === 'string'
      ? process.env.DSH_REMOTE_DESKTOP_SSH_DIR.trim()
      : ''
  return override || join(homedir(), '.ssh')
}

/** host 变更后让 /discover 的 imported 标记立即生效，而不是等 5 秒缓存过期。 */
function invalidateDiscoverCache() {
  discoverCache = { at: 0, sshDir: null, value: null }
}

/** 读取文本文件的前 maxBytes 字节；读取失败返回 null（调用方降级处理）。 */
async function readTextFileLimited(file, maxBytes) {
  let handle
  try {
    handle = await open(file, 'r')
  } catch {
    return null
  }
  try {
    const buffer = Buffer.alloc(maxBytes)
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0)
    return buffer.subarray(0, bytesRead).toString('utf8')
  } catch {
    return null
  } finally {
    try {
      await handle.close()
    } catch {
      // 关闭失败不影响已读内容。
    }
  }
}

/* ------------------------------ ssh_config 词法 ------------------------------ */

/** 去掉整行/行内注释（引号内的 # 保留）。 */
function stripConfigComment(line) {
  let quote = ''
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]
    if (quote) {
      if (char === quote) quote = ''
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char === '#' && (index === 0 || /\s/.test(line[index - 1]))) return line.slice(0, index)
  }
  return line
}

/** 解析 `Key value` / `Key=value`；关键字大小写由调用方处理。 */
function parseConfigLine(rawLine) {
  const line = stripConfigComment(String(rawLine ?? '')).trim()
  if (!line) return null
  const equals = /^([^\s=]+)\s*=\s*([\s\S]*)$/.exec(line)
  if (equals !== null) return { key: equals[1], value: equals[2].trim() }
  const spaced = /^([^\s=]+)\s+([\s\S]*)$/.exec(line)
  if (spaced !== null) return { key: spaced[1], value: spaced[2].trim() }
  return { key: line, value: '' }
}

/** 去值两侧成对引号。 */
function unquoteConfigValue(value) {
  let text = String(value ?? '').trim()
  if (text.length >= 2) {
    const first = text[0]
    const last = text[text.length - 1]
    if ((first === '"' || first === "'") && first === last) text = text.slice(1, -1).trim()
  }
  return text
}

/** 按空白切分参数，支持引号包裹（Host/Include 的多 pattern）。 */
function splitConfigTokens(value) {
  const tokens = []
  let current = ''
  let quote = ''
  for (const char of String(value ?? '')) {
    if (quote) {
      if (char === quote) quote = ''
      else current += char
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current)
        current = ''
      }
      continue
    }
    current += char
  }
  if (current) tokens.push(current)
  return tokens
}

/** Host pattern 是否为具体别名（SPEC：不含 * ? [ !）。 */
function isConcreteHostPattern(pattern) {
  return typeof pattern === 'string' && pattern !== '' && !/[*?[\]!]/.test(pattern)
}

/** ssh_config 的 Port：非法值回退 22。 */
function parseConfigPort(value) {
  const port = Number(String(value ?? '').trim())
  if (!Number.isInteger(port) || port < 1 || port > 65535) return 22
  return port
}

/** HostName 的 %h/%n/%% 展开；出现未知 token 时整体回退为别名。 */
function expandHostNameTokens(value, alias) {
  const source = value || alias
  let unknown = false
  const expanded = source.replace(/%./g, (token) => {
    if (token === '%%') return '%'
    if (token === '%h' || token === '%n') return alias
    unknown = true
    return token
  })
  return unknown || !expanded ? alias : expanded
}

/** IdentityFile：%d 展开为用户家目录；~ 前缀保留（连接层负责展开）。 */
function expandIdentityValue(value) {
  const text = unquoteConfigValue(value)
  if (!text) return ''
  return text.replaceAll('%d', homedir())
}

/* --------------------------- Include 展开（含 glob） --------------------------- */

/** 把单个 glob 片段转成正则（只支持 * 与 ?）。 */
function globSegmentToRegExp(segment) {
  let source = ''
  for (const char of segment) {
    if (char === '*') source += '.*'
    else if (char === '?') source += '.'
    else if ('\\^$.*+?()[]{}|'.includes(char)) source += `\\${char}`
    else source += char
  }
  return new RegExp(`^${source}$`)
}

/** 逐段展开 glob；目录读取失败时返回空列表（静默降级）。 */
async function expandGlobSegments(base, segments) {
  if (segments.length === 0) return [base]
  const [segment, ...rest] = segments
  if (!/[*?]/.test(segment)) {
    const next = join(base, segment)
    return rest.length === 0 ? [next] : expandGlobSegments(next, rest)
  }
  let entries
  try {
    entries = await readdir(base, { withFileTypes: true })
  } catch {
    return []
  }
  const matcher = globSegmentToRegExp(segment)
  const found = []
  const sorted = entries.slice().sort((a, b) => a.name.localeCompare(b.name))
  for (const entry of sorted) {
    if (!matcher.test(entry.name)) continue
    const next = join(base, entry.name)
    if (rest.length === 0) found.push(next)
    else if (entry.isDirectory()) found.push(...(await expandGlobSegments(next, rest)))
  }
  return found
}

/** Include 的 pattern：相对路径相对 ssh 目录；支持 ~ 与 * ? glob。 */
async function expandIncludePattern(rawPattern, sshDir) {
  const pattern = expandHomePath(unquoteConfigValue(rawPattern))
  if (!pattern) return []
  const absolute = isAbsolute(pattern) ? pattern : join(sshDir, pattern)
  if (!/[*?]/.test(absolute)) return [absolute]
  const parts = absolute.replaceAll('\\', '/').split('/')
  const firstGlob = parts.findIndex((part) => /[*?]/.test(part))
  if (firstGlob < 0) return [absolute]
  const base = parts.slice(0, firstGlob).join(sep) || sep
  return expandGlobSegments(base, parts.slice(firstGlob))
}

/**
 * 把 config（含递归 Include）摊平成带来源文件的行列表。
 * 深度 ≤3、Include 文件数 ≤20、单文件 ≤512 KiB；Include 读取失败静默跳过。
 */
async function collectConfigLines(file, sshDir, depth, state, output) {
  const text = await readTextFileLimited(file, SSH_CONFIG_MAX_BYTES)
  if (text === null) return false
  for (const rawLine of text.split(/\r?\n/)) {
    const pair = parseConfigLine(rawLine)
    if (pair !== null && pair.key.toLowerCase() === 'include') {
      if (depth >= SSH_CONFIG_INCLUDE_DEPTH) continue
      for (const pattern of splitConfigTokens(pair.value)) {
        const matches = await expandIncludePattern(pattern, sshDir)
        for (const included of matches) {
          if (state.files >= SSH_CONFIG_INCLUDE_FILES) break
          const absolute = resolve(included)
          if (state.visited.has(absolute)) continue
          state.visited.add(absolute)
          state.files += 1
          await collectConfigLines(absolute, sshDir, depth + 1, state, output)
        }
      }
      continue
    }
    output.push({ text: rawLine, file })
  }
  return true
}

/* ------------------------------ ssh_config 解析 ------------------------------ */

/** 把块内关键字写入块内每个别名（首值优先，后续重复值忽略）。 */
function applySshConfigKeyword(block, keyword, value) {
  for (const alias of block.aliases) {
    if (keyword === 'hostname' && !alias.hostNameSet) {
      alias.hostName = unquoteConfigValue(value)
      alias.hostNameSet = true
    } else if (keyword === 'user' && !alias.userSet) {
      alias.user = unquoteConfigValue(value)
      alias.userSet = true
    } else if (keyword === 'port' && !alias.portSet) {
      alias.port = value
      alias.portSet = true
    } else if (keyword === 'identityfile' && !alias.identitySet) {
      alias.identityFile = unquoteConfigValue(value)
      alias.identitySet = true
    }
  }
}

/** 单个别名 + 全局缺省 → 候选。 */
function buildSshConfigCandidate(alias, global) {
  const user = alias.userSet ? alias.user : global.userSet ? global.user : ''
  const portValue = alias.portSet ? alias.port : global.portSet ? global.port : null
  const identityValue = alias.identitySet
    ? alias.identityFile
    : global.identitySet
      ? global.identityFile
      : ''
  return {
    key: `ssh-config:${alias.alias}`,
    source: 'ssh-config',
    sourcePath: alias.file,
    name: alias.alias,
    alias: alias.alias,
    host: expandHostNameTokens(alias.hostName, alias.alias),
    port: portValue === null ? 22 : parseConfigPort(portValue),
    user,
    identityFile: expandIdentityValue(identityValue),
    imported: false,
  }
}

/**
 * 解析摊平后的 ssh_config 行：顶层 User/Port/IdentityFile 作全局缺省；
 * Host 只收具体别名；Match 之后直到下一个 Host 的设置不归属任何别名。
 */
function parseSshConfigLines(lines) {
  const candidates = []
  const global = {
    user: '',
    userSet: false,
    port: null,
    portSet: false,
    identityFile: '',
    identitySet: false,
  }
  let globalOpen = true
  let block = null
  let skipped = 0

  const finishBlock = () => {
    if (block === null) return
    for (const alias of block.aliases) candidates.push(buildSshConfigCandidate(alias, global))
    block = null
  }

  for (const entry of lines) {
    const pair = parseConfigLine(entry.text)
    if (pair === null) continue
    const keyword = pair.key.toLowerCase()

    if (keyword === 'host') {
      finishBlock()
      globalOpen = false
      const aliases = []
      for (const pattern of splitConfigTokens(pair.value)) {
        if (isConcreteHostPattern(pattern)) {
          aliases.push({
            alias: pattern,
            file: entry.file,
            hostName: '',
            hostNameSet: false,
            user: '',
            userSet: false,
            port: null,
            portSet: false,
            identityFile: '',
            identitySet: false,
          })
        } else {
          skipped += 1
        }
      }
      block = { aliases }
      continue
    }

    if (keyword === 'match') {
      finishBlock()
      globalOpen = false
      continue
    }

    if (block !== null) {
      applySshConfigKeyword(block, keyword, pair.value)
      continue
    }
    if (!globalOpen) continue
    if (keyword === 'user' && !global.userSet) {
      global.user = unquoteConfigValue(pair.value)
      global.userSet = true
    } else if (keyword === 'port' && !global.portSet) {
      global.port = pair.value
      global.portSet = true
    } else if (keyword === 'identityfile' && !global.identitySet) {
      global.identityFile = unquoteConfigValue(pair.value)
      global.identitySet = true
    }
  }

  finishBlock()
  return { candidates: candidates.slice(0, DISCOVER_MAX_ENTRIES), skipped }
}

/** 读取 config 源（主文件缺失时 exists=false，不抛错）。 */
async function collectConfigSource(sshDir) {
  const file = join(sshDir, 'config')
  const lines = []
  const state = { files: 0, visited: new Set([resolve(file)]) }
  const exists = await collectConfigLines(file, sshDir, 0, state, lines)
  if (!exists) return { exists: false, candidates: [], entries: 0, skipped: 0 }
  const parsed = parseSshConfigLines(lines)
  return {
    exists: true,
    candidates: parsed.candidates,
    entries: parsed.candidates.length,
    skipped: parsed.skipped,
  }
}

/* ------------------------------ known_hosts 解析 ------------------------------ */

/** 解析 `[host]:port` 或普通 host；非法单冒号写法返回 null。 */
function parseKnownHostsToken(token) {
  const text = String(token ?? '').trim()
  if (!text) return null
  const bracketed = /^\[([^\]]+)\](?::(\d{1,5}))?$/.exec(text)
  if (bracketed !== null) {
    const host = bracketed[1].trim()
    if (!host) return null
    return { host, port: bracketed[2] === undefined ? 22 : parseConfigPort(bracketed[2]) }
  }
  // known_hosts 只有非默认端口才写成 [host]:port；单冒号的未加括号条目视为非法。
  const colons = text.split(':').length - 1
  if (colons === 1) return null
  return { host: text, port: 22 }
}

/**
 * 解析 known_hosts 文本：跳过 |1| 哈希、@cert-authority/@revoked、通配符；
 * 支持 [host]:port；默认端口 22、用户留空。
 */
function parseKnownHostsText(text, sourcePath) {
  const candidates = []
  let hashed = 0
  if (typeof text !== 'string') return { candidates, hashed }
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const fields = line.split(/\s+/)
    if (fields.length < 2) continue
    const hostField = fields[0]
    if (hostField.startsWith('@')) continue
    if (hostField.startsWith('|')) {
      hashed += 1
      continue
    }
    for (const token of hostField.split(',')) {
      if (candidates.length >= DISCOVER_MAX_ENTRIES) break
      if (!token || token.startsWith('!')) continue
      if (/[*?]/.test(token)) continue
      const parsed = parseKnownHostsToken(token)
      if (parsed === null) continue
      candidates.push({
        key: `known-hosts:${parsed.host.toLowerCase()}:${parsed.port}`,
        source: 'known-hosts',
        sourcePath,
        name: parsed.host,
        alias: '',
        host: parsed.host,
        port: parsed.port,
        user: '',
        identityFile: '',
        imported: false,
      })
    }
  }
  return { candidates, hashed }
}

/** 读取 known_hosts 源（缺失/不可读时 exists=false，不抛错）。 */
async function collectKnownHostsSource(sshDir) {
  const file = join(sshDir, 'known_hosts')
  const text = await readTextFileLimited(file, SSH_KNOWN_HOSTS_MAX_BYTES)
  if (text === null) return { exists: false, candidates: [], entries: 0, hashed: 0 }
  const parsed = parseKnownHostsText(text, file)
  return {
    exists: true,
    candidates: parsed.candidates,
    entries: parsed.candidates.length,
    hashed: parsed.hashed,
  }
}

/* --------------------------- 合并去重与 imported --------------------------- */

/**
 * 合并两个来源：去重键 host|port|user（host 小写），先出现者胜出
 * （ssh-config 优先于 known-hosts）；最后按名称排序。
 */
function mergeDiscoveryCandidates(configCandidates, knownHostCandidates) {
  const seenTargets = new Set()
  const seenKeys = new Set()
  const merged = []
  for (const candidate of [...configCandidates, ...knownHostCandidates]) {
    const target = `${candidate.host.toLowerCase()}|${candidate.port}|${candidate.user}`
    if (seenTargets.has(target)) continue
    if (seenKeys.has(candidate.key)) continue
    seenTargets.add(target)
    seenKeys.add(candidate.key)
    merged.push(candidate)
  }
  merged.sort((a, b) => String(a.name).localeCompare(String(b.name)))
  return merged
}

/** imported：host 相等 + port 相等 + user 为空或相等（host 不区分大小写）。 */
function isCandidateImported(candidate) {
  return hosts.some((host) => {
    if (String(host.host ?? '').toLowerCase() !== candidate.host.toLowerCase()) return false
    if (Number(host.port) !== candidate.port) return false
    const savedUser = String(host.user ?? '')
    return savedUser === '' || candidate.user === '' || savedUser === candidate.user
  })
}

/* ------------------------------ agent / 默认密钥 ------------------------------ */

/** 解析 ssh-add -l 输出首行（best-effort；不读取任何密钥内容）。 */
function firstOutputLine(result) {
  const stdoutLine = String(result.stdout ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean)
  if (stdoutLine) return stdoutLine
  const stderrLine = String(result.stderr ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean)
  return stderrLine ?? ''
}

/** ssh-add -l，3 秒超时：exit 0 有 N 个身份；exit 1 agent 可用无身份；其他不可用。 */
async function probeSshAgent() {
  const result = await runCommand('ssh-add', ['-l'], SSH_ADD_TIMEOUT_MS)
  const firstLine = firstOutputLine(result)
  const detail = sanitizeOutputText(firstLine).slice(0, 300)
  if (result.error === null) {
    const stdout = String(result.stdout ?? '').trim()
    const keys = stdout === '' ? 0 : stdout.split(/\r?\n/).filter((line) => line.trim()).length
    return { available: true, keys, detail: detail || 'ssh-add -l 成功' }
  }
  const exitCode = typeof result.error.code === 'number' ? result.error.code : null
  if (exitCode === 1) {
    return { available: true, keys: 0, detail: detail || 'ssh-agent 可用，但没有已加载的身份' }
  }
  const fallback = exitCode !== null ? `ssh-add -l 退出码 ${exitCode}` : toMessage(result.error)
  return { available: false, keys: 0, detail: detail || fallback }
}

/** 默认私钥文件只检查存在性（不读取内容）；家目录默认位置返回 ~ 形式路径。 */
async function listDefaultKeys(sshDir) {
  const usingDefaultDir = resolve(sshDir) === resolve(join(homedir(), '.ssh'))
  const found = []
  for (const name of DEFAULT_KEY_NAMES) {
    const file = join(sshDir, name)
    try {
      const info = await stat(file)
      if (info.isFile()) found.push(usingDefaultDir ? `~/.ssh/${name}` : file)
    } catch {
      // 文件不存在/不可读：静默跳过。
    }
  }
  return found
}

/* ------------------------------ 响应体 ------------------------------ */

/** GET /discover 的响应体；5 秒内重复请求返回缓存（ssh 目录变化时重新计算）。 */
async function buildDiscoverPayload() {
  await ensureStore()
  const sshDir = discoverSshDirectory()
  const now = Date.now()
  const cached = discoverCache
  if (cached.value !== null && cached.sshDir === sshDir && now - cached.at < DISCOVER_CACHE_MS) {
    return cached.value
  }

  const configPath = join(sshDir, 'config')
  const knownHostsPath = join(sshDir, 'known_hosts')
  const configSource = await collectConfigSource(sshDir)
  const knownHostsSource = await collectKnownHostsSource(sshDir)
  const [agent, defaultKeys] = await Promise.all([probeSshAgent(), listDefaultKeys(sshDir)])
  const candidates = mergeDiscoveryCandidates(
    configSource.candidates,
    knownHostsSource.candidates,
  ).map((candidate) => ({ ...candidate, imported: isCandidateImported(candidate) }))

  const value = {
    ok: true,
    sources: [
      {
        path: configPath,
        exists: configSource.exists,
        entries: configSource.entries,
        skipped: configSource.skipped,
      },
      {
        path: knownHostsPath,
        exists: knownHostsSource.exists,
        entries: knownHostsSource.entries,
        hashed: knownHostsSource.hashed,
      },
    ],
    agent,
    defaultKeys,
    candidates,
  }
  discoverCache = { at: now, sshDir, value }
  return value
}

/* ========================================================================== *
 * HTTP API
 * ========================================================================== */

/** 所有 API 请求统一鉴权：admit 包 try/catch，仅 owner 通过。 */
function authorizeRequest(ctx, req, res) {
  let admission
  try {
    admission = ctx.connection.admit({ headers: req.headers })
  } catch {
    jsonResponse(res, 401, { ok: false, error: 'unauthorized' })
    return false
  }
  if (admission === null || typeof admission !== 'object' || 'rejection' in admission) {
    const status = typeof admission?.rejection === 'number' ? admission.rejection : 401
    jsonResponse(res, status, { ok: false, error: 'unauthorized' })
    return false
  }
  if (admission.peer?.principal?.kind !== 'owner') {
    jsonResponse(res, 403, { ok: false, error: 'forbidden' })
    return false
  }
  return true
}

/** GET /state 的响应体：ssh 环境 + 主机列表 + 活动连接。 */
async function buildStatePayload() {
  await ensureStore()
  const ssh = await resolveSsh()
  const active = {}
  for (const [id, conn] of connections) active[id] = viewConnection(conn)
  return {
    ok: true,
    ssh: { available: ssh.available, path: ssh.path, version: ssh.version },
    hosts: hosts.map((host) => ({ ...host })),
    active,
  }
}

/** POST /hosts：带已有 id 时更新，否则新建。 */
async function upsertHost(rawHost) {
  await ensureStore()
  const input = validateHostInput(rawHost)
  const requestedId = typeof rawHost?.id === 'string' ? rawHost.id.trim() : ''
  const existing = requestedId ? hosts.find((host) => host.id === requestedId) ?? null : null

  if (existing === null) {
    const host = makeHostView(input, null)
    hosts.push(host)
    await persistHosts()
    invalidateDiscoverCache()
    return { ok: true, host: { ...host } }
  }

  // 配置变了就不再沿用旧连接，避免用过期参数继续转发。
  disconnectHost(existing.id, '主机配置已更新，旧连接已断开')
  const updated = makeHostView(input, existing.id)
  const index = hosts.findIndex((host) => host.id === existing.id)
  hosts[index] = updated
  await persistHosts()
  invalidateDiscoverCache()
  return { ok: true, host: { ...updated } }
}

/** POST /hosts/delete：先断开再删除。 */
async function deleteHost(rawId) {
  await ensureStore()
  const host = findHost(rawId)
  if (host === null) throw httpError(404, '未找到该远程主机')
  disconnectHost(host.id, '主机已删除')
  connections.delete(host.id)
  hosts = hosts.filter((item) => item.id !== host.id)
  await persistHosts()
  invalidateDiscoverCache()
  return { ok: true }
}

/** POST /connect：立即返回，连接过程在后台推进。 */
async function connectHost(rawId) {
  await ensureStore()
  const host = findHost(rawId)
  if (host === null) throw httpError(404, '未找到该远程主机')
  const current = connections.get(host.id) ?? null
  if (current !== null && (current.status === 'connecting' || current.status === 'connected')) {
    return { ok: true }
  }
  if (current !== null) {
    // 已有记录但已断开/出错：沿用同一条记录重连。若另起一条记录，会和仍在退避中的
    // 自动重连并发跑两份 ssh（孤儿隧道抢占本地端口），表现为「连上又断开」反复抖动。
    current.userStopped = false
    current.reconnectAttempt = 0
    clearConnectionTimers(current)
    terminateChild(current)
    current.status = 'connecting'
    current.error = null
    current.url = null
    current.token = null
    appendLogLine(current, '[reconnect] 收到手动重连请求')
    startAttempt(current, { preferredLocalPort: current.localPort, reason: 'manual' })
    return { ok: true }
  }
  startConnection(host)
  return { ok: true }
}

/** POST /disconnect：断开指定主机的活动连接。 */
async function disconnectHostById(rawId) {
  await ensureStore()
  const host = findHost(rawId)
  if (host === null) throw httpError(404, '未找到该远程主机')
  disconnectHost(host.id)
  return { ok: true }
}

/**
 * POST /restart：手动重启远端 dsh。
 * 结束远端端口上的 dsh，等端口释放，再重建连接与隧道（新连接会自动后台启动）。
 */
async function restartHost(rawId) {
  await ensureStore()
  const host = findHost(rawId)
  if (host === null) throw httpError(404, '未找到该远程主机')

  const conn = connections.get(host.id) ?? null
  const port =
    conn !== null && typeof conn.remotePort === 'number' ? conn.remotePort : host.remotePort

  if (conn !== null) {
    conn.userStopped = true
    supersedeAttempt(conn)
    clearConnectionTimers(conn)
    terminateChild(conn)
    flushLineBuffer(conn)
    conn.status = 'disconnected'
    conn.url = null
    conn.localPort = null
    connections.delete(host.id)
  }

  try {
    const ssh = await resolveSsh()
    if (ssh.available) {
      await runRemoteScriptOnce(host, ssh.path, buildRemoteRestartScript(port), 15_000)
    }
  } catch {
    // 尽力而为：即使结束失败也继续重连，新连接会再处理端口占用。
  }

  startConnection(host)
  const fresh = connections.get(host.id) ?? null
  if (fresh !== null) appendLogLine(fresh, '[restart] 已按请求重启远端 dsh')
  return { ok: true }
}

/**
 * POST /stop：唯一会主动结束远端 dsh 的用户操作。
 * 先断开本地隧道（userStopped 抑制自动重连），再结束远端端口上的 dsh；
 * 下次连接会重新探测：没有 dsh 就自动后台启动，任务从零开始。
 */
async function stopHost(rawId) {
  await ensureStore()
  const host = findHost(rawId)
  if (host === null) throw httpError(404, '未找到该远程主机')
  const conn = connections.get(host.id) ?? null
  const port =
    conn !== null && typeof conn.remotePort === 'number' ? conn.remotePort : host.remotePort
  disconnectHost(host.id, '远端 dsh 已按用户请求停止')
  let stopped = false
  try {
    const ssh = await resolveSsh()
    if (ssh.available) {
      const result = await runRemoteScriptOnce(host, ssh.path, buildRemoteStopScript(port), 20_000)
      stopped = /STOPPED=1/.test(result.stdout)
    }
  } catch {
    // 结束失败也返回 ok：本地隧道已断开，原因写进连接日志。
  }
  const after = connections.get(host.id) ?? null
  if (after !== null) {
    appendLogLine(
      after,
      stopped ? `[stop] 已结束远端 dsh（端口 ${port}）` : `[stop] 远端端口 ${port} 上没有正在运行的 dsh`,
    )
  }
  return { ok: true, stopped }
}

/** POST /test：同步跑一次 SSH 测试。 */
async function testHost(rawId) {
  await ensureStore()
  const host = findHost(rawId)
  if (host === null) throw httpError(404, '未找到该远程主机')
  return runSshTest(host)
}

/** POST 路由分发；未知路径返回 null。 */
async function handlePostRoute(route, req) {
  if (route === `POST ${API_PREFIX}/hosts`) {
    const body = await readJsonBody(req)
    return upsertHost(body?.host)
  }
  if (route === `POST ${API_PREFIX}/hosts/delete`) {
    const body = await readJsonBody(req)
    return deleteHost(body?.id)
  }
  if (route === `POST ${API_PREFIX}/connect`) {
    const body = await readJsonBody(req)
    return connectHost(body?.id)
  }
  if (route === `POST ${API_PREFIX}/disconnect`) {
    const body = await readJsonBody(req)
    return disconnectHostById(body?.id)
  }
  if (route === `POST ${API_PREFIX}/restart`) {
    const body = await readJsonBody(req)
    return restartHost(body?.id)
  }
  if (route === `POST ${API_PREFIX}/stop`) {
    const body = await readJsonBody(req)
    return stopHost(body?.id)
  }
  if (route === `POST ${API_PREFIX}/test`) {
    const body = await readJsonBody(req)
    return testHost(body?.id)
  }
  if (route === `POST ${API_PREFIX}/open-url`) {
    const body = await readJsonBody(req)
    const result = await openLocalBrowser(body?.url)
    void appendClientReport({
      report: {
        kind: 'open-url',
        url: String(body?.url ?? '').slice(0, 800),
        opened: result.ok === true,
        via: result.via,
      },
    }).catch(() => {})
    return result
  }
  return null
}

async function handleRequest(ctx, req, res) {
  // 鉴权必须在解析路由/请求体之前完成。
  if (!authorizeRequest(ctx, req, res)) return
  try {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const pathname = url.pathname.replace(/\/+$/, '') || '/'
    const method = typeof req.method === 'string' ? req.method.toUpperCase() : ''
    const route = `${method} ${pathname}`

    if (route === `GET ${API_PREFIX}/state`) {
      jsonResponse(res, 200, await buildStatePayload())
      return
    }
    if (route === `GET ${API_PREFIX}/discover`) {
      jsonResponse(res, 200, await buildDiscoverPayload())
      return
    }
    if (route === `POST ${API_PREFIX}/client-report`) {
      const body = await readJsonBody(req)
      jsonResponse(res, 200, await appendClientReport(body))
      return
    }
    if (method === 'POST') {
      const payload = await handlePostRoute(route, req)
      if (payload !== null) {
        jsonResponse(res, 200, payload)
        return
      }
    }
    jsonResponse(res, 404, { ok: false, error: 'unknown endpoint' })
  } catch (error) {
    const status = Number(error?.statusCode) || 500
    jsonResponse(res, status, { ok: false, error: toMessage(error) })
  }
}

/* ========================================================================== *
 * 协议/脚本与离线测试入口（默认依赖保持不变，测试可注入假步骤/子进程）
 * ========================================================================== */

export {
  buildRemoteDetachedLaunchScript,
  buildRemoteStopScript,
  buildSshArgs,
  ensureRemoteDsh,
  executeSshTest,
  parseRemoteDshCheck,
  prepareDetachedRemoteDsh,
  runRemoteStep,
}

/* ========================================================================== *
 * 插件入口
 * ========================================================================== */

export function apply(ctx) {
  // 启动即预热配置加载；readStoreFile 内部兜底，失败时以空列表继续。
  void ensureStore()

  // HTTP API：前缀路由，请求进入 handleRequest 后先做 owner 鉴权。
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: API_PREFIX,
        handler: (req, res) => {
          handleRequest(ctx, req, res).catch((error) => {
            if (!res.writableEnded) {
              try {
                jsonResponse(res, 500, { ok: false, error: toMessage(error) })
              } catch {
                // 响应已不可写，忽略。
              }
            }
          })
        },
      }),
    'remote-desktop: http api',
  )

  // 插件卸载：断开全部 SSH 连接（kill + Windows taskkill 兜底），并写掉待落盘的日志。
  ctx.effect(
    () => () => {
      disconnectAllConnections()
      flushSshLogQueue()
    },
    'remote-desktop: ssh cleanup',
  )
}
