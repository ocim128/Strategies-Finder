import { expect } from 'chai';
import { describe, it } from 'node:test';
import { mergeExitStrategySignals } from '../lib/exit-strategy-merge';
import { timeToNumber, compareTime } from '../lib/strategies/backtest/backtest-utils';
import type { Signal, Time } from '../lib/types/strategies';

function sig(time: number, type: 'buy' | 'sell', price = 100): Signal {
    return { time: time as Time, type, price };
}

describe('Exit Strategy Merge', () => {
    it('returns entry signals unchanged when no exit signals are provided', () => {
        const entries = [sig(1, 'buy'), sig(3, 'sell')];
        const merged = mergeExitStrategySignals(entries, []);
        expect(merged).to.equal(entries);
        expect(merged).to.have.lengthOf(2);
        expect(merged.every((s) => s.exitOnly !== true)).to.equal(true);
    });

    it('tags all exit signals with exitOnly=true', () => {
        const entries = [sig(1, 'buy')];
        const exits = [sig(2, 'sell'), sig(4, 'buy')];
        const merged = mergeExitStrategySignals(entries, exits);
        const taggedExits = merged.filter((s) => s.exitOnly === true);
        expect(taggedExits).to.have.lengthOf(2);
    });

    it('does not mutate the input arrays or signals', () => {
        const entry = sig(1, 'buy');
        const exitSig = sig(2, 'sell');
        const entries = [entry];
        const exits = [exitSig];
        mergeExitStrategySignals(entries, exits);
        expect(entry.exitOnly).to.equal(undefined);
        expect(exitSig.exitOnly).to.equal(undefined);
        expect(entries).to.have.lengthOf(1);
        expect(exits).to.have.lengthOf(1);
    });

    it('sorts the merged stream by signal time', () => {
        const entries = [sig(5, 'buy'), sig(1, 'sell')];
        const exits = [sig(3, 'buy'), sig(7, 'sell')];
        const merged = mergeExitStrategySignals(entries, exits);
        const times = merged.map((s) => s.time as unknown as number);
        expect(times).to.deep.equal([1, 3, 5, 7]);
    });

    it('preserves entry-before-exit order for same-bar ties', () => {
        const entries = [sig(2, 'buy')];
        const exits = [sig(2, 'sell'), sig(2, 'buy')];
        const merged = mergeExitStrategySignals(entries, exits);
        // All at time=2; entry (buy, exitOnly undefined) should come before exit-tagged signals
        expect(merged).to.have.lengthOf(3);
        expect(merged[0].exitOnly).to.not.equal(true);
        expect(merged[1].exitOnly).to.equal(true);
        expect(merged[2].exitOnly).to.equal(true);
    });
});

describe('Exit Strategy Merge ordering and immutability baselines (event-sweep plan, phase 1)', () => {
    it('keeps entry signals by reference in the merged output', () => {
        const entry = sig(3, 'buy');
        const merged = mergeExitStrategySignals([sig(1, 'sell'), entry], [sig(2, 'sell')]);
        const entryInOutput = merged.find((s) => s.exitOnly !== true && s.time === 3);
        expect(entryInOutput).to.equal(entry);
    });

    it('keeps all entries by reference even when the merge reorders them', () => {
        const entries = [sig(5, 'buy'), sig(1, 'buy'), sig(9, 'sell')];
        const merged = mergeExitStrategySignals(entries, [sig(7, 'sell')]);
        for (const entry of entries) {
            expect(merged.includes(entry)).to.equal(true);
        }
    });

    it('handles duplicate times inside and across inputs (entries first, input order kept)', () => {
        const firstEntry = sig(2, 'buy', 1);
        const secondEntry = sig(2, 'sell', 2);
        const firstExit = sig(2, 'sell', 3);
        const secondExit = sig(2, 'buy', 4);
        const merged = mergeExitStrategySignals([firstEntry, secondEntry], [firstExit, secondExit]);
        expect(merged).to.have.lengthOf(4);
        expect(merged[0]).to.equal(firstEntry);
        expect(merged[1]).to.equal(secondEntry);
        expect(merged[2]?.exitOnly).to.equal(true);
        expect(merged[3]?.exitOnly).to.equal(true);
        expect((merged[2] as Signal).price).to.equal(3);
        expect((merged[3] as Signal).price).to.equal(4);
    });

    it('orders mixed time representations through the existing normalization', () => {
        const secondBase = 1_700_000_000;
        const entries: Signal[] = [
            { time: (secondBase + 3600) * 1000 as unknown as Time, type: 'buy', price: 100 }, // milliseconds
            { time: { year: 2023, month: 11, day: 15 } as unknown as Time, type: 'sell', price: 100 }, // BusinessDay
        ];
        const exits: Signal[] = [
            { time: (secondBase + 60) as unknown as Time, type: 'sell', price: 100 }, // seconds
            { time: '2023-11-15T00:30:00.000Z' as unknown as Time, type: 'buy', price: 100 }, // ISO
        ];
        const merged = mergeExitStrategySignals(entries, exits);
        // The merged stream is nondecreasing under the engine's own
        // comparator — whatever each representation normalizes to.
        for (let i = 1; i < merged.length; i += 1) {
            expect(compareTime(merged[i - 1]!.time, merged[i]!.time)).to.be.at.most(0);
        }
        // Seconds and milliseconds normalize onto the same axis: the +60s
        // exit precedes the +3600s (ms-encoded) entry.
        const exitIndex = merged.findIndex((s) => s.exitOnly === true);
        expect(merged[exitIndex]?.time).to.equal((secondBase + 60) as unknown as Time);
        expect(timeToNumber(entries[0]!.time)).to.equal(secondBase + 3600);
    });
});
