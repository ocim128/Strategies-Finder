import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
    TOP_MEAN_CAUSAL_FEATURE_FIELDS,
    TOP_MEAN_FEATURE_CONTRACT_VERSION,
} from "../batch-backtest/sp500-top-mean-causal-features";
import { tieBreakDigest } from "../batch-backtest/max-active-research-contract";
import { getSelectionRule } from "./registry";
import type {
    SelectionCandidate,
    SelectionEventContext,
    SelectionRegime,
    SelectionRule,
    SelectionRuleParams,
} from "./types";
import type {
    TopMeanCandidateFeatureRow,
    TopMeanCausalFeatureField,
} from "../batch-backtest/sp500-top-mean-causal-features";

const REQUIRED_JSONL_FILES = [
    "pool-snapshots.jsonl",
    "candidate-outcomes.jsonl",
    "events-full.jsonl",
    "candidate-features.jsonl",
] as const;

const OUTCOME_STATUSES = new Set([
    "ok",
    "missing_target",
    "missing_entry",
    "right_censored",
    "invalid_price",
]);

interface ArchiveMeta {
    schema: string;
    runId: string;
    interval: string;
    horizons: number[];
    files: Record<string, string>;
}

interface PoolSnapshotRow {
    eventId: string;
    decisionTimeSec: number;
    interval: string;
    poolVersion: string | null;
    asset: string;
    inPool: boolean;
    activePairCount: number;
    signedVotes: number;
    score: number | null;
    longEligible: boolean;
    shortEligible: boolean;
    ema200Above: boolean;
    breadth: number | null;
    regime: SelectionRegime;
    pair?: string;
}

export interface SelectionOutcome {
    eventId: string;
    decisionTimeSec: number;
    horizonBars: number;
    direction: "long" | "short";
    asset: string;
    inPool: boolean;
    eligible: boolean;
    return: number | null;
    entryTimeSec: number | null;
    exitTimeSec: number | null;
    status: string;
}

export interface SelectionBaselineRow {
    eventId: string;
    decisionTimeSec: number;
    horizonBars: number;
    selector: string;
    direction: "long" | "short";
    asset: string;
    selectedReturn: number;
    controlReturn: number;
}

export interface SelectionArchiveEvent {
    eventId: string;
    decisionTimeSec: number;
    interval: string;
    candidates: readonly SelectionCandidate[];
}

export interface SelectionArchive {
    runId: string;
    interval: string;
    horizons: readonly number[];
    events: readonly SelectionArchiveEvent[];
    outcomes: Map<string, SelectionOutcome>;
    baselines: Map<string, SelectionBaselineRow>;
}

export interface SelectionPick {
    eventId: string;
    decisionTimeSec: number;
    horizonBars: number;
    asset: string;
    score: number;
    tiedCount: number;
}

export interface SelectionMetric {
    count: number;
    mean: number | null;
    median: number | null;
}

export interface SelectionComparison {
    selected: SelectionMetric;
    benchmark: SelectionMetric;
    delta: SelectionMetric;
}

export interface SelectionAssetFrequency {
    asset: string;
    count: number;
    share: number;
}

export interface SelectionHorizonTally {
    horizonBars: number;
    eventCount: number;
    candidateEvents: number;
    eligibleEvents: number;
    comparisons: {
        topRaw: SelectionComparison;
        topMean: SelectionComparison;
        othersMean: SelectionComparison;
    };
    selectedAssets: SelectionAssetFrequency[];
    dominantAsset: string | null;
    excludingDominant: SelectionComparison | null;
}

export interface SelectionTally {
    runId: string;
    ruleKey: string;
    ruleName: string;
    direction: "long";
    horizons: SelectionHorizonTally[];
    picks: SelectionPick[];
    reportLines: string[];
}

interface EventBuilder {
    eventId: string;
    decisionTimeSec: number;
    interval: string;
    breadth: number | null;
    regime: SelectionRegime;
    assets: Set<string>;
    candidates: SelectionCandidate[];
}

