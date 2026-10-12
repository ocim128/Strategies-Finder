import { expect } from 'chai';
import { describe, it } from 'node:test';
import {
    STREAM_CONFIG_MARKER,
    buildStreamId,
    parseConfigNameFromStreamId,
} from '../lib/alert-stream-id';

/**
 * Alert stream ids encode an optional config name after a `:cfg:` marker.
 * Build and parse must round-trip so an alert subscription can recover which
 * saved config it belongs to, and parsing must never throw on malformed input.
 */
describe('alert-stream-id: buildStreamId', () => {
    it('lowercases the symbol/interval/strategy base', () => {
        expect(buildStreamId('BTCUSDT', '1H', 'RSI')).to.equal('btcusdt:1h:rsi');
    });

    it('appends a URL-encoded config name when present', () => {
        expect(buildStreamId('BTCUSDT', '1h', 'rsi', 'My Config')).to.equal('btcusdt:1h:rsi:cfg:My%20Config');
    });

    it('omits the marker for blank or whitespace-only config names', () => {
        expect(buildStreamId('BTCUSDT', '1h', 'rsi', '')).to.equal('btcusdt:1h:rsi');
        expect(buildStreamId('BTCUSDT', '1h', 'rsi', '   ')).to.equal('btcusdt:1h:rsi');
        expect(buildStreamId('BTCUSDT', '1h', 'rsi', undefined)).to.equal('btcusdt:1h:rsi');
    });
});

describe('alert-stream-id: parseConfigNameFromStreamId', () => {
    it('returns null when there is no config marker', () => {
        expect(parseConfigNameFromStreamId('btcusdt:1h:rsi')).to.equal(null);
    });

    it('decodes the config name', () => {
        expect(parseConfigNameFromStreamId('btcusdt:1h:rsi:cfg:My%20Config')).to.equal('My Config');
    });

    it('returns null for an empty config segment', () => {
        expect(parseConfigNameFromStreamId('btcusdt:1h:rsi:cfg:')).to.equal(null);
    });

    it('falls back to the raw segment for malformed percent-encoding', () => {
        expect(parseConfigNameFromStreamId('btcusdt:1h:rsi:cfg:%E0%A4%A')).to.equal('%E0%A4%A');
    });

    it('round-trips through buildStreamId', () => {
        const streamId = buildStreamId('ETHUSDT', '4h', 'ema', 'Breakout / A');
        expect(parseConfigNameFromStreamId(streamId)).to.equal('Breakout / A');
    });

    it('exposes the marker it searches for', () => {
        expect(STREAM_CONFIG_MARKER).to.equal(':cfg:');
    });
});
