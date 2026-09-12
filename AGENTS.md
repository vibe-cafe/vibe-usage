# AGENTS.md

AI agent guidance for the vibe-usage CLI. See [README.md](./README.md) for user-facing docs.

## Repository Structure

```
vibe-usage/
├── bin/vibe-usage.js          # CLI entry point → src/index.js
├── src/
│   ├── index.js               # Command router (init, sync, summary, daemon, reset, skill, status, config, help); short help by default, `help --all` for the full list; legacy spellings print a TTY-only hint
│   ├── parsers/               # One parser per tool, all export async parse() → { buckets, sessions }
│   │   ├── index.js           # Parser registry
│   │   ├── aggregate.js       # aggregateToBuckets() / extractSessions() (kept out of index.js to avoid the registry import cycle)
│   │   ├── contract.js        # normalizeParserResult(): parser result contract + source cross-check
│   │   ├── fs-utils.js        # readJsonSafe() / projectFromPath() / projectFromCwd() / toCount()
│   │   ├── claude-code.js
│   │   ├── cindy-ledger.js      # Cindy-private Codex/Pi daily ledger augmentation; no chat reads
│   │   ├── cline-sdk.js       # Current Cline SDK session artifacts; used alongside the legacy Cline reader
│   │   ├── codex.js
│   │   ├── codex-cache.js     # Versioned, disposable per-rollout Codex parser cache
│   │   ├── cola.js            # Cola Pi-compatible sessions; copied headers retain record identities
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
│   │   ├── qoder.js           # Qoder + Qoder CN: IDE local.db tokens + CLI/app JSONL sessions (credit-billed, no tokens)
│   │   ├── alma.js            # SQLite usage ledger; buckets only, no chat reads
│   │   ├── mcode.js           # MiniMax Code runtime-state SQLite ledger (allow-listed token fields only)
│   │   ├── workbuddy.js       # Streaming JSONL; actual routed-model usage + sessions
│   │   └── zcode.js           # SQLite (via sqlite.js), reads message table
│   ├── extra-roots.js         # Additional-root validation and per-source layout resolvers; used by config roots/add-root/remove-root
│   ├── pi-roots.js            # Pi/OMP default, Pi-configured (env + settings.json), profile, XDG, and override discovery
│   ├── cline-roots.js         # Current SDK + legacy standalone/VSCode-host Cline discovery
│   ├── cola-roots.js          # Cola sessions discovery, including COLA_DATA_DIR
│   ├── cindy-roots.js          # Cindy Global/CN Electron roots + per-owner DB discovery
│   ├── craft-roots.js         # CraftAgent root resolution and detection
│   ├── hermes-roots.js        # Shared Hermes CLI/Desktop home + profile discovery; Windows LOCALAPPDATA with legacy fallback
│   ├── qoder-roots.js         # Qoder / Qoder CN edition table, CLI config dir + IDE data dir resolution, detection
│   ├── workbuddy-roots.js     # WorkBuddy default and fixture/relocation roots
│   ├── tools.js               # TOOLS[] registry + detectInstalledTools()
│   ├── sync.js                # Orchestrator: parse all → diff vs state → batch upload only new/changed
│   ├── state.js               # ~/.vibe-usage/state.json: key→hash of uploaded items (incremental sync), clearState() for reset
│   ├── api.js                 # HTTP client: ingest() (always gzip), requestDeviceCode()/pollDeviceCode() (device flow), deleteAllData(), fetchSettings()
│   ├── summary.js             # `summary --days N`: GET /api/usage with the saved vbu_ key, render markdown (cost / tokens / by-tool / by-model / by-project, each table cost-desc). Powers the SKILL.md "查询用量" entries.
│   ├── config.js              # ~/.vibe-usage/config.json (dev: config.dev.json)
│   ├── init.js                # Setup flow (device-flow browser login by default; --manual-key for CI/headless, verify, initial sync, then installs the background service unless --no-daemon / non-TTY)
│   ├── daemon.js              # 30-minute sync loop (foreground)
│   ├── daemon-service.js      # Background service management (systemd/launchd/Task Scheduler install/uninstall/status); npx-cache runs register `npx --yes @vibe-cafe/vibe-usage@latest daemon`, global/checkout runs pin the bin path
│   ├── reset.js               # Delete remote data + clearState() + re-sync (clearing state is what makes the re-sync re-upload)
│   ├── skill.js               # Install/remove SKILL.md for AI coding tools
│   └── output.js              # Terminal output helpers: colors, OSC 8 links, big/small headers, hint() (TTY-only advisory line)
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

**Approved 2026-09-09 by the maintainer (江昪), shipped in v0.10.25 — one-command onboarding.**

| | |
|---|---|
| Previous invariant | First run on a TTY asked `开启后台自动同步？[Y/n]` (default Y); the service pinned `node <bin> daemon`; an npx-cache run only warned that the path would break. |
| Current invariant | First run on a TTY installs the background service without asking; `--no-daemon` opts out; non-TTY runs never install. When the CLI runs from the npx cache and an `npx` exists next to `process.execPath`, the service is registered as `npx --yes @vibe-cafe/vibe-usage@latest daemon` (PATH pinned to that node dir; launchd `ThrottleInterval` 60 / systemd `RestartSec` 60 so an offline boot cannot restart-storm). Global installs and checkouts still pin the bin path. |
| Affected | New installs and re-runs of `init`; vibe-cafe-web copy (one advertised command); VibeFriends knowledge base 话术. Mac/Windows apps call `sync` / `config` and are unaffected. |
| Compatibility | No command or flag renamed or removed. Existing plists / units / scheduled tasks are untouched; `daemon status` reports `npx` vs pinned. Switching an old pinned-cache service: `daemon uninstall`, then the bare command once. |
| Release ordering | CLI 0.10.25 on the registry first, then the website copy that promises auto background sync, then knowledge-base wording. |
| Rollback | Web: revert the copy PR. CLI: publish a version that restores the prompt; already-installed npx-mode services keep working since they always resolve `@latest`. |

## Key Conventions

- **Approved 2026-09-10 — Cola source:** add `cola` to the CLI and backend source registries using the existing bucket/session schema and backend-owned privacy policy. Read `~/.cola/sessions` or `$COLA_DATA_DIR/sessions`; project comes from the session cwd basename, never a channel/scope slug. Cola 1.4.4 copies transcripts with a new header id/time but unchanged records: opt only Cola into dedup by record id + original timestamp + parent id + role + model, keep the richest usage, and attribute it to the earliest available header (stable session-id/path tie-break). Existing Pi-family dedup keys remain unchanged. Read failures protect prior upload state and suppress partial Cola uploads. No migration/reset is required. Release ordering: deploy backend source registration first, then commit the CLI support together with the Hermes fixes in the unpublished release; the maintainer publishes npm. Rollback removes Cola parsing/registration while preserving existing data.

- **Additional runtime roots** — `config roots / add-root / remove-root` manages additive data directories. Follow the [parser and fixture conventions below](#additional-runtime-roots) when extending support.

- **Pure ESM** (`"type": "module"`) — no CommonJS, no build step
- **Zero dependencies** — only Node built-ins (fs, path, os, crypto, https, readline, child_process, zlib, `node:sqlite`)
- **Incremental upload** — parsers emit a complete view of live local data, then `sync.js` diffs each item's content-hash against `~/.vibe-usage/state.json` and uploads only new/changed buckets/sessions — a quiet machine sends zero bytes. State is committed per-batch only after that batch's upload succeeds (failed batch re-sends next run); prune of dead keys (logs the parsers no longer emit) persists unconditionally and is bounded by liveness, never by age — and is scoped to sources whose parser succeeded that run, so a transient failure or an incomplete Codex cache build never evicts that tool's state into a full re-upload. Deleting `state.json` triggers a one-time full re-upload (which is exactly how `reset` re-populates remote data after deleting it).
- **Hidden-project identity** — parsers aggregate before the backend-provided privacy setting is applied. When the fetched `uploadProject=false`, `sync.js` replaces project names with `unknown` and must re-aggregate buckets before hashing/upload so formerly distinct projects that now share a server key are summed instead of overwriting one another. This is enforcement of backend policy, not a local setting.
- **Cost-accounting invariant** — parsers report token counts plus only price-changing model dimensions (for example Codex `service_tier`). Never collect, persist, or encode an account funding path such as ChatGPT subscription, API billing, credits, or bundled quota. The backend always estimates `tokens × provider-published model/service-tier rate`; funding never changes that value. v0.10.18's `#billing=api` / `#billing=subscription` experiment violated this invariant and v0.10.19 removed it. Do not reintroduce it as billing accuracy, plan detection, or incremental cost.
- **Codex parser cache** — unlike the other stateless parsers, Codex keeps versioned, disposable derived data under `~/.vibe-usage/cache/codex/`. This cache is never authoritative: any miss, corruption, unsafe append, parser-algorithm bump, or write failure falls back to raw logs. Keep it separate from `state.json`; `reset` clears upload state but retains the parser cache so it can re-upload without re-reading every rollout.
- **Stable hostname** — hostname is persisted in config at init; `sync.js` never re-reads `os.hostname()` after first capture. This prevents macOS mDNS hostname drift (e.g., `-2`, `-3` suffixes) from creating duplicate device entries in the DB.
- **npx launcher mode (v0.10.25+)** — `resolvePaths()` flags an npx-cache bin path (`/_npx/`); when an `npx` sits next to `process.execPath`, `install()` hands a `launcher` to the three unit generators and the service runs `npx --yes @vibe-cafe/vibe-usage@latest daemon` (`PACKAGE_SPEC`, the same specifier the Mac app resolves). The unit must also pin `PATH` to that node dir (npx is a `#!/usr/bin/env node` script and launchd / systemd / logon tasks have no node on PATH) and slow relaunches (launchd `ThrottleInterval` 60, systemd `RestartSec` 60) because an offline boot makes npx exit non-zero. Global installs and checkouts keep pinning `node <bin> daemon`. `installedModeFromText()` reads the mode back for `status`: test for the package spec alone, not `--yes <spec>` as one string — the plist splits argv into separate `<string>` elements (the first cut reported every npx plist as pinned). Windows process matching in npx mode is `node.exe` next to `npx.cmd` plus CommandLine `*vibe-usage.js* daemon*` (`parseWindowsTaskInvocation` returns `mode: 'npx'`). Verified on macOS 2026-09-09 from a fake `_npx` path: launchd started npx → node daemon, `daemon.log` got `daemon started`, `daemon uninstall` left no plist and no orphan process.
- **`hint()` is TTY-only** — `output.js` `hint()` prints one dim 提示 line only when `process.stdout.isTTY` (`VIBE_USAGE_FORCE_HINTS=1` for tests). The Mac (`SyncEngine.swift`) and Windows (`sync_engine.rs`) apps run `sync` through a pipe and read stdout as the result / error text, so any extra line there corrupts their parsing. Hints go on the success path of the legacy spelling (`sync`, first-time `init`, `daemon`, `daemon install`, `--key`, `--daemon`, `reset --host`); maintenance commands with no simpler equivalent get none.
- **Windows daemon via Task Scheduler** — `daemon install` on win32 registers a per-user task through `Register-ScheduledTask -Xml`; `schtasks /create /sc onlogon` requires elevation while a self-scoped LogonTrigger does not. The XML must pin `<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>` or Task Scheduler kills the resident daemon at its default 72h limit, and its declaration must say `encoding="UTF-16"` even though the file is written UTF-8 — the COM parser rejects other declarations regardless of how the string reaches it. Generated `~/.vibe-usage/daemon-task.cmd` re-applies `CLAUDE_CONFIG_DIR` plus the preserved service env (session-only vars are missing from the registry user env a logon task inherits) and appends output to `daemon.log`; `daemon-task.vbs` starts it hidden so logon shows no console window. PowerShell runs with `-NoProfile -NonInteractive -ExecutionPolicy Bypass` and explicit `exit` codes, because `-Command` exits 0 even after non-terminating cmdlet errors, and reads the XML with `-Encoding UTF8` since it is written BOM-less (default decoding on zh-CN systems is ANSI).
- **Upload identity** — `client-meta.js` reads the real package version from the shipped `package.json`, creates one `syncId` per `runSync`, and adds batch identity plus runtime/platform/hostname to every ingest request. Direct sync defaults to `surface=cli`, the foreground service passes `surface=daemon`, and desktop apps override via `VIBE_USAGE_SURFACE` / `VIBE_USAGE_SURFACE_VERSION`. Keep the CLI as the only ingest HTTP implementation.
- **No TypeScript** — plain JavaScript throughout
- **Say the size before sending it** — `sync.js` prints the pending bucket/session counts and batch count before the upload loop, a remaining-time estimate inside the per-batch progress line, and the compressed bytes plus elapsed time at the end. The estimate is extrapolated only from batches that already finished (`estimateRemainingSeconds()` returns `null` until then): a first-sync backlog and a steady-state trickle differ by orders of magnitude, so any a-priori rate would be wrong for one of them. All three lines are `!quiet`-gated — the desktop apps parse piped stdout.
- **Parser warnings are never filtered** — `sync.js` writes every parser warning to stderr, including quiet (daemon) runs, because the daemon log is the only trail a background failure leaves. A quiet-mode filter for Cursor's fetch soft-skip made a permanently failing export indistinguishable from a healthy one: empty `daemon.log`, `status` still listing the tool as installed, and zero data for months. Keep transient/permanent distinctions in the *message*, not in whether it is printed.
- **Output style** — user-facing text is Chinese (colored via `output.js` helpers: `success` / `failure` / `warn` / `arrow` / `link`). Dashboard URLs use OSC 8 hyperlinks so terminals that support it (iTerm2, Warp, VSCode, Kitty, Terminal.app 14+) render them as clickable. Raw pass-through from external tools (parser errors, `systemctl` / `launchctl` output, daemon loop timestamps) is kept in English and dimmed so it's visually de-emphasized. `init` prints a big ASCII logo; other commands print a compact one-line header (`bigHeader()` / `smallHeader()` from `output.js`).
- **CLI compatibility** — keep the documented legacy aliases `--key` (for `--manual-key`), `--daemon` (for `daemon`), and `reset --host` (for `reset --local`). The bare invocation remains init-or-sync, and since v0.10.25 the only command we advertise; every other subcommand stays supported. `--no-daemon` and `help --all` are public flags. Old spellings (`sync`, `daemon install`, the aliases above) print a one-line `hint()` pointing at the simpler form — **TTY-only**: the Mac and Windows apps read the CLI's piped stdout as the sync result / error text, so never print hints to a pipe. Do not preserve arbitrary unknown-command fallthrough; it was never a public command and can turn typos into unintended side effects.

