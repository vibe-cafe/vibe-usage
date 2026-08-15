import { statSync } from 'node:fs';
import { join } from 'node:path';
import { aggregateToBuckets, extractSessions } from './aggregate.js';
import { readJsonSafe, projectFromPath } from './fs-utils.js';
import { findClineDataDirs } from '../cline-roots.js';

export async function parse() {
  const extDirs = findClineDataDirs();
  if (extDirs.length === 0) return { buckets: [], sessions: [] };

  const entries = [];
  const events = [];

  const candidates = new Map();
  for (const extDir of extDirs) {
    const history = readJsonSafe(join(extDir, 'state', 'taskHistory.json'));
    if (!Array.isArray(history)) continue;

    for (const item of history) {
      if (!item || typeof item !== 'object' || !item.id) continue;
      const taskId = String(item.id);
      const messagesPath = join(extDir, 'tasks', taskId, 'ui_messages.json');
      let stat;
      try {
        stat = statSync(messagesPath);
      } catch {
        continue;
      }
      const key = item.ulid ? String(item.ulid) : taskId;
      const next = { item, taskId, messagesPath, size: stat.size, mtimeMs: stat.mtimeMs };
      const current = candidates.get(key);
      if (!current || next.size > current.size || (
        next.size === current.size && next.mtimeMs > current.mtimeMs
      )) candidates.set(key, next);
    }
  }

  for (const { item, taskId, messagesPath } of candidates.values()) {
      try {
        const project = projectFromPath(
          item.cwdOnTaskInitialization || item.shadowGitConfigWorkTree || item.cwd,
        );
        const fallbackModel = (item.modelId && String(item.modelId).trim()) || 'cline-unknown';

        const messages = readJsonSafe(messagesPath);
        if (!Array.isArray(messages)) continue;

        for (const msg of messages) {
          if (!msg || typeof msg !== 'object') continue;
          const ts = Number(msg.ts);
          if (!Number.isFinite(ts)) continue;
          const timestamp = new Date(ts);

          if (msg.type === 'say' && msg.say === 'api_req_started') {
            let info = null;
            try { info = JSON.parse(msg.text); } catch { /* skip */ }
            if (!info) continue;

            const inputTokens = Math.max(0, Number(info.tokensIn) || 0);
            const outputTokens = Math.max(0, Number(info.tokensOut) || 0);
            const cacheWrites = Math.max(0, Number(info.cacheWrites) || 0);
            const cacheReads = Math.max(0, Number(info.cacheReads) || 0);
            if (inputTokens + outputTokens + cacheWrites + cacheReads === 0) continue;

            // Newer Cline embeds the model id directly on the api_req_started payload.
            const model = (info.model && String(info.model).trim()) || fallbackModel;

            // Bucket schema (matches Cursor's CSV semantics):
            //   inputTokens       = non-cache input + cache-write tokens (both billed as input)
            //   cachedInputTokens = cache-read tokens (10% input rate)
            entries.push({
              source: 'cline',
              model,
              project,
              timestamp,
              inputTokens: inputTokens + cacheWrites,
              outputTokens,
              cachedInputTokens: cacheReads,
              reasoningOutputTokens: 0,
            });
            events.push({ sessionId: taskId, source: 'cline', project, timestamp, role: 'assistant' });
          } else if (msg.type === 'ask' || (msg.type === 'say' && msg.say === 'user_feedback')) {
            events.push({ sessionId: taskId, source: 'cline', project, timestamp, role: 'user' });
          }
        }
      } catch {
        // Skip this task; keep going for the rest of the history.
      }
  }

  return { buckets: aggregateToBuckets(entries), sessions: extractSessions(events) };
}
