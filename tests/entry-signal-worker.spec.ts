import { expect } from 'chai';
import { describe, it } from 'node:test';
import worker, {
    buildLatestActionableEntrySignalQuery,
    decideCommitteeAlert,
} from '../workers/entry-signal-worker';

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

describe('Signal Committee batched state endpoint', () => {
    it('gates POST /api/subscriptions/states behind the worker token', async () => {
        const env = { WORKER_API_TOKEN: 'secret' } as never;
        const unauthorized = await worker.fetch(
            new Request('https://worker.test/api/subscriptions/states', {
                method: 'POST',
                body: JSON.stringify({ streamIds: ['s1'] }),
            }),
            env
        );
        expect(unauthorized.status).to.equal(401);
    });

    it('returns 500 when SIGNALS_DB binding is missing (no crash)', async () => {
        const res = await worker.fetch(
            new Request('https://worker.test/api/subscriptions/states', {
                method: 'POST',
                body: JSON.stringify({ streamIds: ['s1'] }),
            }),
            {} as never
        );
        expect(res.status).to.equal(500);
        const body = await res.json() as { ok: boolean; error: string };
        expect(body.ok).to.equal(false);
        expect(body.error).to.contain('SIGNALS_DB');
    });

    it('rejects requests whose streamIds is not an array', async () => {
        const res = await worker.fetch(
            new Request('https://worker.test/api/subscriptions/states', {
                method: 'POST',
                body: JSON.stringify({ streamIds: 'not-an-array' }),
            }),
            {} as never
        );
        expect(res.status).to.equal(400);
    });

    it('returns an empty states list for an empty streamIds array', async () => {
        const res = await worker.fetch(
            new Request('https://worker.test/api/subscriptions/states', {
                method: 'POST',
                body: JSON.stringify({ streamIds: [] }),
            }),
            {} as never
        );
        expect(res.status).to.equal(200);
        const body = await res.json() as { ok: boolean; states: unknown[] };
        expect(body.ok).to.equal(true);
        expect(body.states).to.deep.equal([]);
    });
});

describe('Committee aggregate-score alert rule decision', () => {
    const baseRule = {
        enabled: true,
        longThreshold: 2,
        shortThreshold: -2,
        lastFiredScoreSign: 0,
    };

    it('fires long when score >= longThreshold and last sign was not positive', () => {
        const r = decideCommitteeAlert(3, baseRule);
        expect(r).to.deep.equal({ fire: true, newSign: 1 });
    });

    it('does not fire long when threshold is not met', () => {
        expect(decideCommitteeAlert(1, baseRule)).to.deep.equal({ fire: false });
    });

    it('does not fire when score is positive but below long threshold', () => {
        expect(decideCommitteeAlert(1, { ...baseRule, longThreshold: 2 })).to.deep.equal({ fire: false });
    });

    it('fires short when score <= shortThreshold and last sign was not negative', () => {
        const r = decideCommitteeAlert(-3, baseRule);
        expect(r).to.deep.equal({ fire: true, newSign: -1 });
    });

    it('hysteresis: does not refire long while score stays positive across ticks', () => {
        // First fire: last sign 0 -> score 3 -> fire, new sign +1
        const first = decideCommitteeAlert(3, baseRule);
        expect(first).to.deep.equal({ fire: true, newSign: 1 });
        // Next tick: last sign now +1, score still 3 -> no refire
        const second = decideCommitteeAlert(3, { ...baseRule, lastFiredScoreSign: 1 });
        expect(second).to.deep.equal({ fire: false });
        // Even if score climbs further while sign unchanged -> still no refire
        const third = decideCommitteeAlert(5, { ...baseRule, lastFiredScoreSign: 1 });
        expect(third).to.deep.equal({ fire: false });
    });

    it('hysteresis: refires only after sign crosses back through zero', () => {
        // Was long (+1), now score goes strongly short (-4) -> fire short
        const r = decideCommitteeAlert(-4, { ...baseRule, lastFiredScoreSign: 1 });
        expect(r).to.deep.equal({ fire: true, newSign: -1 });
    });

    it('never fires when disabled', () => {
        expect(decideCommitteeAlert(10, { ...baseRule, enabled: false })).to.deep.equal({ fire: false });
        expect(decideCommitteeAlert(-10, { ...baseRule, enabled: false })).to.deep.equal({ fire: false });
    });

    it('does not fire on zero score', () => {
        expect(decideCommitteeAlert(0, baseRule)).to.deep.equal({ fire: false });
    });
});

describe('Committee alert rules endpoints', () => {
    it('gates GET /api/committee-alert/rules behind the worker token', async () => {
        const env = { WORKER_API_TOKEN: 'secret' } as never;
        const res = await worker.fetch(new Request('https://worker.test/api/committee-alert/rules'), env);
        expect(res.status).to.equal(401);
    });

    it('returns 500 when SIGNALS_DB binding is missing (no crash)', async () => {
        const res = await worker.fetch(new Request('https://worker.test/api/committee-alert/rules'), {} as never);
        expect(res.status).to.equal(500);
    });

    it('gates POST /api/committee-alert/rules behind the worker token', async () => {
        const env = { WORKER_API_TOKEN: 'secret' } as never;
        const res = await worker.fetch(
            new Request('https://worker.test/api/committee-alert/rules', {
                method: 'POST',
                body: JSON.stringify({ committeeTag: 'default', enabled: true }),
            }),
            env
        );
        expect(res.status).to.equal(401);
    });
});
