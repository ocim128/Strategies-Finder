# Testing for agent workflows

The runner is [scripts/run-tests.ts](../scripts/run-tests.ts). Specs use
`node:test` or standalone assertions and run in separate Node processes so
globals, module caches, and mocks cannot leak between files. Browser specs
(`*.browser.spec.ts`) are bundled with esbuild before execution. E2E is a
separate command.

## Dependency and compiler checks

`npm run deps:check` resolves each direct dependency from this app, prints its
version and metadata path, and checks its declared semver range. Missing or
invalid dependencies fail the command; unrelated sibling workspace leftovers
do not. `npm run verify` runs it before both typechecks and tests. This catches
older tool versions inherited from a parent workspace. Standalone CI uses the
app lockfile and `npm ci`. Workspace installs run from `debug/playground` with
`npm install --workspace=strategies-finder-wt-batch-findings --package-lock=true`;
the workspace `.npmrc` also enables lockfile maintenance. Keep the workspace and
standalone lockfiles for their respective installation contexts.
The direct esbuild version is pinned to 0.28.1 in both contexts; the dependency
preflight reports its resolved path to catch stale nested copies. Regression
coverage in `tests/dependencies-check.spec.ts` includes hidden package metadata,
invalid/missing versions, and unrelated installed packages.

Both typechecks use incremental compilation. Application and test graphs have
separate disposable caches in `.cache/app.tsbuildinfo` and `.cache/tests.tsbuildinfo`.
Deleting `.cache` restores a cold check. No application output is emitted and
typechecks always execute; warm checks reuse TypeScript's compiler analysis.

`npm run build:check` preserves the 650 KiB entry limit and additionally enforces
an 850 KiB combined startup-JavaScript limit. It resolves the actual entry from
`dist/index.html`, traverses static imports in `dist/.vite/manifest.json`, and
counts each JS asset once. Lazy imports are excluded. Raw bytes are gated;
per-asset and summed gzip sizes are also reported. The startup baseline was
781.2 KiB (610.4 entry + 170.8 chart vendor), leaving about 9% headroom. Budget
changes require a measured build and explanation. `tests/bundle-budget.spec.ts`
covers static dependency sharing/cycles, lazy exclusion, and CLI failures.

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

Browser-spec compilation errors produce a failed result and a flushed spec log;
other selected specs still execute and the summary is saved. The runner contract
spec checks this in both serial and parallel fixture runs, isolated from the
outer run's evidence directory.

## Hosted CI caches

`.github/workflows/strategies-finder-test-specs.yml` reuses three artifact
families without inferring any test outcome from a cache:

- Puppeteer browsers: each browser-using job exports `PUPPETEER_CACHE_DIR`
  (under the runner temp directory) through `GITHUB_ENV` in an early step —
  `runner` is not available in job-level `env` — and that exact directory is
  cached ahead of `npm ci` in both the unit and e2e jobs (both launch
  Puppeteer). Keys include OS, architecture, the locked Puppeteer version, and
  the `.puppeteerrc.cjs` hash, so unrelated dependency updates keep browser caches
  usable. Both jobs skip the unused `chrome-headless-shell` download; tests use
  Chrome with `headless: true`. The app's Puppeteer config also skips that binary
  in standalone installs. Vercel's static-build install skips all browsers.
- Cargo: the rust job caches `~/.cargo/registry`, `~/.cargo/git`, and
  `rust-engine/target` after toolchain install. The exact key includes the
  dtolnay toolchain `cachekey` (compiler identity and platform) plus a
  `rust-engine/Cargo.lock` hash; the restore prefix omits the lockfile hash so
  a dependency change rebuilds incrementally instead of evicting everything.
  fmt/test/clippy always run.
- Test timing history: the unit job restores only
  `artifacts/test-logs/timings.json` before `npm run ci` (never `latest/`)
  via `actions/cache/restore@v4`, paired with an explicit
  `actions/cache/save@v4` after a green run — the combined action would add a
  second automatic post-job save of the same run-unique key.
  Keys carry the timing `formatVersion`, runner OS, and Node version, and end
  with `<run id>-<run attempt>`; saves happen only after a green run under
  that unique key, so immutable cache entries cannot freeze scheduling
  history.

Superseded PR runs are cancelled through a workflow/ref concurrency group;
push runs are retained. On unit-job failures, `.log` files and `summary.json`
are uploaded for seven days. Generated `.cjs` bundles are excluded; absent logs
(for example, an install failure) do not fail the upload step.

The workflow is validated with actionlint, not only YAML parsing. Remove the
corresponding steps to restore cold-cache behavior. Net savings depend on
hosted download/compile versus cache-transfer time and are verified from
workflow logs, not locally.

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

## Efficient context and handoffs

Use CodeGraph for structural navigation when available: a specific feature
query through `codegraph_context`, a named symbol through `codegraph_search`,
and callers, traces, or impact as needed. Keep initial results bounded and
widen when incomplete. Use `rtk rg` for text/markup/configuration or an index
miss. Graph relationships can be ambiguous or stale; verify relevant source,
dynamic wiring, contracts, and tests before changing behavior.

