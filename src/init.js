import { createInterface } from 'node:readline';
import { execFile } from 'node:child_process';
import { platform } from 'node:os';
import { loadConfig, saveConfig } from './config.js';
import { ingest } from './api.js';
import { runSync } from './sync.js';
import { detectInstalledTools } from './hooks.js';

function prompt(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function openBrowser(url) {
  const cmds = { darwin: 'open', linux: 'xdg-open', win32: 'start' };
  const cmd = cmds[platform()] || cmds.linux;
  // Use execFile with args array to avoid shell injection via VIBE_USAGE_API_URL
  execFile(cmd, [url], () => {});
}

export async function runInit() {
  console.log('\n  vibe-usage - Vibe Usage Tracker by VibeCaf\u00e9\n');

  const existing = loadConfig();
  if (existing?.apiKey) {
    const answer = await prompt('Config already exists. Overwrite? (y/N) ');
    if (answer.toLowerCase() !== 'y') {
      console.log('Cancelled.');
      return;
    }
  }

  const apiUrl = process.env.VIBE_USAGE_API_URL || 'https://vibecafe.ai';
  console.log(`Get your API key at: ${apiUrl}/usage/setup\n`);
  openBrowser(`${apiUrl}/usage/setup`);

  let apiKey;
  while (true) {
    apiKey = await prompt('Paste your API key: ');
    if (apiKey.startsWith('vbu_')) break;
    console.log('Invalid key — must start with "vbu_". Try again.');
  }

  console.log(`\nVerifying key ${apiKey.slice(0, 8)}...`);
  try {
    await ingest(apiUrl, apiKey, []);
    console.log('Key verified.\n');
  } catch (err) {
    if (err.message === 'UNAUTHORIZED') {
      console.error('Invalid API key. Please check and try again.');
      process.exit(1);
    }
    console.log('Could not verify key (network error). Saving anyway.\n');
  }

  const config = {
    apiKey,
    apiUrl,
  };
  saveConfig(config);

  const tools = detectInstalledTools();
  if (tools.length > 0) {
    console.log(`Detected tools: ${tools.map(t => t.name).join(', ')}`);
  } else {
    console.log('No AI coding tools detected. Install one and re-run init.');
  }

  console.log('\nRunning initial sync...');
  await runSync();

  console.log(`\nSetup complete! View your dashboard at: ${apiUrl}/usage`);
}
