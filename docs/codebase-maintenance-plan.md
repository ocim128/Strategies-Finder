# Codebase Maintenance Plan

## Goal

Make the codebase easier to read, safer to refactor, and easier to delete redundant code by focusing on two cleanup tracks:

- split large mixed-responsibility files
- centralize DOM and browser storage access behind feature-local seams

This plan is intentionally behavior-preserving. It is about manageability, not about adding features.

## Purpose of This Plan

This repo already has the right direction in a few places:

- feature-local DOM contracts
- `lib/persisted-json.ts`
- clearer bootstrap staging in `lib/app-bootstrap.ts`

The problem is consistency. Some features follow those seams, while others still mix:

- business logic
- rendering
- direct DOM lookup
- localStorage access
- feature orchestration

That makes simple refactors feel larger than they should, and it makes dead or redundant code harder to identify with confidence.

This document exists to:

- define a small, repeatable cleanup pattern
- apply it in phases instead of a repo-wide rewrite
- keep behavior stable while improving structure
- make future cleanup easier, not more abstract

## Non-Goals

This plan does not include:

- a framework rewrite
- a styling redesign
- backtest or Finder behavior changes
- moving every file into a new folder at once
- introducing generic base classes or a heavy architecture layer

If a cleanup step needs a large behavior change to land, it is the wrong step for this plan.

## Working Rules

Every phase should follow these rules:

- keep changes behavior-preserving
- clean one feature area at a time
- do not mix feature work with cleanup work
- prefer small explicit helpers over reusable abstractions
- when a migration would cause broad import churn, keep a thin compatibility file at the old path until the rest of the repo catches up
- extracted files should not create more flat `lib/` sprawl; prefer a feature folder when a file is being split into multiple parts

Minimal preferred structure for a cleaned-up feature:

- `*-dom.ts` for required DOM lookups and structural ids
- `*-storage.ts` when the feature persists browser state
- one main service/manager file for behavior
- one renderer/helper file only when the main file clearly has more than one job

Do not create extra layers just because a pattern exists. If a feature only needs one new `*-dom.ts`, stop there.

## Split Decision Checklist

Before splitting a file, confirm all of these are true:

- the file has at least two clear responsibilities
- the split target can be named concretely before editing
- the extracted file will have one obvious owner job
- the result reduces scanning cost instead of adding indirection
- the new files can live under one feature-local path

If these are not true, do a smaller seam extraction first and stop there.

## Current High-Value Targets

These are the best starting points because they are either large, mixed-responsibility, or still rely on scattered DOM/storage access:

- `lib/quick-view.ts`
- `lib/data-mining-manager.ts`
- `lib/handlers/ui-event-handlers.ts`
- `lib/handlers/state-subscriptions.ts`
- `lib/alert-service.ts`
- `lib/handlers/live-positions-handlers.ts`

Large engine files such as `lib/strategies/backtest/backtest-engine.ts` are important, but they are not the first maintainability target for this plan. Start with feature/UI code where the seam is clearer and the cleanup risk is lower.

## Phase 0: Guardrails and Target List

### Purpose

Stop the cleanup problem from spreading further and define the initial migration queue.

### Changes

1. Adopt one simple rule for new or touched feature code:
   - new structural DOM lookups go through a feature-local `*-dom.ts`
   - new browser persistence goes through a feature-local `*-storage.ts` or `lib/persisted-json.ts`
2. Create a short migration queue and do not widen it until one feature migration pattern is proven.
3. Treat file size as a signal, not a hard rule:
   - files above roughly `800` lines or files with mixed DOM plus logic plus storage are cleanup candidates
4. Add one placement rule for extracted files:
   - if a file is split into multiple parts, the new parts should live under a feature-local folder rather than adding more root-level `lib/*.ts` files
   - keep a compatibility barrel at the old path only when it avoids broad churn

### Initial Queue

Recommended order:

1. `lib/quick-view.ts`
2. `lib/data-mining-manager.ts`
3. `lib/handlers/live-positions-handlers.ts`
4. `lib/alert-service.ts`
5. `lib/handlers/ui-event-handlers.ts`

### Acceptance Criteria

- the cleanup queue is explicit
- new cleanup work uses the same seam rules
- the placement rule is explicit
- no repo-wide rewrite starts in this phase

## Phase 1: Pilot One Feature End-to-End

### Purpose

Prove the cleanup pattern on one feature before applying it more widely.

Recommended pilot: `Quick View`

Why this is the right first target:

- it is large enough to matter
- it mixes multiple responsibilities
- it is mostly feature-local
- it is lower-risk than Finder, Hunt, or the backtest engine

### Changes

