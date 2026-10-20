/**
 * Finder control registry: one declarative table for the simple Finder menu
 * controls whose persisted value is a direct scalar mapping to a single DOM
 * control. Browser-only.
 *
 * Why this exists
 * ---------------
 * Before this module, every simple control had to be edited in THREE parallel
 * hand-maintained lists:
 *   1. `applyPersistedUiStateToDom` (state -> DOM write),
 *   2. `captureFinderUiState` (DOM -> state read),
 *   3. `initFinderSettingsPersistenceUI` (input/change -> capture wiring).
 * Forgetting one list silently broke persistence or restore for that control.
 *
 * The table below is the single source of truth for those three concerns. Each
 * entry declares the control's DOM key, the persisted-state key it maps to, how
 * the value is read from the DOM and written back, and which scopes the control
 * belongs to. The controls owner consumes `FINDER_CONTROL_BINDINGS` to:
 *   - write state into the DOM (`applyBindingToDom`),
 *   - read the DOM into state (`readBindingFromDom`),
 *   - wire the debounced persistence listeners for every simple control.
 *
 * Deliberately NOT covered here (they keep explicit handling in the controls
 * owner because their shape is not a scalar, or their read/write policy differs
 * between the capture and submission boundaries):
 *   - the advanced sort list (an ordered, checkbox-bearing container),
 *   - the strategy selection checkboxes,
 *   - the universe symbols textarea (its value is a multi-line text blob),
 *   - the Asset Opportunity batch start/end pair (validated as a unit),
 *   - the Arm Performance enum/horizon group (derived via helpers),
 *   - any control whose capture clamps differently from submission.
 */
import type { FinderManagerDom } from "../finder-manager-dom";
import type { FinderPersistedUiState } from "./finder-settings";
import { parseInputNumber } from "../../dom-input-readers";

/** The persisted-state keys that map 1:1 to a single Finder menu control. */
export type FinderBoundStateKey =
	| "sortPrimary"
	| "sortSecondary"
	| "dataSlice"
	| "dataRangeFrom"
	| "dataRangeTo"
	| "topN"
	| "maxRuns"
	| "rangePercent"
	| "steps"
	| "freezeRiskManagement"
	| "exitStrategyOverrideEnabled"
	| "tradeFilterEnabled"
	| "minTrades"
	| "maxTradesText"
	| "oosValidationEnabled"
	| "universeMinActiveSymbols"
	| "universeMinTotalTrades"
	| "universeMinProfitableActiveRatio"
	| "universeRankingEnabled"
	| "assetOpportunityCandidatePoolSize"
	| "assetOpportunityMinFreshSupport"
	| "assetOpportunityIncludeOpenPositions"
	| "assetOpportunityOosMeasurementMode"
	| "assetOpportunityOosIgnoreLastBars"
	| "assetOpportunityEvalWindowMode"
	| "assetOpportunityEvalWindowBars"
	| "assetOpportunityOosBatchEnabled"
	| "armPerformanceHorizon"
	| "armPerformanceMeasurement"
	| "armPerformanceRankingSort"
	| "armPerformanceRankingTopK"
	| "armPerformanceReplayMode"
	| "armPerformanceExcludeTopContributor"
	| "armPerformanceEventFilterEnabled"
	| "armPerformanceMinEvents"
	| "armPerformanceMaxEventsText"
	| "armPerformanceSelectionCooldownEnabled"
	| "armPerformanceSelectionCooldownBars";

/**
 * How a control's DOM value is read into state.
 *
 * - `text`: raw trimmed string (checkbox/date/optional-number-text controls).
 * - `number`: parsed finite number, clamped to `min`, falling back to the
 *   current state value when the input is not a readable number.
 * - `boolean`: `checked` flag.
 * - `select`: the raw `value` string (normalizers run at the call site so the
 *   read stays allocation-free).
 */
export type FinderControlRead = "text" | "number" | "boolean" | "select";

export interface FinderControlBinding {
	/** Key on the DOM bundle returned by `createFinderManagerDom`. */
	domKey: keyof FinderManagerDom;
	/** Persisted-state field this control owns. */
	stateKey: FinderBoundStateKey;
	read: FinderControlRead;
	/** Inclusive lower bound applied to `number` reads. */
	min?: number;
	/** Control id used for the registry test contract. */
	id: string;
}

