import { createInterface } from 'node:readline';
import { DEFAULT_API_URL, currentApiUrl, isPlaintextRemoteApiUrl, sameApiServer } from './api-url.js';
import { hostname as osHostname } from 'node:os';
import { loadConfig, saveConfig } from './config.js';
import { fetchAccount, ingest, requestDeviceCode, pollDeviceCode } from './api.js';
import { planLoginPage, printableText, runBrowserCommand } from './login-page.js';
import { runSync } from './sync.js';
import { detectInstalledTools } from './tools.js';
import { bigHeader, success, failure, warn, arrow, link, dim, divider } from './output.js';
import { manageDaemon, isDaemonInstalled, isDaemonLaunchBroken, isDaemonPlatform } from './daemon-service.js';

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

/**
 * The server URL in the device-flow reply, or null when it must not be used.
 * Like the login link (login-page.js), it is untrusted input: the API key is
 * sent to it right away and every later sync goes there. Accepted only when
 * it parses, carries no user info, is https (http only when the login itself
 * went to that same http origin: LAN self-hosting), and names the server the
 * login went to — the same origin, or both production names (sameApiServer).
 */
export function trustedReplyApiUrl(replyApiUrl, requestedApiUrl) {
  if (typeof replyApiUrl !== 'string') return null;
  const raw = replyApiUrl.trim();
  // The URL parser silently drops tabs/newlines; refuse instead of rewriting.
  if (!raw || /[\s\u0000-\u001f\u007f-\u009f]/.test(raw)) return null;
  let reply;
  let requested;
  try {
    reply = new URL(raw);
    requested = new URL(requestedApiUrl);
  } catch {
    return null;
  }
  if (reply.username || reply.password) return null;
  if (reply.protocol === 'http:') {
    if (requested.protocol !== 'http:' || reply.origin !== requested.origin) return null;
  } else if (reply.protocol !== 'https:') {
    return null;
  }
  if (!sameApiServer(reply.origin, requested.origin)) return null;
  // Requests resolve '/api/...' against it, so the origin is all that is used.
  return currentApiUrl(reply.origin);
}

/**
 * Where init sends the new key: the reply's server when trusted, otherwise the
 * one the login went to. `ignoredReply` is the reply that was refused (for the
 * warning), null when there was none or it was taken.
 */
export function resolveInitApiUrl(replyApiUrl, requestedApiUrl = DEFAULT_API_URL) {
  const requested = currentApiUrl(requestedApiUrl);
  const reply = typeof replyApiUrl === 'string' ? replyApiUrl.trim() : '';
  if (!reply) return { apiUrl: requested, ignoredReply: null };
  const trusted = trustedReplyApiUrl(reply, requested);
  return trusted ? { apiUrl: trusted, ignoredReply: null } : { apiUrl: requested, ignoredReply: reply };
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

  const requestedApiUrl = currentApiUrl(process.env.VIBE_USAGE_API_URL || DEFAULT_API_URL);
  const host = existing?.hostname || osHostname().replace(/\.local$/, '');
  // A warning, not a refusal: self-hosting on a LAN over http is a real setup.
  if (isPlaintextRemoteApiUrl(requestedApiUrl)) {
    console.log(warn(`服务器 ${requestedApiUrl} 用的是明文 http，API Key 和用量数据会不加密传输；局域网自托管可以忽略，公网服务器请改用 https。`));
  }

  let apiKey;
  let apiUrl = requestedApiUrl;
  if (providedKey) {
    if (!providedKey.startsWith('vbu_')) {
      console.error(failure('API Key 无效，必须以 vbu_ 开头。'));
      process.exit(1);
    }
    apiKey = providedKey;
  } else {
    const auth = await runDeviceFlow(requestedApiUrl, host);
    if (!auth) process.exit(1);
    apiKey = auth.apiKey;
    // Decided before the first request that carries the key (ingest below).
    // An adopted http URL is the login's own origin, already warned about above.
    const resolved = resolveInitApiUrl(auth.apiUrl, requestedApiUrl);
    apiUrl = resolved.apiUrl;
    if (resolved.ignoredReply) {
      console.log(warn(`服务器返回的地址 ${printableText(resolved.ignoredReply)} 不是本次登录的服务器，已忽略，继续使用 ${apiUrl}。`));
    }
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
    ...(existing?.kikiStartAt !== undefined ? { kikiStartAt: existing.kikiStartAt } : {}),
    ...(existing?.magpieStartAt !== undefined ? { magpieStartAt: existing.magpieStartAt } : {}),
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
  } else if (isDaemonInstalled() && !isDaemonLaunchBroken()) {
    console.log(success('后台自动同步已在运行。'));
  } else if (process.stdin.isTTY) {
    await manageDaemon('install');
  } else {
    console.log(dim('非交互环境未开启后台同步；运行 `npx @vibe-cafe/vibe-usage daemon install` 开启。'));
  }
}

export async function runDeviceFlow(apiUrl, hostname) {
  let device;
  try {
    device = await requestDeviceCode(apiUrl, { clientName: CLIENT_NAME, hostname });
  } catch (err) {
    console.error(failure(`无法连接 ${apiUrl}：${err.message}`));
    return null;
  }

  // The link comes from the server's reply: see login-page.js for what is
  // checked before a browser is opened.
  const loginPage = planLoginPage(device.verificationUriComplete, apiUrl);
  const shown = loginPage.url ? link(loginPage.url) : printableText(device.verificationUriComplete);
  console.log(`${arrow('登录确认')} ${shown}`);
  console.log(`  验证码: ${printableText(device.userCode)}`);
  if (loginPage.command) {
    console.log(dim('  浏览器会自动打开；如果没反应，请手动复制上方链接。'));
  } else {
    console.log(warn('登录链接不像是本服务器的登录页，为安全起见没有自动打开浏览器；确认可信再手动复制打开。'));
  }
  console.log();
  if (loginPage.command) runBrowserCommand(loginPage.command);

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
        return { apiKey: res.apiKey, apiUrl: res.apiUrl };
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
