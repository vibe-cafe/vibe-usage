import { execFileSync } from 'node:child_process';
import { writeFileSync, unlinkSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, platform } from 'node:os';
import { fileURLToPath } from 'node:url';

const SERVICE_NAME = 'vibe-usage';
const LAUNCHD_LABEL = 'ai.vibecafe.vibe-usage';

function detectPlatform() {
  const os = platform();
  if (os === 'linux') {
    if (existsSync('/run/systemd/system')) return 'systemd';
    return null;
  }
  if (os === 'darwin') {
    return 'launchd';
  }
  return null;
}

function resolvePaths() {
  const nodePath = process.execPath;
  const thisFile = fileURLToPath(import.meta.url);
  const binPath = join(thisFile, '..', '..', 'bin', 'vibe-usage.js');

  // npx cache paths are unstable — service will break when cache is cleared
  const isNpxCache = binPath.includes('.npm/_npx');

  return { nodePath, binPath, isNpxCache };
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
  return null;
}

function generateSystemdUnit(nodePath, binPath) {
  return `[Unit]
Description=VibeCafe Usage Tracker
After=network.target

[Service]
Type=simple
ExecStart=${nodePath} ${binPath} daemon
Restart=on-failure
RestartSec=10
Environment=NODE_ENV=production
WorkingDirectory=${homedir()}

[Install]
WantedBy=default.target
`;
}

function generateLaunchdPlist(nodePath, binPath) {
  const logDir = join(homedir(), '.vibe-usage');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LAUNCHD_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${nodePath}</string>
        <string>${binPath}</string>
        <string>daemon</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>WorkingDirectory</key>
    <string>${homedir()}</string>
    <key>StandardOutPath</key>
    <string>${join(logDir, 'daemon.log')}</string>
    <key>StandardErrorPath</key>
    <string>${join(logDir, 'daemon.err')}</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>NODE_ENV</key>
        <string>production</string>
    </dict>
</dict>
</plist>
`;
}

function run(cmd, args) {
  try {
    const output = execFileSync(cmd, args, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { ok: true, output: output.trim() };
  } catch (err) {
    return { ok: false, output: (err.stderr || err.stdout || err.message || '').trim() };
  }
}

function install() {
  const plat = detectPlatform();
  if (!plat) {
    console.log('Daemon install is not supported on this platform.');
    console.log('Supported: Linux (systemd), macOS (launchd).');
    return;
  }

  const { nodePath, binPath, isNpxCache } = resolvePaths();

  if (isNpxCache) {
    console.log('Warning: vibe-usage appears to be running from the npx cache.');
    console.log('The daemon may break when the cache is cleared.');
    console.log('For reliable operation, install globally first:');
    console.log('  npm install -g @vibe-cafe/vibe-usage\n');
  }

  const paths = getServicePaths(plat);

  if (existsSync(paths.file)) {
    console.log('Service is already installed. Run `vibe-usage daemon restart` or `daemon uninstall` first.');
    return;
  }

  mkdirSync(paths.dir, { recursive: true });

  if (plat === 'systemd') {
    writeFileSync(paths.file, generateSystemdUnit(nodePath, binPath), 'utf-8');
    console.log(`Created ${paths.file}`);

    run('systemctl', ['--user', 'daemon-reload']);
    const result = run('systemctl', ['--user', 'enable', '--now', `${SERVICE_NAME}.service`]);
    if (!result.ok) {
      console.error(`Failed to start service: ${result.output}`);
      return;
    }
    console.log('Service enabled and started.');
  }

  if (plat === 'launchd') {
    mkdirSync(join(homedir(), '.vibe-usage'), { recursive: true });
    writeFileSync(paths.file, generateLaunchdPlist(nodePath, binPath), 'utf-8');
    console.log(`Created ${paths.file}`);

    const result = run('launchctl', ['load', paths.file]);
    if (!result.ok) {
      console.error(`Failed to load service: ${result.output}`);
      return;
    }
    console.log('Service loaded and started.');
  }

  console.log('\nDaemon installed. Usage data will sync automatically every 30 minutes.');
  console.log('Run `vibe-usage daemon status` to check.');
}

function uninstall() {
  const plat = detectPlatform();
  if (!plat) {
    console.log('No supported service platform detected.');
    return;
  }

  const paths = getServicePaths(plat);

  if (!existsSync(paths.file)) {
    console.log('No daemon service is installed.');
    return;
  }

  if (plat === 'systemd') {
    run('systemctl', ['--user', 'stop', `${SERVICE_NAME}.service`]);
    run('systemctl', ['--user', 'disable', `${SERVICE_NAME}.service`]);
    unlinkSync(paths.file);
    run('systemctl', ['--user', 'daemon-reload']);
    console.log('Service stopped, disabled, and removed.');
  }

  if (plat === 'launchd') {
    run('launchctl', ['unload', paths.file]);
    unlinkSync(paths.file);
    console.log('Service unloaded and removed.');
  }
}

function status() {
  const plat = detectPlatform();
  if (!plat) {
    console.log('No supported service platform detected.');
    return;
  }

  const paths = getServicePaths(plat);

  if (!existsSync(paths.file)) {
    console.log('No daemon service is installed.');
    console.log('Run `vibe-usage daemon install` to set up.');
    return;
  }

  if (plat === 'systemd') {
    const result = run('systemctl', ['--user', 'status', `${SERVICE_NAME}.service`]);
    console.log(result.output);
  }

  if (plat === 'launchd') {
    const result = run('launchctl', ['list', LAUNCHD_LABEL]);
    if (result.ok) {
      console.log(`Service: ${LAUNCHD_LABEL}`);
      console.log(result.output);
    } else {
      console.log('Service is installed but not currently running.');
    }
  }
}

function stop() {
  const plat = detectPlatform();
  if (!plat) {
    console.log('No supported service platform detected.');
    return;
  }

  if (plat === 'systemd') {
    const result = run('systemctl', ['--user', 'stop', `${SERVICE_NAME}.service`]);
    console.log(result.ok ? 'Service stopped.' : `Failed: ${result.output}`);
  }

  if (plat === 'launchd') {
    const result = run('launchctl', ['stop', LAUNCHD_LABEL]);
    console.log(result.ok ? 'Service stopped.' : `Failed: ${result.output}`);
  }
}

function restart() {
  const plat = detectPlatform();
  if (!plat) {
    console.log('No supported service platform detected.');
    return;
  }

  if (plat === 'systemd') {
    const result = run('systemctl', ['--user', 'restart', `${SERVICE_NAME}.service`]);
    console.log(result.ok ? 'Service restarted.' : `Failed: ${result.output}`);
  }

  if (plat === 'launchd') {
    run('launchctl', ['stop', LAUNCHD_LABEL]);
    const result = run('launchctl', ['start', LAUNCHD_LABEL]);
    console.log(result.ok ? 'Service restarted.' : `Failed: ${result.output}`);
  }
}

const SUBCOMMANDS = { install, uninstall, status, stop, restart };

export async function manageDaemon(subcommand) {
  const fn = SUBCOMMANDS[subcommand];
  if (!fn) {
    console.error(`Unknown daemon subcommand: ${subcommand}`);
    console.error('Usage: vibe-usage daemon <install|uninstall|status|stop|restart>');
    process.exit(1);
  }
  fn();
}
