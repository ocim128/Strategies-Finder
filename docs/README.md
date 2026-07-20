# Documentation Index

This directory is the maintained documentation set for Strategies Finder. Keep these files practical and tied to current code, tests, and config.

## Start Here

- [../README.md](../README.md) - repo overview, setup, architecture map, common workflows.
- [../AGENTS.md](../AGENTS.md) - operational checklist for AI coding agents and safe-change validation habits.

## Core Guides

- [strategy-authoring.md](strategy-authoring.md) - built-in strategy contract, examples, helper surface, prepared execution, cross-symbol and 1s Polymarket strategy rules.
- [backtest-endpoint.md](backtest-endpoint.md) - local HTTP endpoint request/response contract.
- [batch-backtest-server-side.md](batch-backtest-server-side.md) - Batch server runtime, Mine/Stability artifacts, miner acceleration, Portfolio Fit endpoint, and memory budget.
- [portfolio-fit-mining-implementation-plan.md](portfolio-fit-mining-implementation-plan.md) - Portfolio Fit Phase 0 resolutions (R1–R19) governing the shipped allocation engine, validation, and contracts.
- [max-active-validation-pair-list-generator-implementation-plan.md](max-active-validation-pair-list-generator-implementation-plan.md) - MAX_ACTIVE validation and Balanced Pair-List Generator (work in progress): Phase 0 research contract freeze, Phase 1 generator, Phase 2 Batch UI, Phase 3 OPEN_SCORE USD diagnostics.
- [cross-symbol.md](cross-symbol.md) - secondary-symbol strategy runtime contract and support matrix.
- [synthetic-pairs.md](synthetic-pairs.md) - synthetic pair generation, supported surfaces, and state miner notes.
- [rank-pairs.md](rank-pairs.md) - Rank Pairs regime classification: anchored sampling, metrics, labels, thresholds, and copy contract.
- [path-dependent-exits.md](path-dependent-exits.md) - Risk Management path-exit modes and TypeScript/Rust compatibility.
- [polymarket.md](polymarket.md) - Polymarket charting, scoring, diagnostics, bridge export, and Execution Lab boundaries.
- [execution-lab-live-trading.md](execution-lab-live-trading.md) - live-trade executor boundary, env vars, order lifecycle, and safety rules.

## Adjacent Docs

- [../workers/README.md](../workers/README.md) - Cloudflare Worker endpoints, D1 migrations, cron, and Telegram support.
- [../DEPLOY_TO_VERCEL.md](../DEPLOY_TO_VERCEL.md) - Vercel deployment and password protection.
- [../artifacts/batch-bench/README.md](../artifacts/batch-bench/README.md) - batch backtest benchmarking protocol and schema.

## Maintenance Rules

- Do not add implementation plans to `docs/` after work is shipped. Put current behavior in the relevant guide.
- Delete or archive speculative docs when their decisions are implemented, rejected, or superseded.
- Every technical claim should point to a real file, command, setting, route, or test.
- Prefer updating one durable guide over adding another shallow Markdown file.
