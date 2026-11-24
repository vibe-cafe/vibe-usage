// The VibeCafé site moved from vibecafe.ai to vibefriends.com on 2026-11-24.
// vibecafe.ai still forwards /api/* to the new host, but that hop proved
// unreliable (requests hanging or 502), so the CLI talks to the new host
// directly. Both names front the same server: upload state and cached settings
// recorded against the old name stay valid, which keeps every machine from
// re-uploading its whole history when the URL changes.
export const DEFAULT_API_URL = 'https://vibefriends.com';

const LEGACY_API_URLS = new Set(['https://vibecafe.ai', 'https://www.vibecafe.ai']);

function trimUrl(url) {
  return String(url).trim().replace(/\/+$/, '').toLowerCase();
}

export function isLegacyApiUrl(url) {
  return typeof url === 'string' && LEGACY_API_URLS.has(trimUrl(url));
}

/** Where requests go: the old production name maps to the new one; any other
 * configured server (local dev, a self-hosted backend) is used as written. */
export function currentApiUrl(url) {
  if (!url) return DEFAULT_API_URL;
  return isLegacyApiUrl(url) ? DEFAULT_API_URL : url;
}

/** A server reached over plain http on another machine: the API key and the
 * usage data cross the network unencrypted. Loopback (local development) is
 * exempt. */
export function isPlaintextRemoteApiUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return parsed.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
}

/** Compare two recorded server URLs, treating the old and new production names
 * as one server. */
export function sameApiServer(a, b) {
  const canonical = url => {
    if (isLegacyApiUrl(url)) return DEFAULT_API_URL;
    if (typeof url === 'string' && trimUrl(url) === DEFAULT_API_URL) return DEFAULT_API_URL;
    return String(url ?? '');
  };
  return canonical(a) === canonical(b);
}

/** Rewrite the old production URL in a loaded config. A configured install
 * without an explicit apiUrl gets the new one written down too: the desktop
 * apps read config.json for the dashboard and fall back to their own built-in
 * default (still the old name in shipped builds). Returns whether anything
 * changed. Custom servers are left alone. */
export function migrateConfigApiUrl(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return false;
  let changed = false;
  if (isLegacyApiUrl(config.apiUrl)) {
    config.apiUrl = DEFAULT_API_URL;
    changed = true;
  } else if (!config.apiUrl && config.apiKey) {
    config.apiUrl = DEFAULT_API_URL;
    changed = true;
  }
  if (isLegacyApiUrl(config.lastUploadProjectApiUrl)) {
    config.lastUploadProjectApiUrl = DEFAULT_API_URL;
    changed = true;
  }
  return changed;
}
