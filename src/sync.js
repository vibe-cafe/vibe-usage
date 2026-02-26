import { hostname as osHostname } from 'node:os';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { loadConfig, saveConfig } from './config.js';
import { ingest } from './api.js';
import { parsers } from './parsers/index.js';
import { TOOLS } from './hooks.js';

const BATCH_SIZE = 500;

export async function runSync() {
  // Self-heal: re-inject any missing hooks before syncing
  ensureHooks();

  const config = loadConfig();
  if (!config?.apiKey) {
    console.error('Not configured. Run `npx @vibe-cafe/vibe-usage init` first.');
    process.exit(1);
  }

  const lastSync = config.lastSync || null;
  const allBuckets = [];

  for (const [source, parse] of Object.entries(parsers)) {
    try {
      const buckets = await parse(lastSync);
      if (buckets.length > 0) {
        allBuckets.push(...buckets);
      }
    } catch (err) {
      process.stderr.write(`warn: ${source} parser failed: ${err.message}\n`);
    }
  }

  if (allBuckets.length === 0) {
    console.log('No new usage data found.');
    return 0;
  }

  // Tag every bucket with this machine's hostname
  const host = osHostname().replace(/\.local$/, '');
  for (const b of allBuckets) {
    b.hostname = host;
  }

  const apiUrl = config.apiUrl || 'https://vibecafe.ai';
  let totalIngested = 0;
  const totalBatches = Math.ceil(allBuckets.length / BATCH_SIZE);

  console.log(`Uploading ${allBuckets.length} buckets (${totalBatches} batch${totalBatches > 1 ? 'es' : ''})...`);

  try {
    for (let i = 0; i < allBuckets.length; i += BATCH_SIZE) {
      const batch = allBuckets.slice(i, i + BATCH_SIZE);
      const batchNum = Math.floor(i / BATCH_SIZE) + 1;
      const uploaded = Math.min(i + BATCH_SIZE, allBuckets.length);

      if (totalBatches > 1) {
        process.stdout.write(`  [${batchNum}/${totalBatches}] ${uploaded}/${allBuckets.length} buckets...\r`);
      }

      const result = await ingest(apiUrl, config.apiKey, batch);
      totalIngested += result.ingested ?? batch.length;

      // Save progress after each successful batch so partial uploads survive interruptions
      config.lastSync = new Date().toISOString();
      saveConfig(config);
    }

    if (totalBatches > 1) {
      process.stdout.write('\n');
    }
    console.log(`Synced ${totalIngested} buckets.`);
    return totalIngested;
  } catch (err) {
    if (err.message === 'UNAUTHORIZED') {
      console.error('Invalid API key. Run `npx @vibe-cafe/vibe-usage init` to reconfigure.');
      process.exit(1);
    }
    // Progress already saved per-batch — report partial success
    if (totalIngested > 0) {
      console.error(`Sync partially completed (${totalIngested} buckets uploaded). ${err.message}`);
    } else {
      console.error(`Sync failed: ${err.message}`);
    }
    process.exit(1);
  }
}

/**
 * Re-inject hooks for any installed tool whose hook is missing.
 * Runs silently — meant as a self-healing side effect of sync.
 */
function ensureHooks() {
  // Skip hook injection if Vibe Usage Mac app is running
  const markerPath = join(homedir(), '.vibe-usage', 'mac-app-active');
  if (existsSync(markerPath)) {
    try {
      const marker = JSON.parse(readFileSync(markerPath, 'utf-8'));
      if (marker.pid) {
        try {
          process.kill(marker.pid, 0);
          return;
        } catch {
          try { unlinkSync(markerPath); } catch { /* ignore */ }
        }
      }
    } catch {
      // Malformed marker file — ignore
    }
  }

  for (const tool of TOOLS) {
    if (!tool.inject) continue;
    try {
      const result = tool.inject();
      if (result.injected) {
        process.stderr.write(`hook: re-installed ${tool.name} hook\n`);
      }
    } catch {
      // ignore — best effort
    }
  }
}
