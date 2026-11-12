/**
 * lib/client.js 静态校验：手写客户端 bundle 的注册形状与安全边界。
 *
 * 不依赖 DSH 运行时：stub `window.__ModuleLoader__` 捕获 factory，用假 React /
 * 假 primitives 物化 exports，再用假 ctx 执行 apply，断言：
 *  1. bundle 以 id='dsh-mailbox' 注册，factory 可执行；
 *  2. exports 形状：name/inject/apply 齐全，apply 不抛错；
 *  3. 注册了左侧页面（main/key=mailbox）、左栏入口、设置页、会话头部入口与 /mailbox 命令；
 *  4. 命令 action 调 ctx.layout.selectPanel('mailbox')；
 *  5. locale 字典（内嵌）与 locale/zh.json、locale/en.json 完全一致；
 *  6. 安全边界：无 dangerouslySetInnerHTML / innerHTML 赋值 / localStorage / allow-scripts，
 *     邮件 iframe 用 sandbox=""，外链带 noopener noreferrer；
 *  7. 不泄漏全局变量；`node --check` 语法通过。
 *
 * 运行：node test/client-bundle.test.js（也可被 node --test test/ 发现）
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const BUNDLE_PATH = join(ROOT, 'lib', 'client.js')
const SOURCE = await readFile(BUNDLE_PATH, 'utf8')

/** 浏览器全局的测试替身（模块级安装；bundle 的 factory/apply 都会用到）。 */
const capturedLoad = { factory: null }
globalThis.window = {
  __ModuleLoader__: {
    load: (spec) => {
      capturedLoad.factory = spec.factory
    },
  },
  __DSH_MAILBOX_UI_MOCK__: true,
}
globalThis.document = {
  createElement: () => {
    const element = {
      attributes: {},
      textContent: '',
      parentNode: null,
      setAttribute(name, value) { this.attributes[name] = value },
    }
    return element
  },
  head: {
    appendChild: (element) => { element.parentNode = { removeChild() {} } },
    textContent: '',
  },
  visibilityState: 'visible',
}
globalThis.location = { search: '' }

/** 捕获 bundle 的 factory（每次加载前清空捕获槽）。 */
function loadBundleFactory() {
  capturedLoad.factory = null
  // eslint-disable-next-line no-eval
  eval(SOURCE)
  assert.equal(typeof capturedLoad.factory, 'function', 'bundle must call window.__ModuleLoader__.load({ factory })')
  return capturedLoad.factory
}

/** 去掉注释后的代码，用于安全边界 grep（注释里说明禁令的文字不算实现）。 */
const CODE = SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

function fakeRequire(id) {
  if (id === 'react') {
    return {
      createElement: () => null,
      Fragment: Symbol('Fragment'),
      useState: (value) => [value, () => {}],
      useEffect: () => {},
      useMemo: (factory) => factory(),
      useRef: (value) => ({ current: value }),
      useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
    }
  }
  if (id === '@deepseek-ai/dsh-client-ui-primitives') return {}
  throw new Error('unexpected require: ' + id)
}

/** 假 ctx：记录 effect / slot 注册 / 命令 / 页面选择。 */
function createFakeContext() {
  const effects = []
  const registrations = []
  const commands = []
  const selectedPanels = []
  const localeRegistrations = []
  const injectedSlots = []
  const ctx = {
    effect(fn, label) {
      const dispose = fn()
      effects.push({ label, dispose })
      return dispose
    },
    locale: {
      register(ns, dict) {
        localeRegistrations.push({ ns, dict })
        return () => {}
      },
      bind(ns) {
        return (key, params) => {
          const registration = localeRegistrations.find((item) => item.ns === ns)
          let text = registration === undefined ? key : (registration.dict.zh[key] ?? key)
          if (params !== undefined && typeof text === 'string') {
            for (const [name, value] of Object.entries(params)) text = text.split('{' + name + '}').join(String(value))
          }
          return text
        }
      },
    },
    slots: {
      inject(name, callback) {
        injectedSlots.push(name)
        return callback()
      },
      register(spec, component) {
        assert.equal(typeof spec, 'object', 'slot registration needs a spec object')
        assert.equal(typeof spec.name, 'string', 'slot registration needs a name')
        assert.equal(typeof component, 'function', 'slot registration needs a component')
        registrations.push({ spec, component })
        return () => {}
      },
    },
    inject(services, callback) {
      const scope = {
        effect(fn, label) {
          const dispose = fn()
          effects.push({ label, dispose })
          return dispose
        },
        commandUi: {
          register(spec) {
            commands.push(spec)
            return () => {}
          },
          decorate() { throw new Error('not expected') },
          dismiss() {},
        },
      }
      assert.ok(services.includes('commandUi'), 'command registration should be injected optionally')
      callback(scope)
    },
    layout: {
      selectPanel(id) { selectedPanels.push(id) },
    },
  }
  return { ctx, effects, registrations, commands, selectedPanels, localeRegistrations, injectedSlots }
}

