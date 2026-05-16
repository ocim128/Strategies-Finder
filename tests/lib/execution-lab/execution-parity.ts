import { isPolymarketEntryPriceFiltered } from "../polymarket-entry-price-filter";
import type {
    ExecutionLabPaperState,
    ExecutionParityMismatchRecord,
} from "./execution-lab-model";

export type ExecutionParityMismatch = {
    mismatchType: ExecutionParityMismatchRecord["mismatchType"];
    latestCandleTimeSec: number;
    detail: string;
    tradeId?: string;
    expectedExitTimeSec?: number;
    expectedExitReason?: string;
    eventEndTs?: number;
};

function formatPolyPrice(value: number | null | undefined): string {
    return value === null || value === undefined || !Number.isFinite(value) ? "--" : value.toFixed(3);
}

export function collectEntryPriceFilterParityMismatches(
    paperState: ExecutionLabPaperState,
    latestCandleTimeSec: number
): ExecutionParityMismatch[] {
    const mismatches: ExecutionParityMismatch[] = [];
    for (const position of [
        ...paperState.openPositions.values(),
        ...paperState.pendingSettlements.values(),
    ]) {
        if (!isPolymarketEntryPriceFiltered(
            position.entryPrice,
            paperState.snapshot.backtestSettings.polymarketEntryPriceFilterCents
        )) {
            continue;
        }
        mismatches.push({
            mismatchType: "entry_price_filter_violation",
            latestCandleTimeSec,
            detail: `paper ${position.side.toUpperCase()} opened at filtered price ${formatPolyPrice(position.entryPrice)}`,
            tradeId: position.tradeId,
            eventEndTs: position.eventEndTs,
        });
    }
    return mismatches;
}
