# k-on-bot

A Telegram group AI bot: it stores every message of the chats it is in, builds
context from reply chains, and answers through several model platforms with
tools, widgets and a Mini App control panel. TypeScript, ESM, Node, SQLite.

Several agent sessions work in this checkout at the same time, and production
runs from the same directory. Most rules below exist because of that.

## Hard rules

1. **Never open `database.sqlite` on the host.** Not with sqlite3, not through
   a script, not a copy of it. Production mounts that single file and keeps
   its write-ahead log inside the container; a host process sees stale data
   and can corrupt the file. To look at production data use
   `npx tsx scripts/prod-query.mts` (read-only, runs inside the container).
2. **A script that imports anything from `src/` imports
   `scripts/offline/harness.mts` first** (and awaits `setupOfflineDb()` when it
   needs the database). The harness points the database at a scratch file.
   `src/db/config.ts` throws when `DB_PATH` is unset outside the container.
3. **Run files with `npx tsx <file>`**, never `pnpm tsx`.
4. **Ask the owner before anything that touches production**: `docker compose
   restart|up|down|build`, pushing to `master` (a restart deploys it), editing
   `.env` or `docker-compose.yaml` on the host. The bot serves real people.
5. **Never print or copy secrets**: `.env`, `.env.test`, `gcp-sa.json`.
6. **A new production env variable also goes into `.env.test` with an empty
   value** when the test instance must not use it: the test container inherits
   the production `.env`.
7. **Do not create `CLAUDE.md` or `CLAUDE.local.md`** here or in a parent
   directory; this file would stop being read.
8. **Kill only processes you started, by PID.** No `pkill -f`, no `killall`.
9. **Dependencies change only in the main checkout**, never in a worktree
   (their `node_modules` are links to it).

## Commands

| What | Command | Time |
|---|---|---|
| One offline test file | `pnpm test:offline <name>` (exact file name, or a substring) | 1–20 s |
| Cases matching a text | `pnpm test:offline <name> --grep "text"` | |
| Whole offline suite | `pnpm test:offline` (3 files at a time; `-j N`) | ~2 min |
| Type check | `pnpm typecheck` (`src`, `scripts`, `scripts-dom`, `webapp`; a name runs one) | ~12 s |
| Lint | `pnpm lint` | ~2 s |
| Dependency guard | `pnpm check-deps` (never writes; `--tighten` after fixing a baseline entry) | ~1 s |
| All three checks, working tree | `pnpm check` | ~15 s |
| Everything, on the committed tree | `pnpm verify` (required before pushing `master`) | ~3 min |
| Write-lock regression | `pnpm test:lock` | ~5 s |
| e2e against the test bot | `pnpm test:e2e:bot` (`:full`, `:tools`); ask first, one run at a time | minutes |
| Production data | `npx tsx scripts/prod-query.mts --tables` / `--schema T` / `"SELECT …"` | |
| Before a release | `pnpm deploy:check` (what ships, verified?, replies in progress) | ~3 s |
| After a release | `pnpm deploy:check --wait` (waits for the new build, shows the build log) | |

Offline test output: one line per file. The per-assertion log of every file is
in the directory printed at the end; a failing case prints its name, message
and `file:line`. `OFFLINE_VERBOSE=1` shows assertions when running one file
directly.

A test file ends when the work its cases started has ended, so an error thrown
after the last case still fails the file. A file that is still running 3 s
after its summary is ended and marked in the run output: run it with
`OFFLINE_DEBUG_HANDLES=1` to see which timer or server was left running, where
it was created and during which case.

## Working loop

- While editing: `pnpm check` and the test files you touched. Not the whole suite.
- Before pushing: commit, then `pnpm verify`. It tests a clean export of
  `HEAD`, so other sessions' uncommitted edits do not affect the result. The
  pre-push hook refuses a push to `master` whose tree has no passing record.
- A new test file is any `scripts/offline/<name>.mts`; the runner finds it.
  Nothing to register. Helpers go in `scripts/offline/support/`. A file that
  must not run with the suite says `// offline: manual` in its header.
- With a feature, write cases for its failure paths and for where it crosses
  existing features, not only the happy path.
- Tests never use a fixed port or a fixed path under `/tmp`: two suites run at
  the same time. Use `startStubServer()` (`support/stub-server.mts`) and a
  per-process temporary directory.
- A test ends what it starts before `reportResults`: close servers, clear
  intervals. A reply started with `createChatContext` goes through
  `trackReply()` and the file calls `endOpenReplies()` at the end
  (`fake-telegram.mts`). A fixture that needs a Bot API client the code must
  not use takes `createUnusedApi()`, never a bare `new Api(token)`, which
  would call Telegram.
- `src` reads most env variables at import. A test sets the env first and
  imports `src` afterwards with `await import(…)`.

