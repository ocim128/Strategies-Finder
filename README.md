# Strategies Finder

Strategies Finder is a Vite + TypeScript trading research playground for building, testing, comparing, and validating strategy ideas on chart data.

It combines:
- a browser UI assembled from HTML partials at runtime
- a TypeScript backtest engine with optional Rust acceleration
- a multi-source data pipeline with local caching
- research tools such as Finder, Exit Strategy Override, Walk Forward, Monte Carlo, Scanner, Data Mining, Rank Pairs, the Opportunity Explorer, and Batch Backtest
- optional Cloudflare Worker alerting and subscription execution

## What You Can Do Here
- Load market data from local SQLite, IndexedDB, bundled price files, or remote providers
- Run backtests with realistic execution settings and risk controls
- Switch between fixed, percent, Kelly, volatility-targeted, risk-parity, martingale, and Optimal f sizing models from the settings panel
- Compare strategies, inspect trades, and review backtest result diagnostics, including entry and exit timing quality
- Search parameter spaces with Finder, including random and genetic modes, and rank current-chart grid/random runs by Entry Score or Exit Score
- Run Batch Backtest across symbol-pair lists and compare survivor candidates across symbols, intervals, and execution settings
- Validate robustness with walk-forward analysis and latest-OOS checks
- Run Batch Backtest post-analysis with OPEN_SCORE USD Replay (a research-only diagnostic; see [`docs/mine-timing-validation-findings.md`](docs/mine-timing-validation-findings.md) for the validation status of removed surfaces)
- Build live or scheduled alert subscriptions through the Worker API
- Use Quick View to inspect backtest stats, trades, and per-trade diagnostics

Trade timing quality scores are descriptive diagnostics. Exit Score is measured on each strategy's own trades; it is not an isolated exit-rule benchmark.

## Quick Start

### Requirements
- Node.js 22.16.0 or newer (22.16.0 is the CI baseline; local SQLite uses `node:sqlite`)
- npm
- Windows PowerShell works well in this repo

### Install and Run
For this app checked out on its own (including hosted CI), use its committed
lockfile:

```bash
npm ci
npm run deps:check
npm run dev
```

When this directory is inside the `debug/playground` npm workspace, install
from that workspace root with `npm install --workspace=strategies-finder-wt-batch-findings --package-lock=true`,
then return here to run the app. Keep the parent workspace lockfile when changing
dependencies; this directory's lockfile serves standalone builds.
`npm run deps:check` fails if the installed direct dependencies violate the app's ranges,
including a TypeScript or Vite version inherited from the parent workspace.

Open the Vite URL shown in the terminal, usually `http://localhost:5173`.

### First Useful Smoke Check
1. Pick a symbol and timeframe.
2. Select a strategy from the dropdown.
3. Click `Run Backtest`.
4. Open `Trades`, `Results`, `Finder`, and `Walk Forward` to verify the feature panels loaded.
5. Open `Monte Carlo` after a backtest to inspect drawdown tails and ruin probability under reshuffled paths.

## Architecture Map

### Bootstrap and layout
- Entry: `index.ts`
- Bootstrap sequencer: `lib/app-bootstrap.ts`
- Runtime layout injection: `lib/layout-manager.ts`
- Runtime HTML source: `html-partials/*`
- Feature wiring: `lib/handlers/*`

### Data and runtime state
- Data manager: `lib/data-manager.ts`
- Data providers: `lib/dataProviders/*`
- Browser caches: `lib/candle-cache.ts`, IndexedDB paths
- Local SQLite API client: `lib/local-sqlite-api.ts`
- Versioned localStorage helper: `lib/persisted-json.ts`
- Shared runtime state: `lib/state.ts`
- State write surface: `lib/state-actions.ts`

