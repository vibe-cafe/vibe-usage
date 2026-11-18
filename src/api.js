import https from 'node:https';
import http from 'node:http';
import { URL } from 'node:url';
import { gzipSync } from 'node:zlib';

const MAX_RETRIES = 3;
const INITIAL_DELAY = 1000;
// Always gzip: ingest bodies are repetitive JSON that compresses ~10:1, and
// the few-byte gzip header overhead on a tiny body is irrelevant next to
// guaranteeing no uncompressed request ever leaves the client.
const GZIP_MIN_BYTES = 0;

export function retryDelayMs(attempt, random = Math.random) {
  const ceiling = INITIAL_DELAY * 2 ** attempt;
  // Equal jitter keeps a real backoff floor while preventing every desktop
  // client from retrying a shared outage on the same 1s / 2s boundaries.
  return Math.round(ceiling / 2 + random() * ceiling / 2);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function ingest(apiUrl, apiKey, buckets, opts, sessions) {
  let lastError;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      return await _send(apiUrl, apiKey, buckets, opts, sessions);
    } catch (err) {
      lastError = err;
      // Don't retry auth errors or client errors
      if (err.message === 'UNAUTHORIZED' || err.statusCode >= 400 && err.statusCode < 500) {
        throw err;
      }
      if (attempt < MAX_RETRIES - 1) {
        await sleep(retryDelayMs(attempt));
      }
    }
  }
  throw lastError;
}

export function encodeIngestBody(buckets, opts, sessions) {
  const payload = { buckets };
  if (sessions && sessions.length > 0) payload.sessions = sessions;
  if (opts?.client) payload.client = opts.client;
  const raw = Buffer.from(JSON.stringify(payload));
  const useGzip = raw.length >= GZIP_MIN_BYTES;
  return {
    body: useGzip ? gzipSync(raw) : raw,
    useGzip,
  };
}

function _send(apiUrl, apiKey, buckets, opts, sessions) {
  return new Promise((resolve, reject) => {
    const url = new URL('/api/usage/ingest', apiUrl);
    const { body, useGzip } = encodeIngestBody(buckets, opts, sessions);
    const totalBytes = body.length;
    const mod = url.protocol === 'https:' ? https : http;

    const headers = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      'Content-Length': totalBytes,
    };
    if (useGzip) headers['Content-Encoding'] = 'gzip';

    const req = mod.request(url, {
      method: 'POST',
      timeout: 60_000,
      headers,
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode === 401) {
          reject(new Error('UNAUTHORIZED'));
          return;
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const err = new Error(`HTTP ${res.statusCode}: ${data}`);
          err.statusCode = res.statusCode;
          reject(err);
          return;
        }
        try {
          resolve(JSON.parse(data));
        } catch {
          reject(new Error(`Invalid JSON response: ${data}`));
        }
      });
    });

    req.on('error', (err) => reject(err));
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timed out (60s)'));
    });

    // Write body in chunks to report upload progress
    const CHUNK = 16 * 1024;
    let sent = 0;

    function writeNext() {
      let ok = true;
      while (ok && sent < totalBytes) {
        const slice = body.subarray(sent, sent + CHUNK);
        sent += slice.length;
        if (opts?.onProgress) opts.onProgress(sent, totalBytes);
        ok = req.write(slice);
      }
      if (sent < totalBytes) {
        req.once('drain', writeNext);
      } else {
        req.end();
      }
    }

    writeNext();
  });
}

/**
 * DELETE usage data for the authenticated user.
 * @param {string} apiUrl
 * @param {string} apiKey
 * @param {{hostname?: string}} [opts]
 * @returns {Promise<{deleted: number}>}
 */
export function deleteAllData(apiUrl, apiKey, opts) {
  return new Promise((resolve, reject) => {
    const url = new URL('/api/usage/ingest', apiUrl);
    if (opts?.hostname) url.searchParams.set('hostname', opts.hostname);
    const mod = url.protocol === 'https:' ? https : http;

    const req = mod.request(url, {
      method: 'DELETE',
      timeout: 60_000,
      headers: {
        'Authorization': `Bearer ${apiKey}`,
      },
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode === 401) {
          reject(new Error('UNAUTHORIZED'));
          return;
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const err = new Error(`HTTP ${res.statusCode}: ${data}`);
          err.statusCode = res.statusCode;
          reject(err);
          return;
        }
        try {
          resolve(JSON.parse(data));
        } catch {
          reject(new Error(`Invalid JSON response: ${data}`));
        }
      });
    });

    req.on('error', (err) => reject(err));
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timed out (60s)'));
    });

    req.end();
  });
}

/**
 * Start a device authorization flow.
 * Returns the deviceCode (for polling) + userCode + URLs (for the user).
 */
export function requestDeviceCode(apiUrl, { clientName, hostname }) {
  return _jsonRequest(apiUrl, '/api/usage/device/code', 'POST', { clientName, hostname }, 10_000);
}

/**
 * One poll iteration. Resolves with one of:
 *   { apiKey, apiUrl }                 — approved, key delivered
 *   { error: 'authorization_pending' } — keep polling
 *   { error: 'access_denied' }         — user pressed deny
 *   { error: 'expired_token' }         — code expired or already consumed
 *   { error: 'invalid_grant' | ... }   — unrecoverable
 * Rejects only on network/server errors.
 */
export function pollDeviceCode(apiUrl, deviceCode) {
  return _jsonRequest(apiUrl, '/api/usage/device/poll', 'POST', { deviceCode }, 15_000);
}

