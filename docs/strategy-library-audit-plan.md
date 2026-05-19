# Strategy Library Audit Plan

## Goal

Add a read-only Strategy Panel tool named **Library Audit** that analyzes helper usage across:

- current built-in strategy files under `lib/strategies/lib/*.ts`
- archived strategy files under `archive/strategy/*.ts`

The first implementation should answer:

- which shared helpers are common in current strategies
- which shared helpers are common in archived strategies
- which helpers are archive-heavy, archive-only, or unused by current strategies after normalizing for current/archive corpus size
- which source files support each count

The tool should produce cleanup candidates, not delete code automatically.

## Assumptions

- Archived strategies are usually weaker or rejected strategies, but archive presence is only a signal, not proof that a helper is bad.
- "Helper" means named imports from shared strategy helper modules in the first cut.
- Local functions declared inside individual strategy files are out of scope for the first cut.
- The UI should live in a dedicated Strategy Panel tab named **Audit**, because the result table is too large for the Settings workspace.
- The browser should not import, compile, or execute archived strategy files.
- The existing Vite plugin pattern used by `lib/strategy-library-admin-plugin.ts` is the right server-side seam for filesystem scanning.
- The audit must report evidence strength. It must not label a helper as bad based only on archive usage.

## Unknowns

- Whether archived strategy usage should be weighted by archive date. The first cut should not weight by date.
- Whether archive reason exists anywhere in the repo. No current evidence shows a persisted archive quality label.
- Whether helper cleanup should later consider strategy performance data. The first cut should not join against backtest results.
- Whether helpers imported by archived files still exist at their original paths. The audit should count import text without resolving or executing archived files.

## Conceptual Constraints

The audit has two built-in interpretation risks:

- Corpus imbalance: the archive can contain many more files than the current library, so raw archived counts will usually be larger.
- Survivorship bias: archived strategy usage can mean a helper was bad, misused, overfit, redundant, or simply popular during a failed generation wave.

The implementation must therefore show normalized rates and evidence flags, not just raw counts.

Recommended interpretation:

- high archived count plus low current rate is a cleanup lead
- archive-only plus missing export is likely stale history, not an active cleanup target
- core signal helpers should be separated from strategy-idea helpers
- low total usage should be marked low evidence, not bad

## Non-Goals

- No automatic helper deletion.
- No strategy deletion changes.
- No strategy manifest changes.
- No new database, localStorage schema, worker contract, or Cloudflare Worker behavior.
- No backtest, Finder, Hunt, Walk Forward, or Polymarket scoring behavior changes.
- No analysis of local per-file helper functions in the first cut.

## Current Repo Facts

- App startup runs through `index.ts` and `lib/app-bootstrap.ts`.
- Strategy Panel layout is injected from `html-partials/strategy-panel-shell.html` and tab/content partials through `lib/layout-manager.ts`.
- Settings markup already contains a destructive `Library Tools` menu in `html-partials/tab-settings-start.html`; audit should stay separate from that admin surface.
- Existing destructive library admin behavior is split across:
  - `lib/strategy-library-admin-plugin.ts`
  - `lib/strategy-library-admin-api.ts`
  - `lib/strategy-library-admin-service.ts`
  - `lib/strategy-library-admin-dom.ts`
- The Vite config already registers `strategyLibraryAdminPlugin()`.
- DOM contract tests include feature-local required id arrays through `tests/feature-dom-contracts.spec.ts`.
- TypeScript is already available as a dev dependency, so AST parsing can use the TypeScript compiler API without adding a package.

## System Architecture

The planned feature should follow the current local-dev architecture:

- Browser UI: dedicated Strategy Panel `Audit` tab and result table.
- Browser service: fetches read-only audit JSON and renders it.
- Vite plugin: scans repo files using Node filesystem APIs and TypeScript AST parsing.
- No persistent storage: results are computed on demand.
- No worker support: this is a local library maintenance tool.

The browser should only receive structured audit results. It should not receive full source file contents.

## Module Boundaries

Proposed modules:

- `lib/strategy-library-audit-plugin.ts`
  - owns filesystem scanning
  - owns TypeScript AST import extraction
  - owns strategy-file detection so helper/core modules are not counted as strategy sources
  - owns helper classification and result shaping
  - exposes pure functions for tests plus the Vite plugin endpoint
- `lib/strategy-library-audit-api.ts`
  - owns browser fetch wrapper and response validation
- `lib/strategy-library-audit-dom.ts`
  - owns required DOM ids for the Library Audit UI
