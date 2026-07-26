# UI Polish — Implementation Plan

## Goal

Tighten the UI surface of Strategies-Finder for a premium production
release by removing dead CSS, consolidating inline-styled layout primitives,
aligning icon/copy language, and formalizing the existing token system.

This is a UI-only change set. It does not introduce new features, settings,
endpoints, persistence, or worker behavior. All changes are visual or
structural cleanup of existing surfaces.

## Scope and non-goals

In scope:

- Dead CSS removal (4 stylesheets).
- Inline-style attribute removal in `html-partials/` (184 instances today).
- Token-system cleanup (unused/aliased tokens).
- Icon-language and copy/labeling consistency.
- Formalizing the z-index scale.
- Show/hide strategy and boolean-control pattern consolidation.

Non-goals:

- No new design system, no rewrite of the panel shell.
- No new dependencies, build tooling, or runtime behavior.
- No change to strategy execution, backtest semantics, or data flow.
- No change to the lazy-stylesheet loading pattern in
  `lib/**/*-service.ts` via `ensureLazyStylesheet`.

## Findings baseline (informs every phase)

- Zero hex colors in `styles/` outside `variables.css`.
- Zero hex/rgb literals in `lib/` outside `lib/constants.ts` (chart theme)
  and `lib/monte-carlo-renderer.ts` (canvas).
- Only 12 `!important` in CSS, all in `accessibility.css` (legitimate).
- 184 `style=""` attributes in `html-partials/`; 91 are in
  `tab-settings-section-core.html` and `tab-settings-section-execution.html`.
- Dead selector counts (per a class-name grep against `lib/` and
  `html-partials/`): `data-viz.css` 41/55, `onboarding.css` 39/54,
  `analysis-styles.css` 44/50, `chart-enhancements.css` 13/46.

## Affected modules and files

CSS only:

- `styles.css` — top-level `@import` list.
- `styles/variables.css` — token definitions.
- `styles/data-viz.css`, `styles/onboarding.css`, `styles/analysis-styles.css`,
  `styles/chart-enhancements.css` — deletion or pruning.
- `styles/features/03-stats-core.css`, `styles/features/06-settings-finder.css`
  — receive extracted survivors from deleted files.
- `styles/media-queries.css` — drop unused `--space-base`.
- `styles/accessibility.css` — touch only if z-index tokens land here.

Markup:

- `html-partials/tab-settings-section-core.html` (54 KB; 52 inline styles).
- `html-partials/tab-settings-section-execution.html` (39 inline styles).
- `html-partials/tab-monte-carlo.html`, `tab-walkforward.html`,
  `tab-finder.html`, `tab-hunt.html`, `tab-alerts.html`,
  `tab-execution-lab.html`, `tab-batch-backtest.html`, `tab-results.html`,
  `tab-rank-pairs.html`, `chart-wrapper.html`, `strategy-panel-shell.html`,
  `tab-settings-start.html`, `tab-settings-end.html`, `code-editor.html`.

TypeScript (small, surgical):

- `lib/batch-backtest/batch-backtest-service.ts:2621` — one `cssText` literal.
- `lib/renderers/resultsRenderer.ts` — show/hide call sites that currently
  use `.style.display = "none"/""`.
- Other TS show/hide call sites identified by grep in Phase 7.

Tests:

- `tests/feature-dom-contracts.spec.ts` — must still pass after class/id
  consolidation.

No database, no schema, no worker, no deployment change.

## Architecture and module boundaries

The repo's stated UI conventions (per `AGENTS.md`):

- "Use design tokens from `styles/variables.css`. Do not hardcode UI colors
  in TypeScript."
- "Use CSS classes for styling states; do not hardcode theme colors in
  TypeScript-generated inline styles."
- "If a styling change introduces or depends on a structural id, update the
  DOM contract and partial together."

This plan keeps every change inside those boundaries. No new boundary, no
contract drift. The DOM id surface is unchanged; only class names and
inline-style attributes change.

## Validation habit (every phase)

```bash
npm run typecheck
..\..\..\node_modules\.bin\esno tests\feature-dom-contracts.spec.ts
```

Plus manual smoke: open each touched tab in `npm run dev`, confirm
light/dark theme rendering and that no previously visible element is now
hidden or mis-styled.

---

