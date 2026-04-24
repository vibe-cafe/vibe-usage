import { loadConfig, saveConfig, getConfigPath } from './config.js';
import { detectInstalledTools, TOOLS } from './tools.js';
import { existsSync } from 'node:fs';
import { smallHeader } from './output.js';

function printSmallHeader() {
  console.log();
  console.log(smallHeader());
  console.log();
}

async function showStatus() {
  const config = loadConfig();
  console.log('\nvibe-usage status\n');

  if (!config?.apiKey) {
    console.log('  Config: not configured');
    console.log(`  Run \`npx @vibe-cafe/vibe-usage init\` to set up.\n`);
  } else {
    console.log(`  Config: ${getConfigPath()}`);
    console.log(`  API key: ${config.apiKey.slice(0, 8)}...`);
    console.log(`  API URL: ${config.apiUrl || 'https://vibecafe.ai'}`);
  }

  console.log('\n  Detected tools:');
  const detected = detectInstalledTools();
  if (detected.length === 0) {
    console.log('    (none)\n');
  } else {
    for (const tool of detected) {
      console.log(`    ${tool.name}`);
    }
    console.log();
  }

  console.log('  All supported tools:');
  for (const tool of TOOLS) {
    const installed = existsSync(tool.dataDir) ? 'installed' : 'not found';
    console.log(`    ${tool.name}: ${installed}`);
  }
  console.log();
}

const VALID_CONFIG_KEYS = ['apiKey', 'apiUrl', 'hostname'];

function handleConfig(args) {
  const sub = args[0];

  switch (sub) {
    case 'get': {
      const key = args[1];
      if (!key) {
        console.error('Usage: vibe-usage config get <key>');
        process.exit(1);
      }
      const config = loadConfig();
      if (!config || !(key in config)) {
        // Output nothing — caller checks exit code or empty output
        process.exit(0);
      }
      // Output raw value (no formatting) for machine parsing
      console.log(config[key] ?? '');
      break;
    }
    case 'set': {
      const key = args[1];
      const value = args[2];
      if (!key || value === undefined) {
        console.error('Usage: vibe-usage config set <key> <value>');
        process.exit(1);
      }
      if (!VALID_CONFIG_KEYS.includes(key)) {
        console.error(`Unknown config key: ${key}`);
        console.error(`Valid keys: ${VALID_CONFIG_KEYS.join(', ')}`);
        process.exit(1);
      }
      const config = loadConfig() || {};
      config[key] = value;
      saveConfig(config);
      break;
    }
    case 'show': {
      const config = loadConfig();
      if (!config) {
        console.log('{}');
      } else {
        console.log(JSON.stringify(config, null, 2));
      }
      break;
    }
    default:
      console.error(`Unknown config subcommand: ${sub || '(none)'}`);
      console.error('Usage: vibe-usage config <get|set|show>');
      process.exit(1);
  }
}

function extractOption(args, name) {
  const flag = `--${name}`;
  const idx = args.findIndex(a => a === flag);
  if (idx === -1) return { args, value: undefined };
  const value = args[idx + 1];
  if (value === undefined || value.startsWith('--')) {
    console.error(`Option ${flag} requires a value.`);
    process.exit(1);
  }
  return { args: [...args.slice(0, idx), ...args.slice(idx + 2)], value };
}

export async function run(rawArgs) {
  const { args, value: apiKey } = extractOption(rawArgs, 'key');
  const command = args[0];

  switch (command) {
    case 'init': {
      const { runInit } = await import('./init.js');
      await runInit({ apiKey });
      break;
    }
    case 'sync': {
      printSmallHeader();
      const { runSync } = await import('./sync.js');
      await runSync();
      break;
    }
    case 'reset': {
      printSmallHeader();
      const { runReset } = await import('./reset.js');
      await runReset(args.slice(1));
      break;
    }
    case 'daemon':
    case '--daemon': {
      const sub = args[1];
      if (sub && ['install', 'uninstall', 'status', 'stop', 'restart'].includes(sub)) {
        printSmallHeader();
        const { manageDaemon } = await import('./daemon-service.js');
        await manageDaemon(sub);
      } else {
        // Foreground daemon loop — no header, just start syncing
        const { runDaemon } = await import('./daemon.js');
        await runDaemon();
      }
      break;
    }
    case 'skill': {
      printSmallHeader();
      const { runSkill } = await import('./skill.js');
      await runSkill(args.slice(1));
      break;
    }
    case 'config': {
      handleConfig(args.slice(1));
      break;
    }
    case 'status': {
      await showStatus();
      break;
    }
    case 'help':
    case '--help':
    case '-h': {
      console.log(`
  vibe-usage - Vibe Usage Tracker by VibeCafé

  Usage:
    npx @vibe-cafe/vibe-usage              Init (first run) or sync
    npx @vibe-cafe/vibe-usage --key <vbu_...>   One-shot init with a pre-copied key
    npx @vibe-cafe/vibe-usage init         Set up API key (interactive)
    npx @vibe-cafe/vibe-usage init --key <vbu_...>   Init with key, skip paste prompt
    npx @vibe-cafe/vibe-usage sync         Manually sync usage data
    npx @vibe-cafe/vibe-usage daemon       Continuous sync (every 30m, foreground)
    npx @vibe-cafe/vibe-usage daemon install    Install background service (systemd/launchd)
    npx @vibe-cafe/vibe-usage daemon uninstall  Remove background service
    npx @vibe-cafe/vibe-usage daemon status     Show background service status
    npx @vibe-cafe/vibe-usage daemon stop       Stop background service
    npx @vibe-cafe/vibe-usage daemon restart    Restart background service
    npx @vibe-cafe/vibe-usage reset        Delete all data and re-upload
    npx @vibe-cafe/vibe-usage reset --local  Delete data for this host only and re-upload
    npx @vibe-cafe/vibe-usage skill         Install skill for AI coding tools
    npx @vibe-cafe/vibe-usage skill --remove  Remove installed skills
    npx @vibe-cafe/vibe-usage status       Show config and detected tools
    npx @vibe-cafe/vibe-usage config show  Show full config as JSON
    npx @vibe-cafe/vibe-usage config get <key>   Get a config value
    npx @vibe-cafe/vibe-usage config set <key> <value>  Set a config value
    npx @vibe-cafe/vibe-usage help         Show this help
`);
      break;
    }
    default: {
      const config = loadConfig();
      if (!config?.apiKey || apiKey) {
        // First run OR user passed --key for a one-shot setup — init.js prints the big header
        const { runInit } = await import('./init.js');
        await runInit({ apiKey });
      } else {
        // Already configured: small header + sync
        printSmallHeader();
        const { runSync } = await import('./sync.js');
        await runSync();
      }
    }
  }
}
