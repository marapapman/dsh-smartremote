/**
 * SSH 探测/准备/测试回归：不联网、不读私钥、不启动真正的 ssh。
 * 流程用可注入步骤和假子进程；runRemoteStep 仅启动本机 node 验证流/退出/超时。
 * 60 秒边界用虚拟时钟，不实际等待一分钟。
 * 用法：node --test test/ssh-regression.mjs
 */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { after, test } from 'node:test'
import {
  buildConnectTimeoutMessage,
  cancelProbe,
  ensureRemoteDsh,
  executeSshTest,
  parseRemoteDshCheck,
  prepareDetachedRemoteDsh,
  probeRemoteOnce,
  probeTiming,
  runRemoteStep,
} from '../index.js'

const home = await mkdtemp(join(tmpdir(), 'smartremote-ssh-regression-'))
const previousHome = process.env.DSH_HOME
process.env.DSH_HOME = home

after(async () => {
  // 等待本地诊断镜像的合并写入结束；所有输出都限制在本测试的临时目录。
  await new Promise((resolve) => setTimeout(resolve, 500))
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
  await rm(home, { recursive: true, force: true })
})

function connection() {
  return {
    id: 'offline-regression',
    host: { host: 'offline.invalid', port: 22, user: 'offline', identityFile: '', remotePort: 39080 },
    status: 'connecting', error: null, url: null, token: null,
    log: [], lineBuffer: '', child: null, children: new Set(),
    deadlineTimer: null, probeTimer: null, probeActive: null, probeLastError: null,
    reconnectTimer: null, attempt: 1,
  }
}

/** 已拿到令牌、只等本地转发端口就绪的连接记录。 */
function probeConnection(overrides = {}) {
  return Object.assign(connection(), { localPort: 5000, token: 'fake-token' }, overrides)
}

/** 假的 httpGet：记录调用，并把 request 句柄交给测试驱动。 */
function fakeHttp() {
  const calls = []
  const impl = (options, callback) => {
    const request = new EventEmitter()
    request.destroyed = false
    request.destroy = () => { request.destroyed = true }
    calls.push({ options, callback, request })
    return request
  }
  return { calls, impl }
}

function step(code, stdout = '', stderr = '', error = null) {
  return { code, stdout, stderr, output: stdout + stderr, error }
}

function queuedSteps(results) {
  const calls = []
  const run = async (conn, sshPath, args, timeoutMs) => {
    calls.push({ args, timeoutMs })
    assert.equal(sshPath, 'fake-ssh')
    assert.ok(calls.length <= results.length, 'must not execute any unexpected remote step')
    return results[calls.length - 1]
  }
  return { calls, run }
}

const probeCases = [
  ['installed', step(0, 'DSH_OK\n'), 'installed'],
  ['missing', step(0, 'DSH_MISSING\n'), 'missing'],
  ['banner and exact CRLF marker', step(0, 'Welcome\r\nDSH_OK\r\n'), 'installed'],
  ['authentication exit 255', step(255, '', 'Permission denied (publickey).\n'), 'failed'],
  ['exit 255 overrides missing marker', step(255, 'DSH_MISSING\n', 'Connection reset\n'), 'failed'],
  ['exit 1 overrides installed marker', step(1, 'DSH_OK\n'), 'failed'],
  ['timeout overrides installed marker', step(null, 'DSH_OK\n', '', '步骤超时（约 25 秒）'), 'failed'],
  ['null exit', step(null), 'failed'],
  ['process error with zero exit', step(0, 'DSH_OK\n', '', 'spawn ENOENT'), 'failed'],
  ['null result', null, 'failed'],
  ['no result', undefined, 'failed'],
  ['empty success output', step(0), 'failed'],
  ['unknown success output', step(0, 'hello\n'), 'failed'],
  ['installed marker substring', step(0, 'NOT_DSH_OK\n'), 'failed'],
  ['missing marker substring', step(0, 'echo DSH_MISSING\n'), 'failed'],
  ['conflicting markers', step(0, 'DSH_OK\nDSH_MISSING\n'), 'failed'],
  ['duplicate markers', step(0, 'DSH_MISSING\nDSH_MISSING\n'), 'failed'],
  ['installed marker only in stderr', step(0, '', 'DSH_OK\n'), 'failed'],
  ['missing marker only in stderr', step(0, '', 'DSH_MISSING\n'), 'failed'],
]

