# Research Tabs Layout Consistency — Technical Plan

Status: planned; implementation not started  
Date: 2026-09-08

## Scope and assumptions

Apply the accepted layout proposal to Finder, Batch, Selection Rules, and Ledger
Sweep. Keep the existing navigation, dark palette, feature behavior, and result
semantics. Use Batch's page header and section treatment as the visual baseline,
with less nested shading and consistent spacing across all four tabs.

This document is an explicit user-requested exception to the implementation-plan
restriction in [README.md](README.md). After shipping, consolidate any durable
behavior notes into the feature guides and remove this plan.

The initial review inspected source, not rendered screens. Exact responsive
breakpoints and inherited style conflicts must be confirmed in the browser before
editing. Existing unrelated pair-selection deletions and test edits are outside
scope; record their baseline failures separately if they affect validation.

## Existing architecture and affected files

| Surface | Implementation touchpoints |
|---|---|
| Markup | `html-partials/tab-finder.html`, `tab-batch-backtest.html`, `tab-selection-rules.html`, `tab-ledger-sweep.html` |
| Shared presentation | Proposed `styles/research-tabs.css`, imported by `styles.css` before the final accessibility stylesheet; reuse `styles/variables.css` tokens and shared buttons/inputs |
| Feature presentation | `styles/batch-backtest.css`, `styles/selection-rules.css`, `styles/trade-ledger-sweep.css`; inspect Finder rules in `styles/features/06-settings-finder.css`, `styles/features/13-finder-sort.css`, and `styles/components/08-finder-controls.css` |
| Finder consumers | `lib/finder-manager.ts`, `lib/finder/finder-ui.ts`, `lib/finder/finder-manager-dom.ts` |
| Batch consumers | `lib/batch-backtest/batch-backtest-service.ts`, `lib/batch-backtest/batch-backtest-dom.ts` |
| Ledger Sweep consumers | `lib/batch-backtest/trade-ledger-sweep-service.ts`, `lib/batch-backtest/trade-ledger-sweep-dom.ts` |
| Selection Rules consumers | `lib/selection-rules/service.ts`, `lib/selection-rules-dom.ts` |

Paths abbreviated in a row are relative to that row's first directory. Consumers
are inspection targets; change their code only if the accepted presentation needs
a small adjustment to visibility, accessible status, or generated result markup.

`index.ts` delegates to `bootstrapApp()` in `lib/app-bootstrap.ts`.
`injectLayout()` in `lib/layout-manager.ts` creates lazy tab placeholders;
`lib/strategy-panel-tab-markup.ts` loads each partial, and lazy feature registration
initializes the corresponding manager/service. Batch, Ledger Sweep, and Selection
Rules call `ensureLazyStylesheet(...)` in their `init()` methods. Shared styling
must therefore work regardless of which tab is opened first.

Keep this data flow intact:

`existing input IDs → existing manager/service → current execution/stream/status path → existing result and report renderers → existing copy handlers`

## Target presentation

Each tab follows: **title and short description → setup → Run/status → progress →
results and exports → existing reports/diagnostics**. Only render report sections
for content that the feature already exposes; do not invent reports for symmetry.

- Use existing 18px title, 16px section padding (`--space-4`), 12px field gaps
  (`--space-3`), and 24px major-section gaps (`--space-6`).
- Use a consistent 36px target height for single-line inputs and buttons. Preserve
  appropriate heights for textareas, multi-selects, and checkbox targets.
- Labels sit above inputs. Use two columns when the resizable panel fits them,
  otherwise one column. Confine horizontal overflow to wide result surfaces.
- One prominent Run action per tab; neutral secondary actions; red Stop during
  execution. Keep status visible outside disclosures and use text as well as color.
- Use subtle borders and one section surface level. Retain existing verdict colors,
  theme tokens, focus styles, and feature-specific result columns.
- Use native `details`/`summary` for optional setup and technical output. No new
  disclosure persistence or JavaScript component system.

## Phase 1 — Establish the shared presentation

**Objective:** align the visual foundation while preserving lazy loading.

**Tasks:**

1. Capture the four tabs at narrow and expanded panel widths, including an available
   results state. Check active styles and current input/button sizes.
2. Add a shared root class to the four partials and a small, root-scoped stylesheet
   for headers, sections, fields, execution bars, result toolbars, and disclosures.
3. Apply matching headers and concise subtitles. Use “Ledger Sweep” consistently
   for its visible title and tab; retain the existing navigation labels and IDs.
4. Remove only feature declarations superseded by the new shared rules. Keep
   feature-specific layout rules local and avoid modifying global `.section-title`,
   `.btn`, or `.param-input` behavior for other tabs.

**Risks:** later-loaded feature CSS may override shared rules; root display rules
must not reveal inactive tabs. Preserve current hidden-element behavior.

**Validation:** typecheck and DOM contracts; browser-check each tab as the first
lazy-loaded feature, then switch repeatedly among them and Settings/Hunt.

**Deliverable / exit criteria:** all four headers, controls, spacing, and surfaces
match; inactive tabs stay hidden and neighboring tabs retain their appearance.

## Phase 2 — Reorganize setup and execution

**Objective:** put essential inputs before optional settings and keep execution
feedback in the same location.

**Dependency:** Phase 1 shared styles.

**Tasks:**

