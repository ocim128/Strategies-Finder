/**
 * Offline, read-only TOP_MEAN selector rule checker.
 *
 * The archive is the frozen source of candidate snapshots and outcomes. This
 * script only validates, selects, joins, and reports; it never runs a
 * backtest and never writes to the archive.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
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

export const TOP_MEAN_RULE_HORIZON = 24;
export const TOP_MEAN_RULE_INTERVAL = "4h";
export const TOP_MEAN_RULE_DIRECTION = "long";
export const TOP_MEAN_RULE_L1_RUN_ID = "sp500_top_mean_1788443592188_cgd3";

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

export type TopMeanRuleCandidate = Readonly<Pick<PoolSnapshotRecord, CandidateField>>;
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
}

export interface TopMeanCausalArchive {
    runId: string;
    meta: TopMeanRuleMeta;
    catalogAssets: readonly string[];
    events: readonly TopMeanNormalizedEvent[];
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
    requireCheck(value.schema === "top_mean_archive.v2", "meta.schema", "top_mean_archive.v2", String(value.schema));
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
        requireCheck(runId !== TOP_MEAN_RULE_L1_RUN_ID, "report.incomplete_header", "DATA_INCOMPLETE on the designated L1 archive", firstLine);
        return;
    }
    requireCheck(runId === TOP_MEAN_RULE_L1_RUN_ID, "report.incomplete_archive", `only ${TOP_MEAN_RULE_L1_RUN_ID} may be DATA_INCOMPLETE`, runId);
    requireCheck(firstLine.includes("DATA_INCOMPLETE"), "report.incomplete_header", "DATA_INCOMPLETE on the first report line", firstLine);
    const coverageLine = reportText.split(/\r?\n/).find((line) => line.includes("coverage=")) ?? "";
    requireCheck(coverageLine.includes("938/962") && coverageLine.includes("97.5%"), "report.incomplete_coverage", "coverage=938/962 (97.5%)", coverageLine || "missing coverage line");
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
): TopMeanNormalizedEvent[] {
    const events: TopMeanNormalizedEvent[] = [];
    for (const [eventId, snapshotMap] of byEvent) {
        const first = snapshotMap.values().next().value as PoolSnapshotRecord | undefined;
        if (!first) continue;
        const rows = [...snapshotMap.values()];
        const baseCandidates = rows
            .map((row): TopMeanBaseCandidate | null => {
                const score = row.activePairCount > 0 ? row.signedVotes / row.activePairCount : null;
                return finite(score) && score > 0 && row.longEligible === true ? { row, score } : null;
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
    return {
        runId,
        meta,
        reportText: args.reportText,
        catalogAssets,
        events: buildNormalizedEvents(byEvent),
        outcomeByKey,
        eventRows: args.archive.eventRows,
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

export function loadNormalizedTopMeanArchiveFromDirectory(ledgerDir: string): TopMeanNormalizedArchive {
    const location = resolveTopMeanArchiveLocation(ledgerDir);
    if (!existsSync(location.runDir)) throw new CheckerFailure("archive.directory", "existing archive directory", location.runId, [], "ARCHIVE FAIL");
    let archive: PoolRuleArchive;
    try {
        archive = loadPoolRuleArchive(location.root, location.runId);
    } catch {
        throw new CheckerFailure("archive.jsonl", "valid archive JSONL and meta", location.runId, [], "ARCHIVE FAIL");
    }
    const reportText = safeArchiveRead(path.join(location.runDir, "report.txt"));
    return normalizeTopMeanArchive({ archive, reportText, runId: location.runId });
}

export function loadCausalTopMeanArchiveFromDirectory(ledgerDir: string): TopMeanCausalArchive {
    const location = resolveTopMeanArchiveLocation(ledgerDir);
    if (!existsSync(location.runDir)) throw new CheckerFailure("archive.directory", "existing archive directory", location.runId, [], "ARCHIVE FAIL");
    const meta = metaRecord(safeJsonRead(path.join(location.runDir, "meta.json")));
    requireCheck(meta.runId === location.runId, "meta.runId_matches_directory", location.runId, String(meta.runId));
    validateResearchContract(meta);
    const catalogAssets = archiveCatalog(meta);
    const snapshots = safeSnapshotRead(path.join(location.runDir, "pool-snapshots.jsonl"));
    const byEvent = validateSnapshotRows(snapshots, catalogAssets);
    return {
        runId: location.runId,
        meta,
        catalogAssets,
        events: buildNormalizedEvents(byEvent),
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

function createReadOnlyProxy<T extends object>(value: T, allowed: readonly string[], label: string): T {
    const allow = new Set(allowed);
    const assertProperty = (property: string | symbol): void => {
        if (typeof property !== "string" || !allow.has(property)) throw new Error(`Rule accessed forbidden ${label} field "${String(property)}".`);
    };
    return new Proxy(value, {
        get(target, property, receiver) {
            assertProperty(property);
            return Reflect.get(target, property, receiver);
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

function candidateProxy(candidate: TopMeanBaseCandidate): TopMeanRuleCandidate {
    const row = candidate.row;
    const causal = Object.fromEntries(TOP_MEAN_RULE_CANDIDATE_FIELDS.map((field) => [field, field === "score" ? candidate.score : row[field]])) as TopMeanRuleCandidate;
    return createReadOnlyProxy(causal, TOP_MEAN_RULE_CANDIDATE_FIELDS, "candidate");
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

function ruleFailure(error: unknown, eventId?: string, asset?: string): never {
    const detail = error instanceof Error ? error.message : String(error);
    throw new CheckerFailure("rule.evaluation", "finite number or boolean result without exception", `${eventId ?? "unknown"}${asset ? `/${asset}` : ""}: ${detail}`, [], "RULE FAIL");
}

function evaluateRuleDecisions(
    events: readonly TopMeanNormalizedEvent[],
    rule: TopMeanRule,
): { kind: "ranking" | "filter" | "none"; decisions: readonly RuleDecision[] } {
    const decisions: RuleDecision[] = [];
    let kind: "ranking" | "filter" | null = null;
    for (const event of events) {
        const candidateResults: Array<{ candidate: TopMeanBaseCandidate; value: number | boolean }> = [];
        let trueCandidateCount = 0;
        for (const candidate of event.baseCandidates) {
            let value: unknown;
            try {
                value = rule(candidateProxy(candidate), eventProxy(event));
            } catch (error) {
                ruleFailure(error, event.eventId, candidate.row.asset);
            }
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
    return { kind: kind ?? "none", decisions };
}

export function evaluateTopMeanRule(args: {
    archive: TopMeanNormalizedArchive;
    window: TopMeanRuleWindow;
    rule: TopMeanRule;
}): TopMeanRuleEvaluation {
    const window = windowSpec(args.window);
    const windowEvents = eventsInWindow(args.archive, window);
    const baseEvents = windowEvents.filter((event) => event.baseCandidates.length >= 2);
    const decisionResult = evaluateRuleDecisions(baseEvents, args.rule);
    const decisions = decisionResult.decisions;
    const kind = decisionResult.kind;
    const completeEvents = baseEvents.filter((event) => outcomeComplete(args.archive, event));
    const completeIds = new Set(completeEvents.map((event) => event.eventId));
    const points: RuleEventPoint[] = [];
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
    const decisionResult = evaluateRuleDecisions(baseEvents, args.rule);
    let selectedEvents = 0;
    let droppedEvents = 0;
    let changedEvents = 0;
    let unchangedEvents = 0;
    for (const decision of decisionResult.decisions) {
        if (!decision.selected) {
            droppedEvents += 1;
            continue;
        }
        selectedEvents += 1;
        if (decision.selected.row.asset === topMeanCandidate(decision.event).row.asset) unchangedEvents += 1;
        else changedEvents += 1;
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
        `candidate keep rate=${(evaluation.candidateKeepRate * 100).toFixed(2)}%`,
        `SCREEN | impact=${impact} thinCutoff=2.00%`,
    ];
    return lines.join("\n") + "\n";
}

function sha256File(filename: string): string {
    return createHash("sha256").update(readFileSync(filename)).digest("hex");
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
    mode: "self-check" | "stats" | "causal-stats" | "screen" | "rule";
    ruleFile?: string;
    window?: TopMeanRuleWindow;
}

const USAGE = [
    "Usage:",
    "  esno scripts/top-mean-rule-checker.ts <ledgerDir> <ruleFile.ts> --window discovery|validation",
    "  esno scripts/top-mean-rule-checker.ts <ledgerDir> --self-check",
    "  esno scripts/top-mean-rule-checker.ts <ledgerDir> --stats --window discovery|validation",
    "  esno scripts/top-mean-rule-checker.ts <ledgerDir> --causal-stats --window discovery",
    "  esno scripts/top-mean-rule-checker.ts <ledgerDir> <ruleFile.ts> --screen --window discovery",
].join("\n");

function parseCli(argv: readonly string[]): CliOptions | "help" {
    if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) return "help";
    let selfCheck = false;
    let stats = false;
    let causalStats = false;
    let screen = false;
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
        } else if (arg === "--screen") {
            if (screen) throw new UsageFailure("duplicate --screen");
            screen = true;
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
    if (selfCheck && stats) throw new UsageFailure("--self-check and --stats are exclusive");
    if ([selfCheck, stats, causalStats, screen].filter(Boolean).length > 1) throw new UsageFailure("checker modes are exclusive");
    if (selfCheck) {
        if (positional.length !== 1 || selectedWindow !== undefined) throw new UsageFailure("self-check mode takes only ledgerDir");
        return { ledgerDir: positional[0]!, mode: "self-check" };
    }
    if (stats) {
        if (positional.length !== 1 || selectedWindow === undefined) throw new UsageFailure("stats mode requires ledgerDir and --window");
        return { ledgerDir: positional[0]!, mode: "stats", window: selectedWindow };
    }
    if (causalStats) {
        if (positional.length !== 1 || selectedWindow !== "discovery") throw new UsageFailure("causal-stats mode requires ledgerDir and --window discovery");
        return { ledgerDir: positional[0]!, mode: "causal-stats", window: selectedWindow };
    }
    if (screen) {
        if (positional.length !== 2 || selectedWindow !== "discovery") throw new UsageFailure("screen mode requires ledgerDir, ruleFile, and --window discovery");
        return { ledgerDir: positional[0]!, ruleFile: positional[1]!, mode: "screen", window: selectedWindow };
    }
    if (positional.length !== 2 || selectedWindow === undefined) throw new UsageFailure("rule mode requires ledgerDir, ruleFile, and --window");
    return { ledgerDir: positional[0]!, mode: "rule", ruleFile: positional[1]!, window: selectedWindow };
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
    if (options.mode === "causal-stats" || options.mode === "screen") {
        let causalArchive: TopMeanCausalArchive;
        try {
            causalArchive = loadCausalTopMeanArchiveFromDirectory(options.ledgerDir);
        } catch (error) {
            process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
            return 1;
        }
        if (options.mode === "causal-stats") {
            const stats = computeTopMeanCausalStats(causalArchive, options.window!);
            process.stdout.write(renderTopMeanCausalStatsReport(causalArchive, stats));
            return 0;
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
        archive = loadNormalizedTopMeanArchiveFromDirectory(options.ledgerDir);
    } catch (error) {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        return 1;
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