for (const [label, result, expected] of probeCases) {
  test(`probe classification: ${label}`, () => {
    assert.equal(parseRemoteDshCheck(result), expected)
  })
}

test('installed probe skips install entirely', async () => {
  const conn = connection()
  const runner = queuedSteps([step(0, 'DSH_OK\n')])
  assert.equal(await ensureRemoteDsh(conn, 'fake-ssh', runner.run), true)
  assert.equal(runner.calls.length, 1)
  assert.equal(conn.status, 'connecting')
  assert.match(conn.log.join('\n'), /远端已安装 dsh/)
})

test('only a confirmed missing probe permits install, then rechecks before success', async () => {
  const conn = connection()
  const runner = queuedSteps([step(0, 'DSH_MISSING\n'), step(0, '', 'npm notice\n'), step(0, 'DSH_OK\n')])
  assert.equal(await ensureRemoteDsh(conn, 'fake-ssh', runner.run), true)
  assert.equal(runner.calls.length, 3)
  assert.equal(runner.calls[1].args.at(-1), 'npm install -g @deepseek-ai/dsh')
  assert.equal(runner.calls[0].args.at(-1), runner.calls[2].args.at(-1))
  assert.deepEqual(runner.calls.map((call) => call.timeoutMs), [25_000, 600_000, 25_000])
  assert.match(conn.log.join('\n'), /dsh 安装完成/)
})

for (const [label, result, expected] of probeCases.filter((item) => item[2] === 'failed')) {
  test(`failed probe never installs: ${label}`, async () => {
    const conn = connection()
    const runner = queuedSteps([result])
    assert.equal(await ensureRemoteDsh(conn, 'fake-ssh', runner.run), false)
    assert.equal(runner.calls.length, 1)
    assert.equal(conn.status, 'error')
    assert.match(conn.error, /SSH 探测远端 dsh 失败/)
    assert.doesNotMatch(conn.log.join('\n'), /开始自动安装|远端未检测到 dsh|远端没有 dsh/)
  })
}

test('authentication failure is preserved in UI error, not replaced with installation advice', async () => {
  const conn = connection()
  const detail = 'root@offline.invalid: Permission denied (publickey).'
  const runner = queuedSteps([step(255, '', detail)])
  await ensureRemoteDsh(conn, 'fake-ssh', runner.run)
  assert.match(conn.error, /code 255/)
  assert.ok(conn.error.includes(detail))
  assert.doesNotMatch(conn.error, /手动安装|自动安装失败|远端没有 dsh/)
})

test('timeout/process cause and raw output remain visible and tokens are redacted', async () => {
  const conn = connection()
  const runner = queuedSteps([step(null, '', 'Connection closed\nhttps://offline.invalid/?token=private-value\n', '步骤超时（约 25 秒）')])
  await ensureRemoteDsh(conn, 'fake-ssh', runner.run)
  assert.match(conn.error, /步骤超时（约 25 秒）/)
  assert.match(conn.error, /Connection closed/)
  assert.match(conn.error, /token=\*\*\*/)
  assert.doesNotMatch(conn.error, /private-value/)
})

for (const [label, recheck] of [
  ['authentication failure', step(255, '', 'Permission denied (publickey).')],
  ['timeout', step(null, '', 'Connection timed out', '步骤超时（约 25 秒）')],
  ['null result', null],
  ['unknown output', step(0, 'hello\n')],
  ['stderr-only marker', step(0, '', 'DSH_OK\n')],
]) {
  test(`successful install is not success when post-install probe fails: ${label}`, async () => {
    const conn = connection()
    const runner = queuedSteps([step(0, 'DSH_MISSING\n'), step(0, 'npm completed\n'), recheck])
    assert.equal(await ensureRemoteDsh(conn, 'fake-ssh', runner.run), false)
    assert.equal(runner.calls.length, 3)
    assert.match(conn.error, /安装后 SSH 复查失败/)
    assert.doesNotMatch(conn.error, /仍找不到 dsh/)
    assert.doesNotMatch(conn.log.join('\n'), /dsh 安装完成/)
    if (recheck?.stderr) assert.ok(conn.error.includes(recheck.stderr.trim()))
  })
}

test('confirmed missing after installation reports PATH problem rather than SSH failure', async () => {
  const conn = connection()
  const runner = queuedSteps([step(0, 'DSH_MISSING\n'), step(0), step(0, 'DSH_MISSING\n')])
  assert.equal(await ensureRemoteDsh(conn, 'fake-ssh', runner.run), false)
  assert.match(conn.error, /仍找不到 dsh 命令/)
  assert.match(conn.error, /PATH/)
  assert.doesNotMatch(conn.error, /设置里检查「自动安装命令」/)
})

