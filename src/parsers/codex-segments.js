import { createHash } from 'node:crypto';
import { sameSignature } from './codex-cache.js';
import { normalizeUsageRecord } from './codex-usage-record.js';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('base64url');
function pick(value, keys) {
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(keys.filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]]));
}
const usageKeys = ['input_tokens', 'output_tokens', 'cached_input_tokens', 'cache_read_input_tokens', 'reasoning_output_tokens', 'total_tokens'];

// Retain only fields consumed by the existing token/timing parser. Full JSON is
// hashed transiently to identify exact copies; chat/tool text is never retained.
function accountingRecord(obj, context) {
  obj = normalizeUsageRecord(obj);
  const next = { type: obj.type, timestamp: obj.timestamp };
  const p = obj.payload;
  if (obj.type === 'session_meta' && p) {
    next.payload = pick(p, ['id', 'timestamp', 'cwd', 'forked_from_id', 'parent_thread_id', 'thread_source', 'model_provider']);
    if (p.git) next.payload.git = pick(p.git, ['repository_url']);
    if (typeof p.source === 'string') next.payload.source = p.source;
    else if (p.source && typeof p.source === 'object' && 'subagent' in p.source) {
      next.payload.source = { subagent: { thread_spawn: pick(p.source.subagent?.thread_spawn, ['parent_thread_id']) } };
    }
  } else if (obj.type === 'turn_context') {
    next.payload = pick(p, ['model', 'service_tier']);
  } else if (obj.type === 'event_msg' && p) {
    next.payload = pick(p, ['type', 'started_at', 'model', 'usage_record', 'response_id']);
    if (p.type === 'token_count') {
      next._tokenFingerprint = hash(p).slice(0, 16);
      next._segmentContext = { ...context };
      if (p.info) next.payload.info = {
        ...pick(p.info, ['model']),
        total_token_usage: pick(p.info.total_token_usage, usageKeys),
        last_token_usage: pick(p.info.last_token_usage, usageKeys),
      };
    } else if (p.type === 'thread_settings_applied') {
      next.payload.thread_settings = pick(p.thread_settings, ['model', 'service_tier']);
    }
  }
  return JSON.stringify(next);
}

/**
 * Merge exact cross-file copies with multiplicity: occurrence N of a record in
 * one file matches occurrence N in another. Repetitions within a file survive.
 * Preserve each file's order (including rewritten-timestamp fork replay); use
 * timestamps only to order independent segments. Contradictory order fails the
 * source instead of inventing a potentially double-counting sequence.
 */
export async function mergeCodexSegments(members, readLines) {
  if (members.length === 1) return singleSegmentRecords(members[0], readLines);
  const nodes = new Map();
  let canonicalKey = null;
  for (const [fileIndex, file] of members.entries()) {
    const occurrences = new Map();
    let previous = null;
    const context = {};
    for await (const line of readLines(file.filePath, file.snapshotSize)) {
      let obj;
      try { obj = JSON.parse(line); } catch { continue; }
      if (!obj || typeof obj !== 'object') continue;
      const settings = obj.type === 'turn_context' ? obj.payload
        : obj.type === 'event_msg' && obj.payload?.type === 'thread_settings_applied' ? obj.payload.thread_settings : null;
      if (settings?.model) context.model = settings.model;
      if (Object.hasOwn(settings || {}, 'service_tier')) context.serviceTier = settings.service_tier;
      const fingerprint = hash(obj);
      const occurrence = (occurrences.get(fingerprint) || 0) + 1;
      occurrences.set(fingerprint, occurrence);
      const key = `${fingerprint}:${occurrence}`;
      if (fileIndex === 0 && canonicalKey === null && obj.type === 'session_meta') canonicalKey = key;
      if (!nodes.has(key)) nodes.set(key, {
        key, line: accountingRecord(obj, context), time: Date.parse(obj.timestamp),
        ordinal: nodes.size, successors: new Set(), incoming: 0,
      });
      if (previous && previous !== key && !nodes.get(previous).successors.has(key)) {
        nodes.get(previous).successors.add(key);
        nodes.get(key).incoming++;
      }
      previous = key;
    }
  }
  const ready = [...nodes.values()].filter(node => !node.incoming);
  const result = [];
  function compare(a, b) {
    if (a.key === canonicalKey || b.key === canonicalKey) return a.key === canonicalKey ? -1 : 1;
    if (Number.isFinite(a.time) && Number.isFinite(b.time) && a.time !== b.time) return a.time - b.time;
    return a.ordinal - b.ordinal;
  }
  while (ready.length) {
    ready.sort(compare);
    const node = ready.shift();
    result.push(node.line);
    for (const key of node.successors) {
      const next = nodes.get(key);
      if (--next.incoming === 0) ready.push(next);
    }
  }
  if (result.length !== nodes.size) throw new Error('Codex continuation copies have conflicting record order');
  return result;
}

