import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
    getCsvPath,
    resolveAlpacaWindow,
    syncOneAlpacaSymbol,
} from "../lib/ibkr-data/ibkr-data-vite-plugin";
import type { AlpacaConfig } from "../lib/ibkr-data/alpaca-fetcher";
import type { IbkrIntervalMeta } from "../lib/ibkr-data/ibkr-data-stream-types";
import { HttpStatusError } from "../lib/vite-http-utils";

// Only these sentinel files are touched; the real catalog is never written.
const SYMBOL = "ZZXWINDOW";
const INTERVALS = ["30m", "1d"] as const;
const NOW = Date.UTC(2026, 0, 31);
const DAY_MS = 24 * 60 * 60 * 1000;
const OLD_CSV = "time,open,high,low,close,volume\n2026-01-01T00:00:00.000Z,100,100,100,100,500\n";
const CONFIG: AlpacaConfig = {
    apiKey: "PKTEST", apiSecret: "test", host: "https://data.alpaca.markets",
    feed: "iex", adjustment: "split",
};
type Catalog = Parameters<typeof syncOneAlpacaSymbol>[0];

function seed(interval: string, overrides: Partial<IbkrIntervalMeta> = {}): Catalog {
    const path = getCsvPath(SYMBOL, interval);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, OLD_CSV);
    return {
        updatedAt: "2026-01-01T00:00:00.000Z",
        entries: [{
            symbol: SYMBOL, markedSymbol: `IBKR:${SYMBOL}`,
            intervals: { [interval]: {
                source: "alpaca", firstTime: "2026-01-01T00:00:00.000Z",
                lastTime: "2026-01-01T00:00:00.000Z", bars: 1,
                lastSyncAt: "2026-01-01T00:00:00.000Z",
                alpacaFeed: "iex", alpacaAdjustment: "split",
                splitAdjustedThrough: "2026-01-01", ...overrides,
            } },
        }],
    };
}

function response(payload: unknown): Response {
    return new Response(JSON.stringify(payload), { status: 200 });
}
const NEW_BAR = { t: "2026-01-30T19:30:00Z", o: 200, h: 201, l: 199, c: 200, v: 1000 };