test('bundle 以 dsh-mailbox id 注册 factory，并且没有语法错误', () => {
  const check = spawnSync(process.execPath, ['--check', BUNDLE_PATH], { encoding: 'utf8' })
  assert.equal(check.status, 0, 'node --check failed: ' + check.stderr)
  const factory = loadBundleFactory()
  assert.equal(typeof factory, 'function')
})

test('exports 形状：name / inject / apply', () => {
  const factory = loadBundleFactory()
  const exports = factory(fakeRequire)
  assert.equal(exports.name, 'mailbox')
  assert.equal(typeof exports.apply, 'function')
  assert.ok(Array.isArray(exports.inject), 'inject must be an array')
  for (const service of ['slots', 'locale', 'layout']) assert.ok(exports.inject.includes(service), 'missing injected service: ' + service)
  assert.ok(exports.inject.includes('commandUi') === false, 'commandUi must be optional (ctx.inject), not required')
  assert.equal(typeof exports.__locale, 'object')
})

test('内嵌字典与 locale/*.json 完全一致（防漂移）', async () => {
  const factory = loadBundleFactory()
  const exports = factory(fakeRequire)
  const dict = exports.__locale
  for (const locale of ['zh', 'en']) {
    const file = join(ROOT, 'locale', locale + '.json')
    const onDisk = JSON.parse(await readFile(file, 'utf8'))
    assert.deepEqual(Object.keys(dict[locale]).sort(), Object.keys(onDisk).sort(), `locale/${locale}.json keys differ from bundle`)
    assert.deepEqual(onDisk, dict[locale], `locale/${locale}.json content differs from bundle; run node probes/client/gen-locale.mjs`)
  }
  assert.deepEqual(Object.keys(dict.zh).sort(), Object.keys(dict.en).sort(), 'zh/en dictionaries must have the same keys')
})

test('apply 注册：左侧页面 + 左栏入口 + 设置页 + 会话头部入口 + /mailbox 命令', () => {
  const factory = loadBundleFactory()
  const exports = factory(fakeRequire)
  const fake = createFakeContext()
  try {
  assert.doesNotThrow(() => exports.apply(fake.ctx), 'apply must not throw with the documented services')

  const names = fake.registrations.map((item) => item.spec.name)
  for (const expected of ['main', 'sidebar.panellist', 'settings.section', 'conversation.session.header.utilities']) {
    assert.ok(names.includes(expected), 'missing slot registration: ' + expected)
  }
  const main = fake.registrations.find((item) => item.spec.name === 'main')
  assert.equal(main.spec.key, 'mailbox')
  const panelRow = fake.registrations.find((item) => item.spec.name === 'sidebar.panellist')
  assert.equal(panelRow.spec.id, 'mailbox')
  assert.equal(panelRow.spec.label(), '邮箱')
  const settingsSection = fake.registrations.find((item) => item.spec.name === 'settings.section')
  assert.equal(settingsSection.spec.id, 'mailbox')
  assert.equal(settingsSection.spec.label(), '邮箱')
  const headerAction = fake.registrations.find((item) => item.spec.name === 'conversation.session.header.utilities')
  assert.equal(headerAction.spec.id, 'mailbox')
  const injected = headerAction.spec.inject()
  injected.openMailbox()
  assert.deepEqual(fake.selectedPanels, ['mailbox'], 'header action must open the mailbox panel')

  assert.equal(fake.commands.length, 1)
  const command = fake.commands[0]
  assert.equal(command.name, 'mailbox')
  assert.equal(command.label(), '邮箱')
  assert.equal(typeof command.description(), 'string')
  assert.equal(command.ui.kind, 'action')
  command.ui.run()
  assert.deepEqual(fake.selectedPanels, ['mailbox', 'mailbox'], 'command action must open the mailbox panel')

  const labels = fake.effects.map((item) => item.label)
  assert.ok(labels.includes('mailbox: styles'), 'CSS must be injected as an owned effect')
  assert.ok(labels.includes('mailbox: dictionaries'))
  assert.ok(labels.some((label) => String(label).includes('command')), 'command registration effect must exist')

  } finally {
    // 清理：停掉未读轮询 interval 等 effect（断言失败也要清理，否则 node:test 会被 timer 拉住）
    for (const effect of fake.effects) {
      try {
        if (typeof effect.dispose === 'function') effect.dispose()
      } catch {
        // best effort
      }
    }
  }
})

