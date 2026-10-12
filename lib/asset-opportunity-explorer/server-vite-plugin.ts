import type { Plugin } from "vite";
import { debugLogger } from "../debug-logger";
import {
    HttpStatusError,
    registerLocalJsonRoute,
    sendJson,
    type LocalRouteMiddlewareStack,
    type ViteHttpResponse,
} from "../vite-http-utils";
import { scanAssetOpportunityArchive, type AssetOpportunityArchiveScanOutcome } from "./archive-reader";
import {
    ExplorerAnalysisError,
    buildHeatmapSnapshot,
    buildRangeDetails,
    type ExplorerView,
} from "./analysis";
import type {
    AssetOpportunityExplorerBasis,
    AssetOpportunityExplorerCatalogResponse,
    AssetOpportunityExplorerHeatmapResponse,
    AssetOpportunityExplorerMetric,
    AssetOpportunityExplorerSpacing,
} from "./types";

/**
 * Read-only local API over the existing `archive/asset opportunity` folder for
 * the Opportunity Explorer heatmap and its evidence panel.
 *
 * A small most-recently-used set of compact selected-run views (per batch run
 * and basis) plus the derived heatmap snapshot are retained per process, so
 * run and basis switches avoid re-scanning the archive; Refresh clears them.
 * No archive writes, no worker pool, no durable jobs, no persistent cache.
 * Sources are referenced by archive filename only — no filesystem path is ever
 * accepted from a client.
 *
 * Bundle-safe for Vite's CJS configuration build: imports only leaf modules
 * (vite-http-utils + feature-local leaves); no `finder-manager`, chart, or UI
 * singletons, no `lightweight-charts` reach.
 */

export const EXPLORER_DETAILS_PAGE_DEFAULT = 100;
export const EXPLORER_DETAILS_PAGE_MAX = 500;

/** Retained compact views. One view is on the order of tens of MB at worst, so the cap stays small. */
const MAX_RETAINED_VIEWS = 3;

let serverRoot: string | null = null;
/** Last completed catalog scan (metadata only). */
let catalog: AssetOpportunityExplorerCatalogResponse | null = null;
/**
 * Compact selected-run views, keyed `batchRunId\u0000basis`, in
 * most-recently-used order (Map insertion order; hits are re-inserted). A scan
 * for an uncached selection takes seconds over a full archive, so repeat
 * switches between a few runs/bases must not re-enter it.
 */
const retainedViews = new Map<string, { generation: number; view: ExplorerView }>();
/** The current derived snapshot for one of the retained views. */
let snapshot: {
    response: AssetOpportunityExplorerHeatmapResponse;
    /** The view the snapshot was derived from; details serve from it directly. */
    view: ExplorerView;
    generation: number;
    batchRunId: string;
    basis: AssetOpportunityExplorerBasis | null;
    horizonBars: number;
    topK: number;
    spacing: AssetOpportunityExplorerSpacing;
} | null = null;
let inFlightScan: { key: string; promise: Promise<AssetOpportunityArchiveScanOutcome> } | null = null;
/**
 * Monotonic scan-ownership token: allocated BEFORE a scan starts. A scan that
 * finishes after a newer refresh/run selection began must not publish — an
 * older completion otherwise overwrites the newer run's retained view or
 * reinstates a snapshot after Refresh.
 */
let scanOwnership = 0;
let scanRunner: typeof scanAssetOpportunityArchive = scanAssetOpportunityArchive;

function retainedViewKey(batchRunId: string, basis: AssetOpportunityExplorerBasis | null): string {
    return `${batchRunId}\u0000${basis ?? "*"}`;
}

function requireRoot(): string {
    return serverRoot ?? process.cwd();
}

function requireQueryParam(url: URL, name: string): string {
    const raw = url.searchParams.get(name);
    if (raw === null || !raw.trim()) throw new HttpStatusError(400, `${name} is required.`);
    return raw.trim();
}

