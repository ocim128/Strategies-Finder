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
    /**
     * Optional sign multiplier applied to every dirSign in this member's
     * tradeWindows. Used to scope the chart overlay to the chart symbol:
     * a synthetic member whose quote leg is the chart symbol passes `-1`
     * (long BASE/QUOTE is short QUOTE). Defaults to `+1` when omitted.
     */
    voteMultiplier?: 1 | -1 | 0;
}

/**
 * Normalized comparison form for chart and member symbols: uppercase, only
 * alphanumerics. Mirrors the committee service's `symbolsMatch` rule so a
 * display separator (`+`, `/`) never blocks a real match.
 */
function normalizeOverlaySymbol(value: string): string {
    return value.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/**
 * What a member contributes to a chart on the given symbol: `0` if it does not
 * match, otherwise the sign multiplier to apply to every dirSign in its
 * tradeWindows.
 *
 * Resolution mirrors the per-leg leaderboard (`aggregateLegScores`):
 *   - direct member: its `symbol` equals the chart symbol -> +1
 *   - synthetic member whose base leg equals the chart symbol -> +1
 *     (long BASE/QUOTE is long BASE on the chart)
 *   - synthetic member whose quote leg equals the chart symbol -> -1
 *     (long BASE/QUOTE is short QUOTE on the chart)
 *
 * A member never contributes more than once: either its own symbol matches, or
 * exactly one of its synthetic legs matches. If the chart symbol somehow equals
 * both legs (degenerate pair), the base leg wins — same precedence as
 * `aggregateLegScores`, which bumps the base before the quote.
 *
 * `null`/malformed pairs and missing symbols contribute 0, so callers can pass
 * the raw resolved pair without sanitizing first.
 */
export function chartOverlayVoteMultiplier(
    chartSymbol: string,
    member: { symbol?: string | null; syntheticPair?: { baseSymbol: string; quoteSymbol: string } | null }
): 1 | -1 | 0 {
    const chart = normalizeOverlaySymbol(chartSymbol);
    if (!chart) return 0;
    const pair = member.syntheticPair ?? null;
    if (pair && pair.baseSymbol && pair.quoteSymbol) {
        if (normalizeOverlaySymbol(pair.baseSymbol) === chart) return 1;
        if (normalizeOverlaySymbol(pair.quoteSymbol) === chart) return -1;
        return 0;
    }
    return member.symbol && normalizeOverlaySymbol(member.symbol) === chart ? 1 : 0;
}

export interface CommitteeOverlayBar {
    /** Unix seconds for the bar's open or close — caller chooses the convention. */
    sec: number;
}

/**
 * Compute the net committee vote at each bar.
 *
 * Returns an Int32Array of length `bars.length` (or an empty array if no bars).
 * Each cell is the sum of `dirSign * voteMultiplier` across all members whose
 * active window covers that bar's time.
 *
 * Complexity: O(events log events + bars) via an events-based sweep, where
 * `events` = 2 × total windows (one +vote at entry, one -vote at exit). This
 * is independent of the windows × bars product, so raising
 * `TRADE_WINDOWS_CAP` (multi-year chart coverage) does not regress render time.
 *
 * @param bars visible chart bars in **ascending** time order. The events
 *   sweep walks bars and events in lockstep, so callers MUST supply sorted
 *   bars (chart OHLCV is ascending by construction). Non-finite/`null` sec
 *   bars are scored 0.
 * @param members committee members. Members without `tradeWindows` are
 *   skipped (they contribute 0 to every bar). A member's optional
 *   `voteMultiplier` scopes its contribution to the chart symbol: `0` drops
 *   it, `-1` flips every dirSign (used when a synthetic pair's quote leg is
 *   the chart symbol). Omitting it defaults to `+1`.
 */
export function computeCommitteeOverlayScores(
    bars: ReadonlyArray<CommitteeOverlayBar>,
    members: ReadonlyArray<CommitteeOverlayMember>
): Int32Array {
    const n = bars.length;
    const scores = new Int32Array(n);
    if (n === 0) return scores;

    // Collect valid members with windows once.
    const activeMembers: Array<{ windows: ReadonlyArray<TradeWindow>; multiplier: 1 | -1 | 0 }> = [];
    if (Array.isArray(members)) {
        for (const m of members) {
            if (m && Array.isArray(m.tradeWindows) && m.tradeWindows.length > 0) {
                // `voteMultiplier` scopes a member's contribution to the chart
                // symbol. `0` drops the member entirely (no symbol match); `+1`
                // counts its dirSigns as-is; `-1` flips them (e.g. a synthetic
                // member whose quote leg is the chart symbol). Default `+1`
                // keeps legacy callers (whole-committee overlay) unchanged.
                const mult = m.voteMultiplier === -1 || m.voteMultiplier === 0 ? m.voteMultiplier : 1;
                if (mult === 0) continue;
                activeMembers.push({ windows: m.tradeWindows, multiplier: mult });
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

    // Events-based sweep instead of the original O(members × windows × bars)
    // triple loop. With TRADE_WINDOWS_CAP raised to 5000 (so multi-year charts
    // get scored end-to-end), the old loop would be ~25 members × 5000 windows
    // × 16000 bars ≈ 2 billion comparisons and freeze the UI. This version is
    // O(events log events + bars): collect every window boundary as a signed
    // delta event, sort once, then sweep bars left-to-right applying deltas.
    //
    // Event semantics: a window covers bar with sec `t` iff entrySec <= t and
    // (exitSec is null/open OR t < exitSec). We model that as two events:
    //   +vote at entrySec (window becomes active at t = entrySec inclusive)
    //   -vote at exitSec  (window no longer active at t = exitSec exclusive)
    // Open-ended windows (exitSec === null) emit only the +entry event, so the
    // vote persists for every later bar — the same semantics as Infinity exit.
    interface DeltaEvent { sec: number; delta: number; }
    const events: DeltaEvent[] = [];
    for (const member of activeMembers) {
        for (const window of member.windows) {
            const entrySec = window[0];
            const exitSecRaw = window[1];
            const dirSign = window[2] * member.multiplier;
            if (!Number.isFinite(entrySec)) continue;
            events.push({ sec: entrySec, delta: dirSign });
            if (exitSecRaw !== null) {
                // NaN exits can't bound a window either way (matches the prior
                // loop's guard); finite exits emit the closing -delta event.
                if (!Number.isNaN(exitSecRaw)) {
                    events.push({ sec: exitSecRaw, delta: -dirSign });
                }
            }
        }
    }

    if (events.length === 0) return scores;

    // Sort ascending by time so we can drain events in lockstep with bars.
    // Ties (entry and exit at the same second) resolve to entry-first because
    // a bar whose sec equals an entry time is inside the window (inclusive)
    // while a bar whose sec equals an exit time is outside it (exclusive) —
    // applying +delta before -delta at the same sec yields the correct net.
    events.sort((a, b) => a.sec < b.sec ? -1 : a.sec > b.sec ? 1 : 0);

    let runningVote = 0;
    let eventIdx = 0;
    const eventCount = events.length;
    for (let i = 0; i < n; i++) {
        const sec = barSecs[i];
        if (sec < 0) continue; // non-finite bar keeps score 0
        // Apply every event at or before this bar's time. Using `<=` makes the
        // entry boundary inclusive (sec == entrySec -> already +vote) and the
        // exit boundary exclusive (sec == exitSec -> already -vote applied, so
        // the closed window no longer contributes to this bar).
        while (eventIdx < eventCount && events[eventIdx]!.sec <= sec) {
            runningVote += events[eventIdx]!.delta;
            eventIdx++;
        }
        scores[i] = runningVote;
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
