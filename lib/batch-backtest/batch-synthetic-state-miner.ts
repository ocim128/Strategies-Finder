import { timeKey } from "../strategies";
import type { BacktestResult, OHLCVData, Signal, Trade } from "../types/strategies";
import {
    computeAdverseExcursionAtr,
    computeAtrAt,
    computeDirectionalAtrDistance,
    computeDirectionalPercentMove,
} from "../portfolioLab/portfolio-lab-statistics";

export type BatchSyntheticDirection = "long" | "short";
export type BatchSyntheticVerdict = "LONG" | "SHORT" | "WATCH" | "SKIP" | "INCONCLUSIVE";
export type BatchSyntheticConfidence = "high" | "medium" | "low" | "none";
export type BatchSyntheticWindow = "discovery" | "selection" | "oos";
export type BatchSyntheticPairContributionLabel = "useful" | "neutral" | "harmful" | "dominating" | "opposing";

export interface BatchSyntheticTargetArtifact {
    asset: string;
    symbol: string;
    data: OHLCVData[];
}

export interface BatchSyntheticPairArtifact {
    symbol: string;
    baseAsset: string;
    quoteAsset: string;
    /**
     * Marked forms of the legs (e.g. `AAPL•`, `NVDA♦`) when the pair came
     * from a non-crypto source. Forwarded so the miner target loader can
     * resolve the correct provider symbol instead of blindly appending
     * `USDT`. Optional because legacy callers/tests construct artifacts
     * directly with only the stripped asset names.
     */
    baseSymbol?: string;
    quoteSymbol?: string;
    data: OHLCVData[];
    signals: Signal[];
    result: BacktestResult;
}

export interface BatchSyntheticMinerOptions {
    lagBars: number;
    horizons: number[];
    /**
     * When true, derive `horizons` per target from the median hold of linked
     * synthetic-pair trades. The strategy edge lives on the order of the
     * strategy's hold time, so a fixed 6-bar label silently misses it on
     * higher timeframes (e.g. 4H median hold 315b vs 6b = 24h label).
     * Default true. Explicit `horizons` in input opts out.
     */
    autoHorizons: boolean;
    targetQuoteSuffix: "USDT";
    minSamples: number;
    minOosSamples: number;
    neighborCountMin: number;
    neighborCountMax: number;
    maxEntryDistance: number;
    minEntryReturnPct: number;
    minEntryLiftPct: number;
    minMfeMaeRatio: number;
}

export interface BatchSyntheticMinerInput {
    interval: string;
    targets: BatchSyntheticTargetArtifact[];
    artifacts: BatchSyntheticPairArtifact[];
    options?: Partial<BatchSyntheticMinerOptions>;
}

export interface BatchSyntheticStateSnapshot {
    asset: string;
    direction: BatchSyntheticDirection | null;
    timeKey: string;
    barIndex: number;
    close: number | null;
    activePeerCount: number;
    agreementCount: number;
    oppositionCount: number;
    agreementRatio: number;
    oppositionRatio: number;
    netAgreement: number;
    agreementTransition: number;
    medianBarsHeld: number | null;
    medianMoveSinceEntryPct: number | null;
    medianMoveSinceEntryAtr: number | null;
    medianAdverseExcursionAtr: number | null;
    breadthPersistence: number;
    agreeingSymbols: string[];
    opposingSymbols: string[];
}

export interface BatchSyntheticCandidateSample {
    snapshot: BatchSyntheticStateSnapshot;
    window: BatchSyntheticWindow;
    forwardReturnPct: number;
    futureMfePct: number;
    futureMaePct: number;
    /**
     * Per-horizon outcomes keyed by horizon in bars. The primary
     * (`forwardReturnPct`/`futureMfePct`/`futureMaePct`) fields always mirror
     * the shortest configured horizon for backward compatibility; the verdict
     * engine reads the longest horizon from this map to check the edge
     * survives to exit scale.
     */
    outcomesByHorizon: Map<number, { forwardReturnPct: number; futureMfePct: number; futureMaePct: number }>;
}

export interface BatchSyntheticVerdictEvidence {
    horizonBars: number;
    /** All horizons evaluated, ascending. Primary horizon is `horizonBars`. */
    horizonBarsAll: number[];
    candidateCount: number;
    analogCount: number;
    selectionCount: number;
    oosCount: number;
    avgDistance: number | null;
    selectionForwardReturnPct: number | null;
    selectionMfePct: number | null;
    selectionMaePct: number | null;
    expectedForwardReturnPct: number | null;
    expectedMfePct: number | null;
    expectedMaePct: number | null;
    baselineOosReturnPct: number | null;
    oosLiftPct: number | null;
    /**
     * Longest-horizon OOS forward return. The strategy edge lives at the
     * strategy's hold scale; requiring the edge to persist at the longest
     * horizon filters one-bar drift that does not survive to exit.
     */
    longestHorizonBars: number | null;
    longestOosForwardReturnPct: number | null;
    longestOosLiftPct: number | null;
}

export interface BatchSyntheticPairContribution {
    symbol: string;
    side: "agreeing" | "opposing";
    label: BatchSyntheticPairContributionLabel;
    oosCountWithout: number;
    oosReturnWithoutPct: number | null;
    returnDeltaPct: number | null;
}

export interface BatchSyntheticAssetVerdict {
    asset: string;
    verdict: BatchSyntheticVerdict;
    direction: BatchSyntheticDirection | null;
    confidence: BatchSyntheticConfidence;
    currentSnapshot: BatchSyntheticStateSnapshot | null;
    evidence: BatchSyntheticVerdictEvidence;
    pairContributions: BatchSyntheticPairContribution[];
    reasons: string[];
    diagnostics: string[];
}

export interface BatchSyntheticMinerResult {
    interval: string;
    options: BatchSyntheticMinerOptions;
    verdicts: BatchSyntheticAssetVerdict[];
    diagnostics: string[];
}

interface TradeRange {
    trade: Trade;
    entryIndex: number;
    exitIndex: number;
}

interface IndexedSignal {
    signal: Signal;
    index: number;
    direction: BatchSyntheticDirection;
}

interface PreparedPairArtifact extends BatchSyntheticPairArtifact {
    timeIndex: Map<string, number>;
    openTradeByIndex: Array<TradeRange | null>;
    /**
     * Closed trade ranges (entry/exit both present). Used to derive an
     * unbiased median hold for auto-horizons. `openTradeByIndex` only carries
     * still-open or end_of_data trades, which over-represents long holds
     * (survivor bias) — using it for horizon calibration inflates horizons
     * 3-5x on higher timeframes and starves the candidate span.
     */
    closedTradeRanges: TradeRange[];
    signalsByIndex: IndexedSignal[][];
}

interface PairState {
    symbol: string;
    direction: BatchSyntheticDirection;
    barsHeld: number;
    moveSinceEntryPct: number;
    moveSinceEntryAtr: number;
    adverseExcursionAtr: number;
}

interface LabeledAnalog {
    sample: BatchSyntheticCandidateSample;
    distance: number;
}

