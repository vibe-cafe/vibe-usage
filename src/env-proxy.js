// Follow the proxy the environment names, or do not send requests that carry
// a vendor account (network-privacy principle, rules 1 and 2, workspace
// AGENTS.md).
//
// The CLI has no proxy code of its own: Node's built-in fetch and https follow
// HTTP_PROXY / HTTPS_PROXY / NO_PROXY only when told to. Measured 2026-11-24 with
// a local stand-in proxy that never connects out:
//   - Node 22.19 ignores NODE_USE_ENV_PROXY entirely and connects directly.
//   - Node 24.22.3 (the Mac app's bundled runtime) honours an http:// proxy for
//     both fetch and https, with NODE_USE_ENV_PROXY=1 or after
//     http.setGlobalProxyFromEnv(); a socks5:// value makes https connect
//     directly without an error (fetch does go through SOCKS); a value without
//     a scheme makes setGlobalProxyFromEnv throw and requests go direct.
//   - `http.setGlobalProxyFromEnv()` exists from Node 24.14 / 25.4; the startup
//     switch (NODE_USE_ENV_PROXY=1 or --use-env-proxy) covers fetch and https
//     from 22.21 / 24.5 (Node docs, Built-in Proxy Support).
//   - Bun 1.3.14 honours http:// for fetch and https on its own and rejects
//     socks5:// with an error, so nothing leaks there.
// A terminal user who exports HTTPS_PROXY without NODE_USE_ENV_PROXY therefore
// got direct connections. `setupEnvProxy()` runs once at start: it turns the
// environment's proxy on for this process where the runtime can do that, and
// otherwise records why it cannot, so callers holding a vendor credential can
// refuse to send (`envProxyBlock()`). Requests without a vendor account (our
// server, npm) are not blocked here; they follow the proxy whenever it is on.
//
// Loopback is always bypassed where this module configures the runtime: the
// Antigravity quota and parser talk to a language server on 127.0.0.1, which
// must never be sent to a proxy.

import http from 'node:http';

const PROXY_VARIABLES = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy'];
const LOOPBACK = ['localhost', '127.0.0.1', '::1', '[::1]'];

let current = { state: 'none' };

/** Non-empty proxy variables, in the order Node and Claude Code read them. */
export function proxyVariables(env = process.env) {
  return PROXY_VARIABLES
    .filter(name => typeof env[name] === 'string' && env[name].trim() !== '')
    .map(name => ({ name, value: env[name].trim() }));
}

function first(env, names) {
  for (const name of names) {
    const value = typeof env[name] === 'string' ? env[name].trim() : '';
    if (value) return { name, value };
  }
  return null;
}

/**
 * The proxy for each scheme, read as curl reads the variables: the scheme's
 * own variable (lowercase first), then ALL_PROXY. For https an HTTP_PROXY
 * alone is the last resort, as Node's fetch already uses it.
 */
export function chosenProxies(env = process.env) {
  return {
    https: first(env, ['https_proxy', 'HTTPS_PROXY', 'all_proxy', 'ALL_PROXY', 'http_proxy', 'HTTP_PROXY']),
    http: first(env, ['http_proxy', 'HTTP_PROXY', 'all_proxy', 'ALL_PROXY']),
  };
}

function isSocks(value) {
  return /^socks[0-9a-z]*:\/\//i.test(value);
}

function withScheme(value) {
  return value.includes('://') ? value : `http://${value}`;
}

/** `--use-env-proxy` or NODE_USE_ENV_PROXY=1, the startup switches Node reads. */
function envProxyFlagOn(env, execArgv) {
  return env.NODE_USE_ENV_PROXY === '1'
    || execArgv.includes('--use-env-proxy')
    || /(^|\s)--use-env-proxy(\s|$)/.test(env.NODE_OPTIONS || '');
}

/**
 * Node releases whose startup switch covers both fetch and https:
 * 22.21+ in the 22 line, 24.5+, and anything newer.
 */
export function nodeHonoursEnvProxyFlag(version) {
  const [major, minor] = String(version || '').split('.').map(Number);
  if (!Number.isFinite(major) || !Number.isFinite(minor)) return false;
  if (major >= 25) return true;
  if (major === 24) return minor >= 5;
  if (major === 22) return minor >= 21;
  return false;
}

