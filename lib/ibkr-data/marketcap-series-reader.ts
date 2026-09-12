/**
 * Market-cap series reader for the OPEN_SCORE USD cap-tilt weighting
 * (docs/open-score-cap-tilt.md).
 *
 * Why a self-contained leaf: this module is imported by
 * `lib/batch-backtest/batch-backtest-vite-plugin.ts`, which is bundled by
 * esbuild when Vite bundles `vite.config.ts` for the Node dev server. It must
 * therefore import ONLY `node:fs`/`node:path` — no `lib/local-daily-datasets`
 * (marker stripping is done inline below), no `lib/ibkr-data/
 * ibkr-data-vite-plugin` (the writer), nothing that transitively reaches
 * `lightweight-charts`. See the bundle trap documented in AGENTS.md.
 *
 * Data source: the Download MarketCap dataset (docs/marketcap-download.md) —
 * `<dir>/<SYMBOL>.csv` with header `time,close,shares_outstanding,market_cap`
 * (daily rows, `time` = ISO UTC date, `market_cap` USD) plus `catalog.json`
 * and `<SYM>.csv.bak` backups, which are skipped here.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface MarketCapLookup {
    /**
     * Market cap in USD for `symbol` at `timeSec`, from the nearest row at or
     * before the timestamp (cap rows are trading days; entries can be
     * intraday). `null` when the symbol has no file or no row at/before
     * `timeSec` — callers treat that as "weight 1", never as an error.
     */
    lookup(symbol: string, timeSec: number): number | null;
    /** Number of symbols indexed (files that yielded at least one valid row). */
    symbols: number;
}

type CapSeries = {
    /** Ascending unix-second row times. */
    times: number[];
    /** Market caps aligned with `times`. */
    caps: number[];
};

/** Marker/slash stripping, inline by design — see the import-hygiene note. */
function normalizeLookupSymbol(symbol: string): string {
    return String(symbol ?? "").replace(/•/g, "").replace(/\//g, "").trim().toUpperCase();
}

/**
 * Indexes every `*.csv` directly in `dir` (skipping `.bak` companions and
 * `catalog.json`, which the `.csv`-suffix filter already excludes). Malformed
 * rows are skipped silently — the Download MarketCap writer is the only
 * producer, and a truncated file must degrade to fewer known dates, never to
 * wrong weights. Row order on disk is ascending but the series re-sorts
 * defensively.
 */
export function loadMarketCapLookup(dir: string): MarketCapLookup {
    const bySymbol = new Map<string, CapSeries>();
    for (const name of readdirSync(dir)) {
        if (!name.toLowerCase().endsWith(".csv")) continue;
        let symbol = name.slice(0, -4);
        // Filenames are `encodeURIComponent(strippedSymbol)`; decode so a
        // hypothetical encoded character matches its plain-symbol lookups.
        try {
            symbol = decodeURIComponent(symbol);
        } catch {
            // Keep the raw stem — an invalid escape still identifies the file.
        }
        const times: number[] = [];
        const caps: number[] = [];
        for (const line of readFileSync(join(dir, name), "utf8").split(/\r?\n/)) {
            const parts = line.split(",");
            if (parts.length < 4) continue;
            const ms = Date.parse(parts[0]!.trim());
            const cap = Number(parts[3]);
            // Date.parse of a non-date returns NaN; caps must be finite USD.
            if (!Number.isFinite(ms) || !Number.isFinite(cap)) continue;
            times.push(Math.floor(ms / 1000));
            caps.push(cap);
        }
        if (times.length === 0) continue;
        const order = times.map((t, i) => ({ t, i })).sort((a, b) => a.t - b.t);
        bySymbol.set(normalizeLookupSymbol(symbol), {
            times: order.map((entry) => times[entry.i]!),
            caps: order.map((entry) => caps[entry.i]!),
        });
    }
    return {
        symbols: bySymbol.size,
        lookup(symbol, timeSec) {
            const series = bySymbol.get(normalizeLookupSymbol(symbol));
            if (!series) return null;
            // Nearest-prior binary search: rightmost times[i] <= timeSec.
            let lo = 0;
            let hi = series.times.length - 1;
            let best = -1;
            while (lo <= hi) {
                const mid = (lo + hi) >> 1;
                if (series.times[mid]! <= timeSec) {
                    best = mid;
                    lo = mid + 1;
                } else {
                    hi = mid - 1;
                }
            }
            return best === -1 ? null : series.caps[best]!;
        },
    };
}
