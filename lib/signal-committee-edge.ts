/**
 * Pure Score Edge Report computation for the Signal Committee.
 *
 * Given the visible chart bars (closes) and the per-bar committee score (from
 * `computeCommitteeOverlayScores`), answer a deterministic question:
 *   "Does the committee score predict forward returns on THIS chart?"
 *
 * The answer is arithmetic, not judgment (AGENTS.md §5): forward-return means
 * and win rates bucketed by score value, plus a score-driven long/short
 * strategy summary. An LLM can narrate the summary stats via the AI export,
 * but it must not recompute them — the numbers here are the source of truth.
 *
 * No DOM, no network, no side effects. Unit-testable.
 */
import { calculateSharpeRatioFromReturns } from "./strategies/performance-metrics";
import { mean, sampleStdDev } from "./statistics-utils";

/** Default bar-count horizons for forward returns. On 1m: 5m/15m/1h. */
export const DEFAULT_EDGE_HORIZONS = [5, 15, 60] as const;
/** Buckets with fewer samples than this are flagged `thin` (not hidden). */
export const DEFAULT_EDGE_MIN_SAMPLES = 3;
/**
 * Minimum |drift-adjusted| return (in percent) for a reversal to be flagged.
 * A near-zero effect is not actionable even with huge n — large-sample trivial
 * effects are noise, not fades. 0.03% = 3 bp; the score=4 reversal at ~37 bp
 * clears it easily, the score=2 artifact at ~0.5 bp does not.
 */
export const REVERSAL_MAGNITUDE_FLOOR_PCT = 0.03;
/** t-stat below this is "not significant" (two-sided rough cut, ~p>0.10). */
export const TSTAT_NOT_SIGNIFICANT = 1.65;
/** t-stat at/above this is "significant" (two-sided rough cut, ~p<=0.05). */
export const TSTAT_SIGNIFICANT = 1.96;
/**
 * Minimum |winRate − 0.5| for a bucket to qualify as a strong-edge signal,
 * on top of the magnitude floor. Guards against a bucket that has a real-sized
 * mean return driven by a few large moves while most bars are coin-flips —
 * a "confirmed" signal should also win (or lose) decisively by frequency.
 */
export const STRONG_EDGE_WIN_DEVIATION = 0.05;

export interface ScoreEdgeOptions {
    horizons?: readonly number[];
    minSamples?: number;
}

/** One forward-return horizon's stats within a single score bucket. */
export interface ScoreEdgeHorizonStat {
    horizon: number;
    /** Number of bars that contributed a finite forward return at this horizon. */
    samples: number;
    /** Mean forward return (percent) across contributing bars. */
    meanForwardReturnPct: number;
    /**
     * Mean forward return minus the chart's per-bar drift scaled to this
     * horizon. Removes the "everything went up because the asset went up"
     * effect so a bucket's number reads as score-specific edge, not beta.
     */
    driftAdjustedPct: number;
    /**
     * Drift-adjusted return in basis points (×100). Surfaces tiny edges in a
     * unit where 1 bp = 0.01%, so a 0.0047% effect reads as "0.47 bp" (clearly
     * trivial) next to a 37 bp one — instead of both looking like "~0%".
     */
    effectSizeBp: number;
    /** Fraction of contributing bars with a positive forward return, 0..1. */
    winRate: number;
    /** True when `samples < minSamples` — read as suggestive, not significant. */
    thin: boolean;
}

/** Aggregate forward-return stats for one committee score value. */
export interface ScoreEdgeBucket {
    score: number;
    horizons: ScoreEdgeHorizonStat[];
    /**
     * True when the bucket's drift-adjusted return contradicts the score's sign
     * at the longest non-thin horizon AND exceeds the economic-magnitude floor
     * — e.g. score=+4 with meaningfully negative forward returns (a crowded-
     * trade reversal). A near-zero drift-adjusted effect is NOT flagged even
     * with huge n, because a large-sample trivial effect is not actionable.
     */
    reversal: boolean;
}

