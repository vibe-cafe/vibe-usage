// Opening the device-login page in a browser.
//
// The link is `verificationUriComplete` from the server's reply to
// /api/usage/device/code, so it is untrusted input: a self-hosted server the
// user mistyped, a plain-http reply altered on the way, or an old domain that
// changed hands could put anything there. Before anything reaches a launcher
// it must parse as an http(s) URL on an origin the device flow can legitimately
// hand out, and only the parsed, re-serialized form is passed on. A link that
// fails is printed for the user to copy, never opened.

import { execFile } from 'node:child_process';
import { platform as osPlatform } from 'node:os';

// The verification origins the server may be configured to return besides the
// origin the request reached: DEVICE_ORIGINS in vibe-cafe
// apps/web/src/lib/device-origins.ts. Keep the two lists the same.
export const DEVICE_VERIFICATION_ORIGINS = Object.freeze(['https://vibefriends.com', 'https://vibecafe.ai']);

// Characters cmd.exe reads as plain text. Everything it treats as syntax
// (& | < > ^ % ! " ( ) , ; and whitespace) is outside, except `&`, which a
// query string may carry and is escaped as `^&` below. The real link
// (`<origin>/usage/device?code=ABCD-EFGH`) needs nothing beyond this set.
const CMD_SAFE_URL = /^[A-Za-z0-9\-._~:/?#[\]@=+&]+$/;

/** The login link, parsed and re-serialized, or null when it must not be opened. */
export function trustedLoginUrl(raw, apiUrl) {
  // The URL parser silently drops tabs/newlines and trims spaces and control
  // characters; refuse such input instead of opening something it rewrote.
  if (typeof raw !== 'string' || /[\s\u0000-\u001f\u007f-\u009f]/.test(raw)) return null;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (url.username || url.password) return null;
  const allowed = new Set(DEVICE_VERIFICATION_ORIGINS);
  try {
    allowed.add(new URL(apiUrl).origin);
  } catch {
    // An unparsable server URL adds nothing; the device request failed anyway.
  }
  return allowed.has(url.origin) ? url.href : null;
}

/**
 * How to open an already trusted URL on this platform, or null.
 * Windows goes through cmd because `start` is a cmd builtin, not an
 * executable: execFile('start', …) fails outright, which once left the device
 * login with no browser at all. So cmd only ever receives a URL made of
 * characters it reads as text.
 */
export function browserCommand(url, os = osPlatform()) {
  if (os === 'win32') {
    if (!CMD_SAFE_URL.test(url)) return null;
    return { file: 'cmd', args: ['/c', 'start', '', url.replace(/&/g, '^&')], options: { windowsHide: true } };
  }
  // execFile with an argument array: no shell sees the URL.
  return { file: os === 'darwin' ? 'open' : 'xdg-open', args: [url], options: {} };
}

/**
 * What init shows and runs for the login link.
 * `url` is the trusted link (null when untrusted), `command` the launcher to
 * run (null when the browser must not be opened automatically).
 */
export function planLoginPage(raw, apiUrl, os = osPlatform()) {
  const url = trustedLoginUrl(raw, apiUrl);
  return { url, command: url ? browserCommand(url, os) : null };
}

/** Untrusted text from the reply (a rejected link, the user code) without
 * control characters, so it cannot carry terminal escape sequences. */
export function printableText(raw) {
  return String(raw ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/g, '');
}

export function runBrowserCommand(command, run = execFile) {
  run(command.file, command.args, command.options, () => {});
}
