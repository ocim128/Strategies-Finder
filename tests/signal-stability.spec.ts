import { expect } from 'chai';
import { describe, it } from 'node:test';
import { OHLCVData, Signal, Time } from './lib/strategies/index';
import { strategies } from './lib/strategies/library';
describe('Causal Signal Stability', () => {
    const buildSyntheticBars = (length: number): OHLCVData[] => {
        const bars: OHLCVData[] = [];
        let close = 100;
        for (let i = 0; i < length; i++) {
            const wave = Math.sin(i / 7) * 1.6;
            const drift = Math.cos(i / 13) * 0.7;
            const open = close;
            close = Math.max(1, close + wave + drift);
            const span = 0.8 + Math.abs(Math.sin(i / 5)) * 0.9;
            bars.push({
                time: (i + 1) as Time,
                open,
                high: Math.max(open, close) + span,
                low: Math.min(open, close) - span,
                close,
                volume: 100 + ((i % 11) * 3),
            });
        }
        return bars;
    };

    const signalKey = (signal: Signal): string =>
        `${Number.isFinite(signal.barIndex as number) ? Math.trunc(signal.barIndex as number) : -1}|${signal.type}`;

    const expectPrefixStable = (strategyKey: string, minPrefix = 140): void => {
        const strategy = strategies[strategyKey];
        expect(strategy, `strategy ${strategyKey} should exist`).to.not.equal(undefined);

        const bars = buildSyntheticBars(320);
        const fullSignals = strategy!.execute(bars, strategy!.defaultParams);
        const fullByBar = new Map<number, Set<string>>();

        for (const signal of fullSignals) {
            const barIndex = Number.isFinite(signal.barIndex as number) ? Math.trunc(signal.barIndex as number) : -1;
            if (barIndex < 0) continue;
            const bucket = fullByBar.get(barIndex) ?? new Set<string>();
            bucket.add(signalKey(signal));
            fullByBar.set(barIndex, bucket);
        }

        for (let prefix = minPrefix; prefix <= bars.length; prefix++) {
            const prefixSignals = strategy!.execute(bars.slice(0, prefix), strategy!.defaultParams);
            const prefixSet = new Set<string>();
            for (const signal of prefixSignals) {
                const barIndex = Number.isFinite(signal.barIndex as number) ? Math.trunc(signal.barIndex as number) : -1;
                if (barIndex >= 0 && barIndex < prefix) {
                    prefixSet.add(signalKey(signal));
                }
            }

            const fullSubset = new Set<string>();
            for (let bar = 0; bar < prefix; bar++) {
                const bucket = fullByBar.get(bar);
                if (!bucket) continue;
                for (const key of bucket) fullSubset.add(key);
            }

            expect(prefixSet.size, `${strategyKey} signal count mismatch at prefix ${prefix}`).to.equal(fullSubset.size);
            for (const key of prefixSet) {
                expect(fullSubset.has(key), `${strategyKey} unstable signal ${key} at prefix ${prefix}`).to.equal(true);
            }
        }
    };

    it('volatility_compression_break should keep prior signals stable when candles are appended', () => {
        expectPrefixStable('volatility_compression_break');
    });
});

