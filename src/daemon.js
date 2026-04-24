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

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      await runSync({ throws: true, quiet: true });
    } catch (err) {
      if (err.message === 'UNAUTHORIZED') {
        log('API key invalid, exiting.');
        process.exit(1);
      }
      log(`sync error: ${err.message}`);
    }
    await sleep(INTERVAL);
  }
}
