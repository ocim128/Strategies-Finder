/**
 * Replay stage 3 — candidate construction and post-outcome selection.
 *
 * buildCandidateViews: per decision event, builds the ordinary / profit-gated /
 * causal / confidence-weighted positive pools, resolves TOP_* picks with the
 * versioned FNV-1a tie-break digest, maintains the strict-past TOP_Z Welford
 * history, and captures profit-only events (no ordinary pool).
 *
 * buildAssetSwitchDecisions: resolves the enabled switch arms in one pass per
 * event and retains only their decisions for the path-dependent replay.
 *
 * buildOutcomeRequests: groups requested event indexes by asset so each target
 * dataset is loaded once, consumed, and released.
 *
 * selectAfterOutcomes: rebuilds the views once target datasets have been
 * inspected (a gapped asset leaves the selector pool instead of invalidating
 * the event), resolves inverted BOT_* picks, and builds the latest-event
 * selector picks for the completed-run UI.
 *
 * Ranking helpers never inspect future return values; tie digests, ordering,
 * and the no-gap fast path (which shares the original view references) are
 * behavior contracts — see the comments at each helper.
 */
import { tieBreakDigest } from "../max-active-research-contract";
import type { OpenScoreUsdLatestSelection, OpenScoreUsdLatestSelectionCandidate, OpenScoreUsdLatestSelections, OpenScoreUsdLatestSelectorName } from "./types";
import type { AssetSwitchDecision, BotViewPicks, Candidate, DecisionEvent, EventView, ProfitOnlyEvent, ReplayArmSelectionMap, ReplayPhaseCallback, StageOutcome } from "./internal-types";
import { REPLAY_ARM_FIELDS, replayArmFields, isCausalArm, CAUSAL_ARM_FIELDS, type CausalArmField } from "./arm-contract";
import type { ReplayArmField } from "./arm-contract";
import { yieldLoop } from "./runtime";
import type { RankingEvent, RankingPick } from "./internal-types";

export const causalCandidatePool = (pool: readonly Candidate[], field: CausalArmField): Candidate[] => pool.filter((candidate) => typeof candidate[field] === "number" && Number.isFinite(candidate[field]));

export const RANKING_ARM_SPECS = REPLAY_ARM_FIELDS.map((field) => ({
    field,
    pool: (field.includes("ProfitNowConf") ? "profitNowConfidencePositives"
        : field.includes("ProfitNow") || field === "topZ" || field === "botZ" ? "profitNowPositives"
        : field.includes("Profit") ? "profitPositives" : "positives") as "positives" | "profitPositives" | "profitNowPositives" | "profitNowConfidencePositives",
    key: (isCausalArm(field) ? field : field === "topZ" || field === "botZ" ? "z" : field.includes("Mean") ? "mean" : "raw") as "raw" | "mean" | "z" | CausalArmField,
    direction: field.startsWith("bot") ? 1 : -1,
    unique: field.endsWith("RawUnique"),
}));

/** Bounded insertion retains membership using the existing digest, never outcomes. */
export function insertRankingPick(picks: RankingPick[], candidate: Candidate, spec: typeof RANKING_ARM_SPECS[number], time: number, names: readonly string[], digestFor?: (index: number) => string): void {
    if (isCausalArm(spec.field) && !Number.isFinite(candidate[spec.field])) return;
    const row = { assetIndex: candidate.assetIndex, key: spec.key === "z" ? candidate.z ?? 0 : candidate[spec.key]!, secondary: spec.unique ? candidate.raw : 0 };
    const compare = (a: RankingPick, b: RankingPick): number => {
        const score = spec.direction * (a.key - b.key || a.secondary - b.secondary);
        if (score) return score;
        const ad = digestFor?.(a.assetIndex) ?? tieBreakDigest(time, names[a.assetIndex]!);
        const bd = digestFor?.(b.assetIndex) ?? tieBreakDigest(time, names[b.assetIndex]!);
        return ad.localeCompare(bd) || names[a.assetIndex]!.localeCompare(names[b.assetIndex]!);
    };
    let index = 0;
    while (index < picks.length && compare(picks[index]!, row) <= 0) index += 1;
    if (index < 5) { picks.splice(index, 0, row); if (picks.length > 5) picks.pop(); }
}

export function captureRankingEvent(timeSec: number, pools: Partial<Record<typeof RANKING_ARM_SPECS[number]["pool"], readonly Candidate[]>>, assetNames: readonly string[], enabled = false): RankingEvent {
    const arms = {} as RankingEvent["arms"];
    const digests = new Map<number, string>();
    const digestFor = (index: number): string => {
        let digest = digests.get(index);
        if (digest === undefined) { digest = tieBreakDigest(timeSec, assetNames[index]!); digests.set(index, digest); }
        return digest;
    };
    for (const spec of RANKING_ARM_SPECS.filter((spec) => enabled || !isCausalArm(spec.field))) {
        const picks: RankingPick[] = [];
        for (const candidate of pools[spec.pool] ?? []) insertRankingPick(picks, candidate, spec, timeSec, assetNames, digestFor);
        arms[spec.field] = { picks, ...(picks.length < 5 ? { reason: "small_pool" as const }
            : spec.unique && picks[0]!.key === picks[1]!.key && picks[0]!.secondary === picks[1]!.secondary ? { reason: "unresolved_pick" as const } : {}) };
    }
    return { timeSec, arms };
}

export interface CandidateStageResult {
    views: EventView[];
    profitOnlyEvents: ProfitOnlyEvent[];
}

export interface AssetSwitchCandidateStageResult {
    rankingEvents?: RankingEvent[];
    decisions: AssetSwitchDecision[];
    candidateComparisonEvents: number;
    selectedAssets: Set<string>;
}

