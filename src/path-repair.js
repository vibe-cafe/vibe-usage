import { statSync, renameSync } from 'node:fs';

/**
 * Move a directory that is occupying a path we need as a file.
 *
 * Both the config file and the state file are written by this CLI, and a
 * customer hit a layout where the *file* path had become a directory (the store
 * was created by a different tool, or an earlier run was interrupted between
 * mkdir and open). `writeFileSync` then fails with EISDIR and the CLI is stuck:
 * every later run reads nothing, and the save that would fix it is the one that
 * throws.
 *
 * Renaming it aside keeps whatever the user's data was — never delete it, the
 * directory may hold real content — while letting the current run write a fresh
 * file. Absence is not a repair, so ENOENT stays silent; anything else (a
 * permission error, a read-only volume) is the caller's to report rather than
 * something to swallow.
 */
export function moveDirectoryOutOfFilePath(path) {
  try {
    if (statSync(path).isDirectory()) {
      renameSync(path, `${path}.directory-backup-${Date.now()}`);
    }
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
  }
}