## Phase 1 — Delete dead CSS

### Objective

Remove ~30 KB of CSS that styles nothing, and shrink first-paint CSS.

### Scope

Four stylesheets with high dead-selector ratios (see baseline above).
Surviving live selectors are migrated first; the files are then removed.

### Technical tasks

1. **`styles/data-viz.css` (41/55 dead)** — delete the whole file and its
   `@import` in `styles.css:13`. Every public class is unused
   (`.num-lg`, `.num-xl`, `.num-badge`, `.pct-indicator`, `.sparkline`,
   `.winrate-bar`, `.metric-card`, `.heat-indicator`, `.compare-bar`,
   `.ratio-display`, `.data-grid*`).
2. **`styles/onboarding.css` (39/54 dead)** — the entire
   `.feature-spotlight-*`, `.checklist-*`, `.getting-started-*`,
   `.help-popover*`, `.help-trigger` systems are dead (no onboarding code
   exists in `lib/`). Migrate the four live `.empty-state-*` rules into
   `styles/features/03-stats-core.css` (which already styles
   `.empty-state-illustrated`), then delete the file and its
   `@import` in `styles.css:20`.
3. **`styles/analysis-styles.css` (44/50 dead)** — only
   `.analysis-finder-table*` (one reference in `lib/polymarket-panel-service.ts`)
   survives. Migrate that block into
   `styles/features/06-settings-finder.css`, then delete the file and its
   `@import` in `styles.css:21`.
4. **`styles/chart-enhancements.css` (13/46 dead)** — keep the file but
   delete only the dead blocks: `.screenshot-modal-*` (7 selectors),
   `.trade-annotation-*` (4), `.trade-zone-overlay`.

### Dependencies

- None. Each file removal is independent.

### Risks or blockers

- A selector the grep missed: re-run the dead-selector check after each
  removal using the existing helper script pattern (extract class names,
  grep `lib/` and `html-partials/`).
- Dynamic class names built by string concatenation in TS: search for
  template literals like `` `num-${kind}` `` before deleting.
- `feature-spotlight` or `getting-started` may be referenced only in
  archived code under `archive/`; the dead check intentionally excludes
  `archive/`, but verify no live `lib/` reference remains.

### Deliverables

- Three stylesheets deleted, one pruned.
- `styles.css` import list trimmed by three lines.
- `.empty-state-*` and `.analysis-finder-table*` rules preserved in
  their new homes.

### Validation and testing criteria

- `npm run typecheck`
- `tests/feature-dom-contracts.spec.ts` passes.
- Manual: every tab partial renders identically; theme toggle still works.
- Manual: Batch, Finder, Polymarket panels render correctly (they lazy-load
  their own CSS and are unaffected by the eager `styles.css` trim, but
  verify).

### Exit criteria

Dead CSS removed; first-paint CSS measurably smaller; no visual regression
in any tab.

---

## Phase 2 — Replace inline-style row wrappers with a class

### Objective

Replace the duplicated inline-styled `param-row-header` pattern (54 inline
style attributes across 27 wrappers) with one CSS class.

### Scope

The exact string:

```html
<div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 4px;">
    <label class="param-label" style="margin-bottom: 0;">…</label>
    …
</div>
```

appears 27 times: 16 in `tab-settings-section-core.html`, 8 in
`tab-settings-section-execution.html`, 2 in `tab-monte-carlo.html`, 1 in
`tab-walkforward.html`.

### Technical tasks

1. Add to `styles/features/06-settings-finder.css`:
   ```css
   .param-row-header {
       display: flex;
       align-items: center;
       justify-content: space-between;
       margin-bottom: var(--space-1);
       gap: var(--space-2);
   }
   .param-row-header .param-label { margin-bottom: 0; }
   ```
2. Find/replace each of the 27 wrappers:
   - `<div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 4px;">` → `<div class="param-row-header">`
   - Remove the `style="margin-bottom: 0;"` from each enclosed `param-label`.
3. Verify the `<div style="display:flex;align-items:center;">` chevron+title
   wrapper (lines 3, 62, 224, 603 of `tab-settings-section-core.html` and
   similar in `tab-settings-section-execution.html`) — these collapse
   cleanly into the same class or a sibling `.section-heading-row` class
   if their layout differs. Confirm by reading each call site.

