import { existsSync, mkdirSync, writeFileSync, unlinkSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { success, dim, green, red } from './output.js';

const SKILL_TARGETS = [
  {
    name: 'Claude Code',
    detectDir: join(homedir(), '.claude'),
    skillDir: join(homedir(), '.claude', 'skills', 'vibe-usage'),
  },
  {
    name: 'Codex CLI',
    detectDir: join(homedir(), '.codex'),
    skillDir: join(homedir(), '.codex', 'skills', 'vibe-usage'),
  },
  {
    name: 'Cursor',
    detectDir: join(homedir(), '.cursor'),
    skillDir: join(homedir(), '.cursor', 'skills', 'vibe-usage'),
  },
  {
    name: 'Windsurf',
    detectDir: join(homedir(), '.codeium', 'windsurf'),
    skillDir: join(homedir(), '.codeium', 'windsurf', 'skills', 'vibe-usage'),
  },
];

function tildePath(absPath) {
  const home = homedir();
  return absPath.startsWith(home) ? absPath.replace(home, '~') : absPath;
}

const SKILL_CONTENT = `---
name: vibe-usage
description: 查询和同步 AI 编程工具的 token 用量（VibeCafé 旗下 Vibe Usage 数据）。
---

# Vibe Usage

Track and answer questions about the user's AI coding token spend via [Vibe Usage](https://vibecafe.ai/usage) (VibeCafé).

## 查询用量（默认行为）

当用户问以下问题时，运行命令并**原样展示输出**（不要总结、不要换算单位、不要翻译）：

| 用户说... | 运行 |
|---|---|
| 我这周花了多少 / 查 usage / 看看消费 | \`npx @vibe-cafe/vibe-usage summary\` |
| 今天花了多少 / 今天 token | \`npx @vibe-cafe/vibe-usage summary --days 1\` |
| 本月花费 / 这个月用量 | \`npx @vibe-cafe/vibe-usage summary --days 30\` |
| 哪个模型最贵 / 模型对比 | \`npx @vibe-cafe/vibe-usage summary\`（输出已按模型拆） |
| 哪个项目花得最多 | \`npx @vibe-cafe/vibe-usage summary\`（输出已按项目拆） |

输出是 markdown 表格，直接展示给用户即可。

## 维护命令

| 用户说... | 运行 |
|---|---|
| 同步数据 / 上传 usage / 数据没更新 | \`npx @vibe-cafe/vibe-usage sync\` |
| 看 daemon 状态 / 后台同步还在跑吗 | \`npx @vibe-cafe/vibe-usage daemon status\` |
| 启动后台同步 | \`npx @vibe-cafe/vibe-usage daemon install\` |
| 重置数据 / 重新上传 | \`npx @vibe-cafe/vibe-usage reset\` |

## 注意

- \`summary\` 读 \`~/.vibe-usage/config.json\` 里已有的 API key，不需要用户额外输入
- summary 输出已是 markdown，**原样展示，不要复述**
- 用户没装过 vibe-usage？提示运行 \`npx @vibe-cafe/vibe-usage\` 先用浏览器登录链接账号
- 支持的工具：Claude Code, Codex, Grok 等
`;

export async function runSkill(args = []) {
  const remove = args.includes('--remove');

  console.log('  检测到的工具:');
  for (const t of SKILL_TARGETS) {
    const found = existsSync(t.detectDir);
    const mark = found ? green('[OK]') : red('[未装]');
    console.log(`    ${mark} ${t.name}`);
  }
  console.log();

  const detected = SKILL_TARGETS.filter(t => existsSync(t.detectDir));

  if (detected.length === 0) {
    console.log(dim('  未检测到支持的工具，无需安装 Skill。'));
    return;
  }

  if (remove) {
    let removed = 0;
    for (const t of detected) {
      const skillFile = join(t.skillDir, 'SKILL.md');
      if (existsSync(skillFile)) {
        unlinkSync(skillFile);
        try { rmdirSync(t.skillDir); } catch {}
        console.log(dim(`  已移除: ${tildePath(skillFile)}`));
        removed++;
      }
    }
    if (removed === 0) {
      console.log(dim('  没有已安装的 Skill。'));
    } else {
      console.log();
      console.log(success(`已从 ${removed} 个工具移除 Skill。`));
    }
    return;
  }

  let installed = 0;
  for (const t of detected) {
    const skillFile = join(t.skillDir, 'SKILL.md');
    mkdirSync(t.skillDir, { recursive: true });
    writeFileSync(skillFile, SKILL_CONTENT, 'utf-8');
    console.log(dim(`  已安装: ${tildePath(skillFile)}`));
    installed++;
  }

  console.log();
  console.log(success(`已为 ${installed} 个工具安装 Skill。`));
  console.log(dim('  AI 助手现在可以自主帮你同步用量数据。'));
}