/**
 * Significance band for the strategy's aggregate edge. `tStat = sharpeRaw ×
 * √(inMarketBars)`; bands follow the conventional two-sided rough cut. The
 * strategy's cumulative return is only trustworthy as "alpha" when this is
 * "significant" — otherwise a large cumulative is just small-edge × many bets
 * (within sampling noise), not a reliable alpha.
 */
export type ScoreEdgeSignificance = "not significant" | "marginal" | "significant";

/**
 * Score-driven long/short strategy stats. The strategy holds the score's sign:
 * long when score > 0, short when score < 0, flat when 0. Returns are the
 * realized close-to-close percent move signed by the position direction.
 */
export interface ScoreEdgeStrategyStats {
    cumulativeReturnPct: number;
    /**
     * Buy-and-hold return over the same window: (lastClose - firstClose) /
     * firstClose * 100. The alpha-vs-beta read: if `cumulativeReturnPct` ≈
     * `buyAndHoldReturnPct`, the score added no timing edge.
     */
    buyAndHoldReturnPct: number;
    /** Strategy cumulative minus buy-and-hold. Positive = real alpha. */
    alphaPct: number;
    /** Per-bar close-to-close drift of the underlying, percent. */
    driftPerBarPct: number;
    /** Per-bar signed returns fed to the Sharpe calc (raw, not annualized). */
    sharpeRaw: number;
    /**
     * t-statistic of the aggregate strategy edge = sharpeRaw × √(inMarketBars).
     * The honest significance read for the cumulative/alpha numbers: a large
     * cumulative with t < ~2 is within sampling noise, not reliable alpha.
     */
    tStat: number;
    /** Band derived from `tStat`. */
    significance: ScoreEdgeSignificance;
    longBars: number;
    shortBars: number;
    flatBars: number;
    /** Mean signed per-bar return, percent. */
    meanBarReturnPct: number;
    /** Sample std dev of signed per-bar returns, percent. */
    stdDevBarReturnPct: number;
}

export interface ScoreEdgeReport {
    symbol: string;
    interval: string;
    barCount: number;
    /** [min, max] score observed across scored bars. */
    scoreRange: { min: number; max: number };
    horizons: number[];
    buckets: ScoreEdgeBucket[];
    strategy: ScoreEdgeStrategyStats;
    /**
     * Plain-text headline findings auto-detected from the buckets (reversal
     * buckets, monotonic-edge observations). Empty when nothing stands out.
     * Surfaced verbatim in the AI export so the buried finding becomes a
     * headline instead of requiring a human to scan the table.
     */
    notableFindings: string[];
    generatedAtIso: string;
}

/** Candle shape consumed by the edge calc — only `close` is needed. */
export interface ScoreEdgeCandle {
    close: number;
}

/**
 * Forward percent return from bar `i` to bar `i + horizon`, for each horizon.
 * Returns `null` for a horizon when the target bar is out of range or any
 * involved price is non-finite/non-positive (avoids div-by-zero).
 *
 * Convention matches the inline calc in `backtest-result-analysis.ts`
 * (`((targetClose - entryPrice) / entryPrice) * 100`).
 */
export function computeForwardReturnsAt(
    closes: ReadonlyArray<number>,
    i: number,
    horizons: ReadonlyArray<number>
): Array<{ horizon: number; forwardReturnPct: number | null }> {
    const entry = closes[i];
    const out: Array<{ horizon: number; forwardReturnPct: number | null }> = [];
    if (!Number.isFinite(entry) || entry <= 0) {
        return horizons.map((h) => ({ horizon: h, forwardReturnPct: null }));
    }
    for (const h of horizons) {
        const target = closes[i + h];
        if (!Number.isFinite(target) || target <= 0) {
            out.push({ horizon: h, forwardReturnPct: null });
            continue;
        }
        out.push({ horizon: h, forwardReturnPct: ((target - entry) / entry) * 100 });
    }
    return out;
}