## Additional Runtime Roots

`src/extra-roots.js` owns `EXTRA_ROOT_SOURCES`, `validateExtraRoot()`,
`extraRootList()`, and the source-specific layout resolvers, including
`grokSessionsDir()`, `antigravityConversationDirs()`, and `piSessionsDir()`.
The currently supported source ids are `antigravity`, `claude-code`, `codex`, `grok`,
`opencode`, and `pi-coding-agent`.

- **Config routing:** `config roots` lists `config.extraRoots` as JSON;
  `config add-root <source> <path>` validates and persists a normalized path;
  `config remove-root <source> <path>` removes it. `sync.js` passes
  `extraRoots: extraRootList(config.extraRoots?.[source])` to each parser.
  The config key must exactly match its parser/source id (`pi-coding-agent`,
  not `pi`).
- **Additive discovery:** keep each tool's default store and any legacy
  `codexExtraHome` configuration. Extra roots must not replace or mask them.
- **Parser result:** merge roots and de-duplicate overlapping paths or copied
  records inside the parser before returning buckets and sessions, using that
  source's existing deduplication rules.
- **Read failures:** a configured root that is missing, unreadable, or no longer
  resolves must produce `skipped: true` with a warning, never an empty success.
  This prevents `sync.js` from pruning that source's prior incremental state.