/**
 * Both bypass spellings merged with loopback (`[::1]` too: Node's fetch
 * matches the bracketed host). `*` in either means bypass everything.
 */
export function mergedNoProxy(env = process.env) {
  const entries = [];
  for (const name of ['no_proxy', 'NO_PROXY']) {
    for (const entry of (env[name] || '').split(/[,\s]+/).filter(Boolean)) {
      if (!entries.includes(entry)) entries.push(entry);
    }
  }
  if (entries.includes('*')) return '*';
  return [...entries, ...LOOPBACK.filter(host => !entries.includes(host))].join(',');
}

/**
 * Decide, once per process, whether this process follows the environment's
 * proxy. Returns and remembers `{ state }`:
 *   - `none`: no proxy variable set (nothing to follow);
 *   - `active`: requests go through the proxy;
 *   - `socks`: a SOCKS proxy, which Node's https cannot follow;
 *   - `unsupported`: a proxy is set but this runtime cannot be made to follow it.
 * The environment itself is never changed (children such as `agy` see what
 * the user or the app set). Where the runtime can be configured at run time
 * (`http.setGlobalProxyFromEnv`, Node 24.14+ / 25.4+), it gets the chosen
 * proxies directly, a value without a scheme read as `http://`. Where only
 * the startup switch exists, Node already decided from the environment as it
 * was, so only an `HTTPS_PROXY` / `HTTP_PROXY` that was there with a scheme
 * counts; anything this function would have had to add (ALL_PROXY, a
 * missing scheme) means the proxy is not followed.
 */
export function setupEnvProxy({
  env = process.env,
  versions = process.versions,
  execArgv = process.execArgv,
  httpModule = http,
} = {}) {
  const { https, http: plain } = chosenProxies(env);
  if (!https && !plain) {
    current = { state: 'none' };
    return current;
  }
  if ([https, plain].some(choice => choice && isSocks(choice.value))) {
    current = { state: 'socks' };
    return current;
  }
  // Bun and the startup switch read only these variables, as they were.
  const readAtStartup = proxyVariables(env).every(({ value }) => value.includes('://'))
    && Boolean(first(env, PROXY_VARIABLES))
    && [https, plain].every(choice => !choice || PROXY_VARIABLES.includes(choice.name));
  if (versions.bun) {
    current = { state: readAtStartup ? 'active' : 'unsupported' };
    return current;
  }
  if (typeof httpModule.setGlobalProxyFromEnv === 'function') {
    try {
      httpModule.setGlobalProxyFromEnv({
        HTTPS_PROXY: https ? withScheme(https.value) : undefined,
        HTTP_PROXY: plain ? withScheme(plain.value) : undefined,
        NO_PROXY: mergedNoProxy(env),
      });
      current = { state: 'active' };
    } catch {
      current = { state: 'unsupported' };
    }
    return current;
  }
  current = {
    state: readAtStartup && envProxyFlagOn(env, execArgv) && nodeHonoursEnvProxyFlag(versions.node)
      ? 'active'
      : 'unsupported',
  };
  return current;
}

const BLOCK_MESSAGES = {
  socks: 'The configured proxy is SOCKS, which this runtime cannot follow; not sent, to avoid a direct connection.',
  unsupported: 'A proxy is configured but this runtime does not follow it (set NODE_USE_ENV_PROXY=1 on Node.js 22.21+ / 24.5+, or use Node.js 24.14+); not sent, to avoid a direct connection.',
};

const BLOCK_NOTICES = {
  socks: '设置的代理是 SOCKS，当前运行环境无法照着走，为避免直连已跳过',
  unsupported: '设置了代理，但当前 Node.js 没有照着走（Node.js 22.21 / 24.5 以上请设置 NODE_USE_ENV_PROXY=1，或改用 24.14 以上），为避免直连已跳过',
};

/**
 * Why a request carrying a vendor account must not be sent right now, or
 * null when it may. `message` is English free text for the quota contract;
 * `notice` is the Chinese clause for terminal and log output.
 */
export function envProxyBlock(state = current.state) {
  if (state !== 'socks' && state !== 'unsupported') return null;
  return { reason: state, message: BLOCK_MESSAGES[state], notice: BLOCK_NOTICES[state] };
}

/** Test hook: forget the decision made by the last `setupEnvProxy()`. */
export function resetEnvProxyForTests() {
  current = { state: 'none' };
}