test('安全边界：无未消毒 HTML / 无浏览器存储密钥 / 沙箱 iframe / 外链 rel', () => {
  assert.equal(CODE.includes('dangerouslySetInnerHTML'), false, 'must not use dangerouslySetInnerHTML')
  assert.equal(/\.innerHTML\s*=/.test(CODE), false, 'must not assign innerHTML')
  assert.equal(CODE.includes('innerHTML:'), false, 'must not pass innerHTML props')
  assert.equal(CODE.includes('allow-scripts'), false, 'iframe sandbox must not allow scripts')
  assert.equal(CODE.includes('allow-same-origin'), false, 'iframe sandbox must not allow same-origin')
  assert.equal(CODE.includes('localStorage'), false, 'must not store anything in localStorage')
  assert.equal(CODE.includes('sessionStorage'), false, 'must not store anything in sessionStorage')
  assert.equal(CODE.includes('document.cookie'), false, 'must not touch cookies directly')
  assert.ok(CODE.includes("sandbox: ''"), 'mail HTML must render in sandbox="" iframe')
  assert.ok(CODE.includes("rel: 'noopener noreferrer'"), 'external links must carry rel="noopener noreferrer"')
  assert.ok(CODE.includes("target: '_blank'"), 'external links must open in a new tab')
  assert.ok(CODE.includes('x-dsh-mailbox'), 'POST requests must carry the CSRF header')
  assert.ok(CODE.includes('/api/mailbox'), 'client must talk to the authenticated host route')
  // 附件：客户端只做 base64 装配，不写日志/存储
  assert.ok(CODE.includes('addComposerAttachments'), 'composer must support attachments')
  assert.ok(CODE.includes("type: 'file'"), 'composer must render a file picker')
  assert.ok(CODE.includes('payload.attachments = attachments.map'), 'composer must send attachments in mail.send payload')
  assert.ok(CODE.includes('base64: item.base64'), 'attachment payload must carry base64 for the host')
  assert.ok(CODE.includes("value: 'dedicated'"), 'notification target must offer the dedicated session option')
  assert.ok(CODE.includes('dedicatedSessionId'), 'UI must surface the dedicated notification session id')
  assert.equal(/console\.(log|info|warn|error)\s*\(/.test(CODE), false, 'bundle must not log to console')
})

test('不泄漏全局变量', () => {
  const before = new Set(Object.keys(globalThis))
  const factory = loadBundleFactory()
  const exports = factory(fakeRequire)
  const fake = createFakeContext()
  try {
    exports.apply(fake.ctx)
    const after = Object.keys(globalThis).filter((key) => !before.has(key))
    assert.deepEqual(after, [], 'bundle must not create global variables: ' + after.join(', '))
  } finally {
    for (const effect of fake.effects) {
      try {
        if (typeof effect.dispose === 'function') effect.dispose()
      } catch {
        // best effort
      }
    }
  }
})