- **Fixture isolation:** overrides should isolate normal machine discovery.
  Grok ignores configured roots when `VIBE_USAGE_GROK_SESSIONS` is set. Pi
  currently still validates and appends explicit `extraRoots` when
  `VIBE_USAGE_PI_SESSION_DIRS` is set, so its tests must also pass only temporary
  extra roots. Do not assume the override alone isolates those tests.

- **Claude / OpenCode roots:** the config id is `claude-code`, never `claude`. Claude keeps its existing physical-session/request-copy selection; validate explicit roots on every run and mark the source skipped if projects/transcripts disappear. OpenCode discovery and parsing share `opencode-roots.js`: SQLite wins independently within each root, including empty databases; JSON is used only where no database exists. Read failures suppress partial OpenCode outputs and protect state.
- OpenCode merges raw accounting/timing records before aggregation. Deduplicate copied stores by session id + message id, keeping the copy with the largest token payload (default root wins ties); anonymous ids stay scoped to their physical store. Canonical paths remove symlink overlap. Keep existing token semantics and top-level model/project precedence; nested `model.modelID` only fills an absent model field; project derivation is unchanged. No reset or backend change is needed. `VIBE_USAGE_OPENCODE_DIRS` replaces default discovery; explicit test `extraRoots` remain additive, like Claude.
- Validation for #81 includes a read-only comparison against an actual default OpenCode store: buckets and sessions matched pre-change main exactly. Synthetic SQLite/JSON stores cover cross-root copying, model fallback, failures, and the full config → detection → parser route. No production upload was performed.

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
6. **Check every model id the parser can emit against the pricing map before shipping.** Server-side pricing is source-agnostic: it matches on the model string alone. From a `vibe-cafe` checkout run `cd packages/model-pricing && bun -e "import { getModelMatchInfo } from './src/pricing'; console.log(getModelMatchInfo('<id>'))"` for each id (routing tiers, vendor-internal codes, pseudo-models). Anything that matches a price it should not be billed at must be namespaced with the tool prefix — Qoder's bare `auto` matched the Cursor `auto` entry and was billed at Cursor's rate until PR #83 renamed it `qoder-auto`.
7. Before the first release, verify against a real local store, not only fixtures: sum the raw rows independently (a SQL `GROUP BY` half-hour bucket, or a one-off script over the JSONL) and compare with the parser's buckets number for number. Third-party trackers' claims about a tool's on-disk format (e.g. "the IDE stopped writing `token_info`") are dated observations, not facts — run one real session on the current build and read the file yourself.

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