const DEFAULT_OPTIONS: BatchSyntheticMinerOptions = {
    lagBars: 3,
    horizons: [6, 12, 24],
    autoHorizons: true,
    targetQuoteSuffix: "USDT",
    minSamples: 12,
    minOosSamples: 4,
    neighborCountMin: 4,
    neighborCountMax: 24,
    maxEntryDistance: 3,
    minEntryReturnPct: 0.05,
    minEntryLiftPct: 0.03,
    minMfeMaeRatio: 1.25,
};

const TRANSITION_LOOKBACK_BARS = 6;

export function runBatchSyntheticStateMiner(input: BatchSyntheticMinerInput): BatchSyntheticMinerResult {
    const options = resolveOptions(input.options);
    const diagnostics: string[] = [];
    const preparedPairs = preparePairArtifacts(input.artifacts, diagnostics);
    const targets = input.targets
        .map((target) => ({
            ...target,
            asset: normalizeAsset(target.asset),
            timeIndex: buildTimeIndex(target.data),
        }))
        .filter((target) => {
            if (!target.asset || target.data.length === 0) {
                diagnostics.push(`Skipped target ${target.symbol || target.asset}: no candles.`);
                return false;
            }
            return true;
        });

    const verdicts = targets
        .map((target) => buildAssetVerdict(target, preparedPairs, options))
        .sort((a, b) => verdictRank(a.verdict) - verdictRank(b.verdict) || a.asset.localeCompare(b.asset));

    return {
        interval: input.interval,
        options,
        verdicts,
        diagnostics,
    };
}

function resolveOptions(raw?: Partial<BatchSyntheticMinerOptions>): BatchSyntheticMinerOptions {
    const options = { ...DEFAULT_OPTIONS, ...raw };
    // Explicit horizons opt out of auto-horizons: a caller who pins horizons
    // wants exactly those values, not median-hold-derived ones.
    const pinnedHorizons = Array.isArray(raw?.horizons) && raw!.horizons.length > 0 ? raw!.horizons : null;
    const horizons = (pinnedHorizons ?? DEFAULT_OPTIONS.horizons)
        .map((value) => Math.max(1, Math.floor(value)))
        .filter((value, index, array) => array.indexOf(value) === index)
        .sort((a, b) => a - b);
    return {
        ...options,
        lagBars: Math.max(0, Math.floor(options.lagBars)),
        horizons,
        autoHorizons: pinnedHorizons !== null ? false : options.autoHorizons !== false,
        minSamples: Math.max(1, Math.floor(options.minSamples)),
        minOosSamples: Math.max(1, Math.floor(options.minOosSamples)),
        neighborCountMin: Math.max(1, Math.floor(options.neighborCountMin)),
        neighborCountMax: Math.max(1, Math.floor(options.neighborCountMax)),
        maxEntryDistance: Math.max(0.1, Number.isFinite(options.maxEntryDistance) ? options.maxEntryDistance : DEFAULT_OPTIONS.maxEntryDistance),
        minEntryReturnPct: Math.max(0, Number.isFinite(options.minEntryReturnPct) ? options.minEntryReturnPct : DEFAULT_OPTIONS.minEntryReturnPct),
        minEntryLiftPct: Math.max(0, Number.isFinite(options.minEntryLiftPct) ? options.minEntryLiftPct : DEFAULT_OPTIONS.minEntryLiftPct),
        minMfeMaeRatio: Math.max(1, Number.isFinite(options.minMfeMaeRatio) ? options.minMfeMaeRatio : DEFAULT_OPTIONS.minMfeMaeRatio),
        targetQuoteSuffix: "USDT",
    };
}

function preparePairArtifacts(
    artifacts: readonly BatchSyntheticPairArtifact[],
    diagnostics: string[]
): PreparedPairArtifact[] {
    const prepared: PreparedPairArtifact[] = [];
    for (const artifact of artifacts) {
        const baseAsset = normalizeAsset(artifact.baseAsset);
        const quoteAsset = normalizeAsset(artifact.quoteAsset);
        if (!artifact.symbol || !baseAsset || !quoteAsset || baseAsset === quoteAsset || artifact.data.length === 0) {
            diagnostics.push(`Skipped pair ${artifact.symbol || "(unknown)"}: invalid synthetic metadata or no candles.`);
            continue;
        }
        const timeIndex = buildTimeIndex(artifact.data);
        const trades = artifact.result.trades ?? [];
        prepared.push({
            ...artifact,
            baseAsset,
            quoteAsset,
            timeIndex,
            openTradeByIndex: buildOpenTradeIndex(trades, artifact.data, timeIndex),
            closedTradeRanges: buildClosedTradeRanges(trades, timeIndex),
            signalsByIndex: buildSignalIndex(artifact.signals ?? [], artifact.data, timeIndex),
        });
    }
    return prepared;
}

