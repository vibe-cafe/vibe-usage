import { accessSync, constants, realpathSync, statSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { homedir } from 'node:os';

function readable(path, directory) {
  try {
    const stat = statSync(path);
    if (directory ? !stat.isDirectory() : !stat.isFile()) throw new Error(`格式不正确: ${path}`);
    accessSync(path, constants.R_OK);
    return true;
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return false;
    throw err;
  }
}

// SQLite wins within each store; JSON is the legacy alternative, not a second
// copy of the same migrated history. A failed SQLite read must protect state.
export function openCodeStore(root) {
  const db = join(root, 'opencode.db');
  if (readable(db, false)) return { kind: 'sqlite', path: db };
  const messages = join(root, 'storage', 'message');
  if (readable(messages, true)) return { kind: 'json', path: messages };
  return null;
}

export function getOpenCodeStores({ extraRoots = [], onWarning = () => {} } = {}) {
  const override = process.env.VIBE_USAGE_OPENCODE_DIRS?.trim();
  const defaults = override ? override.split(delimiter).map(p => p.trim()).filter(Boolean)
    : [join(homedir(), '.local', 'share', 'opencode')];
  const seen = new Set(), stores = [];
  for (const root of [...defaults, ...extraRoots]) {
    try {
      const store = openCodeStore(root);
      if (!store) {
        if (extraRoots.includes(root)) onWarning(`OpenCode: 额外目录缺少 opencode.db 或 storage/message/: ${root}`);
        continue;
      }
      const canonical = realpathSync(store.path);
      if (seen.has(canonical)) continue;
      seen.add(canonical);
      stores.push({ ...store, path: canonical });
    } catch (err) { onWarning(`OpenCode: 无法读取数据目录 ${root}: ${err.message}`); }
  }
  return stores;
}
