import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { expect } from "chai";
import { openSecondMarketDb } from "../lib/second-market/db";
import { syncGammaSnapshots } from "../lib/second-market/polymarket-gamma-sync";

let tempDirs: string[] = [];
const originalFetch = globalThis.fetch;

function makeDbPath(): string {
    const dir = mkdtempSync(join(tmpdir(), "second-market-gamma-"));
    tempDirs.push(dir);
    return join(dir, "second-market-data.sqlite");
}

function rawGammaEvent(id: string, endTs: number): Record<string, unknown> {
    return {
        slug: `btc-updown-5m-${id}`,
        endDate: new Date(endTs * 1000).toISOString(),
        markets: [{
            id,
            slug: `btc-updown-5m-${id}`,
            conditionId: `condition-${id}`,
            clobTokenIds: JSON.stringify([`yes-${id}`, `no-${id}`]),
            outcomes: JSON.stringify(["Up", "Down"]),
            outcomePrices: JSON.stringify(["0.55", "0.45"]),
            active: true,
            closed: false,
        }],
    };
}

afterEach(() => {
    globalThis.fetch = originalFetch;
    for (const dir of tempDirs) {
        rmSync(dir, { recursive: true, force: true });
    }
    tempDirs = [];
});

describe("second market Gamma sync", () => {
    it("stores active snapshots only while returning near-future events for CLOB subscriptions", async () => {
        const now = Math.floor(Date.now() / 1000);
        globalThis.fetch = (async () => new Response(JSON.stringify([
            rawGammaEvent("active", now + 120),
            rawGammaEvent("future", now + 420),
        ]), {
            status: 200,
            headers: { "content-type": "application/json" },
        })) as typeof fetch;

        const db = openSecondMarketDb(makeDbPath());
        try {
            const result = await syncGammaSnapshots(db, { symbol: "BTCUSDT", outcomeInterval: "5m" });
            const count = db.prepare("SELECT COUNT(*) AS count FROM polymarket_gamma_snapshots").get() as { count: number };
            const row = db.prepare("SELECT market_id, raw_json FROM polymarket_gamma_snapshots").get() as {
                market_id: string;
                raw_json: string | null;
            };

            expect(result.events).to.have.length(2);
            expect(count.count).to.equal(1);
            expect(row.market_id).to.equal("active");
            expect(row.raw_json).to.equal(null);
        } finally {
            db.close();
        }
    });
});
