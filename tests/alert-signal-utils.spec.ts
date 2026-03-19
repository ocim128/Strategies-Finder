import { expect } from 'chai';
import { describe, it } from 'node:test';
import {
    getLatestActionableAlertSignal,
    getPersistedAlertSignalEntryPrice,
    PENDING_ENTRY_SIGNAL_REASON,
    resolveAlertSignalEntryPrice,
} from '../lib/alert-signal-utils';

describe('Alert signal utilities', () => {
    it('skips pending-entry records when selecting the latest actionable signal', () => {
        const latest = getLatestActionableAlertSignal([
            { id: 3, signal_reason: PENDING_ENTRY_SIGNAL_REASON },
            { id: 2, signal_reason: null },
            { id: 1, signal_reason: 'breakout' },
        ]);

        expect(latest).to.deep.equal({ id: 2, signal_reason: null });
    });

    it('returns null when every recent record is only a pending-entry placeholder', () => {
        const latest = getLatestActionableAlertSignal([
            { id: 2, signal_reason: PENDING_ENTRY_SIGNAL_REASON },
            { id: 1, signal_reason: PENDING_ENTRY_SIGNAL_REASON },
        ]);

        expect(latest).to.equal(null);
    });

    it('prefers a persisted entryPrice from payload_json when resolving alert entry price', () => {
        const signal = {
            direction: 'long' as const,
            signal_price: 100,
            payload_json: JSON.stringify({ entryPrice: 101.25 }),
        };

        expect(getPersistedAlertSignalEntryPrice(signal)).to.equal(101.25);
        expect(resolveAlertSignalEntryPrice(signal, { slippageBps: 100 })).to.equal(101.25);
    });

    it('falls back to slippage-adjusted signal_price when payload_json has no persisted entryPrice', () => {
        const signal = {
            direction: 'short' as const,
            signal_price: 100,
            payload_json: JSON.stringify({}),
        };

        expect(getPersistedAlertSignalEntryPrice(signal)).to.equal(null);
        expect(resolveAlertSignalEntryPrice(signal, { slippageBps: 100 })).to.equal(99);
    });
});