interface Sample {
    pick: SelectionPick;
    selectedReturn: number;
    topRawReturn: number;
    topMeanReturn: number;
    othersMean: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function dataBug(message: string): never {
    throw new Error(`Selection archive data bug: ${message}`);
}

function requiredString(value: unknown, field: string, rowLabel: string): string {
    if (typeof value !== "string" || value.length === 0) dataBug(`${rowLabel}.${field} must be a non-empty string`);
    return value;
}

function requiredFinite(value: unknown, field: string, rowLabel: string): number {
    if (typeof value !== "number" || !Number.isFinite(value)) dataBug(`${rowLabel}.${field} must be finite`);
    return value;
}

function requiredInteger(value: unknown, field: string, rowLabel: string): number {
    const number = requiredFinite(value, field, rowLabel);
    if (!Number.isInteger(number)) dataBug(`${rowLabel}.${field} must be an integer`);
    return number;
}

function requiredBoolean(value: unknown, field: string, rowLabel: string): boolean {
    if (typeof value !== "boolean") dataBug(`${rowLabel}.${field} must be boolean`);
    return value;
}

function nullableFinite(value: unknown, field: string, rowLabel: string): number | null {
    if (value === null) return null;
    return requiredFinite(value, field, rowLabel);
}

function nullableInteger(value: unknown, field: string, rowLabel: string): number | null {
    if (value === null) return null;
    return requiredInteger(value, field, rowLabel);
}

function parseJson(text: string, label: string): unknown {
    try {
        return JSON.parse(text) as unknown;
    } catch {
        dataBug(`${label} is not valid JSON`);
    }
}

function parseJsonl(text: string, filename: string): unknown[] {
    const rows: unknown[] = [];
    const lines = text.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index]!;
        if (line.trim().length === 0) continue;
        rows.push(parseJson(line, `${filename}:${index + 1}`));
    }
    return rows;
}

function parseMeta(text: string, folderPath: string): ArchiveMeta {
    const value = parseJson(text, "meta.json");
    if (!isRecord(value)) dataBug("meta.json must contain an object");
    const schema = requiredString(value.schema, "schema", "meta.json");
    if (schema !== "top_mean_archive.v3") dataBug(`meta.json.schema must be top_mean_archive.v3, got ${schema}`);
    const runId = requiredString(value.runId, "runId", "meta.json");
    if (runId !== path.basename(folderPath)) dataBug(`meta.json.runId ${runId} does not match folder ${path.basename(folderPath)}`);
    const interval = requiredString(value.interval, "interval", "meta.json");
    if (!Array.isArray(value.horizons) || value.horizons.length === 0) dataBug("meta.json.horizons must be a non-empty array");
    const horizons = value.horizons.map((horizon, index) => {
        const parsed = requiredInteger(horizon, `horizons[${index}]`, "meta.json");
        if (parsed <= 0) dataBug(`meta.json.horizons[${index}] must be positive`);
        return parsed;
    });
    if (new Set(horizons).size !== horizons.length) dataBug("meta.json.horizons must be unique");
    if (isRecord(value.featureSet) && value.featureSet.contractVersion !== undefined && value.featureSet.contractVersion !== TOP_MEAN_FEATURE_CONTRACT_VERSION) {
        dataBug(`meta.json.featureSet.contractVersion must be ${TOP_MEAN_FEATURE_CONTRACT_VERSION}, got ${String(value.featureSet.contractVersion)}`);
    }
    if (!isRecord(value.files)) dataBug("meta.json.files must be an object");
    const files: Record<string, string> = {};
    for (const [filename, hash] of Object.entries(value.files)) {
        if (typeof hash !== "string" || !/^[0-9a-f]{64}$/i.test(hash)) dataBug(`meta.json.files.${filename} must be a SHA-256 hash`);
        if (path.basename(filename) !== filename) dataBug(`meta.json.files contains unsafe filename ${filename}`);
        files[filename] = hash.toLowerCase();
    }
    for (const filename of REQUIRED_JSONL_FILES) {
        if (!(filename in files)) dataBug(`meta.json.files is missing ${filename}`);
    }
    return { schema, runId, interval, horizons, files };
}

