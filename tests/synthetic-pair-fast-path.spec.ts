import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { runBacktestCompact } from '../lib/strategies/backtest/backtest-engine';
import { buildSyntheticPairFromLegs } from '../scripts/lib/synthetic-pair';
import type { BacktestSettings, OHLCVData, Signal } from '../lib/types/strategies';

function stableResult(result: ReturnType<typeof runBacktestCompact>) {
    const { diagnostics: _, endpointSelection, ...stable } = result;
    if (!endpointSelection) return stable;
    // An unadjusted endpoint result may reference its parent result. Compare
    // all its outputs while excluding runtime diagnostics and that back-link.
    const { diagnostics: _endpoint, endpointSelection: _link, ...endpointResult } = endpointSelection.result as typeof result;
    return { ...stable, endpointSelection: { ...endpointSelection, result: endpointResult } };
}

function leg(quote: boolean): OHLCVData[] {
    let price = quote ? 100 : 200;
    return Array.from({ length: 96 }, (_, index) => {
        const open = price;
        price *= 1 + Math.sin(index * (quote ? 0.6 : 1.3)) * 0.012;
        return { time: (172800 + index * 1800) as OHLCVData['time'], open, close: price,
            high: Math.max(open, price) * 1.007, low: Math.min(open, price) * 0.993, volume: 1000 };
    });
}

describe('50/50 single-position Finder fast path', () => {
    for (const interval of ['30m', '4h']) {
        for (const executionModel of ['signal_close', 'next_open', 'next_close'] as const) {
            for (const tradeDirection of ['long', 'short', 'both'] as const) {
                for (const profile of ['percentage', 'atr', 'sparse', 'cooldown', 'kelly', 'confirmation'] as const) {
                    it(`matches fallback for ${interval}/${executionModel}/${tradeDirection}/${profile}`, async () => {
                        const base = leg(false), quote = leg(true);
                        const data = (await buildSyntheticPairFromLegs({
                            baseSymbol: 'BASE\u2022', quoteSymbol: 'QUOTE\u2022', interval, targetBars: 96,
                            executionMode: 'equal_weight', assumeNormalizedLegs: true,
                            fetchLeg: async symbol => symbol === 'BASE\u2022' ? base : quote,
                        })).bars;
                        // Explicit indexes exercise the allocation-free signal preparation.
                        // Partial and exit-only orders must retain both leg quantities/fills.
                        const signals: Signal[] = Array.from({ length: data.length - 1 }, (_, index) => ({
                            time: data[index].time, barIndex: index, price: data[index].close,
                            type: Math.floor(index / 2) % 2 === 0 ? 'buy' : 'sell',
                            ...(index % 7 === 3 ? { sizeFraction: 0.5 } : {}),
                            ...(index % 11 === 7 ? { exitOnly: true } : {}),
                        }));
                        const sparse = profile === 'sparse';
                        const settings: BacktestSettings = { executionModel, tradeDirection, slippageBps: 5, maxOpenTrades: 1,
                            riskMode: profile === 'atr' ? 'advanced' : 'percentage',
                            stopLossEnabled: !sparse, stopLossPercent: 0.7, takeProfitEnabled: !sparse, takeProfitPercent: 1.1,
                            stopLossAtr: profile === 'atr' ? 1 : 0, takeProfitAtr: profile === 'atr' ? 1.5 : 0,
                            atrPeriod: 3,
                            ...(profile === 'cooldown' ? { riskMinHoldEnabled: true, riskMinHoldBars: 2,
                                riskMaxHoldEnabled: true, riskMaxHoldBars: 4, riskCooldownEnabled: true, riskCooldownBars: 2 } : {}),
                            ...(profile === 'confirmation' ? { riskEntryConfirmationEnabled: true,
                                riskEntryConfirmationPercent: 0.3, riskEntryConfirmationBars: 2, riskEntryConfirmationMove: 'up' as const } : {}),
                        };
                        const sizing = { mode: profile === 'kelly' ? 'kelly_criterion' as const : 'fixed' as const, fixedTradeAmount: 1000 };
                        for (const requireTradeHistory of [true, false]) {
                            const options = { requireTradeHistory, includeSharpeRatio: !sparse, skipDrawdown: sparse,
                                endpointSelectionLastDataTime: data[data.length - 1].time, collectDiagnostics: true };
                            const fast = runBacktestCompact(data, signals, 10000, 10, 0.1, settings, sizing, undefined, { ...options, omitEquityCurve: true });
                            const fallback = runBacktestCompact(data, signals, 10000, 10, 0.1, settings, sizing, undefined, { ...options, omitEquityCurve: false });
                            assert.equal(fast.diagnostics?.fastPath?.used, true);
                            assert.equal(fallback.diagnostics?.fastPath?.used, false);
                            assert.deepEqual(stableResult(fast), stableResult(fallback));
                        }
                    });
                }
            }
        }
    }

    it('still blocks unsupported trailing/overlap paths and cooperates with cancellation', () => {
        const data: OHLCVData[] = [0, 1, 2].map(index => ({ time: (172800 + index * 1800) as OHLCVData['time'],
            open: 2, high: 2, low: 2, close: 2, volume: 1, pairLegs: [[200, 200, 200, 200, 100, 100, 100, 100]] }));
        const signals: Signal[] = [{ time: data[0].time, type: 'buy', price: 2 }];
        for (const settings of [{ trailingAtr: 1 }, { maxOpenTrades: 2 }]) {
            const result = runBacktestCompact(data, signals, 10000, 10, 0, settings, undefined, undefined,
                { omitEquityCurve: true, collectDiagnostics: true });
            assert.equal(result.diagnostics?.fastPath?.used, false);
        }
        assert.throws(() => runBacktestCompact(data, signals, 10000, 10, 0, {}, undefined, undefined,
            { omitEquityCurve: true, isCancelled: () => true }), /cancel/i);
    });
});
