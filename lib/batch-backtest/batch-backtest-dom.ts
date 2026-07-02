import { getRequiredElement } from "../dom-utils";

/**
 * Structural DOM contract for the Batch Backtest tab.
 *
 * Mirrors the `lib/hunt/hunt-dom.ts` pattern: a required-ids array used by
 * `tests/feature-dom-contracts.spec.ts`, plus a `create*Dom()` factory that
 * resolves the elements through `getRequiredElement`.
 *
 * Every id here must also exist in `html-partials/tab-batch-backtest.html`.
 */
export const BATCH_BACKTEST_REQUIRED_IDS = [
    "batchbacktestTab",
    "batchBacktestSymbols",
    "batchBacktestUseCurrent",
    "batchBacktestClear",
    "batchBacktestRunBtn",
    "batchBacktestStopBtn",
    "batchBacktestCopyBtn",
    "batchBacktestMineBtn",
    "batchBacktestCopyMinerBtn",
    "batchBacktestProgress",
    "batchBacktestProgressFill",
    "batchBacktestProgressText",
    "batchBacktestStatus",
    "batchBacktestSummary",
    "batchBacktestMinerSummary",
    "batchBacktestMinerResults",
    "batchBacktestResults",
    "batchBacktestEmpty",
] as const;

export function createBatchBacktestDom() {
    return {
        batchbacktestTab: getRequiredElement("batchbacktestTab"),
        batchBacktestSymbols: getRequiredElement<HTMLTextAreaElement>("batchBacktestSymbols"),
        batchBacktestUseCurrent: getRequiredElement<HTMLButtonElement>("batchBacktestUseCurrent"),
        batchBacktestClear: getRequiredElement<HTMLButtonElement>("batchBacktestClear"),
        batchBacktestRunBtn: getRequiredElement<HTMLButtonElement>("batchBacktestRunBtn"),
        batchBacktestStopBtn: getRequiredElement<HTMLButtonElement>("batchBacktestStopBtn"),
        batchBacktestCopyBtn: getRequiredElement<HTMLButtonElement>("batchBacktestCopyBtn"),
        batchBacktestMineBtn: getRequiredElement<HTMLButtonElement>("batchBacktestMineBtn"),
        batchBacktestCopyMinerBtn: getRequiredElement<HTMLButtonElement>("batchBacktestCopyMinerBtn"),
        batchBacktestProgress: getRequiredElement("batchBacktestProgress"),
        batchBacktestProgressFill: getRequiredElement<HTMLDivElement>("batchBacktestProgressFill"),
        batchBacktestProgressText: getRequiredElement<HTMLDivElement>("batchBacktestProgressText"),
        batchBacktestStatus: getRequiredElement<HTMLDivElement>("batchBacktestStatus"),
        batchBacktestSummary: getRequiredElement<HTMLDivElement>("batchBacktestSummary"),
        batchBacktestMinerSummary: getRequiredElement<HTMLDivElement>("batchBacktestMinerSummary"),
        batchBacktestMinerResults: getRequiredElement<HTMLDivElement>("batchBacktestMinerResults"),
        batchBacktestResults: getRequiredElement<HTMLDivElement>("batchBacktestResults"),
        batchBacktestEmpty: getRequiredElement<HTMLDivElement>("batchBacktestEmpty"),
    };
}

export type BatchBacktestDom = ReturnType<typeof createBatchBacktestDom>;
