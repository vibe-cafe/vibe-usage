# AGENTS.md

AI agent guidance for the vibe-usage CLI. See [README.md](./README.md) for user-facing docs.

## Repository Structure

```
vibe-usage/
├── bin/vibe-usage.js          # CLI entry point → src/index.js
├── src/
│   ├── index.js               # Command router (init, sync, daemon, reset, skill, status, config)
│   ├── parsers/               # One parser per tool, all export async parse() → { buckets, sessions }
│   │   ├── index.js           # Parser registry
│   │   ├── aggregate.js       # aggregateToBuckets() / extractSessions() (kept out of index.js to avoid the registry import cycle)
│   │   ├── contract.js        # normalizeParserResult(): parser result contract + source cross-check
│   │   ├── fs-utils.js        # readJsonSafe() / projectFromPath() / projectFromCwd() / toCount()
│   │   ├── claude-code.js
│   │   ├── cindy-ledger.js      # Cindy-private Codex/Pi daily ledger augmentation; no chat reads
│   │   ├── codex.js
│   │   ├── codex-cache.js     # Versioned, disposable per-rollout Codex parser cache
│   │   ├── grok.js            # ~/.grok/sessions updates.jsonl turn_completed usage
│   │   ├── copilot-cli.js
│   │   ├── sqlite.js          # queryDbJson() — node:sqlite (Node ≥22.5), falls back to sqlite3 CLI
│   │   ├── cursor.js          # SQLite (read auth token) + cursor.com CSV export
│   │   ├── gemini-cli.js
│   │   ├── opencode.js        # SQLite (via sqlite.js), legacy JSON fallback
│   │   ├── openclaw.js
│   │   ├── omp.js             # Oh My Pi, via the shared Pi-compatible JSONL reader
│   │   ├── pi-session-jsonl.js # Shared Pi/CraftAgent/OMP reader + copied-record dedup
│   │   ├── craft-agent.js
│   │   ├── qwen-code.js
│   │   ├── kimi-code.js          # Both stores parsed+merged: ~/.kimi-code (root via $KIMI_CODE_HOME) + legacy ~/.kimi
│   │   ├── amp.js
│   │   ├── droid.js
│   │   ├── dsh.js              # DeepSeek Harness multi-frame zstd session logs
│   │   ├── antigravity-db.js  # Offline SQLite + protobuf reader for App 2.0 / agy CLI
│   │   ├── kiro.js            # SQLite (via sqlite.js), JSONL fallback
│   │   ├── hermes.js          # SQLite (via sqlite.js), multi-profile
│   │   ├── trae-cli.js        # Trae CLI JSONL telemetry (not Trae IDE/Work)
│   │   ├── alma.js            # SQLite usage ledger; buckets only, no chat reads
│   │   ├── mcode.js           # MiniMax Code runtime-state SQLite ledger (allow-listed token fields only)
│   │   ├── workbuddy.js       # Streaming JSONL; actual routed-model usage + sessions
│   │   └── zcode.js           # SQLite (via sqlite.js), reads message table
│   ├── pi-roots.js            # Pi/OMP default, Pi-configured (env + settings.json), profile, XDG, and override discovery
│   ├── cline-roots.js         # Standalone + VSCode-host Cline discovery
│   ├── cindy-roots.js          # Cindy Global/CN Electron roots + per-owner DB discovery
│   ├── craft-roots.js         # CraftAgent root resolution and detection
│   ├── workbuddy-roots.js     # WorkBuddy default and fixture/relocation roots
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

## Architecture Approval Gate

A GitHub issue, pull request, or feature request is a **proposal**, not approval
to change product architecture. A broad maintenance request such as "fix every
meaningful issue" authorizes triage and ordinary fixes; it does **not** waive
this gate.

Get explicit maintainer approval for the concrete design and rollout **before
editing, merging, version-bumping, publishing, or deploying** any change that
affects one or more of:

- source of truth or control-plane ownership (backend vs. local config);
- privacy/security policy, collected metadata, or precedence between settings;
- first-run defaults, onboarding questions, or opt-in/opt-out semantics;
- hostname/device/session identity, dedup keys, incremental-state keys, or reset behavior;
- cross-repository API contracts, backend storage/schema, or migrations;
- automatic update behavior across CLI, daemon, Mac, and Windows distributions.

Before requesting approval, state the current invariant, proposed invariant,
affected repositories/data/users, compatibility and migration behavior,
release ordering, and rollback plan. Do not infer approval from issue labels,
age, detail, author confidence, or the absence of objections. A bug fix that
only restores already-documented behavior does not need a new architecture
decision.

**Current Vibe Usage invariant:** upload/privacy policy is backend-owned.
`sync.js` fetches `/api/usage/settings`, caches the last backend answer only for
same-server outages, and the ingest endpoint independently enforces
`usageUploadProject`. Local `config.json` contains operational client state; it
must not gain higher-priority policy controls without an explicitly approved,
cross-repository RFC. `hostname` is a stable upload identity, so changing its
meaning is also an architecture change.

Incident marker: v0.10.15 introduced local privacy precedence and new defaults
from issue #49 without architecture approval; v0.10.16 fully reverted it. Do
not reintroduce any part as a "compatibility" or "small privacy" fix without
passing this gate.

## Key Conventions

- **Pure ESM** (`"type": "module"`) — no CommonJS, no build step
- **Zero dependencies** — only Node built-ins (fs, path, os, crypto, https, readline, child_process, zlib, `node:sqlite`)
- **Incremental upload** — parsers emit a complete view of live local data, then `sync.js` diffs each item's content-hash against `~/.vibe-usage/state.json` and uploads only new/changed buckets/sessions — a quiet machine sends zero bytes. State is committed per-batch only after that batch's upload succeeds (failed batch re-sends next run); prune of dead keys (logs the parsers no longer emit) persists unconditionally and is bounded by liveness, never by age — and is scoped to sources whose parser succeeded that run, so a transient failure or an incomplete Codex cache build never evicts that tool's state into a full re-upload. Deleting `state.json` triggers a one-time full re-upload (which is exactly how `reset` re-populates remote data after deleting it).
- **Hidden-project identity** — parsers aggregate before the backend-provided privacy setting is applied. When the fetched `uploadProject=false`, `sync.js` replaces project names with `unknown` and must re-aggregate buckets before hashing/upload so formerly distinct projects that now share a server key are summed instead of overwriting one another. This is enforcement of backend policy, not a local setting.
- **Cost-accounting invariant** — parsers report token counts plus only price-changing model dimensions (for example Codex `service_tier`). Never collect, persist, or encode an account funding path such as ChatGPT subscription, API billing, credits, or bundled quota. The backend always estimates `tokens × provider-published model/service-tier rate`; funding never changes that value. v0.10.18's `#billing=api` / `#billing=subscription` experiment violated this invariant and v0.10.19 removed it. Do not reintroduce it as billing accuracy, plan detection, or incremental cost.
- **Codex parser cache** — unlike the other stateless parsers, Codex keeps versioned, disposable derived data under `~/.vibe-usage/cache/codex/`. This cache is never authoritative: any miss, corruption, unsafe append, parser-algorithm bump, or write failure falls back to raw logs. Keep it separate from `state.json`; `reset` clears upload state but retains the parser cache so it can re-upload without re-reading every rollout.
- **Stable hostname** — hostname is persisted in config at init; `sync.js` never re-reads `os.hostname()` after first capture. This prevents macOS mDNS hostname drift (e.g., `-2`, `-3` suffixes) from creating duplicate device entries in the DB.
- **Upload identity** — `client-meta.js` reads the real package version from the shipped `package.json`, creates one `syncId` per `runSync`, and adds batch identity plus runtime/platform/hostname to every ingest request. Direct sync defaults to `surface=cli`, the foreground service passes `surface=daemon`, and desktop apps override via `VIBE_USAGE_SURFACE` / `VIBE_USAGE_SURFACE_VERSION`. Keep the CLI as the only ingest HTTP implementation.
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

