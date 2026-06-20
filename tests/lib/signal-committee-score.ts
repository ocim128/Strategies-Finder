/**
 * Pure committee scoring. No DOM, no network, no side effects.
 *
 * A committee row contributes +1 for an open long, -1 for an open short, and
 * 0 otherwise (flat, closed, or never traded). Average age and average gain
 * are computed over open-trade rows only, because flat rows have no defined
 * "since signal" semantics.
 */

export type CommitteeVote = -1 | 0 | 1;

export interface CommitteeScoreRow {
    streamId: string;
    /** When false (no cached state, subscription not found, etc.) the row is excluded from all aggregates. */
    ok: boolean;
    latestTrade: {
        entryTimeSec: number;
        entryPrice: number;
        isOpen: boolean;
    } | null;
    latestClose: number | null;
}

export interface CommitteeAggregate {
    score: number;
    longCount: number;
    shortCount: number;
    flatCount: number;
    excludedCount: number;
    /** Mean elapsed seconds since entry across open-trade rows. null if no open trades. */
    avgAgeSec: number | null;
    /** Mean signed gain percent across open-trade rows. null if no open trades with a usable latestClose. */
    avgGainPct: number | null;
}

/**
 * +1 for an open long, -1 for an open short, 0 otherwise. Excluded rows (ok=false)
 * always vote 0.
 *
 * Direction is inferred from the sign of the latest *entry* that produced the
 * open trade. We do not have a direct `direction` field on the trade context,
 * so open long vs open short is distinguished via `latestEntry` sign carried by
 * the caller's adapter (see `rowFromMemberState`). The vote itself is derived
 * from `voteDirection` to keep this module independent of the wire shape.
 */
export function voteForRow(row: CommitteeScoreRow & { voteDirection?: "long" | "short" | null }): CommitteeVote {
    if (!row.ok) return 0;
    const trade = row.latestTrade;
    if (!trade || !trade.isOpen) return 0;
    if (row.voteDirection === "long") return 1;
    if (row.voteDirection === "short") return -1;
    return 0;
}

/**
 * Signed gain percent for one open trade. `latestClose` is used as the mark.
 * Returns null when inputs are missing or non-finite.
 *
 * Gain sign already incorporates direction via `voteDirection`:
 *   long  -> ((last - entry) / entry) * 100
 *   short -> ((entry - last) / entry) * 100
 */
export function gainPctForRow(
    row: CommitteeScoreRow & { voteDirection?: "long" | "short" | null }
): number | null {
    if (!row.ok) return null;
    const trade = row.latestTrade;
    if (!trade || !trade.isOpen) return null;
    const entry = trade.entryPrice;
    const last = row.latestClose;
    if (!Number.isFinite(entry) || entry <= 0) return null;
    if (last === null || !Number.isFinite(last) || last <= 0) return null;
    const diff = row.voteDirection === "short" ? entry - last : last - entry;
    return (diff / entry) * 100;
}

/**
 * Elapsed seconds from entry to `nowSec`. null when the row has no open trade
 * or `entryTimeSec` is non-finite.
 */
export function ageSecForRow(row: CommitteeScoreRow, nowSec: number): number | null {
    if (!row.ok) return null;
    const trade = row.latestTrade;
    if (!trade || !trade.isOpen) return null;
    if (!Number.isFinite(trade.entryTimeSec) || !Number.isFinite(nowSec)) return null;
    const age = nowSec - trade.entryTimeSec;
    return Number.isFinite(age) && age >= 0 ? age : null;
}

export function aggregateScore(
    rows: Array<CommitteeScoreRow & { voteDirection?: "long" | "short" | null }>,
    nowSec: number = Math.floor(Date.now() / 1000)
): CommitteeAggregate {
    let score = 0;
    let longCount = 0;
    let shortCount = 0;
    let flatCount = 0;
    let excludedCount = 0;
    let ageSum = 0;
    let ageCount = 0;
    let gainSum = 0;
    let gainCount = 0;

    for (const row of rows) {
        if (!row.ok) {
            excludedCount += 1;
            continue;
        }
        const vote = voteForRow(row);
        if (vote > 0) longCount += 1;
        else if (vote < 0) shortCount += 1;
        else flatCount += 1;
        score += vote;

        const age = ageSecForRow(row, nowSec);
        if (age !== null) {
            ageSum += age;
            ageCount += 1;
        }
        const gain = gainPctForRow(row);
        if (gain !== null) {
            gainSum += gain;
            gainCount += 1;
        }
    }

    return {
        score,
        longCount,
        shortCount,
        flatCount,
        excludedCount,
        avgAgeSec: ageCount > 0 ? ageSum / ageCount : null,
        avgGainPct: gainCount > 0 ? gainSum / gainCount : null,
    };
}

/**
 * Format an age in seconds as a short, human-readable duration.
 * Examples: "1m 05s", "2h 14m", "3d 04h". Returns "—" for null/non-finite input.
 */
export function formatAgeShort(ageSec: number | null): string {
    if (ageSec === null || !Number.isFinite(ageSec) || ageSec < 0) return "—";
    const total = Math.floor(ageSec);
    const days = Math.floor(total / 86_400);
    const hours = Math.floor((total % 86_400) / 3_600);
    const minutes = Math.floor((total % 3_600) / 60);
    const seconds = total % 60;
    if (days > 0) return `${days}d ${String(hours).padStart(2, "0")}h`;
    if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
    if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
    return `${seconds}s`;
}

/**
 * Format a signed percent with two decimals and a sign. Returns "—" for null/non-finite input.
 */
export function formatPercentSigned(value: number | null): string {
    if (value === null || !Number.isFinite(value)) return "—";
    const sign = value > 0 ? "+" : "";
    return `${sign}${value.toFixed(2)}%`;
}
