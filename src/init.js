import { createInterface } from 'node:readline';
import { execFile } from 'node:child_process';
import { hostname as osHostname, platform } from 'node:os';
import { loadConfig, saveConfig } from './config.js';
import { ingest } from './api.js';
import { runSync } from './sync.js';
import { detectInstalledTools } from './tools.js';
import { bigHeader, success, failure, warn, arrow, link, dim, divider } from './output.js';

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

  console.log(bigHeader());

  const existing = loadConfig();
  if (existing?.apiKey) {
    if (providedKey && existing.apiKey === providedKey) {
      console.log(dim('已配置同一个 Key，直接同步数据。'));
      console.log();
      await runSync();
      return;
    }
    const answer = await prompt('检测到已有配置，是否覆盖? (y/N) ');
    if (answer.toLowerCase() !== 'y') {
      console.log(dim('已取消。'));
      return;
    }
  }

  const apiUrl = process.env.VIBE_USAGE_API_URL || 'https://vibecafe.ai';

  let apiKey;
  if (providedKey) {
    if (!providedKey.startsWith('vbu_')) {
      console.error(failure('API Key 无效，必须以 vbu_ 开头。'));
      process.exit(1);
    }
    apiKey = providedKey;
  } else {
    console.log(`${arrow('获取 API Key')} ${link(`${apiUrl}/usage`)}`);
    console.log(dim('  浏览器会自动打开，登录后复制 Key 粘贴到下方。'));
    console.log();
    openBrowser(`${apiUrl}/usage`);

    while (true) {
      apiKey = await prompt('粘贴 API Key: ');
      if (apiKey.startsWith('vbu_')) break;
      console.log(warn('必须以 vbu_ 开头，请重试。'));
    }
  }

  try {
    await ingest(apiUrl, apiKey, []);
    console.log(success(`验证通过 ${dim(apiKey.slice(0, 12) + '...')}`));
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
    hostname: existing?.hostname || osHostname().replace(/\.local$/, ''),
  };
  saveConfig(config);

  const tools = detectInstalledTools();
  if (tools.length > 0) {
    console.log(success(`检测到 ${tools.length} 款工具: ${dim(tools.map(t => t.name).join(' · '))}`));
  } else {
    console.log(warn('未检测到 AI 编码工具，安装后重新运行即可。'));
  }

  console.log();
  console.log(divider());
  console.log();

  await runSync();

  if (isDaemonPlatform()) {
    if (process.stdin.isTTY) {
      console.log();
      const answer = await prompt(`开启后台自动同步？${dim('(推荐)')} [Y/n] `);
      const normalized = answer.toLowerCase();
      if (normalized === '' || normalized === 'y' || normalized === 'yes') {
        const { manageDaemon } = await import('./daemon-service.js');
        await manageDaemon('install');
      } else {
        console.log();
        console.log(dim('随时运行 `npx @vibe-cafe/vibe-usage daemon install` 开启后台同步。'));
      }
    } else {
      console.log();
      console.log(dim('提示: 运行 `npx @vibe-cafe/vibe-usage daemon install` 开启后台自动同步。'));
    }
  }
}