Pi-compatible JSONL parsers (`pi-coding-agent.js`, `craft-agent.js`, `omp.js`):
- Use `parsePiSessionJsonl()` instead of duplicating filesystem/message parsing.
- Fold `usage.cacheWrite` into input tokens and keep `cacheRead` separate. OMP/Pi `usage.output` already includes reasoning, so subtract reasoning from output before storing it in `reasoningOutputTokens`. Pi's `Usage` type spells that field `reasoning`; the older `reasoningTokens` spelling stays accepted as a fallback.
- Deduplicate stable message ids across copied/profile stores. Any directory read failure returns `skipped` so incremental state is not pruned.

SQLite-backed parsers (alma, cindy, cursor, dimagent, hermes, kiro, mcode, mimocode, opencode, zcode):
- Use `queryDbJson(dbPath, sql)` from `src/parsers/sqlite.js` — never shell out to `sqlite3` directly. It prefers Node's built-in `node:sqlite` (`DatabaseSync`, opened read-only; Node ≥ 22.5, works on Windows with no extra binary) and falls back to the `sqlite3` CLI on older Node.
- Rows come back as plain objects (`{ column: value }`), same shape as `sqlite3 -json` — INTEGER → number, TEXT → string, JSON via `json_extract` → string.
- If neither `node:sqlite` nor the CLI is available the helper throws an `ENOENT`-flavored error; catch it and rethrow `'sqlite3 CLI not found. Install sqlite3 (or use Node >= 22.5) to sync X data.'` so the user gets a hint.
- For DBs the source app holds a write lock on (Cursor, Kiro), use `queryDbJsonSnapshotOnLock()`. Cindy always uses `queryDbJsonSnapshot()` because a clean WAL-mode database may need SQLite to initialize shared-memory metadata; writable access is confined to the disposable DB/WAL/SHM copy, while the source stays untouched.
- Alma reads only `usage_records` token fields plus workspace names. Its ledger represents assistant responses only, so return buckets with `sessions: []` instead of reading chat records to infer timing.
- mcode reads only `local_runtime_token_usage` allow-listed token fields and session `workspace_dir` / `project_workspace_dir`; `raw`, message tables, and JSON payload columns are never selected. Its WAL database is read through a disposable snapshot-on-lock path, and schema/read failures return `skipped` to protect incremental state. Fixture overrides: `VIBE_USAGE_MCODE_DB` or `MCODE_HOME`.
- Cindy reads only `daily_model_usage` across both regional user-data roots and every per-owner DB. Claude Code rows are excluded because Cindy's SDK already writes normal `~/.claude` transcripts; merge Codex/Pi rows into their existing parser/source, sum currency rows, fold `cache_create_tokens` into input, and add no sessions. Never select `messages`, credentials, costs, or owner ids.

