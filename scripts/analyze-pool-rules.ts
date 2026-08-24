/**
 * Offline Phase 2 P1/P2 pool-rule analyzer.
 *
 * This file is intentionally separate from the replay/coordinator path. It
 * reads a completed Phase 0b archive and local IBKR CSVs, then writes only to
 * archive/pool-analysis. The run directory is never modified.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
    fnv1a64Hex,
    tieBreakDigest,
    MAX_ACTIVE_BLOCK_COUNT,
    MAX_ACTIVE_BOOTSTRAP_SAMPLES,
    MAX_ACTIVE_BOOTSTRAP_SEED,
    PAIRLIST_POOL_RULE_BREADTH_THRESHOLD,
    PAIRLIST_POOL_RULE_CI_HIGH_QUANTILE,
    PAIRLIST_POOL_RULE_CI_LOW_QUANTILE,
    PAIRLIST_POOL_RULE_DISCOVERY_FROM_SEC,
    PAIRLIST_POOL_RULE_DISCOVERY_TO_SEC,
    PAIRLIST_POOL_RULE_EMA_SAMPLE_EVENTS,
    PAIRLIST_POOL_RULE_HORIZONS,
    PAIRLIST_POOL_RULE_LOOKBACK_BARS,
    PAIRLIST_POOL_RULE_PAIRED_FLOOR,
    PAIRLIST_POOL_RULE_POOL_VERSION,
    PAIRLIST_POOL_RULE_PRIMARY_SIZE,
    PAIRLIST_POOL_RULE_SECONDARY_SIZES,
    PAIRLIST_POOL_RULE_VALIDATION_FROM_SEC,
    PAIRLIST_POOL_RULE_VALIDATION_TO_SEC,
} from "../lib/batch-backtest/max-active-research-contract";
import type {
    CandidateOutcomeRecord,
    PoolSnapshotRecord,
} from "../lib/batch-backtest/batch-open-score-usd-replay-engine";
import { parseTimeToUnixSeconds } from "../lib/time-normalization";

const POOL_VERSION = PAIRLIST_POOL_RULE_POOL_VERSION;

export interface PoolRuleMeta {
    interval?: unknown;
    horizons?: unknown;
    canonicalAssets?: unknown;
    manifest?: {
        pairs?: { source?: { poolVersion?: unknown } };
        catalog?: { assets?: unknown };
    };
}

export interface PoolRuleEventRow {
    eventId?: unknown;
    decisionTime?: unknown;
    horizonBars?: unknown;
    selector?: unknown;
    direction?: unknown;
    delta?: unknown;
}

export interface PoolRuleArchive {
    meta: PoolRuleMeta;
    snapshots: readonly PoolSnapshotRecord[];
    outcomes: readonly CandidateOutcomeRecord[];
    eventRows: readonly PoolRuleEventRow[];
}

export interface PoolRuleBar {
    timeSec: number;
    close: number;
}

export interface PoolRuleAssetSeries {
    bars: readonly PoolRuleBar[];
    ema200: readonly (number | null)[];
}

export interface EmaAnchorCheck {
    passed: boolean;
    anchor: "strictly_before" | "shifted_one_bar" | null;
    checkedPairs: number;
    mismatches: number;
    mismatchRate: number | null;
    attempts: Array<{
        anchor: "strictly_before" | "shifted_one_bar";
        checkedPairs: number;
        mismatches: number;
        mismatchRate: number | null;
        passed: boolean;
    }>;
}

export interface MetricSummary {
    events: number;
    mean: number | null;
    ciLower: number | null;
    ciUpper: number | null;
    blockMeans: number[];
    positiveBlocks: number;
    totalBlocks: number;
}

export interface MatchedRandomSummary {
    subsetSize: number;
    requestedDrawsPerEvent: number;
    events: number;
    draws: number;
    validDraws: number;
    meanDelta: number | null;
    p025: number | null;
    p975: number | null;
    fractionAboveProposed: number | null;
}

export interface AssetSelectionCount {
    asset: string;
    events: number;
    share: number;
}

export interface ArmHorizonResult {
    horizonBars: number;
    poolQuality: MetricSummary;
    matchedRandom: MatchedRandomSummary;
    restrictedTopMean: MetricSummary;
    exDominantPoolQuality: MetricSummary;
    dominantAsset: string | null;
    selectedAssets: AssetSelectionCount[];
    benchmarkFull70TopMean: MetricSummary;
    pairedTopMeanMinusFull70: MetricSummary | null;
}

export interface PoolRuleArmResult {
    arm: "P1" | "P2_TOP35" | "P2_TOP21" | "P2_TOP49";
    label: string;
    primary: boolean;
    window: "discovery_2025" | "validation_2026";
    activeMonths: number;
    inactiveMonths: number;
    meanPoolSize: number | null;
    missingHistoryMonths: number;
    horizons: ArmHorizonResult[];
}

export interface PoolRuleAnalysisResult {
    schema: "pairlist_pool_analysis.v1";
    runId: string;
    poolVersion: typeof POOL_VERSION;
    interval: string;
    catalogAssets: string[];
    anchorCheck: EmaAnchorCheck;
    arms: PoolRuleArmResult[];
    verdicts: {
        p1: string;
        p2: string;
    };
    reportLines: string[];
}

export interface PoolRuleEvent {
    eventId: string;
    decisionTimeSec: number;
    snapshots: Map<string, PoolSnapshotRecord>;
}

interface WindowSpec {
    key: "discovery_2025" | "validation_2026";
    label: string;
    fromSec: number;
    toSec: number;
}

export interface PoolRuleMonthAnchor {
    month: string;
    event: EventData;
    breadth: number;
}

type MonthAnchor = PoolRuleMonthAnchor;

export interface PoolRuleValuePoint {
    eventId: string;
    decisionTimeSec: number;
    value: number;
    selectedAsset?: string;
}

type ValuePoint = PoolRuleValuePoint;

export interface PoolRuleEvaluationContext {
    catalogAssets: readonly string[];
    events: readonly EventData[];
    outcomeByKey: Map<string, CandidateOutcomeRecord>;
    seriesByAsset: Map<string, PoolRuleAssetSeries>;
    anchor: "strictly_before" | "shifted_one_bar";
}

type EventData = PoolRuleEvent;
type EvaluationContext = PoolRuleEvaluationContext;

function finiteNumber(value: unknown): number | null {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readJsonl<T>(filename: string): T[] {
    return readFileSync(filename, "utf8")
        .split(/\r?\n/)
        .filter((line) => line.trim().length > 0)
        .map((line, index) => {
            try {
                return JSON.parse(line) as T;
            } catch (error) {
                throw new Error(`${filename}:${index + 1}: invalid JSON (${String(error)})`);
            }
        });
}

export function loadPoolRuleArchive(root: string, runId: string): PoolRuleArchive {
    const runDir = path.join(root, "archive", "batch-open-score", runId);
    const meta = JSON.parse(readFileSync(path.join(runDir, "meta.json"), "utf8")) as PoolRuleMeta;
    return {
        meta,
        snapshots: readJsonl<PoolSnapshotRecord>(path.join(runDir, "pool-snapshots.jsonl")),
        outcomes: readJsonl<CandidateOutcomeRecord>(path.join(runDir, "candidate-outcomes.jsonl")),
        eventRows: readJsonl<PoolRuleEventRow>(path.join(runDir, "events-full.jsonl")),
    };
}

function archiveCatalog(meta: PoolRuleMeta): string[] {
    const manifestAssets = meta.manifest?.catalog?.assets;
    const assets = Array.isArray(manifestAssets)
        ? manifestAssets
        : Array.isArray(meta.canonicalAssets) ? meta.canonicalAssets : [];
    const normalized = assets
        .filter((asset): asset is string => typeof asset === "string")
        .map((asset) => asset.trim().toUpperCase());
    if (normalized.length === 0 || new Set(normalized).size !== normalized.length) {
        throw new Error("archive manifest has no unique canonical catalog");
    }
    if (normalized.length !== 70) {
        throw new Error(`archive catalog must contain exactly 70 assets; found ${normalized.length}`);
    }
    return normalized;
}

function buildEvents(
    snapshots: readonly PoolSnapshotRecord[],
    catalogAssets: readonly string[],
): EventData[] {
    const catalog = new Set(catalogAssets);
    const byId = new Map<string, EventData>();
    for (const row of snapshots) {
        if (!catalog.has(row.asset)) throw new Error(`snapshot asset ${row.asset} is outside the manifest catalog`);
        if (!Number.isFinite(row.decisionTimeSec) || !row.eventId) throw new Error("snapshot has invalid event identity");
        let event = byId.get(row.eventId);
        if (!event) {
            event = { eventId: row.eventId, decisionTimeSec: row.decisionTimeSec, snapshots: new Map() };
            byId.set(row.eventId, event);
        }
        if (event.decisionTimeSec !== row.decisionTimeSec || event.snapshots.has(row.asset)) {
            throw new Error(`duplicate or inconsistent snapshot for ${row.eventId}/${row.asset}`);
        }
        event.snapshots.set(row.asset, row);
    }
    return [...byId.values()].sort((a, b) => a.decisionTimeSec - b.decisionTimeSec || a.eventId.localeCompare(b.eventId));
}

function outcomeKey(eventId: string, horizonBars: number, asset: string): string {
    return `${eventId}|${horizonBars}|${asset}`;
}

function buildOutcomeMap(outcomes: readonly CandidateOutcomeRecord[]): Map<string, CandidateOutcomeRecord> {
    const map = new Map<string, CandidateOutcomeRecord>();
    for (const row of outcomes) {
        if (row.direction !== "long") continue;
        const key = outcomeKey(row.eventId, row.horizonBars, row.asset);
        if (map.has(key)) throw new Error(`duplicate long outcome ${key}`);
        map.set(key, row);
    }
    return map;
}

function monthKey(timeSec: number): string {
    return new Date(timeSec * 1000).toISOString().slice(0, 7);
}

function windowEvents(events: readonly EventData[], window: WindowSpec): EventData[] {
    return events.filter((event) => event.decisionTimeSec >= window.fromSec && event.decisionTimeSec <= window.toSec);
}

export function buildMonthAnchors(events: readonly PoolRuleEvent[]): MonthAnchor[] {
    const anchors = new Map<string, MonthAnchor>();
    for (const event of events) {
        const breadth = event.snapshots.values().next().value?.breadth;
        if (!Number.isFinite(breadth)) continue;
        const month = monthKey(event.decisionTimeSec);
        if (!anchors.has(month)) anchors.set(month, { month, event, breadth: breadth as number });
    }
    return [...anchors.values()].sort((a, b) => a.event.decisionTimeSec - b.event.decisionTimeSec);
}

export function buildP1Membership(
    anchors: readonly MonthAnchor[],
    catalogAssets: readonly string[],
): { members: Map<string, Set<string>>; activeMonths: number; inactiveMonths: number; meanPoolSize: number | null } {
    const members = new Map<string, Set<string>>();
    let activeMonths = 0;
    let inactiveMonths = 0;
    const sizes: number[] = [];
    for (const anchor of anchors) {
        const selected = anchor.breadth > PAIRLIST_POOL_RULE_BREADTH_THRESHOLD
            ? new Set(catalogAssets.filter((asset) => anchor.event.snapshots.get(asset)?.ema200Above === true))
            : new Set<string>();
        members.set(anchor.month, selected);
        if (anchor.breadth > PAIRLIST_POOL_RULE_BREADTH_THRESHOLD) {
            activeMonths += 1;
            sizes.push(selected.size);
        } else {
            inactiveMonths += 1;
        }
    }
    return { members, activeMonths, inactiveMonths, meanPoolSize: sizes.length > 0 ? mean(sizes) : null };
}

function anchorIndex(bars: readonly PoolRuleBar[], decisionTimeSec: number, anchor: "strictly_before" | "shifted_one_bar"): number {
    let index = -1;
    for (let i = 0; i < bars.length; i += 1) {
        const qualifies = anchor === "strictly_before"
            ? bars[i]!.timeSec < decisionTimeSec
            : bars[i]!.timeSec <= decisionTimeSec;
        if (!qualifies) break;
        index = i;
    }
    return index;
}

function median(values: readonly number[]): number | null {
    if (values.length === 0) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const middle = sorted.length >> 1;
    return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

export function buildEma200(bars: readonly PoolRuleBar[]): Array<number | null> {
    const ema = new Array<number | null>(bars.length).fill(null);
    if (bars.length < 200) return ema;
    let seed = 0;
    for (let i = 0; i < 200; i += 1) {
        const close = bars[i]!.close;
        if (!Number.isFinite(close) || close <= 0) return ema;
        seed += close;
    }
    ema[199] = seed / 200;
    const alpha = 2 / 201;
    for (let i = 200; i < bars.length; i += 1) {
        const close = bars[i]!.close;
        const previous = ema[i - 1];
        ema[i] = Number.isFinite(close) && close > 0 && previous !== null
            ? close * alpha + previous * (1 - alpha)
            : null;
    }
    return ema;
}

function anchorAbove(series: PoolRuleAssetSeries, decisionTimeSec: number, anchor: "strictly_before" | "shifted_one_bar"): boolean | null {
    const index = anchorIndex(series.bars, decisionTimeSec, anchor);
    if (index < 0) return null;
    const close = series.bars[index]!.close;
    const ema = series.ema200[index] ?? null;
    return Number.isFinite(close) && ema !== null && Number.isFinite(ema) ? close > ema : null;
}

export function validateEmaAnchor(args: {
    events: readonly Pick<EventData, "eventId" | "decisionTimeSec" | "snapshots">[];
    catalogAssets: readonly string[];
    seriesByAsset: ReadonlyMap<string, PoolRuleAssetSeries>;
    sampleSize?: number;
}): EmaAnchorCheck {
    if (args.events.length < PAIRLIST_POOL_RULE_EMA_SAMPLE_EVENTS) {
        throw new Error(`EMA anchor self-check requires at least ${PAIRLIST_POOL_RULE_EMA_SAMPLE_EVENTS} events; found ${args.events.length}`);
    }
    const sampleSize = Math.max(PAIRLIST_POOL_RULE_EMA_SAMPLE_EVENTS, Math.min(args.sampleSize ?? PAIRLIST_POOL_RULE_EMA_SAMPLE_EVENTS, args.events.length));
    // Use the first deterministic sample. The terminal archive events can be
    // right-censored before a next entry bar exists; those are outcome-missing
    // events, not evidence that the historical EMA anchor is misaligned.
    const sample = args.events.slice(0, sampleSize);
    const attempts: EmaAnchorCheck["attempts"] = [];
    const examplesByAnchor: string[][] = [];
    for (const anchor of ["strictly_before", "shifted_one_bar"] as const) {
        let checkedPairs = 0;
        let mismatches = 0;
        const attemptExamples: string[] = [];
        for (const event of sample) {
            for (const asset of args.catalogAssets) {
                const expected = event.snapshots.get(asset)?.ema200Above;
                const series = args.seriesByAsset.get(asset);
                if (expected === undefined || !series) {
                    mismatches += 1;
                    checkedPairs += 1;
                    continue;
                }
                const actual = anchorAbove(series, event.decisionTimeSec, anchor);
                if (actual === null) continue;
                checkedPairs += 1;
                if (actual !== expected) {
                    mismatches += 1;
                    if (attemptExamples.length < 4) attemptExamples.push(`${event.eventId}:${asset}:expected=${String(expected)} actual=${String(actual)}`);
                }
            }
        }
        const mismatchRate = checkedPairs > 0 ? mismatches / checkedPairs : null;
        const passed = mismatchRate !== null && mismatchRate <= 0.01;
        examplesByAnchor.push(attemptExamples);
        attempts.push({ anchor, checkedPairs, mismatches, mismatchRate, passed });
        if (passed) {
            return { passed: true, anchor, checkedPairs, mismatches, mismatchRate, attempts };
        }
    }
    throw new Error(`EMA anchor self-check failed: ${attempts.map((attempt) => `${attempt.anchor}=${attempt.mismatches}/${attempt.checkedPairs} (${((attempt.mismatchRate ?? 1) * 100).toFixed(2)}%)`).join(", ")} examples=${examplesByAnchor.map((examples, index) => `${attempts[index]!.anchor}:${examples.join(";")}`).join(" | ")}`);
}

export function buildP2Membership(
    anchors: readonly MonthAnchor[],
    catalogAssets: readonly string[],
    seriesByAsset: ReadonlyMap<string, PoolRuleAssetSeries>,
    anchor: "strictly_before" | "shifted_one_bar",
    size: number,
): { members: Map<string, Set<string>>; missingHistoryMonths: number } {
    const members = new Map<string, Set<string>>();
    let missingHistoryMonths = 0;
    for (const monthAnchor of anchors) {
        const values: Array<{ asset: string; momentum: number; relative: number }> = [];
        for (const asset of catalogAssets) {
            const series = seriesByAsset.get(asset);
            if (!series) continue;
            const index = anchorIndex(series.bars, monthAnchor.event.decisionTimeSec, anchor);
            const prior = index - PAIRLIST_POOL_RULE_LOOKBACK_BARS;
            if (prior < 0) continue;
            const currentClose = series.bars[index]?.close;
            const priorClose = series.bars[prior]?.close;
            if (!Number.isFinite(currentClose) || !Number.isFinite(priorClose) || (priorClose as number) <= 0) continue;
            values.push({ asset, momentum: (currentClose as number) / (priorClose as number) - 1, relative: 0 });
        }
        const crossSectionalMedian = median(values.map((value) => value.momentum));
        if (crossSectionalMedian === null || values.length < size) {
            missingHistoryMonths += 1;
            members.set(monthAnchor.month, new Set());
            continue;
        }
        for (const value of values) value.relative = value.momentum - crossSectionalMedian;
        values.sort((left, right) =>
            right.relative - left.relative
            || tieBreakDigest(monthAnchor.event.decisionTimeSec, left.asset).localeCompare(tieBreakDigest(monthAnchor.event.decisionTimeSec, right.asset))
            || left.asset.localeCompare(right.asset));
        members.set(monthAnchor.month, new Set(values.slice(0, size).map((value) => value.asset)));
    }
    return { members, missingHistoryMonths };
}

function createLcg(seed: number): () => number {
    let state = (Math.floor(seed) >>> 0) || 0x9e3779b9;
    return () => {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        return state / 0x100000000;
    };
}

function seedForSubset(eventId: string, poolSize: number): number {
    const digest = fnv1a64Hex(`${MAX_ACTIVE_BOOTSTRAP_SEED}|${eventId}:${poolSize}`);
    return (parseInt(digest.slice(-8), 16) ^ MAX_ACTIVE_BOOTSTRAP_SEED) >>> 0;
}

export function deterministicSubset(catalogAssets: readonly string[], poolSize: number, eventId: string): string[] {
    if (poolSize < 0 || poolSize > catalogAssets.length) throw new Error("invalid subset size");
    const next = createLcg(seedForSubset(eventId, poolSize));
    const work = catalogAssets.map((_, index) => index);
    for (let i = 0; i < poolSize; i += 1) {
        const swapIndex = i + Math.floor(next() * (work.length - i));
        [work[i], work[swapIndex]] = [work[swapIndex]!, work[i]!];
    }
    return work.slice(0, poolSize).sort((left, right) => left - right).map((index) => catalogAssets[index]!);
}

function deterministicSubsetWithRng(catalogAssets: readonly string[], poolSize: number, next: () => number): string[] {
    const work = catalogAssets.map((_, index) => index);
    for (let i = 0; i < poolSize; i += 1) {
        const swapIndex = i + Math.floor(next() * (work.length - i));
        [work[i], work[swapIndex]] = [work[swapIndex]!, work[i]!];
    }
    return work.slice(0, poolSize).map((index) => catalogAssets[index]!);
}

function mean(values: readonly number[]): number | null {
    if (values.length === 0) return null;
    return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function quantile(sortedValues: readonly number[], fraction: number): number | null {
    if (sortedValues.length === 0) return null;
    return sortedValues[Math.max(0, Math.min(sortedValues.length - 1, Math.floor(fraction * sortedValues.length)))] ?? null;
}

export function splitChronologicalBlocks(points: readonly ValuePoint[]): number[][] {
    if (points.length === 0) return [];
    const order = points.map((_, index) => index).sort((left, right) =>
        points[left]!.decisionTimeSec - points[right]!.decisionTimeSec || points[left]!.eventId.localeCompare(points[right]!.eventId));
    const blocks: number[][] = [];
    const count = Math.min(MAX_ACTIVE_BLOCK_COUNT, points.length);
    for (let block = 0; block < count; block += 1) {
        const start = Math.floor((block * points.length) / count);
        const end = Math.floor(((block + 1) * points.length) / count);
        if (end <= start) continue;
        blocks.push(order.slice(start, end).map((index) => points[index]!.value));
    }
    return blocks;
}

export function bootstrapBlockMeans(blockMeans: readonly number[], samples = MAX_ACTIVE_BOOTSTRAP_SAMPLES): { lower: number | null; upper: number | null } {
    if (blockMeans.length < MAX_ACTIVE_BLOCK_COUNT) return { lower: null, upper: null };
    const next = createLcg(MAX_ACTIVE_BOOTSTRAP_SEED);
    const means: number[] = [];
    for (let sample = 0; sample < samples; sample += 1) {
        let total = 0;
        for (let block = 0; block < blockMeans.length; block += 1) total += blockMeans[Math.floor(next() * blockMeans.length)]!;
        means.push(total / blockMeans.length);
    }
    means.sort((left, right) => left - right);
    return { lower: quantile(means, PAIRLIST_POOL_RULE_CI_LOW_QUANTILE), upper: quantile(means, PAIRLIST_POOL_RULE_CI_HIGH_QUANTILE) };
}

function summarize(points: readonly ValuePoint[]): MetricSummary {
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

function okReturn(
    outcomeByKey: ReadonlyMap<string, CandidateOutcomeRecord>,
    eventId: string,
    horizonBars: number,
    asset: string,
): number | null {
    const row = outcomeByKey.get(outcomeKey(eventId, horizonBars, asset));
    if (!row || row.status !== "ok" || !Number.isFinite(row.return)) return null;
    return row.return;
}

function catalogMean(
    context: EvaluationContext,
    eventId: string,
    horizonBars: number,
): number | null {
    const values = context.catalogAssets
        .map((asset) => okReturn(context.outcomeByKey, eventId, horizonBars, asset))
        .filter((value): value is number => value !== null);
    return mean(values);
}

export function computePoolQualityPoint(args: {
    catalogAssets: readonly string[];
    outcomeByKey: ReadonlyMap<string, CandidateOutcomeRecord>;
    eventId: string;
    decisionTimeSec: number;
    horizonBars: number;
    members: ReadonlySet<string>;
}): ValuePoint | null {
    const pool = mean([...args.members]
        .map((asset) => okReturn(args.outcomeByKey, args.eventId, args.horizonBars, asset))
        .filter((value): value is number => value !== null));
    const catalog = mean(args.catalogAssets
        .map((asset) => okReturn(args.outcomeByKey, args.eventId, args.horizonBars, asset))
        .filter((value): value is number => value !== null));
    return pool !== null && catalog !== null
        ? { eventId: args.eventId, decisionTimeSec: args.decisionTimeSec, value: pool - catalog }
        : null;
}

export function topMeanPoint(
    context: EvaluationContext,
    event: EventData,
    horizonBars: number,
    members: ReadonlySet<string>,
): ValuePoint & { selectedAsset: string } | null {
    const eligible = [...members]
        .map((asset) => event.snapshots.get(asset))
        .filter((row): row is PoolSnapshotRecord => row?.longEligible === true && finiteNumber(row.score) !== null)
        .sort((left, right) =>
            (right.score as number) - (left.score as number)
            || tieBreakDigest(event.decisionTimeSec, left.asset).localeCompare(tieBreakDigest(event.decisionTimeSec, right.asset))
            || left.asset.localeCompare(right.asset));
    if (eligible.length < 2) return null;
    const returns = eligible.map((row) => okReturn(context.outcomeByKey, event.eventId, horizonBars, row.asset));
    if (returns.some((value) => value === null)) return null;
    const validReturns = returns.filter((value): value is number => value !== null);
    const selectedReturn = validReturns[0]!;
    const control = mean(validReturns.slice(1));
    if (control === null) return null;
    return {
        eventId: event.eventId,
        decisionTimeSec: event.decisionTimeSec,
        value: selectedReturn - control,
        selectedAsset: eligible[0]!.asset,
    };
}

function evaluateMatchedRandom(
    context: EvaluationContext,
    events: readonly EventData[],
    membersByMonth: ReadonlyMap<string, ReadonlySet<string>>,
    horizonBars: number,
): MatchedRandomSummary {
    const points: Array<{ event: EventData; members: ReadonlySet<string>; delta: number; catalog: number }> = [];
    for (const event of events) {
        const members = membersByMonth.get(monthKey(event.decisionTimeSec));
        if (!members || members.size === 0) continue;
        const proposed = mean([...members].map((asset) => okReturn(context.outcomeByKey, event.eventId, horizonBars, asset)).filter((value): value is number => value !== null));
        const full = catalogMean(context, event.eventId, horizonBars);
        if (proposed === null || full === null) continue;
        points.push({ event, members, delta: proposed - full, catalog: full });
    }
    const distribution: number[] = [];
    let above = 0;
    let draws = 0;
    for (const point of points) {
        const next = createLcg(seedForSubset(point.event.eventId, point.members.size));
        const returns = new Map(context.catalogAssets.map((asset) => [asset, okReturn(context.outcomeByKey, point.event.eventId, horizonBars, asset)]));
        for (let draw = 0; draw < MAX_ACTIVE_BOOTSTRAP_SAMPLES; draw += 1) {
            const subset = deterministicSubsetWithRng(context.catalogAssets, point.members.size, next);
            const subsetMean = mean(subset.map((asset) => returns.get(asset)).filter((value): value is number => value !== null));
            if (subsetMean === null) continue;
            const delta = subsetMean - point.catalog;
            distribution.push(delta);
            if (delta > point.delta) above += 1;
            draws += 1;
        }
    }
    const sorted = [...distribution].sort((left, right) => left - right);
    const subsetSizes = new Set(points.map((point) => point.members.size));
    return {
        subsetSize: subsetSizes.size === 1 ? [...subsetSizes][0]! : 0,
        requestedDrawsPerEvent: MAX_ACTIVE_BOOTSTRAP_SAMPLES,
        events: points.length,
        draws: points.length * MAX_ACTIVE_BOOTSTRAP_SAMPLES,
        validDraws: distribution.length,
        meanDelta: mean(distribution),
        p025: quantile(sorted, PAIRLIST_POOL_RULE_CI_LOW_QUANTILE),
        p975: quantile(sorted, PAIRLIST_POOL_RULE_CI_HIGH_QUANTILE),
        fractionAboveProposed: draws > 0 ? above / draws : null,
    };
}

function evaluateArmHorizon(
    context: EvaluationContext,
    events: readonly EventData[],
    membersByMonth: ReadonlyMap<string, ReadonlySet<string>>,
    horizonBars: number,
): ArmHorizonResult {
    const quality: ValuePoint[] = [];
    const restricted: Array<ValuePoint & { selectedAsset: string }> = [];
    const benchmark: ValuePoint[] = [];
    for (const event of events) {
        const members = membersByMonth.get(monthKey(event.decisionTimeSec));
        if (!members || members.size === 0) continue;
        const proposed = mean([...members].map((asset) => okReturn(context.outcomeByKey, event.eventId, horizonBars, asset)).filter((value): value is number => value !== null));
        const full = catalogMean(context, event.eventId, horizonBars);
        if (proposed !== null && full !== null) quality.push({ eventId: event.eventId, decisionTimeSec: event.decisionTimeSec, value: proposed - full });
        const selected = topMeanPoint(context, event, horizonBars, members);
        if (selected) restricted.push(selected);
        const fullSelected = topMeanPoint(context, event, horizonBars, new Set(context.catalogAssets));
        if (fullSelected) benchmark.push(fullSelected);
    }
    const selectedCounts = new Map<string, number>();
    for (const point of restricted) selectedCounts.set(point.selectedAsset, (selectedCounts.get(point.selectedAsset) ?? 0) + 1);
    const selectedAssets = [...selectedCounts.entries()]
        .map(([asset, eventsCount]) => ({ asset, events: eventsCount, share: restricted.length > 0 ? eventsCount / restricted.length : 0 }))
        .sort((left, right) => right.events - left.events || left.asset.localeCompare(right.asset));
    const dominantAsset = selectedAssets[0]?.asset ?? null;
    const exDominant = quality.filter((point) => !restricted.some((selected) => selected.eventId === point.eventId && selected.selectedAsset === dominantAsset));
    const benchmarkByEvent = new Map(benchmark.map((point) => [point.eventId, point]));
    const paired = restricted
        .map((point) => {
            const reference = benchmarkByEvent.get(point.eventId);
            return reference ? { ...point, value: point.value - reference.value } : null;
        })
        .filter((point): point is ValuePoint & { selectedAsset: string } => point !== null);
    return {
        horizonBars,
        poolQuality: summarize(quality),
        matchedRandom: evaluateMatchedRandom(context, events, membersByMonth, horizonBars),
        restrictedTopMean: summarize(restricted),
        exDominantPoolQuality: summarize(exDominant),
        dominantAsset,
        selectedAssets,
        benchmarkFull70TopMean: summarize(benchmark),
        pairedTopMeanMinusFull70: paired.length > 0 ? summarize(paired) : null,
    };
}

function metricVerdict(metric: MetricSummary | null, lowerBound = 0): "CONFIRM" | "REFUTED" | "INCONCLUSIVE" {
    if (!metric || metric.events === 0 || metric.ciLower === null) return "INCONCLUSIVE";
    return metric.ciLower > lowerBound && metric.positiveBlocks >= 8 ? "CONFIRM" : "REFUTED";
}

function overallVerdict(...layers: Array<"CONFIRM" | "REFUTED" | "INCONCLUSIVE">): "CONFIRM" | "REFUTED" | "INCONCLUSIVE" {
    if (layers.every((layer) => layer === "CONFIRM")) return "CONFIRM";
    return layers.includes("REFUTED") ? "REFUTED" : "INCONCLUSIVE";
}

function fmtPct(value: number | null): string {
    return value === null ? "n/a" : `${value >= 0 ? "+" : ""}${(value * 100).toFixed(2)}%`;
}

function fmtMetric(label: string, metric: MetricSummary): string {
    return `${label}: n=${metric.events} mean=${fmtPct(metric.mean)} CI95=[${fmtPct(metric.ciLower)}, ${fmtPct(metric.ciUpper)}] blocks=${metric.positiveBlocks}/${metric.totalBlocks}`;
}

function fmtMatchedRandom(summary: MatchedRandomSummary): string {
    return `SIZE_MATCHED_RANDOM: k=${summary.subsetSize || "varies"} events=${summary.events} draws=${summary.validDraws}/${summary.draws} (10,000 attempts/event) meanDelta=${fmtPct(summary.meanDelta)} p025=${fmtPct(summary.p025)} p975=${fmtPct(summary.p975)} aboveProposed=${summary.fractionAboveProposed === null ? "n/a" : (summary.fractionAboveProposed * 100).toFixed(2) + "%"}`;
}

function loadCsvSeries(root: string, catalogAssets: readonly string[]): Map<string, PoolRuleAssetSeries> {
    const series = new Map<string, PoolRuleAssetSeries>();
    for (const asset of catalogAssets) {
        const candidates = [
            path.join(root, "price-data", "ibkr", "csv", "4h", `${asset}.csv`),
            path.join(root, "price-data", "ibkr", "csv", "4h", `${asset}USDT.csv`),
        ];
        const filename = candidates.find((candidate) => {
            try { readFileSync(candidate); return true; } catch { return false; }
        });
        if (!filename) throw new Error(`missing IBKR 4h CSV for ${asset}`);
        const rows = readFileSync(filename, "utf8").split(/\r?\n/).slice(1);
        const bars: PoolRuleBar[] = [];
        for (const line of rows) {
            if (!line.trim()) continue;
            const columns = line.split(",");
            const timeSec = parseTimeToUnixSeconds(columns[0]);
            const close = Number(columns[4]);
            if (timeSec === null || !Number.isFinite(close)) continue;
            bars.push({ timeSec, close });
        }
        bars.sort((left, right) => left.timeSec - right.timeSec);
        series.set(asset, { bars, ema200: buildEma200(bars) });
    }
    return series;
}

function armLabel(size: number): "P2_TOP35" | "P2_TOP21" | "P2_TOP49" {
    return size === PAIRLIST_POOL_RULE_PRIMARY_SIZE ? "P2_TOP35" : size === PAIRLIST_POOL_RULE_SECONDARY_SIZES[0] ? "P2_TOP21" : "P2_TOP49";
}

function analyzeWindow(
    context: EvaluationContext,
    window: WindowSpec,
    kind: "P1" | "P2",
    p2Size?: number,
): PoolRuleArmResult {
    const events = windowEvents(context.events, window);
    const anchors = buildMonthAnchors(events);
    let membership: Map<string, Set<string>>;
    let activeMonths = 0;
    let inactiveMonths = 0;
    let meanPoolSize: number | null = null;
    let missingHistoryMonths = 0;
    let arm: PoolRuleArmResult["arm"];
    let label: string;
    let primary = false;
    if (kind === "P1") {
        const p1 = buildP1Membership(anchors, context.catalogAssets);
        membership = p1.members;
        activeMonths = p1.activeMonths;
        inactiveMonths = p1.inactiveMonths;
        meanPoolSize = p1.meanPoolSize;
        arm = "P1";
        label = "P1 trend/breadth";
    } else {
        const size = p2Size!;
        const p2 = buildP2Membership(anchors, context.catalogAssets, context.seriesByAsset, context.anchor, size);
        membership = p2.members;
        missingHistoryMonths = p2.missingHistoryMonths;
        const sizes = [...membership.values()].filter((members) => members.size > 0).map((members) => members.size);
        activeMonths = sizes.length;
        inactiveMonths = anchors.length - activeMonths;
        meanPoolSize = mean(sizes);
        arm = armLabel(size);
        label = `P2 momentum top-${size}`;
        primary = size === PAIRLIST_POOL_RULE_PRIMARY_SIZE;
    }
    return {
        arm,
        label,
        primary,
        window: window.key,
        activeMonths,
        inactiveMonths,
        meanPoolSize,
        missingHistoryMonths,
            horizons: PAIRLIST_POOL_RULE_HORIZONS.map((horizonBars) => evaluateArmHorizon(context, events, membership, horizonBars)),
    };
}

function validationWindow(): WindowSpec {
    return { key: "validation_2026", label: "2026 validation", fromSec: PAIRLIST_POOL_RULE_VALIDATION_FROM_SEC, toSec: PAIRLIST_POOL_RULE_VALIDATION_TO_SEC };
}

function discoveryWindow(): WindowSpec {
    return { key: "discovery_2025", label: "2025 discovery", fromSec: PAIRLIST_POOL_RULE_DISCOVERY_FROM_SEC, toSec: PAIRLIST_POOL_RULE_DISCOVERY_TO_SEC };
}

function verdictLines(arms: readonly PoolRuleArmResult[]): { p1: string; p2: string } {
    const p1 = arms.find((arm) => arm.arm === "P1" && arm.window === "validation_2026");
    const p2 = arms.find((arm) => arm.arm === "P2_TOP35" && arm.window === "validation_2026");
    const p1Horizon = p1?.horizons.find((horizon) => horizon.horizonBars === 48);
    const p2Horizon = p2?.horizons.find((horizon) => horizon.horizonBars === 48);
    const p1Quality = metricVerdict(p1Horizon?.poolQuality ?? null);
    const p1Ranking = metricVerdict(p1Horizon?.restrictedTopMean ?? null);
    const p2Quality = metricVerdict(p2Horizon?.poolQuality ?? null);
    const p2Paired = metricVerdict(p2Horizon?.pairedTopMeanMinusFull70 ?? null, PAIRLIST_POOL_RULE_PAIRED_FLOOR);
    return {
        p1: `P1 verdict: ${overallVerdict(p1Quality, p1Ranking)} (pool-quality=${p1Quality}; restricted-TOP_MEAN=${p1Ranking})`,
        p2: `P2 verdict: ${overallVerdict(p2Quality, p2Paired)} (pool-quality=${p2Quality}; paired-TOP_MEAN-minus-FULL70=${p2Paired})`,
    };
}

function buildReportLines(result: Omit<PoolRuleAnalysisResult, "reportLines">): string[] {
    const lines = [
        "Pairlist Phase 2 — offline P1/P2 pool-rule analysis",
        `Run: ${result.runId}`,
        `Pool version: ${result.poolVersion}`,
        `Catalog: ${result.catalogAssets.length} assets | interval=${result.interval} | long side only`,
        `EMA anchor self-check: PASS anchor=${result.anchorCheck.anchor} checked=${result.anchorCheck.checkedPairs} mismatches=${result.anchorCheck.mismatches} rate=${((result.anchorCheck.mismatchRate ?? 0) * 100).toFixed(2)}%`,
        "Locked frame: discovery=2025-01-10..2025-12-31 descriptive; validation=2026-01-01..2026-08-24 primary; horizons=48 primary, 12/24 descriptive; blocks=10; bootstrap=10,000; seed=1.",
        "P1 rule: UTC monthly pool; first event with non-null breadth; active iff breadth strictly >0.50; members are ema200Above assets; inactive months are empty with no fallback.",
        "P2 rule: UTC monthly pool; trailing 120-bar return minus same-anchor cross-sectional median; exact top-35 primary; top-21/top-49 descriptive; missing history excluded.",
        "Pool-quality rule: mean status=ok long return in proposed pool minus mean status=ok long return across the full catalog, on the matched computable event set.",
        "Restricted TOP_MEAN rule: highest score among pool members with longEligible=true; FNV tie-break; control is the leave-one-out mean of the other eligible members.",
        "Verdict rule P1 @48/2026: both pool-quality and restricted TOP_MEAN need CI95 lower >0 and ≥8/10 positive blocks.",
        "Verdict rule P2 @48/2026 top-35: pool-quality needs CI95 lower >0 and ≥8/10 positive blocks; paired TOP_MEAN−FULL70 CI95 lower must be >−0.50 percentage points. Top-21/top-49 have no verdict.",
    ];
    for (const arm of result.arms) {
        lines.push(`\n${arm.label} | ${arm.window} | months active/inactive=${arm.activeMonths}/${arm.inactiveMonths} meanPoolSize=${arm.meanPoolSize === null ? "n/a" : arm.meanPoolSize.toFixed(2)} missingHistoryMonths=${arm.missingHistoryMonths}${arm.primary ? " | PRIMARY" : " | DESCRIPTIVE"}`);
        for (const horizon of arm.horizons) {
            lines.push(`Horizon ${horizon.horizonBars} bars`);
            lines.push(fmtMetric("POOL_QUALITY", horizon.poolQuality));
            lines.push(fmtMatchedRandom(horizon.matchedRandom));
            lines.push(fmtMetric("RESTRICTED_TOP_MEAN", horizon.restrictedTopMean));
            lines.push(fmtMetric("POOL_QUALITY_EX_DOMINANT", horizon.exDominantPoolQuality) + ` dominant=${horizon.dominantAsset ?? "NONE"}`);
            lines.push(`TOP_MEAN selected assets: ${horizon.selectedAssets.length === 0 ? "n/a" : horizon.selectedAssets.map((row) => `${row.asset}=${row.events} (${(row.share * 100).toFixed(2)}%)`).join(", ")}`);
            lines.push(fmtMetric("FULL70_BAL679_TOP_MEAN", horizon.benchmarkFull70TopMean));
            if (horizon.pairedTopMeanMinusFull70) lines.push(fmtMetric("PAIRED_TOP_MEAN_MINUS_FULL70", horizon.pairedTopMeanMinusFull70));
        }
    }
    lines.push("\n" + result.verdicts.p1);
    lines.push(result.verdicts.p2);
    return lines;
}

export function analyzePoolRules(args: {
    runId: string;
    archive: PoolRuleArchive;
    seriesByAsset: ReadonlyMap<string, PoolRuleAssetSeries>;
    interval?: string;
}): PoolRuleAnalysisResult {
    const poolVersion = args.archive.meta.manifest?.pairs?.source?.poolVersion;
    if (poolVersion !== POOL_VERSION) throw new Error(`Phase 2 requires poolVersion ${POOL_VERSION}; found ${String(poolVersion)}`);
    const catalogAssets = archiveCatalog(args.archive.meta);
    const events = buildEvents(args.archive.snapshots, catalogAssets);
    const eventRows = args.archive.eventRows.filter((row) => row.selector === "TOP_MEAN" && row.direction === "long");
    if (eventRows.length === 0) throw new Error("events-full.jsonl has no archived long TOP_MEAN rows");
    const anchorEvents = events.filter((event) => event.decisionTimeSec <= PAIRLIST_POOL_RULE_VALIDATION_TO_SEC && event.decisionTimeSec >= PAIRLIST_POOL_RULE_DISCOVERY_FROM_SEC);
    const anchorCheck = validateEmaAnchor({ events: anchorEvents, catalogAssets, seriesByAsset: args.seriesByAsset });
    const context: EvaluationContext = {
        catalogAssets,
        events,
        outcomeByKey: buildOutcomeMap(args.archive.outcomes),
        seriesByAsset: new Map(args.seriesByAsset),
        anchor: anchorCheck.anchor!,
    };
    const arms: PoolRuleArmResult[] = [];
    for (const window of [discoveryWindow(), validationWindow()]) {
        arms.push(analyzeWindow(context, window, "P1"));
        arms.push(analyzeWindow(context, window, "P2", PAIRLIST_POOL_RULE_PRIMARY_SIZE));
        for (const size of PAIRLIST_POOL_RULE_SECONDARY_SIZES) arms.push(analyzeWindow(context, window, "P2", size));
    }
    const verdicts = verdictLines(arms);
    const partial = {
        schema: "pairlist_pool_analysis.v1" as const,
        runId: args.runId,
        poolVersion: POOL_VERSION as typeof POOL_VERSION,
        interval: args.interval ?? String(args.archive.meta.interval ?? ""),
        catalogAssets,
        anchorCheck,
        arms,
        verdicts,
    };
    return { ...partial, reportLines: buildReportLines(partial) };
}

export function runPoolRuleAnalysis(args: { root: string; runId: string }): PoolRuleAnalysisResult {
    const archive = loadPoolRuleArchive(args.root, args.runId);
    const catalogAssets = archiveCatalog(archive.meta);
    const seriesByAsset = loadCsvSeries(args.root, catalogAssets);
    const result = analyzePoolRules({ runId: args.runId, archive, seriesByAsset });
    const outputDir = path.join(args.root, "archive", "pool-analysis");
    mkdirSync(outputDir, { recursive: true });
    writeFileSync(path.join(outputDir, `${args.runId}-P1P2.txt`), result.reportLines.join("\n") + "\n", "utf8");
    writeFileSync(
        path.join(outputDir, `${args.runId}-P1P2.json`),
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
        console.error("Usage: esno scripts/analyze-pool-rules.ts <runId>");
        process.exitCode = 1;
    } else {
        try {
            const result = runPoolRuleAnalysis({ root: process.cwd(), runId });
            console.log(result.reportLines.join("\n"));
        } catch (error) {
            console.error(`Phase 2 pool-rule analysis aborted: ${error instanceof Error ? error.message : String(error)}`);
            process.exitCode = 1;
        }
    }
}
