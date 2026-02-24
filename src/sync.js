import { loadConfig, saveConfig } from './config.js';
import { ingest } from './api.js';
import { parsers } from './parsers/index.js';

const BATCH_SIZE = 500;

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
