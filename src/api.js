import https from 'node:https';
import http from 'node:http';
import { URL } from 'node:url';
import { gzipSync } from 'node:zlib';

const MAX_RETRIES = 3;
const INITIAL_DELAY = 1000;
const GZIP_MIN_BYTES = 1024;

export async function ingest(apiUrl, apiKey, buckets, opts, sessions) {
  let lastError;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      return await _send(apiUrl, apiKey, buckets, opts?.onProgress, sessions);
    } catch (err) {
      lastError = err;
      // Don't retry auth errors or client errors
      if (err.message === 'UNAUTHORIZED' || err.statusCode >= 400 && err.statusCode < 500) {
        throw err;
      }
      if (attempt < MAX_RETRIES - 1) {
        const delay = INITIAL_DELAY * 2 ** attempt;
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  throw lastError;
}

function _send(apiUrl, apiKey, buckets, onProgress, sessions) {
  return new Promise((resolve, reject) => {
    const url = new URL('/api/usage/ingest', apiUrl);
    const payload = { buckets };
    if (sessions && sessions.length > 0) payload.sessions = sessions;
    const raw = Buffer.from(JSON.stringify(payload));
    const useGzip = raw.length >= GZIP_MIN_BYTES;
    const body = useGzip ? gzipSync(raw) : raw;
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
        if (onProgress) onProgress(sent, totalBytes);
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
 * GET user settings from the vibecafe API.
 * Returns null on any failure (network, auth, timeout) — caller should fail-safe.
 * @param {string} apiUrl
 * @param {string} apiKey
 * @returns {Promise<{uploadProject: boolean} | null>}
 */
export function fetchSettings(apiUrl, apiKey) {
  return new Promise((resolve) => {
    const url = new URL('/api/usage/settings', apiUrl);
    const mod = url.protocol === 'https:' ? https : http;

    const req = mod.request(url, {
      method: 'GET',
      timeout: 10_000,
      headers: {
        'Authorization': `Bearer ${apiKey}`,
      },
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          resolve(null);
          return;
        }
        try {
          resolve(JSON.parse(data));
        } catch {
          resolve(null);
        }
      });
    });

    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end();
  });
}
