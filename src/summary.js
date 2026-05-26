import https from 'node:https';
import http from 'node:http';
import { URL } from 'node:url';
import { loadConfig } from './config.js';

export async function runSummary(args = []) {
  const days = parseDays(args);
  const config = loadConfig();
  if (!config?.apiKey) {
    console.error('No vibe-usage config found. Run `npx @vibe-cafe/vibe-usage init` first.');
    process.exit(1);
  }

  const url = new URL('/api/usage', config.apiUrl || 'https://vibecafe.ai');
  url.searchParams.set('days', String(days));

  let data;
  try {
    data = await fetchJson(url, config.apiKey);
  } catch (err) {
    if (err.statusCode === 401) {
      console.error('API key invalid or revoked. Run `npx @vibe-cafe/vibe-usage init` to re-link.');
    } else {
      console.error(`Failed to fetch usage: ${err.message}`);
    }
    process.exit(1);
  }

  console.log(render(data, days));
}

function parseDays(args) {
  const idx = args.findIndex(a => a === '--days');
  if (idx === -1) return 7;
  const v = parseInt(args[idx + 1], 10);
  if (!v || v < 1) return 7;
  if (v > 90) return 90;
  return v;
}

function render(data, days) {
  const buckets = Array.isArray(data?.buckets) ? data.buckets : [];
  const sessions = Array.isArray(data?.sessions) ? data.sessions : [];

  if (buckets.length === 0) {
    return `# Vibe Usage Summary (Last ${days} ${days === 1 ? 'day' : 'days'})\n\n暂无数据。运行 \`npx @vibe-cafe/vibe-usage sync\` 上传本地 token 记录。\n\n详情: https://vibecafe.ai/usage\n`;
  }

  let totalCost = 0;
  let totalTokens = 0;
  const byModel = new Map();
  const byProject = new Map();

  for (const b of buckets) {
    const cost = Number(b.estimatedCost ?? 0);
    const tokens = Number(b.totalTokens ?? 0);
    totalCost += cost;
    totalTokens += tokens;
    accumulate(byModel, b.model, { cost, tokens });
    accumulate(byProject, b.project || 'unknown', { cost, tokens, sessions: 0 });
  }

  const sessionsCount = sessions.length;
  let activeSeconds = 0;
  for (const s of sessions) {
    activeSeconds += Number(s.activeSeconds ?? 0);
    const proj = byProject.get(s.project || 'unknown');
    if (proj) proj.sessions += 1;
  }
  const activeHours = activeSeconds / 3600;

  const lines = [];
  lines.push(`# Vibe Usage Summary (Last ${days} ${days === 1 ? 'day' : 'days'})`);
  lines.push('');
  lines.push(`**总览**: $${totalCost.toFixed(2)} · ${formatTokens(totalTokens)} tokens · ${sessionsCount} sessions · ${activeHours.toFixed(1)}h active`);
  lines.push('');

  lines.push('## 按模型');
  lines.push('');
  lines.push('| 模型 | 费用 | Tokens | 占比 |');
  lines.push('|---|---:|---:|---:|');
  for (const [model, { cost, tokens }] of topN(byModel, 'cost', 8)) {
    const pct = totalCost > 0 ? ((cost / totalCost) * 100).toFixed(0) : '0';
    lines.push(`| ${model} | $${cost.toFixed(2)} | ${formatTokens(tokens)} | ${pct}% |`);
  }
  lines.push('');

  lines.push('## 按项目');
  lines.push('');
  lines.push('| 项目 | 费用 | Sessions |');
  lines.push('|---|---:|---:|');
  for (const [project, { cost, sessions: ss }] of topN(byProject, 'cost', 8)) {
    lines.push(`| ${project} | $${cost.toFixed(2)} | ${ss} |`);
  }
  lines.push('');

  lines.push('详情: https://vibecafe.ai/usage');
  return lines.join('\n');
}

function accumulate(map, key, delta) {
  const cur = map.get(key) || { cost: 0, tokens: 0, sessions: 0 };
  for (const k of Object.keys(delta)) cur[k] = (cur[k] || 0) + delta[k];
  map.set(key, cur);
}

function topN(map, sortBy, n) {
  return [...map.entries()]
    .sort((a, b) => b[1][sortBy] - a[1][sortBy])
    .slice(0, n);
}

function formatTokens(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(0) + 'K';
  return String(n);
}

function fetchJson(url, apiKey) {
  return new Promise((resolve, reject) => {
    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.request(url, {
      method: 'GET',
      timeout: 15_000,
      headers: { 'Authorization': `Bearer ${apiKey}` },
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode === 401) {
          const err = new Error('Unauthorized'); err.statusCode = 401; reject(err); return;
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const err = new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`);
          err.statusCode = res.statusCode;
          reject(err); return;
        }
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error('Invalid JSON response')); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout (15s)')); });
    req.end();
  });
}
