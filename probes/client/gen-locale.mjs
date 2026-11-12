#!/usr/bin/env node
/**
 * 从 lib/client.js 内嵌的 DICT 生成 locale/zh.json、locale/en.json。
 * 单文件手写 bundle 没有构建步骤，内嵌字典是唯一事实来源；这两个 JSON 是
 * 可评审/可复用的导出副本，test/client-bundle.test.js 会断言二者一致（防漂移）。
 *
 * 用法：node probes/client/gen-locale.mjs [--check]
 */
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..')
const BUNDLE = join(ROOT, 'lib', 'client.js')
const LOCALE_DIR = join(ROOT, 'locale')

const source = await readFile(BUNDLE, 'utf8')
let factory = null
const prevWindow = globalThis.window
const prevDocument = globalThis.document
const prevLocation = globalThis.location
globalThis.window = { __ModuleLoader__: { load: (spec) => { factory = spec.factory } } }
globalThis.document = { createElement: () => ({ setAttribute() {}, textContent: '', parentNode: null }), head: { appendChild() {} }, visibilityState: 'visible' }
globalThis.location = { search: '' }
try {
  // eslint-disable-next-line no-eval
  eval(source)
} finally {
  globalThis.window = prevWindow
  globalThis.document = prevDocument
  globalThis.location = prevLocation
}
if (factory === null) throw new Error('bundle did not call __ModuleLoader__.load')
const fakeReact = { createElement: () => null }
const moduleExports = factory((id) => {
  if (id === 'react') return fakeReact
  if (id === '@deepseek-ai/dsh-client-ui-primitives') return {}
  throw new Error('unexpected require: ' + id)
})
const dict = moduleExports.__locale
if (dict === undefined || dict.zh === undefined || dict.en === undefined) throw new Error('bundle does not export __locale')

const sortKeys = (record) => Object.fromEntries(Object.keys(record).sort().map((key) => [key, record[key]]))
const zh = sortKeys(dict.zh)
const en = sortKeys(dict.en)
const checkOnly = process.argv.includes('--check')
const { mkdir } = await import('node:fs/promises')
if (!checkOnly) await mkdir(LOCALE_DIR, { recursive: true })

for (const [locale, record] of [['zh', zh], ['en', en]]) {
  const file = join(LOCALE_DIR, locale + '.json')
  const text = JSON.stringify(record, null, 2) + '\n'
  if (checkOnly) {
    const current = await readFile(file, 'utf8')
    if (current !== text) throw new Error(`locale/${locale}.json is out of date; run node probes/client/gen-locale.mjs`)
  } else {
    await writeFile(file, text)
  }
}
console.log((checkOnly ? 'checked' : 'wrote') + ' locale dictionaries: ' + Object.keys(zh).length + ' zh keys, ' + Object.keys(en).length + ' en keys')