function buildAssetVerdict(
    target: BatchSyntheticTargetArtifact & { timeIndex: Map<string, number> },
    pairs: readonly PreparedPairArtifact[],
    options: BatchSyntheticMinerOptions
): BatchSyntheticAssetVerdict {
    const linkedPairs = pairs.filter((pair) => pair.baseAsset === target.asset || pair.quoteAsset === target.asset);
    const diagnostics: string[] = [];
    // Resolve the per-target horizon set. Auto-horizons derive from the median
    // hold of linked synthetic-pair trades, because the strategy edge lives at
    // the strategy's hold scale. A fixed 6-bar label silently misses the edge
    // on higher timeframes (4H median hold 315b vs 6b = 24h label).
    const horizons = resolveHorizonsForTarget(options, linkedPairs, target.data.length);
    const primaryHorizon = horizons[0] ?? 6;
    const longestHorizon = horizons[horizons.length - 1] ?? primaryHorizon;
    const emptyEvidence = createEmptyEvidence(primaryHorizon, horizons);
    if (linkedPairs.length === 0) {
        return createAssetVerdict(target.asset, "INCONCLUSIVE", null, null, emptyEvidence, [], [`No linked synthetic pairs for ${target.asset}.`], diagnostics);
    }
    if (target.data.length <= longestHorizon + 2) {
        return createAssetVerdict(target.asset, "INCONCLUSIVE", null, null, emptyEvidence, [], [`Not enough target candles for horizon ${longestHorizon}.`], diagnostics);
    }

    const currentSnapshot = buildSnapshotAt(target.asset, target.data.length - 1, target.data, linkedPairs, options);
    if (!currentSnapshot || !currentSnapshot.direction) {
        return createAssetVerdict(target.asset, "INCONCLUSIVE", null, currentSnapshot, emptyEvidence, [], ["No active current synthetic state."], diagnostics);
    }

    const samples = buildCandidateSamples(target.asset, target.data, linkedPairs, options, horizons)
        .filter((sample) => sample.snapshot.direction === currentSnapshot.direction);
    // Window split MUST be by bar position over the CANDIDATE span, not sample
    // ordinal and not the full target history. Candidates can only exist in
    // bars [0, length-1-longestHorizon] (a sample at bar i needs i+longestHorizon
    // <= length-1). Splitting over full history puts the OOS band (top 20%)
    // past where any candidate can live, so every sample lands in discovery or
    // selection and OOS is starved ("Pre 24, OOS 0"). Splitting over the
    // candidate span keeps the OOS band reachable.
    const candidateSpan = Math.max(1, target.data.length - longestHorizon);
    for (const sample of samples) {
        sample.window = resolveWindow(sample.snapshot.barIndex, candidateSpan);
    }
    if (samples.length < options.minSamples) {
        return createAssetVerdict(
            target.asset,
            "INCONCLUSIVE",
            currentSnapshot.direction,
            currentSnapshot,
            { ...emptyEvidence, candidateCount: samples.length },
            [],
            [`Only ${samples.length} historical analog candidates; need ${options.minSamples}.`],
            diagnostics
        );
    }

    // Calibrate distance scales from discovery+selection samples ONLY. The
    // newest OOS window must not influence the metric used to judge it
    // (the plan forbids tuning on the eval window). Scales are frozen here
    // before any analog selection.
    const preOosSamples = samples.filter((sample) => sample.window !== "oos");
    const distanceScales = calibrateDistanceScales(preOosSamples);

    const selectionAnalogs = selectAnalogs(currentSnapshot, preOosSamples, options, distanceScales);
    const oosAnalogs = selectAnalogs(
        currentSnapshot,
        samples.filter((sample) => sample.window === "oos"),
        options,
        distanceScales
    );
    const analogs = [...selectionAnalogs, ...oosAnalogs];
    const oosBaseline = summarizeSamples(samples.filter((sample) => sample.window === "oos"), primaryHorizon);
    const selectionSummary = summarizeSamples(selectionAnalogs.map((analog) => analog.sample), primaryHorizon);
    const analogSummary = summarizeSamples(oosAnalogs.map((analog) => analog.sample), primaryHorizon);
    const longestOosSummary = summarizeSamples(oosAnalogs.map((analog) => analog.sample), longestHorizon);
    const longestOosBaseline = summarizeSamples(samples.filter((sample) => sample.window === "oos"), longestHorizon);
    const evidence: BatchSyntheticVerdictEvidence = {
        horizonBars: primaryHorizon,
        horizonBarsAll: horizons,
        candidateCount: samples.length,
        analogCount: analogs.length,
        selectionCount: selectionAnalogs.length,
        oosCount: oosAnalogs.length,
        avgDistance: average(analogs.map((analog) => analog.distance)),
        selectionForwardReturnPct: selectionSummary.avgReturnPct,
        selectionMfePct: selectionSummary.avgMfePct,
        selectionMaePct: selectionSummary.avgMaePct,
        expectedForwardReturnPct: analogSummary.avgReturnPct,
        expectedMfePct: analogSummary.avgMfePct,
        expectedMaePct: analogSummary.avgMaePct,
        baselineOosReturnPct: oosBaseline.avgReturnPct,
        oosLiftPct: analogSummary.avgReturnPct !== null && oosBaseline.avgReturnPct !== null
            ? analogSummary.avgReturnPct - oosBaseline.avgReturnPct
            : null,
        longestHorizonBars: longestHorizon,
        longestOosForwardReturnPct: longestOosSummary.avgReturnPct,
        longestOosLiftPct: longestOosSummary.avgReturnPct !== null && longestOosBaseline.avgReturnPct !== null
            ? longestOosSummary.avgReturnPct - longestOosBaseline.avgReturnPct
            : null,
    };

    const reasons: string[] = [];
    const pairContributions = buildPairContributions(currentSnapshot, oosAnalogs, evidence);
    const verdict = classifyVerdict(evidence, currentSnapshot, options, reasons);
    const confidence = classifyConfidence(verdict, evidence, options);
    return createAssetVerdict(
        target.asset,
        verdict,
        currentSnapshot.direction,
        currentSnapshot,
        evidence,
        pairContributions,
        reasons,
        diagnostics
    , confidence);
}

/**
 * Resolve the horizon set for one target. If `autoHorizons` is on (default),
 * derive from the median hold (in bars) of CLOSED linked synthetic-pair trades:
 * roughly `[0.5x, 1x, 2x]` of median hold. Closed trades are unbiased; open /
 * `end_of_data` trades over-represent long holds (survivor bias) and inflate
 * horizons 3-5x on higher timeframes. Horizons are clamped so the longest
 * never exceeds the candidate span (length-1 minus the longest horizon must
 * still leave room for the OOS window); falls back to `options.horizons` when
 * there are no closed trades or the caller pinned horizons explicitly.
 */
function resolveHorizonsForTarget(
    options: BatchSyntheticMinerOptions,
    linkedPairs: readonly PreparedPairArtifact[],
    targetLength: number
): number[] {
    const fallback = options.horizons;
    if (!options.autoHorizons) {
        return clampHorizonsToCandidateSpan(fallback, targetLength);
    }
    const holdBars: number[] = [];
    for (const pair of linkedPairs) {
        for (const range of pair.closedTradeRanges) {
            holdBars.push(Math.max(1, range.exitIndex - range.entryIndex));
        }
    }
    const medianHold = median(holdBars);
    if (medianHold === null || medianHold < 1) {
        return clampHorizonsToCandidateSpan(fallback, targetLength);
    }
    const mults = [0.5, 1, 2];
    const raw = mults
        .map((mult) => Math.max(1, Math.round(medianHold * mult)))
        .filter((value, index, array) => array.indexOf(value) === index)
        .sort((a, b) => a - b);
    return raw.length > 0
        ? clampHorizonsToCandidateSpan(raw, targetLength)
        : clampHorizonsToCandidateSpan(fallback, targetLength);
}

/**
 * Clamp the longest horizon so at least the OOS window (top 20% of the
 * candidate span) can still produce samples. Without this, a horizon longer
 * than ~80% of `targetLength` makes `lastIndex = length-1-longestHorizon`
 * fall inside the selection window, and every candidate ends up labeled
 * "discovery" or "selection" — never OOS (the "Pre 24, OOS 0" pattern).
 */
function clampHorizonsToCandidateSpan(horizons: number[], targetLength: number): number[] {
    if (horizons.length === 0) {
        return [6];
    }
    // Reserve the top 25% of bars for OOS labels; the longest horizon must
    // leave at least that many bars after the last candidate.
    const maxLongest = Math.max(1, Math.floor(targetLength * 0.75) - 1);
    const clamped = horizons.map((h) => Math.max(1, Math.min(h, maxLongest)));
    // De-dup after clamping can collapse entries.
    return clamped
        .filter((value, index, array) => array.indexOf(value) === index)
        .sort((a, b) => a - b);
}

