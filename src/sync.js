import { hostname as osHostname } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { loadConfig, saveConfig } from './config.js';
import {
  loadState, saveState, pruneState, stateIdentity,
  bucketKey, bucketHash, sessionKey, sessionHash,
} from './state.js';
import { ingest, fetchSettings } from './api.js';
import { createSyncClient, forBatch } from './client-meta.js';
import { parsers } from './parsers/index.js';
import { aggregateToBuckets } from './parsers/aggregate.js';
import { normalizeParserResult } from './parsers/contract.js';
import { extraRootList } from './extra-roots.js';
import { planKikiMigration } from './kiki-migration.js';
import { success, failure, warn, arrow, link, dim, liveStatus } from './output.js';

const BATCH_SIZE = 100;
const SESSION_BATCH_SIZE = 500;

/** Coarse human duration: "45s" / "2m10s" / "1h 20m". */
export function formatDuration(seconds) {
  const secs = Math.max(0, Math.round(seconds));
  if (secs < 60) return `${secs}s`;
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  return s > 0 ? `${m}m${s}s` : `${m}m`;
}

/**
 * Remaining upload time from batches already finished. Measured, never guessed:
 * returns null until at least one batch has completed, because a first-sync
 * backlog and a steady-state trickle differ by three orders of magnitude and
 * any a-priori rate would be wrong for one of them.
 */
