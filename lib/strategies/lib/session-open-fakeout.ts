import { Strategy, OHLCVData, StrategyParams, StrategyIndicator } from '../types';
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getHighs, getLows } from '../strategy-helpers';
import { COLORS } from '../constants';

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
    indicators: (data: OHLCVData[], params: StrategyParams): StrategyIndicator[] => {
        const cleanData = ensureCleanData(data);
        if (cleanData.length === 0) return [];

        const sessionBars = Math.max(6, Math.round(params.sessionBars ?? 24));
        const openingRangeBars = Math.max(2, Math.min(sessionBars - 1, Math.round(params.openingRangeBars ?? 3)));

        const rangeHigh: (number | null)[] = new Array(cleanData.length).fill(null);
        const rangeLow: (number | null)[] = new Array(cleanData.length).fill(null);

        let currentHigh: number | null = null;
        let currentLow: number | null = null;
        let sessionStart = 0;

        for (let i = 0; i < cleanData.length; i++) {
            if (i > 0 && i % sessionBars === 0) {
                sessionStart = i;
                currentHigh = null;
                currentLow = null;
            }

            const barsFromStart = i - sessionStart;
            if (barsFromStart < openingRangeBars) {
                currentHigh = currentHigh === null ? cleanData[i].high : Math.max(currentHigh, cleanData[i].high);
                currentLow = currentLow === null ? cleanData[i].low : Math.min(currentLow, cleanData[i].low);
            }

            rangeHigh[i] = currentHigh;
            rangeLow[i] = currentLow;
        }

        return [
            { name: 'Opening Range High', type: 'line', values: rangeHigh, color: COLORS.Channel },
            { name: 'Opening Range Low', type: 'line', values: rangeLow, color: COLORS.Channel }
        ];
    },
    metadata: {
        role: 'entry',
        direction: 'both',
        walkForwardParams: ['sessionBars', 'openingRangeBars', 'fakeoutWindowBars']
    }
};
