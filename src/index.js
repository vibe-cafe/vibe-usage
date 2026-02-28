import { loadConfig, saveConfig, getConfigPath } from './config.js';
import { detectInstalledTools, TOOLS } from './hooks.js';
import { existsSync } from 'node:fs';

async function showStatus() {
  const config = loadConfig();
  console.log('\nvibe-usage status\n');

  if (!config?.apiKey) {
    console.log('  Config: not configured');
    console.log(`  Run \`npx vibe-usage init\` to set up.\n`);
  } else {
    console.log(`  Config: ${getConfigPath()}`);
    console.log(`  API key: ${config.apiKey.slice(0, 8)}...`);
    console.log(`  API URL: ${config.apiUrl || 'https://vibecafe.ai'}`);
    console.log(`  Last sync: ${config.lastSync || 'never'}`);
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

const VALID_CONFIG_KEYS = ['apiKey', 'apiUrl', 'lastSync'];

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

export async function run(args) {
  const command = args[0];

  switch (command) {
    case 'init': {
      const { runInit } = await import('./init.js');
      await runInit();
      break;
    }
    case 'sync': {
      const { runSync } = await import('./sync.js');
      await runSync();
      break;
    }
    case 'reset': {
      const { runReset } = await import('./reset.js');
      await runReset();
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
    npx vibe-usage              Init (first run) or sync
    npx vibe-usage init         Set up API key
    npx vibe-usage sync         Manually sync usage data
    npx vibe-usage reset        Delete all data and re-upload
    npx vibe-usage status       Show config and detected tools
    npx vibe-usage config show  Show full config as JSON
    npx vibe-usage config get <key>   Get a config value
    npx vibe-usage config set <key> <value>  Set a config value
    npx vibe-usage help         Show this help
`);
      break;
    }
    default: {
      const config = loadConfig();
      if (!config?.apiKey) {
        const { runInit } = await import('./init.js');
        await runInit();
      } else {
        const { runSync } = await import('./sync.js');
        await runSync();
      }
    }
  }
}