- `lib/strategy-library-audit-service.ts`
  - owns event binding, loading state, rendering, and user-facing error handling
- `html-partials/tab-library-audit.html`
  - owns the dedicated audit tab markup
- `html-partials/strategy-panel-shell.html`
  - owns the `Audit` tab button
- `lib/app-bootstrap.ts`
  - registers the service as a lazy feature and binds activation to the menu opening or analyze button
- `vite.config.ts`
  - registers the audit Vite plugin
- `tests/strategy-library-audit-plugin.spec.ts`
  - verifies scanning/classification with temporary fixture files

Do not add audit logic to `strategy-library-admin-service.ts`; admin is destructive, audit is read-only.

## Data Flow

1. User opens the Strategy Panel **Audit** tab and clicks **Analyze Helper Usage**.
2. `strategy-library-audit-service.ts` lazy-initializes, binds events, and calls `getStrategyLibraryAudit()`.
3. `strategy-library-audit-api.ts` fetches the Vite endpoint.
4. `strategy-library-audit-plugin.ts` scans current and archived `.ts` files.
5. The plugin identifies actual strategy source files and excludes shared helper/core modules from the strategy corpus.
6. The plugin parses import declarations with TypeScript AST and counts named imports from allowed helper modules.
7. The plugin calculates raw counts, per-corpus usage rates, archive lift, evidence flags, and bounded source examples.
8. The browser renders totals, flags, and a filterable table.

No result should be written to localStorage in the first cut.

## API Contracts

Proposed endpoint:

```txt
GET /api/strategy-library/audit
```

Proposed response:

```ts
interface StrategyLibraryAuditResponse {
  ok: true;
  generatedAt: string;
  currentStrategyFileCount: number;
  archivedStrategyFileCount: number;
  scannedFileCount: number;
  helperRows: StrategyLibraryAuditRow[];
  warnings: string[];
}

interface StrategyLibraryAuditRow {
  helperName: string;
  moduleSpecifier: string;
  moduleGroup: string;
  currentImportCount: number;
  archivedImportCount: number;
  currentFileCount: number;
  archivedFileCount: number;
  currentUsageRate: number | null;
  archivedUsageRate: number | null;
  archiveRatio: number | null;
  archiveLift: number | null;
  evidenceLevel: "low" | "medium" | "high";
  flags: StrategyLibraryAuditFlag[];
  currentExamples: string[];
  archivedExamples: string[];
}

type StrategyLibraryAuditFlag =
  | "archive_only"
  | "archive_heavy"
  | "current_only"
  | "low_evidence"
  | "core_helper"
  | "missing_export";
```

Notes:

- `moduleSpecifier` should preserve the source import string for traceability.
- `moduleGroup` should normalize equivalent helper surfaces, for example `strategy-helpers`, `indicators`, or `price-action-statistics-core`.
- `archiveRatio` should be `archivedFileCount / (currentFileCount + archivedFileCount)` when the denominator is non-zero.
- `currentUsageRate` should be `currentFileCount / currentStrategyFileCount` when the denominator is non-zero.
- `archivedUsageRate` should be `archivedFileCount / archivedStrategyFileCount` when the denominator is non-zero.
- `archiveLift` should compare archived usage rate against current usage rate. If current usage is zero and archived usage is non-zero, return `null` and rely on `archive_only`.
- `evidenceLevel` should reflect total unique file count, not import count.
- Examples should be relative file paths and capped to avoid large JSON payloads.
- Error responses should follow the existing `{ ok: false, error: string }` style used by strategy library admin.

## Strategy Source Selection

Do not treat every `.ts` file under `lib/strategies/lib` as a strategy source. That directory also contains helper/core modules.

Current strategy source selection:

- include files with an exported strategy definition, preferably detected through AST:
  - `export const <key>: Strategy = ...`
- exclude known helper/core modules even if they have imports:
  - files ending in `-core.ts`
  - files ending in `-helpers.ts`
  - `polymarket-1s-helpers.ts`
  - `cross-symbol-helpers.ts`
- preserve a warning count for skipped `.ts` files that are neither strategy files nor known helper/core modules

Archived strategy source selection:

- include files with an exported strategy definition when detectable
- if archived files have degraded type annotations, allow a fallback filename-based include only for files under `archive/strategy`
- record warnings for archived files that cannot be confidently classified

Reason:

- counting helper/core modules as strategy files would distort current usage rates
- archived files may have stale imports and should be parsed as text, not resolved as live modules