function requirePositiveIntParam(url: URL, name: string): number {
    const raw = requireQueryParam(url, name);
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 1) {
        throw new HttpStatusError(400, `${name} must be a positive integer.`);
    }
    return value;
}

function requireOptionalIntParam(url: URL, name: string, fallback: number, min: number, max?: number): number {
    const raw = url.searchParams.get(name);
    if (raw === null || !raw.trim()) return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < min || (max !== undefined && value > max)) {
        throw new HttpStatusError(400, max !== undefined
            ? `${name} must be an integer between ${min} and ${max}.`
            : `${name} must be an integer >= ${min}.`);
    }
    return value;
}

function requireEnumParam<T extends string>(url: URL, name: string, allowed: readonly T[], fallback?: T): T {
    const raw = url.searchParams.get(name);
    if (raw === null || !raw.trim()) {
        if (fallback !== undefined) return fallback;
        throw new HttpStatusError(400, `${name} is required.`);
    }
    const value = raw.trim() as T;
    if (!allowed.includes(value)) {
        throw new HttpStatusError(400, `${name} must be one of: ${allowed.join(", ")}.`);
    }
    return value;
}

/**
 * Coalesce identical in-flight scans (same root + retained run) behind the
 * injectable runner so completion-order tests can substitute the scan.
 */
function performScan(args: Parameters<typeof scanAssetOpportunityArchive>[0]): Promise<AssetOpportunityArchiveScanOutcome> {
    const key = `${args.root}\u0000${args.retainRunId ?? "*"}\u0000${args.basis ?? "*"}`;
    if (inFlightScan && inFlightScan.key === key) return inFlightScan.promise;
    const startedAt = Date.now();
    const promise = scanRunner(args)
        .then((outcome) => {
            // A scan reads the whole archive (hundreds of MB at scale); the
            // duration line is the only way to tell a slow scan from a stuck one.
            debugLogger.info("explorer.scan_complete", {
                durationMs: Date.now() - startedAt,
                fileCount: outcome.fileCount,
                retainRunId: args.retainRunId,
                basis: args.basis ?? null,
            });
            return outcome;
        })
        .finally(() => {
            if (inFlightScan?.promise === promise) inFlightScan = null;
        });
    inFlightScan = { key, promise };
    return promise;
}

function catalogResponseFromScan(outcome: AssetOpportunityArchiveScanOutcome): AssetOpportunityExplorerCatalogResponse {
    return {
        ok: true,
        archiveRoot: outcome.archiveRootRelative,
        scannedAt: outcome.scannedAt,
        fileCount: outcome.fileCount,
        runs: outcome.runs,
    };
}

/** Map analysis errors onto their status; other errors continue to the 500 path. */
function rethrowMapped(error: unknown): void {
    if (error instanceof ExplorerAnalysisError) {
        throw new HttpStatusError(error.status, error.message);
    }
    throw error;
}

async function handleCatalogRequest(res: ViteHttpResponse, url: URL): Promise<void> {
    try {
        const refresh = url.searchParams.get("refresh") === "1";
        if (!refresh && catalog) {
            sendJson(res, 200, catalog);
            return;
        }
        const ownership = ++scanOwnership;
        const outcome = await performScan({ root: requireRoot(), retainRunId: null });
        const response = catalogResponseFromScan(outcome);
        if (ownership === scanOwnership) {
            // Only the newest scan publishes: a refresh invalidates the
            // retained views and snapshot, and an older completion must never
            // clobber a newer run selection's state.
            catalog = response;
            if (refresh) {
                retainedViews.clear();
                snapshot = null;
            }
        }
        sendJson(res, 200, response);
    } catch (error) {
        rethrowMapped(error);
    }
}

