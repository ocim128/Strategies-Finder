import { expect } from 'chai';
import { describe, it } from 'node:test';
import { deriveWalkForwardTradeThresholds } from './lib/walk-forward-thresholds';

describe('Walk-forward trade thresholds', () => {
    it('derives thresholds from the active manual window configuration', () => {
        const totalTrades = 748;
        const totalBars = 37_391;
        const tradesPerBar = totalTrades / totalBars;

        const manual = deriveWalkForwardTradeThresholds(totalTrades, tradesPerBar, 200, 182);
        const suggested = deriveWalkForwardTradeThresholds(totalTrades, tradesPerBar, 1_200, 29);

        expect(manual.minOOSTradesPerWindow).to.equal(2);
        expect(manual.minTotalOOSTrades).to.equal(182);
        expect(suggested.minOOSTradesPerWindow).to.equal(12);
        expect(suggested.minTotalOOSTrades).to.equal(174);
    });

    it('keeps minimum thresholds finite for sparse strategies', () => {
        const thresholds = deriveWalkForwardTradeThresholds(3, 0, 200, 50);

        expect(thresholds.expectedOOSTradesPerWindow).to.equal(0);
        expect(thresholds.minTrades).to.equal(1);
        expect(thresholds.minOOSTradesPerWindow).to.equal(1);
        expect(thresholds.minTotalOOSTrades).to.equal(20);
    });
});
