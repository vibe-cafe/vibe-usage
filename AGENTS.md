# AGENTS.md

AI agent guidance for the vibe-usage CLI. See [README.md](./README.md) for user-facing docs.

## Repository Structure

```
vibe-usage/
├── bin/vibe-usage.js          # CLI entry point → src/index.js
├── src/
│   ├── index.js               # Command router (init, sync, daemon, reset, skill, status, config)
│   ├── parsers/               # One parser per tool, all export async parse() → { buckets, sessions }
│   │   ├── index.js           # Parser registry, aggregateToBuckets(), extractSessions()
│   │   ├── claude-code.js
│   │   ├── codex.js
│   │   ├── copilot-cli.js
│   │   ├── gemini-cli.js
│   │   ├── opencode.js        # SQLite via child_process sqlite3, JSON fallback
│   │   ├── openclaw.js
│   │   ├── qwen-code.js
│   │   ├── kimi-code.js
│   │   ├── amp.js
│   │   └── droid.js
│   ├── tools.js               # TOOLS[] registry + detectInstalledTools()
│   ├── sync.js                # Orchestrator: parse all → batch upload buckets + sessions
│   ├── api.js                 # HTTP client: ingest(), deleteAllData(), fetchSettings()
│   ├── config.js              # ~/.vibe-usage/config.json (dev: config.dev.json)
│   ├── init.js                # Interactive setup (API key, verify, initial sync)
│   ├── daemon.js              # 5-minute sync loop (foreground)
│   ├── daemon-service.js      # Background service management (systemd/launchd install/uninstall/status)
│   ├── reset.js               # Delete remote data + re-sync
│   └── skill.js               # Install/remove SKILL.md for AI coding tools
├── SKILL.md                   # Skill definition (also used by `npx skills add`)
└── package.json               # @vibe-cafe/vibe-usage, ESM, Node >=20, zero dependencies
```

## Key Conventions

- **Pure ESM** (`"type": "module"`) — no CommonJS, no build step
- **Zero dependencies** — only Node built-ins (fs, path, os, crypto, https, readline, child_process)
- **Stateless sync** — parsers compute full totals from raw logs each run; server upserts idempotently
- **No TypeScript** — plain JavaScript throughout

## Architecture: Two-Track Data Model

Every parser produces two parallel data streams:

### Track 1: Token Buckets
Per-message token usage aggregated into 30-minute windows via `aggregateToBuckets()`.

```js
{ source, model, project, bucketStart, inputTokens, outputTokens, cachedInputTokens, reasoningOutputTokens, totalTokens }
```

### Track 2: Sessions
Timing events fed to `extractSessions()` for interaction metadata.

```js
// Input event shape:
{ sessionId, source, project, timestamp: Date, role: 'user' | 'assistant' }

// Output session shape:
{ source, project, sessionHash, firstMessageAt, lastMessageAt, durationSeconds, activeSeconds, messageCount, userMessageCount, userPromptHours }
```

`activeSeconds` = sum of turn durations (user prompt to last assistant message before next user prompt).

## Adding a New Parser

1. Create `src/parsers/<tool-id>.js` exporting `async function parse()` returning `{ buckets: [], sessions: [] }`
2. Register in `src/parsers/index.js` — import + add to `parsers` object
3. Add tool entry in `src/tools.js` — `{ name, id, dataDir }` (alphabetical by id)
4. Update `README.md` supported tools table
5. **Backend**: add tool id to `VALID_SOURCES` in `vibe-cafe/apps/web/src/app/api/usage/ingest/route.ts`

Parser pattern:
- Read local log files from the tool's data directory
- Extract per-message token entries → `aggregateToBuckets(entries)`
- Extract user/assistant timing events → `extractSessions(events)`
- Handle missing/corrupt files gracefully (try/catch, skip bad lines)

## Development & Testing

```bash
# Dev mode (separate config, custom API URL)
VIBE_USAGE_DEV=1 VIBE_USAGE_API_URL=http://localhost:3000 node ./bin/vibe-usage.js init
VIBE_USAGE_DEV=1 node ./bin/vibe-usage.js sync

# Quick parser test
node -e "import('./src/parsers/<tool-id>.js').then(m => m.parse()).then(r => console.log(JSON.stringify(r, null, 2)))"
```

## Versioning

- Bump `version` in `package.json` before publishing
- Published as `@vibe-cafe/vibe-usage` on npm
- Users run via `npx @vibe-cafe/vibe-usage`
