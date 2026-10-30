/**
 * 「保持远端运行」（keep-alive）与「重启远端」的纯函数冒烟测试：
 * 不启动 ssh、不联网，只校验 argv 与远端脚本的关键约束。
 *
 * 用法：node test/detached-smoke.mjs
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  buildRemoteDetachedLaunchScript,
  buildSshArgs,
  isDetachedLaunch,
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
  mode: 'launch',
  host: 'example.com',
  port: 22,
  user: 'root',
  identityFile: '',
  remotePort: 39080,
  launchCommand: 'dsh --profile web --port {port} --no-open',
}

console.log('isDetachedLaunch')
check('launch + keep → true', isDetachedLaunch({ ...baseHost, keepRemoteRunning: true }) === true)
check('launch without keep → false', isDetachedLaunch(baseHost) === false)
check('attach + keep → false', isDetachedLaunch({ ...baseHost, mode: 'attach', keepRemoteRunning: true }) === false)
check('undefined host → false', isDetachedLaunch(undefined) === false)

console.log('buildSshArgs')
const keepArgs = buildSshArgs({ ...baseHost, keepRemoteRunning: true }, 40123, 39080)
check('keep-alive launch uses -N', keepArgs.includes('-N'))
check(
  'keep-alive launch carries no remote command',
  keepArgs[keepArgs.length - 1] === 'root@example.com',
  keepArgs.join(' '),
)
check('keep-alive tunnel forwards the remote port', keepArgs.join(' ').includes('127.0.0.1:40123:127.0.0.1:39080'))

const normalArgs = buildSshArgs(baseHost, 40124, 39080)
check('normal launch has no -N', !normalArgs.includes('-N'))
check(
  'normal launch appends launch command with {port} replaced',
  normalArgs[normalArgs.length - 1] === 'dsh --profile web --port 39080 --no-open',
  normalArgs[normalArgs.length - 1],
)

const attachArgs = buildSshArgs({ ...baseHost, mode: 'attach' }, 40125, 39080)
check('attach uses -N', attachArgs.includes('-N'))

console.log('buildRemoteDetachedLaunchScript')
const script = buildRemoteDetachedLaunchScript(39123, "dsh --profile web --port 39123 --no-open 'quoted'")
check('script uses $HOME log path (no literal tilde)', script.includes('LOG="$HOME/.dsh/remote-desktop-web.log"'))
check('script does not redirect into "~/"', !script.includes('>> "~/'))
check('script starts detached with setsid', script.includes('setsid nohup sh -c'))
check('script falls back to nohup', script.includes('nohup sh -c'))
check('script reuses an existing dsh', script.includes('REUSE=1'))
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
  const file = path.join(dir, 'script.sh')
  fs.writeFileSync(file, `${script}\n`, 'utf8')
  const result = spawnSync(shell, ['-n', file], { encoding: 'utf8' })
  check('script passes shell -n syntax check', result.status === 0, result.stderr?.trim())
  fs.rmSync(dir, { recursive: true, force: true })
}

console.log(`\n${passed}/${passed + failed} checks passed`)
if (failed > 0) process.exit(1)
