import { loadSessionData } from 'ccusage/data-loader';
import { aggregateToBuckets } from './index.js';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';

const STATE_FILE = join(homedir(), '.vibe-usage', 'claude-code-state.json');

/** Pending state staged during parse(), committed only after successful upload. */
let _pendingState = null;

function loadState() {
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
  } catch {
    return {};
  }
}

function saveState(state) {
  const dir = join(homedir(), '.vibe-usage');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state), 'utf-8');
}

/**
 * Commit pending state to disk.
 * Called by sync.js AFTER successful upload to ensure we only advance
 * the watermark when data has been safely delivered to the server.
 */
export function commitState() {
  if (_pendingState) {
    saveState(_pendingState);
    _pendingState = null;
  }
}

export async function parse() {
  let sessions;
  try {
    sessions = await loadSessionData({ mode: 'display' });
  } catch {
    return [];
  }

  if (!sessions || sessions.length === 0) return [];

  const state = loadState();
  const nextState = { ...state };
  const entries = [];

  for (const session of sessions) {

    const project = resolveProject(session);
    const sessionKey = `${session.projectPath}\0${session.sessionId}`;
    const prev = state[sessionKey] || {};

    for (const breakdown of session.modelBreakdowns || []) {
      const model = breakdown.modelName;
      const prevModel = prev[model] || { i: 0, o: 0, c: 0 };

      const deltaInput = (breakdown.inputTokens || 0) - (prevModel.i || 0);
      const deltaOutput = (breakdown.outputTokens || 0) - (prevModel.o || 0);
      const deltaCached = (breakdown.cacheReadTokens || 0) - (prevModel.c || 0);

      // Always record current cumulative totals for next sync
      if (!nextState[sessionKey]) nextState[sessionKey] = {};
      nextState[sessionKey][model] = {
        i: breakdown.inputTokens || 0,
        o: breakdown.outputTokens || 0,
        c: breakdown.cacheReadTokens || 0,
      };

      // Only emit entries with positive deltas
      if (deltaInput <= 0 && deltaOutput <= 0 && deltaCached <= 0) continue;

      entries.push({
        source: 'claude-code',
        model,
        project,
        timestamp: new Date(session.lastActivity),
        inputTokens: Math.max(0, deltaInput),
        outputTokens: Math.max(0, deltaOutput),
        cachedInputTokens: Math.max(0, deltaCached),
        reasoningOutputTokens: 0,
      });
    }
  }

  // Stage state — only persisted to disk after successful upload
  _pendingState = nextState;

  return aggregateToBuckets(entries);
}

/**
 * Resolve project name from ccusage session data.
 *
 * ccusage v18 assumes 3-layer: projects/{projectPath}/{sessionId}/{file}.jsonl
 * but Claude Code main sessions are 2-layer: projects/{projectPath}/{sessionId}.jsonl
 *
 * For 2-layer files ccusage incorrectly puts the project dir name into sessionId
 * and sets projectPath to "Unknown Project". We detect and correct this.
 */
function resolveProject(session) {
  if (session.projectPath === 'Unknown Project') {
    // 2-layer: sessionId actually holds the project directory name
    return cleanProjectDir(session.sessionId);
  }
  // 3-layer: projectPath is correct, strip any session UUID suffix
  return cleanProjectDir(session.projectPath);
}

/**
 * Clean a raw project directory name from ccusage.
 * Strips session UUID suffix for subagent paths like '-Users-foo-project/77e854f9-...'.
 */
function cleanProjectDir(raw) {
  if (!raw || raw === 'unknown' || raw === 'Unknown Project') return 'unknown';
  const slashIdx = raw.indexOf('/');
  if (slashIdx !== -1) raw = raw.slice(0, slashIdx);
  return raw;
}
