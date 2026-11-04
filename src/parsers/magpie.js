import { createReadStream, readdirSync, readFileSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';

function signature(input, output, cached, written) {
  const counts = [input, output, cached, written];
  return counts.every(value => Number.isSafeInteger(value) && value >= 0)
    ? JSON.stringify(counts) : null;
}

function actualModel(value) {
  return typeof value === 'string' && value.trim()
    && !value.startsWith('group/') && !['auto', 'default', 'unknown'].includes(value)
    ? value : null;
}

function recordCandidate(responses, row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return false;
  if (typeof row.req !== 'string' || !row.req.startsWith('group/')) return true;
  if (Number.isInteger(row.status) && (row.status < 200 || row.status >= 300)) return true;
  const counts = signature(row.in, row.out, row.cache_read, row.cache_write);
  if (!counts || !Number.isInteger(row.status)) return false;
  if (typeof row.response_id !== 'string' || !row.response_id) return true;
  const model = actualModel(row.model ?? row.served);
  if (!model) return true;
  const key = JSON.stringify([row.req, counts]);
  let candidates = responses.get(row.response_id);
  if (!candidates) responses.set(row.response_id, candidates = new Map());
  if (!candidates.has(key)) candidates.set(key, model);
  else if (candidates.get(key) !== model) candidates.set(key, null);
  return true;
}

function mergeCandidates(target, source) {
  for (const [response, candidates] of source) {
    let existing = target.get(response);
    if (!existing) target.set(response, existing = new Map());
    for (const [key, model] of candidates) {
      if (!existing.has(key)) existing.set(key, model);
      else if (existing.get(key) !== model) existing.set(key, null);
    }
  }
}

/** Read only routing/accounting metadata; never retain credentials or prompts.
 * Each parse gets a fresh snapshot bounded to the live file's initial size.
 * Failed sources never contribute a partial set of routing candidates.
 * The final live row is eligible only once its terminating newline is present.
 */
export async function readMagpieModels(warnings) {
  const responses = new Map();
  const configRoot = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  const file = process.env.VIBE_USAGE_MAGPIE_USAGE_FILE?.trim()
    || join(configRoot, 'magpie', 'usage.jsonl');
  const othersDir = process.env.VIBE_USAGE_MAGPIE_OTHERS_DIR?.trim()
    || join(dirname(file), 'usage-others');
  let historyFailures = 0;
  try {
    for (const device of readdirSync(othersDir, { withFileTypes: true })) {
      if (!device.isDirectory()) continue;
      const directory = join(othersDir, device.name);
      let files;
      try { files = readdirSync(directory); } catch { historyFailures++; continue; }
      for (const name of files) {
        if (!name.endsWith('.json')) continue;
        try {
          const data = JSON.parse(readFileSync(join(directory, name), 'utf8'));
          if (!Array.isArray(data?.calls)) throw new Error('Invalid calls');
          const candidates = new Map();
          let malformed = false;
          for (const call of data.calls) {
            if (!recordCandidate(candidates, call)) malformed = true;
          }
          if (malformed) throw new Error('Invalid accounting');
          mergeCandidates(responses, candidates);
        } catch { historyFailures++; }
      }
    }
  } catch (error) {
    if (error.code !== 'ENOENT') historyFailures++;
  }
  if (historyFailures) warnings.push(`Magpie: ${historyFailures} 个历史每日用量文件或目录无法读取或格式无效，已忽略。`);

  try {
    const snapshot = await stat(file);
    if (!snapshot.isFile()) throw new Error('Invalid ledger');
    const { size } = snapshot;
    if (size === 0) return responses;
    const candidates = new Map();
    let malformed = false;
    const input = createReadStream(file, { encoding: 'utf8', start: 0, end: size - 1 });
    const lines = createInterface({ input, crlfDelay: Infinity });
    // readline does not forward stream errors to its async iterator.
    input.on('error', () => lines.close());
    let endsWithNewline = false;
    input.on('data', chunk => { endsWithNewline = chunk.endsWith('\n'); });
    const acceptLine = line => {
      if (!line?.trim()) return;
      let row;
      try { row = JSON.parse(line); } catch { malformed = true; return; }
      if (!recordCandidate(candidates, row)) malformed = true;
    };
    try {
      // Hold only the final line so a concurrent append cannot expose half a row.
      let pending;
      for await (const line of lines) {
        acceptLine(pending);
        pending = line;
      }
      if (endsWithNewline) acceptLine(pending);
      if (input.errored) throw input.errored;
      if (input.bytesRead !== size || malformed) throw new Error('Incomplete ledger');
      mergeCandidates(responses, candidates);
    } finally {
      lines.close();
      input.destroy();
    }
  } catch (error) {
    if (error.code !== 'ENOENT') warnings.push('Magpie: 无法完整读取实时用量日志，未解析的请求保留分组模型。');
  }
  return responses;
}

export function resolveMagpieModel(responses, message, model) {
  const usage = message.usage;
  const counts = signature(usage.input, usage.output, usage.cacheRead, usage.cacheWrite);
  if (!counts) return null;
  const key = JSON.stringify([model, counts]);
  return responses.get(message.responseId)?.get(key) || null;
}
