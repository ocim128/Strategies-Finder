import {
    TRADE_LEDGER_FEATURE_VERSION,
    TRADE_LEDGER_VERSION,
} from "../batch-backtest/trade-ledger-schema";
import { tieBreakDigest } from "../batch-backtest/max-active-research-contract";
import { loadLedgerForReplay } from "../batch-backtest/trade-ledger-replay-loader";
import {
    comparison,
    formatPercentagePoints,
    type SelectionComparison,
} from "../selection-metrics";
import { getPairSelectionRule } from "./registry";
import { reference_alphabetical, reference_loudest_atr } from "./references";
import type {
    PairCandidate,
    PairEventContext,
    PairSelectionRule,
    PairSelectionRuleParams,
} from "./types";

export interface PairSelectionEvent {
    context: PairEventContext;
    candidates: readonly PairCandidate[];
}

export interface PairSelectionArchive {
    runId: string;
    interval: string;
    strategyKey: string;
    ledgerHorizons: readonly number[];
    events: readonly PairSelectionEvent[];
    /** Private-to-the-harness outcomes; never passed to a rule. */
    horizonReturns: ReadonlyMap<string, number | null>;
    diagnostics: PairSelectionArchiveDiagnostics;
}

export interface PairSelectionArchiveDiagnostics {
    loadWallMs: number;
    rowsParsed: number;
    jsonParseMs: number;
    streamWallMs: number;
    readResidualMs: number;
    rows: number;
    events: number;
    candidates: number;
}

export interface PairSelectionPick {
    signalTime: number;
    pair: string;
    baseSymbol: string;
    quoteSymbol: string;
    direction: PairCandidate["direction"];
    score: number;
    tiedCount: number;
}

export interface PairSelectionFrequency {
    value: string;
    count: number;
    share: number;
}

export interface PairSelectionComparisons {
    othersMean: SelectionComparison;
    referenceAlphabetical: SelectionComparison;
    referenceLoudestAtr: SelectionComparison;
}

export interface PairSelectionTally {
    eventCount: number;
    candidateEvents: number;
    eligibleEvents: number;
    comparisons: PairSelectionComparisons;
    selectedPairs: PairSelectionFrequency[];
    selectedBaseLegs: PairSelectionFrequency[];
    selectedQuoteLegs: PairSelectionFrequency[];
    dominantPair: string | null;
    dominantBaseLeg: string | null;
    dominantQuoteLeg: string | null;
    excludingDominantPair: PairSelectionComparisons | null;
}

export interface PairSelectionResult {
    runId: string;
    ruleKey: string;
    ruleName: string;
    tally: PairSelectionTally;
    picks: PairSelectionPick[];
    reportLines: string[];
    diagnostics: PairSelectionTallyDiagnostics;
}

export interface PairSelectionTallyDiagnostics {
    gateMs: number;
    scoreMs: number;
    refsMs: number;
    freqMs: number;
    scoredCandidates: number;
}

function nowMs(): number {
    return typeof performance !== "undefined" ? performance.now() : Date.now();
}

interface ValidatedRow {
    candidate: PairCandidate;
    horizonReturns: ReadonlyMap<string, number | null>;
}

interface PairSample {
    pick: PairSelectionPick;
    selectedReturn: number;
    alphabeticalReturn: number;
    loudestAtrReturn: number;
    othersMean: number;
}

interface IndexedPick {
    pick: PairSelectionPick;
    candidateIndex: number;
}

interface ArchiveDerivedCache {
    referencePicks: readonly {
        alphabetical: IndexedPick;
        loudestAtr: IndexedPick;
    }[];
    horizonReturns: Map<number, readonly (readonly (number | null)[])[]>;
}

const archiveDerivedCache = new WeakMap<PairSelectionArchive, ArchiveDerivedCache>();

function dataBug(message: string): never {
    throw new Error(`Pair-selection ledger data bug: ${message}`);
}

