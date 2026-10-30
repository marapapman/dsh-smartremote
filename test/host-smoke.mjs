/**
 * Host 半冒烟测试：用假 Cordis ctx 挂载 index.js，起真实 HTTP 服务，验证
 * 鉴权 / CRUD / 连接状态机（url 模式）/ 校验 / 404 缺省路由 / 持久化 / 卸载清理，
 * 以及「本地 SSH 自动发现」（ssh_config / known_hosts 解析、Include、去重、
 * imported 标记、missing 目录降级）。
 *
 * 运行（workspace 根）：
 *   node remote-desktop/test/host-smoke.mjs
 *
 * 不触网、不启动 ssh：SSH 连接本身需要真实服务器联调；discover 的 ssh-add 探测
 * 是 best-effort，受限环境里会降级为 unavailable，测试只断言结构不断言成功。
 * 所有临时文件都在系统临时目录里创建并清理。
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const PLUGIN = pathToFileURL(join(import.meta.dirname, '..', 'index.js')).href
const OWNER_COOKIE = 'dsh-desktop-test-cookie=owner'
const results = []

/* ------------------ 自动发现测试夹具（隔离的临时 ssh 目录） ------------------ */

const SSH_CONFIG_FIXTURE = `# global defaults（首个 Host 之前）
User globaluser
Port 2200
IdentityFile ~/.ssh/global_key

Host prod
  HostName 10.0.0.5
  User root
  Port 2222
  IdentityFile %d/.ssh/prod_key

Host web ops
  HostName %h.example.com
  User deploy

Host first second
  HostName first.example.com
  User user1
  User user2
  Port 2400
  Port 2401
  IdentityFile ~/.ssh/first_key
  IdentityFile ~/.ssh/ignored_key

Host *
  User ignored

Host badport
  HostName badport.example.com
  Port notaport

Host matchy
  HostName matchy.example.com
Match all
  HostName should-not-appear.example.com

Host after-match
  HostName after.match.example.com

Host token-h
  HostName %h.internal

Host token-n
  HostName %n.internal

Host token-unknown
  HostName %q.invalid

Host equals-style
  HostName="quoted.example.com"
  PORT=2223

Include extra.conf

Host priority
  HostName priority.example.com
  User ""
  Port 22

Host nohostname
  User nobody
`

const SSH_EXTRA_CONFIG_FIXTURE = `Host included
  HostName included.example.com
  User includeuser
  Port 2022
Include nested.conf
`

const SSH_NESTED_CONFIG_FIXTURE = `Host nested
  HostName nested.example.com
  User nesteduser
`

const SSH_KNOWN_HOSTS_FIXTURE = `# 普通注释
plain.example.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA
port.example.com ssh-rsa AAAAB3NzaC1yc2EAAAA
[port2.example.com]:2222 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA
wild*.example.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA
|1|abc=|def= ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA
@cert-authority *.example.com ssh-rsa AAAAB3NzaC1yc2EAAAA
@revoked revoked.example.com ssh-rsa AAAAB3NzaC1yc2EAAAA
multi1.example.com,multi2.example.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA
dup.example.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA
dup.example.com ssh-rsa AAAAB3NzaC1yc2EAAAA
priority.example.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA
`

/** 写入隔离的 ssh 夹具目录，返回路径。 */
async function writeSshFixtures(home) {
  const sshDir = join(home, 'ssh-fixture')
  await mkdir(sshDir, { recursive: true })
  await writeFile(join(sshDir, 'config'), SSH_CONFIG_FIXTURE, 'utf8')
  await writeFile(join(sshDir, 'extra.conf'), SSH_EXTRA_CONFIG_FIXTURE, 'utf8')
  await writeFile(join(sshDir, 'nested.conf'), SSH_NESTED_CONFIG_FIXTURE, 'utf8')
  await writeFile(join(sshDir, 'known_hosts'), SSH_KNOWN_HOSTS_FIXTURE, 'utf8')
  // 假的“私钥”文件：只用于存在性探测断言，discover 不得读取/回显内容。
  await writeFile(join(sshDir, 'id_ed25519'), 'SECRET-PRIVATE-KEY-MATERIAL\n', 'utf8')
  return sshDir
}