## Layout

| Path | What lives there |
|---|---|
| `src/index.ts` | Entry: bot, panel server, startup repair |
| `src/db/` | Sequelize models and queries; `autoSave.ts` stores incoming messages |
| `src/reply/` | From a trigger to a delivered reply: context building, streaming, retries, `/pic` and `/vid` runners, reply tools |
| `src/ai/` | Model platforms (`platforms/`), routing, system prompt, tool declarations, usage, widgets |
| `src/telegram/` | Telegram delivery: edit coordinator (rate pacing), entities, link previews, widget API |
| `src/services/` | Everything that talks to something else: media cache, luoxu, ComfyUI, GCS, stickers, harness issues |
| `src/cmd/` | Slash commands |
| `src/panel/` | Hono API of the Mini App: auth, views, share pages, thinking pages, stats |
| `src/config/`, `src/shared/` | Config readers and small shared helpers (lowest layer) |
| `webapp/` | React + Vite Mini App (own package); `webapp/src/api/` talks to `src/panel` |
| `scripts/offline/` | Offline tests, `harness.mts`, `fake-telegram.mts`, `runner.mts` |
| `scripts/e2e/` | Tests that drive the real test bot |
| `scripts/deploy/` | Container start script, pm2 config, release checks, rehearsal |
| `scripts/lib/` | Shared by scripts: production queries, the dependency guard's rules |
| `scripts/guard/` | Host watchdog timers |
| `tools/checks/` | Check-only tools: TypeScript 7 for `pnpm typecheck`, oxlint |
| `tgs-converter/`, `widget-render/` | Sidecar containers |
| `docs/` | Design documents; git-ignored, present only in the main checkout |

Lower layers do not import upper ones, types included (`pnpm check-deps`
enforces it against a baseline): `shared`, `types`, `config`, `util.ts`,
`state.ts` → `db` → `services`, `telegram`, `ai`, `widget-image` → `reply`,
`cmd`, `panel` → `index.ts`. A new directory under `src/` gets a line in the
table in `scripts/lib/check-deps/layers.mts`.

## Conventions

- No `export default`. `index.ts` only re-exports. `===` only.
- No `as` casts unless there is no other way (`as const` is fine); the guard
  counts them per file and the count may not grow. After removing a cast or
  an upward import, run `pnpm check-deps --tighten` and commit the baseline
  with the fix.
- Prefer `ts-pattern` for branching on unions. Names are spelled out.
- Split a large function or component into smaller files.
- React: `useMemo` / `useCallback` where it matters; hook dependency lists
  complete (lint checks them).
- Comments: concise English, about why. Commit messages: `type(scope): what`.
- Type checking uses TypeScript 7 from `tools/checks`; the build uses the 5.x
  compiler of the root package. Do not make the build incremental: its cache
  would outlive a deleted `dist/` and nothing would be emitted.
- A major change starts with a design document in `docs/`, named
  `YYYY-MMDD-HHMM-<title>.md`, whose first paragraph is the goal from the
  user's point of view; the owner reviews it before implementation.

## Releasing

Production (`k-on-bot` container) fetches `origin/master`, builds and starts on
every container start, so the release is `docker compose restart k-on-bot`
(a commit that is not pushed does not ship). A change to `.env`, compose
labels or env needs `docker compose up -d k-on-bot` instead: `restart` does not
re-read them, and recreating costs about a minute. A change to the
`Dockerfile` (Node, pnpm or pm2 version) needs the image rebuilt as well:
`docker compose up -d --build k-on-bot`.

1. `pnpm verify`, push, then `pnpm deploy:check`. It must say READY: the
   restart kills the process, so wait while a reply is being generated.
2. Ask the owner, then restart.
3. `pnpm deploy:check --wait`. The `version` of `/api/health` is the commit
   the running build came from; if a build fails the previous build keeps
   running and this command says so.
4. After a live test in a chat, read what the model filed about its tools:
   `npx tsx scripts/prod-query.mts "SELECT id, kind, toolName, title FROM harness_issues WHERE status = 'open' ORDER BY id DESC LIMIT 10"`.

The test instance (`k-on-bot-test`, compose profile `test`) runs the working
tree of the main checkout with its own bot, `.env.test` and database; only one
session can use it at a time. A change to the start scripts (`build.sh`,
`scripts/deploy/`) is rehearsed with `bash scripts/deploy/rehearse.sh`, never on
production.

## Easy to forget

- A new tool is also registered in the Mini App tool groups
  (`webapp/src/tool-groups.ts`), or the panel cannot show or override it.
- A new dependency in `webapp/` ships with the updated `pnpm-lock.yaml`.
- One-off scripts live in `tmp/` (git-ignored) and are deleted after use.
