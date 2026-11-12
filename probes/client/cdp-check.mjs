#!/usr/bin/env node
/**
 * client-ui 探针驱动：用 Chrome DevTools Protocol 打开隔离测试 profile 的 DSH Web GUI，
 * 读取 window.__MAILBOX_PROBE__ 注册结果、点左侧「邮箱探针」入口、截图。
 *
 * 用法：node probes/client/cdp-check.mjs <token-url> [--shot out.png] [--prefix mailbox-probe]
 * 依赖：本机 google-chrome（headless），Node ≥ 22 的全局 WebSocket。
 */
import { spawn } from 'node:child_process'
import { writeFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const url = process.argv[2]
const shotArg = process.argv.indexOf('--shot')
const shot = shotArg > 0 ? process.argv[shotArg + 1] : '/tmp/mailbox-probe.png'
const prefixArg = process.argv.indexOf('--prefix')
const prefix = prefixArg > 0 ? process.argv[prefixArg + 1] : 'mailbox-probe'
if (url === undefined) {
  console.error('usage: node cdp-check.mjs <url> [--shot file.png] [--prefix id]')
  process.exit(2)
}

const CHROME = process.env.CHROME_BIN ?? '/usr/bin/google-chrome'
const PORT = 9223
const profileDir = '/tmp/clientui-chrome-profile'

const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--no-first-run',
    '--disable-dev-shm-usage',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profileDir}`,
    '--window-size=1440,900',
    'about:blank',
  ],
  { stdio: 'ignore' },
)

async function cdpTargets() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/list`)
  return res.json()
}

let ws
let nextId = 1
const pending = new Map()
function send(method, params = {}) {
  const id = nextId++
  ws.send(JSON.stringify({ id, method, params }))
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
}

async function waitFor(fn, { timeout = 30000, interval = 250 } = {}) {
  const started = Date.now()
  for (;;) {
    const value = await fn()
    if (value !== undefined && value !== null && value !== false) return value
    if (Date.now() - started > timeout) throw new Error('waitFor timeout')
    await delay(interval)
  }
}

async function main() {
  // 等 devtools 端口
  await waitFor(async () => {
    try {
      const list = await cdpTargets()
      return list.length > 0 ? list : undefined
    } catch {
      return undefined
    }
  })
  const list = await cdpTargets()
  const page = list.find((t) => t.type === 'page') ?? list[0]
  ws = new WebSocket(page.webSocketDebuggerUrl)
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(String(event.data))
    if (msg.id !== undefined) {
      const slot = pending.get(msg.id)
      if (slot !== undefined) {
        pending.delete(msg.id)
        if (msg.error !== undefined) slot.reject(new Error(JSON.stringify(msg.error)))
        else slot.resolve(msg.result)
      }
    }
  })
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true })
    ws.addEventListener('error', reject, { once: true })
  })
  await send('Page.enable')
  await send('Runtime.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })

  // 收集 console 错误
  const consoleErrors = []
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(String(event.data))
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      consoleErrors.push(msg.params.args.map((a) => a.value ?? a.description ?? a.type).join(' '))
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      consoleErrors.push('exception: ' + JSON.stringify(msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text))
    }
  })

  await send('Page.navigate', { url })
  const probe = await waitFor(async () => {
    const res = await send('Runtime.evaluate', {
      expression: 'window.__MAILBOX_PROBE__ === undefined ? null : JSON.stringify(window.__MAILBOX_PROBE__)',
      returnByValue: true,
    })
    const raw = res?.result?.value
    if (raw === undefined || raw === null) return undefined
    const parsed = JSON.parse(raw)
    return parsed.registered?.['main'] && parsed.registered?.['sidebar.panellist'] ? parsed : undefined
  })
  console.log('PROBE=' + JSON.stringify(probe, null, 2))

  // 左栏入口是否渲染
  const sidebar = await send('Runtime.evaluate', {
    expression: `(${(() => {
      const rows = Array.from(document.querySelectorAll('button'))
        .map((b) => ({ text: (b.textContent || '').trim().slice(0, 40), aria: b.getAttribute('aria-label') || '' }))
        .filter((r) => r.text !== '' || r.aria !== '')
      return JSON.stringify(rows)
    }).toString()})()`,
    returnByValue: true,
  })
  console.log('BUTTONS=' + String(sidebar?.result?.value).slice(0, 2500))

  // 点击左侧入口
  const clicked = await send('Runtime.evaluate', {
    expression: `(${(() => {
      const wanted = ['邮箱探针', 'Mailbox Probe']
      function scan(root) {
        for (const button of root.querySelectorAll('button')) {
          const label = (button.getAttribute('aria-label') || button.textContent || '').trim()
          if (wanted.some((w) => label.includes(w))) {
            button.click()
            return true
          }
        }
        for (const host of root.querySelectorAll('*')) {
          if (host.shadowRoot !== null && scan(host.shadowRoot)) return true
        }
        return false
      }
      return JSON.stringify({ clicked: scan(document) })
    }).toString()})()`,
    returnByValue: true,
  })
  console.log('CLICK=' + String(clicked?.result?.value))

  const pageReady = await waitFor(async () => {
    const res = await send('Runtime.evaluate', {
      expression: `document.querySelector('[data-testid="mailbox-probe-page"]') !== null`,
      returnByValue: true,
    })
    return res?.result?.value === true ? true : undefined
  })
  console.log('PAGE_READY=' + pageReady)

  await delay(700)
  const shotData = await send('Page.captureScreenshot', { format: 'png' })
  await mkdir(dirname(shot), { recursive: true })
  await writeFile(shot, Buffer.from(shotData.data, 'base64'))
  console.log('SHOT=' + shot)

  // 暗色截图
  await send('Runtime.evaluate', {
    expression: `document.body.setAttribute('data-ds-dark-theme',''); window.dispatchEvent(new Event('resize')); true`,
    returnByValue: true,
  })
  await delay(500)
  const darkShot = shot.replace(/\.png$/, '-dark.png')
  const darkData = await send('Page.captureScreenshot', { format: 'png' })
  await writeFile(darkShot, Buffer.from(darkData.data, 'base64'))
  console.log('SHOT_DARK=' + darkShot)

  // 注册表文本（页面里那份）
  const registry = await send('Runtime.evaluate', {
    expression: `document.querySelector('[data-testid="mailbox-probe-registry"]')?.textContent ?? ''`,
    returnByValue: true,
  })
  console.log('REGISTRY=' + String(registry?.result?.value).slice(0, 1200))
  console.log('CONSOLE_ERRORS=' + JSON.stringify(consoleErrors.slice(0, 20), null, 2))
}

try {
  await main()
} catch (error) {
  console.error('FAILED: ' + String(error?.stack ?? error))
  process.exitCode = 1
} finally {
  try {
    ws?.close()
  } catch {}
  chrome.kill('SIGKILL')
}
