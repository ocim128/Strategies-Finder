# Hunt Plan

See also: [`docs/hunt-performance-plan.md`](./hunt-performance-plan.md) for the verified phase-based performance implementation plan. Use that document for execution sequencing and performance work; use this document for Hunt product scope and contracts.

## Goal

Add a new strategy-panel feature named `Hunt`.

`Hunt` is a profile-driven batch runner built on top of the existing Finder engine. It exists to reduce the current manual loop of:

- changing chart symbol and interval
- changing execution and risk settings
- toggling Polymarket measurement settings
- selecting one or more strategy libs
- running Finder repeatedly
- manually comparing winners across runs

The feature should let the user define multiple reusable evaluation profiles, run Finder across those profiles, and surface the strongest survivors with much less manual effort.

## Why This Exists

The current Finder is good for one interactive search at a time. It is not optimized for the user's real workflow:

1. Try many built-in strategies.
2. Try many chart contexts and backtest settings.
3. Often measure Polymarket performance.
4. Keep only strategies that survive repeated testing.
5. Add many more strategies and repeat.

`Hunt` should turn that loop from repeated manual Finder sessions into one controlled batch workflow.

## Product Definition

`Hunt` is:

- a new strategy-panel tab
- a reusable profile manager
- a sequential multi-profile Finder orchestrator
- a survivor-ranking surface
- a review and pruning tool for strategy libraries

`Hunt` is not:

- a replacement for the existing Finder tab
- a new backtest engine
- an endpoint executor
- a saved configuration replacement
- a parallel worker farm in the first cut

The existing Finder tab should remain intact for one-off manual use.

## Current Repo Facts That Matter

These are the repo facts the implementation must respect:

- App startup and feature registration run through `index.ts`, `lib/app-bootstrap.ts`, and `lib/layout-manager.ts`.
- Strategy-panel tabs are structural HTML partials injected at runtime from `html-partials/*`.
- Finder currently depends on live app state, especially `state.currentSymbol`, `state.currentInterval`, current data, and current backtest settings.
- Finder already supports:
  - random search
  - risk-management freeze
  - Polymarket-specific ranking
  - multi-strategy selection
- The existing endpoint snapshot shape is richer than `StrategyConfig` for Hunt's purpose because it already carries:
  - `symbol`
  - `interval`
  - `blockRange`
  - `backtestSettings`
  - `capitalSettings`
  - Polymarket-related settings via `backtestSettings`
- Existing `StrategyConfig` does not store chart symbol or interval, so it is not sufficient as the primary Hunt profile contract.

Relevant files:

- `lib/backtest-endpoint-copy.ts`
- `lib/finder-manager.ts`
- `lib/finder/finder-runner.ts`
- `lib/finder/finder-runner-core.ts`
- `lib/settings-manager.ts`
- `lib/settings-model.ts`
- `html-partials/strategy-panel-shell.html`
- `html-partials/tab-finder.html`
- `lib/layout-manager.ts`

## Core Design Decision

Hunt profiles should be `endpoint-inspired`, but they should not be stored as raw endpoint request payloads.

Reason:

- The endpoint snapshot is a good capture source because it carries the chart and Polymarket context that Hunt needs.
- The endpoint contract also contains endpoint-specific concerns and fixed-capital semantics that Hunt should not inherit as its internal storage contract.

So the rule is:

- `endpoint snapshot` is a valid source for creating a Hunt profile
- `HuntProfile` is the actual persisted app contract

## Responsibilities

The `Hunt` feature owns these responsibilities:

1. Capture current UI state into reusable profiles.
2. Persist, list, rename, duplicate, enable, disable, delete, import, and export profiles.
3. Apply a Hunt profile back into the main UI.
4. Run Finder once per enabled profile using one shared set of Hunt run settings.
5. Merge and group winners across profiles.
6. Show enough context to decide whether a strategy should be kept, reworked, or archived.

The `Hunt` feature should not own:

- strategy authoring
- generic saved strategy configuration management
- endpoint request submission
- Walk Forward implementation
- Monte Carlo implementation

