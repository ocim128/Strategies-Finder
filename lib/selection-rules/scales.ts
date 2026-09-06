import type { SelectionArchive, SelectionArchiveEvent } from "./tally";

const NUMERIC_FIELDS = ["score", "signedVotes", "activePairCount", "breadth"] as const;
const BOOLEAN_FIELDS = ["ema200Above", "longEligible", "shortEligible", "inPool"] as const;
const REGIMES = ["bullish", "bearish", "unavailable"] as const;
const PERCENTILES = [0.01, 0.1, 0.25, 0.5, 0.75, 0.9, 0.99] as const;

type NumericField = typeof NUMERIC_FIELDS[number];
type BooleanField = typeof BOOLEAN_FIELDS[number];

export interface NumericScale {
    values: Record<`p${1 | 10 | 25 | 50 | 75 | 90 | 99}`, number | null>;
    nullShare: number;
}

export interface SelectionScaleBlock {
    horizonBars: number;
    candidateEvents: number;
    positiveCandidates: number;
    numeric: Record<NumericField, NumericScale>;
    booleanTrueRates: Record<BooleanField, number>;
    regimeShares: Record<typeof REGIMES[number], number>;
    candidatesPerEvent: Record<`p${10 | 25 | 50 | 75 | 90 | 99}`, number>;
    candidateCountShares: {
        exactly2to5: number;
        sixTo20: number;
        over20: number;
    };
    utcHourShares: number[];
    utcDayShares: number[];
}

function percentile(values: readonly number[], fraction: number): number {
    const position = (values.length - 1) * fraction;
    const lower = Math.floor(position);
    const upper = Math.ceil(position);
    if (lower === upper) return values[lower]!;
    return values[lower]! + (values[upper]! - values[lower]!) * (position - lower);
}

function numericScale(events: readonly SelectionArchiveEvent[], field: NumericField): NumericScale {
    const values: number[] = [];
    let nullCount = 0;
    for (const event of events) {
        for (const candidate of event.candidates) {
            const value = candidate[field];
            if (value === null) nullCount += 1;
            else values.push(value);
        }
    }
    values.sort((left, right) => left - right);
    const percentiles = Object.fromEntries(PERCENTILES.map((fraction) => [`p${fraction * 100}`, values.length > 0 ? percentile(values, fraction) : null])) as NumericScale["values"];
    return { values: percentiles, nullShare: nullCount / (nullCount + values.length) };
}

function booleanTrueRate(events: readonly SelectionArchiveEvent[], field: BooleanField): number {
    let total = 0;
    let trueCount = 0;
    for (const event of events) {
        for (const candidate of event.candidates) {
            total += 1;
            if (candidate[field]) trueCount += 1;
        }
    }
    return trueCount / total;
}

function candidateEventPercentiles(events: readonly SelectionArchiveEvent[]): SelectionScaleBlock["candidatesPerEvent"] {
    const counts = events.map((event) => event.candidates.length).sort((left, right) => left - right);
    return Object.fromEntries([0.1, 0.25, 0.5, 0.75, 0.9, 0.99].map((fraction) => [`p${fraction * 100}`, percentile(counts, fraction)])) as SelectionScaleBlock["candidatesPerEvent"];
}

function share(count: number, total: number): number {
    return count / total;
}

function formatNumber(value: number | null): string {
    return value === null ? "null" : value.toFixed(6);
}

function formatPercent(value: number): string {
    return `${(value * 100).toFixed(2)}%`;
}

function formatScaleNumber(value: number): string {
    return Number.isInteger(value) ? String(value) : formatNumber(value);
}

