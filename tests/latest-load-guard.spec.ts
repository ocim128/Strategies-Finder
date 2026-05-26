import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { LatestLoadGuard } from '../lib/data/latest-load-guard';

describe('LatestLoadGuard', () => {
    it('aborts and deactivates older load tickets when a newer load starts', () => {
        const guard = new LatestLoadGuard();

        const first = guard.start();
        assert.equal(first.signal.aborted, false);
        assert.equal(first.isActive(), true);

        const second = guard.start();
        assert.equal(first.signal.aborted, true);
        assert.equal(first.isActive(), false);
        assert.equal(second.signal.aborted, false);
        assert.equal(second.isActive(), true);

        first.finish();
        assert.equal(second.isActive(), true);

        second.finish();
        assert.equal(second.isActive(), false);
    });
});