async function retainViewForRun(
    batchRunId: string,
    basis: AssetOpportunityExplorerBasis | null,
): Promise<{ generation: number; view: ExplorerView } | null> {
    const key = retainedViewKey(batchRunId, basis);
    const cached = retainedViews.get(key);
    if (cached) {
        // Re-insert to refresh recency so the most-used views survive eviction.
        retainedViews.delete(key);
        retainedViews.set(key, cached);
        return cached;
    }
    const ownership = ++scanOwnership;
    const outcome = await performScan({ root: requireRoot(), retainRunId: batchRunId, ...(basis ? { basis } : {}) });
    if (!outcome.runs.some((run) => run.batchRunId === batchRunId)) {
        throw new HttpStatusError(400, `Unknown batch run: ${batchRunId}. Refresh the catalog.`);
    }
    if (ownership !== scanOwnership) {
        // A newer selection or refresh took ownership while this scan ran;
        // drop the stale outcome instead of overwriting newer state.
        return null;
    }
    catalog = catalogResponseFromScan(outcome);
    const entry = { generation: ownership, view: outcome.view! };
    retainedViews.set(key, entry);
    while (retainedViews.size > MAX_RETAINED_VIEWS) {
        const oldest = retainedViews.keys().next();
        if (oldest.done) break;
        retainedViews.delete(oldest.value);
    }
    snapshot = null;
    return entry;
}

async function handleHeatmapRequest(res: ViteHttpResponse, url: URL): Promise<void> {
    try {
        const batchRunId = requireQueryParam(url, "batchRunId");
        const horizonBars = requirePositiveIntParam(url, "horizonBars");
        const topK = requirePositiveIntParam(url, "topK");
        const spacing = requireEnumParam<AssetOpportunityExplorerSpacing>(url, "spacing", ["all", "horizon"], "all");
        const basisParam = url.searchParams.get("basis");
        // Absent = no re-basing: each row keeps its primary measurement (the
        // pre-basis view legacy archives need).
        const basis = basisParam && basisParam.trim()
            ? requireEnumParam<AssetOpportunityExplorerBasis>(url, "basis", ["pair", "base_only", "quote_only"])
            : null;
        const entry = await retainViewForRun(batchRunId, basis);
        if (!entry) {
            throw new HttpStatusError(409, "A newer explorer selection replaced this scan while it ran; repeat the request.");
        }
        const view = entry.view;
        if (view.archiveMaximumRank > 0 && topK > view.archiveMaximumRank) {
            throw new HttpStatusError(400, `topK ${topK} exceeds the archived rank limit ${view.archiveMaximumRank} for run "${batchRunId}"; the archive shortlist has no ranks beyond it.`);
        }
        if (snapshot
            && snapshot.batchRunId === batchRunId
            && snapshot.basis === basis
            && snapshot.horizonBars === horizonBars
            && snapshot.topK === topK
            && snapshot.spacing === spacing) {
            sendJson(res, 200, snapshot.response);
            return;
        }
        const response = buildHeatmapSnapshot(view, {
            batchRunId,
            horizonBars,
            topK,
            spacing,
            snapshotId: `explorer-${entry.generation}-${batchRunId}-b${basis}-h${horizonBars}-k${topK}-${spacing}`,
        });
        snapshot = {
            response,
            view,
            generation: entry.generation,
            batchRunId,
            basis,
            horizonBars,
            topK,
            spacing,
        };
        sendJson(res, 200, response);
    } catch (error) {
        rethrowMapped(error);
    }
}