### Strategy and backtest engine
- Strategies execute on one supplied OHLCV series. The retired secondary-symbol strategy runtime and helpers have been removed; synthetic-pair datasets still supply a single ratio series. Legacy `crossSymbolSecondary` settings are ignored.
- Strategy registry and loading: `strategyRegistry.ts`
- Built-in source of truth: `lib/strategies/lib/*`, with generated metadata/loaders/eager manifests under `lib/strategies/manifest*.ts`
- Browser built-in loading: summary metadata and per-key loaders from `lib/strategies/manifest-summary.ts` and `lib/strategies/manifest-loaders.ts`
- Worker/test eager built-in library: `lib/strategies/library.ts`
- Backtest orchestration/UI: `lib/backtest-service.ts`
- Backtest run feedback presenter: `lib/backtest-run-presenter.ts`
- TS engine: `lib/strategies/backtest/*`
- Rust engine client: `lib/rust-engine-client.ts`
- Optional Rust loopback service: `rust-engine/` (start with
  `set START_RUST_ENGINE=1 && run_playground.bat`)

### Chart and renderer layer
- Chart controller: `lib/chart-manager.ts`
- Results renderer: `lib/renderers/resultsRenderer.ts`
- Trades renderer: `lib/renderers/tradesRenderer.ts`

### Research tools
- Finder: `lib/finder-manager.ts`, `lib/finder/*` (server-side Symbol Universe in `lib/finder/server/*`; see [docs/finder-server-side.md](docs/finder-server-side.md))
- Walk Forward: `lib/walk-forward-service.ts`
- Monte Carlo: `lib/monte-carlo-service.ts`, `lib/strategies/monte-carlo/*`
  (see [Monte Carlo guide](docs/monte-carlo.md))
- Scanner: `lib/scanner/*`
- Data Mining: `lib/data-mining-manager.ts`, `lib/data-mining-dom.ts`
- Batch Backtest: `lib/batch-backtest/batch-backtest-service.ts` (browser orchestration), `lib/batch-backtest/batch-backtest-vite-plugin.ts` (server execution; see [docs/batch-backtest-server-side.md](docs/batch-backtest-server-side.md))

### Alerts / Worker
- Worker: `workers/entry-signal-worker.ts`
- API client: `lib/alert-service.ts`
- Worker docs: `workers/README.md`

## Architecture Flow

```mermaid
flowchart LR
    A[Remote Providers]
    B[Bundled price-data]
    C[IndexedDB Cache]
    D[SQLite API / local DB]

    A --> E[DataManager]
    B --> E
    C --> E
    D --> E

    E --> F[state.ts]
    F --> G[chart-manager]
    F --> H[backtest-service]

    H --> I[strategyRegistry + manifest metadata/loaders]
    I --> J[TS / Rust backtest engine]
    J --> K[resultsRenderer]
    J --> L[tradesRenderer]
    J --> G

    F --> M[Finder]
    F --> O[Walk Forward]
    M --> J
    O --> J
```

## How It Boots
1. `index.ts` delegates startup to `lib/app-bootstrap.ts`.
2. The bootstrap registry injects the runtime HTML layout from `html-partials/*`.
3. Strategy metadata is loaded, with built-in strategy code loaded on demand; then the chart layer and feature managers are initialized in dependency order.
4. Saved settings are restored and applied back into UI state and feature state.
5. Initial market data is loaded, after which reactive state updates drive chart, backtest, and renderer refreshes.

## UI Structure

This app is heavily id-driven.

The important rule is:
- markup lives in `html-partials/*`
- binding happens in `lib/handlers/*`, feature managers, and renderers
- required structural ids are defined in feature-local `*-dom.ts` modules next to their handlers, renderers, or services
- the smoke test `tests/feature-dom-contracts.spec.ts` imports every feature-local contract directly and fails if a required id disappears from the partials

If you rename a UI id, update the partial, the feature DOM contract, and the consuming code together.

## Data Flow and Caching

`DataManager` currently prefers:
1. local SQLite cache via Vite `/api/sqlite/*`
2. IndexedDB cache
3. bundled `price-data/*`
4. remote fetch from provider

This ordering matters because Finder, Scanner, and repeated backtests depend on fast warm-cache reads. The local stock catalog contains IBKR data only; TOP_MEAN requires an explicit pair list.

IBKR fallback loads prefer explicit imports and bundled CSVs before reading
persisted caches. See [Price data loading and persistence](docs/price-data.md)
for provider-specific precedence, live-candle persistence, and SQLite access.

### Server-Side Batch Backtest

