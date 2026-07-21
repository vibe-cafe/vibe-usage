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
│   │   ├── codex-cache.js     # Versioned, disposable per-rollout Codex parser cache
│   │   ├── grok.js            # ~/.grok/sessions updates.jsonl turn_completed usage
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
│   ├── state.js               # ~/.vibe-usage/state.json: key→hash of uploaded items (incremental sync), clearState() for reset
│   ├── api.js                 # HTTP client: ingest() (always gzip), requestDeviceCode()/pollDeviceCode() (device flow), deleteAllData(), fetchSettings()
│   ├── summary.js             # `summary --days N`: GET /api/usage with the saved vbu_ key, render markdown (cost / tokens / by-model / by-project). Powers the SKILL.md "查询用量" entries.
│   ├── config.js              # ~/.vibe-usage/config.json (dev: config.dev.json)
│   ├── init.js                # Setup flow (device-flow browser login by default; --manual-key for CI/headless, verify, initial sync, daemon install prompt)
│   ├── daemon.js              # 30-minute sync loop (foreground)
│   ├── daemon-service.js      # Background service management (systemd/launchd install/uninstall/status)
│   ├── reset.js               # Delete remote data + clearState() + re-sync (clearing state is what makes the re-sync re-upload)
│   ├── skill.js               # Install/remove SKILL.md for AI coding tools
│   └── output.js              # Terminal output helpers: colors, OSC 8 links, big/small headers
├── SKILL.md                   # Skill definition (also used by `npx skills add`)
└── package.json               # @vibe-cafe/vibe-usage, ESM, Node >=20 (≥22.5 enables built-in node:sqlite), zero dependencies
```

## Key Conventions

- **Pure ESM** (`"type": "module"`) — no CommonJS, no build step
- **Zero dependencies** — only Node built-ins (fs, path, os, crypto, https, readline, child_process, zlib, `node:sqlite`)
- **Incremental upload** — parsers emit a complete view of live local data, then `sync.js` diffs each item's content-hash against `~/.vibe-usage/state.json` and uploads only new/changed buckets/sessions — a quiet machine sends zero bytes. State is committed per-batch only after that batch's upload succeeds (failed batch re-sends next run); prune of dead keys (logs the parsers no longer emit) persists unconditionally and is bounded by liveness, never by age — and is scoped to sources whose parser succeeded that run, so a transient failure or an incomplete Codex cache build never evicts that tool's state into a full re-upload. Deleting `state.json` triggers a one-time full re-upload (which is exactly how `reset` re-populates remote data after deleting it).
- **Codex parser cache** — unlike the other stateless parsers, Codex keeps versioned, disposable derived data under `~/.vibe-usage/cache/codex/`. This cache is never authoritative: any miss, corruption, unsafe append, parser-algorithm bump, or write failure falls back to raw logs. Keep it separate from `state.json`; `reset` clears upload state but retains the parser cache so it can re-upload without re-reading every rollout.
- **Stable hostname** — hostname is persisted in config at init; `sync.js` never re-reads `os.hostname()` after first capture. This prevents macOS mDNS hostname drift (e.g., `-2`, `-3` suffixes) from creating duplicate device entries in the DB.
- **No TypeScript** — plain JavaScript throughout
- **Output style** — user-facing text is Chinese (colored via `output.js` helpers: `success` / `failure` / `warn` / `arrow` / `link`). Dashboard URLs use OSC 8 hyperlinks so terminals that support it (iTerm2, Warp, VSCode, Kitty, Terminal.app 14+) render them as clickable. Raw pass-through from external tools (parser errors, `systemctl` / `launchctl` output, daemon loop timestamps) is kept in English and dimmed so it's visually de-emphasized. `init` prints a big ASCII logo; other commands print a compact one-line header (`bigHeader()` / `smallHeader()` from `output.js`).
- **CLI compatibility** — keep the documented legacy aliases `--key` (for `--manual-key`), `--daemon` (for `daemon`), and `reset --host` (for `reset --local`). The bare invocation remains init-or-sync. Do not preserve arbitrary unknown-command fallthrough; it was never a public command and can turn typos into unintended side effects.

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
- Mark transient/network errors with `err.skip = true` and return `{ buckets: [], sessions: [], skipped: true }` so the parser stays quiet without letting `sync.js` prune that source's incremental state. Only auth/permanent errors should bubble up.

Codex forked sessions (`codex.js`):
- Forking a Codex conversation writes a *new* rollout file that replays the entire source conversation at the top — every `event_msg/token_count` included, all timestamped in a 1–3s burst at the fork instant. Those tokens are already counted from the source session's own file, so naively parsing the fork double-counts and spikes token/cost at the fork timestamp.
- Unique ordinary sessions take a cheap header discovery pass followed by one usage pass. Only forks, sub-agents, their referenced parents, corrupt headers, and duplicate session ids build the full replay index. For those files, the index treats only the first `session_meta` as canonical and records a monotonic raw-`token_count` timestamp plus compact payload fingerprint. The usage pass skips the longest child token prefix that exactly matches a suffix of the parent snapshot present at spawn. Requiring the snapshot suffix avoids false matches against unrelated interior turns, remains exact when the parent continues running, and avoids over-skipping truncated-history forks. Recognized sub-agents have one additional live-write safeguard: when their exact leading payload sequence matches an interior parent slice but has not reached the snapshot suffix yet, that sequence is treated as an in-progress replay instead of real usage. If the source file is missing or no payload sequence matches, skip nothing unless the child provides its own task boundary.
- All raw-log passes **stream** each rollout line-by-line (`node:readline` over a `createReadStream`), never loading a full rollout into memory. Every read is bounded to the size captured before parsing. Exact stat signatures reuse cached summaries with zero raw-log reads. Ordinary append-only files additionally validate inode/device, size growth, newline alignment, and a trailing-prefix guard before reading only the new bytes; complex replay participants and any failed guard take the complete path. A 30-day rolling audit re-reads at most one warm file up to 64 MiB per invocation. Non-interactive cold builds use a 105-second work budget and return `skipped` progress so `sync.js` protects old upload state while the next run resumes from per-file checkpoints.

Codex sub-agent sessions (`codex.js`):
- A sub-agent rollout (`session_meta.payload.thread_source === 'subagent'`, a `source: { subagent: ... }` object, or a `parent_thread_id`) can begin with full parent history (including a second parent `session_meta`) or a last-N-turn suffix without that meta. Only the first child meta is canonical. The exact token-sequence match locates the copied suffix; the child's own `task_started`/`turn_started` at the end of that suffix supplies the record boundary so copied timing events are skipped too. If a live rollout currently contains only an exact partial copy of the parent, skip that matching prefix until a later stable snapshot reveals the completed replay boundary. Legacy single-meta files fall back conservatively to their first task boundary, and unmatched payloads retain fail-open counting.
- Duplicate `token_count` emissions: Codex occasionally writes the same record twice back-to-back — identical `last_token_usage`, unchanged `total_token_usage.total_tokens`. A real API call always advances the cumulative counter, so an unchanged **positive** total marks the event as contributing zero (duplicate, or zero-usage bookkeeping like compaction) and it is skipped instead of summing `last_token_usage` twice. Guarded to positive totals so builds that leave `total_token_usage` all-zero can't suppress real usage.

Codex archived sessions (`codex.js`, `tools.js`):
- Codex moves a "completed" session's rollout file from `$CODEX_HOME/sessions/` to `$CODEX_HOME/archived_sessions/` (default `~/.codex`, override honored via `CODEX_HOME` like the Codex CLI itself — also the test hook). The parser scans **both** dirs in one pass (`sessionsDirs()`); scanning only the live dir permanently lost any session archived between two syncs. A newly moved path may be parsed once before receiving its own cache entry; complete outputs and server-side upserts remain idempotent, and indexing both dirs together keeps fork replay-skip correct when a fork and its parent are split across them.
- When the same session id exists in both dirs, the parser selects the more complete physical file for both token usage and timing events. This prevents transient live/archive overlap from doubling buckets or session stats. `findCodexDataDirs` in `tools.js` likewise treats either dir as "Codex installed".

## Development & Testing

```bash
# Run the test suite (node:test; CI runs it on Node 20/22 × ubuntu/macos via .github/workflows/test.yml)
npm test

