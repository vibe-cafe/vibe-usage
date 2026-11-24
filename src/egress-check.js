// Egress check before a vendor-account read that goes out direct
// (network-privacy principle, rule 3, workspace AGENTS.md; maintenance plan
// 「代理与地区风险-修复方案」§3.4, decided by the maintainer 2026-11-24).
//
// When the environment names a proxy for the vendor's hosts, the request goes
// through it (`env-proxy.js`) and nothing here runs. When it goes out direct —
// no proxy at all, a host on the user's bypass list, or a proxy this machine
// cannot see (TUN, a proxy on the router) — the CLI first asks a Cloudflare
// edge on the same route which country it sees: an anonymous
// `GET https://<host>/cdn-cgi/trace` with no cookie, token or account header,
// of which only the two-letter `loc=` is read. A country the vendor does not
// serve, or no answer, pauses the read: nothing carrying the account is sent.
//
// Only the vendors the maintainer named pause (OpenAI, Anthropic, xAI,
// Google). Of those the CLI reads Antigravity (Google, through `agy` or the
// desktop language server, which make the request with their own login);
// Grok reads a local log today and joins when it starts asking the official
// program (#189). Google's hosts have no trace page, so a host of another
// paused vendor on the same route stands in for them (`SUBSTITUTE_TRACE_HOSTS`).
//
// Settings, passed by the desktop apps or set by a terminal user:
//   VIBE_USAGE_EGRESS_CHECK=0   no check: a direct read is sent as before.
//   VIBE_USAGE_REQUIRE_PROXY=1  this machine reaches the internet through a
//                               local proxy client: a direct read always
//                               pauses, and no check is sent.

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import https from 'node:https';
import { homedir, networkInterfaces } from 'node:os';
import { dirname, join } from 'node:path';
import { chosenProxies } from './env-proxy.js';

/** Regions the paused vendors do not serve and our users may be in. */
export const UNSUPPORTED_EGRESS_REGIONS = Object.freeze(['CN', 'HK', 'MO']);

/**
 * Stand-ins for hosts without a trace page, in order of preference. Only one
 * whose own route is also direct is used: a host the user sends through a
 * proxy is never sent direct just to be checked (rule 1).
 */
export const SUBSTITUTE_TRACE_HOSTS = Object.freeze(['chatgpt.com', 'api.anthropic.com']);

/** Products the CLI gates, with the hosts their account requests reach. */
export const EGRESS_GATED_PRODUCTS = Object.freeze({
  antigravity: Object.freeze({
    urls: ['https://daily-cloudcode-pa.googleapis.com/', 'https://generativelanguage.googleapis.com/'],
    traceHosts: [],
  }),
});

export const EGRESS_PAUSE_REASONS = Object.freeze([
  'egressRegionUnsupported',
  'egressUnconfirmed',
  'proxyNotDetected',
]);

const SUPPORTED_TTL_MS = 10 * 60 * 1000;
const PAUSED_TTL_MS = 60 * 1000;
const TRACE_TIMEOUT_MS = 5000;
const TRACE_MAX_BYTES = 4096;
const CACHE_VERSION = 1;

const OFF = new Set(['0', 'false', 'off', 'no']);
const ON = new Set(['1', 'true', 'on', 'yes']);

function flag(environment, name) {
  return String(environment[name] ?? '').trim().toLowerCase();
}

export function egressCheckEnabled(environment = process.env) {
  return !OFF.has(flag(environment, 'VIBE_USAGE_EGRESS_CHECK'));
}

export function proxyRequired(environment = process.env) {
  return ON.has(flag(environment, 'VIBE_USAGE_REQUIRE_PROXY'));
}

/**
 * A bypass list (`NO_PROXY`) read broadly, as any runtime might: `*`, an
 * exact host, or a domain and its subdomains (with or without a leading `.`
 * / `*.`); ports are ignored. `agy` (Go) reads a bare `googleapis.com` as its
 * subdomains too, while `env-proxy.js` reads it narrowly for our own
 * requests. For this check, reading a host as direct costs one check and
 * reading it as proxied would skip one.
 */
export function bypassedBroadly(url, environment = process.env) {
  let host;
  try {
    host = new URL(String(url).includes('://') ? url : `https://${url}`).hostname.toLowerCase().replace(/^\[|\]$/g, '');
  } catch {
    return false;
  }
  const list = ['no_proxy', 'NO_PROXY'].map(name => String(environment[name] ?? '').trim()).find(Boolean) || '';
  return list.split(/[,\s]+/).filter(Boolean).some(raw => {
    let entry = raw.toLowerCase();
    if (entry === '*') return true;
    if (!entry.startsWith('[')) entry = entry.replace(/:\d+$/, '');
    entry = entry.replace(/^\*?\./, '');
    return Boolean(entry) && (host === entry || host.endsWith(`.${entry}`));
  });
}

/**
 * `proxy` when a request to `url` would go through the environment's proxy,
 * `direct` otherwise (no proxy variable, or the URL on the bypass list as
 * any runtime might read it).
 */
export function routeFor(url, environment = process.env) {
  return chosenProxies(environment).https && !bypassedBroadly(url, environment) ? 'proxy' : 'direct';
}

/** The two-letter country in a trace body, or null (unknown, Tor, absent). */
export function traceRegion(body) {
  const match = /^loc=([A-Za-z0-9]{2})\s*$/m.exec(String(body || ''));
  const region = match?.[1].toUpperCase();
  return region && /^[A-Z]{2}$/.test(region) && region !== 'XX' ? region : null;
}

/**
 * The machine's network addresses, hashed: switching networks or turning a
 * TUN adapter on or off changes it, and with it every cached answer.
 * Loopback and IPv6 link-local addresses are left out (macOS's AirDrop
 * interfaces come and go with link-local addresses only), as in the apps.
 */
