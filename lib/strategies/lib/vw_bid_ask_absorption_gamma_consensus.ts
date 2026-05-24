import type { Strategy, OHLCVData, StrategyExecutionContext, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    getCloses,
    getTypicalPrices,
    getVolumes,
} from "../strategy-helpers";
import { buildRollingMinMax } from "./price-action-statistics-core";
import { buildPolymarket1sGammaConsensusMask } from "./polymarket-1s-helpers";
import { normalizeIntegerParam, normalizeNumberParam } from "./range-conviction-core";
import {
    getPreparedValueAreaData,
    getValueAreaSeries,
} from "./value-area-acceptance-core";

function buildPocVolumeConcentration(
    data: OHLCVData[],
    poc: (number | null)[],
    lookbackInput: number,
    numBins = 12
): (number | null)[] {
    const lookback = Math.max(3, Math.round(lookbackInput));
    const bins = Math.max(3, Math.round(numBins));
    const closes = getCloses(data);
    const volumes = getVolumes(data);
    const result: (number | null)[] = new Array(data.length).fill(null);

    for (let i = lookback - 1; i < data.length; i++) {
        const currentPoc = poc[i];
        if (currentPoc === null) continue;
        const start = i - lookback + 1;
        let high = -Infinity;
        let low = Infinity;
        let totalVolume = 0;
        for (let j = start; j <= i; j++) {
            high = Math.max(high, data[j].high);
            low = Math.min(low, data[j].low);
            totalVolume += Math.max(0, volumes[j]);
        }
        const width = (high - low) / bins;
        if (width <= 0 || totalVolume <= 0) continue;

        let pocVolume = 0;
        const halfWidth = width / 2;
        for (let j = start; j <= i; j++) {
            if (Math.abs(closes[j] - currentPoc) <= halfWidth) {
                pocVolume += Math.max(0, volumes[j]);
            }
        }
        result[i] = pocVolume / totalVolume;
    }

    return result;
}

function normalizeVwBidAskAbsorptionGammaConsensusParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: normalizeIntegerParam(params.lookback, 50, 5),
        pocConcentration: normalizeNumberParam(params.pocConcentration, 0.6, 0, 1),
    };
}

export const vw_bid_ask_absorption_gamma_consensus: Strategy = {
    name: "Volume-Weighted Bid-Ask Absorption with Gamma Consensus",
    description: "Fades trailing extremes with concentrated POC volume only when Polymarket Gamma consensus agrees.",
    defaultParams: {
        lookback: 50,
        pocConcentration: 0.6,
    },
    paramLabels: {
        lookback: "Value Area Lookback",
        pocConcentration: "POC Volume Concentration",
    },
    normalizeParams: normalizeVwBidAskAbsorptionGammaConsensusParams,
    polymarket1sConfig: { required: true },
    prepareFinderData: (data: OHLCVData[]) => getPreparedValueAreaData(null, data),
    executePrepared: (preparedData: unknown, params: StrategyParams, data: OHLCVData[], context?: StrategyExecutionContext) => {
        if (!context?.polymarket1s) return [];

        const prepared = getPreparedValueAreaData(preparedData, data);
        const cleanData = prepared.cleanData;
        const p = normalizeVwBidAskAbsorptionGammaConsensusParams(params);
        const lookback = p.lookback;
        if (cleanData.length < lookback + 1) return [];

        const typicals = getTypicalPrices(cleanData);
        const boundary = buildRollingMinMax(typicals, lookback);
        const valueArea = getValueAreaSeries(prepared, lookback, 0.68, 12);
        const concentration = buildPocVolumeConcentration(cleanData, valueArea.poc, lookback, 12);
        const mask = buildPolymarket1sGammaConsensusMask(cleanData, context, { volLookback: lookback });
        if (!mask.available) return [];

        return createSignalLoop(cleanData, [boundary.min, boundary.max, valueArea.poc, concentration], (i) => {
            const low = boundary.min[i];
            const high = boundary.max[i];
            const pocShare = concentration[i];
            if (low === null || high === null || pocShare === null || pocShare < p.pocConcentration) return null;

            if (typicals[i] <= low && mask.longAllowed[i]) {
                return createBuySignal(cleanData, i, "POC volume concentration at trailing low with Gamma consensus");
            }
            if (typicals[i] >= high && mask.shortAllowed[i]) {
                return createSellSignal(cleanData, i, "POC volume concentration at trailing high with Gamma consensus");
            }
            return null;
        });
    },
    execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) =>
        vw_bid_ask_absorption_gamma_consensus.executePrepared!(
            vw_bid_ask_absorption_gamma_consensus.prepareFinderData!(data),
            params,
            data,
            context
        ),
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "pocConcentration"],
    },
};
