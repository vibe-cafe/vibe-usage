import { loadConfig, saveConfig, getConfigPath } from './config.js';
import { detectInstalledTools, TOOLS } from './tools.js';
import { existsSync } from 'node:fs';
import { validateExtraCodexHome } from './codex-roots.js';
import {
  EXTRA_ROOT_SOURCES,
  extraRootList,
  normalizeExtraRoot,
  validateExtraRoot,
} from './extra-roots.js';
import { dim as dimText, failure, hint, smallHeader, warn } from './output.js';
import { fetchAccount } from './api.js';

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
    console.log(`  Run \`npx @vibe-cafe/vibe-usage\` to set up.\n`);
  } else {
    console.log(`  Config: ${getConfigPath()}`);
    console.log(`  API key: ${config.apiKey.slice(0, 8)}...`);
    console.log(`  API URL: ${config.apiUrl || 'https://vibecafe.ai'}`);
    // 数据算在谁名下,是这里最该回答、以前偏偏答不出的一件事。
    await printBoundAccount(config.apiUrl || 'https://vibecafe.ai', config.apiKey);
    if (config.codexExtraHome) {
      console.log(`  Extra Codex Home: ${config.codexExtraHome}`);
    }
    for (const source of EXTRA_ROOT_SOURCES) {
      for (const root of extraRootList(config.extraRoots?.[source])) {
        console.log(`  Extra ${source} Root: ${root}`);
      }
    }
  }

  console.log('\n  Detected tools:');
  const toolOptions = {
    codexExtraHome: config?.codexExtraHome,
    extraRoots: config?.extraRoots,
  };
  const detected = detectInstalledTools(toolOptions);
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
    const installed = (tool.detectDataDirs
      ? tool.detectDataDirs(toolOptions).length > 0
      : existsSync(tool.dataDir)) ? 'installed' : 'not found';
    console.log(`    ${tool.name}: ${installed}`);
  }
  console.log();
}

/**
 * Print the account this key uploads to. Never throws: an offline machine or an
 * older backend just means we cannot name the account, which must not make
 * `status` fail — but a revoked/invalid key is worth saying out loud.
 */
async function printBoundAccount(apiUrl, apiKey) {
  try {
    const account = await fetchAccount(apiUrl, apiKey);
    if (account) {
      const label = account.name ? `@${account.handle}(${account.name})` : `@${account.handle}`;
      console.log(`  账号: ${label}`);
      console.log(dimText(`        数据都记在这个账号名下,不是它就换个账号重新 init`));
    } else {
      console.log(dimText('  账号: 服务端未返回(后端版本较旧或网络异常)'));
    }
  } catch (err) {
    if (err.message === 'UNAUTHORIZED') {
      console.log(warn('账号: Key 已失效,请重新运行 `npx @vibe-cafe/vibe-usage init`'));
      return;
    }
    console.log(dimText('  账号: 读取失败'));
  }
}

