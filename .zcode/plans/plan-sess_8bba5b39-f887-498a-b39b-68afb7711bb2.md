## Fix: Download must never destroy existing data

Three surgical layers. All three destruction sites get fixed (IBKR worker, Alpaca worker, aggregator). The first layer alone would have prevented your data loss; the other two are defense-in-depth so no future path can repeat it.

### Layer 1 — Download merges, never replaces (root cause fix)

**Problem:** `syncOneSymbol` (IBKR, line 1464) and `syncOneAlpacaSymbol` (line 1741) both do:
```ts
const existing = syncOnly ? readCsvCandles(symbol, interval) : [];
```
On Download (`syncOnly === false`), existing rows are discarded — the new fetch overwrites the file entirely. Your 73,000-bar NVDA 30m file was replaced by 79 Alpaca bars because of this single line.

**Fix:** Always read existing rows and merge via `mergeCandlesByTime` (which already exists, already does last-write-wins dedup by timestamp, sorted ascending). The merge is safe: overlapping timestamps take the newer fetch's values; non-overlapping old rows (the entire IBKR history back to 2004) are preserved.

```ts
// In both syncOneSymbol and syncOneAlpacaSymbol:
const existing = readCsvCandles(symbol, interval);   // always read
const merged = adjustIntradayCandlesFromDailyCsv(     // IBKR only
    symbol, interval, mergeCandlesByTime([...existing, ...fetched])
);
writeCsv(symbol, interval, merged);
```

This changes Download semantics from "replace" to "merge new bars onto existing history" — which is what every user actually expects "download more data" to mean. The Alpaca source guard (`syncOnly && source !== "alpaca" → 409`) becomes unnecessary for safety, but I'll **keep it** because merging Alpaca bars into an IBKR interval still mixes feeds (a data-quality issue, not a data-loss issue). What changes: Alpaca Download against an existing IBKR interval now **merges** instead of replacing, so the IBKR history survives and the Alpaca bars extend it. The catalog records `source: "alpaca"` — but mixing sources in one file is itself problematic, so I'll add a `mixed` source state (see below).

**The `mixed` source state:** when Download would merge into an interval with a different existing `source`, the catalog records `source: "mixed"` (new value) instead of overwriting the source label. This honestly tells you "this interval contains bars from multiple providers" — you can decide whether to trust it. `normalizeDataSource`/catalog readers stay backward-compatible (unknown/absent source still treated as IBKR for reads).

### Layer 2 — `writeCsv` auto-backs-up before overwrite (defense in depth)

**Problem:** `writeCsv` does atomic temp+rename but does NOT preserve the file being replaced. Once renamed over, the old content is gone permanently.

**Fix:** before the rename, if the destination exists, copy it to `<path>.bak` (overwriting any prior `.bak`). This covers all three destruction sites at once (both sync workers AND the aggregator) without touching their call sites. The `.bak` is a single-file, last-good-state snapshot — enough to undo one bad operation.

```ts
export function writeCsv(symbol, interval, candles): void {
    const filePath = getCsvPath(symbol, interval);
    // ... build tempPath, writeFileSync(tempPath, ...) ...
    if (existsSync(filePath)) {
        copyFileSync(filePath, `${filePath}.bak`);   // preserve last good state
    }
    renameSync(tempPath, filePath);
}
```

Trade-off: a `.bak` file sits next to every CSV (2× disk for the price of one undo). For 100 symbols × ~4MB that's ~400MB of `.bak` files. Acceptable for a local research dataset, and `.bak` is easy to clean up (`del /S *.bak`). If you want, I can make the backup opt-in via an env var, but I recommend always-on given what just happened.

### Layer 3 — Aggregator refuses shrinking writes (the 4h path that bit you)

**Problem:** `scripts/ibkr-aggregate-csv.ts` regenerated your 4h from the truncated 79-bar 30m and overwrote 13,369 4h bars. `shouldSkip` only checks for "destination already matches" — it has no guard against "destination is much larger than what we're about to write".

**Fix:** before `writeCsv`, compare `aggregated.length` against the existing destination's bar count. If the new count is meaningfully smaller (say <50% of existing AND existing has >100 bars — a clear shrink, not a fresh write), refuse with a message:
```
NVDA: REFUSED write of 10 bars (existing 4h has 13369 bars).
The 30m source likely shrank. Re-run with --force to overwrite anyway,
or restore 30m/NVDA.csv from its .bak and re-aggregate.
```
Add a `--force` flag to override (with the existing `--dry-run` still working). This is the guard that would have stopped your 4h loss even after the 30m was already destroyed.

### Validation

- New unit tests:
  - `writeCsv` creates a `.bak` when overwriting an existing file
  - IBKR Download merges new bars onto existing (existing history preserved)
  - Alpaca Download merges into an IBKR interval → catalog records `source: "mixed"`
  - Aggregator refuses shrinking writes; `--force` overrides; `--dry-run` still works
- Run existing: `alpaca-fetcher.spec.ts`, `alpaca-source-integration.spec.ts`, `ibkr-data-lifecycle.spec.ts`, `ibkr-price-data.spec.ts`, `feature-dom-contracts.spec.ts` — confirm no regressions
- `npm run typecheck` clean

### What this does NOT change

- The source guard for **Sync** stays (sync = incremental merge onto same-source data; mixing sources via sync is still a data-quality error, just now a non-destructive one)
- `npm run ibkr:aggregate` CLI signature stays the same (only adds `--force`)
- Existing catalog entries without `source` still read fine
- The 1d interval (untouched, 6,908 bars intact) is not affected by any of these changes

### After the fix lands

You can re-download the 99 symbols from IBKR with `period=max` and the existing bars you do have will be preserved (merge, not replace). BA.csv (the one symbol that survived) needs no action — it'll merge cleanly with whatever you fetch next. The `.bak` files will accumulate as you work, giving you a one-step undo on every future write.

### Files to change

1. `lib/ibkr-data/ibkr-data-vite-plugin.ts` — `writeCsv` (add `.bak`), `syncOneSymbol` (always merge), `syncOneAlpacaSymbol` (always merge + `mixed` source on cross-source Download)
2. `lib/ibkr-data/ibkr-data-stream-types.ts` — add `"mixed"` to the `source` union
3. `scripts/ibkr-aggregate-csv.ts` — add shrink-guard + `--force` flag
4. `tests/alpaca-source-integration.spec.ts` — update the source-guard test for the new merge semantics; add `mixed` test
5. New test file or append to existing — `writeCsv` `.bak` test, aggregator shrink-guard test