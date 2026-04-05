import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildOutcomeRow, parseArgs, resolveOutcomeSyncTargets } from "../scripts/polymarket-sync-outcomes";

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

    it("captures minute checkpoints from the first trade inside each minute bucket", () => {
        const event = {
            slug: "btc-up-1",
            endTs: 1_700_000_300,
            marketSlug: "btc-up-1",
            upTokenId: "yes-1",
            noTokenId: "no-1",
            settleUp: 1 as const,
        };
        const points = [
            { t: 1_700_000_000 - 1, p: 0.085 },
            { t: 1_700_000_000 + 12, p: 0.205 },
            { t: 1_700_000_060 + 7, p: 0.315 },
            { t: 1_700_000_120 + 5, p: 0.425 },
            { t: 1_700_000_180 + 9, p: 0.535 },
            { t: 1_700_000_240 + 11, p: 0.645 },
        ];

        const row = buildOutcomeRow(event, points, "10684");

        assert.ok(row);
        assert.equal(row.yes_open_price, 0.205);
        assert.equal(row.yes_entry_minute_1_price, 0.315);
        assert.equal(row.yes_entry_minute_2_price, 0.425);
        assert.equal(row.yes_entry_minute_3_price, 0.535);
        assert.equal(row.yes_entry_minute_4_price, 0.645);
    });
});