export function networkFingerprint(interfaces = networkInterfaces()) {
  const entries = [];
  for (const [name, addresses] of Object.entries(interfaces || {})) {
    for (const address of addresses || []) {
      if (address.internal || /^fe[89ab]/i.test(address.address)) continue;
      entries.push(`${name}|${address.family}|${address.address}`);
    }
  }
  return createHash('sha256').update(entries.sort().join('\n')).digest('hex').slice(0, 16);
}

/**
 * One anonymous trace request, direct: its own agent, so neither the
 * runtime's environment proxy nor our tunnel (`proxy-tunnel.js`, installed on
 * the global agents) takes it. No cookie, no credential, no redirect.
 * Resolves the country or null.
 */
export function fetchTraceRegion(host, { timeoutMs = TRACE_TIMEOUT_MS, httpsModule = https } = {}) {
  return new Promise(resolve => {
    let settled = false;
    const done = value => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const agent = new httpsModule.Agent({ keepAlive: false });
    let request;
    const timer = setTimeout(() => {
      request?.destroy();
      done(null);
    }, timeoutMs);
    try {
      request = httpsModule.request({
        host, port: 443, path: '/cdn-cgi/trace', method: 'GET', agent,
        headers: { accept: 'text/plain' },
      }, response => {
        if (response.statusCode !== 200) {
          // No country here: stop reading at once.
          request.destroy();
          done(null);
          return;
        }
        let body = '';
        response.setEncoding('utf8');
        response.on('data', chunk => {
          body += chunk;
          if (body.length > TRACE_MAX_BYTES) {
            request.destroy();
            done(traceRegion(body.slice(0, TRACE_MAX_BYTES)));
          }
        });
        response.on('end', () => done(traceRegion(body)));
        response.on('error', () => done(null));
      });
      request.on('error', () => done(null));
      request.end();
    } catch {
      done(null);
    }
  });
}

function cachePath(environment) {
  const root = environment.VIBE_USAGE_QUOTA_CACHE_DIR?.trim() || join(homedir(), '.vibe-usage');
  return join(root, 'egress-checks.json');
}

function loadCache(environment) {
  try {
    const parsed = JSON.parse(readFileSync(cachePath(environment), 'utf8'));
    if (parsed?.version !== CACHE_VERSION || !parsed.entries || typeof parsed.entries !== 'object') return {};
    return parsed.entries;
  } catch {
    return {};
  }
}

function saveCache(environment, entries) {
  try {
    const path = cachePath(environment);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify({ version: CACHE_VERSION, entries }), { mode: 0o600 });
    renameSync(temporary, path);
  } catch {
    // A cache that cannot be written only costs another check next time.
  }
}

/**
 * The country seen through `host`, direct, from the cache when it is still
 * valid for this network, else asked now and remembered: a supported answer
 * for 10 minutes, anything that pauses for 1 minute, so a proxy turned back
 * on is picked up by the next read.
 */
async function regionThrough(host, { environment, now, fingerprint, trace }) {
  const entries = loadCache(environment);
  const cached = entries[host];
  const at = now.getTime();
  if (cached && cached.network === fingerprint && typeof cached.checkedAt === 'number') {
    const region = typeof cached.region === 'string' ? cached.region : null;
    const ttl = region && !UNSUPPORTED_EGRESS_REGIONS.includes(region) ? SUPPORTED_TTL_MS : PAUSED_TTL_MS;
    if (at >= cached.checkedAt && at - cached.checkedAt < ttl) return region;
  }
  const region = await trace(host);
  entries[host] = { region, checkedAt: at, network: fingerprint };
  for (const [key, entry] of Object.entries(entries)) {
    if (!entry || typeof entry.checkedAt !== 'number' || at - entry.checkedAt > SUPPORTED_TTL_MS) delete entries[key];
  }
  saveCache(environment, entries);
  return region;
}

const MESSAGES = {
  egressRegionUnsupported: region => `Paused: the network egress is in ${region}, a region this vendor does not serve; nothing carrying the account was sent.`,
  egressUnconfirmed: () => 'Paused: the network egress could not be confirmed; nothing carrying the account was sent.',
  proxyNotDetected: () => 'Paused: no proxy detected and this machine is set to rely on a local proxy; nothing carrying the account was sent.',
};

function pause(pauseReason, region) {
  return { pauseReason, region, message: MESSAGES[pauseReason](region) };
}

/**
 * Whether a read of `productId` must pause now: null when it may go ahead
 * (a gated product whose every host goes through a proxy, a supported egress,
 * the check switched off, or a product that is not gated), else
 * `{ pauseReason, region?, message }`.
 */
export async function egressPauseFor(productId, {
  environment = process.env,
  now = new Date(),
  fingerprint = networkFingerprint,
  trace = fetchTraceRegion,
} = {}) {
  const product = EGRESS_GATED_PRODUCTS[productId];
  if (!product) return null;
  if (product.urls.every(url => routeFor(url, environment) === 'proxy')) return null;
  if (proxyRequired(environment)) return pause('proxyNotDetected');
  if (!egressCheckEnabled(environment)) return null;
  const candidates = [...product.traceHosts, ...SUBSTITUTE_TRACE_HOSTS];
  const host = candidates.find(candidate => routeFor(`https://${candidate}/`, environment) === 'direct');
  if (!host) return pause('egressUnconfirmed');
  const region = await regionThrough(host, {
    environment, now, fingerprint: typeof fingerprint === 'function' ? fingerprint() : fingerprint, trace,
  });
  if (!region) return pause('egressUnconfirmed');
  return UNSUPPORTED_EGRESS_REGIONS.includes(region) ? pause('egressRegionUnsupported', region) : null;
}
