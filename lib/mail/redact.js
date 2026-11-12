/**
 * Secret redaction helpers (SPEC §0 T3): authorization codes / passwords must
 * never appear in error messages, logs, HTTP responses or diagnostics.
 *
 * Email protocol errors are usually built from server replies and command
 * echoes, so the safest approach is a final scrub at the boundary: every
 * `SmtpError` / `ImapError` message produced by this package is passed through
 * `redactSecrets()` with the credentials of the current connection.
 *
 * @module dsh-mailbox/lib/mail/redact
 */

const REDACTED = '[REDACTED]';

/**
 * Replace every occurrence of the given secrets (and their common encodings:
 * base64, percent-encoding, JSON-escaped) in a string.
 *
 * @param {unknown} text - text to scrub.
 * @param {Array<string|undefined|null>} secrets - raw secret values.
 * @returns {string}
 */
export function redactSecrets(text, secrets = []) {
  let out = String(text ?? '');
  const variants = new Set();
  for (const secret of secrets) {
    if (typeof secret !== 'string' || secret === '') continue;
    variants.add(secret);
    try {
      variants.add(Buffer.from(secret, 'utf8').toString('base64'));
    } catch {
      // ignore
    }
    try {
      variants.add(encodeURIComponent(secret));
    } catch {
      // ignore
    }
    variants.add(JSON.stringify(secret).slice(1, -1));
  }
  if (variants.size === 0) return out;
  const ordered = [...variants].filter((value) => value !== '').sort((a, b) => b.length - a.length);
  for (const variant of ordered) {
    if (out.includes(variant)) out = out.split(variant).join(REDACTED);
  }
  return out;
}

/**
 * Redact secrets from an Error instance in place (message, stack, and common
 * structured fields such as `response` / `command`), then return it.
 *
 * @template {Error} T
 * @param {T} error
 * @param {Array<string|undefined|null>} secrets
 * @returns {T}
 */
export function redactError(error, secrets = []) {
  if (!(error instanceof Error)) return error;
  if (typeof error.message === 'string') error.message = redactSecrets(error.message, secrets);
  if (typeof error.stack === 'string') error.stack = redactSecrets(error.stack, secrets);
  for (const field of ['response', 'command', 'text', 'detail']) {
    if (typeof error[field] === 'string') error[field] = redactSecrets(error[field], secrets);
  }
  return error;
}

export { REDACTED };
export default { redactSecrets, redactError, REDACTED };
