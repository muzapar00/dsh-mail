import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEventLog } from '../../lib/events.js';

/** Read every JSONL row written under `<dir>/logs`. */
async function readRows(dir) {
  const files = await readdir(join(dir, 'logs'));
  const dayFiles = files.filter((name) => /^events-\d{8}\.jsonl$/.test(name)).sort();
  assert.ok(dayFiles.length > 0, 'expected at least one day file');
  const text = await readFile(join(dir, 'logs', dayFiles[dayFiles.length - 1]), 'utf8');
  return text.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

async function tempDir() {
  return mkdtemp(join(tmpdir(), 'dsh-events-'));
}

test('records keep a whitelisted shape, scrub detail and use UTC ISO8601 ts', async () => {
  const dir = await tempDir();
  const log = createEventLog(dir);
  log.info('send', '[dsh-mailbox] sent to nuc@muzapar.cn path=/home/user/secret.txt id=deadbeef1234', {
    sessionId: 's-1',
    count: 2,
    body: 'SECRET TEXT',
    attachmentName: 'private.pdf',
  });
  await log.flush();
  await log.close();
  const rows = await readRows(dir);
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.event, 'send');
  assert.equal(row.level, 'info');
  assert.match(row.ts, /Z$/);
  assert.ok(!row.detail.includes('nuc@muzapar.cn'));
  assert.ok(!row.detail.includes('/home/user/secret.txt'));
  assert.ok(!row.detail.includes('deadbeef1234'));
  assert.ok(row.detail.includes('<email>'));
  assert.ok(row.detail.includes('<path>'));
  assert.ok(row.detail.includes('<id>'));
  assert.equal(row.data.sessionId, 's-1');
  assert.equal(row.data.count, 2);
  assert.ok(!('body' in row.data));
  assert.ok(!('attachmentName' in row.data));
  const raw = JSON.stringify(rows);
  assert.ok(!raw.includes('SECRET TEXT'));
  assert.ok(!raw.includes('private.pdf'));
});

test('cap drops routine lines first and keeps warn within a bounded overflow', async () => {
  const dir = await tempDir();
  const log = createEventLog(dir, { maxFileBytes: 400 });
  for (let index = 0; index < 10; index += 1) log.info('poll', 'x'.repeat(60));
  log.warn('disk', `low space ${'y'.repeat(60)}`);
  await log.flush();
  await log.close();
  const rows = await readRows(dir);
  assert.ok(rows.some((row) => row.level === 'warn'));
});

test('repeated important lines collapse into a first line plus one summary with the count', async () => {
  const dir = await tempDir();
  const log = createEventLog(dir, { dedupeWindowMs: 60000 });
  for (let index = 0; index < 5; index += 1) log.warn('imap', 'connection refused');
  await log.flush();
  await log.close();
  const rows = await readRows(dir);
  const important = rows.filter((row) => row.level === 'warn');
  assert.equal(important.length, 2);
  assert.equal(important[1].data.count, 5);
  assert.equal(typeof important[1].data.since, 'string');
  assert.equal(typeof important[1].data.until, 'string');
});

test('a failed write is counted and recovered on the next successful append', async () => {
  const dir = await tempDir();
  const blocked = join(dir, 'logs');
  await writeFile(blocked, 'not a directory');
  const log = createEventLog(dir);
  log.info('sync', 'fails while logs is a file');
  await log.flush();
  assert.ok(log.stats().dropped >= 1);
  assert.ok(log.lastError().length > 0);
  await rm(blocked);
  log.info('sync', 'works now');
  await log.flush();
  await log.close();
  const rows = await readRows(dir);
  const recovered = rows.find((row) => row.event === 'log-recovered');
  assert.ok(recovered !== undefined);
  assert.ok(recovered.data.dropped >= 1);
  assert.equal(typeof recovered.data.since, 'string');
});

test('same-day restart seeds the cap accounting with the existing file size', async () => {
  const dir = await tempDir();
  await mkdir(join(dir, 'logs'), { recursive: true });
  const stamp = new Date().toISOString().slice(0, 10).replaceAll('-', '');
  const dayFile = join(dir, 'logs', `events-${stamp}.jsonl`);
  await writeFile(dayFile, 'x'.repeat(290), 'utf8');
  const log = createEventLog(dir, { maxFileBytes: 300 });
  log.info('poll', 'a line that would exceed the cap if the prefix were ignored');
  await log.flush();
  assert.ok(log.stats().dropped >= 1, 'expected the write to be dropped because the cap is already nearly used');
  const size = (await readFile(dayFile)).length;
  assert.equal(size, 290);
});

test('expired day files are pruned at startup', async () => {
  const dir = await tempDir();
  await mkdir(join(dir, 'logs'), { recursive: true });
  await writeFile(join(dir, 'logs', 'events-20200101.jsonl'), '{"old":true}\n', 'utf8');
  const log = createEventLog(dir);
  await log.flush(500);
  await log.close();
  const left = await readdir(join(dir, 'logs'));
  assert.ok(!left.includes('events-20200101.jsonl'));
});

test('flush and close never wait longer than their timeout', async () => {
  const dir = await tempDir();
  const log = createEventLog(dir);
  for (let index = 0; index < 30; index += 1) log.info('burst', `line ${index}`);
  const started = Date.now();
  await log.close(1);
  assert.ok(Date.now() - started < 2000);
});
