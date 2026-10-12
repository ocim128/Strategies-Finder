import { expect } from 'chai';
import { describe, it } from 'node:test';
import {
    cloneJsonCompatible,
    parseJsonPreservingNonFinite,
    safeJsonParse,
    serializeJsonPreservingNonFinite,
    stableNormalize,
    stableStringify,
} from '../lib/json-utils';

/**
 * These helpers back settings persistence and saved-config identity. The
 * non-finite round-trip and the key-order-stable stringify are the two
 * behaviors the rest of the app silently depends on, so both are pinned.
 */

describe('json-utils: safeJsonParse', () => {
    it('parses valid JSON', () => {
        expect(safeJsonParse('{"a":1}', {})).to.deep.equal({ a: 1 });
        expect(safeJsonParse('[1,2]', [])).to.deep.equal([1, 2]);
    });

    it('returns the same fallback reference on invalid JSON', () => {
        const fallback = { safe: true };
        expect(safeJsonParse('{not json', fallback)).to.equal(fallback);
        expect(safeJsonParse('', fallback)).to.equal(fallback);
    });
});

describe('json-utils: non-finite number round-trip', () => {
    it('serializes NaN, Infinity and -Infinity without throwing', () => {
        const raw = serializeJsonPreservingNonFinite({ a: Number.NaN, b: Number.POSITIVE_INFINITY, c: Number.NEGATIVE_INFINITY, d: 1 });
        expect(raw).to.contain('"__type":"non-finite-number"');
        expect(raw).to.contain('"value":"NaN"');
        expect(raw).to.contain('"value":"Infinity"');
        expect(raw).to.contain('"value":"-Infinity"');
    });

    it('restores the non-finite values on parse', () => {
        const raw = serializeJsonPreservingNonFinite({ a: Number.NaN, b: Number.POSITIVE_INFINITY, c: Number.NEGATIVE_INFINITY, d: 1 });
        const parsed = parseJsonPreservingNonFinite(raw) as Record<string, number>;
        expect(parsed.a).to.be.NaN;
        expect(parsed.b).to.equal(Number.POSITIVE_INFINITY);
        expect(parsed.c).to.equal(Number.NEGATIVE_INFINITY);
        expect(parsed.d).to.equal(1);
    });

    it('round-trips non-finite values nested inside arrays and objects', () => {
        const raw = serializeJsonPreservingNonFinite({ list: [1, Number.NaN, { deep: Number.POSITIVE_INFINITY }] });
        const parsed = parseJsonPreservingNonFinite(raw) as { list: [number, number, { deep: number }] };
        expect(parsed.list[0]).to.equal(1);
        expect(parsed.list[1]).to.be.NaN;
        expect(parsed.list[2].deep).to.equal(Number.POSITIVE_INFINITY);
    });

    it('handles a top-level non-finite number', () => {
        const parsed = parseJsonPreservingNonFinite(serializeJsonPreservingNonFinite(Number.NaN));
        expect(parsed).to.be.NaN;
    });

    it('leaves ordinary objects untouched on the reviver path', () => {
        const parsed = parseJsonPreservingNonFinite('{"__type":"other","value":"NaN"}');
        expect(parsed).to.deep.equal({ __type: 'other', value: 'NaN' });
    });
});

describe('json-utils: stable key ordering', () => {
    it('normalizes object key order recursively', () => {
        expect(stableNormalize({ b: 1, a: { d: 2, c: 3 } })).to.deep.equal({ a: { c: 3, d: 2 }, b: 1 });
    });

    it('produces identical strings regardless of key insertion order', () => {
        expect(stableStringify({ b: 1, a: 2 })).to.equal(stableStringify({ a: 2, b: 1 }));
    });

    it('keeps array order intact', () => {
        expect(stableStringify({ list: [3, 1, 2] })).to.equal('{"list":[3,1,2]}');
    });

    it('stringifies undefined rather than returning undefined', () => {
        expect(stableStringify(undefined)).to.equal('undefined');
    });
});

describe('json-utils: cloneJsonCompatible', () => {
    it('deep-clones without sharing references', () => {
        const source = { a: { b: [1, 2] } };
        const clone = cloneJsonCompatible(source);
        expect(clone).to.deep.equal(source);
        expect(clone).to.not.equal(source);
        expect(clone.a).to.not.equal(source.a);
    });
});