### Dependencies

- Phase 1 should land first so we know the surviving CSS surface is clean.

### Risks or blockers

- Some of the 27 wrappers have additional inline styles (e.g. specific
  `margin-top`); preserve those on a per-site basis.
- The chevron+title wrappers and the param-label wrappers may have
  different intended spacing; do not collapse them blindly if the read
  shows a divergence.

### Deliverables

- One new `.param-row-header` class.
- ~54 fewer `style=""` attributes across four partials.

### Validation and testing criteria

- Per-partial visual diff: before/after screenshots of Settings, Execution,
  Monte Carlo, Walk Forward tabs.
- `tests/feature-dom-contracts.spec.ts` passes (no id changes).

### Exit criteria

All 27 wrappers converted; no visual drift in any touched Settings
subsection (Trade Direction, Entry Confirmation, Risk Management, Trade
Sizing, Polymarket Settings).

---

## Phase 3 — Token cleanup

### Objective

Remove tokens that misrepresent the system to future contributors.

### Scope

- `--bg-highest` (uses 0 references) and its underlying `--hsl-surface-5`
  in `styles/variables.css:7, 38` (and the `.light-theme` override on
  line 215).
- `--font-size-2xs` (identical to `--font-size-xs`, both 11px, on lines
  183-184). Pick `--font-size-xs` and remove `--font-size-2xs`; replace
  all uses.
- `--space-base` defined once in `styles/media-queries.css:329`, never
  referenced.

### Technical tasks

1. `grep -rn "bg-highest\|surface-5" styles/` — verify zero uses outside
   `variables.css`. Remove from both `:root` and `.light-theme` blocks.
2. `grep -rn "font-size-2xs" styles/ html-partials/` — replace every use
   with `--font-size-xs`. Then remove the `--font-size-2xs` definition.
3. Remove the `--space-base: 3px;` line from `media-queries.css:329`.

### Dependencies

- None.

### Risks or blockers

- A token might be referenced only in inline-style attribute strings or in
  TS — extend the grep to `lib/` to be safe.

### Deliverables

- Three tokens removed; no value changes anywhere.

### Validation and testing criteria

- `npm run typecheck`
- Manual smoke: every font is the same physical size as before.

### Exit criteria

Token list is honest; nothing visually changes.

---

## Phase 4 — Small drift fixes

### Objective

Remove the three stray Unicode pictographs, fix the one JS-generated
off-theme card, and either use or delete `.stat-card.hero`.

### Scope

- `html-partials/chart-wrapper.html:25` — `▲` text arrow inside
  `.ohlc-change-arrow`. Replace with the existing SVG triangle family
  already used in `header.html:136-148` for the IN/OUT markers, or with
  an up/down triangle SVG matching the chart's trade markers.
- `html-partials/tab-rank-pairs.html:16` — `⚠` text prefix. Replace with
  the SVG warning-triangle path from `live-positions.html:50-52`.
- `lib/batch-backtest/batch-backtest-service.ts:2621` — `cssText` literal
  with hardcoded `#131722` and `#2962ff`. Replace with a class:
  ```css
  .batch-debug-card {
      background: var(--bg-secondary);
      padding: var(--space-2) var(--space-3);
      margin-bottom: var(--space-1-5);
      border-radius: var(--radius-xs);
      border-left: 3px solid var(--accent-color);
      font-size: var(--font-size-sm);
  }
  ```
  Append the class to `styles/batch-backtest.css` (lazy-loaded by the
  existing `ensureLazyStylesheet` call in the same service).
- `styles/features/03-stats-core.css:156-164` defines `.stat-card.hero`
  (zero references). Either delete it, **or** add `class="stat-card hero"`
  to `#netProfitCard` in `tab-results.html:39` and
  `#netProfitPctCard` in `tab-results.html:47` (preferred — gives the
  Results tab a clear headline metric).

### Dependencies

- None.

### Risks or blockers

- The OHLC change arrow color depends on sign at runtime; the replacement
  SVG must accept `currentColor` so the existing positive/negative class
  toggles continue to drive color.
- `.stat-card.hero` adds a 2px bottom border; verify it lines up with
  the existing grid border collapse in `.stats-grid`.

### Deliverables

- Three icon sites unified.
- One TS cssText removed.
- `.stat-card.hero` either in use or deleted.

