import https from 'node:https';
import http from 'node:http';
import { URL } from 'node:url';

/**
 * POST buckets to the vibecafe ingest API.
 * Uses native http/https — zero dependencies.
 * @param {string} apiUrl - Base URL (e.g. "https://vibecafe.ai")
 * @param {string} apiKey - Bearer token (vbu_xxx)
 * @param {Array} buckets - Array of usage bucket objects
 * @returns {Promise<{ingested: number}>}
 */
export function ingest(apiUrl, apiKey, buckets) {
  return new Promise((resolve, reject) => {
    const url = new URL('/api/usage/ingest', apiUrl);
    const body = JSON.stringify({ buckets });
    const mod = url.protocol === 'https:' ? https : http;

    const req = mod.request(url, {
      method: 'POST',
      timeout: 30_000,
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
          reject(new Error(`HTTP ${res.statusCode}: ${data}`));
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
      reject(new Error('Request timed out (30s)'));
    });
    req.write(body);
    req.end();
  });
}
