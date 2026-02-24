import https from 'node:https';
import http from 'node:http';
import { URL } from 'node:url';

const MAX_RETRIES = 3;
const INITIAL_DELAY = 1000;

/**
 * POST buckets to the vibecafe ingest API.
 * Uses native http/https — zero dependencies.
 * Retries up to 3 times with exponential backoff on transient failures.
 * @param {string} apiUrl - Base URL (e.g. "https://vibecafe.ai")
 * @param {string} apiKey - Bearer token (vbu_xxx)
 * @param {Array} buckets - Array of usage bucket objects
 * @returns {Promise<{ingested: number}>}
 */
export async function ingest(apiUrl, apiKey, buckets) {
  let lastError;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      return await _send(apiUrl, apiKey, buckets);
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

function _send(apiUrl, apiKey, buckets) {
  return new Promise((resolve, reject) => {
    const url = new URL('/api/usage/ingest', apiUrl);
    const body = JSON.stringify({ buckets });
    const mod = url.protocol === 'https:' ? https : http;

    const req = mod.request(url, {
      method: 'POST',
      timeout: 60_000,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'Content-Length': Buffer.byteLength(body),
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
    req.write(body);
    req.end();
  });
}
