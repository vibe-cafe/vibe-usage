import { projectFromCwd, toCount } from './fs-utils.js';
import { aggregateToBuckets, extractSessions } from './aggregate.js';
import { isSqliteUnavailableError, queryDbJsonSnapshotOnLock, sqliteUnavailableError } from './sqlite.js';
import { findKiloDbs } from '../kilo-roots.js';

const SOURCE = 'kilo';
// One statement gives a consistent SQLite view, including a live WAL. Only
// individual allow-listed fields cross the SQL boundary. Malformed JSON or an
// incompatible schema throws: silently omitting records would prune sync state.
const USAGE_SQL = `
 SELECT 'session' AS kind, s.id AS recordId, s.id AS sessionId,
   s.parent_id AS parentId, s.directory AS directory, s.time_created AS columnCreated,
   NULL AS dataCreated, NULL AS messageId, NULL AS role, NULL AS model,
   NULL AS cwdPath, NULL AS rootPath,
   NULL AS inputTokens, NULL AS outputTokens, NULL AS reasoningTokens,
   NULL AS cacheReadTokens, NULL AS cacheWriteTokens,
   NULL AS stepStart, NULL AS generationId, NULL AS vercelId
 FROM session s
 UNION ALL
 SELECT 'message', m.id, m.session_id, NULL, NULL, m.time_created,
   json_extract(m.data, '$.time.created'), m.id,
   json_extract(m.data, '$.role'),
   coalesce(json_extract(m.data, '$.modelID'), json_extract(m.data, '$.modelId'),
     json_extract(m.data, '$.model.modelID'), json_extract(m.data, '$.model.id')),
   json_extract(m.data, '$.path.cwd'), json_extract(m.data, '$.path.root'),
   json_extract(m.data, '$.tokens.input'), json_extract(m.data, '$.tokens.output'),
   json_extract(m.data, '$.tokens.reasoning'), json_extract(m.data, '$.tokens.cache.read'),
   json_extract(m.data, '$.tokens.cache.write'), NULL, NULL, NULL
 FROM message m
 UNION ALL
 SELECT 'part', p.id, p.session_id, NULL, NULL, p.time_created, NULL, p.message_id, NULL,
   coalesce(json_extract(p.data, '$.model.modelID'), json_extract(p.data, '$.model.modelId'),
     json_extract(p.data, '$.model.id')),
   NULL, NULL,
   json_extract(p.data, '$.tokens.input'), json_extract(p.data, '$.tokens.output'),
   json_extract(p.data, '$.tokens.reasoning'), json_extract(p.data, '$.tokens.cache.read'),
   json_extract(p.data, '$.tokens.cache.write'), json_extract(p.data, '$.time.start'),
   json_extract(p.data, '$.generationID'), json_extract(p.data, '$.vercelID')
 FROM part p WHERE json_extract(p.data, '$.type') = 'step-finish'
 ORDER BY columnCreated, recordId
`;

const ROUTING_LABELS = new Set(['auto', 'default', 'default-model', 'balanced', 'free', 'fast', 'performance', 'efficient', 'lite', 'ultimate']);

// Preserve concrete provider/model ids, including slash-bearing ids. Only
// generic routing words need a namespace to avoid another tool's price entry.
export function resolveKiloModel(raw) {
  const model = typeof raw === 'string' ? raw.trim() : '';
  if (!model) return 'unknown';
  return ROUTING_LABELS.has(model.toLowerCase()) ? `kilo-${model.toLowerCase()}` : model;
}

function timestampFrom(...values) {
  for (const raw of values) {
    if (raw == null || raw === '') continue;
    const number = Number(raw);
    const date = Number.isFinite(number) && number > 0
      ? new Date(number < 1e12 ? number * 1000 : number)
      : (typeof raw === 'string' ? new Date(raw) : null);
    if (date && Number.isFinite(date.getTime())) return date;
  }
  return null;
}

function tokensFor(row) {
  return {
    inputTokens: toCount(row.inputTokens),
    outputTokens: toCount(row.outputTokens),
    cachedInputTokens: toCount(row.cacheReadTokens),
    reasoningOutputTokens: toCount(row.reasoningTokens),
    cacheCreation5mTokens: toCount(row.cacheWriteTokens),
  };
}
const footprint = tokens => Object.values(tokens).reduce((sum, n) => sum + n, 0);
const rowFootprint = row => footprint(tokensFor(row));
const keyFor = (session, id) => JSON.stringify([session, id]);
const text = value => typeof value === 'string' && value.trim() ? value.trim() : null;