for (const [label, install, pattern] of [
  ['npm failure on stderr', step(127, '', 'sh: npm: command not found\n'), /npm\/Node\.js/],
  ['SSH failure while installing', step(255, '', 'Connection reset by peer\n'), /Connection reset by peer/],
  ['install timeout', step(null, '', 'partial npm output', '步骤超时（约 600 秒）'), /步骤超时（约 600 秒）/],
]) {
  test(`install failure keeps original diagnostics and does not recheck: ${label}`, async () => {
    const conn = connection()
    const runner = queuedSteps([step(0, 'DSH_MISSING\n'), install])
    assert.equal(await ensureRemoteDsh(conn, 'fake-ssh', runner.run), false)
    assert.equal(runner.calls.length, 2)
    assert.match(conn.error, pattern)
    assert.doesNotMatch(conn.log.join('\n'), /dsh 安装完成/)
  })
}

for (const [label, result] of [
  ['authentication failure', step(255, '', 'Permission denied (publickey).')],
  ['timeout with partial startup-looking output', step(null, 'PID:123\nREUSE=0\nTOKEN=fake\n', '', '步骤超时（约 75 秒）')],
  ['failed process despite complete-looking token', step(255, 'REUSE=1\nTOKEN=fake\n')],
  ['unknown output', step(0, 'hello\n')],
  ['unknown output with an incidental PID', step(0, 'PID:123\nhello\n')],
  ['failure marker substring', step(0, 'log: FAILED=reuse-no-token\n')],
  ['duplicate failure markers', step(0, 'FAILED=reuse-no-token\nFAILED=port-busy\n')],
  ['duplicate PID markers', step(0, 'PID:123\nPID:456\nFAILED=no-token\n')],
  ['duplicate reuse markers', step(0, 'REUSE=1\nREUSE=1\nTOKEN=fake\n')],
  ['duplicate token markers', step(0, 'REUSE=1\nTOKEN=one\nTOKEN=two\n')],
  ['conflicting success and failure', step(0, 'PID:123\nTOKEN=fake\nFAILED=no-token\n')],
  ['malformed reuse marker', step(0, 'REUSE=other\nFAILED=reuse-no-token\n')],
  ['reuse conflicting with new PID', step(0, 'PID:123\nREUSE=1\nTOKEN=fake\n')],
  ['unproved fresh startup', step(0, 'REUSE=0\nTOKEN=fake\n')],
  ['token only on stderr', step(0, '', 'REUSE=1\nTOKEN=fake\n')],
  ['null result', null],
]) {
  test(`remote preparation failure never cleans up existing remote processes: ${label}`, async () => {
    const conn = connection()
    const runner = queuedSteps([result])
    const cleaned = []
    assert.equal(await prepareDetachedRemoteDsh(conn, 'fake-ssh', runner.run, (...args) => cleaned.push(args)), false)
    assert.equal(conn.status, 'error')
    assert.equal(conn.token, null)
    assert.equal(runner.calls.length, 1)
    assert.equal(cleaned.length, 0)
    assert.doesNotMatch(conn.error, /在后台启动后没有输出访问令牌/)
    if (result?.stderr) {
      // 日志与错误文案会保留 stderr，但协议里的 TOKEN= 行必须打码。
      for (const line of result.stderr.trim().split(/\r?\n/)) {
        if (/^[ \t]*TOKEN=/.test(line)) {
          assert.ok(conn.error.includes('TOKEN=***'), 'token lines must be redacted in diagnostics')
          assert.ok(!conn.error.includes(line), 'raw token line must never reach diagnostics')
        } else {
          assert.ok(conn.error.includes(line), `diagnostics must keep stderr line: ${line}`)
        }
      }
    }
  })
}

test('preparation reuses a confirmed token without cleanup', async () => {
  const conn = connection()
  const runner = queuedSteps([step(0, 'REUSE=1\nPORT=39080\nTOKEN=fake\n')])
  const cleaned = []
  assert.equal(await prepareDetachedRemoteDsh(conn, 'fake-ssh', runner.run, (...args) => cleaned.push(args)), true)
  assert.equal(conn.token, 'fake')
  assert.equal(conn.remotePort, 39080)
  assert.equal(cleaned.length, 0)
})

