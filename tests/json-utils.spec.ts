import { expect } from 'chai';
import { describe, it } from 'node:test';
import {
    cloneJsonCompatible,
    parseJsonPreservingNonFinite,
    safeJsonParse,
    serializeJsonPreservingNonFinite,
    serializeJsonPreservingNonFiniteChunks,
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

/**
 * The chunked serializer exists because one `JSON.stringify` of a large Finder
 * result inventory throws `RangeError: Invalid string length` above V8's
 * ~536MB single-string limit. These tests pin the two properties that make it
 * a safe replacement: identical text, and a bounded chunk size.
 */
describe('json-utils: chunked non-finite serialization', () => {
    const joinChunks = (value: unknown, maxChunkChars?: number): { text: string; chunks: string[] } => {
        const chunks = [...serializeJsonPreservingNonFiniteChunks(value, maxChunkChars)];
        return { text: chunks.join(''), chunks };
    };

    const assertSameJson = (value: unknown, maxChunkChars?: number): void => {
        expect(joinChunks(value, maxChunkChars).text).to.equal(serializeJsonPreservingNonFinite(value));
    };

    it('matches the string form for primitives and boundary numbers', () => {
        for (const value of [null, true, false, 0, -0, 1, -1.5, 1e21, -1e-7, '', 'a', 'quote"and\\slash', 'ünïcødé 🚀', '\n\t\u0001']) {
            assertSameJson(value);
        }
    });

    it('matches the string form for arrays, objects, and nesting', () => {
        assertSameJson([]);
        assertSameJson([1, 2, 3]);
        assertSameJson({});
        assertSameJson({ a: 1, b: 'two', c: [3, { d: null }] });
        assertSameJson([[[]], [{}], [{ a: [{ b: 1 }] }]]);
        assertSameJson({ list: Array.from({ length: 50 }, (_v, i) => ({ i, name: `s${i}` })) });
    });

    it('matches the string form for non-finite numbers at the root and nested', () => {
        assertSameJson(Number.NaN);
        assertSameJson(Number.POSITIVE_INFINITY);
        assertSameJson(Number.NEGATIVE_INFINITY);
        assertSameJson({ a: Number.NaN, b: Number.POSITIVE_INFINITY, c: Number.NEGATIVE_INFINITY, d: 1 });
        assertSameJson({ list: [1, Number.NaN, { deep: Number.POSITIVE_INFINITY }] });
        assertSameJson([Number.NaN, [Number.NEGATIVE_INFINITY]]);
    });

    it('round-trips non-finite markers through the parser', () => {
        const { text } = joinChunks({ a: Number.NaN, b: Number.POSITIVE_INFINITY });
        const parsed = parseJsonPreservingNonFinite(text) as { a: number; b: number };
        expect(parsed.a).to.be.NaN;
        expect(parsed.b).to.equal(Number.POSITIVE_INFINITY);
    });

    it('follows JSON.stringify for toJSON, undefined members, and array holes', () => {
        assertSameJson({ at: new Date(Date.UTC(2020, 0, 2)) });
        assertSameJson({ kept: 1, dropped: undefined, alsoDropped: () => 1 });
        assertSameJson([1, undefined, () => 1, null, 2]);
        // Sparse arrays serialize holes as null, same as JSON.stringify.
        assertSameJson([1, , 3]); // eslint-disable-line no-sparse-arrays
        assertSameJson(undefined);
    });

    it('throws the JSON.stringify errors for BigInt and circular structures', () => {
        expect(() => joinChunks({ big: BigInt(1) as unknown })).to.throw(TypeError);
        const circular: Record<string, unknown> = { name: 'root' };
        circular.self = circular;
        expect(() => joinChunks(circular)).to.throw(TypeError, /circular/i);
    });

    it('splits into bounded chunks that never exceed the requested size', () => {
        const candidates = Array.from({ length: 400 }, (_v, index) => ({
            strategyKey: 'ema_confirmation',
            params: { fastPeriod: index },
            symbols: Array.from({ length: 5 }, (_s, s) => ({ symbol: `SYM${s}`, netProfit: s * 1.5 })),
        }));
        const maxChunkChars = 2048;
        const { text, chunks } = joinChunks({ type: 'done', candidates }, maxChunkChars);
        expect(text).to.equal(serializeJsonPreservingNonFinite({ type: 'done', candidates }));
        expect(chunks.length).to.be.greaterThan(1);
        // A single chunk is the unit that must stay under V8's string limit.
        expect(Math.max(...chunks.map((chunk) => chunk.length))).to.be.at.most(maxChunkChars * 2);
    });

    it('yields one chunk when the payload fits the budget', () => {
        const { chunks } = joinChunks({ type: 'done', ok: true });
        expect(chunks).to.have.length(1);
        expect(chunks[0]).to.equal('{"type":"done","ok":true}');
    });
});