export async function buildCandidateViews(args: {
    enableCausalArms?: boolean;
    events: readonly DecisionEvent[];
    /** events.length at sweep exit; progress denominator only. */
    totalEvents: number;
    assetNames: readonly string[];
    assetCount: number;
    /** Keep singleton events so they can start an enabled selector cooldown. */
    selectionCooldownBars?: number;
    /** Legacy full-view fixtures can retain empty/singleton switch events. */
    includeAllDecisionEvents?: boolean;
    onRankingEvent?: (event: RankingEvent) => void;
    shouldStop?: () => boolean;
    onPhase: ReplayPhaseCallback;
}): Promise<StageOutcome<CandidateStageResult>> {
    const { events, totalEvents, assetNames, assetCount, onPhase } = args;
    const retainSingletonEvents = Math.max(0, Math.floor(args.selectionCooldownBars ?? 0)) > 0
        || args.includeAllDecisionEvents === true;
    // --- Phase 3: build candidate sets; collect per-asset event requests ---
    onPhase("targets", "forming candidates", 0, totalEvents);
    const views: EventView[] = [];
    /**
     * Events with a profit pool but fewer than 2 ordinary positives. Without
     * cooldown, only >= 2-member profit pools are retained; with cooldown,
     * singleton pools also remain so a selected asset can start its cooldown.
     */
    interface ProfitOnlyEvent {
        timeSec: number;
        profitPositives: Candidate[];
        profitNowPositives: Candidate[];
        profitNowConfidencePositives: Candidate[];
    }
    const profitOnlyEvents: ProfitOnlyEvent[] = [];
    // TOP_Z per-asset causal z-surprise state (Welford) over each asset's own
    // PROFIT_NOW raw score at PRIOR decision events. Empty history is mean 0 /
    // std 0, so with the max(std, 1)-vote denominator floor the first surprise
    // equals the raw count. Updated AFTER each event's pools are built.
    const zWelfordMean = new Float64Array(assetCount);
    const zWelfordM2 = new Float64Array(assetCount);
    const zWelfordCount = new Float64Array(assetCount);
    const zSurprise = (a: number, score: number): number => {
        const n = zWelfordCount[a]!;
        if (n <= 0) return score;
        const variance = zWelfordM2[a]! / n;
        const z = (score - zWelfordMean[a]!) / Math.max(Math.sqrt(variance), 1);
        return Number.isFinite(z) ? z : 0;
    };
    const updateZStats = (a: number, score: number): void => {
        const n = zWelfordCount[a]!;
        const mean = zWelfordMean[a]!;
        const delta = score - mean;
        const nextMean = mean + delta / (n + 1);
        zWelfordM2[a] = zWelfordM2[a]! + delta * (score - nextMean);
        zWelfordMean[a] = nextMean;
        zWelfordCount[a] = n + 1;
    };
    for (let e = 0; e < events.length; e += 1) {
        if (args.shouldStop?.()) {
            return { ok: false, earlyExit: {
                reportLine: "OPEN_SCORE USD | cancelled during candidate selection.",
                assets: assetCount,
                totalEvents,
            } };
        }
        const ev = events[e]!;
        const positives: Candidate[] = [];
        const profitPositives: Candidate[] = [];
        const profitNowPositives: Candidate[] = [];
        const profitNowConfidencePositives: Candidate[] = [];
        let maxActivePairs = 0;
        for (let a = 0; a < assetCount; a += 1) {
            const raw = ev.rawScore[a]!;
            const cnt = ev.activePairCount[a]!;
            // Redundant-work plan phase 1: the ordinary literal (and its
            // adjusted/mean arithmetic) is only worth building for the
            // positive pool — non-positive assets discarded it immediately.
            // The profit pools and TOP_Z's history update below still run for
            // every asset, and the outer loop must NOT continue early:
            // profitable-pair subsets can be positive with a non-positive
            // ordinary score.
            if (raw > 0) {
                const candidate: Candidate = {
                    assetIndex: a,
                    raw,
                    adjusted: cnt > 0 ? raw / Math.sqrt(cnt) : raw,
                    mean: cnt > 0 ? raw / cnt : raw,
                    activePairs: cnt,
                    ...ev.causalScores?.get(a),
                };
                if (cnt > maxActivePairs) maxActivePairs = cnt;
                positives.push(candidate);
            }
            // Profit-gated pool: same shape, filtered scores only.
            const rawPnl = ev.rawScoreProfit[a]!;
            if (rawPnl > 0) {
                const cntPnl = ev.activePairCountProfit[a]!;
                profitPositives.push({
                    assetIndex: a,
                    raw: rawPnl,
                    adjusted: cntPnl > 0 ? rawPnl / Math.sqrt(cntPnl) : rawPnl,
                    mean: cntPnl > 0 ? rawPnl / cntPnl : rawPnl,
                    activePairs: cntPnl,
                });
            }
            // Causal pool: same shape, realized-so-far filtered scores only.
            const rawPnlNow = ev.rawScoreProfitNow[a]!;
            if (rawPnlNow > 0) {
                const cntPnlNow = ev.activePairCountProfitNow[a]!;
                profitNowPositives.push({
                    assetIndex: a,
                    raw: rawPnlNow,
                    adjusted: cntPnlNow > 0 ? rawPnlNow / Math.sqrt(cntPnlNow) : rawPnlNow,
                    mean: cntPnlNow > 0 ? rawPnlNow / cntPnlNow : rawPnlNow,
                    activePairs: cntPnlNow,
                    z: zSurprise(a, rawPnlNow),
                });
            }
            // Causal confidence-weighted pool: the same entry-time causal
            // filter, but each qualifying vote carries a bounded realized-P&L
            // consistency/evidence weight.
            const rawPnlNowConf = ev.rawScoreProfitNowConf[a]!;
            if (rawPnlNowConf > 0) {
                const cntPnlNowConf = ev.activePairCountProfitNowConf[a]!;
                profitNowConfidencePositives.push({
                    assetIndex: a,
                    raw: rawPnlNowConf,
                    adjusted: cntPnlNowConf > 0 ? rawPnlNowConf / Math.sqrt(cntPnlNowConf) : rawPnlNowConf,
                    mean: cntPnlNowConf > 0 ? rawPnlNowConf / cntPnlNowConf : rawPnlNowConf,
                    activePairs: cntPnlNowConf,
                });
            }
        }
        // TOP_Z history update: strictly-past semantics — this event's
        // profit-now scores join each asset's history only AFTER the pools
        // above captured this event's z values.
        args.onRankingEvent?.(captureRankingEvent(ev.timeSec, { positives, profitPositives, profitNowPositives, profitNowConfidencePositives }, assetNames, args.enableCausalArms));
        for (let a = 0; a < assetCount; a += 1) updateZStats(a, ev.rawScoreProfitNow[a]!);
        // A singleton cannot form a paired comparison, but with cooldown
        // enabled it still represents a real selection event and must be
        // retained so its selected asset starts cooling down.
        if (positives.length >= 2 || (retainSingletonEvents && positives.length === 1) || args.includeAllDecisionEvents === true) {
            // Phase 0 freeze: tie-break by the versioned FNV-1a 64 digest of
            // `MAX_ACTIVE_TIE_VERSION|tieSeed|truncatedEventTimeSec|scoringAsset`.
            // Smallest digest wins. Asset name and input order are NEVER
            // tie-breaks. On a digest collision (astronomically unlikely),
            // asset-name order keeps execution deterministic.
            const eventTimeSec = ev.timeSec;
            // Selection-aggregation plan phase 3: the digest key is only
            // (version, seed, event time, asset), so one asset's digest is
            // identical across every pickMax in this event. Lazily memoize
            // per assetIndex — the map is allocated only when a tie actually
            // requests a digest and becomes unreachable with the event, so
            // nothing is retained across events.
            let eventDigestCache: Map<number, string> | null = null;
            const digestFor = (c: Candidate): string => {
                const cached = eventDigestCache?.get(c.assetIndex);
                if (cached !== undefined) return cached;
                const digest = tieBreakDigest(eventTimeSec, assetNames[c.assetIndex]!);
                (eventDigestCache ??= new Map()).set(c.assetIndex, digest);
                return digest;
            };
            type RankKey = "raw" | "mean" | "activePairs" | "z";
            const rankValue = (candidate: Candidate, key: RankKey): number =>
                key === "z" ? candidate.z ?? Number.NEGATIVE_INFINITY : candidate[key] ?? Number.NEGATIVE_INFINITY;
            const pickMax = (candidates: readonly Candidate[], key: RankKey): { winner: Candidate; tiedCount: number } => {
                // First pass: find the max value.
                let maxValue = rankValue(candidates[0]!, key);
                for (let i = 1; i < candidates.length; i += 1) {
                    const v = rankValue(candidates[i]!, key);
                    if (v > maxValue) maxValue = v;
                }
                // Second pass: collect every candidate at the max, then pick by
                // tie-break digest. Counting at the end gives the correct tied
                // total regardless of input order.
                const tiedAtTop: Candidate[] = [];
                for (const c of candidates) {
                    if (rankValue(c, key) === maxValue) tiedAtTop.push(c);
                }
                let winner = tiedAtTop[0]!;
                if (tiedAtTop.length > 1) {
                    // Precompute every tied candidate's digest ONCE and track the
                    // current winner's digest alongside the winner itself. The
                    // prior loop recomputed `digestFor(winner)` on every
                    // iteration — O(k) TextEncoder.encode + FNV hashes per tie
                    // event instead of O(1) lookup, and pickMax runs 6–7× per
                    // event across every event (Phase 3 hot path).
                    const digests = tiedAtTop.map(digestFor);
                    let dW = digests[0]!;
                    for (let i = 1; i < tiedAtTop.length; i += 1) {
                        const c = tiedAtTop[i]!;
                        const dC = digests[i]!;
                        if (dC < dW) { winner = c; dW = dC; }
                        else if (dC === dW) {
                            // Tie-digest collision. Asset name is the final
                            // deterministic fallback (collision is astronomically
                            // unlikely; no longer surfaced as a verdict flag —
                            // no consumer ever read it).
                            if (assetNames[c.assetIndex]! < assetNames[winner.assetIndex]!) { winner = c; dW = dC; }
                        }
                    }
                }
                return { winner, tiedCount: tiedAtTop.length };
            };
            const topRaw = positives.length > 0 ? pickMax(positives, "raw") : null;
            const topMean = positives.length > 0 ? pickMax(positives, "mean") : null;
            const topMeanRawUniquePool = topMean
                ? positives.filter((candidate) => candidate.mean === topMean.winner.mean)
                : [];
            let topMeanRawUnique = -1;
            let maxRawInTopMeanTie = -Infinity;
            for (const candidate of topMeanRawUniquePool) {
                if (candidate.raw > maxRawInTopMeanTie) maxRawInTopMeanTie = candidate.raw;
            }
            const topMeanRawMaxRows = topMeanRawUniquePool.filter((candidate) => candidate.raw === maxRawInTopMeanTie);
            if (topMeanRawMaxRows.length === 1) topMeanRawUnique = topMeanRawMaxRows[0]!.assetIndex;
            const uniquePick = (
                pool: readonly Candidate[],
                key: "raw" | "mean" | "z",
                direction: "max" | "min",
            ): number | null => {
                if (pool.length === 0) return null;
                const score = (candidate: Candidate): number => key === "z"
                    ? candidate.z ?? Number.NEGATIVE_INFINITY
                    : candidate[key] ?? Number.NEGATIVE_INFINITY;
                let best = score(pool[0]!);
                for (let index = 1; index < pool.length; index += 1) {
                    const value = score(pool[index]!);
                    if (direction === "max" ? value > best : value < best) best = value;
                }
                let winner: number | null = null;
                for (const candidate of pool) {
                    if (score(candidate) !== best) continue;
                    if (winner !== null) return null;
                    winner = candidate.assetIndex;
                }
                return winner;
            };
            const bestMeanPool = (pool: readonly Candidate[], direction: "max" | "min"): Candidate[] => {
                if (pool.length === 0) return [];
                const best = pool.reduce((value, candidate) => direction === "max"
                    ? Math.max(value, candidate.mean)
                    : Math.min(value, candidate.mean),
                direction === "max" ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY);
                return pool.filter((candidate) => candidate.mean === best);
            };
            // Profit-gated picks: same digest tie-break, own >= 2 pool gate.
            const poolMinimum = args.includeAllDecisionEvents === true ? 1 : 2;
            const topRawProfit = profitPositives.length >= poolMinimum ? pickMax(profitPositives, "raw") : null;
            const topMeanProfit = profitPositives.length >= poolMinimum ? pickMax(profitPositives, "mean") : null;
            // Causal picks: identical, over the point-in-time pool.
            const topRawProfitNow = profitNowPositives.length >= poolMinimum ? pickMax(profitNowPositives, "raw") : null;
            const topMeanProfitNow = profitNowPositives.length >= poolMinimum ? pickMax(profitNowPositives, "mean") : null;
            const topRawProfitNowConf = profitNowConfidencePositives.length >= poolMinimum
                ? pickMax(profitNowConfidencePositives, "raw")
                : null;
            // Causal z-surprise ranking over the profit-now pool.
            const topZ = profitNowPositives.length >= poolMinimum
                ? pickMax(profitNowPositives, "z")
                : null;
            let switchPicks: EventView["assetSwitchPicks"];
            if (args.includeAllDecisionEvents === true) {
                // Normal ranked arms already resolve score ties with the
                // canonical event digest. Keep that winner for switch replay;
                // only TOP_MEAN_RAW_UNIQUE requires a unique best raw score.
                const rankedWinner = (pick: { winner: Candidate } | null): number | null =>
                    pick?.winner.assetIndex ?? null;
                switchPicks = {
                    // The ordinary ranking results already computed above
                    // carry tie counts. Reuse them instead of ranking those
                    // pools a second time just for switch replay.
                    ...Object.fromEntries((args.enableCausalArms ? CAUSAL_ARM_FIELDS : []).map((field) => [field, pickUsableMaxByAssetNames(causalCandidatePool(positives, field), field, ev.timeSec, assetNames)?.winner.assetIndex ?? null])),
                    topRawProfitNow: rankedWinner(topRawProfitNow),
                    topMeanProfitNow: rankedWinner(topMeanProfitNow),
                    topRawProfitNowConf: rankedWinner(topRawProfitNowConf),
                    topZ: rankedWinner(topZ),
                    topRaw: rankedWinner(topRaw),
                    topMean: rankedWinner(topMean),
                    topMeanRawUnique: topMeanRawUnique >= 0 ? topMeanRawUnique : null,
                    topRawProfit: rankedWinner(topRawProfit),
                    topMeanProfit: rankedWinner(topMeanProfit),
                    // BOT arms have no parallel display pick in this stage;
                    // calculate only their unique extreme selectors here.
                    botRawProfitNow: uniquePick(profitNowPositives, "raw", "min"),
                    botMeanProfitNow: uniquePick(profitNowPositives, "mean", "min"),
                    botZ: uniquePick(profitNowPositives, "z", "min"),
                    botRaw: uniquePick(positives, "raw", "min"),
                    botMean: uniquePick(positives, "mean", "min"),
                    botMeanRawUnique: uniquePick(bestMeanPool(positives, "min"), "raw", "min"),
                };
                if (Object.keys(switchPicks).length !== replayArmFields(args.enableCausalArms).length) {
                    throw new Error("Asset-switch candidate mapping is incomplete.");
                }
            }
            views.push({
                ...(args.enableCausalArms ? { causalPicks: Object.fromEntries(CAUSAL_ARM_FIELDS.map((field) => [field,
                    pickUsableMaxByAssetNames(causalCandidatePool(positives, field), field, ev.timeSec, assetNames)?.winner.assetIndex ?? -1])) } : {}),
                timeSec: ev.timeSec, positives,
                profitPositives,
                profitNowPositives,
                profitNowConfidencePositives,
                ...(switchPicks ? { assetSwitchPicks: switchPicks } : {}),
                topRaw: topRaw?.winner.assetIndex ?? -1,
                topMean: topMean?.winner.assetIndex ?? -1,
                topMeanRawUnique,
                topMeanRawUniquePool,
                topRawProfit: topRawProfit?.winner.assetIndex ?? -1,
                topMeanProfit: topMeanProfit?.winner.assetIndex ?? -1,
                topRawProfitNow: topRawProfitNow?.winner.assetIndex ?? -1,
                topMeanProfitNow: topMeanProfitNow?.winner.assetIndex ?? -1,
                topRawProfitNowConf: topRawProfitNowConf?.winner.assetIndex ?? -1,
                topZ: topZ?.winner.assetIndex ?? -1,
                maxActivePairs,
                ties: {
                    RAW: (topRaw?.tiedCount ?? 0) >= 2 ? 1 : 0,
                    MEAN: (topMean?.tiedCount ?? 0) >= 2 ? 1 : 0,
                },
            });
        } else if (
            profitPositives.length >= (retainSingletonEvents ? 1 : 2)
            || profitNowPositives.length >= (retainSingletonEvents ? 1 : 2)
            || profitNowConfidencePositives.length >= (retainSingletonEvents ? 1 : 2)
        ) {
            // Profit-arm-only event: no ordinary view, but a profit arm can
            // still select (and cool down) an asset. Pools are captured
            // verbatim; picks are resolved in Phase 5 with the same tie-break.
            profitOnlyEvents.push({
                timeSec: ev.timeSec,
                profitPositives,
                profitNowPositives,
                profitNowConfidencePositives,
            });
        }
        if (e % 1000 === 0) {
            onPhase("targets", `formed candidates for ${e}/${totalEvents} events`, e, totalEvents);
            await yieldLoop();
            if (args.shouldStop?.()) {
                return { ok: false, earlyExit: {
                    reportLine: "OPEN_SCORE USD | cancelled during candidate selection.",
                    assets: assetCount,
                    totalEvents,
                } };
            }
        }
    }
    return { ok: true, result: { views, profitOnlyEvents } };
}

