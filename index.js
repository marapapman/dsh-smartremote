/**
 * Host half of the Remote Desktop bundle（远程主机 / Remote Desktop）。
 *
 * 通过系统 ssh 连接远程服务器：launch 模式在远端启动 `dsh --profile web` 并解析
 * 访问令牌，attach 模式连接已运行的 dsh；两者都建立 127.0.0.1 本地端口转发，
 * 把远端 dsh 的 Web GUI 内嵌到本地面板。url 模式不做 SSH，直接把用户给的完整
 * URL 作为 iframe 地址。
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
const OUTPUT_TAIL_CHARS = 4096

const CONNECT_TIMEOUT_MS = 45_000
const INSTALL_TIMEOUT_MS = 600_000
const SETUP_PROBE_TIMEOUT_MS = 25_000
const PROBE_TIMEOUT_MS = 3_000
const PROBE_INTERVAL_MS = 750
const TEST_TIMEOUT_MS = 12_000
const KILL_GRACE_MS = 2_000
const COMMAND_TIMEOUT_MS = 5_000

const DEFAULT_LAUNCH_COMMAND = 'dsh --profile web --port {port} --no-open'
const DEFAULT_INSTALL_COMMAND = 'npm install -g @deepseek-ai/dsh'
const REMOTE_DSH_CHECK_COMMAND = 'command -v dsh >/dev/null 2>&1 && echo DSH_OK || echo DSH_MISSING'
const VALID_MODES = new Set(['launch', 'attach', 'url'])
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
]

/** SSH 测试用的精简参数（SPEC 固定值）。 */
const SSH_TEST_OPTIONS = [
  '-o', 'BatchMode=yes',
  '-o', 'ConnectTimeout=8',
  '-o', 'StrictHostKeyChecking=accept-new',
]

const TOKEN_PATTERN = /[?&]token=([A-Za-z0-9._~-]+)/
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
    mode: input.mode,
    host: input.host,
    port: input.port,
    user: input.user,
    identityFile: input.identityFile,
    remotePort: input.remotePort,
    launchCommand: input.launchCommand,
    installCommand: input.installCommand,
    token: input.token,
    url: input.url,
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

function defaultHostName(mode, host, url) {
  if (host) return host.slice(0, 80)
  if (mode === 'url') {
    try {
      return new URL(url).host.slice(0, 80)
    } catch {
      // 落回通用名称。
    }
  }
  return '远程服务器'
}

/** 按 SPEC 校验/归一化 HostInput，返回规范化的输入字段。 */
function validateHostInput(rawHost) {
  if (rawHost === null || typeof rawHost !== 'object' || Array.isArray(rawHost)) {
    throw httpError(400, '缺少 host 配置')
  }
  const mode = typeof rawHost.mode === 'string' ? rawHost.mode.trim() : ''
  if (!VALID_MODES.has(mode)) throw httpError(400, 'mode 必须是 launch、attach 或 url')

  const host = normalizeText(rawHost.host, 255)
  const user = normalizeText(rawHost.user, 128)
  const identityFile = normalizeText(rawHost.identityFile, 1024)
  const port = parsePort(rawHost.port, 22, 'SSH 端口')
  const remotePort = parsePort(rawHost.remotePort, 39080, '远端端口')
  const token = normalizeText(rawHost.token, 256)

  let url = ''
  if (mode === 'url') {
    url = normalizeText(rawHost.url, 2048)
    if (!url) throw httpError(400, '直接 URL 模式需要填写完整 URL')
    let parsed
    try {
      parsed = new URL(url)
    } catch {
      throw httpError(400, 'URL 格式不正确')
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw httpError(400, 'URL 必须以 http:// 或 https:// 开头')
    }
  } else if (!host) {
    throw httpError(400, '请填写 SSH 主机地址')
  }

  const launchCommand =
    mode === 'launch' ? normalizeText(rawHost.launchCommand, 4096) || DEFAULT_LAUNCH_COMMAND : ''
  const installCommand =
    mode === 'launch' ? normalizeText(rawHost.installCommand, 4096) || DEFAULT_INSTALL_COMMAND : ''
  let name = normalizeText(rawHost.name, 80)
  if (!name) name = defaultHostName(mode, host, url)

  return { name, mode, host, port, user, identityFile, remotePort, launchCommand, installCommand, token, url }
}