test('preparation accepts the normal fresh-start PID/REUSE/TOKEN protocol', async () => {
  const conn = connection()
  const runner = queuedSteps([step(0, 'PID:123\r\nREUSE=0\r\nPORT=39080\r\nTOKEN=fake\r\n')])
  const cleaned = []
  assert.equal(await prepareDetachedRemoteDsh(conn, 'fake-ssh', runner.run, (...args) => cleaned.push(args)), true)
  assert.equal(conn.token, 'fake')
  assert.equal(cleaned.length, 0)
  assert.match(conn.log.join('\n'), /未检测到运行中的 dsh/)
})

test('only an explicit newly started PID allows no-token failure cleanup', async () => {
  const conn = connection()
  const runner = queuedSteps([step(0, 'PID:123\nFAILED=no-token\n')])
  const cleaned = []
  assert.equal(await prepareDetachedRemoteDsh(conn, 'fake-ssh', runner.run, (...args) => cleaned.push(args)), false)
  assert.equal(cleaned.length, 1)
  assert.equal(cleaned[0][1], 39080)
})

test('SSH failure while migrating an old instance stops without relaunch or extra cleanup', async () => {
  const conn = connection()
  const runner = queuedSteps([step(0, 'FAILED=reuse-no-token\n'), step(255, '', 'Connection closed\n')])
  const cleaned = []
  assert.equal(await prepareDetachedRemoteDsh(conn, 'fake-ssh', runner.run, (...args) => cleaned.push(args)), false)
  assert.equal(runner.calls.length, 2)
  assert.equal(cleaned.length, 0)
  assert.match(conn.error, /Connection closed/)
})

test('runRemoteStep separates stdout markers from stderr and drains both streams', async () => {
  const conn = connection()
  const result = await runRemoteStep(conn, process.execPath, ['-e', "process.stdout.write('DSH_OK\\n'); process.stderr.write('DSH_MISSING\\n');"], 5_000)
  assert.equal(result.code, 0)
  assert.equal(result.stdout, 'DSH_OK\n')
  assert.equal(result.stderr, 'DSH_MISSING\n')
  assert.ok(result.output.includes('DSH_OK'))
  assert.ok(result.output.includes('DSH_MISSING'))
  assert.ok(conn.log.includes('DSH_OK'))
  assert.ok(conn.log.includes('DSH_MISSING'))
  assert.equal(parseRemoteDshCheck(result), 'installed')
})

test('runRemoteStep retains stderr and exit 255 rather than classifying it as missing', async () => {
  const result = await runRemoteStep(connection(), process.execPath, ['-e', "process.stderr.write('Permission denied (publickey).\\n'); process.exitCode = 255;"], 5_000)
  assert.equal(result.code, 255)
  assert.match(result.stderr, /Permission denied/)
  assert.equal(parseRemoteDshCheck(result), 'failed')
})

test('runRemoteStep reports local process startup errors explicitly', async () => {
  const result = await runRemoteStep(connection(), join(home, 'nonexistent-ssh'), [], 5_000)
  assert.equal(result.code, null)
  assert.match(result.error, /ENOENT/)
})

test('runRemoteStep timeout returns null exit plus timeout cause and partial output', async () => {
  const result = await runRemoteStep(connection(), process.execPath, ['-e', "process.stderr.write('waiting for ssh\\n'); setInterval(() => {}, 100);"], 1_000)
  assert.equal(result.code, null)
  assert.match(result.error, /步骤超时/)
  assert.match(result.stderr, /waiting for ssh/)
  assert.equal(parseRemoteDshCheck(result), 'failed')
})

function fakeChild() {
  const child = new EventEmitter()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.exitCode = null
  child.killCount = 0
  child.kill = () => {
    child.killCount += 1
    child.exitCode = 1
    return true
  }
  return child
}

test('SSH test accepts a 21.6 second successful login and waits for stream close', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const child = fakeChild()
  let settled = false
  const resultPromise = executeSshTest('fake-ssh', connection().host, () => child)
  resultPromise.then(() => { settled = true })
  t.mock.timers.tick(12_000)
  await Promise.resolve()
  assert.equal(settled, false, 'old 12-second deadline must not fire')
  t.mock.timers.tick(9_600)
  child.exitCode = 0
  child.emit('exit', 0, null)
  await Promise.resolve()
  assert.equal(settled, false, 'exit must not settle before stdout is drained')
  child.stdout.write('dsh-ssh-ok\n')
  child.emit('close', 0, null)
  assert.deepEqual(await resultPromise, { ok: true, output: 'dsh-ssh-ok' })
  t.mock.timers.tick(60_000)
  assert.equal(child.killCount, 0, 'successful test must clear its deadline')
})

