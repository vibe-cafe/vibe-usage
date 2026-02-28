import { hostname as osHostname } from 'node:os';
import { loadConfig, saveConfig } from './config.js';
import { ingest } from './api.js';
import { parsers, postSyncHooks } from './parsers/index.js';

const BATCH_SIZE = 100;

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

export async function runSync() {
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
      const prefix = totalBatches > 1 ? `  [${batchNum}/${totalBatches}] ` : '  ';

      const result = await ingest(apiUrl, config.apiKey, batch, {
        onProgress(sent, total) {
          const pct = Math.round((sent / total) * 100);
          process.stdout.write(`\r${prefix}${formatBytes(sent)}/${formatBytes(total)} (${pct}%)\x1b[K`);
        },
      });
      totalIngested += result.ingested ?? batch.length;

      // Save progress after each successful batch so partial uploads survive interruptions
      config.lastSync = new Date().toISOString();
      saveConfig(config);
    }


    // Commit parser state now that all data has been uploaded successfully.
    // State is staged during parse() but only persisted here to prevent
    // data loss if uploads fail (deltas would be re-computed on retry).
    for (const hook of postSyncHooks) {
      try { hook(); } catch { /* best effort */ }
    }

    if (totalBatches > 1 || allBuckets.length > 0) {
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