The Batch Backtest tab runs its workload in the Vite dev-server (Node) process, so 1000+ IBKR 4H synthetic-pair runs stop OOM-ing the browser. The browser tab holds only rendered scalars and DOM rows; Node writes per-row analysis artifacts to temporary disk storage and loads linked pairs back per target during OPEN_SCORE USD Replay.

For large runs, start the dev server with extra heap:

```bash
NODE_OPTIONS=--max-old-space-size=16384 npm run dev
```

The same heap guidance applies to server-owned Finder runs. Finder Asset
Opportunity **Batch OOS Holdout** sweeps additionally run holdout iterations
in parallel across a bounded worker-thread pool sized from your cores and
RAM (~10 MB per symbol plus an estimated 64 MB signal-cache budget per worker
against 75% of system RAM, including the prepared closed-candle view reused
across holdouts).
`FINDER_ASSET_BATCH_WORKERS=1` forces the original sequential loop (rollback
lever); Rust-engine runs prefer at most 2 workers. Server-owned **Symbol
Universe** multi-strategy jobs parallelize the same way across selected
strategies (`FINDER_UNIVERSE_WORKERS=1` forces the sequential loop; Rust
preference caps the auto pool at 4). See
[docs/finder-server-side.md](docs/finder-server-side.md).

Reattach after a tab reload is automatic (2s poll). The last completed Batch output is restored from a compact local snapshot after reload, and Copy summary in server-side mode preserves B&H and OPEN_SCORE sections through scalar summary fields; see [docs/batch-backtest-server-side.md](docs/batch-backtest-server-side.md).

## Important Contracts

### Strategy registration is split
- UI and runtime loading use `strategyRegistry`
- Built-in source of truth is `lib/strategies/lib/*`, with generated metadata, loader, key, and eager manifest files under `lib/strategies/manifest*.ts`
- Browser UI listing uses `lib/strategies/manifest-summary.ts`; browser strategy execution loads code through `lib/strategies/manifest-loaders.ts`
- `lib/strategies/library.ts` uses the eager manifest and is what worker-side evaluation imports

If you add or rename a built-in strategy, run `npm run strategies:sync-manifest` or the strategy will not load consistently.

### Settings compatibility is real
- persisted JSON blobs now route through `lib/persisted-json.ts`, which supports schema/version envelopes while still reading legacy raw JSON payloads
- The JSON persistence helpers tolerate unavailable or policy-blocked browser
  storage: reads return their caller's fallback and writes return `false`.
  Storage access errors reach the optional `onError` callback.
- removed trade-filter settings may still appear in old saved payloads; ignore them instead of restoring behavior
- any new setting unsupported by Rust must be stripped in both:
  - `lib/backtest-service.ts`
  - `lib/finder-manager.ts`

### Time handling is broad
The code accepts unix seconds, unix milliseconds, ISO strings, and `BusinessDay` objects.

Reuse existing helpers instead of inventing new conversions:
- `timeKey`
- `timeToNumber`
- existing parse/normalize helpers in backtest and data utilities

### Execution realism matters
- percentage and ATR take-profit exits are capped at the configured target price once touched
- stop-loss exits can still fill worse at the bar open when price gaps through the stop
- `next_open` runs impose a 1-bar re-entry cooldown after a full `signal` exit, so same-bar re-entries are blocked and the earliest new entry is the next bar
- if you need tighter execution realism than OHLC can provide, validate with lower-timeframe or tick data

## Common Workflows

### Strategy authoring
Built-in strategy authoring has enough contract surface to deserve its own guide.

Use:
- [`docs/strategy-authoring.md`](docs/strategy-authoring.md) for the template, normalization rules, and common failure modes
- [`docs/synthetic-pairs.md`](docs/synthetic-pairs.md) for generating synthetic pair data (e.g. BNBPAXG) for backtest and Finder research
- [`docs/backtest-endpoint.md`](docs/backtest-endpoint.md) for local HTTP backtest usage, payload examples, and parity rules
- [`AGENTS.md`](AGENTS.md) for the operational checklist and validation habits

Endpoint note:
- the HTTP backtest endpoint intentionally uses one fixed sizing profile only: `$1000` per trade with `0.1%` commission
- the UI `Preview Endpoint` and `Copy Endpoint` actions are the preferred parity path because they reuse the exact latest UI backtest snapshot and upload the matching dataset