## Hunt Contracts

### HuntProfile

This is the main persisted contract.

```ts
type HuntProfile = {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  source: "current_ui" | "endpoint_snapshot" | "saved_config_plus_chart";
  symbol: string;
  interval: string;
  blockRange: { from: number; to: number } | null;
  backtestSettings: BacktestSettings;
  capitalSettings: CapitalSettings;
  notes?: string;
};
```

Important rules:

- A Hunt profile stores evaluation environment only.
- A Hunt profile does not store `strategyKey`.
- A Hunt profile does not store `strategyParams`.
- `polymarketOutcomeSymbol` and `polymarketEntryOffset` must live inside `backtestSettings` and must be preserved exactly.

### HuntRunSettings

These are the global controls for a Hunt session.

```ts
type HuntRunSettings = {
  mode: "random";
  maxRunsPerStrategy: number;
  rangePercent: number;
  globalTopN: number;
  perProfileKeepN: number;
  selectedStrategyKeys: string[];
  polymarketScoringEnabled: boolean;
  polymarketRankMode: PolymarketFinderRankMode;
  polymarketMinScoredPredictions: number;
  polymarketLockOffset: boolean;
  polymarketAfterTakeProfitOnly: boolean;
  freezeRiskManagement: boolean;
  tradeCountFilterEnabled: boolean;
  minTrades: number;
  maxTrades: number;
};
```

Defaults for the first cut:

- `mode = "random"`
- `maxRunsPerStrategy = 120`
- `rangePercent = 555`
- `globalTopN = 20`
- `perProfileKeepN = 50`

`perProfileKeepN` is intentionally larger than the visible global top 20. Hunt needs more than 20 raw candidates per profile so the survivor view does not drop cross-profile winners too early.

### HuntProfileRunResult

This is the tagged output from one profile.

```ts
type HuntProfileRunResult = {
  profileId: string;
  profileName: string;
  symbol: string;
  interval: string;
  blockRange: { from: number; to: number } | null;
  result: FinderResult;
  localRank: number;
};
```

### HuntSurvivorGroup

This is the grouped result shown in the main Hunt result surface.

```ts
type HuntSurvivorGroup = {
  groupKey: string;
  strategyKey: string;
  strategyName: string;
  params: StrategyParams;
  appearances: number;
  profileIds: string[];
  profileNames: string[];
  bestLocalRank: number;
  medianLocalRank: number;
  bestPrimaryMetric: number;
  medianPrimaryMetric: number;
  bestCandidate: HuntProfileRunResult;
  candidates: HuntProfileRunResult[];
};
```

Grouping key:

- `strategyKey + stable normalized params`

The implementation should use a deterministic normalized string key for params so equivalent results from different profiles collapse into one survivor group.

## UI Plan

The UI should make Hunt feel like a batch workflow, not like a second manual Finder tab.

### New tab

Add a new strategy-panel tab:

- tab id: `hunt`
- label: `Hunt`

The existing Finder tab remains unchanged.

### Hunt tab sections

#### 1. Profiles

Purpose:

- define reusable evaluation environments
- select which profiles participate in a run

UI:

- profile list with enable checkbox per row
- row badges for:
  - symbol
  - interval
  - block mode active
  - Polymarket outcome symbol if set
- actions:
  - `Capture Current UI`
  - `Import Endpoint Snapshot JSON`
  - `Create From Saved Config + Current Chart`
  - `Apply To UI`
  - `Duplicate`
  - `Rename`
  - `Delete`

Important first-cut simplification:

- direct inline editing of every field is not required
- profile creation should primarily come from capture/import flows

#### 2. Strategies

Purpose:

- choose which strategy libs Hunt will test across profiles

UI:

- same style of multi-select list as Finder
- search box
- bulk actions:
  - `All`
  - `None`
  - `Invert`
  - `Visible`
- selected count summary

This selection is global to the Hunt run, not per profile.

#### 3. Hunt Settings

Purpose:

- keep the workflow simple and repeatable

Visible controls:

- `Polymarket Scoring` toggle
- `Run Selected Profile Only`
- `Run Hunt`

Advanced foldout:

- `Polymarket Rank Mode`
- `Min Scored`
- `Lock Offset in Random 1m`
- `After TP Only`
- `Freeze Risk Management`
- `Trade Count Filter`
- `Min Trades`
- `Max Trades`

Not user-configurable in v1:

- search mode
- runs per strategy
- range percent
- visible global top count

Those should be fixed Hunt defaults in the first cut.

#### 4. Progress

Purpose:

- make long sequential runs understandable and cancellable

UI:

- global progress bar
- current profile label
- processed profiles count
- processed strategies count within current profile
- cancel button

Example status text:

- `Profile 3/10: eth-1m-poly`
- `Running 120 random searches per strategy`
- `Restoring original UI context...`

#### 5. Results

Purpose:

- separate pruning decisions from raw per-profile winners

Result views:

- `Survivors`
- `Per Profile`

`Survivors` view should be the default.

Survivor row content:

- rank
- strategy name
- params
- survived `N / M` profiles
- best profile
- best and median metric summary
- action:
  - `Apply Result`

Per-profile row content:

- profile badge
- local rank
- strategy name
- params
- metric summary
- action:
  - `Apply Result`

## UX Rules

These rules should be explicit so later implementation does not drift:

1. Hunt should preserve the user's original UI context before the run starts.
2. Hunt may temporarily switch symbol, interval, and settings while running profiles.
3. Hunt should restore the original UI context after the batch completes or is cancelled.
4. `Apply Profile To UI` should permanently switch the main UI to that profile.
5. `Apply Result` should:
   - apply the profile's symbol and interval
   - apply the profile's backtest and capital settings
   - switch to the result's strategy
   - apply the result's params
   - rerun a normal backtest
6. If exactly one profile is enabled and it matches the current UI context, Hunt should produce the same winners as the existing Finder for the same selected strategies and advanced settings.

## Architecture Direction

`Hunt` should be implemented as its own feature service, not as a fork of `FinderManager`.

Recommended modules:

- `html-partials/tab-hunt.html`
- `lib/hunt/hunt-dom.ts`
- `lib/hunt/hunt-model.ts`
- `lib/hunt/hunt-storage.ts`
- `lib/hunt/hunt-profile-capture.ts`
- `lib/hunt/hunt-runner.ts`
- `lib/hunt/hunt-results.ts`
- `lib/hunt/hunt-service.ts`

Expected shared touchpoints:

- `lib/app-bootstrap.ts`
- `lib/layout-manager.ts`
- `html-partials/strategy-panel-shell.html`
- `lib/feature-dom-contracts.ts`
- `tests/feature-dom-contracts.spec.ts`

Finder reuse direction:

- Hunt should call shared Finder execution logic, not interact with Finder DOM.
- If needed, extract more shared logic from `FinderManager` into reusable functions rather than duplicating search behavior.

## File Responsibilities

### `lib/hunt/hunt-model.ts`

Owns:

- Hunt types
- Hunt defaults
- normalization helpers
- migration helpers for persisted Hunt data

### `lib/hunt/hunt-storage.ts`

Owns:

- load/save/upsert/delete profile persistence
- load/save Hunt UI state persistence
- schema keys and versioning

Suggested storage split:

- one persisted key for profiles
- one persisted key for Hunt UI state

### `lib/hunt/hunt-profile-capture.ts`

Owns:

- capture current UI into `HuntProfile`
- convert `UiBacktestEndpointSnapshot` into `HuntProfile`
- optional conversion from saved config plus current chart into `HuntProfile`

### `lib/hunt/hunt-dom.ts`

Owns:

- typed required DOM contract for Hunt structural ids

### `lib/hunt/hunt-runner.ts`

Owns:

- single-profile run execution
- multi-profile sequential orchestration
- result tagging
- progress callbacks
- cancellation
- original UI snapshot capture and restore