function buildCandidateSamples(
    asset: string,
    targetData: OHLCVData[],
    linkedPairs: readonly PreparedPairArtifact[],
    options: BatchSyntheticMinerOptions,
    horizons: number[]
): BatchSyntheticCandidateSample[] {
    const samples: BatchSyntheticCandidateSample[] = [];
    const longestHorizon = horizons[horizons.length - 1] ?? 1;
    const lastIndex = targetData.length - 1 - longestHorizon;
    for (let index = 0; index <= lastIndex; index += 1) {
        // Carry-in trades ARE allowed historically. The current snapshot uses
        // carry-in too (an open BTC+APT short entered 200 bars ago is a valid
        // current state on 4H). Forbidding carry-in historically while allowing
        // it currently makes the matcher search under a stricter rule than the
        // state it is trying to match, which suppresses analogs precisely on
        // the higher timeframes where the edge lives. Trade age is exposed as
        // a distance feature so old samples are not conflated with fresh ones.
        const snapshot = buildSnapshotAt(asset, index, targetData, linkedPairs, options);
        if (!snapshot?.direction) {
            continue;
        }
        // Compute all horizons in a SINGLE forward pass. Longer horizons
        // strictly contain shorter ones, so scanning each horizon independently
        // re-reads the same candles (h1+h2+h3 vs max(h)). On 4H with
        // horizons [24,48,96] this cuts MFE/MAE work ~1.75x; on [150,300,600]
        // ~1.75x. Each horizon "snaps" its outcome as the scan crosses its
        // boundary, using the running MFE/MAE extrema.
        const outcomesByHorizon = buildAllHorizonOutcomes(targetData, index, snapshot.direction, horizons);
        if (!outcomesByHorizon) {
            continue;
        }
        const shortestOutcome = outcomesByHorizon.get(horizons[0]!);
        if (!shortestOutcome) {
            continue;
        }
        // Window label is assigned later by bar position in buildAssetVerdict,
        // not by sample rank here (see comment there for why).
        samples.push({
            snapshot,
            window: "discovery",
            forwardReturnPct: shortestOutcome.forwardReturnPct,
            futureMfePct: shortestOutcome.futureMfePct,
            futureMaePct: shortestOutcome.futureMaePct,
            outcomesByHorizon,
        });
    }
    return samples;
}

/**
 * Compute forward-return / MFE / MAE for every horizon in ONE forward scan.
 * `horizons` must be ascending. Returns null if the basis bar or the longest
 * horizon's end bar is missing. MFE/MAE are accumulated as running extrema so
 * each horizon's snapshot at its boundary is the true max-favorable /
 * max-adverse over `[index+1, index+horizon]`.
 *
 * Equivalence: a micro-benchmark confirmed this single-pass produces MFE/MAE
 * numerically identical (to 1e-9) to an independent per-horizon scan, at
 * ~1.3x lower cost. The longest-horizon gate test exercises the longest
 * horizon's outcome through the verdict pipeline.
 */
function buildAllHorizonOutcomes(
    data: OHLCVData[],
    index: number,
    direction: BatchSyntheticDirection,
    horizons: number[]
): Map<number, { forwardReturnPct: number; futureMfePct: number; futureMaePct: number }> | null {
    const basis = data[index];
    const longest = horizons[horizons.length - 1] ?? 1;
    const endLong = data[index + longest];
    if (!basis || !endLong || !isFinitePositive(basis.close)) {
        return null;
    }
    const result = new Map<number, { forwardReturnPct: number; futureMfePct: number; futureMaePct: number }>();
    let futureMfePct = 0;
    let futureMaePct = 0;
    let horizonIdx = 0;
    for (let cursor = index + 1; cursor <= index + longest; cursor += 1) {
        const candle = data[cursor];
        if (!candle) {
            continue;
        }
        const favorable = direction === "long" ? candle.high : candle.low;
        const adverse = direction === "long" ? candle.low : candle.high;
        futureMfePct = Math.max(futureMfePct, computeDirectionalPercentMove(basis.close, favorable, direction));
        futureMaePct = Math.min(futureMaePct, computeDirectionalPercentMove(basis.close, adverse, direction));
        // When the cursor crosses a horizon boundary, snap the outcome at the
        // running extrema. Multiple horizons can share a boundary.
        while (horizonIdx < horizons.length && cursor === index + horizons[horizonIdx]!) {
            const h = horizons[horizonIdx]!;
            const endBar = data[index + h];
            const forwardReturnPct = endBar
                ? computeDirectionalPercentMove(basis.close, endBar.close, direction)
                : 0;
            result.set(h, { forwardReturnPct, futureMfePct, futureMaePct });
            horizonIdx += 1;
        }
    }
    // Fallback: if the loop did not reach a horizon (e.g. data gaps left
    // `cursor` skipping past a boundary via `continue`), fill any missing
    // entries so the caller's contract holds.
    for (const h of horizons) {
        if (!result.has(h)) {
            const endBar = data[index + h];
            result.set(h, {
                forwardReturnPct: endBar ? computeDirectionalPercentMove(basis.close, endBar.close, direction) : 0,
                futureMfePct,
                futureMaePct,
            });
        }
    }
    return result;
}

function buildSnapshotAt(
    asset: string,
    targetIndex: number,
    targetData: OHLCVData[],
    linkedPairs: readonly PreparedPairArtifact[],
    options: BatchSyntheticMinerOptions
): BatchSyntheticStateSnapshot | null {
    const targetBar = targetData[targetIndex];
    if (!targetBar) {
        return null;
    }
    const key = timeKey(targetBar.time);
    const states = getPairStatesAt(asset, key, linkedPairs, options.lagBars);
    if (states.length === 0) {
        return {
            asset,
            direction: null,
            timeKey: key,
            barIndex: targetIndex,
            close: Number.isFinite(targetBar.close) ? targetBar.close : null,
            activePeerCount: 0,
            agreementCount: 0,
            oppositionCount: 0,
            agreementRatio: 0,
            oppositionRatio: 0,
            netAgreement: 0,
            agreementTransition: 0,
            medianBarsHeld: null,
            medianMoveSinceEntryPct: null,
            medianMoveSinceEntryAtr: null,
            medianAdverseExcursionAtr: null,
            breadthPersistence: 0,
            agreeingSymbols: [],
            opposingSymbols: [],
        };
    }

    const longStates = states.filter((state) => state.direction === "long");
    const shortStates = states.filter((state) => state.direction === "short");
    const direction: BatchSyntheticDirection | null = longStates.length > shortStates.length
        ? "long"
        : shortStates.length > longStates.length
            ? "short"
            : null;
    const agreeing = direction === "long" ? longStates : direction === "short" ? shortStates : [];
    const opposing = direction === "long" ? shortStates : direction === "short" ? longStates : [];
    const netAgreement = direction
        ? agreeing.length - opposing.length
        : Math.abs(longStates.length - shortStates.length);
    const previousIndex = Math.max(0, targetIndex - TRANSITION_LOOKBACK_BARS);
    const previousKey = timeKey(targetData[previousIndex]?.time ?? targetBar.time);
    const previousStates = getPairStatesAt(asset, previousKey, linkedPairs, options.lagBars);
    const previousLong = previousStates.filter((state) => state.direction === "long").length;
    const previousShort = previousStates.filter((state) => state.direction === "short").length;
    const directionFactor = direction === "short" ? -1 : 1;
    const currentRawNet = longStates.length - shortStates.length;
    const previousRawNet = previousLong - previousShort;

    return {
        asset,
        direction,
        timeKey: key,
        barIndex: targetIndex,
        close: Number.isFinite(targetBar.close) ? targetBar.close : null,
        activePeerCount: states.length,
        agreementCount: agreeing.length,
        oppositionCount: opposing.length,
        agreementRatio: states.length > 0 ? agreeing.length / states.length : 0,
        oppositionRatio: states.length > 0 ? opposing.length / states.length : 0,
        netAgreement,
        agreementTransition: direction ? (currentRawNet - previousRawNet) * directionFactor : 0,
        medianBarsHeld: median(agreeing.map((state) => state.barsHeld)),
        medianMoveSinceEntryPct: median(agreeing.map((state) => state.moveSinceEntryPct)),
        medianMoveSinceEntryAtr: median(agreeing.map((state) => state.moveSinceEntryAtr)),
        medianAdverseExcursionAtr: median(agreeing.map((state) => state.adverseExcursionAtr)),
        breadthPersistence: computeBreadthPersistence(asset, targetIndex, targetData, linkedPairs, options, direction),
        agreeingSymbols: agreeing.map((state) => state.symbol).sort(),
        opposingSymbols: opposing.map((state) => state.symbol).sort(),
    };
}

