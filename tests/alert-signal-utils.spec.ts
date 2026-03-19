import { expect } from 'chai';
import { describe, it } from 'node:test';
import {
    getLatestActionableAlertSignal,
    PENDING_ENTRY_SIGNAL_REASON,
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
});
