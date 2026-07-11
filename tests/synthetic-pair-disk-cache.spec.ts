/**
 * Tests for the synthetic pair disk cache.
 *
 * Verifies the fingerprint contract for both leg kinds (file-backed IBKR legs
 * via seed CSV mtime; Binance legs via SQLite series_meta), the version
 * invalidation behavior, and the round-trip write→read that the batch
 * loader's disk-cache hook relies on.
 *
 * The Binance path uses a test seam (`__setSeriesMetaFetcherForTests`) so the
 * tests don't need the dev server running. File-backed legs resolve seed CSVs
 * against a per-spec tempdir via `__setSeedDirForTests` so seed mtime
 * sensitivity is tested against real `statSync` without writing fixtures into
 * the warmed `price-data/ibkr/csv/30m/` production tree (audit Finding 3).
 */

import * as assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { afterEach, beforeEach, test } from "node:test";
import { dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { deserialize as v8Deserialize, serialize as v8Serialize } from "node:v8";
import type { OHLCVData } from "../lib/types/strategies";
import type { SyntheticPairDiskCacheArgs } from "../lib/batch-backtest/batch-dataset-loader-core";
import {
    SYNTHETIC_PAIR_CACHE_VERSION,
    __cacheFilePathForTests,
    __clearSyntheticPairDiskCacheForTests,
    __setSeedDirForTests,
    __setSeriesMetaFetcherForTests,
    __setSyntheticPairCacheDirForTests,
    computeSeedFingerprint,
    getSyntheticPairCacheSize,
    loadCachedSyntheticPair,
    LRU_TOUCH_THROTTLE_MS,
    MAX_CACHE_BYTES,
    MAX_CACHE_FILES,
    pruneOnStartup,
    pruneSyntheticPairDiskCache,
    storeSyntheticPair,
} from "../lib/batch-backtest/synthetic-pair-disk-cache";

const BULLET = "\u2022"; // IBKR marker
const BASE_SYMBOL = `AAPL${BULLET}`;
const QUOTE_SYMBOL = `MSFT${BULLET}`;
const SOURCE_INTERVAL = "30m";
// Per-spec tempdir root for file-backed seed CSVs. Previously this resolved
// against `process.cwd()/price-data/ibkr/csv/30m/`, which wrote test fixtures
// into the warmed production seed tree (audit Finding 3). The seed root is now
// injected via `__setSeedDirForTests` so the fingerprint `statSync` path also
// resolves here, and the whole tree is removed in `afterEach`.
let seedDir = "";
let cacheDir = "";

function seedPath(bare: string): string {
    return resolve(seedDir, SOURCE_INTERVAL, `${bare}.csv`);
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

beforeEach(() => {
    cacheDir = mkdtempSync(resolve(tmpdir(), "sf-synthetic-cache-test-"));
    seedDir = mkdtempSync(resolve(tmpdir(), "sf-synthetic-seed-test-"));
    __setSyntheticPairCacheDirForTests(cacheDir);
    __setSeedDirForTests(seedDir);
    __clearSyntheticPairDiskCacheForTests();
    __setSeriesMetaFetcherForTests(null);
    for (const bare of ["AAPL", "MSFT"]) {
        writeSeed(bare, `test-seed-${bare}\n`);
    }
});

afterEach(() => {
    __clearSyntheticPairDiskCacheForTests();
    __setSyntheticPairCacheDirForTests(null);
    __setSeedDirForTests(null);
    if (cacheDir) {
        rmSync(cacheDir, { recursive: true, force: true });
        cacheDir = "";
    }
    if (seedDir) {
        rmSync(seedDir, { recursive: true, force: true });
        seedDir = "";
    }
    __setSeriesMetaFetcherForTests(null);
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

test("binance fingerprint uses series_meta.lastTime, barsCount, and updatedAt", async () => {
    __setSeriesMetaFetcherForTests(async (_symbol, _interval) => ({
        ok: true,
        lastTime: 1782914400,
        barsCount: 65003,
        updatedAt: 1778000000,
    }));
    const fp = await computeSeedFingerprint("BTCUSDT", "PAXGUSDT", "1h");
    assert.equal(typeof fp, "string");
    assert.ok(fp!.includes("binance:BTCUSDT:1h:1782914400:65003:1778000000"));
    assert.ok(fp!.includes("binance:PAXGUSDT:1h:1782914400:65003:1778000000"));
});

test("binance fingerprint folds updatedAt=0 when series_meta omits it (cold cache / older endpoint)", async () => {
    // updatedAt intentionally absent — every field on SeriesMetaResponse is
    // optional, so the bare object is a valid response.
    __setSeriesMetaFetcherForTests(async () => ({
        ok: true,
        lastTime: 1782914400,
        barsCount: 65003,
    }));
    const fp = await computeSeedFingerprint("BTCUSDT", "PAXGUSDT", "1h");
    assert.equal(typeof fp, "string");
    assert.ok(fp!.includes("binance:BTCUSDT:1h:1782914400:65003:0"));
});

test("binance fingerprint changes when updatedAt moves but lastTime and barsCount stay fixed (Finding 2)", async () => {
    // Same row count, same last bar, but a historical bar was corrected via
    // /store-ohlcv (which bumps series_meta.updated_at). The old fingerprint
    // keyed only on lastTime+barsCount would NOT change here, serving stale
    // bars — updatedAt closes that gap.
    let updatedAt = 1778000000;
    __setSeriesMetaFetcherForTests(async () => ({
        ok: true,
        lastTime: 1782914400,
        barsCount: 65003,
        updatedAt,
    }));
    const before = await computeSeedFingerprint("BTCUSDT", "PAXGUSDT", "1h");
    updatedAt = 1778000100; // a repair bumped updated_at, nothing else moved
    const after = await computeSeedFingerprint("BTCUSDT", "PAXGUSDT", "1h");
    assert.notEqual(before, after, "fingerprint must change when updatedAt moves");
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
    assert.ok(fp!.includes(`binance:BTCUSDT:${SOURCE_INTERVAL}:1782914400:65003:0`));
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

    // Corrupt the v2 (.bin) file by flipping the version after write.
    const filePath = __cacheFilePathForTests(args);
    const parsed = v8Deserialize(readFileSync(filePath)) as { version: number };
    parsed.version = SYNTHETIC_PAIR_CACHE_VERSION + 999;
    writeFileSync(filePath, v8Serialize(parsed));

    const loaded = await loadCachedSyntheticPair(args);
    assert.equal(loaded, null, "version mismatch must invalidate");
});

test("malformed v2 cache file causes a cache miss (no throw)", async () => {
    const args = makeArgs();
    const filePath = __cacheFilePathForTests(args);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, Buffer.from([0xff, 0xfe, 0xfd, 0xfc, 0x00, 0x01, 0x02, 0x03]));

    const loaded = await loadCachedSyntheticPair(args);
    assert.equal(loaded, null);
});

test("legacy v1 JSON cache is still read and upgraded to v2 on next store", async () => {
    const args = makeArgs();
    const legacyPath = `${__cacheFilePathForTests(args).replace(/\.bin$/, "")}.json`;
    const legacyPayload = {
        version: SYNTHETIC_PAIR_CACHE_VERSION,
        fingerprint: await computeSeedFingerprint(args.baseSymbol, args.quoteSymbol, args.sourceInterval),
        generatedAt: new Date().toISOString(),
        sourceInterval: args.sourceInterval,
        bars: 2,
        data: makeBars(2).map((bar) => ({
            time: Number(bar.time),
            open: bar.open,
            high: bar.high,
            low: bar.low,
            close: bar.close,
            volume: bar.volume,
        })),
    };
    mkdirSync(dirname(legacyPath), { recursive: true });
    writeFileSync(legacyPath, JSON.stringify(legacyPayload), "utf8");

    // v1 read succeeds.
    const loaded = await loadCachedSyntheticPair(args);
    assert.ok(loaded !== null);
    assert.equal(loaded!.bars.length, 2);

    // Next store writes v2 (.bin) and removes the legacy .json.
    assert.equal(await storeSyntheticPair(args, makeBars(4)), true);
    assert.equal(existsSync(legacyPath), false, "legacy .json must be removed on upgrade write");
    assert.equal(existsSync(__cacheFilePathForTests(args)), true, "v2 .bin must exist after upgrade write");
    const reloaded = await loadCachedSyntheticPair(args);
    assert.ok(reloaded !== null);
    assert.equal(reloaded!.bars.length, 4);
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
    assert.ok(filePath.endsWith(".bin"), "v2 cache files use the .bin extension");
    assert.ok(!filePath.includes("|"), "pipe must be replaced for shell-safety");
    assert.ok(filePath.includes(cacheDir), `file should live under ${cacheDir}`);
});

// --------------------------------------------------------------------------
// Bounded-cache pruning (Finding 1)
// --------------------------------------------------------------------------

function seedCacheFiles(count: number): { paths: string[]; totalBytes: number } {
    const paths: string[] = [];
    let totalBytes = 0;
    for (let i = 0; i < count; i += 1) {
        const p = resolve(cacheDir, `seed-${i}.bin`);
        // Each file is ~12 bytes so byte-cap tests can use a tiny threshold.
        const buf = Buffer.alloc(12, i);
        writeFileSync(p, buf);
        paths.push(p);
        totalBytes += buf.length;
    }
    return { paths, totalBytes };
}

function touchFile(path: string, mtimeSecondsAgo: number): void {
    const atime = (Date.now() / 1000);
    const mtime = atime - mtimeSecondsAgo;
    utimesSync(path, atime, mtime);
}

test("pruneSyntheticPairDiskCache evicts oldest-mtime files first by file-count cap", () => {
    const { paths } = seedCacheFiles(5);
    // Make the order deterministic: index 0 is oldest, 4 is newest.
    paths.forEach((p, i) => touchFile(p, 100 - i));
    const before = getSyntheticPairCacheSize();
    assert.equal(before.files, 5);

    const result = pruneSyntheticPairDiskCache({ maxFiles: 3, maxBytes: MAX_CACHE_BYTES });
    assert.equal(result.files, 3, "should leave 3 files after prune");
    assert.equal(result.evictedFiles, 2, "should evict 2 oldest files");
    assert.equal(existsSync(paths[0]!), false, "oldest file evicted");
    assert.equal(existsSync(paths[1]!), false, "second-oldest file evicted");
    assert.equal(existsSync(paths[4]!), true, "newest file kept");
});

test("pruneSyntheticPairDiskCache evicts by byte cap when bytes exceed the limit", () => {
    const { totalBytes } = seedCacheFiles(10);
    // Cap to half the total bytes; oldest files must be evicted until under cap.
    const byteCap = Math.floor(totalBytes / 2);
    const result = pruneSyntheticPairDiskCache({ maxBytes: byteCap, maxFiles: MAX_CACHE_FILES });
    assert.ok(result.bytes <= byteCap, `bytes (${result.bytes}) must be under cap (${byteCap})`);
    assert.ok(result.evictedFiles > 0, "should evict some files to meet the byte cap");
    assert.equal(result.evictedBytes, totalBytes - result.bytes);
});

test("pruneSyntheticPairDiskCache is a no-op when under both caps", () => {
    seedCacheFiles(2);
    const result = pruneSyntheticPairDiskCache({ maxFiles: 10, maxBytes: 1024 * 1024 });
    assert.equal(result.files, 2);
    assert.equal(result.evictedFiles, 0);
});

test("pruneOnStartup is idempotent across calls (runs at most once per process)", () => {
    // __setSyntheticPairCacheDirForTests resets the startup guard, so the first
    // call here actually prunes. A second call must NOT prune again (it just
    // measures).
    seedCacheFiles(4);
    const first = pruneOnStartup();
    assert.equal(first.files, 4);

    // Add a file after the startup prune; a second pruneOnStartup must not evict it.
    writeFileSync(resolve(cacheDir, "post-startup.bin"), Buffer.alloc(8));
    const second = pruneOnStartup();
    assert.equal(second.files, 5, "second startup-prune call must be a no-op (just measure)");
});

test("pruneSyntheticPairDiskCache treats corrupt/vanished files gracefully", () => {
    writeFileSync(resolve(cacheDir, "note.txt"), "not a cache file");
    seedCacheFiles(2);
    const result = pruneSyntheticPairDiskCache({ maxFiles: MAX_CACHE_FILES, maxBytes: MAX_CACHE_BYTES });
    // .txt files are ignored by the cache (only .bin/.json counted).
    assert.equal(result.files, 2);
    assert.equal(result.evictedFiles, 0);
    assert.equal(readdirSync(cacheDir).filter((f) => f.endsWith(".txt")).length, 1);
});

// --------------------------------------------------------------------------
// LRU-by-mtime hit refresh (Finding 3): a cache HIT must update eviction
// priority so a hot pair survives pruning even if it hasn't been rewritten.
// --------------------------------------------------------------------------

test("a cache HIT refreshes mtime so a hot pair survives oldest-mtime pruning (Finding 3)", async () => {
    // Three crypto pairs with stable fingerprints (fixed series_meta).
    __setSeriesMetaFetcherForTests(async () => ({ ok: true, lastTime: 1782914400, barsCount: 65003, updatedAt: 1 }));
    const argsA = makeCryptoArgs();
    const argsB = makeCryptoArgs();
    const argsC = makeCryptoArgs();
    // Distinct pair keys → distinct cache files.
    argsA.pairKey = "A|BTCUSDT|PAXGUSDT|1h|1h|50000|synthetic";
    argsB.pairKey = "B|BTCUSDT|PAXGUSDT|1h|1h|50000|synthetic";
    argsC.pairKey = "C|BTCUSDT|PAXGUSDT|1h|1h|50000|synthetic";
    for (const a of [argsA, argsB, argsC]) {
        assert.equal(await storeSyntheticPair(a, makeBars(2)), true);
    }

    // Make A the OLDEST write so that without LRU-touch it would be evicted
    // first. All three are set well OUTSIDE the throttle window so a hit on A
    // WILL refresh its mtime (a hit inside the window is throttled by design).
    const pathA = __cacheFilePathForTests(argsA);
    const pathB = __cacheFilePathForTests(argsB);
    const pathC = __cacheFilePathForTests(argsC);
    const throttleSec = LRU_TOUCH_THROTTLE_MS / 1000;
    touchFile(pathA, throttleSec + 600); // oldest, well above throttle
    touchFile(pathB, throttleSec + 300);
    touchFile(pathC, throttleSec + 60);  // newest, still above throttle

    // Sanity: A is currently the oldest by mtime.
    const mtimeA = statSync(pathA).mtimeMs;

    // Repeatedly load A — each hit should refresh its mtime.
    const hit = await loadCachedSyntheticPair(argsA);
    assert.ok(hit !== null, "A must be a cache hit");

    const mtimeAAfter = statSync(pathA).mtimeMs;
    assert.ok(mtimeAAfter > mtimeA, "a hit must refresh the file mtime");

    // Now prune to 2 files. Before the fix, A (oldest write, hottest) would be
    // evicted. After the fix, A was just touched so it survives; the OLDEST
    // untouched entry (B) is evicted instead.
    const result = pruneSyntheticPairDiskCache({ maxFiles: 2, maxBytes: MAX_CACHE_BYTES });
    assert.equal(result.files, 2);
    assert.equal(existsSync(pathA), true, "hot pair A must survive after a hit");
    assert.equal(existsSync(pathB), false, "B (now oldest untouched) is evicted");
    assert.equal(existsSync(pathC), true, "C (newest) kept");
});

test("a cache HIT is throttled: a second hit within the window does not touch mtime (Finding 3)", async () => {
    __setSeriesMetaFetcherForTests(async () => ({ ok: true, lastTime: 1782914400, barsCount: 65003, updatedAt: 1 }));
    const args = makeCryptoArgs();
    args.pairKey = "THROTTLE|BTCUSDT|PAXGUSDT|1h|1h|50000|synthetic";
    assert.equal(await storeSyntheticPair(args, makeBars(2)), true);

    const p = __cacheFilePathForTests(args);
    // Push the file's mtime well OUTSIDE the throttle window first. Otherwise
    // the store itself just set the mtime to ~now and the first hit would be
    // throttled too — which would make this test pass for the wrong reason.
    touchFile(p, (LRU_TOUCH_THROTTLE_MS / 1000) + 300);
    const beforeFirst = statSync(p).mtimeMs;

    // First hit (outside the window) MUST refresh the mtime.
    assert.ok((await loadCachedSyntheticPair(args)) !== null);
    const afterFirst = statSync(p).mtimeMs;
    assert.ok(afterFirst > beforeFirst, "first hit outside the window must refresh mtime");

    // A second hit immediately after is now WITHIN the window → must NOT touch.
    assert.ok((await loadCachedSyntheticPair(args)) !== null);
    const afterSecond = statSync(p).mtimeMs;
    assert.equal(afterSecond, afterFirst, "throttle prevents a second utimesSync within the window");
});

test("a cache MISS does not refresh mtime (touch only fires on a validated hit)", async () => {
    __setSeriesMetaFetcherForTests(async () => ({ ok: true, lastTime: 1782914400, barsCount: 65003, updatedAt: 1 }));
    const args = makeCryptoArgs();
    args.pairKey = "MISS|BTCUSDT|PAXGUSDT|1h|1h|50000|synthetic";
    assert.equal(await storeSyntheticPair(args, makeBars(2)), true);
    const p = __cacheFilePathForTests(args);

    // Change the fingerprint so the next load is a MISS (stale fingerprint).
    __setSeriesMetaFetcherForTests(async () => ({ ok: true, lastTime: 9999999999, barsCount: 65003, updatedAt: 1 }));
    touchFile(p, 100);
    const mtimeBefore = statSync(p).mtimeMs;

    assert.equal(await loadCachedSyntheticPair(args), null);

    const mtimeAfter = statSync(p).mtimeMs;
    assert.equal(mtimeAfter, mtimeBefore, "a miss must not refresh mtime");
});