function projectFor(message, session) {
  // Kilo may record path.root='/' even though cwd identifies the workspace.
  return projectFromCwd(message.cwdPath || session?.directory || message.rootPath);
}

function logicalRoots(sessions) {
  const result = new Map();
  for (const id of sessions.keys()) {
    const visited = new Set();
    let current = id;
    while (true) {
      if (visited.has(current)) {
        // No trustworthy root for a cycle or a chain into one: fail open as
        // this physical session, rather than discarding its human prompts.
        result.set(id, id);
        break;
      }
      visited.add(current);
      const parent = sessions.get(current)?.parentId;
      if (!parent || !sessions.has(parent)) {
        result.set(id, current);
        break;
      }
      current = parent;
    }
  }
  return result;
}

function requestIds(call) {
  return [call.generationId && `g:${call.generationId}`, call.vercelId && `v:${call.vercelId}`].filter(Boolean);
}

function sameCall(a, b) {
  if (a.timestamp.getTime() !== b.timestamp.getTime()) return false;
  const aIds = requestIds(a), bIds = requestIds(b);
  if (aIds.length && bIds.length) return aIds.some(id => bIds.includes(id));
  return a.model === b.model && JSON.stringify(a.tokens) === JSON.stringify(b.tokens);
}

// Forks regenerate message/part ids but preserve request ids and original
// timestamps. A cross-session match may suppress usage only when it precedes
// the target session's creation and a matching earlier physical copy exists.
// Pair occurrences within each target session: repeated local calls stay real.
function dedupeReplay(calls, sessions) {
  const ordered = [...calls].sort((a, b) => (
    (sessions.get(a.sessionId)?.createdAt?.getTime() ?? Infinity)
      - (sessions.get(b.sessionId)?.createdAt?.getTime() ?? Infinity)
    || a.timestamp - b.timestamp || a.messageId.localeCompare(b.messageId)
    || a.recordId.localeCompare(b.recordId)
  ));
  const byTime = new Map();
  const survivors = [];
  const paired = new Map();
  const copySources = new Map();
  const copiedCalls = new Set();
  for (const call of ordered) {
    const created = sessions.get(call.sessionId)?.createdAt?.getTime();
    const time = call.timestamp.getTime();
    const candidates = byTime.get(time) || [];
    const used = paired.get(call.sessionId) || new Set();
    const original = created != null && time < created
      ? candidates.find(other => other.sessionId !== call.sessionId
        && (sessions.get(other.sessionId)?.createdAt?.getTime() ?? Infinity) < created
        && !used.has(other) && sameCall(call, other))
      : null;
    if (original) {
      used.add(original);
      paired.set(call.sessionId, used);
      copiedCalls.add(call);
      if (!copySources.has(call.sessionId)) copySources.set(call.sessionId, new Set());
      copySources.get(call.sessionId).add(original.sessionId);
      if (footprint(call.tokens) > footprint(original.tokens)
        || (footprint(call.tokens) === footprint(original.tokens) && call.hasStepModel && !original.hasStepModel)) {
        original.tokens = call.tokens;
        original.model = call.model;
        original.hasStepModel = call.hasStepModel;
      }
      continue;
    }
    candidates.push(call);
    byTime.set(time, candidates);
    survivors.push(call);
  }
  return { survivors, copySources, copiedCalls };
}

function copiedTiming(messages, sessions, copySources, calls, copiedCalls) {
  const excluded = new Set();
  const messageCalls = new Map();
  for (const call of calls) {
    if (!messageCalls.has(call.messageKey)) messageCalls.set(call.messageKey, []);
    messageCalls.get(call.messageKey).push(call);
  }
  for (const [key, usage] of messageCalls) {
    if (usage.every(call => copiedCalls.has(call))) excluded.add(key);
  }
  const bySession = new Map();
  for (const message of messages.values()) {
    if (!bySession.has(message.sessionId)) bySession.set(message.sessionId, []);
    bySession.get(message.sessionId).push(message);
  }
  for (const [target, sources] of copySources) {
    const created = sessions.get(target)?.createdAt?.getTime();
    const used = new Set();
    for (const message of bySession.get(target) || []) {
      if (!message.timestamp || !(message.timestamp.getTime() < created)) continue;
      if (message.role !== 'user' && message.role !== 'assistant') continue;
      for (const source of sources) {
        const original = (bySession.get(source) || []).find(other => !used.has(other)
          && other.timestamp?.getTime() === message.timestamp.getTime()
          && other.role === message.role);
        if (original) {
          used.add(original);
          excluded.add(message.key);
          break;
        }
      }
    }
  }
  return excluded;
}

