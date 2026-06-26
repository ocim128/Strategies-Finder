import { expect } from 'chai';
import { describe, it } from 'node:test';
import { selectLatestEntryExportCandles } from '../lib/latest-entry-export-window';
import type { OHLCVData, Time } from '../lib/strategies/index';

function buildCandles(count: number, startSec = 1_700_000_000, intervalSec = 300): OHLCVData[] {
    const out: OHLCVData[] = [];
    for (let i = 0; i < count; i++) {
        const open = 100 + i;
        out.push({
            time: (startSec + i * intervalSec) as Time,
            open,
            high: open + 1,
            low: open - 1,
            close: open + 0.5,
            volume: 1000 + i,
        });
    }
    return out;
}

describe('Latest Entry Export Window', () => {
    it('preserves the next-open bridge candle for export when executionModel is next_open', () => {
        const candles = buildCandles(3);
        const nowSec = Number(candles[2].time);

        const result = selectLatestEntryExportCandles(
            candles,
            '5m',
            { executionModel: 'next_open' },
            nowSec
        );

        expect(result).to.not.equal(null);
        expect(result).to.have.length(3);
        expect(result?.[2].time).to.equal(candles[2].time);
        expect(result?.[2].open).to.equal(candles[2].open);
        expect(result?.[2].high).to.equal(candles[2].open);
        expect(result?.[2].low).to.equal(candles[2].open);
        expect(result?.[2].close).to.equal(candles[2].open);
        expect(result?.[2].volume).to.equal(0);
    });

    it('does not add a bridge candle for signal_close export', () => {
        const candles = buildCandles(3);
        const nowSec = Number(candles[2].time);

        const result = selectLatestEntryExportCandles(
            candles,
            '5m',
            { executionModel: 'signal_close' },
            nowSec
        );

        expect(result).to.not.equal(null);
        expect(result).to.have.length(2);
        expect(result?.[1].time).to.equal(candles[1].time);
    });
});
