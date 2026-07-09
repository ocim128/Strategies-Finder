/**
 * Tests for the synthetic pair disk cache.
 *
 * Verifies the fingerprint contract for both leg kinds (file-backed IBKR legs
 * via seed CSV mtime; Binance legs via SQLite series_meta), the version
 * invalidation behavior, and the round-trip write→read that the batch
 * loader's disk-cache hook relies on.
 *
 * The Binance path uses a test seam (`__setSeriesMetaFetcherForTests`) so the
 * tests don't need the dev server running. File-backed legs still hit the
 * real filesystem under `price-data/ibkr/csv/30m/` so seed mtime sensitivity
 * is tested against actual `statSync`.
 */

import * as assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { afterEach, beforeEach, test } from "node:test";
import { dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import type { OHLCVData } from "../lib/types/strategies";
import type { SyntheticPairDiskCacheArgs } from "../lib/batch-backtest/batch-dataset-loader-core";
import {
    SYNTHETIC_PAIR_CACHE_VERSION,
    __cacheFilePathForTests,
    __clearSyntheticPairDiskCacheForTests,
    __setSeriesMetaFetcherForTests,
    __setSyntheticPairCacheDirForTests,
    computeSeedFingerprint,
    loadCachedSyntheticPair,
    storeSyntheticPair,
} from "../lib/batch-backtest/synthetic-pair-disk-cache";

const BULLET = "\u2022"; // IBKR marker
const BASE_SYMBOL = `AAPL${BULLET}`;
const QUOTE_SYMBOL = `MSFT${BULLET}`;
const SOURCE_INTERVAL = "30m";
const SEED_DIR = resolve(process.cwd(), "price-data", "ibkr", "csv", SOURCE_INTERVAL);
let cacheDir = "";

function seedPath(bare: string): string {
    return resolve(SEED_DIR, `${bare}.csv`);
}

function writeSeed(bare: string, contents: string): void {
    mkdirSync(dirname(seedPath(bare)), { recursive: true });
    writeFileSync(seedPath(bare), contents, "utf8");
}

function makeArgs(overrides: Partial<SyntheticPairDiskCacheArgs> = {}): SyntheticPairDiskCacheArgs {
    return {
        pairKey: `AAPL${BULLET}+MSFT${BULLET}|AAPL${BULLET}|MSFT${BULLET}|4h|30m|100000|synthetic`,
        syntheticSymbol: `AAPL${BULLET}+MSFT${BULLET}`,
        baseSymbol: BASE_SYMBOL,
        quoteSymbol: QUOTE_SYMBOL,
        interval: "4h",
        sourceInterval: SOURCE_INTERVAL,
        sourceBars: 100000,
        ...overrides,
    };
}

function makeCryptoArgs(): SyntheticPairDiskCacheArgs {
    return makeArgs({
        pairKey: `BTCUSDT+PAXGUSDT|BTCUSDT|PAXGUSDT|1h|1h|50000|synthetic`,
        syntheticSymbol: "BTCUSDT+PAXGUSDT",
        baseSymbol: "BTCUSDT",
        quoteSymbol: "PAXGUSDT",
        interval: "1h",
        sourceInterval: "1h",
        sourceBars: 50000,
    });
}

function makeMixedArgs(): SyntheticPairDiskCacheArgs {
    // AAPL leg resolves at 30m (IBKR seed interval that exists on disk);
    // BTCUSDT leg uses the same 30m source interval for alignment. Real
    // mixed pairs would pick a common source interval the same way
    // `pickSourceInterval` does in production.
    return makeArgs({
        pairKey: `AAPL${BULLET}+BTCUSDT|AAPL${BULLET}|BTCUSDT|1h|30m|50000|synthetic`,
        syntheticSymbol: `AAPL${BULLET}+BTCUSDT`,
        baseSymbol: BASE_SYMBOL,
        quoteSymbol: "BTCUSDT",
        interval: "1h",
        sourceInterval: SOURCE_INTERVAL,
        sourceBars: 50000,
    });
}

function makeBars(n: number): OHLCVData[] {
    const bars: OHLCVData[] = [];
    for (let i = 0; i < n; i += 1) {
        bars.push({
            time: 1700000000 + i * 1800 as OHLCVData["time"],
            open: 100 + i,
            high: 101 + i,
            low: 99 + i,
            close: 100.5 + i,
            volume: 1000 + i,
        });
    }
    return bars;
}

// Save original seed contents so tests don't clobber real data accidentally.
const originalSeeds = new Map<string, string>();

beforeEach(() => {
    cacheDir = mkdtempSync(resolve(tmpdir(), "sf-synthetic-cache-test-"));
    __setSyntheticPairCacheDirForTests(cacheDir);
    __clearSyntheticPairDiskCacheForTests();
    __setSeriesMetaFetcherForTests(null);
    for (const bare of ["AAPL", "MSFT"]) {
        if (existsSync(seedPath(bare))) {
            originalSeeds.set(bare, readFileSync(seedPath(bare), "utf8"));
        }
        writeSeed(bare, `test-seed-${bare}\n`);
    }
});

afterEach(() => {
    __clearSyntheticPairDiskCacheForTests();
    __setSyntheticPairCacheDirForTests(null);
    if (cacheDir) {
        rmSync(cacheDir, { recursive: true, force: true });
        cacheDir = "";
    }
    __setSeriesMetaFetcherForTests(null);
    for (const bare of ["AAPL", "MSFT"]) {
        const original = originalSeeds.get(bare);
        if (original !== undefined) {
            writeFileSync(seedPath(bare), original, "utf8");
        }
        // If there was no original seed, leave the test artifact — it's under
        // price-data/ which is gitignored and won't pollute the repo.
    }
    originalSeeds.clear();
});

// --------------------------------------------------------------------------
// File-backed (IBKR / stock-market) legs
// --------------------------------------------------------------------------

test("file-backed fingerprint is a string with version + bare tickers", async () => {
    const fp = await computeSeedFingerprint(BASE_SYMBOL, QUOTE_SYMBOL, SOURCE_INTERVAL);
    assert.equal(typeof fp, "string");
    assert.ok(fp!.includes(`v${SYNTHETIC_PAIR_CACHE_VERSION}`));
    assert.ok(fp!.includes("file:AAPL"));
    assert.ok(fp!.includes("file:MSFT"));
    assert.ok(fp!.includes(SOURCE_INTERVAL));
});

test("file-backed fingerprint changes when seed mtime changes", async () => {
    const before = await computeSeedFingerprint(BASE_SYMBOL, QUOTE_SYMBOL, SOURCE_INTERVAL);
    const targetTime = (Date.now() / 1000) + 60;
    utimesSync(seedPath("AAPL"), targetTime, targetTime);
    const after = await computeSeedFingerprint(BASE_SYMBOL, QUOTE_SYMBOL, SOURCE_INTERVAL);
    assert.notEqual(before, after, "fingerprint must change when seed mtime changes");
});

test("file-backed fingerprint returns null when the seed CSV does not exist", async () => {
    const result = await computeSeedFingerprint(`NONEXISTENT${BULLET}`, QUOTE_SYMBOL, SOURCE_INTERVAL);
    assert.equal(result, null);
});

test("file-backed round-trip: store then load returns the same bars", async () => {
    const args = makeArgs();
    const original = makeBars(5);
    assert.equal(await storeSyntheticPair(args, original), true);

    const loaded = await loadCachedSyntheticPair(args);
    assert.ok(loaded !== null, "expected a cache hit after store");
    assert.equal(loaded!.bars.length, original.length);
    assert.deepEqual(
        loaded!.bars.map((b) => b.open),
        original.map((b) => b.open),
    );
    assert.deepEqual(
        loaded!.bars.map((b) => Number(b.time)),
        original.map((b) => Number(b.time)),
    );
});

// --------------------------------------------------------------------------
// Binance (crypto) legs
// --------------------------------------------------------------------------

test("binance fingerprint uses series_meta.lastTime and barsCount", async () => {
    __setSeriesMetaFetcherForTests(async (_symbol, _interval) => ({
        ok: true,
        lastTime: 1782914400,
        barsCount: 65003,
    }));
    const fp = await computeSeedFingerprint("BTCUSDT", "PAXGUSDT", "1h");
    assert.equal(typeof fp, "string");
    assert.ok(fp!.includes("binance:BTCUSDT:1h:1782914400:65003"));
    assert.ok(fp!.includes("binance:PAXGUSDT:1h:1782914400:65003"));
});

test("binance fingerprint returns null when series_meta is cold (no rows)", async () => {
    __setSeriesMetaFetcherForTests(async () => ({ ok: true, lastTime: null, barsCount: null }));
    const fp = await computeSeedFingerprint("BTCUSDT", "PAXGUSDT", "1h");
    assert.equal(fp, null);
});

test("binance fingerprint returns null when fetcher errors (network / DB down)", async () => {
    __setSeriesMetaFetcherForTests(async () => null);
    const fp = await computeSeedFingerprint("BTCUSDT", "PAXGUSDT", "1h");
    assert.equal(fp, null);
});

test("binance fingerprint changes when lastTime moves forward", async () => {
    let lastTime = 1782914400;
    __setSeriesMetaFetcherForTests(async () => ({ ok: true, lastTime, barsCount: 65003 }));
    const before = await computeSeedFingerprint("BTCUSDT", "PAXGUSDT", "1h");
    lastTime = 1782918000; // a new bar arrived
    const after = await computeSeedFingerprint("BTCUSDT", "PAXGUSDT", "1h");
    assert.notEqual(before, after, "fingerprint must change when lastTime moves");
});

test("binance round-trip: store then load returns the same bars", async () => {
    __setSeriesMetaFetcherForTests(async () => ({ ok: true, lastTime: 1782914400, barsCount: 65003 }));
    const args = makeCryptoArgs();
    const original = makeBars(3);
    assert.equal(await storeSyntheticPair(args, original), true);
    const loaded = await loadCachedSyntheticPair(args);
    assert.ok(loaded !== null);
    assert.equal(loaded!.bars.length, original.length);
});

test("binance cache hit invalidates when series_meta.lastTime changes between store and load", async () => {
    let lastTime = 1782914400;
    __setSeriesMetaFetcherForTests(async () => ({ ok: true, lastTime, barsCount: 65003 }));
    const args = makeCryptoArgs();
    assert.equal(await storeSyntheticPair(args, makeBars(3)), true);

    lastTime = 1782918000; // upstream advanced
    const loaded = await loadCachedSyntheticPair(args);
    assert.equal(loaded, null, "stale fingerprint must invalidate");
});

// --------------------------------------------------------------------------
// Mixed (one file-backed + one Binance) legs
// --------------------------------------------------------------------------

test("mixed pair fingerprint combines file: and binance: segments", async () => {
    __setSeriesMetaFetcherForTests(async (_symbol, _interval) => ({ ok: true, lastTime: 1782914400, barsCount: 65003 }));
    const fp = await computeSeedFingerprint(BASE_SYMBOL, "BTCUSDT", SOURCE_INTERVAL);
    assert.equal(typeof fp, "string");
    assert.ok(fp!.includes(`file:AAPL:${SOURCE_INTERVAL}:`));
    assert.ok(fp!.includes(`binance:BTCUSDT:${SOURCE_INTERVAL}:1782914400:65003`));
});

test("mixed pair round-trip works", async () => {
    __setSeriesMetaFetcherForTests(async () => ({ ok: true, lastTime: 1782914400, barsCount: 65003 }));
    const args = makeMixedArgs();
    assert.equal(await storeSyntheticPair(args, makeBars(2)), true);
    const loaded = await loadCachedSyntheticPair(args);
    assert.ok(loaded !== null);
    assert.equal(loaded!.bars.length, 2);
});

// --------------------------------------------------------------------------
// Cross-cutting invalidation
// --------------------------------------------------------------------------

test("version mismatch causes a cache miss", async () => {
    const args = makeArgs();
    assert.equal(await storeSyntheticPair(args, makeBars(3)), true);

    // Corrupt the file by flipping the version after write.
    const filePath = __cacheFilePathForTests(args);
    const raw = readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    parsed.version = SYNTHETIC_PAIR_CACHE_VERSION + 999;
    writeFileSync(filePath, JSON.stringify(parsed), "utf8");

    const loaded = await loadCachedSyntheticPair(args);
    assert.equal(loaded, null, "version mismatch must invalidate");
});

test("malformed JSON in cache file causes a cache miss (no throw)", async () => {
    const args = makeArgs();
    const filePath = __cacheFilePathForTests(args);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, "{not valid json", "utf8");

    const loaded = await loadCachedSyntheticPair(args);
    assert.equal(loaded, null);
});

test("load returns null when no cache file exists", async () => {
    const loaded = await loadCachedSyntheticPair(makeArgs());
    assert.equal(loaded, null);
});

test("storeSyntheticPair on crypto legs with cold series_meta is a no-op (no file written)", async () => {
    __setSeriesMetaFetcherForTests(async () => ({ ok: true, lastTime: null, barsCount: null }));
    const args = makeCryptoArgs();
    assert.equal(await storeSyntheticPair(args, makeBars(3)), false);
    assert.equal(existsSync(__cacheFilePathForTests(args)), false);
});

test("cache file path encodes the pair key without pipe characters", () => {
    const args = makeArgs();
    const filePath = __cacheFilePathForTests(args);
    assert.ok(filePath.endsWith(".json"));
    assert.ok(!filePath.includes("|"), "pipe must be replaced for shell-safety");
    assert.ok(filePath.includes(cacheDir), `file should live under ${cacheDir}`);
});
