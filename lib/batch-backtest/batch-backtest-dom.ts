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
    "batchBacktestSymbolTemplate",
    "batchBacktestUseCurrent",
    "batchBacktestClear",
    "batchBacktestRunBtn",
    "batchBacktestStopBtn",
    "batchBacktestCopyBtn",
    "batchBacktestCopyBenchmarkBtn",
    "batchBacktestMineBtn",
    "batchBacktestCopyMinerBtn",
    "batchBacktestAutoRunStability",
    "batchBacktestStabilitySubsetSize",
    "batchBacktestStabilityReruns",
    "batchBacktestStabilitySeed",
    "batchBacktestStabilityMineBtn",
    "batchBacktestCopyStabilityBtn",
    "batchBacktestPortfolioFitBtn",
    "batchBacktestCopyPortfolioFitBtn",
    "batchBacktestPortfolioFitSummary",
    "batchBacktestPortfolioFitResults",
    "batchBacktestTimingSurfaceBtn",
    "batchBacktestCopyTimingSurfaceBtn",
    "batchBacktestTimingSurfaceSummary",
    "batchBacktestTimingSurfaceResults",
    "batchBacktestProgress",
    "batchBacktestProgressFill",
    "batchBacktestProgressText",
    "batchBacktestStatus",
    "batchBacktestSummary",
    "batchBacktestSummaryGrid",
    "batchBacktestMinerSummary",
    "batchBacktestMinerResults",
    "batchBacktestResults",
    "batchBacktestEmpty",
] as const;

export function createBatchBacktestDom() {
    return {
        batchbacktestTab: getRequiredElement("batchbacktestTab"),
        batchBacktestSymbols: getRequiredElement<HTMLTextAreaElement>("batchBacktestSymbols"),
        batchBacktestSymbolTemplate: getRequiredElement<HTMLSelectElement>("batchBacktestSymbolTemplate"),
        batchBacktestUseCurrent: getRequiredElement<HTMLButtonElement>("batchBacktestUseCurrent"),
        batchBacktestClear: getRequiredElement<HTMLButtonElement>("batchBacktestClear"),
        batchBacktestRunBtn: getRequiredElement<HTMLButtonElement>("batchBacktestRunBtn"),
        batchBacktestStopBtn: getRequiredElement<HTMLButtonElement>("batchBacktestStopBtn"),
        batchBacktestCopyBtn: getRequiredElement<HTMLButtonElement>("batchBacktestCopyBtn"),
        batchBacktestCopyBenchmarkBtn: getRequiredElement<HTMLButtonElement>("batchBacktestCopyBenchmarkBtn"),
        batchBacktestMineBtn: getRequiredElement<HTMLButtonElement>("batchBacktestMineBtn"),
        batchBacktestCopyMinerBtn: getRequiredElement<HTMLButtonElement>("batchBacktestCopyMinerBtn"),
        batchBacktestAutoRunStability: getRequiredElement<HTMLInputElement>("batchBacktestAutoRunStability"),
        batchBacktestStabilitySubsetSize: getRequiredElement<HTMLInputElement>("batchBacktestStabilitySubsetSize"),
        batchBacktestStabilityReruns: getRequiredElement<HTMLInputElement>("batchBacktestStabilityReruns"),
        batchBacktestStabilitySeed: getRequiredElement<HTMLInputElement>("batchBacktestStabilitySeed"),
        batchBacktestStabilityMineBtn: getRequiredElement<HTMLButtonElement>("batchBacktestStabilityMineBtn"),
        batchBacktestCopyStabilityBtn: getRequiredElement<HTMLButtonElement>("batchBacktestCopyStabilityBtn"),
        batchBacktestPortfolioFitBtn: getRequiredElement<HTMLButtonElement>("batchBacktestPortfolioFitBtn"),
        batchBacktestCopyPortfolioFitBtn: getRequiredElement<HTMLButtonElement>("batchBacktestCopyPortfolioFitBtn"),
        batchBacktestPortfolioFitSummary: getRequiredElement<HTMLDivElement>("batchBacktestPortfolioFitSummary"),
        batchBacktestPortfolioFitResults: getRequiredElement<HTMLDivElement>("batchBacktestPortfolioFitResults"),
        batchBacktestTimingSurfaceBtn: getRequiredElement<HTMLButtonElement>("batchBacktestTimingSurfaceBtn"),
        batchBacktestCopyTimingSurfaceBtn: getRequiredElement<HTMLButtonElement>("batchBacktestCopyTimingSurfaceBtn"),
        batchBacktestTimingSurfaceSummary: getRequiredElement<HTMLDivElement>("batchBacktestTimingSurfaceSummary"),
        batchBacktestTimingSurfaceResults: getRequiredElement<HTMLDivElement>("batchBacktestTimingSurfaceResults"),
        batchBacktestProgress: getRequiredElement("batchBacktestProgress"),
        batchBacktestProgressFill: getRequiredElement<HTMLDivElement>("batchBacktestProgressFill"),
        batchBacktestProgressText: getRequiredElement<HTMLDivElement>("batchBacktestProgressText"),
        batchBacktestStatus: getRequiredElement<HTMLDivElement>("batchBacktestStatus"),
        batchBacktestSummary: getRequiredElement<HTMLDivElement>("batchBacktestSummary"),
        batchBacktestSummaryGrid: getRequiredElement<HTMLDivElement>("batchBacktestSummaryGrid"),
        batchBacktestMinerSummary: getRequiredElement<HTMLDivElement>("batchBacktestMinerSummary"),
        batchBacktestMinerResults: getRequiredElement<HTMLDivElement>("batchBacktestMinerResults"),
        batchBacktestResults: getRequiredElement<HTMLDivElement>("batchBacktestResults"),
        batchBacktestEmpty: getRequiredElement<HTMLDivElement>("batchBacktestEmpty"),
    };
}

export type BatchBacktestDom = ReturnType<typeof createBatchBacktestDom>;
