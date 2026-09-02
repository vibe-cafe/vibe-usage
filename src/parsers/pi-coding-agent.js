import { statSync } from 'node:fs';
import { normalizeExtraRoot, piSessionsDir } from '../extra-roots.js';
import { getPiSessionDirs } from '../pi-roots.js';
import { mergeCindyHarnessUsage, readCindyHarnessUsage } from './cindy-ledger.js';
import { parsePiSessionJsonl } from './pi-session-jsonl.js';

/** Parse the official Pi agent's Pi-compatible JSONL sessions. */
export async function parse({ extraRoots = [] } = {}) {
  for (const root of extraRoots) {
    try {
      if (!statSync(piSessionsDir(root)).isDirectory()) throw new Error('not a directory');
    } catch {
      // An explicitly configured root that is momentarily unreadable is not
      // proof that its usage disappeared, so skip instead of reporting empty.
      return {
        buckets: [],
        sessions: [],
        skipped: true,
        warnings: [`pi-coding-agent: 额外根目录不可用，已跳过本次 Pi 同步: ${normalizeExtraRoot(root)}`],
      };
    }
  }

  const nativeResult = await parsePiSessionJsonl({
    source: 'pi-coding-agent',
    sessionsDirs: getPiSessionDirs(extraRoots),
  });
  return mergeCindyHarnessUsage(nativeResult, readCindyHarnessUsage('pi'));
}
