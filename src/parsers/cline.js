import { readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { homedir } from 'node:os';
import { aggregateToBuckets, extractSessions } from './index.js';

const EXTENSION_ID = 'saoudrizwan.claude-dev';

// VSCode-fork application names that may host extensions.
const HOSTS = ['Code', 'Cursor', 'Windsurf', 'VSCodium', 'Code - Insiders', 'Trae', 'Trae CN'];

function getHostRoots() {
  const out = [];
  if (process.platform === 'darwin') {
    const base = join(homedir(), 'Library', 'Application Support');
    for (const h of HOSTS) out.push(join(base, h));
  } else if (process.platform === 'win32') {
    const appData = process.env.APPDATA?.trim() || join(homedir(), 'AppData', 'Roaming');
    for (const h of HOSTS) out.push(join(appData, h));
  } else {
    const xdg = process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), '.config');
    for (const h of HOSTS) out.push(join(xdg, h));
  }
  return out;
}

export function findClineExtensionDirs() {
  const dirs = [];
  for (const root of getHostRoots()) {
    const ext = join(root, 'User', 'globalStorage', EXTENSION_ID);
    try {
      if (statSync(ext).isDirectory()) dirs.push(ext);
    } catch {
      // not installed in this host; skip
    }
  }
  return dirs;
}

function readJsonSafe(path) {
  try { return JSON.parse(readFileSync(path, 'utf-8')); } catch { return null; }
}

function projectFromPath(absPath) {
  if (!absPath || typeof absPath !== 'string') return 'unknown';
  const trimmed = absPath.replace(/[\\/]+$/, '');
  const name = basename(trimmed);
  return name || 'unknown';
}

export async function parse() {
  const extDirs = findClineExtensionDirs();
  if (extDirs.length === 0) return { buckets: [], sessions: [] };

  const entries = [];
  const events = [];

  for (const extDir of extDirs) {
    const history = readJsonSafe(join(extDir, 'state', 'taskHistory.json'));
    if (!Array.isArray(history)) continue;

    for (const item of history) {
      try {
        if (!item || typeof item !== 'object' || !item.id) continue;
        const taskId = String(item.id);
        const project = projectFromPath(item.cwdOnTaskInitialization || item.shadowGitConfigWorkTree);
        const fallbackModel = (item.modelId && String(item.modelId).trim()) || 'cline-unknown';

        const messages = readJsonSafe(join(extDir, 'tasks', taskId, 'ui_messages.json'));
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
  }

  return { buckets: aggregateToBuckets(entries), sessions: extractSessions(events) };
}
