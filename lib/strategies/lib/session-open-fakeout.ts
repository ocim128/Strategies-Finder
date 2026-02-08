import { Strategy, OHLCVData, StrategyParams } from '../types';
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getHighs, getLows } from '../strategy-helpers';

export const session_open_fakeout: Strategy = {
    name: 'Session Open Fakeout',
    description: 'Builds an opening range each session and fades quick failed breaks back into that range.',
    defaultParams: {
        sessionBars: 24,
        openingRangeBars: 3,
        fakeoutWindowBars: 8
    },
    paramLabels: {
        sessionBars: 'Bars Per Session',
        openingRangeBars: 'Opening Range Bars',
        fakeoutWindowBars: 'Fakeout Window (bars)'
    },
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        if (cleanData.length === 0) return [];

        const sessionBars = Math.max(6, Math.round(params.sessionBars ?? 24));
        const openingRangeBars = Math.max(2, Math.min(sessionBars - 1, Math.round(params.openingRangeBars ?? 3)));
        const fakeoutWindowBars = Math.max(1, Math.round(params.fakeoutWindowBars ?? 8));

        const highs = getHighs(cleanData);
        const lows = getLows(cleanData);
        const passthrough = new Array<number>(cleanData.length).fill(0);

        let sessionStart = 0;
        let rangeHigh: number | null = null;
        let rangeLow: number | null = null;

        return createSignalLoop(cleanData, [passthrough], (i) => {
            if (i > 0 && i % sessionBars === 0) {
                sessionStart = i;
                rangeHigh = null;
                rangeLow = null;
            }

            const barsFromStart = i - sessionStart;

            if (barsFromStart < openingRangeBars) {
                rangeHigh = rangeHigh === null ? highs[i] : Math.max(rangeHigh, highs[i]);
                rangeLow = rangeLow === null ? lows[i] : Math.min(rangeLow, lows[i]);
                return null;
            }

            if (rangeHigh === null || rangeLow === null) return null;
            if (barsFromStart > openingRangeBars + fakeoutWindowBars) return null;

            const close = cleanData[i].close;
            if (highs[i] > rangeHigh && close < rangeHigh) {
                return createSellSignal(cleanData, i, 'Opening Range Fakeout Up');
            }

            if (lows[i] < rangeLow && close > rangeLow) {
                return createBuySignal(cleanData, i, 'Opening Range Fakeout Down');
            }

            return null;
        });
    },
    metadata: {
        role: 'entry',
        direction: 'both',
        walkForwardParams: ['sessionBars', 'openingRangeBars', 'fakeoutWindowBars']
    }
};
