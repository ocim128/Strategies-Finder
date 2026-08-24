/**
 * Offline Phase 2 tied-set analysis.
 *
 * This analyzer is deliberately read-only with respect to a TOP_MEAN archive.
 * It reuses the P1/P2 analyzer's archive loader, chronological block splitter,
 * and frozen block bootstrap so the registered frame has one implementation.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
    PAIRLIST_POOL_RULE_DISCOVERY_FROM_SEC,
    PAIRLIST_POOL_RULE_DISCOVERY_TO_SEC,
    PAIRLIST_POOL_RULE_HORIZONS,
    PAIRLIST_POOL_RULE_POOL_VERSION,
    PAIRLIST_POOL_RULE_VALIDATION_FROM_SEC,
    PAIRLIST_POOL_RULE_VALIDATION_TO_SEC,
} from "../lib/batch-backtest/max-active-research-contract";
import type {
    CandidateOutcomeRecord,
    PoolSnapshotRecord,
} from "../lib/batch-backtest/batch-open-score-usd-replay-engine";
import {
    bootstrapBlockMeans,
    loadPoolRuleArchive,
    splitChronologicalBlocks,
    type MetricSummary,
    type PoolRuleArchive,
    type PoolRuleEvent,
    type PoolRuleEventRow,
    type PoolRuleMeta,
    type PoolRuleValuePoint,
} from "./analyze-pool-rules";

const POOL_VERSION = PAIRLIST_POOL_RULE_POOL_VERSION;

type WindowKey = "discovery_2025" | "validation_2026";

interface WindowSpec {
    key: WindowKey;
    label: string;
    fromSec: number;
    toSec: number;
}

interface EngineTopMeanRow {
    eventId: string;
    horizonBars: number;
    asset: string;
    delta: number | null;
}

export interface TiedSetGroup {
    eligibleAssets: string[];
    tiedAssets: string[];
    maxScore: number | null;
}

export interface TiedSetEventMetrics {
    group: TiedSetGroup;
    tiedOkCount: number;
    eligibleOkCount: number;
    nonTieOkCount: number;
    tiedMean: number | null;
    eligibleMean: number | null;
    nonTieMean: number | null;
    t1: number | null;
    t2: number | null;
    t3: number | null;
    engineDelta: number | null;
    setComponent: number | null;
    pickWithinSetComponent: number | null;
}

export interface TiedSetDistribution {
    n: number;
    mean: number | null;
    min: number | null;
    median: number | null;
    max: number | null;
}

export interface TiedSetSelectionFrequency {
    asset: string;
    events: number;
    share: number;
}

export interface TiedSetReconciliation {
    archivedEngineMean: number | null;
    recomputedEngineMean: number | null;
    setComponentMean: number | null;
    pickWithinSetMean: number | null;
    componentSum: number | null;
    residual: number | null;
    archivedVsRecomputed: number | null;
    archivedRows: number;
    recomputedRows: number;
}

export interface TiedSetHorizonResult {
    horizonBars: number;
    t1: MetricSummary;
    t2: MetricSummary;
    t3: MetricSummary;
    t1ExDominant: MetricSummary;
    excluded: {
        tiedSetLt2Ok: number;
        t2TiedSetAllEligible: number;
        t2NoNonTieOkReturns: number;
        missingTopMeanRow: number;
        t3MissingOkReturn: number;
    };
    reconciliation: TiedSetReconciliation;
}

export interface TiedSetWindowResult {
    window: WindowKey;
    label: string;
    tiedSetSize: TiedSetDistribution;
    tiedSetEligibleRatio: TiedSetDistribution;
    tiedSetMembership: TiedSetSelectionFrequency[];
    dominantTieSetMember: string | null;
    horizons: TiedSetHorizonResult[];
}

export interface TiedSetAnalysisResult {
    schema: "pairlist_tied_set_analysis.v1";
    runId: string;
    poolVersion: typeof POOL_VERSION;
    interval: string;
    catalogAssets: string[];
    windows: TiedSetWindowResult[];
    t1Verdict: "CONFIRMED" | "NOT_CONFIRMED" | "INCONCLUSIVE";
    t3Interpretation: "AMBIGUOUS";
    programState: "edge_belongs_to_set" | "no_demonstrated_edge" | "halt_interpretation_ambiguous";
    reportLines: string[];
}

interface TiedEvent extends PoolRuleEvent {
    snapshots: Map<string, PoolSnapshotRecord>;
}

interface TiedPoint extends PoolRuleValuePoint {
    tiedAssets: string[];
}

interface ReconciliationPoint {
    eventId: string;
    decisionTimeSec: number;
    archivedDelta: number;
    engineDelta: number;
    setComponent: number;
    pickWithinSetComponent: number;
}

interface AnalysisContext {
    archive: PoolRuleArchive;
    catalogAssets: readonly string[];
    events: readonly TiedEvent[];
    outcomes: ReadonlyMap<string, CandidateOutcomeRecord>;
    engineRows: ReadonlyMap<string, EngineTopMeanRow>;
}

function mean(values: readonly number[]): number | null {
    return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function finiteNumber(value: unknown): number | null {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function outcomeKey(eventId: string, horizonBars: number, asset: string): string {
    return `${eventId}|${horizonBars}|${asset}`;
}

function okReturn(
    outcomes: ReadonlyMap<string, CandidateOutcomeRecord>,
    eventId: string,
    horizonBars: number,
    asset: string,
): number | null {
    const row = outcomes.get(outcomeKey(eventId, horizonBars, asset));
    return row?.status === "ok" && finiteNumber(row.return) !== null ? row.return : null;
}

function okReturns(
    outcomes: ReadonlyMap<string, CandidateOutcomeRecord>,
    eventId: string,
    horizonBars: number,
    assets: readonly string[],
): number[] {
    return assets
        .map((asset) => okReturn(outcomes, eventId, horizonBars, asset))
        .filter((value): value is number => value !== null);
}

export function meanOkReturns(
    outcomes: ReadonlyMap<string, CandidateOutcomeRecord>,
    eventId: string,
    horizonBars: number,
    assets: readonly string[],
): number | null {
    return mean(okReturns(outcomes, eventId, horizonBars, assets));
}

export function extractTieGroup(rows: readonly PoolSnapshotRecord[]): TiedSetGroup {
    const eligible = rows.filter((row) => row.longEligible);
    for (const row of eligible) {
        if (finiteNumber(row.score) === null) {
            throw new Error(`eligible snapshot has no finite score: ${row.eventId}/${row.asset}`);
        }
    }
    if (eligible.length === 0) return { eligibleAssets: [], tiedAssets: [], maxScore: null };
    const maxScore = Math.max(...eligible.map((row) => row.score as number));
    return {
        eligibleAssets: eligible.map((row) => row.asset),
        tiedAssets: eligible.filter((row) => row.score === maxScore).map((row) => row.asset),
        maxScore,
    };
}

export function computeTiedSetEventMetrics(args: {
    eventId: string;
    horizonBars: number;
    snapshots: readonly PoolSnapshotRecord[];
    outcomes: ReadonlyMap<string, CandidateOutcomeRecord>;
    enginePickAsset?: string | null;
}): TiedSetEventMetrics {
    const group = extractTieGroup(args.snapshots);
    if (args.enginePickAsset !== undefined && args.enginePickAsset !== null
        && !group.tiedAssets.includes(args.enginePickAsset)) {
        throw new Error(`TOP_MEAN pick is outside the computed tied set: ${args.eventId}/${args.horizonBars}/${args.enginePickAsset}`);
    }
    const nonTieAssets = group.eligibleAssets.filter((asset) => !group.tiedAssets.includes(asset));
    const tiedValues = okReturns(args.outcomes, args.eventId, args.horizonBars, group.tiedAssets);
    const eligibleValues = okReturns(args.outcomes, args.eventId, args.horizonBars, group.eligibleAssets);
    const nonTieValues = okReturns(args.outcomes, args.eventId, args.horizonBars, nonTieAssets);
    const tiedMean = mean(tiedValues);
    const eligibleMean = mean(eligibleValues);
    const nonTieMean = mean(nonTieValues);
    const pickReturn = args.enginePickAsset === undefined || args.enginePickAsset === null
        ? null
        : okReturn(args.outcomes, args.eventId, args.horizonBars, args.enginePickAsset);
    const otherEligibleAssets = args.enginePickAsset === undefined || args.enginePickAsset === null
        ? []
        : group.eligibleAssets.filter((asset) => asset !== args.enginePickAsset);
    const otherMean = meanOkReturns(args.outcomes, args.eventId, args.horizonBars, otherEligibleAssets);
    const engineDelta = pickReturn !== null && otherMean !== null ? pickReturn - otherMean : null;
    const setComponent = tiedMean !== null && otherMean !== null ? tiedMean - otherMean : null;
    const pickWithinSetComponent = pickReturn !== null && tiedMean !== null ? pickReturn - tiedMean : null;
    return {
        group,
        tiedOkCount: tiedValues.length,
        eligibleOkCount: eligibleValues.length,
        nonTieOkCount: nonTieValues.length,
        tiedMean,
        eligibleMean,
        nonTieMean,
        t1: tiedValues.length >= 2 && tiedMean !== null && eligibleMean !== null ? tiedMean - eligibleMean : null,
        t2: tiedValues.length >= 2 && tiedMean !== null && nonTieMean !== null ? tiedMean - nonTieMean : null,
        t3: pickReturn !== null && tiedMean !== null ? pickReturn - tiedMean : null,
        engineDelta,
        setComponent,
        pickWithinSetComponent,
    };
}

function archiveCatalog(meta: PoolRuleMeta): string[] {
    const raw = Array.isArray(meta.manifest?.catalog?.assets)
        ? meta.manifest.catalog.assets
        : Array.isArray(meta.canonicalAssets) ? meta.canonicalAssets : [];
    const assets = raw
        .filter((asset): asset is string => typeof asset === "string")
        .map((asset) => asset.trim().toUpperCase());
    if (assets.length !== 70 || new Set(assets).size !== assets.length) {
        throw new Error(`archive catalog must contain exactly 70 unique assets; found ${assets.length}`);
    }
    return assets;
}

function buildEvents(
    snapshots: readonly PoolSnapshotRecord[],
    catalogAssets: readonly string[],
): TiedEvent[] {
    const catalog = new Set(catalogAssets);
    const events = new Map<string, TiedEvent>();
    for (const row of snapshots) {
        if (!catalog.has(row.asset)) throw new Error(`snapshot asset is outside catalog: ${row.asset}`);
        let event = events.get(row.eventId);
        if (!event) {
            event = { eventId: row.eventId, decisionTimeSec: row.decisionTimeSec, snapshots: new Map() };
            events.set(row.eventId, event);
        }
        if (event.snapshots.has(row.asset)) throw new Error(`duplicate snapshot: ${row.eventId}/${row.asset}`);
        event.snapshots.set(row.asset, row);
    }
    return [...events.values()].sort((left, right) => left.decisionTimeSec - right.decisionTimeSec || left.eventId.localeCompare(right.eventId));
}

function buildOutcomeMap(outcomes: readonly CandidateOutcomeRecord[]): Map<string, CandidateOutcomeRecord> {
    const map = new Map<string, CandidateOutcomeRecord>();
    for (const row of outcomes) {
        if (row.direction !== "long") continue;
        const key = outcomeKey(row.eventId, row.horizonBars, row.asset);
        if (map.has(key)) throw new Error(`duplicate long outcome: ${key}`);
        map.set(key, row);
    }
    return map;
}

function engineRowKey(eventId: string, horizonBars: number): string {
    return `${eventId}|${horizonBars}`;
}

function buildEngineRows(rows: readonly PoolRuleEventRow[]): Map<string, EngineTopMeanRow> {
    const map = new Map<string, EngineTopMeanRow>();
    for (const row of rows) {
        const asset = (row as PoolRuleEventRow & { asset?: unknown }).asset;
        if (row.selector !== "TOP_MEAN" || row.direction !== "long") continue;
        if (typeof row.eventId !== "string" || typeof asset !== "string" || typeof row.horizonBars !== "number") {
            throw new Error("malformed TOP_MEAN row in events-full.jsonl");
        }
        const key = engineRowKey(row.eventId, row.horizonBars);
        if (map.has(key)) throw new Error(`duplicate TOP_MEAN row: ${key}`);
        map.set(key, {
            eventId: row.eventId,
            horizonBars: row.horizonBars,
            asset: asset.toUpperCase(),
            delta: finiteNumber(row.delta),
        });
    }
    return map;
}

function buildContext(archive: PoolRuleArchive): AnalysisContext {
    const poolVersion = archive.meta.manifest?.pairs?.source?.poolVersion;
    if (poolVersion !== POOL_VERSION) throw new Error(`tied-set analysis requires poolVersion ${POOL_VERSION}; found ${String(poolVersion)}`);
    const catalogAssets = archiveCatalog(archive.meta);
    const snapshots = buildEvents(archive.snapshots, catalogAssets);
    const engineRows = buildEngineRows(archive.eventRows);
    if (engineRows.size === 0) throw new Error("events-full.jsonl has no long TOP_MEAN rows");
    return {
        archive,
        catalogAssets,
        events: snapshots,
        outcomes: buildOutcomeMap(archive.outcomes),
        engineRows,
    };
}

function distribution(values: readonly number[]): TiedSetDistribution {
    const sorted = [...values].sort((left, right) => left - right);
    return {
        n: sorted.length,
        mean: mean(sorted),
        min: sorted[0] ?? null,
        median: sorted.length > 0 ? sorted[Math.floor(sorted.length / 2)]! : null,
        max: sorted[sorted.length - 1] ?? null,
    };
}

function summarize(points: readonly PoolRuleValuePoint[]): MetricSummary {
    const blocks = splitChronologicalBlocks(points);
    const blockMeans = blocks.map((block) => mean(block) as number);
    const ci = bootstrapBlockMeans(blockMeans);
    return {
        events: points.length,
        mean: mean(points.map((point) => point.value)),
        ciLower: ci.lower,
        ciUpper: ci.upper,
        blockMeans,
        positiveBlocks: blockMeans.filter((value) => value > 0).length,
        totalBlocks: blockMeans.length,
    };
}

function windowEvents(events: readonly TiedEvent[], window: WindowSpec): TiedEvent[] {
    return events.filter((event) => event.decisionTimeSec >= window.fromSec && event.decisionTimeSec <= window.toSec);
}

function monthWindowSpecs(): WindowSpec[] {
    return [
        { key: "discovery_2025", label: "2025 discovery", fromSec: PAIRLIST_POOL_RULE_DISCOVERY_FROM_SEC, toSec: PAIRLIST_POOL_RULE_DISCOVERY_TO_SEC },
        { key: "validation_2026", label: "2026 validation", fromSec: PAIRLIST_POOL_RULE_VALIDATION_FROM_SEC, toSec: PAIRLIST_POOL_RULE_VALIDATION_TO_SEC },
    ];
}

function metricPoint(event: TiedEvent, value: number, tiedAssets: readonly string[] = []): TiedPoint {
    return { eventId: event.eventId, decisionTimeSec: event.decisionTimeSec, value, tiedAssets: [...tiedAssets] };
}

function frequency(
    counts: ReadonlyMap<string, number>,
    denominator: number,
): TiedSetSelectionFrequency[] {
    return [...counts.entries()]
        .map(([asset, events]) => ({ asset, events, share: denominator > 0 ? events / denominator : 0 }))
        .sort((left, right) => right.events - left.events || left.asset.localeCompare(right.asset));
}

function evaluateWindowHorizon(
    context: AnalysisContext,
    events: readonly TiedEvent[],
    horizonBars: number,
    dominantTieSetMember: string | null,
): TiedSetHorizonResult {
    const t1Points: TiedPoint[] = [];
    const t2Points: TiedPoint[] = [];
    const t3Points: PoolRuleValuePoint[] = [];
    const t1ExDominantPoints: TiedPoint[] = [];
    const reconciliationPoints: ReconciliationPoint[] = [];
    let tiedSetLt2Ok = 0;
    let t2TiedSetAllEligible = 0;
    let t2NoNonTieOkReturns = 0;
    let missingTopMeanRow = 0;
    let t3MissingOkReturn = 0;

    for (const event of events) {
        const row = context.engineRows.get(engineRowKey(event.eventId, horizonBars));
        if (!row) missingTopMeanRow += 1;
        const metrics = computeTiedSetEventMetrics({
            eventId: event.eventId,
            horizonBars,
            snapshots: [...event.snapshots.values()],
            outcomes: context.outcomes,
            enginePickAsset: row?.asset,
        });
        if (metrics.tiedOkCount < 2) tiedSetLt2Ok += 1;
        if (metrics.group.eligibleAssets.length > 0
            && metrics.group.tiedAssets.length === metrics.group.eligibleAssets.length) t2TiedSetAllEligible += 1;
        if (metrics.nonTieOkCount === 0) t2NoNonTieOkReturns += 1;
        if (metrics.t1 !== null) {
            const point = metricPoint(event, metrics.t1, metrics.group.tiedAssets);
            t1Points.push(point);
            if (dominantTieSetMember === null || !metrics.group.tiedAssets.includes(dominantTieSetMember)) {
                t1ExDominantPoints.push(point);
            }
        }
        if (metrics.t2 !== null) t2Points.push(metricPoint(event, metrics.t2, metrics.group.tiedAssets));
        if (row && metrics.t3 !== null) {
            t3Points.push(metricPoint(event, metrics.t3));
        } else if (row) {
            t3MissingOkReturn += 1;
        }
        if (row?.delta !== null && row?.delta !== undefined
            && metrics.engineDelta !== null
            && metrics.setComponent !== null
            && metrics.pickWithinSetComponent !== null) {
            reconciliationPoints.push({
                eventId: event.eventId,
                decisionTimeSec: event.decisionTimeSec,
                archivedDelta: row.delta,
                engineDelta: metrics.engineDelta,
                setComponent: metrics.setComponent,
                pickWithinSetComponent: metrics.pickWithinSetComponent,
            });
        }
    }
    const reconciliation = reconciliationPoints.length > 0
        ? {
            archivedEngineMean: mean(reconciliationPoints.map((point) => point.archivedDelta)),
            recomputedEngineMean: mean(reconciliationPoints.map((point) => point.engineDelta)),
            setComponentMean: mean(reconciliationPoints.map((point) => point.setComponent)),
            pickWithinSetMean: mean(reconciliationPoints.map((point) => point.pickWithinSetComponent)),
            componentSum: mean(reconciliationPoints.map((point) => point.setComponent + point.pickWithinSetComponent)),
            residual: mean(reconciliationPoints.map((point) => point.engineDelta - point.setComponent - point.pickWithinSetComponent)),
            archivedVsRecomputed: mean(reconciliationPoints.map((point) => point.archivedDelta - point.engineDelta)),
            archivedRows: events.filter((event) => context.engineRows.has(engineRowKey(event.eventId, horizonBars))).length,
            recomputedRows: reconciliationPoints.length,
        }
        : {
            archivedEngineMean: null,
            recomputedEngineMean: null,
            setComponentMean: null,
            pickWithinSetMean: null,
            componentSum: null,
            residual: null,
            archivedVsRecomputed: null,
            archivedRows: events.filter((event) => context.engineRows.has(engineRowKey(event.eventId, horizonBars))).length,
            recomputedRows: 0,
        };
    return {
        horizonBars,
        t1: summarize(t1Points),
        t2: summarize(t2Points),
        t3: summarize(t3Points),
        t1ExDominant: summarize(t1ExDominantPoints),
        excluded: { tiedSetLt2Ok, t2TiedSetAllEligible, t2NoNonTieOkReturns, missingTopMeanRow, t3MissingOkReturn },
        reconciliation,
    };
}

function evaluateWindow(context: AnalysisContext, window: WindowSpec): TiedSetWindowResult {
    const events = windowEvents(context.events, window);
    const tiedSetSizes: number[] = [];
    const tiedSetRatios: number[] = [];
    const membershipCounts = new Map<string, number>();
    for (const event of events) {
        const group = extractTieGroup([...event.snapshots.values()]);
        tiedSetSizes.push(group.tiedAssets.length);
        if (group.eligibleAssets.length > 0) tiedSetRatios.push(group.tiedAssets.length / group.eligibleAssets.length);
        for (const asset of group.tiedAssets) membershipCounts.set(asset, (membershipCounts.get(asset) ?? 0) + 1);
    }
    const tiedSetMembership = frequency(membershipCounts, events.length);
    const dominantTieSetMember = tiedSetMembership[0]?.asset ?? null;
    return {
        window: window.key,
        label: window.label,
        tiedSetSize: distribution(tiedSetSizes),
        tiedSetEligibleRatio: distribution(tiedSetRatios),
        tiedSetMembership,
        dominantTieSetMember,
        horizons: PAIRLIST_POOL_RULE_HORIZONS.map((horizonBars) =>
            evaluateWindowHorizon(context, events, horizonBars, dominantTieSetMember)),
    };
}

function fmtPct(value: number | null): string {
    return value === null ? "n/a" : `${value >= 0 ? "+" : ""}${(value * 100).toFixed(2)}%`;
}

function fmtMetric(label: string, metric: MetricSummary): string {
    return `${label}: n=${metric.events} mean=${fmtPct(metric.mean)} CI95=[${fmtPct(metric.ciLower)}, ${fmtPct(metric.ciUpper)}] blocks=${metric.positiveBlocks}/${metric.totalBlocks}`;
}

function fmtDistribution(label: string, value: TiedSetDistribution): string {
    return `${label}: n=${value.n} mean=${value.mean === null ? "n/a" : value.mean.toFixed(3)} min=${value.min === null ? "n/a" : value.min.toFixed(3)} median=${value.median === null ? "n/a" : value.median.toFixed(3)} max=${value.max === null ? "n/a" : value.max.toFixed(3)}`;
}

function buildReportLines(result: Omit<TiedSetAnalysisResult, "reportLines">): string[] {
    const lines = [
        "TOP_MEAN tied-set analysis",
        `Run: ${result.runId}`,
        `Pool version: ${result.poolVersion}`,
        `Catalog: ${result.catalogAssets.length} assets | interval=${result.interval} | long side only`,
        "Frame: 2026 validation primary / 2025 discovery descriptive; 48 bars primary / 12+24 descriptive; 10 chronological blocks; 10,000 bootstrap resamples; seed 1.",
        "T1 rule: tied-set equal-weight mean minus same-pool-random equal-weight mean of all eligible positives; both sides computable.",
        "T2 rule: tied-set equal-weight mean minus non-tie eligible mean; tied-set <2 ok returns and empty non-tie sides are excluded.",
        "T3 rule: FNV TOP_MEAN pick minus its tied-set mean; diagnostic only, no pass/fail.",
        "Decision rule: T1 CONFIRMED at 48 bars in 2026 only if CI95 lower bound >0 and ≥8/10 positive blocks.",
        "T3 significance: AMBIGUOUS — registration specifies significant non-zero but registers no numeric significance threshold; no significance classification is applied.",
    ];
    for (const window of result.windows) {
        lines.push(`\n${window.label} | dominant tie-set member=${window.dominantTieSetMember ?? "NONE"}`);
        lines.push(fmtDistribution("TIED_SET_SIZE", window.tiedSetSize));
        lines.push(fmtDistribution("TIED_SET_ELIGIBLE_RATIO", window.tiedSetEligibleRatio));
        lines.push(`TIED_SET_MEMBERSHIP: ${window.tiedSetMembership.length === 0 ? "n/a" : window.tiedSetMembership.map((row) => `${row.asset}=${row.events} (${(row.share * 100).toFixed(2)}%)`).join(", ")}`);
        for (const horizon of window.horizons) {
            lines.push(`Horizon ${horizon.horizonBars} bars`);
            lines.push(fmtMetric("T1_TIED_SET_EQUAL_WEIGHT_MINUS_SAME_POOL_RANDOM", horizon.t1));
            lines.push(fmtMetric("T2_TIED_SET_EQUAL_WEIGHT_MINUS_NON_TIE_ELIGIBLE_MEAN", horizon.t2));
            lines.push(fmtMetric("T3_FNV_PICK_MINUS_TIED_SET_MEAN", horizon.t3));
            lines.push(fmtMetric("T1_EX_DOMINANT", horizon.t1ExDominant));
            lines.push(`Excluded: tiedSetLt2Ok=${horizon.excluded.tiedSetLt2Ok} t2TiedSetAllEligible=${horizon.excluded.t2TiedSetAllEligible} t2NoNonTieOkReturns=${horizon.excluded.t2NoNonTieOkReturns} missingTopMeanRow=${horizon.excluded.missingTopMeanRow} t3MissingOkReturn=${horizon.excluded.t3MissingOkReturn}`);
            const reconciliation = horizon.reconciliation;
            lines.push(`RECONCILIATION h${horizon.horizonBars}: archivedEngineMean=${fmtPct(reconciliation.archivedEngineMean)} recomputedEngineMean=${fmtPct(reconciliation.recomputedEngineMean)} setComponent=${fmtPct(reconciliation.setComponentMean)} pickWithinSetComponent=${fmtPct(reconciliation.pickWithinSetMean)} componentSum=${fmtPct(reconciliation.componentSum)} residual=${fmtPct(reconciliation.residual)} archivedVsRecomputed=${fmtPct(reconciliation.archivedVsRecomputed)} rows=${reconciliation.recomputedRows}/${reconciliation.archivedRows}`);
        }
    }
    const validation = result.windows.find((window) => window.window === "validation_2026");
    const primary = validation?.horizons.find((horizon) => horizon.horizonBars === 48);
    lines.push(`\nT1 verdict @48/2026: ${result.t1Verdict}`);
    lines.push(`Program state: ${result.programState}`);
    if (primary) {
        lines.push(`T1 primary accounting: mean=${fmtPct(primary.t1.mean)} CI95=[${fmtPct(primary.t1.ciLower)}, ${fmtPct(primary.t1.ciUpper)}] positiveBlocks=${primary.t1.positiveBlocks}/${primary.t1.totalBlocks}`);
        lines.push(`T3 diagnostic @48/2026: mean=${fmtPct(primary.t3.mean)} CI95=[${fmtPct(primary.t3.ciLower)}, ${fmtPct(primary.t3.ciUpper)}] — AMBIGUOUS significance threshold`);
        lines.push(`Reconciliation accounting @48/2026: archived=${fmtPct(primary.reconciliation.archivedEngineMean)} = setComponent ${fmtPct(primary.reconciliation.setComponentMean)} + pickWithinSetComponent ${fmtPct(primary.reconciliation.pickWithinSetMean)} = ${fmtPct(primary.reconciliation.componentSum)}; residual=${fmtPct(primary.reconciliation.residual)}`);
    }
    return lines;
}

export function analyzeTiedSet(args: { runId: string; archive: PoolRuleArchive }): TiedSetAnalysisResult {
    const context = buildContext(args.archive);
    const windows = monthWindowSpecs().map((window) => evaluateWindow(context, window));
    const primary = windows.find((window) => window.window === "validation_2026")?.horizons.find((horizon) => horizon.horizonBars === 48);
    const t1Verdict: TiedSetAnalysisResult["t1Verdict"] = !primary || primary.t1.events === 0 || primary.t1.ciLower === null
        ? "INCONCLUSIVE"
        : primary.t1.ciLower > 0 && primary.t1.positiveBlocks >= 8 ? "CONFIRMED" : "NOT_CONFIRMED";
    const programState: TiedSetAnalysisResult["programState"] = t1Verdict === "CONFIRMED"
        ? "halt_interpretation_ambiguous"
        : t1Verdict === "NOT_CONFIRMED" ? "no_demonstrated_edge" : "halt_interpretation_ambiguous";
    const partial = {
        schema: "pairlist_tied_set_analysis.v1" as const,
        runId: args.runId,
        poolVersion: POOL_VERSION as typeof POOL_VERSION,
        interval: String(args.archive.meta.interval ?? ""),
        catalogAssets: [...context.catalogAssets],
        windows,
        t1Verdict,
        t3Interpretation: "AMBIGUOUS" as const,
        programState,
    };
    return { ...partial, reportLines: buildReportLines(partial) };
}

export function runTiedSetAnalysis(args: { root: string; runId: string }): TiedSetAnalysisResult {
    const archive = loadPoolRuleArchive(args.root, args.runId);
    const result = analyzeTiedSet({ runId: args.runId, archive });
    const outputDir = path.join(args.root, "archive", "pool-analysis");
    mkdirSync(outputDir, { recursive: true });
    writeFileSync(path.join(outputDir, `${args.runId}-TIESET.txt`), result.reportLines.join("\n") + "\n", "utf8");
    writeFileSync(
        path.join(outputDir, `${args.runId}-TIESET.json`),
        JSON.stringify(result, (key, value) => key === "reportLines" ? undefined : value, 2) + "\n",
        "utf8",
    );
    return result;
}

function isMainModule(): boolean {
    if (!process.argv[1]) return false;
    try {
        let modulePath = decodeURIComponent(new URL(import.meta.url).pathname);
        if (/^\/[A-Za-z]:/.test(modulePath)) modulePath = modulePath.slice(1);
        return path.resolve(modulePath).toLowerCase() === path.resolve(process.argv[1]).toLowerCase();
    } catch {
        return false;
    }
}

if (isMainModule()) {
    const runId = process.argv[2];
    if (!runId) {
        console.error("Usage: esno scripts/analyze-tied-set.ts <runId>");
        process.exitCode = 1;
    } else {
        try {
            const result = runTiedSetAnalysis({ root: process.cwd(), runId });
            console.log(result.reportLines.join("\n"));
        } catch (error) {
            console.error(`Tied-set analysis aborted: ${error instanceof Error ? error.message : String(error)}`);
            process.exitCode = 1;
        }
    }
}