/** 构造 HostView（字段名与顺序与 SPEC 一致）。 */
function makeHostView(input, existingId) {
  return {
    id: existingId ?? randomUUID(),
    name: input.name,
    mode: input.mode,
    host: input.host,
    port: input.port,
    user: input.user,
    identityFile: input.identityFile,
    remotePort: input.remotePort,
    launchCommand: input.launchCommand,
    installCommand: input.installCommand,
    token: input.token,
    url: input.url,
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

/* ========================================================================== *
 * ssh 参数构造
 * ========================================================================== */

function sshTarget(host) {
  return host.user ? `${host.user}@${host.host}` : host.host
}

/**
 * 建立转发连接的 argv。
 * launch：最后一个参数是替换过 {port} 的启动命令（作为单个 argv 交给 ssh，由 ssh
 * 在远端按 shell 解释）；attach：加 -N，不执行远端命令。
 * remotePort 允许与配置不同（启动前探测到占用时会自动换端口）。
 */
function buildSshArgs(host, localPort, remotePort = host.remotePort) {
  const args = [...SSH_CONNECT_OPTIONS, '-p', String(host.port)]
  if (host.identityFile) args.push('-i', expandHomePath(host.identityFile))
  args.push('-L', `127.0.0.1:${localPort}:127.0.0.1:${remotePort}`)
  if (host.mode === 'attach') args.push('-N')
  args.push(sshTarget(host))
  if (host.mode === 'launch') {
    args.push(host.launchCommand.replaceAll('{port}', String(remotePort)))
  }
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
 * 单次远端命令：输出实时写入连接日志，返回 { code, stdout }。
 * 超时/进程错误时 code 为 null；取消（连接被断开）由调用方检查 conn.status。
 */
function runRemoteStep(conn, sshPath, args, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false
    let output = ''
    let child = null
    const finish = (code) => {
      if (settled) return
      settled = true
      if (child && conn.child === child) conn.child = null
      resolve({ code, stdout: output })
    }
    try {
      child = spawn(sshPath, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      appendLogLine(conn, `[setup] 无法启动 ssh：${toMessage(error)}`)
      finish(null)
      return
    }
    conn.child = child
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    const collect = (chunk) => {
      const text = String(chunk ?? '')
      if (!text) return
      output += text
      if (output.length > MAX_TEST_OUTPUT) output = output.slice(-MAX_TEST_OUTPUT)
      appendLogText(conn, text)
    }
    child.stdout?.on('data', collect)
    child.stderr?.on('data', collect)
    child.on('error', (error) => {
      appendLogLine(conn, `[setup] ssh 进程错误：${toMessage(error)}`)
      finish(null)
    })
    child.on('exit', (code) => {
      flushLineBuffer(conn)
      finish(typeof code === 'number' ? code : null)
    })
    const timer = setTimeout(() => {
      appendLogLine(conn, `[setup] 步骤超时（约 ${Math.round(timeoutMs / 1000)} 秒）`)
      killProcessTree(child)
      finish(null)
    }, timeoutMs)
    if (typeof timer.unref === 'function') timer.unref()
  })
}

/**
 * 把一段远端 shell 脚本编码成 ssh 命令（base64，避免引号/换行在远端 shell 中被破坏）。
 */
function encodeRemoteScript(script) {
  const encoded = Buffer.from(String(script), 'utf8').toString('base64')
  return `echo ${encoded} | base64 -d | sh`
}

/** 远端端口准备脚本：清理上一次残留的 dsh，并返回第一个可用端口。 */
function buildRemotePortPrepScript(startPort, maxPort) {
  return [
    `PORT=${startPort}`,
    `MAX=${maxPort}`,
    'STALE=0',
    'check_port() {',
    '  if command -v ss >/dev/null 2>&1; then',
    '    ss -ltn 2>/dev/null | grep -qE "[:.]$1[[:space:]]"',
    '  else',
    '    netstat -ltn 2>/dev/null | grep -qE "[:.]$1[[:space:]]"',
    '  fi',
    '}',
    'if command -v fuser >/dev/null 2>&1; then',
    '  for pid in $(fuser -n tcp "$PORT" 2>/dev/null); do',
    '    if tr "\\0" " " < "/proc/$pid/cmdline" 2>/dev/null | grep -q dsh; then',
    '      if kill "$pid" 2>/dev/null; then STALE=1; fi',
    '    fi',
    '  done',
    'fi',
    'if [ "$STALE" = 1 ]; then sleep 1; fi',
    'P=$PORT',
    'while [ "$P" -le "$MAX" ]; do',
    '  if ! check_port "$P"; then',
    '    echo "PORT=$P"',
    '    exit 0',
    '  fi',
    '  P=$((P+1))',
    'done',
    'echo "PORT=none"',
  ].join('\n')
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
 * 启动前准备远端端口：如果配置端口被上一次残留的 dsh 占用，尽量回收；否则向后找空闲端口。
 * 成功后把最终端口写到 conn.remotePort。
 */
async function prepareRemotePort(conn, sshPath) {
  const start = conn.host.remotePort
  const max = Math.min(65535, start + 30)
  const script = buildRemotePortPrepScript(start, max)
  const step = await runRemoteStep(
    conn,
    sshPath,
    buildRemoteCommandArgs(conn.host, encodeRemoteScript(script)),
    SETUP_PROBE_TIMEOUT_MS * 2,
  )
  if (conn.status !== 'connecting') return false
  const match = /PORT=(\d+|none)/.exec(step.stdout)
  if (match === null || match[1] === 'none') {
    failConnection(
      conn,
      `远端 ${start}-${max} 端口都被占用，无法启动 dsh；请在设置里换一个远端端口后重试。`,
      '[setup] 没有可用的远端端口',
    )
    return false
  }
  const port = Number(match[1])
  if (port === start) {
    appendLogLine(conn, `[setup] 远端端口 ${port} 可用`)
  } else {
    appendLogLine(conn, `[setup] 远端端口 ${start} 不可用（已清理残留或换用空闲端口），改用 ${port}`)
  }
  conn.remotePort = port
  return true
}

/** 断开连接时尽力清理远端监听端口上的 dsh，避免残留阻塞下次连接。 */
function cleanupRemotePort(conn) {
  if (!conn || conn.mode !== 'launch') return
  const port = conn.remotePort || (conn.host && conn.host.remotePort)
  if (typeof port !== 'number') return
  void resolveSsh()
    .then((ssh) => {
      if (!ssh.available) return
      const command = encodeRemoteScript(buildRemotePortCleanupScript(port))
      execFile(
        ssh.path,
        buildRemoteCommandArgs(conn.host, command),
        { windowsHide: true, timeout: 8000 },
        () => {
          // 尽力而为：清理失败不影响本地断开。
        },
      )
    })
    .catch(() => {})
}

/**
 * 首次连接探测远端 dsh；缺失时按 installCommand 自动安装（仅 launch 模式）。
 * 返回 true 表示可以继续启动；失败时已通过 failConnection 设置连接错误。
 */
async function ensureRemoteDsh(conn, sshPath) {
  const check = await runRemoteStep(
    conn,
    sshPath,
    buildRemoteCommandArgs(conn.host, REMOTE_DSH_CHECK_COMMAND),
    SETUP_PROBE_TIMEOUT_MS,
  )
  if (conn.status !== 'connecting') return false
  if (check.code === 0 && check.stdout.includes('DSH_OK')) {
    appendLogLine(conn, '[setup] 远端已安装 dsh')
    return true
  }
  if (check.code === null) {
    failConnection(conn, 'SSH 连接失败：无法在远端执行探测命令。', '[setup] 探测 dsh 失败')
    return false
  }

  const installCommand = conn.host.installCommand || DEFAULT_INSTALL_COMMAND
  appendLogLine(conn, `[setup] 远端未检测到 dsh，开始自动安装：${installCommand}`)
  const install = await runRemoteStep(
    conn,
    sshPath,
    buildRemoteCommandArgs(conn.host, installCommand),
    INSTALL_TIMEOUT_MS,
  )
  if (conn.status !== 'connecting') return false
  if (install.code !== 0) {
    const tail = install.stdout.trim().split(/\r?\n/).filter(Boolean).slice(-6).join('\n')
    const npmMissing = /npm: (command )?not found|command not found/i.test(install.stdout)
    const hint = npmMissing
      ? '远端没有可用的 npm/Node.js：请先安装 Node.js（含 npm），或在设置里把「自动安装命令」改成可用的安装方式。'
      : '可在 设置 → 远程主机 里修改该主机的「自动安装命令」，或先在远端手动安装 dsh。'
    failConnection(
      conn,
      `远端没有 dsh，自动安装失败。${hint}${tail ? `\n最近输出：\n${tail}` : ''}`,
      '[setup] 自动安装失败',
    )
    return false
  }

  const recheck = await runRemoteStep(
    conn,
    sshPath,
    buildRemoteCommandArgs(conn.host, REMOTE_DSH_CHECK_COMMAND),
    SETUP_PROBE_TIMEOUT_MS,
  )
  if (conn.status !== 'connecting') return false
  if (recheck.code !== 0 || !recheck.stdout.includes('DSH_OK')) {
    failConnection(
      conn,
      '自动安装命令执行完成，但仍找不到 dsh 命令；请在设置里检查「自动安装命令」，或先在远端手动安装。',
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
    mode: host.mode,
    status: 'connecting',
    url: null,
    error: null,
    log: [],
    localPort: null,
    // 本次连接实际使用的远端端口（启动前探测到占用时会变化）。
    remotePort: host.remotePort,
    startedAt: new Date().toISOString(),
    // attach 模式允许用户预填令牌；launch 模式由启动输出解析。
    token: host.mode === 'attach' ? host.token || null : null,
    lineBuffer: '',
    outputTail: '',
    child: null,
    deadlineTimer: null,
    probeTimer: null,
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

function terminateChild(conn) {
  const child = conn.child
  if (!child) return
  conn.child = null
  killProcessTree(child)
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
  conn.url = buildConnectionUrl(conn.localPort, conn.token)
  appendLogLine(conn, `[ready] 本地端口转发已就绪：127.0.0.1:${conn.localPort}`)
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
    conn.mode === 'launch' && !conn.token
      ? 'SSH 连接超时（45 秒）：未从远端启动输出中解析到访问令牌，请检查启动命令是否会输出 dsh web 启动行。'
      : 'SSH 连接超时（45 秒）：未能建立到远端 dsh 的端口转发或服务未就绪。'
  const tail = conn.log.slice(-20)
  if (tail.length === 0) return headline
  return `${headline}\n最近日志：\n${tail.join('\n')}`
}

/** 启动后按 SPEC 参数拉起 ssh，并挂上输出/退出/超时处理。 */
async function beginSshConnection(conn) {
  try {
    const ssh = await resolveSsh()
    if (conn.status !== 'connecting') return
    if (!ssh.available) {
      failConnection(conn, SSH_MISSING_MESSAGE)
      return
    }

    // launch 模式：首次连接先确认远端有 dsh，缺失则自动安装，再建立隧道。
    if (conn.host.mode === 'launch') {
      const ready = await ensureRemoteDsh(conn, ssh.path)
      if (!ready || conn.status !== 'connecting') return
      // 上一次连接可能留下/残留占用远端端口：清理残留或换一个空闲端口。
      const prepared = await prepareRemotePort(conn, ssh.path)
      if (!prepared || conn.status !== 'connecting') return
    }

    const localPort = await allocateLocalPort()
    if (conn.status !== 'connecting') return
    conn.localPort = localPort

    const args = buildSshArgs(conn.host, localPort, conn.remotePort)
    appendLogLine(conn, `$ ${formatCommand(ssh.path, args)}`)
    const child = spawn(ssh.path, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    conn.child = child
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

    // attach 模式没有启动行可解析，spawn 后立即开始探活。
    if (conn.mode === 'attach') beginProbe(conn)
  } catch (error) {
    failConnection(conn, `建立 SSH 连接失败：${toMessage(error)}`)
  }
}

/** 处理合并后的 stdout/stderr：写 ring buffer，并在 launch 模式解析 token。 */
function handleSshOutput(conn, chunk) {
  if (conn.status === 'error' || conn.status === 'disconnected') return
  appendLogText(conn, chunk)
  if (conn.token || conn.mode !== 'launch') return
  // token 可能被拆到两次 data 事件里，用尾巴 buffer 兜住。
  conn.outputTail = `${conn.outputTail}${chunk}`.slice(-OUTPUT_TAIL_CHARS)
  const match = TOKEN_PATTERN.exec(conn.outputTail)
  if (!match) return
  conn.token = match[1]
  conn.outputTail = ''
  appendLogLine(conn, '[ssh] 已从远端启动输出中解析到访问令牌')
  beginProbe(conn)
}

/** ssh 进程退出：已就绪 → disconnected；未就绪 → error。 */
function handleSshExit(conn, code, signal) {
  clearConnectionTimers(conn)
  flushLineBuffer(conn)
  if (conn.status === 'connected') {
    conn.status = 'disconnected'
    conn.url = null
    conn.localPort = null
    appendLogLine(conn, `[ssh] 连接已退出（${formatExit(code, signal)}）`)
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
    return
  }
  appendLogLine(conn, `[ssh] 进程已退出（${formatExit(code, signal)}）`)
}

/** 开始探活：launch 需要先拿到 token，attach 立即探测。 */
function beginProbe(conn) {
  if (conn.status !== 'connecting') return
  if (conn.mode === 'launch' && !conn.token) return
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
  const record = createConnection(host)
  connections.set(host.id, record)
  if (host.mode === 'url') {
    record.status = 'connected'
    record.url = host.url
    appendLogLine(record, '[ready] 直接 URL 模式，无需 SSH')
    return
  }
  // beginSshConnection 内部已兜底错误，这里再挂一次 catch 以防未捕获 rejection。
  beginSshConnection(record).catch((error) => {
    failConnection(record, `建立 SSH 连接失败：${toMessage(error)}`)
  })
}

/** 主动断开：kill 进程并把视图置为 disconnected（保留日志）。 */
function disconnectHost(id, reason = '已断开连接') {
  const conn = connections.get(id)
  if (!conn) return
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
 * SSH 测试（POST /test，同步跑一次 ssh echo，12 秒超时）
 * ========================================================================== */

function runSshTest(host) {
  if (host.mode === 'url') {
    return Promise.resolve({ ok: true, output: '直接 URL 模式无需 SSH 测试，URL 已直接用于内嵌面板。' })
  }
  return resolveSsh().then((ssh) => {
    if (!ssh.available) return { ok: false, error: SSH_MISSING_MESSAGE }
    return executeSshTest(ssh.path, host)
  })
}

function executeSshTest(sshPath, host) {
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
      child = spawn(sshPath, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      finish({ ok: false, error: `无法启动 ssh 进程：${toMessage(error)}` })
      return
    }

    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', collect)
    child.stderr?.on('data', collect)
    child.on('error', (error) => finish({ ok: false, error: `无法启动 ssh 进程：${toMessage(error)}` }))
    child.on('exit', (code, signal) => {
      const text = sanitizeOutputText(output).trim()
      const detail = truncated ? `${text}\n…（输出已截断）` : text
      if (code === 0) {
        finish({ ok: true, output: detail || 'dsh-ssh-ok' })
        return
      }
      finish({ ok: false, error: detail || `SSH 测试失败（${formatExit(code, signal)}）` })
    })

    timer = setTimeout(() => finish({ ok: false, error: 'SSH 测试超时（12 秒）' }), TEST_TIMEOUT_MS)
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
  const current = connections.get(host.id)
  if (current && (current.status === 'connecting' || current.status === 'connected')) {
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
