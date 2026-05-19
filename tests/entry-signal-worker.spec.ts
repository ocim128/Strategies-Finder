import { expect } from 'chai';
import { describe, it } from 'node:test';
import worker, { buildLatestActionableEntrySignalQuery } from '../workers/entry-signal-worker';

describe('Entry signal worker queries', () => {
    it('filters pending-entry placeholders out of latest-entry lookups', () => {
        const query = buildLatestActionableEntrySignalQuery('payload_json');

        expect(query).to.equal(
            "SELECT payload_json FROM entry_signals WHERE channel_key = ? AND COALESCE(signal_reason, '') != ? ORDER BY signal_time DESC, id DESC LIMIT 1"
        );
    });

    it('keeps health public but protects private endpoints when WORKER_API_TOKEN is set', async () => {
        const env = { WORKER_API_TOKEN: 'secret' } as never;

        const health = await worker.fetch(new Request('https://worker.test/health'), env);
        expect(health.status).to.equal(200);

        const unauthorized = await worker.fetch(new Request('https://worker.test/api/subscriptions'), env);
        expect(unauthorized.status).to.equal(401);

        const authorized = await worker.fetch(new Request('https://worker.test/api/subscriptions', {
            headers: { authorization: 'Bearer secret' },
        }), env);
        expect(authorized.status).to.equal(500);
    });
});