export async function parse() {
  const warnings = [];
  const dbs = findKiloDbs({ onWarning: warning => warnings.push(warning) });
  const sessions = new Map(), messages = new Map(), parts = new Map();
  for (const path of dbs) {
    let rows;
    try {
      rows = queryDbJsonSnapshotOnLock(path, USAGE_SQL, { tempPrefix: 'vibe-usage-kilo-' });
    } catch (error) {
      if (isSqliteUnavailableError(error)) throw sqliteUnavailableError('Kilo');
      warnings.push(`Kilo: 无法读取 ${path}: ${error.message}`);
      continue;
    }
    for (const row of rows) {
      const sessionId = String(row.sessionId);
      if (row.kind === 'session') {
        const candidate = { parentId: text(row.parentId), directory: text(row.directory), createdAt: timestampFrom(row.columnCreated) };
        const prior = sessions.get(sessionId);
        if (!prior || (candidate.createdAt && (!prior.createdAt || candidate.createdAt < prior.createdAt))) sessions.set(sessionId, candidate);
        continue;
      }
      const key = keyFor(sessionId, row.recordId);
      const collection = row.kind === 'message' ? messages : parts;
      const previous = collection.get(key);
      if (!previous || rowFootprint(row) > rowFootprint(previous)
        || (rowFootprint(row) === rowFootprint(previous) && text(row.model) && !text(previous.model))) {
        collection.set(key, { ...row, sessionId, key, timestamp: timestampFrom(row.dataCreated, row.columnCreated) });
      }
    }
  }
  if (warnings.length) return { buckets: [], sessions: [], skipped: true, warnings };

  const roots = logicalRoots(sessions);
  const partsByMessage = new Map();
  for (const part of parts.values()) {
    const key = keyFor(part.sessionId, part.messageId);
    if (!partsByMessage.has(key)) partsByMessage.set(key, []);
    partsByMessage.get(key).push(part);
  }
  const calls = [];
  for (const message of messages.values()) {
    if (message.role !== 'assistant') continue;
    const add = (row, timestamp, step) => {
      const tokens = tokensFor(row);
      if (!timestamp || footprint(tokens) === 0) return;
      calls.push({
        sessionId: message.sessionId, messageId: message.messageId, recordId: row.recordId,
        messageKey: message.key, timestamp, tokens,
        model: resolveKiloModel(text(row.model) || message.model), hasStepModel: Boolean(step && text(row.model)),
        project: projectFor(message, sessions.get(message.sessionId)),
        generationId: text(row.generationId), vercelId: text(row.vercelId),
      });
    };
    const steps = (partsByMessage.get(message.key) || []).filter(part => rowFootprint(part) > 0);
    if (steps.length) {
      for (const step of steps) add(step, timestampFrom(step.stepStart, step.columnCreated, message.dataCreated, message.columnCreated), true);
    } else {
      add(message, message.timestamp, false);
    }
  }
  const { survivors, copySources, copiedCalls } = dedupeReplay(calls, sessions);
  const excluded = copiedTiming(messages, sessions, copySources, calls, copiedCalls);
  const events = [], humanSessions = new Set();
  for (const message of messages.values()) {
    if (!message.timestamp || excluded.has(message.key) || !['user', 'assistant'].includes(message.role)) continue;
    const root = roots.get(message.sessionId) || message.sessionId;
    const human = message.role === 'user' && root === message.sessionId;
    if (human) humanSessions.add(root);
    events.push({ source: SOURCE, sessionId: root,
      project: projectFor(message, sessions.get(root) || sessions.get(message.sessionId)),
      timestamp: message.timestamp, role: human ? 'user' : 'assistant' });
  }
  return {
    buckets: aggregateToBuckets(survivors.map(call => ({ source: SOURCE, model: call.model,
      project: call.project, timestamp: call.timestamp, ...call.tokens }))),
    sessions: extractSessions(events.filter(event => humanSessions.has(event.sessionId))),
  };
}