The short version:
1. Create `lib/strategies/lib/<strategy-key>.ts`.
2. Export a valid `Strategy`.
3. Run `npm run strategies:sync-manifest`.
4. Keep `normalizeParams(...)` aligned with `execute(...)`.
5. Run `npm run typecheck` and confirm the strategy appears in the UI.
6. To remove built-in strategies from disk, use `Library Tools` in the Settings tab. It can delete the current strategy or a pasted bulk list of keys, names, or filenames, archives each file to `archive/strategy/*`, and re-syncs the generated manifest files under `lib/strategies/` automatically.

Dev note:
- `npm run dev` ignores `lib/strategies/**` changes by default so Finder work is not interrupted while you author or edit strategies.
- After strategy edits, run `npm run strategies:sync-manifest` if needed and do a manual browser refresh when you are ready to load the new code.
- Set `WATCH_STRATEGIES=1` before starting Vite if you want live reload for `lib/strategies/**` again.

For strategy-idea generation via [`archive/prompt.txt`](archive/prompt.txt), keep the allowed helper surface aligned with real exported strategy-layer utilities. Favor low-complexity price, bar-geometry, crossover, pivot, and timeframe-alignment helpers before heavier transforms, and keep prompt-specific quality filters inside the prompt file rather than expanding the repo-level README.

### Check local data
One CLI research tool operates on the synced IBKR `30m` CSV tree (`price-data/ibkr/csv/30m/`):
- `npm run data:preflight` scans that tree for deterministic data defects (add `-- --json` for machine-readable output). Implementation: `lib/market-data/data-integrity-scan.ts`.

It is a descriptive diagnostic, not a trade signal.

### Change UI safely
1. Add or update markup in `html-partials/*`.
2. Add the required id to the matching feature-local `*-dom.ts` contract if it is structural.
3. Wire the feature through its typed DOM contract.
4. Run typecheck and the DOM-contract smoke test.

### Work on alerts / subscriptions
- Read `workers/README.md`
- Keep `workers/entry-signal-worker.ts` aligned with `lib/alert-service.ts`
- Add a worker migration for schema changes

## Troubleshooting

### UI looks stale after Vite HMR
This app has singleton managers and runtime-injected partials. If a panel or shortcut behaves inconsistently after hot reload, do a full page refresh before assuming the code is wrong.

### Data looks stale or inconsistent
The app prefers warm caches. If fresh remote data is not appearing, check the local SQLite and IndexedDB paths first before debugging the provider code.

### Rust engine never connects
Check the engine status indicator and the Rust sanitization path. Unsupported settings must be stripped in both `lib/backtest-service.ts` and `lib/finder-manager.ts`.

### UI ids suddenly break
Run:
```bash
npm run typecheck
..\..\..\node_modules\.bin\esno tests\feature-dom-contracts.spec.ts
```

## Validation Commands

Run from this directory.

```bash
npm run typecheck
npm run typecheck:tests
npm run test
npm run test:e2e
npm run validate:changes
```

`npm run test` uses a compact wrapper that discovers `tests/**/*.spec.ts`, excludes `tests/e2e.spec.ts`, prints one status line per spec, and writes full per-spec logs to `artifacts/test-logs/latest`. `artifacts/test-logs/latest/summary.json` contains the machine-readable summary for agent or tooling use.

Parallel runs start slow specs first using successful timings retained across
focused runs in `artifacts/test-logs/timings.json`. Every selected spec still
executes in its own process. `--runInBand` preserves discovery order. Use
`npm run test -- filter --list --json` to inspect selection without replacing
logs. Every filter must match, and unknown options fail early. See
[Testing for agent workflows](docs/testing.md) for selection, evidence, and
reliable async fixtures.

Log open/write failures are reported as `LOG ERROR` and optional `logError`
summary fields; they do not discard concurrent results or change test outcomes.

`npm run verify` runs typecheck, staged test typecheck, and the compact test suite.

`npm run validate:changes` maps the current Git changes to relevant guides, focused spec filters, and fixed checks, printing why each was selected:

