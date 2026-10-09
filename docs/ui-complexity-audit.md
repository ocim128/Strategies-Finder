# UI complexity audit — implemented

Status: all thirteen recommendations were implemented on 10 October 2026, including the explicitly authorized removal of Quick View and shared-link automatic backtesting. Scope was active UI and its validation; archive folders and execution engines were excluded.

This record replaces the pre-change audit. Current behavior is maintained in [Settings](settings.md), [Testing](testing.md), and the [application overview](../README.md).

## Delivered changes

| Audit finding | Implementation |
| --- | --- |
| 1. Obsolete bootstrap graph test | Deleted its parser/spec. Startup stays sequential. The runner detects streamed TAP failures even when Node exits zero, while preserving expected TODO/SKIP semantics. |
| 2. Retired-screen CSS | Deleted entry-preview and parity styles and the strategy-option/analysis-table stylesheets; removed Quick View CSS with the feature. |
| 3. Animation catalog | Deleted unused utility selectors and keyframes. Active animations and reduced-motion support remain. |
| 4. Hidden settings scaffolding | Deleted the hidden workspace toggle/key, their contract entries and write paths, and the dormant accordion initializer. Runtime presets are Simple/Standard; saved Advanced maps to Standard. |
| 5. Mirrored take-profit fields | Each adaptive setting has one canonical input. Mode metadata controls visibility/enabled state; mirrors and synthetic propagation events are gone. Persisted IDs/values remain compatible. |
| 6. Runtime settings repair | HTML defines final section order. Native details/summary handles disclosure; section navigation opens the native element directly. Runtime reordering, target repair, manual keyboard disclosure, and rank-based presets are gone. |
| 7. Navigation bookkeeping | Container event delegation, one AbortController lifetime, and one panel collection replace listener maps and separate secondary-panel visibility state. Teardown cancels frames and active resize capture. |
| 8. DOM cache | Required/optional helpers perform direct ID lookup. Deleted global cache, connectivity eviction, clearing API, and relay lookup. Useful feature-local DOM contracts remain. |
| 9. Generic/unread rendering | Deleted the single-consumer generic card/table helper and unused diagnostic export along with Quick View. |
| 10. Bootstrap telemetry | Settings restore uses the existing step boundary with an explicit restore handler; duplicated timing/error logic is gone. |
| 11. Manual CSS loader | Lazy feature modules import their CSS. Deleted the stylesheet injector and caller IDs. Fake-browser bundling omits CSS; Opportunity Explorer's browser lifecycle spec now uses the browser-spec suffix. |
| 12. Shared-link auto-run | Deleted timers, data fingerprints, and duplicate settings-readiness comparisons. Links load their setup and prompt the recipient to click Run. Token consumption, view restrictions, and synthetic-pair application remain. |
| 13. Quick View | Deleted the overlay, its lifecycle/rendering/stylesheet/specs/loading triggers. The toolbar now opens Results; Trades retains diagnostics and jump-to-trade navigation. |

## Behavior and compatibility

- Results and Trades own backtest inspection. No automatic overlay appears after a result.
- Shared links require an explicit Run click after loading their configuration/data context.
- Settings disclosures use native keyboard and focus behavior; feature switches do not collapse their section.
- Mode changes retain canonical take-profit edits, and configuration restore/autosave still use existing setting shapes.
- Saved historical Advanced display preferences normalize to Standard at the read boundary.
- Lazy-tab deduplication, loading/error feedback, dev Retry, production Reload, strategy/result ownership generations, accessibility, and persisted JSON compatibility were retained.
- No dependencies, engine algorithms, Rust/Worker wire contracts, or archive contents changed.

## Measured reduction

The presentation baseline selected 74 TypeScript files, 44 stylesheets, and 23 partials: 33,452 physical lines. Mixed services were inspected but not all counted in that denominator. Source counts include comments/whitespace; they are not a measure of product adoption or build speed.

Application edits remove **2,562 net lines**, including the styled feature service import boundaries. That is roughly **7.7%** relative to the narrower presentation baseline. Tests remove another **459 net lines**, and the runner adds **13 net lines**: **3,008 net code lines removed**, excluding documentation. Eight application modules and two obsolete UI-support specs disappear. Test additions cover actual behavior; the renamed Opportunity Explorer spec is counted as a move. Final measurements are stored under `artifacts/ui-cleanup-measurements.json`.

Deleted mechanisms include the global DOM cache and its invalidation API, manual stylesheet loader, hidden accordion path, generic card API, preset ranking, take-profit mirror synchronization, source-parsed bootstrap graph, parallel listener maps/teardown loops, separate secondary-panel state, auto-run polling/readiness protocol, and the Quick View lifecycle/rendering surface.

Maintenance savings remain estimates: the removed duplicated state and obsolete ownership paths should reduce recurring UI work, but no percentage of product value or build-time improvement was measured. Quick View and auto-run were removed on explicit user instruction rather than an adoption-data claim.

## Validation and regression coverage

Required checks are full JavaScript CI (`npm run ci`) and browser E2E (`npm run test:e2e`), selected by `npm run validate:changes`. The CI command includes dependency checks, application/test typechecks, all specs, a production build, and entry/startup bundle budgets.

Both commands passed on the final source: **268/268 specs**, both typechecks and dependency preflight, production build, and browser E2E. The entry is **594.4 / 650 KiB** and combined startup JavaScript **765.2 / 850 KiB**. `git diff --check` and local report-link checks pass. Full spec logs are preserved under `artifacts/ui-cleanup-ci-tests/`; the final real-browser log is `artifacts/ui-cleanup-e2e.log`.

Browser E2E covers:

- All take-profit modes, canonical edits across mode changes, settings restoration, disabled state, and autosave.
- Search/section shortcuts, native Enter/Space disclosure, embedded feature switches, and desktop/mobile layout.
- Navigation reinitialization without duplicate handlers, allowed-tab restrictions, keyboard/focus behavior, the Results shortcut, and teardown during a pointer resize.
- Shared-link setup without an automatic backtest, explicit Run, consumed URL token, and historical Advanced preset compatibility.
- Existing Finder/Batch/Monte Carlo flows, Trades navigation, live-position modal ownership, and lazy-tab failure/recovery.
- Production chunk recovery at both root and non-root URL bases.

The runner contract spec reproduces suite-construction failure with an isolated copied runner. Its raw log can report failure even when the child exits zero; the outer run must fail. An expected failing TODO remains an accepted outcome. Browser lifecycle specs continue to use fake DOMs; rendered behavior is established separately by Puppeteer.

No Rust checks were selected: changes do not affect Rust source or wire behavior. JavaScript Rust-parity specs remain part of full CI. Archive content was neither edited nor reviewed.

## Retained boundaries

Keep lightweight-charts/Vite, feature-local DOM contracts, lazy activation/recovery, publication ownership, bounded progressive Trades rendering, frame coalescing/debounce, canonical time/price helpers, settings coercion/persistence, and accessibility. These have current requirements. No UI framework, component generator, event bus, or plugin system was introduced.
