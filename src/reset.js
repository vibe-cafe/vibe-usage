import { createInterface } from 'node:readline';
import { existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, hostname as getHostname } from 'node:os';
import { loadConfig, saveConfig } from './config.js';
import { deleteAllData } from './api.js';
import { runSync } from './sync.js';

const STATE_FILES = [
  join(homedir(), '.vibe-usage', 'claude-code-state.json'),
];

function prompt(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

export async function runReset(args = []) {
  const hostOnly = args.includes('--local');
  const config = loadConfig();
  if (!config?.apiKey) {
    console.error('Not configured. Run `npx @vibe-cafe/vibe-usage init` first.');
    process.exit(1);
  }

  const currentHost = getHostname();
  const apiUrl = config.apiUrl || 'https://vibecafe.ai';

  if (hostOnly) {
    const answer = await prompt(`This will delete usage data for this host (${currentHost}) and re-upload from local logs. Continue? (y/N) `);
    if (answer.toLowerCase() !== 'y') {
      console.log('Cancelled.');
      return;
    }

    // 1. Delete remote data for this host
    console.log(`Deleting remote data for host: ${currentHost}...`);
    try {
      const result = await deleteAllData(apiUrl, config.apiKey, { hostname: currentHost });
      console.log(`Deleted ${result.deleted} buckets from server.`);
    } catch (err) {
      if (err.message === 'UNAUTHORIZED') {
        console.error('Invalid API key. Run `npx @vibe-cafe/vibe-usage init` to reconfigure.');
        process.exit(1);
      }
      console.error(`Failed to delete remote data: ${err.message}`);
      process.exit(1);
    }
  } else {
    const answer = await prompt('This will delete ALL your usage data and re-upload from local logs. Continue? (y/N) ');
    if (answer.toLowerCase() !== 'y') {
      console.log('Cancelled.');
      return;
    }

    // 1. Delete all remote data
    console.log('Deleting all remote data...');
    try {
      const result = await deleteAllData(apiUrl, config.apiKey);
      console.log(`Deleted ${result.deleted} buckets from server.`);
    } catch (err) {
      if (err.message === 'UNAUTHORIZED') {
        console.error('Invalid API key. Run `npx @vibe-cafe/vibe-usage init` to reconfigure.');
        process.exit(1);
      }
      console.error(`Failed to delete remote data: ${err.message}`);
      process.exit(1);
    }
  }

  // 2. Clear local state
  config.lastSync = null;
  saveConfig(config);

  for (const stateFile of STATE_FILES) {
    if (existsSync(stateFile)) {
      unlinkSync(stateFile);
    }
  }
  console.log('Cleared local sync state.');

  // 3. Re-upload everything
  console.log('\nRe-syncing all data...');
  await runSync();

  console.log(`\nReset complete! View your dashboard at: ${apiUrl}/usage`);
}