const VALID_CONFIG_KEYS = ['apiKey', 'apiUrl', 'hostname', 'codexExtraHome'];

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
      let value = args[2];
      if (!key || value === undefined) {
        console.error('Usage: vibe-usage config set <key> <value>');
        process.exit(1);
      }
      if (!VALID_CONFIG_KEYS.includes(key)) {
        console.error(`Unknown config key: ${key}`);
        console.error(`Valid keys: ${VALID_CONFIG_KEYS.join(', ')}`);
        process.exit(1);
      }
      if (key === 'codexExtraHome' && value !== '') {
        const validation = validateExtraCodexHome(value);
        if (!validation.ok) {
          console.error(failure(`额外 Codex Home 无效，需要包含 sessions/ 或 archived_sessions/: ${validation.path}`));
          process.exit(1);
        }
        value = validation.path;
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
    case 'add-root': {
      const source = args[1];
      const value = args[2];
      if (!source || value === undefined) {
        console.error(`Usage: vibe-usage config add-root <${EXTRA_ROOT_SOURCES.join('|')}> <path>`);
        process.exit(1);
      }
      const validation = validateExtraRoot(source, value);
      if (!validation.ok) {
        console.error(failure(`额外 ${source} 根目录无效（${validation.reason}）: ${validation.path}`));
        process.exit(1);
      }
      const config = loadConfig() || {};
      if (!config.extraRoots || typeof config.extraRoots !== 'object' || Array.isArray(config.extraRoots)) {
        config.extraRoots = {};
      }
      const roots = extraRootList(config.extraRoots[source]);
      config.extraRoots[source] = [...new Set([...roots, validation.path])];
      saveConfig(config);
      break;
    }
    case 'remove-root': {
      const source = args[1];
      const value = args[2];
      if (!EXTRA_ROOT_SOURCES.includes(source) || value === undefined) {
        console.error(`Usage: vibe-usage config remove-root <${EXTRA_ROOT_SOURCES.join('|')}> <path>`);
        process.exit(1);
      }
      const config = loadConfig() || {};
      const path = normalizeExtraRoot(value);
      const roots = extraRootList(config.extraRoots?.[source])
        .filter(root => normalizeExtraRoot(root) !== path);
      if (config.extraRoots && typeof config.extraRoots === 'object' && !Array.isArray(config.extraRoots)) {
        if (roots.length > 0) config.extraRoots[source] = roots;
        else delete config.extraRoots[source];
        if (Object.keys(config.extraRoots).length === 0) delete config.extraRoots;
      }
      saveConfig(config);
      break;
    }
    case 'roots': {
      const config = loadConfig();
      const roots = config?.extraRoots;
      console.log(JSON.stringify(
        roots && typeof roots === 'object' && !Array.isArray(roots) ? roots : {},
        null,
        2,
      ));
      break;
    }
    default:
      console.error(`Unknown config subcommand: ${sub || '(none)'}`);
      console.error('Usage: vibe-usage config <get|set|show|add-root|remove-root|roots>');
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

// Boolean global flag: present anywhere in argv → true, removed from args.
function extractFlag(args, name) {
  const flag = `--${name}`;
  const idx = args.findIndex(a => a === flag);
  if (idx === -1) return { args, value: false };
  return { args: [...args.slice(0, idx), ...args.slice(idx + 1)], value: true };
}

const BARE = 'npx @vibe-cafe/vibe-usage';

// The one command we advertise. Everything else stays supported (see
// `help --all`) but the default help must not read like a matrix.
const SHORT_HELP = `
  vibe-usage - Vibe Usage Tracker by VibeCafé

  用法:
    ${BARE}
        首次运行: 浏览器登录 → 同步 → 自动开启后台同步(每 30 分钟一次)
        之后运行: 手动同步一次

  常用:
    ${BARE} daemon status      查看后台同步
    ${BARE} daemon uninstall   关闭后台同步
    ${BARE} summary [--days N] 最近 N 天用量(默认 7)
    ${BARE} help --all         全部命令与选项

  旧命令(sync、init、daemon install …)仍可用，见 help --all。
`;

const FULL_HELP = `
  vibe-usage - Vibe Usage Tracker by VibeCafé

  Usage:
    ${BARE}              Init (first run, browser login, then background sync) or sync
    ${BARE} --no-daemon  Same, but do not install the background service on first run
    ${BARE} init         Set up via browser login (default)
    ${BARE} init --manual-key <vbu_...>   Skip browser, use a pre-issued key (CI/headless)
    ${BARE} sync         Manually sync usage data
    ${BARE} sync --extra-codex-home <path>  Use another Codex Home for this run
    ${BARE} summary       Print last 7 days as markdown (cost/tokens/tool/model/project)
    ${BARE} summary --days N   Same, but over the last N days (1-90)
    ${BARE} daemon       Continuous sync (every 30m, foreground)
    ${BARE} daemon install    Install background service (systemd/launchd/Task Scheduler)
    ${BARE} daemon uninstall  Remove background service
    ${BARE} daemon status     Show background service status
    ${BARE} daemon stop       Stop background service
    ${BARE} daemon restart    Restart background service
    ${BARE} reset        Delete all data and re-upload
    ${BARE} reset --local  Delete data for this host only and re-upload (--host is a legacy alias)
    ${BARE} skill         Install skill for AI coding tools
    ${BARE} skill --remove  Remove installed skills
    ${BARE} status       Show config and detected tools
    ${BARE} config show  Show full config as JSON
    ${BARE} config get <key>   Get a config value
    ${BARE} config set <key> <value>  Set a config value
    ${BARE} config set codexExtraHome <path>  Persist another Codex Home
    ${BARE} config add-root <tool> <path>  Add a Claude Code, Codex, Grok, OpenCode, Antigravity, or Pi data root
    ${BARE} config remove-root <tool> <path>  Remove an added data root
    ${BARE} config roots  Show added data roots as JSON
    ${BARE} help         Show the short help
    ${BARE} help --all   Show this full list
`;

export async function run(rawArgs) {
  // --key and --manual-key both mean "skip device flow, take this vbu_ key".
  // --manual-key is the documented name; --key is kept as a legacy alias so
  // existing scripts/docs don't break when device flow becomes the default.
  let stripped;
  let apiKey;
  ({ args: stripped, value: apiKey } = extractOption(rawArgs, 'manual-key'));
  if (apiKey === undefined) {
    ({ args: stripped, value: apiKey } = extractOption(stripped, 'key'));
    if (apiKey !== undefined) hint('--key 已改名 --manual-key，旧写法仍可用');
  }
  let noDaemon;
  ({ args: stripped, value: noDaemon } = extractFlag(stripped, 'no-daemon'));
  let codexExtraHome;
  ({ args: stripped, value: codexExtraHome } = extractOption(stripped, 'extra-codex-home'));
  if (codexExtraHome !== undefined) {
    const validation = validateExtraCodexHome(codexExtraHome);
    if (!validation.ok) {
      console.error(failure(`额外 Codex Home 无效，需要包含 sessions/ 或 archived_sessions/: ${validation.path}`));
      process.exit(1);
    }
    codexExtraHome = validation.path;
  }

  const args = stripped;
  const command = args[0];

  switch (command) {
    case 'init': {
      // Re-running init on a configured machine is the account re-bind path;
      // only a genuine first setup gets nudged toward the bare command.
      const firstSetup = !loadConfig()?.apiKey;
      const { runInit } = await import('./init.js');
      await runInit({ apiKey, codexExtraHome, noDaemon });
      if (firstSetup) hint(`以后直接运行 ${BARE} 即可：首次登录，之后同步`);
      break;
    }
    case 'sync': {
      printSmallHeader();
      const { runSync } = await import('./sync.js');
      await runSync({ codexExtraHome });
      hint(`以后直接运行 ${BARE} 就是同步，不用再加 sync`);
      break;
    }
    case 'summary': {
      const { runSummary } = await import('./summary.js');
      await runSummary(args.slice(1));
      break;
    }
    case 'reset': {
      printSmallHeader();
      if (args.includes('--host')) hint('reset --host 已改名 reset --local，旧写法仍可用');
      const { runReset } = await import('./reset.js');
      await runReset(args.slice(1));
      break;
    }
    case 'daemon':
    case '--daemon': {
      if (command === '--daemon') hint('--daemon 已改名 daemon，旧写法仍可用');
      const sub = args[1];
      if (sub === undefined) {
        // Foreground daemon loop — no header, just start syncing
        hint(`首次运行 ${BARE} 会自动开启后台同步，不用手动跑 daemon`);
        const { runDaemon } = await import('./daemon.js');
        await runDaemon({ codexExtraHome });
      } else {
        if (codexExtraHome !== undefined) {
          console.error(failure('后台 daemon 不接受临时 Codex Home，请先运行 `config set codexExtraHome <path>`。'));
          process.exit(1);
        }
        // manageDaemon validates the subcommand and exits 1 on unknown ones —
        // a typo (e.g. `daemon stauts`) must never fall through to the
        // infinite foreground loop.
        printSmallHeader();
        const { manageDaemon } = await import('./daemon-service.js');
        await manageDaemon(sub);
        if (sub === 'install') hint(`首次运行 ${BARE} 会自动开启后台同步，不用单独装`);
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
      console.log(args.includes('--all') ? FULL_HELP : SHORT_HELP);
      break;
    }
    case undefined: {
      // Bare invocation (no command): first run OR a one-shot --key setup →
      // init; already configured → sync.
      const config = loadConfig();
      if (!config?.apiKey || apiKey) {
        // First run OR user passed --key for a one-shot setup — init.js prints the big header
        const { runInit } = await import('./init.js');
        await runInit({ apiKey, codexExtraHome, noDaemon });
      } else {
        // Already configured: small header + sync
        printSmallHeader();
        const { runSync } = await import('./sync.js');
        await runSync({ codexExtraHome });
      }
      break;
    }
    default: {
      // Compatibility is explicit above: --key, --daemon, reset --host, and
      // the no-command init/sync behavior remain supported. Unknown words were
      // never public commands; failing them avoids typo-triggered side effects.
      console.error(`Unknown command: ${command}`);
      console.error('Run `vibe-usage help` to see available commands.');
      process.exit(1);
    }
  }
}