export function computeSelectionScales(archive: SelectionArchive): SelectionScaleBlock[] {
    const candidateEvents = archive.events
        .filter((event) => event.candidates.length >= 2)
        .sort((left, right) => left.decisionTimeSec - right.decisionTimeSec || left.eventId.localeCompare(right.eventId));
    const totalCandidates = candidateEvents.reduce((sum, event) => sum + event.candidates.length, 0);
    return [...archive.horizons].sort((left, right) => left - right).map((horizonBars) => {
        const regimeCounts = { bullish: 0, bearish: 0, unavailable: 0 };
        const utcHourCounts = Array.from({ length: 24 }, () => 0);
        const utcDayCounts = Array.from({ length: 7 }, () => 0);
        let exactly2to5 = 0;
        let sixTo20 = 0;
        let over20 = 0;
        for (const event of candidateEvents) {
            const count = event.candidates.length;
            if (count <= 5) exactly2to5 += 1;
            else if (count <= 20) sixTo20 += 1;
            else over20 += 1;
            const date = new Date(event.decisionTimeSec * 1000);
            utcHourCounts[date.getUTCHours()] += 1;
            utcDayCounts[date.getUTCDay()] += 1;
            for (const candidate of event.candidates) regimeCounts[candidate.regime] += 1;
        }
        return {
            horizonBars,
            candidateEvents: candidateEvents.length,
            positiveCandidates: totalCandidates,
            numeric: Object.fromEntries(NUMERIC_FIELDS.map((field) => [field, numericScale(candidateEvents, field)])) as Record<NumericField, NumericScale>,
            booleanTrueRates: Object.fromEntries(BOOLEAN_FIELDS.map((field) => [field, booleanTrueRate(candidateEvents, field)])) as Record<BooleanField, number>,
            regimeShares: {
                bullish: share(regimeCounts.bullish, totalCandidates),
                bearish: share(regimeCounts.bearish, totalCandidates),
                unavailable: share(regimeCounts.unavailable, totalCandidates),
            },
            candidatesPerEvent: candidateEventPercentiles(candidateEvents),
            candidateCountShares: {
                exactly2to5: share(exactly2to5, candidateEvents.length),
                sixTo20: share(sixTo20, candidateEvents.length),
                over20: share(over20, candidateEvents.length),
            },
            utcHourShares: utcHourCounts.map((count) => share(count, candidateEvents.length)),
            utcDayShares: utcDayCounts.map((count) => share(count, candidateEvents.length)),
        };
    });
}

export function formatSelectionScales(block: SelectionScaleBlock): string[] {
    const lines = [
        `horizon=${block.horizonBars} candidateEvents=${block.candidateEvents} positiveCandidates=${block.positiveCandidates}`,
    ];
    for (const field of NUMERIC_FIELDS) {
        const scale = block.numeric[field];
        lines.push(`${field} p1=${formatNumber(scale.values.p1)} p10=${formatNumber(scale.values.p10)} p25=${formatNumber(scale.values.p25)} p50=${formatNumber(scale.values.p50)} p75=${formatNumber(scale.values.p75)} p90=${formatNumber(scale.values.p90)} p99=${formatNumber(scale.values.p99)} null=${formatPercent(scale.nullShare)}`);
    }
    for (const field of BOOLEAN_FIELDS) lines.push(`${field} true=${formatPercent(block.booleanTrueRates[field])}`);
    lines.push(`regime bullish=${formatPercent(block.regimeShares.bullish)} bearish=${formatPercent(block.regimeShares.bearish)} unavailable=${formatPercent(block.regimeShares.unavailable)}`);
    lines.push(`candidatesPerEvent p10=${formatScaleNumber(block.candidatesPerEvent.p10)} p25=${formatScaleNumber(block.candidatesPerEvent.p25)} p50=${formatScaleNumber(block.candidatesPerEvent.p50)} p75=${formatScaleNumber(block.candidatesPerEvent.p75)} p90=${formatScaleNumber(block.candidatesPerEvent.p90)} p99=${formatScaleNumber(block.candidatesPerEvent.p99)}`);
    lines.push(`candidateCountShare exactly2to5=${formatPercent(block.candidateCountShares.exactly2to5)} sixTo20=${formatPercent(block.candidateCountShares.sixTo20)} over20=${formatPercent(block.candidateCountShares.over20)}`);
    lines.push(`utcHour ${block.utcHourShares.map((value, hour) => `${String(hour).padStart(2, "0")}=${formatPercent(value)}`).join(" ")}`);
    lines.push(`utcDay ${block.utcDayShares.map((value, day) => `${day}=${formatPercent(value)}`).join(" ")}`);
    return lines;
}
