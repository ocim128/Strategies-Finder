/**
 * Pure historical committee-score overlay computation.
 *
 * Given the visible chart bars (each with a unix-seconds time) and each
 * member's compact trade-window list ([entrySec, exitSec, dirSign]), compute
 * the net committee vote at each bar. A window covers a bar iff
 * `entrySec <= barSec` AND (`exitSec === null` OR `barSec < exitSec`).
 *
 * Cross-timeframe alignment is handled naturally: a 1h member's window covers
 * all 60 of the 1m bars that fall inside [entrySec, exitSec). No resampling
 * is needed because windows are wall-clock seconds, not bar indices.
 *
 * No DOM, no network, no side effects. Unit-testable.
 */

export type TradeWindow = [entrySec: number, exitSec: (number | null), dirSign: 1 | -1];

export interface CommitteeOverlayMember {
    streamId: string;
    /** Absent or null means "no historical vote data" — member contributes 0 everywhere. */
    tradeWindows?: ReadonlyArray<TradeWindow> | null;
}

export interface CommitteeOverlayBar {
    /** Unix seconds for the bar's open or close — caller chooses the convention. */
    sec: number;
}

/**
 * Compute the net committee vote at each bar.
 *
 * Returns an Int32Array of length `bars.length` (or an empty array if no bars).
 * Each cell is the sum of dirSigns across all members whose active window
 * covers that bar's time.
 *
 * @param bars visible chart bars, in any order (typically ascending time).
 *   Must already carry `sec` (unix seconds). Non-finite/`null` sec bars are
 *   scored 0.
 * @param members committee members. Members without `tradeWindows` are
 *   skipped (they contribute 0 to every bar).
 */
export function computeCommitteeOverlayScores(
    bars: ReadonlyArray<CommitteeOverlayBar>,
    members: ReadonlyArray<CommitteeOverlayMember>
): Int32Array {
    const n = bars.length;
    const scores = new Int32Array(n);
    if (n === 0) return scores;

    // Collect valid members with windows once.
    const activeMembers: Array<{ windows: ReadonlyArray<TradeWindow> }> = [];
    if (Array.isArray(members)) {
        for (const m of members) {
            if (m && Array.isArray(m.tradeWindows) && m.tradeWindows.length > 0) {
                activeMembers.push({ windows: m.tradeWindows });
            }
        }
    }
    if (activeMembers.length === 0) return scores;

    // Precompute bar seconds once; mark non-finite as -Infinity so they never
    // fall inside any window (windows are unix seconds >= 0).
    const barSecs = new Float64Array(n);
    for (let i = 0; i < n; i++) {
        const sec = bars[i]?.sec;
        barSecs[i] = typeof sec === "number" && Number.isFinite(sec) ? sec : -Infinity;
    }

    // For each member, sweep its windows and add dirSign to every covered bar.
    // O(members × windows × bars) worst case; in practice windows are few per
    // member (capped at 200 server-side) and bars dominate. Acceptable for
    // the documented committee target (<=25 members).
    for (const member of activeMembers) {
        for (const window of member.windows) {
            const entrySec = window[0];
            const exitSecRaw = window[1];
            const dirSign = window[2];
            if (!Number.isFinite(entrySec)) continue;
            const exitSec = exitSecRaw === null ? Infinity : exitSecRaw;
            // Allow Infinity (open trade). Only reject NaN — a malformed exit
            // that can't bound a window either way.
            if (typeof exitSec === "number" && Number.isNaN(exitSec)) continue;
            for (let i = 0; i < n; i++) {
                const s = barSecs[i];
                if (s < 0) continue; // non-finite bar
                if (s >= entrySec && s < exitSec) {
                    scores[i] += dirSign;
                }
            }
        }
    }

    return scores;
}

/**
 * Select the bars worth annotating with a wick marker + score label.
 *
 * Used by the committee chart overlay to avoid stamping a number on every bar
 * (illegible on dense charts). A bar is picked when:
 * - it is the first bar (anchors the start of the score series), or
 * - its score differs from the previous bar's (the verdict changed), or
 * - it is the last bar (keeps the live verdict visible even when flat).
 *
 * `timeFor` returns the chart-library time; bars whose `timeFor` returns
 * `null`/`undefined` are dropped (their neighbours are still compared, so a
 * single null time can't suppress a real change).
 */
export function pickScoreChangePoints<TBar>(
    bars: ReadonlyArray<TBar>,
    scores: ReadonlyArray<number>,
    timeFor: (bar: TBar) => unknown
): Array<{ time: unknown; value: number }> {
    const len = Math.min(bars.length, scores.length);
    const points: Array<{ time: unknown; value: number }> = [];
    if (len === 0) return points;
    let lastScore = scores[0];
    for (let i = 0; i < len; i++) {
        const score = scores[i];
        const isChange = i === 0 || score !== lastScore;
        if (isChange || i === len - 1) {
            const time = timeFor(bars[i]);
            if (time !== undefined && time !== null) {
                points.push({ time, value: score });
            }
        }
        lastScore = score;
    }
    return points;
}