function check(name, condition, detail = '') {
  results.push({ name, ok: !!condition, detail })
  if (!condition) console.error(`FAIL ${name}${detail ? ` — ${detail}` : ''}`)
}

/** 假 ctx：owner cookie 通过鉴权，其余 401；collect 注册与清理函数。 */
function createFakeContext() {
  const routes = []
  const disposers = []
  const context = {
    connection: {
      admit(request) {
        const headers = request.headers || {}
        return headers.cookie === OWNER_COOKIE
          ? { peer: { principal: { kind: 'owner' } } }
          : { rejection: 401 }
      },
    },
    webServer: {
      register(route) {
        routes.push(route)
        return () => {}
      },
    },
    effect(register) {
      const dispose = register()
      if (typeof dispose === 'function') disposers.push(dispose)
      return dispose
    },
  }
  return { context, routes, disposers }
}

async function serve(routes) {
  const server = createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
    const route = routes.find((entry) => entry.kind === 'prefix' && pathname.startsWith(entry.path))
    if (route === undefined) {
      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end('not found')
      return
    }
    route.handler(req, res)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { server, base: `http://127.0.0.1:${server.address().port}` }
}

async function call(base, method, path, body, cookie = OWNER_COOKIE) {
  const headers = {}
  if (cookie) headers.cookie = cookie
  if (body !== undefined) headers['content-type'] = 'application/json'
  const response = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  let payload = null
  try {
    payload = await response.json()
  } catch {
    payload = null
  }
  return { status: response.status, payload }
}

