import { createFakeElement } from "./fake-element";
/**
 * Shared fake Batch DOM factory derived from `BATCH_BACKTEST_REQUIRED_IDS`.
 * Keeps browser lifecycle fixtures aligned with the live DOM contract so
 * removed controls cannot silently reappear and new TOP_MEAN fields cannot
 * drift out of test setup.
 */
import {
    BATCH_BACKTEST_REQUIRED_IDS,
    type BatchBacktestDom,
} from "../../lib/batch-backtest/batch-backtest-dom";

export function createFakeBatchElement(): any {
    return createFakeElement();
}

const DEFAULT_VALUES: Partial<Record<(typeof BATCH_BACKTEST_REQUIRED_IDS)[number], string>> = {
    batchBacktestBalancedMaxPairs: "2000",
    batchBacktestBalancedSeed: "1",
    batchBacktestOpenScoreUsdHorizons: "12,24,48",
    batchBacktestSp500TopMeanHorizons: "12,24,48",
    batchBacktestSp500TopMeanWorkers: "4",
    batchBacktestSp500TopMeanMaxPairs: "",
    batchBacktestSp500TopMeanSelectionCooldownBars: "5",
    batchBacktestSp500TopMeanDetailsSelector: "TOP_MEAN",
    batchBacktestSp500TopMeanTieBreak: "off",
};

/**
 * Build a complete `BatchBacktestDom` shell with one fake element per required
 * id. Override individual fields after construction when a test needs seeded
 * values (e.g. balanced assets textarea).
 */
export function createFakeBatchBacktestDom(): BatchBacktestDom {
    const dom: Record<string, any> = {};
    for (const id of BATCH_BACKTEST_REQUIRED_IDS) {
        const el = createFakeBatchElement();
        const defaultValue = DEFAULT_VALUES[id];
        if (defaultValue !== undefined) {
            el.value = defaultValue;
        }
        dom[id] = el;
    }
    return dom as BatchBacktestDom;
}
