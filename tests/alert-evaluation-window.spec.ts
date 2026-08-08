import { expect } from 'chai';
import { describe, it } from 'node:test';
import { selectExecutionAwareClosedCandles } from '../lib/alert-evaluation-window';
import type { OHLCVData, Time } from '../lib/strategies/index';

function buildCandles(count: number, startSec = 1_700_000_000, intervalSec = 60): OHLCVData[] {
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

describe('Alert Evaluation Window', () => {
    it('returns null when not enough closed candles exist and fallback is disabled', () => {
        const candles = buildCandles(1);
        const result = selectExecutionAwareClosedCandles(
            candles,
            '1m',
            { executionModel: 'signal_close' },
            {
                nowSec: Number(candles[0].time),
                minClosedCandles: 2,
            }
        );

        expect(result).to.equal(null);
    });

    it('falls back to trimmed closed candles when requested', () => {
        const candles = buildCandles(1);
        const result = selectExecutionAwareClosedCandles(
            candles,
            '1m',
            { executionModel: 'signal_close' },
            {
                nowSec: Number(candles[0].time),
                minClosedCandles: 2,
                fallbackToTrimmedClosed: true,
            }
        );

        expect(result).to.not.equal(null);
        expect(result).to.have.length(1);
        expect(result?.[0].time).to.equal(candles[0].time);
    });

    it('adds the next-open bridge candle for next_open execution when a closed window exists', () => {
        const candles = buildCandles(3);
        const nowSec = Number(candles[2].time);
        const result = selectExecutionAwareClosedCandles(
            candles,
            '1m',
            { executionModel: 'next_open' },
            {
                nowSec,
                minClosedCandles: 1,
            }
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

    it('normalizes ISO and millisecond candle times before deciding which candle is open', () => {
        for (const time of [
            new Date(1_700_000_120 * 1000).toISOString() as Time,
            (1_700_000_120_000) as Time,
        ]) {
            const candles = buildCandles(3);
            candles[2].time = time;
            const result = selectExecutionAwareClosedCandles(
                candles,
                '1m',
                { executionModel: 'signal_close' },
                { nowSec: 1_700_000_120, minClosedCandles: 1 },
            );

            expect(result).to.have.length(2);
        }
    });

    it('keeps the next-open bridge in the trimmed fallback path', () => {
        const candles = buildCandles(3);
        const result = selectExecutionAwareClosedCandles(
            candles,
            '1m',
            { executionModel: 'next_open' },
            {
                nowSec: Number(candles[2].time),
                minClosedCandles: 10,
                fallbackToTrimmedClosed: true,
            },
        );

        expect(result).to.have.length(3);
        expect(result?.[2].open).to.equal(candles[2].open);
        expect(result?.[2].high).to.equal(candles[2].open);
        expect(result?.[2].low).to.equal(candles[2].open);
        expect(result?.[2].close).to.equal(candles[2].open);
    });
});
