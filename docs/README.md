# Documentation Index

This directory is the maintained documentation set for Strategies Finder. Keep these files practical and tied to current code, tests, and config.

## Start Here

- [../README.md](../README.md) - repo overview, setup, architecture map, common workflows.
- [../AGENTS.md](../AGENTS.md) - operational checklist for AI coding agents and safe-change validation habits.

## Core Guides

- [strategy-authoring.md](strategy-authoring.md) - built-in strategy contract, examples, helper surface, prepared execution, cross-symbol and 1s Polymarket strategy rules.
- [backtest-endpoint.md](backtest-endpoint.md) - local HTTP endpoint request/response contract.
- [batch-backtest-server-side.md](batch-backtest-server-side.md) - Batch server runtime, Mine/Stability artifacts, miner acceleration, OPEN_SCORE USD Replay endpoint, and memory budget.
- [finder-server-side.md](finder-server-side.md) - server-owned Finder Symbol Universe (one server job owns all strategies + OOS), heap budget, scalar-only wire contract, Stop scoped by run id, and tab-reload reattach via `/api/finder/status`.
- [cross-symbol.md](cross-symbol.md) - secondary-symbol strategy runtime contract and support matrix.
- [synthetic-pairs.md](synthetic-pairs.md) - synthetic pair generation, supported surfaces, and state miner notes.
- [rank-pairs.md](rank-pairs.md) - Rank Pairs regime classification: anchored sampling, metrics, labels, thresholds, and copy contract.
- [path-dependent-exits.md](path-dependent-exits.md) - Risk Management path-exit modes and TypeScript/Rust compatibility.
- [polymarket.md](polymarket.md) - Polymarket charting, scoring, diagnostics, bridge export, and Execution Lab boundaries.
- [execution-lab-live-trading.md](execution-lab-live-trading.md) - live-trade executor boundary, env vars, order lifecycle, and safety rules.
- [mine-timing-validation-findings.md](mine-timing-validation-findings.md) - research findings (mostly negative) on Mine Timing, spread-quality metrics, OPEN_SCORE USD selection, and signal-event replay. Read this before re-introducing any removed diagnostic surface.

## Adjacent Docs

- [../workers/README.md](../workers/README.md) - Cloudflare Worker endpoints, D1 migrations, cron, and Telegram support.
- [../DEPLOY_TO_VERCEL.md](../DEPLOY_TO_VERCEL.md) - Vercel deployment and password protection.
- [../artifacts/batch-bench/README.md](../artifacts/batch-bench/README.md) - batch backtest benchmarking protocol and schema.

## Maintenance Rules

- Do not add implementation plans to `docs/`. Once work has shipped, fold current behavior into the relevant guide and delete the plan.
- Delete or archive speculative docs when their decisions are implemented, rejected, or superseded.
- Every technical claim should point to a real file, command, setting, route, or test.
- Prefer updating one durable guide over adding another shallow Markdown file.
- When a feature is removed, prune every doc that still describes it as live. Stale "this feature exists" docs are worse than no doc.