### Validation and testing criteria

- Manual: OHLC panel shows arrow that recolors on positive/negative.
- Manual: Rank Pairs warning renders as the same triangle used by
  Live Positions.
- Manual: Batch TOP_MEAN debug cards match the Batch UI in both themes.
- Manual: Results tab shows Net Profit at a larger size if hero is enabled.

### Exit criteria

Three drift sources resolved; one or two visual wins landed.

---

## Phase 5 — Formalize the z-index scale

### Objective

Replace 14 magic-number `z-index` values with tokens.

### Scope

After Phase 1 removes the dead `9000` tier (only used by `onboarding.css`
which is being deleted), the surviving scale is:

`-1, 1, 5, 10, 20, 50, 100, 101, 1000, 2000, 2200, 9999, 10000`.

Add tokens to `styles/variables.css`:

```css
--z-behind: -1;
--z-base: 1;
--z-raised: 10;
--z-overlay: 50;
--z-popover: 100;
--z-dropdown: 1000;
--z-modal: 2000;
--z-debug: 2200;     /* debug-panel */
--z-toast: 9999;
--z-screenshot: 10000;
```

Then replace every literal `z-index:` in `styles/` with the matching
token.

### Technical tasks

1. Add the token block to `styles/variables.css` (both `:root` and
   `.light-theme` if the values are theme-independent, they can stay in
   `:root` only).
2. Sweep `styles/` and replace literals. The full list of sites is in the
   audit (33 z-index declarations across 11 files).
3. Drop the orphaned `5`, `20`, `101` values into the closest tier
   (`--z-raised`, `--z-overlay`, `--z-popover` respectively) — verify
   visual stacking is unchanged at each site.

### Dependencies

- Phase 1 must land first (so the `9000` tier from `onboarding.css` is
  already gone).

### Risks or blockers

- Modest risk of stacking regressions if a tier is collapsed incorrectly.
  Mitigation: do the sweep one file at a time with a manual smoke after
  each.

### Deliverables

- z-index tokens; every literal replaced.

### Validation and testing criteria

- Manual smoke: dropdown menus (symbol search, panel More menu,
  backtest-tools-menu), modals (code editor, alert modals),
  debug-panel, toasts, screenshot modal all stack correctly.
- `tests/feature-dom-contracts.spec.ts` passes.

### Exit criteria

No literal `z-index:` value remains in `styles/`; layering behavior
identical to before.

---

## Phase 6 — Copy and labeling pass

### Objective

Resolve the copy/casing inconsistencies that make the app feel assembled.

### Scope (per-site, all one-line edits unless noted)

- `html-partials/tab-batch-backtest.html:82, 86, 109, 136, 161` — raw
  identifiers `OPEN_SCORE USD`, `TOP_MEAN Coordinator`, `Run TOP_MEAN`.
  Convert to sentence case for user-facing copy; keep the identifiers in
  `title=` tooltips or code references. Recommended:
  `Open Score USD`, `Top-Mean Coordinator`, `Run Top-Mean`.
- Cancel vs Stop: pick **Stop** for the destructive interrupt action,
  align `tab-hunt.html:154`, `tab-walkforward.html:68`,
  `tab-monte-carlo.html:87` to `Stop` + `btn btn-danger stop-btn`.
  Verify the JS handlers don't key off the literal button label.
- Timeframe strip casing: `header.html:104-114` — pick all-uppercase for
  multi-letter labels (`1S 1M 3M 5M 15M 1H 2H 3H 4H 1D 1W`) or all-lower
  for single-letter ones. Confirm the existing `data-interval` values
  are unchanged.
- Redundant panel title: `strategy-panel-shell.html:9` "Strategy Tester"
  duplicates the header logo. Replace with the active tab name (e.g.
  "Settings"/"Results"/"Finder") updated by the existing tab-switch
  handler in `lib/strategy-panel-controller.ts`, or remove the text
  entirely and keep only the SVG.
- Section-title redundancy: drop `tab-settings-start.html:88`
  "Settings shown", `tab-monte-carlo.html:7` "Simulation Settings" →
  leave the section body untitled, `tab-hunt.html:66` "Hunt Settings" →
  leave untitled.