describe("Alpaca respects the selected request window", () => {
    const originalFetch = globalThis.fetch;
    const originalNow = Date.now;
    let urls: URL[];

    beforeEach(() => {
        Date.now = () => NOW;
        urls = [];
        globalThis.fetch = async (input) => {
            const url = new URL(String(input));
            urls.push(url);
            return response(url.pathname.includes("corporate-actions")
                ? { corporate_actions: {} }
                : { bars: [NEW_BAR] });
        };
    });
    afterEach(() => {
        globalThis.fetch = originalFetch;
        Date.now = originalNow;
        for (const interval of INTERVALS) {
            const path = getCsvPath(SYMBOL, interval);
            for (const suffix of ["", ".bak", ".tmp"]) rmSync(`${path}${suffix}`, { force: true });
        }
    });

    const barsUrls = () => urls.filter((url) => url.pathname.endsWith("/bars"));
    const assertFourDays = () => {
        assert.ok(barsUrls().length > 0);
        for (const url of barsUrls()) {
            assert.equal(url.searchParams.get("start"), "2026-01-27T00:00:00.000Z");
            assert.equal(url.searchParams.get("end"), "2026-01-31T00:00:00.000Z");
        }
    };

    for (const interval of INTERVALS) {
        it(`keeps repeated fresh ${interval} downloads at 4d and records adjustment provenance`, async () => {
            const catalog: Catalog = { updatedAt: "", entries: [] };
            await syncOneAlpacaSymbol(catalog, SYMBOL, interval, "4d", false, undefined, CONFIG);
            assert.equal(catalog.entries[0]!.intervals[interval]!.splitAdjustedThrough, "2026-01-31");
            await syncOneAlpacaSymbol(catalog, SYMBOL, interval, "4d", false, undefined, CONFIG);
            assert.equal(barsUrls().length, 2);
            assertFourDays();
        });

        for (const syncOnly of [false, true]) {
            it(`bounds ${interval} ${syncOnly ? "Sync" : "Download"} to 4d and preserves older saved rows`, async () => {
                const catalog = seed(interval);
                const result = await syncOneAlpacaSymbol(catalog, SYMBOL, interval, "4d", syncOnly, undefined, CONFIG);
                assertFourDays();
                assert.equal(result.fetchedBars, 1);
                assert.equal(result.bars, 2);
                assert.match(readFileSync(getCsvPath(SYMBOL, interval), "utf8"), /2026-01-01/);
            });
        }
    }

    it("keeps every paginated bars request within 4d", async () => {
        globalThis.fetch = async (input) => {
            const url = new URL(String(input));
            urls.push(url);
            return response({ bars: [NEW_BAR], next_page_token: urls.length === 1 ? "second" : null });
        };
        await syncOneAlpacaSymbol({ updatedAt: "", entries: [] }, SYMBOL, "30m", "4d", false, undefined, CONFIG);
        assert.equal(barsUrls().length, 2);
        assert.equal(barsUrls()[1]!.searchParams.get("page_token"), "second");
        assertFourDays();
    });

    for (const reason of ["missing provenance", "changed feed", "new split", "failed split lookup"]) {
        it(`requires an explicit max refresh for ${reason} without fetching full history or writing`, async () => {
            const catalog = seed("30m", reason === "missing provenance"
                ? { splitAdjustedThrough: undefined }
                : reason === "changed feed" ? { alpacaFeed: "sip" } : {});
            const before = JSON.stringify(catalog);
            if (reason === "new split" || reason === "failed split lookup") {
                globalThis.fetch = async (input) => {
                    urls.push(new URL(String(input)));
                    return reason === "failed split lookup"
                        ? new Response("Forbidden", { status: 403 })
                        : response({ corporate_actions: { forward_splits: [{
                            symbol: SYMBOL, ex_date: "2026-01-30", old_rate: 1, new_rate: 10,
                        }] } });
                };
            }
            await assert.rejects(
                syncOneAlpacaSymbol(catalog, SYMBOL, "30m", "4d", false, undefined, CONFIG),
                (error: unknown) => error instanceof HttpStatusError && error.status === 409
                    && /Data Period max/.test(error.message),
            );
            assert.equal(barsUrls().length, 0);
            assert.equal(readFileSync(getCsvPath(SYMBOL, "30m"), "utf8"), OLD_CSV);
            assert.equal(JSON.stringify(catalog), before);
            assert.equal(existsSync(`${getCsvPath(SYMBOL, "30m")}.bak`), false);
        });
    }

    it("repairs legacy Alpaca prices only when max is explicitly requested", async () => {
        const catalog = seed("30m", { splitAdjustedThrough: undefined });
        const result = await syncOneAlpacaSymbol(catalog, SYMBOL, "30m", "max", false, undefined, CONFIG);
        assert.equal(barsUrls()[0]!.searchParams.get("start"), "1970-01-01T00:00:00.000Z");
        assert.equal(urls.length, 1, "an explicit refresh does not need a split lookup");
        assert.equal(result.bars, 1, "old price-scale rows are replaced");
        assert.equal(catalog.entries[0]!.intervals["30m"]!.splitAdjustedThrough, "2026-01-31");
        assert.doesNotMatch(readFileSync(getCsvPath(SYMBOL, "30m"), "utf8"), /2026-01-01/);
    });

    it("leaves the old prices unchanged if an explicit full refresh hits the page ceiling", async () => {
        const catalog = seed("30m");
        const before = JSON.stringify(catalog);
        globalThis.fetch = async () => response({ bars: [NEW_BAR], next_page_token: "more" });
        await assert.rejects(
            syncOneAlpacaSymbol(catalog, SYMBOL, "30m", "max", false, undefined, CONFIG),
            /full-history refresh.*incomplete/,
        );
        assert.equal(readFileSync(getCsvPath(SYMBOL, "30m"), "utf8"), OLD_CSV);
        assert.equal(JSON.stringify(catalog), before);
    });

    for (const stage of ["before fetch", "during split lookup", "during bars fetch"]) {
        it(`cancels ${stage} without changing saved prices or catalog metadata`, async () => {
            const catalog = seed("30m");
            const before = JSON.stringify(catalog);
            const controller = new AbortController();
            if (stage === "before fetch") controller.abort();
            globalThis.fetch = async (input) => {
                const url = new URL(String(input));
                urls.push(url);
                const splitLookup = url.pathname.includes("corporate-actions");
                if ((stage === "during split lookup" && splitLookup) || !splitLookup) controller.abort();
                return response(splitLookup ? { corporate_actions: {} } : { bars: [NEW_BAR] });
            };
            const result = await syncOneAlpacaSymbol(catalog, SYMBOL, "30m", "4d", false, controller.signal, CONFIG);
            assert.equal(result.cancelled, true);
            assert.equal(result.fetchedBars, 0);
            assert.equal(readFileSync(getCsvPath(SYMBOL, "30m"), "utf8"), OLD_CSV);
            assert.equal(JSON.stringify(catalog), before);
            if (stage === "before fetch") assert.equal(urls.length, 0);
        });
    }

    it("clips a stale sync overlap to the bounded period while max retains incremental overlap", () => {
        const lastBar = NOW - 30 * DAY_MS;
        assert.equal(resolveAlpacaWindow("4d", NOW, lastBar).start, "2026-01-27T00:00:00.000Z");
        assert.equal(resolveAlpacaWindow("max", NOW, lastBar).start, new Date(lastBar).toISOString());
    });
});