## Helper Module and Export Rules

First-cut helper modules:

- `../strategy-helpers`
- `../indicators`
- `./price-action-statistics-core`
- `./price-action-frequency-core`
- `./range-conviction-core`
- `./cross-symbol-helpers`
- `./polymarket-1s-helpers`

Normalize helper modules by module group, not by exact raw specifier only. The raw specifier should remain in examples, but classification should tolerate equivalent relative strings and optional `.ts` suffixes.

Build a current export index from the live helper modules when possible:

- parse live helper module files with TypeScript AST
- record exported function/const names
- mark helper rows as `missing_export` when archived files import a helper that no longer exists in the current helper module
- do not fail the audit when export validation is unavailable; return a warning

Classification:

- `archive_only`: `currentFileCount === 0 && archivedFileCount > 0`
- `archive_heavy`: `currentFileCount > 0 && archivedUsageRate >= currentUsageRate * 2 && archivedFileCount >= 5`
- `current_only`: `currentFileCount > 0 && archivedFileCount === 0`
- `low_evidence`: total unique file count is 1 or 2
- `core_helper`: common signal plumbing helpers such as `createBuySignal`, `createSellSignal`, `createSignalLoop`, and `ensureCleanData`
- `missing_export`: the helper is imported by scanned files but is not exported by the current live helper module

The UI should visually distinguish `core_helper` from cleanup candidates so foundational helpers do not dominate the warning list.

## State Management

Use local service state only:

- `idle`
- `loading`
- `ready`
- `error`

Do not add shared `state.ts` fields. The audit result is not part of chart state, backtest state, strategy selection, or settings persistence.

## Security Considerations

- The endpoint is local-dev maintenance tooling, like the existing strategy library admin endpoint.
- The endpoint must not accept arbitrary paths from the browser.
- Scan roots must be fixed to repo-relative directories:
  - `lib/strategies/lib`
  - `archive/strategy`
- Returned examples must be relative paths only.
- Do not return full source text.
- Do not execute, import, or transpile strategy files.
- Reuse path containment checks similar to `assertPathWithin(...)` in `strategy-library-admin-plugin.ts`.

## Performance Considerations

- The archive folder can contain hundreds of files, so scanning should be on demand only.
- Use synchronous filesystem reads inside the Vite plugin only for one explicit audit request; this matches existing local maintenance tooling.
- Use TypeScript AST parsing per file; avoid dynamic imports.
- Cap example file paths per row, for example 5 current and 5 archived examples.
- Sort rows server-side by risk signal, then by total usage.
- Do not re-run the audit on every strategy selection change.

## Observability and Logging

- Browser service should log audit success/failure through `debugLogger`.
- Vite plugin should return warnings in the response for skipped unreadable files or parse failures.
- Parse warnings should be visible in the UI but should not fail the entire audit unless all scan roots fail.

## Failure Handling

- If one file cannot be read or parsed, record a warning and continue.
- If a scan root is missing, return a warning and continue with the existing root.
- If both scan roots are missing, return a non-OK response.
- If the endpoint is unavailable, show a concise UI error and keep the menu usable.
- If the response shape is malformed, fail loud in the API wrapper with a clear error.

## Rollback Strategy

- The feature is additive and read-only.
- Rollback is removing:
  - the `Audit` tab button and lazy tab partial
  - audit DOM contract exports
  - lazy feature registration
  - Vite plugin registration
  - audit service/API/plugin files
  - audit tests
- No data migration or localStorage cleanup is required because the first cut persists nothing.

## Edge Cases

- Multiline import declarations.
- `import type { ... }` declarations.
- Aliased named imports, for example `foo as bar`; count the exported helper name, not the alias.
- Archived files whose relative imports no longer resolve from `archive/strategy`.
- Strategy files with spaces or timestamp suffixes in filenames.
- Duplicate imports of the same helper in one file. File count should count the file once; import count may count occurrences.
- Files with no Strategy export but helper imports. The first cut should exclude them from strategy usage counts and report a skipped-file warning.
- Helpers that are archive-heavy only because the archive corpus is much larger. Usage-rate and lift columns should prevent raw-count overreaction.

## Phase 0: Planning and Contract Lock

### Objective

Define the product scope, module seams, endpoint shape, and validation criteria before implementation.

### Scope

- Planning document only.
- No runtime code changes.
- No UI markup changes.

### Technical Tasks

