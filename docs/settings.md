# Settings menu

The Settings menu keeps strategy selection, strategy parameters, Library Tools, and saved configurations together. When the Settings panel has at least 960px of usable width, these occupy the left column and execution settings occupy the right. Narrower panels stack the same controls without changing their values or order.

## Navigation and summaries

Direction, Risk, Sizing, Confirmation, Execution, and Engine shortcuts open and focus the corresponding section. Search matches control labels and their explanatory text, including strategy parameters. Enter opens the first search result; Escape clears the search. Navigation to a section hidden by Simple mode selects Standard through the existing preset controls. Navigation never enables risk, confirmation, or other features. If a control is inactive for the current feature/mode, its result says so and focuses the section header instead.

Section headers show live summaries even while collapsed. These refresh after edits, loading or restoring configurations, resetting defaults, and changing strategies. Engine summaries describe the preference; actual engine selection still depends on availability and supported settings.

## Saving and restoring

General settings retain the existing debounced browser autosave. The status reports pending writes, successful writes, and storage failures. Editing search or configuration names does not schedule an autosave. Strategy parameters are kept through named configurations, rather than the general-settings autosave.

After saving or applying a named configuration, the menu tracks the effective strategy key, parameters, and all backtest settings in memory. It reports **Matches saved setup** or **Modified**, independently of general-settings autosave. Editing and then restoring a field to its earlier value clears Modified. This comparison excludes chart symbol/timeframe and display preferences.

**Restore configuration** reapplies the tracked configuration using the existing serialized user configuration loader, including its chart symbol/timeframe and synthetic-pair regeneration. Selecting another configuration in the dropdown alone does not change the tracked setup. Saving again updates the tracked setup; deleting its saved configuration clears tracking. The tracking state resets on page reload. Autosave does not overwrite named configurations.

## Owners and checks

- Markup: `html-partials/tab-settings-*.html`; required workspace IDs: `lib/ui-manager-dom.ts`.
- Workspace layout: `styles/settings-ux.css`; navigation and summaries: `lib/handlers/settings-workspace.ts` and `lib/settings-workspace-model.ts`.
- Existing section/preset behavior: `lib/handlers/settings-ux-handlers.ts`, `lib/handlers/settings-section-handlers.ts`, and `lib/strategy-panel-settings-registry.ts`.
- Persistence and configuration feedback: `lib/settings-manager.ts`; restore wiring: `lib/handlers/settings-handlers.ts`.

Saved payloads continue through `lib/persisted-json.ts`; these UI features add no persisted fields or migrations. Validate with `npm run typecheck`, `npm run typecheck:tests`, focused `settings-workspace.spec.ts`, `settings-compat.spec.ts`, `strategy-panel-settings-registry.spec.ts`, and `feature-dom-contracts.spec.ts` tests, plus `npm run test:e2e` for navigation, configuration restore, save feedback, and responsive layout.
