import { getPiSessionDirs } from '../pi-roots.js';
import { mergeCindyHarnessUsage, readCindyHarnessUsage } from './cindy-ledger.js';
import { parsePiSessionJsonl } from './pi-session-jsonl.js';

/** Parse the official Pi agent's Pi-compatible JSONL sessions. */
export async function parse() {
  const nativeResult = await parsePiSessionJsonl({
    source: 'pi-coding-agent',
    sessionsDirs: getPiSessionDirs(),
  });
  return mergeCindyHarnessUsage(nativeResult, readCindyHarnessUsage('pi'));
}
