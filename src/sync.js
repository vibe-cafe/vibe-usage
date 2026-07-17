import { hostname as osHostname } from 'node:os';
import { loadConfig, saveConfig } from './config.js';
import {
  loadState, saveState, pruneState,
  bucketKey, bucketHash, sessionKey, sessionHash,
} from './state.js';
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
  // Sources whose parser ran to completion this sync. pruneState() below is
  // scoped to these so a transient parser failure doesn't evict that tool's
  // state and force a full re-upload next run.
  const okSources = new Set();

  for (const [source, parse] of Object.entries(parsers)) {
    try {
      const result = await parse();
      const buckets = Array.isArray(result) ? result : result.buckets;
      const sessions = Array.isArray(result) ? [] : (result.sessions || []);
      if (!Array.isArray(buckets) || !Array.isArray(sessions)) {
        throw new TypeError('Parser returned an invalid result');
      }
      // A parser may deliberately suppress a transient error (Cursor network
      // timeout) to keep daemon logs quiet. Its empty result is not proof that
      // its prior data disappeared, so it must not be pruned this run.
      if (!result?.skipped) okSources.add(source);
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
    // Successful parsers emitted no live items. Prune their old keys even on
    // this fast path; otherwise deleting the final local log would leave dead
    // state entries forever. Failed-parser sources remain protected.
    const state = loadState();
    const before = Object.keys(state.buckets).length + Object.keys(state.sessions).length;
    pruneState(state, new Set(), new Set(), okSources);
    const pruned = before - (Object.keys(state.buckets).length + Object.keys(state.sessions).length);
    if (pruned > 0) saveState(state);
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
  // Cloud-sourced parsers (e.g. cursor) pre-set their own hostname sentinel so
  // the same account data isn't stored as separate rows per machine.
  for (const b of allBuckets) if (!b.hostname) b.hostname = host;
  for (const s of allSessions) if (!s.hostname) s.hostname = host;

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

  // Incremental diff: parsers above always read the full local history (cheap,
  // local-only). Here we drop anything whose content matches what we already
  // uploaded, so only new/changed items go over the network. A quiet machine
  // sends zero bytes; an active one sends just the current 30-min bucket.
  // Missing/corrupt state.json => empty maps => one-time full upload, then
  // incremental forever after.
  const state = loadState();
  const changedBuckets = [];
  const changedSessions = [];
  const liveBucketKeys = new Set();
  const liveSessionKeys = new Set();
  // key -> hash, committed to state only after the owning batch's upload
  // succeeds (a failed batch re-sends next sync — no silent gap).
  const pendingBucketState = new Map();
  const pendingSessionState = new Map();

  for (const b of allBuckets) {
    const key = bucketKey(b);
    const h = bucketHash(b);
    liveBucketKeys.add(key);
    if (state.buckets[key] === h) continue;
    changedBuckets.push(b);
    pendingBucketState.set(key, h);
  }
  for (const s of allSessions) {
    const key = sessionKey(s);
    const h = sessionHash(s);
    liveSessionKeys.add(key);
    if (state.sessions[key] === h) continue;
    changedSessions.push(s);
    pendingSessionState.set(key, h);
  }

  // Drop entries the parsers no longer emit (deleted logs) so state.json can't
  // grow forever. Done by liveness, never by age — an old bucket's hash never
  // changes, so keeping it is exactly what prevents re-uploading it.
  //
  // Persist the pruned state unconditionally and immediately: removing dead
  // keys is independent of whether anything uploads, so it must NOT be coupled
  // to upload success. If we deferred this to the batch loop, a first-batch
  // failure would throw before any saveState and the prune would be lost.
  const before = Object.keys(state.buckets).length + Object.keys(state.sessions).length;
  pruneState(state, liveBucketKeys, liveSessionKeys, okSources);
  const pruned = before - (Object.keys(state.buckets).length + Object.keys(state.sessions).length);
  if (pruned > 0) saveState(state);

  if (changedBuckets.length === 0 && changedSessions.length === 0) {
    if (!quiet) console.log(dim('无新增数据。'));
    return 0;
  }

  const allBucketsToSend = changedBuckets;
  const allSessionsToSend = changedSessions;

  let totalIngested = 0;
  let totalSessionsSynced = 0;
  let totalDroppedBuckets = 0;
  const droppedSources = new Set();
  const bucketBatches = Math.ceil(allBucketsToSend.length / BATCH_SIZE);
  const sessionBatches = Math.ceil(allSessionsToSend.length / SESSION_BATCH_SIZE);
  const totalBatches = Math.max(bucketBatches, sessionBatches, 1);

  try {
    for (let batchIdx = 0; batchIdx < totalBatches; batchIdx++) {
      const batch = allBucketsToSend.slice(batchIdx * BATCH_SIZE, (batchIdx + 1) * BATCH_SIZE);
      const batchSessions = allSessionsToSend.slice(batchIdx * SESSION_BATCH_SIZE, (batchIdx + 1) * SESSION_BATCH_SIZE);
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
      if (result.dropped) {
        totalDroppedBuckets += Number(result.dropped.buckets) || 0;
        for (const s of result.dropped.unknownSources || []) droppedSources.add(s);
      }

      // Commit only this batch's hashes, only after it uploaded successfully.
      // A batch that throws aborts the loop with its keys still absent from
      // state, so the next sync re-sends exactly those items — no data loss,
      // no silent gaps.
      for (const b of batch) {
        const key = bucketKey(b);
        const entry = pendingBucketState.get(key);
        if (entry) state.buckets[key] = entry;
      }
      for (const s of batchSessions) {
        const key = sessionKey(s);
        const entry = pendingSessionState.get(key);
        if (entry) state.sessions[key] = entry;
      }
      saveState(state);
    }

    if (totalBatches > 1 || allBucketsToSend.length > 0) {
      process.stdout.write('\r\x1b[K');
    }
    const syncParts = [`${totalIngested} buckets`];
    if (totalSessionsSynced > 0) syncParts.push(`${totalSessionsSynced} sessions`);
    console.log(success(`已同步 ${syncParts.join(' · ')}`));

    if (totalDroppedBuckets > 0) {
      // Server doesn't (yet) recognize these source IDs — usually means the
      // CLI is newer than the deployed vibe-cafe. Surface so the user knows
      // the data wasn't lost on their end, just not stored upstream.
      const sourcesList = Array.from(droppedSources).sort().join(', ');
      console.log(dim(`  ${totalDroppedBuckets} buckets dropped (服务端未收录的 source: ${sourcesList})`));
    }

    if (!quiet && totalSessionsSynced > 0) {
      const totalActive = allSessionsToSend.reduce((s, x) => s + x.activeSeconds, 0);
      const totalDuration = allSessionsToSend.reduce((s, x) => s + x.durationSeconds, 0);
      const totalMsgs = allSessionsToSend.reduce((s, x) => s + x.messageCount, 0);
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
