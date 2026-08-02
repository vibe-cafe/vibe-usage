import { getPiSessionDirs } from '../pi-roots.js';
import { parsePiSessionJsonl } from './pi-session-jsonl.js';

/** Parse the official Pi agent's Pi-compatible JSONL sessions. */
export async function parse() {
  return parsePiSessionJsonl({
    source: 'pi-coding-agent',
    sessionsDirs: getPiSessionDirs(),
  });
}
