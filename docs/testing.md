# Testing for agent workflows

The runner is [scripts/run-tests.ts](../scripts/run-tests.ts). Specs use
`node:test` or standalone assertions and run in separate Node processes so
globals, module caches, and mocks cannot leak between files. Browser specs
(`*.browser.spec.ts`) are bundled with esbuild before execution. E2E is a
separate command.

## Select checks before running them

Start with `npm run validate:changes` and inspect the feature's guide and
callers as required by [AGENTS.md](../AGENTS.md). Its routing is advisory;
add semantic-impact checks when shared behavior changes.

Validation routing compares canonical filesystem roots, so directory junctions
and Windows short directory names do not exclude genuine application changes.
Paths outside a nested app remain outside its validation scope.

```bash
npm run test -- finder-engine.spec.ts --list
npm run --silent test -- finder-engine.spec.ts --list --json
npm run test -- finder-engine.spec.ts finder-param-space.spec.ts
npm run validate:changes -- --run
```

Filters are case-insensitive path fragments, combined with OR. Use a full
filename to keep a run focused, or `finder-` to select a feature family.
Every filter must match at least one spec, and unknown options fail before
any spec runs. `--list` discovers paths without spawning specs or changing
test logs; `--list --json` returns `selectedCount`, `totalCount`, `filters`,
and `files` in one object.

On Windows, use `npm.cmd` if PowerShell's npm wrapper consumes options.
The runner also honors forwarded `npm_config_list` and `npm_config_json`.
Use `--silent` when parsing npm command output as JSON.

## Parallel execution and evidence

The default pool uses up to six processes, bounded by available cores.
Successful durations in `artifacts/test-logs/timings.json` put slow specs at
the front of parallel runs. Focused runs update their timings and retain
history for other specs. A previous `latest/summary.json` also seeds timings.
Missing or malformed history falls back to discovery order. History changes
only ordering; every selected spec executes each time.

Use `--runInBand` or `--jobs=1` for discovery order when diagnosing contention,
and `--jobs=4` to reduce concurrent resource use. Run one test/validation
command at a time because runs replace `artifacts/test-logs/latest/`.

Compact output reports each spec and the failure tail. Full logs and
`summary.json` are under `artifacts/test-logs/latest/`; the summary includes
paths, outcomes, durations, jobs, scheduling, and timeouts. Result rows stay
sorted by path regardless of completion order. `npm run --silent test:json`
prints the summary as one JSON object. Use a failed spec's log to investigate
before rerunning only that spec.

## Write small, reliable specs

- Put each regression in its nearest owning spec and name the observable
  behavior. Assert outputs and contracts rather than duplicating implementation.
- Use small deterministic fixtures that still exercise relevant boundaries,
  execution models, long/short behavior, cancellation, and parity.
- Await the operation or an explicit signal. For observable asynchronous
  state, reuse [waitFor](../tests/helpers/wait-for.ts) with a bounded deadline
  and a useful condition label instead of a fixed sleep.
- To bound a promise, reuse [withTimeout](../tests/helpers/with-timeout.ts).
  It clears its deadline on resolution and rejection, so passing specs do not
  stay alive until an unused timer expires. It does not cancel the operation;
  dispose workers, servers, and other resources in `finally`.
- Use `node:test` mock timers for deadline behavior when real scheduling is
  irrelevant. Keep real workers and subprocesses for lifecycle contracts that
  need them. Restore globals, mocks, environment variables, and temporary data.

Run `npm run typecheck:tests` after changing specs. Runner/tooling changes
require `npm run verify`; keep the repository's full CI, E2E, and Rust checks.
