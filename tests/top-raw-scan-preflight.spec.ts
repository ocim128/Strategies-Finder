import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ScanEndpointCoverage, hasScanEndpointHistory, scanSourceIntervals, scanPrimarySourceInterval, scanSyncReference } from "../lib/batch-backtest/top-raw-scan-preflight";

const history = (end: number) => Array.from({ length: 200 }, (_, i) => end - 199 + i);
describe("TOP_RAW preflight timestamp coverage", () => {
    it("tracks the synthetic loader's primary seed and target fallback", () => {
        assert.equal(scanPrimarySourceInterval("AAPL•", "4h"), "30m");
        assert.deepEqual(scanSourceIntervals("AAPL•", "4h"), ["30m", "4h"]);
        assert.deepEqual(scanSourceIntervals("AAPL•", "1d"), ["30m", "4h", "1d"]);
    });
    it("chooses the latest endpoint with 200 bars in every asset", () => {
        const coverage = new ScanEndpointCoverage();
        coverage.add([...history(300), 301, 302]); coverage.add(history(300));
        assert.deepEqual(coverage.select(), { asOf: 300, support: 2, complete: true });
    });
    it("falls back to the newest candle supported by the most assets when histories diverge", () => {
        const coverage = new ScanEndpointCoverage();
        coverage.add(history(300)); coverage.add(history(300)); coverage.add(history(900));
        assert.deepEqual(coverage.select(), { asOf: 300, support: 2, complete: false });
    });
    it("does not mistake a common early candle for sufficient history at E", () => {
        assert.equal(hasScanEndpointHistory(history(300), 299), false);
        assert.equal(hasScanEndpointHistory(history(300), 300), true);
        const coverage = new ScanEndpointCoverage();
        coverage.add(history(300)); coverage.add(history(299));
        assert.deepEqual(coverage.select(), { asOf: 300, support: 1, complete: false });
        assert.equal(new ScanEndpointCoverage().select(), null);
    });
    it("compares sync coverage at the prevalent phase of the latest day", () => {
        const day = 1700006400, regular = day + 16 * 3600, extended = day + 20 * 3600;
        assert.equal(scanSyncReference([regular, regular, regular, extended, day - 86400 + 20 * 3600], 14400), regular);
        assert.equal(scanSyncReference([regular, extended], 14400), extended);
        assert.equal(scanSyncReference([day, day - 86400], 86400), day);
        assert.equal(scanSyncReference([], 14400), null);
    });
});
