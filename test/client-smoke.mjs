/**
 * Client 半无头加载冒烟测试：用桩 window / React / Cordis ctx 执行 client.js 的
 * factory 和 apply，验证模块能加载、两个 slot 注册、locale 字典注册、卸载清理。
 *
 * 运行（workspace 根）：
 *   node remote-desktop/test/client-smoke.mjs
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import vm from 'node:vm'

const source = await readFile(join(import.meta.dirname, '..', 'client.js'), 'utf8')
const results = []

function check(name, condition, detail = '') {
  results.push({ name, ok: !!condition })
  if (!condition) console.error(`FAIL ${name}${detail ? ` — ${detail}` : ''}`)
}

/* ------------------------------ 桩环境 ------------------------------ */

let definition = null
const React = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn,
  useRef: (value) => ({ current: value }),
}
const requireStub = (id) => {
  if (id === 'react') return React
  throw new Error(`unexpected require(${id})`)
}

const registrations = []
const dictionaries = []
const effects = []
const services = {
  sidebarRightTabs: { get: (kind) => (kind === 'browser' ? { id: 'browser' } : undefined) },
  sidebarRight: {
    openTab: (...args) => registrations.push({ openTab: args }),
    commandTarget: () => undefined,
    toggleFullscreen: (...args) => registrations.push({ toggleFullscreen: args }),
  },
  layout: {
    selectPanel: (id) => registrations.push({ selectPanel: id }),
    openRightbar: (...args) => registrations.push({ openRightbar: args }),
  },
}
const ctx = {
  get: (name) => services[name],
  inject: (deps, callback) => {
    const scope = {}
    for (const name of deps) scope[name] = services[name]
    callback(scope)
    return () => {}
  },
  effect: (register, label) => {
    const dispose = typeof register === 'function' ? register() : undefined
    effects.push({ label, dispose })
    return dispose
  },
  slots: {
    inject: (slotName, callback) => {
      const disposer = callback()
      return typeof disposer === 'function' ? disposer : () => {}
    },
    register: (options, component) => {
      registrations.push({ slot: options.name, options, component })
      return () => {}
    },
  },
  locale: {
    bind: () => (key) => key,
    register: (ns, locale, dict) => {
      dictionaries.push({ ns, locale, keys: Object.keys(dict) })
      return () => {}
    },
    subscribe: () => () => {},
  },
}

const sandbox = {
  window: { __ModuleLoader__: { load: (value) => { definition = value } } },
  document: undefined,
  setTimeout,
  clearTimeout,
  setInterval: () => 0,
  clearInterval: () => {},
  fetch: () => Promise.reject(new Error('no network in smoke test')),
}
sandbox.window.window = sandbox.window

vm.runInNewContext(source, sandbox, { filename: 'client.js' })

/* ------------------------------ 断言 ------------------------------ */

check('module registers a loader definition', definition !== null)
check('loader id matches package', definition?.id === 'dsh-smartremote')
check('factory is a function', typeof definition?.factory === 'function')

const factoryExports = definition.factory(requireStub)
check('factory exports inject list', Array.isArray(factoryExports?.inject) && factoryExports.inject.includes('slots'))
check('factory exports apply', typeof factoryExports?.apply === 'function')

factoryExports.apply(ctx)

const slotNames = registrations.filter((entry) => entry.slot).map((entry) => entry.slot)
check('registers the settings section', slotNames.includes('settings.section'))
const sections = registrations.filter((entry) => entry.slot === 'settings.section')
check('settings section id', sections[0]?.options?.id === 'remote-desktop-settings')
check('settings label is a thunk', typeof sections[0]?.options?.label === 'function')
check('settings component is a function', typeof sections[0]?.component === 'function')
check(
  'no static sidebar/main entry (per-host entries are dynamic)',
  !slotNames.includes('sidebar.panellist') && !slotNames.includes('main'),
  slotNames.join(','),
)

const zh = dictionaries.find((entry) => entry.locale === 'zh')
const en = dictionaries.find((entry) => entry.locale === 'en')
check('registers zh dictionary', Array.isArray(zh?.keys) && zh.keys.length > 0)
check('registers en dictionary', Array.isArray(en?.keys) && en.keys.length > 0)
const onlyZh = zh.keys.filter((key) => !en.keys.includes(key))
const onlyEn = en.keys.filter((key) => !zh.keys.includes(key))
check('ZH/EN dictionaries have identical keys', onlyZh.length === 0 && onlyEn.length === 0, `${onlyZh} / ${onlyEn}`)
check('dictionary key count', zh.keys.length === en.keys.length && zh.keys.length >= 99, String(zh.keys.length))

check('effect cleanup registered', effects.length >= 3 && effects.some((entry) => typeof entry.dispose === 'function'))

const failed = results.filter((entry) => !entry.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exitCode = failed.length === 0 ? 0 : 1
