#!/usr/bin/env node
/**
 * Lead 的真实 GUI 验收探针：用 Chrome headless + CDP 打开一个 DSH Web 实例，
 * 检查 dsh-mailbox 入口是否出现、点击后页面是否渲染、宿主 API 是否可达，并截图。
 *
 * 用法：
 *   node probes/lead/ui-check.mjs <tokenized-url> --out /tmp/shots
 *
 * 说明：URL 里带启动 token，脚本只把它用于浏览器导航，不打印到 stdout。
 */
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const url = process.argv[2];
if (url === undefined) {
  console.error('usage: node probes/lead/ui-check.mjs <tokenized-url> [--out dir] [--port 9224]');
  process.exit(2);
}
const outArg = process.argv.indexOf('--out');
const outDir = outArg > 0 ? process.argv[outArg + 1] : '/tmp/dsh-mailbox-shots';
const portArg = process.argv.indexOf('--port');
const PORT = portArg > 0 ? Number(process.argv[portArg + 1]) : 9224;
const CHROME = process.env.CHROME_BIN ?? '/usr/bin/google-chrome';
const profileDir = `/tmp/dsh-mailbox-chrome-${PORT}`;

const chrome = spawn(CHROME, [
  '--headless=new',
  '--disable-gpu',
  '--no-sandbox',
  '--no-first-run',
  '--disable-dev-shm-usage',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profileDir}`,
  '--window-size=1440,900',
  'about:blank',
], { stdio: 'ignore' });

let ws;
let nextId = 1;
const pending = new Map();
const consoleErrors = [];
function send(method, params = {}) {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}
async function waitFor(fn, { timeout = 60000, interval = 300, label = 'condition' } = {}) {
  const started = Date.now();
  for (;;) {
    try {
      const value = await fn();
      if (value !== undefined && value !== null && value !== false) return value;
    } catch {
      // keep polling
    }
    if (Date.now() - started > timeout) throw new Error(`timeout waiting for ${label}`);
    await delay(interval);
  }
}
async function evaluate(expression) {
  const res = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (res?.exceptionDetails !== undefined) return { error: res.exceptionDetails.text };
  return res?.result?.value;
}
async function shot(name) {
  await delay(500);
  const data = await send('Page.captureScreenshot', { format: 'png' });
  await mkdir(outDir, { recursive: true });
  const file = join(outDir, name);
  await writeFile(file, Buffer.from(data.data, 'base64'));
  console.log('SHOT=' + file);
  return file;
}

async function main() {
  await waitFor(async () => {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      return list.length > 0 ? list : undefined;
    } catch {
      return undefined;
    }
  }, { label: 'devtools', timeout: 30000 });
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = list.find((t) => t.type === 'page') ?? list[0];
  ws = new WebSocket(page.webSocketDebuggerUrl);
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(String(event.data));
    if (msg.id !== undefined) {
      const slot = pending.get(msg.id);
      if (slot !== undefined) {
        pending.delete(msg.id);
        if (msg.error !== undefined) slot.reject(new Error(JSON.stringify(msg.error)));
        else slot.resolve(msg.result);
      }
      return;
    }
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      consoleErrors.push(msg.params.args.map((a) => a.value ?? a.description ?? a.type).join(' ').slice(0, 300));
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      consoleErrors.push('exception: ' + String(msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text).slice(0, 300));
    }
  });
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

  await send('Page.navigate', { url });
  console.log('NAVIGATED');

  // 等 Web 壳渲染出主界面（出现带 aria-label/text 的按钮）
  await waitFor(async () => {
    const count = await evaluate(`document.querySelectorAll('button').length`);
    return typeof count === 'number' && count > 5 ? true : undefined;
  }, { label: 'web shell', timeout: 90000 });
  await delay(1200);

  // 收集左栏入口
  const rows = await evaluate(`JSON.stringify(Array.from(document.querySelectorAll('button'))
    .map((b) => ({ text: (b.textContent || '').trim().slice(0, 40), aria: b.getAttribute('aria-label') || '', title: b.getAttribute('title') || '' }))
    .filter((r) => r.text !== '' || r.aria !== '' || r.title !== '')
    .slice(0, 80))`);
  console.log('BUTTONS=' + String(rows).slice(0, 4000));

  const hasEntry = await evaluate(`(${(() => {
    const wanted = ['邮箱', 'Mailbox', 'mailbox'];
    const match = (root) => {
      for (const button of root.querySelectorAll('button, a, [role="button"]')) {
        const label = ((button.getAttribute('aria-label') || '') + ' ' + (button.textContent || '') + ' ' + (button.getAttribute('title') || '')).trim();
        if (wanted.some((w) => label.toLowerCase().includes(w.toLowerCase()))) return true;
      }
      for (const host of root.querySelectorAll('*')) {
        if (host.shadowRoot !== null && match(host.shadowRoot)) return true;
      }
      return false;
    };
    return JSON.stringify({ hasEntry: match(document) });
  }).toString()})()`);
  console.log('ENTRY=' + String(hasEntry));
  await shot('before-click.png');

  const clicked = await evaluate(`(${(() => {
    const wanted = ['邮箱', 'Mailbox'];
    function scan(root) {
      for (const button of root.querySelectorAll('button, a, [role="button"]')) {
        const label = ((button.getAttribute('aria-label') || '') + ' ' + (button.textContent || '') + ' ' + (button.getAttribute('title') || '')).trim();
        if (wanted.some((w) => label.toLowerCase().includes(w.toLowerCase()))) { button.click(); return { clicked: true, label }; }
      }
      for (const host of root.querySelectorAll('*')) {
        if (host.shadowRoot !== null) { const hit = scan(host.shadowRoot); if (hit.clicked) return hit; }
      }
      return { clicked: false };
    }
    return JSON.stringify(scan(document));
  }).toString()})()`);
  console.log('CLICK=' + String(clicked));

  // 页面出现面包屑/标题「邮箱」或收件箱等文案
  const pageState = await waitFor(async () => {
    const text = await evaluate(`(document.body.innerText || '').slice(0, 6000)`);
    if (typeof text !== 'string') return undefined;
    const marks = ['收件箱', 'Inbox', '好友', '设置', '写邮件', '写信', 'Compose', '邮箱'];
    const found = marks.filter((mark) => text.includes(mark));
    return found.length >= 2 ? { found, text: text.slice(0, 1500) } : undefined;
  }, { label: 'mailbox page', timeout: 30000 }).catch(() => undefined);
  console.log('PAGE=' + JSON.stringify(pageState ?? 'not-rendered'));
  await shot('mailbox-light.png');
  await evaluate(`document.body.setAttribute('data-ds-dark-theme',''); window.dispatchEvent(new Event('resize')); true`);
  await shot('mailbox-dark.png');

  // 宿主 API（同源 fetch，自动带 cookie）
  const api = await evaluate(`fetch('/api/mailbox?action=state').then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) })).catch((e) => ({ error: String(e) }))`);
  const summary = api && typeof api === 'object' && api.body !== null ? {
    status: api.status,
    ok: api.body.ok,
    enabled: api.body.enabled,
    counts: api.body.counts,
    registeredTools: api.body.registeredTools,
    promptSection: api.body.promptSection,
    apiRoute: api.body.apiRoute,
    configured: api.body.connections,
    hasSecretText: JSON.stringify(api.body).includes('authCode\\"') ? 'suspicious-raw-key' : 'masked',
  } : api;
  console.log('API=' + JSON.stringify(summary, null, 2));

  // Click-through verification of the main tabs and the composer attachment UI.
  async function clickText(wanted, selector = 'button, a, [role="button"]') {
    return evaluate(`(${(() => null).toString(), `(function(){
      var wanted = ${'${JSON.stringify(wanted)}'};
      function scan(root) {
        for (const el of root.querySelectorAll(${JSON.stringify(selector)})) {
          const label = ((el.getAttribute('aria-label') || '') + ' ' + (el.textContent || '') + ' ' + (el.getAttribute('title') || '')).trim();
          if (wanted.some((w) => label.toLowerCase().includes(w.toLowerCase()))) { el.click(); return true; }
        }
        for (const host of root.querySelectorAll('*')) {
          if (host.shadowRoot !== null && scan(host.shadowRoot)) return true;
        }
        return false;
      }
      return scan(document);
    })()`})`);
  }
  async function collectButtons() {
    return evaluate(`JSON.stringify(Array.from(document.querySelectorAll('button, a, [role="button"]')).map(function (b) {
      return ((b.getAttribute('aria-label') || '') + '|' + (b.textContent || '').trim() + '|' + (b.getAttribute('title') || '')).slice(0, 120);
    }).filter(function (x) { return x.replace(/[|]/g, '') !== ''; }).slice(0, 120))`);
  }
  for (const [name, labels] of [['compose', ['写信', '写邮件', 'Compose']], ['friends', ['好友', 'Friends']], ['settings', ['设置', 'Settings']], ['diagnostics', ['诊断', 'Diagnostics']]]) {
    const hit = await clickText(labels);
    await delay(900);
    console.log('TAB_' + name.toUpperCase() + '=' + hit);
    if (hit) {
      await shot('tab-' + name + '.png');
      if (name === 'compose') {
        const composerButtons = await collectButtons();
        console.log('COMPOSE_BUTTONS=' + String(composerButtons).slice(0, 3000));
        const addHit = await clickText(['添加附件', 'Attach', '附件']);
        console.log('ATTACH_BUTTON=' + addHit);
      }
    }
  }
  const probe = await evaluate(`JSON.stringify({
    mailboxProbe: globalThis.__DSH_MAILBOX_UI__ ?? null,
    pluginRows: (globalThis.__DSH_BOOT__?.plugins ?? []).filter((row) => String(row.id).includes('mailbox')),
  })`);
  console.log('PLUGIN=' + String(probe).slice(0, 1200));
  console.log('CONSOLE_ERRORS=' + JSON.stringify(consoleErrors.slice(0, 20), null, 2));
}

try {
  await main();
} catch (error) {
  console.error('FAILED: ' + String(error?.stack ?? error));
  process.exitCode = 1;
} finally {
  try {
    ws?.close();
  } catch {}
  chrome.kill('SIGKILL');
}
