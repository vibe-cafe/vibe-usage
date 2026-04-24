import { execFileSync } from 'node:child_process';
import { writeFileSync, unlinkSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, platform } from 'node:os';
import { fileURLToPath } from 'node:url';
import { success, failure, warn, dim } from './output.js';

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
    console.log(failure('当前平台不支持 daemon。'));
    console.log(dim('  支持: Linux (systemd) / macOS (launchd)'));
    return;
  }

  const { nodePath, binPath, isNpxCache } = resolvePaths();

  if (isNpxCache) {
    console.log(warn('检测到从 npx 缓存运行 vibe-usage,缓存清理后 daemon 会失效。'));
    console.log(dim('  建议先全局安装:  npm install -g @vibe-cafe/vibe-usage'));
    console.log();
  }

  const paths = getServicePaths(plat);

  if (existsSync(paths.file)) {
    console.log(warn('Daemon 已安装，运行 `vibe-usage daemon restart` 或 `uninstall` 先处理。'));
    return;
  }

  mkdirSync(paths.dir, { recursive: true });

  if (plat === 'systemd') {
    writeFileSync(paths.file, generateSystemdUnit(nodePath, binPath), 'utf-8');
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
    writeFileSync(paths.file, generateLaunchdPlist(nodePath, binPath), 'utf-8');
    console.log(dim(`  已写入 ${paths.file}`));

    const result = run('launchctl', ['load', paths.file]);
    if (!result.ok) {
      console.error(failure(`加载服务失败: ${result.output}`));
      return;
    }
    console.log(success('服务已加载并启动。'));
  }

  console.log();
  console.log(success('Daemon 已安装，用量数据将每 30 分钟自动同步。'));
  console.log(dim('  运行 `vibe-usage daemon status` 查看状态。'));
}

function uninstall() {
  const plat = detectPlatform();
  if (!plat) {
    console.log(failure('未检测到支持的服务平台。'));
    return;
  }

  const paths = getServicePaths(plat);

  if (!existsSync(paths.file)) {
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
}

function status() {
  const plat = detectPlatform();
  if (!plat) {
    console.log(failure('未检测到支持的服务平台。'));
    return;
  }

  const paths = getServicePaths(plat);

  if (!existsSync(paths.file)) {
    console.log(dim('未安装 daemon 服务。'));
    console.log(dim('  运行 `vibe-usage daemon install` 安装。'));
    return;
  }

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
    const result = run('launchctl', ['stop', LAUNCHD_LABEL]);
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
    run('launchctl', ['stop', LAUNCHD_LABEL]);
    const result = run('launchctl', ['start', LAUNCHD_LABEL]);
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
