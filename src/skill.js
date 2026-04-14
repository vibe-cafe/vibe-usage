import { existsSync, mkdirSync, writeFileSync, unlinkSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

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
description: Track and sync AI coding tool token usage to vibecafe.ai dashboard.
---

# Vibe Usage

Track your AI coding tool token usage and sync to [vibecafe.ai](https://vibecafe.ai/usage).

## Setup

First-time setup (interactive — asks for API key):

\`\`\`bash
npx @vibe-cafe/vibe-usage
\`\`\`

Get your API key at https://vibecafe.ai/usage/setup

## Commands

When the user asks to sync usage, check costs, or track tokens, run:

\`\`\`bash
npx @vibe-cafe/vibe-usage sync
\`\`\`

Other available commands:

| Command | Description |
|---------|-------------|
| \`npx @vibe-cafe/vibe-usage sync\` | Sync latest usage data |
| \`npx @vibe-cafe/vibe-usage status\` | Show config and detected tools |
| \`npx @vibe-cafe/vibe-usage daemon\` | Continuous sync every 30 minutes |
| \`npx @vibe-cafe/vibe-usage reset\` | Delete all data and re-upload |
| \`npx @vibe-cafe/vibe-usage reset --local\` | Delete this host's data and re-upload |

## When to Use

- User says "sync my usage", "upload usage", "track tokens"
- User asks "how much have I spent?", "what's my cost?"
- User wants to check if sync is working: run \`status\`
- User wants continuous background sync: run \`daemon\`

## Notes

- Requires initial setup with an API key (run \`npx @vibe-cafe/vibe-usage\` first)
- Config is stored at \`~/.vibe-usage/config.json\`
- Supports: Claude Code, Codex CLI, Copilot CLI, Gemini CLI, OpenCode, OpenClaw, Qwen Code, Kimi Code, Amp, Droid
`;

export async function runSkill(args = []) {
  const remove = args.includes('--remove');

  console.log('\nvibe-usage skill\n');

  console.log('  AI coding tools:');
  for (const t of SKILL_TARGETS) {
    const found = existsSync(t.detectDir);
    console.log(`    ${found ? '\u2713' : '\u2717'} ${t.name}`);
  }
  console.log();

  const detected = SKILL_TARGETS.filter(t => existsSync(t.detectDir));

  if (detected.length === 0) {
    console.log('  No supported tools detected. Nothing to do.\n');
    return;
  }

  if (remove) {
    let removed = 0;
    for (const t of detected) {
      const skillFile = join(t.skillDir, 'SKILL.md');
      if (existsSync(skillFile)) {
        unlinkSync(skillFile);
        try { rmdirSync(t.skillDir); } catch {}
        console.log(`  Removed: ${tildePath(skillFile)}`);
        removed++;
      }
    }
    if (removed === 0) {
      console.log('  No skills installed to remove.\n');
    } else {
      console.log(`\n  Removed vibe-usage skill from ${removed} tool${removed > 1 ? 's' : ''}.\n`);
    }
    return;
  }

  let installed = 0;
  for (const t of detected) {
    const skillFile = join(t.skillDir, 'SKILL.md');
    mkdirSync(t.skillDir, { recursive: true });
    writeFileSync(skillFile, SKILL_CONTENT, 'utf-8');
    console.log(`  Installed: ${tildePath(skillFile)}`);
    installed++;
  }

  console.log(`\n  Installed vibe-usage skill for ${installed} tool${installed > 1 ? 's' : ''}.\n`);
  console.log('  Your AI coding assistant now knows how to sync usage data.');
  console.log('  Try asking: "sync my vibe usage" or "how much have I spent?"\n');
}
