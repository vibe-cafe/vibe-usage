import { createInterface } from 'node:readline';
import { execFile } from 'node:child_process';
import { hostname as osHostname, platform } from 'node:os';
import { loadConfig, saveConfig } from './config.js';
import { ingest } from './api.js';
import { runSync } from './sync.js';
import { detectInstalledTools } from './tools.js';

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

function isDaemonPlatform() {
  return process.platform === 'linux' || process.platform === 'darwin';
}

export async function runInit(options = {}) {
  const { apiKey: providedKey } = options;

  console.log('\n  vibe-usage - Vibe Usage Tracker by VibeCaf\u00e9\n');

  const existing = loadConfig();
  if (existing?.apiKey) {
    if (providedKey && existing.apiKey === providedKey) {
      console.log('Already configured with this key. Running sync...\n');
      await runSync();
      return;
    }
    const answer = await prompt('Config already exists. Overwrite? (y/N) ');
    if (answer.toLowerCase() !== 'y') {
      console.log('Cancelled.');
      return;
    }
  }

  const apiUrl = process.env.VIBE_USAGE_API_URL || 'https://vibecafe.ai';

  let apiKey;
  if (providedKey) {
    if (!providedKey.startsWith('vbu_')) {
      console.error('Invalid API key — must start with "vbu_".');
      process.exit(1);
    }
    apiKey = providedKey;
    console.log(`Using API key ${apiKey.slice(0, 8)}...`);
  } else {
    console.log(`Get your API key at: ${apiUrl}/usage\n`);
    openBrowser(`${apiUrl}/usage`);

    while (true) {
      apiKey = await prompt('Paste your API key: ');
      if (apiKey.startsWith('vbu_')) break;
      console.log('Invalid key — must start with "vbu_". Try again.');
    }
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
    hostname: existing?.hostname || osHostname().replace(/\.local$/, ''),
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

  if (isDaemonPlatform()) {
    if (process.stdin.isTTY) {
      console.log('');
      const answer = await prompt('开启后台自动同步？(持续上报用量数据,推荐) [Y/n] ');
      const normalized = answer.toLowerCase();
      if (normalized === '' || normalized === 'y' || normalized === 'yes') {
        const { manageDaemon } = await import('./daemon-service.js');
        await manageDaemon('install');
      } else {
        console.log('\n可随时运行 `npx @vibe-cafe/vibe-usage daemon install` 开启后台同步。');
      }
    } else {
      // Non-interactive shell (CI, pipe) — don't block on prompt
      console.log('\nTip: Run `npx @vibe-cafe/vibe-usage daemon install` to sync automatically in the background.');
    }
  }
}
