/**
 * 「自动探测 + 常驻启动」「停止远端」相关纯函数的冒烟测试：
 * 不启动 ssh、不联网，只校验 argv 与远端脚本的关键约束。
 *
 * 契约（v0.11.0 起）：
 * - 远端 dsh 永远以后台常驻方式运行，ssh 只建隧道（-N），因此断开不会结束远端任务；
 * - 连接时自动探测：端口上有 dsh 就复用，没有就 setsid/nohup 启动；
 * - 只有「停止远端」「重启远端」会结束远端进程。
 *
 * 用法：node test/detached-smoke.mjs
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  buildRemoteDetachedLaunchScript,
  buildRemoteStopScript,
  buildSshArgs,
} from '../index.js'

let passed = 0
let failed = 0
function check(label, condition, detail) {
  if (condition) {
    passed += 1
    console.log(`  ok  ${label}`)
  } else {
    failed += 1
    console.log(`  FAIL ${label}${detail === undefined ? '' : ` :: ${detail}`}`)
  }
}

const baseHost = {
  host: 'example.com',
  port: 22,
  user: 'root',
  identityFile: '',
  remotePort: 39080,
}

console.log('buildSshArgs')
const args = buildSshArgs(baseHost, 40123, 39080)
check('always uses -N (tunnel only, no remote command)', args.includes('-N'))
check(
  'last two argv are -N and user@host',
  args[args.length - 2] === '-N' && args[args.length - 1] === 'root@example.com',
  args.slice(-2).join(' '),
)
check('forwards the remote port', args.join(' ').includes('127.0.0.1:40123:127.0.0.1:39080'))
check('carries no launch command', !args.join(' ').includes('dsh --profile web'))
check('keeps the SSH keepalive options', args.join(' ').includes('ServerAliveInterval=15'))

const keyArgs = buildSshArgs({ ...baseHost, identityFile: '~/.ssh/k.pem' }, 40124, 39080)
check(
  'identityFile is passed with -i and expanded',
  keyArgs.includes('-i') && keyArgs.some((arg) => arg.endsWith('k.pem') && !arg.startsWith('~')),
  keyArgs.join(' '),
)

const portArgs = buildSshArgs(baseHost, 40125)
check('defaults remotePort from host', portArgs.join(' ').includes('127.0.0.1:40125:127.0.0.1:39080'))

console.log('buildRemoteDetachedLaunchScript')
const script = buildRemoteDetachedLaunchScript(39123, "dsh --profile web --port 39123 --no-open 'quoted'")
check('script uses $HOME log path (no literal tilde)', script.includes('LOG="$HOME/.dsh/remote-desktop-web.log"'))
check('script does not redirect into "~/"', !script.includes('>> "~/'))
check('script starts detached with setsid', script.includes('setsid nohup sh -c'))
check('script falls back to nohup', script.includes('nohup sh -c'))
check('script detects an already running dsh', script.includes('REUSE=1'))
check('script checks the pid really is dsh (pid_is_dsh)', script.includes('pid_is_dsh'))
check('script reports a busy non-dsh port', script.includes('FAILED=port-busy'))
check('script reports missing token on reuse', script.includes('FAILED=reuse-no-token'))
check('script reports a fresh launch', script.includes('REUSE=0'))
check('script reads the token only from new log lines', script.includes('read_token $((START + 1))'))
check('script matches the port-specific token line', script.includes('grep -o ":$PORT/?token=[^ ]*"'))
check('script uses the configured port', script.startsWith('PORT=39123'))
check(
  'script single-quotes the launch command safely',
  script.includes(`setsid nohup sh -c 'dsh --profile web --port 39123 --no-open '\\''quoted'\\'''`),
  script.split('\n').find((line) => line.includes('setsid')),
)

console.log('buildRemoteStopScript')
const stop = buildRemoteStopScript(39222)
check('stop script uses the configured port', stop.startsWith('PORT=39222'))
check('stop script finds the listener via fuser', stop.includes('fuser -n tcp "$PORT"'))
check('stop script only kills dsh processes', stop.includes('grep -q dsh'))
check('stop script escalates to kill -9', stop.includes('kill -9'))
check('stop script waits for the port to be released', stop.includes('check_port'))
check('stop script reports STOPPED=1 when it killed something', stop.includes('STOPPED=$FOUND'))
check('stop script defaults FOUND=0', stop.includes('FOUND=0'))

// 语法检查：有可用 POSIX shell 时用 sh -n 验证（Windows 上 Git bash 在受限环境里
// 可能无法启动，探测失败就跳过；真实语法验证在 Linux 服务器上做）。
const shellCandidates =
  process.platform === 'win32'
    ? ['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files\\Git\\usr\\bin\\sh.exe']
    : ['/bin/sh', '/usr/bin/sh', 'sh']
const shell = shellCandidates.find((candidate) => {
  if (candidate.includes(path.sep) && !fs.existsSync(candidate)) return false
  const probe = spawnSync(candidate, ['-c', 'exit 0'], { timeout: 10_000 })
  return probe.status === 0
})
if (shell === undefined) {
  console.log('  skip shell syntax check (no POSIX shell available)')
} else {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rd-detached-'))
  for (const [label, body] of [
    ['launch', script],
    ['stop', stop],
  ]) {
    const file = path.join(dir, `${label}.sh`)
    fs.writeFileSync(file, `${body}\n`, 'utf8')
    const result = spawnSync(shell, ['-n', file], { encoding: 'utf8' })
    check(`${label} script passes shell -n syntax check`, result.status === 0, result.stderr?.trim())
  }
  fs.rmSync(dir, { recursive: true, force: true })
}

console.log(`\n${passed}/${passed + failed} checks passed`)
if (failed > 0) process.exit(1)
