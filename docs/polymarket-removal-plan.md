# Polymarket Removal Plan

Status: IMPLEMENTED on `chore/remove-polymarket` (worktree sibling `Strategies-Finder-rm-polymarket`). All code phases landed; Phase 5 (env/secret + local data deletion) remains a manual user action. Kept as the decision record per the docs Maintenance Rules.

This document is the implementation plan for removing every Polymarket-related surface from the codebase. It is based on a full dependency sweep of the working tree (grep over `lib/`, `scripts/`, `html-partials/`, `styles/`, `tests/`, `docs/`, plus `git ls-files`). No implementation code has been changed yet.

## 1. Scope and current state

"Polymarket" in this repo is not one feature — it is three subsystems plus threading through ~85 core files.

### 1.1 Polymarket-inherent subsystems (delete wholesale)

These exist only to chart, score, or trade Polymarket outcome markets. Verified: their markets/instruments are Polymarket YES/NO outcome tokens on BTCUSDT/XRPUSDT events; no non-Polymarket functionality was found in them.

| Subsystem | Files |
| --- | --- |
| Polymarket panel / direct charting | `html-partials/tab-polymarket.html`, `lib/polymarket-panel-service.ts`, `lib/polymarket-panel-dom.ts`, `styles/polymarket.css`, `styles/features/15-polymarket-panel.css`, `PM` nav button in `html-partials/header.html:103` |
| Execution Lab (paper + live trade) | entire `lib/execution-lab/` directory (18 files incl. `execution-lab-vite-plugin.ts`, `live-executor-adapter.ts`), `html-partials/tab-execution-lab.html`, `docs/execution-lab-live-trading.md`. Live fills go through the external side-repo executor (`EXECUTION_LAB_LIVE_EXECUTOR_PATH` in `.env`) |
| Second-market / 1s miner | entire `lib/second-market/` directory (16 files), `lib/second-market-vite-plugin.ts`, `scripts/second-market-miner.ts`. Data sources are `binance_1s` + `polymarket_clob_1s` / `polymarket_reference_1s` / `polymarket_gamma` (`lib/second-market/types.ts:14-19`); Binance 1s exists only as the signal feed for Polymarket outcomes |
| Polymarket leaf modules | all ~44 `lib/polymarket-*.ts` files, `lib/finder/finder-runner-polymarket.ts`, `lib/types/polymarket-outcomes.ts`, `lib/dataProviders/polymarket.ts`, `lib/local-sqlite-polymarket-api.ts`, `lib/polymarket-price-points-ingest.ts` |
| Dead strategy helpers | `lib/strategies/lib/polymarket-1s-helpers.ts` — **zero importers** in `lib/` (only `tests/polymarket-1s-helpers.spec.ts`); the `polymarket1sConfig` / `StrategyKind "polymarket-1s"` flag (`strategyRegistry.ts:52,463-476`, `scripts/strategy-manifest-generator.ts:192,306,336,355`, `lib/strategies/manifest-summary.ts:14`) is set by no strategy and is dead |
| Scripts | `scripts/polymarket-sync-outcomes.ts`, `scripts/polymarket-universe-integrity.ts`, `scripts/lib/polymarket-research.ts`, `scripts/export-latest-entry-signal.ts` (bridge export consumed by the side-repo bot), `scripts/second-market-miner.ts`; `package.json` scripts `poly:*`, `mine:1s*`, `signal:export` |
| Tests | ~40 specs: `tests/polymarket-*`, `tests/execution-lab-*`, `tests/second-market-*`, `tests/finder-polymarket.spec.ts`, `tests/quick-view-polymarket.spec.ts`, `tests/monte-carlo-polymarket.spec.ts`, `tests/local-sqlite-polymarket-api.spec.ts` |

Scale: `git ls-files | grep -icE "polymarket|second-market|execution-lab"` → **129 tracked files** in the wholesale-delete set.

### 1.2 Core files needing surgical edits (~85 files)

Every file below contains Polymarket references that must be stripped; the file itself stays. Drive the work with:

```sh
grep -ril polymarket --include="*.ts" --include="*.html" --include="*.css" \
  lib/ scripts/ html-partials/ styles/ tests/ *.ts *.json
```

Grouped by area (verified hit counts in parentheses where large):

