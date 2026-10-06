# Settings menu

The Settings menu keeps strategy selection, strategy parameters, Library Tools, and saved configurations together. When the Settings panel has at least 960px of usable width, these occupy the left column and execution settings occupy the right. Narrower panels stack the same controls without changing their values or order.

## Navigation and summaries

Direction, Risk, Sizing, Confirmation, Execution, and Engine shortcuts open and focus the corresponding section. Search matches control labels and their explanatory text, including strategy parameters. Enter opens the first search result; Escape clears the search. Navigation to a section hidden by Simple mode selects Standard through the existing preset controls. Navigation never enables risk, confirmation, or other features. If a control is inactive for the current feature/mode, its result says so and focuses the section header instead.

Section headers show live summaries even while collapsed. These refresh after edits, loading or restoring configurations, resetting defaults, and changing strategies. Engine summaries describe the preference; actual engine selection still depends on availability and supported settings.

## Saving and restoring

General settings retain the existing debounced browser autosave. The status reports pending writes, successful writes, and storage failures. Editing search or configuration names does not schedule an autosave. Strategy parameters are kept through named configurations, rather than the general-settings autosave.

After saving or applying a named configuration, the menu tracks the effective strategy key, parameters, and all backtest settings in memory. It reports **Matches saved setup** or **Modified**, independently of general-settings autosave. Editing and then restoring a field to its earlier value clears Modified. This comparison excludes chart symbol/timeframe and display preferences.

**Restore configuration** reapplies the tracked configuration using the existing serialized user configuration loader, including its chart symbol/timeframe and synthetic-pair regeneration. Selecting another configuration in the dropdown alone does not change the tracked setup. Saving again updates the tracked setup; deleting its saved configuration clears tracking. The tracking state resets on page reload. Autosave does not overwrite named configurations.

Deletion reports success and refreshes configuration consumers only after the storage write succeeds. If browser storage rejects the write or the selected configuration is no longer saved, the menu reports a failure and keeps the selection available for retry. A failed storage write preserves the saved configuration and its tracking state.

## Compatibility-only settings

Some retired controls no longer have UI or execution behavior: the advanced-risk fields (partial take-profit, break-even, time-stop, and win-streak stop-loss values), `marketMode`, and `allowSameBarExit`. The resolver (`lib/backtest-settings-resolver.ts`) still accepts these fields so older saved payloads and legacy raw JSON keep loading without a migration, but `applyRemovedBacktestSettingDefaults` forces them to fixed inert values as the final step of every resolution. None of them have DOM contracts. Their Rust wire contract is mixed: `marketMode` and the win-streak fields are stripped from Rust payloads by `lib/rust-settings-sanitizer.ts`, while `partialTakeProfitAtR`, `partialTakeProfitPercent`, `breakEvenAtR`, `breakEvenPercent`, `timeStopBars`, and `allowSameBarExit` are forwarded to the Rust engine with their inert values. Do not add new controls or resolver rules for them.

## Shared value parsers

Three setting-value interpretations have one owner in `lib/backtest-settings-resolver.ts`: entry-confirmation move (`resolveEntryConfirmationMove`, with an optional fallback so callers keep their own default), confirmation mode (`readConfirmationMode`), and strategy-name lists (`readStringArray`). Both the raw resolver and the DOM settings contract (`lib/backtest-settings-dom-contract.ts`) call these helpers, so an accepted mode or list rule changes in one place. Their toggle gating, fallback sources, and storage/DOM responsibilities stay separate; numeric and JSON parameter parsing intentionally differs between the capture and DOM paths and is not shared. `settings-compat.spec.ts` pins the DOM/raw parity for all supported enum values and list shapes.

## Owners and checks

- Markup: `html-partials/tab-settings-*.html`; required workspace IDs: `lib/ui-manager-dom.ts`.
- Workspace layout: `styles/settings-ux.css`; navigation and summaries: `lib/handlers/settings-workspace.ts` and `lib/settings-workspace-model.ts`.
- Existing section/preset behavior: `lib/handlers/settings-ux-handlers.ts`, `lib/handlers/settings-section-handlers.ts`, and `lib/strategy-panel-settings-registry.ts`.
- Persistence and configuration feedback: `lib/settings-manager.ts`; restore wiring: `lib/handlers/settings-handlers.ts`.

Saved payloads continue through `lib/persisted-json.ts`; these UI features add no persisted fields or migrations. Validate with `npm run typecheck`, `npm run typecheck:tests`, focused `settings-handlers.browser.spec.ts`, `settings-workspace.spec.ts`, `settings-compat.spec.ts`, `strategy-panel-settings-registry.spec.ts`, and `feature-dom-contracts.spec.ts` tests, plus `npm run test:e2e` for navigation, configuration restore, save feedback, and responsive layout.
