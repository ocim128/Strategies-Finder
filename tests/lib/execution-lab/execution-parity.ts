import { isPolymarketEntryPriceFiltered } from "../polymarket-entry-price-filter";
import type {
    ExecutionLabRecord,
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

function formatDateTime(ts: number | null | undefined): string {
    if (ts === null || ts === undefined || !Number.isFinite(ts)) return "--";
    return new Date(Math.floor(ts) * 1000).toLocaleString("en-US", {
        month: "short",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
    });
}

function formatSeconds(value: number | null | undefined): string {
    return value === null || value === undefined || !Number.isFinite(value) ? "--" : `${Math.floor(value)}s`;
}

export function collectLatePaperExecutionMismatches(
    records: readonly ExecutionLabRecord[],
    latestCandleTimeSec: number,
    maxDelaySec: number
): ExecutionParityMismatch[] {
    const mismatches: ExecutionParityMismatch[] = [];
    for (const record of records) {
        if (record.recordType === "paper_entry") {
            const delaySec = latestCandleTimeSec - record.entryTimeSec;
            if (delaySec > maxDelaySec) {
                mismatches.push({
                    mismatchType: "late_paper_execution",
                    latestCandleTimeSec,
                    detail: `paper ${record.side.toUpperCase()} entry was processed ${formatSeconds(delaySec)} after entry time ${formatDateTime(record.entryTimeSec)}`,
                    tradeId: record.tradeId,
                    eventEndTs: record.eventEndTs,
                });
            }
        }
        if (record.recordType === "paper_exit" && record.exitReason !== "resolution") {
            const delaySec = latestCandleTimeSec - record.exitTimeSec;
            if (delaySec > maxDelaySec) {
                mismatches.push({
                    mismatchType: "late_paper_execution",
                    latestCandleTimeSec,
                    detail: `paper ${record.exitReason} exit was processed ${formatSeconds(delaySec)} after exit time ${formatDateTime(record.exitTimeSec)}`,
                    tradeId: record.tradeId,
                    expectedExitTimeSec: record.exitTimeSec,
                    expectedExitReason: record.exitReason,
                });
            }
        }
    }
    return mismatches;
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