- **Settings chain** — `lib/settings-model.ts` (import block at lines 13-21; ~20 `polymarket*` fields at lines 144-167; normalization at ~404-411), `lib/settings-manager.ts` (6), `lib/backtest-settings-resolver.ts` (80), `lib/backtest-settings-dom-contract.ts` (58 ids), `html-partials/tab-settings-section-execution.html` (the whole `data-section="polymarket"` block from line 89), `lib/strategy-panel-settings-registry.ts`, `lib/strategy-panel-tab-markup.ts`, `lib/rust-settings-sanitizer.ts` (28), `lib/backtest-service.ts` (56)
- **Backtest engine + results** — `lib/types/strategies.ts` (imports at 2-5; `Trade.exitReason` members `polymarket_take_profit`/`polymarket_stop_loss` at line 36; `Trade.polymarketOutcome` at 42; `BacktestResult.polymarketTradeSummary` at 176; ~20 `BacktestSettings.polymarket*` fields from line 420; `StrategyExecutionContext.polymarket1s`), `lib/strategies/backtest/backtest-engine.ts` (2), `lib/backtest-executor.ts`, `lib/backtest-result-analysis.ts`, `lib/backtest-diagnostic-output.ts`, `lib/renderers/tradesRenderer.ts`, `lib/exit-strategy-merge.ts`, `lib/confirmation-signal-filter.ts`
- **Backtest HTTP endpoint** — `lib/backtest-endpoint-contract.ts`, `lib/backtest-endpoint-settings.ts` (Polymarket allowlist entries at 14-18), `lib/backtest-endpoint-execution.ts` (`polymarketExitMode` split at line 18, `annotatePolymarket` threading at 31-83), `lib/backtest-endpoint-copy.ts`, `lib/backtest-endpoint-facade.ts`, `lib/backtest-endpoint-plugin.ts`
- **Finder** — `lib/finder-manager.ts` (102), `lib/types/finder.ts` (options at 135-152 incl. `polymarketScoringEnabled`/`polymarketRankMode`; `FinderResult.polymarketEval` at 200; diagnostics counters `polymarketEvaluation` at 745/762), `html-partials/tab-finder.html` (`finderPolymarketSection` from line 239), `lib/finder/finder-manager-dom.ts`, `lib/finder/finder-runner.ts` + `finder-runner-core.ts` + `finder-runner-shared.ts` + `finder-runner-single.ts` + `finder-runner-universe.ts`, `lib/finder/finder-engine.ts`, `lib/finder/finder-diagnostics.ts`, `lib/finder/finder-result-snapshot.ts`, `lib/finder/finder-strategy-quality.ts`, `lib/finder/finder-ui.ts`, `lib/finder/finder-asset-opportunity-runner.ts`, `lib/finder/finder-asset-candidate-execution.ts`, `lib/finder/constants.ts`, `lib/finder/server/finder-vite-plugin.ts`, `lib/finder/server/server-asset-is-search.ts`
- **Data provider + charting + search** — `lib/types/data-providers.ts:3` (`'polymarket'` union member), `lib/data/data-provider-router.ts:32-35` (auto-routing via `isPolymarketEventSymbol`), `lib/data/data-fetcher.ts` (18), `lib/data-manager.ts` (3), `lib/chart-manager.ts` (7), `lib/asset-search-service.ts` (18). `isPolymarketEventSymbol` lives in `lib/dataProviders/polymarket.ts` and is imported only by the router and `lib/polymarket-price-feed-utils.ts` — it is deleted with its module
- **Monte Carlo** — `lib/monte-carlo-service.ts` (51; second run source `"polymarket"` at line 27 with its own run button + readiness gating), `lib/monte-carlo-dom.ts` (12), `lib/monte-carlo-renderer.ts`, `lib/strategies/monte-carlo/{index,types,monte-carlo-engine}.ts`, `html-partials/tab-monte-carlo.html:73` (`mc-polymarket-stake-per-trade`)
- **Quick View** — `lib/quick-view.ts` (14; imports the `QuickViewPolymarket*` summary suite), `lib/quick-view/quick-view-service.ts`, `lib/quick-view/quick-view-renderer.ts`
- **Other surfaces** — `lib/walk-forward-service.ts` (2), `lib/scanner/scanner-engine.ts` (2), `lib/cross-symbol-runtime.ts` (1), `lib/data-mining-manager.ts` (10), `lib/ui-manager.ts` (1), `lib/handlers/ui-event-handlers.ts` (8; PM button branch), `lib/handlers/state-subscriptions.ts` + `state-subscriptions-dom.ts`, `lib/asset-search-service.ts`, `lib/vite-http-utils.ts`
- **Alerts** — the Cloudflare worker `workers/entry-signal-worker.ts` itself is **polymarket-free**. Only `lib/alert-worker-compat.ts:11-12` (display-name mapping case) and `lib/alert-subscription-utils.ts:33,56` (filter on `polymarket1sConfig`) need edits; the alert feature survives
- **Startup / build** — `lib/app-bootstrap.ts:321-322` (lazy feature registrations) and `lib/lazy-feature-init.ts:27-28` (tab → feature map), `vite.config.ts` (imports at 6/10/18; constants at 22-25; `configurePolymarketNodeDns` call at 53; `polymarketProxyPlugin` at 200-282, registered at 364; `secondMarketApiPlugin()` at 368; `executionLabVitePlugin()` at 369), `lib/local-sqlite-vite-plugin.ts` (Polymarket routes at lines 717, 789, 860, 915, 984 plus the CLOB history fetch helpers at 7-10/21/129-201), `lib/crypto-data/crypto-data-vite-plugin.ts`
- **Shared tests to update (not delete)** — `tests/feature-dom-contracts.spec.ts` (imports `POLYMARKET_PANEL_REQUIRED_IDS` at line 12, contract entry at 87), `tests/settings-compat.spec.ts`, `tests/backtesting-engine.spec.ts`, `tests/backtest-endpoint-*.spec.ts`, `tests/backtest-result-analysis.spec.ts`, `tests/backtest-edge-analysis.spec.ts`, `tests/backtest-executor-{cancellation,timings}.spec.ts`, `tests/backtest-diagnostic-output.spec.ts`, `tests/rust-engine-client.spec.ts`, `tests/sqlite-query-plan.spec.ts`, `tests/finder-{date-range,diagnostics,engine,exit-alpha,manager-logic}.spec.ts`, `tests/strategies-lib/prepared-execution-parity.spec.ts`, `tests/strategy-panel-settings-registry.spec.ts`, `tests/worker-strategy-support.spec.ts:14`, `tests/ph-lin-typescript-regression.spec.ts`

