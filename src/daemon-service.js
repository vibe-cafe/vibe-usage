import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync, unlinkSync, mkdirSync, existsSync, realpathSync } from 'node:fs';
import { join, win32 as winPath, posix as posixPath } from 'node:path';
import { homedir, platform, tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { success, failure, warn, dim } from './output.js';

const SERVICE_NAME = 'vibe-usage';
const LAUNCHD_LABEL = 'ai.vibecafe.vibe-usage';
// Same specifier the Mac app resolves on every sync (vibe-usage-app
// RuntimeDetector.swift): a service that runs this instead of a pinned bin
// path survives npx cache cleanup and picks up new releases at each login.
export const PACKAGE_SPEC = '@vibe-cafe/vibe-usage@latest';

function detectPlatform() {
  const os = platform();
  if (os === 'linux') {
    if (existsSync('/run/systemd/system')) return 'systemd';
    return null;
  }
  if (os === 'darwin') {
    return 'launchd';
  }
  if (os === 'win32') {
    return 'taskscheduler';
  }
  return null;
}

// npx cache paths are unstable — a service pinned to one breaks when the
// cache is cleared. POSIX: ~/.npm/_npx/<hash>/...; Windows:
// %LocalAppData%\npm-cache\_npx\...
export function isNpxCachePath(binPath) {
  return /[\\/]_npx[\\/]/.test(binPath);
}

/**
 * When the CLI itself came from the npx cache, the service should not pin
 * that path; it should re-resolve the package through npx at every start.
 * Returns null when no npx lives next to the running node (then the caller
 * falls back to pinning the path and warning, as before).
 */
export function npxLauncher(nodePath, exists = existsSync, os = platform()) {
  const paths = os === 'win32' ? winPath : posixPath;
  const nodeDir = paths.dirname(nodePath);
  const npxPath = paths.join(nodeDir, os === 'win32' ? 'npx.cmd' : 'npx');
  return exists(npxPath) ? { mode: 'npx', npxPath, nodeDir } : null;
}

function defaultTempDirs() {
  const dirs = new Set([tmpdir(), '/tmp', '/private/tmp']);
  try {
    dirs.add(realpathSync(tmpdir()));
  } catch {
    // keep the unresolved form
  }
  return [...dirs];
}

// A PATH entry that only lives as long as one shell: fnm's per-shell links
// (`fnm_multishells/<pid>_<time>/bin`) and anything under a temp directory.
function isShortLivedDir(dir, tempDirs) {
  if (dir.split('/').includes('fnm_multishells')) return true;
  return tempDirs.some(temp => dir === temp || dir.startsWith(`${temp}/`));
}

/**
 * The runtime path a service should pin. Homebrew / Linuxbrew put node on PATH
 * as a symlink into a versioned keg (`/opt/homebrew/bin/node` ->
 * `../Cellar/node/26.8.2/bin/node`), and `process.execPath` is that resolved,
 * versioned path; `brew upgrade node` deletes it and the service never starts
 * again. So prefer the first PATH entry that resolves to the very same binary,
 * which the package manager re-points on upgrade. Short-lived PATH entries are
 * skipped. No match (nvm, Volta, a plain binary) -> `execPath`, as before.
 * Windows keeps `execPath`.
 */
export function stableRuntimePath(execPath, {
  pathEnv = process.env.PATH,
  os = platform(),
  resolve = realpathSync,
  tempDirs = defaultTempDirs(),
} = {}) {
  if (os === 'win32' || !pathEnv) return execPath;
  let target;
  try {
    target = resolve(execPath);
  } catch {
    return execPath;
  }
  const name = posixPath.basename(execPath);
  for (const dir of pathEnv.split(':')) {
    if (!posixPath.isAbsolute(dir) || isShortLivedDir(dir, tempDirs)) continue;
    const candidate = posixPath.join(dir, name);
    try {
      if (resolve(candidate) === target) return candidate;
    } catch {
      // not on this PATH entry
    }
  }
  return execPath;
}

/**
 * What `install()` registers: the runtime path, and in npx mode the npx next
 * to it. The npx next to the stable path wins; the one next to `execPath` is
 * the fallback (as before) when the stable directory has none.
 */
export function resolveServiceLaunch(execPath, binPath, options = {}) {
  const { exists = existsSync, os = platform() } = options;
  const nodePath = stableRuntimePath(execPath, { ...options, os });
  const isNpxCache = isNpxCachePath(binPath);
  let launcher = null;
  if (isNpxCache) {
    launcher = npxLauncher(nodePath, exists, os);
    if (!launcher && nodePath !== execPath) launcher = npxLauncher(execPath, exists, os);
  }
  return { nodePath, isNpxCache, launcher };
}

function resolvePaths() {
  const thisFile = fileURLToPath(import.meta.url);
  const binPath = join(thisFile, '..', '..', 'bin', 'vibe-usage.js');
  return { binPath, ...resolveServiceLaunch(process.execPath, binPath) };
}

// argv the service runs; the last token is always `daemon` so process
// matching and log greps keep working across both modes.
function serviceArgv(nodePath, binPath, launcher) {
  if (launcher?.mode === 'npx') return [launcher.npxPath, '--yes', PACKAGE_SPEC, 'daemon'];
  return [nodePath, binPath, 'daemon'];
}

// npx is a `#!/usr/bin/env node` script and launchd / systemd start services
// with a minimal PATH that has no node on it.
function servicePath(launcher) {
  return [launcher.nodeDir, '/usr/local/bin', '/usr/bin', '/bin'].join(':');
}

function getServicePaths(plat) {
  if (plat === 'systemd') {
    const dir = join(homedir(), '.config', 'systemd', 'user');
    return { dir, file: join(dir, `${SERVICE_NAME}.service`) };
  }
  if (plat === 'launchd') {
    const dir = join(homedir(), 'Library', 'LaunchAgents');
    return { dir, file: join(dir, `${LAUNCHD_LABEL}.plist`) };
  }
  if (plat === 'taskscheduler') {
    const dir = join(homedir(), '.vibe-usage');
    return {
      dir,
      file: join(dir, 'daemon-task.xml'),
      cmd: join(dir, 'daemon-task.cmd'),
      vbs: join(dir, 'daemon-task.vbs'),
    };
  }
  return null;
}

function escapeSystemdEnvironment(value) {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

// In `set "KEY=VALUE"`, cmd expands %VAR% on the line, so literal percents must double
function escapeCmdValue(value) {
  return value.replace(/%/g, '%%');
}

function psString(value) {
  return `'${value.replace(/'/g, "''")}'`;
}

function escapeXml(value) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// Variables that relocate a tool's on-disk store. The service runs from a
// launchd/systemd unit that inherits nothing, so anything the parsers read for
// discovery has to be captured into the unit at install time. Keep this list in
// sync with the store-locating variables the parsers and roots modules read
// (`grep -rho 'process\.env\.[A-Z_]*' src/parsers src/*-roots.js`): a variable
// missing here makes the background service sync a different store than the
// foreground CLI (issue #112). Test-only overrides (`VIBE_USAGE_*`) and
// accounting knobs are deliberately absent -- they do not relocate a store.
const PRESERVED_SERVICE_ENV = [
  'AMP_DATA_DIR',
  'CLINE_DIR',
  'CLINE_DATA_DIR',
  'CLINE_SESSION_DATA_DIR',
  'CODEBUDDY_CONFIG_DIR',
  'CODEX_HOME',
  'COLA_DATA_DIR',
  'CRAFT_AGENT_DIR',
  'CRAFTAGENT_DIR',
  'CURSOR_CONFIG_DIR',
  'DIMCODE_HOME',
  'DSH_HOME',
  'GROK_HOME',
  'HERMES_HOME',
  'KIKI_HOME',
  'KILO_DB',
  'KIMI_CODE_HOME',
  'KIRO_BASE_PATH',
  'KIRO_CLI_DB_PATH',
  'KIRO_CLI_SESSIONS_DIR',
  'KIRO_SESSIONS_DIR',
  'KIRO_USER_PATH',
  'MAVIS_DATA_DIR',
  'MCODE_HOME',
  'MIMOCODE_HOME',
  'MIMOCODE_DB',
  'MINIMAX_DATA_DIR',
  'PI_CONFIG_DIR',
  'PI_CODING_AGENT_DIR',
  'PI_CODING_AGENT_SESSION_DIR',
  'XDG_DATA_HOME',
];

function serviceEnvironment(claudeConfigDir, env) {
  const values = {
    CLAUDE_CONFIG_DIR: claudeConfigDir,
    ...Object.fromEntries(PRESERVED_SERVICE_ENV.map(key => [key, env[key]?.trim()])),
  };
  return Object.entries(values).filter(([, value]) => value);
}

export function generateSystemdUnit(
  nodePath,
  binPath,
  claudeConfigDir = process.env.CLAUDE_CONFIG_DIR?.trim(),
  env = process.env,
  launcher = null,
) {
  const npx = launcher?.mode === 'npx';
  const pathLine = npx ? `Environment="PATH=${escapeSystemdEnvironment(servicePath(launcher))}"\n` : '';
  const environment = serviceEnvironment(claudeConfigDir, env)
    .map(([key, value]) => `Environment="${key}=${escapeSystemdEnvironment(value)}"\n`)
    .join('');
  // npx mode needs the registry at start; RestartSec=60 keeps an offline boot
  // from turning into a restart storm.
  return `[Unit]
Description=VibeCafe Usage Tracker
After=network.target

[Service]
Type=simple
ExecStart=${serviceArgv(nodePath, binPath, launcher).join(' ')}
Restart=on-failure
RestartSec=${npx ? 60 : 10}
Environment=NODE_ENV=production
${pathLine}${environment}WorkingDirectory=${homedir()}

[Install]
WantedBy=default.target
`;
}

export function generateLaunchdPlist(
  nodePath,
  binPath,
  claudeConfigDir = process.env.CLAUDE_CONFIG_DIR?.trim(),
  env = process.env,
  launcher = null,
) {
  const npx = launcher?.mode === 'npx';
  const logDir = join(homedir(), '.vibe-usage');
  const programArguments = serviceArgv(nodePath, binPath, launcher)
    .map(arg => `        <string>${escapeXml(arg)}</string>\n`)
    .join('');
  const pathEntry = npx
    ? `        <key>PATH</key>\n        <string>${escapeXml(servicePath(launcher))}</string>\n`
    : '';
  const environment = serviceEnvironment(claudeConfigDir, env)
    .map(([key, value]) => `        <key>${key}</key>\n        <string>${escapeXml(value)}</string>\n`)
    .join('');
  // ThrottleInterval only matters in npx mode: an offline boot makes npx exit
  // non-zero and KeepAlive would otherwise relaunch it every 10 seconds.
  const throttle = npx ? `    <key>ThrottleInterval</key>\n    <integer>60</integer>\n` : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LAUNCHD_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
${programArguments}    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
${throttle}    <key>WorkingDirectory</key>
    <string>${homedir()}</string>
    <key>StandardOutPath</key>
    <string>${join(logDir, 'daemon.log')}</string>
    <key>StandardErrorPath</key>
    <string>${join(logDir, 'daemon.err')}</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>NODE_ENV</key>
        <string>production</string>
${pathEntry}${environment}    </dict>
</dict>
</plist>
`;
}

export function generateWindowsTaskCmd(
  nodePath,
  binPath,
  claudeConfigDir = process.env.CLAUDE_CONFIG_DIR?.trim(),
  env = process.env,
  launcher = null,
) {
  const logPath = join(homedir(), '.vibe-usage', 'daemon.log');
  const lines = [
    '@echo off',
    'rem Generated by `vibe-usage daemon install` - reinstalling overwrites this file',
    'set "NODE_ENV=production"',
  ];
  if (launcher?.mode === 'npx') {
    // npx.cmd re-launches node by name; the logon task's PATH may not have it.
    lines.push(`set "PATH=${escapeCmdValue(launcher.nodeDir)};%PATH%"`);
  }
  for (const [key, value] of serviceEnvironment(claudeConfigDir, env)) {
    lines.push(`set "${key}=${escapeCmdValue(value)}"`);
  }
  const invocation = launcher?.mode === 'npx'
    ? `"${escapeCmdValue(launcher.npxPath)}" --yes ${PACKAGE_SPEC} daemon`
    : `"${escapeCmdValue(nodePath)}" "${escapeCmdValue(binPath)}" daemon`;
  lines.push(`${invocation} >> "${escapeCmdValue(logPath)}" 2>&1`);
  return lines.join('\r\n') + '\r\n';
}

export function generateWindowsTaskVbs(cmdPath) {
  const lines = [
    "' Vibe Usage daemon launcher - window style 0 keeps the logon session console-free;",
    "' waitOnReturn=True keeps the task's Running state true to the daemon's lifetime",
    "' (so MultipleInstancesPolicy can veto a second start while one daemon lives)",
    `CreateObject("WScript.Shell").Run """${cmdPath}""", 0, True`,
  ];
  return lines.join('\r\n') + '\r\n';
}

// Task Scheduler kills tasks after its default 72h execution limit unless the XML
// pins ExecutionTimeLimit to PT0S — the daemon is meant to run indefinitely.
// Registered via `Register-ScheduledTask -Xml`: `schtasks /create /sc onlogon`
// demands elevation, while a self-scoped LogonTrigger does not (verified non-admin).
// The declaration must say UTF-16 or the Task Scheduler COM parser rejects the
// registration with an XML format error, even though the string handed to
// Register-ScheduledTask is read from the UTF-8 file via Get-Content -Raw.
export function generateWindowsTaskXml(userId, wscriptPath, vbsPath) {
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>VibeCafe Usage Tracker background sync daemon</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <UserId>${escapeXml(userId)}</UserId>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${escapeXml(userId)}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${escapeXml(wscriptPath)}</Command>
      <Arguments>"${escapeXml(vbsPath)}"</Arguments>
    </Exec>
  </Actions>
</Task>
`;
}

function run(cmd, args) {
  try {
    const output = execFileSync(cmd, args, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    return { ok: true, output: output.trim() };
  } catch (err) {
    return { ok: false, output: (err.stderr || err.stdout || err.message || '').trim() };
  }
}

function runPowerShell(script) {
  return run('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    script,
  ]);
}

// $ErrorActionPreference='Stop' turns cmdlet failures into the catch block's exit 1,
// since -Command otherwise exits 0 even after a non-terminating error.
function psTry(scriptLines) {
  return [
    "$ErrorActionPreference = 'Stop'",
    'try {',
    ...scriptLines.map(line => `  ${line}`),
    '  exit 0',
    '} catch {',
    '  [Console]::Error.WriteLine($_.Exception.Message)',
    '  exit 1',
    '}',
  ].join('\n');
}

function taskExists() {
  const result = runPowerShell(
    `if (Get-ScheduledTask -TaskName ${psString(SERVICE_NAME)} -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }`,
  );
  return result.ok;
}

function windowsUserId() {
  const domain = process.env.USERDOMAIN?.trim();
  const user = process.env.USERNAME?.trim();
  if (domain && user) return `${domain}\\${user}`;
  const result = run('whoami', []);
  return result.ok ? result.output : null;
}

// The cmd wrapper is the install-time record of the exact runtime + CLI
// invocation. Process matching uses both paths so it works for Node and Bun
// without touching foreground daemons from another checkout.
export function parseWindowsTaskInvocation(cmd) {
  const unescapeCmdValue = value => value.replace(/%%/g, '%');
  const pinned = cmd.match(/^"([^"]+)" "([^"]+)" daemon\b/m);
  if (pinned) {
    return {
      runtimePath: unescapeCmdValue(pinned[1]),
      binPath: unescapeCmdValue(pinned[2]),
    };
  }
  // npx mode: the live daemon is node.exe (next to npx.cmd) running the
  // cached bin, whose path we cannot know in advance — match on the bin name.
  const npx = cmd.match(/^"([^"]+)" --yes @vibe-cafe\/vibe-usage@\S+ daemon\b/m);
  if (npx) {
    const npxPath = unescapeCmdValue(npx[1]);
    return {
      runtimePath: winPath.join(winPath.dirname(npxPath), 'node.exe'),
      binPath: 'vibe-usage.js',
      mode: 'npx',
      npxPath,
    };
  }
  return null;
}

function readTaskInvocation(paths) {
  try {
    return parseWindowsTaskInvocation(readFileSync(paths.cmd, 'utf-8'));
  } catch {
    return null;
  }
}

// -like treats []*? as wildcards; a literal path containing any of them must be
// bracket-escaped to still match.
function psLikeFragment(value) {
  return value.replace(/[[\]*?]/g, '[$&]');
}

export function windowsDaemonProcessExpression(invocation) {
  if (!invocation) return null;
  const binPattern = `'*${psLikeFragment(invocation.binPath)}* daemon*'`;
  return `Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -ieq ${psString(invocation.runtimePath)} -and $_.CommandLine -like ${binPattern} }`;
}

function daemonProcessKillLines(invocation) {
  const expression = windowsDaemonProcessExpression(invocation);
  return expression
    ? [`${expression} | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`]
    : [];
}

export function isDaemonPlatform() {
  return detectPlatform() !== null;
}

// A leftover daemon-task.xml without a registration (crashed uninstall) must
// not block a fresh install, so Task Scheduler checks the live task instead.
export function isDaemonInstalled() {
  const plat = detectPlatform();
  if (!plat) return false;
  const paths = getServicePaths(plat);
  return plat === 'taskscheduler' ? taskExists() : existsSync(paths.file);
}

// An installed service whose registered node/npx/bin no longer exists.
export function isDaemonLaunchBroken() {
  const plat = detectPlatform();
  if (!plat) return false;
  return missingLaunchPaths(plat, getServicePaths(plat))?.length > 0;
}

/**
 * Read-only summary for `doctor`: the service platform, whether the service is
 * installed, how it launches (`npx` / `pinned`) and whether the files it
 * launches still exist (`launchPathExists`). Never starts, queries the
 * run state of, or changes the service.
 */
export function daemonSummary() {
  const plat = detectPlatform();
  if (!plat) return { platform: null, installed: false, mode: null, launchPathExists: null };
  const paths = getServicePaths(plat);
  const installed = plat === 'taskscheduler' ? taskExists() : existsSync(paths.file);
  if (!installed) return { platform: plat, installed, mode: null, launchPathExists: null };
  const missing = missingLaunchPaths(plat, paths);
  return {
    platform: plat,
    installed,
    mode: describeInstalledMode(plat, paths),
    launchPathExists: missing ? missing.length === 0 : null,
  };
}

function unescapeXml(value) {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * The files an installed unit starts, read back from the unit text: the npx
 * binary in npx mode, the runtime and the bin script when pinned. `null` when
 * the text has no recognizable invocation.
 */
export function launchPathsFromText(plat, text) {
  if (plat === 'taskscheduler') {
    const invocation = parseWindowsTaskInvocation(text);
    if (!invocation) return null;
    return invocation.mode === 'npx' ? [invocation.npxPath] : [invocation.runtimePath, invocation.binPath];
  }
  let argv = null;
  if (plat === 'launchd') {
    const block = text.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/);
    if (block) argv = [...block[1].matchAll(/<string>([^<]*)<\/string>/g)].map(match => unescapeXml(match[1]));
  } else if (plat === 'systemd') {
    const line = text.match(/^ExecStart=(.+)$/m);
    if (line) argv = line[1].trim().split(/\s+/);
  }
  if (!argv?.length) return null;
  return installedModeFromText(text) === 'npx' ? [argv[0]] : argv.slice(0, 2);
}

/**
 * Registered launch paths that no longer exist (e.g. the versioned node an
 * upgrade deleted): `[]` when all are there, `null` when the unit cannot be
 * read or parsed. A service with a missing path cannot start at all.
 */
export function missingLaunchPaths(plat, paths, exists = existsSync) {
  let text;
  try {
    text = readFileSync(plat === 'taskscheduler' ? paths.cmd : paths.file, 'utf-8');
  } catch {
    return null;
  }
  const launch = launchPathsFromText(plat, text);
  return launch ? launch.filter(path => !exists(path)) : null;
}

const REINSTALL_COMMAND = 'npx @vibe-cafe/vibe-usage daemon install';

// How an installed service starts the daemon, read back from the unit itself
// so `status` tells the truth about machines set up by older versions. The
// plist splits argv into separate <string> elements, so look for the package
// spec alone: a pinned bin path contains `@vibe-cafe/vibe-usage/bin`, never
// `@latest`.
export function installedModeFromText(text) {
  return text.includes(PACKAGE_SPEC) ? 'npx' : 'pinned';
}

export function describeInstalledMode(plat, paths) {
  try {
    return installedModeFromText(readFileSync(plat === 'taskscheduler' ? paths.cmd : paths.file, 'utf-8'));
  } catch {
    return null;
  }
}

function install() {
  const plat = detectPlatform();
  if (!plat) {
    console.log(failure('当前平台不支持 daemon。'));
    console.log(dim('  支持: Linux (systemd) / macOS (launchd) / Windows (Task Scheduler)'));
    return;
  }

  const { nodePath, binPath, isNpxCache, launcher } = resolvePaths();

  if (isNpxCache && !launcher) {
    console.log(warn('检测到从 npx 缓存运行 vibe-usage 且找不到 npx,缓存清理后 daemon 会失效。'));
    console.log(dim('  建议先全局安装:  npm install -g @vibe-cafe/vibe-usage'));
    console.log();
  }

  const paths = getServicePaths(plat);

  if (isDaemonInstalled()) {
    // A registration whose node/npx is gone can never start again, so
    // `daemon install` replaces it; a working one is left alone, as before.
    if (!missingLaunchPaths(plat, paths)?.length) {
      console.log(warn('Daemon 已安装，运行 `vibe-usage daemon restart` 或 `uninstall` 先处理。'));
      return;
    }
    console.log(warn('已注册的后台服务启动路径已不存在（常见于升级 Node 之后），先移除旧注册再重新安装。'));
    uninstall();
  }

  mkdirSync(paths.dir, { recursive: true });

  if (plat === 'systemd') {
    writeFileSync(paths.file, generateSystemdUnit(nodePath, binPath, undefined, process.env, launcher), 'utf-8');
    console.log(dim(`  已写入 ${paths.file}`));

    run('systemctl', ['--user', 'daemon-reload']);
    const result = run('systemctl', ['--user', 'enable', '--now', `${SERVICE_NAME}.service`]);
    if (!result.ok) {
      console.error(failure(`启动服务失败: ${result.output}`));
      return;
    }
    console.log(success('服务已启用并启动。'));
  }

  if (plat === 'launchd') {
    mkdirSync(join(homedir(), '.vibe-usage'), { recursive: true });
    writeFileSync(paths.file, generateLaunchdPlist(nodePath, binPath, undefined, process.env, launcher), 'utf-8');
    console.log(dim(`  已写入 ${paths.file}`));

    const result = run('launchctl', ['load', paths.file]);
    if (!result.ok) {
      console.error(failure(`加载服务失败: ${result.output}`));
      return;
    }
    console.log(success('服务已加载并启动。'));
  }

  if (plat === 'taskscheduler') {
    const userId = windowsUserId();
    if (!userId) {
      console.error(failure('无法确定当前 Windows 用户，安装中止。'));
      return;
    }
    const wscriptPath = join(
      process.env.WINDIR?.trim() || process.env.SystemRoot?.trim() || 'C:\\Windows',
      'System32',
      'wscript.exe',
    );

    writeFileSync(paths.cmd, generateWindowsTaskCmd(nodePath, binPath, undefined, process.env, launcher), 'utf-8');
    writeFileSync(paths.vbs, generateWindowsTaskVbs(paths.cmd), 'utf-8');
    writeFileSync(paths.file, generateWindowsTaskXml(userId, wscriptPath, paths.vbs), 'utf-8');
    console.log(dim(`  已写入 ${paths.file}`));

    // Get-Content must force UTF8: the XML is written without a BOM and default
    // decoding on e.g. zh-CN systems is ANSI, which mangles non-ASCII paths
    const result = runPowerShell(psTry([
      `Register-ScheduledTask -TaskName ${psString(SERVICE_NAME)} -Xml (Get-Content -Raw -Encoding UTF8 ${psString(paths.file)}) -Force | Out-Null`,
      `Start-ScheduledTask -TaskName ${psString(SERVICE_NAME)}`,
    ]));
    if (!result.ok) {
      console.error(failure(`注册/启动计划任务失败: ${result.output}`));
      return;
    }
    console.log(success('计划任务已注册并启动。'));
  }

  console.log();
  console.log(success('已开启后台自动同步（每 30 分钟一次，登录自启）。'));
  if (launcher?.mode === 'npx') {
    console.log(dim('  服务通过 npx 启动，每次登录自动使用最新版。'));
  }
  console.log(dim('  关闭: npx @vibe-cafe/vibe-usage daemon uninstall'));
}

function uninstall() {
  const plat = detectPlatform();
  if (!plat) {
    console.log(failure('未检测到支持的服务平台。'));
    return;
  }

  const paths = getServicePaths(plat);

  const installed = plat === 'taskscheduler'
    ? taskExists() || existsSync(paths.file)
    : existsSync(paths.file);
  if (!installed) {
    console.log(dim('未安装 daemon 服务。'));
    return;
  }

  if (plat === 'systemd') {
    run('systemctl', ['--user', 'stop', `${SERVICE_NAME}.service`]);
    run('systemctl', ['--user', 'disable', `${SERVICE_NAME}.service`]);
    unlinkSync(paths.file);
    run('systemctl', ['--user', 'daemon-reload']);
    console.log(success('服务已停止、禁用并删除。'));
  }

  if (plat === 'launchd') {
    run('launchctl', ['unload', paths.file]);
    unlinkSync(paths.file);
    console.log(success('服务已卸载并删除。'));
  }

  if (plat === 'taskscheduler') {
    if (taskExists()) {
      const result = runPowerShell(psTry([
        `Stop-ScheduledTask -TaskName ${psString(SERVICE_NAME)} -ErrorAction SilentlyContinue`,
        ...daemonProcessKillLines(readTaskInvocation(paths)),
        `Unregister-ScheduledTask -TaskName ${psString(SERVICE_NAME)} -Confirm:$false`,
      ]));
      if (!result.ok) {
        console.error(failure(`删除计划任务失败: ${result.output}`));
        return;
      }
    }
    for (const file of [paths.file, paths.cmd, paths.vbs]) {
      if (existsSync(file)) unlinkSync(file);
    }
    console.log(success('服务已卸载并删除。'));
  }
}

function status() {
  const plat = detectPlatform();
  if (!plat) {
    console.log(failure('未检测到支持的服务平台。'));
    return;
  }

  const paths = getServicePaths(plat);

  const printRegistration = () => {
    const mode = describeInstalledMode(plat, paths);
    if (mode === 'npx') console.log(dim(`  运行方式: npx ${PACKAGE_SPEC}（每次登录自动更新）`));
    else if (mode === 'pinned') console.log(dim('  运行方式: 固定路径（升级后需 daemon uninstall 再重跑一条命令）'));
    const missing = missingLaunchPaths(plat, paths);
    if (missing?.length) {
      console.log(warn('后台服务的启动路径已失效，下次启动时（如重启电脑后）会失败；正在运行的后台进程可能还在跑。'));
      for (const path of missing) console.log(dim(`  找不到: ${path}`));
      console.log(dim(`  常见于升级或卸载 Node 之后。运行 \`${REINSTALL_COMMAND}\` 重新注册。`));
    }
  };

  if (plat === 'taskscheduler') {
    if (!taskExists()) {
      console.log(dim('未安装 daemon 服务。'));
      console.log(dim('  运行 `vibe-usage daemon install` 安装。'));
      return;
    }
    printRegistration();
    const invocation = readTaskInvocation(paths);
    const processExpression = windowsDaemonProcessExpression(invocation);
    const scriptLines = [
      `$t = Get-ScheduledTask -TaskName ${psString(SERVICE_NAME)} -ErrorAction SilentlyContinue`,
      'if (-not $t) { exit 1 }',
      'Write-Output ("State=" + $t.State)',
    ];
    if (processExpression) {
      scriptLines.push(
        `$p = ${processExpression} | Select-Object -First 1`,
        'if ($p) { Write-Output "DaemonProcess=running" } else { Write-Output "DaemonProcess=stopped" }',
      );
    }
    scriptLines.push(
      '$i = Get-ScheduledTaskInfo -TaskName ' + psString(SERVICE_NAME) + ' -ErrorAction SilentlyContinue',
      'if ($i -and $i.LastRunTime.Year -gt 1) { Write-Output ("LastRunTime=" + $i.LastRunTime.ToString("s")) }',
      'if ($i) { Write-Output ("LastTaskResult=" + $i.LastTaskResult) }',
    );
    const result = runPowerShell(scriptLines.join('\n'));
    if (!result.ok) {
      console.log(warn('无法读取计划任务状态。'));
      return;
    }
    const lines = Object.fromEntries(result.output
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean)
      .map(line => {
        const idx = line.indexOf('=');
        return idx === -1 ? [line, ''] : [line.slice(0, idx), line.slice(idx + 1)];
      }));
    // The live runtime process is the source of truth; the task State can lag.
    const running = processExpression
      ? lines.DaemonProcess === 'running'
      : lines.State === 'Running';
    if (running) {
      console.log(success('服务运行中。'));
    } else if (lines.State === 'Ready' || lines.State === 'Stopped' || lines.State === 'Running') {
      console.log(warn('服务已安装但当前未运行。'));
    } else {
      console.log(warn(`服务状态异常: ${lines.State || '未知'}`));
    }
    for (const key of ['LastRunTime', 'LastTaskResult']) {
      if (lines[key]) console.log(dim(`  ${key}=${lines[key]}`));
    }
    if (!running) {
      console.log(dim(`  查看日志: ${join(homedir(), '.vibe-usage', 'daemon.log')}，或运行 \`vibe-usage daemon restart\`。`));
    }
    return;
  }

  if (!existsSync(paths.file)) {
    console.log(dim('未安装 daemon 服务。'));
    console.log(dim('  运行 `vibe-usage daemon install` 安装。'));
    return;
  }
  printRegistration();

  if (plat === 'systemd') {
    const result = run('systemctl', ['--user', 'status', `${SERVICE_NAME}.service`]);
    console.log(dim(result.output));
  }

  if (plat === 'launchd') {
    const result = run('launchctl', ['list', LAUNCHD_LABEL]);
    if (result.ok) {
      console.log(dim(`Service: ${LAUNCHD_LABEL}`));
      console.log(dim(result.output));
    } else {
      console.log(warn('服务已安装但当前未运行。'));
    }
  }
}

