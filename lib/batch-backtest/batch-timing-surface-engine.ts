/**
 * Counterfactual Timing Surface Miner — pure policy-grid evaluation engine.
 *
 * Deterministic, server-safe (no DOM, no chart, no
 * `lightweight-charts` transitive imports).
 *
 *
 *  - 60/20/20 chronological discovery/selection/validation split by target-bar
 *    position. A sample is purged when its delayed entry or exit crosses a
 *    partition boundary.
 *  - Horizon grid calibrated ONCE per target from discovery-only closed linked
 *    trades whose entry AND exit lie inside discovery (rounded [0.5x, 1x, 2x]
 *    of the discovery median hold; de-duplicated positive horizons; fallback
 *    [6, 12, 24] when discovery has no qualifying trades). Selection and
 *    validation cannot change the grid.
 *  - Per-rerun cell metrics are computed independently. Historical episodes
 *    duplicated across reruns are NEVER pooled as independent observations.
 *    Metrics are aggregated across reruns as median + 10th percentile of the
 *    per-rerun medians (subset recurrence sensitivity; NOT a statistical
 *    confidence interval).
 *  - Delayed cells must beat immediate entry (positive median lift over
 *    immediate entry) in both discovery and selection. Delay-zero cells require
 *    positive median net return only. Every actionable policy must beat SKIP
 *    after costs.
 *  - Selection ranking is deterministic: selection positive-rerun rate, median
 *    lift, median net return, lower delay, shorter horizon. Ties broken
 *    deterministically.
 *  - The frozen winner passes timing validation only when at least 60% of
 *    validation-evaluable matching-direction reruns are net positive, median
 *    validation net return is positive, and (delay > 0) median validation lift
 *    over immediate entry is positive.
 *  - A plateau requires the chosen cell and at least 2 orthogonal neighbors in
 *    delay/horizon space to have positive selection median net return across
 *    qualifying reruns. Cells with fewer than 2 available neighbors cannot
 *    establish a plateau.
 *
 * Net return applies entry commission to entry notional and exit commission to
 * exit notional after adverse entry/exit slippage. The cost model is identical
 * to the Batch backtest helpers: `commissionRate = commissionPercent / 100`,
 * `slippageRate = slippageBps / 10000`. Entry fills use the existing execution
 * semantics:
 *   - signal_close: entry candle close
 *   - next_open:    next candle open
 *   - next_close:   next candle close
 */

import type { OHLCVData } from "../types/strategies";
import {
    applySlippage,
    entrySideForDirection,
    exitSideForDirection,
} from "../strategies/backtest/backtest-utils";
import {
    buildBatchSyntheticAnalogDetail,
    prepareBatchSyntheticTargetArtifacts,
    selectNearestAnalogsForTimingSurface,
    type BatchSyntheticAnalogDetailSample,
    type BatchSyntheticPreparedPairArtifact,
    type BatchSyntheticPreparedTargetArtifact,
} from "./batch-synthetic-state-miner";
import type { BatchStabilityRow } from "./batch-stability-mine";
import { computeStabilityAction } from "./miner-verdict-format-helpers";
import {
    TIMING_SURFACE_DELAYS,
    TIMING_SURFACE_DEFAULT_GATES,
    TIMING_SURFACE_EVIDENCE_SCOPE,
    TIMING_SURFACE_FALLBACK_HORIZONS,
    TIMING_SURFACE_SCHEMA_VERSION,
    TimingSurfaceCancelled,
    type TimingSurfaceCellWindowMetrics,
    type TimingSurfaceCostModel,
    type TimingSurfaceDecision,
    type TimingSurfaceEngineInput,
    type TimingSurfaceGates,
    type TimingSurfaceProfile,
    type TimingSurfaceReasonCode,
    type TimingSurfaceResult,
    type TimingSurfaceRow,
    type TimingSurfaceScalarCellSummary,
    type TimingSurfaceWindow,
    type TimingSurfaceDelay,
    type TimingSurfaceRowCells,
} from "./batch-timing-surface-types";

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface ResolvedWindow {
    discoveryEndIndex: number;
    selectionEndIndex: number;
    candidateSpan: number;
}

interface PerRerunCellReturn {
    /** Median net return across episodes in this rerun/cell/window, in percent. */
    medianReturnPct: number;
    /** Per-episode net returns in percent. */
    episodeReturnsPct: number[];
    /** Per-episode lift over immediate entry in percent (delayed cells only). */
    episodeLiftsPct: number[];
    /** Median lift over immediate entry in percent (delayed cells only). */
    medianLiftPct: number;
    /** Number of independent episodes that survived boundary purge. */
    episodes: number;
}