/**
 * Build the Score Edge Report.
 *
 * Returns `null` when there are no usable bars (no closes, no scores, or
 * length mismatch) so the caller can hide the section instead of showing
 * misleading empty stats. An all-zero score series still returns a report
 * (every bar lands in the score=0 bucket) — that's a real signal ("committee
 * never agreed"), not missing data.
 *
 * @param candles  visible chart bars; only `.close` is read.
 * @param scores   per-bar net committee vote, index-aligned with `candles`.
 *   Length may exceed `candles.length`; the extra tail is ignored. Non-finite
 *   scores are skipped (they don't land in any bucket).
 * @param symbol/interval  carried through for display + AI export.
 */
export function computeScoreEdgeReport(
    candles: ReadonlyArray<ScoreEdgeCandle>,
    scores: ReadonlyArray<number>,
    symbol: string,
    interval: string,
    options?: ScoreEdgeOptions
): ScoreEdgeReport | null {
    const n = Math.min(candles.length, scores.length);
    if (n === 0) return null;

    const horizons = (options?.horizons && options.horizons.length > 0
        ? Array.from(options.horizons)
        : Array.from(DEFAULT_EDGE_HORIZONS));
    const minSamples = Math.max(1, Math.floor(options?.minSamples ?? DEFAULT_EDGE_MIN_SAMPLES));

    const closes = candles.map((c) => c.close);

    // Per-score buckets: Map<score, Array<horizonIndex, returns[]>>
    const bucketReturns = new Map<number, Array<number | null>[]>();
    let scoreMin = Infinity;
    let scoreMax = -Infinity;

    // Strategy + benchmark accumulators.
    const signedBarReturns: number[] = [];
    let longBars = 0;
    let shortBars = 0;
    let flatBars = 0;

    // Drift = mean close-to-close return across all finite bars (the asset's
    // own directional bias). Used to drift-adjust bucket returns so beta
    // doesn't masquerade as score edge.
    let driftSum = 0;
    let driftCount = 0;

    for (let i = 0; i < n; i++) {
        const score = scores[i];
        const finiteScore = Number.isFinite(score);

        // Drift is computed across ALL finite close-to-close moves, independent
        // of whether the score is finite, so it reflects the asset not the score.
        const entry = closes[i];
        const next = closes[i + 1];
        if (Number.isFinite(entry) && entry > 0 && Number.isFinite(next)) {
            driftSum += ((next - entry) / entry) * 100;
            driftCount++;
        }

        if (!finiteScore) continue;
        if (score! < scoreMin) scoreMin = score!;
        if (score! > scoreMax) scoreMax = score!;

        // Bucket accumulation: forward returns at each horizon.
        if (!bucketReturns.has(score)) {
            bucketReturns.set(score, horizons.map(() => [] as Array<number | null>));
        }
        const horizonReturns = bucketReturns.get(score)!;
        const forward = computeForwardReturnsAt(closes, i, horizons);
        forward.forEach((f, idx) => {
            horizonReturns[idx]!.push(f.forwardReturnPct);
        });

        // Strategy: position = sign(score), realized at next bar's close move.
        if (Number.isFinite(entry) && entry > 0 && Number.isFinite(next)) {
            const rawMove = ((next - entry) / entry) * 100;
            if (score! > 0) {
                signedBarReturns.push(rawMove);
                longBars++;
            } else if (score! < 0) {
                signedBarReturns.push(-rawMove);
                shortBars++;
            } else {
                flatBars++;
            }
        } else if (score === 0) {
            flatBars++;
        }
    }

    const driftPerBarPct = driftCount > 0 ? driftSum / driftCount : 0;

    // Build bucket view-models, sorted by score ascending.
    const buckets: ScoreEdgeBucket[] = Array.from(bucketReturns.keys())
        .sort((a, b) => a - b)
        .map((score) => {
            const horizonReturns = bucketReturns.get(score)!;
            const horizonStats = horizons.map((h, idx) => {
                const finite = horizonReturns[idx]!.filter(
                    (v): v is number => v !== null && Number.isFinite(v)
                );
                const wins = finite.filter((v) => v > 0).length;
                const meanRet = mean(finite);
                // Drift over `h` bars = per-bar drift * h. Subtract so the
                // bucket reads as score-specific edge, not market beta.
                const driftAdj = meanRet - driftPerBarPct * h;
                return {
                    horizon: h,
                    samples: finite.length,
                    meanForwardReturnPct: meanRet,
                    driftAdjustedPct: driftAdj,
                    // Effect size in basis points so tiny edges aren't masked
                    // by percent rounding (0.0047% reads as "0.47 bp").
                    effectSizeBp: driftAdj * 100,
                    winRate: finite.length > 0 ? wins / finite.length : 0,
                    thin: finite.length < minSamples,
                };
            });
            // Reversal flag: at the longest non-thin horizon, the drift-adjusted
            // return sign contradicts the score sign AND the effect is
            // economically meaningful (above the bp floor). The magnitude gate
            // stops a large-n trivial effect (e.g. score=2 at ~0.5 bp) from
            // sharing the headline with a real fade (score=4 at ~37 bp).
            const longestNonThin = [...horizonStats]
                .filter((h) => !h.thin)
                .sort((a, b) => b.horizon - a.horizon)[0];
            const reversal = Boolean(
                longestNonThin
                && Math.abs(longestNonThin.driftAdjustedPct) >= REVERSAL_MAGNITUDE_FLOOR_PCT
                && Math.sign(score) !== 0
                && Math.sign(score) === Math.sign(-longestNonThin.driftAdjustedPct)
            );
            return { score, horizons: horizonStats, reversal };
        });

    // Buy-and-hold benchmark over the full window (first finite close to last
    // finite close). Same bars the strategy trades, so the alpha comparison is
    // apples-to-apples.
    let firstFiniteClose = NaN;
    let lastFiniteClose = NaN;
    for (const c of closes) {
        if (Number.isFinite(c) && c > 0) {
            if (!Number.isFinite(firstFiniteClose)) firstFiniteClose = c;
            lastFiniteClose = c;
        }
    }
    const buyAndHoldReturnPct = Number.isFinite(firstFiniteClose) && firstFiniteClose > 0
        ? ((lastFiniteClose - firstFiniteClose) / firstFiniteClose) * 100
        : 0;

    // Strategy summary. Bar counts are always reported (a chart that never
    // goes long/short is itself a signal); cumulative/Sharpe/moments only
    // populate when at least one in-market bar realized a signed return.
    const inMarketBars = longBars + shortBars;
    let strategy: ScoreEdgeStrategyStats = {
        cumulativeReturnPct: 0,
        buyAndHoldReturnPct,
        alphaPct: -buyAndHoldReturnPct,
        driftPerBarPct,
        sharpeRaw: 0,
        tStat: 0,
        significance: "not significant",
        longBars,
        shortBars,
        flatBars,
        meanBarReturnPct: 0,
        stdDevBarReturnPct: 0,
    };
    if (signedBarReturns.length > 0) {
        const meanRet = mean(signedBarReturns);
        const stdRet = sampleStdDev(signedBarReturns);
        // cumulativeReturnPct: sum of per-bar returns (compounding is a
        // separate, noisier metric; the additive form is the honest small-edge
        // read and matches how the per-bucket means aggregate).
        const cumulative = signedBarReturns.reduce((acc, r) => acc + r, 0);
        const sharpeRaw = calculateSharpeRatioFromReturns(signedBarReturns, 1, 0);
        // t-statistic of the aggregate edge. sharpeRaw is mean/std per bar, so
        // multiplying by √n gives the standard one-sample t-stat. A large
        // cumulative with low t is within sampling noise, not reliable alpha —
        // the significance band makes that explicit next to the headline.
        const tStat = Number.isFinite(sharpeRaw) ? sharpeRaw * Math.sqrt(inMarketBars) : 0;
        strategy = {
            cumulativeReturnPct: cumulative,
            buyAndHoldReturnPct,
            alphaPct: cumulative - buyAndHoldReturnPct,
            driftPerBarPct,
            // periodsPerYear=1 → raw information ratio, not annualized. Avoids
            // a timeframe resolver; the label in the UI says "raw".
            sharpeRaw,
            tStat,
            significance: significanceBand(tStat),
            longBars,
            shortBars,
            flatBars,
            meanBarReturnPct: meanRet,
            stdDevBarReturnPct: stdRet,
        };
    }

    const notableFindings = buildNotableFindings(buckets, strategy);

    return {
        symbol,
        interval,
        barCount: n,
        scoreRange: {
            min: Number.isFinite(scoreMin) ? scoreMin : 0,
            max: Number.isFinite(scoreMax) ? scoreMax : 0,
        },
        horizons,
        buckets,
        strategy,
        notableFindings,
        generatedAtIso: new Date().toISOString(),
    };
}

