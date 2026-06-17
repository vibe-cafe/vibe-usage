import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { aggregateToBuckets, extractSessions } from './index.js';

const TRAE_HOSTS = ['Trae CN', 'Trae', 'TRAE SOLO CN'];

function getTraeUserDirs() {
  const out = [];
  if (process.platform === 'darwin') {
    const base = join(homedir(), 'Library', 'Application Support');
    for (const h of TRAE_HOSTS) out.push(join(base, h, 'User'));
  } else if (process.platform === 'win32') {
    const appData = process.env.APPDATA?.trim() || join(homedir(), 'AppData', 'Roaming');
    for (const h of TRAE_HOSTS) out.push(join(appData, h, 'User'));
  } else {
    const xdg = process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), '.config');
    for (const h of TRAE_HOSTS) out.push(join(xdg, h, 'User'));
  }
  return out.filter(existsSync);
}

function findChatSessionFiles() {
  const files = [];
  for (const userDir of getTraeUserDirs()) {
    const wsDir = join(userDir, 'workspaceStorage');
    if (existsSync(wsDir)) {
      for (const ws of readdirSync(wsDir, { withFileTypes: true })) {
        if (!ws.isDirectory()) continue;
        const csDir = join(wsDir, ws.name, 'chatSessions');
        if (!existsSync(csDir)) continue;
        for (const f of readdirSync(csDir)) {
          if (f.endsWith('.jsonl')) files.push({ path: join(csDir, f), project: readProjectName(join(wsDir, ws.name)) });
        }
      }
    }
    const ewDir = join(userDir, 'globalStorage', 'emptyWindowChatSessions');
    if (existsSync(ewDir)) {
      for (const f of readdirSync(ewDir)) {
        if (f.endsWith('.jsonl')) files.push({ path: join(ewDir, f), project: 'unknown' });
      }
    }
  }
  return files;
}

function readProjectName(wsDir) {
  try {
    const meta = JSON.parse(readFileSync(join(wsDir, 'workspace.json'), 'utf-8'));
    const uri = meta.folder || meta.workspace?.folders?.[0]?.uri || '';
    const match = String(uri).match(/file:\/\/(.+)/);
    if (match) {
      const parts = match[1].replace(/\/$/, '').split('/');
      return parts[parts.length - 1] || 'unknown';
    }
  } catch {}
  return 'unknown';
}

function extractModelFromDetails(details) {
  const name = details.split('•')[0].trim();
  if (!name) return 'unknown';
  return name.toLowerCase().replace(/\s+/g, '-');
}

function parseSessionFile(filePath, project) {
  const entries = [];
  const sessionEvents = [];
  let raw;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch {
    return { entries, sessionEvents };
  }

  const lines = raw.split('\n').filter(l => l.trim());
  if (lines.length === 0) return { entries, sessionEvents };

  let sessionId = '';
  let creationDate = null;
  let pendingMetadata = null;
  let pendingModel = 'unknown';

  for (const line of lines) {
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }

    const kind = obj.kind;
    const v = obj.v;

    if (kind === 0 && v && typeof v === 'object') {
      sessionId = v.sessionId || '';
      creationDate = v.creationDate || null;
      continue;
    }

    if (kind !== 1 || !v || typeof v !== 'object') continue;

    if (v.metadata && typeof v.metadata === 'object') {
      const meta = v.metadata;
      const promptTokens = Number(meta.promptTokens) || 0;
      const outputTokens = Number(meta.outputTokens) || 0;
      if (promptTokens > 0 || outputTokens > 0) {
        pendingMetadata = { promptTokens, outputTokens };
        if (v.resolvedModel) {
          pendingModel = String(v.resolvedModel);
        } else if (v.details) {
          pendingModel = extractModelFromDetails(String(v.details));
        }
      }
      continue;
    }

    if (v.completedAt && pendingMetadata) {
      const ts = new Date(Number(v.completedAt));
      if (!isNaN(ts.getTime())) {
        entries.push({
          source: 'trae',
          model: pendingModel,
          project,
          timestamp: ts,
          inputTokens: pendingMetadata.promptTokens,
          outputTokens: pendingMetadata.outputTokens,
          cachedInputTokens: 0,
          reasoningOutputTokens: 0,
        });
        if (sessionId) {
          sessionEvents.push({
            sessionId,
            source: 'trae',
            project,
            timestamp: ts,
            role: 'assistant',
          });
        }
      }
      pendingMetadata = null;
      continue;
    }
  }

  if (pendingMetadata) {
    let ts = creationDate ? new Date(Number(creationDate)) : null;
    if (!ts || isNaN(ts.getTime())) {
      try { ts = statSync(filePath).mtime; } catch { ts = new Date(); }
    }
    entries.push({
      source: 'trae',
      model: pendingModel,
      project,
      timestamp: ts,
      inputTokens: pendingMetadata.promptTokens,
      outputTokens: pendingMetadata.outputTokens,
      cachedInputTokens: 0,
      reasoningOutputTokens: 0,
    });
  }

  return { entries, sessionEvents };
}

export async function parse() {
  const files = findChatSessionFiles();
  const allEntries = [];
  const allEvents = [];

  for (const { path, project } of files) {
    const { entries, sessionEvents } = parseSessionFile(path, project);
    allEntries.push(...entries);
    allEvents.push(...sessionEvents);
  }

  return {
    buckets: aggregateToBuckets(allEntries),
    sessions: extractSessions(allEvents),
  };
}