1. Split `lib/quick-view.ts` by responsibility, not by arbitrary chunks.
2. Extract DOM lookup and required element references into a feature-local DOM module.
3. Keep one main feature service for lifecycle and event wiring.
4. Move rendering helpers out only if they are clearly presentation-only.
5. If the import path would cause broad churn, keep a thin `lib/quick-view.ts` compatibility barrel that re-exports the main feature service.

### Preferred Result

A reasonable end state is:

- `lib/quick-view.ts` as a thin compatibility export if needed
- `lib/quick-view/quick-view-dom.ts`
- `lib/quick-view/quick-view-service.ts`
- `lib/quick-view/quick-view-renderer.ts`

Only add another helper file if the service still has obviously separate jobs after this split.

### Explicitly Avoid

- breaking Quick View into many micro-files
- moving Polymarket business logic unless it is required to reduce obvious mixing
- changing user-facing Quick View behavior as part of the cleanup

### Acceptance Criteria

- Quick View behavior is unchanged
- the main Quick View file no longer owns raw structural DOM lookup
- the main Quick View file has one clear job: feature orchestration
- the result is easier to scan than the current single-file version

### Validation

- `npm run typecheck`
- `npm run test`
- targeted Quick View or Polymarket-related tests if touched

## Phase 2: DOM Seam Rollout

### Purpose

Make structural UI contracts explicit in a few high-value features before touching broader file splits.

### Changes

Apply the seam pattern only to DOM access in the next small set of features:

1. `lib/data-mining-manager.ts`
   - add a feature-local DOM module
   - remove scattered `document.getElementById(...)` calls from the main manager
2. `lib/handlers/state-subscriptions.ts`
   - only extract stable structural DOM access
   - do not try to redesign cross-feature state subscriptions in this phase

Do these sequentially, not as one broad refactor.

### Minimal Pattern

For a migrated feature:

- structural ids live in one place
- DOM lookup happens in one place
- the main file reads like behavior, not setup plumbing

### Explicitly Avoid

- converting every single feature in one pass
- creating one shared mega-DOM helper for the whole app

Feature-local seams are the point.

### Acceptance Criteria

- migrated features no longer scatter raw structural DOM lookup through service/handler code
- structural ids are easier to find and review

### Validation

- `npm run typecheck`
- `npm run test`
- `..\..\..\node_modules\.bin\esno tests\feature-dom-contracts.spec.ts` when structural UI ids are touched

## Phase 3: Storage Seam Rollout

### Purpose

Make browser persistence contracts explicit in a few high-churn features without mixing that work into the DOM rollout.

### Changes

1. `lib/handlers/live-positions-handlers.ts`
   - move localStorage keys and read/write logic into a small feature-local storage helper
2. `lib/alert-service.ts`
   - isolate worker URL persistence into a storage helper
   - if the stored shape grows, route it through `lib/persisted-json.ts`

Do these sequentially, not as one broad refactor.

### Minimal Pattern

For a migrated feature:

- browser storage keys live in one place
- serialization and fallback rules live in one place
- the main file reads like behavior, not persistence plumbing

### Explicitly Avoid

- creating one shared mega-storage helper for unrelated feature settings
- changing stored keys unless there is a migration path

### Acceptance Criteria

- migrated features no longer scatter raw localStorage key usage through service/handler code
- storage keys are easier to find and review
- storage behavior remains backward compatible

### Validation

- `npm run typecheck`
- `npm run test`

## Phase 4: Split Remaining Large Feature Files Using the Proven Pattern

### Purpose

Apply the pilot pattern to the next highest-value files without turning the cleanup into a rewrite.

### Target Files

Primary candidates:

- `lib/handlers/ui-event-handlers.ts`
- `lib/data-mining-manager.ts` if Phase 2 only extracted DOM access
- `lib/handlers/state-subscriptions.ts` if Phase 2 only extracted stable DOM access

### Approach

Split by clear responsibility boundaries only. For example:

- symbol search handling
- timeframe handling
- settings subsection wiring
- shared take-profit mirror wiring

If a section is tightly coupled and not causing pain, leave it alone.

Before starting a split, write down the intended destination files first. If the destination file names are fuzzy, the split is probably premature.

### Important Rule

Do not split `ui-event-handlers.ts` into a framework-like event system. The goal is smaller, readable feature-oriented modules, not a new abstraction layer.

### Acceptance Criteria

- each migrated file has a clearer ownership boundary
- removed code is not replaced with indirection for its own sake
- import paths remain understandable
- the repo root does not gain more flat utility files as a side effect

### Validation

- `npm run typecheck`
- `npm run test`
- relevant focused specs for any touched feature

## Stop Condition

This plan is successful when:

- common UI features have explicit `dom` and `storage` seams
- the largest non-engine feature files are split by responsibility where it clearly helps
- cleanup work is small enough to do alongside hobby development without becoming its own project

If a later phase starts to feel like a rewrite, stop and narrow the scope again.
