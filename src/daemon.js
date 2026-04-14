import { loadConfig } from './config.js';
import { runSync } from './sync.js';

const INTERVAL = 30 * 60_000; // 30 minutes

function log(msg) {
  const ts = new Date().toLocaleTimeString('en-US', { hour12: false });
  process.stdout.write(`[${ts}] ${msg}\n`);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function runDaemon() {
  const config = loadConfig();
  if (!config?.apiKey) {
    console.error('Not configured. Run `npx @vibe-cafe/vibe-usage init` first.');
    process.exit(1);
  }

  log('Daemon started (sync every 30m, Ctrl+C to stop)');

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      await runSync({ throws: true, quiet: true });
    } catch (err) {
      if (err.message === 'UNAUTHORIZED') {
        log('API key invalid. Exiting.');
        process.exit(1);
      }
      log(`Sync error: ${err.message}`);
    }
    await sleep(INTERVAL);
  }
}