### `lib/hunt/hunt-results.ts`

Owns:

- raw result tagging helpers
- grouping by strategy plus params
- survivor ranking
- profile-level merge and sorting helpers

### `lib/hunt/hunt-service.ts`

Owns:

- Hunt tab initialization
- event wiring
- rendering
- calling storage and runner modules
- apply profile and apply result flows

## Recommended Build Phases

### Phase 0: Lock Hunt Contracts

Purpose:

- prevent the first implementation pass from drifting into "second Finder tab" chaos

Responsibilities:

- add this plan document
- lock `HuntProfile`, `HuntRunSettings`, `HuntProfileRunResult`, and `HuntSurvivorGroup`
- lock the core UX rules
- lock the first-cut non-goals

UI:

- none required

Acceptance:

- the implementation team can answer:
  - what a Hunt profile is
  - what Hunt stores
  - what Hunt does not store
  - how Hunt differs from Finder and saved configs

### Phase 1: Add Hunt Tab Shell And Profile Storage

Purpose:

- create the persistent profile surface before any run logic

Responsibilities:

- add `Hunt` tab button to `html-partials/strategy-panel-shell.html`
- inject `html-partials/tab-hunt.html` from `lib/layout-manager.ts`
- add `lib/hunt/hunt-dom.ts`
- add Hunt profile persistence and normalization
- render profile list
- implement:
  - capture current UI as profile
  - duplicate
  - rename
  - delete
  - enable/disable
  - apply profile to UI

UI:

- Profiles section only needs to be fully functional in this phase
- other sections may be placeholders

Acceptance:

- user can create, persist, reload, rename, duplicate, delete, and apply Hunt profiles
- DOM contract test updated and passing

### Phase 2: Add Endpoint-Inspired Import And Profile Capture Variants

Purpose:

- support the richer source that motivated the feature

Responsibilities:

- import JSON shaped like the current UI endpoint snapshot or a Hunt-export payload
- convert imported snapshot into `HuntProfile`
- add `Create From Saved Config + Current Chart`
- ensure imported profiles preserve:
  - chart symbol
  - chart interval
  - block range
  - `polymarketOutcomeSymbol`
  - `polymarketEntryOffset`

UI:

- add import action and import status/error feedback

Acceptance:

- user can paste or import endpoint-style snapshot JSON and get a valid Hunt profile
- invalid JSON or incomplete payloads fail with explicit error messages

### Phase 3: Single-Profile Hunt Execution With Finder Parity

Purpose:

- prove Hunt is using the same search engine correctly before adding multi-profile orchestration

Responsibilities:

- implement one-profile execution path
- reuse shared Finder runner logic
- wire Hunt strategy selection and advanced settings into Finder options
- do not read from Finder DOM during execution
- display raw top results for the selected profile

UI:

- Strategies section functional
- Hunt settings functional
- progress and cancel functional
- Per Profile results functional

Acceptance:

- if the Hunt profile matches the current UI and only one profile is enabled, Hunt and Finder return materially identical winners for the same run settings
- cancellation works

### Phase 4: Multi-Profile Sequential Orchestrator

Purpose:

- move from parity proof to real workload reduction

Responsibilities:

- run enabled profiles sequentially
- capture original UI context before run
- switch app context per profile as needed
- restore original UI context on completion or cancellation
- tag all raw results with profile metadata
- keep per-profile top `perProfileKeepN`
- merge raw results into one Hunt result collection

UI:

- current profile label
- profile progress count
- global run status

Important rule:

- v1 should run sequentially only

Reason:

- Finder currently depends on shared app state, chart state, data caches, and settings
- parallel execution would increase complexity and state drift risk substantially

Acceptance:

- user can run Hunt across multiple profiles
- results contain profile badges and local ranks
- original UI context is restored after the run

### Phase 5: Survivor Grouping And Main Hunt Review Surface

Purpose:

- turn raw results into pruning signals

Responsibilities:

- group by `strategyKey + normalized params`
- compute:
  - appearance count
  - best local rank
  - median local rank
  - best metric
  - median metric
