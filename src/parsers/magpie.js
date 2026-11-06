import { openSync, closeSync, readSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { HALF_HOUR_MS, magpieStartTime } from '../magpie-migration.js';

const CHUNK_SIZE = 64 * 1024;
const BRIDGE_AGENTS = new Set(['claude', 'codex', 'pi', 'omp', 'opencode']);
const isGroup = model => /(^|\/)group\//.test(model || '');
const concrete = model => typeof model === 'string' && model.length > 0
  && !isGroup(model) && !['auto', 'unknown', 'default'].includes(model);
const bareModel = model => model.split('/').at(-1).replace(/\[1m\]/gi, '')
  .replace(/:(?:none|minimal|low|medium|high|xhigh|max)(?:\+(?:none|minimal|low|medium|high|xhigh|max))*$/, '')
  .replace(/-(?:priority|fast|flex)$/, '');
const countsEqual = (a, b) => a.length === b.length && a.every((n, i) => n === b[i]);

function parseLine(line) {
  try { return JSON.parse(line); } catch { return null; }
}

// The append-only ledger is chronological. Scan backwards to the cut minus a
// day, then read forwards. No index or durable copy of Magpie data is created.
function recentOffset(fd, size, since) {
  if (!Number.isFinite(since)) return 0;
  let end = size;
  let suffix = Buffer.alloc(0);
  while (end > 0) {
    const start = Math.max(0, end - CHUNK_SIZE);
    const chunk = Buffer.alloc(end - start);
    if (readSync(fd, chunk, 0, chunk.length, start) !== chunk.length) throw new Error('Short ledger read');
    const data = Buffer.concat([chunk, suffix]);
    let right = data.length;
    for (let i = data.length - 1; i >= 0; i--) {
      if (data[i] !== 10) continue;
      const row = parseLine(data.subarray(i + 1, right).toString('utf8'));
      if (row && Date.parse(row.t) < since) return start + right;
      right = i;
    }
    suffix = data.subarray(0, right);
    end = start;
  }
  return 0;
}

/** One context per sync, shared by the five parsers. prepare() is called only
 * after a tool has captured/read its snapshot, and reads only the ledger tail
 * on later calls. Only allow-listed accounting metadata survives each line.
 */
export function createMagpieContext({ startAt, onPossible, now = Date.now() } = {}) {
  const file = process.env.VIBE_USAGE_MAGPIE_TEST_FILE
    || join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'magpie', 'usage.jsonl');
  const responses = new Map();
  const conflictingResponses = new Set();
  const sessions = new Map();
  const bridgeRequests = new Set();
  let offset = null;
  const ctx = {
    startAt, failed: false, pending: [], bytesRead: 0,
    discover(hasResponseModel = false) {
      let snapshot;
      try { snapshot = statSync(file); }
      catch (err) { if (err.code !== 'ENOENT') ctx.failed = true; }
      if (snapshot || ctx.failed || hasResponseModel) {
        if (ctx.startAt === undefined && onPossible) ctx.startAt = onPossible();
      }
      return snapshot;
    },
    prepare(hasResponseModel = false) {
      const snapshot = ctx.discover(hasResponseModel);
      if (!snapshot || ctx.failed) return;
      let fd;
      try {
        if (!snapshot.isFile()) throw new Error('Not a ledger');
        fd = openSync(file, 'r');
        const cut = magpieStartTime(ctx.startAt);
        const since = cut === null ? -Infinity : cut - 86_400_000;
        offset ??= recentOffset(fd, snapshot.size, since);
        let position = offset;
        let pending = Buffer.alloc(0);
        while (position < snapshot.size) {
          const chunk = Buffer.alloc(Math.min(CHUNK_SIZE, snapshot.size - position));
          if (readSync(fd, chunk, 0, chunk.length, position) !== chunk.length) throw new Error('Short ledger read');
          ctx.bytesRead += chunk.length;
          position += chunk.length;
          const data = Buffer.concat([pending, chunk]);
          let start = 0;
          for (let i = 0; i < data.length; i++) {
            if (data[i] !== 10) continue;
            const row = parseLine(data.subarray(start, i).toString('utf8'));
            if (row && Date.parse(row.t) >= since) addRow(row);
            start = i + 1;
          }
          pending = data.subarray(start);
          offset = position - pending.length;
        }
        // A final line without a newline is retried by the next prepare/sync.
      } catch {
        ctx.failed = true;
      } finally {
        if (fd !== undefined) closeSync(fd);
      }
    },
    isBridge(requestIds) {
      return !ctx.failed && requestIds.some(id => id && bridgeRequests.has(id));
    },
    attribute(entries, kind) {
      const candidates = entries.filter(e => e.magpie);
      if (!candidates.length) return entries;
      ctx.prepare(kind === 'pi' && candidates.some(e => concrete(e.magpie.responseModel)));
      const cut = magpieStartTime(ctx.startAt);
      if (cut === null || ctx.failed) return entries;
      // OpenCode has no response id: require a one-to-one match in both
      // directions, including two local messages competing for one ledger row.
      const matches = new Map();
      const claims = new Map();
      for (const e of candidates) {
        const m = e.magpie;
        const pool = kind === 'opencode' ? sessions.get(m.sessionId) : responses.get(m.responseId);
        const rows = (pool || []).filter(row => {
          if (conflictingResponses.has(row.responseId)) return false;
          const counts = kind === 'codex'
            ? [row.input + row.cached + row.written, row.output, row.cached]
            : [row.input, row.output, row.cached, row.written];
          return countsEqual(m.counts, counts) && (kind !== 'opencode'
            || Math.abs(m.completed - row.completed) <= 2000);
        });
        matches.set(e, rows);
        if (kind === 'opencode') for (const row of rows) claims.set(row, (claims.get(row) || 0) + 1);
      }
      return entries.map(e => {
        if (!e.magpie || new Date(e.timestamp).getTime() < cut) return e;
        const m = e.magpie;
        let actual;
        let matched = false;
        if (kind === 'pi' && concrete(m.responseModel)) {
          actual = `magpie/${m.responseModel}`;
          matched = true;
        } else {
          const rows = matches.get(e);
          if (rows.length === 1 && (kind !== 'opencode' || claims.get(rows[0]) === 1)) {
            actual = rows[0].model;
            matched = !!actual;
          }
        }
        if (!matched && (kind !== 'claude' || isGroup(e.model))
          && now - new Date(e.timestamp).getTime() <= 600_000) {
          ctx.pending.push({ source: e.source, project: e.project,
            bucketStart: new Date(Math.floor(new Date(e.timestamp).getTime() / HALF_HOUR_MS) * HALF_HOUR_MS).toISOString() });
        }
        if (!actual || (!isGroup(e.model) && bareModel(actual) === bareModel(e.model))) return e;
        // Preserve Claude's existing fast marker without adding it twice.
        if (kind === 'claude' && m.fast && !/-(?:priority|fast|flex)$/.test(actual)) actual += '-fast';
        return { ...e, model: actual };
      });
    },
  };

  function addRow(row) {
    if (!Number.isInteger(row.status) || row.status < 200 || row.status >= 300
      || row.fallback || row.backfill || row.remote) return;
    if (row.provider === 'claude' && typeof row.rid === 'string' && row.rid
      && BRIDGE_AGENTS.has(row.agent)) bridgeRequests.add(row.rid);
    const counts = [row.in, row.out, row.cache_read, row.cache_write];
    if (!counts.every(n => Number.isSafeInteger(n) && n >= 0)) return;
    const actual = row.model === 'auto' ? row.served : row.model;
    const tier = ['priority', 'fast', 'flex'].includes(row.tier_served) ? `-${row.tier_served}` : '';
    const record = {
      responseId: row.response_id,
      model: concrete(actual) && typeof row.provider === 'string' && row.provider
        ? `magpie/${row.provider}/${actual}${tier}` : null,
      input: row.in, output: row.out, cached: row.cache_read, written: row.cache_write,
      completed: Date.parse(row.t) + (row.ms || 0),
    };
    if (row.response_id) {
      if (!responses.has(row.response_id)) responses.set(row.response_id, []);
      if (responses.get(row.response_id).some(previous => previous.model !== record.model)) conflictingResponses.add(row.response_id);
      responses.get(row.response_id).push(record);
    }
    if (row.agent === 'opencode' && row.session) {
      if (!sessions.has(row.session)) sessions.set(row.session, []);
      sessions.get(row.session).push(record);
    }
  }
  return ctx;
}