function verifyJsonlFiles(folderPath: string, meta: ArchiveMeta): Map<string, string> {
    const captured = new Map<string, string>();
    for (const [filename, expectedHash] of Object.entries(meta.files)) {
        if (!filename.endsWith(".jsonl")) continue;
        const filePath = path.join(folderPath, filename);
        let bytes: Buffer;
        try {
            bytes = readFileSync(filePath);
        } catch {
            dataBug(`cannot read ${filename}`);
        }
        const actualHash = createHash("sha256").update(bytes).digest("hex");
        if (actualHash !== expectedHash) dataBug(`${filename} SHA-256 mismatch: expected ${expectedHash}, got ${actualHash}`);
        if ((REQUIRED_JSONL_FILES as readonly string[]).includes(filename)) captured.set(filename, bytes.toString("utf8"));
    }
    return captured;
}

function parsePoolRows(rows: readonly unknown[], meta: ArchiveMeta): {
    events: Map<string, EventBuilder>;
    assetsByEvent: Map<string, Set<string>>;
} {
    const events = new Map<string, EventBuilder>();
    const assetsByEvent = new Map<string, Set<string>>();
    const seen = new Set<string>();
    for (let index = 0; index < rows.length; index += 1) {
        const value = rows[index];
        const label = `pool-snapshots.jsonl:${index + 1}`;
        if (!isRecord(value)) dataBug(`${label} must contain an object`);
        const row: PoolSnapshotRow = {
            eventId: requiredString(value.eventId, "eventId", label),
            decisionTimeSec: requiredInteger(value.decisionTimeSec, "decisionTimeSec", label),
            interval: requiredString(value.interval, "interval", label),
            poolVersion: value.poolVersion === null ? null : requiredString(value.poolVersion, "poolVersion", label),
            asset: requiredString(value.asset, "asset", label),
            inPool: requiredBoolean(value.inPool, "inPool", label),
            activePairCount: requiredInteger(value.activePairCount, "activePairCount", label),
            signedVotes: requiredInteger(value.signedVotes, "signedVotes", label),
            score: nullableFinite(value.score, "score", label),
            longEligible: requiredBoolean(value.longEligible, "longEligible", label),
            shortEligible: requiredBoolean(value.shortEligible, "shortEligible", label),
            ema200Above: requiredBoolean(value.ema200Above, "ema200Above", label),
            breadth: nullableFinite(value.breadth, "breadth", label),
            regime: value.regime === "bullish" || value.regime === "bearish" || value.regime === "unavailable"
                ? value.regime
                : dataBug(`${label}.regime must be bullish, bearish, or unavailable`),
            pair: typeof value.pair === "string" ? value.pair : undefined,
        };
        if (row.activePairCount < 0) dataBug(`${label}.activePairCount must be non-negative`);
        const expectedScore = row.activePairCount > 0 ? row.signedVotes / row.activePairCount : null;
        if (expectedScore === null ? row.score !== null : row.score === null || Math.abs(row.score - expectedScore) > 1e-12) {
            dataBug(`${label}.score does not equal signedVotes / activePairCount`);
        }
        if (row.interval !== meta.interval) dataBug(`${label}.interval does not match meta.json.interval`);
        const key = `${row.eventId}|${row.asset}`;
        if (seen.has(key)) dataBug(`duplicate pool snapshot ${key}`);
        seen.add(key);
        let event = events.get(row.eventId);
        if (!event) {
            event = {
                eventId: row.eventId,
                decisionTimeSec: row.decisionTimeSec,
                interval: row.interval,
                breadth: row.breadth,
                regime: row.regime,
                assets: new Set<string>(),
                candidates: [],
            };
            events.set(row.eventId, event);
            assetsByEvent.set(row.eventId, event.assets);
        } else if (
            event.decisionTimeSec !== row.decisionTimeSec
            || event.interval !== row.interval
            || event.breadth !== row.breadth
            || event.regime !== row.regime
        ) {
            dataBug(`conflicting event context for ${row.eventId}`);
        }
        event.assets.add(row.asset);
        if (row.signedVotes > 0) {
            event.candidates.push({
                asset: row.asset,
                pair: row.pair ?? null,
                score: row.score,
                signedVotes: row.signedVotes,
                activePairCount: row.activePairCount,
                ema200Above: row.ema200Above,
                breadth: row.breadth,
                regime: row.regime,
                longEligible: row.longEligible,
                shortEligible: row.shortEligible,
                inPool: row.inPool,
                priorCoverageSlope5: null,
                priorSignedVoteDelta3: null,
                priorScoreStdDev5: null,
                priorTopMeanReturnMean3: null,
            });
        }
    }
    return { events, assetsByEvent };
}

