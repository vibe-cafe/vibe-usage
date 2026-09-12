import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { projectFromCwd, toCount } from './fs-utils.js';

// Verified with the shipped cline 3.0.61 / @cline/core 0.0.82. SQLite is only
// the session index: per-call accounting lives in version-1 messages artifacts.
// Read canonical artifacts, not DB prompt/metadata columns or provider settings.
export function readClineSdk(sessionDirs, onWarning) {
  const copies = [];
  for (const dir of sessionDirs) {
    let children;
    try { children = readdirSync(dir, { withFileTypes: true }); }
    catch (err) { onWarning(`cline: 无法读取会话目录 ${dir}: ${err.message}`); continue; }
    for (const child of children) {
      if (!child.isDirectory()) continue;
      const sessionDir = join(dir, child.name);
      let files, manifest;
      try {
        files = readdirSync(sessionDir, { withFileTypes: true })
          .filter(file => file.isFile() && file.name.endsWith('.messages.json'));
        if (!files.length) continue;
        manifest = JSON.parse(readFileSync(join(sessionDir, `${child.name}.json`), 'utf8'));
        if (manifest?.version !== 1 || manifest.session_id !== child.name) {
          throw new Error('unsupported or inconsistent Cline session manifest');
        }
      } catch (err) {
        onWarning(`cline: 无法读取会话目录 ${sessionDir}: ${err.message}`);
        continue;
      }
      for (const file of files) {
        const messagesPath = join(sessionDir, file.name);
        try {
          const payload = JSON.parse(readFileSync(messagesPath, 'utf8'));
          if (payload?.version !== 1 || !Array.isArray(payload.messages)
            || typeof payload.sessionId !== 'string'
            || (payload.sessionId !== child.name && payload.origin?.parentThreadId !== child.name)) {
            throw new Error('unsupported or inconsistent Cline session artifact');
          }
          const project = projectFromCwd(manifest.workspace_root || manifest.cwd);
          // Reduce immediately to accounting/timing metadata. No prompt, response,
          // system prompt, tool arguments, credentials, or stored costs survive.
          const messages = payload.messages.flatMap(message => {
            if (!message || !['user', 'assistant'].includes(message.role)) return [];
            if (message.role === 'user' && (payload.agent !== 'lead'
              || message.metadata?.kind || message.metadata?.userRunSpan === 0
              || ['system', 'status', 'error', 'tool'].includes(message.metadata?.displayRole)
              || (Array.isArray(message.content) && message.content.some(block =>
                block?.type === 'tool_result' || block?.type === 'tool-result')))) return [];
            if (typeof message.ts !== 'number' || !Number.isFinite(message.ts)
              || !Number.isFinite(new Date(message.ts).getTime())) return [];
            // Legacy migration inserts a cumulative metric on an old assistant
            // without a timestamp. Never re-date that summary to the migration.
            const metric = message.role === 'assistant' ? message.metrics : null;
            const input = toCount(metric?.inputTokens);
            const cachedInputTokens = Math.min(input, toCount(metric?.cacheReadTokens));
            return [{
              id: typeof message.id === 'string' ? message.id : null,
              role: message.role,
              timestamp: message.ts,
              model: message.modelInfo?.id || manifest.model || 'cline-unknown',
              inputTokens: input - cachedInputTokens,
              outputTokens: toCount(metric?.outputTokens),
              cachedInputTokens,
            }];
          });
          copies.push({ sessionId: child.name, artifactId: payload.sessionId, project, messages,
            // Restored/forked artifacts retain message ids/timestamps; attribute
            // shared history to the earliest original session deterministically.
            started: Date.parse(manifest.started_at) || 0, messagesPath });
        } catch (err) {
          onWarning(`cline: 无法读取会话 ${messagesPath}: ${err.message}`);
        }
      }
    }
  }
  copies.sort((a, b) => a.started - b.started
    || a.sessionId.localeCompare(b.sessionId) || a.messagesPath.localeCompare(b.messagesPath));
  const records = new Map();
  for (const copy of copies) {
    copy.messages.forEach((message, index) => {
      // Anonymous messages can be deduplicated only within copies of this
      // logical session; equal usage in unrelated sessions remains distinct.
      const identity = message.id || `${copy.artifactId}:${index}`;
      const key = JSON.stringify([identity, message.role, message.timestamp]);
      const next = { ...message, sessionId: copy.sessionId, project: copy.project };
      const old = records.get(key);
      const count = value => value.inputTokens + value.outputTokens + value.cachedInputTokens;
      if (!old) records.set(key, next);
      else if (count(next) > count(old)) {
        records.set(key, { ...next, sessionId: old.sessionId, project: old.project });
      }
    });
  }
  const entries = [], events = [];
  for (const message of records.values()) {
    const base = { source: 'cline', project: message.project, timestamp: new Date(message.timestamp) };
    if (message.role === 'assistant'
      && message.inputTokens + message.outputTokens + message.cachedInputTokens > 0) {
      entries.push({ ...base, model: message.model, inputTokens: message.inputTokens,
        outputTokens: message.outputTokens, cachedInputTokens: message.cachedInputTokens,
        reasoningOutputTokens: 0 });
    }
    events.push({ ...base, sessionId: message.sessionId, role: message.role });
  }
  return { entries, events };
}