function stop() {
  const plat = detectPlatform();
  if (!plat) {
    console.log(failure('未检测到支持的服务平台。'));
    return;
  }

  if (plat === 'systemd') {
    const result = run('systemctl', ['--user', 'stop', `${SERVICE_NAME}.service`]);
    console.log(result.ok ? success('服务已停止。') : failure(`停止失败: ${result.output}`));
  }

  if (plat === 'launchd') {
    // The plist sets KeepAlive=true, so `launchctl stop` is useless here —
    // launchd immediately relaunches the job and the daemon keeps running.
    // unload removes the job from launchd entirely; the plist file stays on
    // disk, so `daemon restart` (load) and status detection keep working.
    const paths = getServicePaths(plat);
    if (!existsSync(paths.file)) {
      console.log(dim('未安装 daemon 服务。'));
      return;
    }
    const result = run('launchctl', ['unload', paths.file]);
    console.log(result.ok ? success('服务已停止。') : failure(`停止失败: ${result.output}`));
  }

  if (plat === 'taskscheduler') {
    if (!taskExists()) {
      console.log(dim('未安装 daemon 服务。'));
      return;
    }
    // The logon trigger stays registered, so like launchd's unload the daemon
    // stays stopped until `restart` or the next logon. Stop-ScheduledTask only
    // terminates the wscript wrapper, so the real runtime daemon is matched and
    // killed explicitly.
    const paths = getServicePaths(plat);
    const invocation = readTaskInvocation(paths);
    const result = runPowerShell(psTry([
      `Stop-ScheduledTask -TaskName ${psString(SERVICE_NAME)} -ErrorAction SilentlyContinue`,
      ...daemonProcessKillLines(invocation),
    ]));
    console.log(result.ok ? success('服务已停止。') : failure(`停止失败: ${result.output}`));
  }
}