- Document the proposed feature name: **Library Audit**.
- Document non-goals and assumptions.
- Document module boundaries and data flow.
- Document endpoint and response contracts.
- Document validation commands.

### Dependencies

- Existing repo structure.
- Existing strategy library admin architecture for reference.

### Risks/Blockers

- Ambiguity around whether archived usage means helper weakness or strategy misuse.
- Unknown future need for performance-result joins.

### Deliverables

- `docs/strategy-library-audit-plan.md`

### Validation/Testing Criteria

- Document references only files and architecture that exist or are explicitly proposed.
- Document does not require new infrastructure, database, or worker behavior.

### Exit Criteria

- Plan is reviewed and accepted as the implementation guide.

## Phase 1: Server-Side Audit Core

### Objective

Build a tested, read-only audit engine that scans strategy files and produces helper usage rows.

### Scope

- Node/Vite-side code only.
- No browser UI beyond API availability.

### Technical Tasks

- Create `lib/strategy-library-audit-plugin.ts`.
- Add fixed scan-root resolution for current and archived strategy directories.
- Add path containment checks.
- Parse `.ts` files with TypeScript `createSourceFile`.
- Detect strategy source files before counting imports.
- Exclude helper/core modules from current strategy corpus counts.
- Extract named imports from configured helper module specifiers.
- Normalize module groups.
- Build a best-effort export index from current live helper modules.
- Count import occurrences and unique file usage separately.
- Calculate per-corpus usage rates, archive lift, evidence level, flags, and capped examples.
- Expose pure scan/build functions for tests.

### Dependencies

- `typescript` dev dependency.
- Node `fs` and `path`.
- Existing `sendJson` helper from `lib/http-response-utils.ts`.

### Risks/Blockers

- Archived files may contain syntax that current TypeScript parsing cannot handle.
- Helper module specifiers may vary more than expected.
- Regex-like shortcuts would miss multiline imports; AST parsing is required.
- Misclassifying helper/core files as strategies would distort usage rates.
- Raw archive counts will be misleading without normalized rates because the archive corpus is larger.

### Deliverables

- Pure audit functions.
- Vite plugin endpoint handler.
- Fixture-based tests for extraction and classification.

### Validation/Testing Criteria

- `npm run typecheck`
- `..\\..\\..\\node_modules\\.bin\\esno tests\\strategy-library-audit-plugin.spec.ts`
- Tests cover multiline imports, aliased imports, archive-only helpers, current-only helpers, missing exports, excluded helper/core modules, normalized rates, and warning behavior.

### Exit Criteria

- The pure audit function returns stable expected rows from temporary fixture directories.
- Endpoint returns `{ ok: true, ... }` for a repo with at least one scan root.
- Endpoint never imports or executes strategy files.
- Current helper/core modules are not counted as strategy source files.

## Phase 2: API Wrapper and Response Validation

### Objective

Add a browser-side fetch wrapper with strict enough validation to fail loud on malformed responses.

### Scope

- Browser API module only.
- No DOM rendering yet.

### Technical Tasks

- Create `lib/strategy-library-audit-api.ts`.
- Add TypeScript interfaces matching the endpoint response.
- Fetch `GET /api/strategy-library/audit`.
- Parse JSON and surface `{ ok: false, error }` messages.
- Validate required response fields before returning data to the service.

### Dependencies

- Phase 1 endpoint.
- Existing browser fetch pattern from `strategy-library-admin-api.ts`.

### Risks/Blockers

- Endpoint unavailable under production build if plugin registration is dev/preview only.
- Overly loose validation could hide server regressions.

### Deliverables

- Fetch wrapper.
- Exported response interfaces.

### Validation/Testing Criteria

- `npm run typecheck`
- Manual or unit-level fetch mock if an existing lightweight pattern is available.

### Exit Criteria

- Callers receive typed audit data or a clear thrown error.
- API wrapper does not know about DOM or rendering.

## Phase 3: Dedicated Audit Tab UI and DOM Contract

### Objective

Add a read-only **Audit** tab to the Strategy Panel without changing existing Settings or Library Tools behavior.

### Scope

- Dedicated audit tab partial.
- Strategy Panel tab shell.
- Feature-local DOM contract.
- DOM contract test update.
- No audit rendering logic beyond structural containers.

### Technical Tasks

