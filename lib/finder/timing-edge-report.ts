/**
 * Timing Edge report builder.
 *
 * Consumes persisted Mine Timing runs (`TimingEdgePersistedRun[]` from the
 * `mine_timing_*` SQLite tables) and produces the per-asset rows the Assets
 * tab renders. This is the Mine-Timing-fed counterpart to the universe-fed
 * `lib/finder/asset-leadership.ts` reducer.
 *
 * Design notes:
 * - Source-aware: stability runs contribute scored rows; one-shot mine runs
 *   contribute directional snapshots. Both roll up to the same row shape.
 * - "Top Timing Edge" ranks by score (stability) or by OOS lift (mine).
 * - "Rising/Falling" compares recent-window score vs previous-window score
 *   per asset, mirroring the leadership report's trend semantics.
 */

import type { TimingEdgePersistedRun, TimingEdgeVerdictSnapshot } from "../batch-backtest/mine-timing-persistence";

export interface TimingEdgeAssetRow {
    asset: string;
    /** Latest-run score. Stability: timingEdgeScore. Mine: lift-derived. */
    score: number;
    scoreChange: number;
    trend: "up" | "down" | "flat";
    /** Appearances = number of runs in which this asset produced a LONG/SHORT verdict. */
    appearances: number;
    profitableRate: number;
    /** Per-asset average across appearances. */
    avgLiftPct: number;
    avgRr: number;
    avgDiversity: number;
    /** Direction from the latest non-trivial verdict. */
    latestDirection: "LONG" | "SHORT" | null;
    latestConfidence: string;
    /** Pair that appeared most often as dominant_pair across appearances. */
    strongestPair: string | null;
    /** Of the latest run: pair warnings / hits. Lower is healthier. */
    latestPairWarnings: number;
    latestHits: number;
    /** Latest snapshot's edge metrics — what the row currently "looks like". */
    latestLiftPct: number | null;
    latestHmaxLiftPct: number | null;
    latestDiversity: number;
}

export interface TimingEdgeReport {
    runs: TimingEdgePersistedRun[];
    topTimingEdge: TimingEdgeAssetRow[];
    longTriggers: TimingEdgeAssetRow[];
    shortTriggers: TimingEdgeAssetRow[];
    risingEdge: TimingEdgeAssetRow[];
    fallingEdge: TimingEdgeAssetRow[];
    diverseStable: TimingEdgeAssetRow[];
    overview: {
        totalRuns: number;
        /** Number of unique (asset, direction) edges — TWO if WLD appeared as both LONG and SHORT. */
        totalAssets: number;
        /** Number of unique asset names, regardless of how many directions each appeared in. */
        totalUniqueAssets: number;
        totalVerdicts: number;
        longTriggerCount: number;
        shortTriggerCount: number;
        /** Direction-qualified (e.g. "WLD SHORT") so the chip is unambiguous when the same asset has rows in both directions. */
        topAsset: string | null;
        topScore: number;
    };
}

const RECENT_WINDOW_RUNS = 6;
const TOP_LIMIT = 12;

/**
 * Project one persisted verdict snapshot to a per-run per-asset contribution.
 * Filters to LONG/SHORT only — WATCH/SKIP/INCONCLUSIVE don't represent a
 * timing-edge signal, they represent the absence of one.
 */
function relevantVerdicts(run: TimingEdgePersistedRun): TimingEdgeVerdictSnapshot[] {
    return run.verdicts.filter((v) => v.verdict === "LONG" || v.verdict === "SHORT");
}

/**
 * Score for a single verdict within a single run. For stability runs this is
 * the precomputed `timingEdgeScore` (already folds in diversity + warnings +
 * confidence). For one-shot mine runs there's no rerun aggregation, so we
 * synthesize a comparable score from lift × confidence. The mine-derived
 * score is intentionally simpler — without rerun independence data it cannot
 * match the stability score's signal, only its scale.
 *
 * Note: mine runs frequently have null longest-horizon fields (insufficient
 * analogs). An earlier version gated on `longestOosLiftPct > 0` and silently
 * zeroed the score whenever it was null — turning every mine row with thin
 * OOS data into a score-0 row, regardless of how strong the per-bar lift was.
 * The gate is dropped for mine for that reason; stability's precomputed score
 * already encodes horizon persistence.
 */
function verdictScore(snapshot: TimingEdgeVerdictSnapshot, source: "mine" | "stability"): number {
    if (source === "stability") return snapshot.timingEdgeScore;
    const lift = snapshot.oosLiftPct ?? snapshot.expectedForwardReturnPct ?? 0;
    const liftFactor = Math.max(0, Math.min(1, lift / 5));
    const confidenceFactor = snapshot.confidence === "high" ? 1 : snapshot.confidence === "medium" ? 0.6 : 0.3;
    return Math.round(100 * liftFactor * confidenceFactor);
}