function parseFeatureRows(
    rows: readonly unknown[],
    events: ReadonlyMap<string, EventBuilder>,
): Map<string, TopMeanCandidateFeatureRow> {
    const features = new Map<string, TopMeanCandidateFeatureRow>();
    for (let index = 0; index < rows.length; index += 1) {
        const value = rows[index];
        const label = `candidate-features.jsonl:${index + 1}`;
        if (!isRecord(value)) dataBug(`${label} must contain an object`);
        const eventId = requiredString(value.eventId, "eventId", label);
        const event = events.get(eventId);
        if (!event) dataBug(`${label}.eventId ${eventId} does not join pool-snapshots.jsonl`);
        const asset = requiredString(value.asset, "asset", label);
        if (!event.assets.has(asset)) dataBug(`${label}.asset ${asset} does not join pool-snapshots.jsonl event ${eventId}`);
        const decisionTimeSec = requiredInteger(value.decisionTimeSec, "decisionTimeSec", label);
        if (decisionTimeSec !== event.decisionTimeSec) dataBug(`${label}.decisionTimeSec does not join event ${eventId}`);
        const featureValues = {} as Record<TopMeanCausalFeatureField, number | null>;
        for (const field of TOP_MEAN_CAUSAL_FEATURE_FIELDS) {
            featureValues[field] = nullableFinite(value[field], field, label);
        }
        const row: TopMeanCandidateFeatureRow = { eventId, decisionTimeSec, asset, ...featureValues };
        const key = `${eventId}|${asset}`;
        if (features.has(key)) dataBug(`duplicate candidate feature ${key}`);
        features.set(key, row);
    }
    for (const event of events.values()) {
        for (const asset of event.assets) {
            if (!features.has(`${event.eventId}|${asset}`)) dataBug(`missing candidate feature ${event.eventId}|${asset}`);
        }
    }
    return features;
}

function attachCandidateFeatures(
    events: ReadonlyMap<string, EventBuilder>,
    features: ReadonlyMap<string, TopMeanCandidateFeatureRow>,
): void {
    for (const event of events.values()) {
        for (const candidate of event.candidates) {
            const feature = features.get(`${event.eventId}|${candidate.asset}`);
            if (!feature) dataBug(`missing candidate feature ${event.eventId}|${candidate.asset}`);
            for (const field of TOP_MEAN_CAUSAL_FEATURE_FIELDS) candidate[field] = feature[field];
        }
    }
}

function outcomeKey(eventId: string, horizonBars: number, direction: string, asset: string): string {
    return JSON.stringify([eventId, horizonBars, direction, asset]);
}

function baselineKey(eventId: string, horizonBars: number, selector: string, direction: string): string {
    return JSON.stringify([eventId, horizonBars, selector, direction]);
}