class SwitchRankedMaximum {
    private bestValue = Number.NEGATIVE_INFINITY;
    private winner: number | null = null;
    private winnerDigest: string | null = null;

    constructor(
        private readonly assetNames: readonly string[],
        private readonly digestFor: (assetIndex: number) => string,
    ) {}

    consider(value: number, assetIndex: number): void {
        if (this.winner === null || value > this.bestValue) {
            this.bestValue = value;
            this.winner = assetIndex;
            this.winnerDigest = null;
            return;
        }
        if (value !== this.bestValue) return;
        const candidateDigest = this.digestFor(assetIndex);
        this.winnerDigest ??= this.digestFor(this.winner);
        if (candidateDigest < this.winnerDigest
            || (candidateDigest === this.winnerDigest && this.assetNames[assetIndex]! < this.assetNames[this.winner]!)) {
            this.winner = assetIndex;
            this.winnerDigest = candidateDigest;
        }
    }

    result(): number | null {
        return this.winner;
    }
}

class SwitchUniqueExtreme {
    private bestValue: number;
    private winner: number | null = null;
    private winnerCount = 0;

    constructor(private readonly direction: "max" | "min") {
        this.bestValue = direction === "max" ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY;
    }

    consider(value: number, assetIndex: number): void {
        const better = this.direction === "max" ? value > this.bestValue : value < this.bestValue;
        if (this.winnerCount === 0 || better) {
            this.bestValue = value;
            this.winner = assetIndex;
            this.winnerCount = 1;
        } else if (value === this.bestValue) {
            this.winnerCount += 1;
            this.winner = null;
        }
    }

    result(): number | null {
        return this.winnerCount === 1 ? this.winner : null;
    }
}

class SwitchMeanRawUnique {
    private bestMean: number;
    private bestRaw: number;
    private winner: number | null = null;
    private winnerCount = 0;

    constructor(private readonly direction: "max" | "min") {
        this.bestMean = direction === "max" ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY;
        this.bestRaw = direction === "max" ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY;
    }

    consider(mean: number, raw: number, assetIndex: number): void {
        const betterMean = this.direction === "max" ? mean > this.bestMean : mean < this.bestMean;
        if (this.winnerCount === 0 || betterMean) {
            this.bestMean = mean;
            this.bestRaw = raw;
            this.winner = assetIndex;
            this.winnerCount = 1;
            return;
        }
        if (mean !== this.bestMean) return;
        const betterRaw = this.direction === "max" ? raw > this.bestRaw : raw < this.bestRaw;
        if (betterRaw) {
            this.bestRaw = raw;
            this.winner = assetIndex;
            this.winnerCount = 1;
        } else if (raw === this.bestRaw) {
            this.winnerCount += 1;
            this.winner = null;
        }
    }

    result(): number | null {
        return this.winnerCount === 1 ? this.winner : null;
    }
}

/**
 * Build the switch replay's minimal event stream directly. Horizon mode needs
 * the candidate pools retained on EventView; switch mode needs only its arm
 * picks, so this path resolves those picks in one asset pass and releases each
 * score snapshot as soon as it has been consumed.
 */