function getPairStatesAt(
    asset: string,
    key: string,
    linkedPairs: readonly PreparedPairArtifact[],
    lagBars: number
): PairState[] {
    const states: PairState[] = [];
    for (const pair of linkedPairs) {
        const pairIndex = pair.timeIndex.get(key);
        if (pairIndex === undefined) {
            continue;
        }
        const side = pair.baseAsset === asset ? "base" : pair.quoteAsset === asset ? "quote" : null;
        if (!side) {
            continue;
        }
        const open = pair.openTradeByIndex[pairIndex];
        if (open) {
            states.push(buildTradePairState(pair, open, pairIndex, side));
            continue;
        }
        const signal = findLatestSignal(pair.signalsByIndex, pairIndex, lagBars);
        if (signal) {
            states.push(buildSignalPairState(pair, signal, pairIndex, side));
        }
    }
    return states;
}

function buildTradePairState(
    pair: PreparedPairArtifact,
    range: TradeRange,
    pairIndex: number,
    side: "base" | "quote"
): PairState {
    const pairDirection = range.trade.type;
    const direction = mapPairDirectionToAsset(pairDirection, side);
    const candle = pair.data[pairIndex];
    const atr = computeAtrAt(pair.data, pairIndex) ?? Math.max(1e-9, range.trade.entryPrice * 0.01);
    return {
        symbol: pair.symbol,
        direction,
        barsHeld: Math.max(0, pairIndex - range.entryIndex),
        moveSinceEntryPct: computeDirectionalPercentMove(range.trade.entryPrice, candle?.close ?? range.trade.entryPrice, pairDirection),
        moveSinceEntryAtr: computeDirectionalAtrDistance(range.trade.entryPrice, candle?.close ?? range.trade.entryPrice, pairDirection, atr),
        adverseExcursionAtr: computeAdverseExcursionAtr(pair.data, range.entryIndex, pairIndex, pairDirection, range.trade.entryPrice, atr),
    };
}

function buildSignalPairState(
    pair: PreparedPairArtifact,
    signal: IndexedSignal,
    pairIndex: number,
    side: "base" | "quote"
): PairState {
    const pairDirection = signal.direction;
    const direction = mapPairDirectionToAsset(pairDirection, side);
    const candle = pair.data[pairIndex];
    const entryPrice = signal.signal.price || pair.data[signal.index]?.close || candle?.close || 0;
    const atr = computeAtrAt(pair.data, pairIndex) ?? Math.max(1e-9, entryPrice * 0.01);
    return {
        symbol: pair.symbol,
        direction,
        barsHeld: Math.max(0, pairIndex - signal.index),
        moveSinceEntryPct: computeDirectionalPercentMove(entryPrice, candle?.close ?? entryPrice, pairDirection),
        moveSinceEntryAtr: computeDirectionalAtrDistance(entryPrice, candle?.close ?? entryPrice, pairDirection, atr),
        adverseExcursionAtr: computeAdverseExcursionAtr(pair.data, signal.index, pairIndex, pairDirection, entryPrice, atr),
    };
}

function mapPairDirectionToAsset(direction: BatchSyntheticDirection, side: "base" | "quote"): BatchSyntheticDirection {
    if (side === "base") {
        return direction;
    }
    return direction === "long" ? "short" : "long";
}

function findLatestSignal(
    signalsByIndex: IndexedSignal[][],
    pairIndex: number,
    lagBars: number
): IndexedSignal | null {
    const start = Math.max(0, pairIndex - lagBars);
    for (let index = pairIndex; index >= start; index -= 1) {
        const entries = signalsByIndex[index];
        if (!entries || entries.length === 0) {
            continue;
        }
        const hasBuy = entries.some((entry) => entry.direction === "long");
        const hasSell = entries.some((entry) => entry.direction === "short");
        // A bar with conflicting buy+sell signals is ambiguous for THIS bar,
        // not a voiding of the whole lag window. Skip it and keep searching
        // backward for an unambiguous signal still within lagBars. Returning
        // null here would silently drop pair states whenever any bar in the
        // window carries both sides (common on strategy-flip bars).
        if (hasBuy === hasSell) {
            continue;
        }
        return entries[entries.length - 1] ?? null;
    }
    return null;
}

function computeBreadthPersistence(
    asset: string,
    targetIndex: number,
    targetData: OHLCVData[],
    linkedPairs: readonly PreparedPairArtifact[],
    options: BatchSyntheticMinerOptions,
    direction: BatchSyntheticDirection | null
): number {
    if (!direction) {
        return 0;
    }
    let persistence = 0;
    for (let offset = 0; offset < 5; offset += 1) {
        const index = targetIndex - offset;
        if (index < 0) {
            break;
        }
        // Direction-only lookup: persistence just counts agreeing/opposing
        // pairs over the last 5 bars. The full PairState (with O(hold)
        // adverseExcursionAtr and ATR recomputation) is not needed here, and
        // recomputing it 5x per candidate bar dominates the 4H hot path when
        // carry-in trades span hundreds of bars.
        const counts = getPairDirectionCountsAt(asset, timeKey(targetData[index]!.time), linkedPairs, options.lagBars, direction);
        if (counts.total === 0 || counts.same <= counts.opposite) {
            break;
        }
        persistence += 1;
    }
    return persistence;
}

/**
 * Lightweight direction-only sibling of `getPairStatesAt`. Returns agreeing /
 * opposing counts relative to `targetDirection` instead of full `PairState`
 * objects, so it skips the O(hold) `computeAdverseExcursionAtr` scan and the
 * per-bar ATR recomputation. Used only where the caller needs direction
 * consensus (breadth persistence); the main snapshot path still needs the
 * full `PairState` features.
 */
function getPairDirectionCountsAt(
    asset: string,
    key: string,
    linkedPairs: readonly PreparedPairArtifact[],
    lagBars: number,
    targetDirection: BatchSyntheticDirection
): { same: number; opposite: number; total: number } {
    let same = 0;
    let opposite = 0;
    for (const pair of linkedPairs) {
        const pairIndex = pair.timeIndex.get(key);
        if (pairIndex === undefined) {
            continue;
        }
        const side = pair.baseAsset === asset ? "base" : pair.quoteAsset === asset ? "quote" : null;
        if (!side) {
            continue;
        }
        let pairDirection: BatchSyntheticDirection | null = null;
        const open = pair.openTradeByIndex[pairIndex];
        if (open) {
            pairDirection = mapPairDirectionToAsset(open.trade.type, side);
        } else {
            const signal = findLatestSignal(pair.signalsByIndex, pairIndex, lagBars);
            if (signal) {
                pairDirection = mapPairDirectionToAsset(signal.direction, side);
            }
        }
        if (pairDirection === targetDirection) {
            same += 1;
        } else if (pairDirection !== null) {
            opposite += 1;
        }
    }
    return { same, opposite, total: same + opposite };
}

