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

Routing ownership: [scripts/validation-map.ts](../scripts/validation-map.ts)
owns the rule catalogue, pure plan construction, and `normalizeChangedPaths`,
the one changed-path canonicalization shared with the Git collector in
[scripts/validate-changes.ts](../scripts/validate-changes.ts). A plan that
selects `full-js` drops the focused trio (both typechecks and the focused spec
run) because `npm run ci` contains them; a future composite check would need an
explicit policy change rather than new metadata.

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

## Hosted CI caches

`.github/workflows/strategies-finder-test-specs.yml` reuses three artifact
families without inferring any test outcome from a cache:

- Puppeteer browsers: a job-level `PUPPETEER_CACHE_DIR` under the runner temp
  directory is cached ahead of `npm ci` in both the unit and e2e jobs (both
  launch Puppeteer). Keys are `puppeteer-<os>-<arch>-<lockfile hash>`.
- Cargo: the rust job caches `~/.cargo/registry`, `~/.cargo/git`, and
  `rust-engine/target` after toolchain install. The exact key includes the
  dtolnay toolchain `cachekey` (compiler identity and platform) plus a
  `rust-engine/Cargo.lock` hash; the restore prefix omits the lockfile hash so
  a dependency change rebuilds incrementally instead of evicting everything.
  fmt/test/clippy always run.
- Test timing history: the unit job restores only
  `artifacts/test-logs/timings.json` before `npm run ci` (never `latest/`).
  Keys carry the timing `formatVersion`, runner OS, and Node version, and end
  with `<run id>-<run attempt>`; saves happen only after a green run under
  that unique key, so immutable cache entries cannot freeze scheduling
  history.

Remove the corresponding steps to restore cold-cache behavior. Net savings
depend on hosted download/compile versus cache-transfer time and are verified
from workflow logs, not locally.

## RTK as the primary agent CLI

[RTK](https://github.com/rtk-ai/rtk) is a local CLI that filters command output
before a coding agent reads it. Its advertised 60-90% reduction concerns
supported command output; total session savings depend on the commands used.
It does not reduce the source files, instructions, or reasoning in a session.
RTK is required as the primary shell-command entry point for AI agents in
this repo, as specified in [AGENTS.md](../AGENTS.md#command-execution-rtk-required).
It is a developer tool installed on the agent's machine, outside the
application's npm dependencies and CI checks.

Install on native Windows with the upstream package:

```powershell
winget install --id rtk-ai.rtk --exact
rtk --version
```

Alternatively, download the Windows ZIP from [RTK releases](https://github.com/rtk-ai/rtk/releases),
verify its SHA-256 against the release checksum, and place `rtk.exe` in a
directory on PATH, such as `$env:USERPROFILE\.local\bin`. Restart the agent
or terminal if PATH changed. See [upstream installation instructions](https://github.com/rtk-ai/rtk/blob/master/INSTALL.md).

At session start, verify `rtk --version`. Install RTK or repair PATH if it is
missing; report a setup limitation if installation is unavailable instead of
silently switching to raw commands. Installation and tool-location commands
needed to bootstrap RTK are exempt. Native file/edit tools need no wrapping.

Use supported filters for routine inspection:

```powershell
rtk git status --short
rtk git diff
rtk git log -5 --oneline
rtk rg -n AbortController lib
rtk tsc --noEmit
rtk gain
rtk gain --history
```

This works without a command-rewriting hook. RTK also offers
`rtk init --codex` for a project-scoped Codex hook and awareness files; see
the [upstream Codex guide](https://github.com/rtk-ai/rtk/blob/master/hooks/codex/README.md).
Hook support depends on the installed agent's tool protocol. Verify rewriting
in that client before relying on it; explicit commands remain the fallback.

Use `rtk proxy` for unsupported commands and output that must stay exact.
Proxy preserves command output and tracks usage without filtering. On Windows,
use `npm.cmd`; use `npm` on other systems:

```powershell
rtk proxy npm.cmd run test -- feature-dom-contracts.spec.ts
rtk proxy npm.cmd run validate:changes
rtk proxy npm.cmd --silent run test -- feature-dom-contracts.spec.ts --list --json
rtk proxy git diff -- AGENTS.md
rtk proxy powershell -NoProfile -Command 'Get-Content AGENTS.md'
```

Our custom test runner already emits compact status lines and retains full
logs. The local benchmark found that `rtk test` hid the pass/fail summary and
`rtk summary` omitted validation routing details. Run these checks through
`rtk proxy` to preserve their evidence. Likewise, proxy JSON output, exact
source reads/searches, patch review, and saved failure logs. On this Windows
setup, `rtk grep` failed because `grep` was absent; `rtk rg` worked.

Use `rtk gain` to inspect estimated savings from actual wrapped commands;
these are RTK estimates, not the provider's total token or billing figures.
If a filtered diagnostic is incomplete, rerun the underlying command through
`rtk proxy` or inspect the existing logs. Required validation and its pass/fail
criteria still apply. Proxy commands may yield no token savings; preserving
their evidence takes priority over filtering.

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