test('SSH test total timeout is exactly 60 seconds and error text follows that constant', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const child = fakeChild()
  let settled = false
  const resultPromise = executeSshTest('fake-ssh', connection().host, () => child)
  resultPromise.then(() => { settled = true })
  t.mock.timers.tick(59_999)
  await Promise.resolve()
  assert.equal(settled, false)
  assert.equal(child.killCount, 0)
  t.mock.timers.tick(1)
  assert.deepEqual(await resultPromise, { ok: false, error: 'SSH 测试超时（60 秒）' })
  assert.equal(child.killCount, 1)
})

test('SSH test preserves actual authentication errors before the 60-second deadline', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const child = fakeChild()
  const resultPromise = executeSshTest('fake-ssh', connection().host, () => child)
  child.stderr.write('Permission denied (publickey).\n')
  child.exitCode = 255
  child.emit('exit', 255, null)
  child.emit('close', 255, null)
  assert.deepEqual(await resultPromise, { ok: false, error: 'Permission denied (publickey).' })
  t.mock.timers.tick(60_000)
  assert.equal(child.killCount, 0)
})

/* ------------------------------------------------------------------------- *
 * 就绪探测：慢链路不被打断、wall-clock 限时、旧尝试隔离、诊断与脱敏
 * ------------------------------------------------------------------------- */

test('probe timing allows a round trip far slower than the old 3-second socket idle limit', () => {
  assert.ok(probeTiming.timeoutMs >= 15_000, 'probe must tolerate several seconds of link latency')
  assert.equal(probeTiming.intervalMs, 750)
})

test('readiness probe accepts a response slower than the old 3-second limit', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const conn = probeConnection()
  const http = fakeHttp()
  probeRemoteOnce(conn, http.impl)
  assert.equal(http.calls.length, 1)
  assert.equal(http.calls[0].options.port, 5000)

  // 实测一次完整往返约 7.4 秒：旧实现会在第 3 秒把它打断。
  t.mock.timers.tick(4_000)
  assert.equal(http.calls[0].request.destroyed, false, 'slow but healthy round trip must not be aborted')
  assert.equal(conn.status, 'connecting')

  http.calls[0].callback({ resume() {} })
  assert.equal(conn.status, 'connected')
  assert.match(conn.url, /token=fake-token/)
  assert.equal(conn.probeActive, null)
})

test('readiness probe is bounded by a wall-clock deadline, then retries once', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const conn = probeConnection()
  const http = fakeHttp()
  probeRemoteOnce(conn, http.impl)

  t.mock.timers.tick(probeTiming.timeoutMs - 1)
  assert.equal(http.calls[0].request.destroyed, false)
  t.mock.timers.tick(1)
  assert.equal(http.calls[0].request.destroyed, true, 'deadline must release the request')
  assert.match(conn.probeLastError, /单次探活未在 20 秒内收到远端 HTTP 响应/)
  assert.equal(conn.status, 'connecting')
  assert.equal(http.calls.length, 1)

  t.mock.timers.tick(probeTiming.intervalMs)
  assert.equal(http.calls.length, 2, 'a failed probe schedules exactly one retry')
})

test('cancelling an in-flight probe releases its request and stops retrying', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const conn = probeConnection()
  const http = fakeHttp()
  probeRemoteOnce(conn, http.impl)
  assert.equal(conn.probeActive.request, http.calls[0].request)

  cancelProbe(conn)
  assert.equal(http.calls[0].request.destroyed, true)
  assert.equal(conn.probeActive, null)
  assert.equal(conn.probeTimer, null)

  t.mock.timers.tick(probeTiming.timeoutMs + probeTiming.intervalMs)
  assert.equal(http.calls.length, 1, 'a cancelled probe must never retry')
})

test('cancelling clears a queued retry timer', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const conn = probeConnection()
  const http = fakeHttp()
  probeRemoteOnce(conn, http.impl)
  t.mock.timers.tick(probeTiming.timeoutMs)
  assert.notEqual(conn.probeTimer, null, 'a retry should be queued after the deadline')

  cancelProbe(conn)
  assert.equal(conn.probeTimer, null)
  t.mock.timers.tick(probeTiming.intervalMs)
  assert.equal(http.calls.length, 1)
})