Qoder parsers (`qoder.js`, two editions via `../qoder-roots.js`):
- Source `qoder` (qoder.com) and `qoder-cn` (qoder.com.cn) are separate accounts, billing and data dirs; never merge them. The IDE store `SharedClientCache/cache/db/local.db` yields real tokens (`prompt_tokens` includes `cached_tokens`) with `model_key` usually a routing tier; only token/model/timing columns are selected. Routing tiers (`auto`, `ultimate`, `performance`, `efficient`, `lite`) are reported as `qoder-<tier>`: a bare `auto` collides with the Cursor `auto` entry in the server pricing map and would be billed at Cursor's rate, whereas `qoder-*` never matches a price and renders as unmatched, which is the truthful state. CLI + desktop app transcripts under `<configDir>/projects/**/*.jsonl` are credit-billed with all token fields 0 — they contribute sessions only. Reading the `credits` field would violate the cost-accounting invariant above and needs the architecture gate; do not add it as a pseudo-model quietly.
- One assistant message is written as several JSONL lines (one per content block); dedupe by `sessionId|message.id`, keeping the last usage-bearing line. `user` records with `toolUseResult` / `tool_result` blocks are tool results, not human prompts.
- `~/.qoder` alone does not mean the CLI is installed (the IDE's `dataFolderName` is `.qoder` too); detection checks `projects/` or the IDE db.

Cline (`cline.js`, `cline-sdk.js`, `cline-roots.js`):
- Cline CLI 3.0.61 / core 0.0.82 writes per-call metrics to `~/.cline/data/sessions/<id>/*.messages.json`; `data/db/sessions.db` is only an index and is not needed for accounting. Read the adjacent version-1 `<id>.json` manifest for project/model fallback. Include child-agent artifacts in that same session directory. Keep old standalone and editor `state/taskHistory.json` + `tasks/<id>/ui_messages.json` stores, including the legacy `~/.cline/data` layout. Honor `CLINE_DIR`, `CLINE_DATA_DIR`, and `CLINE_SESSION_DATA_DIR`; `VIBE_USAGE_CLINE_DIRS` replaces all machine discovery for fixtures.
- SDK `metrics.inputTokens` already includes cache reads and writes: subtract `cacheReadTokens` once into `cachedInputTokens`, leaving cache writes in ordinary input. `outputTokens` is already the full output; the persisted metrics have no separate reasoning field. Never read stored cost as the estimated price. Legacy `tokensIn` is uncached input, so its existing cache-write addition stays unchanged.
- SDK assistant message ids and timestamps identify copied history; keep the richest metrics, with deterministic attribution to the earliest original session. Anonymous messages are scoped to the artifact/session and position. Preserve the existing legacy task-copy selection and upload session ids. Ignore child-agent prompts, tool results, and synthetic user events when counting human turns. Legacy-to-SDK migration can attach cumulative usage to an old assistant without a timestamp: skip that record instead of assigning it the migration time; the legacy store retains the original accounting.
- Read canonical `.messages.json` artifacts only, not compaction sidecars or backups. Reduce parsed records to token/model/timing fields; do not retain or upload message content, system prompts, provider credentials, or costs. Unreadable, corrupt, or unsupported SDK artifacts return `skipped` with warnings so earlier upload state is preserved. Regression coverage: `test/cline.test.js` and `test/cline-sdk.test.js`.
- Service installation preserves all three Cline directory environment variables for launchd, systemd, and Windows tasks, so background sync sees the same relocated store as manual sync. Existing services need reinstallation to capture a newly set variable.
- Verified using the installed official CLI in an isolated directory with a local OpenAI-compatible test endpoint: a new headless conversation followed by an interactive `--id` resume wrote two calls of 100 input (including 30 cache reads) and 20 output; parsing yielded 140 uncached input, 60 cache reads, 40 output, and one session with two human prompts. No paid provider call or backend upload was used for that verification.

Network-fetch parsers (the Cursor exception):
- Cursor stores no usage locally — only an auth token in `state.vscdb`. The parser reads the token via `queryDbJson()`, then GETs a CSV from `cursor.com`.
- Always wrap network calls with `AbortSignal.timeout(...)` so a single hung host can't stall the whole sync (sync.js catches throws per-parser but cannot interrupt a hanging await).
- Size that timeout for the **slowest account**, not the median one. cursor.com computes the export over the whole account, so its latency scales with the user's usage: a too-short default does not fail intermittently, it locks heavy users out of every single sync. 10s (v0.7.11) and 30s (#72) both did this; the default is now 120s, overridable via `VIBE_USAGE_CURSOR_FETCH_TIMEOUT_MS`.
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
- Session logs at `$DSH_HOME/sessions/<project-key>/<id>/session[.vN].jsonl[.zstd]` (default `~/.dsh`; fixture/relocation override `VIBE_USAGE_DSH_SESSIONS`) support released formats V0–V3, checked against DSH tag `dsh-v0.1.5-alpha.2`. Select the highest canonical generation per session directory; never fall back to a frozen predecessor on a corrupt, unreadable, mismatched, or unsupported current generation. Across copied project directories, prefer the newest format before comparing same-version decompressed sizes. DSH migrations retain the original files and can shrink newer logs, so reading every generation double-counts and choosing by size can freeze updates.
- Compressed logs are multi-frame Zstandard — one frame per write batch. Node's `node:zlib` zstd (Node ≥ 22.15) decodes exactly one frame per call, so `splitZstdFrames()` walks the RFC 8878 frame structure (magic/header/blocks/checksum, skippable frames) and decompresses each standard frame separately; an incomplete final frame is ignored at the last complete boundary, while invalid complete structure fails the source as `skipped`. On older Node the `zstd` CLI (`zstd -d -c`) is the fallback; if neither exists the parser returns `skipped` with a hint so prior state is not pruned. Plain JSONL logs are read directly.
- Usage comes from `assistant/message` records. `usage.inputTokens` is uncached input; optional `usage.cacheWriteTokens` is folded into `inputTokens` because the shared bucket schema has no cache-write column; `usage.cacheReadTokens` maps to `cachedInputTokens`. `usage.outputTokens` includes `reasoningTokens` (verified against DSH's own `session_projcache` totals), so reasoning is subtracted from output into `reasoningOutputTokens`.
- Replay dedup is version-specific. V0/V1 use header `parentSession` + numeric `seedLength`; their untagged `session/end-seed` markers may appear after real history and must never define the cut. V2/V3 require boolean `isSeeded`; a seeded log uses the LAST marker whose `data.inherited === true` (its seq excludes the marker itself). An untagged resume marker cannot extend that cut. Reject inconsistent modern seed metadata with `skipped` so upload state survives. Below the cut, skip only messages confirmed in the parent by seq, role, model, and token accounting. Mixed-format migrations renumber seqs, so require preserved message ids in order instead of matching seqs across versions. Ids remain parser-local; session/upload identities do not change. Missing or divergent parent copies retain the sole local history.
- Timing events: `user/message` records with `source.kind === 'user'` (plugin-sourced messages are ignored) plus every `assistant/message`; only sessions with a real user prompt reach `extractSessions()`.
- DeepSeek Harness is in developer preview with compatibility-breaking changes expected. `MAX_SESSION_FORMAT_VERSION` gates both filename and header versions; require those versions to agree. Unknown canonical filenames must warn even if an old supported generation remains alongside them. Before extending support, inspect the upstream filename convention, header, assistant usage, and inheritance codec rather than merely increasing the version limit.

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

Extra-root regression coverage:

| Test file | Coverage |
|---|---|
| `test/cli.test.js` | Config commands, supported source ids, layout validation, legacy-config preservation |
| `test/codex-roots.test.js` | Additive root discovery, path deduplication, live/archive and Multica layouts |
| `test/grok.test.js` | Default-plus-extra stores, copied sessions, missing/unreadable configured roots |
| `test/pi-compatible.test.js` | Extra-root layouts, overlapping paths, copied records, missing/unreadable roots |
| `test/state.test.js` | Pruning only sources whose parsers succeeded |

Run the focused checks locally:

```bash
node --test test/cli.test.js test/codex-roots.test.js test/grok.test.js test/pi-compatible.test.js test/state.test.js
```

Test hooks (env vars honored at module load, set them before importing):
- `VIBE_USAGE_STATE_DIR` / `VIBE_USAGE_CONFIG_DIR` — redirect `state.js` / `config.js` away from the real `~/.vibe-usage` (used by `test/state.test.js`, `test/reset.test.js`)
- Codex cache controls: `VIBE_USAGE_CACHE_DIR` redirects cache writes, `VIBE_USAGE_CODEX_CACHE=0` disables the optimization, `VIBE_USAGE_CODEX_WORK_BUDGET_MS` overrides the non-interactive build budget, and `VIBE_USAGE_CODEX_AUDIT_INTERVAL_MS` / `VIBE_USAGE_CODEX_AUDIT_MAX_BYTES` override rolling-audit bounds
- Per-parser fixtures: `CODEX_HOME`, `VIBE_USAGE_ALMA_DB`, `VIBE_USAGE_CINDY_DIRS`, `VIBE_USAGE_GROK_SESSIONS`, `VIBE_USAGE_KIMI_CODE_DIR`, `VIBE_USAGE_KIMI_DIR`, `VIBE_USAGE_TRAE_CLI_SESSIONS`, `VIBE_USAGE_WORKBUDDY_DIRS`, `VIBE_USAGE_KIRO_LEGACY_TOKENS`, `VIBE_USAGE_DSH_SESSIONS`, `VIBE_USAGE_QODER_PROJECTS` / `VIBE_USAGE_QODER_DB` / `VIBE_USAGE_QODER_CN_PROJECTS` / `VIBE_USAGE_QODER_CN_DB` (the Qoder parser otherwise honors Qoder's own `QODER_CONFIG_DIR` / `QODERCN_CONFIG_DIR` for transcripts and `QODER_HOME` / `QODER_CN_HOME` for the IDE store). The Kimi Code parser resolves its data root as `VIBE_USAGE_KIMI_CODE_DIR` → `KIMI_CODE_HOME` (matching the CLI) → `~/.kimi-code`, and always merges the legacy `~/.kimi` store instead of either/or (`kimi migrate` drops usage records, so no double-count)
- Claude fixtures: `VIBE_USAGE_CLAUDE_DIRS` replaces normal Claude root discovery with a `path.delimiter`-separated root list; `VIBE_USAGE_CLAUDE_DESKTOP_DIRS` overrides only the Claude Desktop user-data roots. The production parser scans `~/.claude`, `$CLAUDE_CONFIG_DIR`, data-bearing `~/.claude-*` profiles, and the per-session `.claude` roots created below Claude Desktop's `local-agent-mode-sessions`. Desktop Code already writes to the normal Claude Code root, while Cowork uses the private roots. Both remain source `claude-code`. The parser streams each JSONL file to its captured size, de-duplicates usage by API call identity (`message.id` + `requestId`, falling back to the line `uuid` when a record carries neither) keeping the most complete payload for each call, and returns `skipped` with warnings after any read failure so incremental state is not pruned. Claude Code writes one assistant line per content block - all sharing the call ids and repeating the same `usage` object - plus an early partial line while streaming, so a per-line key counted a single call once per block.
- Pi-family/Cline/OpenClaw fixtures: `VIBE_USAGE_PI_SESSION_DIRS`, `VIBE_USAGE_OMP_SESSION_DIRS`, `VIBE_USAGE_CLINE_DIRS`, and `VIBE_USAGE_OPENCLAW_DIRS` replace normal discovery with `path.delimiter`-separated roots. Pi still appends explicit `extraRoots`, as described in [Additional Runtime Roots](#additional-runtime-roots).

## Versioning

- Keep `version` aligned in `package.json` and `package-lock.json` before publishing
  (`npm version <x.y.z> --no-git-tag-version` updates both; hand-editing one is how they drift)
- Published as `@vibe-cafe/vibe-usage` on npm
- Users run via `npx @vibe-cafe/vibe-usage`

### Publishing with 2FA on the account

**Do not pipe `npm publish`.** With webauthn/passkey 2FA the CLI opens a browser and
polls for approval, but it only does that when stdout is a TTY. Behind a pipe it skips
the browser step and fails `EOTP` instead — asking for a code the account does not have.
Three releases were burned on this before the pipe itself was suspected; the wrapper
added *to observe the failure* was the failure.

```bash
# Wrong: tee makes stdout a pipe, npm never opens the browser
npm publish --access public 2>&1 | tee publish.log

# Right: script(1) keeps a pty and still captures everything
script -q publish.log npm publish --access public
```

- **`EOTP`'s wording lies.** "requires a one-time password from your authenticator" is a
  generic message; it does not mean a TOTP app is enrolled. Ask which second factor the
  account actually has instead of inferring one from the error, and do not reach for
  `--otp=` on a passkey-only account.
- **`npm whoami` returning a username is not proof you can publish.** A stored token
  authenticates the account without satisfying 2FA, and the EOTP lands *after* npm has
  packed the tarball, so it reads like a packaging failure.
- **`npm login --auth-type=web` can fail on its own.** Its `/-/v1/login` endpoint has
  returned `ECONNRESET` while `publish` reached the registry fine in the same minute —
  and when it fails **no browser opens at all**, which looks like the human forgot to
  click. A login failure says nothing about registry reachability.
- **A successful publish is async: `PUT 202` + "Your package is being processed".**
  `npm view` and the version endpoint (`/<pkg>/<version>` → 404) keep showing the old
  release for a few minutes. Exit code 0 with `info ok` in `~/.npm/_logs/` is the real
  signal; a `202` is acceptance, not failure.
- **Those log filenames are UTC** (`2026-09-09T17_16_54_269Z`). Convert before deciding a
  log is stale — a success two minutes old reads as eight hours old at UTC+8.
- **Verify by unpacking what was published**, never by the exit code alone:
  `npm pack @vibe-cafe/vibe-usage@<version> --prefer-online`, untar, grep the shipped
  `src/`. `npm view` without `--prefer-online` reads a local cache and reports the
  previous version as current.
