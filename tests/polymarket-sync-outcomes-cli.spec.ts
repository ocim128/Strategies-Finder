import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildOutcomeRow, main, parseArgs, resolveOutcomeSyncTargets } from "../scripts/polymarket-sync-outcomes";

describe("polymarket sync outcomes CLI", () => {
    it("keeps the default single-target BTC sync", () => {
        const config = parseArgs([]);
        assert.ok(config);
        assert.equal(config.allSymbols, false);
        assert.equal(config.polymarketDns, "adguard-doh");

        const targets = resolveOutcomeSyncTargets(config);
        assert.deepEqual(targets, [{
            symbol: undefined,
            outcomeInterval: "5m",
            seriesId: "10684",
        }]);
    });

    it("allows system DNS override for Polymarket outcome sync", () => {
        const config = parseArgs(["--polymarket-dns", "system"]);
        assert.ok(config);
        assert.equal(config.polymarketDns, "system");
    });

    it("expands --all into every supported Polymarket native session target", () => {
        const config = parseArgs(["--all"]);
        assert.ok(config);
        assert.equal(config.allSymbols, true);

        const targets = resolveOutcomeSyncTargets(config);
        assert.deepEqual(targets, [
            { symbol: "BTCUSDT", outcomeInterval: "5m", seriesId: "10684" },
            { symbol: "ETHUSDT", outcomeInterval: "5m", seriesId: "10683" },
            { symbol: "SOLUSDT", outcomeInterval: "5m", seriesId: "10686" },
            { symbol: "XRPUSDT", outcomeInterval: "5m", seriesId: "10685" },
            { symbol: "BTCUSDT", outcomeInterval: "15m", seriesId: "10192" },
            { symbol: "ETHUSDT", outcomeInterval: "15m", seriesId: "10191" },
            { symbol: "SOLUSDT", outcomeInterval: "15m", seriesId: "10423" },
            { symbol: "XRPUSDT", outcomeInterval: "15m", seriesId: "10422" },
            { symbol: "BTCUSDT", outcomeInterval: "1h", seriesId: "10114" },
            { symbol: "ETHUSDT", outcomeInterval: "1h", seriesId: "10117" },
            { symbol: "SOLUSDT", outcomeInterval: "1h", seriesId: "10122" },
            { symbol: "XRPUSDT", outcomeInterval: "1h", seriesId: "10123" },
        ]);
    });

    it("keeps --all inside the requested native session when --interval is explicit", () => {
        const config = parseArgs(["--all", "--interval", "15m"]);
        assert.ok(config);

        const targets = resolveOutcomeSyncTargets(config);
        assert.deepEqual(targets, [
            { symbol: "BTCUSDT", outcomeInterval: "15m", seriesId: "10192" },
            { symbol: "ETHUSDT", outcomeInterval: "15m", seriesId: "10191" },
            { symbol: "SOLUSDT", outcomeInterval: "15m", seriesId: "10423" },
            { symbol: "XRPUSDT", outcomeInterval: "15m", seriesId: "10422" },
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

    it("continues Gamma pagination when the API returns fewer rows than the requested page size", async () => {
        const originalFetch = globalThis.fetch;
        const originalLog = console.log;
        const offsets: string[] = [];
        let storeCalls = 0;

        globalThis.fetch = (async (input: RequestInfo | URL) => {
            const url = new URL(String(input));
            if (url.hostname === "gamma-api.polymarket.com") {
                const offset = Number(url.searchParams.get("offset") ?? 0);
                offsets.push(String(offset));
                const rows = offset >= 200
                    ? []
                    : Array.from({ length: 100 }, (_, index) => {
                        const endTs = 1_700_000_300 + offset * 300 + index * 300;
                        return {
                            slug: `event-${offset}-${index}`,
                            endDate: new Date(endTs * 1000).toISOString(),
                            markets: [{
                                slug: `event-${offset}-${index}`,
                                outcomes: ["Up", "Down"],
                                outcomePrices: ["1", "0"],
                                clobTokenIds: [`yes-${offset}-${index}`, `no-${offset}-${index}`],
                            }],
                        };
                    });
                return new Response(JSON.stringify(rows), { status: 200 });
            }
            if (url.hostname === "clob.polymarket.com") {
                return new Response(JSON.stringify({ history: [{ t: 1_700_000_000, p: 0.5 }] }), { status: 200 });
            }
            if (url.pathname === "/api/sqlite/store-polymarket-outcomes") {
                storeCalls++;
                return new Response(JSON.stringify({ ok: true, upserted: 0 }), { status: 200 });
            }
            throw new Error(`Unexpected fetch ${url.toString()}`);
        }) as typeof fetch;
        console.log = () => {};

        try {
            await main([
                "--series-id", "10684",
                "--dry-run",
                "--max-events", "250",
                "--page-size", "500",
            ]);
        } finally {
            globalThis.fetch = originalFetch;
            console.log = originalLog;
        }

        assert.deepEqual(offsets, ["0", "100", "200"]);
        assert.equal(storeCalls, 0);
    });

    it("lets --all continue when a target has missing events but no usable history rows", async () => {
        const originalFetch = globalThis.fetch;
        const originalLog = console.log;
        const originalWarn = console.warn;
        const gammaSeriesIds: string[] = [];
        let storeCalls = 0;

        globalThis.fetch = (async (input: RequestInfo | URL) => {
            const url = new URL(String(input));
            if (url.hostname === "gamma-api.polymarket.com") {
                const seriesId = url.searchParams.get("series_id") ?? "unknown";
                gammaSeriesIds.push(seriesId);
                return new Response(JSON.stringify([{
                    slug: `event-${seriesId}`,
                    endDate: "2026-05-25T12:00:00.000Z",
                    markets: [{
                        slug: `event-${seriesId}`,
                        outcomes: ["Up", "Down"],
                        outcomePrices: ["1", "0"],
                        clobTokenIds: [`yes-${seriesId}`, `no-${seriesId}`],
                    }],
                }]), { status: 200 });
            }
            if (url.pathname === "/api/sqlite/load-polymarket-outcomes") {
                return new Response(JSON.stringify({ ok: true, rows: [] }), { status: 200 });
            }
            if (url.hostname === "clob.polymarket.com") {
                return new Response(JSON.stringify({ history: [] }), { status: 200 });
            }
            if (url.pathname === "/api/sqlite/store-polymarket-outcomes") {
                storeCalls++;
                return new Response(JSON.stringify({ ok: true, upserted: 0 }), { status: 200 });
            }
            throw new Error(`Unexpected fetch ${url.toString()}`);
        }) as typeof fetch;
        console.log = () => {};
        console.warn = () => {};

        try {
            await main(["--all", "--interval", "1h", "--max-events", "1", "--vite-origin", "http://local.test"]);
        } finally {
            globalThis.fetch = originalFetch;
            console.log = originalLog;
            console.warn = originalWarn;
        }

        assert.deepEqual(gammaSeriesIds, ["10114", "10117", "10122", "10123"]);
        assert.equal(storeCalls, 0);
    });
});
