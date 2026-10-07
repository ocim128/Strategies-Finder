# Documentation Index

This directory is the maintained documentation set for Strategies Finder. Keep these files practical and tied to current code, tests, and config.

## Start Here

- [../README.md](../README.md) - repo overview, setup, architecture map, common workflows.
- [../AGENTS.md](../AGENTS.md) - operational checklist for AI coding agents and safe-change validation habits.

## Core Guides

- [testing.md](testing.md) - focused spec selection, parallel scheduling, machine-readable evidence, and deterministic test helpers for agent workflows.
- [settings.md](settings.md) - Settings layout, search, live summaries, autosave feedback, and named configuration restore.
- [monte-carlo.md](monte-carlo.md) - chart backtest resampling, simulation controls, lazy tab layout, and regression checks.

- [strategy-authoring.md](strategy-authoring.md) - built-in strategy contract, examples, helper surface, and prepared execution.
- [backtest-endpoint.md](backtest-endpoint.md) - local HTTP endpoint request/response contract.
- [backtest-engines-typescript-rust.md](backtest-engines-typescript-rust.md) - TypeScript/Rust engine split, engine-selection fences, capability handshake, and wire contracts.
- [batch-backtest-server-side.md](batch-backtest-server-side.md) - Batch server runtime, analysis artifacts, OPEN_SCORE USD Replay endpoint, TOP_MEAN coordinator, and memory budget.
- [finder.md](finder.md) - Finder menu scopes, settings, ranking and Re-Sort invariants, server lifecycle, data contracts, and safe-change checklist.
- [finder-server-side.md](finder-server-side.md) - server-owned Finder Symbol Universe and Asset Opportunity jobs, parallel batch worker pool, JSONL run log, heap budget, scalar-only wire contract, Stop scoped by run id, and tab-reload reattach via `/api/finder/status`.
- [finder-asset-opportunity-resort-guide.md](finder-asset-opportunity-resort-guide.md) - how to add an Asset Opportunity Re-Sort metric end to end (browser control, archive contract, tests).
- [alpaca-ibkr-sync.md](alpaca-ibkr-sync.md) - Alpaca-backed IBKR Data downloads, source guards, credentials, 30m-to-4h aggregation, and the EDGAR market-cap download.
- [marketcap-download.md](marketcap-download.md) - design reference for the shipped EDGAR MarketCap download: route, service wiring, fetcher, and the split-factor invariant.
- [price-data.md](price-data.md) - shared price-data source selection, stream persistence, body deadlines, SQLite authorization, and crypto CSV tail loading.
- [pairlist-pools.md](pairlist-pools.md) - committed, hash-locked pair-list pools for S&P-500 TOP_MEAN campaigns: registry schema, generation scripts, archive stamping, and the integrity test.
- [synthetic-pairs.md](synthetic-pairs.md) - synthetic pair generation and supported surfaces.
- [rank-pairs.md](rank-pairs.md) - Rank Pairs regime classification: anchored sampling, metrics, labels, thresholds, and copy contract.

## Research Surfaces and Records

- [trade-ledger.md](trade-ledger.md) - Archived trade-ledger formats, replay eligibility, and offline checker compatibility.
- [asset-opportunity-explorer.md](asset-opportunity-explorer.md) - descriptive heatmap over the Asset Opportunity holdout archive: routes, cell semantics, coverage reporting, and limits.
- [mine-timing-validation-findings.md](mine-timing-validation-findings.md) - historical research findings (mostly negative) on removed Mine/signal-event diagnostics, spread-quality metrics, and OPEN_SCORE USD selection. Read this before re-introducing any removed diagnostic surface.
- [pairlist-selection-research.md](pairlist-selection-research.md) - completed preregistered pool-selection research record; the registered candidate failed its adoption rule and the walk-forward machinery was retired.

## Records and Audits

- [Finder causal arm definitions](finder.md#additional-causal-score-definitions) - coverage, stable support, fresh support, price strength and graph strength; execution and recovery are in [the server guide](finder-server-side.md#additional-causal-arms-execution-and-recovery).

- [maintenance-log.md](maintenance-log.md) - concise log of completed repository maintenance improvements, evidence, checks, and follow-ups.
- [asset-opportunity-time-filter-audit.md](asset-opportunity-time-filter-audit.md) - negative-result audit: why the large Entry Time Filter improvement was untrustworthy evidence, with the correction and rerun protocol.
- [open-score-cap-tilt.md](open-score-cap-tilt.md) - implemented cap-tilt weight design record; the TOP_MEAN coordinator's import-hygiene rule cites this file.
- [finder-arm-performance plan records](finder-arm-performance-plan.md) - retired delivery plan and the optimization chain built on it (allocation, redundant work, worker reuse, replay efficiency); each file's status banner records implemented, deferred, and measured-rejected phases. Current behavior lives in [Finder behavior](finder.md#arm-performance).

- [complexity-audit-finder-batch-ibkr-crypto-2026-08-27.md](complexity-audit-finder-batch-ibkr-crypto-2026-08-27.md) - point-in-time complexity audit driving the `chore/complexity-reduction` branch; some findings are already addressed.

- [rust-engine-complexity-audit.md](rust-engine-complexity-audit.md) - audit whose deletions landed: the Rust engine is a generic server-first kernel; explains why the specialized Asset Opportunity Rust paths were removed.

## Adjacent Docs


- [../workers/README.md](../workers/README.md) - Cloudflare Worker endpoints, D1 migrations, cron, and Telegram support.
- [../DEPLOY_TO_VERCEL.md](../DEPLOY_TO_VERCEL.md) - Vercel deployment and password protection.
- [../artifacts/batch-bench/README.md](../artifacts/batch-bench/README.md) - batch backtest benchmarking protocol and schema.

## Maintenance Rules

- Do not add implementation plans to `docs/`. Once work has shipped, fold current behavior into the relevant guide and delete the plan.
- Delete or archive speculative docs when their decisions are implemented, rejected, or superseded. Keep a historical doc only when it carries a decision or negative result that must not be re-litigated, and mark it with a status banner.
- Every technical claim should point to a real file, command, setting, route, or test.
- Prefer citing symbols (exported names) over line numbers; line pins rot on every edit. When a number is load-bearing, name the constant instead.
- Prefer updating one durable guide over adding another shallow Markdown file.
- When a feature is removed, prune every doc that still describes it as live. Stale "this feature exists" docs are worse than no doc.
