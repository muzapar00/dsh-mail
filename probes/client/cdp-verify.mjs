#!/usr/bin/env node
/**
 * dsh-mailbox 客户端真实 UI 验证驱动（隔离 profile / DSH Web GUI + CDP）。
 *
 * 流程：
 *  1. 打开 DSH Web GUI（带启动 token 的 URL），等应用就绪；
 *  2. 关掉首屏「预览版说明」；
 *  3. 找左侧导航「邮箱」入口（验证入口 + 数字徽标），点击进入；
 *  4. 依次点 收件箱/已发送/隔离/好友/设置/诊断 并截图；
 *  5. 设置页展开「如何获取授权码」、截图；
 *  6. 写信面板截图；
 *  7. 亮/暗两套截图；
 *  8. 读取 /api/mailbox?action=state 的 counts，与左栏徽标对照；
 *  9. 打印 console 错误清单。
 *
 * 用法：node probes/client/cdp-verify.mjs '<token url>' --out /tmp/mailbox-ui
 */
import { spawn } from 'node:child_process'
import { writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const url = process.argv[2]
const outArg = process.argv.indexOf('--out')
const outDir = outArg > 0 ? process.argv[outArg + 1] : '/tmp/mailbox-ui'
if (url === undefined) {
  console.error('usage: node cdp-verify.mjs <url> [--out dir]')
  process.exit(2)
}
const CHROME = process.env.CHROME_BIN ?? '/usr/bin/google-chrome'
const PORT = 9224

const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--no-first-run',
    '--disable-dev-shm-usage',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=/tmp/clientui-chrome-verify-${process.pid}`,
    '--window-size=1440,960',
    'about:blank',
  ],
  { stdio: 'ignore' },
)

let ws
let nextId = 1
const pending = new Map()
const consoleErrors = []
const consoleWarnings = []

function send(method, params = {}) {
  const id = nextId++
  ws.send(JSON.stringify({ id, method, params }))
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`CDP command timeout (${method})`))
    }, 20000)
    if (timer !== null && typeof timer.unref === 'function') timer.unref()
    pending.set(id, {
      resolve: (value) => { clearTimeout(timer); resolve(value) },
      reject: (error) => { clearTimeout(timer); reject(error) },
    })
  })
}
async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (result.exceptionDetails !== undefined) throw new Error('evaluate failed: ' + JSON.stringify(result.exceptionDetails.text ?? result.exceptionDetails))
  return result.result?.value
}
async function waitFor(expression, { timeout = 40000, interval = 300, label = '' } = {}) {
  const started = Date.now()
  for (;;) {
    let value
    try {
      value = await evaluate(expression)
    } catch {
      value = undefined
    }
    if (value !== undefined && value !== null && value !== false) return value
    if (Date.now() - started > timeout) throw new Error('waitFor timeout: ' + (label || expression))
    await delay(interval)
  }
}
async function shot(name) {
  const data = await send('Page.captureScreenshot', { format: 'png' })
  const file = join(outDir, name)
  await writeFile(file, Buffer.from(data.data, 'base64'))
  console.log('SHOT ' + file)
  return file
}
async function clickByText(texts, { exact = false } = {}) {
  const list = JSON.stringify(texts)
  const exactFlag = exact ? 'true' : 'false'
  const script = `(() => {
    const wanted = ${list}
    const exact = ${exactFlag}
    function scan(root) {
      for (const node of root.querySelectorAll('button, a, [role="tab"], [role="button"], summary')) {
        const label = ((node.getAttribute('aria-label') || '') + ' ' + (node.textContent || '')).trim()
        for (const w of wanted) {
          if (exact ? label === w : label.includes(w)) {
            node.click()
            return label
          }
        }
      }
      for (const host of root.querySelectorAll('*')) {
        if (host.shadowRoot !== null) {
          const hit = scan(host.shadowRoot)
          if (hit) return hit
        }
      }
      return ''
    }
    return scan(document)
  })()`
  return evaluate(script)
}
async function clickSelector(selector) {
  return evaluate(`(() => { const node = document.querySelector(${JSON.stringify(selector)}); if (node === null) return false; node.click(); return true })()`)
}

/** 关掉 DSH 首屏之类的引导弹层（只点带关闭/取消/跳过语义的按钮）。 */
async function dismissOverlays() {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const clicked = await evaluate(`(() => {
      for (const dialog of document.querySelectorAll('[role="dialog"]')) {
        for (const button of dialog.querySelectorAll('button')) {
          const label = ((button.getAttribute('aria-label') || '') + ' ' + (button.textContent || '')).trim()
          if (/关闭|Close|取消|跳过|稍后/.test(label)) { button.click(); return label }
        }
      }
      return ''
    })()`)
    if (clicked === '') break
    console.log('DISMISS overlay: ' + clicked)
    await delay(500)
  }
}

async function main() {
  let targets = []
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/json/list`)
      targets = await response.json()
      if (Array.isArray(targets) && targets.length > 0) break
    } catch {
      // devtools not up yet
    }
    await delay(200)
  }
  if (!Array.isArray(targets) || targets.length === 0) throw new Error('chrome devtools did not start')
  const list = targets
  const page = list.find((target) => target.type === 'page') ?? list[0]
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
      return
    }
    if (msg.method === 'Runtime.consoleAPICalled') {
      const text = msg.params.args.map((arg) => arg.value ?? arg.description ?? arg.type).join(' ')
      if (msg.params.type === 'error') consoleErrors.push(text)
      else if (msg.params.type === 'warning') consoleWarnings.push(text)
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      consoleErrors.push('exception: ' + JSON.stringify(msg.params.exceptionDetails?.exception?.description ?? msg.params.exceptionDetails?.text))
    }
  })
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true })
    ws.addEventListener('error', reject, { once: true })
  })
  await send('Page.enable')
  await send('Runtime.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 960, deviceScaleFactor: 1, mobile: false })
  await mkdir(outDir, { recursive: true })

  await send('Page.navigate', { url })
  await waitFor(`document.querySelectorAll('button').length > 3`, { label: 'app boot' })
  await delay(1200)

  // 欢迎弹层
  const welcome = await clickByText(['继续', 'Continue', '开始使用'])
  if (welcome !== '') {
    console.log('WELCOME dismissed via: ' + welcome)
    await delay(700)
  }

  await delay(600)
  await dismissOverlays()

  // 左侧「邮箱」入口
  const entry = await waitFor(
    `(() => {
      const buttons = Array.from(document.querySelectorAll('button'))
      const hit = buttons.find((b) => ((b.getAttribute('aria-label') || '') + (b.textContent || '')).includes('邮箱'))
      return hit === undefined ? null : { aria: hit.getAttribute('aria-label'), text: (hit.textContent || '').trim() }
    })()`,
    { label: 'mailbox sidebar entry' },
  )
  console.log('ENTRY=' + JSON.stringify(entry))
  if (process.argv.includes('--skip-member') === false) {
    await shot('00-dsh-shell-with-entry.png')
  }

  // 打开邮箱页面
  const opened = await clickByText(['邮箱', 'Mailbox'])
  console.log('OPEN_ENTRY=' + opened)
  await waitFor(`document.querySelector('.dsh-mailbox-root') !== null`, { label: 'mailbox page' })
  await delay(1500)
  await shot('01-inbox.png')

  // 读真实 API state（只读探测，失败不中断截图流程）
  let stateInfo = ''
  try {
  stateInfo = await evaluate(`(async () => {
    try {
      const res = await fetch('/api/mailbox?action=state', { credentials: 'same-origin', headers: { accept: 'application/json' } })
      const body = await res.json()
      return JSON.stringify({ status: res.status, ok: body.ok, enabled: body.enabled, counts: body.counts, connections: body.connections, sync: body.sync, configIssue: true })
    } catch (error) { return JSON.stringify({ error: String(error) }) }
  })()`)
  } catch (error) { stateInfo = 'PROBE_FAILED: ' + String(error?.message ?? error) }
  console.log('STATE=' + stateInfo)

  // 左栏徽标 DOM
  const badge = await evaluate(`(() => {
    const buttons = Array.from(document.querySelectorAll('button'))
    const row = buttons.find((b) => (b.getAttribute('aria-label') || '').includes('邮箱'))
    if (row === undefined) return 'entry-not-found'
    return JSON.stringify({ aria: row.getAttribute('aria-label'), text: (row.textContent || '').trim(), html: row.innerHTML.slice(0, 400) })
  })()`)
  console.log('ENTRY_DOM=' + badge)

  // 五个页签
  const tabs = [
    ['02-sent.png', ['已发送', 'Sent']],
    ['03-quarantine.png', ['隔离', 'Quarantine']],
    ['04-friends.png', ['好友', 'Friends']],
    ['05-settings.png', ['设置', 'Settings']],
    ['06-diagnostics.png', ['诊断', 'Diagnostics']],
  ]
  for (const [file, labels] of tabs) {
    // 只在邮箱导航里点（避免命中其它区域的同名文字）
    const clicked = await evaluate(`(() => {
      const nav = document.querySelector('.dsh-mailbox-nav')
      if (nav === null) return 'no-nav'
      for (const item of nav.querySelectorAll('button')) {
        const label = ((item.getAttribute('aria-label') || '') + ' ' + (item.textContent || '')).trim()
        for (const w of ${JSON.stringify(labels)}) {
          if (label.includes(w)) { item.click(); return label }
        }
      }
      return ''
    })()`)
    console.log('TAB ' + file + ' -> ' + clicked)
    await delay(1100)
    await shot(file)
  }

  // 回到设置页
  await evaluate(`(() => {
    const nav = document.querySelector('.dsh-mailbox-nav')
    if (nav !== null) for (const item of nav.querySelectorAll('button')) if ((item.textContent || '').includes('设置')) { item.click(); return true }
    return false
  })()`)
  await waitFor(`document.querySelector('.dsh-mailbox-settings-tabs') !== null`, { label: 'settings tabs' })
  await delay(500)
  // 设置页：四个分组 tab 截图（快速开始 / 连接配置 / 通知与好友 / 高级设置）
  const settingsTab = async (label, file) => {
    const clicked = await evaluate(`(() => {
      for (const button of document.querySelectorAll('.dsh-mailbox-settings-tab')) {
        if ((button.textContent || '').includes(${JSON.stringify(label)})) { button.click(); return (button.textContent || '').trim() }
      }
      return ''
    })()`)
    console.log('SETTINGS_TAB ' + label + ' -> ' + clicked)
    await delay(700)
    await shot(file)
  }
  await settingsTab('快速开始', '05a-settings-quickstart.png')
  await settingsTab('连接配置', '05b-settings-connect.png')
  // 展开服务商授权码引导
  await evaluate(`(() => {
    const details = document.querySelectorAll('.dsh-mailbox-auth-guide')
    if (details.length > 0) { details.forEach((item) => { item.open = true }); details[0].scrollIntoView({ block: 'center' }) }
    return details.length
  })()`)
  await delay(500)
  await shot('07-settings-auth-guide.png')
  await settingsTab('通知与好友', '05c-settings-notify.png')
  // 通知测试：按通知目标投递（默认 dedicated），应返回 delivered + sessionId
  const notifyClicked = await evaluate(`(() => {
    const buttons = Array.from(document.querySelectorAll('.dsh-mailbox-view button'))
    const target = buttons.find((button) => (button.textContent || '').includes('通知测试') || (button.textContent || '').includes('Test notification'))
    if (target === undefined) return ''
    target.click()
    return (target.textContent || '').trim()
  })()`)
  console.log('NOTIFY_TEST_CLICK=' + notifyClicked)
  await delay(2500)
  const notifyResult = await evaluate(`(() => {
    const result = document.querySelector('.dsh-mailbox-view .dsh-mailbox-test-result')
    return result === null ? '' : (result.textContent || '').trim()
  })()`)
  console.log('NOTIFY_RESULT=' + notifyResult)
  const sessionsInfo = await evaluate(`(async () => {
    try {
      const res = await fetch('/api/mailbox?action=sessions', { credentials: 'same-origin', headers: { accept: 'application/json' } })
      const body = await res.json()
      return JSON.stringify({ status: res.status, sessions: Array.isArray(body.sessions) ? body.sessions.map((item) => ({ id: item.sessionId, title: item.title })) : body.sessions })
    } catch (error) { return JSON.stringify({ error: String(error) }) }
  })()`)
  console.log('SESSIONS=' + sessionsInfo)
  await shot('05c2-settings-notify-test.png')
  // 左栏是否出现「邮箱通知」会话
  const sidebarSession = await evaluate(`(() => {
    const text = document.body.textContent || ''
    return JSON.stringify({ hasDedicatedSession: text.includes('邮箱通知') })
  })()`)
  console.log('SIDEBAR_DEDICATED=' + sidebarSession)
  await shot('05c3-notify-session-sidebar.png')
  await settingsTab('高级设置', '05d-settings-advanced.png')
  // 高级设置里展开第一个分组
  await evaluate(`(() => { const adv = document.querySelector('.dsh-mailbox-adv'); if (adv !== null) { adv.open = true; adv.scrollIntoView({ block: 'center' }) } return adv !== null })()`)
  await delay(500)
  await shot('07b-settings-advanced-open.png')
  // 回到快速开始，提示条与保存栏同屏
  await settingsTab('快速开始', '07c-settings-quickstart-bottom.png')
  await evaluate(`(() => { const el = document.querySelector('.dsh-mailbox-view-scroll'); if (el !== null) el.scrollTop = el.scrollHeight; return true })()`)
  await delay(400)
  await shot('07d-settings-savebar.png')

  // 写信面板
  const compose = await clickByText(['写信', 'Compose'])
  console.log('COMPOSE=' + compose)
  await waitFor(`document.querySelector('.dsh-mailbox-composer') !== null`, { label: 'composer' })
  await delay(700)
  await shot('08-compose.png')
  // 关闭写信面板（头部关闭按钮；有草稿时会弹放弃确认）
  async function closeComposer() {
    const clicked = await evaluate(`(() => {
      const head = document.querySelector('.dsh-mailbox-composer-head')
      if (head === null) return ''
      const buttons = Array.from(head.querySelectorAll('button'))
      if (buttons.length === 0) return ''
      const target = buttons[buttons.length - 1]
      target.click()
      return (target.getAttribute('aria-label') || target.textContent || '').trim()
    })()`)
    await delay(500)
    if (clicked !== '') await clickByText(['放弃', 'Discard'])
    await delay(400)
  }
  await closeComposer()

  // 写信 + 附件（CDP 直接给 <input type=file> 塞文件，验证 chips 与发送请求装配）
  await clickByText(['写信', 'Compose'])
  await waitFor(`document.querySelector('.dsh-mailbox-composer') !== null`, { label: 'composer again' })
  await delay(400)
  try {
    await send('DOM.enable')
    const doc = await send('DOM.getDocument', { depth: -1 })
    const found = await send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '.dsh-mailbox-composer input[type="file"]' })
    if (found.nodeId !== 0) {
      await send('DOM.setFileInputFiles', { nodeId: found.nodeId, files: ['/tmp/mailbox-attach/demo-report.pdf', '/tmp/mailbox-attach/notes.txt'] })
      await waitFor(`document.querySelectorAll('.dsh-mailbox-attach-chip').length >= 2`, { label: 'attachment chips' })
      const chips = await evaluate(`JSON.stringify(Array.from(document.querySelectorAll('.dsh-mailbox-attach-chip')).map((chip) => (chip.textContent || '').trim()))`)
      console.log('ATTACHMENT_CHIPS=' + chips)
      await delay(500)
      await shot('08b-compose-attachments.png')
    } else {
      console.log('ATTACHMENT_INPUT not found')
    }
  } catch (error) {
    console.log('ATTACHMENT_UPLOAD_FAILED: ' + String(error?.message ?? error))
  }
  // 清空附件（点 chips 的 ×）
  await evaluate(`(() => { const buttons = Array.from(document.querySelectorAll('.dsh-mailbox-attach-remove')); buttons.forEach((button) => button.click()); return buttons.length })()`)
  await delay(300)
  await closeComposer()

  // 回到收件箱，打开第一封邮件（真实数据）
  const goInbox = `(() => {
    const nav = document.querySelector('.dsh-mailbox-nav')
    if (nav !== null) for (const item of nav.querySelectorAll('button')) if ((item.textContent || '').includes('收件箱')) { item.click(); return true }
    return false
  })()`
  await evaluate(goInbox)
  await delay(1000)
  const rowCount = await evaluate(`document.querySelectorAll('.dsh-mailbox-row').length`)
  console.log('ROWS=' + rowCount)
  if (Number(rowCount) > 0) {
    await clickSelector('.dsh-mailbox-row')
    await waitFor(`document.querySelector('.dsh-mailbox-reader iframe') !== null`, { label: 'reader iframe' })
    await delay(900)
    const frameInfo = await evaluate(`(() => {
      const frame = document.querySelector('.dsh-mailbox-reader iframe')
      if (frame === null) return 'no-frame'
      return JSON.stringify({ sandbox: frame.getAttribute('sandbox'), hasSrcdoc: (frame.getAttribute('srcdoc') || '').length > 20, referrerPolicy: frame.getAttribute('referrerpolicy'), title: frame.getAttribute('title') })
    })()`)
    console.log('IFRAME=' + frameInfo)
    const linkInfo = await evaluate(`(() => {
      const links = Array.from(document.querySelectorAll('.dsh-mailbox-links a'))
      return JSON.stringify(links.map((a) => ({ href: a.getAttribute('href'), rel: a.getAttribute('rel'), target: a.getAttribute('target') })))
    })()`)
    console.log('LINKS=' + linkInfo)
    await shot('10-reader.png')
  }
  // 隔离区里的可疑邮件
  await evaluate(`(() => { const nav = document.querySelector('.dsh-mailbox-nav'); if (nav !== null) for (const item of nav.querySelectorAll('button')) if ((item.textContent || '').includes('隔离')) { item.click(); return true } return false })()`)
  await delay(1000)
  const quarantineRows = await evaluate(`document.querySelectorAll('.dsh-mailbox-row').length`)
  console.log('QUARANTINE_ROWS=' + quarantineRows)
  if (Number(quarantineRows) > 0) {
    await clickSelector('.dsh-mailbox-row')
    await delay(900)
    await shot('11-quarantine-reader.png')
  }
  // 暗色：收件箱 + 设置
  await evaluate(goInbox)
  await delay(900)
  await evaluate(`document.body.setAttribute('data-ds-dark-theme', ''); true`)
  await delay(900)
  await shot('12-inbox-dark.png')
  await evaluate(`(() => { const nav = document.querySelector('.dsh-mailbox-nav'); if (nav !== null) for (const item of nav.querySelectorAll('button')) if ((item.textContent || '').includes('设置')) { item.click(); return true } return false })()`)
  await delay(1000)
  await shot('13-settings-dark.png')
  await evaluate(`document.body.removeAttribute('data-ds-dark-theme'); true`)

  // 窄屏：列表与阅读切换
  await send('Emulation.setDeviceMetricsOverride', { width: 420, height: 860, deviceScaleFactor: 1, mobile: true })
  await evaluate(goInbox)
  await delay(900)
  await shot('14-narrow-list.png')
  if (Number(rowCount) > 0) {
    await clickSelector('.dsh-mailbox-row')
    await delay(800)
    await shot('15-narrow-reader.png')
  }

  console.log('CONSOLE_ERRORS=' + JSON.stringify(consoleErrors.slice(0, 30), null, 2))
  console.log('CONSOLE_WARNINGS=' + JSON.stringify(consoleWarnings.slice(0, 10), null, 2))
}

try {
  await main()
} catch (error) {
  console.error('FAILED: ' + String(error?.stack ?? error))
  process.exitCode = 1
} finally {
  try { ws?.close() } catch {}
  chrome.kill('SIGKILL')
}
