import { loadConfig } from './config.js';
import { runSync } from './sync.js';
import { failure, dim } from './output.js';

const INTERVAL = 30 * 60_000; // 30 minutes

function log(msg) {
  const ts = new Date().toLocaleTimeString('en-US', { hour12: false });
  process.stdout.write(dim(`[${ts}] ${msg}\n`));
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function runDaemon() {
  const config = loadConfig();
  if (!config?.apiKey) {
    console.error(failure('尚未配置，请先运行 `npx @vibe-cafe/vibe-usage init`。'));
    process.exit(1);
  }

  log('daemon started (sync every 30m, Ctrl+C to stop)');

  // Why we don't exit on the first 401: launchd KeepAlive / systemd
  // Restart=on-failure relaunch in ~10s, which used to turn a single bad/
  // revoked key into ~360 ingest-401s per hour per machine. Sleeping a full
  // INTERVAL between auth retries collapses that storm to the daemon's normal
  // 30m cadence; only after MAX_AUTH_FAILURES consecutive 401s do we hand
  // off to the supervisor, which by then can't relaunch fast enough to matter.
  const MAX_AUTH_FAILURES = 5;
  let consecutiveAuthFailures = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      await runSync({ throws: true, quiet: true, surface: 'daemon' });
      consecutiveAuthFailures = 0;
    } catch (err) {
      if (err.message === 'UNAUTHORIZED') {
        consecutiveAuthFailures++;
        if (consecutiveAuthFailures >= MAX_AUTH_FAILURES) {
          log(`API key invalid for ${MAX_AUTH_FAILURES} consecutive syncs, exiting.`);
          process.exit(1);
        }
        log(`API key invalid (attempt ${consecutiveAuthFailures}/${MAX_AUTH_FAILURES}), retrying in 30m.`);
      } else {
        log(`sync error: ${err.message}`);
      }
    }
    await sleep(INTERVAL);
  }
}
