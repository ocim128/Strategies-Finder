import { expect } from 'chai';
import { describe, it } from 'node:test';
import type { OHLCVData, Strategy, StrategyExecutionContext, Time } from '../../lib/strategies/index';
import { strategyManifest } from '../../lib/strategies/manifest-eager';

function buildExecutionContext(strategy: Strategy, bars: OHLCVData[]): StrategyExecutionContext | undefined {
    const context: StrategyExecutionContext = {};

    if (strategy.crossSymbolConfig) {
        const secondaryData = bars.map((bar, index) => ({
            ...bar,
            open: bar.open * 0.985 + index * 0.03,
            high: bar.high * 0.992 + index * 0.03,
            low: bar.low * 0.978 + index * 0.03,
            close: bar.close * 0.989 + Math.sin(index / 9) * 0.6,
            volume: bar.volume * 1.08 + (index % 7) * 3,
        }));

        context.crossSymbol = {
            primarySymbol: "BTCUSDT",
            secondarySymbol: strategy.crossSymbolConfig.defaultSymbol,
            secondaryData,
            alignedLength: bars.length,
            trimmedLeadingBars: 0,
        };
    }

    if (strategy.polymarket1sConfig) {
        context.polymarket1s = {
            symbol: "BTCUSDT",
            outcomeSymbol: "BTCUSDT",
            seriesId: "test-series",
            outcomeInterval: "5m",
            quotes: bars.map((bar) => {
                const sampleTs = Number(bar.time);
                const eventStartTs = Math.floor((sampleTs - 1) / 300) * 300 + 1;
                return {
                    series_id: "test-series",
                    symbol: "BTCUSDT",
                    outcome_interval: "5m",
                    event_start_ts: eventStartTs,
                    event_end_ts: eventStartTs + 300,
                    sample_ts: sampleTs,
                    yes_mid: 0.48 + Math.sin(sampleTs / 17) * 0.06,
                    no_mid: 0.52 - Math.sin(sampleTs / 17) * 0.06,
                    yes_ask: 0.52 + Math.sin(sampleTs / 19) * 0.04,
                    no_ask: 0.52 - Math.sin(sampleTs / 19) * 0.04,
                };
            }),
        };
    }

    return context.crossSymbol || context.polymarket1s ? context : undefined;
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
            rolling_median_dynamic_channel_breakout: {
                lookback: 14,
                threshold: 0.7,
                maxAdverse: 1,
            },
            adx_skewness_drift: {
                adxPeriod: 18,
                adxThresh: 22,
                skewThreshold: 0.35,
            },
            close_acceptance_volume_conviction: {
                lookback: 18,
                convictionRank: 82,
            },
            velocity_percentile_phi_snap: {
                velocityWindow: 4,
                erLookback: 11,
                phiInefficiency: 0.45,
            },
            entropy_acceleration_transition: {
                entropyWindow: 16,
                rocPeriod: 4,
            },
            tail_volatility_dislocation_executable_edge: {
                lookback: 18,
                atrMultiplier: 1.9,
                minEdge: 0.01,
            },
            typical_price_percentile_acceleration_executable_edge: {
                lookback: 18,
                pctThreshold: 0.42,
                minEdge: 0.01,
            },
            vol_adjusted_volume_surge_reversal_reaction: {
                lookback: 18,
                atrMultiplier: 1.7,
                volZThreshold: 1.2,
                lagSec: 3,
            },
            efficiency_ratio_regime_pressure_gap: {
                lookback: 18,
                minEfficiency: 0.45,
                minEdge: 0.01,
            },
            skewness_regime_reversion_pressure_gap: {
                lookback: 18,
                skewThreshold: 0.75,
                minEdge: 0.01,
            },
            micro_streak_decay_executable_edge: {
                streakLength: 3,
                volLookback: 18,
                minEdge: 0.01,
            },
            probability_theta_decay_arbitrage: {
                volLookback: 18,
                progressMin: 0.5,
                minEdge: 0.01,
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
