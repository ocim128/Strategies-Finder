import { expect } from 'chai';
import { describe, it } from 'node:test';
import type { Time } from 'lightweight-charts';
import type { OHLCVData } from './lib/strategies/types';
import type { FeatureLabRow } from './lib/featureLab/types';
import {
    buildFeatureLabDataset,
    buildFeatureLabMetadata,
    buildFeatureLabVerdictReport,
    evaluateTpBeforeSlLabel,
} from './lib/featureLab/featureLabService';

function createBars(closes: number[]): OHLCVData[] {
    return closes.map((close, idx) => {
        const high = close * 1.01;
        const low = close * 0.99;
        return {
            time: (idx + 1) as unknown as Time,
            open: close,
            high,
            low,
            close,
            volume: 1000 + idx * 10,
        };
    });
}

describe('Feature Lab MVP', () => {
    it('keeps feature/label indexing aligned with no forward leakage', () => {
        const closes = Array.from({ length: 80 }, (_, i) => 100 + i);
        const bars = createBars(closes);
        const dataset = buildFeatureLabDataset(bars);

        expect(dataset.rows.length).to.be.greaterThan(0);

        const first = dataset.rows[0];
        const last = dataset.rows[dataset.rows.length - 1];

        expect(first.barIndex).to.equal(27);
        expect(last.barIndex).to.equal(59);
        expect(first.split).to.equal('train');
        expect(last.split).to.equal('holdout');

        const expectedRet5 = bars[first.barIndex].close / bars[first.barIndex - 5].close - 1;
        const expectedFwd5 = bars[first.barIndex + 5].close / bars[first.barIndex].close - 1;
        const expectedFwd20 = bars[first.barIndex + 20].close / bars[first.barIndex].close - 1;

        expect(first.ret_5).to.be.closeTo(expectedRet5, 1e-12);
        expect(first.fwd_ret_5).to.be.closeTo(expectedFwd5, 1e-12);
        expect(first.fwd_ret_20).to.be.closeTo(expectedFwd20, 1e-12);

        const metadata = buildFeatureLabMetadata(dataset, 'ETHUSDT', '1m');
        expect(metadata.columns).to.include('split');
        expect(metadata.symbol).to.equal('ETHUSDT');
        expect(metadata.interval).to.equal('1m');
    });

    it('computes TP-before-SL labels correctly on synthetic candles', () => {
        const bars: OHLCVData[] = [
            { time: 1 as unknown as Time, open: 100, high: 100.4, low: 99.6, close: 100, volume: 1000 },
            { time: 2 as unknown as Time, open: 100, high: 103, low: 100, close: 101, volume: 1000 },
            { time: 3 as unknown as Time, open: 101, high: 100.5, low: 98.5, close: 99, volume: 1000 },
            { time: 4 as unknown as Time, open: 99, high: 99.5, low: 97.5, close: 98, volume: 1000 },
        ];

        const tpPct = 0.02;
        const slPct = 0.01;

        const longFromBar0 = evaluateTpBeforeSlLabel(bars, 0, 2, tpPct, slPct, 'long');
        const shortFromBar0 = evaluateTpBeforeSlLabel(bars, 0, 2, tpPct, slPct, 'short');
        const longFromBar1 = evaluateTpBeforeSlLabel(bars, 1, 2, tpPct, slPct, 'long');
        const shortFromBar1 = evaluateTpBeforeSlLabel(bars, 1, 2, tpPct, slPct, 'short');

        expect(longFromBar0).to.equal(1);
        expect(shortFromBar0).to.equal(0);
        expect(longFromBar1).to.equal(0);
        expect(shortFromBar1).to.equal(1);
    });

    it('applies min-sample filtering in verdict ranking', () => {
        const rows: FeatureLabRow[] = Array.from({ length: 60 }, (_, i) => {
            const base = i - 30;
            return {
                barIndex: i + 30,
                time: i + 30,
                datetime: new Date((i + 30) * 1000).toISOString(),
                split: i < 36 ? 'train' : i < 48 ? 'validation' : 'holdout',
                close: 100 + i,
                ret_1: base * 0.001,
                ret_5: base * 0.002,
                rsi_14: 50 + (base % 15),
                atr_pct_14: 0.01 + (i % 5) * 0.001,
                adx_14: 20 + (i % 20),
                ema_fast_slow_spread: base * 0.0005,
                volume_rel_20: 0.8 + (i % 10) * 0.1,
                fwd_ret_5: base >= 0 ? 0.01 : -0.01,
                fwd_ret_20: base >= 0 ? 0.02 : -0.02,
                long_tp_before_sl: base >= 0 ? 1 : 0,
                short_tp_before_sl: base >= 0 ? 0 : 1,
            };
        });

        const relaxed = buildFeatureLabVerdictReport(rows, {
            binCount: 4,
            minSampleCount: 5,
            topBinsPerSide: 10,
            targetReturn: 'fwd_ret_20',
        });
        const strict = buildFeatureLabVerdictReport(rows, {
            binCount: 4,
            minSampleCount: 100,
            topBinsPerSide: 10,
            targetReturn: 'fwd_ret_20',
        });

        expect(relaxed.longTopBins.length + relaxed.shortTopBins.length).to.be.greaterThan(0);
        expect(strict.longTopBins).to.have.lengthOf(0);
        expect(strict.shortTopBins).to.have.lengthOf(0);
        expect(relaxed.allLongBins.length + relaxed.allShortBins.length).to.be.greaterThan(0);
    });
});