/**
 * The simple Finder menu controls. Order is the DOM write order used when
 * restoring persisted state; it mirrors the previous hand-written order so
 * downstream sync hooks observe the same intermediate values.
 */
export const FINDER_CONTROL_BINDINGS: readonly FinderControlBinding[] = [
	{ domKey: "finderSort", stateKey: "sortPrimary", read: "select", id: "finderSort" },
	{ domKey: "finderSortSecondary", stateKey: "sortSecondary", read: "select", id: "finderSortSecondary" },
	{ domKey: "finderDataSlice", stateKey: "dataSlice", read: "select", id: "finderDataSlice" },
	{ domKey: "finderDataRangeFrom", stateKey: "dataRangeFrom", read: "text", id: "finderDataRangeFrom" },
	{ domKey: "finderDataRangeTo", stateKey: "dataRangeTo", read: "text", id: "finderDataRangeTo" },
	{ domKey: "finderTopN", stateKey: "topN", read: "number", min: 1, id: "finderTopN" },
	{ domKey: "finderMaxRuns", stateKey: "maxRuns", read: "number", min: 1, id: "finderMaxRuns" },
	{ domKey: "finderRange", stateKey: "rangePercent", read: "number", min: 0, id: "finderRange" },
	{ domKey: "finderSteps", stateKey: "steps", read: "number", min: 2, id: "finderSteps" },
	{ domKey: "finderFreezeRiskManagementToggle", stateKey: "freezeRiskManagement", read: "boolean", id: "finderFreezeRiskManagementToggle" },
	{ domKey: "finderExitStrategyOverrideToggle", stateKey: "exitStrategyOverrideEnabled", read: "boolean", id: "finderExitStrategyOverrideToggle" },
	{ domKey: "finderTradesToggle", stateKey: "tradeFilterEnabled", read: "boolean", id: "finderTradesToggle" },
	{ domKey: "finderTradesMin", stateKey: "minTrades", read: "number", min: 0, id: "finderTradesMin" },
	{ domKey: "finderTradesMax", stateKey: "maxTradesText", read: "text", id: "finderTradesMax" },
	{ domKey: "finderOosValidationToggle", stateKey: "oosValidationEnabled", read: "boolean", id: "finderOosValidationToggle" },
	{ domKey: "finderUniverseMinActiveSymbols", stateKey: "universeMinActiveSymbols", read: "number", min: 1, id: "finderUniverseMinActiveSymbols" },
	{ domKey: "finderUniverseMinTotalTrades", stateKey: "universeMinTotalTrades", read: "number", min: 0, id: "finderUniverseMinTotalTrades" },
	{ domKey: "finderUniverseMinProfitableActiveRatio", stateKey: "universeMinProfitableActiveRatio", read: "number", min: 0, id: "finderUniverseMinProfitableActiveRatio" },
	{ domKey: "finderUniverseRankingEnabled", stateKey: "universeRankingEnabled", read: "boolean", id: "finderUniverseRankingEnabled" },
	{ domKey: "finderAssetCandidatePoolSize", stateKey: "assetOpportunityCandidatePoolSize", read: "number", min: 1, id: "finderAssetCandidatePoolSize" },
	{ domKey: "finderAssetMinFreshSupport", stateKey: "assetOpportunityMinFreshSupport", read: "number", min: 1, id: "finderAssetMinFreshSupport" },
	{ domKey: "finderAssetIncludeOpenPositions", stateKey: "assetOpportunityIncludeOpenPositions", read: "boolean", id: "finderAssetIncludeOpenPositions" },
	{ domKey: "finderAssetOosMeasurementMode", stateKey: "assetOpportunityOosMeasurementMode", read: "select", id: "finderAssetOosMeasurementMode" },
	{ domKey: "finderAssetOosIgnoreLastBars", stateKey: "assetOpportunityOosIgnoreLastBars", read: "number", min: 0, id: "finderAssetOosIgnoreLastBars" },
	{ domKey: "finderAssetEvalWindowMode", stateKey: "assetOpportunityEvalWindowMode", read: "select", id: "finderAssetEvalWindowMode" },
	{ domKey: "finderAssetEvalWindowBars", stateKey: "assetOpportunityEvalWindowBars", read: "number", min: 0, id: "finderAssetEvalWindowBars" },
	{ domKey: "finderAssetOosBatchToggle", stateKey: "assetOpportunityOosBatchEnabled", read: "boolean", id: "finderAssetOosBatchToggle" },
	{ domKey: "finderArmPerformanceMeasurement", stateKey: "armPerformanceMeasurement", read: "select", id: "finderArmPerformanceMeasurement" },
	{ domKey: "finderArmPerformanceRankingSort", stateKey: "armPerformanceRankingSort", read: "select", id: "finderArmPerformanceRankingSort" },
	{ domKey: "finderArmPerformanceRankingTopK", stateKey: "armPerformanceRankingTopK", read: "number", min: 2, id: "finderArmPerformanceRankingTopK" },
	{ domKey: "finderArmPerformanceReplayMode", stateKey: "armPerformanceReplayMode", read: "select", id: "finderArmPerformanceReplayMode" },
	{ domKey: "finderArmPerformanceHorizon", stateKey: "armPerformanceHorizon", read: "number", min: 1, id: "finderArmPerformanceHorizon" },
	{ domKey: "finderArmPerformanceExcludeTopContributor", stateKey: "armPerformanceExcludeTopContributor", read: "boolean", id: "finderArmPerformanceExcludeTopContributor" },
	{ domKey: "finderArmPerformanceEventFilterEnabled", stateKey: "armPerformanceEventFilterEnabled", read: "boolean", id: "finderArmPerformanceEventFilterEnabled" },
	{ domKey: "finderArmPerformanceMinEvents", stateKey: "armPerformanceMinEvents", read: "number", min: 1, id: "finderArmPerformanceMinEvents" },
	{ domKey: "finderArmPerformanceMaxEvents", stateKey: "armPerformanceMaxEventsText", read: "text", id: "finderArmPerformanceMaxEvents" },
	{ domKey: "finderArmPerformanceSelectionCooldownEnabled", stateKey: "armPerformanceSelectionCooldownEnabled", read: "boolean", id: "finderArmPerformanceSelectionCooldownEnabled" },
	{ domKey: "finderArmPerformanceSelectionCooldownBars", stateKey: "armPerformanceSelectionCooldownBars", read: "number", min: 1, id: "finderArmPerformanceSelectionCooldownBars" },
] as const;

