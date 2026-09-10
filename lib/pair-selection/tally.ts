import {
    TRADE_LEDGER_VERSION,
} from "../batch-backtest/trade-ledger-schema";
import { tieBreakDigest } from "../batch-backtest/max-active-research-contract";
import { loadLedgerForReplay } from "../batch-backtest/trade-ledger-replay-loader";
import type { LedgerReplayProgress } from "../batch-backtest/trade-ledger-replay-loader";
import {
    PAIR_HORIZON_OUTCOMES_CAPABILITY,
    resolvePairFeatureCompatibility,
} from "../pair-features/compatibility";
import type { PairFeatureCompatibilityResult } from "../pair-features/types";
import {
    comparison,
    formatPercentagePoints,
    metric,
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
import type { ActivePairFeatures } from "./feature-access";

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
    consumeMs: number;
    rankRowsParsed: number;
    rankJsonParseMs: number;
    rankStreamWallMs: number;
    rankReadResidualMs: number;
    rankJoinMs: number;
    rankJoinFused: boolean;
    ranksLoaded: boolean;
    rows: number;
    events: number;
    candidates: number;
}

export interface LoadPairSelectionArchiveOptions {
    /**
     * Menu runs select one horizon. When supplied, validate every horizon
     * field but retain only this horizon's outcome keys in the archive.
     * Omitting the option preserves the CLI/all-horizons behavior.
     */
    retainHorizonBars?: number;
    /** Set false when none of the selected rules reads rank features. */
    includeSignalRanks?: boolean;
    /** Called periodically while the ledger or rank sidecar is being read. */
    onProgress?: (progress: LedgerReplayProgress) => void;
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
    unscoredEvents: number;
}

/**
 * Detail-only tail probe budget: the most recent multi-candidate events the
 * harness may score to answer "what is the rule currently selecting?" when
 * the strict outcome gate omitted them. Gated history is never rescored
 * beyond this window and probe work never touches the summary counters.
 */
export const SELECTION_RULES_DETAIL_PENDING_PROBE_MAX_EVENTS = 64;

export type PairSelectionDetailStatus = "COMPLETE" | "SELECTED_OUTCOME_KNOWN_POOL_INCOMPLETE" | "PENDING";

/** One compact per-event selection row; the archive keeps horizon PnL only. */
export interface PairSelectionDetailRow {
    signalTime: number;
    pair: string;
    baseSymbol: string;
    quoteSymbol: string;
    direction: PairCandidate["direction"];
    score: number;
    tiedCount: number;
    candidateCount: number;
    status: PairSelectionDetailStatus;
    selectedReturn: number | null;
    othersMean: number | null;
    delta: number | null;
}

export interface PairSelectionDetailPairPerformance {
    pair: string;
    direction: PairCandidate["direction"];
    selectedCount: number;
    completedCount: number;
    wins: number;
    winRate: number | null;
    meanSelectedReturn: number | null;
    medianSelectedReturn: number | null;
    meanDelta: number | null;
}

export interface PairSelectionDetailProbe {
    eventsScanned: number;
    scoredCandidates: number;
}

/**
 * Separate detail payload handed to an optional sink; never attached to
 * {@link PairSelectionResult}, stream events, status snapshots, or receipts.
 */
export interface PairSelectionRuleDetail {
    latest: PairSelectionDetailRow | null;
    /** Chronological (oldest → newest); probe rows, when present, follow completed rows. */
    history: PairSelectionDetailRow[];
    pairPerformance: PairSelectionDetailPairPerformance[];
    probe: PairSelectionDetailProbe;
}

function nowMs(): number {
    return typeof performance !== "undefined" ? performance.now() : Date.now();
}

interface ValidatedRow {
    candidate: PairCandidate;
    horizonReturns: ReadonlyMap<string, number | null>;
}

const PRIVATE_ROW_ORDINAL = Symbol("pairSelectionLedgerRowOrdinal");
type ArchivedCandidate = PairCandidate & { [PRIVATE_ROW_ORDINAL]?: number };

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
    referencePicks: readonly ({
        alphabetical: IndexedPick | null;
        loudestAtr: IndexedPick | null;
    })[];
    horizonReturns: Map<number, readonly (readonly (number | null)[])[]>;
}

