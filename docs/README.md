# Documentation Index

This directory is the maintained documentation set for Strategies Finder. Keep these files practical and tied to current code, tests, and config.

## Start Here

- [../README.md](../README.md) - repo overview, setup, architecture map, common workflows.
- [../AGENTS.md](../AGENTS.md) - operational checklist for AI coding agents and safe-change validation habits.

## Core Guides

- [strategy-authoring.md](strategy-authoring.md) - built-in strategy contract, examples, helper surface, prepared execution, cross-symbol and 1s Polymarket strategy rules.
- [backtest-endpoint.md](backtest-endpoint.md) - local HTTP endpoint request/response contract.
- [backtest-engines-typescript-rust.md](backtest-engines-typescript-rust.md) - TypeScript/Rust engine split, engine-selection fences, capability handshake, and wire contracts.
- [batch-backtest-server-side.md](batch-backtest-server-side.md) - Batch server runtime, analysis artifacts, OPEN_SCORE USD Replay endpoint, S&P 500 TOP_MEAN coordinator, and memory budget.
- [finder-server-side.md](finder-server-side.md) - server-owned Finder Symbol Universe and Asset Opportunity jobs, parallel batch worker pool, JSONL run log, heap budget, scalar-only wire contract, Stop scoped by run id, and tab-reload reattach via `/api/finder/status`.
- [finder-asset-opportunity-resort-guide.md](finder-asset-opportunity-resort-guide.md) - how to add an Asset Opportunity Re-Sort metric end to end (browser control, archive contract, tests).
- [alpaca-ibkr-sync.md](alpaca-ibkr-sync.md) - Alpaca-backed IBKR Data downloads, source guards, credentials, 30m-to-4h aggregation, and the EDGAR market-cap download.
- [cross-symbol.md](cross-symbol.md) - secondary-symbol strategy runtime contract and support matrix.
- [synthetic-pairs.md](synthetic-pairs.md) - synthetic pair generation and supported surfaces.
- [rank-pairs.md](rank-pairs.md) - Rank Pairs regime classification: anchored sampling, metrics, labels, thresholds, and copy contract.
- [path-dependent-exits.md](path-dependent-exits.md) - Risk Management path-exit modes and TypeScript/Rust compatibility.
- [polymarket.md](polymarket.md) - Polymarket charting, scoring, diagnostics, bridge export, and Execution Lab boundaries.
- [execution-lab-live-trading.md](execution-lab-live-trading.md) - live-trade executor boundary, env vars, order lifecycle, and safety rules.

## Research Surfaces and Records

- [trade-ledger.md](trade-ledger.md) - Batch "Save trade ledger" export (v3): row schema, as-if outcomes, replay eligibility guard, and the offline checker.
- [trade-ledger-sweep.md](trade-ledger-sweep.md) - server-owned Ledger Rule Sweep tab: routes, load-once vs isolated-per-rule memory, archive contracts, and UI ids.
- [trade-gate.md](trade-gate.md) - Trade Gate Batch certification workflow, feature parity, counters, and certification records.
- [selection-rules.md](selection-rules.md) - pair-selection rule contract, diagnostics, measured scales, and the detailed selection view.
- [mine-timing-validation-findings.md](mine-timing-validation-findings.md) - historical research findings (mostly negative) on removed Mine/signal-event diagnostics, spread-quality metrics, and OPEN_SCORE USD selection. Read this before re-introducing any removed diagnostic surface.
- [pairlist-selection-research.md](pairlist-selection-research.md) - completed preregistered pool-selection research record; the registered candidate failed its adoption rule and the walk-forward machinery was retired.

## Historical Decision Records

- [rust-engine-complexity-audit.md](rust-engine-complexity-audit.md) - audit whose deletions landed: the Rust engine is a generic server-first kernel; explains why the specialized Asset Opportunity Rust paths were removed.
- [complexity-audit-finder-batch-ibkr-crypto-2026-08-27.md](complexity-audit-finder-batch-ibkr-crypto-2026-08-27.md) - point-in-time complexity audit driving the `chore/complexity-reduction` branch; some findings are already addressed.

## Adjacent Docs

- [../workers/README.md](../workers/README.md) - Cloudflare Worker endpoints, D1 migrations, cron, and Telegram support.
- [../DEPLOY_TO_VERCEL.md](../DEPLOY_TO_VERCEL.md) - Vercel deployment and password protection.
- [../artifacts/batch-bench/README.md](../artifacts/batch-bench/README.md) - batch backtest benchmarking protocol and schema.

## Maintenance Rules

- Do not add implementation plans to `docs/`. Once work has shipped, fold current behavior into the relevant guide and delete the plan.
- Delete or archive speculative docs when their decisions are implemented, rejected, or superseded. Keep a historical doc only when it carries a decision or negative result that must not be re-litigated, and mark it with a status banner.
- Every technical claim should point to a real file, command, setting, route, or test.
- Prefer updating one durable guide over adding another shallow Markdown file.
- When a feature is removed, prune every doc that still describes it as live. Stale "this feature exists" docs are worse than no doc.