```bash
npm run validate:changes                              # preview the plan (read-only)
npm run validate:changes -- --base origin/main        # add committed changes from the merge base with <ref>
npm run validate:changes -- --run                     # execute the planned checks sequentially
npm run --silent validate:changes -- --run --json     # one JSON object on stdout, then execute
```

Default scope is staged, unstaged, and untracked non-ignored files. `--base <ref>` is resolved locally (nothing is fetched; the ref need not be `origin/main`). The preview writes no files; `--run` stops at the first failing check, marks the rest as not run, preserves child output in `artifacts/validation-logs/latest/`, and reports node/npm/cargo versions with the results. Documentation-only changes select no code checks and say so; unclassified files fall back to the full JS checks and are reported by path; a stale routing filter is an error, never a silently clean plan. Changing a spec schedules both typechecks and that spec; changing nothing reports a no-op.

Windows note: PowerShell's `npm.ps1` can consume `--run`, `--json`, and `--base` as its own options and forward them through `npm_config_*` environment variables instead of argv. The command honors those forwarded values (explicit flags always win), and `npm.cmd run validate:changes -- --run` avoids the quirk entirely.

Keep the limits in mind: the routing table in `scripts/validation-map.ts` is manually maintained and advisory — it widens shared modules with extra rules instead of an import graph, cannot prove semantic impact (settings migrations, long/short parity, and regression coverage still require inspection per [AGENTS.md](AGENTS.md)), never replaces full CI/E2E/Rust policy, and cannot see changes under the `debug/playground/` workspace outside this Git root. Run one validation at a time: executions replace `artifacts/validation-logs/latest/` and focused specs share the runner's `artifacts/test-logs/latest/`.

GitHub Actions checks out this app at the repository root and installs from this
directory's `package-lock.json` with `npm ci`. Its jobs run `npm run ci`
(verification plus the production build and entry-bundle budget),
the Rust format/test/clippy checks under `rust-engine/`, and `npm run test:e2e`.
The full spec suite runs on Windows x64 with Node 22.16.0. Rust and browser
checks run on Linux.
Puppeteer installs the browser used by the smoke test, which uses a desktop
viewport and the app's built-in mock symbols to check data loading, symbol and
interval switching, configuration saving, and layout without live exchange
access. When working inside the larger `debug/playground/` workspace, also
update the workspace lockfile when changing dependencies.

Useful variants:
```bash
npm run test:verbose
npm run test:json
npm run test -- --runInBand
npm run test -- --jobs=4
npm run test -- backtesting-engine
npm run --silent test -- finder-engine.spec.ts --list --json
```

Useful extras:
```bash
..\..\..\node_modules\.bin\esno tests\feature-dom-contracts.spec.ts
```

## Specialized Project Docs

These are intentionally narrower than the repo itself:
- `docs/README.md`: maintained documentation index
- `AGENTS.md`: safe-change handbook for coding agents
- `docs/backtest-endpoint.md`: local backtest endpoint usage and request contract
- `docs/backtest-engines-typescript-rust.md`: TypeScript/Rust engine split, engine-selection rules, and wire contracts
- `docs/batch-backtest-server-side.md`: server-side Batch Backtest, artifact retention, OPEN_SCORE USD Replay, TOP_MEAN, and memory budget
- `docs/finder-server-side.md`: server-owned Finder Symbol Universe (one server job owns all strategies + OOS), heap budget, scalar-only wire contract, Stop scoped by run id, and tab-reload reattach via `/api/finder/status`
- `docs/trade-ledger.md`: archived trade-ledger formats and offline replay compatibility
- `docs/asset-opportunity-explorer.md`: descriptive heatmap over the Asset Opportunity holdout archive (routes, cell semantics, limits)
- `docs/rank-pairs.md`: Rank Pairs regime classification contract
- `docs/alpaca-ibkr-sync.md`: Alpaca-backed IBKR Data workflow, source guards, and aggregation
- `docs/synthetic-pairs.md`: synthetic pair generation and supported surfaces
- `docs/strategy-authoring.md`: built-in strategy authoring guide
- `docs/mine-timing-validation-findings.md`: historical negative findings behind the removal of Mine/selection diagnostic surfaces
- `workers/README.md`: Worker endpoints, cron behavior, D1 setup, Telegram
- `DEPLOY_TO_VERCEL.md`: deployment notes
