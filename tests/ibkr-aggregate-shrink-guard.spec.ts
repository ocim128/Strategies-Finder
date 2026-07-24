/**
 * Aggregator shrink-guard tests (Layer 3 of the data-loss-safety fix).
 *
 * Locks the behavior added after a destructive aggregation run: a truncated
 * 30m source must NOT silently overwrite a much larger existing 4h
 * destination. The CLI now refuses such writes by default; `--force`
 * overrides; `--dry-run` still reports what would happen.
 *
 * The script module is imported for its exported `shouldRefuseShrink` helper
 * (the guard is pure logic over on-disk CSVs). Tests use sentinel symbols
 * at a sentinel interval so production data is never touched.
 */
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { shouldRefuseShrink } from "../scripts/ibkr-aggregate-csv";
import { getCsvPath } from "../lib/ibkr-data/ibkr-data-vite-plugin";
import type { OHLCVData } from "../lib/types/strategies";

const TEST_INTERVAL = "zzagg";
const TEST_DIR = resolve(process.cwd(), "price-data", "ibkr", "csv", TEST_INTERVAL);

function bar(epoch: number): OHLCVData {
    return { time: epoch as OHLCVData["time"], open: 1, high: 2, low: 0.5, close: 1.5, volume: 100 };
}

function seedDestination(symbol: string, count: number): void {
    const path = getCsvPath(symbol, TEST_INTERVAL);
    mkdirSync(resolve(path, ".."), { recursive: true });
    const rows = ["time,open,high,low,close,volume"];
    for (let i = 0; i < count; i += 1) {
        const epoch = 1_700_000_000 + i * 1800;
        rows.push(`${new Date(epoch * 1000).toISOString()},1,2,0.5,1.5,100`);
    }
    writeFileSync(path, `${rows.join("\n")}\n`);
}

describe("shouldRefuseShrink (aggregator Layer 3 shrink-guard)", () => {
    beforeEach(() => {
        rmSync(TEST_DIR, { recursive: true, force: true });
        mkdirSync(TEST_DIR, { recursive: true });
    });
    afterEach(() => {
        rmSync(TEST_DIR, { recursive: true, force: true });
    });

    it("refuses when aggregated output is materially smaller than existing destination", () => {
        // Existing destination: 10,000 bars. Aggregated output: 10 bars.
        // ratio = 0.001 < 0.5 threshold -> refuse.
        seedDestination("ZZS1", 10_000);
        const smallAggregated = [bar(1_700_000_000), bar(1_700_001_800)];
        const { refuse, existingCount } = shouldRefuseShrink("ZZS1", TEST_INTERVAL, smallAggregated);
        assert.equal(refuse, true);
        assert.equal(existingCount, 10_000);
    });

    it("does NOT refuse when destination is fresh (no existing file)", () => {
        // No seed — destination does not exist. A fresh write is always allowed.
        const aggregated = [bar(1_700_000_000), bar(1_700_001_800)];
        const { refuse, existingCount } = shouldRefuseShrink("ZZFRESH", TEST_INTERVAL, aggregated);
        assert.equal(refuse, false);
        assert.equal(existingCount, 0);
    });

    it("does NOT refuse when destination is below the minimum threshold (tiny existing)", () => {
        // Existing 50 bars (< SHRINK_GUARD_MIN_EXISTING=100). Even a much
        // smaller aggregated output is allowed — tiny destinations are not
        // worth guarding (likely a fresh or in-progress file).
        seedDestination("ZZTINY", 50);
        const { refuse } = shouldRefuseShrink("ZZTINY", TEST_INTERVAL, [bar(1)]);
        assert.equal(refuse, false);
    });

    it("does NOT refuse when aggregated is comparable in size to destination", () => {
        // Existing 10,000 bars. Aggregated 6,000 bars (ratio 0.6 > 0.5).
        // A modest shrink is normal (latest data trim); only a clear shrink
        // (ratio < 0.5) is refused.
        seedDestination("ZZOK", 10_000);
        const aggregated: OHLCVData[] = [];
        for (let i = 0; i < 6_000; i += 1) aggregated.push(bar(1_700_000_000 + i * 1800));
        const { refuse } = shouldRefuseShrink("ZZOK", TEST_INTERVAL, aggregated);
        assert.equal(refuse, false);
    });

    it("boundary: refuses at exactly 49% of existing (below the 50% ratio threshold)", () => {
        seedDestination("ZZB", 10_000);
        const aggregated: OHLCVData[] = [];
        for (let i = 0; i < 4_900; i += 1) aggregated.push(bar(1_700_000_000 + i * 1800)); // 49%
        const { refuse } = shouldRefuseShrink("ZZB", TEST_INTERVAL, aggregated);
        assert.equal(refuse, true);
    });

    it("is a pure read (never writes or destroys the destination)", () => {
        // The guard must be safe to call: it must not modify or delete the
        // existing destination file. This is what makes `--dry-run` + the
        // pre-write guard safe to compose.
        seedDestination("ZZPURE", 1_000);
        const before = readdirSync(TEST_DIR);
        shouldRefuseShrink("ZZPURE", TEST_INTERVAL, [bar(1)]);
        const after = readdirSync(TEST_DIR);
        assert.deepEqual(before, after);
        assert.ok(existsSync(getCsvPath("ZZPURE", TEST_INTERVAL)), "destination file intact");
    });
});
