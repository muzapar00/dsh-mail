#!/usr/bin/env node
/**
 * dsh-mailbox profile installer.
 *
 * Links this package into a DSH profile, adds it to `dsh.profile.bundles`, and
 * optionally seeds the plugin's data directory from the legacy
 * `dsh-user-contact` configuration. Idempotent and reversible; dry-run by
 * default — nothing is written until `--apply` is passed.
 *
 * Usage:
 *   node scripts/install-profile.mjs --profile ~/.dsh/profiles/web --dry-run
 *   node scripts/install-profile.mjs --profile ~/.dsh/profiles/web --apply
 *   node scripts/install-profile.mjs --profile ~/.dsh/profiles/web --apply \
 *     --seed ./seed.json --data-dir ~/.dsh/mailbox
 *   node scripts/install-profile.mjs --profile ~/.dsh/profiles/web --apply \
 *     --seed-from-legacy ~/.dsh/profiles/web/cordis.patch.yml
 *
 * Safety:
 *  - never edits anything outside the target profile and the plugin data dir;
 *  - backs up package.json before writing;
 *  - refuses to seed over an existing config.json unless --force-seed;
 *  - does not copy authorization codes: seeds reference `authCodeFile` paths;
 *  - prints whether a dsh process currently serves that profile (restart may be
 *    needed when HMR is off).
 */

