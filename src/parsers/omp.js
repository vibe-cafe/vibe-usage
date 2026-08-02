import { getOmpSessionDirs } from '../pi-roots.js';
import { parsePiSessionJsonl } from './pi-session-jsonl.js';

/** Parse Oh My Pi's Pi-compatible JSONL sessions, including profiles/XDG. */
export async function parse() {
  return parsePiSessionJsonl({
    source: 'omp',
    sessionsDirs: getOmpSessionDirs(),
  });
}