function isFiniteNumber(value: number | null): value is number {
    return value !== null && Number.isFinite(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(row: Record<string, unknown>, field: string): boolean {
    return Object.prototype.hasOwnProperty.call(row, field);
}

function requiredString(row: Record<string, unknown>, field: string, label: string): string {
    if (!hasOwn(row, field) || typeof row[field] !== "string" || row[field]!.length === 0) {
        dataBug(`${label}.${field} must be a non-empty string`);
    }
    return row[field] as string;
}

function requiredFinite(row: Record<string, unknown>, field: string, label: string): number {
    if (!hasOwn(row, field) || typeof row[field] !== "number" || !Number.isFinite(row[field])) {
        dataBug(`${label}.${field} must be finite`);
    }
    return row[field] as number;
}

function requiredInteger(row: Record<string, unknown>, field: string, label: string): number {
    const value = requiredFinite(row, field, label);
    if (!Number.isInteger(value)) dataBug(`${label}.${field} must be an integer`);
    return value;
}

function requiredBoolean(row: Record<string, unknown>, field: string, label: string): boolean {
    if (!hasOwn(row, field) || typeof row[field] !== "boolean") dataBug(`${label}.${field} must be boolean`);
    return row[field] as boolean;
}

function nullableFinite(row: Record<string, unknown>, field: string, label: string): number | null {
    if (!hasOwn(row, field)) dataBug(`${label}.${field} is missing`);
    const value = row[field];
    if (value === null) return null;
    if (typeof value !== "number" || !Number.isFinite(value)) dataBug(`${label}.${field} must be finite or null`);
    return value;
}

function nullableString(row: Record<string, unknown>, field: string, label: string): string | null {
    if (!hasOwn(row, field)) dataBug(`${label}.${field} is missing`);
    const value = row[field];
    if (value === null) return null;
    if (typeof value !== "string") dataBug(`${label}.${field} must be a string or null`);
    return value;
}

function candidateKey(signalTime: number, pair: string, direction: string): string {
    return JSON.stringify([signalTime, pair, direction]);
}

function horizonKey(horizonBars: number, signalTime: number, pair: string, direction: string): string {
    return JSON.stringify([horizonBars, signalTime, pair, direction]);
}

function validateHorizonOutcomes(value: unknown, label: string): ReadonlyMap<string, number | null> {
    if (!isRecord(value)) dataBug(`${label}.horizons must be an object`);
    const outcomes = new Map<string, number | null>();
    for (const [key, rawOutcome] of Object.entries(value)) {
        const horizon = Number(key);
        if (!Number.isInteger(horizon) || horizon <= 0) dataBug(`${label}.horizons has invalid horizon key ${key}`);
        if (!isRecord(rawOutcome)) dataBug(`${label}.horizons.${key} must be an object`);
        const status = requiredString(rawOutcome, "status", `${label}.horizons.${key}`);
        if (status !== "ok" && status !== "right_censored") {
            dataBug(`${label}.horizons.${key}.status must be ok or right_censored`);
        }
        const entryTimeSec = nullableFinite(rawOutcome, "entryTimeSec", `${label}.horizons.${key}`);
        const entryPrice = nullableFinite(rawOutcome, "entryPrice", `${label}.horizons.${key}`);
        const exitTimeSec = nullableFinite(rawOutcome, "exitTimeSec", `${label}.horizons.${key}`);
        const exitPrice = nullableFinite(rawOutcome, "exitPrice", `${label}.horizons.${key}`);
        if (!hasOwn(rawOutcome, "pnlPercent")) dataBug(`${label}.horizons.${key}.pnlPercent is missing`);
        const pnl = rawOutcome.pnlPercent;
        if (status === "right_censored") {
            if (pnl !== null) dataBug(`${label}.horizons.${key}.right_censored pnlPercent must be null`);
            if (exitTimeSec !== null || exitPrice !== null) dataBug(`${label}.horizons.${key}.right_censored exit fields must be null`);
            outcomes.set(key, null);
        } else {
            if (entryTimeSec === null || entryPrice === null || exitTimeSec === null || exitPrice === null) {
                dataBug(`${label}.horizons.${key}.ok entry and exit fields must be finite`);
            }
            if (typeof pnl !== "number" || !Number.isFinite(pnl)) {
                dataBug(`${label}.horizons.${key}.ok pnlPercent must be finite`);
            }
            outcomes.set(key, pnl);
        }
    }
    return outcomes;
}

function validateLedgerRow(value: unknown, index: number): ValidatedRow {
    const label = `ledger.jsonl:${index + 1}`;
    if (!isRecord(value)) dataBug(`${label} must contain an object`);
    const ledgerVersion = requiredInteger(value, "ledgerVersion", label);
    if (ledgerVersion !== TRADE_LEDGER_VERSION) dataBug(`${label}.ledgerVersion must be ${TRADE_LEDGER_VERSION}`);
    const directionValue = requiredString(value, "direction", label);
    if (directionValue !== "long" && directionValue !== "short") dataBug(`${label}.direction must be long or short`);
    const direction = directionValue as "long" | "short";
    if (!hasOwn(value, "horizons")) dataBug(`${label}.horizons is missing`);
    const horizonReturns = validateHorizonOutcomes(value.horizons, label);
    const featureFields = [
        "feat_entryRangePosition",
        "feat_atrPct",
        "feat_return20",
        "feat_gapPct",
        "feat_dow",
        "feat_hour",
        "feat_pairWinRatePrior",
        "feat_barsSincePairLastFire",
        "feat_pairSpreadVolatility20",
        "feat_legVolatilityRatio20",
        "feat_candidatesAtTime",
    ] as const;
    const features = Object.fromEntries(featureFields.map((field) => [field, nullableFinite(value, field, label)])) as Record<typeof featureFields[number], number | null>;
    const pair = requiredString(value, "pair", label);
    const baseSymbol = requiredString(value, "baseSymbol", label);
    const quoteSymbol = requiredString(value, "quoteSymbol", label);
    const signalTime = requiredInteger(value, "signalTime", label);
    const signalBarIndex = requiredInteger(value, "signalBarIndex", label);
    nullableFinite(value, "fillTime", label);
    nullableFinite(value, "fillPrice", label);
    requiredBoolean(value, "executed", label);
    nullableString(value, "notExecutedReason", label);
    const pairTradesPrior = requiredFinite(value, "feat_pairTradesPrior", label);
    if (!Number.isInteger(pairTradesPrior) || pairTradesPrior < 0) dataBug(`${label}.feat_pairTradesPrior must be a non-negative integer`);
    return {
        candidate: {
            pair,
            baseSymbol,
            quoteSymbol,
            direction,
            signalTime,
            signalBarIndex,
            feat_entryRangePosition: features.feat_entryRangePosition,
            feat_atrPct: features.feat_atrPct,
            feat_return20: features.feat_return20,
            feat_gapPct: features.feat_gapPct,
            feat_dow: features.feat_dow,
            feat_hour: features.feat_hour,
            feat_pairWinRatePrior: features.feat_pairWinRatePrior,
            feat_pairTradesPrior: pairTradesPrior,
            feat_barsSincePairLastFire: features.feat_barsSincePairLastFire,
            feat_pairSpreadVolatility20: features.feat_pairSpreadVolatility20,
            feat_legVolatilityRatio20: features.feat_legVolatilityRatio20,
            feat_candidatesAtTime: features.feat_candidatesAtTime,
        },
        horizonReturns,
    };
}

function compareCandidates(left: PairCandidate, right: PairCandidate): number {
    return left.pair < right.pair ? -1
        : left.pair > right.pair ? 1
        : left.direction < right.direction ? -1
        : left.direction > right.direction ? 1
        : 0;
}

export async function loadPairSelectionArchive(folderPath: string): Promise<PairSelectionArchive> {
    const loadStartedAt = nowMs();
    const loaded = await loadLedgerForReplay(folderPath);
    if (loaded.provenance.ledgerVersion !== TRADE_LEDGER_VERSION) {
        throw new Error(
            `Pair selection requires ledgerVersion ${TRADE_LEDGER_VERSION}; folder has ${String(loaded.provenance.ledgerVersion)}. Re-run the batch.`,
        );
    }
    if (loaded.provenance.featureVersion !== TRADE_LEDGER_FEATURE_VERSION) {
        throw new Error(
            `Pair selection requires ledger featureVersion ${TRADE_LEDGER_FEATURE_VERSION}; `
            + `folder has ${String(loaded.provenance.featureVersion)}. Re-run the batch to create a v3 ledger.`,
        );
    }
    const ledgerHorizons = loaded.provenance.ledgerHorizons;
    if (
        !Array.isArray(ledgerHorizons)
        || ledgerHorizons.length === 0
        || ledgerHorizons.some((value) => !Number.isInteger(value) || value <= 0)
        || new Set(ledgerHorizons).size !== ledgerHorizons.length
    ) {
        throw new Error("Pair selection requires provenance.ledgerHorizons; re-run the batch to create a v3 ledger.");
    }
    const groups = new Map<number, { candidates: PairCandidate[] }>();
    const horizonReturns = new Map<string, number | null>();
    const seen = new Set<string>();
    for (let index = 0; index < loaded.rows.length; index += 1) {
        const validated = validateLedgerRow(loaded.rows[index], index);
        const candidate = validated.candidate;
        const key = candidateKey(candidate.signalTime, candidate.pair, candidate.direction);
        if (seen.has(key)) dataBug(`duplicate candidate ${key}`);
        seen.add(key);
        let group = groups.get(candidate.signalTime);
        if (!group) {
            group = { candidates: [] };
            groups.set(candidate.signalTime, group);
        }
        group.candidates.push(candidate);
        for (const [horizon, value] of validated.horizonReturns) {
            horizonReturns.set(horizonKey(Number(horizon), candidate.signalTime, candidate.pair, candidate.direction), value);
        }
    }
    const events = [...groups.entries()]
        .sort(([left], [right]) => left - right)
        .map(([signalTime, group]): PairSelectionEvent => ({
            context: {
                signalTime,
                interval: loaded.provenance.interval,
                strategyKey: loaded.provenance.strategyKey,
            },
            candidates: group.candidates.sort(compareCandidates),
        }));
    const candidates = events.reduce((sum, event) => sum + event.candidates.length, 0);
    return {
        runId: loaded.provenance.runId,
        interval: loaded.provenance.interval,
        strategyKey: loaded.provenance.strategyKey,
        ledgerHorizons: [...ledgerHorizons],
        events,
        horizonReturns,
        diagnostics: {
            loadWallMs: nowMs() - loadStartedAt,
            rowsParsed: loaded.diagnostics.ledger.rowsParsed,
            jsonParseMs: loaded.diagnostics.ledger.jsonParseMs,
            streamWallMs: loaded.diagnostics.ledger.streamWallMs,
            readResidualMs: loaded.diagnostics.ledger.readResidualMs,
            rows: loaded.rows.length,
            events: events.length,
            candidates,
        },
    };
}

export function resolvePairSelectionHorizon(archive: PairSelectionArchive, requested?: number): number {
    const horizonBars = requested ?? archive.ledgerHorizons[0];
    if (!Number.isInteger(horizonBars) || horizonBars <= 0 || !archive.ledgerHorizons.includes(horizonBars)) {
        throw new Error(
            `Pair selection horizon ${String(horizonBars)} is not present in folder provenance (available: ${archive.ledgerHorizons.join(", ")}).`,
        );
    }
    return horizonBars;
}

function cloneCandidate(candidate: PairCandidate): PairCandidate {
    return { ...candidate };
}

function defaultTieBreak(left: PairCandidate, right: PairCandidate, event: PairEventContext): number {
    const leftDigest = tieBreakDigest(event.signalTime, `${left.pair}|${left.direction}`);
    const rightDigest = tieBreakDigest(event.signalTime, `${right.pair}|${right.direction}`);
    if (leftDigest < rightDigest) return -1;
    if (leftDigest > rightDigest) return 1;
    return compareCandidates(left, right);
}

export function pickPairSelectionRule(
    event: PairSelectionEvent,
    rule: PairSelectionRule,
    params: PairSelectionRuleParams,
): PairSelectionPick {
    return pickPairSelectionRuleIndexed(event, rule, params).pick;
}

function pickPairSelectionRuleIndexed(
    event: PairSelectionEvent,
    rule: PairSelectionRule,
    params: PairSelectionRuleParams,
): IndexedPick {
    if (event.candidates.length === 0) dataBug(`event ${event.context.signalTime} has no candidates`);
    const pool = event.candidates.map(cloneCandidate);
    const scores = pool.map((candidate) => {
        const score = rule.score(candidate, { ...event.context }, params, pool);
        if (typeof score !== "number" || Number.isNaN(score)) {
            throw new Error(`Pair-selection rule ${rule.key} returned an invalid score for ${event.context.signalTime}/${candidate.pair}/${candidate.direction}`);
        }
        return score;
    });
    let maxScore = scores[0]!;
    let winnerIndex = 0;
    let tiedCount = 1;
    const compareTie = rule.tieBreak ?? defaultTieBreak;
    for (let index = 1; index < pool.length; index += 1) {
        const score = scores[index]!;
        if (score > maxScore) {
            maxScore = score;
            winnerIndex = index;
            tiedCount = 1;
        } else if (score === maxScore) {
            tiedCount += 1;
            if (compareTie(pool[index]!, pool[winnerIndex]!, event.context) < 0) winnerIndex = index;
        }
    }
    const winner = pool[winnerIndex]!;
    return {
        pick: {
            signalTime: event.context.signalTime,
            pair: winner.pair,
            baseSymbol: winner.baseSymbol,
            quoteSymbol: winner.quoteSymbol,
            direction: winner.direction,
            score: maxScore,
            tiedCount,
        },
        candidateIndex: winnerIndex,
    };
}

function getArchiveDerivedCache(archive: PairSelectionArchive): ArchiveDerivedCache {
    const existing = archiveDerivedCache.get(archive);
    if (existing) return existing;
    const created: ArchiveDerivedCache = {
        referencePicks: archive.events.map((event) => ({
            alphabetical: pickPairSelectionRuleIndexed(event, reference_alphabetical, {}),
            loudestAtr: pickPairSelectionRuleIndexed(event, reference_loudest_atr, {}),
        })),
        horizonReturns: new Map(),
    };
    archiveDerivedCache.set(archive, created);
    return created;
}

function getHorizonReturns(
    archive: PairSelectionArchive,
    horizonBars: number,
): readonly (readonly (number | null)[])[] {
    const cache = getArchiveDerivedCache(archive);
    const existing = cache.horizonReturns.get(horizonBars);
    if (existing) return existing;
    const values = archive.events.map((event) => {
        // Preserve the original strict gate: single-candidate events never
        // require an outcome lookup because they cannot become samples.
        if (event.candidates.length < 2) return [];
        return event.candidates.map((candidate) => {
            const key = horizonKey(horizonBars, event.context.signalTime, candidate.pair, candidate.direction);
            if (!archive.horizonReturns.has(key)) {
                dataBug(`horizon outcome is unjoinable for ${event.context.signalTime}/${candidate.pair}/${candidate.direction} at ${horizonBars} bars`);
            }
            return archive.horizonReturns.get(key)!;
        });
    });
    cache.horizonReturns.set(horizonBars, values);
    return values;
}

function comparisonForSamples(samples: readonly PairSample[]): PairSelectionComparisons {
    const selected = samples.map((sample) => sample.selectedReturn);
    return {
        othersMean: comparison(selected, samples.map((sample) => sample.othersMean)),
        referenceAlphabetical: comparison(selected, samples.map((sample) => sample.alphabeticalReturn)),
        referenceLoudestAtr: comparison(selected, samples.map((sample) => sample.loudestAtrReturn)),
    };
}

function makeFrequencies(values: readonly string[]): PairSelectionFrequency[] {
    const counts = new Map<string, number>();
    for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
    return [...counts.entries()]
        .sort((left, right) => right[1] - left[1] || (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0))
        .map(([value, count]) => ({ value, count, share: values.length > 0 ? count / values.length : 0 }));
}

function formatComparison(label: string, value: SelectionComparison): string {
    return `${label} selected(mean/median)=${formatPercentagePoints(value.selected.mean)}/${formatPercentagePoints(value.selected.median)}`
        + ` benchmark(mean/median)=${formatPercentagePoints(value.benchmark.mean)}/${formatPercentagePoints(value.benchmark.median)}`
        + ` delta_pp(mean/median)=${formatPercentagePoints(value.delta.mean)}/${formatPercentagePoints(value.delta.median)}`;
}

function frequencyLine(label: string, values: readonly PairSelectionFrequency[]): string {
    return `${label} = ${values.map((entry) => `${entry.value}:n=${entry.count},share=${(entry.share * 100).toFixed(1)}%`).join(" | ") || "none"}`;
}

function buildReportLines(
    archive: PairSelectionArchive,
    rule: PairSelectionRule,
    tally: PairSelectionTally,
    horizonBars: number,
): string[] {
    const lines = [
        `pair-selection rule=${rule.name} key=${rule.key} run=${archive.runId} strategyKey=${archive.strategyKey} interval=${archive.interval} horizonBars=${horizonBars} events=${tally.eventCount}`,
        `candidateEvents=${tally.candidateEvents} eligibleEvents=${tally.eligibleEvents}`,
        `${rule.name} n=${tally.eligibleEvents} ${formatComparison("vs OTHERS_MEAN", tally.comparisons.othersMean)}`,
        `${rule.name} n=${tally.eligibleEvents} ${formatComparison("vs reference_alphabetical", tally.comparisons.referenceAlphabetical)}`,
        `${rule.name} n=${tally.eligibleEvents} ${formatComparison("vs reference_loudest_atr", tally.comparisons.referenceLoudestAtr)}`,
        frequencyLine(`${rule.name} selected PAIR`, tally.selectedPairs),
        frequencyLine(`${rule.name} selected BASE`, tally.selectedBaseLegs),
        frequencyLine(`${rule.name} selected QUOTE`, tally.selectedQuoteLegs),
        `${rule.name} dominant BASE=${tally.dominantBaseLeg ?? "none"} share=${tally.selectedBaseLegs[0] ? `${(tally.selectedBaseLegs[0].share * 100).toFixed(1)}%` : "n/a"}`,
        `${rule.name} dominant QUOTE=${tally.dominantQuoteLeg ?? "none"} share=${tally.selectedQuoteLegs[0] ? `${(tally.selectedQuoteLegs[0].share * 100).toFixed(1)}%` : "n/a"}`,
    ];
    if (tally.dominantPair !== null && tally.excludingDominantPair !== null) {
        lines.push(`${rule.name}_EX_${tally.dominantPair} n=${tally.excludingDominantPair.othersMean.selected.count} ${formatComparison("vs OTHERS_MEAN", tally.excludingDominantPair.othersMean)}`);
        lines.push(`${rule.name}_EX_${tally.dominantPair} n=${tally.excludingDominantPair.referenceAlphabetical.selected.count} ${formatComparison("vs reference_alphabetical", tally.excludingDominantPair.referenceAlphabetical)}`);
        lines.push(`${rule.name}_EX_${tally.dominantPair} n=${tally.excludingDominantPair.referenceLoudestAtr.selected.count} ${formatComparison("vs reference_loudest_atr", tally.excludingDominantPair.referenceLoudestAtr)}`);
    }
    return lines;
}

export function tallyPairSelectionRule(
    archive: PairSelectionArchive,
    ruleOrKey: PairSelectionRule | string,
    suppliedParams?: PairSelectionRuleParams,
    requestedHorizonBars?: number,
): PairSelectionResult {
    const rule = typeof ruleOrKey === "string" ? getPairSelectionRule(ruleOrKey) : ruleOrKey;
    if (!rule) throw new Error(`Unknown pair-selection rule: ${String(ruleOrKey)}`);
    const horizonBars = resolvePairSelectionHorizon(archive, requestedHorizonBars);
    const rawParams = suppliedParams === undefined ? rule.defaultParams : { ...suppliedParams };
    const params = rule.normalizeParams ? rule.normalizeParams(rawParams) : rawParams;
    const samples: PairSample[] = [];
    const picks: PairSelectionPick[] = [];
    let candidateEvents = 0;
    const diagnostics: PairSelectionTallyDiagnostics = {
        gateMs: 0,
        scoreMs: 0,
        refsMs: 0,
        freqMs: 0,
        scoredCandidates: 0,
    };
    const refsStartedAt = nowMs();
    const derived = getArchiveDerivedCache(archive);
    diagnostics.refsMs += nowMs() - refsStartedAt;
    const returnsByEvent = getHorizonReturns(archive, horizonBars);
    for (let eventIndex = 0; eventIndex < archive.events.length; eventIndex += 1) {
        const event = archive.events[eventIndex]!;
        const gateStartedAt = nowMs();
        if (event.candidates.length < 2) {
            diagnostics.gateMs += nowMs() - gateStartedAt;
            continue;
        }
        candidateEvents += 1;
        const returns = returnsByEvent[eventIndex]!;
        const finiteReturns: number[] = [];
        for (const value of returns) {
            if (isFiniteNumber(value)) finiteReturns.push(value);
        }
        diagnostics.gateMs += nowMs() - gateStartedAt;
        if (finiteReturns.length !== returns.length) continue;
        const scoreStartedAt = nowMs();
        const indexedPick = pickPairSelectionRuleIndexed(event, rule, params);
        const pick = indexedPick.pick;
        diagnostics.scoreMs += nowMs() - scoreStartedAt;
        const references = derived.referencePicks[eventIndex]!;
        diagnostics.scoredCandidates += event.candidates.length * 3;
        const selectedReturn = returns[indexedPick.candidateIndex];
        const alphabeticalReturn = returns[references.alphabetical.candidateIndex];
        const loudestAtrReturn = returns[references.loudestAtr.candidateIndex];
        if (!isFiniteNumber(selectedReturn) || !isFiniteNumber(alphabeticalReturn) || !isFiniteNumber(loudestAtrReturn)) {
            dataBug(`selected candidate outcome missing for ${event.context.signalTime}`);
        }
        const totalReturn = finiteReturns.reduce((sum, value) => sum + value, 0);
        const othersMean = (totalReturn - selectedReturn) / (returns.length - 1);
        picks.push(pick);
        samples.push({
            pick,
            selectedReturn,
            alphabeticalReturn,
            loudestAtrReturn,
            othersMean,
        });
    }
    const freqStartedAt = nowMs();
    const selectedPairs = makeFrequencies(samples.map((sample) => sample.pick.pair));
    const selectedBaseLegs = makeFrequencies(samples.map((sample) => sample.pick.baseSymbol));
    const selectedQuoteLegs = makeFrequencies(samples.map((sample) => sample.pick.quoteSymbol));
    const dominantPair = selectedPairs[0]?.value ?? null;
    const excludingDominantPair = dominantPair === null
        ? null
        : comparisonForSamples(samples.filter((sample) => sample.pick.pair !== dominantPair));
    const comparisons = comparisonForSamples(samples);
    diagnostics.freqMs += nowMs() - freqStartedAt;
    const tally: PairSelectionTally = {
        eventCount: archive.events.length,
        candidateEvents,
        eligibleEvents: samples.length,
        comparisons,
        selectedPairs,
        selectedBaseLegs,
        selectedQuoteLegs,
        dominantPair,
        dominantBaseLeg: selectedBaseLegs[0]?.value ?? null,
        dominantQuoteLeg: selectedQuoteLegs[0]?.value ?? null,
        excludingDominantPair,
    };
    return {
        runId: archive.runId,
        ruleKey: rule.key,
        ruleName: rule.name,
        tally,
        picks,
        reportLines: buildReportLines(archive, rule, tally, horizonBars),
        diagnostics,
    };
}