test('a late response from an older attempt cannot mark the new connection ready', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const conn = probeConnection()
  const http = fakeHttp()
  probeRemoteOnce(conn, http.impl)

  // 自动重连换了 attempt 与本地端口，旧探测的响应这时才回来。
  conn.attempt = 2
  conn.localPort = 5001
  http.calls[0].callback({ resume() {} })

  assert.equal(conn.status, 'connecting')
  assert.equal(conn.url, null)
})

test('an error from an older attempt does not queue a retry on the new attempt', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const conn = probeConnection()
  const http = fakeHttp()
  probeRemoteOnce(conn, http.impl)

  conn.attempt = 2
  conn.localPort = 5001
  http.calls[0].request.emit('error', new Error('connect ECONNREFUSED 127.0.0.1:5000'))

  assert.equal(conn.probeTimer, null)
  t.mock.timers.tick(probeTiming.intervalMs)
  assert.equal(http.calls.length, 1)
})

test('a refused probe records the reason and keeps retrying while connecting', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const conn = probeConnection()
  const http = fakeHttp()
  probeRemoteOnce(conn, http.impl)

  http.calls[0].request.emit('error', new Error('connect ECONNREFUSED 127.0.0.1:5000'))
  assert.match(conn.probeLastError, /ECONNREFUSED/)
  assert.equal(conn.status, 'connecting')

  t.mock.timers.tick(probeTiming.intervalMs)
  assert.equal(http.calls.length, 2)
})

test('connect timeout describes the tunnel stage instead of blaming the token', () => {
  const conn = probeConnection({
    probeLastError: '本地探活请求失败：connect ECONNREFUSED 127.0.0.1:5000',
    log: ['[connect] 第 1 次连接尝试（initial）', '[setup] 检测到远端已在运行的 dsh（端口 39080），直接接入'],
  })
  const message = buildConnectTimeoutMessage(conn)
  assert.match(message, /SSH 连接超时（45 秒）/)
  assert.match(message, /SSH 隧道已启动/)
  assert.doesNotMatch(message, /没有拿到远端 dsh 的访问令牌/)
  assert.match(message, /最近一次探活失败/)
  assert.match(message, /ECONNREFUSED/)
  assert.match(message, /最近日志/)
})

test('connect timeout still reports a missing token when there is none', () => {
  const conn = probeConnection({ token: null })
  assert.match(buildConnectTimeoutMessage(conn), /没有拿到远端 dsh 的访问令牌/)
})

test('protocol TOKEN lines are redacted from diagnostics while raw stdout keeps them', async () => {
  const conn = connection()
  const result = await runRemoteStep(
    conn,
    process.execPath,
    ['-e', "process.stdout.write('REUSE=1\\nTOKEN=secret-value\\n')"],
    5_000,
  )
  assert.equal(result.code, 0)
  // 解析用的原始输出必须完整保留，才能取到 conn.token。
  assert.match(result.stdout, /TOKEN=secret-value/)
  const logged = conn.log.join('\n')
  assert.match(logged, /TOKEN=\*\*\*/)
  assert.ok(!logged.includes('secret-value'), 'token must never reach the connection log')
})

test('TOKEN lines split across chunks are still redacted', async () => {
  const conn = connection()
  const script = "process.stdout.write('TOKE'); setTimeout(() => process.stdout.write('N=split-secret\\n'), 60)"
  const result = await runRemoteStep(conn, process.execPath, ['-e', script], 5_000)
  assert.equal(result.code, 0)
  assert.ok(result.stdout.includes('TOKEN=split-secret'))
  const logged = conn.log.join('\n')
  assert.match(logged, /TOKEN=\*\*\*/)
  assert.ok(!logged.includes('split-secret'))
})

test('the SSH mirror log file also stores redacted TOKEN lines', async () => {
  const conn = connection()
  await runRemoteStep(conn, process.execPath, ['-e', "process.stdout.write('TOKEN=mirror-secret\\n')"], 5_000)
  // 镜像写入按 400ms 合并落盘。
  await new Promise((resolve) => setTimeout(resolve, 700))
  const mirror = await readFile(join(home, 'remote-desktop-ssh.log'), 'utf8')
  assert.match(mirror, /TOKEN=\*\*\*/)
  assert.ok(!mirror.includes('mirror-secret'), 'token must never reach the SSH mirror log')
})
