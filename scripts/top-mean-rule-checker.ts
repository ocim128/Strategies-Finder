/**
 * Offline, read-only TOP_MEAN selector rule checker.
 *
 * The archive is the frozen source of candidate snapshots and outcomes. This
 * script only validates, selects, joins, and reports; it never runs a
 * backtest and never writes to the archive.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
    bootstrapBlockMeans,
    loadPoolRuleArchive,
    splitChronologicalBlocks,
    type PoolRuleArchive,
    type PoolRuleEventRow,
    type PoolRuleValuePoint,
} from "./analyze-pool-rules";
import {
    MAX_ACTIVE_BLOCK_COUNT,
    MAX_ACTIVE_BOOTSTRAP_SAMPLES,
    MAX_ACTIVE_BOOTSTRAP_SEED,
    MAX_ACTIVE_TIE_VERSION,
    PAIRLIST_POOL_RULE_DISCOVERY_FROM_SEC,
    PAIRLIST_POOL_RULE_DISCOVERY_TO_SEC,
    PAIRLIST_POOL_RULE_VALIDATION_FROM_SEC,
    PAIRLIST_POOL_RULE_VALIDATION_TO_SEC,
    tieBreakDigest,
} from "../lib/batch-backtest/max-active-research-contract";
import type {
    CandidateOutcomeRecord,
    PoolSnapshotRecord,
} from "../lib/batch-backtest/batch-open-score-usd-replay-engine";
import {
    TOP_MEAN_CAUSAL_FEATURE_FIELDS,
    TOP_MEAN_CANDIDATE_FEATURES_SCHEMA,
    TOP_MEAN_FEATURE_CONTRACT_VERSION,
    TOP_MEAN_FEATURE_FORMULA_VERSION,
    TOP_MEAN_FEATURE_AVAILABILITY_POLICY,
    type TopMeanCandidateFeatureRow,
    type TopMeanCausalFeatureField,
} from "../lib/batch-backtest/sp500-top-mean-causal-features";
import {
    TOP_MEAN_PRICE_FEATURE_FIELDS,
    TOP_MEAN_PRICE_FEATURES_SCHEMA,
    TOP_MEAN_PRICE_FEATURE_CONTRACT_VERSION,
    TOP_MEAN_PRICE_FEATURE_FORMULA_VERSION,
    TOP_MEAN_PRICE_FEATURE_AVAILABILITY_POLICY,
    TOP_MEAN_PRICE_SESSION_SCHEDULE_VERSION,
    type TopMeanPriceFeatureField,
    type TopMeanPriceFeatureRow,
} from "./lib/top-mean-price-features";
import type { TopMeanPriceManifest } from "./build-top-mean-price-features";

export const TOP_MEAN_RULE_HORIZON = 24;
export const TOP_MEAN_RULE_INTERVAL = "4h";
export const TOP_MEAN_RULE_DIRECTION = "long";
export const TOP_MEAN_RULE_L1_RUN_ID = "sp500_top_mean_1788443592188_cgd3";
export const TOP_MEAN_RULE_L2_RUN_ID = "sp500_top_mean_1788560534200_jedw";
const INCOMPLETE_ALLOWED = new Set([TOP_MEAN_RULE_L1_RUN_ID, TOP_MEAN_RULE_L2_RUN_ID]);

const TOP_MEAN_RULE_CANDIDATE_FIELDS = [
    "eventId",
    "decisionTimeSec",
    "interval",
    "poolVersion",
    "asset",
    "inPool",
    "activePairCount",
    "signedVotes",
    "score",
    "longEligible",
    "shortEligible",
    "ema200Above",
    "breadth",
    "regime",
] as const;

export const TOP_MEAN_RULE_V2_FIELDS = TOP_MEAN_CAUSAL_FEATURE_FIELDS;
export const TOP_MEAN_RULE_PRICE_FIELDS = TOP_MEAN_PRICE_FEATURE_FIELDS;

const TOP_MEAN_RULE_EVENT_FIELDS = [
    "decisionTimeSec",
    "breadth",
    "regime",
    "poolSize",
    "dow",
    "hour",
] as const;

const OUTCOME_STATUSES = ["ok", "missing_target", "missing_entry", "right_censored", "invalid_price"] as const;

type CandidateField = typeof TOP_MEAN_RULE_CANDIDATE_FIELDS[number];
type Regime = PoolSnapshotRecord["regime"];

export type TopMeanRuleCandidate = Readonly<Pick<PoolSnapshotRecord, CandidateField>
    & Partial<Record<TopMeanCausalFeatureField, number | null>>
    & Partial<Record<TopMeanPriceFeatureField, number | null>>>;
export type TopMeanRuleEvent = Readonly<{
    decisionTimeSec: number;
    breadth: number | null;
    regime: Regime;
    poolSize: number;
    dow: number;
    hour: number;
}>;
export type TopMeanRule = (candidate: TopMeanRuleCandidate, event: TopMeanRuleEvent) => number | boolean;

export type TopMeanRuleWindow = "discovery" | "validation";

export interface TopMeanRuleWindowSpec {
    name: TopMeanRuleWindow;
    fromSec: number;
    toSec: number;
}

export interface TopMeanRuleArchiveMeta {
    schema?: unknown;
    runId?: unknown;
    interval?: unknown;
    horizons?: unknown;
    canonicalAssets?: unknown;
    fingerprint?: unknown;
    runFingerprint?: unknown;
    fingerprintVersion?: unknown;
    postAssemblyFingerprint?: unknown;
    files?: unknown;
    featureSet?: unknown;
    manifest?: {
        catalog?: { assets?: unknown };
        researchContract?: {
            tieVersion?: unknown;
            blockCount?: unknown;
            bootstrapSamples?: unknown;
            bootstrapSeed?: unknown;
        };
    };
}

export interface TopMeanBaseCandidate {
    row: PoolSnapshotRecord;
    score: number;
    features: TopMeanCandidateFeatureRow | null;
    priceFeatures: TopMeanPriceFeatureRow | null;
}

export interface TopMeanNormalizedEvent {
    eventId: string;
    decisionTimeSec: number;
    snapshots: ReadonlyMap<string, PoolSnapshotRecord>;
    baseCandidates: readonly TopMeanBaseCandidate[];
    ruleEvent: TopMeanRuleEvent;
}

export interface TopMeanNormalizedArchive {
    runId: string;
    meta: TopMeanRuleMeta;
    reportText: string;
    catalogAssets: readonly string[];
    events: readonly TopMeanNormalizedEvent[];
    outcomeByKey: ReadonlyMap<string, CandidateOutcomeRecord>;
    eventRows: readonly PoolRuleEventRow[];
    featuresByKey?: ReadonlyMap<string, TopMeanCandidateFeatureRow>;
    priceFeaturesByKey?: ReadonlyMap<string, TopMeanPriceFeatureRow>;
    priceManifest?: TopMeanPriceManifest;
    admittedPriceFields?: readonly TopMeanPriceFeatureField[];
}

export interface TopMeanCausalArchive {
    runId: string;
    meta: TopMeanRuleMeta;
    catalogAssets: readonly string[];
    events: readonly TopMeanNormalizedEvent[];
    featuresByKey?: ReadonlyMap<string, TopMeanCandidateFeatureRow>;
    priceFeaturesByKey?: ReadonlyMap<string, TopMeanPriceFeatureRow>;
    priceManifest?: TopMeanPriceManifest;
    admittedPriceFields?: readonly TopMeanPriceFeatureField[];
}

interface TopMeanRuleMeta extends TopMeanRuleArchiveMeta {
    schema: string;
    runId: string;
    interval: string;
    horizons: readonly number[];
}

export interface TopMeanArchiveLocation {
    root: string;
    runId: string;
    runDir: string;
}

export interface SelfCheckResult {
    eventCount: number;
    dominantAsset: string | null;
    metric: ArchiveMetric;
}

export interface ArchiveMetric {
    n: number;
    topMean: number | null;
    controlMean: number | null;
    deltaMean: number | null;
    ciLower: number | null;
    ciUpper: number | null;
    blockMeans: readonly number[];
    positiveBlocks: number;
    totalBlocks: number;
}

export interface RuleMetric {
    n: number;
    mean: number | null;
    ciLower: number | null;
    ciUpper: number | null;
    blockMeans: readonly number[];
    positiveBlocks: number;
    totalBlocks: number;
    status: "CONCLUSIVE" | "INCONCLUSIVE";
}

export interface RuleEventPoint {
    eventId: string;
    decisionTimeSec: number;
    selectedAsset: string;
    selectedReturn: number;
    incumbentReturn: number;
    primary: number;
    secondary: number;
}

export interface SelectedAssetSummary {
    asset: string;
    events: number;
    share: number;
    selectedMean: number | null;
    secondaryDelta: number | null;
}

export interface TopMeanRuleEvaluation {
    window: TopMeanRuleWindowSpec;
    kind: "ranking" | "filter" | "none";
    candidateKeepRate: number;
    eventKeepRate: number;
    rawEventCount: number;
    baseCandidateEventCount: number;
    outcomeCompleteEventCount: number;
    points: readonly RuleEventPoint[];
    primary: RuleMetric;
    secondary: RuleMetric;
    selectedAssets: readonly SelectedAssetSummary[];
    dominantAsset: string | null;
    dominantExclusionPrimary: RuleMetric;
    dominantExclusionSecondary: RuleMetric;
    accessedV2Fields: readonly TopMeanCausalFeatureField[];
    nullReads: number;
    nullReadsByField: Readonly<Record<string, number>>;
    nullNeutralViolations: number;
    changedFullyObservedEvents: number;
    changedPartiallyObservedEvents: number;
    accessedPriceFields: readonly TopMeanPriceFeatureField[];
    priceFieldsFullyObservedEvents: number;
    priceFieldsPartiallyObservedEvents: number;
}

export interface PercentileSummary {
    n: number;
    p0: number | null;
    p1: number | null;
    p5: number | null;
    p25: number | null;
    p50: number | null;
    p75: number | null;
    p95: number | null;
    p99: number | null;
    p100: number | null;
}

export interface TopMeanCalibrationStats {
    window: TopMeanRuleWindowSpec;
    rawEventCount: number;
    baseCandidateEventCount: number;
    outcomeCompleteEventCount: number;
    exclusions: Readonly<{ NO_BASE_CANDIDATES: number; OUTCOME_INCOMPLETE: number }>;
    candidateSignedVotes: PercentileSummary;
    candidateActivePairCount: PercentileSummary;
    candidateScore: PercentileSummary;
    eventBreadth: PercentileSummary;
    eventPoolSize: PercentileSummary;
    eventsPerUtcDay: PercentileSummary;
    regimes: Readonly<Record<Regime, { events: number; share: number }>>;
}

export interface TopMeanCausalScreenEvaluation {
    window: TopMeanRuleWindowSpec;
    kind: "ranking" | "filter" | "none";
    rawEventCount: number;
    baseCandidateEventCount: number;
    baseCandidateCount: number;
    candidateKeepRate: number;
    selectedEvents: number;
    droppedEvents: number;
    changedEvents: number;
    unchangedEvents: number;
    accessedV2Fields: readonly TopMeanCausalFeatureField[];
    nullReads: number;
    nullReadsByField: Readonly<Record<string, number>>;
    nullNeutralViolations: number;
    changedFullyObservedEvents: number;
    changedPartiallyObservedEvents: number;
    accessedPriceFields: readonly TopMeanPriceFeatureField[];
    priceFieldsFullyObservedEvents: number;
    priceFieldsPartiallyObservedEvents: number;
}

export interface TopMeanCausalStats {
    window: TopMeanRuleWindowSpec;
    rawEventCount: number;
    baseCandidateEventCount: number;
    baseCandidateCount: number;
    incumbentActivePairCount: PercentileSummary;
    runnerUpActivePairCount: PercentileSummary;
    top1Score: PercentileSummary;
    top2Score: PercentileSummary;
    exactTopScoreTies: number;
    nearTieCounts: Readonly<{ le001: number; le0025: number; le005: number }>;
    topRawSelectionDifferences: number;
}

export interface TopMeanFeatureFieldStats {
    nonNull: number;
    nullCount: number;
    values: PercentileSummary;
    incumbent: PercentileSummary;
    runnerUp: PercentileSummary;
    nonIncumbent: PercentileSummary;
    withinEventRange: PercentileSummary;
    withinEventDistinctValueRate: number | null;
    correlations: Readonly<Record<string, number | null>>;
}

export interface TopMeanFeatureAvailabilityByEvent {
    ordinal: number;
    eventId: string;
    baseCandidates: number;
    nonNullByField: Readonly<Record<string, number>>;
}

export interface TopMeanFeatureStats {
    window: TopMeanRuleWindowSpec;
    rawEventCount: number;
    baseCandidateEventCount: number;
    baseCandidateCount: number;
    fields: Readonly<Record<TopMeanCausalFeatureField, TopMeanFeatureFieldStats>>;
    priceFields?: Readonly<Record<TopMeanPriceFeatureField, TopMeanFeatureFieldStats>>;
    availabilityByEvent: readonly TopMeanFeatureAvailabilityByEvent[];
    warmupCompletionByOrdinal: readonly TopMeanFeatureAvailabilityByEvent[];
    priorTopMeanReturnMean3Availability: Readonly<{ zero: number; one: number; twoPlus: number }>;
    crossFeatureCorrelations: Readonly<Record<string, number | null>>;
    priceCrossFeatureCorrelations?: Readonly<Record<string, number | null>>;
}

interface RuleAccessTracker {
    accessed: Set<TopMeanCausalFeatureField>;
    accessedPrice: Set<TopMeanPriceFeatureField>;
    nullReads: number;
    nullReadsByField: Map<string, number>;
    nullNeutralViolations: number;
}

export interface TopMeanRuleAccessSummary {
    accessedV2Fields: readonly TopMeanCausalFeatureField[];
    nullReads: number;
    nullReadsByField: Readonly<Record<string, number>>;
    nullNeutralViolations: number;
    accessedPriceFields: readonly TopMeanPriceFeatureField[];
}

function createRuleAccessTracker(): RuleAccessTracker {
    return { accessed: new Set(), accessedPrice: new Set(), nullReads: 0, nullReadsByField: new Map(), nullNeutralViolations: 0 };
}

function accessSummary(tracker: RuleAccessTracker): TopMeanRuleAccessSummary {
    const nullReadsByField: Record<string, number> = {};
    for (const field of [...TOP_MEAN_CAUSAL_FEATURE_FIELDS, ...TOP_MEAN_PRICE_FEATURE_FIELDS]) {
        const count = tracker.nullReadsByField.get(field) ?? 0;
        if (count > 0) nullReadsByField[field] = count;
    }
    return {
        accessedV2Fields: [...tracker.accessed].sort(codeUnitCompare),
        nullReads: tracker.nullReads,
        nullReadsByField,
        nullNeutralViolations: tracker.nullNeutralViolations,
        accessedPriceFields: [...tracker.accessedPrice].sort(codeUnitCompare),
    };
}

interface RuleDecision {
    event: TopMeanNormalizedEvent;
    candidateResults: readonly { candidate: TopMeanBaseCandidate; value: number | boolean }[];
    selected: TopMeanBaseCandidate | null;
    trueCandidateCount: number;
}

interface ComparableRow {
    eventId: string;
    decisionTime: number;
    entryTime: number;
    exitTime: number;
    horizonBars: number;
    selector: string;
    direction: string;
    asset: string;
    selectedReturn: number;
    controlReturn: number;
    delta: number;
    eligibleCandidates: number;
}

class CheckerFailure extends Error {
    readonly check: string;

    constructor(check: string, expected: string, actual: string, examples: readonly string[] = [], prefix = "SELF_CHECK FAIL") {
        const lines = [prefix, `check=${check}`, `expected=${expected}`, `actual=${actual}`];
        for (const example of [...examples].sort(codeUnitCompare).slice(0, 10)) lines.push(`mismatch=${example}`);
        super(lines.join("\n"));
        this.name = "CheckerFailure";
        this.check = check;
    }
}

class UsageFailure extends Error {
    constructor(message: string) {
        super(message);
        this.name = "UsageFailure";
    }
}

function codeUnitCompare(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
}

function numberCompare(left: number, right: number): number {
    return left < right ? -1 : left > right ? 1 : 0;
}

function finite(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value);
}

function integer(value: unknown): value is number {
    return finite(value) && Number.isInteger(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireCheck(condition: boolean, check: string, expected: string, actual: string, examples: readonly string[] = [], prefix = "SELF_CHECK FAIL"): asserts condition {
    if (!condition) throw new CheckerFailure(check, expected, actual, examples, prefix);
}

function metaRecord(meta: unknown): TopMeanRuleMeta {
    requireCheck(isRecord(meta), "meta.object", "object", typeof meta);
    const value = meta as unknown as TopMeanRuleMeta;
    requireCheck(value.schema === "top_mean_archive.v2" || value.schema === "top_mean_archive.v3", "meta.schema", "top_mean_archive.v2 or top_mean_archive.v3", String(value.schema));
    requireCheck(typeof value.runId === "string" && value.runId.length > 0, "meta.runId", "non-empty string", String(value.runId));
    requireCheck(value.interval === TOP_MEAN_RULE_INTERVAL, "meta.interval", TOP_MEAN_RULE_INTERVAL, String(value.interval));
    requireCheck(Array.isArray(value.horizons) && value.horizons.length === 1 && value.horizons[0] === TOP_MEAN_RULE_HORIZON, "meta.horizons", "[24]", JSON.stringify(value.horizons));
    return value;
}

function uniqueCatalog(value: unknown, check: string): string[] {
    requireCheck(Array.isArray(value), check, "non-empty unique string array", typeof value);
    const assets = (value as unknown[]).map((asset) => {
        requireCheck(typeof asset === "string" && asset.length > 0 && asset === asset.trim(), check, "non-empty trimmed strings", JSON.stringify(asset));
        return asset;
    });
    const unique = new Set(assets);
    requireCheck(assets.length > 0 && unique.size === assets.length, check, "non-empty unique string array", `${assets.length} entries/${unique.size} unique`);
    return assets;
}

function archiveCatalog(meta: TopMeanRuleMeta): string[] {
    const manifestAssets = meta.manifest?.catalog?.assets;
    const canonicalAssets = meta.canonicalAssets;
    const assets = manifestAssets !== undefined
        ? uniqueCatalog(manifestAssets, "meta.manifest.catalog.assets")
        : uniqueCatalog(canonicalAssets, "meta.canonicalAssets");
    if (manifestAssets !== undefined && canonicalAssets !== undefined) {
        const canonical = uniqueCatalog(canonicalAssets, "meta.canonicalAssets");
        requireCheck(assets.length === canonical.length && assets.every((asset, index) => asset === canonical[index]), "meta.catalog_identity", "manifest catalog equals canonicalAssets", "catalog arrays differ");
    }
    return [...assets].sort(codeUnitCompare);
}

function validateResearchContract(meta: TopMeanRuleMeta): void {
    const contract = meta.manifest?.researchContract;
    requireCheck(isRecord(contract), "meta.researchContract", "researchContract object", typeof contract);
    requireCheck(contract.tieVersion === MAX_ACTIVE_TIE_VERSION, "meta.researchContract.tieVersion", MAX_ACTIVE_TIE_VERSION, String(contract.tieVersion));
    requireCheck(contract.blockCount === MAX_ACTIVE_BLOCK_COUNT, "meta.researchContract.blockCount", String(MAX_ACTIVE_BLOCK_COUNT), String(contract.blockCount));
    requireCheck(contract.bootstrapSamples === MAX_ACTIVE_BOOTSTRAP_SAMPLES, "meta.researchContract.bootstrapSamples", String(MAX_ACTIVE_BOOTSTRAP_SAMPLES), String(contract.bootstrapSamples));
    requireCheck(contract.bootstrapSeed === MAX_ACTIVE_BOOTSTRAP_SEED, "meta.researchContract.bootstrapSeed", String(MAX_ACTIVE_BOOTSTRAP_SEED), String(contract.bootstrapSeed));
}

function validateIncompleteHeader(runId: string, reportText: string): void {
    const firstLine = reportText.split(/\r?\n/, 1)[0] ?? "";
    const hasIncompleteFlag = reportText.includes("DATA_INCOMPLETE");
    if (!hasIncompleteFlag) {
        requireCheck(!INCOMPLETE_ALLOWED.has(runId), "report.incomplete_header", "DATA_INCOMPLETE on a designated incomplete-allowed archive", firstLine);
        return;
    }
    requireCheck(INCOMPLETE_ALLOWED.has(runId), "report.incomplete_archive", `DATA_INCOMPLETE allowed only on designated archives (${[...INCOMPLETE_ALLOWED].join(", ")})`, runId);
    requireCheck(firstLine.includes("DATA_INCOMPLETE"), "report.incomplete_header", "DATA_INCOMPLETE on the first report line", firstLine);
}

function validateSnapshotRows(
    snapshots: readonly PoolSnapshotRecord[],
    catalogAssets: readonly string[],
): Map<string, Map<string, PoolSnapshotRecord>> {
    const catalog = new Set(catalogAssets);
    const byEvent = new Map<string, Map<string, PoolSnapshotRecord>>();
    const contexts = new Map<string, string>();
    const seen = new Set<string>();
    for (const row of snapshots) {
        requireCheck(isRecord(row), "snapshots.row", "object", typeof row);
        requireCheck(typeof row.eventId === "string" && row.eventId.length > 0, "snapshots.identity", "non-empty eventId", String(row.eventId));
        requireCheck(integer(row.decisionTimeSec), "snapshots.decisionTimeSec", "integer Unix seconds", String(row.decisionTimeSec));
        requireCheck(row.interval === TOP_MEAN_RULE_INTERVAL, "snapshots.interval", TOP_MEAN_RULE_INTERVAL, String(row.interval));
        requireCheck(row.poolVersion === null || typeof row.poolVersion === "string", "snapshots.poolVersion", "string or null", String(row.poolVersion));
        requireCheck(typeof row.asset === "string" && catalog.has(row.asset), "snapshots.asset", "catalog asset", String(row.asset));
        requireCheck(typeof row.inPool === "boolean", "snapshots.inPool", "boolean", String(row.inPool));
        requireCheck(integer(row.activePairCount) && row.activePairCount >= 0, "snapshots.activePairCount", "non-negative integer", String(row.activePairCount));
        requireCheck(integer(row.signedVotes), "snapshots.signedVotes", "integer", String(row.signedVotes));
        requireCheck(row.score === null || finite(row.score), "snapshots.score", "finite number or null", String(row.score));
        requireCheck(typeof row.longEligible === "boolean", "snapshots.longEligible", "boolean", String(row.longEligible));
        requireCheck(typeof row.shortEligible === "boolean", "snapshots.shortEligible", "boolean", String(row.shortEligible));
        requireCheck(typeof row.ema200Above === "boolean", "snapshots.ema200Above", "boolean", String(row.ema200Above));
        requireCheck(row.breadth === null || finite(row.breadth), "snapshots.breadth", "finite number or null", String(row.breadth));
        requireCheck(row.regime === "bullish" || row.regime === "bearish" || row.regime === "unavailable", "snapshots.regime", "bullish|bearish|unavailable", String(row.regime));
        const expectedScore = row.activePairCount > 0 ? row.signedVotes / row.activePairCount : null;
        requireCheck(expectedScore === null ? row.score === null : row.score !== null && Math.abs(row.score - expectedScore) <= 1e-12, "snapshots.score_recompute", String(expectedScore), String(row.score), [`${row.eventId}/${row.asset}`]);
        const key = `${row.eventId}|${row.asset}`;
        requireCheck(!seen.has(key), "snapshots.unique_identity", "one row per eventId|asset", key);
        seen.add(key);
        const context = JSON.stringify([row.decisionTimeSec, row.interval, row.poolVersion, row.breadth, row.regime]);
        const previousContext = contexts.get(row.eventId);
        requireCheck(previousContext === undefined || previousContext === context, "snapshots.event_context", "consistent event context", `${row.eventId} has conflicting contexts`, [row.eventId]);
        contexts.set(row.eventId, context);
        let eventRows = byEvent.get(row.eventId);
        if (!eventRows) {
            eventRows = new Map<string, PoolSnapshotRecord>();
            byEvent.set(row.eventId, eventRows);
        }
        eventRows.set(row.asset, row);
    }
    for (const [eventId, rows] of byEvent) {
        const missing = catalogAssets.filter((asset) => !rows.has(asset));
        requireCheck(rows.size === catalogAssets.length && missing.length === 0, "snapshots.catalog_coverage", `${catalogAssets.length} catalog rows for every event`, `${eventId} has ${rows.size}`, missing.map((asset) => `${eventId}/${asset}`));
    }
    return byEvent;
}

function outcomeKey(eventId: string, horizonBars: number, direction: string, asset: string): string {
    return `${eventId}|${horizonBars}|${direction}|${asset}`;
}

export function makeTopMeanOutcomeKey(eventId: string, horizonBars: number, direction: string, asset: string): string {
    return outcomeKey(eventId, horizonBars, direction, asset);
}

function validateOutcomeRows(
    outcomes: readonly CandidateOutcomeRecord[],
    catalogAssets: readonly string[],
    eventsById: ReadonlyMap<string, ReadonlyMap<string, PoolSnapshotRecord>>,
): Map<string, CandidateOutcomeRecord> {
    const catalog = new Set(catalogAssets);
    const map = new Map<string, CandidateOutcomeRecord>();
    for (const row of outcomes) {
        requireCheck(isRecord(row), "outcomes.row", "object", typeof row);
        requireCheck(typeof row.eventId === "string" && eventsById.has(row.eventId), "outcomes.eventId", "known eventId", String(row.eventId));
        requireCheck(integer(row.decisionTimeSec), "outcomes.decisionTimeSec", "integer Unix seconds", String(row.decisionTimeSec));
        requireCheck(row.decisionTimeSec === eventsById.get(row.eventId)!.values().next().value!.decisionTimeSec, "outcomes.event_context", "decision time matches snapshot event", `${row.eventId}/${row.asset}`);
        requireCheck(row.horizonBars === TOP_MEAN_RULE_HORIZON, "outcomes.horizon", String(TOP_MEAN_RULE_HORIZON), String(row.horizonBars));
        requireCheck(row.direction === "long" || row.direction === "short", "outcomes.direction", "long|short", String(row.direction));
        requireCheck(typeof row.asset === "string" && catalog.has(row.asset), "outcomes.asset", "catalog asset", String(row.asset));
        requireCheck(typeof row.inPool === "boolean", "outcomes.inPool", "boolean", String(row.inPool));
        requireCheck(typeof row.eligible === "boolean", "outcomes.eligible", "boolean", String(row.eligible));
        requireCheck(row.return === null || finite(row.return), "outcomes.return", "finite number or null", String(row.return));
        requireCheck(row.entryTimeSec === null || integer(row.entryTimeSec), "outcomes.entryTimeSec", "integer or null", String(row.entryTimeSec));
        requireCheck(row.exitTimeSec === null || integer(row.exitTimeSec), "outcomes.exitTimeSec", "integer or null", String(row.exitTimeSec));
        requireCheck((OUTCOME_STATUSES as readonly string[]).includes(row.status), "outcomes.status", OUTCOME_STATUSES.join("|"), String(row.status));
        if (row.eligible === true && row.status === "ok" && finite(row.return)) {
            requireCheck(integer(row.entryTimeSec) && integer(row.exitTimeSec), "outcomes.ok_times", "eligible ok outcomes have entry and exit times", `${row.eventId}/${row.asset}`);
        }
        const key = outcomeKey(row.eventId, row.horizonBars, row.direction, row.asset);
        requireCheck(!map.has(key), "outcomes.unique_identity", "one row per eventId|horizon|direction|asset", key);
        map.set(key, row);
    }
    return map;
}

function compareCandidateTie(left: TopMeanBaseCandidate, right: TopMeanBaseCandidate, decisionTimeSec: number): number {
    return codeUnitCompare(tieBreakDigest(decisionTimeSec, left.row.asset), tieBreakDigest(decisionTimeSec, right.row.asset))
        || codeUnitCompare(left.row.asset, right.row.asset);
}

function compareBaseCandidates(left: TopMeanBaseCandidate, right: TopMeanBaseCandidate, decisionTimeSec: number): number {
    return numberCompare(right.score, left.score) || compareCandidateTie(left, right, decisionTimeSec);
}

function buildNormalizedEvents(
    byEvent: ReadonlyMap<string, ReadonlyMap<string, PoolSnapshotRecord>>,
    featuresByKey: ReadonlyMap<string, TopMeanCandidateFeatureRow> = new Map(),
    priceFeaturesByKey: ReadonlyMap<string, TopMeanPriceFeatureRow> = new Map(),
): TopMeanNormalizedEvent[] {
    const events: TopMeanNormalizedEvent[] = [];
    for (const [eventId, snapshotMap] of byEvent) {
        const first = snapshotMap.values().next().value as PoolSnapshotRecord | undefined;
        if (!first) continue;
        const rows = [...snapshotMap.values()];
        const baseCandidates = rows
            .map((row): TopMeanBaseCandidate | null => {
                const score = row.activePairCount > 0 ? row.signedVotes / row.activePairCount : null;
                return finite(score) && score > 0 && row.longEligible === true
                    ? {
                        row,
                        score,
                        features: featuresByKey.get(featureKey(row.eventId, row.asset)) ?? null,
                        priceFeatures: priceFeaturesByKey.get(featureKey(row.eventId, row.asset)) ?? null,
                    }
                    : null;
            })
            .filter((candidate): candidate is TopMeanBaseCandidate => candidate !== null)
            .sort((left, right) => codeUnitCompare(left.row.asset, right.row.asset));
        const date = new Date(first.decisionTimeSec * 1000);
        events.push({
            eventId,
            decisionTimeSec: first.decisionTimeSec,
            snapshots: snapshotMap,
            baseCandidates,
            ruleEvent: {
                decisionTimeSec: first.decisionTimeSec,
                breadth: first.breadth,
                regime: first.regime,
                poolSize: rows.filter((row) => row.inPool).length,
                dow: date.getUTCDay(),
                hour: date.getUTCHours(),
            },
        });
    }
    return events.sort((left, right) => numberCompare(left.decisionTimeSec, right.decisionTimeSec) || codeUnitCompare(left.eventId, right.eventId));
}

export function normalizeTopMeanArchive(args: {
    archive: PoolRuleArchive;
    reportText: string;
    runId?: string;
    features?: readonly TopMeanCandidateFeatureRow[];
    priceFeatures?: readonly TopMeanPriceFeatureRow[];
    priceManifest?: TopMeanPriceManifest;
    admittedPriceFields?: readonly TopMeanPriceFeatureField[];
}): TopMeanNormalizedArchive {
    const meta = metaRecord(args.archive.meta);
    const runId = args.runId ?? meta.runId;
    requireCheck(meta.runId === runId, "meta.runId_matches_directory", runId, String(meta.runId));
    validateResearchContract(meta);
    const catalogAssets = archiveCatalog(meta);
    requireCheck(args.reportText.trim().length > 0, "report.present", "non-empty report.txt", "empty report");
    validateIncompleteHeader(runId, args.reportText);
    const byEvent = validateSnapshotRows(args.archive.snapshots, catalogAssets);
    const outcomeByKey = validateOutcomeRows(args.archive.outcomes, catalogAssets, byEvent);
    const featuresByKey = args.features === undefined
        ? new Map<string, TopMeanCandidateFeatureRow>()
        : validateFeatureRows(args.features, args.archive.snapshots);
    const priceFeaturesByKey = args.priceFeatures === undefined
        ? new Map<string, TopMeanPriceFeatureRow>()
        : validatePriceFeatureRows(args.priceFeatures, args.archive.snapshots);
    requireCheck(meta.schema === "top_mean_archive.v2" ? featuresByKey.size === 0 : args.features !== undefined, "feature-set.normalize", "v3 archives receive joined feature rows", meta.schema);
    return {
        runId,
        meta,
        reportText: args.reportText,
        catalogAssets,
        events: buildNormalizedEvents(byEvent, featuresByKey, priceFeaturesByKey),
        outcomeByKey,
        eventRows: args.archive.eventRows,
        featuresByKey,
        ...(args.priceFeatures !== undefined ? { priceFeaturesByKey } : {}),
        ...(args.priceManifest ? { priceManifest: args.priceManifest } : {}),
        ...(args.admittedPriceFields ? { admittedPriceFields: args.admittedPriceFields } : {}),
    };
}

function safeArchiveRead(filename: string): string {
    try {
        return readFileSync(filename, "utf8");
    } catch {
        throw new CheckerFailure("archive.read", "required archive files readable", path.basename(filename), [], "ARCHIVE FAIL");
    }
}

function safeJsonRead(filename: string): unknown {
    let text: string;
    try {
        text = readFileSync(filename, "utf8");
    } catch {
        throw new CheckerFailure("archive.read", "required causal archive files readable", path.basename(filename), [], "ARCHIVE FAIL");
    }
    try {
        return JSON.parse(text) as unknown;
    } catch {
        throw new CheckerFailure("meta.json", "valid JSON", path.basename(filename), [], "ARCHIVE FAIL");
    }
}

function safeSnapshotRead(filename: string): PoolSnapshotRecord[] {
    let text: string;
    try {
        text = readFileSync(filename, "utf8");
    } catch {
        throw new CheckerFailure("archive.read", "required causal archive files readable", path.basename(filename), [], "ARCHIVE FAIL");
    }
    return text
        .split(/\r?\n/)
        .filter((line) => line.trim().length > 0)
        .map((line, index) => {
            try {
                return JSON.parse(line) as PoolSnapshotRecord;
            } catch {
                throw new CheckerFailure("pool-snapshots.jsonl", "valid JSONL rows", `${path.basename(filename)}:${index + 1}`, [], "ARCHIVE FAIL");
            }
        });
}

function featureKey(eventId: string, asset: string): string {
    return `${eventId}|${asset}`;
}

function safeFeatureRead(filename: string): TopMeanCandidateFeatureRow[] {
    let text: string;
    try {
        text = readFileSync(filename, "utf8");
    } catch {
        throw new CheckerFailure("feature-set.file", "readable candidate-features.jsonl", path.basename(filename), [], "ARCHIVE FAIL");
    }
    return text
        .split(/\r?\n/)
        .filter((line) => line.trim().length > 0)
        .map((line, index) => {
            try {
                return JSON.parse(line) as TopMeanCandidateFeatureRow;
            } catch {
                throw new CheckerFailure("feature-set.jsonl", "valid JSONL rows", `${path.basename(filename)}:${index + 1}`, [], "ARCHIVE FAIL");
            }
        });
}

function validateFeatureRows(
    rows: readonly TopMeanCandidateFeatureRow[],
    snapshots: readonly PoolSnapshotRecord[],
): Map<string, TopMeanCandidateFeatureRow> {
    const snapshotKeys = new Set(snapshots.map((row) => featureKey(row.eventId, row.asset)));
    const snapshotsByKey = new Map(snapshots.map((row) => [featureKey(row.eventId, row.asset), row] as const));
    const map = new Map<string, TopMeanCandidateFeatureRow>();
    for (const row of rows) {
        requireCheck(isRecord(row), "feature-set.row", "object", typeof row);
        requireCheck(typeof row.eventId === "string" && row.eventId.length > 0, "feature-set.identity", "non-empty eventId", String(row.eventId));
        requireCheck(integer(row.decisionTimeSec), "feature-set.decisionTimeSec", "integer Unix seconds", String(row.decisionTimeSec));
        requireCheck(typeof row.asset === "string", "feature-set.asset", "string", String(row.asset));
        const key = featureKey(row.eventId, row.asset);
        requireCheck(snapshotKeys.has(key), "feature-set.snapshot_identity", "matching snapshot identity", key);
        requireCheck(!map.has(key), "feature-set.unique_identity", "one row per eventId|asset", key);
        const snapshot = snapshotsByKey.get(key)!;
        requireCheck(snapshot.decisionTimeSec === row.decisionTimeSec, "feature-set.event_context", "matching snapshot decision time", key);
        for (const field of TOP_MEAN_CAUSAL_FEATURE_FIELDS) {
            const value = row[field];
            requireCheck(value === null || finite(value), `feature-set.${field}`, "finite number or null", String(value), [key]);
        }
        map.set(key, row);
    }
    const missing = [...snapshotKeys].filter((key) => !map.has(key));
    requireCheck(rows.length === snapshots.length && missing.length === 0, "feature-set.row_count_identity", `${snapshots.length} one-to-one rows`, `${rows.length} rows`, missing.slice(0, 10));
    return map;
}

const PRICE_ROW_FIELDS = ["eventId", "decisionTimeSec", "asset", ...TOP_MEAN_PRICE_FEATURE_FIELDS] as const;

function validatePriceFeatureRows(
    rows: readonly TopMeanPriceFeatureRow[],
    snapshots: readonly PoolSnapshotRecord[],
): Map<string, TopMeanPriceFeatureRow> {
    const snapshotKeys = new Set(snapshots.map((row) => featureKey(row.eventId, row.asset)));
    const snapshotsByKey = new Map(snapshots.map((row) => [featureKey(row.eventId, row.asset), row] as const));
    const map = new Map<string, TopMeanPriceFeatureRow>();
    let previousOrder: TopMeanPriceFeatureRow | undefined;
    for (const row of rows) {
        requireCheck(isRecord(row), "price-feature.row", "object", typeof row);
        requireCheck(JSON.stringify(Object.keys(row).sort(codeUnitCompare)) === JSON.stringify([...PRICE_ROW_FIELDS].sort(codeUnitCompare)), "price-feature.fields", JSON.stringify(PRICE_ROW_FIELDS), JSON.stringify(Object.keys(row).sort(codeUnitCompare)));
        requireCheck(typeof row.eventId === "string" && row.eventId.length > 0, "price-feature.identity", "non-empty eventId", String(row.eventId));
        requireCheck(integer(row.decisionTimeSec), "price-feature.decisionTimeSec", "integer Unix seconds", String(row.decisionTimeSec));
        requireCheck(typeof row.asset === "string", "price-feature.asset", "string", String(row.asset));
        const key = featureKey(row.eventId, row.asset);
        requireCheck(snapshotKeys.has(key), "price-feature.snapshot_identity", "matching snapshot identity", key);
        requireCheck(!map.has(key), "price-feature.unique_identity", "one row per eventId|asset", key);
        const snapshot = snapshotsByKey.get(key)!;
        requireCheck(snapshot.decisionTimeSec === row.decisionTimeSec, "price-feature.event_context", "matching snapshot decision time", key);
        for (const field of TOP_MEAN_PRICE_FEATURE_FIELDS) {
            const value = row[field];
            requireCheck(value === null || finite(value), `price-feature.${field}`, "finite number or null", String(value), [key]);
        }
        if (previousOrder) {
            const ordered = previousOrder.decisionTimeSec < row.decisionTimeSec
                || (previousOrder.decisionTimeSec === row.decisionTimeSec && (codeUnitCompare(previousOrder.eventId, row.eventId) < 0
                    || (previousOrder.eventId === row.eventId && codeUnitCompare(previousOrder.asset, row.asset) <= 0)));
            requireCheck(ordered, "price-feature.order", "decisionTimeSec,eventId,asset ascending", `${previousOrder.eventId}/${previousOrder.asset} before ${row.eventId}/${row.asset}`);
        }
        map.set(key, row);
        previousOrder = row;
    }
    const missing = [...snapshotKeys].filter((key) => !map.has(key));
    requireCheck(rows.length === snapshots.length && missing.length === 0, "price-feature.row_count_identity", `${snapshots.length} one-to-one rows`, `${rows.length} rows`, missing.slice(0, 10));
    return map;
}

function safePriceFeatureRead(filename: string): TopMeanPriceFeatureRow[] {
    let text: string;
    try {
        text = readFileSync(filename, "utf8");
    } catch {
        throw new CheckerFailure("price-feature.file", "readable candidate-price-features.jsonl", path.basename(filename), [], "ARCHIVE FAIL");
    }
    return text
        .split(/\r?\n/)
        .filter((line) => line.trim().length > 0)
        .map((line, index) => {
            try {
                return JSON.parse(line) as TopMeanPriceFeatureRow;
            } catch {
                throw new CheckerFailure("price-feature.jsonl", "valid JSONL rows", `${path.basename(filename)}:${index + 1}`, [], "ARCHIVE FAIL");
            }
        });
}

function safePriceAuditRead(filename: string): unknown[] {
    let text: string;
    try {
        text = readFileSync(filename, "utf8");
    } catch {
        throw new CheckerFailure("price-feature.audit", "readable price-feature-audit.jsonl", path.basename(filename), [], "ARCHIVE FAIL");
    }
    return text.split(/\r?\n/).filter((line) => line.trim().length > 0).map((line, index) => {
        try {
            return JSON.parse(line) as unknown;
        } catch {
            throw new CheckerFailure("price-feature.audit.jsonl", "valid JSONL rows", `${path.basename(filename)}:${index + 1}`, [], "ARCHIVE FAIL");
        }
    });
}

function canonicalManifestWithoutIdentity(manifest: TopMeanPriceManifest): string {
    const copy = { ...manifest } as Record<string, unknown>;
    delete copy.enrichmentId;
    return JSON.stringify(copy);
}

function validatePriceManifest(value: unknown, location: TopMeanArchiveLocation, enrichmentDir: string, meta: TopMeanRuleMeta, snapshots: readonly PoolSnapshotRecord[]): TopMeanPriceManifest {
    requireCheck(isRecord(value), "price-manifest.object", "object", typeof value, [], "ARCHIVE FAIL");
    const manifest = value as unknown as TopMeanPriceManifest;
    requireCheck(manifest.schema === TOP_MEAN_PRICE_FEATURES_SCHEMA, "price-manifest.schema", TOP_MEAN_PRICE_FEATURES_SCHEMA, String(manifest.schema));
    requireCheck(manifest.contractVersion === TOP_MEAN_PRICE_FEATURE_CONTRACT_VERSION, "price-manifest.contract", TOP_MEAN_PRICE_FEATURE_CONTRACT_VERSION, String(manifest.contractVersion));
    requireCheck(manifest.formulaVersion === TOP_MEAN_PRICE_FEATURE_FORMULA_VERSION, "price-manifest.formula", TOP_MEAN_PRICE_FEATURE_FORMULA_VERSION, String(manifest.formulaVersion));
    requireCheck(manifest.availabilityPolicy === TOP_MEAN_PRICE_FEATURE_AVAILABILITY_POLICY, "price-manifest.availability", TOP_MEAN_PRICE_FEATURE_AVAILABILITY_POLICY, String(manifest.availabilityPolicy));
    requireCheck(manifest.sessionScheduleVersion === TOP_MEAN_PRICE_SESSION_SCHEDULE_VERSION, "price-manifest.schedule", TOP_MEAN_PRICE_SESSION_SCHEDULE_VERSION, String(manifest.sessionScheduleVersion));
    requireCheck(JSON.stringify(manifest.fields) === JSON.stringify(TOP_MEAN_PRICE_FEATURE_FIELDS), "price-manifest.fields", JSON.stringify(TOP_MEAN_PRICE_FEATURE_FIELDS), JSON.stringify(manifest.fields));
    requireCheck(typeof manifest.enrichmentId === "string" && /^[0-9a-f]{64}$/i.test(manifest.enrichmentId), "price-manifest.enrichmentId", "SHA-256", String(manifest.enrichmentId));
    const computedIdentity = createHash("sha256").update(canonicalManifestWithoutIdentity(manifest), "utf8").digest("hex");
    requireCheck(manifest.enrichmentId === computedIdentity, "price-manifest.identity", String(manifest.enrichmentId), computedIdentity);
    requireCheck(manifest.parentRunId === location.runId, "price-manifest.parentRunId", location.runId, String(manifest.parentRunId));
    requireCheck(manifest.parentMetaSha256 === sha256File(path.join(location.runDir, "meta.json")), "price-manifest.parentMeta", String(manifest.parentMetaSha256), sha256File(path.join(location.runDir, "meta.json")));
    requireCheck(manifest.parentPoolSnapshotsSha256 === sha256File(path.join(location.runDir, "pool-snapshots.jsonl")), "price-manifest.parentPoolSnapshots", String(manifest.parentPoolSnapshotsSha256), sha256File(path.join(location.runDir, "pool-snapshots.jsonl")));
    const expectedTemporal = isRecord(meta.featureSet) && typeof meta.featureSet.sha256 === "string" ? meta.featureSet.sha256 : null;
    requireCheck(manifest.parentTemporalFeatureSha256 === expectedTemporal, "price-manifest.parentTemporalFeature", String(expectedTemporal), String(manifest.parentTemporalFeatureSha256));
    const expectedPostAssembly = typeof meta.postAssemblyFingerprint === "string" ? meta.postAssemblyFingerprint : null;
    requireCheck(manifest.parentPostAssemblyFingerprint === expectedPostAssembly, "price-manifest.parentPostAssembly", String(expectedPostAssembly), String(manifest.parentPostAssemblyFingerprint));
    const assets = archiveCatalog(meta);
    requireCheck(isRecord(manifest.catalog), "price-manifest.catalog", "catalog object", typeof manifest.catalog);
    requireCheck(JSON.stringify(manifest.catalog.assets) === JSON.stringify(assets), "price-manifest.catalog.assets", JSON.stringify(assets), JSON.stringify(manifest.catalog.assets));
    requireCheck(manifest.catalog.sha256 === createHash("sha256").update(JSON.stringify(assets), "utf8").digest("hex"), "price-manifest.catalog.sha256", "catalog SHA-256", String(manifest.catalog.sha256));
    requireCheck(isRecord(manifest.sourceCsvSha256), "price-manifest.sourceCsvSha256", "source hash map", typeof manifest.sourceCsvSha256);
    const sourceNames = Object.keys(manifest.sourceCsvSha256).sort(codeUnitCompare);
    requireCheck(JSON.stringify(sourceNames) === JSON.stringify(assets), "price-manifest.sourceCsvSha256.keys", JSON.stringify(assets), JSON.stringify(sourceNames));
    for (const asset of assets) requireCheck(typeof manifest.sourceCsvSha256[asset] === "string" && /^[0-9a-f]{64}$/i.test(manifest.sourceCsvSha256[asset]!), `price-manifest.sourceCsvSha256.${asset}`, "SHA-256", String(manifest.sourceCsvSha256[asset]));
    for (const [name, label] of [["sessionScheduleSha256", "sessionScheduleSha256"], ["builderSourceSha256", "builderSourceSha256"]] as const) requireCheck(typeof manifest[name] === "string" && /^[0-9a-f]{64}$/i.test(manifest[name]), `price-manifest.${label}`, "SHA-256", String(manifest[name]));
    requireCheck(integer(manifest.rowCount) && manifest.rowCount === snapshots.length, "price-manifest.rowCount", String(snapshots.length), String(manifest.rowCount));
    requireCheck(manifest.sidecarFile === "candidate-price-features.jsonl", "price-manifest.sidecarFile", "candidate-price-features.jsonl", String(manifest.sidecarFile));
    requireCheck(manifest.auditFile === "price-feature-audit.jsonl", "price-manifest.auditFile", "price-feature-audit.jsonl", String(manifest.auditFile));
    requireCheck(typeof manifest.sidecarSha256 === "string" && /^[0-9a-f]{64}$/i.test(manifest.sidecarSha256), "price-manifest.sidecarSha256", "SHA-256", String(manifest.sidecarSha256));
    requireCheck(typeof manifest.auditSha256 === "string" && /^[0-9a-f]{64}$/i.test(manifest.auditSha256), "price-manifest.auditSha256", "SHA-256", String(manifest.auditSha256));
    const sidecarPath = path.join(enrichmentDir, manifest.sidecarFile);
    const auditPath = path.join(enrichmentDir, manifest.auditFile);
    requireCheck(existsSync(sidecarPath), "price-manifest.sidecarFile.exists", "sidecar file exists", manifest.sidecarFile, [], "ARCHIVE FAIL");
    requireCheck(existsSync(auditPath), "price-manifest.auditFile.exists", "audit file exists", manifest.auditFile, [], "ARCHIVE FAIL");
    requireCheck(sha256File(sidecarPath) === manifest.sidecarSha256, "price-manifest.sidecarSha256.actual", manifest.sidecarSha256, sha256File(sidecarPath));
    requireCheck(sha256File(auditPath) === manifest.auditSha256, "price-manifest.auditSha256.actual", manifest.auditSha256, sha256File(auditPath));
    return manifest;
}

function loadPriceFeaturesForArchive(
    location: TopMeanArchiveLocation,
    enrichmentDir: string,
    meta: TopMeanRuleMeta,
    snapshots: readonly PoolSnapshotRecord[],
): { rows: Map<string, TopMeanPriceFeatureRow>; manifest: TopMeanPriceManifest } {
    const resolved = path.resolve(enrichmentDir);
    requireCheck(resolved !== location.runDir && !resolved.startsWith(`${location.runDir}${path.sep}`), "price-feature.layout", "enrichment outside parent ledger", resolved, [], "ARCHIVE FAIL");
    const manifestPath = path.join(resolved, "price-feature-manifest.json");
    const manifest = validatePriceManifest(safeJsonRead(manifestPath), location, resolved, meta, snapshots);
    const rows = validatePriceFeatureRows(safePriceFeatureRead(path.join(resolved, manifest.sidecarFile)), snapshots);
    const audit = safePriceAuditRead(path.join(resolved, manifest.auditFile));
    requireCheck(audit.length === rows.size, "price-feature.audit.row_count", String(rows.size), String(audit.length));
    const auditKeys = new Set<string>();
    for (const row of audit) {
        requireCheck(isRecord(row), "price-feature.audit.row", "object", typeof row);
        requireCheck(typeof row.eventId === "string" && typeof row.asset === "string" && integer(row.decisionTimeSec), "price-feature.audit.identity", "eventId, asset, integer decisionTimeSec", JSON.stringify(row));
        const key = featureKey(row.eventId, row.asset);
        requireCheck(!auditKeys.has(key), "price-feature.audit.unique_identity", "one row per eventId|asset", key);
        auditKeys.add(key);
        const feature = rows.get(key);
        requireCheck(feature !== undefined && feature.decisionTimeSec === row.decisionTimeSec, "price-feature.audit.event_context", "matching sidecar row", key);
        requireCheck(isRecord(row.availability) && isRecord(row.maxSourceBarEndSec), "price-feature.audit.shape", "availability and maxSourceBarEndSec objects", key);
        requireCheck(JSON.stringify(Object.keys(row.availability).sort(codeUnitCompare)) === JSON.stringify([...TOP_MEAN_PRICE_FEATURE_FIELDS].sort(codeUnitCompare)), "price-feature.audit.availability.fields", JSON.stringify(TOP_MEAN_PRICE_FEATURE_FIELDS), JSON.stringify(Object.keys(row.availability).sort(codeUnitCompare)), [key]);
        requireCheck(JSON.stringify(Object.keys(row.maxSourceBarEndSec).sort(codeUnitCompare)) === JSON.stringify([...TOP_MEAN_PRICE_FEATURE_FIELDS].sort(codeUnitCompare)), "price-feature.audit.maxSourceBarEndSec.fields", JSON.stringify(TOP_MEAN_PRICE_FEATURE_FIELDS), JSON.stringify(Object.keys(row.maxSourceBarEndSec).sort(codeUnitCompare)), [key]);
        for (const field of TOP_MEAN_PRICE_FEATURE_FIELDS) {
            requireCheck(typeof row.availability[field] === "string", `price-feature.audit.${field}.reason`, "string reason", String(row.availability[field]), [key]);
            const max = row.maxSourceBarEndSec[field];
            requireCheck(max === null || integer(max), `price-feature.audit.${field}.maxSourceBarEndSec`, "integer or null", String(max), [key]);
        }
    }
    requireCheck(auditKeys.size === rows.size, "price-feature.audit.coverage", String(rows.size), String(auditKeys.size));
    return { rows, manifest };
}

function loadFeatureRowsForArchive(
    location: TopMeanArchiveLocation,
    meta: TopMeanRuleMeta,
    snapshots: readonly PoolSnapshotRecord[],
    options: { verifyOutcomeSource: boolean } = { verifyOutcomeSource: true },
): Map<string, TopMeanCandidateFeatureRow> {
    const declared = meta.featureSet !== undefined;
    if (!declared) {
        requireCheck(meta.schema === "top_mean_archive.v2", "feature-set.declaration", "no featureSet on v2 archive", `schema=${meta.schema}`, [], "ARCHIVE FAIL");
        return new Map();
    }
    requireCheck(meta.schema === "top_mean_archive.v3", "feature-set.schema", "top_mean_archive.v3", String(meta.schema));
    requireCheck(isRecord(meta.featureSet), "feature-set.meta", "featureSet object", typeof meta.featureSet);
    const featureSet = meta.featureSet;
    requireCheck(featureSet.schema === TOP_MEAN_CANDIDATE_FEATURES_SCHEMA, "feature-set.version.schema", TOP_MEAN_CANDIDATE_FEATURES_SCHEMA, String(featureSet.schema));
    requireCheck(featureSet.contractVersion === TOP_MEAN_FEATURE_CONTRACT_VERSION, "feature-set.version.contract", TOP_MEAN_FEATURE_CONTRACT_VERSION, String(featureSet.contractVersion));
    requireCheck(featureSet.formulaVersion === TOP_MEAN_FEATURE_FORMULA_VERSION, "feature-set.version.formula", TOP_MEAN_FEATURE_FORMULA_VERSION, String(featureSet.formulaVersion));
    requireCheck(featureSet.availabilityPolicy === TOP_MEAN_FEATURE_AVAILABILITY_POLICY, "feature-set.version.availability", TOP_MEAN_FEATURE_AVAILABILITY_POLICY, String(featureSet.availabilityPolicy));
    requireCheck(featureSet.file === "candidate-features.jsonl", "feature-set.file", "candidate-features.jsonl", String(featureSet.file));
    requireCheck(integer(featureSet.rowCount) && featureSet.rowCount >= 0, "feature-set.rowCount", "non-negative integer", String(featureSet.rowCount));
    requireCheck(typeof featureSet.sha256 === "string" && /^[0-9a-f]{64}$/i.test(featureSet.sha256), "feature-set.sha256", "SHA-256", String(featureSet.sha256));
    requireCheck(typeof featureSet.builderSourceSha256 === "string" && /^[0-9a-f]{64}$/i.test(featureSet.builderSourceSha256), "feature-set.builderSourceSha256", "SHA-256", String(featureSet.builderSourceSha256));
    requireCheck(Array.isArray(featureSet.fields) && featureSet.fields.length === TOP_MEAN_CAUSAL_FEATURE_FIELDS.length && featureSet.fields.every((field: unknown, index: number) => field === TOP_MEAN_CAUSAL_FEATURE_FIELDS[index]), "feature-set.fields", JSON.stringify(TOP_MEAN_CAUSAL_FEATURE_FIELDS), JSON.stringify(featureSet.fields));
    requireCheck(isRecord(featureSet.sources), "feature-set.sources", "sources object", typeof featureSet.sources);
    for (const field of ["poolSnapshotsSha256", "candidateOutcomesSha256"] as const) {
        requireCheck(typeof featureSet.sources[field] === "string" && /^[0-9a-f]{64}$/i.test(featureSet.sources[field]), `feature-set.sources.${field}`, "SHA-256", String(featureSet.sources[field]));
    }
    validateV3FileManifest(location, meta, options.verifyOutcomeSource);
    const featurePath = path.join(location.runDir, "candidate-features.jsonl");
    const featureRows = safeFeatureRead(featurePath);
    requireCheck(sha256File(featurePath) === featureSet.sha256, "feature-set.file.sha256", String(featureSet.sha256), sha256File(featurePath));
    const poolPath = path.join(location.runDir, "pool-snapshots.jsonl");
    const outcomePath = path.join(location.runDir, "candidate-outcomes.jsonl");
    requireCheck(sha256File(poolPath) === featureSet.sources.poolSnapshotsSha256, "feature-set.source.pool-snapshots", String(featureSet.sources.poolSnapshotsSha256), sha256File(poolPath));
    if (options.verifyOutcomeSource) {
        requireCheck(sha256File(outcomePath) === featureSet.sources.candidateOutcomesSha256, "feature-set.source.candidate-outcomes", String(featureSet.sources.candidateOutcomesSha256), sha256File(outcomePath));
    }
    requireCheck(featureRows.length === featureSet.rowCount, "feature-set.rowCount.actual", String(featureSet.rowCount), String(featureRows.length));
    return validateFeatureRows(featureRows, snapshots);
}

function validateV3FileManifest(
    location: TopMeanArchiveLocation,
    meta: TopMeanRuleMeta,
    includeOutcome: boolean,
): void {
    requireCheck(typeof meta.runFingerprint === "string" && meta.runFingerprint.length > 0, "meta.runFingerprint", "non-empty string", String(meta.runFingerprint));
    requireCheck(meta.fingerprint === undefined || meta.runFingerprint === meta.fingerprint, "meta.runFingerprint_matches_fingerprint", String(meta.fingerprint), String(meta.runFingerprint));
    requireCheck(meta.fingerprintVersion === "top_mean_ledger_fingerprint.v2", "meta.fingerprintVersion", "top_mean_ledger_fingerprint.v2", String(meta.fingerprintVersion));
    requireCheck(typeof meta.postAssemblyFingerprint === "string" && /^[0-9a-f]{64}$/i.test(meta.postAssemblyFingerprint), "meta.postAssemblyFingerprint", "SHA-256", String(meta.postAssemblyFingerprint));
    requireCheck(isRecord(meta.files), "meta.files", "file hash map", typeof meta.files);
    const files = meta.files as Record<string, unknown>;

    const declaredNames = Object.keys(files).sort(codeUnitCompare);
    const actualNames = readdirSync(location.runDir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name !== "meta.json")
        .map((entry) => entry.name)
        .sort(codeUnitCompare);
    if (includeOutcome) {
        requireCheck(JSON.stringify(declaredNames) === JSON.stringify(actualNames), "meta.files.identity", "all sealed non-meta files declared exactly once", `${declaredNames.join(",")} vs ${actualNames.join(",")}`);
    }
    const namesToVerify = includeOutcome
        ? declaredNames
        : ["pool-snapshots.jsonl", "candidate-features.jsonl"];
    for (const filename of namesToVerify) {
        const expected = files[filename];
        requireCheck(typeof expected === "string" && /^[0-9a-f]{64}$/i.test(expected), `meta.files.${filename}`, "SHA-256", String(expected));
        const filePath = path.join(location.runDir, filename);
        requireCheck(existsSync(filePath), `meta.files.${filename}.exists`, "declared file exists", filename);
        requireCheck(sha256File(filePath) === expected, `meta.files.${filename}.sha256`, String(expected), sha256File(filePath));
    }
    if (includeOutcome) {
        const assembled = sha256LineList(declaredNames.map((filename) => `${filename}=${files[filename]}`));
        requireCheck(assembled === meta.postAssemblyFingerprint, "meta.postAssemblyFingerprint.value", String(meta.postAssemblyFingerprint), assembled);
    }
}

export function resolveTopMeanArchiveLocation(ledgerDir: string): TopMeanArchiveLocation {
    const runDir = path.resolve(ledgerDir);
    const batchDir = path.dirname(runDir);
    const archiveDir = path.dirname(batchDir);
    requireCheck(path.basename(batchDir) === "batch-open-score" && path.basename(archiveDir) === "archive", "ledgerDir.layout", "<root>/archive/batch-open-score/<runId>", runDir, [], "ARCHIVE FAIL");
    const runId = path.basename(runDir);
    requireCheck(runId.length > 0 && runId !== "." && runId !== "..", "ledgerDir.runId", "non-empty run id", runId, [], "ARCHIVE FAIL");
    const root = path.dirname(archiveDir);
    requireCheck(path.resolve(root, "archive", "batch-open-score", runId) === runDir, "ledgerDir.round_trip", "loader round-trip", runDir, [], "ARCHIVE FAIL");
    return { root, runId, runDir };
}

export function loadNormalizedTopMeanArchiveFromDirectory(ledgerDir: string, options: TopMeanCausalArchiveLoadOptions = {}): TopMeanNormalizedArchive {
    const location = resolveTopMeanArchiveLocation(ledgerDir);
    if (!existsSync(location.runDir)) throw new CheckerFailure("archive.directory", "existing archive directory", location.runId, [], "ARCHIVE FAIL");
    let archive: PoolRuleArchive;
    try {
        archive = loadPoolRuleArchive(location.root, location.runId);
    } catch {
        throw new CheckerFailure("archive.jsonl", "valid archive JSONL and meta", location.runId, [], "ARCHIVE FAIL");
    }
    const reportText = safeArchiveRead(path.join(location.runDir, "report.txt"));
    const featuresByKey = loadFeatureRowsForArchive(location, metaRecord(archive.meta), archive.snapshots);
    const metaValue = metaRecord(archive.meta);
    const price = options.priceFeaturesDir === undefined
        ? null
        : loadPriceFeaturesForArchive(location, options.priceFeaturesDir, metaValue, archive.snapshots);
    return normalizeTopMeanArchive({
        archive,
        reportText,
        runId: location.runId,
        ...(featuresByKey.size > 0 || metaRecord(archive.meta).schema === "top_mean_archive.v3"
            ? { features: [...featuresByKey.values()] }
            : {}),
        ...(price ? { priceFeatures: [...price.rows.values()], priceManifest: price.manifest } : {}),
        ...(options.admittedPriceFields ? { admittedPriceFields: options.admittedPriceFields } : {}),
    });
}

export interface TopMeanCausalArchiveLoadOptions {
    priceFeaturesDir?: string;
    admittedPriceFields?: readonly TopMeanPriceFeatureField[];
}

interface TopMeanPriceCalibrationHeader {
    schema?: unknown;
    parentRunId?: unknown;
    enrichmentId?: unknown;
    admittedFields?: unknown;
    artifactSha256?: unknown;
}

function loadAdmittedPriceFields(filename: string, archive: TopMeanCausalArchive | TopMeanNormalizedArchive): TopMeanPriceFeatureField[] {
    let value: unknown;
    try {
        value = JSON.parse(readFileSync(path.resolve(filename), "utf8")) as unknown;
    } catch {
        throw new CheckerFailure("price-calibration.file", "readable valid JSON calibration artifact", path.basename(filename), [], "RULE FAIL");
    }
    requireCheck(isRecord(value), "price-calibration.object", "object", typeof value, [], "RULE FAIL");
    const artifact = value as TopMeanPriceCalibrationHeader;
    requireCheck(artifact.schema === "top_mean_price_calibration.v1", "price-calibration.schema", "top_mean_price_calibration.v1", String(artifact.schema), [], "RULE FAIL");
    requireCheck(artifact.parentRunId === archive.runId, "price-calibration.parentRunId", archive.runId, String(artifact.parentRunId), [], "RULE FAIL");
    requireCheck(archive.priceManifest !== undefined && artifact.enrichmentId === archive.priceManifest.enrichmentId, "price-calibration.enrichmentId", archive.priceManifest?.enrichmentId ?? "price sidecar", String(artifact.enrichmentId), [], "RULE FAIL");
    requireCheck(typeof artifact.artifactSha256 === "string" && /^[0-9a-f]{64}$/i.test(artifact.artifactSha256), "price-calibration.artifactSha256", "SHA-256", String(artifact.artifactSha256), [], "RULE FAIL");
    const copy = { ...artifact } as Record<string, unknown>;
    delete copy.artifactSha256;
    const expectedHash = createHash("sha256").update(JSON.stringify(copy), "utf8").digest("hex");
    requireCheck(artifact.artifactSha256 === expectedHash, "price-calibration.identity", String(artifact.artifactSha256), expectedHash, [], "RULE FAIL");
    requireCheck(Array.isArray(artifact.admittedFields), "price-calibration.admittedFields", "array", typeof artifact.admittedFields, [], "RULE FAIL");
    const admitted = artifact.admittedFields.map((field) => {
        requireCheck(typeof field === "string" && (TOP_MEAN_PRICE_FEATURE_FIELDS as readonly string[]).includes(field), "price-calibration.field", "registered price field", String(field), [], "RULE FAIL");
        return field as TopMeanPriceFeatureField;
    });
    requireCheck(new Set(admitted).size === admitted.length, "price-calibration.admittedFields.unique", "unique fields", JSON.stringify(admitted), [], "RULE FAIL");
    requireCheck(admitted.every((field) => archive.priceManifest?.fields.includes(field)), "price-calibration.admittedFields.sidecar", "sidecar fields", JSON.stringify(admitted), [], "RULE FAIL");
    return admitted;
}

export function loadCausalTopMeanArchiveFromDirectory(ledgerDir: string, options: TopMeanCausalArchiveLoadOptions = {}): TopMeanCausalArchive {
    const location = resolveTopMeanArchiveLocation(ledgerDir);
    if (!existsSync(location.runDir)) throw new CheckerFailure("archive.directory", "existing archive directory", location.runId, [], "ARCHIVE FAIL");
    const meta = metaRecord(safeJsonRead(path.join(location.runDir, "meta.json")));
    requireCheck(meta.runId === location.runId, "meta.runId_matches_directory", location.runId, String(meta.runId));
    validateResearchContract(meta);
    const catalogAssets = archiveCatalog(meta);
    const snapshots = safeSnapshotRead(path.join(location.runDir, "pool-snapshots.jsonl"));
    const byEvent = validateSnapshotRows(snapshots, catalogAssets);
    const featuresByKey = loadFeatureRowsForArchive(location, meta, snapshots, { verifyOutcomeSource: false });
    const price = options.priceFeaturesDir === undefined
        ? null
        : loadPriceFeaturesForArchive(location, options.priceFeaturesDir, meta, snapshots);
    return {
        runId: location.runId,
        meta,
        catalogAssets,
        events: buildNormalizedEvents(byEvent, featuresByKey, price?.rows),
        featuresByKey,
        ...(price ? { priceFeaturesByKey: price.rows, priceManifest: price.manifest } : {}),
        ...(options.admittedPriceFields ? { admittedPriceFields: options.admittedPriceFields } : {}),
    };
}

function windowSpec(name: TopMeanRuleWindow): TopMeanRuleWindowSpec {
    return name === "discovery"
        ? { name, fromSec: PAIRLIST_POOL_RULE_DISCOVERY_FROM_SEC, toSec: PAIRLIST_POOL_RULE_DISCOVERY_TO_SEC }
        : { name, fromSec: PAIRLIST_POOL_RULE_VALIDATION_FROM_SEC, toSec: PAIRLIST_POOL_RULE_VALIDATION_TO_SEC };
}

export function getTopMeanRuleWindow(name: TopMeanRuleWindow): TopMeanRuleWindowSpec {
    return windowSpec(name);
}

function eventsInWindow(archive: { events: readonly TopMeanNormalizedEvent[] }, window: TopMeanRuleWindowSpec): TopMeanNormalizedEvent[] {
    return archive.events.filter((event) => event.decisionTimeSec >= window.fromSec && event.decisionTimeSec <= window.toSec);
}

function topMeanCandidate(event: TopMeanNormalizedEvent): TopMeanBaseCandidate {
    const candidate = [...event.baseCandidates].sort((left, right) => compareBaseCandidates(left, right, event.decisionTimeSec))[0];
    if (!candidate) throw new CheckerFailure("candidate.selection", "at least one base candidate", event.eventId, [], "ARCHIVE FAIL");
    return candidate;
}

function topRawCandidate(event: TopMeanNormalizedEvent): TopMeanBaseCandidate {
    const candidate = [...event.baseCandidates].sort((left, right) => numberCompare(right.row.signedVotes, left.row.signedVotes) || compareCandidateTie(left, right, event.decisionTimeSec))[0];
    if (!candidate) throw new CheckerFailure("candidate.selection", "at least one base candidate", event.eventId, [], "ARCHIVE FAIL");
    return candidate;
}

function eventFeaturesFullyObserved(event: TopMeanNormalizedEvent): boolean {
    return event.baseCandidates.length > 0 && event.baseCandidates.every((candidate) =>
        candidate.features !== null
        && TOP_MEAN_CAUSAL_FEATURE_FIELDS.every((field) => candidate.features![field] !== null));
}

function priceFieldsFullyObserved(event: TopMeanNormalizedEvent, fields: readonly TopMeanPriceFeatureField[]): boolean {
    return event.baseCandidates.length > 0 && event.baseCandidates.every((candidate) =>
        candidate.priceFeatures !== null && fields.every((field) => candidate.priceFeatures![field] !== null));
}

function validLongOutcome(archive: TopMeanNormalizedArchive, eventId: string, asset: string): CandidateOutcomeRecord | null {
    const outcome = archive.outcomeByKey.get(outcomeKey(eventId, TOP_MEAN_RULE_HORIZON, TOP_MEAN_RULE_DIRECTION, asset));
    return outcome?.eligible === true && outcome.status === "ok" && finite(outcome.return) ? outcome : null;
}

function outcomeComplete(archive: TopMeanNormalizedArchive, event: TopMeanNormalizedEvent): boolean {
    return event.baseCandidates.length >= 2 && event.baseCandidates.every((candidate) => validLongOutcome(archive, event.eventId, candidate.row.asset) !== null);
}

function metricFromPairs(points: readonly RuleEventPoint[], field: "primary" | "secondary"): RuleMetric {
    const blockPoints: PoolRuleValuePoint[] = points.map((point) => ({ eventId: point.eventId, decisionTimeSec: point.decisionTimeSec, value: point[field] }));
    const blocks = splitChronologicalBlocks(blockPoints);
    const blockMeans = blocks.map((block) => block.reduce((sum, value) => sum + value, 0) / block.length);
    const ci = bootstrapBlockMeans(blockMeans);
    return {
        n: points.length,
        mean: points.length > 0 ? points.reduce((sum, point) => sum + point[field], 0) / points.length : null,
        ciLower: ci.lower,
        ciUpper: ci.upper,
        blockMeans,
        positiveBlocks: blockMeans.filter((value) => value > 0).length,
        totalBlocks: blockMeans.length,
        status: blockMeans.length >= MAX_ACTIVE_BLOCK_COUNT ? "CONCLUSIVE" : "INCONCLUSIVE",
    };
}

function archiveMetricFromRows(rows: readonly ComparableRow[]): ArchiveMetric {
    const points: PoolRuleValuePoint[] = rows.map((row) => ({ eventId: row.eventId, decisionTimeSec: row.decisionTime, value: row.delta }));
    const blocks = splitChronologicalBlocks(points);
    const blockMeans = blocks.map((block) => block.reduce((sum, value) => sum + value, 0) / block.length);
    const ci = bootstrapBlockMeans(blockMeans);
    return {
        n: rows.length,
        topMean: rows.length > 0 ? rows.reduce((sum, row) => sum + row.selectedReturn, 0) / rows.length : null,
        controlMean: rows.length > 0 ? rows.reduce((sum, row) => sum + row.controlReturn, 0) / rows.length : null,
        deltaMean: rows.length > 0 ? rows.reduce((sum, row) => sum + row.delta, 0) / rows.length : null,
        ciLower: ci.lower,
        ciUpper: ci.upper,
        blockMeans,
        positiveBlocks: blockMeans.filter((value) => value > 0).length,
        totalBlocks: blockMeans.length,
    };
}

function parseComparableRow(row: PoolRuleEventRow, index: number): ComparableRow {
    requireCheck(isRecord(row), "events-full.row", "object", typeof row);
    const value = row as Record<string, unknown>;
    const fields = ["eventId", "decisionTime", "entryTime", "exitTime", "horizonBars", "selector", "direction", "asset", "selectedReturn", "controlReturn", "delta", "eligibleCandidates"];
    for (const field of fields) requireCheck(field in value, "events-full.identity", `field ${field}`, `row ${index}`);
    requireCheck(typeof value.eventId === "string", "events-full.eventId", "string", String(value.eventId));
    requireCheck(integer(value.decisionTime) && integer(value.entryTime) && integer(value.exitTime), "events-full.times", "integer Unix seconds", value.eventId as string);
    requireCheck(integer(value.horizonBars) && typeof value.selector === "string" && typeof value.direction === "string" && typeof value.asset === "string", "events-full.selector_identity", "valid selector identity", value.eventId as string);
    requireCheck(finite(value.selectedReturn) && finite(value.controlReturn) && finite(value.delta), "events-full.returns", "finite returns", value.eventId as string);
    requireCheck(integer(value.eligibleCandidates) && value.eligibleCandidates >= 2, "events-full.eligibleCandidates", "integer >= 2", String(value.eligibleCandidates));
    return {
        eventId: value.eventId as string,
        decisionTime: value.decisionTime as number,
        entryTime: value.entryTime as number,
        exitTime: value.exitTime as number,
        horizonBars: value.horizonBars as number,
        selector: value.selector as string,
        direction: value.direction as string,
        asset: value.asset as string,
        selectedReturn: value.selectedReturn as number,
        controlReturn: value.controlReturn as number,
        delta: value.delta as number,
        eligibleCandidates: value.eligibleCandidates as number,
    };
}

function comparableArchivedRows(archive: TopMeanNormalizedArchive): ComparableRow[] {
    return archive.eventRows
        .filter((row) => row.selector === "TOP_MEAN" && row.direction === TOP_MEAN_RULE_DIRECTION && row.horizonBars === TOP_MEAN_RULE_HORIZON)
        .map(parseComparableRow)
        .sort((left, right) => numberCompare(left.decisionTime, right.decisionTime) || codeUnitCompare(left.eventId, right.eventId));
}

function reconstructIncumbent(archive: TopMeanNormalizedArchive): ComparableRow[] {
    const rows: ComparableRow[] = [];
    for (const event of archive.events) {
        if (event.baseCandidates.length < 2) continue;
        const selected = topMeanCandidate(event);
        const outcomes = event.baseCandidates.map((candidate) => validLongOutcome(archive, event.eventId, candidate.row.asset));
        if (outcomes.some((outcome) => outcome === null)) continue;
        const selectedOutcome = validLongOutcome(archive, event.eventId, selected.row.asset)!;
        const returns = event.baseCandidates
            .filter((candidate) => candidate.row.asset !== selected.row.asset)
            .map((candidate) => validLongOutcome(archive, event.eventId, candidate.row.asset)!.return!)
            .filter(finite);
        const controlReturn = returns.reduce((sum, value) => sum + value, 0) / returns.length;
        rows.push({
            eventId: event.eventId,
            decisionTime: event.decisionTimeSec,
            entryTime: selectedOutcome.entryTimeSec!,
            exitTime: selectedOutcome.exitTimeSec!,
            horizonBars: TOP_MEAN_RULE_HORIZON,
            selector: "TOP_MEAN",
            direction: TOP_MEAN_RULE_DIRECTION,
            asset: selected.row.asset,
            selectedReturn: selectedOutcome.return!,
            controlReturn,
            delta: selectedOutcome.return! - controlReturn,
            eligibleCandidates: event.baseCandidates.length,
        });
    }
    return rows;
}

function compareExactOrTolerance(expected: ComparableRow, actual: ComparableRow, examples: string[]): void {
    for (const field of ["eventId", "decisionTime", "entryTime", "exitTime", "horizonBars", "selector", "direction", "asset", "eligibleCandidates"] as const) {
        if (expected[field] !== actual[field]) examples.push(`${expected.eventId}.${field}: expected=${String(expected[field])} actual=${String(actual[field])}`);
    }
    for (const field of ["selectedReturn", "controlReturn", "delta"] as const) {
        if (Math.abs(expected[field] - actual[field]) > 1e-12) examples.push(`${expected.eventId}.${field}: expected=${expected[field]} actual=${actual[field]}`);
    }
}

function signedPercent(value: number | null): string {
    if (value === null) return "n/a";
    const percent = value * 100;
    return `${percent >= 0 ? "+" : ""}${percent.toFixed(2)}%`;
}

function fixedNumber(value: number | null): string {
    return value === null ? "n/a" : value.toFixed(6);
}

function parseMetricLine(line: string, label: string): { n: number; top: string; rand: string; delta: string; lower: string; upper: string; positiveBlocks: number; totalBlocks: number } | null {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = line.match(new RegExp(`^${escaped}\\s+n=(\\d+)\\s+top=([+-]\\d+\\.\\d+)%\\s+rand=([+-]\\d+\\.\\d+)%\\s+delta=([+-]\\d+\\.\\d+)%\\s+CI95=(?:\\[([+-]\\d+\\.\\d+)%[,]([+-]\\d+\\.\\d+)%\\]|(n/a))\\s+\\+blocks=(\\d+)\\/(\\d+)$`));
    if (!match) return null;
    return { n: Number(match[1]), top: `${match[2]}%`, rand: `${match[3]}%`, delta: `${match[4]}%`, lower: match[7] === "n/a" ? "n/a" : `${match[5]}%`, upper: match[7] === "n/a" ? "n/a" : `${match[6]}%`, positiveBlocks: Number(match[8]), totalBlocks: Number(match[9]) };
}

function selectedAssetSummaries(rows: readonly ComparableRow[]): SelectedAssetSummary[] {
    const grouped = new Map<string, ComparableRow[]>();
    for (const row of rows) (grouped.get(row.asset) ?? (grouped.set(row.asset, []), grouped.get(row.asset)!)).push(row);
    return [...grouped.entries()]
        .map(([asset, assetRows]) => ({
            asset,
            events: assetRows.length,
            share: rows.length > 0 ? assetRows.length / rows.length : 0,
            selectedMean: assetRows.reduce((sum, row) => sum + row.selectedReturn, 0) / assetRows.length,
            secondaryDelta: assetRows.reduce((sum, row) => sum + row.delta, 0) / assetRows.length,
        }))
        .sort((left, right) => numberCompare(right.events, left.events) || codeUnitCompare(left.asset, right.asset));
}

function selectedSummaryText(rows: readonly ComparableRow[]): string {
    const summaries = selectedAssetSummaries(rows);
    if (summaries.length === 0) return "n/a";
    const visible = summaries.slice(0, 5).map((row) => `${row.asset}:n=${row.events},share=${(row.share * 100).toFixed(1)}%,delta=${signedPercent(row.secondaryDelta)}`);
    if (summaries.length > 5) visible.push(`other=${summaries.length - 5} assets`);
    return visible.join(" | ");
}

function assertMetricMatches(expected: ArchiveMetric, actualLine: string | undefined, label: string): void {
    const actual = actualLine ? parseMetricLine(actualLine, label) : null;
    requireCheck(actual !== null, `report.${label}`, "displayed metric line", actualLine ?? "missing");
    requireCheck(actual.n === expected.n, `report.${label}.n`, String(expected.n), String(actual.n));
    const expectedTokens = [signedPercent(expected.topMean), signedPercent(expected.controlMean), signedPercent(expected.deltaMean), signedPercent(expected.ciLower), signedPercent(expected.ciUpper)];
    const actualTokens = [actual.top, actual.rand, actual.delta, actual.lower, actual.upper];
    requireCheck(expectedTokens.every((token, index) => token === actualTokens[index]), `report.${label}.percentages`, expectedTokens.join(","), actualTokens.join(","));
    requireCheck(actual.positiveBlocks === expected.positiveBlocks && actual.totalBlocks === expected.totalBlocks, `report.${label}.blocks`, `${expected.positiveBlocks}/${expected.totalBlocks}`, `${actual.positiveBlocks}/${actual.totalBlocks}`);
}

export function runTopMeanSelfCheck(archive: TopMeanNormalizedArchive): SelfCheckResult {
    const expectedRows = reconstructIncumbent(archive);
    const actualRows = comparableArchivedRows(archive);
    const examples: string[] = [];
    requireCheck(expectedRows.length === actualRows.length, "full_window.event_count", String(expectedRows.length), String(actualRows.length));
    const seen = new Set<string>();
    for (let index = 0; index < Math.max(expectedRows.length, actualRows.length); index += 1) {
        const expected = expectedRows[index];
        const actual = actualRows[index];
        if (!expected || !actual) continue;
        if (seen.has(actual.eventId)) examples.push(`duplicate archived event ${actual.eventId}`);
        seen.add(actual.eventId);
        compareExactOrTolerance(expected, actual, examples);
    }
    requireCheck(examples.length === 0, "full_window.event_alignment", "one-for-one TOP_MEAN reconstruction", `${examples.length} mismatches`, examples);
    const metric = archiveMetricFromRows(expectedRows);
    const reportLines = archive.reportText.split(/\r?\n/);
    const metricLine = reportLines.find((line) => /^TOP_MEAN\s+n=/.test(line));
    assertMetricMatches(metric, metricLine, "TOP_MEAN");
    const summaryLine = reportLines.find((line) => line.startsWith("TOP_MEAN selected assets = "));
    requireCheck(summaryLine !== undefined, "report.TOP_MEAN.selected_assets", "selected-assets summary", "missing");
    requireCheck(summaryLine!.slice("TOP_MEAN selected assets = ".length) === selectedSummaryText(expectedRows), "report.TOP_MEAN.selected_assets", selectedSummaryText(expectedRows), summaryLine!.slice("TOP_MEAN selected assets = ".length));
    const summaries = selectedAssetSummaries(expectedRows);
    const dominant = summaries[0]?.asset ?? null;
    if (dominant) {
        const excluded = expectedRows.filter((row) => row.asset !== dominant);
        const excludedMetric = archiveMetricFromRows(excluded);
        const label = `MEAN_EX_${dominant}`;
        const excludedLine = reportLines.find((line) => new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s+n=`).test(line));
        assertMetricMatches(excludedMetric, excludedLine, label);
    }
    return { eventCount: expectedRows.length, dominantAsset: dominant, metric };
}

function createReadOnlyProxy<T extends object>(
    value: T,
    allowed: readonly string[],
    label: string,
    onGet?: (property: string, value: unknown) => void,
): T {
    const allow = new Set(allowed);
    const assertProperty = (property: string | symbol): void => {
        if (typeof property !== "string" || !allow.has(property)) throw new Error(`Rule accessed forbidden ${label} field "${String(property)}".`);
    };
    return new Proxy(value, {
        get(target, property, receiver) {
            assertProperty(property);
            const result = Reflect.get(target, property, receiver);
            if (typeof property === "string") onGet?.(property, result);
            return result;
        },
        has(target, property) {
            assertProperty(property);
            return Reflect.has(target, property);
        },
        ownKeys() {
            throw new Error(`Rule tried to enumerate ${label} fields; enumeration is refused.`);
        },
        getOwnPropertyDescriptor(target, property) {
            assertProperty(property);
            return Reflect.getOwnPropertyDescriptor(target, property);
        },
        set() {
            throw new Error(`Rule tried to mutate ${label}; mutation is refused.`);
        },
        defineProperty() {
            throw new Error(`Rule tried to define a ${label} property; mutation is refused.`);
        },
        deleteProperty() {
            throw new Error(`Rule tried to delete a ${label} property; mutation is refused.`);
        },
        getPrototypeOf() {
            throw new Error(`Rule accessed the ${label} prototype chain; prototype access is refused.`);
        },
        setPrototypeOf() {
            throw new Error(`Rule tried to change the ${label} prototype; mutation is refused.`);
        },
        preventExtensions() {
            throw new Error(`Rule tried to freeze the ${label}; mutation is refused.`);
        },
    });
}

function candidateProxy(candidate: TopMeanBaseCandidate, tracker: RuleAccessTracker, invocation: { nullRead: boolean }, allowedPriceFields?: readonly TopMeanPriceFeatureField[]): TopMeanRuleCandidate {
    const row = candidate.row;
    const priceFields = candidate.priceFeatures === null
        ? []
        : (allowedPriceFields ?? TOP_MEAN_PRICE_FEATURE_FIELDS);
    const fields = [
        ...TOP_MEAN_RULE_CANDIDATE_FIELDS,
        ...(candidate.features === null ? [] : TOP_MEAN_CAUSAL_FEATURE_FIELDS),
        ...priceFields,
    ];
    const causal = Object.fromEntries(fields.map((field) => {
        if ((TOP_MEAN_CAUSAL_FEATURE_FIELDS as readonly string[]).includes(field)) {
            const value = candidate.features?.[field as TopMeanCausalFeatureField] ?? null;
            return [field, value];
        }
        if ((TOP_MEAN_PRICE_FEATURE_FIELDS as readonly string[]).includes(field)) {
            const value = candidate.priceFeatures?.[field as TopMeanPriceFeatureField] ?? null;
            return [field, value];
        }
        return [field, field === "score" ? candidate.score : row[field as CandidateField]];
    })) as TopMeanRuleCandidate;
    return createReadOnlyProxy(causal, fields, "candidate", (property, value) => {
        if ((TOP_MEAN_CAUSAL_FEATURE_FIELDS as readonly string[]).includes(property) && value === null) {
            const field = property as TopMeanCausalFeatureField;
            tracker.accessed.add(field);
            tracker.nullReads += 1;
            tracker.nullReadsByField.set(field, (tracker.nullReadsByField.get(field) ?? 0) + 1);
            invocation.nullRead = true;
        } else if ((TOP_MEAN_PRICE_FEATURE_FIELDS as readonly string[]).includes(property) && value === null) {
            const field = property as TopMeanPriceFeatureField;
            tracker.accessedPrice.add(field);
            tracker.nullReads += 1;
            tracker.nullReadsByField.set(field, (tracker.nullReadsByField.get(field) ?? 0) + 1);
            invocation.nullRead = true;
        } else if ((TOP_MEAN_CAUSAL_FEATURE_FIELDS as readonly string[]).includes(property)) {
            tracker.accessed.add(property as TopMeanCausalFeatureField);
        } else if ((TOP_MEAN_PRICE_FEATURE_FIELDS as readonly string[]).includes(property)) {
            tracker.accessedPrice.add(property as TopMeanPriceFeatureField);
        }
    });
}

function eventProxy(event: TopMeanNormalizedEvent): TopMeanRuleEvent {
    return createReadOnlyProxy({ ...event.ruleEvent }, TOP_MEAN_RULE_EVENT_FIELDS, "event");
}

function compareRuleValue(left: { candidate: TopMeanBaseCandidate; value: number | boolean }, right: { candidate: TopMeanBaseCandidate; value: number | boolean }, event: TopMeanNormalizedEvent): number {
    return numberCompare(right.value as number, left.value as number)
        || compareCandidateTie(left.candidate, right.candidate, event.decisionTimeSec);
}

function selectRuleDecision(decision: RuleDecision, kind: "ranking" | "filter"): TopMeanBaseCandidate | null {
    if (kind === "filter") {
        const passing = decision.candidateResults.filter((result) => result.value === true);
        return passing.length === 0 ? null : [...passing].sort((left, right) => compareBaseCandidates(left.candidate, right.candidate, decision.event.decisionTimeSec))[0]!.candidate;
    }
    return [...decision.candidateResults].sort((left, right) => compareRuleValue(left, right, decision.event))[0]!.candidate;
}

function classifyRuleValue(value: unknown): "ranking" | "filter" {
    if (typeof value === "number" && Number.isFinite(value)) return "ranking";
    if (typeof value === "boolean") return "filter";
    throw new Error("Rule must return a finite number or boolean for every base candidate.");
}

function neutralizeNullFeatureRead(
    value: unknown,
    candidate: TopMeanBaseCandidate,
    invocation: { nullRead: boolean },
    tracker: RuleAccessTracker,
    establishedKind: "ranking" | "filter" | null,
): unknown {
    if (!invocation.nullRead) return value;
    const kind = establishedKind
        ?? (typeof value === "boolean" ? "filter" : "ranking");
    const neutral = kind === "filter" ? true : candidate.score;
    const isNeutral = kind === "filter" ? value === true : value === neutral;
    if (!isNeutral) tracker.nullNeutralViolations += 1;
    return neutral;
}

function ruleFailure(error: unknown, eventId?: string, asset?: string): never {
    const detail = error instanceof Error ? error.message : String(error);
    throw new CheckerFailure("rule.evaluation", "finite number or boolean result without exception", `${eventId ?? "unknown"}${asset ? `/${asset}` : ""}: ${detail}`, [], "RULE FAIL");
}

function evaluateRuleDecisions(
    events: readonly TopMeanNormalizedEvent[],
    rule: TopMeanRule,
    allowedPriceFields?: readonly TopMeanPriceFeatureField[],
): { kind: "ranking" | "filter" | "none"; decisions: readonly RuleDecision[]; access: TopMeanRuleAccessSummary } {
    const decisions: RuleDecision[] = [];
    let kind: "ranking" | "filter" | null = null;
    const tracker = createRuleAccessTracker();
    for (const event of events) {
        const candidateResults: Array<{ candidate: TopMeanBaseCandidate; value: number | boolean }> = [];
        let trueCandidateCount = 0;
        for (const candidate of event.baseCandidates) {
            let value: unknown;
            const invocation = { nullRead: false };
            try {
                value = rule(candidateProxy(candidate, tracker, invocation, allowedPriceFields), eventProxy(event));
            } catch (error) {
                ruleFailure(error, event.eventId, candidate.row.asset);
            }
            value = neutralizeNullFeatureRead(value, candidate, invocation, tracker, kind);
            let currentKind: "ranking" | "filter";
            try {
                currentKind = classifyRuleValue(value);
            } catch (error) {
                ruleFailure(error, event.eventId, candidate.row.asset);
            }
            if (kind !== null && kind !== currentKind) ruleFailure(new Error("rule result kind changed between candidates"), event.eventId, candidate.row.asset);
            kind ??= currentKind;
            if (currentKind === "ranking" && !finite(value)) ruleFailure(new Error("rule returned a non-finite number"), event.eventId, candidate.row.asset);
            if (currentKind === "filter" && value === true) trueCandidateCount += 1;
            candidateResults.push({ candidate, value: value as number | boolean });
        }
        const decision: RuleDecision = { event, candidateResults, selected: null, trueCandidateCount };
        decision.selected = kind === null ? null : selectRuleDecision(decision, kind);
        decisions.push(decision);
    }
    return { kind: kind ?? "none", decisions, access: accessSummary(tracker) };
}

export function evaluateTopMeanRule(args: {
    archive: TopMeanNormalizedArchive;
    window: TopMeanRuleWindow;
    rule: TopMeanRule;
}): TopMeanRuleEvaluation {
    const window = windowSpec(args.window);
    const windowEvents = eventsInWindow(args.archive, window);
    const baseEvents = windowEvents.filter((event) => event.baseCandidates.length >= 2);
    const decisionResult = evaluateRuleDecisions(baseEvents, args.rule, args.archive.admittedPriceFields);
    const decisions = decisionResult.decisions;
    const kind = decisionResult.kind;
    const completeEvents = baseEvents.filter((event) => outcomeComplete(args.archive, event));
    const completeIds = new Set(completeEvents.map((event) => event.eventId));
    const points: RuleEventPoint[] = [];
    let changedFullyObservedEvents = 0;
    let changedPartiallyObservedEvents = 0;
    for (const decision of decisions) {
        if (!completeIds.has(decision.event.eventId) || !decision.selected) continue;
        const incumbent = topMeanCandidate(decision.event);
        const selectedOutcome = validLongOutcome(args.archive, decision.event.eventId, decision.selected.row.asset)!;
        const incumbentOutcome = validLongOutcome(args.archive, decision.event.eventId, incumbent.row.asset)!;
        const otherReturns = decision.event.baseCandidates
            .filter((candidate) => candidate.row.asset !== decision.selected!.row.asset)
            .map((candidate) => validLongOutcome(args.archive, decision.event.eventId, candidate.row.asset)!.return!)
            .filter(finite);
        const controlReturn = otherReturns.reduce((sum, value) => sum + value, 0) / otherReturns.length;
        if (decision.selected.row.asset !== incumbent.row.asset) {
            if (eventFeaturesFullyObserved(decision.event)) changedFullyObservedEvents += 1;
            else changedPartiallyObservedEvents += 1;
        }
        points.push({
            eventId: decision.event.eventId,
            decisionTimeSec: decision.event.decisionTimeSec,
            selectedAsset: decision.selected.row.asset,
            selectedReturn: selectedOutcome.return!,
            incumbentReturn: incumbentOutcome.return!,
            primary: selectedOutcome.return! - incumbentOutcome.return!,
            secondary: selectedOutcome.return! - controlReturn,
        });
    }
    const candidateDenominator = completeEvents.reduce((sum, event) => sum + event.baseCandidates.length, 0);
    const candidateNumerator = kind === "filter"
        ? decisions.filter((decision) => completeIds.has(decision.event.eventId)).reduce((sum, decision) => sum + decision.trueCandidateCount, 0)
        : candidateDenominator;
    const primary = metricFromPairs(points, "primary");
    const secondary = metricFromPairs(points, "secondary");
    const selectedAssets = selectedAssetSummaries(points.map((point) => ({
        eventId: point.eventId,
        decisionTime: point.decisionTimeSec,
        entryTime: 0,
        exitTime: 0,
        horizonBars: TOP_MEAN_RULE_HORIZON,
        selector: "RULE",
        direction: TOP_MEAN_RULE_DIRECTION,
        asset: point.selectedAsset,
        selectedReturn: point.selectedReturn,
        controlReturn: point.incumbentReturn - point.primary,
        delta: point.secondary,
        eligibleCandidates: 2,
    })));
    const dominantAsset = selectedAssets[0]?.asset ?? null;
    const excludedPoints = dominantAsset === null ? [] : points.filter((point) => point.selectedAsset !== dominantAsset);
    const priceFieldsFullyObservedEvents = decisionResult.access.accessedPriceFields.length === 0
        ? 0
        : baseEvents.filter((event) => priceFieldsFullyObserved(event, decisionResult.access.accessedPriceFields)).length;
    return {
        window,
        kind: kind ?? "none",
        candidateKeepRate: candidateDenominator > 0 ? candidateNumerator / candidateDenominator : 0,
        eventKeepRate: completeEvents.length > 0 ? points.length / completeEvents.length : 0,
        rawEventCount: windowEvents.length,
        baseCandidateEventCount: baseEvents.length,
        outcomeCompleteEventCount: completeEvents.length,
        points,
        primary,
        secondary,
        selectedAssets,
        dominantAsset,
        dominantExclusionPrimary: metricFromPairs(excludedPoints, "primary"),
        dominantExclusionSecondary: metricFromPairs(excludedPoints, "secondary"),
        ...decisionResult.access,
        changedFullyObservedEvents,
        changedPartiallyObservedEvents,
        priceFieldsFullyObservedEvents,
        priceFieldsPartiallyObservedEvents: decisionResult.access.accessedPriceFields.length === 0
            ? 0
            : baseEvents.length - priceFieldsFullyObservedEvents,
    };
}

export function evaluateTopMeanCausalScreen(args: {
    archive: TopMeanCausalArchive;
    window: TopMeanRuleWindow;
    rule: TopMeanRule;
}): TopMeanCausalScreenEvaluation {
    const window = windowSpec(args.window);
    const windowEvents = eventsInWindow(args.archive, window);
    const baseEvents = windowEvents.filter((event) => event.baseCandidates.length >= 2);
    const decisionResult = evaluateRuleDecisions(baseEvents, args.rule, args.archive.admittedPriceFields);
    if (args.archive.meta.schema === "top_mean_archive.v3" && decisionResult.access.accessedV2Fields.length === 0 && decisionResult.access.accessedPriceFields.length === 0) {
        throw new CheckerFailure("rule.v2.no_feature_access", "at least one V2 feature field read", "none", [], "RULE FAIL");
    }
    let selectedEvents = 0;
    let droppedEvents = 0;
    let changedEvents = 0;
    let unchangedEvents = 0;
    let changedFullyObservedEvents = 0;
    let changedPartiallyObservedEvents = 0;
    for (const decision of decisionResult.decisions) {
        if (!decision.selected) {
            droppedEvents += 1;
            continue;
        }
        selectedEvents += 1;
        if (decision.selected.row.asset === topMeanCandidate(decision.event).row.asset) unchangedEvents += 1;
        else {
            changedEvents += 1;
            if (eventFeaturesFullyObserved(decision.event)) changedFullyObservedEvents += 1;
            else changedPartiallyObservedEvents += 1;
        }
    }
    const baseCandidateCount = baseEvents.reduce((sum, event) => sum + event.baseCandidates.length, 0);
    const candidateNumerator = decisionResult.kind === "filter"
        ? decisionResult.decisions.reduce((sum, decision) => sum + decision.trueCandidateCount, 0)
        : baseCandidateCount;
    return {
        window,
        kind: decisionResult.kind,
        rawEventCount: windowEvents.length,
        baseCandidateEventCount: baseEvents.length,
        baseCandidateCount,
        candidateKeepRate: baseCandidateCount > 0 ? candidateNumerator / baseCandidateCount : 0,
        selectedEvents,
        droppedEvents,
        changedEvents,
        unchangedEvents,
        ...decisionResult.access,
        changedFullyObservedEvents,
        changedPartiallyObservedEvents,
        priceFieldsFullyObservedEvents: decisionResult.access.accessedPriceFields.length === 0
            ? 0
            : baseEvents.filter((event) => priceFieldsFullyObserved(event, decisionResult.access.accessedPriceFields)).length,
        priceFieldsPartiallyObservedEvents: decisionResult.access.accessedPriceFields.length === 0
            ? 0
            : baseEvents.filter((event) => !priceFieldsFullyObserved(event, decisionResult.access.accessedPriceFields)).length,
    };
}

function percentile(values: readonly number[]): PercentileSummary {
    const sorted = [...values].sort(numberCompare);
    const at = (fraction: number): number | null => sorted.length === 0 ? null : sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))]!;
    return { n: sorted.length, p0: at(0), p1: at(0.01), p5: at(0.05), p25: at(0.25), p50: at(0.5), p75: at(0.75), p95: at(0.95), p99: at(0.99), p100: at(1) };
}

export function computeTopMeanCausalStats(archive: TopMeanCausalArchive, windowName: TopMeanRuleWindow): TopMeanCausalStats {
    const window = windowSpec(windowName);
    const windowEvents = eventsInWindow(archive, window);
    const baseEvents = windowEvents.filter((event) => event.baseCandidates.length >= 2);
    const sortedCandidates = baseEvents.map((event) => [...event.baseCandidates].sort((left, right) => compareBaseCandidates(left, right, event.decisionTimeSec)));
    const top1 = sortedCandidates.map((candidates) => candidates[0]!.score);
    const top2 = sortedCandidates.map((candidates) => candidates[1]!.score);
    const winnerActivePairCount = sortedCandidates.map((candidates) => candidates[0]!.row.activePairCount);
    const runnerUpActivePairCount = sortedCandidates.map((candidates) => candidates[1]!.row.activePairCount);
    const exactTopScoreTies = top1.filter((score, index) => score === top2[index]).length;
    const nearTieCounts = {
        le001: top1.filter((score, index) => score - top2[index]! <= 0.01).length,
        le0025: top1.filter((score, index) => score - top2[index]! <= 0.025).length,
        le005: top1.filter((score, index) => score - top2[index]! <= 0.05).length,
    };
    const topRawSelectionDifferences = baseEvents.filter((event) => topRawCandidate(event).row.asset !== topMeanCandidate(event).row.asset).length;
    return {
        window,
        rawEventCount: windowEvents.length,
        baseCandidateEventCount: baseEvents.length,
        baseCandidateCount: baseEvents.reduce((sum, event) => sum + event.baseCandidates.length, 0),
        incumbentActivePairCount: percentile(winnerActivePairCount),
        runnerUpActivePairCount: percentile(runnerUpActivePairCount),
        top1Score: percentile(top1),
        top2Score: percentile(top2),
        exactTopScoreTies,
        nearTieCounts,
        topRawSelectionDifferences,
    };
}

function pearson(left: readonly number[], right: readonly number[]): number | null {
    if (left.length !== right.length || left.length < 2) return null;
    const leftMean = left.reduce((sum, value) => sum + value, 0) / left.length;
    const rightMean = right.reduce((sum, value) => sum + value, 0) / right.length;
    let numerator = 0;
    let leftVariance = 0;
    let rightVariance = 0;
    for (let index = 0; index < left.length; index += 1) {
        const leftDelta = left[index]! - leftMean;
        const rightDelta = right[index]! - rightMean;
        numerator += leftDelta * rightDelta;
        leftVariance += leftDelta ** 2;
        rightVariance += rightDelta ** 2;
    }
    if (leftVariance === 0 || rightVariance === 0) return null;
    return numerator / Math.sqrt(leftVariance * rightVariance);
}

function ranks(values: readonly number[]): number[] {
    const indexed = values.map((value, index) => ({ value, index })).sort((left, right) => left.value - right.value || left.index - right.index);
    const output = new Array<number>(values.length);
    let index = 0;
    while (index < indexed.length) {
        let end = index + 1;
        while (end < indexed.length && indexed[end]!.value === indexed[index]!.value) end += 1;
        const rank = (index + 1 + end) / 2;
        for (let cursor = index; cursor < end; cursor += 1) output[indexed[cursor]!.index] = rank;
        index = end;
    }
    return output;
}

function correlation(left: readonly number[], right: readonly number[]): { pearson: number | null; spearman: number | null } {
    return { pearson: pearson(left, right), spearman: pearson(ranks(left), ranks(right)) };
}

function featureValue(candidate: TopMeanBaseCandidate, field: TopMeanCausalFeatureField): number | null {
    return candidate.features?.[field] ?? null;
}

function priceFeatureValue(candidate: TopMeanBaseCandidate, field: TopMeanPriceFeatureField): number | null {
    return candidate.priceFeatures?.[field] ?? null;
}

function featureCorrelation(
    candidates: readonly TopMeanBaseCandidate[],
    field: TopMeanCausalFeatureField,
    target: (candidate: TopMeanBaseCandidate) => number,
): { pearson: number | null; spearman: number | null } {
    const left: number[] = [];
    const right: number[] = [];
    for (const candidate of candidates) {
        const value = featureValue(candidate, field);
        if (value === null) continue;
        left.push(value);
        right.push(target(candidate));
    }
    return correlation(left, right);
}

function distributionForRole(
    candidates: readonly TopMeanBaseCandidate[],
    field: TopMeanCausalFeatureField,
): PercentileSummary {
    return percentile(candidates.map((candidate) => featureValue(candidate, field)).filter(finite));
}

function featureFieldStats(
    field: TopMeanCausalFeatureField,
    baseEvents: readonly TopMeanNormalizedEvent[],
    allCandidates: readonly TopMeanBaseCandidate[],
): TopMeanFeatureFieldStats {
    const values = allCandidates.map((candidate) => featureValue(candidate, field));
    const eventRanges: number[] = [];
    let distinctEvents = 0;
    for (const event of baseEvents) {
        const eventValues = event.baseCandidates.map((candidate) => featureValue(candidate, field)).filter(finite);
        if (eventValues.length === 0) continue;
        eventRanges.push(Math.max(...eventValues) - Math.min(...eventValues));
        if (new Set(eventValues).size > 1) distinctEvents += 1;
    }
    const sortedCandidatesByEvent = baseEvents.map((event) => [...event.baseCandidates].sort((left, right) => compareBaseCandidates(left, right, event.decisionTimeSec)));
    const incumbents = sortedCandidatesByEvent.map((candidates) => candidates.slice(0, 1)).flat();
    const runnersUp = sortedCandidatesByEvent.map((candidates) => candidates.slice(1, 2)).flat();
    const nonIncumbents = sortedCandidatesByEvent.map((candidates) => candidates.slice(1)).flat();
    const correlations: Record<string, number | null> = {};
    const targets: Readonly<Record<string, (candidate: TopMeanBaseCandidate) => number>> = {
        score: (candidate) => candidate.score,
        signedVotes: (candidate) => candidate.row.signedVotes,
        activePairCount: (candidate) => candidate.row.activePairCount,
        ema200Above: (candidate) => candidate.row.ema200Above ? 1 : 0,
    };
    for (const [name, target] of Object.entries(targets)) {
        const result = featureCorrelation(allCandidates, field, target);
        correlations[`${name}.pearson`] = result.pearson;
        correlations[`${name}.spearman`] = result.spearman;
    }
    return {
        nonNull: values.filter(finite).length,
        nullCount: values.filter((value) => value === null).length,
        values: percentile(values.filter(finite)),
        incumbent: distributionForRole(incumbents, field),
        runnerUp: distributionForRole(runnersUp, field),
        nonIncumbent: distributionForRole(nonIncumbents, field),
        withinEventRange: percentile(eventRanges),
        withinEventDistinctValueRate: baseEvents.length > 0 ? distinctEvents / baseEvents.length : null,
        correlations,
    };
}

function priceFeatureFieldStats(
    field: TopMeanPriceFeatureField,
    baseEvents: readonly TopMeanNormalizedEvent[],
    allCandidates: readonly TopMeanBaseCandidate[],
): TopMeanFeatureFieldStats {
    const values = allCandidates.map((candidate) => priceFeatureValue(candidate, field));
    const eventRanges: number[] = [];
    let distinctEvents = 0;
    for (const event of baseEvents) {
        const eventValues = event.baseCandidates.map((candidate) => priceFeatureValue(candidate, field)).filter(finite);
        if (eventValues.length === 0) continue;
        eventRanges.push(Math.max(...eventValues) - Math.min(...eventValues));
        if (new Set(eventValues).size > 1) distinctEvents += 1;
    }
    const sortedCandidatesByEvent = baseEvents.map((event) => [...event.baseCandidates].sort((left, right) => compareBaseCandidates(left, right, event.decisionTimeSec)));
    const incumbents = sortedCandidatesByEvent.map((candidates) => candidates.slice(0, 1)).flat();
    const runnersUp = sortedCandidatesByEvent.map((candidates) => candidates.slice(1, 2)).flat();
    const nonIncumbents = sortedCandidatesByEvent.map((candidates) => candidates.slice(1)).flat();
    const targets: Readonly<Record<string, (candidate: TopMeanBaseCandidate) => number | null>> = {
        score: (candidate) => candidate.score,
        signedVotes: (candidate) => candidate.row.signedVotes,
        activePairCount: (candidate) => candidate.row.activePairCount,
        ema200Above: (candidate) => candidate.row.ema200Above ? 1 : 0,
        ...Object.fromEntries(TOP_MEAN_CAUSAL_FEATURE_FIELDS.map((temporal) => [temporal, (candidate: TopMeanBaseCandidate) => featureValue(candidate, temporal)])),
        breadth: (candidate) => candidate.row.breadth,
        regimeBullish: (candidate) => candidate.row.regime === "bullish" ? 1 : 0,
        regimeBearish: (candidate) => candidate.row.regime === "bearish" ? 1 : 0,
        regimeUnavailable: (candidate) => candidate.row.regime === "unavailable" ? 1 : 0,
    };
    const correlations: Record<string, number | null> = {};
    for (const [name, target] of Object.entries(targets)) {
        const left: number[] = [];
        const right: number[] = [];
        for (const candidate of allCandidates) {
            const value = priceFeatureValue(candidate, field);
            const targetValue = target(candidate);
            if (value === null || !finite(targetValue)) continue;
            left.push(value);
            right.push(targetValue);
        }
        const result = correlation(left, right);
        correlations[`${name}.pearson`] = result.pearson;
        correlations[`${name}.spearman`] = result.spearman;
    }
    return {
        nonNull: values.filter(finite).length,
        nullCount: values.filter((value) => value === null).length,
        values: percentile(values.filter(finite)),
        incumbent: distributionForPriceRole(incumbents, field),
        runnerUp: distributionForPriceRole(runnersUp, field),
        nonIncumbent: distributionForPriceRole(nonIncumbents, field),
        withinEventRange: percentile(eventRanges),
        withinEventDistinctValueRate: baseEvents.length > 0 ? distinctEvents / baseEvents.length : null,
        correlations,
    };
}

function distributionForPriceRole(candidates: readonly TopMeanBaseCandidate[], field: TopMeanPriceFeatureField): PercentileSummary {
    return percentile(candidates.map((candidate) => priceFeatureValue(candidate, field)).filter(finite));
}

export function computeTopMeanFeatureStats(
    archive: TopMeanCausalArchive,
    windowName: TopMeanRuleWindow,
): TopMeanFeatureStats {
    requireCheck(archive.meta.schema === "top_mean_archive.v3", "feature-stats.archive", "top_mean_archive.v3 with featureSet", String(archive.meta.schema));
    const window = windowSpec(windowName);
    const windowEvents = eventsInWindow(archive, window);
    const baseEvents = windowEvents.filter((event) => event.baseCandidates.length >= 2);
    const allCandidates = baseEvents.flatMap((event) => event.baseCandidates);
    const availabilityByEvent = windowEvents.map((event, index) => {
        const nonNullByField: Record<string, number> = {};
        for (const field of TOP_MEAN_CAUSAL_FEATURE_FIELDS) {
            nonNullByField[field] = event.baseCandidates.filter((candidate) => featureValue(candidate, field) !== null).length;
        }
        return { ordinal: index + 1, eventId: event.eventId, baseCandidates: event.baseCandidates.length, nonNullByField };
    });
    const fields = {} as Record<TopMeanCausalFeatureField, TopMeanFeatureFieldStats>;
    for (const field of TOP_MEAN_CAUSAL_FEATURE_FIELDS) fields[field] = featureFieldStats(field, baseEvents, allCandidates);
    const priceFields = archive.priceFeaturesByKey === undefined
        ? undefined
        : {} as Record<TopMeanPriceFeatureField, TopMeanFeatureFieldStats>;
    if (priceFields) for (const field of TOP_MEAN_PRICE_FEATURE_FIELDS) priceFields[field] = priceFeatureFieldStats(field, baseEvents, allCandidates);
    const crossFeatureCorrelations: Record<string, number | null> = {};
    for (let leftIndex = 0; leftIndex < TOP_MEAN_CAUSAL_FEATURE_FIELDS.length; leftIndex += 1) {
        const leftField = TOP_MEAN_CAUSAL_FEATURE_FIELDS[leftIndex]!;
        for (let rightIndex = leftIndex + 1; rightIndex < TOP_MEAN_CAUSAL_FEATURE_FIELDS.length; rightIndex += 1) {
            const rightField = TOP_MEAN_CAUSAL_FEATURE_FIELDS[rightIndex]!;
            const left: number[] = [];
            const right: number[] = [];
            for (const candidate of allCandidates) {
                const leftValue = featureValue(candidate, leftField);
                const rightValue = featureValue(candidate, rightField);
                if (leftValue === null || rightValue === null) continue;
                left.push(leftValue);
                right.push(rightValue);
            }
            const result = correlation(left, right);
            crossFeatureCorrelations[`${leftField}~${rightField}.pearson`] = result.pearson;
            crossFeatureCorrelations[`${leftField}~${rightField}.spearman`] = result.spearman;
        }
    }
    const priceCrossFeatureCorrelations: Record<string, number | null> = {};
    if (priceFields) for (let leftIndex = 0; leftIndex < TOP_MEAN_PRICE_FEATURE_FIELDS.length; leftIndex += 1) {
        const leftField = TOP_MEAN_PRICE_FEATURE_FIELDS[leftIndex]!;
        for (let rightIndex = leftIndex + 1; rightIndex < TOP_MEAN_PRICE_FEATURE_FIELDS.length; rightIndex += 1) {
            const rightField = TOP_MEAN_PRICE_FEATURE_FIELDS[rightIndex]!;
            const left: number[] = [];
            const right: number[] = [];
            for (const candidate of allCandidates) {
                const leftValue = priceFeatureValue(candidate, leftField);
                const rightValue = priceFeatureValue(candidate, rightField);
                if (leftValue === null || rightValue === null) continue;
                left.push(leftValue);
                right.push(rightValue);
            }
            const result = correlation(left, right);
            priceCrossFeatureCorrelations[`${leftField}~${rightField}.pearson`] = result.pearson;
            priceCrossFeatureCorrelations[`${leftField}~${rightField}.spearman`] = result.spearman;
        }
    }
    const returnAvailability = { zero: 0, one: 0, twoPlus: 0 };
    for (const event of windowEvents) {
        const available = event.baseCandidates.filter((candidate) => featureValue(candidate, "priorTopMeanReturnMean3") !== null).length;
        if (available === 0) returnAvailability.zero += 1;
        else if (available === 1) returnAvailability.one += 1;
        else returnAvailability.twoPlus += 1;
    }
    return {
        window,
        rawEventCount: windowEvents.length,
        baseCandidateEventCount: baseEvents.length,
        baseCandidateCount: allCandidates.length,
        fields,
        ...(priceFields ? { priceFields } : {}),
        availabilityByEvent,
        warmupCompletionByOrdinal: availabilityByEvent,
        priorTopMeanReturnMean3Availability: returnAvailability,
        crossFeatureCorrelations,
        ...(priceFields ? { priceCrossFeatureCorrelations } : {}),
    };
}

export function computeTopMeanCalibrationStats(archive: TopMeanNormalizedArchive, windowName: TopMeanRuleWindow): TopMeanCalibrationStats {
    const window = windowSpec(windowName);
    const events = eventsInWindow(archive, window);
    const baseEvents = events.filter((event) => event.baseCandidates.length >= 2);
    const completeEvents = baseEvents.filter((event) => outcomeComplete(archive, event));
    const daily = new Map<string, number>();
    const regimes: Record<Regime, { events: number; share: number }> = {
        bullish: { events: 0, share: 0 },
        bearish: { events: 0, share: 0 },
        unavailable: { events: 0, share: 0 },
    };
    for (const event of events) {
        regimes[event.ruleEvent.regime].events += 1;
        const day = new Date(event.decisionTimeSec * 1000).toISOString().slice(0, 10);
        daily.set(day, (daily.get(day) ?? 0) + 1);
    }
    for (const regime of ["bullish", "bearish", "unavailable"] as const) regimes[regime].share = events.length > 0 ? regimes[regime].events / events.length : 0;
    const candidates = baseEvents.flatMap((event) => event.baseCandidates);
    return {
        window,
        rawEventCount: events.length,
        baseCandidateEventCount: baseEvents.length,
        outcomeCompleteEventCount: completeEvents.length,
        exclusions: {
            NO_BASE_CANDIDATES: events.filter((event) => event.baseCandidates.length < 2).length,
            OUTCOME_INCOMPLETE: baseEvents.filter((event) => !outcomeComplete(archive, event)).length,
        },
        candidateSignedVotes: percentile(candidates.map((candidate) => candidate.row.signedVotes)),
        candidateActivePairCount: percentile(candidates.map((candidate) => candidate.row.activePairCount)),
        candidateScore: percentile(candidates.map((candidate) => candidate.score)),
        eventBreadth: percentile(events.map((event) => event.ruleEvent.breadth).filter(finite)),
        eventPoolSize: percentile(events.map((event) => event.ruleEvent.poolSize)),
        eventsPerUtcDay: percentile([...daily.values()]),
        regimes,
    };
}

function ruleMetricLine(label: string, metric: RuleMetric): string {
    const ci = metric.ciLower === null || metric.ciUpper === null ? "n/a" : `[${signedPercent(metric.ciLower)},${signedPercent(metric.ciUpper)}]`;
    return `${label} | n=${metric.n} mean=${signedPercent(metric.mean)} CI95=${ci} +blocks=${metric.positiveBlocks}/${metric.totalBlocks} status=${metric.status}`;
}

function blockLine(label: string, metric: RuleMetric): string {
    return `${label} blocks=[${metric.blockMeans.map(signedPercent).join(",")}]`;
}

export function renderTopMeanRuleReport(args: {
    archive: TopMeanNormalizedArchive;
    ruleName: string;
    ruleSha256: string;
    selfCheck: SelfCheckResult;
    evaluation: TopMeanRuleEvaluation;
}): string {
    const evaluation = args.evaluation;
    const lines = [
        "TOP_MEAN RULE CHECKER",
        `archive | runId=${args.archive.runId} interval=${TOP_MEAN_RULE_INTERVAL} horizons=[${TOP_MEAN_RULE_HORIZON}] metaFingerprint=${typeof args.archive.meta.fingerprint === "string" ? args.archive.meta.fingerprint : "n/a"}`,
        `rule | file=${args.ruleName} sha256=${args.ruleSha256}`,
        `self-check | PASS events=${args.selfCheck.eventCount} dominant=${args.selfCheck.dominantAsset ?? "NONE"}`,
        `window | name=${evaluation.window.name} from=${evaluation.window.fromSec} to=${evaluation.window.toSec}`,
        `cohort | rawEvents=${evaluation.rawEventCount} baseCandidateEvents=${evaluation.baseCandidateEventCount} outcomeCompleteEvents=${evaluation.outcomeCompleteEventCount}`,
        `rule kind=${evaluation.kind}`,
        `candidate keep rate=${(evaluation.candidateKeepRate * 100).toFixed(2)}%` ,
        `event keep rate=${(evaluation.eventKeepRate * 100).toFixed(2)}%`,
        ruleMetricLine("PRIMARY", evaluation.primary),
        blockLine("PRIMARY", evaluation.primary),
        ruleMetricLine("SECONDARY", evaluation.secondary),
        blockLine("SECONDARY", evaluation.secondary),
        `selected assets | count=${evaluation.selectedAssets.length}`,
    ];
    if (evaluation.selectedAssets.length === 0) lines.push("SELECTED_ASSET | n/a");
    else for (const asset of evaluation.selectedAssets) lines.push(`SELECTED_ASSET | asset=${asset.asset} n=${asset.events} share=${(asset.share * 100).toFixed(2)}% selectedMean=${signedPercent(asset.selectedMean)} secondaryDelta=${signedPercent(asset.secondaryDelta)}`);
    lines.push(`DOMINANT | asset=${evaluation.dominantAsset ?? "NONE"}`);
    const exclusionLabel = evaluation.dominantAsset ?? "NONE";
    lines.push("dominant exclusion | same kept events minus dominant selected asset");
    lines.push(ruleMetricLine(`PRIMARY_EX_${exclusionLabel}`, evaluation.dominantExclusionPrimary));
    lines.push(blockLine(`PRIMARY_EX_${exclusionLabel}`, evaluation.dominantExclusionPrimary));
    lines.push(ruleMetricLine(`SECONDARY_EX_${exclusionLabel}`, evaluation.dominantExclusionSecondary));
    lines.push(blockLine(`SECONDARY_EX_${exclusionLabel}`, evaluation.dominantExclusionSecondary));
    lines.push(`access | v2Fields=${evaluation.accessedV2Fields.join(",") || "none"}${evaluation.accessedPriceFields.length > 0 ? ` priceFields=${evaluation.accessedPriceFields.join(",")}` : ""} nullReads=${evaluation.nullReads} nullNeutralViolations=${evaluation.nullNeutralViolations}`);
    if (evaluation.accessedPriceFields.length > 0) lines.push(`price completeness | fullyObservedEvents=${evaluation.priceFieldsFullyObservedEvents} partiallyObservedEvents=${evaluation.priceFieldsPartiallyObservedEvents}`);
    return lines.join("\n") + "\n";
}

function renderSelfCheckPass(result: SelfCheckResult): string {
    const metric = result.metric;
    return `SELF_CHECK PASS | events=${result.eventCount} dominant=${result.dominantAsset ?? "NONE"} | TOP_MEAN n=${metric.n} top=${signedPercent(metric.topMean)} rand=${signedPercent(metric.controlMean)} delta=${signedPercent(metric.deltaMean)} CI95=${metric.ciLower === null || metric.ciUpper === null ? "n/a" : `[${signedPercent(metric.ciLower)},${signedPercent(metric.ciUpper)}]`} +blocks=${metric.positiveBlocks}/${metric.totalBlocks}\n`;
}

function percentileLine(label: string, summary: PercentileSummary): string {
    const values = [summary.p0, summary.p1, summary.p5, summary.p25, summary.p50, summary.p75, summary.p95, summary.p99, summary.p100].map(fixedNumber);
    return `${label} | n=${summary.n} p0=${values[0]} p1=${values[1]} p5=${values[2]} p25=${values[3]} p50=${values[4]} p75=${values[5]} p95=${values[6]} p99=${values[7]} p100=${values[8]}`;
}

export function renderTopMeanStatsReport(archive: TopMeanNormalizedArchive, stats: TopMeanCalibrationStats, selfCheck: SelfCheckResult): string {
    const lines = [
        "TOP_MEAN RULE CHECKER | mode=stats",
        `archive | runId=${archive.runId} interval=${TOP_MEAN_RULE_INTERVAL} horizons=[${TOP_MEAN_RULE_HORIZON}] metaFingerprint=${typeof archive.meta.fingerprint === "string" ? archive.meta.fingerprint : "n/a"}`,
        renderSelfCheckPass(selfCheck).trimEnd(),
        `window | name=${stats.window.name} from=${stats.window.fromSec} to=${stats.window.toSec}`,
        `cohort | rawEvents=${stats.rawEventCount} baseCandidateEvents=${stats.baseCandidateEventCount} outcomeCompleteEvents=${stats.outcomeCompleteEventCount}`,
        `exclusions | NO_BASE_CANDIDATES=${stats.exclusions.NO_BASE_CANDIDATES} OUTCOME_INCOMPLETE=${stats.exclusions.OUTCOME_INCOMPLETE}`,
        percentileLine("candidate signedVotes", stats.candidateSignedVotes),
        percentileLine("candidate activePairCount", stats.candidateActivePairCount),
        percentileLine("candidate recomputedScore", stats.candidateScore),
        percentileLine("event breadth", stats.eventBreadth),
        percentileLine("event poolSize", stats.eventPoolSize),
        percentileLine("events per UTC day", stats.eventsPerUtcDay),
    ];
    for (const regime of ["bullish", "bearish", "unavailable"] as const) lines.push(`regime | ${regime} events=${stats.regimes[regime].events} share=${(stats.regimes[regime].share * 100).toFixed(2)}%`);
    return lines.join("\n") + "\n";
}

function causalPercentileValue(value: number | null, digits: number): string {
    return value === null ? "n/a" : value.toFixed(digits);
}

function causalCountRate(count: number, total: number): string {
    return `${count}/${total} (${total > 0 ? ((count / total) * 100).toFixed(2) : "0.00"}%)`;
}

function renderCausalActivePairPercentiles(label: string, summary: PercentileSummary): string {
    return `${label}: p0 ${causalPercentileValue(summary.p0, 0)} | p25 ${causalPercentileValue(summary.p25, 0)} | p50 ${causalPercentileValue(summary.p50, 0)} | p75 ${causalPercentileValue(summary.p75, 0)} | p95 ${causalPercentileValue(summary.p95, 0)} | max ${causalPercentileValue(summary.p100, 0)}`;
}

function renderCausalScorePercentiles(label: string, summary: PercentileSummary): string {
    return `${label}: p25 ${causalPercentileValue(summary.p25, 4)} | p50 ${causalPercentileValue(summary.p50, 4)} | p75 ${causalPercentileValue(summary.p75, 4)}`;
}

export function renderTopMeanCausalStatsReport(archive: TopMeanCausalArchive, stats: TopMeanCausalStats): string {
    const lines = [
        "TOP_MEAN RULE CHECKER | mode=causal-stats",
        `archive | runId=${archive.runId} interval=${TOP_MEAN_RULE_INTERVAL} metaFingerprint=${typeof archive.meta.fingerprint === "string" ? archive.meta.fingerprint : "n/a"}`,
        `window | name=${stats.window.name} from=${stats.window.fromSec} to=${stats.window.toSec}`,
        `causal cohort | rawEvents=${stats.rawEventCount} baseCandidateEvents=${stats.baseCandidateEventCount} baseCandidates=${stats.baseCandidateCount}`,
        renderCausalActivePairPercentiles("incumbent winner activePairCount", stats.incumbentActivePairCount),
        renderCausalActivePairPercentiles("runner-up activePairCount", stats.runnerUpActivePairCount),
        renderCausalScorePercentiles("top-1 score", stats.top1Score),
        renderCausalScorePercentiles("top-2 score", stats.top2Score),
        `exact top-score ties: ${causalCountRate(stats.exactTopScoreTies, stats.baseCandidateEventCount)}`,
        `top1-top2 score margin <=0.01: ${causalCountRate(stats.nearTieCounts.le001, stats.baseCandidateEventCount)}`,
        `top1-top2 score margin <=0.025: ${causalCountRate(stats.nearTieCounts.le0025, stats.baseCandidateEventCount)}`,
        `top1-top2 score margin <=0.05: ${causalCountRate(stats.nearTieCounts.le005, stats.baseCandidateEventCount)}`,
        `max-signedVotes (TOP_RAW) selection differs: ${causalCountRate(stats.topRawSelectionDifferences, stats.baseCandidateEventCount)}`,
    ];
    return lines.join("\n") + "\n";
}

function featurePercentileLine(label: string, summary: PercentileSummary): string {
    return `${label} | n=${summary.n} p0=${fixedNumber(summary.p0)} p1=${fixedNumber(summary.p1)} p5=${fixedNumber(summary.p5)} p25=${fixedNumber(summary.p25)} p50=${fixedNumber(summary.p50)} p75=${fixedNumber(summary.p75)} p95=${fixedNumber(summary.p95)} p99=${fixedNumber(summary.p99)} p100=${fixedNumber(summary.p100)}`;
}

export function renderTopMeanFeatureStatsReport(archive: TopMeanCausalArchive, stats: TopMeanFeatureStats): string {
    const lines = [
        "TOP_MEAN RULE CHECKER | mode=feature-stats",
        `archive | runId=${archive.runId} interval=${TOP_MEAN_RULE_INTERVAL} metaFingerprint=${typeof archive.meta.fingerprint === "string" ? archive.meta.fingerprint : "n/a"}`,
        `feature-set | schema=${TOP_MEAN_CANDIDATE_FEATURES_SCHEMA} contract=${TOP_MEAN_FEATURE_CONTRACT_VERSION} formula=${TOP_MEAN_FEATURE_FORMULA_VERSION} availability=${TOP_MEAN_FEATURE_AVAILABILITY_POLICY}`,
        `window | name=${stats.window.name} from=${stats.window.fromSec} to=${stats.window.toSec}`,
        `causal cohort | rawEvents=${stats.rawEventCount} baseCandidateEvents=${stats.baseCandidateEventCount} baseCandidates=${stats.baseCandidateCount}`,
    ];
    for (const field of TOP_MEAN_CAUSAL_FEATURE_FIELDS) {
        const value = stats.fields[field]!;
        lines.push(`FEATURE | name=${field} nonNull=${value.nonNull} null=${value.nullCount} distinctEventRate=${value.withinEventDistinctValueRate === null ? "n/a" : value.withinEventDistinctValueRate.toFixed(4)}`);
        lines.push(featurePercentileLine(`${field} values`, value.values));
        lines.push(featurePercentileLine(`${field} incumbent`, value.incumbent));
        lines.push(featurePercentileLine(`${field} runnerUp`, value.runnerUp));
        lines.push(featurePercentileLine(`${field} nonIncumbent`, value.nonIncumbent));
        lines.push(featurePercentileLine(`${field} withinEventRange`, value.withinEventRange));
        for (const name of Object.keys(value.correlations).sort(codeUnitCompare)) lines.push(`CORRELATION | ${field}~${name}=${fixedNumber(value.correlations[name] ?? null)}`);
    }
    for (const field of TOP_MEAN_PRICE_FEATURE_FIELDS) {
        const value = stats.priceFields?.[field];
        if (!value) continue;
        lines.push(`FEATURE | name=${field} nonNull=${value.nonNull} null=${value.nullCount} distinctEventRate=${value.withinEventDistinctValueRate === null ? "n/a" : value.withinEventDistinctValueRate.toFixed(4)}`);
        lines.push(featurePercentileLine(`${field} values`, value.values));
        lines.push(featurePercentileLine(`${field} incumbent`, value.incumbent));
        lines.push(featurePercentileLine(`${field} runnerUp`, value.runnerUp));
        lines.push(featurePercentileLine(`${field} nonIncumbent`, value.nonIncumbent));
        lines.push(featurePercentileLine(`${field} withinEventRange`, value.withinEventRange));
        for (const name of Object.keys(value.correlations).sort(codeUnitCompare)) lines.push(`CORRELATION | ${field}~${name}=${fixedNumber(value.correlations[name] ?? null)}`);
    }
    for (const name of Object.keys(stats.priceCrossFeatureCorrelations ?? {}).sort(codeUnitCompare)) lines.push(`PRICE_CROSS_FEATURE | ${name}=${fixedNumber(stats.priceCrossFeatureCorrelations![name] ?? null)}`);
    for (const name of Object.keys(stats.crossFeatureCorrelations).sort(codeUnitCompare)) lines.push(`CROSS_FEATURE | ${name}=${fixedNumber(stats.crossFeatureCorrelations[name] ?? null)}`);
    lines.push(`RETURN_FEATURE_AVAILABILITY | zero=${stats.priorTopMeanReturnMean3Availability.zero} one=${stats.priorTopMeanReturnMean3Availability.one} twoPlus=${stats.priorTopMeanReturnMean3Availability.twoPlus}`);
    for (const event of stats.warmupCompletionByOrdinal) {
        lines.push(`WARMUP | ordinal=${event.ordinal} eventId=${event.eventId} baseCandidates=${event.baseCandidates} ${TOP_MEAN_CAUSAL_FEATURE_FIELDS.map((field) => `${field}=${event.nonNullByField[field]}`).join(" ")}`);
    }
    return lines.join("\n") + "\n";
}

export function renderTopMeanCausalScreenReport(args: {
    archive: TopMeanCausalArchive;
    ruleName: string;
    ruleSha256: string;
    evaluation: TopMeanCausalScreenEvaluation;
}): string {
    const evaluation = args.evaluation;
    const changeRate = evaluation.baseCandidateEventCount > 0
        ? (evaluation.changedEvents / evaluation.baseCandidateEventCount) * 100
        : 0;
    const impact = evaluation.changedEvents === 0 ? "ZERO" : changeRate < 2 ? "THIN" : "MATERIAL";
    const lines = [
        "TOP_MEAN RULE CHECKER | mode=screen",
        `archive | runId=${args.archive.runId} interval=${TOP_MEAN_RULE_INTERVAL} metaFingerprint=${typeof args.archive.meta.fingerprint === "string" ? args.archive.meta.fingerprint : "n/a"}`,
        `rule | file=${args.ruleName} sha256=${args.ruleSha256}`,
        `window | name=${evaluation.window.name} from=${evaluation.window.fromSec} to=${evaluation.window.toSec}`,
        `causal cohort | rawEvents=${evaluation.rawEventCount} baseCandidateEvents=${evaluation.baseCandidateEventCount} baseCandidates=${evaluation.baseCandidateCount}`,
        `rule | kind=${evaluation.kind}`,
        `selection | selectedEvents=${evaluation.selectedEvents} droppedEvents=${evaluation.droppedEvents} changed=${evaluation.changedEvents}/${evaluation.baseCandidateEventCount} rate=${changeRate.toFixed(2)}% unchanged=${evaluation.unchangedEvents}`,
        `selection observation | changedFullyObserved=${evaluation.changedFullyObservedEvents} changedPartiallyObserved=${evaluation.changedPartiallyObservedEvents}`,
        `access | v2Fields=${evaluation.accessedV2Fields.join(",") || "none"}${evaluation.accessedPriceFields.length > 0 ? ` priceFields=${evaluation.accessedPriceFields.join(",")}` : ""} nullReads=${evaluation.nullReads} nullReadsByField=${JSON.stringify(evaluation.nullReadsByField)} nullNeutralViolations=${evaluation.nullNeutralViolations}`,
        ...(evaluation.accessedPriceFields.length > 0 ? [`price completeness | fullyObservedEvents=${evaluation.priceFieldsFullyObservedEvents} partiallyObservedEvents=${evaluation.priceFieldsPartiallyObservedEvents}`] : []),
        `candidate keep rate=${(evaluation.candidateKeepRate * 100).toFixed(2)}%`,
        `SCREEN | impact=${impact} thinCutoff=2.00%`,
    ];
    return lines.join("\n") + "\n";
}

function sha256File(filename: string): string {
    return createHash("sha256").update(readFileSync(filename)).digest("hex");
}

function sha256LineList(lines: readonly string[]): string {
    return createHash("sha256").update(`${lines.join("\n")}\n`, "utf8").digest("hex");
}

function preflightRuleSource(ruleFile: string, allowLegacySource: boolean): void {
    const resolved = path.resolve(ruleFile);
    const name = path.basename(resolved);
    let bytes: Buffer;
    try {
        bytes = readFileSync(resolved);
    } catch {
        throw new CheckerFailure("rule.file", "readable rule file", name, [], "RULE FAIL");
    }
    const pipeOffset = bytes.indexOf(0x7c);
    if (!allowLegacySource && pipeOffset >= 0) {
        throw new CheckerFailure("rule.source.no_pipe", "no U+007C bytes", `${name}:offset=${pipeOffset}`, [], "RULE FAIL");
    }
}

async function importRule(ruleFile: string): Promise<{ name: string; sha256: string; rule: TopMeanRule }> {
    const resolved = path.resolve(ruleFile);
    const name = path.basename(resolved);
    let sha256: string;
    try {
        sha256 = sha256File(resolved);
    } catch {
        throw new CheckerFailure("rule.file", "readable rule file", name, [], "RULE FAIL");
    }
    let module: unknown;
    try {
        module = await import(pathToFileURL(resolved).href);
    } catch {
        throw new CheckerFailure("rule.import", "default-exported rule module", name, [], "RULE FAIL");
    }
    const defaultRule = isRecord(module) ? module.default : undefined;
    if (typeof defaultRule !== "function") throw new CheckerFailure("rule.default_export", "default export is a function", name, [], "RULE FAIL");
    return { name, sha256, rule: defaultRule as TopMeanRule };
}

interface CliOptions {
    ledgerDir: string;
    mode: "self-check" | "stats" | "causal-stats" | "feature-stats" | "screen" | "rule";
    ruleFile?: string;
    window?: TopMeanRuleWindow;
    allowLegacySource: boolean;
    priceFeaturesDir?: string;
    priceCalibrationFile?: string;
}

const USAGE = [
    "Usage:",
    "  esno scripts/top-mean-rule-checker.ts <ledgerDir> <ruleFile.ts> --window discovery|validation [--price-features <dir>] [--price-calibration <file>] [--allow-legacy-source]",
    "  esno scripts/top-mean-rule-checker.ts <ledgerDir> --self-check",
    "  esno scripts/top-mean-rule-checker.ts <ledgerDir> --stats --window discovery|validation",
    "  esno scripts/top-mean-rule-checker.ts <ledgerDir> --causal-stats --window discovery",
    "  esno scripts/top-mean-rule-checker.ts <ledgerDir> --feature-stats --window discovery|validation [--price-features <dir>]",
    "  esno scripts/top-mean-rule-checker.ts <ledgerDir> <ruleFile.ts> --screen --window discovery [--price-features <dir>] [--price-calibration <file>]",
    "  --allow-legacy-source allows U+007C only for historical rule replay",
].join("\n");

function parseCli(argv: readonly string[]): CliOptions | "help" {
    if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) return "help";
    let selfCheck = false;
    let stats = false;
    let causalStats = false;
    let featureStats = false;
    let screen = false;
    let allowLegacySource = false;
    let priceFeaturesDir: string | undefined;
    let priceCalibrationFile: string | undefined;
    let selectedWindow: TopMeanRuleWindow | undefined;
    const positional: string[] = [];
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index]!;
        if (arg === "--self-check") {
            if (selfCheck) throw new UsageFailure("duplicate --self-check");
            selfCheck = true;
        } else if (arg === "--stats") {
            if (stats) throw new UsageFailure("duplicate --stats");
            stats = true;
        } else if (arg === "--causal-stats") {
            if (causalStats) throw new UsageFailure("duplicate --causal-stats");
            causalStats = true;
        } else if (arg === "--feature-stats") {
            if (featureStats) throw new UsageFailure("duplicate --feature-stats");
            featureStats = true;
        } else if (arg === "--screen") {
            if (screen) throw new UsageFailure("duplicate --screen");
            screen = true;
        } else if (arg === "--allow-legacy-source") {
            if (allowLegacySource) throw new UsageFailure("duplicate --allow-legacy-source");
            allowLegacySource = true;
        } else if (arg === "--price-features") {
            if (priceFeaturesDir !== undefined) throw new UsageFailure("duplicate --price-features");
            priceFeaturesDir = argv[++index];
            if (!priceFeaturesDir) throw new UsageFailure("--price-features requires a directory");
        } else if (arg === "--price-calibration") {
            if (priceCalibrationFile !== undefined) throw new UsageFailure("duplicate --price-calibration");
            priceCalibrationFile = argv[++index];
            if (!priceCalibrationFile) throw new UsageFailure("--price-calibration requires a file");
        } else if (arg === "--window") {
            if (selectedWindow !== undefined) throw new UsageFailure("duplicate --window");
            const value = argv[++index];
            if (value !== "discovery" && value !== "validation") throw new UsageFailure("--window requires discovery or validation");
            selectedWindow = value;
        } else if (arg.startsWith("--")) {
            throw new UsageFailure(`unknown option ${arg}`);
        } else positional.push(arg);
    }
    if (positional.length === 0) throw new UsageFailure("ledgerDir is required");
    if (allowLegacySource && positional.length !== 2) throw new UsageFailure("--allow-legacy-source requires ledgerDir and ruleFile");
    if (selfCheck && stats) throw new UsageFailure("--self-check and --stats are exclusive");
    if ([selfCheck, stats, causalStats, featureStats, screen].filter(Boolean).length > 1) throw new UsageFailure("checker modes are exclusive");
    if (selfCheck) {
        if (positional.length !== 1 || selectedWindow !== undefined) throw new UsageFailure("self-check mode takes only ledgerDir");
        return { ledgerDir: positional[0]!, mode: "self-check", allowLegacySource, priceFeaturesDir, priceCalibrationFile };
    }
    if (stats) {
        if (positional.length !== 1 || selectedWindow === undefined) throw new UsageFailure("stats mode requires ledgerDir and --window");
        return { ledgerDir: positional[0]!, mode: "stats", window: selectedWindow, allowLegacySource, priceFeaturesDir, priceCalibrationFile };
    }
    if (causalStats) {
        if (positional.length !== 1 || selectedWindow !== "discovery") throw new UsageFailure("causal-stats mode requires ledgerDir and --window discovery");
        return { ledgerDir: positional[0]!, mode: "causal-stats", window: selectedWindow, allowLegacySource, priceFeaturesDir, priceCalibrationFile };
    }
    if (featureStats) {
        if (positional.length !== 1 || selectedWindow === undefined) throw new UsageFailure("feature-stats mode requires ledgerDir and --window");
        return { ledgerDir: positional[0]!, mode: "feature-stats", window: selectedWindow, allowLegacySource, priceFeaturesDir, priceCalibrationFile };
    }
    if (screen) {
        if (positional.length !== 2 || selectedWindow !== "discovery") throw new UsageFailure("screen mode requires ledgerDir, ruleFile, and --window discovery");
        return { ledgerDir: positional[0]!, ruleFile: positional[1]!, mode: "screen", window: selectedWindow, allowLegacySource, priceFeaturesDir, priceCalibrationFile };
    }
    if (positional.length !== 2 || selectedWindow === undefined) throw new UsageFailure("rule mode requires ledgerDir, ruleFile, and --window");
    return { ledgerDir: positional[0]!, mode: "rule", ruleFile: positional[1]!, window: selectedWindow, allowLegacySource, priceFeaturesDir, priceCalibrationFile };
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

export async function runTopMeanRuleCheckerCli(argv: readonly string[]): Promise<number> {
    let options: CliOptions | "help";
    try {
        options = parseCli(argv);
    } catch (error) {
        process.stderr.write(`USAGE ERROR | ${error instanceof Error ? error.message : String(error)}\n${USAGE}\n`);
        return 2;
    }
    if (options === "help") {
        process.stdout.write(`${USAGE}\n`);
        return 0;
    }
    if (options.ruleFile !== undefined) {
        try {
            preflightRuleSource(options.ruleFile, options.allowLegacySource);
        } catch (error) {
            process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
            return 1;
        }
    }
    if (options.mode === "causal-stats" || options.mode === "feature-stats" || options.mode === "screen") {
        let causalArchive: TopMeanCausalArchive;
        try {
            causalArchive = loadCausalTopMeanArchiveFromDirectory(options.ledgerDir, {
                ...(options.priceFeaturesDir ? { priceFeaturesDir: options.priceFeaturesDir } : {}),
            });
        } catch (error) {
            process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
            return 1;
        }
        if (options.mode === "screen" && options.priceFeaturesDir && !options.priceCalibrationFile) {
            process.stderr.write("RULE FAIL | enriched screen requires --price-calibration\n");
            return 1;
        }
        if (options.priceCalibrationFile) {
            try {
                causalArchive = { ...causalArchive, admittedPriceFields: loadAdmittedPriceFields(options.priceCalibrationFile, causalArchive) };
            } catch (error) {
                process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
                return 1;
            }
        }
        if (options.mode === "causal-stats") {
            const stats = computeTopMeanCausalStats(causalArchive, options.window!);
            process.stdout.write(renderTopMeanCausalStatsReport(causalArchive, stats));
            return 0;
        }
        if (options.mode === "feature-stats") {
            try {
                const stats = computeTopMeanFeatureStats(causalArchive, options.window!);
                process.stdout.write(renderTopMeanFeatureStatsReport(causalArchive, stats));
                return 0;
            } catch (error) {
                process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
                return 1;
            }
        }
        let importedRule: { name: string; sha256: string; rule: TopMeanRule };
        try {
            importedRule = await importRule(options.ruleFile!);
        } catch (error) {
            process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
            return 1;
        }
        try {
            const evaluation = evaluateTopMeanCausalScreen({ archive: causalArchive, window: options.window!, rule: importedRule.rule });
            process.stdout.write(renderTopMeanCausalScreenReport({ archive: causalArchive, ruleName: importedRule.name, ruleSha256: importedRule.sha256, evaluation }));
            return 0;
        } catch (error) {
            process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
            return 1;
        }
    }
    let archive: TopMeanNormalizedArchive;
    try {
        archive = loadNormalizedTopMeanArchiveFromDirectory(options.ledgerDir, {
            ...(options.priceFeaturesDir ? { priceFeaturesDir: options.priceFeaturesDir } : {}),
        });
    } catch (error) {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        return 1;
    }
    if (options.priceFeaturesDir && options.mode === "rule" && !options.priceCalibrationFile) {
        process.stderr.write("RULE FAIL | enriched rule evaluation requires --price-calibration\n");
        return 1;
    }
    if (options.priceCalibrationFile) {
        try {
            archive = { ...archive, admittedPriceFields: loadAdmittedPriceFields(options.priceCalibrationFile, archive) };
        } catch (error) {
            process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
            return 1;
        }
    }
    let selfCheck: SelfCheckResult;
    try {
        selfCheck = runTopMeanSelfCheck(archive);
    } catch (error) {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        return 1;
    }
    if (options.mode === "self-check") {
        process.stdout.write(renderSelfCheckPass(selfCheck));
        return 0;
    }
    if (options.mode === "stats") {
        const stats = computeTopMeanCalibrationStats(archive, options.window!);
        process.stdout.write(renderTopMeanStatsReport(archive, stats, selfCheck));
        return 0;
    }
    let importedRule: { name: string; sha256: string; rule: TopMeanRule };
    try {
        importedRule = await importRule(options.ruleFile!);
    } catch (error) {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        return 1;
    }
    let evaluation: TopMeanRuleEvaluation;
    try {
        evaluation = evaluateTopMeanRule({ archive, window: options.window!, rule: importedRule.rule });
    } catch (error) {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        return 1;
    }
    process.stdout.write(renderTopMeanRuleReport({ archive, ruleName: importedRule.name, ruleSha256: importedRule.sha256, selfCheck, evaluation }));
    return 0;
}

if (isMainModule()) {
    void runTopMeanRuleCheckerCli(process.argv.slice(2)).then((exitCode) => {
        process.exitCode = exitCode;
    }).catch(() => {
        process.stderr.write("RULE FAIL | checker failed\n");
        process.exitCode = 1;
    });
}