## 2. Assumptions and unknowns

1. **Execution Lab and second-market are in scope.** Both are Polymarket-only (verified by reading their models/data sources). If any part of them should survive, this plan changes materially — confirm before starting.
2. **No localStorage/settings migration is required** (repo convention per `AGENTS.md`: removed settings in old saved payloads are ignored). Stale browser keys (`executionLabSettings` from `lib/execution-lab/execution-lab-model.ts:19`, `sqlite-polymarket` availability flag from `lib/local-sqlite-polymarket-api.ts:13`, polymarket fields inside the settings blob) become inert.
3. **Persisted data provider value `'polymarket'`**: `DataProviderRouter.getProvider` computes providers at runtime, but any persisted state that names `'polymarket'` must fall back to the default Binance provider rather than crash. Verify the chart/data-manager load path during implementation; add a fallback if one is missing.
4. **Rust engine**: the TS side already strips polymarket settings before sending (`lib/rust-settings-sanitizer.ts`), so the Rust binary never receives them today. Unknown: whether the Rust crate has polymarket-specific capability code. Verify by running one backtest with the Rust engine enabled after removal; if the handshake/capability list mentions polymarket, extend the sanitizer cleanup accordingly.
5. **Database**: `price-data/market-data.sqlite` contains `polymarket_outcomes` and `polymarket_price_points` tables; `price-data/1second-chart/second-market-data.sqlite` is the second-market DB (`SECOND_MARKET_DB_RELATIVE_PATH`, `lib/second-market/types.ts:8`). Dropping tables/dirs is optional cleanup, not required for correctness.
6. **`smoke-ledger-window/` is git-tracked** (ledger.jsonl / provenance.json / signal-ranks.jsonl from a paper-trade smoke). It is Execution Lab data and should be `git rm`'d with Phase 1, or kept deliberately as history — decide at implementation time.
7. The side-repo bot (`Polymarket-crypto-5min-arbitrage-bot`) is outside this repo and unaffected; `signal:export` is its only feed and dies here.

## 3. Non-goals

