/**
 * Shared MarketCap preflight for the two server-side cap-tilt consumers:
 * the standalone OPEN_SCORE USD route (`batch-backtest-vite-plugin.ts`) and
 * the TOP_MEAN coordinator (`sp500-top-mean-coordinator-engine.ts`). Audit
 * centralize-preflight finding: the two paths used to duplicate directory
 * resolution, CSV existence checks, required-symbol construction, the lookup
 * load, error text, and coverage logging — free to drift apart in validation
 * and coverage behavior.
 *
 * Leaf-safe for the vite.config esbuild bundle (AGENTS.md bundle trap):
 * imports only `node:fs`/`node:path` and the dependency-free
 * `marketcap-series-reader` leaf. NEVER import `ibkr-data-vite-plugin.ts`
 * (the producer) from here.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
    loadMarketCapLookup,
    normalizeMarketCapSymbol,
    type MarketCapLookup,
} from "./marketcap-series-reader";

/**
 * "Materially stale" threshold for the cap-tilt provenance warning: when the
 * newest MarketCap row trails the run's data window by more than this, the
 * report says so explicitly instead of silently falling back to weight 1
 * near the window end. Weighting semantics are unchanged — the warning is
 * observability only (audit coverage/provenance finding).
 */
export const MARKETCAP_STALE_WARNING_MS = 30 * 24 * 60 * 60 * 1000;

export type MarketCapPreflight = {
    /** Filtered lookup over exactly the requested symbols. */
    lookup: MarketCapLookup;
    /** Distinct requested symbols (normalized dedupe). */
    requestedSymbols: number;
    /** Requested symbols whose CSV yielded at least one valid row. */
    loadedSymbols: number;
    /** Requested symbols with no MarketCap data on disk. */
    missingSymbols: string[];
    /** Latest MarketCap row time (unix seconds) across loaded symbols. */
    latestDataTimeSec: number | null;
    /** `catalog.json` `updatedAt`, or null when absent/unreadable. */
    catalogUpdatedAt: string | null;
};

/** Same process.cwd()-rooted convention the IBKR plugin uses for price-data. */
export function resolveDefaultMarketCapDir(root: string = process.cwd()): string {
    return resolve(root, "price-data", "ibkr", "marketcap");
}

/**
 * Loads the MarketCap lookup for `requiredSymbols` and fails LOUD on the two
 * silent-degradation cases the audit identified:
 *  - the dataset directory is missing or holds no CSVs (previously each
 *    caller re-implemented this check with duplicated error text);
 *  - CSVs exist but every file is malformed/empty, which used to pass
 *    preflight and silently index zero symbols — every cap lookup then fell
 *    back to weight 1, producing a baseline-like run (audit fail-closed
 *    finding). Individual missing symbols still answer `null` (weight 1) as
 *    before and are reported via {@link MarketCapPreflight.missingSymbols}.
 */
export function loadMarketCapPreflight(
    dir: string,
    requiredSymbols: Iterable<string>,
): MarketCapPreflight {
    let csvFileCount = 0;
    try {
        csvFileCount = readdirSync(dir).filter((name) => name.toLowerCase().endsWith(".csv")).length;
    } catch {
        csvFileCount = 0;
    }
    if (csvFileCount === 0) {
        throw new Error(
            `The cap-tilt weighting requires the market-cap dataset, but ${dir} is missing or empty. Download MarketCap in the IBKR Data tab first.`,
        );
    }

    const required = [
        ...new Set(
            Array.from(requiredSymbols, (symbol) => normalizeMarketCapSymbol(String(symbol ?? "")))
                .filter((symbol) => symbol !== ""),
        ),
    ];
    const lookup = loadMarketCapLookup(dir, { symbols: required });
    if (lookup.symbols === 0) {
        throw new Error(
            `Market-cap files exist in ${dir} but contain no valid rows. Redownload MarketCap in the IBKR Data tab first.`,
        );
    }

    const indexed = new Set(lookup.indexedSymbols);
    const missingSymbols = required.filter((symbol) => !indexed.has(symbol)).sort((a, b) => a.localeCompare(b));

    return {
        lookup,
        requestedSymbols: required.length,
        loadedSymbols: lookup.symbols,
        missingSymbols,
        latestDataTimeSec: lookup.latestTimeSec,
        catalogUpdatedAt: readCatalogUpdatedAt(dir),
    };
}

function readCatalogUpdatedAt(dir: string): string | null {
    try {
        const parsed = JSON.parse(readFileSync(join(dir, "catalog.json"), "utf8")) as {
            updatedAt?: unknown;
        };
        return typeof parsed.updatedAt === "string" ? parsed.updatedAt : null;
    } catch {
        return null;
    }
}

function isoDateFromSec(timeSec: number | null): string | null {
    return timeSec === null ? null : new Date(timeSec * 1000).toISOString().slice(0, 10);
}

/**
 * Additive provenance report lines (audit coverage/provenance finding):
 * `marketcap dataset | requested=N loaded=M missing=K latest=YYYY-MM-DD
 * catalogUpdatedAt=...` plus a staleness warning when the newest cap row
 * trails the run's data window (or, when unknown, the current time) by more
 * than {@link MARKETCAP_STALE_WARNING_MS}. Pure formatting; the reportLines
 * contract renders whatever these produce verbatim.
 */
export function formatMarketCapProvenanceLines(
    preflight: MarketCapPreflight,
    options?: { windowEndTimeSec?: number | null; nowMs?: number },
): string[] {
    const lines = [
        `marketcap dataset | requested=${preflight.requestedSymbols}`
            + ` loaded=${preflight.loadedSymbols}`
            + ` missing=${preflight.missingSymbols.length}`
            + ` latest=${isoDateFromSec(preflight.latestDataTimeSec) ?? "none"}`
            + ` catalogUpdatedAt=${preflight.catalogUpdatedAt ?? "none"}`,
    ];
    if (preflight.missingSymbols.length > 0) {
        const shown = preflight.missingSymbols.slice(0, 12).join(",");
        const suffix = preflight.missingSymbols.length > shown.split(",").length ? ",…" : "";
        lines.push(`marketcap missing | ${preflight.missingSymbols.length} requested symbol(s) have no cap data: ${shown}${suffix}`);
    }
    const referenceSec = options?.windowEndTimeSec ?? null;
    const referenceMs = referenceSec !== null && referenceSec !== undefined
        ? referenceSec * 1000
        : (options?.nowMs ?? Date.now());
    if (
        preflight.latestDataTimeSec !== null
        && referenceMs - preflight.latestDataTimeSec * 1000 > MARKETCAP_STALE_WARNING_MS
    ) {
        const referenceLabel = referenceSec !== null && referenceSec !== undefined
            ? `the latest data bar (${isoDateFromSec(referenceSec)})`
            : "today";
        lines.push(
            "WARN: marketcap latest row "
                + `(${isoDateFromSec(preflight.latestDataTimeSec)}) is more than `
                + `${Math.round(MARKETCAP_STALE_WARNING_MS / 86_400_000)} days older than ${referenceLabel}; `
                + "caps after that date fall back to weight 1. Refresh the MarketCap dataset for current cap-tilt weights.",
        );
    }
    return lines;
}
