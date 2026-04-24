import { hostname as osHostname } from 'node:os';
import { loadConfig, saveConfig } from './config.js';
import { ingest, fetchSettings } from './api.js';
import { parsers } from './parsers/index.js';
import { success, failure, arrow, link, dim } from './output.js';

const BATCH_SIZE = 100;
const SESSION_BATCH_SIZE = 500;

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

export async function runSync({ throws = false, quiet = false } = {}) {
  const config = loadConfig();
  if (!config?.apiKey) {
    console.error(failure('尚未配置，请先运行 `npx @vibe-cafe/vibe-usage init`。'));
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
  const parserResults = [];

  for (const [source, parse] of Object.entries(parsers)) {
    try {
      const result = await parse();
      const buckets = Array.isArray(result) ? result : result.buckets;
      const sessions = Array.isArray(result) ? [] : (result.sessions || []);
      if (buckets.length > 0) allBuckets.push(...buckets);
      if (sessions.length > 0) allSessions.push(...sessions);
      if (buckets.length > 0 || sessions.length > 0) {
        parserResults.push({ source, buckets: buckets.length, sessions: sessions.length });
      }
    } catch (err) {
      // Parser errors are non-fatal — pass-through in dim gray (no translation).
      process.stderr.write(`${dim(`  ${source}: ${err.message}`)}\n`);
    }
  }

  if (allBuckets.length === 0 && allSessions.length === 0) {
    if (!quiet) console.log(dim('暂无新数据。'));
    return 0;
  }

  if (!quiet && parserResults.length > 0) {
    for (const p of parserResults) {
      const parts = [];
      if (p.buckets > 0) parts.push(`${p.buckets} buckets`);
      if (p.sessions > 0) parts.push(`${p.sessions} sessions`);
      console.log(`  ${dim(p.source.padEnd(14))}${parts.join(' · ')}`);
    }
  }

  let host = config.hostname;
  if (!host) {
    host = osHostname().replace(/\.local$/, '');
    config.hostname = host;
    saveConfig(config);
  }
  for (const b of allBuckets) b.hostname = host;
  for (const s of allSessions) s.hostname = host;

  // Privacy: check if user allows project name upload
  const apiUrl = config.apiUrl || 'https://vibecafe.ai';
  const settings = await fetchSettings(apiUrl, config.apiKey);
  const uploadProject = settings?.uploadProject === true;

  if (!quiet) {
    if (uploadProject) {
      console.log(dim('  项目名: 上传（可在 Web 设置中关闭）'));
    } else {
      console.log(dim('  项目名: 已隐藏'));
    }
  }
  if (!uploadProject) {
    for (const b of allBuckets) b.project = 'unknown';
    for (const s of allSessions) s.project = 'unknown';
  }

  let totalIngested = 0;
  let totalSessionsSynced = 0;
  const bucketBatches = Math.ceil(allBuckets.length / BATCH_SIZE);
  const sessionBatches = Math.ceil(allSessions.length / SESSION_BATCH_SIZE);
  const totalBatches = Math.max(bucketBatches, sessionBatches, 1);

  try {
    for (let batchIdx = 0; batchIdx < totalBatches; batchIdx++) {
      const batch = allBuckets.slice(batchIdx * BATCH_SIZE, (batchIdx + 1) * BATCH_SIZE);
      const batchSessions = allSessions.slice(batchIdx * SESSION_BATCH_SIZE, (batchIdx + 1) * SESSION_BATCH_SIZE);
      const batchNum = batchIdx + 1;
      const prefix = totalBatches > 1 ? `  ${dim(`[${batchNum}/${totalBatches}]`)} 上传中 ` : '  上传中 ';

      const result = await ingest(apiUrl, config.apiKey, batch, {
        onProgress(sent, total) {
          const pct = Math.round((sent / total) * 100);
          process.stdout.write(`\r${prefix}${dim(`${formatBytes(sent)}/${formatBytes(total)} (${pct}%)`)}\x1b[K`);
        },
      }, batchSessions.length > 0 ? batchSessions : undefined);
      totalIngested += result.ingested ?? batch.length;
      totalSessionsSynced += result.sessions ?? 0;
    }

    if (totalBatches > 1 || allBuckets.length > 0) {
      process.stdout.write('\r\x1b[K');
    }
    const syncParts = [`${totalIngested} buckets`];
    if (totalSessionsSynced > 0) syncParts.push(`${totalSessionsSynced} sessions`);
    console.log(success(`已同步 ${syncParts.join(' · ')}`));

    if (!quiet && totalSessionsSynced > 0) {
      const totalActive = allSessions.reduce((s, x) => s + x.activeSeconds, 0);
      const totalDuration = allSessions.reduce((s, x) => s + x.durationSeconds, 0);
      const totalMsgs = allSessions.reduce((s, x) => s + x.messageCount, 0);
      const fmtTime = (secs) => {
        if (secs < 60) return `${secs}s`;
        const h = Math.floor(secs / 3600);
        const m = Math.floor((secs % 3600) / 60);
        return h > 0 ? (m > 0 ? `${h}h ${m}m` : `${h}h`) : `${m}m`;
      };
      console.log(dim(`  活跃 ${fmtTime(totalActive)} / 总时长 ${fmtTime(totalDuration)} · ${totalMsgs} 条消息`));
    }

    if (!quiet) {
      console.log();
      console.log(`${arrow('前往 Dashboard 查看详情')} ${link(`${apiUrl}/usage`)}`);
    }

    return totalIngested;
  } catch (err) {
    if (err.message === 'UNAUTHORIZED') {
      console.error(failure('API Key 无效，请运行 `npx @vibe-cafe/vibe-usage init` 重新配置。'));
      if (throws) throw err;
      process.exit(1);
    }
    if (totalIngested > 0) {
      console.error(failure(`部分完成（已上传 ${totalIngested} buckets）: ${err.message}`));
    } else {
      console.error(failure(`同步失败: ${err.message}`));
    }
    if (throws) throw err;
    process.exit(1);
  }
}