export function estimateRemainingSeconds({ elapsedMs, doneBatches, totalBatches }) {
  if (!(elapsedMs > 0) || doneBatches < 1 || totalBatches <= doneBatches) return null;
  return ((elapsedMs / doneBatches) * (totalBatches - doneBatches)) / 1000;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/** Elapsed-time suffix for the live status line (`formatDuration` rounds 0 to `0s`). */
function phaseElapsed(elapsedMs) {
  return ` · 已用时 ${formatDuration(elapsedMs / 1000)}`;
}

export function resolveUploadProjectSetting(settings) {
  if (typeof settings?.uploadProject !== 'boolean') {
    const error = new Error('SETTINGS_UNAVAILABLE');
    error.code = 'SETTINGS_UNAVAILABLE';
    throw error;
  }
  return settings.uploadProject;
}

export function resolveCachedUploadProjectSetting(config, apiUrl) {
  if (config?.lastUploadProjectApiUrl !== apiUrl) return undefined;
  return typeof config.lastUploadProject === 'boolean'
    ? config.lastUploadProject
    : undefined;
}

export function resolveCodexExtraHome(configured, temporary) {
  return temporary ?? configured;
}

// Hiding project names can collapse multiple parser buckets onto one server
// identity. Merge those buckets before hashing/uploading so no project's usage
// wins by iteration order.
export function reaggregateHiddenProjectBuckets(buckets) {
  return aggregateToBuckets(buckets.map(bucket => ({
    ...bucket,
    timestamp: new Date(bucket.bucketStart),
  })));
}

/**
 * Compare local parser diagnostics (Cursor's signed-in account and newest
 * event) with the previous run and warn only on a meaningful change. The
 * values live in state.json under `parserMeta`; they are local diagnostics,
 * never uploaded, and older CLIs ignore them.
 *
 * This is how an account switch stops being silent: the old token keeps
 * returning the old account's history, so the dashboard simply stops growing
 * while every sync still "succeeds". `status` prints the recorded account and
 * newest event for the same reason.
 */
export function applyParserInfos(state, parserInfos) {
  if (!Array.isArray(parserInfos) || parserInfos.length === 0) return false;
  if (!state.parserMeta || typeof state.parserMeta !== 'object') state.parserMeta = {};
  let changed = false;

  for (const { source, info } of parserInfos) {
    if (!info || typeof info !== 'object' || Array.isArray(info)) continue;
    const previous = state.parserMeta[source];
    if (source === 'cursor') {
      const warnings = [];
      if (previous?.account && info.account && previous.account !== info.account) {
        warnings.push(
          `cursor: Cursor 登录账号已从 ${previous.account} 更换为 ${info.account}；`
          + '如果这不是你刚切换的账号，请在 Cursor 设置中重新登录。',
        );
      }
      if (previous?.latestEventAt && info.latestEventAt) {
        const before = Date.parse(previous.latestEventAt);
        const after = Date.parse(info.latestEventAt);
        if (Number.isFinite(before) && Number.isFinite(after) && after < before) {
          warnings.push(
            `cursor: Cursor 最新事件从 ${previous.latestEventAt} 回退到 ${info.latestEventAt}；`
            + '这通常意味着当前登录的是另一个（更旧的）Cursor 账号。',
          );
        }
      }
      if (previous?.tokenEvents > 0 && info.tokenEvents === 0) {
        warnings.push(
          `cursor: Cursor 本次没有读到可上传的 token 用量（账号 ${info.account || '未知'}，`
          + `事件 ${info.events ?? 0}）。如果最近用过 Cursor，请运行 status 确认登录账号；`
          + 'X 订阅的用量也可能并入 grok.com/dashboard。',
        );
      } else if (previous?.events > 0 && info.events === 0) {
        warnings.push(
          `cursor: Cursor 本次没有返回任何用量事件（账号 ${info.account || '未知'}）；`
          + '如果最近用过 Cursor，请确认 Cursor 仍登录该账号。',
        );
      }
      for (const message of warnings) {
        process.stderr.write(`${dim(`  ${message}`)}\n`);
      }
    }
    if (JSON.stringify(previous ?? null) !== JSON.stringify(info)) {
      state.parserMeta[source] = info;
      changed = true;
    }
  }
  return changed;
}

// Parser execution is I/O bound (log reads, occasional network calls). Run a
// bounded number at once to cut wall-clock sync time without the memory spike
// of loading every tool's logs simultaneously.
export const PARSER_CONCURRENCY = 4;

// Parsers whose run time follows the size of a remote account rather than this
// machine. Cursor downloads cursor.com's usage export; a whole-account export
// for a heavy account took 137s (issue #131), and every other tool's upload
// used to wait for it. If one is still running once the local parsers are done
// (plus a short grace), runSync uploads the local results first.
export const DEFERRABLE_SOURCES = new Set(['cursor']);
const DEFAULT_DEFERRED_GRACE_MS = 5_000;

export function resolveDeferredGraceMs(value) {
  const ms = Number(value);
  return value !== undefined && value !== '' && Number.isInteger(ms) && ms >= 0 && ms <= 600_000
    ? ms
    : DEFAULT_DEFERRED_GRACE_MS;
}

// Run `fn` over `items` with at most `limit` in flight, preserving order.
export async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));
  const workers = Array.from({ length: workerCount }, async () => {
    while (true) {
      const index = nextIndex++;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

export async function runSync({
  throws = false,
  quiet = false,
  surface = 'cli',
  codexExtraHome,
} = {}) {
  const config = loadConfig();
  if (!config?.apiKey) {
    console.error(failure('尚未配置，请先运行 `npx @vibe-cafe/vibe-usage`。'));
    if (throws) throw new Error('NOT_CONFIGURED');
    process.exit(1);
  }

  // Migration: remove deprecated lastSync field from config
  if ('lastSync' in config) {
    delete config.lastSync;
    saveConfig(config);
  }

  // Privacy is a required input, not an optional hint. If the settings API is
  // unavailable, treating it as `false` changes every project-bearing item's
  // incremental identity to `unknown` and can trigger a full-history upload.
  // Resolve it before parsing or loading upload state so failure is a true
  // no-op: no data upload and no state mutation.
  const apiUrl = config.apiUrl || 'https://vibecafe.ai';
  // state.json records what was already uploaded to *this* account on *this*
  // server. Passing the identity into loadState() makes state left by a
  // previous account fall away, so a re-bind re-uploads the local history
  // instead of diffing it against uploads the new account never received.
  // Built from the same `apiUrl` the ingest calls below use, so the recorded
  // target and the actual target can never drift apart.
  const identity = stateIdentity({ apiUrl, apiKey: config.apiKey });
  // Both the settings round-trip and the log scan below can run for minutes on
  // a cold or proxied machine (a timing-out endpoint retrying, a cold Codex
  // index, a 120s Cursor export). A live status line keeps that work
  // distinguishable from a hang; it never reaches a pipe, so the desktop apps
  // keep parsing bare result text from stdout.
  const status = liveStatus({ enabled: !quiet });
  status.start(elapsedMs => `正在读取上传设置${phaseElapsed(elapsedMs)}`);
  let uploadProject;
  try {
    const settings = await fetchSettings(apiUrl, config.apiKey);
    uploadProject = resolveUploadProjectSetting(settings);
    // Scope the cached privacy choice to the server that returned it. Reusing
    // the value after `apiUrl` changes could expose project names to a
    // different server during its first settings outage.
    if (
      config.lastUploadProject !== uploadProject
      || config.lastUploadProjectApiUrl !== apiUrl
    ) {
      config.lastUploadProject = uploadProject;
      config.lastUploadProjectApiUrl = apiUrl;
      saveConfig(config);
    }
  } catch (err) {
    status.stop();
    if (err.message === 'UNAUTHORIZED') {
      console.error(failure('API Key 无效，请运行 `npx @vibe-cafe/vibe-usage init` 重新配置。'));
      if (throws) throw err;
      process.exit(1);
    }
    // Settings endpoint unreachable (not auth): degrade to the last confirmed
    // choice for this same server rather than hard-aborting every upload.
    const cachedUploadProject = resolveCachedUploadProjectSetting(config, apiUrl);
    if (typeof cachedUploadProject === 'boolean') {
      uploadProject = cachedUploadProject;
      if (!quiet) console.log(warn('设置接口不可用，沿用上次的项目名设置。'));
    } else {
      console.error(failure('暂时无法读取上传设置，本次同步已安全取消（未上传数据）。请稍后重试。'));
      if (throws) throw err;
      process.exit(1);
    }
  }

  // Loaded before parsing so a stateful parser can use the previous run's
  // diagnostics (Cursor uses the last event time to gate its events fallback
  // and avoid re-uploading already-known history under a different model id).
  const state = loadState(identity);

  // A sync may run as two passes (see below); these lines print once, and
  // the upload client (one syncId per runSync) is created once.
  let syncClient = null;
  let identityNoticeShown = false;
  let projectNoticeShown = false;
  const announceIdentityChange = () => {
    if (!state.identityChanged || quiet || identityNoticeShown) return;
    identityNoticeShown = true;
    console.log(dim('检测到上传账号已更换，本次全量重传本地历史'));
  };
  const printDashboardLink = () => {
    console.log();
    console.log(`${arrow('前往 Dashboard 查看详情')} ${link(`${apiUrl}/usage`)}`);
  };

  // Run parsers concurrently (bounded) so one slow parser (Cursor's network
  // fetch, a cold Codex index) can't stall the rest. Results are collected in
  // registry order so output and merged arrays stay deterministic.
  const parserRegistry = Object.entries(parsers);
  let parsedSources = 0;
  const runParser = async ([source, parse]) => {
    try {
      const result = await parse({
        extraRoots: extraRootList(config.extraRoots?.[source]),
        previousInfo: state.parserMeta?.[source],
        ...(source === 'codex' ? {
          codexExtraHome: resolveCodexExtraHome(config.codexExtraHome, codexExtraHome),
        } : {}),
      });
      return { source, result };
    } catch (err) {
      return { source, error: err };
    } finally {
      parsedSources++;
    }
  };
  status.start(elapsedMs => `正在扫描本地日志 ${parsedSources}/${parserRegistry.length}${phaseElapsed(elapsedMs)}`);
  // Deferrable (network-bound) parsers start first, outside the pool: they
  // wait on a remote account, not on this machine's disk or CPU.
  const deferredEntries = parserRegistry.filter(([source]) => DEFERRABLE_SOURCES.has(source));
  const localEntries = parserRegistry.filter(([source]) => !DEFERRABLE_SOURCES.has(source));
  let deferredSettled = deferredEntries.length === 0;
  const deferredOutcomes = Promise.all(deferredEntries.map(runParser)).then((outcomes) => {
    deferredSettled = true;
    return outcomes;
  });
  const localOutcomes = await mapWithConcurrency(localEntries, PARSER_CONCURRENCY, runParser);
  if (!deferredSettled) {
    // A short grace keeps the ordinary case -- a Cursor export that finishes
    // just after the local logs -- in one pass and one summary. `ref: false`:
    // an already-finished sync must not idle on it.
    await Promise.race([
      deferredOutcomes,
      sleep(resolveDeferredGraceMs(process.env.VIBE_USAGE_DEFERRED_GRACE_MS), undefined, { ref: false }),
    ]);
  }

  if (deferredSettled) {
    const bySource = new Map([...localOutcomes, ...await deferredOutcomes].map(o => [o.source, o]));
    status.stop();
    return syncOutcomes(parserRegistry.map(([source]) => bySource.get(source)));
  }

  // Still downloading (a first whole-account Cursor export can take minutes,
  // issue #131): upload every finished tool now, then the slow source. Each
  // pass diffs, prunes (scoped to its own sources) and commits state per batch
  // exactly like a single pass, so the uploaded keys and values are the same;
  // only their order changes. A desktop app that kills the process at its own
  // timeout now loses at most the slow source, not every tool's upload.
  status.stop();
  const pendingSources = deferredEntries.map(([source]) => source).join(', ');
  if (!quiet) console.log(dim(`  ${pendingSources}: 仍在读取用量数据，先上传其他工具`));
  const firstPassIngested = await syncOutcomes(localOutcomes, { final: false });
  status.start(elapsedMs => `正在等待 ${pendingSources}${phaseElapsed(elapsedMs)}`);
  const lateOutcomes = await deferredOutcomes;
  status.stop();
  return firstPassIngested + await syncOutcomes(lateOutcomes, {
    final: true,
    ingestedEarlier: firstPassIngested,
  });

  // One diff-and-upload pass over a set of parser outcomes. `final` is false
  // only for the first of two passes (see above): that pass stays quiet about
  // "no new data" and leaves the dashboard link to the last pass.
  async function syncOutcomes(parserOutcomes, { final = true, ingestedEarlier = 0 } = {}) {
    let allBuckets = [];
    const allSessions = [];
    const parserResults = [];
    const parserProgress = [];
    const parserInfos = [];
    // Sources whose parser ran to completion this sync. pruneState() below is
    // scoped to these so a transient parser failure doesn't evict that tool's
    // state and force a full re-upload next run.
    const okSources = new Set();

    for (const { source, result, error } of parserOutcomes) {
      if (error) {
        // Parser errors are non-fatal — pass-through in dim gray (no translation).
        process.stderr.write(`${dim(`  ${source}: ${error.message}`)}\n`);
        continue;
      }
      let normalized;
      try {
        normalized = normalizeParserResult(source, result);
      } catch (err) {
        process.stderr.write(`${dim(`  ${source}: ${err.message}`)}\n`);
        continue;
      }
      const { buckets, sessions, skipped, warnings, indexing, info } = normalized;
      if (indexing) {
        parserProgress.push({ source, ...indexing });
      }
      if (info) parserInfos.push({ source, info });
      // Parser warnings always reach stderr, including quiet (daemon) runs: the
      // daemon log is the only trail a background failure leaves. Cursor's fetch
      // soft-skip used to be filtered out here to keep that log tidy, which made
      // a permanently failing export indistinguishable from a healthy one -- the
      // tool still listed as "installed" while it had never uploaded a byte.
      for (const message of warnings) {
        process.stderr.write(`${dim(`  ${message}`)}\n`);
      }
      // A parser may downgrade a transient error (Cursor network timeout) to a
      // warning instead of throwing. Its empty result is not proof that its prior
      // data disappeared, so it must not be pruned this run.
      if (!skipped) okSources.add(source);
      for (const bucket of buckets) allBuckets.push(bucket);
      for (const session of sessions) allSessions.push(session);
      if (buckets.length > 0 || sessions.length > 0) {
        parserResults.push({ source, buckets: buckets.length, sessions: sessions.length });
      }
    }

    if (allBuckets.length === 0 && allSessions.length === 0) {
      // Successful parsers emitted no live items. Prune their old keys even on
      // this fast path; otherwise deleting the final local log would leave dead
      // state entries forever. Failed-parser sources remain protected.
      announceIdentityChange();
      const before = Object.keys(state.buckets).length + Object.keys(state.sessions).length;
      pruneState(state, new Set(), new Set(), okSources);
      const pruned = before - (Object.keys(state.buckets).length + Object.keys(state.sessions).length);
      const metaChanged = applyParserInfos(state, parserInfos);
      if (pruned > 0 || metaChanged) saveState(state, identity);
      if (!quiet && parserProgress.length > 0) {
        for (const p of parserProgress) {
          console.log(dim(`  ${p.source}: 正在建立本地索引 ${p.completed}/${p.total}（下次同步继续）`));
        }
      } else if (!quiet && final) {
        if (ingestedEarlier > 0) printDashboardLink();
        else console.log(dim('暂无新数据。'));
      }
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
    if (!quiet && parserProgress.length > 0) {
      for (const p of parserProgress) {
        console.log(dim(`  ${p.source}: 正在建立本地索引 ${p.completed}/${p.total}（下次同步继续）`));
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

    if (!quiet && !projectNoticeShown) {
      projectNoticeShown = true;
      if (uploadProject) {
        console.log(dim('  项目名: 上传（可在 Web 设置中关闭）'));
      } else {
        console.log(dim('  项目名: 已隐藏'));
      }
    }
    if (!uploadProject) {
      for (const b of allBuckets) b.project = 'unknown';
      for (const s of allSessions) s.project = 'unknown';
      allBuckets = reaggregateHiddenProjectBuckets(allBuckets);
    }

    // Incremental upload diff: parsers above emit a complete view of live local
    // data (Codex may assemble that view from its disposable parser cache). Here
    // we drop anything whose content matches what we already uploaded, so only
    // new/changed items go over the network. A quiet machine sends zero bytes;
    // an active one sends just the current 30-min bucket.
    // Missing/corrupt state.json => empty maps => one-time full upload, then
    // incremental forever after.
    announceIdentityChange();
    const metaChanged = applyParserInfos(state, parserInfos);
    let migration;
    try {
      migration = planKikiMigration(allBuckets, allSessions, state, config.kikiStartAt);
    } catch (err) {
      process.stderr.write(`${dim(`  kiki: ${err.message}`)}\n`);
      migration = planKikiMigration(allBuckets, allSessions, state);
      migration.buckets = migration.buckets.filter(b => b.source !== 'kiki');
      migration.sessions = migration.sessions.filter(s => s.source !== 'kiki');
      // The invalid cut drops every Kiki row regardless of what the fallback
      // plan did; report that as withheld so the diagnostic is not silent.
      const droppedBuckets = allBuckets.filter(b => b.source === 'kiki');
      const droppedSessions = allSessions.filter(s => s.source === 'kiki');
      const droppedStarts = droppedBuckets.map(b => Date.parse(b.bucketStart)).filter(Number.isFinite);
      migration.withheld = {
        buckets: droppedBuckets.length,
        sessions: droppedSessions.length,
        totalTokens: droppedBuckets.reduce((sum, b) => sum + (Number(b.totalTokens) || 0), 0),
        earliest: droppedStarts.length > 0 ? new Date(Math.min(...droppedStarts)).toISOString() : null,
        latest: droppedStarts.length > 0 ? new Date(Math.max(...droppedStarts)).toISOString() : null,
      };
      okSources.delete('kiki');
    }
    if (migration.blocked) {
      okSources.delete('kiki');
      process.stderr.write(`${dim('  kiki: 历史与 kimi-code 同步记录重叠，暂停 Kiki 上传以避免双计。请保留 state.json，停用旧兼容采集器并按 README 迁移，显式设置 config set kikiStartAt <UTC半小时切点>。')}\n`);
    }
    // A cut (or the guard) withholds real Kiki history and freezes legacy
    // kimi-code rows; neither is silent, even in quiet/daemon runs. The user
    // learns the counts and time range, and both ways out: set a verified cut, or
    // clear the guard when they know no compatibility collector ever ran.
    const withheld = migration.withheld;
    if (withheld.buckets > 0 || withheld.sessions > 0
      || migration.frozenBuckets > 0 || migration.frozenSessions > 0) {
      const parts = [];
      if (withheld.buckets > 0 || withheld.sessions > 0) {
        const range = withheld.earliest ? `，时间范围 ${withheld.earliest} 至 ${withheld.latest}` : '';
        parts.push(`本次未上传 ${withheld.buckets} 个桶 / ${withheld.sessions} 个会话（${withheld.totalTokens} tokens${range}）`);
      }
      if (migration.frozenBuckets > 0 || migration.frozenSessions > 0) {
        parts.push(`已冻结 ${migration.frozenBuckets} 个旧 kimi-code 桶 / ${migration.frozenSessions} 个会话，其增长不再上传（服务端记录会停留在旧值）`);
      }
      process.stderr.write(`${dim(`  kiki: ${parts.join('；')}。若这段历史应归入 Kiki，请设置切点 config set kikiStartAt <UTC半小时切点>；若确认从未运行过兼容采集器，可用 config set kikiStartAt none 解除保护。`)}\n`);
    }
    allBuckets = migration.buckets;
    const uploadSessions = migration.sessions;
    const changedBuckets = [];
    const changedSessions = [];
    const liveBucketKeys = new Set(migration.preserveBuckets);
    const liveSessionKeys = new Set(migration.preserveSessions);
    // key -> hash, committed to state only after the owning batch's upload
    // succeeds (a failed batch re-sends next sync — no silent gap).
    const pendingBucketState = new Map();
    const pendingSessionState = new Map();

    for (const b of allBuckets) {
      const key = bucketKey(b);
      const h = bucketHash(b);
      liveBucketKeys.add(key);
      if (migration.preserveBuckets.has(key) || state.buckets[key] === h) continue;
      changedBuckets.push(b);
      pendingBucketState.set(key, h);
    }
    for (const s of uploadSessions) {
      const key = sessionKey(s);
      const h = sessionHash(s);
      liveSessionKeys.add(key);
      if (migration.preserveSessions.has(key) || state.sessions[key] === h) continue;
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
    if (pruned > 0 || metaChanged) saveState(state, identity);

    if (changedBuckets.length === 0 && changedSessions.length === 0) {
      if (!quiet && final) {
        if (ingestedEarlier > 0) printDashboardLink();
        else console.log(dim('无新增数据。'));
      }
      return 0;
    }

    const allBucketsToSend = changedBuckets;
    const allSessionsToSend = changedSessions;

    let totalIngested = 0;
    let totalSessionsSynced = 0;
    let totalDroppedBuckets = 0;
    let totalDroppedUnknownModels = 0;
    let totalDroppedImplausible = 0;
    let totalProtectedBuckets = 0;
    const droppedSources = new Set();
    const bucketBatches = Math.ceil(allBucketsToSend.length / BATCH_SIZE);
    const sessionBatches = Math.ceil(allSessionsToSend.length / SESSION_BATCH_SIZE);
    const totalBatches = Math.max(bucketBatches, sessionBatches, 1);
    // One syncId per runSync, shared by both passes.
    syncClient ??= createSyncClient({ defaultSurface: surface, hostname: host });

    // Say up front how much is about to go up. A first sync (or one that
    // backfills after a parser was broken) can be thousands of batches, and with
    // only a per-batch progress line the user cannot tell a long upload from a
    // hung one -- which is exactly how a silently failing parser stayed hidden.
    if (!quiet) {
      const pending = [`${allBucketsToSend.length} buckets`];
      if (allSessionsToSend.length > 0) pending.push(`${allSessionsToSend.length} sessions`);
      const batchNote = totalBatches > 1 ? `，分 ${totalBatches} 批` : '';
      console.log(dim(`  待上传 ${pending.join(' · ')}${batchNote}`));
    }

    let uploadedBytes = 0;
    const uploadStartedAt = Date.now();

    try {
      for (let batchIdx = 0; batchIdx < totalBatches; batchIdx++) {
        const batch = allBucketsToSend.slice(batchIdx * BATCH_SIZE, (batchIdx + 1) * BATCH_SIZE);
        const batchSessions = allSessionsToSend.slice(batchIdx * SESSION_BATCH_SIZE, (batchIdx + 1) * SESSION_BATCH_SIZE);
        const batchNum = batchIdx + 1;
        const prefix = totalBatches > 1 ? `  ${dim(`[${batchNum}/${totalBatches}]`)} 上传中 ` : '  上传中 ';

        // Only measured batches feed the estimate, so the first batch shows no
        // ETA rather than a made-up one.
        const remaining = estimateRemainingSeconds({
          elapsedMs: Date.now() - uploadStartedAt,
          doneBatches: batchIdx,
          totalBatches,
        });
        const etaNote = remaining === null ? '' : ` · 预计还需 ${formatDuration(remaining)}`;

        let batchBytes = 0;
        const result = await ingest(apiUrl, config.apiKey, batch, {
          client: forBatch(syncClient, batchIdx, totalBatches),
          onProgress(sent, total) {
            batchBytes = total;
            const pct = Math.round((sent / total) * 100);
            process.stdout.write(`\r${prefix}${dim(`${formatBytes(sent)}/${formatBytes(total)} (${pct}%)${etaNote}`)}\x1b[K`);
          },
        }, batchSessions.length > 0 ? batchSessions : undefined);
        uploadedBytes += batchBytes;
        totalIngested += result.ingested ?? batch.length;
        totalSessionsSynced += result.sessions ?? 0;
        const batchUnknownSources = new Set(result.dropped?.unknownSources || []);
        if (result.dropped) {
          totalDroppedBuckets += Number(result.dropped.buckets) || 0;
          totalDroppedUnknownModels += Number(result.dropped.unknownModels) || 0;
          totalDroppedImplausible += Number(result.dropped.implausible) || 0;
          for (const s of result.dropped.unknownSources || []) droppedSources.add(s);
        }
        totalProtectedBuckets += Number(result.protected?.buckets) || 0;

        // Commit only hashes from this successful batch. Persist before starting
        // the next batch: if a later upload fails or the process exits abruptly,
        // the next sync retries only the uncommitted suffix.
        let batchStateChanged = false;
        for (const b of batch) {
          // A source unknown to an older backend may become valid after deploy.
          // Leave those hashes uncommitted so the next sync retries them instead
          // of turning a temporary release-order mismatch into permanent loss.
          if (batchUnknownSources.has(b.source)) continue;
          const key = bucketKey(b);
          const entry = pendingBucketState.get(key);
          if (entry) {
            state.buckets[key] = entry;
            batchStateChanged = true;
          }
        }
        for (const s of batchSessions) {
          // Same uncommitted-on-drop rule as buckets: a session the backend
          // rejected for an unknown source must be retried on the next sync
          // rather than permanently lost.
          if (batchUnknownSources.has(s.source)) continue;
          const key = sessionKey(s);
          const entry = pendingSessionState.get(key);
          if (entry) {
            state.sessions[key] = entry;
            batchStateChanged = true;
          }
        }
        if (batchStateChanged) saveState(state, identity);
      }

      if (totalBatches > 1 || allBucketsToSend.length > 0) {
        process.stdout.write('\r\x1b[K');
      }
      const syncParts = [`${totalIngested} buckets`];
      if (totalSessionsSynced > 0) syncParts.push(`${totalSessionsSynced} sessions`);
      console.log(success(`已同步 ${syncParts.join(' · ')}`));
      if (!quiet && uploadedBytes > 0) {
        const elapsed = (Date.now() - uploadStartedAt) / 1000;
        console.log(dim(`  上传 ${formatBytes(uploadedBytes)}（已压缩），用时 ${formatDuration(elapsed)}`));
      }

      if (totalDroppedBuckets > 0) {
        const reasons = [];
        if (droppedSources.size > 0) {
          reasons.push(`服务端未收录的 source: ${Array.from(droppedSources).sort().join(', ')}`);
        }
        if (totalDroppedUnknownModels > 0) reasons.push(`模型未知: ${totalDroppedUnknownModels}`);
        if (totalDroppedImplausible > 0) reasons.push(`超出合理范围: ${totalDroppedImplausible}`);
        if (reasons.length === 0) reasons.push('服务端拒绝');
        console.log(dim(`  ${totalDroppedBuckets} buckets dropped (${reasons.join('；')})`));
      }

      if (totalProtectedBuckets > 0) {
        console.log(dim(`  服务端保留了 ${totalProtectedBuckets} 个更大的已有 bucket（本次较小快照未覆盖）`));
      }

      if (!quiet && totalSessionsSynced > 0) {
        const totalActive = allSessionsToSend.reduce((s, x) => s + x.activeSeconds, 0);
        const totalDuration = allSessionsToSend.reduce((s, x) => s + x.durationSeconds, 0);
        const totalMsgs = allSessionsToSend.reduce((s, x) => s + x.messageCount, 0);
        console.log(dim(`  活跃 ${formatDuration(totalActive)} / 总时长 ${formatDuration(totalDuration)} · ${totalMsgs} 条消息`));
      }

      if (!quiet && final) printDashboardLink();

      return totalIngested;
    } catch (err) {
      if (err.message === 'UNAUTHORIZED') {
        console.error(failure('API Key 无效，请运行 `npx @vibe-cafe/vibe-usage init` 重新配置。'));
        if (throws) throw err;
        process.exit(1);
      }
      // Count the first pass too: when only the slow source's pass fails, the
      // other tools did reach the server and the message must say so.
      const ingestedSoFar = ingestedEarlier + totalIngested;
      if (ingestedSoFar > 0) {
        console.error(failure(`部分完成（已上传 ${ingestedSoFar} buckets）: ${err.message}`));
      } else {
        console.error(failure(`同步失败: ${err.message}`));
      }
      if (throws) throw err;
      process.exit(1);
    }
  }
}
