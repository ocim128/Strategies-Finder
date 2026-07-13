# Server-Side Finder Symbol Universe

The Finder **Symbol Universe** scope can run its heavy multi-symbol evaluation
either in the browser tab (the original path) or in the Vite dev-server (Node)
process. The server-side path exists because a universe run holds N full OHLCV
datasets (~5–10 MB each at the 100k-bar cap) in memory for the whole evaluation
loop (`lib/finder/finder-runner-universe.ts`). Large universes OOM a browser
tab; Node can use main RAM directly, and the browser tab keeps only the
rendered scalar survivor rows.

This mirrors the [Server-Side Batch Backtest](./batch-backtest-server-side.md)
architecture 1:1 (owner-lock, NDJSON stream, scalar-only wire) so the two
server-side paths read consistently. The key difference: **Finder Universe has
no Mine step**, so there is no artifact directory, no TTL, and no per-row
`data`/`signals`/`trades` strip — `FinderUniverseCandidate` is already
scalar by design. Tab-reload reattach (which Batch supports) is NOT yet wired
into the Finder browser path; see "Stop and reattach" below.

## Scope

Server-side mode applies to the **Symbol Universe** scope only. The
current-chart Finder always runs in-tab (it has a single dataset and is not
memory-pressured). Polymarket scoring is rejected by Universe mode regardless
of execution path.

## When to use server-side mode

Use **Server-Side** when:

- You run large symbol lists (≥400 symbols at the 100k-bar cap).
- You want the browser tab to stay responsive during a long universe sweep.
- You want the browser tab to stay responsive during a long universe sweep.
  (Note: tab-reload reattach is not yet supported; keep the tab open for the
  duration of a server-side run.)

Use **Browser-Tab** when:

- You are on `vite preview` (no dev server) or a built bundle. The manager
  auto-detects a 404/405 from `/api/finder/universe-run` and falls back to the
  in-tab path transparently.
- You are running small universes and want to skip the dev-server round-trip.

## Selecting the mode

`Settings → Backend Engine → Finder Universe Execution Mode`. Default is
**Server-Side**. The select is registered in
both DOM-contract systems (`BACKTEST_DOM_SETTING_IDS` and
`BACKTEST_SETTINGS_DOM_CONTRACTS`) with the case-sensitive
`finderUniverseExecutionMode` parser; do not switch it to the generic `string`
parser (which uppercases and breaks the `"server"` / `"browser"` values).

## Starting the dev server with extra heap

A universe run retains N full datasets plus prepared closed-candle data per
symbol on the dev server. The default V8 heap is too small for large
universes. Start the dev server with:

```bash
# macOS / Linux
NODE_OPTIONS=--max-old-space-size=16384 npm run dev

# Windows (cmd)
set NODE_OPTIONS=--max-old-space-size=16384 && npm run dev

# Windows (PowerShell)
$env:NODE_OPTIONS="--max-old-space-size=16384"; npm run dev
```

`run_playground.bat` sets `NODE_OPTIONS=--max-old-space-size=16384`
automatically unless you already supplied a `--max-old-space-size` value. If
you start Vite manually with the default heap, large server-side universe runs
(≥400 symbols) are rejected before they begin instead of crashing the dev
server (see `resolveFinderUniverseHeapWarning` in
`lib/finder/server/finder-server-heap-guard.ts`).

Heap floors: **8192 MB** for 400–799 symbols, **12288 MB** for 800+. These
match the Batch plugin's floors so a user who already runs Batch server-side at
the same heap has a consistent experience.

## What crosses the wire

Every streamed `candidate` event is **scalar-only**. `FinderUniverseCandidate`
and `FinderUniverseSymbolResult` are already scalar by design (metrics + status
+ light timing meta; no `data`, `signals`, `trades`, or `equityCurve`). The
server plugin calls `toScalarCandidate(...)` + `assertCandidateIsScalar(...)`
(`lib/finder/server/finder-stream-types.ts`) defensively so a future field
added to those types cannot accidentally ship an array over the wire and
re-pressurize the browser tab. The forbidden-array-field contract is locked by
`tests/finder-server-plugin.spec.ts`.

Stream events (consumed via `consumeNdjsonStream`, dispatched by `event.type`):

