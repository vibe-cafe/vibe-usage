import { loadSessionData } from 'ccusage/data-loader';
import { aggregateToBuckets } from './index.js';

export async function parse(lastSync) {
  let sessions;
  try {
    sessions = await loadSessionData({ mode: 'display' });
  } catch {
    return [];
  }

  if (!sessions || sessions.length === 0) return [];

  const entries = [];

  for (const session of sessions) {
    if (lastSync && new Date(session.lastActivity) <= new Date(lastSync)) continue;

    for (const breakdown of session.modelBreakdowns || []) {
      entries.push({
        source: 'claude-code',
        model: breakdown.modelName,
        project: session.projectPath || 'unknown',
        timestamp: new Date(session.lastActivity),
        inputTokens: breakdown.inputTokens,
        outputTokens: breakdown.outputTokens,
        cachedInputTokens: breakdown.cacheReadTokens,
        reasoningOutputTokens: 0,
      });
    }
  }

  return aggregateToBuckets(entries);
}