async function main() {
  const home = await mkdtemp(join(tmpdir(), 'rd-smoke-'))
  const sshDir = await writeSshFixtures(home)
  const missingSshDir = join(home, 'ssh-missing')
  const partialSshDir = join(home, 'ssh-partial')
  await mkdir(partialSshDir, { recursive: true })
  await writeFile(join(partialSshDir, 'known_hosts'), 'only-known.example.com ssh-ed25519 AAAA\n', 'utf8')

  process.env.DSH_HOME = home
  process.env.DSH_REMOTE_DESKTOP_SSH_DIR = sshDir
  const first = createFakeContext()
  const module = await import(PLUGIN)
  module.apply(first.context)
  const { server, base } = await serve(first.routes)
  const prefix = '/remote-desktop/api'

  try {
    // 1. 鉴权
    const anonymous = await call(base, 'GET', `${prefix}/state`, undefined, '')
    check('unauthenticated state → 401', anonymous.status === 401 && anonymous.payload?.ok === false)
    const unauthenticatedPost = await call(base, 'POST', `${prefix}/connect`, { id: 'x' }, '')
    check('unauthenticated post → 401', unauthenticatedPost.status === 401)

    // 2. 初始 state
    const initial = await call(base, 'GET', `${prefix}/state`)
    check(
      'state shape',
      initial.status === 200 &&
        initial.payload?.ok === true &&
        Array.isArray(initial.payload.hosts) &&
        typeof initial.payload.active === 'object' &&
        typeof initial.payload.ssh?.available === 'boolean',
    )
    check('state hosts empty', initial.payload.hosts.length === 0)

    // 3. 校验
    const badMode = await call(base, 'POST', `${prefix}/hosts`, { host: { mode: 'ssh' } })
    check('invalid mode → 400', badMode.status === 400)
    const badPort = await call(base, 'POST', `${prefix}/hosts`, {
      host: { mode: 'launch', host: 'example.com', port: 70000 },
    })
    check('invalid port → 400', badPort.status === 400)
    const badUrl = await call(base, 'POST', `${prefix}/hosts`, { host: { mode: 'url', url: 'ftp://x' } })
    check('invalid url protocol → 400', badUrl.status === 400)

    // 4. 新建 url 模式主机并持久化
    const created = await call(base, 'POST', `${prefix}/hosts`, {
      host: { name: 'Local UI', mode: 'url', url: 'http://127.0.0.1:9/' },
    })
    check('create host', created.status === 200 && typeof created.payload?.host?.id === 'string')
    const id = created.payload.host.id
    const store = JSON.parse(await readFile(join(home, 'remote-desktop.json'), 'utf8'))
    check('store persisted', store.version === 1 && store.hosts.some((host) => host.id === id))

    // 4b. launch 模式：installCommand 默认值 / 自定义值持久化 / 非 launch 模式忽略
    const launchHost = await call(base, 'POST', `${prefix}/hosts`, {
      host: { name: 'Auto Install', mode: 'launch', host: 'example.com' },
    })
    check(
      'launch host default installCommand',
      launchHost.status === 200 && launchHost.payload?.host?.installCommand === 'npm install -g @deepseek-ai/dsh',
      JSON.stringify(launchHost.payload),
    )
    const launchId = launchHost.payload?.host?.id
    const customInstall = await call(base, 'POST', `${prefix}/hosts`, {
      host: {
        id: launchId,
        name: 'Auto Install',
        mode: 'launch',
        host: 'example.com',
        installCommand: 'apt-get install -y dsh',
      },
    })
    check('custom installCommand persisted', customInstall.payload?.host?.installCommand === 'apt-get install -y dsh')
    const urlHostInstall = await call(base, 'POST', `${prefix}/hosts`, {
      host: { id, name: 'Local UI', mode: 'url', url: 'http://127.0.0.1:9/', installCommand: 'ignored' },
    })
    check('installCommand cleared for non-launch mode', urlHostInstall.payload?.host?.installCommand === '')
    await call(base, 'POST', `${prefix}/hosts/delete`, { id: launchId })

    // 5. 连接状态机（url 模式立即 connected）
    const connected = await call(base, 'POST', `${prefix}/connect`, { id })
    check('connect accepted', connected.status === 200 && connected.payload?.ok === true)
    const afterConnect = await call(base, 'GET', `${prefix}/state`)
    const view = afterConnect.payload.active[id]
    check(
      'url mode connected',
      view?.status === 'connected' && view?.url === 'http://127.0.0.1:9/',
      JSON.stringify(view),
    )

    // 6. 编辑保留 id
    const edited = await call(base, 'POST', `${prefix}/hosts`, {
      host: { id, name: 'Renamed', mode: 'url', url: 'http://127.0.0.1:9/' },
    })
    check('edit keeps id', edited.payload?.host?.id === id && edited.payload.host.name === 'Renamed')

    // 7. 断开
    const disconnected = await call(base, 'POST', `${prefix}/disconnect`, { id })
    check('disconnect accepted', disconnected.status === 200)
    const afterDisconnect = await call(base, 'GET', `${prefix}/state`)
    check('disconnected view', afterDisconnect.payload.active[id]?.status === 'disconnected')

    // 8. 测试端点（url 模式无需 SSH）
    const tested = await call(base, 'POST', `${prefix}/test`, { id })
    check('test url mode', tested.status === 200 && tested.payload?.ok === true)

    // 9. 未知路由 / 未知 id
    const unknown = await call(base, 'GET', `${prefix}/nope`)
    check('unknown endpoint → 404', unknown.status === 404)
    const missing = await call(base, 'POST', `${prefix}/connect`, { id: 'missing' })
    check('unknown id → 404', missing.status === 404)

    // 9b. 本机打开浏览器：只校验入参拒绝逻辑（有效链接会真的拉起浏览器，冒烟测试不触发）
    const anonymousOpen = await call(base, 'POST', `${prefix}/open-url`, { url: 'https://platform.deepseek.com/dsh/authorize' }, '')
    check('open-url unauthenticated → 401', anonymousOpen.status === 401)
    const missingUrl = await call(base, 'POST', `${prefix}/open-url`, {})
    check('open-url missing url → 400', missingUrl.status === 400)
    const badProtocol = await call(base, 'POST', `${prefix}/open-url`, { url: 'file:///C:/Windows/System32/calc.exe' })
    check('open-url rejects file: → 400', badProtocol.status === 400)
    const badScheme = await call(base, 'POST', `${prefix}/open-url`, { url: 'javascript:alert(1)' })
    check('open-url rejects javascript: → 400', badScheme.status === 400)
    const withCredentials = await call(base, 'POST', `${prefix}/open-url`, { url: 'https://user:pass@example.com/x' })
    check('open-url rejects credentials → 400', withCredentials.status === 400)

    // 10. 删除
    const removed = await call(base, 'POST', `${prefix}/hosts/delete`, { id })
    check('delete host', removed.status === 200)
    const afterDelete = await call(base, 'GET', `${prefix}/state`)
    check('state empty after delete', afterDelete.payload.hosts.length === 0 && !afterDelete.payload.active[id])

    // 11. 本地 SSH 自动发现（GET /discover）
    const anonymousDiscover = await call(base, 'GET', `${prefix}/discover`, undefined, '')
    check('discover unauthenticated → 401', anonymousDiscover.status === 401)

    const discovered = await call(base, 'GET', `${prefix}/discover`)
    const discoverPayload = discovered.payload ?? {}
    const sources = discoverPayload.sources ?? []
    const agent = discoverPayload.agent ?? {}
    const defaultKeys = discoverPayload.defaultKeys ?? []
    const candidates = discoverPayload.candidates ?? []
    const byName = (name) => candidates.find((candidate) => candidate.name === name)
    const byHost = (host) => candidates.filter((candidate) => candidate.host === host)

    check(
      'discover ok shape',
      discovered.status === 200 &&
        discoverPayload.ok === true &&
        Array.isArray(sources) &&
        Array.isArray(candidates) &&
        Array.isArray(defaultKeys) &&
        typeof agent === 'object' &&
        agent !== null,
    )
    check(
      'discover source paths',
      sources.length === 2 &&
        sources[0]?.path === join(sshDir, 'config') &&
        sources[1]?.path === join(sshDir, 'known_hosts'),
      JSON.stringify(sources),
    )
    check(
      'config source entries/skipped',
      sources[0]?.exists === true && sources[0]?.entries === 16 && sources[0]?.skipped === 1,
      JSON.stringify(sources[0]),
    )
    check(
      'known_hosts source entries/hashed',
      sources[1]?.exists === true && sources[1]?.entries === 8 && sources[1]?.hashed === 1,
      JSON.stringify(sources[1]),
    )

    // ssh_config：多别名、首值优先、glob/Match、%h/%n、%d/~、非法 Port、全局缺省
    check(
      'config multi-alias Host',
      byName('web')?.host === 'web.example.com' &&
        byName('ops')?.host === 'ops.example.com' &&
        byName('web')?.user === 'deploy',
      JSON.stringify(byName('web')),
    )
    check(
      'config first value wins',
      byName('first')?.user === 'user1' &&
        byName('first')?.port === 2400 &&
        byName('first')?.identityFile === '~/.ssh/first_key',
      JSON.stringify(byName('first')),
    )
    check(
      'config glob pattern skipped',
      byName('*') === undefined &&
        candidates.every((candidate) => !String(candidate.name).includes('*')) &&
        sources[0]?.skipped === 1,
    )
    check(
      'config Match ignored',
      candidates.every((candidate) => candidate.host !== 'should-not-appear.example.com') &&
        byName('matchy')?.host === 'matchy.example.com' &&
        byName('after-match')?.host === 'after.match.example.com',
    )
    check(
      'config HostName %h',
      byName('web')?.host === 'web.example.com' && byName('token-h')?.host === 'token-h.internal',
    )
    check('config HostName %n', byName('token-n')?.host === 'token-n.internal')
    check('config unknown token falls back to alias', byName('token-unknown')?.host === 'token-unknown')
    check(
      'config IdentityFile %d expanded',
      String(byName('prod')?.identityFile ?? '').startsWith(homedir()) &&
        String(byName('prod')?.identityFile ?? '').endsWith('prod_key') &&
        !String(byName('prod')?.identityFile ?? '').includes('%d'),
      JSON.stringify(byName('prod')),
    )
    check(
      'config global defaults applied',
      byName('after-match')?.user === 'globaluser' &&
        byName('after-match')?.port === 2200 &&
        byName('after-match')?.identityFile === '~/.ssh/global_key',
      JSON.stringify(byName('after-match')),
    )
    check('config invalid Port falls back 22', byName('badport')?.port === 22)
    check(
      'config Include applied',
      byName('included')?.host === 'included.example.com' &&
        byName('included')?.port === 2022 &&
        byName('included')?.sourcePath === join(sshDir, 'extra.conf') &&
        byName('nested')?.host === 'nested.example.com' &&
        byName('nested')?.sourcePath === join(sshDir, 'nested.conf'),
      JSON.stringify(byName('included')),
    )
    check(
      'config Key=value and quotes',
      byName('equals-style')?.host === 'quoted.example.com' && byName('equals-style')?.port === 2223,
      JSON.stringify(byName('equals-style')),
    )

    // known_hosts：明文、[host]:port、通配符/哈希/marker 跳过
    check(
      'known_hosts plain and [host]:port',
      byName('plain.example.com')?.port === 22 &&
        byName('plain.example.com')?.user === '' &&
        byName('port2.example.com')?.port === 2222,
    )
    check(
      'known_hosts wildcard skipped',
      candidates.every((candidate) => !/[*?]/.test(String(candidate.host ?? ''))),
    )
    check(
      'known_hosts hashed skipped and counted',
      sources[1]?.hashed === 1 && candidates.every((candidate) => !String(candidate.key).includes('|1|')),
    )

    // 合并去重 / 排序 / 字段结构
    check(
      'ssh-config priority over known_hosts',
      byHost('priority.example.com').length === 1 &&
        byHost('priority.example.com')[0]?.source === 'ssh-config' &&
        byHost('priority.example.com')[0]?.user === '',
      JSON.stringify(byHost('priority.example.com')),
    )
    check(
      'dedupe by host|port|user',
      byHost('first.example.com').length === 1 &&
        byHost('dup.example.com').length === 1 &&
        candidates.length === 21,
      `candidates=${candidates.length}`,
    )
    check(
      'candidates sorted by name',
      JSON.stringify(candidates.map((candidate) => candidate.name)) ===
        JSON.stringify(candidates.map((candidate) => candidate.name).slice().sort((a, b) => String(a).localeCompare(String(b)))),
    )
    const prodCandidate = byName('prod')
    check(
      'candidate shape',
      prodCandidate !== undefined &&
        Object.keys(prodCandidate).length === 10 &&
        ['key', 'source', 'sourcePath', 'name', 'alias', 'host', 'port', 'user', 'identityFile', 'imported'].every(
          (key) => key in prodCandidate,
        ) &&
        prodCandidate.key === 'ssh-config:prod',
      JSON.stringify(prodCandidate),
    )

    // imported：与已保存 host 的匹配（host + port + user）
    check('imported false before save', byName('plain.example.com')?.imported === false)
    const savedCandidate = await call(base, 'POST', `${prefix}/hosts`, {
      host: { name: 'Plain known', mode: 'launch', host: 'plain.example.com' },
    })
    check(
      'save candidate host',
      savedCandidate.status === 200 && typeof savedCandidate.payload?.host?.id === 'string',
    )
    const discoveredAfterSave = await call(base, 'GET', `${prefix}/discover`)
    const candidatesAfterSave = discoveredAfterSave.payload?.candidates ?? []
    check(
      'imported true after save',
      candidatesAfterSave.find((candidate) => candidate.name === 'plain.example.com')?.imported === true &&
        candidatesAfterSave.find((candidate) => candidate.name === 'prod')?.imported === false,
    )
    const deletedCandidate = await call(base, 'POST', `${prefix}/hosts/delete`, {
      id: savedCandidate.payload.host.id,
    })
    check('delete candidate host', deletedCandidate.status === 200)
    const discoveredAfterDelete = await call(base, 'GET', `${prefix}/discover`)
    check(
      'imported false after delete',
      (discoveredAfterDelete.payload?.candidates ?? []).find(
        (candidate) => candidate.name === 'plain.example.com',
      )?.imported === false,
    )

    // agent / 默认密钥（best-effort，只断言结构；受限环境会降级为 unavailable）
    check(
      'agent probe shape',
      typeof agent.available === 'boolean' &&
        Number.isInteger(agent.keys) &&
        agent.keys >= 0 &&
        typeof agent.detail === 'string',
      JSON.stringify(agent),
    )
    check(
      'defaultKeys detected',
      defaultKeys.length === 1 && defaultKeys[0] === join(sshDir, 'id_ed25519'),
      JSON.stringify(defaultKeys),
    )
    check(
      'private key content never exposed',
      !JSON.stringify(discoverPayload).includes('SECRET-PRIVATE-KEY-MATERIAL'),
    )

    // 缺失目录 / 部分缺失：仍然 200，sources[].exists 单独降级
    process.env.DSH_REMOTE_DESKTOP_SSH_DIR = missingSshDir
    const missingDiscover = await call(base, 'GET', `${prefix}/discover`)
    const missingSources = missingDiscover.payload?.sources ?? []
    check(
      'missing ssh dir → 200 degraded',
      missingDiscover.status === 200 &&
        missingDiscover.payload?.ok === true &&
        missingSources.length === 2 &&
        missingSources.every((source) => source.exists === false && source.entries === 0) &&
        (missingDiscover.payload?.candidates ?? []).length === 0,
      JSON.stringify(missingSources),
    )

    process.env.DSH_REMOTE_DESKTOP_SSH_DIR = partialSshDir
    const partialDiscover = await call(base, 'GET', `${prefix}/discover`)
    const partialSources = partialDiscover.payload?.sources ?? []
    const partialCandidates = partialDiscover.payload?.candidates ?? []
    check(
      'partial ssh dir degrades per source',
      partialDiscover.status === 200 &&
        partialSources[0]?.exists === false &&
        partialSources[1]?.exists === true &&
        partialSources[1]?.entries === 1 &&
        partialCandidates.length === 1 &&
        partialCandidates[0]?.host === 'only-known.example.com',
      JSON.stringify(partialSources),
    )
    process.env.DSH_REMOTE_DESKTOP_SSH_DIR = sshDir

    // 12. 重新加载插件实例：配置从同一 DSH_HOME 恢复
    await call(base, 'POST', `${prefix}/hosts`, {
      host: { name: 'Restored', mode: 'url', url: 'http://127.0.0.1:9/' },
    })
    server.close()
    const second = createFakeContext()
    const reloaded = await import(`${PLUGIN}?reload=1`)
    reloaded.apply(second.context)
    const restoredServer = await serve(second.routes)
    const restored = await call(restoredServer.base, 'GET', `${prefix}/state`)
    check(
      'hosts restored after reload',
      restored.payload.hosts.length === 1 && restored.payload.hosts[0].name === 'Restored',
    )

    // 13. 卸载清理不抛错
    for (const dispose of second.disposers.reverse()) await dispose()
    check('dispose clean', true)
    restoredServer.server.close()
  } finally {
    server.close()
    await rm(home, { recursive: true, force: true })
  }

  const failed = results.filter((entry) => !entry.ok)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
  process.exitCode = failed.length === 0 ? 0 : 1
}

await main()
