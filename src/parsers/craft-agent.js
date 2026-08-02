import { getCraftWorkspacesDir } from '../craft-roots.js';
import { parsePiSessionJsonl } from './pi-session-jsonl.js';

function isCraftPiSession(filePath) {
  return filePath.split(/[\\/]/).includes('.pi-sessions');
}

function projectFromCraftPath(filePath) {
  const parts = filePath.replace(/\\/g, '/').split('/');
  const sessionsIndex = parts.lastIndexOf('sessions');
  return parts[sessionsIndex + 1] || 'unknown';
}

export async function parse() {
  return parsePiSessionJsonl({
    source: 'craft-agent',
    sessionsDirs: [getCraftWorkspacesDir()],
    includeFile: isCraftPiSession,
    projectFromPath: projectFromCraftPath,
  });
}