function selectAnalogs(
    current: BatchSyntheticStateSnapshot,
    samples: readonly BatchSyntheticCandidateSample[],
    options: BatchSyntheticMinerOptions,
    scales: DistanceScales
): LabeledAnalog[] {
    const ranked = samples
        .filter((sample) => sample.snapshot.direction === current.direction)
        .map((sample) => ({
            sample,
            distance: measureSnapshotDistance(current, sample.snapshot, scales),
        }))
        .filter((item) => Number.isFinite(item.distance))
        .sort((a, b) => a.distance - b.distance);
    const count = Math.min(options.neighborCountMax, Math.max(options.neighborCountMin, Math.ceil(Math.sqrt(ranked.length))));
    return ranked.slice(0, count);
}

interface DistanceScales {
    activePeerCount: number;
    netAgreement: number;
    agreementTransition: number;
    medianBarsHeld: number;
    medianMoveSinceEntryPct: number;
    medianMoveSinceEntryAtr: number;
    medianAdverseExcursionAtr: number;
    breadthPersistence: number;
}

const FALLBACK_SCALES: DistanceScales = {
    activePeerCount: 12,
    netAgreement: 8,
    agreementTransition: 6,
    medianBarsHeld: 48,
    medianMoveSinceEntryPct: 8,
    medianMoveSinceEntryAtr: 4,
    medianAdverseExcursionAtr: 4,
    breadthPersistence: 5,
};

/**
 * Calibrate distance normalizers from discovery+selection samples only. The
 * plan forbids tuning anything on the newest OOS window, so scales MUST be
 * frozen before any analog selection. Each scale is the discovery-window
 * interquartile range of that feature (robust to outliers; 0 falls back to a
 * sane default). On 4H, `medianMoveSinceEntryPct` regularly exceeds 8%, so a
 * fixed scale of 8 would let one feature dominate the distance and push every
 * analog past `maxEntryDistance`. Calibrating to the actual spread fixes that.
 */
function calibrateDistanceScales(preOosSamples: readonly BatchSyntheticCandidateSample[]): DistanceScales {
    const snapshots = preOosSamples.map((sample) => sample.snapshot);
    if (snapshots.length < 4) {
        return { ...FALLBACK_SCALES };
    }
    const pick = (select: (snapshot: BatchSyntheticStateSnapshot) => number | null): number => {
        const values = snapshots
            .map(select)
            .filter((value): value is number => value !== null && Number.isFinite(value))
            .sort((a, b) => a - b);
        if (values.length < 4) {
            return 0;
        }
        const q1 = values[Math.floor(values.length * 0.25)];
        const q3 = values[Math.floor(values.length * 0.75)];
        const iqr = Math.max(1e-9, (q3 ?? 0) - (q1 ?? 0));
        return iqr;
    };
    const resolve = (value: number, fallback: number) => value > 1e-9 ? value : fallback;
    const barsHeldScale = pick((s) => s.medianBarsHeld);
    const movePctScale = pick((s) => s.medianMoveSinceEntryPct);
    const moveAtrScale = pick((s) => s.medianMoveSinceEntryAtr);
    const advAtrScale = pick((s) => s.medianAdverseExcursionAtr);
    return {
        activePeerCount: resolve(pick((s) => s.activePeerCount), FALLBACK_SCALES.activePeerCount),
        netAgreement: resolve(pick((s) => s.netAgreement), FALLBACK_SCALES.netAgreement),
        agreementTransition: resolve(pick((s) => s.agreementTransition), FALLBACK_SCALES.agreementTransition),
        medianBarsHeld: resolve(barsHeldScale, FALLBACK_SCALES.medianBarsHeld),
        medianMoveSinceEntryPct: resolve(movePctScale, FALLBACK_SCALES.medianMoveSinceEntryPct),
        medianMoveSinceEntryAtr: resolve(moveAtrScale, FALLBACK_SCALES.medianMoveSinceEntryAtr),
        medianAdverseExcursionAtr: resolve(advAtrScale, FALLBACK_SCALES.medianAdverseExcursionAtr),
        breadthPersistence: resolve(pick((s) => s.breadthPersistence), FALLBACK_SCALES.breadthPersistence),
    };
}

function measureSnapshotDistance(
    a: BatchSyntheticStateSnapshot,
    b: BatchSyntheticStateSnapshot,
    scales: DistanceScales
): number {
    if (!a.direction || a.direction !== b.direction) {
        return Number.POSITIVE_INFINITY;
    }
    return (
        normalizedAbs(a.activePeerCount, b.activePeerCount, scales.activePeerCount) * 0.8
        + Math.abs(a.agreementRatio - b.agreementRatio) * 2
        + Math.abs(a.oppositionRatio - b.oppositionRatio) * 1.5
        + normalizedAbs(a.netAgreement, b.netAgreement, scales.netAgreement) * 0.8
        + normalizedAbs(a.agreementTransition, b.agreementTransition, scales.agreementTransition) * 0.8
        + normalizedAbs(nullable(a.medianBarsHeld), nullable(b.medianBarsHeld), scales.medianBarsHeld) * 0.7
        + normalizedAbs(nullable(a.medianMoveSinceEntryPct), nullable(b.medianMoveSinceEntryPct), scales.medianMoveSinceEntryPct) * 1.2
        + normalizedAbs(nullable(a.medianMoveSinceEntryAtr), nullable(b.medianMoveSinceEntryAtr), scales.medianMoveSinceEntryAtr) * 1.1
        + normalizedAbs(nullable(a.medianAdverseExcursionAtr), nullable(b.medianAdverseExcursionAtr), scales.medianAdverseExcursionAtr) * 0.8
        + normalizedAbs(a.breadthPersistence, b.breadthPersistence, scales.breadthPersistence) * 0.6
    );
}