Network-fetch parsers (the Cursor exception):
- Cursor stores no usage locally — only an auth token in `state.vscdb`. The parser reads the token via `queryDbJson()`, then GETs a CSV from `cursor.com`.
- Always wrap network calls with `AbortSignal.timeout(...)` so a single hung host can't stall the whole sync (sync.js catches throws per-parser but cannot interrupt a hanging await).
- Mark transient/network errors with `err.skip = true` and return `{ buckets: [], sessions: [], skipped: true }` so the parser stays quiet without letting `sync.js` prune that source's incremental state. Only auth/permanent errors should bubble up.

WorkBuddy JSONL parser (`workbuddy.js`):
- Stream each JSONL file only to its captured size; never retain or upload message content.
- Use the top-level usage-record id for copied-record dedup and `providerData.requestModelId` for the routed model identifier exposed by WorkBuddy. A conversation request id can span multiple billable model calls and is not a dedup key.
- WorkBuddy aggregate input/output counts include cache reads/reasoning. Split those subsets before `aggregateToBuckets()` so token categories do not overlap. Count usage from completed assistant records and usage-bearing `function_call` records.
- Emit timing events from user records, completed assistant records, and usage-bearing `function_call` records; pass only sessions with a user prompt to `extractSessions()`.

Codex forked sessions (`codex.js`):
- Forking a Codex conversation writes a *new* rollout file that replays the entire source conversation at the top — every `event_msg/token_count` included, all timestamped in a 1–3s burst at the fork instant. Those tokens are already counted from the source session's own file, so naively parsing the fork double-counts and spikes token/cost at the fork timestamp.
- Unique ordinary sessions take a cheap header discovery pass followed by one usage pass. Only forks, sub-agents, their referenced parents, corrupt headers, and duplicate session ids build the full replay index. For those files, the index treats only the first `session_meta` as canonical and records a monotonic raw-`token_count` timestamp plus compact payload fingerprint. The usage pass skips the longest child token prefix that exactly matches a suffix of the parent snapshot present at spawn. Requiring the snapshot suffix avoids false matches against unrelated interior turns, remains exact when the parent continues running, and avoids over-skipping truncated-history forks. Recognized sub-agents have one additional live-write safeguard: when their exact leading payload sequence matches an interior parent slice but has not reached the snapshot suffix yet, that sequence is treated as an in-progress replay instead of real usage. If the source file is missing or no payload sequence matches, skip nothing unless the child provides its own task boundary.
- All raw-log passes **stream** each rollout line-by-line (`node:readline` over a `createReadStream`), never loading a full rollout into memory. Every read is bounded to the size captured before parsing. Exact stat signatures reuse cached summaries with zero raw-log reads. Ordinary append-only files additionally validate inode/device, size growth, newline alignment, and a trailing-prefix guard before reading only the new bytes; complex replay participants and any failed guard take the complete path. A 30-day rolling audit re-reads at most one warm file up to 64 MiB per invocation. Non-interactive cold builds use a 105-second work budget and return `skipped` progress so `sync.js` protects old upload state while the next run resumes from per-file checkpoints.

