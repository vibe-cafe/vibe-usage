import { accessSync, constants, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { loadCachedQuota, saveCachedQuota } from './cache.js';
import { cursorQuotaNetworkURLs, fetchCursorQuota } from './providers/cursor.js';
import { antigravityDesktopPaths, antigravityInstallPaths, fetchAntigravityQuota } from './providers/antigravity.js';
import { fetchGrokQuota } from './providers/grok.js';
import { fetchKimiCodeQuota, kimiCodeNetworkURLs } from './providers/kimi-code.js';
import { fetchOpenCodeGoQuota, openCodeGoNetworkURLs } from './providers/opencode-go.js';
import { fetchZaiQuota, zaiNetworkURLs } from './providers/zai.js';
import { FETCHABLE_QUOTA_PRODUCT_IDS, quotaEnvelope, quotaResult } from './schema.js';
import { envProxyBlockFor } from '../env-proxy.js';
import { egressPauseFor } from '../egress-check.js';

// Providers whose own request carries the user's vendor credential. When the
// environment names a proxy this process cannot follow, they are not run
// (network-privacy principle). Grok reads a local log; Antigravity talks to a
// local language server and the official program makes its own requests.
// The URLs each read requests, resolved by the provider itself: a URL on the
// user's bypass list is the user's own direct rule, so it is not blocked; a
// read that requests nothing (no key) is not blocked either.
const VENDOR_NETWORK_URLS = {
  'kimi-code': kimiCodeNetworkURLs,
  zcode: zaiNetworkURLs,
  'opencode-go': openCodeGoNetworkURLs,
  cursor: cursorQuotaNetworkURLs,
};

const providers = new Map([
  ['kimi-code', fetchKimiCodeQuota],
  ['zcode', fetchZaiQuota],
  ['grok', fetchGrokQuota],
  ['opencode-go', fetchOpenCodeGoQuota],
  ['cursor', fetchCursorQuota],
  ['antigravity', fetchAntigravityQuota],
]);

function executableExists(name, environment, platform) {
  const pathDelimiter = platform === 'win32' ? ';' : delimiter;
  const candidateNames = [name];
  if (platform === 'win32') {
    const extensions = (environment.PATHEXT || '.COM;.EXE;.BAT;.CMD')
      .split(';')
      .map(value => value.trim())
      .filter(Boolean)
      .map(value => value.startsWith('.') ? value : `.${value}`);
    for (const extension of extensions) {
      candidateNames.push(`${name}${extension}`, `${name}${extension.toLowerCase()}`);
    }
  }

  return (environment.PATH || '').split(pathDelimiter).filter(Boolean).some(directory => (
    candidateNames.some(candidate => {
      const path = join(directory, candidate);
      try {
        // Windows does not expose POSIX execute bits; file presence plus a
        // PATHEXT executable suffix is its ordinary command-discovery rule.
        accessSync(path, platform === 'win32' ? constants.F_OK : constants.X_OK);
        return true;
      } catch {
        return false;
      }
    })
  ));
}

export function discoverQuotaProducts({
  environment = process.env,
  home = homedir(),
  platform = process.platform,
} = {}) {
  const applications = platform === 'darwin'
    ? ['/Applications', join(home, 'Applications')] : [];
  const existsAny = paths => paths.some(path => existsSync(path));
  const configuredGrokHome = environment.GROK_HOME?.trim();
  const grokHome = configuredGrokHome
    ? configuredGrokHome.replace(/^~(?=$|[\\/])/, home)
    : join(home, '.grok');
  return quotaEnvelope([
    {
      id: 'kimi-code',
      detected: existsAny([join(home, '.kimi'), join(home, '.kimi-code')])
        || executableExists('kimi', environment, platform),
      fetchable: true,
    },
    {
      id: 'zcode',
      detected: existsAny([join(home, '.zcode'), join(home, '.config', 'zcode'),
        ...applications.map(path => join(path, 'ZCode.app'))])
        || executableExists('zcode', environment, platform),
      fetchable: true,
    },
    {
      id: 'grok',
      detected: existsAny([grokHome]) || executableExists('grok', environment, platform),
      fetchable: true,
    },
    {
      id: 'opencode-go',
      detected: existsAny([join(home, '.local', 'share', 'opencode')])
        || executableExists('opencode', environment, platform),
      fetchable: true,
    },
    {
      id: 'cursor',
      detected: existsAny([join(home, '.cursor'),
        ...applications.map(path => join(path, 'Cursor.app'))])
        || executableExists('cursor', environment, platform),
      fetchable: true,
    },
    {
      id: 'antigravity',
      detected: existsAny([join(home, '.gemini', 'antigravity-cli'),
        join(home, '.gemini', 'antigravity'), ...antigravityInstallPaths(environment, home, platform),
        ...antigravityDesktopPaths(environment, home, platform),
        ...applications.map(path => join(path, 'Antigravity.app'))])
        || executableExists('agy', environment, platform)
        || !!environment.ANTIGRAVITY_CLI_PATH && existsSync(environment.ANTIGRAVITY_CLI_PATH),
      fetchable: true,
    },
  ]);
}

export async function fetchQuotaProducts(ids, options = {}) {
  const unique = [...new Set(ids)];
  const invalid = unique.filter(id => !FETCHABLE_QUOTA_PRODUCT_IDS.includes(id));
  if (invalid.length) throw new Error(`Unsupported quota product: ${invalid.join(', ')}`);

  const environment = options.environment || process.env;
  const fetched = await Promise.all(unique.map(async id => {
    const urls = VENDOR_NETWORK_URLS[id]?.({ ...options, environment });
    const block = !urls?.length ? null
      : options.envProxyBlock !== undefined ? options.envProxyBlock
      : envProxyBlockFor(urls, { env: environment });
    if (block) {
      // Not a failure: nothing was sent. `unsupported` keeps the desktop apps
      // from offering a retry and the cache from answering in its place.
      return quotaResult({ id, status: 'unsupported', message: block.message });
    }
    // A vendor that pauses when the egress is wrong, read direct: check the
    // egress first (`egress-check.js`). Paused is not a failure either.
    const paused = await (options.egressPause || egressPauseFor)(id, { environment, now: options.now || new Date() });
    if (paused) {
      return quotaResult({
        id, status: 'unsupported', message: paused.message,
        pauseReason: paused.pauseReason, egressRegion: paused.region,
      });
    }
    try {
      return await providers.get(id)(options);
    } catch {
      return quotaResult({ id, status: 'retryable_error', message: 'Provider failed unexpectedly' });
    }
  }));
  const results = fetched.map(result => {
    if (result.status === 'ok') {
      saveCachedQuota(result, result.cacheScope, options.environment);
      return result;
    }
    if (result.status === 'retryable_error') {
      return loadCachedQuota(
        result.id,
        result.cacheScope,
        options.environment,
        options.now || new Date()
      ) || result;
    }
    return result;
  });
  return quotaEnvelope(results);
}