import { copyFile, mkdir, readFile, readlink, symlink, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';

const HERE = dirname(dirname(new URL(import.meta.url).pathname));
const PLUGIN_PACKAGE = JSON.parse(await readFile(join(HERE, 'package.json'), 'utf8'));
const PLUGIN_NAME = 'dsh-mailbox';
const LEGACY_NAME = 'dsh-user-contact';

/** Parse `--key value` / `--flag` arguments. */
function parseArgs(argv) {
  const out = { apply: false, forceSeed: false, keepLegacy: false, seed: '', seedFromLegacy: '', dataDir: '', profile: '' };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const take = () => {
      index += 1;
      const value = argv[index];
      if (value === undefined || value.startsWith('--')) throw new Error(`missing value for ${arg}`);
      return value;
    };
    switch (arg) {
      case '--apply':
        out.apply = true;
        break;
      case '--dry-run':
        out.apply = false;
        break;
      case '--force-seed':
        out.forceSeed = true;
        break;
      case '--keep-legacy':
        out.keepLegacy = true;
        break;
      case '--profile':
        out.profile = take();
        break;
      case '--seed':
        out.seed = take();
        break;
      case '--seed-from-legacy':
        out.seedFromLegacy = take();
        break;
      case '--data-dir':
        out.dataDir = take();
        break;
      case '--help':
      case '-h':
        out.help = true;
        break;
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }
  return out;
}

/** Expand a leading `~` and resolve against cwd. */
function expandPath(value) {
  if (value === '') return '';
  const expanded = value.startsWith('~/') ? join(homedir(), value.slice(2)) : value;
  return resolve(expanded);
}

/** Print one dry-run/apply line. */
function line(tag, text) {
  console.log(`${tag.padEnd(8)} ${text}`);
}

/** Is a dsh process currently using this profile? Best-effort /proc scan. */
async function findServingProcess(profileName) {
  if (process.platform !== 'linux') return '';
  try {
    const { readdir } = await import('node:fs/promises');
    const entries = await readdir('/proc');
    for (const entry of entries) {
      if (!/^\d+$/.test(entry)) continue;
      try {
        const cmdline = await readFile(`/proc/${entry}/cmdline`, 'utf8');
        const args = cmdline.split('\0');
        if (!args.some((arg) => arg === 'dsh')) continue;
        if (args.some((arg) => arg === 'w' || arg === 'web') || args.includes('--profile')) {
          const profileArg = args.includes('--profile') ? args[args.indexOf('--profile') + 1] : 'web';
          if (profileArg === profileName) return entry;
        }
      } catch {
        // Process vanished; ignore.
      }
    }
  } catch {
    // /proc unavailable; nothing to report.
  }
  return '';
}

/** Minimal parser for the legacy `user-contact-email` block in a cordis patch. */
function parseLegacyPatch(text) {
  const lines = text.split('\n');
  const start = lines.findIndex((candidate) => /^\s*-\s*id:\s*user-contact-email\s*$/.test(candidate));
  if (start === -1) return null;
  const values = {};
  for (let index = start + 1; index < lines.length; index += 1) {
    const line_ = lines[index];
    if (/^\s*-\s*id:/.test(line_) && index !== start) break;
    const match = /^\s{4,}([A-Za-z][A-Za-z0-9]*):\s*(.*)$/.exec(line_);
    if (match === null) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (value === 'true') value = true;
    else if (value === 'false') value = false;
    else if (/^\d+$/.test(value)) value = Number(value);
    values[match[1]] = value;
  }
  return values;
}

/** Derive a matching IMAP host from the SMTP host (best effort). */
function guessImapHost(smtpHost) {
  if (typeof smtpHost !== 'string' || smtpHost === '') return '';
  return smtpHost.replace(/^smtp\./i, 'imap.');
}

/** Build a seed config document from legacy values (no secrets). */
function seedFromLegacyValues(legacy) {
  const sender = typeof legacy.sender === 'string' ? legacy.sender : '';
  const recipient = typeof legacy.recipient === 'string' ? legacy.recipient : '';
  const smtpHost = typeof legacy.smtpHost === 'string' ? legacy.smtpHost : '';
  const authCodeFile = typeof legacy.authCodeFile === 'string' ? legacy.authCodeFile : '';
  return {
    mailbox: {
      address: sender,
      displayName: legacy.fromName ?? '费加罗',
      signature: legacy.signature ?? '费加罗',
      salutation: legacy.salutation ?? '',
      greeting: legacy.greeting ?? '',
      subjectPrefix: legacy.subjectPrefix ?? '[DeepSeek Harness] ',
      letterhead: false,
      avatarFile: '',
    },
    owner: { address: recipient, name: '' },
    smtp: {
      preset: 'custom',
      host: smtpHost,
      port: typeof legacy.smtpPort === 'number' ? legacy.smtpPort : 465,
      security: 'tls',
      user: sender,
      authCode: '',
      authCodeFile,
      allowStrangerRecipients: false,
    },
    imap: {
      enabled: true,
      preset: 'custom',
      host: guessImapHost(smtpHost),
      port: 993,
      security: 'tls',
      user: sender,
      authCode: '',
      authCodeFile,
      mailbox: 'INBOX',
      pollIntervalSeconds: 120,
      markSeen: true,
      fetchLimit: 20,
    },
    friends: { policy: 'auto', defaultAutoReply: false },
    notify: { enabled: true, target: 'latest', strangerMail: 'notify', batchSeconds: 30, maxPreviewChars: 200 },
    prompt: { language: 'zh', extraNote: '', includeFriendListInSystemPrompt: true, maxFriendListInPrompt: 30 },
    security: { allowRemoteImages: false, maxSendsPerHour: 20, maxFriendAddsPerDay: 3, maxMessageBytes: 5242880, quarantineSuspicious: true, maxMessagesRetained: 500 },
    ui: { locale: 'zh' },
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.profile === '') {
    console.log(`Usage: node scripts/install-profile.mjs --profile <profile-dir> [--apply] [options]

Options:
  --profile <dir>            target DSH profile directory (e.g. ~/.dsh/profiles/web)
  --apply                    write changes (default: dry-run)
  --data-dir <dir>           plugin data directory (default: <DSH_HOME>/mailbox)
  --seed <file>              JSON seed config written when config.json is absent
  --seed-from-legacy <file>  derive the seed from a legacy cordis.patch.yml
  --force-seed               overwrite an existing config.json
  --keep-legacy              keep the legacy dsh-user-contact bundle enabled

Exit codes: 0 ok, 1 usage/precondition error, 2 missing profile.`);
    process.exit(args.profile === '' && !args.help ? 1 : 0);
  }

  const profileDir = expandPath(args.profile);
  if (!existsSync(join(profileDir, 'package.json'))) {
    console.error(`error: profile package.json not found under ${profileDir}`);
    process.exit(2);
  }
  const manifestPath = join(profileDir, 'package.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const profileName = profileDir.split('/').pop();
  const dshHome = args.dataDir !== '' ? dirname(expandPath(args.dataDir)) : dirname(dirname(profileDir));
  const dataDir = args.dataDir !== '' ? expandPath(args.dataDir) : join(dshHome, 'mailbox');

  const bundles = Array.isArray(manifest.dsh?.profile?.bundles) ? [...manifest.dsh.profile.bundles] : [];
  const dependencies = { ...(manifest.dependencies ?? {}) };
  const hasMailboxBundle = bundles.includes(PLUGIN_NAME);
  const legacyIndex = bundles.indexOf(LEGACY_NAME);
  const plan = [];
  if (!hasMailboxBundle) plan.push(`enable ${PLUGIN_NAME}`);
  if (legacyIndex >= 0 && !args.keepLegacy) plan.push(`remove legacy ${LEGACY_NAME}`);

  line('profile', profileDir);
  line('dataDir', dataDir);
  line('package', `${PLUGIN_NAME}@${PLUGIN_PACKAGE.version}`);
  line('bundles', plan.length === 0 ? 'already installed — nothing to change' : plan.join('; '));

  // node_modules link plan
  const nodeModules = join(profileDir, 'node_modules');
  const linkPath = join(nodeModules, PLUGIN_NAME);
  let linkState = 'create symlink';
  if (existsSync(linkPath)) {
    const info = await stat(linkPath);
    if (info.isSymbolicLink()) {
      const target = resolve(dirname(linkPath), await readlink(linkPath));
      linkState = target === HERE ? `already linked to ${HERE}` : `replace symlink (was ${target})`;
    } else {
      linkState = 'WARNING: a real directory already exists; leave it untouched';
    }
  }
  line('node_modules', linkState);

  const configPath = join(dataDir, 'config.json');
  let seed = null;
  if (args.seed !== '') {
    seed = JSON.parse(await readFile(expandPath(args.seed), 'utf8'));
    line('seed', `from ${expandPath(args.seed)}`);
  } else if (args.seedFromLegacy !== '') {
    const legacy = parseLegacyPatch(await readFile(expandPath(args.seedFromLegacy), 'utf8'));
    if (legacy === null) {
      console.error(`error: no user-contact-email block found in ${args.seedFromLegacy}`);
      process.exit(1);
    }
    seed = seedFromLegacyValues(legacy);
    line('seed', `from legacy patch (${LEGACY_NAME})`);
  }
  if (seed !== null) {
    line('seed-file', existsSync(configPath)
      ? (args.forceSeed ? `${configPath} will be overwritten (--force-seed)` : `${configPath} exists; seed skipped (use --force-seed)`)
      : `${configPath} will be created`);
  }

  const serving = await findServingProcess(profileName);
  if (serving !== '') {
    line('warning', `dsh process ${serving} currently serves profile "${profileName}"; HMR may pick the change up, otherwise restart it`);
  }

  if (!args.apply) {
    line('done', 'dry-run only (pass --apply to write)');
    return;
  }

  // ---------------------------------------------------------------- apply
  // Replace the legacy entry in place (keeps bundle ordering), then de-duplicate.

  await mkdir(nodeModules, { recursive: true });
  if (existsSync(linkPath)) {
    const info = await stat(linkPath);
    if (info.isSymbolicLink()) {
      const target = resolve(dirname(linkPath), await readlink(linkPath));
      if (target !== HERE) {
        const { unlink } = await import('node:fs/promises');
        await unlink(linkPath);
        await symlink(HERE, linkPath, 'dir');
        line('linked', `${linkPath} -> ${HERE}`);
      } else {
        line('linked', `${linkPath} already points at ${HERE}`);
      }
    } else {
      line('warning', `${linkPath} is a real directory; left untouched`);
    }
  } else {
    await symlink(HERE, linkPath, 'dir');
    line('linked', `${linkPath} -> ${HERE}`);
  }

  if (seed !== null) {
    if (!existsSync(configPath) || args.forceSeed) {
      // Merge the seed over plugin defaults; the plugin re-validates on boot.
      const { defaultConfig, deepMerge } = await import('../lib/config.js');
      const merged = deepMerge(defaultConfig(), seed);
      await mkdir(dataDir, { recursive: true, mode: 0o700 });
      await writeFile(configPath, `${JSON.stringify(merged, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      line('seeded', `${configPath} (0600)`);
    } else {
      line('seed', `${configPath} exists; skipped`);
    }
  }

  // Manifest last: the profile watcher validates the new bundle immediately, so
  // the node_modules link and the data-directory seed must already be in place.
  let nextBundles = bundles.map((name) => (name === LEGACY_NAME && !args.keepLegacy ? PLUGIN_NAME : name));
  nextBundles = [...new Set(nextBundles)];
  if (!nextBundles.includes(PLUGIN_NAME)) nextBundles.push(PLUGIN_NAME);
  dependencies[PLUGIN_NAME] = `link:${HERE}`;
  manifest.dependencies = dependencies;
  manifest.dsh = { ...(manifest.dsh ?? {}), profile: { ...(manifest.dsh?.profile ?? {}), bundles: nextBundles } };
  const backupPath = `${manifestPath}.bak-${new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15)}`;
  await copyFile(manifestPath, backupPath);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  line('wrote', `${manifestPath} (backup: ${backupPath})`);

  line('done', `installed into profile "${profileName}". If dsh-hmr is enabled the plugin hot-loads; otherwise restart dsh. Open the "邮箱" entry in the DSH sidebar afterwards.`);
}

main().catch((error) => {
  console.error(`install failed: ${error.message}`);
  process.exit(1);
});