Source snippets already returned by tools count as reads. Reuse unchanged
context instead of reading the same files through another tool. Load only
the relevant guide sections and focused specs; revisit files after changes,
missing compaction details, or contradictory evidence. Batch independent
lookups, while keeping edits, dependent checks, and shared-log test runs
sequential. Do not substitute reduced context for caller inspection.

Use the validation router and saved test summaries instead of rebuilding
selection or rerunning a passing check on unchanged work. Run all required
checks and add semantic-impact coverage; this policy preserves full CI,
E2E, and Rust requirements. Expand or repeat checks when changes, failures,
or unresolved concerns justify it.

For substantial work, create a task-specific handoff:

```powershell
rtk proxy npm.cmd run agent:bench -- handoff --task finder-cancellation
```

This copies [the handoff template](agent-handoff.template.md) to
`artifacts/agent-handoffs/finder-cancellation.md` and refuses to overwrite an
existing handoff. Update that copy at meaningful checkpoints and before
compaction, interruption, or transfer. Record the objective, constraints,
decisions, changed files, Git state, exact validation commands/results,
evidence paths, risks, and next step. Avoid full logs and secrets. On resume,
verify current instructions and Git state; stale notes are not authority.

These choices follow [OpenAI's guidance on small, conditional instructions](https://developers.openai.com/blog/rethinking-skills-and-prompts-for-gpt-6-astra)
and [progressive disclosure and deterministic scripts](https://developers.openai.com/blog/skills-agents-sdk).
The goal is less redundant work while retaining evidence, not fewer checks.

## Agent workflow benchmark

[scripts/agent-benchmark.ts](../scripts/agent-benchmark.ts) compares externally
measured runs; it does not launch models or estimate usage from text length.
[The eight tasks](../scripts/agent-benchmark-tasks.json) cover four source
navigation questions and four implementation/coverage tasks. An implementation
task may correctly identify sufficient existing coverage instead of adding
a duplicate spec. Each task has a prompt, independent review criteria,
source paths, and minimum check names; repository policy may require more checks.

```powershell
rtk proxy npm.cmd run agent:bench -- tasks
rtk proxy npm.cmd run agent:bench -- template --task validation-routing --variant baseline --trial 1
rtk proxy npm.cmd run agent:bench -- record --input artifacts/agent-benchmark/input.json
rtk proxy npm.cmd run agent:bench -- compare --baseline baseline --candidate efficient
```

Run each task in separate sessions/checkouts from the same fixed fixture
commit. Compare an RTK-only baseline policy with the new efficiency policy;
keep RTK, exact model, reasoning effort, task prompt, starting code/data,
and required checks fixed. Apply policies separately from fixture code and
keep their exact copies as evidence. Alternate policy order, use at least
two trials per task (three or more preferred), and record all attempts,
including failures. Document cache/environment differences rather than
attributing them to the policy.

Save the template as an input JSON file and replace placeholders with observed
data. Sum provider input/output usage across the entire task, including
retries and additional agents if any; record wall time, tool calls, and
corrective follow-ups from the transcript. Cached input and reasoning counts
are subsets, so do not add them to token totals again. Keep the same metric
definition for both policies. If the client does not expose whole-task usage,
do not invent it or substitute RTK output-token estimates; the comparison
remains pending until usable measurements exist.

A human or independent grader must evaluate the task's acceptance criteria,
inspect the resulting files/answer, and record `review.passed`, reviewer,
and notes. The implementing agent must not approve its own output. Passing
checks alone do not prove the task is correct. Include the transcript,
usage export, policy copy, review, and applicable check logs in `evidence`
as existing repo-local file paths. For implementation passes, `checks`
must include every minimum name with exit code zero; failed attempts can
have incomplete checks but must be graded failed. Capture any additional
checks required by the normal feature guide too.

`record` validates the data, snapshots evidence into an exclusive run directory
under `artifacts/agent-benchmark/<variant>/<task>-<trial>/`, and refuses
overwrites. Archive external evidence under `artifacts/` before importing it.
`compare` writes a JSON report under `artifacts/agent-benchmark/`; add
`--json` for machine-readable stdout. It rejects duplicate runs and withholds
aggregate savings when any task/trial is missing or configurations differ.
Failure trials remain in totals. It reports per-task medians, total token and
runtime measurements, reviewed outcomes, and corrective follow-ups. Any
candidate failure or increased total corrective follow-ups prevents an
improvement verdict even if fewer tokens were used.

Exit codes: `0` for a complete lower-token comparison with all candidate
outcomes passing and no increase in corrective follow-ups; `1` for invalid
input, regression, or no token improvement; `2` for insufficient evidence.
These are the comparator's native codes. RTK 0.51.0's `proxy` maps nonzero
child codes to `1` on the tested Windows setup, so use the JSON `status` to
distinguish missing evidence from regression when invoking it through RTK.
Runtime is reported separately; inspect it before adopting a slower policy.
This small benchmark cannot establish zero degradation on other tasks or
compute billing savings. Extend the task set when relevant failures emerge;
its hash prevents mixing incompatible task sets.

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