interface CellMetrics {
    delay: TimingSurfaceDelay;
    horizon: number;
    discovery: TimingSurfaceCellWindowMetrics;
    selection: TimingSurfaceCellWindowMetrics;
    validation: TimingSurfaceCellWindowMetrics;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export async function runTimingSurfaceEngine(input: TimingSurfaceEngineInput): Promise<TimingSurfaceResult> {
    const gates: TimingSurfaceGates = TIMING_SURFACE_DEFAULT_GATES;
    const nowMs = input.nowMs ?? Date.now();
    const warnings: string[] = [];
    const profile: TimingSurfaceProfile = {
        targetLoadMs: 0,
        subsetReconstructionMs: 0,
        analogReconstructionMs: 0,
        engineMs: 0,
        aggregationMs: 0,
        targetsEvaluated: 0,
        rerunsEvaluated: 0,
        cellsEvaluated: 0,
        cellsEmitted: 0,
        boundaryCheckedSamples: 0,
        boundaryPurgedSamples: 0,
    };
    const engineStart = now();

    // Yield between bounded work units so the HTTP Stop handler can update
    // miner ownership while the engine is running.
    const yieldTick = async (): Promise<void> => {
        await new Promise<void>((resolve) => setImmediate(resolve));
    };

    const stabilityRows = input.stability.rows;
    const reruns = Math.max(1, input.stability.reruns);
    const rows: TimingSurfaceRow[] = [];
    const rowCells: Record<string, TimingSurfaceRowCells> = {};
    const lostOwnership = input.lostOwnership ?? (() => false);

    for (const stabilityRow of stabilityRows) {
        // check ownership between bounded work units (per-target).
        if (lostOwnership()) throw new TimingSurfaceCancelled();
        await yieldTick();
        const stabilityKey = `${stabilityRow.asset}|${stabilityRow.direction}`;
        const currentAction = input.stabilityActions.get(stabilityKey);
        if (currentAction !== "ENTER") continue;
        const targetDataset = input.targets.get(stabilityRow.asset);
        if (!targetDataset) {
            // Eligible by Stability but no target OHLCV loaded — emit INVALID row.
            rows.push(buildInvalidRow(
                stabilityRow,
                "ENTER",
                ["INVALID_INPUT"],
            ));
            warnings.push(`No target dataset for ${stabilityRow.asset}; emitted INVALID.`);
            continue;
        }
        profile.targetsEvaluated += 1;

        const engineResult = await evaluateOneTarget(
            stabilityRow,
            targetDataset.data,
            input,
            gates,
            reruns,
            profile,
            yieldTick,
        );
        rows.push(engineResult.row);
        if (engineResult.cells) {
            rowCells[stabilityKey] = engineResult.cells;
            profile.cellsEmitted += engineResult.cells.cells.length;
        }
    }

    profile.engineMs = roundMs(now() - engineStart);

    return {
        schemaVersion: TIMING_SURFACE_SCHEMA_VERSION,
        fingerprint: input.fingerprint,
        interval: input.interval,
        generatedAt: nowMs,
        asOfTimeKey: rows.length > 0
            ? rows.map((r) => r.asOfTimeKey).filter((k): k is string => Boolean(k)).sort().at(-1) ?? null
            : null,
        stability: {
            reruns: input.stability.reruns,
            subsetSize: input.stability.subsetSize,
            seed: input.stability.seed,
            totalPairs: input.stability.totalPairs,
            targetAssets: input.stability.targetAssets,
        },
        costModel: input.costModel,
        evidenceScope: TIMING_SURFACE_EVIDENCE_SCOPE,
        exploitEligible: false,
        rows,
        rowCells,
        profile,
        warnings,
    };
}

// ---------------------------------------------------------------------------
// Per-target evaluation
// ---------------------------------------------------------------------------

interface OneTargetResult {
    row: TimingSurfaceRow;
    cells: TimingSurfaceRowCells | null;
}

async function evaluateOneTarget(
    stabilityRow: BatchStabilityRow,
    targetData: OHLCVData[],
    input: TimingSurfaceEngineInput,
    gates: TimingSurfaceGates,
    reruns: number,
    profile: TimingSurfaceProfile,
    yieldTick: () => Promise<void>,
): Promise<OneTargetResult> {
    const directionLong = stabilityRow.direction === "LONG";
    const direction: "long" | "short" = directionLong ? "long" : "short";

    // Step 1: prepare the target artifact once (no per-rerun cost).
    const preparedTarget = prepareSingleTarget(stabilityRow.asset, targetData);
    if (!preparedTarget) {
        return {
            row: buildInvalidRow(stabilityRow, "ENTER", ["INVALID_INPUT"]),
            cells: null,
        };
    }

    // Step 2: derive the raw 60/20/20 window boundaries by target-bar position
    // — independent of the miner's auto-horizon calibration.
    const windows = resolveWindows(preparedTarget.data.length);

    // Step 3: prepare the per-rerun analog detail. For each rerun, the server
    // resolves the linked artifact subset for this target; we build the
    // candidate samples + frozen discovery distance scales ONCE per rerun.
    const analogStart = now();
    // Precompute each rerun's frozen analogs and delayed-state validity once;
    // the cell grid then performs only cost and boundary calculations.
    const preparedReruns: PreparedRerun[] = [];
    const lostOwnership = input.lostOwnership ?? (() => false);
    const executionShift = input.costModel.executionModel === "signal_close" ? 0 : 1;
    const minerOptions = {
        neighborCountMin: gates.neighborCountMin,
        neighborCountMax: gates.neighborCountMax,
        autoHorizons: false,
    };
    for (let runIndex = 0; runIndex < reruns; runIndex += 1) {
        if (lostOwnership()) throw new TimingSurfaceCancelled();
        await yieldTick();
        const linked = input.resolveRerunLinkedArtifacts(runIndex, stabilityRow.asset);
        if (!linked) continue;
        const linkedPairs = [...linked.linkedArtifacts] as BatchSyntheticPreparedPairArtifact[];
        const detail = buildBatchSyntheticAnalogDetail({
            target: preparedTarget,
            linkedPairs,
            direction,
            options: { autoHorizons: false },
        });
        if (detail.discoveryEndIndex !== windows.discoveryEndIndex
            || detail.selectionEndIndex !== windows.selectionEndIndex) {
            windows.discoveryEndIndex = detail.discoveryEndIndex;
            windows.selectionEndIndex = detail.selectionEndIndex;
            windows.candidateSpan = detail.candidateSpan;
        }
        const currentSnapshot = detail.currentSnapshot;
        const matchesDirection = currentSnapshot?.direction === direction;
        // Per-window nearest-analog selection ONCE per rerun. The cell loop
        // below reuses these frozen lists; it does NOT re-score distance.
        let analogsByWindow: PreparedRerun["analogsByWindow"] = { discovery: [], selection: [], validation: [] };
        if (matchesDirection && detail.scales && currentSnapshot?.direction === direction) {
            const discoverySamples = detail.samples.filter((s) => s.barIndex < windows.discoveryEndIndex);
            const selectionSamples = detail.samples.filter((s) => s.barIndex >= windows.discoveryEndIndex && s.barIndex < windows.selectionEndIndex);
            const validationSamples = detail.samples.filter((s) => s.barIndex >= windows.selectionEndIndex);
            analogsByWindow = {
                discovery: selectNearestAnalogsForTimingSurface(currentSnapshot, discoverySamples, detail.scales, minerOptions).map((a) => a.sample),
                selection: selectNearestAnalogsForTimingSurface(currentSnapshot, selectionSamples, detail.scales, minerOptions).map((a) => a.sample),
                validation: selectNearestAnalogsForTimingSurface(currentSnapshot, validationSamples, detail.scales, minerOptions).map((a) => a.sample),
            };
        }
        // Precompute delayed-state validity ONCE per (delay, sample). For
        // delay 0 the map stays empty (no reconstruction needed). The unique
        // entry bars across all windows are the union of analog barIndex + d.
        const delayedStateValidByEntryIndex = new Map<number, Map<number, boolean>>();
        if (matchesDirection) {
            const allAnalogs = [...analogsByWindow.discovery, ...analogsByWindow.selection, ...analogsByWindow.validation];
            for (const d of TIMING_SURFACE_DELAYS) {
                if (d === 0) continue;
                const inner = new Map<number, boolean>();
                const entryIndexes = new Set<number>();
                for (const sample of allAnalogs) {
                    entryIndexes.add(sample.barIndex + d);
                }
                for (const entryIndex of entryIndexes) {
                    if (entryIndex < 0 || entryIndex >= preparedTarget.data.length) {
                        inner.set(entryIndex, false);
                        continue;
                    }
                    const snap = detail.snapshotAt(entryIndex + executionShift);
                    inner.set(entryIndex, snap?.direction === direction);
                }
                delayedStateValidByEntryIndex.set(d, inner);
            }
        }
        preparedReruns.push({ matchesDirection, analogsByWindow, discoveryHoldBars: detail.discoveryHoldBars, delayedStateValidByEntryIndex });
        profile.rerunsEvaluated += 1;
    }
    profile.analogReconstructionMs += roundMs(now() - analogStart);

    if (preparedReruns.length === 0) {
        return {
            row: buildInvalidRow(stabilityRow, "ENTER", ["INSUFFICIENT_RECURRENCE"]),
            cells: null,
        };
    }

    // Step 4: derive the common horizon grid from discovery-only closed trades,
    // aggregated across reruns.  one grid per target, used unchanged
    // in every rerun.
    const allDiscoveryHoldBars: number[] = [];
    for (const rerun of preparedReruns) {
        for (const bars of rerun.discoveryHoldBars) allDiscoveryHoldBars.push(bars);
    }
    const horizons = resolveHorizonGrid(allDiscoveryHoldBars, windows);
    if (horizons.length === 0) {
        return {
            row: buildWatchRow(stabilityRow, "ENTER", ["NO_DISCOVERY_HORIZON"]),
            cells: null,
        };
    }

    // Step 5: evaluate the fixed (delay × horizon) grid. Now that analogs and
    // delayed-state validity are cached per rerun, the cell loop is pure cost
    // math + boundary check.
    const cellsByCellKey = new Map<string, CellMetrics>();
    let boundaryPurged = 0;
    let boundaryChecked = 0;
    const aggregationStart = now();
    for (const horizon of horizons) {
        for (const delay of TIMING_SURFACE_DELAYS) {
            // check ownership between bounded work units (per-cell).
            if (lostOwnership()) throw new TimingSurfaceCancelled();
            // Keep cancellation reachable during the grid evaluation.
            await yieldTick();
            const metrics = evaluateCellAcrossReruns(
                delay, horizon, direction, preparedReruns,
                preparedTarget, windows, input.costModel, gates, lostOwnership,
            );
            profile.cellsEvaluated += 1;
            boundaryPurged += metrics.__boundaryPurged;
            boundaryChecked += metrics.__boundaryChecked;
            cellsByCellKey.set(cellKey(delay, horizon), metrics);
        }
    }
    profile.boundaryPurgedSamples += boundaryPurged;
    profile.boundaryCheckedSamples += boundaryChecked;
    profile.aggregationMs += roundMs(now() - aggregationStart);

    // Step 6: discovery qualification gate.
    const recurrenceQualified: CellMetrics[] = [];
    const discoveryQualified: CellMetrics[] = [];
    for (const cell of cellsByCellKey.values()) {
        if (!cellQualifiesDiscovery(cell, gates, reruns)) continue;
        recurrenceQualified.push(cell);
        if (!cellPassesDiscoveryRules(cell)) continue;
        discoveryQualified.push(cell);
    }
    if (discoveryQualified.length === 0) {
        const diagnostic = selectDiagnosticCell(
            recurrenceQualified.length > 0 ? recurrenceQualified : [...cellsByCellKey.values()],
        );
        const reason: TimingSurfaceReasonCode = recurrenceQualified.length > 0
            ? "NON_POSITIVE_EDGE"
            : "INSUFFICIENT_RECURRENCE";
        return {
            row: diagnostic
                ? buildEvidenceWatchRow(stabilityRow, diagnostic, emptyPlateau(), preparedTarget, [reason])
                : buildWatchRow(stabilityRow, "ENTER", [reason]),
            cells: buildRowCells([...cellsByCellKey.values()], horizons, gates),
        };
    }

    // Step 7: require selection recurrence independently from discovery, then
    // rank by selection positive-rerun rate, median lift, median net return,
    // lower delay, and shorter horizon.
    const selectionQualified = discoveryQualified.filter((cell) =>
        windowQualifiesRecurrence(cell.selection, gates, reruns));
    if (selectionQualified.length === 0) {
        const diagnostic = [...discoveryQualified].sort(compareCellsForSelection)[0]!;
        return {
            row: buildEvidenceWatchRow(
                stabilityRow,
                diagnostic,
                emptyPlateau(),
                preparedTarget,
                ["INSUFFICIENT_RECURRENCE"],
            ),
            cells: buildRowCells([...cellsByCellKey.values()], horizons, gates),
        };
    }
    selectionQualified.sort(compareCellsForSelection);
    const ranked = selectionQualified;

    // Step 8: apply selection rules + plateau + freeze the winner.
    let frozen: CellMetrics | null = null;
    let frozenPlateau: PlateauInfo | null = null;
    let bestSelectionCandidate: CellMetrics | null = null;
    let bestSelectionPlateau: PlateauInfo | null = null;
    for (const candidate of ranked) {
        if (!cellPassesSelectionRules(candidate)) continue;
        const plateau = computePlateau(candidate, cellsByCellKey, horizons, gates, reruns);
        if (bestSelectionCandidate === null) {
            bestSelectionCandidate = candidate;
            bestSelectionPlateau = plateau;
        }
        if (!plateauPasses(plateau, gates)) continue;
        frozen = candidate;
        frozenPlateau = plateau;
        break;
    }
    if (!frozen || !frozenPlateau) {
        const diagnostic = bestSelectionCandidate ?? ranked[0]!;
        const plateau = bestSelectionPlateau
            ?? computePlateau(diagnostic, cellsByCellKey, horizons, gates, reruns);
        const reason = resolveSelectionRejectionReason(bestSelectionCandidate, plateau);
        return {
            row: buildEvidenceWatchRow(stabilityRow, diagnostic, plateau, preparedTarget, [reason]),
            cells: buildRowCells([...cellsByCellKey.values()], horizons, gates),
        };
    }

    // Step 9: validate the frozen winner. Negative validation expectancy or
    // non-positive required lift emits SKIP; insufficient evidence emits WATCH.
    if (!windowQualifiesRecurrence(frozen.validation, gates, reruns)) {
        return {
            row: buildSelectedRow(
                stabilityRow,
                "ENTER",
                "WATCH",
                frozen,
                frozenPlateau,
                preparedTarget,
                ["INSUFFICIENT_RECURRENCE"],
            ),
            cells: buildRowCells([...cellsByCellKey.values()], horizons, gates),
        };
    }
    const validationOutcome = passesValidationGate(frozen, gates);
    if (!validationOutcome.passed) {
        const decision: TimingSurfaceDecision = validationOutcome.shouldSkip ? "SKIP" : "WATCH";
        const reason: TimingSurfaceReasonCode = validationOutcome.shouldSkip
            ? (frozen.delay > 0 ? "NO_POSITIVE_LIFT" : "NEGATIVE_NET_EXPECTANCY")
            : "VALIDATION_FAILED";
        return {
            row: decision === "SKIP"
                ? buildSelectedRow(stabilityRow, "ENTER", "SKIP", frozen, frozenPlateau, preparedTarget, [reason])
                : buildSelectedRow(stabilityRow, "ENTER", "WATCH", frozen, frozenPlateau, preparedTarget, [reason]),
            cells: buildRowCells([...cellsByCellKey.values()], horizons, gates),
        };
    }

    // Step 10: emit an actionable decision only when the Stability source is
    // still fresh at completion.
    const completionMs = input.completionNow ? input.completionNow() : Date.now();
    const actionAtCompletion = computeStabilityAction(stabilityRow, reruns, input.interval, completionMs).action;
    if (actionAtCompletion !== "ENTER") {
        return {
            row: buildInvalidRow(stabilityRow, actionAtCompletion, ["SOURCE_STALE"]),
            cells: buildRowCells([...cellsByCellKey.values()], horizons, gates),
        };
    }
    const decision: TimingSurfaceDecision = frozen.delay === 0
        ? "ENTER_NOW"
        : (frozen.delay === 1 ? "WAIT_1" : frozen.delay === 2 ? "WAIT_2" : "WAIT_3");
    const row = buildSelectedRow(stabilityRow, "ENTER", decision, frozen, frozenPlateau, preparedTarget);
    return { row, cells: buildRowCells([...cellsByCellKey.values()], horizons, gates) };
}

// ---------------------------------------------------------------------------
// Target / window preparation
// ---------------------------------------------------------------------------

function prepareSingleTarget(asset: string, data: OHLCVData[]): BatchSyntheticPreparedTargetArtifact | null {
    const prepared = prepareBatchSyntheticTargetArtifacts([{ asset, symbol: asset, data }]);
    return prepared[0] ?? null;
}

function resolveWindows(targetLength: number): ResolvedWindow {
    // Fallback horizon 24 reserve; the seam narrows this to the actual longest.
    const longest = Math.max(TIMING_SURFACE_FALLBACK_HORIZONS[2] ?? 24, 24);
    const candidateSpan = Math.max(1, targetLength - longest);
    return {
        discoveryEndIndex: Math.max(0, Math.floor(candidateSpan * 0.6)),
        selectionEndIndex: Math.max(0, Math.floor(candidateSpan * 0.8)),
        candidateSpan,
    };
}

// ---------------------------------------------------------------------------
// Horizon grid
// ---------------------------------------------------------------------------

function resolveHorizonGrid(discoveryHoldBars: number[], windows: ResolvedWindow): number[] {
    const medianHold = median(discoveryHoldBars);
    let raw: number[];
    if (medianHold === null || medianHold < 1) {
        raw = [...TIMING_SURFACE_FALLBACK_HORIZONS];
    } else {
        const mults = [0.5, 1, 2];
        raw = mults
            .map((mult) => Math.max(1, Math.round(medianHold * mult)))
            .filter((value, index, array) => array.indexOf(value) === index)
            .sort((a, b) => a - b);
    }
    // Clamp horizons so selection and validation can each contain complete outcomes.
    const maxHorizon = Math.max(
        1,
        Math.min(
            Math.floor((windows.selectionEndIndex - windows.discoveryEndIndex) * 0.9),
            Math.floor((windows.candidateSpan - windows.selectionEndIndex) * 0.9),
        ),
    );
    const clamped = raw.map((h) => Math.max(1, Math.min(h, maxHorizon)))
        .filter((value, index, array) => array.indexOf(value) === index)
        .sort((a, b) => a - b);
    return clamped;
}

// ---------------------------------------------------------------------------
// Per-cell evaluation across reruns
// ---------------------------------------------------------------------------

interface CellMetricsWithBoundary extends CellMetrics {
    __boundaryPurged: number;
    __boundaryChecked: number;
}

/**
 * Per-rerun precomputed data, hoisted out of the cell grid. The cell loop
 * reuses the frozen per-window analog lists and the delayed-state validity
 * cache; it does not re-score distance or rebuild snapshots.
 */
interface PreparedRerun {
    matchesDirection: boolean;
    analogsByWindow: {
        discovery: ReadonlyArray<BatchSyntheticAnalogDetailSample>;
        selection: ReadonlyArray<BatchSyntheticAnalogDetailSample>;
        validation: ReadonlyArray<BatchSyntheticAnalogDetailSample>;
    };
    discoveryHoldBars: number[];
    /** Outer key: delay; inner key: entry bar index. True = direction still matches. */
    delayedStateValidByEntryIndex: Map<number, Map<number, boolean>>;
}

function evaluateCellAcrossReruns(
    delay: TimingSurfaceDelay,
    horizon: number,
    direction: "long" | "short",
    preparedReruns: ReadonlyArray<PreparedRerun>,
    target: BatchSyntheticPreparedTargetArtifact,
    windows: ResolvedWindow,
    costModel: TimingSurfaceCostModel,
    gates: TimingSurfaceGates,
    lostOwnership: () => boolean,
): CellMetricsWithBoundary {
    const discoveryPerRerun: PerRerunCellReturn[] = [];
    const selectionPerRerun: PerRerunCellReturn[] = [];
    const validationPerRerun: PerRerunCellReturn[] = [];
    let boundaryPurged = 0;
    let boundaryChecked = 0;
    const delayedCache = delay > 0 ? null : new Map<number, boolean>();

    for (const rerun of preparedReruns) {
        // check ownership between bounded work units (per-rerun).
        if (lostOwnership()) throw new TimingSurfaceCancelled();
        // only reruns whose miner verdict matches the retained
        // direction contribute cell metrics.
        if (!rerun.matchesDirection) continue;

        // Use the precomputed per-window analog lists. The cell loop is now
        // pure cost math + boundary check; analog selection and delayed-state
        // reconstruction happen ONCE per rerun in evaluateOneTarget.
        const delayedStateValidByEntryIndex = delay > 0
            ? rerun.delayedStateValidByEntryIndex.get(delay) ?? new Map<number, boolean>()
            : delayedCache;
        const discoveryEpisodes = buildWindowEpisodesForCell(
            rerun.analogsByWindow.discovery, delay, horizon, direction,
            target, windows, "discovery", costModel, delayedStateValidByEntryIndex,
        );
        boundaryChecked += rerun.analogsByWindow.discovery.length;
        boundaryPurged += discoveryEpisodes.purged;
        const selectionEpisodes = buildWindowEpisodesForCell(
            rerun.analogsByWindow.selection, delay, horizon, direction,
            target, windows, "selection", costModel, delayedStateValidByEntryIndex,
        );
        boundaryChecked += rerun.analogsByWindow.selection.length;
        boundaryPurged += selectionEpisodes.purged;
        const validationEpisodes = buildWindowEpisodesForCell(
            rerun.analogsByWindow.validation, delay, horizon, direction,
            target, windows, "validation", costModel, delayedStateValidByEntryIndex,
        );
        boundaryChecked += rerun.analogsByWindow.validation.length;
        boundaryPurged += validationEpisodes.purged;

        if (discoveryEpisodes.episodes.length > 0) {
            discoveryPerRerun.push(summarizeRerunCell(discoveryEpisodes.episodes, delay));
        }
        if (selectionEpisodes.episodes.length > 0) {
            selectionPerRerun.push(summarizeRerunCell(selectionEpisodes.episodes, delay));
        }
        if (validationEpisodes.episodes.length > 0) {
            validationPerRerun.push(summarizeRerunCell(validationEpisodes.episodes, delay));
        }
    }

    return {
        delay,
        horizon,
        discovery: aggregateWindow("discovery", discoveryPerRerun, gates),
        selection: aggregateWindow("selection", selectionPerRerun, gates),
        validation: aggregateWindow("validation", validationPerRerun, gates),
        __boundaryPurged: boundaryPurged,
        __boundaryChecked: boundaryChecked,
    };
}

interface Episode {
    entryIndex: number;
    exitIndex: number;
    netReturnPct: number;
    /** Lift over immediate entry at the same horizon (0 for delay 0). */
    liftOverImmediatePct: number;
}

/**
 * Build delayed-entry episodes for one window of one cell, with window-aware
 * boundary purge and delayed-state reconstruction.
 *
 * A sample is purged when its delayed entry or exit crosses its window
 * boundary. A discovery entry must stay inside discovery; a selection entry
 * must stay inside selection; a validation entry must stay inside validation.
 * Earlier versions only checked the candidate-span boundary, which let a
 * discovery entry exit inside selection and leak held-back prices into the
 * earlier stage.
 *
 * A delayed sample is rejected if the asset-relative synthetic direction is
 * no longer active at entry. For delay > 0, we reconstruct the synthetic
 * state at the actual delayed fill bar (NOT the original analog bar) and require its
 * direction to match. This is what makes a WAIT_n recommendation meaningful —
 * it says "if the state at the delayed bar still matches this pattern".
 */
function buildWindowEpisodesForCell(
    samples: ReadonlyArray<BatchSyntheticAnalogDetailSample>,
    delay: TimingSurfaceDelay,
    horizon: number,
    direction: "long" | "short",
    target: BatchSyntheticPreparedTargetArtifact,
    windows: ResolvedWindow,
    window: TimingSurfaceWindow,
    costModel: TimingSurfaceCostModel,
    /**
     * Delayed-state validity cache. Caller pre-computes, per (rerun, sample,
     * delay), whether the synthetic direction at the actual fill bar still
     * matches. Keys are nominal `${barIndex + delay}` indexes used by the
     * episode builder; value true means "still active".
     * Null when delay == 0 (immediate entry — no delayed-state check needed)
     * OR when the caller has not pre-computed this sample (treated as fail).
     */
    delayedStateValidByEntryIndex: Map<number, boolean> | null,
): { episodes: Episode[]; purged: number } {
    const rawEpisodes: Episode[] = [];
    let purged = 0;
    // Window-aware boundary: the actual FILL indexes (after the execution
    // shift) for both entry and exit must stay inside this window's
    // [start, end) range. Resolve fill indexes before checking the boundary
    // because next_open and next_close add one bar to nominal indexes.
    const windowStart = window === "discovery" ? 0 : window === "selection" ? windows.discoveryEndIndex : windows.selectionEndIndex;
    const windowEnd = window === "discovery" ? windows.discoveryEndIndex : window === "selection" ? windows.selectionEndIndex : windows.candidateSpan;
    const shift = costModel.executionModel === "signal_close" ? 0 : 1;

    for (const sample of samples) {
        const entryIndex = sample.barIndex + delay;
        const exitIndex = entryIndex + horizon;
        // Resolve the actual fill indexes (mirror computeNetReturn's shift).
        const fillEntryIndex = entryIndex + shift;
        const fillExitIndex = exitIndex + shift;
        // Purge using actual fill indexes, not nominal signal indexes.
        // Both fills must satisfy windowStart <= fillIndex < windowEnd.
        if (fillEntryIndex < windowStart || fillEntryIndex >= windowEnd
            || fillExitIndex < windowStart || fillExitIndex >= windowEnd) {
            purged += 1;
            continue;
        }
        // Cap at candidate span (defense in depth).
        if (fillExitIndex >= windows.candidateSpan) {
            purged += 1;
            continue;
        }
        // For delay > 0, consult the precomputed validity cache: the synthetic direction at the delayed
        // entry bar must still match. This is hoisted out of the cell loop in
        // the caller (one reconstruction per (rerun, sample, delay), not per
        // cell) so the per-cell cost is a Map lookup.
        if (delay > 0) {
            const stillActive = delayedStateValidByEntryIndex?.get(entryIndex) ?? false;
            if (!stillActive) { purged += 1; continue; }
        }
        const result = computeNetReturn(target.data, entryIndex, exitIndex, direction, costModel);
        if (!result) { purged += 1; continue; }

        // Lift over immediate entry (delayed cells only). Compute the
        // immediate-entry counterpart at this same bar.
        let liftOverImmediatePct = 0;
        if (delay > 0) {
            const immediate = computeNetReturn(target.data, sample.barIndex, sample.barIndex + horizon, direction, costModel);
            if (immediate) {
                liftOverImmediatePct = result.netReturnPct - immediate.netReturnPct;
            }
        }

        rawEpisodes.push({
            entryIndex,
            exitIndex,
            netReturnPct: result.netReturnPct,
            liftOverImmediatePct,
        });
    }

    // Group overlapping entry-to-exit ranges into independent episodes.
    rawEpisodes.sort((a, b) => a.entryIndex - b.entryIndex);
    const episodes: Episode[] = [];
    let current: Episode[] = [];
    let currentMaxExit = -1;
    for (const ep of rawEpisodes) {
        if (current.length === 0 || ep.entryIndex <= currentMaxExit) {
            current.push(ep);
            currentMaxExit = Math.max(currentMaxExit, ep.exitIndex);
        } else {
            episodes.push(mergeGroup(current));
            current = [ep];
            currentMaxExit = ep.exitIndex;
        }
    }
    if (current.length > 0) episodes.push(mergeGroup(current));
    return { episodes, purged };
}

function mergeGroup(group: Episode[]): Episode {
    if (group.length === 1) return group[0]!;
    const avgReturn = group.reduce((s, e) => s + e.netReturnPct, 0) / group.length;
    const avgLift = group.reduce((s, e) => s + e.liftOverImmediatePct, 0) / group.length;
    // Take the earliest entry / latest exit as the group's range for overlap
    // detection purposes (already merged by sort), but keep entry/exit as the
    // first episode's anchor for window partitioning consistency.
    return {
        entryIndex: group[0]!.entryIndex,
        exitIndex: Math.max(...group.map((episode) => episode.exitIndex)),
        netReturnPct: avgReturn,
        liftOverImmediatePct: avgLift,
    };
}

interface NetReturnResult {
    netReturnPct: number;
}

/**
 * Net return after entry commission on entry notional and exit commission on
 * exit notional after adverse entry/exit slippage. Mirrors the Batch backtest
 * engine path: `commissionRate = commissionPercent / 100`,
 * `slippageRate = slippageBps / 10000`.
 *
 * For the timing surface we model a single unit-size position. Entry and exit
 * notional are 1.0 * fill price; gross PnL = (exitEntry * directionFactor) -
 * entryPrice. Net PnL subtracts entry commission (on entry notional) and exit
 * commission (on exit notional). Net return % = netPnl / entryNotional * 100.
 */
function computeNetReturn(
    data: OHLCVData[],
    entryIndex: number,
    exitIndex: number,
    direction: "long" | "short",
    costModel: TimingSurfaceCostModel,
): NetReturnResult | null {
    // Resolve the entry fill using the existing execution semantics. For
    // signal_close the entry is at the candle close; for next_open it is the
    // NEXT candle's open (so the bar at `entryIndex + 1`); for next_close the
    // next candle's close. We mirror `getExecutionShift` exactly.
    const shift = costModel.executionModel === "signal_close" ? 0 : 1;
    const fillEntryIndex = entryIndex + shift;
    const fillExitIndex = exitIndex + shift;
    const fillEntryBar = data[fillEntryIndex];
    const fillExitBar = data[fillExitIndex];
    if (!fillEntryBar || !fillExitBar) return null;
    const entryBase = costModel.executionModel === "next_open"
        ? fillEntryBar.open
        : fillEntryBar.close;
    const exitBase = costModel.executionModel === "next_open"
        ? fillExitBar.open
        : fillExitBar.close;
    if (!Number.isFinite(entryBase) || entryBase <= 0) return null;
    if (!Number.isFinite(exitBase) || exitBase <= 0) return null;

    const slippageRate = costModel.slippageBps / 10000;
    const entrySide = entrySideForDirection(direction);
    const exitSide = exitSideForDirection(direction);
    const entryFill = applySlippage(entryBase, entrySide, slippageRate);
    const exitFill = applySlippage(exitBase, exitSide, slippageRate);

    const directionFactor = direction === "long" ? 1 : -1;
    const grossPnl = (exitFill - entryFill) * directionFactor;
    const commissionRate = costModel.commissionPercent / 100;
    const entryCommission = entryFill * commissionRate;
    const exitCommission = exitFill * commissionRate;
    const netPnl = grossPnl - entryCommission - exitCommission;
    const netReturnPct = (netPnl / entryFill) * 100;
    if (!Number.isFinite(netReturnPct)) return null;
    return { netReturnPct };
}

function summarizeRerunCell(episodes: Episode[], delay: TimingSurfaceDelay): PerRerunCellReturn {
    const returns = episodes.map((e) => e.netReturnPct).sort((a, b) => a - b);
    const lifts = delay > 0
        ? episodes.map((e) => e.liftOverImmediatePct).sort((a, b) => a - b)
        : [];
    return {
        medianReturnPct: percentile(returns, 0.5),
        episodeReturnsPct: returns,
        episodeLiftsPct: lifts,
        medianLiftPct: delay > 0 ? percentile(lifts, 0.5) : 0,
        episodes: episodes.length,
    };
}

function aggregateWindow(
    window: TimingSurfaceWindow,
    perRerun: PerRerunCellReturn[],
    gates: TimingSurfaceGates,
): TimingSurfaceCellWindowMetrics {
    const qualifying = perRerun.filter((r) => r.episodes >= gates.minEpisodesPerRerunCell);
    if (qualifying.length === 0) {
        return {
            window,
            evaluatedReruns: perRerun.length,
            qualifyingReruns: 0,
            positiveReruns: 0,
            medianNetReturnPct: null,
            p10NetReturnPct: null,
            medianWinRate: null,
            medianLiftOverImmediatePct: null,
            totalEpisodes: 0,
        };
    }
    const medians = qualifying.map((r) => r.medianReturnPct).sort((a, b) => a - b);
    const lifts = qualifying.map((r) => r.medianLiftPct).filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
    const winRates = qualifying.map((r) => {
        const wins = r.episodeReturnsPct.filter((v) => v > 0).length;
        return r.episodeReturnsPct.length > 0 ? wins / r.episodeReturnsPct.length : 0;
    }).sort((a, b) => a - b);
    // track the POSITIVE-rerun count separately from bare
    // coverage (qualifyingReruns). Selection ranking orders by positive-rerun
    // rate; the validation gate divides positive-reruns by validation-evaluable
    // matching-direction reruns for the 60% threshold.
    const positiveReruns = qualifying.filter((r) => r.medianReturnPct > 0).length;
    return {
        window,
        evaluatedReruns: perRerun.length,
        qualifyingReruns: qualifying.length,
        positiveReruns,
        medianNetReturnPct: percentile(medians, 0.5),
        p10NetReturnPct: percentile(medians, 0.1),
        medianWinRate: percentile(winRates, 0.5),
        medianLiftOverImmediatePct: lifts.length > 0 ? percentile(lifts, 0.5) : null,
        totalEpisodes: qualifying.reduce((s, r) => s + r.episodes, 0),
    };
}

// ---------------------------------------------------------------------------
// Gates
// ---------------------------------------------------------------------------

function windowQualifiesRecurrence(
    window: TimingSurfaceCellWindowMetrics,
    gates: TimingSurfaceGates,
    reruns: number,
): boolean {
    if (window.qualifyingReruns < gates.minQualifyingReruns) return false;
    if (window.qualifyingReruns / Math.max(1, reruns) < gates.minRecurrenceFraction) return false;
    return true;
}

function cellQualifiesDiscovery(cell: CellMetrics, gates: TimingSurfaceGates, reruns: number): boolean {
    return windowQualifiesRecurrence(cell.discovery, gates, reruns);
}

function cellPassesDiscoveryRules(cell: CellMetrics): boolean {
    // delay-zero requires positive median net return in discovery;
    // delayed cells additionally require positive median lift over immediate.
    const discoveryNet = cell.discovery.medianNetReturnPct;
    if (discoveryNet === null || discoveryNet <= 0) return false;
    if (cell.delay > 0) {
        const lift = cell.discovery.medianLiftOverImmediatePct;
        if (lift === null || lift <= 0) return false;
    }
    return true;
}

function cellPassesSelectionRules(cell: CellMetrics): boolean {
    // same rule in selection.
    const selectionNet = cell.selection.medianNetReturnPct;
    if (selectionNet === null || selectionNet <= 0) return false;
    if (cell.delay > 0) {
        const lift = cell.selection.medianLiftOverImmediatePct;
        if (lift === null || lift <= 0) return false;
    }
    return true;
}

function compareCellsForSelection(a: CellMetrics, b: CellMetrics): number {
    // selection positive-rerun rate, median lift, median net
    // return, lower delay, shorter horizon. Earlier versions used
    // qualifyingReruns (coverage), which ranked "many reruns with episodes"
    // above "fewer reruns with positive returns" — the opposite of intent.
    const positiveRateA = a.selection.positiveReruns / Math.max(1, a.selection.qualifyingReruns);
    const positiveRateB = b.selection.positiveReruns / Math.max(1, b.selection.qualifyingReruns);
    if (positiveRateA !== positiveRateB) return positiveRateB - positiveRateA;
    if (a.selection.positiveReruns !== b.selection.positiveReruns) {
        return b.selection.positiveReruns - a.selection.positiveReruns;
    }
    const liftA = a.selection.medianLiftOverImmediatePct ?? -Infinity;
    const liftB = b.selection.medianLiftOverImmediatePct ?? -Infinity;
    if (liftA !== liftB) return liftB - liftA;
    const netA = a.selection.medianNetReturnPct ?? -Infinity;
    const netB = b.selection.medianNetReturnPct ?? -Infinity;
    if (netA !== netB) return netB - netA;
    if (a.delay !== b.delay) return a.delay - b.delay;
    return a.horizon - b.horizon;
}

/** Pick one deterministic cell for diagnostics when discovery cannot advance. */
function selectDiagnosticCell(cells: ReadonlyArray<CellMetrics>): CellMetrics | null {
    if (cells.length === 0) return null;
    return [...cells].sort((a, b) => {
        if (a.discovery.qualifyingReruns !== b.discovery.qualifyingReruns) {
            return b.discovery.qualifyingReruns - a.discovery.qualifyingReruns;
        }
        if (a.discovery.positiveReruns !== b.discovery.positiveReruns) {
            return b.discovery.positiveReruns - a.discovery.positiveReruns;
        }
        const netA = a.discovery.medianNetReturnPct ?? -Infinity;
        const netB = b.discovery.medianNetReturnPct ?? -Infinity;
        if (netA !== netB) return netB - netA;
        if (a.delay !== b.delay) return a.delay - b.delay;
        return a.horizon - b.horizon;
    })[0]!;
}

interface PlateauInfo {
    positiveNeighbors: number;
    availableNeighbors: number;
    neighborDelays: TimingSurfaceDelay[];
    neighborHorizons: number[];
}

function emptyPlateau(): PlateauInfo {
    return {
        positiveNeighbors: 0,
        availableNeighbors: 0,
        neighborDelays: [],
        neighborHorizons: [],
    };
}

function plateauPasses(plateau: PlateauInfo, gates: TimingSurfaceGates): boolean {
    return plateau.availableNeighbors >= gates.plateauMinPositiveNeighbors
        && plateau.positiveNeighbors >= gates.plateauMinPositiveNeighbors;
}

function resolveSelectionRejectionReason(
    selectionCandidate: CellMetrics | null,
    plateau: PlateauInfo,
): TimingSurfaceReasonCode {
    if (selectionCandidate === null) return "NO_POSITIVE_SELECTION";
    return plateau.positiveNeighbors === 0 ? "ISOLATED_OPTIMUM" : "NO_PLATEAU";
}

/**
 * Plateau detection is restricted to strictly adjacent orthogonal neighbors:
 * same delay + horizon ±1 step, or same
 * horizon + delay ±1 step. Earlier versions counted every cell in the same
 * row or column as a neighbor, which let a distant positive cell support an
 * isolated optimum.
 *
 * Horizon adjacency is "one step in the sorted-unique horizon grid" (the grid
 * is target-specific, so strict ±1 bar is the wrong comparator).
 */
function computePlateau(
    cell: CellMetrics,
    all: Map<string, CellMetrics>,
    horizons: number[],
    gates: TimingSurfaceGates,
    reruns: number,
): PlateauInfo {
    const neighborDelays: TimingSurfaceDelay[] = [];
    const neighborHorizons: number[] = [];
    let positive = 0;
    let available = 0;
    const sortedHorizons = [...horizons].sort((a, b) => a - b);
    const hIndex = sortedHorizons.indexOf(cell.horizon);
    const adjacentHorizons = new Set<number>();
    if (hIndex > 0) adjacentHorizons.add(sortedHorizons[hIndex - 1]!);
    if (hIndex >= 0 && hIndex < sortedHorizons.length - 1) adjacentHorizons.add(sortedHorizons[hIndex + 1]!);
    const adjacentDelays = new Set<TimingSurfaceDelay>();
    for (const d of TIMING_SURFACE_DELAYS) {
        if (Math.abs(d - cell.delay) === 1) adjacentDelays.add(d);
    }
    // Same delay, adjacent horizon step.
    for (const h of adjacentHorizons) {
        const other = all.get(cellKey(cell.delay, h));
        if (!other) continue;
        available += 1;
        neighborDelays.push(other.delay);
        neighborHorizons.push(other.horizon);
        const net = other.selection.medianNetReturnPct;
        if (windowQualifiesRecurrence(other.selection, gates, reruns) && net !== null && net > 0) positive += 1;
    }
    // Same horizon, adjacent delay step.
    for (const d of adjacentDelays) {
        const other = all.get(cellKey(d, cell.horizon));
        if (!other) continue;
        available += 1;
        neighborDelays.push(other.delay);
        neighborHorizons.push(other.horizon);
        const net = other.selection.medianNetReturnPct;
        if (windowQualifiesRecurrence(other.selection, gates, reruns) && net !== null && net > 0) positive += 1;
    }
    return {
        positiveNeighbors: positive,
        availableNeighbors: available,
        neighborDelays,
        neighborHorizons,
    };
}

interface ValidationOutcome {
    passed: boolean;
    shouldSkip: boolean;
}

function passesValidationGate(cell: CellMetrics, gates: TimingSurfaceGates): ValidationOutcome {
    // 60% of validation-evaluable matching-direction reruns net
    // positive, median validation net positive, and (delay>0) median
    // validation lift positive. Earlier versions divided qualifyingReruns
    // (coverage), which made the 60% gate pass whenever enough reruns had
    // episodes — even if every one lost money.
    if (cell.validation.qualifyingReruns === 0) {
        // Insufficient validation evidence produces WATCH, never SKIP.
        return { passed: false, shouldSkip: false };
    }
    if (cell.validation.positiveReruns / Math.max(1, cell.validation.qualifyingReruns) < gates.validationPositiveRerunFraction) {
        // Fewer than 60% of validation-evaluable matching-direction reruns are
        // net positive. If median is also non-positive, this is negative
        // expectancy produces SKIP; otherwise it remains WATCH.
        const net = cell.validation.medianNetReturnPct;
        const shouldSkip = net !== null && net <= 0;
        return { passed: false, shouldSkip };
    }
    const net = cell.validation.medianNetReturnPct;
    if (net === null || net <= 0) {
        // Negative validation expectancy produces SKIP.
        return { passed: false, shouldSkip: true };
    }
    if (cell.delay > 0) {
        const lift = cell.validation.medianLiftOverImmediatePct;
        if (lift === null || lift <= 0) {
            // Non-positive required lift for a delayed policy produces SKIP.
            return { passed: false, shouldSkip: true };
        }
    }
    return { passed: true, shouldSkip: false };
}

// ---------------------------------------------------------------------------
// Row builders
// ---------------------------------------------------------------------------

function buildSelectedRow(
    stabilityRow: BatchStabilityRow,
    action: "ENTER" | "WATCH" | "WAIT" | "REJECT" | "INVALID",
    decision: TimingSurfaceDecision,
    frozen: CellMetrics,
    plateau: PlateauInfo,
    target: BatchSyntheticPreparedTargetArtifact,
    reasonCodes?: TimingSurfaceReasonCode[],
): TimingSurfaceRow {
    // Compute revalidation bar/time when delay > 0.  a delayed
    // winner produces WAIT_n; it is not a scheduled entry. The user reruns at
    // the delayed bar.
    const currentBarIndex = target.data.length - 1;
    const isDelayedAction = decision === "WAIT_1" || decision === "WAIT_2" || decision === "WAIT_3";
    const revalidationBarIndex = isDelayedAction ? currentBarIndex + frozen.delay : null;
    const resolvedReasons = reasonCodes ?? (decision === "ENTER_NOW"
        ? ["ACTIONABLE_NOW", "ACCEPTED_PLATEAU"]
        : ["AWAITING_REVALIDATION", "ACCEPTED_PLATEAU"]);
    return {
        asset: stabilityRow.asset,
        direction: stabilityRow.direction,
        decision,
        reasonCodes: resolvedReasons,
        chosenDelay: frozen.delay,
        chosenHorizon: frozen.horizon,
        evidenceDelay: frozen.delay,
        evidenceHorizon: frozen.horizon,
        asOfTimeKey: stabilityRow.asOfTimeKey,
        revalidationBarIndex,
        sourceStabilityAction: action,
        discoveryEpisodes: frozen.discovery.totalEpisodes,
        selectionEpisodes: frozen.selection.totalEpisodes,
        validationEpisodes: frozen.validation.totalEpisodes,
        discoveryEvaluatedReruns: frozen.discovery.evaluatedReruns,
        selectionEvaluatedReruns: frozen.selection.evaluatedReruns,
        validationEvaluatedReruns: frozen.validation.evaluatedReruns,
        discoveryQualifyingReruns: frozen.discovery.qualifyingReruns,
        selectionQualifyingReruns: frozen.selection.qualifyingReruns,
        validationQualifyingReruns: frozen.validation.qualifyingReruns,
        discoveryPositiveReruns: frozen.discovery.positiveReruns,
        selectionPositiveReruns: frozen.selection.positiveReruns,
        validationPositiveReruns: frozen.validation.positiveReruns,
        selectionMedianNetReturnPct: frozen.selection.medianNetReturnPct,
        selectionP10NetReturnPct: frozen.selection.p10NetReturnPct,
        selectionMedianLiftPct: frozen.selection.medianLiftOverImmediatePct,
        validationMedianNetReturnPct: frozen.validation.medianNetReturnPct,
        validationP10NetReturnPct: frozen.validation.p10NetReturnPct,
        validationMedianLiftPct: frozen.validation.medianLiftOverImmediatePct,
        medianWinRate: frozen.selection.medianWinRate,
        plateauPositiveNeighborCount: plateau.positiveNeighbors,
        sourceTimingEdgeScore: stabilityRow.timingEdgeScore,
    };
}

/**
 * Preserve the strongest available cell's measured evidence on a WATCH row
 * without presenting that diagnostic cell as a frozen trading policy.
 */
function buildEvidenceWatchRow(
    stabilityRow: BatchStabilityRow,
    evidenceCell: CellMetrics,
    plateau: PlateauInfo,
    target: BatchSyntheticPreparedTargetArtifact,
    reasonCodes: TimingSurfaceReasonCode[],
): TimingSurfaceRow {
    return {
        ...buildSelectedRow(stabilityRow, "ENTER", "WATCH", evidenceCell, plateau, target, reasonCodes),
        chosenDelay: null,
        chosenHorizon: null,
        revalidationBarIndex: null,
    };
}

function buildWatchRow(
    stabilityRow: BatchStabilityRow,
    action: "ENTER" | "WATCH" | "WAIT" | "REJECT" | "INVALID",
    reasonCodes: TimingSurfaceReasonCode[],
): TimingSurfaceRow {
    return {
        asset: stabilityRow.asset,
        direction: stabilityRow.direction,
        decision: "WATCH",
        reasonCodes,
        chosenDelay: null,
        chosenHorizon: null,
        evidenceDelay: null,
        evidenceHorizon: null,
        asOfTimeKey: stabilityRow.asOfTimeKey,
        revalidationBarIndex: null,
        sourceStabilityAction: action,
        discoveryEpisodes: 0,
        selectionEpisodes: 0,
        validationEpisodes: 0,
        discoveryEvaluatedReruns: 0,
        selectionEvaluatedReruns: 0,
        validationEvaluatedReruns: 0,
        discoveryQualifyingReruns: 0,
        selectionQualifyingReruns: 0,
        validationQualifyingReruns: 0,
        discoveryPositiveReruns: 0,
        selectionPositiveReruns: 0,
        validationPositiveReruns: 0,
        selectionMedianNetReturnPct: null,
        selectionP10NetReturnPct: null,
        selectionMedianLiftPct: null,
        validationMedianNetReturnPct: null,
        validationP10NetReturnPct: null,
        validationMedianLiftPct: null,
        medianWinRate: null,
        plateauPositiveNeighborCount: 0,
        sourceTimingEdgeScore: stabilityRow.timingEdgeScore,
    };
}

function buildInvalidRow(
    stabilityRow: BatchStabilityRow,
    action: "ENTER" | "WATCH" | "WAIT" | "REJECT" | "INVALID",
    reasonCodes: TimingSurfaceReasonCode[],
): TimingSurfaceRow {
    return {
        asset: stabilityRow.asset,
        direction: stabilityRow.direction,
        decision: "INVALID",
        reasonCodes,
        chosenDelay: null,
        chosenHorizon: null,
        evidenceDelay: null,
        evidenceHorizon: null,
        asOfTimeKey: stabilityRow.asOfTimeKey,
        revalidationBarIndex: null,
        sourceStabilityAction: action,
        discoveryEpisodes: 0,
        selectionEpisodes: 0,
        validationEpisodes: 0,
        discoveryEvaluatedReruns: 0,
        selectionEvaluatedReruns: 0,
        validationEvaluatedReruns: 0,
        discoveryQualifyingReruns: 0,
        selectionQualifyingReruns: 0,
        validationQualifyingReruns: 0,
        discoveryPositiveReruns: 0,
        selectionPositiveReruns: 0,
        validationPositiveReruns: 0,
        selectionMedianNetReturnPct: null,
        selectionP10NetReturnPct: null,
        selectionMedianLiftPct: null,
        validationMedianNetReturnPct: null,
        validationP10NetReturnPct: null,
        validationMedianLiftPct: null,
        medianWinRate: null,
        plateauPositiveNeighborCount: 0,
        sourceTimingEdgeScore: stabilityRow.timingEdgeScore,
    };
}

function buildRowCells(
    cells: CellMetrics[],
    horizons: number[],
    gates: TimingSurfaceGates,
): TimingSurfaceRowCells {
    const uniqueHorizons = Array.from(new Set(cells.flatMap((c) => [c.horizon]).concat(horizons))).sort((a, b) => a - b);
    const summaries: TimingSurfaceScalarCellSummary[] = cells.slice(0, gates.maxCellsPerResult).map((c) => ({
        delay: c.delay,
        horizon: c.horizon,
        discoveryMedianNetReturnPct: c.discovery.medianNetReturnPct,
        selectionMedianNetReturnPct: c.selection.medianNetReturnPct,
        validationMedianNetReturnPct: c.validation.medianNetReturnPct,
        discoveryQualifyingReruns: c.discovery.qualifyingReruns,
        selectionQualifyingReruns: c.selection.qualifyingReruns,
        validationQualifyingReruns: c.validation.qualifyingReruns,
    }));
    return {
        delays: [...TIMING_SURFACE_DELAYS],
        horizons: uniqueHorizons,
        cells: summaries,
    };
}

// ---------------------------------------------------------------------------
// Deterministic helpers
// ---------------------------------------------------------------------------

function cellKey(delay: TimingSurfaceDelay, horizon: number): string {
    return `${delay}|${horizon}`;
}

function percentile(sortedAsc: number[], p: number): number {
    if (sortedAsc.length === 0) return 0;
    if (sortedAsc.length === 1) return sortedAsc[0]!;
    // Linear interpolation between closest ranks.
    const rank = p * (sortedAsc.length - 1);
    const lower = Math.floor(rank);
    const upper = Math.ceil(rank);
    if (lower === upper) return sortedAsc[lower]!;
    const weight = rank - lower;
    return sortedAsc[lower]! * (1 - weight) + sortedAsc[upper]! * weight;
}

function median(values: number[]): number | null {
    if (values.length === 0) return null;
    const sorted = [...values].filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
    if (sorted.length === 0) return null;
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function now(): number {
    return typeof performance !== "undefined" && typeof performance.now === "function"
        ? performance.now()
        : Date.now();
}

function roundMs(value: number): number {
    if (!Number.isFinite(value)) return 0;
    return Math.round(value * 1000) / 1000;
}

export const __testInternals = {
    buildWindowEpisodesForCell,
    aggregateWindow,
    compareCellsForSelection,
    resolveSelectionRejectionReason,
    buildEvidenceWatchRow,
    buildSelectedRow,
    passesValidationGate,
    plateauPasses,
    windowQualifiesRecurrence,
};