- No refactor of the settings system, backtest engine semantics, Finder core, Batch/OPEN_SCORE, IBKR, or market-cap surfaces — only polymarket branches/fields are removed.
- No renaming of surviving settings keys; no schema version bumps.
- The alert worker, walk-forward, scanner, cross-symbol runtime, and Rust engine keep their current behavior.

## 4. Implementation phases

### Phase 0 — Baseline and branch

**Objective:** a provable before/after state.

**Tasks**
- Cut `chore/remove-polymarket` from the current branch.
- Run and record baseline results: `npm run typecheck`, `npm run typecheck:tests`, full test suite (`npm run test`). Note: `npm run` is broken in this environment (EDUPLICATEWORKSPACE) — use direct binaries (`..\..\..\node_modules\.bin\esno tests/<spec>.spec.ts`, direct `tsc`) per existing practice.
- Capture the reference inventory: `git ls-files | grep -iE "polymarket|second-market|execution-lab"` (expect 129) and the surgical-edit grep from §1.2.

**Dependencies:** none. **Deliverables:** branch + baseline artifacts. **Exit criteria:** baseline recorded; inventory numbers match this document (or this doc is updated to match reality).

### Phase 1 — Wholesale deletions

**Objective:** remove the three subsystems, leaf modules, scripts, partials, styles, and their specs in one commit. The build is expected to be red after this phase; that is fine.

**Tasks**
- `git rm` the files in §1.1 (three subsystems, ~44 leaf modules, `finder-runner-polymarket.ts`, `types/polymarket-outcomes.ts`, `dataProviders/polymarket.ts`, `local-sqlite-polymarket-api.ts`, dead helpers, docs `polymarket.md` + `execution-lab-live-trading.md`, scripts, ~40 specs, `styles/polymarket.css`, `styles/features/15-polymarket-panel.css`, `smoke-ledger-window/` if approved).
- Remove the `@import './features/15-polymarket-panel.css'` line from `styles/features.css:14`.
- Remove `poly:*`, `mine:1s*`, `signal:export` scripts from `package.json`.

**Dependencies:** Phase 0. **Risks:** a needed file gets caught in the bulk pattern — mitigate by reviewing `git ls-files | grep -iE ...` output line by line before committing (e.g. `tests/second-market-trades-renderer.spec.ts` goes, but `lib/renderers/tradesRenderer.ts` stays).

**Deliverables:** one commit "Remove polymarket subsystems (files)". **Validation:** `git status` shows only deletions plus the two small edits. **Exit criteria:** nothing outside §1.1 was deleted.

### Phase 2 — Surgical core edits

**Objective:** strip every remaining polymarket reference from core files, area by area, one commit per area so regressions are bisectable. After each area: typecheck must pass before the commit.

**Dependencies:** Phase 1 (imports must be gone before call sites are edited — typecheck drives discovery).

**Tasks, in recommended order:**