function parseOutcomeRows(
    rows: readonly unknown[],
    events: ReadonlyMap<string, EventBuilder>,
    assetsByEvent: ReadonlyMap<string, Set<string>>,
    meta: ArchiveMeta,
): Map<string, SelectionOutcome> {
    const outcomes = new Map<string, SelectionOutcome>();
    for (let index = 0; index < rows.length; index += 1) {
        const value = rows[index];
        const label = `candidate-outcomes.jsonl:${index + 1}`;
        if (!isRecord(value)) dataBug(`${label} must contain an object`);
        const eventId = requiredString(value.eventId, "eventId", label);
        const event = events.get(eventId);
        if (!event) dataBug(`${label}.eventId ${eventId} does not join pool-snapshots.jsonl`);
        const decisionTimeSec = requiredInteger(value.decisionTimeSec, "decisionTimeSec", label);
        if (decisionTimeSec !== event.decisionTimeSec) dataBug(`${label}.decisionTimeSec does not join event ${eventId}`);
        const horizonBars = requiredInteger(value.horizonBars, "horizonBars", label);
        if (!meta.horizons.includes(horizonBars)) dataBug(`${label}.horizonBars ${horizonBars} is not in meta.json.horizons`);
        const direction = value.direction === "long" || value.direction === "short"
            ? value.direction
            : dataBug(`${label}.direction must be long or short`);
        const asset = requiredString(value.asset, "asset", label);
        if (!assetsByEvent.get(eventId)!.has(asset)) dataBug(`${label}.asset ${asset} does not join event ${eventId}`);
        const status = requiredString(value.status, "status", label);
        if (!OUTCOME_STATUSES.has(status)) dataBug(`${label}.status ${status} is not recognized`);
        const row: SelectionOutcome = {
            eventId,
            decisionTimeSec,
            horizonBars,
            direction,
            asset,
            inPool: requiredBoolean(value.inPool, "inPool", label),
            eligible: requiredBoolean(value.eligible, "eligible", label),
            return: nullableFinite(value.return, "return", label),
            entryTimeSec: nullableInteger(value.entryTimeSec, "entryTimeSec", label),
            exitTimeSec: nullableInteger(value.exitTimeSec, "exitTimeSec", label),
            status,
        };
        const key = outcomeKey(eventId, horizonBars, direction, asset);
        if (outcomes.has(key)) dataBug(`duplicate candidate outcome ${key}`);
        outcomes.set(key, row);
    }
    for (const event of events.values()) {
        for (const candidate of event.candidates) {
            for (const horizonBars of meta.horizons) {
                for (const direction of ["long", "short"] as const) {
                    const key = outcomeKey(event.eventId, horizonBars, direction, candidate.asset);
                    if (!outcomes.has(key)) dataBug(`missing candidate outcome ${key}`);
                }
            }
        }
    }
    return outcomes;
}

function parseBaselineRows(
    rows: readonly unknown[],
    events: ReadonlyMap<string, EventBuilder>,
    assetsByEvent: ReadonlyMap<string, Set<string>>,
    meta: ArchiveMeta,
): Map<string, SelectionBaselineRow> {
    const baselines = new Map<string, SelectionBaselineRow>();
    for (let index = 0; index < rows.length; index += 1) {
        const value = rows[index];
        const label = `events-full.jsonl:${index + 1}`;
        if (!isRecord(value)) dataBug(`${label} must contain an object`);
        const eventId = requiredString(value.eventId, "eventId", label);
        const event = events.get(eventId);
        if (!event) dataBug(`${label}.eventId ${eventId} does not join pool-snapshots.jsonl`);
        const decisionTimeSec = requiredInteger(value.decisionTime, "decisionTime", label);
        if (decisionTimeSec !== event.decisionTimeSec) dataBug(`${label}.decisionTime does not join event ${eventId}`);
        const horizonBars = requiredInteger(value.horizonBars, "horizonBars", label);
        if (!meta.horizons.includes(horizonBars)) dataBug(`${label}.horizonBars ${horizonBars} is not in meta.json.horizons`);
        const selector = requiredString(value.selector, "selector", label);
        const direction = value.direction === "long" || value.direction === "short"
            ? value.direction
            : dataBug(`${label}.direction must be long or short`);
        const asset = requiredString(value.asset, "asset", label);
        if (!assetsByEvent.get(eventId)!.has(asset)) dataBug(`${label}.asset ${asset} does not join event ${eventId}`);
        const row: SelectionBaselineRow = {
            eventId,
            decisionTimeSec,
            horizonBars,
            selector,
            direction,
            asset,
            selectedReturn: requiredFinite(value.selectedReturn, "selectedReturn", label),
            controlReturn: requiredFinite(value.controlReturn, "controlReturn", label),
        };
        const key = baselineKey(eventId, horizonBars, selector, direction);
        if (baselines.has(key)) dataBug(`duplicate archived baseline ${key}`);
        baselines.set(key, row);
    }
    return baselines;
}

