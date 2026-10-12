import { expect } from 'chai';
import { describe, it } from 'node:test';
import {
    DEFAULT_BINANCE_FUTURES_API_BASES,
    DEFAULT_BINANCE_SPOT_API_BASES,
    parseBinanceApiBases,
    resolveBinanceApiBases,
} from '../lib/binance-api-bases';

/**
 * Binance base resolution: a configured comma list wins, otherwise the spot
 * or futures defaults apply. Parsing must trim, strip trailing slashes and drop
 * empties so a sloppy settings string cannot produce a malformed request URL.
 */

describe('binance-api-bases: parseBinanceApiBases', () => {
    it('splits, trims and strips trailing slashes', () => {
        expect(parseBinanceApiBases(' https://a.com/ , https://b.com/// ')).to.deep.equal([
            'https://a.com',
            'https://b.com',
        ]);
    });

    it('drops empty entries', () => {
        expect(parseBinanceApiBases('https://a.com,,  ,')).to.deep.equal(['https://a.com']);
    });

    it('returns an empty array for null, undefined or empty input', () => {
        expect(parseBinanceApiBases(null)).to.deep.equal([]);
        expect(parseBinanceApiBases(undefined)).to.deep.equal([]);
        expect(parseBinanceApiBases('')).to.deep.equal([]);
    });
});

describe('binance-api-bases: resolveBinanceApiBases', () => {
    it('falls back to the spot defaults', () => {
        expect(resolveBinanceApiBases('spot')).to.deep.equal([...DEFAULT_BINANCE_SPOT_API_BASES]);
    });

    it('falls back to the futures defaults', () => {
        expect(resolveBinanceApiBases('futures')).to.deep.equal([...DEFAULT_BINANCE_FUTURES_API_BASES]);
    });

    it('prefers a configured list over the defaults', () => {
        expect(resolveBinanceApiBases('spot', 'https://custom.example')).to.deep.equal(['https://custom.example']);
        expect(resolveBinanceApiBases('futures', 'https://custom.example')).to.deep.equal(['https://custom.example']);
    });

    it('ignores a blank configured list', () => {
        expect(resolveBinanceApiBases('futures', '   ')).to.deep.equal([...DEFAULT_BINANCE_FUTURES_API_BASES]);
    });

    it('returns a fresh array each call', () => {
        expect(resolveBinanceApiBases('futures')).to.not.equal(DEFAULT_BINANCE_FUTURES_API_BASES);
        expect(resolveBinanceApiBases('spot')).to.not.equal(DEFAULT_BINANCE_SPOT_API_BASES);
    });
});