function rrOrNan(snapshot: TimingEdgeVerdictSnapshot): number {
    if (snapshot.medianRr !== null && Number.isFinite(snapshot.medianRr)) return snapshot.medianRr;
    // One-shot mine has no rr; synthesize from MFE/MAE if present.
    const mfe = snapshot.expectedMfePct;
    const mae = snapshot.expectedMaePct;
    if (mfe === null || mae === null || !Number.isFinite(mfe) || !Number.isFinite(mae)) return 0;
    const adverse = Math.abs(mae);
    if (adverse <= 1e-9) return mfe > 0 ? 10 : 0;
    return mfe / adverse;
}

function buildAssetRow(
    asset: string,
    contributions: Array<{ run: TimingEdgePersistedRun; verdict: TimingEdgeVerdictSnapshot }>,
): TimingEdgeAssetRow {
    // Contributions sorted oldest → newest so the "latest" is the last element.
    // Tiebreak on runId so two runs with identical createdAt (rare, but a
    // stability + mine persisting in the same millisecond can collide) don't
    // leave "latest" dependent on input order.
    const sorted = [...contributions].sort((a, b) =>
        a.run.createdAt - b.run.createdAt || a.run.runId.localeCompare(b.run.runId)
    );
    const latest = sorted[sorted.length - 1]!;
    const latestVerdict = latest.verdict;

    const scores = sorted.map((c) => verdictScore(c.verdict, c.run.source));
    const latestScore = scores[scores.length - 1] ?? 0;

    // Recent-window vs previous-window trend (mirrors asset-leadership semantics).
    const recentWindow = sorted.slice(-RECENT_WINDOW_RUNS);
    const previousWindow = sorted.slice(0, Math.max(0, sorted.length - RECENT_WINDOW_RUNS));
    const recentAvg = avg(recentWindow.map((c) => verdictScore(c.verdict, c.run.source)));
    const previousAvg = avg(previousWindow.map((c) => verdictScore(c.verdict, c.run.source)));
    const scoreChange = recentAvg - previousAvg;
    const trend: TimingEdgeAssetRow["trend"] =
        Math.abs(scoreChange) < 0.5 ? "flat" : scoreChange > 0 ? "up" : "down";

    const lifts = sorted.map((c) => c.verdict.medianLiftPct ?? c.verdict.oosLiftPct ?? 0);
    const diversities = sorted.map((c) => c.verdict.medianDiversity ?? 0);
    const rrs = sorted.map((c) => rrOrNan(c.verdict));

    // Dominant pair across appearances.
    const pairCounts = new Map<string, number>();
    for (const c of sorted) {
        const pair = c.verdict.dominantPair;
        if (pair) pairCounts.set(pair, (pairCounts.get(pair) ?? 0) + 1);
    }
    let strongestPair: string | null = null;
    let strongestPairCount = 0;
    for (const [pair, count] of pairCounts) {
        if (count > strongestPairCount) {
            strongestPair = pair;
            strongestPairCount = count;
        }
    }

    const profitableAppearances = scores.filter((s) => s > 0).length;

    return {
        asset,
        score: latestScore,
        scoreChange,
        trend,
        appearances: sorted.length,
        profitableRate: sorted.length > 0 ? profitableAppearances / sorted.length : 0,
        avgLiftPct: avg(lifts),
        avgRr: avg(rrs),
        avgDiversity: avg(diversities),
        latestDirection: latestVerdict.verdict === "LONG" ? "LONG" : latestVerdict.verdict === "SHORT" ? "SHORT" : null,
        latestConfidence: latestVerdict.confidence,
        strongestPair,
        latestPairWarnings: latestVerdict.pairWarnings,
        latestHits: latestVerdict.hits,
        latestLiftPct: latestVerdict.medianLiftPct ?? latestVerdict.oosLiftPct,
        latestHmaxLiftPct: latestVerdict.medianHmaxLiftPct ?? latestVerdict.longestOosForwardReturnPct,
        latestDiversity: latestVerdict.medianDiversity ?? 0,
    };
}

