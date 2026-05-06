import { expect } from 'chai';
import { describe, it } from 'node:test';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { OHLCVData, StrategyParams } from '../../lib/strategies';
import { strategyManifest } from '../../lib/strategies/manifest';

function buildBars(length: number): OHLCVData[] {
    const bars: OHLCVData[] = [];
    for (let i = 0; i < length; i++) {
        const trend = 100 + i * 0.18;
        const wave = Math.sin(i / 5) * 3 + Math.cos(i / 11) * 1.5;
        const close = trend + wave;
        const open = close - Math.sin(i / 3) * 0.8;
        const high = Math.max(open, close) + 1.2 + (i % 3) * 0.1;
        const low = Math.min(open, close) - 1.1 - (i % 2) * 0.1;

        bars.push({
            time: i + 1,
            open,
            high,
            low,
            close,
            volume: 1000 + (i % 7) * 50,
        });
    }
    return bars;
}

function createRawParams(defaultParams: StrategyParams): StrategyParams {
    const rawParams: StrategyParams = {};

    for (const [key, value] of Object.entries(defaultParams)) {
        if (!Number.isFinite(value)) continue;

        rawParams[key] = Number.isInteger(value)
            ? (value > 1 ? value + 0.6 : value - 2.4)
            : (value === 0 ? -0.75 : -Math.abs(value) - 0.37);
    }

    return rawParams;
}

describe('strategy normalization parity', () => {
    const bars = buildBars(240);
    const cases = strategyManifest.filter(({ strategy }) => typeof strategy.normalizeParams === 'function');

    it('exposes normalizeParams and keeps defaults canonical for manifest strategies that opt into normalization', () => {
        expect(cases.length).to.be.greaterThan(0);

        for (const { key, strategy } of cases) {
            const normalizedDefaults = strategy.normalizeParams!(strategy.defaultParams);
            expect(normalizedDefaults, `${key} default params drift`).to.deep.equal(strategy.defaultParams);
        }
    });

    it('keeps direct execution aligned with normalized parameter values', () => {
        for (const { key, strategy } of cases) {
            const rawParams = createRawParams(strategy.defaultParams);
            const normalizedParams = strategy.normalizeParams!(rawParams);
            const rawSignals = strategy.execute(bars, rawParams);
            const normalizedSignals = strategy.execute(bars, normalizedParams);

            expect(rawSignals, `${key} execute() should normalize params internally`).to.deep.equal(normalizedSignals);
        }
    });

    it('keeps built-in strategy execution free of ambient randomness', () => {
        const strategyDir = path.join(process.cwd(), 'lib', 'strategies', 'lib');
        const offenders = readdirSync(strategyDir)
            .filter((name) => name.endsWith('.ts'))
            .filter((name) => /\bMath\.random\s*\(/.test(readFileSync(path.join(strategyDir, name), 'utf8')));

        expect(offenders).to.deep.equal([]);
    });
});