function handleDetailsRequest(res: ViteHttpResponse, url: URL): void {
    try {
        const snapshotId = requireQueryParam(url, "snapshotId");
        const sortMetric = requireQueryParam(url, "sortMetric");
        const horizonBars = requirePositiveIntParam(url, "horizonBars");
        const holdoutFrom = requirePositiveIntParam(url, "holdoutFrom");
        const holdoutTo = requirePositiveIntParam(url, "holdoutTo");
        const metric = requireEnumParam<AssetOpportunityExplorerMetric>(url, "metric", ["actual", "delta"]);
        const offset = requireOptionalIntParam(url, "offset", 0, 0);
        const limit = requireOptionalIntParam(url, "limit", EXPLORER_DETAILS_PAGE_DEFAULT, 1, EXPLORER_DETAILS_PAGE_MAX);
        if (!snapshot || snapshot.response.snapshotId !== snapshotId) {
            throw new HttpStatusError(409, "The heatmap snapshot is no longer retained; reload the explorer view to match the current archive selection.");
        }
        if (snapshot.response.horizonBars !== horizonBars) {
            throw new HttpStatusError(400, `horizonBars ${horizonBars} does not match the snapshot horizon ${snapshot.response.horizonBars}.`);
        }
        const response = buildRangeDetails({
            snapshotId,
            view: snapshot.view,
            columns: snapshot.response.holdoutBars,
            topK: snapshot.response.topK,
            horizonBars,
            sortMetric,
            holdoutFrom,
            holdoutTo,
            metric,
            offset,
            limit,
        });
        sendJson(res, 200, response);
    } catch (error) {
        rethrowMapped(error);
    }
}

export function registerAssetOpportunityExplorerRoutes(middlewares: LocalRouteMiddlewareStack): void {
    const unauthorizedMessage = "Unauthorized: asset-opportunity-explorer routes are local-only.";
    registerLocalJsonRoute(middlewares, "/api/asset-opportunity-explorer/catalog", {
        methods: ["GET"],
        unauthorizedMessage,
        onAuthorized: async ({ res, url }) => handleCatalogRequest(res, url),
    });
    registerLocalJsonRoute(middlewares, "/api/asset-opportunity-explorer/heatmap", {
        methods: ["GET"],
        unauthorizedMessage,
        onAuthorized: async ({ res, url }) => handleHeatmapRequest(res, url),
    });
    registerLocalJsonRoute(middlewares, "/api/asset-opportunity-explorer/details", {
        methods: ["GET"],
        unauthorizedMessage,
        onAuthorized: ({ res, url }) => handleDetailsRequest(res, url),
    });
}

export function assetOpportunityExplorerVitePlugin(): Plugin {
    return {
        name: "asset-opportunity-explorer",
        configureServer(server) {
            serverRoot = server.config.root ?? process.cwd();
            registerAssetOpportunityExplorerRoutes(server.middlewares);
        },
        configurePreviewServer(server) {
            serverRoot = server.config.root ?? process.cwd();
            registerAssetOpportunityExplorerRoutes(server.middlewares);
        },
    };
}

export const __testInternals = {
    registerAssetOpportunityExplorerRoutesForTests: registerAssetOpportunityExplorerRoutes,
    setServerRootForTests(root: string | null): void { serverRoot = root; },
    setScanRunnerForTests(runner: typeof scanAssetOpportunityArchive | null): void {
        scanRunner = runner ?? scanAssetOpportunityArchive;
    },
    resetForTests(): void {
        serverRoot = null;
        catalog = null;
        retainedViews.clear();
        snapshot = null;
        scanOwnership = 0;
        inFlightScan = null;
        scanRunner = scanAssetOpportunityArchive;
    },
    getCatalogForTests(): AssetOpportunityExplorerCatalogResponse | null { return catalog; },
    getSnapshotForTests(): typeof snapshot { return snapshot; },
    /** The most-recently-used retained view; hits refresh recency. */
    getRetainedGenerationForTests(): number | null {
        const entries = [...retainedViews.values()];
        return entries[entries.length - 1]?.generation ?? null;
    },
    getRetainedViewForTests(): ExplorerView | null {
        const entries = [...retainedViews.values()];
        return entries[entries.length - 1]?.view ?? null;
    },
    /** Number of distinct retained views (run, basis) pairs. */
    getRetainedViewCountForTests(): number { return retainedViews.size; },
};
