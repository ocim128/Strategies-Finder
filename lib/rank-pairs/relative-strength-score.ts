/**
 * Pure relative-strength scoring for synthetic pair ranking.
 *
 * No DOM, no fetch. The browser service feeds it the OHLCVData[] returned by
 * the batch dataset loader (which already runs the synthetic base/quote
 * alignment + aggregation) and gets back a score + verdict.
 *
 * The ratio series for a synthetic pair IS the relative-strength series
 * (base.close / quote.close), so the score reduces to the ratio's total return
 * over the supplied window. See docs/synthetic-agreement-filter-plan.md for the
 * `BASE+QUOTE` = `base / quote` semantics.
 *
 * ⚠ LOOKAHEAD BIAS: this uses full-window return and is research-only.
 */

import type { OHLCVData } from "../types/strategies";

export type RankVerdict = "STRONG_BASE" | "SOLID_BASE" | "FLAT" | "WEAK_BASE" | "THIN";

export interface RelativeStrengthScore {
    ratioReturn: number; // (last/first - 1) over the window
    annualizedReturn: number;
    bars: number;
    verdict: RankVerdict;
}

export function classifyVerdict(
    ratioReturn: number,
    annualizedReturn: number,
    bars: number,
): RankVerdict {
    // THIN guard: not enough overlap to trust the return
    if (bars < 200) return "THIN";
    if (ratioReturn >= 0.5 && annualizedReturn >= 0.25) return "STRONG_BASE";
    if (ratioReturn >= 0.15 && annualizedReturn >= 0.08) return "SOLID_BASE";
    if (ratioReturn <= -0.15 && annualizedReturn <= -0.08) return "WEAK_BASE";
    return "FLAT";
}

function intervalToPeriodsPerYear(interval: string): number {
    const unit = interval.slice(-1);
    const n = Number(interval.slice(0, -1)) || 1;
    const hoursPerYear = 365 * 24;
    if (unit === "h") return hoursPerYear / n;
    if (unit === "d") return 365 / n;
    if (unit === "w") return 52 / n;
    if (unit === "m") return (hoursPerYear * 60) / n; // assume minute bars
    return hoursPerYear; // fallback: treat as hourly
}

export function scoreRelativeStrength(
    bars: OHLCVData[],
    interval: string,
): RelativeStrengthScore {
    const closes = bars
        .map((b) => Number(b.close))
        .filter((n) => Number.isFinite(n) && n > 0);

    if (closes.length < 200) {
        return {
            ratioReturn: NaN,
            annualizedReturn: NaN,
            bars: closes.length,
            verdict: "THIN",
        };
    }

    const first = closes[0];
    const last = closes[closes.length - 1];
    const ratioReturn = last / first - 1;
    const periodsPerYear = intervalToPeriodsPerYear(interval);
    const years = closes.length / periodsPerYear;
    const annualizedReturn = years > 0 ? Math.pow(last / first, 1 / years) - 1 : 0;

    return {
        ratioReturn,
        annualizedReturn,
        bars: closes.length,
        verdict: classifyVerdict(ratioReturn, annualizedReturn, closes.length),
    };
}

export function formatPercent(x: number): string {
    if (!Number.isFinite(x)) return "n/a";
    const sign = x >= 0 ? "+" : "";
    return `${sign}${(x * 100).toFixed(1)}%`;
}