- Finder: group existing controls under Scope, Search, and Validation. Move Sorting
  and Universe Ranking below essential setup. Keep strategy selection accessible;
  use disclosures for optional settings without hiding required inputs or warnings.
  Preserve all four scope modes, their conditional sections, and advanced sorting.
- Batch: collapse Balanced Generator; retain ledger export and Trade Gate as setup.
  Separate Run/Stop/status from analysis and exports. Move post-run analysis below
  results. Keep From/To inputs discoverable before execution: they also scope saved
  ledger rows, so they must not become post-run-only controls.
- Selection Rules: place Refresh next to the folder selector, followed by folder
  metadata, horizon, and rule selection. Keep All/None/Invert with the rule list.
- Ledger Sweep: match the folder/refresh layout and execution bar. Keep the holdout
  interpretation warning visible outside collapsed technical sections.
- Align progress styling without replacing the existing progress implementations.

**Risks:** Finder uses `.closest(".param-group")` for OOS labels and disabled state;
retain those wrappers. Preserve scope-specific visibility containers, delegated
event targets, and original element instances/IDs. Moving a control must not change
its defaults, persistence, or request payload.

**Validation:** exercise all Finder scopes and advanced sorting; Batch generation,
ledger settings, and date inputs; rule bulk selection and refresh; Run/Stop and
validation errors on each tab. Run DOM contracts after markup changes.

**Deliverable / exit criteria:** setup has a clear reading order, execution controls
share a layout, and all existing inputs remain usable with identical values.

## Phase 3 — Align results and technical output

**Objective:** make results and copy actions predictable without changing reports.

**Dependency:** Phase 2 layout.

**Tasks:**

1. Align result heading/toolbars, empty-state sizing, header typography, row density,
   and numeric alignment. Keep Finder/Batch list-based renderers and Selection
   Rules' table; do not convert them into a new common table component.
2. Place existing result/summary copy actions with the corresponding output. Keep
   precise labels such as Copy Top Results, Copy Summary, and Copy Report when the
   payload differs. Keep configuration and analysis exports available.
3. Collapse Selection Rules' report and diagnostics separately. Retain Ledger
   Sweep's Diagnostics disclosure and Summary/Full JSON tabs. Position copy buttons
   beside their associated section, outside the clickable disclosure summary.
4. Keep error/status messages visible when reports are collapsed. Preserve result
   selection, sorting, Apply actions, and disabled export gating.

**Contracts:** Selection Rules copies `reportLines.join("\n")`; Batch OPEN_SCORE
report rendering/copy remains verbatim. Ledger Sweep's existing diagnostic summary
formatter remains authoritative. Do not rename report fields, recompute verdicts,
change server artifact gating, or add browser-held data arrays.

**Validation:** compare displayed and copied output before/after using the same
available result fixture; check empty, running, completed, cancelled, and failed
states. Verify horizontal scrolling, keyboard access, and disclosure behavior.

**Deliverable / exit criteria:** output and exports are consistently located;
payloads, result interactions, and visible error feedback are unchanged.

## Phase 4 — Verify integration

**Objective:** demonstrate visual consistency and preserve lifecycle behavior.

**Dependencies:** Phases 1–3; runnable local app and suitable existing datasets or
ledger folders for manual run checks. Missing fixtures must be reported explicitly.

**Validation:**

- Run `npm run typecheck` and
  `..\..\..\node_modules\.bin\esno tests\feature-dom-contracts.spec.ts`.
- Run relevant existing specs through `scripts/run-tests.ts`/the repository test
  runner: `lazy-feature-init.spec.ts`, `finder-manager-lifecycle.browser.spec.ts`,
  `batch-backtest-service-lifecycle.browser.spec.ts`, `batch-backtest-copy.spec.ts`,
  `trade-ledger-sweep-service.spec.ts`, and `selection-rules-preferences.spec.ts`.
  Browser-named lifecycle specs use fake DOMs; they do not establish visual parity.
- Extend existing focused tests only for changed visibility/interaction contracts;
  do not add tests that merely restate CSS declarations. If test code changes, run
  `npm run typecheck:tests`.
- Run `npm run build:check` to verify stylesheet packaging and the bundle budget.
- In the browser, check narrow/expanded panel widths, supported themes, keyboard
  focus, long folder/rule names, lazy-load order, and no page-level overflow. Verify
  Run/Stop, tab switching during a run, and reload reattach where supported.
- Record screenshots and actual pass/fail/skip results. Separate pre-existing
  failures from regressions; do not label an unperformed check as passed.

**Deliverable / exit criteria:** reviewable screenshots and validation results cover
all four tabs; no unresolved layout, accessibility, copy, or lifecycle regressions.

## Boundaries and rollback

No database/schema, localStorage schema, API, infrastructure, deployment, Rust, or
Worker changes are needed. Preserve run-ID ownership, cancellation/reattach,
authorization, scalar streaming, artifact lifetime, and existing escaped rendering.
No additional polling or per-result data retention is required.

Keep shared CSS small and reuse existing renderers. Maintain each feature's current
`hidden`, inline `display`, and `.active` visibility mechanisms; a uniform appearance
does not require a new state machine. Register any genuinely new required DOM ID
in its feature-local contract; decorative wrappers need only classes.

Rollback consists of reverting this work's partial/style and any narrowly required
presentation-handler changes. No data migration or server rollback is needed.
Do not reset or restore unrelated working-tree changes.
