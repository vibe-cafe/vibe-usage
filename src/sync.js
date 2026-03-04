import { hostname as osHostname } from 'node:os';
import { loadConfig, saveConfig } from './config.js';
import { ingest, fetchSettings } from './api.js';
import { parsers } from './parsers/index.js';

const BATCH_SIZE = 100;

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

export async function runSync({ throws = false, quiet = false } = {}) {
  const config = loadConfig();
  if (!config?.apiKey) {
    console.error('Not configured. Run `npx @vibe-cafe/vibe-usage init` first.');
    if (throws) throw new Error('NOT_CONFIGURED');
    process.exit(1);
  }

  // Migration: remove deprecated lastSync field from config
  if ('lastSync' in config) {
    delete config.lastSync;
    saveConfig(config);
  }

  const allBuckets = [];

  for (const [source, parse] of Object.entries(parsers)) {
    try {
      const buckets = await parse();
      if (buckets.length > 0) {
        allBuckets.push(...buckets);
      }
    } catch (err) {
      process.stderr.write(`warn: ${source} parser failed: ${err.message}\n`);
    }
  }

  if (allBuckets.length === 0) {
    if (!quiet) console.log('No new usage data found.');
    return 0;
  }

  // Tag every bucket with this machine's hostname
  const host = osHostname().replace(/\.local$/, '');
  for (const b of allBuckets) {
    b.hostname = host;
  }

  // Privacy: check if user allows project name upload
  const apiUrl = config.apiUrl || 'https://vibecafe.ai';
  const settings = await fetchSettings(apiUrl, config.apiKey);
  const uploadProject = settings?.uploadProject === true;

  if (uploadProject) {
    console.log('📂 项目名: 上传 (可在 vibecafe.ai/usage 设置中关闭)');
  } else {
    console.log('🔒 项目名: 已隐藏');
    for (const b of allBuckets) {
      b.project = 'unknown';
    }
  }

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
    }

    if (totalBatches > 1 || allBuckets.length > 0) {
      process.stdout.write('\n');
    }
    console.log(`Synced ${totalIngested} buckets.`);
    return totalIngested;
  } catch (err) {
    if (err.message === 'UNAUTHORIZED') {
      console.error('Invalid API key. Run `npx @vibe-cafe/vibe-usage init` to reconfigure.');
      if (throws) throw err;
      process.exit(1);
    }
    // Report partial success
    if (totalIngested > 0) {
      console.error(`Sync partially completed (${totalIngested} buckets uploaded). ${err.message}`);
    } else {
      console.error(`Sync failed: ${err.message}`);
    }
    if (throws) throw err;
    process.exit(1);
  }
}