| event           | handler          | payload                                                        |
| --------------- | ---------------- | -------------------------------------------------------------- |
| `start`         | `onStart`        | `totalCandidates`, `totalSymbols`, `interval`, `strategyKey`   |
| `progress`      | `onProgress`     | `percent`, `text`, `status`                                    |
| `candidate`     | `onCandidate`    | `index`, `totalCandidates`, scalar `candidate`                 |
| `symbol_failed` | `onSymbolFailed` | `symbol`, `error`                                              |
| `done`          | `onDone`         | `ok`, `cancelled`, `totals`, `summary`, `diagnostics`, `cacheStats` |
| `fatal`         | `onFatal`        | `error`                                                        |

## What stays server-side

- The N full OHLCV datasets for the duration of the evaluation loop.
- The prepared closed-candle data per symbol.
- The candidate survivor heap (only scalar survivors are streamed).
- Terminal diagnostics are returned in `done.diagnostics` (same builder as the
  in-tab path, so Copy Diagnostics parity holds).

The server releases the datasets when the run ends. There is **no Mine
artifact directory and no TTL** — Universe has no Mine step, so the Batch
plugin's artifact-retention machinery is intentionally not copied here.

## Out-of-sample (OOS) validation

In v1, the server path runs the IS evaluation and returns the survivors; the
**browser** runs the OOS pass on the returned survivors. This works because
the OOS pass re-loads each symbol via `FinderManager.loadUniverseDataset`,
which hits the browser-side `universeDatasetCache` (datasets are fetched
client-side on demand). Running OOS server-side is a follow-up (the plan's D4
decision: the server already holds the datasets, so server-side OOS is cheaper
long-term, but the in-browser OOS reuse is correct and parity-identical for
now).

## Stop and reattach

- **Stop** (`POST /api/finder/stop`): the Finder Stop button force-bumps the
  server's owner lock and aborts in-flight dataset loads (the runner checks
  ownership loss per candidate). It also flips the browser-side `isCancelled`
  flag so the in-tab OOS pass on the returned survivors stops promptly. Stop
  leaves a partial survivor set that is still rendered.
- **Tab reload mid-run is NOT supported in v1.** The `GET /api/finder/status`
  endpoint exists (it snapshots in-progress run state + paginated accumulated
  candidates via `?after=`/`?limit=`), but the browser Finder has no consumer
  of it — there is no reattach poll on init (unlike Batch Backtest). A tab
  reload during a server-side universe run loses the in-flight run's live
  progress view; the run continues on the server to completion but the
  reloaded tab won't pick it up. Reattach is a documented follow-up; until it
  lands, keep the tab open for the duration of a server-side run. The status
  endpoint remains useful for ad-hoc `curl` introspection of in-flight state.

## Server-side import hygiene

`lib/finder/server/finder-vite-plugin.ts` is imported by `vite.config.ts`, so
anything it imports (transitively) ends up bundled by esbuild when Vite bundles
the config for the Node dev server. The server modules must NOT import from
`lib/finder-manager.ts`, `lib/data-manager.ts`, `lib/settings-manager.ts`,
`lib/ui-manager.ts`, or any module that transitively reaches `lib/constants.ts`
or `lib/chart-manager.ts` — both pull `lightweight-charts`, which is ESM-only
and fails the cjs config bundle.

The server loader (`lib/finder/server/server-finder-data-loader.ts`) reuses
`createBatchDatasetLoaderCore` from `lib/batch-backtest/batch-dataset-loader-core.ts`
so the synthetic-pair pipeline, `SyntheticLegCache` caps, and offline-first
gap-fill are identical to the Batch server path **by construction**. Drift
between the browser and server universe loaders is therefore impossible — both
route through the same core. This is locked by
`tests/finder-server-loader-parity.spec.ts`.

## Validation habit after server-side Finder changes

- `npm run typecheck`
- `..\..\..\node_modules\.bin\esno tests\finder-server-plugin.spec.ts`
- `..\..\..\node_modules\.bin\esno tests\finder-server-loader-parity.spec.ts`
- `..\..\..\node_modules\.bin\esno tests\finder-universe-runner.spec.ts`
- `..\..\..\node_modules\.bin\esno tests\feature-dom-contracts.spec.ts`
- `..\..\..\node_modules\.bin\esno tests\backtest-settings-id-parity.spec.ts`
- Manual smoke (server-side): start
  `NODE_OPTIONS=--max-old-space-size=16384 npm run dev`, run a 50-symbol
  universe in browser mode (regression) then server-side mode (parity), then a
  400-symbol universe in server-side mode (the goal). Confirm: progress
  streams, Stop works, Copy Diagnostics works, server/browser parity on survivors.
