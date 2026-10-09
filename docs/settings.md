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

For multiple configurations, expand **Bulk delete configurations**, check the configurations to remove (or use **Select all**), then click **Delete selected…**. The confirmation lists the selected names. The checklist follows the dropdown's newest-first order and keeps checked items when configurations are saved or imported. Bulk selection does not load or apply a configuration. The entire selection is deleted in one storage write; if a selected configuration has disappeared or storage rejects the write, none are deleted and the selection remains available for retry. Successful deletion refreshes the dropdown and checklist, notifies configuration consumers, and clears tracking if the loaded configuration was deleted.

The bulk checklist supports **Shift-click**: click one configuration, then hold Shift and click another to set the entire range to the second checkbox's new state. Ranges work in either direction, including clearing checked ranges, and use the current displayed order. The last clicked configuration remains the anchor across list refreshes while it still exists. Select all or deleting the anchor resets the range anchor.

## Strategy selection ownership

The strategy selector owns its in-flight selection intent centrally in `lib/ui-manager.ts` (`beginStrategySelection`, `ownsStrategySelection`, `settleStrategySelection`, `cancelPendingStrategySelection`). Every selection request runs under a monotonic generation: the picked option stays visible while its strategy loads, renders and commits from superseded requests are dropped, and only the request that still owns the intent may settle it. External configuration application (settings restore, strategy-config apply, live-position navigation) cancels the pending intent, so a stale user selection can never commit over the externally applied setup — including same-key restores. While a pending key is not listed yet (for example a not-yet-registered custom strategy), the dropdown keeps the user's intent instead of falling back to the first listed strategy.

Finder Apply joins the same boundary: all four Apply flows (Current Chart, Universe, Asset Opportunity, Arm Performance; `lib/finder/browser/finder-result-actions.ts`) load the strategy first — so a missing strategy aborts without touching ownership — and then cancel the pending intent before committing, meaning a dropdown selection that was still loading when Apply ran can never commit over the applied result, its metadata, parameters, or applied backtest settings.

Every successful `applyStrategyConfig` also re-asserts the dropdown option through the same owner — including same-key restores, where the state subscription does not fire — so a pending (cancelled) selection cannot leave the dropdown describing a strategy the restored configuration replaced. Parameter rendering has independent render ownership in `updateStrategyParams`: each call starts a render generation, and a render whose lazy load settles after a newer render started — or after another key was committed — is dropped without touching the form. This survives selection settlement and cancellation because the generation only advances when a newer parameter render actually starts; already-loaded strategies still render synchronously, and restores keep their parameter values.

`tests/strategy-selection.browser.spec.ts` pins these races, including rapid selection switching, restore-during-selection, Finder Apply across all four scopes, and stale render/settle cases.

## Exit Strategy Override retention

A failed or unavailable exit-strategy selection (`lib/handlers/exit-strategy-override-handler.ts`) rolls the whole sub-section back to a retained configuration snapshot: the dropdown key, the rendered form, the hidden JSON, and the handler's internal strategy all restore to the last successful selection with its effective parameters. The hidden input is treated as mutable incoming configuration, not a rollback source — pending incoming settings for another key (settings restores, Finder Apply) do not overwrite the snapshot, while legitimate edits to the active configuration and same-key incoming updates do. Stale failures (a newer selection already rendered) surface nothing and roll nothing back.

## Compatibility-only settings

Some retired controls no longer have UI or execution behavior: the advanced-risk fields (partial take-profit, break-even, time-stop, and win-streak stop-loss values), `marketMode`, and `allowSameBarExit`. The resolver (`lib/backtest-settings-resolver.ts`) still accepts these fields so older saved payloads and legacy raw JSON keep loading without a migration, but `applyRemovedBacktestSettingDefaults` forces them to fixed inert values as the final step of every resolution. None of them have DOM contracts. Their Rust wire contract is mixed: `marketMode` and the win-streak fields are stripped from Rust payloads by `lib/rust-settings-sanitizer.ts`, while `partialTakeProfitAtR`, `partialTakeProfitPercent`, `breakEvenAtR`, `breakEvenPercent`, `timeStopBars`, and `allowSameBarExit` are forwarded to the Rust engine with their inert values. Do not add new controls or resolver rules for them.

## Shared value parsers

The DOM settings contract keeps the fields used for form capture/restore and
Rust parity checks. Retired strategy-kind UI metadata and unread
`workerSupport`/`legacyAliases` annotations have been removed; saved-setting
compatibility remains in the settings model and resolver.

Three setting-value interpretations have one owner in `lib/backtest-settings-resolver.ts`: entry-confirmation move (`resolveEntryConfirmationMove`, with an optional fallback so callers keep their own default), confirmation mode (`readConfirmationMode`), and strategy-name lists (`readStringArray`). Both the raw resolver and the DOM settings contract (`lib/backtest-settings-dom-contract.ts`) call these helpers, so an accepted mode or list rule changes in one place. Their toggle gating, fallback sources, and storage/DOM responsibilities stay separate; numeric and JSON parameter parsing intentionally differs between the capture and DOM paths and is not shared. `settings-compat.spec.ts` pins the DOM/raw parity for all supported enum values and list shapes.

## Owners and checks

- Markup: `html-partials/tab-settings-*.html`; required workspace IDs: `lib/ui-manager-dom.ts`.
- Workspace layout: `styles/settings-ux.css`; navigation and summaries: `lib/handlers/settings-workspace.ts` and `lib/settings-workspace-model.ts`.
- Existing section/preset behavior: `lib/handlers/settings-ux-handlers.ts`, `lib/handlers/settings-section-handlers.ts`, and `lib/strategy-panel-settings-registry.ts`.
- Persistence and configuration feedback: `lib/settings-manager.ts`; restore wiring: `lib/handlers/settings-handlers.ts`.
- Bulk deletion controls: `lib/handlers/settings-handlers-dom.ts` (`SETTINGS_BULK_DELETE_REQUIRED_IDS`); layout: `styles/settings-ux.css`.

Saved payloads continue through `lib/persisted-json.ts`; these UI features add no persisted fields or migrations. Validate with `npm run typecheck`, `npm run typecheck:tests`, focused `settings-handlers.browser.spec.ts`, `settings-workspace.spec.ts`, `settings-compat.spec.ts`, `strategy-panel-settings-registry.spec.ts`, and `feature-dom-contracts.spec.ts` tests, plus `npm run test:e2e` for navigation, configuration restore, save feedback, and responsive layout.
