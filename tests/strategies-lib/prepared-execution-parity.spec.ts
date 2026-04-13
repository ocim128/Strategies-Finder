import { expect } from 'chai';
import { describe, it } from 'node:test';
import type { OHLCVData, Time } from '../../lib/strategies/index';
import { strategyManifest } from '../../lib/strategies/manifest';

describe('strategy prepared execution parity', () => {
    it('keeps prepared execution aligned with direct execution for strategies that expose finder precompute hooks', () => {
        const bars: OHLCVData[] = [];
        for (let i = 0; i < 180; i++) {
            const base = 100 + i * 0.25 + Math.sin(i / 6) * 4;
            bars.push({
                time: (i + 1) as Time,
                open: base - 0.5,
                high: base + 1.25,
                low: base - 1.25,
                close: base + Math.cos(i / 5) * 0.75,
                volume: 100 + (i % 12) * 8,
            });
        }

        const cases = strategyManifest.filter(({ strategy }) =>
            typeof strategy.prepareFinderData === 'function'
            || typeof strategy.executePrepared === 'function'
        );

        expect(cases.length).to.be.greaterThan(0);

        for (const { key, strategy } of cases) {
            expect(typeof strategy.prepareFinderData, `${key} should expose prepareFinderData`).to.equal('function');
            expect(typeof strategy.executePrepared, `${key} should expose executePrepared`).to.equal('function');

            const prepared = strategy.prepareFinderData!(bars);
            const preparedSignals = strategy.executePrepared!(prepared, strategy.defaultParams, bars);
            const directSignals = strategy.execute(bars, strategy.defaultParams);

            expect(preparedSignals, `${key} prepared-path drift`).to.deep.equal(directSignals);
        }
    });
});