const archiveDerivedCache = new WeakMap<PairSelectionArchive, ArchiveDerivedCache>();
const archiveCompatibility = new WeakMap<PairSelectionArchive, PairFeatureCompatibilityResult>();

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
    return `${signalTime}\u0000${pair.length}:${pair}\u0000${direction}`;
}

function horizonKey(horizonBars: number, signalTime: number, pair: string, direction: string): string {
    return JSON.stringify([horizonBars, signalTime, pair, direction]);
}

function validateHorizonOutcomes(
    value: unknown,
    label: string,
    retainHorizonBars?: number,
): ReadonlyMap<string, number | null> {
    if (!isRecord(value)) dataBug(`${label}.horizons must be an object`);
    const outcomes = new Map<string, number | null>();
    for (const key in value) {
        if (!hasOwn(value, key)) continue;
        const rawOutcome = value[key];
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
            if (retainHorizonBars === undefined || retainHorizonBars === horizon) outcomes.set(key, null);
        } else {
            if (entryTimeSec === null || entryPrice === null || exitTimeSec === null || exitPrice === null) {
                dataBug(`${label}.horizons.${key}.ok entry and exit fields must be finite`);
            }
            if (typeof pnl !== "number" || !Number.isFinite(pnl)) {
                dataBug(`${label}.horizons.${key}.ok pnlPercent must be finite`);
            }
            if (retainHorizonBars === undefined || retainHorizonBars === horizon) outcomes.set(key, pnl);
        }
    }
    return outcomes;
}

