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
  const allSessions = [];

  for (const [source, parse] of Object.entries(parsers)) {
    try {
      const result = await parse();
      const buckets = Array.isArray(result) ? result : result.buckets;
      const sessions = Array.isArray(result) ? [] : (result.sessions || []);
      if (buckets.length > 0) allBuckets.push(...buckets);
      if (sessions.length > 0) allSessions.push(...sessions);
    } catch (err) {
      process.stderr.write(`warn: ${source} parser failed: ${err.message}\n`);
    }
  }

  if (allBuckets.length === 0 && allSessions.length === 0) {
    if (!quiet) console.log('No new usage data found.');
    return 0;
  }

  const host = osHostname().replace(/\.local$/, '');
  for (const b of allBuckets) {
    b.hostname = host;
  }
  for (const s of allSessions) {
    s.hostname = host;
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
    for (const s of allSessions) {
      s.project = 'unknown';
    }
  }

  let totalIngested = 0;
  let totalSessionsSynced = 0;
  const totalBatches = Math.ceil(Math.max(allBuckets.length, 1) / BATCH_SIZE);

  const parts = [];
  if (allBuckets.length > 0) parts.push(`${allBuckets.length} buckets`);
  if (allSessions.length > 0) parts.push(`${allSessions.length} sessions`);
  console.log(`Uploading ${parts.join(' + ')} (${totalBatches} batch${totalBatches > 1 ? 'es' : ''})...`);

  try {
    for (let i = 0; i < Math.max(allBuckets.length, 1); i += BATCH_SIZE) {
      const batch = allBuckets.slice(i, i + BATCH_SIZE);
      const batchNum = Math.floor(i / BATCH_SIZE) + 1;
      const prefix = totalBatches > 1 ? `  [${batchNum}/${totalBatches}] ` : '  ';
      const batchSessions = i === 0 ? allSessions : undefined;

      const result = await ingest(apiUrl, config.apiKey, batch, {
        onProgress(sent, total) {
          const pct = Math.round((sent / total) * 100);
          process.stdout.write(`\r${prefix}${formatBytes(sent)}/${formatBytes(total)} (${pct}%)\x1b[K`);
        },
      }, batchSessions);
      totalIngested += result.ingested ?? batch.length;
      totalSessionsSynced += result.sessions ?? 0;
    }

    if (totalBatches > 1 || allBuckets.length > 0) {
      process.stdout.write('\n');
    }
    const syncParts = [`${totalIngested} buckets`];
    if (totalSessionsSynced > 0) syncParts.push(`${totalSessionsSynced} sessions`);
    console.log(`Synced ${syncParts.join(' + ')}.`);
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
