import { parse as parseClaudeCode } from './claude-code.js';
import { parse as parseCodex } from './codex.js';
import { parse as parseGeminiCli } from './gemini-cli.js';
import { parse as parseOpencode } from './opencode.js';
import { parse as parseOpenclaw } from './openclaw.js';
import { parse as parseQwenCode } from './qwen-code.js';
import { parse as parseKimiCode } from './kimi-code.js';

export const parsers = {
  'claude-code': parseClaudeCode,
  'codex': parseCodex,
  'gemini-cli': parseGeminiCli,
  'opencode': parseOpencode,
  'openclaw': parseOpenclaw,
  'qwen-code': parseQwenCode,
  'kimi-code': parseKimiCode,
};


export function roundToHalfHour(date) {
  const d = new Date(date);
  d.setMinutes(d.getMinutes() < 30 ? 0 : 30, 0, 0);
  return d;
}

export function aggregateToBuckets(entries) {
  const map = new Map();

  for (const e of entries) {
    const bucketStart = roundToHalfHour(e.timestamp).toISOString();
    const key = `${e.source}|${e.model}|${e.project}|${bucketStart}`;

    if (!map.has(key)) {
      map.set(key, {
        source: e.source,
        model: e.model,
        project: e.project,
        bucketStart,
        inputTokens: 0,
        outputTokens: 0,
        cachedInputTokens: 0,
        reasoningOutputTokens: 0,
        totalTokens: 0,
      });
    }

    const b = map.get(key);
    b.inputTokens += e.inputTokens || 0;
    b.outputTokens += e.outputTokens || 0;
    b.cachedInputTokens += e.cachedInputTokens || 0;
    b.reasoningOutputTokens += e.reasoningOutputTokens || 0;
    b.totalTokens += (e.inputTokens || 0) + (e.outputTokens || 0) + (e.reasoningOutputTokens || 0);
  }

  return Array.from(map.values());
}
