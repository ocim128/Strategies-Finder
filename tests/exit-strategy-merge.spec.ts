import { expect } from 'chai';
import { describe, it } from 'node:test';
import { mergeExitStrategySignals } from '../lib/exit-strategy-merge';
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
