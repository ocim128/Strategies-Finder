import { Strategy, OHLCVData, Signal, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, ensureCleanData, getTypicalPrices } from "../strategy-helpers";
import { buildPercentileRank, buildRollingZScore, extractBarMetricSeries } from "./price-action-statistics-core";

const ENTRY_THRESHOLD_MIN = 50;
const ENTRY_THRESHOLD_MAX = 99;
const EXIT_ZSCORE_THRESHOLD = 0.5;

function normalizeTypicalPricePercentileGapExitHybridParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        entryLookback: Math.max(2, Math.round(Number(params.entryLookback ?? 23))),
        entryThreshold: Math.max(
            ENTRY_THRESHOLD_MIN,
            Math.min(ENTRY_THRESHOLD_MAX, Number(params.entryThreshold ?? ENTRY_THRESHOLD_MIN))
        ),
        exitLookback: Math.max(2, Math.round(Number(params.exitLookback ?? 2))),
    };
}

export const typical_price_percentile_gap_exit_hybrid: Strategy = {
    name: "Typical Price Percentile Gap Exit Hybrid",
    description:
        "Uses Typical Price Percentile Alignment for new entries and a Rolling Gap Z-Score state change as the exit overlay, with opposite percentile entries taking priority over the exit leg.",
    defaultParams: {
        entryLookback: 23,
        entryThreshold: 50,
        exitLookback: 2,
    },
    paramLabels: {
        entryLookback: "Entry Lookback",
        entryThreshold: "Entry Threshold",
        exitLookback: "Exit Lookback",
    },
    normalizeParams: normalizeTypicalPricePercentileGapExitHybridParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeTypicalPricePercentileGapExitHybridParams(params);
        const entryLookback = p.entryLookback as number;
        const entryThreshold = (p.entryThreshold as number) / 100;
        const exitLookback = p.exitLookback as number;
        const requiredBars = Math.max(entryLookback, exitLookback) + 1;
        if (cleanData.length < requiredBars) return [];

        const typicalPrices = getTypicalPrices(cleanData);
        const percentileRank = buildPercentileRank(typicalPrices, entryLookback);
        const gaps = extractBarMetricSeries(cleanData, "gapPct");
        const gapZscore = buildRollingZScore(gaps, exitLookback);
        const signals: Signal[] = [];
        let virtualPosition: "long" | "short" | null = null;

        for (let i = 1; i < cleanData.length; i++) {
            const rank = percentileRank[i];
            const gapZ = gapZscore[i];
            const wantsLongEntry = rank !== null && rank > entryThreshold;
            const wantsShortEntry = rank !== null && rank < 1 - entryThreshold;
            const wantsLongExit = gapZ !== null && gapZ > EXIT_ZSCORE_THRESHOLD;
            const wantsShortExit = gapZ !== null && gapZ < -EXIT_ZSCORE_THRESHOLD;

            if (virtualPosition === null) {
                if (wantsLongEntry) {
                    signals.push(
                        createBuySignal(
                            cleanData,
                            i,
                            `Typical price percentile ${(rank! * 100).toFixed(1)}% above hybrid entry threshold`
                        )
                    );
                    virtualPosition = "long";
                    continue;
                }
                if (wantsShortEntry) {
                    signals.push(
                        createSellSignal(
                            cleanData,
                            i,
                            `Typical price percentile ${(rank! * 100).toFixed(1)}% below hybrid inverse threshold`
                        )
                    );
                    virtualPosition = "short";
                }
                continue;
            }

            if (virtualPosition === "long") {
                if (wantsShortEntry) {
                    signals.push(
                        createSellSignal(
                            cleanData,
                            i,
                            `Typical price percentile ${(rank! * 100).toFixed(1)}% triggered hybrid short reversal`
                        )
                    );
                    virtualPosition = "short";
                    continue;
                }
                if (wantsShortExit) {
                    signals.push(
                        createSellSignal(
                            cleanData,
                            i,
                            `Gap z-score ${gapZ!.toFixed(2)} triggered hybrid long exit`
                        )
                    );
                    virtualPosition = null;
                }
                continue;
            }

            if (wantsLongEntry) {
                signals.push(
                    createBuySignal(
                        cleanData,
                        i,
                        `Typical price percentile ${(rank! * 100).toFixed(1)}% triggered hybrid long reversal`
                    )
                );
                virtualPosition = "long";
                continue;
            }
            if (wantsLongExit) {
                signals.push(
                    createBuySignal(
                        cleanData,
                        i,
                        `Gap z-score ${gapZ!.toFixed(2)} triggered hybrid short exit`
                    )
                );
                virtualPosition = null;
            }
        }

        return signals;
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["entryLookback", "entryThreshold", "exitLookback"],
    },
};