/**
 * mergeCodexSegments() of one file, without the graph. Within one file every
 * record is a new node (occurrence N of a fingerprint is a new key), joined to
 * the previous one, so the graph is a single path and the merge returns the
 * records in file order. Hashing every full record (chat and tool text
 * included) to build that path is most of the cost of a merge.
 */
async function singleSegmentRecords(file, readLines) {
  const result = [];
  const context = {};
  for await (const line of readLines(file.filePath, file.snapshotSize)) {
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    if (!obj || typeof obj !== 'object') continue;
    const settings = obj.type === 'turn_context' ? obj.payload
      : obj.type === 'event_msg' && obj.payload?.type === 'thread_settings_applied' ? obj.payload.thread_settings : null;
    if (settings?.model) context.model = settings.model;
    if (Object.hasOwn(settings || {}, 'service_tier')) context.serviceTier = settings.service_tier;
    result.push(accountingRecord(obj, context));
  }
  return result;
}

/**
 * What a group of copies of one session (sorted as for the merge) is merged
 * from, and which of its members name its cache entry.
 *
 * Members with the same content form one class: hard links of one file (same
 * stat signature: Orca links every rollout into each account's home), and a
 * compressed rollout proven byte-identical to a plain member when its replay
 * index was built (`copyOf` in its cache entry, valid while that member's
 * signature is unchanged). A later member of a class already merged adds no
 * record and no order to the merge, so `read` -- one member per class, at the
 * class's first position, a plain one where possible -- merges to exactly the
 * same records as all members.
 *
 * `identity` is the members without those proven compressed copies, when that
 * leaves the same sequence of classes; otherwise all members. A copy then
 * leaves the group's cache entry where it was before Codex compressed its home's
 * file: the copy in `~/.codex` of a conversation Orca also keeps does not make
 * every such group merge again. Equal class sequences merge to the same
 * records, so an entry made from either member list is exact for both.
 */
export function planCodexSegments(members) {
  const parent = members.map((_, i) => i);
  const find = i => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const copies = new Set();
  for (let i = 0; i < members.length; i++) {
    for (let j = 0; j < i; j++) {
      if (sameSignature(members[i].signature, members[j].signature)) parent[find(i)] = find(j);
    }
    const copyOf = members[i].compressed ? members[i].cache?.copyOf : null;
    const j = copyOf ? members.findIndex(other => !other.compressed
      && other.filePath === copyOf.filePath && sameSignature(other.signature, copyOf.signature)) : -1;
    if (j >= 0) {
      parent[find(i)] = find(j);
      copies.add(i);
    }
  }
  const classSequence = indexes => {
    const seen = new Set();
    return indexes.map(find).filter(cls => !seen.has(cls) && seen.add(cls));
  };
  const all = members.map((_, i) => i);
  const kept = all.filter(i => !copies.has(i));
  const identity = kept.length < all.length
    && classSequence(kept).join() === classSequence(all).join() ? kept : all;
  const read = classSequence(all).map(cls => {
    const same = all.filter(i => find(i) === cls);
    return members[same.find(i => !members[i].compressed) ?? same[0]];
  });
  return { identity: identity.map(i => members[i]), read };
}

// The disposable group cache is invalidated by ANY member of its identity (see
// planCodexSegments()) changing, appearing, disappearing, or moving. It never
// shares the selected physical file's cache.
export function codexSegmentSignature(members) {
  return {
    size: members.reduce((sum, file) => sum + file.snapshotSize, 0),
    mtimeMs: Math.max(...members.map(file => file.signature.mtimeMs)),
    dev: 'codex-segments',
    ino: hash(members.map(file => [file.filePath, file.signature]).sort((a, b) => a[0].localeCompare(b[0]))),
  };
}
