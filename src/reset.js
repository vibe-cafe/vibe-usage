import { createInterface } from 'node:readline';
import { hostname as getHostname } from 'node:os';
import { loadConfig } from './config.js';
import { deleteAllData } from './api.js';
import { runSync } from './sync.js';
import { clearState } from './state.js';
import { success, failure, arrow, link, dim } from './output.js';

function prompt(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

export async function runReset(args = [], deps = {}) {
  // Injectable for tests — the production defaults hit readline, the network,
  // and the real sync pipeline.
  const ask = deps.prompt ?? prompt;
  const deleteRemote = deps.deleteAllData ?? deleteAllData;
  const resync = deps.runSync ?? runSync;

  const hostOnly = args.includes('--local');
  const config = loadConfig();
  if (!config?.apiKey) {
    console.error(failure('尚未配置，请先运行 `npx @vibe-cafe/vibe-usage init`。'));
    process.exit(1);
  }

  // Target the hostname persisted at init — the same one sync.js uploads
  // under. A fresh os.hostname() can have drifted since (macOS mDNS adds -2
  // suffixes), which would delete zero rows, or another machine's rows.
  const currentHost = config.hostname || getHostname().replace(/\.local$/, '');
  const apiUrl = config.apiUrl || 'https://vibecafe.ai';

  if (hostOnly) {
    const answer = await ask(`将删除当前机器（${currentHost}）的用量数据并从本地日志重新上传，继续? (y/N) `);
    if (answer.toLowerCase() !== 'y') {
      console.log(dim('已取消。'));
      return;
    }

    console.log(dim(`  正在删除 ${currentHost} 的云端数据...`));
    try {
      const result = await deleteRemote(apiUrl, config.apiKey, { hostname: currentHost });
      console.log(success(`已删除 ${result.deleted} buckets · ${result.sessions ?? 0} sessions`));
    } catch (err) {
      if (err.message === 'UNAUTHORIZED') {
        console.error(failure('API Key 无效，请运行 `npx @vibe-cafe/vibe-usage init` 重新配置。'));
        process.exit(1);
      }
      console.error(failure(`删除云端数据失败: ${err.message}`));
      process.exit(1);
    }
  } else {
    const answer = await ask('将删除所有用量数据并从本地日志重新上传，继续? (y/N) ');
    if (answer.toLowerCase() !== 'y') {
      console.log(dim('已取消。'));
      return;
    }

    console.log(dim('  正在删除所有云端数据...'));
    try {
      const result = await deleteRemote(apiUrl, config.apiKey);
      console.log(success(`已删除 ${result.deleted} buckets · ${result.sessions ?? 0} sessions`));
    } catch (err) {
      if (err.message === 'UNAUTHORIZED') {
        console.error(failure('API Key 无效，请运行 `npx @vibe-cafe/vibe-usage init` 重新配置。'));
        process.exit(1);
      }
      console.error(failure(`删除云端数据失败: ${err.message}`));
      process.exit(1);
    }
  }

  // The remote rows are gone, so every local item must count as "changed" on
  // the re-sync below. Without this, sync.js's incremental diff matches every
  // item against state.json and uploads zero bytes — the deleted data would
  // never come back.
  clearState();

  console.log();
  console.log(dim('  从本地日志重新同步...'));
  await resync();

  console.log();
  console.log(`${arrow('Dashboard')} ${link(`${apiUrl}/usage`)}`);
}