Codex sub-agent sessions (`codex.js`):
- A sub-agent rollout (`session_meta.payload.thread_source === 'subagent'`, a `source: { subagent: ... }` object, or a `parent_thread_id`) can begin with full parent history (including a second parent `session_meta`) or a last-N-turn suffix without that meta. Only the first child meta is canonical. The exact token-sequence match locates the copied suffix; the child's own `task_started`/`turn_started` at the end of that suffix supplies the record boundary so copied timing events are skipped too. If a live rollout currently contains only an exact partial copy of the parent, skip that matching prefix until a later stable snapshot reveals the completed replay boundary. Legacy single-meta files fall back conservatively to their first task boundary, and unmatched payloads retain fail-open counting.
- Duplicate `token_count` emissions: Codex occasionally writes the same record twice back-to-back — identical `last_token_usage`, unchanged `total_token_usage.total_tokens`. A real API call always advances the cumulative counter, so an unchanged **positive** total marks the event as contributing zero (duplicate, or zero-usage bookkeeping like compaction) and it is skipped instead of summing `last_token_usage` twice. Guarded to positive totals so builds that leave `total_token_usage` all-zero can't suppress real usage.

DeepSeek Harness parser (`dsh.js`):
- Session logs at `$DSH_HOME/sessions/<project-key>/session-<id>/session.jsonl.zstd` (default `~/.dsh`; fixture/relocation override `VIBE_USAGE_DSH_SESSIONS`) are multi-frame Zstandard — one frame per write batch. Node's `node:zlib` zstd (Node ≥ 22.15) decodes exactly one frame per call, so `splitZstdFrames()` walks the RFC 8878 frame structure (magic/header/blocks/checksum, skippable frames) and decompresses each standard frame separately; an incomplete final frame is ignored at the last complete boundary, while invalid complete structure fails the source as `skipped`. On older Node the `zstd` CLI (`zstd -d -c`) is the fallback; if neither exists the parser returns `skipped` with a hint so prior state is not pruned. Plain `session.jsonl` logs (compression disabled) are read directly.
- Usage comes from `assistant/message` records. `usage.inputTokens` is uncached input; optional `usage.cacheWriteTokens` is folded into `inputTokens` because the shared bucket schema has no cache-write column; `usage.cacheReadTokens` maps to `cachedInputTokens`. `usage.outputTokens` includes `reasoningTokens` (verified against DSH's own `session_projcache` totals), so reasoning is subtracted from output into `reasoningOutputTokens`.
- Replay dedup uses immutable header metadata, never `session/end-seed` marker position: DSH (dev preview) writes that marker at creation and resume boundaries, so "skip before the last marker" can discard real history. A fork/subagent header's `parentSession` identifies the source and `seedLength` is the exact count of inherited leading event seqs. The parser skips child messages below that boundary only when the selected parent copy still has matching seq, role, model, and token accounting; missing, corrupt, divergent, or invalid source records fail open so the sole local copy is not lost. Files without both lineage fields are counted in full. A session id appearing in several project dirs keeps the most complete copy.
- Timing events: `user/message` records with `source.kind === 'user'` (plugin-sourced messages are ignored) plus every `assistant/message`; only sessions with a real user prompt reach `extractSessions()`.
- DeepSeek Harness is in developer preview with compatibility-breaking changes expected. `SESSION_FORMAT_VERSION` gates the header `version` field: unknown versions are skipped with a warning so a future on-disk format fails loud instead of mis-parsing.

Codex archived sessions (`codex.js`, `tools.js`):
- Codex moves a "completed" session's rollout file from `$CODEX_HOME/sessions/` to `$CODEX_HOME/archived_sessions/` (default `~/.codex`, override honored via `CODEX_HOME` like the Codex CLI itself — also the test hook). The parser scans **both** dirs in one pass (`sessionsDirs()`); scanning only the live dir permanently lost any session archived between two syncs. A newly moved path may be parsed once before receiving its own cache entry; complete outputs and server-side upserts remain idempotent, and indexing both dirs together keeps fork replay-skip correct when a fork and its parent are split across them.
- When the same session id exists in both dirs, the parser selects the more complete physical file for both token usage and timing events. This prevents transient live/archive overlap from doubling buckets or session stats. `findCodexDataDirs` in `tools.js` likewise treats either dir as "Codex installed".

## Development & Testing

```bash
# Run the test suite (node:test; CI runs it on Node 20/22/24 × ubuntu/macos via .github/workflows/test.yml)
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
- Per-parser fixtures: `CODEX_HOME`, `VIBE_USAGE_ALMA_DB`, `VIBE_USAGE_CINDY_DIRS`, `VIBE_USAGE_GROK_SESSIONS`, `VIBE_USAGE_KIMI_CODE_DIR`, `VIBE_USAGE_KIMI_DIR`, `VIBE_USAGE_TRAE_CLI_SESSIONS`, `VIBE_USAGE_WORKBUDDY_DIRS`, `VIBE_USAGE_KIRO_LEGACY_TOKENS`, `VIBE_USAGE_DSH_SESSIONS`. The Kimi Code parser resolves its data root as `VIBE_USAGE_KIMI_CODE_DIR` → `KIMI_CODE_HOME` (matching the CLI) → `~/.kimi-code`, and always merges the legacy `~/.kimi` store instead of either/or (`kimi migrate` drops usage records, so no double-count)
- Claude fixtures: `VIBE_USAGE_CLAUDE_DIRS` replaces normal Claude root discovery with a `path.delimiter`-separated root list; `VIBE_USAGE_CLAUDE_DESKTOP_DIRS` overrides only the Claude Desktop user-data roots. The production parser scans `~/.claude`, `$CLAUDE_CONFIG_DIR`, data-bearing `~/.claude-*` profiles, and the per-session `.claude` roots created below Claude Desktop's `local-agent-mode-sessions`. Desktop Code already writes to the normal Claude Code root, while Cowork uses the private roots. Both remain source `claude-code`. The parser streams each JSONL file to its captured size, de-duplicates usage by API call identity (`message.id` + `requestId`, falling back to the line `uuid` when a record carries neither) keeping the most complete payload for each call, and returns `skipped` with warnings after any read failure so incremental state is not pruned. Claude Code writes one assistant line per content block - all sharing the call ids and repeating the same `usage` object - plus an early partial line while streaming, so a per-line key counted a single call once per block.
- Pi-family/Cline/OpenClaw fixtures: `VIBE_USAGE_PI_SESSION_DIRS`, `VIBE_USAGE_OMP_SESSION_DIRS`, `VIBE_USAGE_CLINE_DIRS`, and `VIBE_USAGE_OPENCLAW_DIRS` replace normal discovery with `path.delimiter`-separated roots.

## Versioning

- Keep `version` aligned in `package.json` and `package-lock.json` before publishing
- Published as `@vibe-cafe/vibe-usage` on npm
- Users run via `npx @vibe-cafe/vibe-usage`