1. **Startup/build first** (unblocks the dev server): `vite.config.ts` (plugin registrations, proxy plugin, DNS init, imports), `lib/app-bootstrap.ts`, `lib/lazy-feature-init.ts`, `lib/local-sqlite-vite-plugin.ts` (five routes + CLOB fetch helpers), `lib/crypto-data/crypto-data-vite-plugin.ts`. Verify: `npm run dev` starts (a dangling import here fails the esbuild config bundle with the known `lightweight-charts` ESM error — AGENTS.md "Server-side import hygiene").
2. **Settings chain**: remove the ~20 fields from `lib/settings-model.ts` (type + normalization + imports), mirror through `lib/backtest-settings-resolver.ts` (check `applyDerivedBacktestSettingGuards`), delete the 58 DOM contract ids in `lib/backtest-settings-dom-contract.ts` **together with** the `data-section="polymarket"` block in `tab-settings-section-execution.html`, then `lib/backtest-service.ts`, `lib/rust-settings-sanitizer.ts`, `lib/strategy-panel-settings-registry.ts`, `lib/strategy-panel-tab-markup.ts`, `lib/handlers/state-subscriptions*.ts`. Verify: `esno tests/feature-dom-contracts.spec.ts` + `tests/settings-compat.spec.ts`.
3. **Types + engine + results**: `lib/types/strategies.ts` (exitReason members, `polymarketOutcome`, `polymarketTradeSummary`, `polymarket1s` execution context, `BacktestSettings` fields), then the compiler walks you through `backtest-engine.ts`, `backtest-executor.ts`, `backtest-result-analysis.ts`, `backtest-diagnostic-output.ts`, `tradesRenderer.ts`, `exit-strategy-merge.ts`, `confirmation-signal-filter.ts`. Validate a plain long backtest still runs (see Phase 4 validation; `Trade.exitReason` narrowing is behavior-relevant — the remaining members are unchanged).
4. **Backtest endpoint**: `backtest-endpoint-settings.ts` allowlist, `backtest-endpoint-execution.ts` (`polymarketExitMode` destructure, `annotatePolymarket`), contract/copy/facade/plugin. Validate `tests/backtest-endpoint-*.spec.ts`.
5. **Finder**: `lib/types/finder.ts` fields, `tab-finder.html` section, `finder-manager-dom.ts` ids, then all `lib/finder/*` branches (scoring gate `polymarketScoringEnabled`, `polymarketEval` result fields, diagnostics counters, `finder-runner-polymarket.ts` call sites). Universe/Asset Opportunity server paths: keep behavior byte-identical for non-polymarket runs — those branches were gated and must simply disappear. Validate `tests/finder-*.spec.ts` survivors.
6. **Data provider**: remove `'polymarket'` from the `DataProvider` union, the router branch (`data-provider-router.ts:32-35`), `data-fetcher.ts`, `data-manager.ts`, `chart-manager.ts`, `asset-search-service.ts` polymarket sources. Add the fallback for persisted `'polymarket'` provider values if the load path lacks one (assumption 3).
7. **Monte Carlo + Quick View**: remove the `"polymarket"` run source in `monte-carlo-service.ts`, DOM entries in `monte-carlo-dom.ts` + `tab-monte-carlo.html`, engine/type plumbing in `lib/strategies/monte-carlo/*`; remove the `QuickViewPolymarket*` summaries from `quick-view.ts` + `lib/quick-view/*`. Validate `tests/monte-carlo-*.spec.ts` survivors (non-polymarket scenarios unchanged).
8. **Other surfaces**: walk-forward, scanner, cross-symbol-runtime, data-mining-manager, ui-manager, `ui-event-handlers.ts` (PM button branch + `header.html:103` button), `vite-http-utils.ts`, `alert-worker-compat.ts`, `alert-subscription-utils.ts`. Validate `tests/worker-strategy-support.spec.ts` (its polymarket1s filter line becomes trivial) and alert specs.
9. **Manifest/registry**: delete `StrategyKind "polymarket-1s"` + `polymarket1sConfig` from `strategyRegistry.ts`, `scripts/strategy-manifest-generator.ts`, `lib/strategies/manifest-summary.ts`, then run `npm run strategies:sync-manifest` (or the direct esno equivalent) and commit the regenerated `lib/strategies/manifest-*.ts`.

**Risks / blockers:** ~85 files means missed references are likely — the grep-to-zero gate in Phase 4 is the safety net, not eyeballing. The DOM-contract pairing rule (id removed from partial and contract in the same commit) is the repo's known failure mode — never split them. The settings DOM contract is the single source for `BACKTEST_DOM_SETTING_IDS`; partial removal silently drops ids ("DOM checked, settings false" failure mode in AGENTS.md).

**Deliverables:** 8-9 commits, one per numbered task. **Exit criteria:** typecheck + `typecheck:tests` green after every commit; the grep from §1.2 returns only docs hits.

### Phase 3 — Shared-spec and documentation cleanup

**Objective:** tests and docs describe the post-removal system.

**Tasks**
- Update the shared tests listed in §1.2 (remove polymarket cases/expectations; keep every non-polymarket assertion intact).
- Update `AGENTS.md` (Polymarket sections: Modify Polymarket scoring, Modify Execution Lab, validation habits, failure modes; `scripts/export-latest-entry-signal.ts` mention in the settings section) and `README.md`.
- Update remaining docs that mention polymarket: `docs/README.md` (remove the two index entries), `docs/backtest-endpoint.md`, `docs/backtest-engines-typescript-rust.md`, `docs/cross-symbol.md`, `docs/finder.md`, `docs/finder-server-side.md`, `docs/path-dependent-exits.md`, `docs/strategy-authoring.md`, `docs/synthetic-pairs.md`.
- Add this plan's outcome note (see Rollback section) if any decision changed during implementation.