export async function buildAssetSwitchDecisions(args: {
    enableCausalArms?: boolean;
    events: readonly DecisionEvent[];
    totalEvents: number;
    assetNames: readonly string[];
    assetCount: number;
    shouldStop?: () => boolean;
    onPhase: ReplayPhaseCallback;
    onEventProcessed?: (eventIndex: number) => void;
    captureRanking?: boolean;
}): Promise<StageOutcome<AssetSwitchCandidateStageResult>> {
    const { events, totalEvents, assetNames, assetCount, onPhase, onEventProcessed } = args;
    onPhase("targets", "forming asset-switch decisions", 0, totalEvents);
    const decisions: AssetSwitchDecision[] = [];
    const rankingEvents = args.captureRanking ? [] as RankingEvent[] : undefined;
    const selectedAssets = new Set<string>();
    const zWelfordMean = new Float64Array(assetCount);
    const zWelfordM2 = new Float64Array(assetCount);
    const zWelfordCount = new Float64Array(assetCount);
    let candidateComparisonEvents = 0;

    const zSurprise = (assetIndex: number, score: number): number => {
        const n = zWelfordCount[assetIndex]!;
        if (n <= 0) return score;
        const variance = zWelfordM2[assetIndex]! / n;
        const z = (score - zWelfordMean[assetIndex]!) / Math.max(Math.sqrt(variance), 1);
        return Number.isFinite(z) ? z : 0;
    };
    const updateZStats = (assetIndex: number, score: number): void => {
        const n = zWelfordCount[assetIndex]!;
        const mean = zWelfordMean[assetIndex]!;
        const delta = score - mean;
        const nextMean = mean + delta / (n + 1);
        zWelfordM2[assetIndex] = zWelfordM2[assetIndex]! + delta * (score - nextMean);
        zWelfordMean[assetIndex] = nextMean;
        zWelfordCount[assetIndex] = n + 1;
    };

    for (let eventIndex = 0; eventIndex < events.length; eventIndex += 1) {
        if (args.shouldStop?.()) {
            return { ok: false, earlyExit: {
                reportLine: "OPEN_SCORE USD | cancelled during candidate selection.",
                assets: assetCount,
                totalEvents,
            } };
        }
        const event = events[eventIndex]!;
        const ranking = rankingEvents ? captureRankingEvent(event.timeSec, {}, assetNames, args.enableCausalArms) : null;
        const considerRanking = (pool: typeof RANKING_ARM_SPECS[number]["pool"], raw: number, count: number, assetIndex: number, z?: number): void => {
            if (!ranking || raw <= 0) return;
            const candidate: Candidate = { assetIndex, raw, mean: count > 0 ? raw / count : raw, activePairs: count, adjusted: raw, z };
            for (const spec of RANKING_ARM_SPECS) if (!isCausalArm(spec.field) && spec.pool === pool) insertRankingPick(ranking.arms[spec.field].picks, candidate, spec, event.timeSec, assetNames, digestFor);
        };
        let digestCache: Map<number, string> | null = null;
        const digestFor = (assetIndex: number): string => {
            const cached = digestCache?.get(assetIndex);
            if (cached !== undefined) return cached;
            const digest = tieBreakDigest(event.timeSec, assetNames[assetIndex]!);
            (digestCache ??= new Map()).set(assetIndex, digest);
            return digest;
        };

        const topRaw = new SwitchRankedMaximum(assetNames, digestFor);
        const topMean = new SwitchRankedMaximum(assetNames, digestFor);
        const topMeanRawUnique = new SwitchMeanRawUnique("max");
        const topRawProfit = new SwitchRankedMaximum(assetNames, digestFor);
        const topMeanProfit = new SwitchRankedMaximum(assetNames, digestFor);
        const topRawProfitNow = new SwitchRankedMaximum(assetNames, digestFor);
        const topMeanProfitNow = new SwitchRankedMaximum(assetNames, digestFor);
        const topRawProfitNowConf = new SwitchRankedMaximum(assetNames, digestFor);
        const topZ = new SwitchRankedMaximum(assetNames, digestFor);
        const botRaw = new SwitchUniqueExtreme("min");
        const botMean = new SwitchUniqueExtreme("min");
        const botMeanRawUnique = new SwitchMeanRawUnique("min");
        const botRawProfitNow = new SwitchUniqueExtreme("min");
        const botMeanProfitNow = new SwitchUniqueExtreme("min");
        const botZ = new SwitchUniqueExtreme("min");
        let positiveCount = 0;

        for (let assetIndex = 0; assetIndex < assetCount; assetIndex += 1) {
            const raw = event.rawScore[assetIndex]!;
            const activePairs = event.activePairCount[assetIndex]!;
            considerRanking("positives", raw, activePairs, assetIndex);
            if (raw > 0) {
                const mean = activePairs > 0 ? raw / activePairs : raw;
                positiveCount += 1;
                topRaw.consider(raw, assetIndex);
                topMean.consider(mean, assetIndex);
                topMeanRawUnique.consider(mean, raw, assetIndex);
                botRaw.consider(raw, assetIndex);
                botMean.consider(mean, assetIndex);
                botMeanRawUnique.consider(mean, raw, assetIndex);
            }

            const rawProfit = event.rawScoreProfit[assetIndex]!;
            considerRanking("profitPositives", rawProfit, event.activePairCountProfit[assetIndex]!, assetIndex);
            if (rawProfit > 0) {
                const count = event.activePairCountProfit[assetIndex]!;
                topRawProfit.consider(rawProfit, assetIndex);
                topMeanProfit.consider(count > 0 ? rawProfit / count : rawProfit, assetIndex);
            }

            const rawProfitNow = event.rawScoreProfitNow[assetIndex]!;
            if (ranking) considerRanking("profitNowPositives", rawProfitNow, event.activePairCountProfitNow[assetIndex]!, assetIndex, zSurprise(assetIndex, rawProfitNow));
            if (rawProfitNow > 0) {
                const count = event.activePairCountProfitNow[assetIndex]!;
                const mean = count > 0 ? rawProfitNow / count : rawProfitNow;
                const z = zSurprise(assetIndex, rawProfitNow);
                topRawProfitNow.consider(rawProfitNow, assetIndex);
                topMeanProfitNow.consider(mean, assetIndex);
                topZ.consider(z, assetIndex);
                botRawProfitNow.consider(rawProfitNow, assetIndex);
                botMeanProfitNow.consider(mean, assetIndex);
                botZ.consider(z, assetIndex);
            }

            const rawProfitNowConf = event.rawScoreProfitNowConf[assetIndex]!;
            considerRanking("profitNowConfidencePositives", rawProfitNowConf, event.activePairCountProfitNowConf[assetIndex]!, assetIndex);
            if (rawProfitNowConf > 0) topRawProfitNowConf.consider(rawProfitNowConf, assetIndex);

            // Each asset's TOP_Z history is independent. Read its prior
            // statistics above, then incorporate this event before advancing
            // to the next asset; this preserves strict-past semantics without
            // a second pass over the score snapshots.
            updateZStats(assetIndex, rawProfitNow);
        }
        if (positiveCount >= 2) candidateComparisonEvents += 1;

        const picks: AssetSwitchDecision["picks"] = {
            ...Object.fromEntries((args.enableCausalArms ? CAUSAL_ARM_FIELDS : []).map((field) => [field, event.causalArms?.[field]?.picks[0]?.assetIndex ?? null])),
            topRawProfitNow: topRawProfitNow.result(),
            topMeanProfitNow: topMeanProfitNow.result(),
            topRawProfitNowConf: topRawProfitNowConf.result(),
            topZ: topZ.result(),
            topRaw: topRaw.result(),
            topMean: topMean.result(),
            topMeanRawUnique: topMeanRawUnique.result(),
            topRawProfit: topRawProfit.result(),
            topMeanProfit: topMeanProfit.result(),
            botRawProfitNow: botRawProfitNow.result(),
            botMeanProfitNow: botMeanProfitNow.result(),
            botZ: botZ.result(),
            botRaw: botRaw.result(),
            botMean: botMean.result(),
            botMeanRawUnique: botMeanRawUnique.result(),
        };
        for (const arm of replayArmFields(args.enableCausalArms)) {
            const selectedIndex = picks[arm];
            if (selectedIndex != null) {
                const selectedAsset = assetNames[selectedIndex] ?? "";
                if (selectedAsset) selectedAssets.add(selectedAsset);
            }
        }
        decisions.push({ timeSec: event.timeSec, picks, ...(event.causalArms ? { eligiblePoolCounts: Object.fromEntries(CAUSAL_ARM_FIELDS.map((field) => [field, event.causalArms![field]!.eligibleCount])) } : {}) });
        if (ranking) {
            for (const field of replayArmFields(args.enableCausalArms)) {
                if (isCausalArm(field)) ranking.arms[field] = { picks: event.causalArms?.[field]?.picks ?? [] };
                const row = ranking.arms[field];
                row.reason = row.picks.length < 5 ? "small_pool" : picks[field] === null ? "unresolved_pick"
                    : row.picks[0]!.assetIndex !== picks[field] ? "pick_changed" : undefined;
            }
            rankingEvents!.push(ranking);
        }
        onEventProcessed?.(eventIndex);

        if (eventIndex % 1000 === 0) {
            onPhase("targets", `formed asset-switch decisions for ${eventIndex}/${totalEvents} events`, eventIndex, totalEvents);
            await yieldLoop();
            if (args.shouldStop?.()) {
                return { ok: false, earlyExit: {
                    reportLine: "OPEN_SCORE USD | cancelled during candidate selection.",
                    assets: assetCount,
                    totalEvents,
                } };
            }
        }
    }
    return { ok: true, result: { decisions, candidateComparisonEvents, selectedAssets, ...(rankingEvents ? { rankingEvents } : {}) } };
}