/**
 * Register this machine's Codex Ultrafast cut (see codex-ultrafast.js). The
 * server keeps the first registration and answers with the cut in force, so a
 * repeated or concurrent call is harmless. One attempt, no retry: a failure
 * only means this sync uploads the merged format once more.
 * @returns {Promise<{startAt: string, created: boolean}>}
 */
export function registerCodexUltrafastStart(apiUrl, apiKey, { hostname, proposedStartAt, client }) {
  return _jsonRequest(
    apiUrl, '/api/usage/codex-ultrafast-start', 'POST', { hostname, proposedStartAt, client }, 15_000,
    { Authorization: `Bearer ${apiKey}` },
  );
}

function _jsonRequest(apiUrl, path, method, body, timeoutMs, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, apiUrl);
    const mod = url.protocol === 'https:' ? https : http;
    const raw = Buffer.from(JSON.stringify(body));

    const req = mod.request(url, {
      method,
      timeout: timeoutMs,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': raw.length,
        ...headers,
      },
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const err = new Error(`HTTP ${res.statusCode}: ${data}`);
          err.statusCode = res.statusCode;
          reject(err);
          return;
        }
        try {
          resolve(JSON.parse(data));
        } catch {
          reject(new Error(`Invalid JSON response: ${data}`));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error(`Request timed out (${timeoutMs}ms)`)); });
    req.write(raw);
    req.end();
  });
}

/**
 * Authenticated GET returning parsed JSON. Shared by summary and settings so
 * callers don't hand-roll their own https request + error mapping.
 * - 401 → Error('UNAUTHORIZED') with statusCode 401
 * - other non-2xx / timeout / bad JSON → Error with statusCode
 * @param {string} apiUrl
 * @param {string} apiKey
 * @param {string} path
 * @param {{timeoutMs?: number}} [opts]
 * @returns {Promise<any>}
 */
export function getJson(apiUrl, apiKey, path, { timeoutMs = 15_000 } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, apiUrl);
    const mod = url.protocol === 'https:' ? https : http;

    const req = mod.request(url, {
      method: 'GET',
      timeout: timeoutMs,
      headers: { 'Authorization': `Bearer ${apiKey}` },
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode === 401) {
          const err = new Error('UNAUTHORIZED');
          err.statusCode = 401;
          reject(err);
          return;
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const err = new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`);
          err.statusCode = res.statusCode;
          reject(err);
          return;
        }
        try {
          resolve(JSON.parse(data));
        } catch {
          reject(new Error('Invalid JSON response'));
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error(`Request timed out (${timeoutMs}ms)`)); });
    req.end();
  });
}

/**
 * Which vibecafe account this API key is bound to.
 *
 * Exists because a key minted against the wrong account is otherwise invisible
 * from the client side: ingest and this endpoint both answer 200 for it, so the
 * user sees a healthy CLI and a healthy desktop app while their uploads pile up
 * on an account they never look at. Ask the backend whose data it is and say so.
 *
 * Returns null when the backend is too old to send `account`, or on any
 * transient failure — identity is a nicety, never a reason to fail a command.
 * UNAUTHORIZED still propagates: that one the caller must not swallow.
 *
 * @param {string} apiUrl
 * @param {string} apiKey
 * @returns {Promise<{handle: string, name: string | null} | null>}
 */
export async function fetchAccount(apiUrl, apiKey) {
  let data;
  try {
    // bucketsOnly keeps the response to the aggregate we throw away; days=1
    // keeps the window (and the scan) small.
    data = await getJson(apiUrl, apiKey, '/api/usage?days=1&bucketsOnly=true', { timeoutMs: 10_000 });
  } catch (err) {
    if (err.message === 'UNAUTHORIZED') throw err;
    return null;
  }
  const account = data?.account;
  if (account && typeof account.handle === 'string') {
    return { handle: account.handle, name: account.name ?? null };
  }
  return null;
}

/**
 * GET user settings from the vibecafe API.
 * Returns null after transient failures are exhausted. A 401 remains distinct
 * so callers can surface invalid credentials instead of calling it an outage.
 * @param {string} apiUrl
 * @param {string} apiKey
 * @returns {Promise<{uploadProject: boolean} | null>}
 */
export async function fetchSettings(apiUrl, apiKey, retry = {}) {
  const wait = retry.sleep ?? sleep;
  const random = retry.random ?? Math.random;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      return await fetchSettingsOnce(apiUrl, apiKey, retry.hostname);
    } catch (err) {
      if (err.message === 'UNAUTHORIZED') throw err;
      // Retrying a permanent client response cannot make it valid. 429 is the
      // exception: it is transient load shedding and benefits from backoff.
      if (err.statusCode >= 400 && err.statusCode < 500 && err.statusCode !== 429) {
        return null;
      }
      if (attempt < MAX_RETRIES - 1) {
        await wait(retryDelayMs(attempt, random));
      }
    }
  }
  return null;
}

// Naming the upload hostname makes the server add that machine's Codex
// Ultrafast cut (`codexUltrafast: { startAt }`) to the same response, so the
// cut costs no extra request per sync. Servers that predate it ignore the
// parameter.
async function fetchSettingsOnce(apiUrl, apiKey, hostname) {
  const path = hostname
    ? `/api/usage/settings?hostname=${encodeURIComponent(hostname)}`
    : '/api/usage/settings';
  const settings = await getJson(apiUrl, apiKey, path, { timeoutMs: 10_000 });
  if (typeof settings?.uploadProject !== 'boolean') {
    throw new Error('Invalid settings response');
  }
  return settings;
}