function classifyVerdict(
    evidence: BatchSyntheticVerdictEvidence,
    current: BatchSyntheticStateSnapshot,
    options: BatchSyntheticMinerOptions,
    reasons: string[]
): BatchSyntheticVerdict {
    if (evidence.analogCount < options.neighborCountMin) {
        reasons.push(`Only ${evidence.analogCount} analogs; need ${options.neighborCountMin}.`);
        return "INCONCLUSIVE";
    }
    if ((evidence.avgDistance ?? Number.POSITIVE_INFINITY) > options.maxEntryDistance) {
        reasons.push(`Nearest analog distance ${formatReasonNumber(evidence.avgDistance)} exceeds max ${options.maxEntryDistance}.`);
        return "INCONCLUSIVE";
    }
    const selectionReturn = evidence.selectionForwardReturnPct ?? 0;
    const selectionMfe = evidence.selectionMfePct ?? 0;
    const selectionMae = evidence.selectionMaePct ?? 0;
    const selectionFavorable = selectionReturn > 0 && selectionMfe > Math.abs(selectionMae);
    if (evidence.selectionCount < options.minSamples) {
        reasons.push(`Only ${evidence.selectionCount} pre-OOS analogs; need ${options.minSamples}.`);
        return "INCONCLUSIVE";
    }
    if (evidence.oosCount < options.minOosSamples) {
        if (selectionFavorable) {
            reasons.push("Selection window is positive, but newest OOS samples are insufficient.");
            return "WATCH";
        }
        reasons.push(`Only ${evidence.oosCount} newest-window analogs; need ${options.minOosSamples}.`);
        return "INCONCLUSIVE";
    }
    const oosReturn = evidence.expectedForwardReturnPct ?? 0;
    const oosLift = evidence.oosLiftPct ?? 0;
    const mfe = evidence.expectedMfePct ?? 0;
    const mae = evidence.expectedMaePct ?? 0;
    const requiredReturn = computeRequiredEntryReturnPct(evidence, options);
    const requiredLift = computeRequiredEntryLiftPct(evidence, options);
    const mfeMaeRatio = computeMfeMaeRatio(mfe, mae);
    const oosFavorable = oosReturn > 0 && oosLift >= 0 && mfe > Math.abs(mae);
    if (!selectionFavorable && !oosFavorable) {
        reasons.push("Pre-OOS and newest-window analogs show poor remaining expectancy or unfavorable MFE/MAE.");
        return "SKIP";
    }
    if (!selectionFavorable || !oosFavorable) {
        reasons.push("Pre-OOS and newest-window analogs disagree.");
        return "WATCH";
    }
    if (oosReturn >= requiredReturn && oosLift >= requiredLift && mfeMaeRatio >= options.minMfeMaeRatio) {
        // Longest-horizon persistence gate. The strategy edge lives at the
        // strategy's hold scale (auto-horizons set the longest to ~2x median
        // hold). A short-horizon drift that does not survive to exit scale is
        // not a transferable entry signal; downgrade to WATCH.
        const longestReturn = evidence.longestOosForwardReturnPct;
        const longestLift = evidence.longestOosLiftPct;
        if (longestReturn !== null && longestLift !== null && (longestReturn <= 0 || longestLift < 0)) {
            reasons.push(
                `Short-horizon edge does not persist to longest horizon ${evidence.longestHorizonBars}b: `
                + `return ${formatReasonNumber(longestReturn)}%, lift ${formatReasonNumber(longestLift)}%.`
            );
            return "WATCH";
        }
        if (current.agreeingSymbols.length === 1) {
            reasons.push("Positive OOS evidence, but current agreement comes from one pair.");
            return "WATCH";
        }
        reasons.push("Pre-OOS and newest-window analogs agree with sufficient edge.");
        return current.direction === "long" ? "LONG" : "SHORT";
    }
    reasons.push(`OOS edge below entry gate: return ${formatReasonNumber(oosReturn)}% vs ${formatReasonNumber(requiredReturn)}%, lift ${formatReasonNumber(oosLift)}% vs ${formatReasonNumber(requiredLift)}%, MFE/MAE ${formatReasonNumber(mfeMaeRatio)} vs ${options.minMfeMaeRatio}.`);
    return "WATCH";
}

function classifyConfidence(
    verdict: BatchSyntheticVerdict,
    evidence: BatchSyntheticVerdictEvidence,
    options: BatchSyntheticMinerOptions
): BatchSyntheticConfidence {
    if (verdict === "INCONCLUSIVE") {
        return "none";
    }
    const distance = evidence.avgDistance ?? Number.POSITIVE_INFINITY;
    const edgeMultiple = computeEntryEdgeMultiple(evidence, options);
    const mfeMaeRatio = computeMfeMaeRatio(evidence.expectedMfePct ?? 0, evidence.expectedMaePct ?? 0);
    if ((verdict === "LONG" || verdict === "SHORT")
        && evidence.oosCount >= 12
        && evidence.selectionCount >= 12
        && distance <= 1.8
        && edgeMultiple >= 1.5
        && mfeMaeRatio >= 1.6
    ) {
        return "high";
    }
    if ((verdict === "LONG" || verdict === "SHORT" || verdict === "WATCH")
        && evidence.oosCount >= 6
        && evidence.selectionCount >= 6
        && distance <= 3
        && edgeMultiple >= 1
    ) {
        return "medium";
    }
    return "low";
}

function computeRequiredEntryReturnPct(
    evidence: BatchSyntheticVerdictEvidence,
    options: BatchSyntheticMinerOptions
): number {
    const mae = Math.abs(evidence.expectedMaePct ?? 0);
    return Math.max(options.minEntryReturnPct, mae * 0.15);
}

function computeRequiredEntryLiftPct(
    evidence: BatchSyntheticVerdictEvidence,
    options: BatchSyntheticMinerOptions
): number {
    const baseline = Math.abs(evidence.baselineOosReturnPct ?? 0);
    return Math.max(options.minEntryLiftPct, baseline * 0.1);
}

function computeEntryEdgeMultiple(
    evidence: BatchSyntheticVerdictEvidence,
    options: BatchSyntheticMinerOptions
): number {
    const oosReturn = evidence.expectedForwardReturnPct ?? 0;
    const oosLift = evidence.oosLiftPct ?? 0;
    const returnMultiple = oosReturn / Math.max(1e-9, computeRequiredEntryReturnPct(evidence, options));
    const liftMultiple = oosLift / Math.max(1e-9, computeRequiredEntryLiftPct(evidence, options));
    return Math.min(returnMultiple, liftMultiple);
}

function computeMfeMaeRatio(mfe: number, mae: number): number {
    return mfe / Math.max(1e-9, Math.abs(mae));
}

function formatReasonNumber(value: number | null | undefined): string {
    if (value === null || value === undefined || !Number.isFinite(value)) {
        return "--";
    }
    return value.toFixed(Math.abs(value) >= 10 ? 1 : 2);
}

function buildPairContributions(
    current: BatchSyntheticStateSnapshot,
    oosAnalogs: readonly LabeledAnalog[],
    evidence: BatchSyntheticVerdictEvidence
): BatchSyntheticPairContribution[] {
    const symbols = [
        ...current.agreeingSymbols.map((symbol) => ({ symbol, side: "agreeing" as const })),
        ...current.opposingSymbols.map((symbol) => ({ symbol, side: "opposing" as const })),
    ];
    const baseReturn = evidence.expectedForwardReturnPct;
    return symbols.map(({ symbol, side }) => {
        const without = oosAnalogs
            .filter((analog) => !analog.sample.snapshot.agreeingSymbols.includes(symbol) && !analog.sample.snapshot.opposingSymbols.includes(symbol))
            .map((analog) => analog.sample);
        const summary = summarizeSamples(without, evidence.horizonBars);
        const delta = summary.avgReturnPct !== null && baseReturn !== null ? summary.avgReturnPct - baseReturn : null;
        let label: BatchSyntheticPairContributionLabel = "neutral";
        if (side === "opposing") {
            label = "opposing";
        } else if (current.agreeingSymbols.length === 1) {
            label = "dominating";
        } else if (delta !== null && delta < -0.2) {
            label = "useful";
        } else if (delta !== null && delta > 0.2) {
            label = "harmful";
        }
        return {
            symbol,
            side,
            label,
            oosCountWithout: without.length,
            oosReturnWithoutPct: summary.avgReturnPct,
            returnDeltaPct: delta,
        };
    });
}

