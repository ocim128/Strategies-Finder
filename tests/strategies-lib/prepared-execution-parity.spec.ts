import { expect } from 'chai';
import { describe, it } from 'node:test';
import type { OHLCVData, Strategy, StrategyExecutionContext, Time } from '../../lib/strategies/index';
import { strategyManifest } from '../../lib/strategies/manifest';

function buildExecutionContext(strategy: Strategy, bars: OHLCVData[]): StrategyExecutionContext | undefined {
    if (!strategy.crossSymbolConfig) {
        return undefined;
    }

    const secondaryData = bars.map((bar, index) => ({
        ...bar,
        open: bar.open * 0.985 + index * 0.03,
        high: bar.high * 0.992 + index * 0.03,
        low: bar.low * 0.978 + index * 0.03,
        close: bar.close * 0.989 + Math.sin(index / 9) * 0.6,
        volume: bar.volume * 1.08 + (index % 7) * 3,
    }));

    return {
        crossSymbol: {
            primarySymbol: "BTCUSDT",
            secondarySymbol: strategy.crossSymbolConfig.defaultSymbol,
            secondaryData,
            alignedLength: bars.length,
            trimmedLeadingBars: 0,
        },
    };
}

function assertPreparedParity(strategy: Strategy, bars: OHLCVData[], params: Record<string, number>): void {
    const executionContext = buildExecutionContext(strategy, bars);
    const normalizedParams = strategy.normalizeParams
        ? strategy.normalizeParams({ ...strategy.defaultParams, ...params })
        : { ...strategy.defaultParams, ...params };
    const prepared = strategy.prepareFinderData!(bars, undefined, executionContext);
    const preparedSignals = strategy.executePrepared!(prepared, normalizedParams, bars, executionContext);
    const directSignals = strategy.execute(bars, normalizedParams, executionContext);

    expect(preparedSignals).to.deep.equal(directSignals);
}

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
            assertPreparedParity(strategy, bars, strategy.defaultParams);
        }
    });

    it('keeps the converted heavy strategy batch aligned on non-default params', () => {
        const bars: OHLCVData[] = [];
        for (let i = 0; i < 220; i++) {
            const base = 150 + i * 0.18 + Math.sin(i / 8) * 5;
            bars.push({
                time: (i + 1) as Time,
                open: base - 0.75,
                high: base + 1.5,
                low: base - 1.4,
                close: base + Math.cos(i / 7) * 0.9,
                volume: 140 + (i % 9) * 11,
            });
        }

        const overridesByKey: Record<string, Record<string, number>> = {
            body_concentration_entropy_squeeze: {
                entropyWindow: 18,
                compressionRank: 35,
            },
            rolling_vwap_center: {
                lookback: 14,
            },
            return_skewness_exhaustion_fade: {
                skew_window: 18,
                zscore_threshold: 1.75,
            },
            relative_strength_mean_reversion: {
                lookback: 18,
                zThreshold: 1.4,
            },
        };

        for (const { key, strategy } of strategyManifest) {
            const overrides = overridesByKey[key];
            if (!overrides) {
                continue;
            }

            expect(typeof strategy.prepareFinderData, `${key} should expose prepareFinderData`).to.equal('function');
            expect(typeof strategy.executePrepared, `${key} should expose executePrepared`).to.equal('function');
            assertPreparedParity(strategy, bars, overrides);
        }
    });
});
