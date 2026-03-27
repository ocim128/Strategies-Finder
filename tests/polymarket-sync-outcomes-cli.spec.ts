import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { parseArgs, resolveOutcomeSyncTargets } from "../scripts/polymarket-sync-outcomes";

describe("polymarket sync outcomes CLI", () => {
    it("keeps the default single-target BTC sync", () => {
        const config = parseArgs([]);
        assert.ok(config);
        assert.equal(config.allSymbols, false);

        const targets = resolveOutcomeSyncTargets(config);
        assert.deepEqual(targets, [{
            symbol: undefined,
            seriesId: "10684",
        }]);
    });

    it("expands --all into every supported Polymarket 5m symbol", () => {
        const config = parseArgs(["--all"]);
        assert.ok(config);
        assert.equal(config.allSymbols, true);

        const targets = resolveOutcomeSyncTargets(config);
        assert.deepEqual(targets, [
            { symbol: "BTCUSDT", seriesId: "10684" },
            { symbol: "ETHUSDT", seriesId: "10683" },
            { symbol: "SOLUSDT", seriesId: "10686" },
            { symbol: "XRPUSDT", seriesId: "10685" },
        ]);
    });

    it("rejects combining --all with an explicit symbol", () => {
        assert.throws(
            () => parseArgs(["--all", "--symbol", "BTCUSDT"]),
            /--all cannot be combined with --symbol or --series-id\./
        );
    });
});
