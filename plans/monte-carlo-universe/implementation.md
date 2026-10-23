# Implementation checklist

Status: **not started**. Read [scope](README.md), then
[technical rules](technical-design.md). [validation.md](validation.md) defines
the acceptance examples. The checklist references those rules rather than
creating alternative versions.

## Working rules

Follow current AGENTS.md. Start with `rtk --version`, worktree inspection, and
`rtk proxy npm.cmd run validate:changes`. Preserve unrelated changes, use
CodeGraph/source verification, and read only the owning guides and callers.
Create/update a task handoff with
`rtk proxy npm.cmd run agent:bench -- handoff --task monte-carlo-universe`.
Use RTK for shell commands and run shared-log checks sequentially.

## File ownership

Five new files under `lib/monte-carlo/universe/` are enough for v1:

| File | Owns |
| --- | --- |
| `model.ts` | Request/replay/row/snapshot types, constants, validation, seeds, scalar summary/verdict helpers. No DOM or Node runtime imports. |
| `worker.ts` | Whole-run/detail tasks; Batch callback; calls existing MC API. |
| `server.ts` | Authorized routes, worker-entry resolution, ownership, state/progress, shutdown. |
| `store.ts` | Two-file journal/manifest storage, bounded replay/recovery, latest-result replacement. |
| `controller.ts` | Browser capture/run/stop/poll/reattach/detail state and feature preferences. |

Extend existing Monte Carlo service, renderer, DOM contract, partial, and CSS.
Do not add a separate API-client class, browser store, persistence interface,
generic transport, prepared-sample engine, or speculative extension points.
Plain functions and feature-local state suffice. If a later measured need
requires another boundary, explain it in the handoff.

## P1 - Fix and pin simulation semantics

- [ ] Verify current engine/position-builder callers against technical section 4.
- [ ] Correct 50/50 gross normalization; retain ordinary fee-inclusive sizing.
- [ ] Add generated-step/path/aggregate finite checks before statistics filtering
  and verdicts. Chart errors must not report successful infinite results.
- [ ] Narrow the existing MC input to its five used backtest fields; full chart
  results remain accepted. Add Universe source metadata without another engine.
- [ ] Define the allowlisted replay input using existing Trade/settings types.
  Fixed/percent summary and replay call the same API without candles.
- [ ] Implement model constants, validation, canonical keys, deterministic seed,
  eligibility, scalar projection, coverage, and sort helpers.
- [ ] Reject effective partial controls before admission and unexpected partial
  records before MC; preserve existing ordinary chart partial sizing.
- [ ] Pass the numerical examples and existing Monte Carlo regressions.

Exit: the audit cases have exact expected results and pass meaningful checks.

## P2 - Execute a captured universe

- [ ] Capture all strategy/confirmation/exit, capital, date, source/market, and
  interval settings after strategy selection settles. One capital field only.
- [ ] Add optional Batch asOfTimeSec with the specified default, preserving
  existing callers. Verify source context actually reaches the shared loader.
- [ ] Run Batch in the worker with TypeScript execution and result pruning.
  Preserve pair legs, execution-aware candles, and existing cache fences.
- [ ] Implement the non-rejecting callback/fatal-error rule from technical
  section 3. Commit each scalar row once; await backpressure and release arrays.
- [ ] Implement whole-run and detail task variants in the same worker entry.
  Reuse shared bundling and Finder task-worker lifecycle; test runnable CJS/JS
  and failed bundling, including raw-TS fallback.
- [ ] Pass runner parity, per-stage errors, shared-source, frozen-window, and
  callback-double-notification cases.

Exit: a mixed ordinary/ratio/50-50 fixture produces deterministic rows.

## P3 - Own, store, and recover the job

- [ ] Extend the existing checked owner adapter/token kind exactly as specified;
  audit competing Finder/Batch/TOP_MEAN admission. No independent lock system.
- [ ] Register Run/Status/Stop/Detail in one Vite plugin for dev and preview.
  Use existing authorization and request helpers.
- [ ] Implement idempotent Run, pending Stop, owner-generation guards, failure
  finalization, awaited worker disposal, and server/HMR cleanup.
- [ ] Implement manifest + journal, serialized parent commits, byte offsets,
  bounded replay, partial-tail recovery, and interrupted-run reconciliation.
- [ ] Keep latest terminal + active only; replace after readers release.
  Apply file byte limits; no time scheduler or global quota subsystem.
- [ ] Return one complete bounded scalar snapshot per status request.
- [ ] Pass route/owner/storage/failure tests; confirm imports stay Node-safe.

Exit: Stop, worker failure, browser disconnect, and process restart settle
correctly without duplicate rows or leaked ownership.

## P4 - Connect the screen

- [ ] Compose the Universe controller from the existing MC service. Separate
  chart revision from Universe run and detail-selection ownership.
- [ ] Add preferences + lastRunId using persisted-json, compatible defaults,
  pagehide flush, one-at-a-time polling, backoff, and reload recovery.
- [ ] Update scope containers, partial, required IDs, consumers, and styles
  together. No duplicate IDs; all nodes remain in the lazy root.
- [ ] Add the README controls, bootstrap-only behavior, captured-config preview,
  coverage/table, full-inventory sorting, and 100-row UI pagination.
- [ ] Reuse the detail renderer with the correct source label and legacy units.
  Abort/ignore stale detail responses; retain one detail at a time.
- [ ] Enable CSV/JSON export only from a terminal snapshot, over all rows.
- [ ] Handle a missing local backend without changing chart availability.
- [ ] Pass DOM, browser lifecycle, rendering/export, and real lazy-tab E2E checks.

Exit: the full user workflow works without an existing chart backtest.

## P5 - Validate and deliver

- [ ] Run the acceptance checks in validation.md and update validation-map
  routing for the new folder and shared semantic impact.
- [ ] Verify the 1,000-row status byte limit, sorting/export scope, file/record
  limits, bounded memory, and responsive Stop with local deterministic data.
- [ ] Complete required broad JS/build, E2E, and applicable Rust policy.
  Do not rerun passing checks on unchanged code without a reason.
- [ ] Update maintained Monte Carlo and synthetic-pair guides; update settings
  or server guides only where their contracts changed.
- [ ] Record actual files/versions/defaults, exact validation evidence, and any
  remaining limitations in the handoff. Retire the plan under docs policy.

Exit: every required acceptance item is resolved and evidence matches the
final worktree. No implementation work is completed by this planning task.