function avg(values: number[]): number {
    if (values.length === 0) return 0;
    return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function sortByScoreDesc(rows: TimingEdgeAssetRow[]): TimingEdgeAssetRow[] {
    return [...rows].sort((a, b) =>
        b.score - a.score
        || b.profitableRate - a.profitableRate
        || b.avgLiftPct - a.avgLiftPct
        || a.asset.localeCompare(b.asset)
    );
}

export function buildTimingEdgeReport(input: { runs: TimingEdgePersistedRun[] }): TimingEdgeReport {
    const runs = [...input.runs].sort((a, b) => a.createdAt - b.createdAt);
    // Key by `${asset}|${direction}`, NOT just asset. A LONG verdict from
    // strategy A and a SHORT verdict from strategy B on the same asset are
    // independent edges — averaging their lifts cancels signal (a +5% long
    // lift and a +5% short lift are opposite bets, not "5% lift"). Per-
    // direction keying makes every average direction-honest by construction
    // and lets the same asset legitimately appear in both Long Triggers and
    // Short Triggers when different strategies disagree on its edge.
    const byAssetDirection = new Map<string, { asset: string; contributions: Array<{ run: TimingEdgePersistedRun; verdict: TimingEdgeVerdictSnapshot }> }>();
    let totalVerdicts = 0;
    for (const run of runs) {
        const relevant = relevantVerdicts(run);
        totalVerdicts += relevant.length;
        for (const verdict of relevant) {
            const key = `${verdict.asset}|${verdict.verdict}`;
            const entry = byAssetDirection.get(key) ?? { asset: verdict.asset, contributions: [] };
            entry.contributions.push({ run, verdict });
            byAssetDirection.set(key, entry);
        }
    }
    const allRows = Array.from(byAssetDirection.values()).map((entry) => buildAssetRow(entry.asset, entry.contributions));

    const topTimingEdge = sortByScoreDesc(allRows).slice(0, TOP_LIMIT);
    const longTriggers = sortByScoreDesc(allRows.filter((r) => r.latestDirection === "LONG")).slice(0, TOP_LIMIT);
    const shortTriggers = sortByScoreDesc(allRows.filter((r) => r.latestDirection === "SHORT")).slice(0, TOP_LIMIT);
    // Rising/Falling require a NON-EMPTY previous window to compare against.
    // The previous window is `sorted.slice(0, length - RECENT_WINDOW_RUNS)` —
    // empty unless appearances > RECENT_WINDOW_RUNS. With an empty previous
    // window `previousAvg = 0`, so any positive-scoring row would trend "up"
    // from a zero baseline and the section becomes noise (every row appears
    // in both lists). The strict `>` gate ensures we only trend rows that
    // have genuinely transitioned across the window boundary.
    //
    // Additionally, Rising only includes positive scoreChange and Falling only
    // negative — sorting alone puts the same rows in both lists when scores
    // are all positive.
    const trendRows = allRows.filter((r) => r.appearances > RECENT_WINDOW_RUNS);
    const risingEdge = trendRows
        .filter((r) => r.scoreChange > 0)
        .sort((a, b) => b.scoreChange - a.scoreChange)
        .slice(0, TOP_LIMIT);
    const fallingEdge = trendRows
        .filter((r) => r.scoreChange < 0)
        .sort((a, b) => a.scoreChange - b.scoreChange)
        .slice(0, TOP_LIMIT);
    // Diverse & Stable: high diversity AND profitable — the highest-trust rows.
    const diverseStable = sortByScoreDesc(
        allRows.filter((r) => r.latestDiversity >= 0.5 && r.profitableRate >= 0.5)
    ).slice(0, TOP_LIMIT);

    const topRow = topTimingEdge[0];
    return {
        runs,
        topTimingEdge,
        longTriggers,
        shortTriggers,
        risingEdge,
        fallingEdge,
        diverseStable,
        overview: {
            totalRuns: runs.length,
            totalAssets: allRows.length,
            totalUniqueAssets: new Set(allRows.map((r) => r.asset)).size,
            totalVerdicts,
            longTriggerCount: longTriggers.length,
            shortTriggerCount: shortTriggers.length,
            topAsset: topRow ? `${topRow.asset} ${topRow.latestDirection ?? ""}`.trim() : null,
            topScore: topRow?.score ?? 0,
        },
    };
}

/**
 * Pure projection used by the Copy button and tests. One line per top asset,
 * pipe-delimited to match the Mine Timing row format.
 */
export function formatTimingEdgeReportRow(row: TimingEdgeAssetRow): string {
    const fmt = (v: number | null | undefined, digits = 2): string =>
        (v === null || v === undefined || !Number.isFinite(v)) ? "--" : v.toFixed(digits);
    const fmtPct = (v: number | null | undefined): string => {
        if (v === null || v === undefined || !Number.isFinite(v)) return "--";
        return `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;
    };
    return [
        row.asset,
        `Dir ${row.latestDirection ?? "--"}`,
        `Score ${fmt(row.score, 1)}`,
        `Conf ${row.latestConfidence}`,
        `Appr ${row.appearances}`,
        `Profit% ${(row.profitableRate * 100).toFixed(0)}%`,
        `AvgLift ${fmtPct(row.avgLiftPct)}`,
        `AvgRR ${fmt(row.avgRr)}`,
        `AvgDiv ${(row.avgDiversity * 100).toFixed(0)}%`,
        `Latest ${fmtPct(row.latestLiftPct)} lift / ${fmtPct(row.latestHmaxLiftPct)} hmax`,
        `Pair ${row.strongestPair ?? "--"}`,
        `Warn ${row.latestPairWarnings}/${row.latestHits}`,
    ].join(" | ");
}