export interface OutcomeRequestPlan {
    /** Asset index -> requested event indexes (tail-deduped, view order). */
    requestsByAsset: Map<number, number[]>;
    /** Assets requested by the ordinary positive pools. */
    positiveRequestedAssets: Set<number>;
    /** views.length + profitOnlyEvents.length. */
    totalEventCount: number;
    /** Decision time of a view OR profit-only event index. */
    eventTimeOf: (idx: number) => number;
}

export function buildOutcomeRequests(args: {
    views: readonly EventView[];
    profitOnlyEvents: readonly ProfitOnlyEvent[];
}): OutcomeRequestPlan {
    const { views, profitOnlyEvents } = args;
    // Group requested event indexes by asset so each target dataset is loaded
    // once, consumed, and released.
    const requestsByAsset = new Map<number, number[]>();
    const positiveRequestedAssets = new Set<number>();
    for (let v = 0; v < views.length; v += 1) {
        for (const c of views[v]!.positives) {
            positiveRequestedAssets.add(c.assetIndex);
            let list = requestsByAsset.get(c.assetIndex);
            if (!list) { list = []; requestsByAsset.set(c.assetIndex, list); }
            list.push(v);
        }
        // A profit-gated candidate may have a non-positive unfiltered score
        // (offsetting losing-pair votes). Add it after the positive pass so
        // the same view index cannot be appended twice for an asset.
        for (const c of views[v]!.profitPositives) {
            let list = requestsByAsset.get(c.assetIndex);
            if (!list) { list = []; requestsByAsset.set(c.assetIndex, list); }
            if (list[list.length - 1] !== v) list.push(v);
        }
        // Causal pool candidates may also have a non-positive unfiltered
        // score; tail-dedupe keeps the same view from appending twice.
        for (const c of views[v]!.profitNowPositives) {
            let list = requestsByAsset.get(c.assetIndex);
            if (!list) { list = []; requestsByAsset.set(c.assetIndex, list); }
            if (list[list.length - 1] !== v) list.push(v);
        }
        for (const c of views[v]!.profitNowConfidencePositives) {
            let list = requestsByAsset.get(c.assetIndex);
            if (!list) { list = []; requestsByAsset.set(c.assetIndex, list); }
            if (list[list.length - 1] !== v) list.push(v);
        }
    }
    // Profit-only events share the request/outcome indexes, offset after the
    // real views so every existing view index stays stable.
    const totalEventCount = views.length + profitOnlyEvents.length;
    const eventTimeOf = (idx: number): number =>
        idx < views.length ? views[idx]!.timeSec : profitOnlyEvents[idx - views.length]!.timeSec;
    const pushEventRequest = (assetIndex: number, idx: number): void => {
        let list = requestsByAsset.get(assetIndex);
        if (!list) { list = []; requestsByAsset.set(assetIndex, list); }
        if (list[list.length - 1] !== idx) list.push(idx);
    };
    for (let pi = 0; pi < profitOnlyEvents.length; pi += 1) {
        const idx = views.length + pi;
        for (const c of profitOnlyEvents[pi]!.profitPositives) pushEventRequest(c.assetIndex, idx);
        for (const c of profitOnlyEvents[pi]!.profitNowPositives) pushEventRequest(c.assetIndex, idx);
        for (const c of profitOnlyEvents[pi]!.profitNowConfidencePositives) pushEventRequest(c.assetIndex, idx);
    }
    return { requestsByAsset, positiveRequestedAssets, totalEventCount, eventTimeOf };
}

export interface PostOutcomeSelectionResult {
    /**
     * Gap-filtered views, index-aligned with `views` (null = event omitted
     * after gap filtering). With no data gaps this shares the original view
     * references (no-gap fast path).
     */
    gapFilteredViews: Array<EventView | null>;
    gapFilteredProfitOnlyEvents: ProfitOnlyEvent[];
    botPicksByView: Array<BotViewPicks | null>;
    latestSelections: OpenScoreUsdLatestSelections | null;
    armSelectionsByView?: Array<ReplayArmSelectionMap | null>;
    armSelectionsByProfitOnly?: Array<ReplayArmSelectionMap | null>;
}

export type UsableRankKey = "raw" | "mean" | "activePairs" | "z" | CausalArmField;

const usableRankValue = (candidate: Candidate, key: UsableRankKey): number =>
    key === "z" ? candidate.z ?? Number.NEGATIVE_INFINITY : candidate[key] ?? Number.NEGATIVE_INFINITY;

const usableRankValueMin = (candidate: Candidate, key: UsableRankKey): number =>
    key === "z" ? candidate.z ?? Number.POSITIVE_INFINITY : candidate[key] ?? Number.NEGATIVE_INFINITY;

/**
 * Gap-filtered max ranking with the versioned FNV-1a digest tie-break (smallest
 * digest wins; asset-name order only on a digest collision). Shared with the
 * engine's aggregation loop, which re-resolves profit-only-event picks with the
 * exact same rule. Null for an empty pool.
 */
export function pickUsableMaxByAssetNames(
    pool: readonly Candidate[],
    key: UsableRankKey,
    timeSec: number,
    assetNames: readonly string[],
): { winner: Candidate; tiedCount: number } | null {
    if (pool.length === 0) return null;
    let maxValue = usableRankValue(pool[0]!, key);
    for (let i = 1; i < pool.length; i += 1) {
        const value = usableRankValue(pool[i]!, key);
        if (value > maxValue) maxValue = value;
    }
    const tied = pool.filter((candidate) => usableRankValue(candidate, key) === maxValue);
    let winner = tied[0]!;
    if (tied.length > 1) {
        let winnerDigest = tieBreakDigest(timeSec, assetNames[winner.assetIndex]!);
        for (let i = 1; i < tied.length; i += 1) {
            const candidate = tied[i]!;
            const digest = tieBreakDigest(timeSec, assetNames[candidate.assetIndex]!);
            if (digest < winnerDigest || (digest === winnerDigest
                && assetNames[candidate.assetIndex]! < assetNames[winner.assetIndex]!)) {
                winner = candidate;
                winnerDigest = digest;
            }
        }
    }
    return { winner, tiedCount: tied.length };
}

/**
 * Inverted-rank counterpart of {@link pickUsableMaxByAssetNames}: same pool,
 * same eligibility, same digest tie-break, but the LOWEST rank value is
 * selected. A missing z ranks as +Infinity so a z-less candidate can never win
 * a min ranking (mirror of the max picker's -Infinity guard).
 */
export function pickUsableMinByAssetNames(
    pool: readonly Candidate[],
    key: UsableRankKey,
    timeSec: number,
    assetNames: readonly string[],
): { winner: Candidate; tiedCount: number } | null {
    if (pool.length === 0) return null;
    let minValue = usableRankValueMin(pool[0]!, key);
    for (let i = 1; i < pool.length; i += 1) {
        const value = usableRankValueMin(pool[i]!, key);
        if (value < minValue) minValue = value;
    }
    const tied = pool.filter((candidate) => usableRankValueMin(candidate, key) === minValue);
    let winner = tied[0]!;
    if (tied.length > 1) {
        let winnerDigest = tieBreakDigest(timeSec, assetNames[winner.assetIndex]!);
        for (let i = 1; i < tied.length; i += 1) {
            const candidate = tied[i]!;
            const digest = tieBreakDigest(timeSec, assetNames[candidate.assetIndex]!);
            if (digest < winnerDigest || (digest === winnerDigest
                && assetNames[candidate.assetIndex]! < assetNames[winner.assetIndex]!)) {
                winner = candidate;
                winnerDigest = digest;
            }
        }
    }
    return { winner, tiedCount: tied.length };
}


