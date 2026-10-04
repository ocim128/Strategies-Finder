import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PointBoundedParsedCache } from '../lib/data/point-bounded-parsed-cache';

const value = (points: number) => ({ columns: { time: new Float64Array(points) } });
type Entry = ReturnType<typeof value>;

describe('parsed column cache budgets', () => {
    it('evicts the oldest columns by points and preserves touched entries', () => {
        const cache = new PointBoundedParsedCache<Entry>(5, 3);
        cache.set('A', value(2));
        cache.set('B', value(2));
        const a = cache.get('A')!;
        cache.delete('A');
        cache.set('A', a);
        cache.set('C', value(2));
        assert.deepEqual([...cache.keys()], ['A', 'C']);
        assert.equal(cache.points, 4);
        assert.equal(cache.evictions, 1);
    });

    it('enforces the entry cap even for tiny series', () => {
        const cache = new PointBoundedParsedCache<Entry>(100, 2);
        for (const key of ['A', 'B', 'C']) cache.set(key, value(1));
        assert.deepEqual([...cache.keys()], ['B', 'C']);
        assert.equal(cache.points, 2);
        assert.equal(cache.evictions, 1);
    });

    it('accounts for replacements, explicit deletion, oversized entries, and clear', () => {
        const cache = new PointBoundedParsedCache<Entry>(5);
        cache.set('A', value(2));
        cache.set('B', value(2));
        cache.set('A', value(1));
        assert.equal(cache.points, 3);
        cache.delete('B');
        assert.equal(cache.points, 1);
        assert.equal(cache.delete('missing'), false);
        cache.set('huge', value(6));
        assert.equal(cache.size, 0);
        assert.equal(cache.points, 0);
        cache.set('C', value(2));
        cache.clear();
        assert.equal(cache.points, 0);
        assert.equal(cache.evictions, 0);
    });
});