- `html-partials/tab-settings-section-core.html:35` — user-facing hint
  mentions "scanner" execution, but no Scanner panel exists. Remove the
  "scanner" word from the sentence (keep "backtest, finder, and
  walk-forward execution").
- `html-partials/tab-batch-backtest.html:38-39` — placeholder ends with
  a stray `♦` (`&#x2666;`). Remove the glyph.
- `html-partials/code-editor.html:29-32` — `calculateSMA` and
  `calculateEMA` are each listed twice. Remove the duplicates.
- `tab-settings-start.html:83` `Delete…` ellipsis — keep as-is (correct
  for a destructive action that opens a confirmation), but verify other
  delete buttons (`tab-settings-end.html:16 Reset to Default`,
  `tab-finder.html:299 Reset Settings`) use a consistent verb.

### Dependencies

- None.

### Risks or blockers

- The strategy-panel title change requires the tab-switch controller to
  update the title text on tab change; if that handler is brittle, defer
  to a follow-up and just remove the text for now.
- Button-label changes may break tests that assert on label text; search
  `tests/` for the affected strings.

### Deliverables

- ~15 one-line copy fixes.
- One strategy-panel title behavior change (or text removal).

### Validation and testing criteria

- `tests/feature-dom-contracts.spec.ts` (some assertions may need a
  label-text update; they belong to this phase).
- Manual: open every touched tab and read the labels aloud.

### Exit criteria

All listed copy issues resolved; no broken label-text test assertions.

---

## Phase 7 — Unify show/hide strategy (is-hidden vs inline display)

### Objective

Replace the ~80 `style="display: none;"` attributes and the JS
`.style.display = "none"/""` toggles with the `.is-hidden` class.

### Scope

Today the codebase mixes two hide strategies:

- `.is-hidden` class (`styles/components/02-tool-dropdown.css:151`,
  defined as `display: none !important`).
- Inline `style="display: none;"` (most prevalent in
  `tab-settings-section-core.html`, `tab-results.html`).
- JS toggling via `el.style.display = "none"` / `el.style.display = ""`.

These do not compose: `.is-hidden` cannot override an inline
`style="display:none"`, so a class-toggle off will not reveal an element
that was hidden inline.

### Technical tasks

1. In `html-partials/tab-results.html`, replace all 18
   `style="display: none;"` with `class="… is-hidden"` (preserving
   existing classes).
2. In `lib/renderers/resultsRenderer.ts`, replace every
   `el.style.display = "none"` with `el.classList.add("is-hidden")` and
   every `el.style.display = ""` with `el.classList.remove("is-hidden")`.
3. Repeat for the other partials with inline `display:none`:
   `tab-settings-section-core.html`, `tab-settings-section-execution.html`,
   `tab-monte-carlo.html`, `tab-finder.html`, `tab-alerts.html`.
4. Sweep `lib/` for `.style.display = "none"` and `.style.display = ""`
   and convert each to classList toggles. There are ~80 such assignments;
   most are in renderers and managers (audit listed
   `lib/finder-manager.ts`, `lib/handlers/live-positions-handlers.ts`,
   `lib/strategy-panel-controller.ts`, `lib/finder/finder-ui.ts`).
5. Leave alone the chart/canvas positioning styles
   (`lib/chart-manager.ts`, `lib/monte-carlo-renderer.ts`) — those are
   not display toggles.

### Dependencies

- None strictly, but lands cleanly after Phases 1–6.

### Risks or blockers

- Some elements are shown with `display: flex` or `display: grid` rather
  than block. Removing `.is-hidden` restores the stylesheet's
  `display` value, which is the right behavior — but verify each
  element's natural display value matches what the inline toggle was
  setting.
- Some toggles use `.style.display = "block"` or `"flex"` explicitly;
  those need the classList conversion to *not* set a display value
  (the stylesheet must already declare the right one). Add the display
  rule to the partial's class if missing.

### Deliverables

- ~80 fewer inline `display:` styles.
- ~80 classList conversions in `lib/`.
- One consistent show/hide mechanism.

### Validation and testing criteria

- `npm run typecheck`
- `tests/feature-dom-contracts.spec.ts`
- Manual: every section that was hidden by default appears and disappears
  correctly. Settings subsections, Results advanced analytics, Finder
  universe/polymarket toggles, Alert modals.

### Exit criteria

Zero `style="display:` attributes in `html-partials/`; zero
`.style.display =` assignments outside chart/canvas code in `lib/`.

---

## Phase 8 — Unify boolean control patterns

### Objective

Collapse the 7 distinct boolean-toggle markup patterns down to 2.

### Scope

Per the HTML audit, the current patterns are:

1. `.section-toggle.section-toggle--sm` + separate `<label>` (Settings
   header strip).
2. `.section-toggle` full size in section header.
3. Bare `<input type="checkbox">` + `param-label` (Finder Polymarket
   options).
4. `<label class="param-label hunt-inline-toggle">` wrapping checkbox +
   `<span>` (Hunt).
5. `<label class="checkbox-label">` wrapping checkbox (Hunt, second
   pattern).
6. `<label class="toggle-label" style="font-size:0.78rem;">` with trailing
   text node (Alerts).
7. Checkbox inside `<label class="param-group">` with no switch chrome
   (Execution Lab, Batch).

Target: two patterns only.

- **Switch** (`.section-toggle`) — primary toggle in a row.
- **Inline checkbox** — `.checkbox-row` (new) for low-emphasis
  sub-options. Replace `.checkbox-label`, `.toggle-label`,
  `.hunt-inline-toggle`.

### Technical tasks

1. Define `.checkbox-row` in `styles/components/05-toggles-modal-theme.css`
   next to the existing `.section-toggle` rules. Include the
   `font-size:0.78rem` from `tab-alerts.html:43` so the inline-style
   escape hatch is no longer needed.
2. Migrate `tab-finder.html:187-188`, `tab-hunt.html:68-71, 112-115,
   120-121`, `tab-alerts.html:43-45`, `tab-execution-lab.html:71-74`,
   `tab-batch-backtest.html:170-171` to one of the two patterns.
3. Delete `.checkbox-label`, `.toggle-label`, `.hunt-inline-toggle` class
   definitions after migration.
4. The "Polymarket Lock Offset" control appears as a bare checkbox in
   both `tab-finder.html:187` and `tab-hunt.html:120`; both should match
   the surrounding sibling toggles' pattern in their respective files.

### Dependencies

- Phase 2 (param-row-header) should land first; many of these checkboxes
  sit inside a row that already needs the header class.

### Risks or blockers

- `tab-alerts.html:43` inline font-size is a real signal that the existing
  toggle classes don't fit a compact row. Make sure `.checkbox-row` actually
  fits before removing the inline style.
- Test selectors that key off `.toggle-label` or `.checkbox-label`: search
  `tests/` and `lib/`.

### Deliverables

- 5 of 7 boolean patterns removed.
- One new `.checkbox-row` class.
- Three deprecated classes deleted.

### Validation and testing criteria

- Manual: every settings row in Finder, Hunt, Alerts, Execution Lab,
  Batch reads consistently with its neighbors.
- `tests/feature-dom-contracts.spec.ts` passes.

### Exit criteria

Two boolean control patterns remain; no inline-style escape hatches.

---

## Phase 9 — Adaptive TP DOM deduplication

### Objective

Collapse the 5-copy duplicated Adaptive TP settings block into one shared
block the JS already knows how to sync.

### Scope

`html-partials/tab-settings-section-core.html` lines 412-517 contain
five near-identical copies of three inputs (Min TP Multiplier, Max TP
Multiplier, Lookback Trades), one per `data-tp-mode-panel`:
`expectancy_optimal`, `regime_calibrated`, `information_coefficient`,
`path_efficiency`, `serial_dependency`, `minimum_surprisal`.

The JS layer already treats them as shared — every input carries
`data-shared-tp-field="<name>"`, and there are 17 such attributes for
what is logically 3 settings. The DOM is fighting the JS abstraction.

### Technical tasks

1. **Verify the JS path before changing the DOM.** Find the handler that
   resolves `data-shared-tp-field` (search `lib/` for that attribute
   name). Document the current sync semantics: when one panel's input
   changes, are the other four updated programmatically?
2. Decide the layout: either
   - **(a)** Render the three inputs once, outside the mode panels, and
     show/hide the block conditionally on the selected TP mode; or
   - **(b)** Keep one canonical copy inside a reference panel and have
     the JS populate the other panels on mode change.
   Prefer (a) — fewer DOM nodes, one source of truth.
3. Remove the duplicated `param-row` blocks from the per-mode panels,
   leaving only mode-specific inputs in each panel.
4. Verify the existing settings persistence round-trip
   (`lib/settings-manager.ts` → localStorage → restore) still reads
   and writes the same param keys.

### Dependencies

- Phase 2 (param-row-header) — the surviving TP row will use the new
  class.

### Risks or blockers

- This phase touches both markup and JS. The JS path must be understood
  before any HTML is removed. If the handler does anything stateful per
  panel (e.g. tracks "last edited in panel X"), that state needs to be
  preserved or removed deliberately.
- Adaptive TP params are part of the persisted settings blob; verify
  no schema migration is implied.
- WFA/Finder may read these params; verify they don't expect per-panel
  copies.

### Deliverables

- ~80 lines of HTML removed.
- One canonical Adaptive TP controls block.
- Documented JS sync semantics.

### Validation and testing criteria

- `npm run typecheck`
- `tests/feature-dom-contracts.spec.ts`
- `..\..\..\node_modules\.bin\esno tests\backtesting-engine.spec.ts`
- Manual: cycle through every TP mode in the Settings UI; confirm the
  three shared inputs retain their values, that changing them in one
  mode shows the new values when returning to that mode, and that a Run
  Backtest uses the correct values per mode.
- Manual: save and reload — persisted TP settings restore correctly.

### Exit criteria

Five duplicated blocks reduced to one; all TP modes still configure,
persist, and execute correctly.

---

## Performance

- Phase 1 reduces first-paint CSS by ~30 KB.
- Phases 2, 7, 9 reduce DOM node count in the Settings tab (Phase 9
  removes ~80 lines of duplicated markup).
- No phase adds runtime cost. No new transition, animation, or effect.

## Failure handling and edge cases

- If a phase introduces a regression, revert the phase's commit in
  isolation — phases are ordered to be independently shippable.
- The lazy-loaded feature stylesheets (`alerts.css`, `batch-backtest.css`,
  `data-mining.css`, `execution-lab.css`, `hunt.css`, `polymarket.css`,
  `quick-view.css`, `scanner-styles.css`) are *not* touched by this plan
  except where explicitly noted (Phase 4 adds `.batch-debug-card` to
  `batch-backtest.css`).

## Rollback strategy

Each phase is one PR-sized commit. Rollback = revert the commit. No
migration, no settings-shape change, no persistence drift. Phases 1, 3, 5
are pure deletion/sweep and trivially revertible. Phases 7, 8, 9 touch
behavior and warrant a clean revert commit message describing the
regression observed.

## Open questions

- `.stat-card.hero` (Phase 4): use it for `#netProfitCard`, or delete it?
  Preference is to use it; needs one visual check.
- Strategy-panel title (Phase 6): dynamic-per-tab text vs. icon-only?
  Dynamic is nicer; icon-only is safer if the tab-switch controller is
  brittle.
- Phase 9 layout choice (a) vs. (b): must read the
  `data-shared-tp-field` handler in `lib/` before deciding.
- Stability check UI in `tab-batch-backtest.html:168-180` — out of scope
  for this plan. Per `AGENTS.md`, "Stability Mine — removed" but the UI
  is still wired to live JS. Confirm with the user whether this is a
  retained feature with a confusing name or a leftover to remove in a
  separate change.

## Sequencing summary

| Phase | Effort | Risk | Depends on |
|---|---|---|---|
| 1 — Dead CSS | ~30 min | Low | — |
| 2 — param-row-header | ~30 min | Low | 1 |
| 3 — Token cleanup | ~15 min | Low | — |
| 4 — Drift fixes | ~1 hr | Low | — |
| 5 — z-index tokens | ~30 min | Low-Med | 1 |
| 6 — Copy pass | ~1 hr | Low | — |
| 7 — is-hidden unification | ~2 hr | Medium | 1–6 |
| 8 — Boolean patterns | ~4 hr | Medium | 2 |
| 9 — Adaptive TP dedup | ~4 hr | Medium-High | 2 |

Phases 1–6 deliver most of the perceived-quality lift for ~3 hours of
work. Phases 7–9 are larger cleanups that can land independently over a
longer period.
