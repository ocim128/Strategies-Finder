# Agent Guide

Use this file as a short task router. Read the guide and tests for the feature you are changing; inspect its callers and current worktree before editing. Run **npm run validate:changes** to map the current Git changes to candidate guides and focused checks with reasons; it assists the routing below but cannot determine every semantic impact.

## Command execution: RTK required

- **RTK is the primary CLI for AI agents in this repo.** Run `rtk --version` at session start and execute shell commands through RTK. Commands elsewhere in this guide name the underlying operation; apply this wrapping rule when running them.
- Use supported filters: `rtk git status --short`, `rtk git diff`, `rtk git log -5 --oneline`, `rtk rg`, and `rtk tsc --noEmit`. On Windows use `rtk rg`, because `rtk grep` requires a separate `grep` binary.
- Use **`rtk proxy <command> [args...]`** for unsupported commands and output that must remain exact. This keeps RTK as the entry point while preserving output and tracking usage. Run this repo's custom checks as `rtk proxy npm.cmd run test -- <filter>` and `rtk proxy npm.cmd run validate:changes` (use `npm` on non-Windows systems). Also proxy JSON output, exact source reads, patch review, and failure logs; generic `rtk test` / `rtk summary` filters hide required details from these custom checks.
- For PowerShell cmdlets or scripts, proxy the explicit shell, for example `rtk proxy powershell -NoProfile -Command 'Get-Content AGENTS.md'`. Native file/edit tools do not need wrapping.
- If RTK is missing, install it or repair PATH using [RTK setup](docs/testing.md#rtk-as-the-primary-agent-cli). Do not silently fall back to a raw-command workflow; report a setup limitation if the environment prevents installation. Bootstrap commands needed to install or locate RTK are exempt.
- Filtering can omit information. Recover exact details with `rtk proxy` and inspect saved logs before diagnosing failures. Keep required checks and their pass/fail criteria intact.

## Before editing

1. Run **rtk git status --short** and preserve unrelated work.
2. Find the owning implementation, its nearest focused spec, and any generated or persisted contract it touches.
3. Read the matching row below. Read **README.md** for repo orientation; read **index.ts** and **lib/app-bootstrap.ts** when changing startup.
4. Keep the patch focused. State assumptions when they affect behavior, and report checks accurately.

## Route by change

| Change | Read first | Check |
| --- | --- | --- |
| UI structure or DOM ids | [UI Structure](README.md#ui-structure); the owning feature's local DOM contract and **html-partials/** | **npm run test -- feature-dom-contracts.spec.ts** |
| Built-in strategy | [Strategy Authoring](docs/strategy-authoring.md) | **npm run strategies:sync-manifest** after source changes; run **npm run test -- new-strategy-lib-smoke.spec.ts** |
| Backtest fills, exits, or TypeScript/Rust behavior | [Backtest engine guide](docs/backtest-engines-typescript-rust.md) | Focused backtest spec; check long/short and affected execution models |
| Finder | [Finder guide](docs/finder.md), [Finder server guide](docs/finder-server-side.md) | Focused **finder-*.spec.ts** tests |
| Batch Backtest or TOP_MEAN | [Batch server guide](docs/batch-backtest-server-side.md), [research findings](docs/mine-timing-validation-findings.md) | Focused **batch-*.spec.ts** or **sp500-top-mean-*.spec.ts** tests |
| Synthetic pairs or IBKR data | [Synthetic pairs](docs/synthetic-pairs.md), [Alpaca / IBKR sync](docs/alpaca-ibkr-sync.md) | Focused data or loader-parity spec |
| Settings or persistence | **lib/settings-manager.ts**, **lib/persisted-json.ts**, **tests/settings-compat.spec.ts** | Focused settings/persistence spec |
| Alerts or Worker API | **workers/README.md**, **lib/alert-service.ts**, **workers/entry-signal-worker.ts** | Focused Worker/alert spec |
| Other renderer, chart, Walk Forward, or Monte Carlo work | Owning **lib/** service/renderer/DOM contract and its focused spec | Focused feature spec |

## Contracts to preserve

- For structural UI changes, update the partial, matching feature-local DOM contract, and consumer together.
- Built-in strategy manifests are generated. Edit **lib/strategies/lib/** and run **npm run strategies:sync-manifest**; do not edit generated manifests by hand.
- Preserve saved-settings compatibility. Route JSON blobs through **lib/persisted-json.ts**; add a migration when a persisted shape changes. Settings unsupported by Rust may need matching sanitization in **lib/backtest-service.ts** and **lib/finder-manager.ts**.
- Reuse **timeKey**, **timeToNumber**, and existing normalization helpers for supported time shapes.
- For Finder and Batch server work, follow the feature guide for memory, route authorization, wire shape, cancellation, reattach, and browser/server parity. Keep Vite server-plugin imports out of browser-bound modules that pull in **lightweight-charts**.
- Do not reintroduce retired prediction, allocation, or timing-diagnostic surfaces documented in **docs/mine-timing-validation-findings.md**.

## Validation

- Read [Testing for agent workflows](docs/testing.md) when changing specs or the runner. Use **npm run test -- filter --list --json** to inspect selection without replacing logs. Parallel runs use successful timing history to start slow specs first; **--runInBand** preserves discovery order. Clear deadline timers and dispose test resources when operations settle.
- **npm run validate:changes** previews a validation plan for the current Git changes (staged, unstaged, untracked, or `--base <ref>`), listing the guides, focused spec filters, and fixed checks each routing rule selects, with the reason. Add `--run` to execute the selected checks sequentially — it stops at the first failure, preserves output in `artifacts/validation-logs/latest/`, and reports tool versions with results. `--json` prints one machine-readable report (use `npm run --silent validate:changes -- --json` so npm's banner stays off stdout).
- The routing table in `scripts/validation-map.ts` is manually maintained and advisory. Shared modules are widened by extra rules rather than an import graph, unclassified non-documentation files fall back to the full JS checks, and documentation-only changes select no code checks and say so. Selection never replaces the route table above, caller inspection, or the requirement to add semantic-impact tests; keep full CI, E2E, and Rust policy intact.
- **npm run typecheck** checks application TypeScript.
- **npm run test -- filter** (filename or path fragment) runs focused specs; for example, **npm run test -- feature-dom-contracts.spec.ts**.
- **npm run typecheck:tests** checks test TypeScript. **npm run verify** runs the broad typecheck and test suite.
- Use **npm run test:e2e** for end-to-end coverage when the change needs it.

## Workspace dependencies

Feature work installs dependencies from **debug/playground/**, whose lockfile is used by the npm workspace and CI. The lockfile in this directory is for the standalone Vercel deployment. Update the workspace lock when adding a dependency; update this directory's lock only when the Vercel build needs it. See [deployment instructions](DEPLOY_TO_VERCEL.md).

## Documentation

Update the feature guide that owns a changed behavior. Keep **README.md** broad, check relative links and file references, and use [docs/README.md](docs/README.md) to find maintained guides.