- sort survivor groups by:
  1. appearances
  2. median local rank
  3. best local rank
- add `Survivors` as the default view

UI:

- two result views:
  - `Survivors`
  - `Per Profile`
- apply result action from either view

Acceptance:

- user can see which candidates survive across profiles instead of comparing raw rows manually

### Phase 6: Polish, Validation, And Documentation

Purpose:

- finish the feature so it is stable enough for repeated research loops

Responsibilities:

- export Hunt profiles to JSON
- improve error handling and status text
- document Hunt behavior in repo docs if behavior is user-facing
- add tests for normalization and result grouping
- run full validation checklist

UI:

- import/export polish
- empty states
- disabled states
- clear unsupported-state messaging

Acceptance:

- Hunt feels like a first-class strategy-panel feature, not an experiment hidden behind happy-path assumptions

## Validation Plan

At minimum, validate these after implementation:

- `npm run typecheck`
- `npm run test`
- `..\\..\\..\\node_modules\\.bin\\esno tests\\feature-dom-contracts.spec.ts`

Targeted behavior checks:

1. Create a Hunt profile from current UI.
2. Reload the app and confirm the profile persists.
3. Apply the profile and confirm symbol, interval, and settings restore correctly.
4. Import endpoint-style snapshot JSON and confirm Polymarket fields survive.
5. Run one profile and compare Hunt output to current Finder output.
6. Run multiple profiles and confirm the original UI context is restored afterward.
7. Apply a Hunt result and confirm the chart, settings, strategy, and params all match the selected candidate.
8. Test unsupported Polymarket combinations and ensure the UI explains why the run cannot proceed.

## Risks And Mitigations

### Finder parity drift

Risk:

- Hunt accidentally becomes a slightly different search engine than Finder.

Mitigation:

- Phase 3 exists specifically to prove single-profile parity before multi-profile rollout.

### Hunt profile drift from current UI contracts

Risk:

- capture/import silently drops fields such as `polymarketOutcomeSymbol` or `blockRange`.

Mitigation:

- use explicit normalization helpers
- preserve profile fields as first-class contract members
- test import/capture round-trips

### Shared state side effects during batch runs

Risk:

- multi-profile execution leaves the app on the wrong symbol, interval, or settings.

Mitigation:

- capture original context before run
- restore it in a `finally` path
- never let apply-profile and run-profile share ambiguous semantics

### Raw top-20 merge hides real survivors

Risk:

- one profile dominates the output and cross-profile survivors never surface.

Mitigation:

- keep more than 20 candidates per profile internally
- add grouped survivor ranking as a dedicated phase

### Hunt becomes too configurable too early

Risk:

- it turns into a duplicate of Finder with more complexity and less clarity.

Mitigation:

- hardcode random mode, run count, range, and visible global top count in v1
- keep advanced settings narrow and Hunt-specific

## Non-Goals For The First Cut

- parallel multi-profile execution
- profile-specific strategy lists
- profile-specific run-count tuning
- genetic or grid Hunt modes
- integrated Walk Forward or Monte Carlo inside Hunt
- automatic delete/archive of strategy files
- editing every profile field manually in a big form

## Proposed First Deliverable

The first meaningful deliverable should include:

1. `Hunt` tab visible in the strategy panel.
2. Hunt profile persistence and current-UI capture.
3. Single-profile Hunt execution with Finder parity.
4. Multi-profile sequential execution.
5. Survivor and per-profile result views.
6. Apply-profile and apply-result flows.

It does not need endpoint submission or archive automation.

## Decision Summary

- `Hunt` is a new strategy-panel feature, not a Finder replacement.
- Hunt profiles are endpoint-inspired but Hunt-native.
- Profiles store chart plus backtest context, not strategy params.
- Strategy selection remains global to the Hunt session.
- Hunt v1 runs sequentially.
- Hunt v1 keeps random mode and core search defaults fixed.
- The main output is a grouped survivor view, not only a flat merged result list.
