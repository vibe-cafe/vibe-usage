import { loadConfig } from './config.js';
import { getJson } from './api.js';
import { failure } from './output.js';

export async function runSummary(args = []) {
  const days = parseDays(args);
  const config = loadConfig();
  if (!config?.apiKey) {
    console.error(failure('尚未配置，请先运行 `npx @vibe-cafe/vibe-usage init`。'));
    process.exit(1);
  }

  const apiUrl = config.apiUrl || 'https://vibecafe.ai';

  let data;
  try {
    data = await getJson(apiUrl, config.apiKey, `/api/usage?days=${days}`, { timeoutMs: 15_000 });
  } catch (err) {
    if (err.statusCode === 401) {
      console.error(failure('API Key 无效，请运行 `npx @vibe-cafe/vibe-usage init` 重新配置。'));
    } else {
      console.error(failure(`获取用量数据失败: ${err.message}`));
    }
    process.exit(1);
  }

  console.log(render(data, days, apiUrl));
}

function parseDays(args) {
  const idx = args.findIndex(a => a === '--days');
  if (idx === -1) return 7;
  const v = parseInt(args[idx + 1], 10);
  if (!v || v < 1) return 7;
  if (v > 90) return 90;
  return v;
}

function render(data, days, apiUrl) {
  const buckets = Array.isArray(data?.buckets) ? data.buckets : [];
  const sessions = Array.isArray(data?.sessions) ? data.sessions : [];
  const dashboard = `${apiUrl}/usage`;

  if (buckets.length === 0) {
    return `# Vibe Usage Summary (Last ${days} ${days === 1 ? 'day' : 'days'})\n\n暂无数据。运行 \`npx @vibe-cafe/vibe-usage sync\` 上传本地 token 记录。\n\n详情: ${dashboard}\n`;
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

  lines.push(`详情: ${dashboard}`);
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
