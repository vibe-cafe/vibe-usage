import { KIKI_SOURCE_ID, independentKikiRoots } from '../kiki-roots.js';
import { parseCurrentKimiRoots } from './kimi-code.js';
import { resolveKimiCodeRoots } from '../kimi-roots.js';

// Strip only known routing/provider prefixes, never arbitrary slash-bearing
// model ids (e.g. Qwen/Qwen3.8-Flash). Nested known routes are stripped in order.
export const KIKI_MODEL_PREFIXES = Object.freeze([
  'axon', 'axon-message', 'axon-chat', 'kimi-code', 'anthropic',
  'deepseek', 'z-ai', 'hub', 'stealth', 'st', 'minimax',
]);

export function normalizeKikiModel(model, prefixes = KIKI_MODEL_PREFIXES) {
  if (typeof model !== 'string' || !model) return 'unknown';
  let normalized = model;
  for (;;) {
    const slash = normalized.indexOf('/');
    if (slash < 0 || slash === normalized.length - 1
      || !prefixes.includes(normalized.slice(0, slash))) return normalized;
    normalized = normalized.slice(slash + 1);
  }
}

export async function parse({ excludeRoots = [] } = {}) {
  return parseCurrentKimiRoots(independentKikiRoots([...resolveKimiCodeRoots(), ...excludeRoots]), {
    source: KIKI_SOURCE_ID,
    normalizeModel: normalizeKikiModel,
    deduplicateCopies: true,
  }) ?? { buckets: [], sessions: [] };
}
