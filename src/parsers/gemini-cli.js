import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import { aggregateToBuckets, extractSessions } from './index.js';

const TMP_DIR = join(homedir(), '.gemini', 'tmp');

// Gemini CLI session storage:
//   ~/.gemini/tmp/<project_hash>/chats/session-<ts>-<id>.jsonl   (current, v0.39+)
//   ~/.gemini/tmp/<project_hash>/chats/session-<ts>-<id>.json    (legacy, single JSON object)
//   ~/.gemini/tmp/<project_hash>/chats/<parent_id>/<sub_id>.jsonl (subagent sessions, nested)
// The .jsonl migration (PR #23749, ~v0.39.0) made the old .json-only glob miss every new
// session — collect both extensions, and recurse one level for nested subagent files.

/**
 * Walk each project's chats/ directory and collect every session file
 * (both .json and .jsonl), descending into subagent subdirectories.
 */
function findSessionFiles(baseDir) {
  const results = [];
  if (!existsSync(baseDir)) return results;

  let projectDirs;
  try {
    projectDirs = readdirSync(baseDir, { withFileTypes: true });
  } catch {
    return results;
  }

  for (const entry of projectDirs) {
    if (!entry.isDirectory()) continue;
    collectChatFiles(join(baseDir, entry.name, 'chats'), results, 0);
  }
  return results;
}

function collectChatFiles(dir, out, depth) {
  if (depth > 2) return; // chats/ + nested subagent dirs is as deep as it goes
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      collectChatFiles(full, out, depth + 1);
    } else if (e.name.endsWith('.jsonl') || e.name.endsWith('.json')) {
      out.push(full);
    }
  }
}

/**
 * Read a session file into a uniform { messages, directories } shape.
 * .jsonl: line 1 is session metadata, each following line is one record.
 * .json:  a single ConversationRecord object with a messages[] array.
 */
function readRecords(filePath) {
  let raw;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }

  if (filePath.endsWith('.jsonl')) {
    const messages = [];
    let directories = null;
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let obj;
      try {
        obj = JSON.parse(trimmed);
      } catch {
        continue;
      }
      // The metadata line carries directories; message lines carry a `type`.
      if (!directories && Array.isArray(obj.directories)) directories = obj.directories;
      if (typeof obj.type === 'string' || typeof obj.role === 'string') messages.push(obj);
    }
    return { messages, directories };
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  return {
    messages: data.messages || data.history || [],
    directories: Array.isArray(data.directories) ? data.directories : null,
  };
}

// Model/assistant messages are recorded as type 'gemini'; user turns as 'user'.
// info/error/warning are system noise and skipped. `role` is accepted as a
// fallback for any older format that used it.
function classifyRole(msg) {
  const t = msg.type ?? msg.role;
  if (t === 'user') return 'user';
  if (t === 'gemini' || t === 'model' || t === 'assistant') return 'assistant';
  return null;
}

// Tokens live in msg.tokens.{input,output,cached,thoughts} (TokensSummary, where
// `input` already includes cached). Fall back to the raw Gemini API usageMetadata
// shape for any legacy record that stored it.
function extractTokens(msg) {
  const t = msg.tokens;
  if (t) {
    const cached = t.cached || 0;
    const thoughts = t.thoughts || 0;
    return {
      inputTokens: (t.input || 0) - cached,
      outputTokens: (t.output || 0) - thoughts,
      cachedInputTokens: cached,
      reasoningOutputTokens: thoughts,
    };
  }
  const u = msg.usageMetadata || msg.usage;
  if (u) {
    const cached = u.cachedContentTokenCount || 0;
    const thoughts = u.thoughtsTokenCount || 0;
    return {
      inputTokens: (u.promptTokenCount || u.input_tokens || 0) - cached,
      outputTokens: (u.candidatesTokenCount || u.output_tokens || 0) - thoughts,
      cachedInputTokens: cached,
      reasoningOutputTokens: thoughts,
    };
  }
  return null;
}

function projectFromDirectories(directories) {
  if (!directories || directories.length === 0) return 'unknown';
  const first = directories[0];
  if (!first) return 'unknown';
  return basename(String(first).replace(/[\\/]+$/, '')) || 'unknown';
}

export async function parse() {
  const sessionFiles = findSessionFiles(TMP_DIR);
  if (sessionFiles.length === 0) return { buckets: [], sessions: [] };

  const entries = [];
  const sessionEvents = [];

  for (const filePath of sessionFiles) {
    const record = readRecords(filePath);
    if (!record) continue;

    const project = projectFromDirectories(record.directories);

    for (const msg of record.messages) {
      const role = classifyRole(msg);
      if (!role) continue;

      const stamp = msg.timestamp || msg.createTime;
      if (!stamp) continue;
      const ts = new Date(stamp);
      if (isNaN(ts.getTime())) continue;

      sessionEvents.push({
        sessionId: filePath,
        source: 'gemini-cli',
        project,
        timestamp: ts,
        role,
      });

      if (role !== 'assistant') continue;
      const tokens = extractTokens(msg);
      if (!tokens) continue;

      entries.push({
        source: 'gemini-cli',
        model: msg.model || 'unknown',
        project,
        timestamp: ts,
        ...tokens,
      });
    }
  }

  return { buckets: aggregateToBuckets(entries), sessions: extractSessions(sessionEvents) };
}