/**
 * Auto-detect headline findings so the buried pattern becomes the headline.
 * Catches two cases a flat table hides:
 *  - reversal buckets: high-conviction score whose forward return goes the
 *    other way (e.g. score=+4 marks a top to fade).
 *  - alpha-vs-beta: strategy cumulative vs buy-and-hold, qualified by the
 *    significance band so a large-but-noisy cumulative isn't misread as alpha.
 */
function buildNotableFindings(
    buckets: ScoreEdgeBucket[],
    strategy: ScoreEdgeStrategyStats
): string[] {
    const findings: string[] = [];

    // Strong-edge (confirmed-signal) detector — the mirror of the reversal
    // detector below. A bucket qualifies when, at the longest non-thin
    // horizon, the drift-adjusted effect clears the magnitude floor AND agrees
    // with the score sign AND the win rate is decisively off 0.50. This
    // surfaces the actionable positive signal (e.g. score=3 is a real long)
    // that a flat table buries under the bulk-noise buckets. Reversals are
    // rare by design; confirmed signals are the case the user most wants
    // surfaced, so they read first.
    for (const bucket of buckets) {
        if (bucket.reversal) continue; // a reversal is reported in its own pass
        const longest = [...bucket.horizons]
            .filter((h) => !h.thin)
            .sort((a, b) => b.horizon - a.horizon)[0];
        if (!longest) continue;
        const eff = longest.driftAdjustedPct;
        if (Math.abs(eff) < REVERSAL_MAGNITUDE_FLOOR_PCT) continue;
        if (Math.sign(bucket.score) === 0) continue;
        if (Math.sign(bucket.score) !== Math.sign(eff)) continue; // opposite sign -> reversal territory, skip
        if (Math.abs(longest.winRate - 0.5) < STRONG_EDGE_WIN_DEVIATION) continue;
        const dir = bucket.score > 0 ? "long" : "short";
        findings.push(
            `score=${bucket.score} confirms a ${dir} signal: a ${dir} score predicts same-sign ${longest.horizon}-bar returns ` +
            `(drift-adjusted ${formatPct(eff)} / ${longest.effectSizeBp.toFixed(1)} bp, ` +
            `win ${longest.winRate.toFixed(2)}, n${longest.samples}).`
        );
    }

    for (const bucket of buckets) {
        if (!bucket.reversal) continue;
        const longest = [...bucket.horizons].sort((a, b) => b.horizon - a.horizon)[0];
        if (!longest) continue;
        const sign = bucket.score > 0 ? "positive" : "negative";
        const opp = bucket.score > 0 ? "negative" : "positive";
        findings.push(
            `score=${bucket.score} reverses: a ${sign} score predicts ${opp} ${longest.horizon}-bar returns ` +
            `(drift-adjusted ${formatPct(longest.driftAdjustedPct)} / ${longest.effectSizeBp.toFixed(1)} bp, ` +
            `win ${longest.winRate.toFixed(2)}, n${longest.samples}). ` +
            `Treat as a fade signal, not a follow signal.`
        );
    }

    // Alpha read: only meaningful when the strategy was actually in market.
    const inMarket = strategy.longBars + strategy.shortBars;
    if (inMarket > 0) {
        const alpha = strategy.alphaPct;
        const bh = strategy.buyAndHoldReturnPct;
        const sig = strategy.significance;
        // Always surface the significance-qualified read when the alpha is
        // large in magnitude — a big alpha that is "not significant" is the
        // classic small-edge-times-many-bets trap, and the headline must say so.
        if (Math.abs(alpha) < Math.abs(bh) * 0.1) {
            findings.push(
                `Little to no timing alpha: score-driven LS returned ${formatPct(strategy.cumulativeReturnPct)} ` +
                `vs buy-and-hold ${formatPct(bh)} (alpha ${formatPct(alpha)}). The gain is beta, not score edge.`
            );
        } else if (alpha > 0) {
            findings.push(
                `Positive timing alpha: ${formatPct(alpha)} vs buy-and-hold ${formatPct(bh)} ` +
                `(t=${strategy.tStat.toFixed(2)}, ${sig}).` +
                (sig === "significant" ? "" : " Large cumulative but the edge is within sampling noise — treat as unreliable alpha.")
            );
        } else if (alpha < 0) {
            findings.push(
                `Negative timing alpha: ${formatPct(alpha)} vs buy-and-hold ${formatPct(bh)} ` +
                `(t=${strategy.tStat.toFixed(2)}, ${sig}) — the score hurt.`
            );
        }
    }

    return findings;
}