export function loadSelectionArchive(folderPath: string): SelectionArchive {
    const resolvedFolderPath = path.resolve(folderPath);
    const metaText = readFileSync(path.join(resolvedFolderPath, "meta.json"), "utf8");
    const meta = parseMeta(metaText, resolvedFolderPath);
    const jsonlTexts = verifyJsonlFiles(resolvedFolderPath, meta);
    const poolText = jsonlTexts.get("pool-snapshots.jsonl");
    const outcomesText = jsonlTexts.get("candidate-outcomes.jsonl");
    const eventsText = jsonlTexts.get("events-full.jsonl");
    const featuresText = jsonlTexts.get("candidate-features.jsonl");
    if (poolText === undefined || outcomesText === undefined || eventsText === undefined || featuresText === undefined) dataBug("required JSONL file was not captured");
    const pool = parsePoolRows(parseJsonl(poolText, "pool-snapshots.jsonl"), meta);
    const features = parseFeatureRows(parseJsonl(featuresText, "candidate-features.jsonl"), pool.events);
    attachCandidateFeatures(pool.events, features);
    const outcomes = parseOutcomeRows(parseJsonl(outcomesText, "candidate-outcomes.jsonl"), pool.events, pool.assetsByEvent, meta);
    const baselines = parseBaselineRows(parseJsonl(eventsText, "events-full.jsonl"), pool.events, pool.assetsByEvent, meta);
    const events = [...pool.events.values()]
        .map((event): SelectionArchiveEvent => ({
            eventId: event.eventId,
            decisionTimeSec: event.decisionTimeSec,
            interval: event.interval,
            candidates: event.candidates.sort((left, right) => left.asset.localeCompare(right.asset)),
        }))
        .sort((left, right) => left.decisionTimeSec - right.decisionTimeSec || left.eventId.localeCompare(right.eventId));
    return { runId: meta.runId, interval: meta.interval, horizons: meta.horizons, events, outcomes, baselines };
}

function runtimeCandidate(candidate: SelectionCandidate): SelectionCandidate {
    return { ...candidate };
}

function runtimeEvent(event: SelectionArchiveEvent, horizonBars: number): SelectionEventContext {
    return {
        eventId: event.eventId,
        decisionTimeSec: event.decisionTimeSec,
        horizonBars,
        interval: event.interval,
    };
}

function compareTie(left: SelectionCandidate, right: SelectionCandidate, decisionTimeSec: number): number {
    const leftDigest = tieBreakDigest(decisionTimeSec, left.asset);
    const rightDigest = tieBreakDigest(decisionTimeSec, right.asset);
    if (leftDigest < rightDigest) return -1;
    if (leftDigest > rightDigest) return 1;
    return left.asset < right.asset ? -1 : left.asset > right.asset ? 1 : 0;
}

export function pickSelectionRule(
    event: SelectionArchiveEvent,
    horizonBars: number,
    rule: SelectionRule,
    params: SelectionRuleParams,
): SelectionPick {
    const candidates = event.candidates.map(runtimeCandidate);
    if (candidates.length === 0) dataBug(`event ${event.eventId} has no positive candidates`);
    const scores = candidates.map((candidate) => {
        const score = rule.score(candidate, runtimeEvent(event, horizonBars), params, candidates);
        if (typeof score !== "number" || Number.isNaN(score)) throw new Error(`Selection rule ${rule.key} returned an invalid score for ${event.eventId}/${candidate.asset}`);
        return score;
    });
    let maxScore = scores[0]!;
    for (let index = 1; index < scores.length; index += 1) {
        if (scores[index]! > maxScore) maxScore = scores[index]!;
    }
    const tied = candidates.filter((_candidate, index) => scores[index] === maxScore);
    let winner = tied[0]!;
    for (let index = 1; index < tied.length; index += 1) {
        if (compareTie(tied[index]!, winner, event.decisionTimeSec) < 0) winner = tied[index]!;
    }
    return {
        eventId: event.eventId,
        decisionTimeSec: event.decisionTimeSec,
        horizonBars,
        asset: winner.asset,
        score: maxScore,
        tiedCount: tied.length,
    };
}

