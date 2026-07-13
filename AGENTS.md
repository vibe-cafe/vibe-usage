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
│   │   ├── sqlite.js          # queryDbJson() — node:sqlite (Node ≥22.5), falls back to sqlite3 CLI
│   │   ├── cursor.js          # SQLite (read auth token) + cursor.com CSV export
│   │   ├── gemini-cli.js
│   │   ├── opencode.js        # SQLite (via sqlite.js), legacy JSON fallback
│   │   ├── openclaw.js
│   │   ├── qwen-code.js
│   │   ├── kimi-code.js
│   │   ├── amp.js
│   │   ├── droid.js
│   │   ├── antigravity-db.js  # Offline SQLite + protobuf reader for App 2.0 / agy CLI
│   │   ├── kiro.js            # SQLite (via sqlite.js), JSONL fallback
│   │   ├── hermes.js          # SQLite (via sqlite.js), multi-profile
│   │   ├── trae-cli.js        # Trae CLI JSONL telemetry (not Trae IDE/Work)
│   │   └── zcode.js           # SQLite (via sqlite.js), reads message table
│   ├── tools.js               # TOOLS[] registry + detectInstalledTools()
│   ├── sync.js                # Orchestrator: parse all → diff vs state → batch upload only new/changed
│   ├── state.js               # ~/.vibe-usage/state.json: key→hash of uploaded items (incremental sync)
│   ├── api.js                 # HTTP client: ingest() (always gzip), requestDeviceCode()/pollDeviceCode() (device flow), deleteAllData(), fetchSettings()
│   ├── summary.js             # `summary --days N`: GET /api/usage with the saved vbu_ key, render markdown (cost / tokens / by-model / by-project). Powers the SKILL.md "查询用量" entries.
│   ├── config.js              # ~/.vibe-usage/config.json (dev: config.dev.json)
│   ├── init.js                # Setup flow (device-flow browser login by default; --manual-key for CI/headless, verify, initial sync, daemon install prompt)
│   ├── daemon.js              # 30-minute sync loop (foreground)
│   ├── daemon-service.js      # Background service management (systemd/launchd install/uninstall/status)
│   ├── reset.js               # Delete remote data + re-sync
│   ├── skill.js               # Install/remove SKILL.md for AI coding tools
│   └── output.js              # Terminal output helpers: colors, OSC 8 links, big/small headers
├── SKILL.md                   # Skill definition (also used by `npx skills add`)
└── package.json               # @vibe-cafe/vibe-usage, ESM, Node >=20 (≥22.5 enables built-in node:sqlite), zero dependencies
```

## Key Conventions

- **Pure ESM** (`"type": "module"`) — no CommonJS, no build step
- **Zero dependencies** — only Node built-ins (fs, path, os, crypto, https, readline, child_process, zlib, `node:sqlite`)
- **Incremental sync** — parsers stay stateless (compute full totals from raw logs each run, server upserts idempotently), but `sync.js` diffs each item's content-hash against `~/.vibe-usage/state.json` and uploads only new/changed buckets/sessions — a quiet machine sends zero bytes. State is committed per-batch only after that batch's upload succeeds (failed batch re-sends next run); prune of dead keys (logs the parsers no longer emit) persists unconditionally and is bounded by liveness, never by age. Deleting `state.json` triggers a one-time full re-upload.
- **Stable hostname** — hostname is persisted in config at init; `sync.js` never re-reads `os.hostname()` after first capture. This prevents macOS mDNS hostname drift (e.g., `-2`, `-3` suffixes) from creating duplicate device entries in the DB.
- **No TypeScript** — plain JavaScript throughout
- **Output style** — user-facing text is Chinese (colored via `output.js` helpers: `success` / `failure` / `warn` / `arrow` / `link`). Dashboard URLs use OSC 8 hyperlinks so terminals that support it (iTerm2, Warp, VSCode, Kitty, Terminal.app 14+) render them as clickable. Raw pass-through from external tools (parser errors, `systemctl` / `launchctl` output, daemon loop timestamps) is kept in English and dimmed so it's visually de-emphasized. `init` prints a big ASCII logo; other commands print a compact one-line header (`bigHeader()` / `smallHeader()` from `output.js`).

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
5. **Backend**: append the source to `USAGE_SOURCES` in `vibe-cafe/apps/web/src/lib/usage-sources.ts` (ingest filter and `/usage` chip list both derive from it). Release ordering between vibe-usage publish and vibe-cafe deploy is no longer load-bearing — the ingest endpoint **soft-drops** unknown sources (returns them in `dropped: { buckets, unknownSources }` instead of 400ing the batch) so other parsers' data still lands. Until the source is registered server-side, `sync.js` prints a dim "X buckets dropped (服务端未收录的 source: …)" line.

Parser pattern:
- Read local log files from the tool's data directory
- Extract per-message token entries → `aggregateToBuckets(entries)`
- Extract user/assistant timing events → `extractSessions(events)`
- Handle missing/corrupt files gracefully (try/catch, skip bad lines)

SQLite-backed parsers (antigravity, cursor, opencode, kiro, hermes):
- Use `queryDbJson(dbPath, sql)` from `src/parsers/sqlite.js` — never shell out to `sqlite3` directly. It prefers Node's built-in `node:sqlite` (`DatabaseSync`, opened read-only; Node ≥ 22.5, works on Windows with no extra binary) and falls back to the `sqlite3` CLI on older Node.
- Rows come back as plain objects (`{ column: value }`), same shape as `sqlite3 -json` — INTEGER → number, TEXT → string, JSON via `json_extract` → string.
- If neither `node:sqlite` nor the CLI is available the helper throws an `ENOENT`-flavored error; catch it and rethrow `'sqlite3 CLI not found. Install sqlite3 (or use Node >= 22.5) to sync X data.'` so the user gets a hint.
- For DBs the source app holds a write lock on (Cursor, Kiro): catch `/database is locked/i`, copy the DB (+ `-wal`/`-shm`) to a temp dir, and re-query the snapshot.

Network-fetch parsers (the Cursor exception):
- Cursor stores no usage locally — only an auth token in `state.vscdb`. The parser reads the token via `queryDbJson()`, then GETs a CSV from `cursor.com`.
- Always wrap network calls with `AbortSignal.timeout(...)` so a single hung host can't stall the whole sync (sync.js catches throws per-parser but cannot interrupt a hanging await).
- Mark transient/network errors with `err.skip = true` so the parser silently returns empty (avoids noisy daemon logs every 5 min). Only auth/permanent errors should bubble up.

Codex forked sessions (`codex.js`):
- Forking a Codex conversation writes a *new* rollout file that replays the entire source conversation at the top — every `event_msg/token_count` included, all timestamped in a 1–3s burst at the fork instant. Those tokens are already counted from the source session's own file, so naively parsing the fork double-counts and spikes token/cost at the fork timestamp.
- The parser does two streaming passes. Pass 1 treats only the first `session_meta` as canonical and builds a monotonic raw-`token_count` timestamp index plus a compact payload fingerprint per record. A fork may copy full history or only the last N turns, so pass 2 skips the longest child token prefix that exactly matches a suffix of the parent snapshot present at spawn. Requiring the snapshot suffix avoids false matches against unrelated interior turns, remains exact when the parent continues running, and avoids over-skipping truncated-history forks. If the source file is missing or no payload sequence matches, skip nothing unless the child provides its own task boundary (over-count on incomplete data beats silently dropping real usage).
- Both passes **stream** each rollout file line-by-line (`node:readline` over a `createReadStream`), never `readFileSync` into memory. Large `$CODEX_HOME` histories (hundreds of files, some >100 MB) otherwise OOM the V8 heap during `JSON.parse`. Pass 1 retains only compact metadata, one numeric timestamp, and one short hash per raw `token_count`.

Codex sub-agent sessions (`codex.js`):
- A sub-agent rollout (`session_meta.payload.thread_source === 'subagent'`, a `source: { subagent: ... }` object, or a `parent_thread_id`) can begin with full parent history (including a second parent `session_meta`) or a last-N-turn suffix without that meta. Only the first child meta is canonical. The exact token-sequence match locates the copied suffix; the child's own `task_started`/`turn_started` at the end of that suffix supplies the record boundary so copied timing events are skipped too. Legacy single-meta files fall back conservatively to their first task boundary.
- Duplicate `token_count` emissions: Codex occasionally writes the same record twice back-to-back — identical `last_token_usage`, unchanged `total_token_usage.total_tokens`. A real API call always advances the cumulative counter, so an unchanged **positive** total marks the event as contributing zero (duplicate, or zero-usage bookkeeping like compaction) and it is skipped instead of summing `last_token_usage` twice. Guarded to positive totals so builds that leave `total_token_usage` all-zero can't suppress real usage.

Codex archived sessions (`codex.js`, `tools.js`):
- Codex moves a "completed" session's rollout file from `$CODEX_HOME/sessions/` to `$CODEX_HOME/archived_sessions/` (default `~/.codex`, override honored via `CODEX_HOME` like the Codex CLI itself — also the test hook). The parser scans **both** dirs in one pass (`sessionsDirs()`); scanning only the live dir permanently lost any session archived between two syncs. Re-reading an already-synced archived file is idempotent (stateless parser, server dedups), and indexing both dirs together keeps fork replay-skip correct when a fork and its parent are split across them.
- When the same session id exists in both dirs, the parser selects the more complete physical file for both token usage and timing events. This prevents transient live/archive overlap from doubling buckets or session stats. `findCodexDataDirs` in `tools.js` likewise treats either dir as "Codex installed".

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
