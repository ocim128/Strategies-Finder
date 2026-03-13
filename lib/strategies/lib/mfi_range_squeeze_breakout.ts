import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from "../strategy-helpers";
import { calculateMFI } from "../indicators";
import { buildRollingMinMax, buildRateOfChange } from "./price-action-statistics-core";

export const mfi_range_squeeze_breakout: Strategy = {
    name: "MFI Range Squeeze Breakout",
    description: "Finds extreme complacency environments where the entire swing amplitude (the maximum minus minimum) of the Money Flow Index collapses to a rolling historical floor, waiting for a Rate of Change trigger to smash the equilibrium.",
    defaultParams: {
        mfiPeriod: 14,
        squeezeLookback: 40,
        rocTrigger: 2.0,
    },
    paramLabels: {
        mfiPeriod: "MFI Array Bounds",
        squeezeLookback: "Structural Range Matrix",
        rocTrigger: "Velocity ROC Limit",
    },
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const mPeriod = params.mfiPeriod as number;
        const sLookback = params.squeezeLookback as number;

        if (cleanData.length < mPeriod + sLookback * 2 + 10) return [];

        const mfi = calculateMFI(
            cleanData.map(d => d.high),
            cleanData.map(d => d.low),
            cleanData.map(d => d.close),
            cleanData.map(d => d.volume),
            mPeriod
        );

        const safeMfi = mfi.map(v => v === null ? 50 : v);
        
        // First layer: The historical MFI trajectory local maximums and minimums (small 10 bar rolling block)
        const localLimits = buildRollingMinMax(safeMfi, 10);
        
        // The raw point amplitude mapping the thickness of the overall Money Flow trace
        const amplitudes = localLimits.max.map((maxVal, i) => {
            const minVal = localLimits.min[i];
            if (maxVal === null || minVal === null) return null;
            return maxVal - minVal;
        });

        const safeAmplitudes = amplitudes.map(v => v === null ? 0.000001 : v);
        
        // Second layer: the historical compression of the dimensional thickness array itself
        const squeezeLimits = buildRollingMinMax(safeAmplitudes, sLookback);

        const rocSeries = buildRateOfChange(cleanData.map(d => d.close), 1);

        return createSignalLoop(cleanData, [], (i) => {
            if (i < mPeriod + sLookback + 12 || squeezeLimits.min[i - 1] === null || rocSeries[i] === null) return null;

            const prevThickness = safeAmplitudes[i - 1];
            const squeezeFloor = squeezeLimits.min[i - 1]!;

            // Is the total amplitude of money flow mathematically stalemated?
            const wasSqueezed = prevThickness <= squeezeFloor + 0.0001; 

            const roc = rocSeries[i]! * 100;
            const rocGate = params.rocTrigger as number;

            // Buy: Volume vector dead, price explosively breaches
            if (wasSqueezed && roc > rocGate) {
                return createBuySignal(cleanData, i, "Directional upward thrust definitively exiting an MFI geometric thickness squeeze limits");
            }

            // Sell: Volume vector dead, price explosively breaks
            if (wasSqueezed && roc < -rocGate) {
                return createSellSignal(cleanData, i, "Directional downward wipeout definitively exiting an MFI geometric thickness squeeze limits");
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["mfiPeriod", "squeezeLookback", "rocTrigger"],
    },
};
