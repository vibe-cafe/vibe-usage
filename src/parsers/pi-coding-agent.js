import { normalizeExtraRoot, piSessionsDir } from '../extra-roots.js';
import { getPiSessionDirs } from '../pi-roots.js';
import { mergeCindyHarnessUsage, readCindyHarnessUsage } from './cindy-ledger.js';
import { parsePiSessionJsonl } from './pi-session-jsonl.js';

/** Parse the official Pi agent's Pi-compatible JSONL sessions. */
export async function parse({ extraRoots = [] } = {}) {
  for (const root of extraRoots) {
    // piSessionsDir re-resolves the root's shape, so an agent home that lost
    // its `sessions/` child is caught here too, not just a root that vanished.
    if (piSessionsDir(root) !== null) continue;
    // An explicitly configured root that is momentarily unreadable is not
    // proof that its usage disappeared, so skip instead of reporting empty.
    return {
      buckets: [],
      sessions: [],
      skipped: true,
      warnings: [`pi-coding-agent: 额外根目录不可用，已跳过本次 Pi 同步: ${normalizeExtraRoot(root)}`],
    };
  }

  const nativeResult = await parsePiSessionJsonl({
    source: 'pi-coding-agent',
    sessionsDirs: getPiSessionDirs(extraRoots),
  });
  return mergeCindyHarnessUsage(nativeResult, readCindyHarnessUsage('pi'));
}