function validateLedgerRow(value: unknown, index: number, retainHorizonBars?: number): ValidatedRow {
    const label = `ledger.jsonl:${index + 1}`;
    if (!isRecord(value)) dataBug(`${label} must contain an object`);
    const ledgerVersion = requiredInteger(value, "ledgerVersion", label);
    if (ledgerVersion !== TRADE_LEDGER_VERSION) dataBug(`${label}.ledgerVersion must be ${TRADE_LEDGER_VERSION}`);
    const directionValue = requiredString(value, "direction", label);
    if (directionValue !== "long" && directionValue !== "short") dataBug(`${label}.direction must be long or short`);
    const direction = directionValue as "long" | "short";
    if (!hasOwn(value, "horizons")) dataBug(`${label}.horizons is missing`);
    const horizonReturns = validateHorizonOutcomes(value.horizons, label, retainHorizonBars);
    const feat_entryRangePosition = nullableFinite(value, "feat_entryRangePosition", label);
    const feat_atrPct = nullableFinite(value, "feat_atrPct", label);
    const feat_return20 = nullableFinite(value, "feat_return20", label);
    const feat_gapPct = nullableFinite(value, "feat_gapPct", label);
    const feat_dow = nullableFinite(value, "feat_dow", label);
    const feat_hour = nullableFinite(value, "feat_hour", label);
    const feat_pairWinRatePrior = nullableFinite(value, "feat_pairWinRatePrior", label);
    const feat_barsSincePairLastFire = nullableFinite(value, "feat_barsSincePairLastFire", label);
    const feat_pairSpreadVolatility20 = nullableFinite(value, "feat_pairSpreadVolatility20", label);
    const feat_legVolatilityRatio20 = nullableFinite(value, "feat_legVolatilityRatio20", label);
    const feat_candidatesAtTime = nullableFinite(value, "feat_candidatesAtTime", label);
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
            feat_entryRangePosition,
            feat_atrPct,
            feat_return20,
            feat_gapPct,
            feat_dow,
            feat_hour,
            feat_pairWinRatePrior,
            feat_pairTradesPrior: pairTradesPrior,
            feat_barsSincePairLastFire,
            feat_pairSpreadVolatility20,
            feat_legVolatilityRatio20,
            feat_candidatesAtTime,
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

function validatePairSelectionProvenance(provenance: { ledgerVersion: unknown; featureVersion?: unknown; ledgerHorizons?: unknown }): PairFeatureCompatibilityResult {
    const compatibility = resolvePairFeatureCompatibility({
        ledgerVersion: provenance.ledgerVersion,
        featureVersion: provenance.featureVersion,
        requiredCapabilities: [PAIR_HORIZON_OUTCOMES_CAPABILITY],
    });
    if (!compatibility.supported) throw new Error(compatibility.message ?? "Pair selection provenance is unsupported.");
    const ledgerHorizons = provenance.ledgerHorizons;
    if (
        !Array.isArray(ledgerHorizons)
        || ledgerHorizons.length === 0
        || ledgerHorizons.some((value) => !Number.isInteger(value) || value <= 0)
        || new Set(ledgerHorizons).size !== ledgerHorizons.length
    ) {
        throw new Error("Pair selection requires provenance.ledgerHorizons; re-run the batch to create a v3 ledger.");
    }
    return compatibility;
}

export async function loadPairSelectionArchive(
    folderPath: string,
    options: LoadPairSelectionArchiveOptions = {},
): Promise<PairSelectionArchive> {
    if (
        options.retainHorizonBars !== undefined
        && (!Number.isInteger(options.retainHorizonBars) || options.retainHorizonBars <= 0)
    ) {
        throw new Error("retainHorizonBars must be a positive integer when supplied.");
    }
    const loadStartedAt = nowMs();
    const groups = new Map<number, { candidates: ArchivedCandidate[] }>();
    const horizonReturns = new Map<string, number | null>();
    const seen = new Set<string>();
    let rows = 0;
    let compatibility: PairFeatureCompatibilityResult | null = null;
    const loaded = await loadLedgerForReplay(folderPath, {
        includeSignalRanks: options.includeSignalRanks,
        onProgress: options.onProgress,
        validateProvenance: (provenance) => {
            compatibility = validatePairSelectionProvenance(provenance);
        },
        onLedgerRow: (value) => {
            const validated = validateLedgerRow(value, rows, options.retainHorizonBars);
            const candidate = validated.candidate as ArchivedCandidate;
            // Keep the ordinal private without copying and deleting a symbol
            // on every scoring pass (which deoptimizes the candidate shape).
            Object.defineProperty(candidate, PRIVATE_ROW_ORDINAL, { value: rows });
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
            rows += 1;
        },
    });
    const ledgerHorizons = loaded.provenance.ledgerHorizons!;
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
    const archive: PairSelectionArchive = {
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
            consumeMs: loaded.diagnostics.ledger.consumeMs,
            rankRowsParsed: loaded.diagnostics.ranks.rowsParsed,
            rankJsonParseMs: loaded.diagnostics.ranks.jsonParseMs,
            rankStreamWallMs: loaded.diagnostics.ranks.streamWallMs,
            rankReadResidualMs: loaded.diagnostics.ranks.readResidualMs,
            rankJoinMs: loaded.diagnostics.rankJoinMs,
            rankJoinFused: loaded.diagnostics.rankJoinFused,
            ranksLoaded: options.includeSignalRanks !== false && loaded.diagnostics.ranks.rowsParsed > 0,
            rows,
            events: events.length,
            candidates,
        },
    };
    if (compatibility === null) throw new Error("Pair selection compatibility was not resolved before loading the ledger.");
    archiveCompatibility.set(archive, compatibility);
    return archive;
}