export async function selectAfterOutcomes(args: {
    enableCausalArms?: boolean;
    onRankingSelection?: (time: number, field: ReplayArmField, pool: readonly Candidate[], effectivePick: number) => void;
    views: readonly EventView[];
    profitOnlyEvents: readonly ProfitOnlyEvent[];
    assetNames: readonly string[];
    /** Assets excluded from selector pools because a target data gap overlaps the window. */
    dataGapAssets: ReadonlyMap<number, unknown>;
    /** Events omitted because fewer than two usable positives survived gaps. */
    dataGapEvents: Set<number>;
    shouldStop?: () => boolean;
    selectionCooldownBars?: number;
    boundaryIndicesByView?: Array<Map<number, number> | null>;
}): Promise<PostOutcomeSelectionResult> {
    const { views, profitOnlyEvents, assetNames, dataGapAssets, dataGapEvents } = args;
    const cooldownBars = Math.max(0, Math.floor(args.selectionCooldownBars ?? 0));
    const latestView = views[views.length - 1] ?? null;
    const usableCandidates = (pool: readonly Candidate[]): Candidate[] =>
        pool.filter((candidate) => !dataGapAssets.has(candidate.assetIndex));

    const pickUsableMax = (
        pool: readonly Candidate[],
        key: UsableRankKey,
        timeSec: number,
    ): { winner: Candidate; tiedCount: number } | null =>
        pickUsableMaxByAssetNames(pool, key, timeSec, assetNames);
    const pickUsableMin = (
        pool: readonly Candidate[],
        key: UsableRankKey,
        timeSec: number,
    ): { winner: Candidate; tiedCount: number } | null =>
        pickUsableMinByAssetNames(pool, key, timeSec, assetNames);


    // Target gaps are discovered after the pair-event sweep. Rebuild the
    // candidate views once their target datasets have been inspected so a
    // gapped asset is removed from the selector pool instead of invalidating
    // an otherwise usable event.
    // No-gap fast path (replay-efficiency plan phase 2): with an empty gap
    // set, filtering is the identity on every pool, so the ORIGINAL EventView
    // already IS the gap-filtered view — pushing it reuses the Phase 3
    // rankings/tie digests verbatim instead of recomputing them. The
    // re-ranking loop below stays the authoritative path for any real gap.
    // Downstream is read-only over views (returnsByView keyed per view; the
    // bot/latest/bottom-side resolvers never mutate pools), so sharing the
    // reference is safe.
    const hasDataGaps = dataGapAssets.size > 0;
    const gapFilteredViews: Array<EventView | null> = [];
    if (!hasDataGaps) {
        for (const source of views) gapFilteredViews.push(source);
    }
    for (let viewIndex = hasDataGaps ? 0 : views.length; viewIndex < views.length; viewIndex += 1) {
        const source = views[viewIndex]!;
        const positives = usableCandidates(source.positives);
        if (positives.length < (cooldownBars > 0 ? 1 : 2)) {
            if (source.positives.some((candidate) => dataGapAssets.has(candidate.assetIndex))) {
                dataGapEvents.add(viewIndex);
            }
            gapFilteredViews.push(null);
            continue;
        }
        const profitPositives = usableCandidates(source.profitPositives);
        const profitNowPositives = usableCandidates(source.profitNowPositives);
        const profitNowConfidencePositives = usableCandidates(source.profitNowConfidencePositives);
        const topRaw = pickUsableMax(positives, "raw", source.timeSec)!;
        const topMean = pickUsableMax(positives, "mean", source.timeSec)!;
        const topMeanRawUniquePool = positives.filter((candidate) => candidate.mean === topMean.winner.mean);
        let topMeanRawUnique = -1;
        let maxRawInTopMeanTie = -Infinity;
        for (const candidate of topMeanRawUniquePool) {
            if (candidate.raw > maxRawInTopMeanTie) maxRawInTopMeanTie = candidate.raw;
        }
        const topMeanRawMaxRows = topMeanRawUniquePool.filter((candidate) => candidate.raw === maxRawInTopMeanTie);
        if (topMeanRawMaxRows.length === 1) topMeanRawUnique = topMeanRawMaxRows[0]!.assetIndex;
        const topRawProfit = profitPositives.length >= 2
            ? pickUsableMax(profitPositives, "raw", source.timeSec)
            : null;
        const topMeanProfit = profitPositives.length >= 2
            ? pickUsableMax(profitPositives, "mean", source.timeSec)
            : null;
        const topRawProfitNow = profitNowPositives.length >= 2
            ? pickUsableMax(profitNowPositives, "raw", source.timeSec)
            : null;
        const topMeanProfitNow = profitNowPositives.length >= 2
            ? pickUsableMax(profitNowPositives, "mean", source.timeSec)
            : null;
        const topRawProfitNowConf = profitNowConfidencePositives.length >= 2
            ? pickUsableMax(profitNowConfidencePositives, "raw", source.timeSec)
            : null;
        const topZ = profitNowPositives.length >= 2
            ? pickUsableMax(profitNowPositives, "z", source.timeSec)
            : null;
        let maxActivePairs = 0;
        for (const candidate of positives) {
            if (candidate.activePairs > maxActivePairs) maxActivePairs = candidate.activePairs;
        }
        gapFilteredViews.push({
            ...source,
            positives,
            profitPositives,
            profitNowPositives,
            profitNowConfidencePositives,
            topRaw: topRaw.winner.assetIndex,
            topMean: topMean.winner.assetIndex,
            topMeanRawUnique,
            topMeanRawUniquePool,
            topRawProfit: topRawProfit?.winner.assetIndex ?? -1,
            topMeanProfit: topMeanProfit?.winner.assetIndex ?? -1,
            topRawProfitNow: topRawProfitNow?.winner.assetIndex ?? -1,
            topMeanProfitNow: topMeanProfitNow?.winner.assetIndex ?? -1,
            topRawProfitNowConf: topRawProfitNowConf?.winner.assetIndex ?? -1,
            topZ: topZ?.winner.assetIndex ?? -1,
            maxActivePairs,
            ties: {
                RAW: topRaw.tiedCount >= 2 ? 1 : 0,
                MEAN: topMean.tiedCount >= 2 ? 1 : 0,
            },
        });
    }
    const gapFilteredProfitOnlyEvents: ProfitOnlyEvent[] = profitOnlyEvents.map((source) => ({
        ...source,
        profitPositives: usableCandidates(source.profitPositives),
        profitNowPositives: usableCandidates(source.profitNowPositives),
        profitNowConfidencePositives: usableCandidates(source.profitNowConfidencePositives),
    }));

    /**
     * Inverted (negative-control) picks per gap-filtered view: the same pools
     * and >= 2 gates as the TOP_* arms, but the LOWEST rank value is selected
     * (see {@link pickUsableMin}). BOT_MEAN_RAW_UNIQUE mirrors
     * TOP_MEAN_RAW_UNIQUE on the bottom of the ranking: bottom-mean tied set,
     * then its unique raw MINIMUM (-1 on a residual raw tie). Resolved once
     * per view, before the per-horizon aggregation, exactly like the TOP picks.
     */
    interface BotViewPicks {
        raw: number;
        mean: number;
        meanRawUnique: number;
        meanRawUniquePoolSize: number;
        rawProfitNow: number;
        meanProfitNow: number;
        z: number;
    }
    const resolveBotViewPicks = (view: EventView): BotViewPicks => {
        const botMean = pickUsableMin(view.positives, "mean", view.timeSec)!;
        const bottomMeanTied = view.positives.filter((candidate) => candidate.mean === botMean.winner.mean);
        let meanRawUnique = -1;
        let minRawInBotMeanTie = Number.POSITIVE_INFINITY;
        for (const candidate of bottomMeanTied) {
            if (candidate.raw < minRawInBotMeanTie) minRawInBotMeanTie = candidate.raw;
        }
        const botMeanRawMinRows = bottomMeanTied.filter((candidate) => candidate.raw === minRawInBotMeanTie);
        if (botMeanRawMinRows.length === 1) meanRawUnique = botMeanRawMinRows[0]!.assetIndex;
        const profitNowPicked = view.profitNowPositives.length >= 2;
        return {
            raw: pickUsableMin(view.positives, "raw", view.timeSec)!.winner.assetIndex,
            mean: botMean.winner.assetIndex,
            meanRawUnique,
            meanRawUniquePoolSize: bottomMeanTied.length,
            rawProfitNow: profitNowPicked
                ? pickUsableMin(view.profitNowPositives, "raw", view.timeSec)?.winner.assetIndex ?? -1
                : -1,
            meanProfitNow: profitNowPicked
                ? pickUsableMin(view.profitNowPositives, "mean", view.timeSec)?.winner.assetIndex ?? -1
                : -1,
            z: profitNowPicked
                ? pickUsableMin(view.profitNowPositives, "z", view.timeSec)?.winner.assetIndex ?? -1
                : -1,
        };
    };
    const botPicksByView: Array<BotViewPicks | null> = gapFilteredViews.map((view) =>
        view ? resolveBotViewPicks(view) : null);

    const latestSelections: OpenScoreUsdLatestSelections | null = (() => {
        if (!latestView) return null;

        const pick = (
            selector: OpenScoreUsdLatestSelectorName,
            direction: "long" | "short" | "none",
            pool: readonly Candidate[],
            primary: (candidate: Candidate) => number,
            primaryOrder: "max" | "min",
            secondary?: (candidate: Candidate) => number,
            secondaryOrder: "max" | "min" = "max",
        ): OpenScoreUsdLatestSelection => {
            const usablePool = usableCandidates(pool);
            // Ranked detail for the Latest-picks UI: the arm's top candidates
            // in its own ranking order, capped at 3 so the wire payload stays
            // bounded. Runs once per completed run (latest event, per arm).
            const rankTopCandidates = (): OpenScoreUsdLatestSelectionCandidate[] =>
                [...usablePool]
                    .sort((a, b) => {
                        const pa = primary(a);
                        const pb = primary(b);
                        if (pa !== pb) return primaryOrder === "max" ? pb - pa : pa - pb;
                        if (secondary) {
                            const sa = secondary(a);
                            const sb = secondary(b);
                            if (sa !== sb) return secondaryOrder === "max" ? sb - sa : sa - sb;
                        }
                        return assetNames[a.assetIndex]!.localeCompare(assetNames[b.assetIndex]!);
                    })
                    .slice(0, 3)
                    .map((candidate) => ({
                        asset: assetNames[candidate.assetIndex]!,
                        score: candidate.raw,
                        mean: candidate.mean,
                        activePairs: candidate.activePairs,
                    }));
            const topCandidates = rankTopCandidates();
            if (usablePool.length < 2) {
                return {
                    selector,
                    direction,
                    asset: null,
                    tiedAssets: [],
                    score: null,
                    mean: null,
                    activePairs: null,
                    eligibleCandidates: usablePool.length,
                    reason: "insufficient_candidates",
                    topCandidates,
                };
            }
            let bestPrimary = primary(usablePool[0]!);
            for (let i = 1; i < usablePool.length; i += 1) {
                const value = primary(usablePool[i]!);
                if (primaryOrder === "max" ? value > bestPrimary : value < bestPrimary) {
                    bestPrimary = value;
                }
            }
            let finalists = usablePool.filter((candidate) => primary(candidate) === bestPrimary);
            if (secondary && finalists.length > 1) {
                let bestSecondary = secondary(finalists[0]!);
                for (let i = 1; i < finalists.length; i += 1) {
                    const value = secondary(finalists[i]!);
                    if (secondaryOrder === "max" ? value > bestSecondary : value < bestSecondary) {
                        bestSecondary = value;
                    }
                }
                finalists = finalists.filter((candidate) => secondary(candidate) === bestSecondary);
            }
            if (finalists.length !== 1) {
                return {
                    selector,
                    direction,
                    asset: null,
                    tiedAssets: finalists.map((candidate) => assetNames[candidate.assetIndex]!).sort(),
                    score: null,
                    mean: null,
                    activePairs: null,
                    eligibleCandidates: usablePool.length,
                    reason: "tied",
                    topCandidates,
                };
            }
            const selected = finalists[0]!;
            return {
                selector,
                direction,
                asset: assetNames[selected.assetIndex]!,
                tiedAssets: [],
                score: selected.raw,
                mean: selected.mean,
                activePairs: selected.activePairs,
                eligibleCandidates: usablePool.length,
                reason: "selected",
                topCandidates,
            };
        };

        return {
            decisionTime: latestView.timeSec,
            selections: [
                pick("TOP_RAW", "long", latestView.positives, (candidate) => candidate.raw, "max"),
                pick("TOP_MEAN", "long", latestView.positives, (candidate) => candidate.mean, "max"),
                pick("TOP_MEAN_RAW_UNIQUE", "long", latestView.positives, (candidate) => candidate.mean, "max", (candidate) => candidate.raw),
                pick("TOP_RAW_PROFIT_NOW", "long", latestView.profitNowPositives, (candidate) => candidate.raw, "max"),
                pick("TOP_MEAN_PROFIT_NOW", "long", latestView.profitNowPositives, (candidate) => candidate.mean, "max"),
                pick("TOP_RAW_PROFIT_NOW_CONF", "long", latestView.profitNowConfidencePositives, (candidate) => candidate.raw, "max"),
                pick("TOP_Z", "long", latestView.profitNowPositives, (candidate) => candidate.z ?? Number.NEGATIVE_INFINITY, "max"),
                pick("BOT_RAW", "long", latestView.positives, (candidate) => candidate.raw, "min"),
                pick("BOT_MEAN", "long", latestView.positives, (candidate) => candidate.mean, "min"),
                pick("BOT_MEAN_RAW_UNIQUE", "long", latestView.positives, (candidate) => candidate.mean, "min", (candidate) => candidate.raw, "min"),
                pick("BOT_RAW_PROFIT_NOW", "long", latestView.profitNowPositives, (candidate) => candidate.raw, "min"),
                pick("BOT_MEAN_PROFIT_NOW", "long", latestView.profitNowPositives, (candidate) => candidate.mean, "min"),
                pick("BOT_Z", "long", latestView.profitNowPositives, (candidate) => candidate.z ?? Number.POSITIVE_INFINITY, "min"),
            ],
        };
    })();

    if (cooldownBars <= 0) {
        return { gapFilteredViews, gapFilteredProfitOnlyEvents, botPicksByView, latestSelections };
    }

    type ArmField = keyof ReplayArmSelectionMap;
    type RankDirection = "max" | "min";
    interface ArmSpec {
        field: ArmField;
        pool: "positives" | "profitPositives" | "profitNowPositives" | "profitNowConfidencePositives";
        key: UsableRankKey;
        direction: RankDirection;
        uniqueRaw?: "max" | "min";
    }
    const specs: ArmSpec[] = [
        ...(args.enableCausalArms ? CAUSAL_ARM_FIELDS.map((field): ArmSpec => ({ field, pool: "positives", key: field, direction: "max" })) : []),
        { field: "topRawProfitNow", pool: "profitNowPositives", key: "raw", direction: "max" },
        { field: "topMeanProfitNow", pool: "profitNowPositives", key: "mean", direction: "max" },
        { field: "topRawProfitNowConf", pool: "profitNowConfidencePositives", key: "raw", direction: "max" },
        { field: "topZ", pool: "profitNowPositives", key: "z", direction: "max" },
        { field: "topRaw", pool: "positives", key: "raw", direction: "max" },
        { field: "topMean", pool: "positives", key: "mean", direction: "max" },
        { field: "topMeanRawUnique", pool: "positives", key: "mean", direction: "max", uniqueRaw: "max" },
        { field: "topRawProfit", pool: "profitPositives", key: "raw", direction: "max" },
        { field: "topMeanProfit", pool: "profitPositives", key: "mean", direction: "max" },
        { field: "botRawProfitNow", pool: "profitNowPositives", key: "raw", direction: "min" },
        { field: "botMeanProfitNow", pool: "profitNowPositives", key: "mean", direction: "min" },
        { field: "botZ", pool: "profitNowPositives", key: "z", direction: "min" },
        { field: "botRaw", pool: "positives", key: "raw", direction: "min" },
        { field: "botMean", pool: "positives", key: "mean", direction: "min" },
        { field: "botMeanRawUnique", pool: "positives", key: "mean", direction: "min", uniqueRaw: "min" },
    ];
    const armSelectionsByView: Array<ReplayArmSelectionMap | null> = new Array(views.length).fill(null);
    const armSelectionsByProfitOnly: Array<ReplayArmSelectionMap | null> = new Array(profitOnlyEvents.length).fill(null);
    // Only the final view needs its eligible candidates for the UI's latest
    // selection explanation. Historical selections retain scalar metadata;
    // their pools are reconstructed from event candidates during aggregation.
    const latestEligiblePools = new Map<ArmField, readonly Candidate[]>();
    const lastSelectedBoundaryByArm = new Map<ArmField, Map<number, number>>();
    for (const spec of specs) lastSelectedBoundaryByArm.set(spec.field, new Map());
    const timeline = [
        ...views.map((view, index) => ({ kind: "view" as const, index, timeSec: view.timeSec })),
        ...profitOnlyEvents.map((event, index) => ({ kind: "profit" as const, index, timeSec: event.timeSec })),
    ].sort((left, right) => left.timeSec - right.timeSec);

    for (let timelineIndex = 0; timelineIndex < timeline.length; timelineIndex += 1) {
        if ((timelineIndex & 0x1ff) === 0) {
            if (args.shouldStop?.()) throw new Error("OPEN_SCORE USD replay cancelled during selector cooldown.");
            if (timelineIndex > 0) await yieldLoop();
        }
        const entry = timeline[timelineIndex]!;
        const eventIndex = entry.kind === "view" ? entry.index : views.length + entry.index;
        const sourceView = entry.kind === "view" ? gapFilteredViews[entry.index] : null;
        const sourceProfitOnly = entry.kind === "profit" ? gapFilteredProfitOnlyEvents[entry.index] : null;
        const pools: Record<ArmSpec["pool"], readonly Candidate[]> = sourceView
            ? {
                positives: sourceView.positives,
                profitPositives: sourceView.profitPositives,
                profitNowPositives: sourceView.profitNowPositives,
                profitNowConfidencePositives: sourceView.profitNowConfidencePositives,
            }
            : {
                positives: [],
                profitPositives: sourceProfitOnly?.profitPositives ?? [],
                profitNowPositives: sourceProfitOnly?.profitNowPositives ?? [],
                profitNowConfidencePositives: sourceProfitOnly?.profitNowConfidencePositives ?? [],
            };
        const boundaryByAsset = args.boundaryIndicesByView?.[eventIndex] ?? null;
        const resolved: ReplayArmSelectionMap = {};
        for (const spec of specs) {
            const pool = isCausalArm(spec.field)
                ? causalCandidatePool(entry.kind === "view" ? views[entry.index]!.positives : [], spec.field)
                : pools[spec.pool];
            const previous = lastSelectedBoundaryByArm.get(spec.field)!;
            const remaining = boundaryByAsset
                ? pool.filter((candidate) => {
                    const boundary = boundaryByAsset.get(candidate.assetIndex);
                    const lastSelected = previous.get(candidate.assetIndex);
                    return boundary === undefined || lastSelected === undefined || boundary - lastSelected > cooldownBars;
                })
                : [...pool];
            let rankPool = remaining;
            let selectedAssetIndex = -1;
            let tiedCount = 0;
            let control: "leave_one_out" | "mean_tied_set" = "leave_one_out";
            if (remaining.length > 0 && spec.uniqueRaw) {
                let bestMean = usableRankValue(remaining[0]!, "mean");
                for (let i = 1; i < remaining.length; i += 1) {
                    const value = usableRankValue(remaining[i]!, "mean");
                    if (spec.direction === "max" ? value > bestMean : value < bestMean) bestMean = value;
                }
                rankPool = remaining.filter((candidate) => usableRankValue(candidate, "mean") === bestMean);
                let bestRaw = rankPool[0]!.raw;
                for (let i = 1; i < rankPool.length; i += 1) {
                    const value = rankPool[i]!.raw;
                    if (spec.uniqueRaw === "max" ? value > bestRaw : value < bestRaw) bestRaw = value;
                }
                const rawTied = rankPool.filter((candidate) => candidate.raw === bestRaw);
                tiedCount = rawTied.length;
                if (rawTied.length === 1) selectedAssetIndex = rawTied[0]!.assetIndex;
                control = "mean_tied_set";
            } else if (remaining.length > 0) {
                const ranked = spec.direction === "max"
                    ? pickUsableMaxByAssetNames(remaining, spec.key, entry.timeSec, assetNames)
                    : pickUsableMinByAssetNames(remaining, spec.key, entry.timeSec, assetNames);
                if (ranked) {
                    selectedAssetIndex = ranked.winner.assetIndex;
                    tiedCount = ranked.tiedCount;
                }
            }
            resolved[spec.field] = {
                selectedAssetIndex,
                tiedCount,
                poolSize: rankPool.length,
                eligiblePoolSize: remaining.length,
                control,
            };
            if (args.onRankingSelection) {
                const original = entry.kind === "view" ? views[entry.index] : profitOnlyEvents[entry.index];
                const originalSource = original && spec.pool in original ? (original as EventView)[spec.pool] : [];
                const originalPool = isCausalArm(spec.field) ? causalCandidatePool(originalSource, spec.field) : originalSource;
                const frozenPool = boundaryByAsset ? originalPool.filter((candidate) => {
                    const boundary = boundaryByAsset.get(candidate.assetIndex);
                    const last = previous.get(candidate.assetIndex);
                    return boundary === undefined || last === undefined || boundary - last > cooldownBars;
                }) : originalPool;
                args.onRankingSelection(entry.timeSec, spec.field, frozenPool, selectedAssetIndex);
            }
            if (entry.kind === "view" && entry.index === views.length - 1) {
                latestEligiblePools.set(spec.field, remaining);
            }
            if (selectedAssetIndex >= 0) {
                const boundary = boundaryByAsset?.get(selectedAssetIndex);
                if (boundary !== undefined) previous.set(selectedAssetIndex, boundary);
            }
        }
        if (entry.kind === "view") armSelectionsByView[entry.index] = resolved;
        else armSelectionsByProfitOnly[entry.index] = resolved;
    }

    // Latest-picks is a view of the final ordinary decision event. Reuse the
    // already-resolved selection for that event so displaying it cannot apply
    // the final event to cooldown state a second time.
    const latestViewIndex = views.length - 1;
    const latestResolved = latestViewIndex >= 0 ? armSelectionsByView[latestViewIndex] : null;
    const cooldownLatestSelections: OpenScoreUsdLatestSelections | null = latestSelections && latestResolved
        ? {
            decisionTime: latestSelections.decisionTime,
            selections: latestSelections.selections.map((current) => {
                const fieldBySelector: Partial<Record<OpenScoreUsdLatestSelectorName, ArmField>> = {
                    TOP_RAW: "topRaw",
                    TOP_MEAN: "topMean",
                    TOP_MEAN_RAW_UNIQUE: "topMeanRawUnique",
                    TOP_RAW_PROFIT_NOW: "topRawProfitNow",
                    TOP_MEAN_PROFIT_NOW: "topMeanProfitNow",
                    TOP_RAW_PROFIT_NOW_CONF: "topRawProfitNowConf",
                    TOP_Z: "topZ",
                    BOT_RAW: "botRaw",
                    BOT_MEAN: "botMean",
                    BOT_MEAN_RAW_UNIQUE: "botMeanRawUnique",
                    BOT_RAW_PROFIT_NOW: "botRawProfitNow",
                    BOT_MEAN_PROFIT_NOW: "botMeanProfitNow",
                    BOT_Z: "botZ",
                };
                const field = fieldBySelector[current.selector];
                const selection = field ? latestResolved[field] : undefined;
                if (!field || !selection) return current;
                const spec = specs.find((candidate) => candidate.field === field)!;
                const eligiblePool = latestEligiblePools.get(field) ?? [];
                const ranked = [...eligiblePool].sort((left, right) => {
                    const leftValue = usableRankValue(left, spec.key);
                    const rightValue = usableRankValue(right, spec.key);
                    if (leftValue !== rightValue) return spec.direction === "max"
                        ? rightValue - leftValue
                        : leftValue - rightValue;
                    return assetNames[left.assetIndex]!.localeCompare(assetNames[right.assetIndex]!);
                });
                const topCandidates = ranked.slice(0, 3).map((candidate) => ({
                    asset: assetNames[candidate.assetIndex]!,
                    score: candidate.raw,
                    mean: candidate.mean,
                    activePairs: candidate.activePairs,
                }));
                const picked = eligiblePool.find((candidate) => candidate.assetIndex === selection.selectedAssetIndex);
                const tieValue = picked ? usableRankValue(picked, spec.key) : null;
                let tiedAssets: string[] = [];
                if (selection.tiedCount > 1 && selection.control === "mean_tied_set") {
                    const meanBest = eligiblePool.reduce((best, candidate) =>
                        spec.direction === "max" ? Math.max(best, candidate.mean) : Math.min(best, candidate.mean),
                    eligiblePool[0]!.mean);
                    const meanTiedPool = eligiblePool.filter((candidate) => candidate.mean === meanBest);
                    let bestRaw = meanTiedPool[0]!.raw;
                    for (const candidate of meanTiedPool.slice(1)) {
                        if (spec.uniqueRaw === "max" ? candidate.raw > bestRaw : candidate.raw < bestRaw) {
                            bestRaw = candidate.raw;
                        }
                    }
                    tiedAssets = meanTiedPool
                        .filter((candidate) => candidate.raw === bestRaw)
                        .map((candidate) => assetNames[candidate.assetIndex]!)
                        .sort((left, right) => left.localeCompare(right));
                } else if (selection.tiedCount > 1) {
                    tiedAssets = eligiblePool
                        .filter((candidate) => usableRankValue(candidate, spec.key) === tieValue)
                        .map((candidate) => assetNames[candidate.assetIndex]!)
                        .sort((left, right) => left.localeCompare(right));
                }
                return {
                    ...current,
                    asset: picked ? assetNames[picked.assetIndex]! : null,
                    tiedAssets,
                    score: picked?.raw ?? null,
                    mean: picked?.mean ?? null,
                    activePairs: picked?.activePairs ?? null,
                    eligibleCandidates: selection.eligiblePoolSize,
                    reason: picked ? "selected" : selection.tiedCount > 1 ? "tied" : "insufficient_candidates",
                    topCandidates,
                };
            }),
        }
        : latestSelections;

    return {
        gapFilteredViews,
        gapFilteredProfitOnlyEvents,
        botPicksByView,
        latestSelections: cooldownLatestSelections,
        armSelectionsByView,
        armSelectionsByProfitOnly,
    };
}