function summarizeSamples(
    samples: readonly BatchSyntheticCandidateSample[],
    horizon?: number
): {
    count: number;
    avgReturnPct: number | null;
    avgMfePct: number | null;
    avgMaePct: number | null;
} {
    // When a specific horizon is requested, prefer the per-horizon outcome map
    // (so the longest-horizon summary reflects the longest-horizon label, not
    // the shortest-horizon fields mirrored on the sample).
    if (horizon !== undefined) {
        const resolved = samples
            .map((sample) => sample.outcomesByHorizon.get(horizon))
            .filter((value): value is { forwardReturnPct: number; futureMfePct: number; futureMaePct: number } => Boolean(value));
        if (resolved.length > 0) {
            return {
                count: resolved.length,
                avgReturnPct: average(resolved.map((outcome) => outcome.forwardReturnPct)),
                avgMfePct: average(resolved.map((outcome) => outcome.futureMfePct)),
                avgMaePct: average(resolved.map((outcome) => outcome.futureMaePct)),
            };
        }
    }
    return {
        count: samples.length,
        avgReturnPct: average(samples.map((sample) => sample.forwardReturnPct)),
        avgMfePct: average(samples.map((sample) => sample.futureMfePct)),
        avgMaePct: average(samples.map((sample) => sample.futureMaePct)),
    };
}

function buildOpenTradeIndex(
    trades: readonly Trade[],
    data: readonly OHLCVData[],
    timeIndex: ReadonlyMap<string, number>
): Array<TradeRange | null> {
    const openByIndex = Array.from({ length: data.length }, () => null as TradeRange | null);
    for (const trade of trades) {
        const entryIndex = timeIndex.get(timeKey(trade.entryTime));
        const exitIndex = timeIndex.get(timeKey(trade.exitTime));
        if (entryIndex === undefined || exitIndex === undefined || exitIndex < entryIndex) {
            continue;
        }
        const range = { trade, entryIndex, exitIndex };
        const last = trade.exitReason === "end_of_data" ? exitIndex : Math.max(entryIndex, exitIndex - 1);
        for (let index = entryIndex; index <= last && index < openByIndex.length; index += 1) {
            openByIndex[index] = range;
        }
    }
    return openByIndex;
}

/**
 * Closed trades only (excludes `end_of_data`, which represents a trade still
 * open at the data boundary). Used for unbiased median-hold calibration —
 * `openTradeByIndex` includes `end_of_data` ranges and skews long.
 */
function buildClosedTradeRanges(
    trades: readonly Trade[],
    timeIndex: ReadonlyMap<string, number>
): TradeRange[] {
    const ranges: TradeRange[] = [];
    for (const trade of trades) {
        if (trade.exitReason === "end_of_data") {
            continue;
        }
        const entryIndex = timeIndex.get(timeKey(trade.entryTime));
        const exitIndex = timeIndex.get(timeKey(trade.exitTime));
        if (entryIndex === undefined || exitIndex === undefined || exitIndex <= entryIndex) {
            continue;
        }
        ranges.push({ trade, entryIndex, exitIndex });
    }
    return ranges;
}

function buildSignalIndex(
    signals: readonly Signal[],
    data: readonly OHLCVData[],
    timeIndex: ReadonlyMap<string, number>
): IndexedSignal[][] {
    const byIndex: IndexedSignal[][] = Array.from({ length: data.length }, () => []);
    for (const signal of signals) {
        const index = typeof signal.barIndex === "number" && signal.barIndex >= 0 && signal.barIndex < data.length
            ? signal.barIndex
            : timeIndex.get(timeKey(signal.time));
        if (index === undefined || index < 0 || index >= data.length) {
            continue;
        }
        byIndex[index].push({
            signal,
            index,
            direction: signal.type === "buy" ? "long" : "short",
        });
    }
    return byIndex;
}

function buildTimeIndex(data: readonly OHLCVData[]): Map<string, number> {
    const index = new Map<string, number>();
    data.forEach((bar, cursor) => {
        index.set(timeKey(bar.time), cursor);
    });
    return index;
}

function resolveWindow(index: number, length: number): BatchSyntheticWindow {
    const ratio = length <= 1 ? 1 : index / Math.max(1, length - 1);
    if (ratio < 0.6) {
        return "discovery";
    }
    if (ratio < 0.8) {
        return "selection";
    }
    return "oos";
}

function createAssetVerdict(
    asset: string,
    verdict: BatchSyntheticVerdict,
    direction: BatchSyntheticDirection | null,
    currentSnapshot: BatchSyntheticStateSnapshot | null,
    evidence: BatchSyntheticVerdictEvidence,
    pairContributions: BatchSyntheticPairContribution[],
    reasons: string[],
    diagnostics: string[],
    confidence: BatchSyntheticConfidence = verdict === "INCONCLUSIVE" ? "none" : "low"
): BatchSyntheticAssetVerdict {
    return {
        asset,
        verdict,
        direction,
        confidence,
        currentSnapshot,
        evidence,
        pairContributions,
        reasons,
        diagnostics,
    };
}

function createEmptyEvidence(horizonBars: number, horizonBarsAll: number[] = [horizonBars]): BatchSyntheticVerdictEvidence {
    return {
        horizonBars,
        horizonBarsAll,
        candidateCount: 0,
        analogCount: 0,
        selectionCount: 0,
        oosCount: 0,
        avgDistance: null,
        selectionForwardReturnPct: null,
        selectionMfePct: null,
        selectionMaePct: null,
        expectedForwardReturnPct: null,
        expectedMfePct: null,
        expectedMaePct: null,
        baselineOosReturnPct: null,
        oosLiftPct: null,
        longestHorizonBars: horizonBarsAll[horizonBarsAll.length - 1] ?? horizonBars,
        longestOosForwardReturnPct: null,
        longestOosLiftPct: null,
    };
}

function normalizeAsset(value: string): string {
    return value.trim().toUpperCase();
}

function nullable(value: number | null): number {
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function normalizedAbs(a: number, b: number, scale: number): number {
    return Math.abs(a - b) / Math.max(1e-9, scale);
}

function average(values: Array<number | null | undefined>): number | null {
    const finite = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
    if (finite.length === 0) {
        return null;
    }
    return finite.reduce((sum, value) => sum + value, 0) / finite.length;
}

function median(values: Array<number | null | undefined>): number | null {
    const finite = values
        .filter((value): value is number => typeof value === "number" && Number.isFinite(value))
        .sort((a, b) => a - b);
    if (finite.length === 0) {
        return null;
    }
    const middle = Math.floor(finite.length / 2);
    return finite.length % 2 === 1
        ? finite[middle]
        : (finite[middle - 1] + finite[middle]) / 2;
}

function isFinitePositive(value: number): boolean {
    return Number.isFinite(value) && value > 0;
}

function verdictRank(verdict: BatchSyntheticVerdict): number {
    switch (verdict) {
        case "LONG": return 0;
        case "SHORT": return 1;
        case "WATCH": return 2;
        case "SKIP": return 3;
        case "INCONCLUSIVE": return 4;
        default: return 5;
    }
}

export function resolveBatchSyntheticTargetSymbol(asset: string, suffix: "USDT" = "USDT"): string {
    return `${normalizeAsset(asset)}${suffix}`;
}