function metric(values: readonly number[]): SelectionMetric {
    if (values.length === 0) return { count: 0, mean: null, median: null };
    const sorted = [...values].sort((left, right) => left - right);
    const middle = sorted.length >> 1;
    const median = sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
    return {
        count: values.length,
        mean: values.reduce((sum, value) => sum + value, 0) / values.length,
        median,
    };
}

function comparison(selected: readonly number[], benchmark: readonly number[]): SelectionComparison {
    if (selected.length !== benchmark.length) dataBug("comparison series have different lengths");
    const deltas = selected.map((value, index) => value - benchmark[index]!);
    return { selected: metric(selected), benchmark: metric(benchmark), delta: metric(deltas) };
}

function comparisonForSamples(samples: readonly Sample[]): {
    topRaw: SelectionComparison;
    topMean: SelectionComparison;
    othersMean: SelectionComparison;
} {
    const selected = samples.map((sample) => sample.selectedReturn);
    return {
        topRaw: comparison(selected, samples.map((sample) => sample.topRawReturn)),
        topMean: comparison(selected, samples.map((sample) => sample.topMeanReturn)),
        othersMean: comparison(selected, samples.map((sample) => sample.othersMean)),
    };
}

function makeAssetFrequencies(samples: readonly Sample[]): SelectionAssetFrequency[] {
    const counts = new Map<string, number>();
    for (const sample of samples) counts.set(sample.pick.asset, (counts.get(sample.pick.asset) ?? 0) + 1);
    return [...counts.entries()]
        .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
        .map(([asset, count]) => ({ asset, count, share: count / samples.length }));
}

function horizonTally(
    archive: SelectionArchive,
    rule: SelectionRule,
    params: SelectionRuleParams,
    horizonBars: number,
): { tally: SelectionHorizonTally; picks: SelectionPick[] } {
    const samples: Sample[] = [];
    const picks: SelectionPick[] = [];
    let candidateEvents = 0;
    for (const event of archive.events) {
        if (event.candidates.length < 2) continue;
        candidateEvents += 1;
        const positiveReturns: number[] = [];
        let eligible = true;
        for (const candidate of event.candidates) {
            const longOutcome = archive.outcomes.get(outcomeKey(event.eventId, horizonBars, "long", candidate.asset));
            const shortOutcome = archive.outcomes.get(outcomeKey(event.eventId, horizonBars, "short", candidate.asset));
            if (!longOutcome || !shortOutcome) dataBug(`unjoinable outcome for ${event.eventId}/${candidate.asset}/${horizonBars}`);
            if (!Number.isFinite(longOutcome.return) || !Number.isFinite(shortOutcome.return)) eligible = false;
            positiveReturns.push(longOutcome.return ?? Number.NaN);
        }
        if (!eligible) continue;
        const pick = pickSelectionRule(event, horizonBars, rule, params);
        const selectedOutcome = archive.outcomes.get(outcomeKey(event.eventId, horizonBars, "long", pick.asset));
        if (!selectedOutcome || !Number.isFinite(selectedOutcome.return)) dataBug(`selected outcome missing for ${event.eventId}/${pick.asset}/${horizonBars}`);
        const topRaw = archive.baselines.get(baselineKey(event.eventId, horizonBars, "TOP_RAW", "long"));
        const topMean = archive.baselines.get(baselineKey(event.eventId, horizonBars, "TOP_MEAN", "long"));
        if (!topRaw || !topMean) dataBug(`archived TOP_RAW/TOP_MEAN baseline missing for ${event.eventId}/${horizonBars}/long`);
        const selectedReturn = selectedOutcome.return!;
        const othersMean = (positiveReturns.reduce((sum, value) => sum + value, 0) - selectedReturn) / (positiveReturns.length - 1);
        picks.push(pick);
        samples.push({ pick, selectedReturn, topRawReturn: topRaw.selectedReturn, topMeanReturn: topMean.selectedReturn, othersMean });
    }
    const selectedAssets = makeAssetFrequencies(samples);
    const dominantAsset = selectedAssets[0]?.asset ?? null;
    const excludingDominant = dominantAsset === null
        ? null
        : comparisonForSamples(samples.filter((sample) => sample.pick.asset !== dominantAsset)).othersMean;
    return {
        tally: {
            horizonBars,
            eventCount: archive.events.length,
            candidateEvents,
            eligibleEvents: samples.length,
            comparisons: comparisonForSamples(samples),
            selectedAssets,
            dominantAsset,
            excludingDominant,
        },
        picks,
    };
}

