import { expect } from 'chai';
import { describe, it } from 'node:test';
import { buildLatestActionableEntrySignalQuery } from '../workers/entry-signal-worker';

describe('Entry signal worker queries', () => {
    it('filters pending-entry placeholders out of latest-entry lookups', () => {
        const query = buildLatestActionableEntrySignalQuery('payload_json');

        expect(query).to.equal(
            "SELECT payload_json FROM entry_signals WHERE channel_key = ? AND COALESCE(signal_reason, '') != ? ORDER BY signal_time DESC, id DESC LIMIT 1"
        );
    });
});
