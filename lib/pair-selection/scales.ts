import { formatNumber, formatPercent, percentile } from "../selection-metrics";
import type { PairCandidate } from "./types";
import type { PairSelectionArchive, PairSelectionEvent } from "./tally";

export const PAIR_SELECTION_NUMERIC_FIELDS = [
    "feat_entryRangePosition",
    "feat_atrPct",
    "feat_return20",
    "feat_gapPct",
    "feat_dow",
    "feat_hour",
    "feat_pairWinRatePrior",
    "feat_pairTradesPrior",
    "feat_barsSincePairLastFire",
    "feat_pairSpreadVolatility20",
    "feat_legVolatilityRatio20",
    "feat_candidatesAtTime",
] as const satisfies readonly (keyof PairCandidate)[];

type PairNumericField = typeof PAIR_SELECTION_NUMERIC_FIELDS[number];

export interface PairNumericScale {
    values: Record<`p${1 | 10 | 25 | 50 | 75 | 90 | 99}`, number | null>;
    nullShare: number;
}

export interface PairSelectionScaleBlock {
    eventCount: number;
    candidateEvents: number;
    candidates: number;
    numeric: Record<PairNumericField, PairNumericScale>;
}

const PERCENTILES = [0.01, 0.1, 0.25, 0.5, 0.75, 0.9, 0.99] as const;

function numericScale(events: readonly PairSelectionEvent[], field: PairNumericField): PairNumericScale {
    const values: number[] = [];
    let nullCount = 0;
    for (const event of events) {
        for (const candidate of event.candidates) {
            const value = candidate[field];
            if (value === null) nullCount += 1;
            else values.push(value as number);
        }
    }
    values.sort((left, right) => left - right);
    const total = nullCount + values.length;
    const percentileValues = Object.fromEntries(
        PERCENTILES.map((fraction) => [
            `p${fraction * 100}`,
            values.length > 0 ? percentile(values, fraction) : null,
        ]),
    ) as PairNumericScale["values"];
    return { values: percentileValues, nullShare: total > 0 ? nullCount / total : 0 };
}

export function computePairSelectionScales(archive: PairSelectionArchive): PairSelectionScaleBlock {
    const candidateEvents = archive.events
        .filter((event) => event.candidates.length >= 2)
        .slice()
        .sort((left, right) => left.context.signalTime - right.context.signalTime);
    const candidates = candidateEvents.reduce((sum, event) => sum + event.candidates.length, 0);
    return {
        eventCount: archive.events.length,
        candidateEvents: candidateEvents.length,
        candidates,
        numeric: Object.fromEntries(
            PAIR_SELECTION_NUMERIC_FIELDS.map((field) => [field, numericScale(candidateEvents, field)]),
        ) as Record<PairNumericField, PairNumericScale>,
    };
}

export function formatPairSelectionScales(block: PairSelectionScaleBlock): string[] {
    const lines = [
        `events=${block.eventCount} candidateEvents=${block.candidateEvents} candidates=${block.candidates}`,
    ];
    for (const field of PAIR_SELECTION_NUMERIC_FIELDS) {
        const scale = block.numeric[field];
        lines.push(`${field} p1=${formatNumber(scale.values.p1)} p10=${formatNumber(scale.values.p10)} p25=${formatNumber(scale.values.p25)} p50=${formatNumber(scale.values.p50)} p75=${formatNumber(scale.values.p75)} p90=${formatNumber(scale.values.p90)} p99=${formatNumber(scale.values.p99)} null=${formatPercent(scale.nullShare)}`);
    }
    return lines;
}