function validateRuleFeatureRequirements(archive: PairSelectionArchive, rule: PairSelectionRule, activeFeatures?: ActivePairFeatures): void {
    const requirements = rule.metadata?.featureRequirements;
    if (!requirements) return;
    if (activeFeatures) {
        if (activeFeatures.ruleKey !== rule.key) throw new Error(`Pair features activated for ${activeFeatures.ruleKey}, not ${rule.key}.`);
        return;
    }
    const compatibility = archiveCompatibility.get(archive);
    if (!compatibility) {
        throw new Error(`Pair-selection rule ${rule.name} (${rule.key}) cannot validate its feature requirements.`);
    }
    const decision = resolvePairFeatureCompatibility({
        ledgerVersion: compatibility.ledgerVersion,
        featureVersion: compatibility.featureVersion,
        requiredCapabilities: requirements.columns,
    });
    if (!decision.supported) {
        throw new Error(
            `Pair-selection rule ${rule.name} (${rule.key}) requires unavailable capability `
            + `${decision.missingCapabilities.join(", ")}. ${decision.message ?? "Prepare the required feature pack."}`,
        );
    }
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

function cloneCandidate(candidate: PairCandidate, activeFeatures?: ActivePairFeatures): PairCandidate {
    const archived = candidate as ArchivedCandidate;
    const cloned = { ...archived } as ArchivedCandidate;
    const ordinal = archived[PRIVATE_ROW_ORDINAL];
    if (activeFeatures) {
        if (ordinal === undefined) dataBug(`candidate ${candidate.pair} has no private ledger row ordinal`);
        Object.assign(cloned, activeFeatures.readCandidateFeatures(ordinal));
    }
    return cloned;
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
    activeFeatures?: ActivePairFeatures,
): PairSelectionPick {
    const indexed = pickPairSelectionRuleIndexed(event, rule, params, activeFeatures);
    if (indexed === null) {
        throw new Error(`Pair-selection rule ${rule.key} has no eligible candidate for ${event.context.signalTime}.`);
    }
    return indexed.pick;
}

function pickPairSelectionRuleIndexed(
    event: PairSelectionEvent,
    rule: PairSelectionRule,
    params: PairSelectionRuleParams,
    activeFeatures?: ActivePairFeatures,
    copyCandidates = true,
): IndexedPick | null {
    if (event.candidates.length === 0) dataBug(`event ${event.context.signalTime} has no candidates`);
    const pool = copyCandidates
        ? event.candidates.map((candidate) => cloneCandidate(candidate, activeFeatures))
        : event.candidates;
    let maxScore = Number.NEGATIVE_INFINITY;
    let winnerIndex = -1;
    let tiedCount = 0;
    const compareTie = rule.tieBreak ?? defaultTieBreak;
    for (let index = 0; index < pool.length; index += 1) {
        const candidate = pool[index]!;
        const score = rule.score(candidate, { ...event.context }, params, pool);
        if (typeof score !== "number" || (score !== Number.NEGATIVE_INFINITY && !Number.isFinite(score))) {
            throw new Error(`Pair-selection rule ${rule.key} returned an invalid score for ${event.context.signalTime}/${candidate.pair}/${candidate.direction}`);
        }
        if (score === Number.NEGATIVE_INFINITY) continue;
        if (score > maxScore) {
            maxScore = score;
            winnerIndex = index;
            tiedCount = 1;
        } else if (score === maxScore) {
            tiedCount += 1;
            if (compareTie(pool[index]!, pool[winnerIndex]!, event.context) < 0) winnerIndex = index;
        }
    }
    if (winnerIndex < 0) return null;
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
            // These fixed references only read candidates; user rules still
            // receive isolated copies, including their complete event pool.
            alphabetical: pickPairSelectionRuleIndexed(event, reference_alphabetical, {}, undefined, false),
            loudestAtr: pickPairSelectionRuleIndexed(event, reference_loudest_atr, {}, undefined, false),
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

function buildDetailRow(
    event: PairSelectionEvent,
    indexed: IndexedPick,
    returns: readonly (number | null)[],
): PairSelectionDetailRow {
    const pick = indexed.pick;
    const selectedReturn = returns[indexed.candidateIndex] ?? null;
    const poolComplete = returns.length === event.candidates.length && returns.every(isFiniteNumber);
    const selectedKnown = isFiniteNumber(selectedReturn);
    let othersMean: number | null = null;
    if (poolComplete && selectedKnown) {
        const totalReturn = returns.reduce((sum, value) => sum + (value as number), 0);
        othersMean = (totalReturn - (selectedReturn as number)) / (returns.length - 1);
    }
    const status: PairSelectionDetailStatus = !selectedKnown
        ? "PENDING"
        : poolComplete ? "COMPLETE" : "SELECTED_OUTCOME_KNOWN_POOL_INCOMPLETE";
    return {
        signalTime: event.context.signalTime,
        pair: pick.pair,
        baseSymbol: pick.baseSymbol,
        quoteSymbol: pick.quoteSymbol,
        direction: pick.direction,
        score: pick.score,
        tiedCount: pick.tiedCount,
        candidateCount: event.candidates.length,
        status,
        selectedReturn: selectedKnown ? selectedReturn : null,
        othersMean,
        delta: othersMean === null ? null : (selectedReturn as number) - othersMean,
    };
}

/**
 * Detail-only backward probe for current selections. Walks the archive tail
 * over at most SELECTION_RULES_DETAIL_PENDING_PROBE_MAX_EVENTS
 * multi-candidate events, scoring each once and retaining every pick found in
 * that bounded window. Single-candidate events are skipped entirely; probe
 * work never touches picks, samples, diagnostics, comparisons, or report
 * lines.
 */
function probeLatestDetailRows(
    archive: PairSelectionArchive,
    rule: PairSelectionRule,
    params: PairSelectionRuleParams,
    horizonBars: number,
    activeFeatures: ActivePairFeatures | undefined,
    newestSampleEventIndex: number,
): { rows: PairSelectionDetailRow[]; eventsScanned: number; scoredCandidates: number } {
    let eventsScanned = 0;
    let scoredCandidates = 0;
    const rows: PairSelectionDetailRow[] = [];
    for (let index = archive.events.length - 1; index > newestSampleEventIndex; index -= 1) {
        const event = archive.events[index]!;
        if (event.candidates.length < 2) continue;
        if (eventsScanned >= SELECTION_RULES_DETAIL_PENDING_PROBE_MAX_EVENTS) {
            return { rows, eventsScanned, scoredCandidates };
        }
        eventsScanned += 1;
        const indexed = pickPairSelectionRuleIndexed(event, rule, params, activeFeatures);
        scoredCandidates += event.candidates.length;
        if (indexed === null) continue;
        const returns = event.candidates.map((candidate) =>
            archive.horizonReturns.get(horizonKey(horizonBars, event.context.signalTime, candidate.pair, candidate.direction)) ?? null);
        rows.push(buildDetailRow(event, indexed, returns));
    }
    return { rows, eventsScanned, scoredCandidates };
}

function buildDetailPairPerformance(
    completedRows: readonly PairSelectionDetailRow[],
    probeRows: readonly PairSelectionDetailRow[],
): PairSelectionDetailPairPerformance[] {
    interface DetailGroup {
        pair: string;
        direction: PairCandidate["direction"];
        all: PairSelectionDetailRow[];
        completed: PairSelectionDetailRow[];
    }
    const groups = new Map<string, DetailGroup>();
    for (const row of completedRows) {
        const key = `${row.pair}\u0000${row.direction}`;
        let group = groups.get(key);
        if (!group) {
            group = { pair: row.pair, direction: row.direction, all: [], completed: [] };
            groups.set(key, group);
        }
        group.all.push(row);
        group.completed.push(row);
    }
    for (const probeRow of probeRows) {
        const key = `${probeRow.pair}\u0000${probeRow.direction}`;
        let group = groups.get(key);
        if (!group) {
            group = { pair: probeRow.pair, direction: probeRow.direction, all: [], completed: [] };
            groups.set(key, group);
        }
        // The probe is deliberately detail-only. It may show a known selected
        // return, but it was not admitted to the summary sample set (the
        // probe exists only because the normal gate/reference path did not
        // produce a sample), so it must never affect completed metrics.
        group.all.push(probeRow);
    }
    return [...groups.values()]
        .map((group): PairSelectionDetailPairPerformance => {
            const returns = group.completed.map((row) => row.selectedReturn as number);
            const stats = metric(returns);
            const meanDelta = group.completed.length > 0
                ? group.completed.reduce((sum, row) => sum + (row.delta as number), 0) / group.completed.length
                : null;
            return {
                pair: group.pair,
                direction: group.direction,
                selectedCount: group.all.length,
                completedCount: group.completed.length,
                wins: returns.filter((value) => value > 0).length,
                winRate: group.completed.length > 0 ? returns.filter((value) => value > 0).length / group.completed.length : null,
                meanSelectedReturn: stats.mean,
                medianSelectedReturn: stats.median,
                meanDelta,
            };
        })
        .sort((left, right) =>
            right.selectedCount - left.selectedCount
            || (left.pair < right.pair ? -1 : left.pair > right.pair ? 1 : 0)
            || (left.direction < right.direction ? -1 : left.direction > right.direction ? 1 : 0));
}

function emitPairSelectionDetail(
    archive: PairSelectionArchive,
    rule: PairSelectionRule,
    params: PairSelectionRuleParams,
    horizonBars: number,
    activeFeatures: ActivePairFeatures | undefined,
    detailRows: readonly PairSelectionDetailRow[],
    newestSampleEventIndex: number,
    detailSink: (detail: PairSelectionRuleDetail) => void,
): void {
    const history = [...detailRows];
    const probe = probeLatestDetailRows(archive, rule, params, horizonBars, activeFeatures, newestSampleEventIndex);
    if (probe.rows.length > 0) history.push(...[...probe.rows].reverse());
    detailSink({
        latest: history.length > 0 ? history[history.length - 1]! : null,
        history,
        pairPerformance: buildDetailPairPerformance(detailRows, probe.rows),
        probe: { eventsScanned: probe.eventsScanned, scoredCandidates: probe.scoredCandidates },
    });
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
    activeFeatures?: ActivePairFeatures,
    detailSink?: (detail: PairSelectionRuleDetail) => void,
): PairSelectionResult {
    const rule = typeof ruleOrKey === "string" ? getPairSelectionRule(ruleOrKey) : ruleOrKey;
    if (!rule) throw new Error(`Unknown pair-selection rule: ${String(ruleOrKey)}`);
    validateRuleFeatureRequirements(archive, rule, activeFeatures);
    const horizonBars = resolvePairSelectionHorizon(archive, requestedHorizonBars);
    const rawParams = suppliedParams === undefined ? rule.defaultParams : { ...suppliedParams };
    const params = rule.normalizeParams ? rule.normalizeParams(rawParams) : rawParams;
    const samples: PairSample[] = [];
    const picks: PairSelectionPick[] = [];
    const detailRows: PairSelectionDetailRow[] = [];
    let newestSampleEventIndex = -1;
    let candidateEvents = 0;
    const diagnostics: PairSelectionTallyDiagnostics = {
        gateMs: 0,
        scoreMs: 0,
        refsMs: 0,
        freqMs: 0,
        scoredCandidates: 0,
        unscoredEvents: 0,
    };
    const refsStartedAt = nowMs();
    const derived = getArchiveDerivedCache(archive);
    const returnsByEvent = getHorizonReturns(archive, horizonBars);
    diagnostics.refsMs += nowMs() - refsStartedAt;
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
        const indexedPick = pickPairSelectionRuleIndexed(event, rule, params, activeFeatures);
        diagnostics.scoreMs += nowMs() - scoreStartedAt;
        diagnostics.scoredCandidates += event.candidates.length;
        if (indexedPick === null) {
            diagnostics.unscoredEvents += 1;
            continue;
        }
        const pick = indexedPick.pick;
        const references = derived.referencePicks[eventIndex]!;
        if (references.alphabetical === null || references.loudestAtr === null) {
            diagnostics.unscoredEvents += 1;
            continue;
        }
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
        if (detailSink) {
            newestSampleEventIndex = eventIndex;
            detailRows.push(buildDetailRow(event, indexedPick, returns));
        }
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
    if (detailSink) {
        emitPairSelectionDetail(archive, rule, params, horizonBars, activeFeatures, detailRows, newestSampleEventIndex, detailSink);
    }
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
