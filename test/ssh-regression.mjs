/**
 * SSH 探测/准备/测试回归：不联网、不读私钥、不启动真正的 ssh。
 * 流程用可注入步骤和假子进程；runRemoteStep 仅启动本机 node 验证流/退出/超时。
 * 60 秒边界用虚拟时钟，不实际等待一分钟。
 * 用法：node --test test/ssh-regression.mjs
 */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { after, test } from 'node:test'
import {
  ensureRemoteDsh,
  executeSshTest,
  parseRemoteDshCheck,
  prepareDetachedRemoteDsh,
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
    deadlineTimer: null, probeTimer: null, reconnectTimer: null,
  }
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
    if (result?.stderr) assert.ok(conn.error.includes(result.stderr.trim()))
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
