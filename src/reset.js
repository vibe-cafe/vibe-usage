import { createInterface } from 'node:readline';
import { hostname as getHostname } from 'node:os';
import { loadConfig, saveConfig } from './config.js';
import { deleteAllData } from './api.js';
import { runSync } from './sync.js';
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

export async function runReset(args = []) {
  const hostOnly = args.includes('--local');
  const config = loadConfig();
  if (!config?.apiKey) {
    console.error(failure('尚未配置，请先运行 `npx @vibe-cafe/vibe-usage init`。'));
    process.exit(1);
  }

  const currentHost = getHostname().replace(/\.local$/, '');
  const apiUrl = config.apiUrl || 'https://vibecafe.ai';

  if (hostOnly) {
    const answer = await prompt(`将删除当前机器（${currentHost}）的用量数据并从本地日志重新上传，继续? (y/N) `);
    if (answer.toLowerCase() !== 'y') {
      console.log(dim('已取消。'));
      return;
    }

    console.log(dim(`  正在删除 ${currentHost} 的云端数据...`));
    try {
      const result = await deleteAllData(apiUrl, config.apiKey, { hostname: currentHost });
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
    const answer = await prompt('将删除所有用量数据并从本地日志重新上传，继续? (y/N) ');
    if (answer.toLowerCase() !== 'y') {
      console.log(dim('已取消。'));
      return;
    }

    console.log(dim('  正在删除所有云端数据...'));
    try {
      const result = await deleteAllData(apiUrl, config.apiKey);
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

  // Clear local state (legacy — no state files needed for current parsers)
  config.lastSync = null;
  saveConfig(config);

  console.log();
  console.log(dim('  从本地日志重新同步...'));
  await runSync();

  console.log();
  console.log(`${arrow('Dashboard')} ${link(`${apiUrl}/usage`)}`);
}