# Dev mode (separate config, custom API URL)
VIBE_USAGE_DEV=1 VIBE_USAGE_API_URL=http://localhost:3000 node ./bin/vibe-usage.js init
VIBE_USAGE_DEV=1 node ./bin/vibe-usage.js sync

# Quick parser test
node -e "import('./src/parsers/<tool-id>.js').then(m => m.parse()).then(r => console.log(JSON.stringify(r, null, 2)))"
```

Test hooks (env vars honored at module load, set them before importing):
- `VIBE_USAGE_STATE_DIR` / `VIBE_USAGE_CONFIG_DIR` — redirect `state.js` / `config.js` away from the real `~/.vibe-usage` (used by `test/state.test.js`, `test/reset.test.js`)
- Codex cache controls: `VIBE_USAGE_CACHE_DIR` redirects cache writes, `VIBE_USAGE_CODEX_CACHE=0` disables the optimization, `VIBE_USAGE_CODEX_WORK_BUDGET_MS` overrides the non-interactive build budget, and `VIBE_USAGE_CODEX_AUDIT_INTERVAL_MS` / `VIBE_USAGE_CODEX_AUDIT_MAX_BYTES` override rolling-audit bounds
- Per-parser fixtures: `CODEX_HOME`, `VIBE_USAGE_GROK_SESSIONS`, `VIBE_USAGE_KIMI_CODE_DIR`, `VIBE_USAGE_KIMI_DIR`, `VIBE_USAGE_TRAE_CLI_SESSIONS`, `VIBE_USAGE_KIRO_LEGACY_TOKENS`
- Claude fixtures: `VIBE_USAGE_CLAUDE_DIRS` replaces normal Claude root discovery with a `path.delimiter`-separated root list. The production parser scans `~/.claude`, `$CLAUDE_CONFIG_DIR`, and data-bearing `~/.claude-*` profiles, streams each JSONL file to its captured size, keeps the most complete duplicate session/UUID, and returns `skipped` with warnings after any read failure so incremental state is not pruned.

## Versioning

- Keep `version` aligned in `package.json` and `package-lock.json` before publishing
- Published as `@vibe-cafe/vibe-usage` on npm
- Users run via `npx @vibe-cafe/vibe-usage`