function formatPercent(value: number | null): string {
    if (value === null) return "n/a";
    return `${value >= 0 ? "+" : ""}${(value * 100).toFixed(2)}%`;
}

function formatComparison(label: string, value: SelectionComparison): string {
    return `${label} selected(mean/median)=${formatPercent(value.selected.mean)}/${formatPercent(value.selected.median)} benchmark(mean/median)=${formatPercent(value.benchmark.mean)}/${formatPercent(value.benchmark.median)} delta(mean/median)=${formatPercent(value.delta.mean)}/${formatPercent(value.delta.median)}`;
}

function reportForHorizon(ruleName: string, tally: SelectionHorizonTally): string[] {
    const lines = [
        `horizon=${tally.horizonBars} candidateEvents=${tally.candidateEvents} eligibleEvents=${tally.eligibleEvents}`,
        `${ruleName} h=${tally.horizonBars} n=${tally.eligibleEvents} ${formatComparison("vs TOP_RAW", tally.comparisons.topRaw)} | ${formatComparison("vs TOP_MEAN", tally.comparisons.topMean)} | ${formatComparison("vs OTHERS_MEAN", tally.comparisons.othersMean)}`,
        `${ruleName} selected assets = ${tally.selectedAssets.map((entry) => `${entry.asset}:n=${entry.count},share=${(entry.share * 100).toFixed(1)}%`).join(" | ") || "none"}`,
    ];
    if (tally.dominantAsset !== null && tally.excludingDominant !== null) {
        lines.push(`${ruleName}_EX_${tally.dominantAsset} h=${tally.horizonBars} n=${tally.excludingDominant.selected.count} ${formatComparison("vs OTHERS_MEAN", tally.excludingDominant)}`);
    }
    return lines;
}

export function tallySelectionRule(
    archive: SelectionArchive,
    ruleOrKey: SelectionRule | string,
    suppliedParams?: SelectionRuleParams,
): SelectionTally {
    const rule = typeof ruleOrKey === "string" ? getSelectionRule(ruleOrKey) : ruleOrKey;
    if (!rule) throw new Error(`Unknown selection rule: ${String(ruleOrKey)}`);
    const rawParams = suppliedParams === undefined ? rule.defaultParams : { ...suppliedParams };
    const params = rule.normalizeParams ? rule.normalizeParams(rawParams) : rawParams;
    const horizonResults = archive.horizons.map((horizonBars) => horizonTally(archive, rule, params, horizonBars));
    const horizons = horizonResults.map((result) => result.tally);
    const picks = horizonResults.flatMap((result) => result.picks);
    const reportLines = [
        `selection rule=${rule.name} key=${rule.key} run=${archive.runId} interval=${archive.interval} direction=long events=${archive.events.length}`,
        ...horizons.flatMap((horizon) => reportForHorizon(rule.name, horizon)),
    ];
    return { runId: archive.runId, ruleKey: rule.key, ruleName: rule.name, direction: "long", horizons, picks, reportLines };
}