/**
 * Two-sided rough-cut significance band from a t-statistic. Not a precise
 * p-value (no dof lookup) — a deliberate, labeled honest signal so the
 * strategy headline can't pass off a noisy cumulative as reliable alpha.
 */
function significanceBand(tStat: number): ScoreEdgeSignificance {
    if (!Number.isFinite(tStat)) return "not significant";
    const abs = Math.abs(tStat);
    if (abs >= TSTAT_SIGNIFICANT) return "significant";
    if (abs >= TSTAT_NOT_SIGNIFICANT) return "marginal";
    return "not significant";
}

/**
 * Format a percent with sign. Picks 4 sig figs for tiny magnitudes so small
 * per-bar edges don't round to a misleading "+0.00%" next to a large
 * cumulative number (the original symptom: mean per-bar +0.0015% read as
 * "+0.00%" alongside +75.08%).
 */
function formatPct(value: number): string {
    if (!Number.isFinite(value)) return "—";
    const abs = Math.abs(value);
    let digits: number;
    if (abs === 0) digits = 2;
    else if (abs < 0.01) digits = 4;
    else if (abs < 1) digits = 3;
    else digits = 2;
    const sign = value > 0 ? "+" : "";
    return `${sign}${value.toFixed(digits)}%`;
}

/**
 * Format a magnitude (std dev) — same precision rules as formatPct but never
 * prefixed with a sign, since std dev is not directional.
 */