**Dependencies:** Phase 2. **Deliverables:** one docs/tests commit. **Validation:** relative links resolve; backticked paths exist (repo documentation standard). **Exit criteria:** `grep -ril polymarket docs/ AGENTS.md README.md` returns only this plan document (which records the removal).

### Phase 4 — Verification

**Objective:** prove the system works without polymarket.

**Validation**
- `npm run typecheck`, `npm run typecheck:tests` (direct binaries if npm is still broken).
- Full suite: `npm run test` (or per-spec esno); confirm the suite no longer references deleted specs.
- Grep-to-zero gate: the §1.2 grep over `lib/ scripts/ html-partials/ styles/ tests/ *.ts *.json` must return nothing (excluding artifacts).
- Manual smoke (`NODE_OPTIONS=--max-old-space-size=16384 npm run dev`): dev server starts; every tab renders; symbol search, a plain chart backtest (long + short, `signal_close` + `next_open`), Finder current-chart run, and a small Batch run all behave as before; no console errors; no 404s from `/api/*`.

**Exit criteria:** all green; grep-to-zero; smoke checklist passed.

### Phase 5 — Data and secrets cleanup (user actions, destructive — do last)

**Objective:** remove local polymarket data and credentials once the removal is accepted.

**Tasks (each requires explicit user approval; none are reversible)**
- `.env` / `.env.example`: delete `POLYMARKET_PRIVATE_KEY`, `POLYMARKET_PROXY_ADDRESS`, `EXECUTION_LAB_LIVE_EXECUTOR_PATH` lines. **Security:** the key in `.env` is a real wallet private key stored in plaintext (file is gitignored, so it never entered git history). Treat it as exposed regardless — empty or rotate that wallet.
- Optionally `DROP TABLE polymarket_outcomes; DROP TABLE polymarket_price_points;` in `price-data/market-data.sqlite` and delete `price-data/1second-chart/` (gitignored data).
- Optionally clear stale browser localStorage keys (`executionLabSettings`, `sqlite-polymarket`, polymarket fields inside the settings blob).

**Exit criteria:** no polymarket credentials on disk; leftover data removed or consciously kept.

## 5. Technical reference

**Data flow being removed** (for orientation while editing): settings UI (`tab-settings-section-execution.html`) → `settings-manager.ts` blob → `backtest-settings-resolver.ts` guards → `backtest-service.ts` → TS engine polymarket branches / `rust-settings-sanitizer.ts` (strip before send) / HTTP endpoint (`backtest-endpoint-*`); Finder: `tab-finder.html` → `finder-manager.ts` options (`types/finder.ts:135-152`) → `finder-runner-polymarket.ts` scoring → `FinderResult.polymarketEval` → diagnostics; price data: Polymarket CLOB/gamma APIs → `vite.config.ts` proxy + `local-sqlite-vite-plugin.ts` routes → `polymarket_outcomes`/`polymarket_price_points` tables → `local-sqlite-polymarket-api.ts` / signal-exit evaluator; live trade: browser → `execution-lab-vite-plugin.ts` → side-repo executor binary (env-configured path).

**Contracts that must keep working:** `BACKTEST_SETTINGS_DOM_CONTRACTS` ↔ HTML partials ↔ `feature-dom-contracts.spec.ts` (single-source settings ids); `strategyRegistry`/manifest sync (run `strategies:sync-manifest` after generator edits); scalar-only wire contracts for Batch/Finder server routes (untouched — polymarket was already unsupported in Universe mode); Rust fallback compatibility (assumption 4).

**Database/schema changes:** none required in code. Optional table drops in Phase 5. `localStorage` blobs tolerate missing fields by convention (no version bump).

**Performance:** removal only; polymarket branches were settings-gated, so non-polymarket run behavior and performance are unchanged. Finder/Batch hot paths must not gain work — deleting branches cannot add any, so no benchmarking is needed beyond the existing suite.

**Error handling:** the only new behavior is the persisted-`'polymarket'`-provider fallback (assumption 3). Everything else is deletion of gated code.

**Rollback:** the entire effort lives on `chore/remove-polymarket` as a linear series of per-area commits off a known-good baseline — abandon the branch or `git revert` the range to roll back. Phase 5 data/secret actions are the only irreversible steps and are deferred until the code removal is accepted; skipping them leaves inert data only. The pre-removal state also remains reachable via git history regardless.