function restart() {
  const plat = detectPlatform();
  if (!plat) {
    console.log(failure('未检测到支持的服务平台。'));
    return;
  }

  if (plat === 'systemd') {
    const result = run('systemctl', ['--user', 'restart', `${SERVICE_NAME}.service`]);
    console.log(result.ok ? success('服务已重启。') : failure(`重启失败: ${result.output}`));
  }

  if (plat === 'launchd') {
    // unload + load (not stop + start): stop can't win against KeepAlive, and
    // load re-runs the job immediately thanks to RunAtLoad=true.
    const paths = getServicePaths(plat);
    run('launchctl', ['unload', paths.file]);
    const result = run('launchctl', ['load', paths.file]);
    console.log(result.ok ? success('服务已重启。') : failure(`重启失败: ${result.output}`));
  }

  if (plat === 'taskscheduler') {
    if (!taskExists()) {
      console.log(dim('未安装 daemon 服务。'));
      return;
    }
    const paths = getServicePaths(plat);
    const invocation = readTaskInvocation(paths);
    const taskName = psString(SERVICE_NAME);
    const result = runPowerShell(psTry([
      `$t = Get-ScheduledTask -TaskName ${taskName}`,
      "if ($t.State -eq 'Running') {",
      `  Stop-ScheduledTask -TaskName ${taskName} -ErrorAction SilentlyContinue`,
      ...daemonProcessKillLines(invocation),
      '  $deadline = (Get-Date).AddSeconds(5)',
      `  while ((Get-ScheduledTask -TaskName ${taskName}).State -eq 'Running' -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 200 }`,
      '}',
      `Start-ScheduledTask -TaskName ${taskName}`,
    ]));
    console.log(result.ok ? success('服务已重启。') : failure(`重启失败: ${result.output}`));
  }
}

const SUBCOMMANDS = { install, uninstall, status, stop, restart };

export async function manageDaemon(subcommand) {
  const fn = SUBCOMMANDS[subcommand];
  if (!fn) {
    console.error(failure(`未知 daemon 子命令: ${subcommand}`));
    console.error(dim('  用法: vibe-usage daemon <install|uninstall|status|stop|restart>'));
    process.exit(1);
  }
  fn();
}