function formatMagnitudePct(value: number): string {
    if (!Number.isFinite(value)) return "—";
    const abs = Math.abs(value);
    let digits: number;
    if (abs === 0) digits = 2;
    else if (abs < 0.01) digits = 4;
    else if (abs < 1) digits = 3;
    else digits = 2;
    return `${abs.toFixed(digits)}%`;
}

/**
 * Compact plain-text export for an LLM to narrate. Contains labeled summary
 * stats + the per-bucket edge table, NOT raw bars. The instruction line tells
 * the model to summarize rather than recompute.
 */
export function formatScoreEdgeAiExport(report: ScoreEdgeReport): string {
    const lines: string[] = [];
    lines.push("# Committee Score Edge Report");
    lines.push("");
    lines.push(`symbol: ${report.symbol}`);
    lines.push(`interval: ${report.interval}`);
    lines.push(`bars scored: ${report.barCount}`);
    lines.push(`score range: ${report.scoreRange.min} .. ${report.scoreRange.max}`);
    lines.push(`horizons (bars): ${report.horizons.join(", ")}`);
    lines.push("");

    lines.push("## Score-driven long/short strategy");
    const s = report.strategy;
    lines.push(`cumulative return: ${formatPct(s.cumulativeReturnPct)}`);
    lines.push(`buy-and-hold (same window): ${formatPct(s.buyAndHoldReturnPct)}`);
    lines.push(`alpha (cumulative - buy-and-hold): ${formatPct(s.alphaPct)}`);
    lines.push(`mean per-bar return: ${formatPct(s.meanBarReturnPct)}`);
    lines.push(`per-bar drift of underlying: ${formatPct(s.driftPerBarPct)}`);
    lines.push(`std dev: ${formatMagnitudePct(s.stdDevBarReturnPct)}`);
    lines.push(`sharpe (raw, not annualized): ${Number.isFinite(s.sharpeRaw) ? s.sharpeRaw.toFixed(3) : "—"}`);
    lines.push(`t-stat (significance): ${Number.isFinite(s.tStat) ? s.tStat.toFixed(2) : "—"} — ${s.significance}`);
    lines.push(`bars in market: ${s.longBars + s.shortBars} (long ${s.longBars} / short ${s.shortBars} / flat ${s.flatBars})`);
    lines.push("");

    if (report.notableFindings.length > 0) {
        lines.push("## Notable findings (auto-detected)");
        for (const f of report.notableFindings) {
            lines.push(`- ${f}`);
        }
        lines.push("");
    }

    lines.push("## Forward return by score bucket");
    lines.push("(mean forward return [drift-adjusted / effect bp] / win rate; * = thin sample)");
    for (const bucket of report.buckets) {
        const rev = bucket.reversal ? " [REVERSAL]" : "";
        const parts = bucket.horizons.map((h) => {
            const star = h.thin ? "*" : "";
            return `+${h.horizon}b: ${formatPct(h.meanForwardReturnPct)} [${formatPct(h.driftAdjustedPct)} / ${h.effectSizeBp.toFixed(1)} bp] (win ${h.winRate.toFixed(2)}, n${h.samples})${star}`;
        });
        lines.push(`score=${bucket.score}${rev}: ${parts.join(", ")}`);
    }
    lines.push("");

    lines.push("## Instruction");
    lines.push("These are deterministic forward-return statistics for the committee score on this chart.");
    lines.push("Summarize whether the score predicts directional edge. Key reads:");
    lines.push("- t-stat / significance: a large alpha that is 'not significant' is small-edge-times-many-bets");
    lines.push("  noise, NOT reliable alpha. Weight the strategy line by its significance band.");
    lines.push("- alpha (cumulative - buy-and-hold): near zero means the gain is beta, not score edge.");
    lines.push("- drift-adjusted / effect bp per bucket: positive scores should show positive drift-adjusted");
    lines.push("  returns; a [REVERSAL] bucket means high conviction marks a fade, not a follow. Effect bp");
    lines.push("  below ~3 is economically trivial even with large n.");
    lines.push("- win rate > ~0.55 with enough samples (n) is meaningful; thin (*) buckets are uncertain.");
    lines.push("Quote the Notable findings verbatim. Do NOT recompute or second-guess the numbers.");
    return lines.join("\n");
}