type WritableInput = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

/**
 * Write one persisted state value into its DOM control. Numeric controls are
 * written as strings; booleans drive `checked`; everything else assigns the
 * raw value.
 */
export function applyBindingToDom(
	binding: FinderControlBinding,
	dom: FinderManagerDom,
	state: FinderPersistedUiState,
): void {
	const element = dom[binding.domKey] as WritableInput;
	const value = state[binding.stateKey];
	if (typeof value === "boolean") {
		(element as HTMLInputElement).checked = value;
		return;
	}
	element.value = String(value);
}

/**
 * Read one control's current DOM value back into state, preserving the
 * previous value when a numeric control is not readable. Returns the previous
 * value so the caller can keep the write explicit and typed.
 */
export function readBindingFromDom(
	binding: FinderControlBinding,
	dom: FinderManagerDom,
	state: FinderPersistedUiState,
): void {
	const element = dom[binding.domKey] as WritableInput;
	switch (binding.read) {
		case "boolean":
			(state as Record<FinderBoundStateKey, unknown>)[binding.stateKey] = (element as HTMLInputElement).checked;
			return;
		case "number": {
			const parsed = parseInputNumber(element.value);
			if (parsed === null) return;
			const min = binding.min;
			const next = min === undefined ? parsed : Math.max(min, parsed);
			(state as Record<FinderBoundStateKey, unknown>)[binding.stateKey] = next;
			return;
		}
		case "text":
			(state as Record<FinderBoundStateKey, unknown>)[binding.stateKey] = element.value.trim();
			return;
		case "select":
		default:
			(state as Record<FinderBoundStateKey, unknown>)[binding.stateKey] = element.value;
			return;
	}
}