- Update `html-partials/strategy-panel-shell.html` with a new `data-tab="libraryaudit"` tab button.
- Add `html-partials/tab-library-audit.html` with a `libraryauditTab` root.
- Register the new partial in `lib/strategy-panel-tab-markup.ts`.
- Add button id for `Analyze Helper Usage`.
- Add status/result container ids.
- Create `lib/strategy-library-audit-dom.ts`.
- Export the new DOM contract through `lib/feature-dom-contracts.ts` if needed.
- Add the required id group to `tests/feature-dom-contracts.spec.ts`.

### Dependencies

- Existing Strategy Panel tab shell and lazy tab markup loader.
- Existing feature DOM contract pattern.

### Risks/Blockers

- Strategy Panel tab row is already dense; the tab label should stay short.
- Adding structural ids without updating tests will fail DOM contract validation.

### Deliverables

- Audit menu markup.
- DOM contract module.
- Updated feature DOM contract test.

### Validation/Testing Criteria

- `..\\..\\..\\node_modules\\.bin\\esno tests\\feature-dom-contracts.spec.ts`
- `npm run typecheck`

### Exit Criteria

- All required audit ids exist in HTML partials.
- Existing strategy library admin ids and behavior remain untouched.

## Phase 4: Browser Service and Rendering

### Objective

Wire the Library Audit UI to the endpoint and render actionable helper usage results.

### Scope

- Event binding.
- Loading/error states.
- Table rendering and simple client-side filtering/sorting if needed.
- Lazy feature registration.

### Technical Tasks

- Create `lib/strategy-library-audit-service.ts`.
- Bind the analyze button.
- Maintain local service state: idle/loading/ready/error.
- Render summary counts and warnings.
- Render helper rows with flags, raw counts, usage rates, archive lift, evidence level, and examples.
- Add minimal filter controls only if they directly support the core workflow:
  - show archive-heavy only
  - hide core helpers
  - text search by helper/module
- Register lazy feature in `lib/app-bootstrap.ts`.
- Activate it when the Library Audit menu opens or the analyze button is pressed.
- Log success/failure through `debugLogger`.

### Dependencies

- Phase 2 API wrapper.
- Phase 3 DOM contract.
- Existing lazy feature mechanism in `lib/lazy-feature-init.ts`.

### Risks/Blockers

- Rendering too much data can make the Audit tab hard to scan.
- Sorting/filtering can become overbuilt. Keep the first cut minimal.
- Audit state should not leak into global app state.

### Deliverables

- Working Library Audit UI.
- Read-only helper table.
- User-visible warnings and errors.

### Validation/Testing Criteria

- `npm run typecheck`
- `..\\..\\..\\node_modules\\.bin\\esno tests\\feature-dom-contracts.spec.ts`
- Manual smoke:
  - open Audit
  - run audit
  - verify summary counts render
  - verify archive-heavy rows render with normalized rates
  - verify core helpers can be visually separated from cleanup leads
  - verify existing Settings Library Tools delete UI still opens

### Exit Criteria

- User can run the audit from the Strategy Panel.
- No strategy files are modified.
- No localStorage entries are created.
- Existing strategy selection and delete menu behavior remain unchanged.

## Phase 5: Integration, Documentation, and Cleanup

### Objective

Finalize the feature with focused tests, documentation alignment, and rollback clarity.

### Scope

- Vite config registration.
- Documentation update if implementation differs from this plan.
- Focused validation.

### Technical Tasks

- Register the audit plugin in `vite.config.ts` near `strategyLibraryAdminPlugin()`.
- Add or update tests for plugin endpoint behavior if the existing Vite plugin tests provide a reusable pattern.
- Update this plan with implementation notes only if the final contract changes materially.
- Confirm no generated strategy manifest files changed.

### Dependencies

- Phases 1-4.
- Existing Vite plugin registration pattern.

### Risks/Blockers

- Plugin registration order conflicts are unlikely but should be checked because `vite.config.ts` has multiple local API plugins.
- Broad test runs may expose unrelated baseline failures. Record them separately if present.

### Deliverables

- Registered audit plugin.
- Passing focused tests.
- Final implementation notes if needed.

### Validation/Testing Criteria

- `npm run typecheck`
- `..\\..\\..\\node_modules\\.bin\\esno tests\\feature-dom-contracts.spec.ts`
- `..\\..\\..\\node_modules\\.bin\\esno tests\\strategy-library-audit-plugin.spec.ts`
- Optional broader check if changes remain small and time allows:
  - `npm run test`

### Exit Criteria

- Feature is execution-ready and verified by focused tests.
- Any skipped validation is explicitly reported.
- Rollback remains additive-file removal with no data migration.
