import { createInterface } from 'node:readline';
import { execFile } from 'node:child_process';
import { hostname as osHostname, platform } from 'node:os';
import { loadConfig, saveConfig } from './config.js';
import { fetchAccount, ingest, requestDeviceCode, pollDeviceCode } from './api.js';
import { runSync } from './sync.js';
import { detectInstalledTools } from './tools.js';
import { bigHeader, success, failure, warn, arrow, link, dim, divider } from './output.js';
import { manageDaemon, isDaemonInstalled, isDaemonPlatform } from './daemon-service.js';

const CLIENT_NAME = 'vibe-usage CLI';

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
  // `start` is a cmd.exe builtin, not an executable: execFile('start', …) fails
  // outright on Windows, so the device-flow login never opened a tab and the
  // user was left staring at the code with no browser to type it into. Go
  // through cmd, and escape a bare `&` (present in verificationUriComplete's
  // query string) or cmd would read it as a command separator.
  if (platform() === 'win32') {
    execFile('cmd', ['/c', 'start', '', url.replace(/&/g, '^&')], { windowsHide: true }, () => {});
    return;
  }
  const cmds = { darwin: 'open', linux: 'xdg-open' };
  const cmd = cmds[platform()] || cmds.linux;
  // Use execFile with args array to avoid shell injection via VIBE_USAGE_API_URL
  execFile(cmd, [url], () => {});
}

export async function runInit(options = {}) {
  const { apiKey: providedKey, codexExtraHome, noDaemon = false } = options;

  console.log(bigHeader());

  const existing = loadConfig();
  if (existing?.apiKey) {
    if (providedKey && existing.apiKey === providedKey) {
      console.log(dim('已配置同一个 Key，直接同步数据。'));
      console.log();
      await runSync({ codexExtraHome });
      return;
    }
    const answer = await prompt('检测到已有配置，是否覆盖? (y/N) ');
    if (answer.toLowerCase() !== 'y') {
      console.log(dim('已取消。'));
      return;
    }
  }

  const apiUrl = process.env.VIBE_USAGE_API_URL || 'https://vibecafe.ai';
  const host = existing?.hostname || osHostname().replace(/\.local$/, '');

  let apiKey;
  if (providedKey) {
    if (!providedKey.startsWith('vbu_')) {
      console.error(failure('API Key 无效，必须以 vbu_ 开头。'));
      process.exit(1);
    }
    apiKey = providedKey;
  } else {
    apiKey = await runDeviceFlow(apiUrl, host);
    if (!apiKey) process.exit(1);
  }

  try {
    await ingest(apiUrl, apiKey, []);
    console.log(success(`验证通过 ${dim(apiKey.slice(0, 12) + '...')}`));
    // 说清楚数据会算在谁名下 —— 授权那一刻浏览器里登录的可能并不是他自己以为的
    // 那个账号,而这是整条链路上最后一次能当场发现的机会。
    const account = await fetchAccount(apiUrl, apiKey).catch(() => null);
    if (account) {
      console.log(success(`已链接到账号 ${account.name ? `@${account.handle}(${account.name})` : `@${account.handle}`}`));
      console.log(dim('  数据都会记在这个账号名下;不是你要的账号就退出登录后重新 init。'));
    }
  } catch (err) {
    if (err.message === 'UNAUTHORIZED') {
      console.error(failure('API Key 无效，请检查后重试。'));
      process.exit(1);
    }
    console.log(warn(`网络异常（${err.message}），跳过验证直接保存。`));
  }

  const config = {
    apiKey,
    apiUrl,
    hostname: host,
    ...(existing?.codexExtraHome ? { codexExtraHome: existing.codexExtraHome } : {}),
    ...(existing?.extraRoots ? { extraRoots: existing.extraRoots } : {}),
  };
  saveConfig(config);

  const tools = detectInstalledTools({
    codexExtraHome: config.codexExtraHome,
    extraRoots: config.extraRoots,
  });
  if (tools.length > 0) {
    console.log(success(`检测到 ${tools.length} 款工具: ${dim(tools.map(t => t.name).join(' · '))}`));
  } else {
    console.log(warn('未检测到 AI 编码工具，安装后重新运行即可。'));
  }

  console.log();
  console.log(divider());
  console.log();

  await runSync({ codexExtraHome });

  // Background sync is the default (maintainer decision 2026-09-09): one
  // command should leave the machine fully set up. `--no-daemon` opts out;
  // a non-interactive run (CI, headless --manual-key) never installs a
  // service on a machine nobody is looking at.
  console.log();
  if (noDaemon) {
    console.log(dim('已按 --no-daemon 跳过后台同步。随时运行 `npx @vibe-cafe/vibe-usage daemon install` 开启。'));
  } else if (!isDaemonPlatform()) {
    console.log(dim('当前平台不支持后台同步，之后手动运行 `npx @vibe-cafe/vibe-usage` 即可同步。'));
  } else if (isDaemonInstalled()) {
    console.log(success('后台自动同步已在运行。'));
  } else if (process.stdin.isTTY) {
    await manageDaemon('install');
  } else {
    console.log(dim('非交互环境未开启后台同步；运行 `npx @vibe-cafe/vibe-usage daemon install` 开启。'));
  }
}

async function runDeviceFlow(apiUrl, hostname) {
  let device;
  try {
    device = await requestDeviceCode(apiUrl, { clientName: CLIENT_NAME, hostname });
  } catch (err) {
    console.error(failure(`无法连接 ${apiUrl}：${err.message}`));
    return null;
  }

  console.log(`${arrow('登录确认')} ${link(device.verificationUriComplete)}`);
  console.log(`  验证码: ${device.userCode}`);
  console.log(dim('  浏览器会自动打开；如果没反应，请手动复制上方链接。'));
  console.log();
  openBrowser(device.verificationUriComplete);

  const intervalMs = (device.interval || 5) * 1000;
  const deadline = Date.now() + (device.expiresIn || 900) * 1000;

  process.stdout.write(dim('等待审批…'));
  const aborter = new AbortController();
  const onSigint = () => { aborter.abort(); };
  process.on('SIGINT', onSigint);
  try {
    while (Date.now() < deadline) {
      if (aborter.signal.aborted) {
        process.stdout.write('\n');
        console.log(warn('已取消。'));
        return null;
      }
      await sleep(intervalMs);
      let res;
      try {
        res = await pollDeviceCode(apiUrl, device.deviceCode);
      } catch (err) {
        // Transient network blip — keep polling until deadline.
        process.stdout.write(dim('.'));
        continue;
      }
      if (res.apiKey) {
        process.stdout.write('\n');
        console.log(success('已批准，获取到 API Key。'));
        return res.apiKey;
      }
      if (res.error === 'authorization_pending') {
        process.stdout.write(dim('.'));
        continue;
      }
      if (res.error === 'access_denied') {
        process.stdout.write('\n');
        console.error(failure('请求被拒绝。'));
        return null;
      }
      if (res.error === 'expired_token') {
        process.stdout.write('\n');
        console.error(failure('验证码已过期，请重跑 init。'));
        return null;
      }
      process.stdout.write('\n');
      console.error(failure(`服务端返回未知错误：${res.error}`));
      return null;
    }
    process.stdout.write('\n');
    console.error(failure('验证码已过期，请重跑 init。'));
    return null;
  } finally {
    process.removeListener('SIGINT', onSigint);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
