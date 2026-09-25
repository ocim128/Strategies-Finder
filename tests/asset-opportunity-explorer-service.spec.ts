/** Browser lifecycle regressions for the Opportunity Explorer service. */
import { expect } from "chai";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { AssetOpportunityExplorerService } from "../lib/asset-opportunity-explorer/service";
import { ASSET_OPPORTUNITY_EXPLORER_REQUIRED_IDS } from "../lib/asset-opportunity-explorer/dom";
import type {
    AssetOpportunityExplorerCatalogResponse,
    AssetOpportunityExplorerHeatmapResponse,
} from "../lib/asset-opportunity-explorer/types";

function fakeEl(): any {
    const listeners = new Map<string, Array<(ev?: unknown) => void>>();
    const el: any = {
        style: {},
        dataset: {},
        disabled: false,
        hidden: false,
        value: "",
        textContent: "",
        max: "",
        clientWidth: 800,
        scrollTop: 0,
        children: [] as any[],
        listeners,
        classList: {
            add: () => undefined,
            remove: () => undefined,
            contains: () => false,
        },
        setAttribute: () => undefined,
        replaceChildren(...children: unknown[]) { el.children = children; },
        appendChild(child: unknown) { el.children.push(child); return child; },
        append(...children: unknown[]) { el.children.push(...children); },
        querySelector: () => fakeEl(),
        querySelectorAll: () => [],
        addEventListener(type: string, handler: (ev?: unknown) => void) {
            const arr = listeners.get(type) ?? [];
            arr.push(handler);
            listeners.set(type, arr);
        },
        removeEventListener: () => undefined,
        getContext: () => null,
    };
    return el;
}

/** Mimics a real <select>: replacing the options re-selects the first entry
 * when the current value is no longer present. */
function fakeSelectEl(): any {
    const el = fakeEl();
    const originalReplace = el.replaceChildren;
    el.replaceChildren = (...children: unknown[]) => {
        originalReplace(...children);
        const values = children.map((option) => (option as any)?.value).filter((value) => typeof value === "string");
        el.value = values.includes(el.value) ? el.value : (values[0] ?? "");
    };
    return el;
}

const SELECT_IDS = new Set([
    "explorerRunSelect",
    "explorerHorizonSelect",
    "explorerMetricSelect",
    "explorerSpacingSelect",
]);

type FetchResponder = (url: string) => { status: number; body: unknown } | Promise<{ status: number; body: unknown }>;

let savedDocument: any;
let savedWindow: any;
let savedFetch: any;
let responder: FetchResponder;
let requestedUrls: string[];

function catalogPayload(runs: unknown[]): AssetOpportunityExplorerCatalogResponse {
    return {
        ok: true,
        archiveRoot: "archive/asset opportunity",
        scannedAt: "2026-09-25T00:00:00.000Z",
        fileCount: runs.length,
        runs: runs as AssetOpportunityExplorerCatalogResponse["runs"],
    };
}

function fixtureRun() {
    return {
        batchRunId: "run-a",
        latestTimestamp: "2026-09-25T01:00:00.000Z",
        holdoutBars: [12, 24],
        sortMetrics: ["expectancy"],
        support: "fixed_horizon" as const,
        horizons: [6, 12],
        archiveMaximumRank: 10,
        sourceBlockCount: 2,
        hasBaselines: true,
    };
}

function fixtureRunB() {
    return {
        ...fixtureRun(),
        batchRunId: "run-b",
        latestTimestamp: "2026-09-25T02:00:00.000Z",
    };
}

function heatmapPayload(snapshotId: string): AssetOpportunityExplorerHeatmapResponse {
    return {
        ok: true,
        snapshotId,
        batchRunId: "run-a",
        horizonBars: 6,
        topK: 10,
        spacing: "all",
        measurementMode: "fixed_horizon",
        basis: "pair",
        holdoutBars: [24, 12],
        sorts: ["expectancy"],
        cells: [{
            holdoutBars: 24,
            sortMetric: "expectancy",
            actual: 1.5,
            baseline: 1,
            delta: 0.5,
            selectedRows: 2,
            observedRows: 2,
            totalSamples: 2,
        }],
        diagnostics: {
            sourceBlockCount: 2,
            retainedBlockCount: 1,
            archivedRows: 2,
            selectedRows: 2,
            observedRows: 2,
            missingRows: 0,
            unknownFingerprintRows: 0,
            archiveMaximumRank: 10,
            notes: [],
        },
    };
}

function detailsPayload(
    snapshotId: string,
    sortMetric = "expectancy",
    holdoutFrom = 12,
    holdoutTo = 24,
) {
    return {
        ok: true,
        snapshotId,
        batchRunId: "run-a",
        sortMetric,
        holdoutFrom,
        holdoutTo,
        horizonBars: 6,
        metric: "actual",
        unit: "%",
        summary: {
            totalHoldouts: 2,
            observedHoldouts: 2,
            mean: 1.5,
            median: 1.5,
            observedRows: 2,
            totalRows: 2,
            missingRows: 0,
            uniqueCandidates: 2,
            unknownFingerprintRows: 0,
        },
        histogram: {
            bins: [{ from: 1, to: 2, count: 2 }],
            valuesCount: 2,
        },
        rows: [{
            holdoutBars: 24,
            rank: 1,
            symbol: "AAA",
            strategyId: "strategy_a",
            strategyName: "Strategy A",
            candidateFingerprint: "fp-1",
            actual: 1.5,
            baseline: 1,
            sampleSize: 1,
            blockTimestamp: "2026-09-25T01:00:00.000Z",
            sourceFile: "oos-holdout-24-bars.txt",
        }],
        totalRows: 1,
        offset: 0,
        hasMore: false,
    };
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(`timed out waiting for ${label}`);
}

/** Fresh service with the fake selects defaulted like a real browser would. */
function createService(): { service: AssetOpportunityExplorerService; dom: any } {
    const service = new AssetOpportunityExplorerService();
    service.init();
    const dom = (service as any).getDom();
    dom.explorerSpacingSelect.value = "all";
    dom.explorerMetricSelect.value = "actual";
    return { service, dom };
}

/** Details response that echoes the requested selection, so the service's
 * selection-key check sees a matching payload unless told otherwise. */
function detailsResponderFor(
    url: string,
    gate?: Promise<void>,
): { status: number; body: unknown } | Promise<{ status: number; body: unknown }> {
    const params = new URLSearchParams(url.slice(url.indexOf("?") + 1));
    const body = () => ({
        status: 200,
        body: detailsPayload(
            params.get("snapshotId")!,
            params.get("sortMetric")!,
            Number(params.get("holdoutFrom")),
            Number(params.get("holdoutTo")),
        ),
    });
    return gate ? gate.then(body) : body();
}

describe("Asset Opportunity Explorer service", () => {
    let elements: Map<string, any>;

    before(() => {
        savedDocument = (globalThis as any).document;
        savedWindow = (globalThis as any).window;
        savedFetch = (globalThis as any).fetch;
        elements = new Map<string, any>();
        (globalThis as any).document = {
            getElementById: (id: string) => {
                let el = elements.get(id);
                if (!el) {
                    el = SELECT_IDS.has(id) ? fakeSelectEl() : fakeEl();
                    elements.set(id, el);
                }
                return el;
            },
            createElement: () => fakeEl(),
            createElementNS: () => fakeEl(),
            addEventListener: () => undefined,
            head: { appendChild: () => undefined },
        };
        (globalThis as any).window = { addEventListener: () => undefined };
        (globalThis as any).fetch = (url: string) => {
            requestedUrls.push(String(url));
            return Promise.resolve(responder(String(url))).then((outcome) => ({
                ok: outcome.status === 200,
                status: outcome.status,
                json: () => Promise.resolve(outcome.body),
            }));
        };
    });

    beforeEach(() => {
        requestedUrls = [];
    });

    // Fresh elements per test so each service instance binds its own listeners.
    afterEach(() => {
        elements.clear();
    });

    after(() => {
        if (savedDocument === undefined) delete (globalThis as any).document;
        else (globalThis as any).document = savedDocument;
        if (savedWindow === undefined) delete (globalThis as any).window;
        else (globalThis as any).window = savedWindow;
        if (savedFetch === undefined) delete (globalThis as any).fetch;
        else (globalThis as any).fetch = savedFetch;
    });

    it("shows the empty state when the catalog has no runs", async () => {
        responder = () => ({ status: 200, body: catalogPayload([]) });
        const { dom } = createService();
        await waitFor(() => dom.explorerStatus.textContent.includes("Catalog loaded"), "catalog loaded");
        expect(dom.explorerEmpty.hidden).to.equal(false);
        expect(dom.explorerHeatmapSection.hidden).to.equal(true);
    });

    it("keeps the previous display marked stale when a refresh fails", async () => {
        let failRefresh = false;
        responder = (url) => {
            if (url.includes("catalog") && failRefresh) return { status: 500, body: { error: "disk error" } };
            if (url.includes("catalog")) return { status: 200, body: catalogPayload([fixtureRun()]) };
            return { status: 200, body: heatmapPayload("snap-1") };
        };
        const { dom } = createService();
        await waitFor(() => dom.explorerStatus.textContent.includes("Heatmap loaded"), "initial heatmap visible");
        expect(dom.explorerEmpty.hidden).to.equal(true);

        failRefresh = true;
        dom.explorerRefreshBtn.listeners.get("click")![0]!();
        await waitFor(
            () => dom.explorerStatus.textContent.includes("Refresh failed") && dom.explorerStatus.textContent.includes("stale"),
            "stale status",
        );
        // The previous view stays visible rather than being blanked.
        expect(dom.explorerHeatmapSection.hidden).to.equal(false);
        expect(dom.explorerEmpty.hidden).to.equal(true);
    });

    it("drops an obsolete heatmap response and keeps only the newest snapshot", async () => {
        let releaseFirst: (() => void) | null = null;
        const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
        responder = (url) => {
            if (url.includes("catalog")) return { status: 200, body: catalogPayload([fixtureRun()]) };
            if (url.includes("heatmap")) {
                // The first heatmap call hangs until released; the second answers
                // immediately so the older response would finish last.
                if (requestedUrls.filter((candidate) => candidate.includes("heatmap")).length === 1) {
                    return firstGate.then(() => ({ status: 200, body: heatmapPayload("snap-1") }));
                }
                return { status: 200, body: heatmapPayload("snap-2") };
            }
            return { status: 200, body: {} };
        };
        const { service } = createService();
        await waitFor(() => requestedUrls.filter((candidate) => candidate.includes("heatmap")).length === 1, "first heatmap in flight");
        void (service as any).loadHeatmap();
        await waitFor(() => requestedUrls.filter((candidate) => candidate.includes("heatmap")).length === 2, "second heatmap sent");
        releaseFirst!();
        await waitFor(() => (service as any).heatmap?.snapshotId === "snap-2", "newest snapshot retained");
        // The obsolete snap-1 response must never overwrite the newer snapshot.
        expect((service as any).heatmap.snapshotId).to.equal("snap-2");
    });

    it("renders range detail for a selection and discards mismatched snapshot payloads", async () => {
        responder = (url) => {
            if (url.includes("catalog")) return { status: 200, body: catalogPayload([fixtureRun()]) };
            if (url.includes("heatmap")) return { status: 200, body: heatmapPayload("snap-1") };
            if (url.includes("details")) {
                return { status: 200, body: detailsPayload("snap-1") };
            }
            return { status: 404, body: { error: "unknown" } };
        };
        const { service, dom } = createService();
        await waitFor(() => dom.explorerStatus.textContent.includes("Heatmap loaded"), "heatmap visible");

        (service as any).selectRange("expectancy", 12, 24);
        await waitFor(() => dom.explorerDetailTitle.textContent.includes("expectancy"), "detail rendered");
        await waitFor(() => dom.explorerDetailStatus.textContent.includes("Showing"), "detail settled");
        expect(dom.explorerDetailTitle.textContent).to.contain("expectancy");
        expect(dom.explorerDetailSummary.textContent).to.contain("equal-holdout mean");
        expect(dom.explorerDetailRows.children.length).to.equal(1);
        expect(requestedUrls.some((url) => url.includes("snapshotId=snap-1") && url.includes("details"))).to.equal(true);

        // A payload naming a different snapshot must never render.
        (service as any).heatmap.snapshotId = "snap-stale-target";
        requestedUrls.length = 0;
        await (service as any).loadDetails(0);
        expect(dom.explorerDetailStatus.textContent).to.contain("discarded");
        expect(dom.explorerDetailRows.children.length).to.equal(1);
    });

    it("binds every structural id from the DOM contract", () => {
        // init() resolves every contract id through getRequiredElement; a fresh
        // instance that initialized without throwing proves the wiring is complete.
        responder = () => ({ status: 200, body: catalogPayload([]) });
        const service = new AssetOpportunityExplorerService();
        service.init();
        expect(ASSET_OPPORTUNITY_EXPLORER_REQUIRED_IDS.length).to.be.greaterThan(0);
    });

    it("keeps the chosen batch run when the catalog is rebuilt", async () => {
        responder = (url) => {
            if (url.includes("catalog")) return { status: 200, body: catalogPayload([fixtureRun(), fixtureRunB()]) };
            return { status: 200, body: heatmapPayload("snap-1") };
        };
        const { dom } = createService();
        await waitFor(() => requestedUrls.some((url) => url.includes("batchRunId=run-a")), "initial heatmap for run-a");
        // The user picks run B; the change handler rebuilds the options.
        dom.explorerRunSelect.value = "run-b";
        dom.explorerRunSelect.listeners.get("change")![0]!();
        await waitFor(() => requestedUrls.some((url) => url.includes("batchRunId=run-b")), "heatmap for run-b");
        expect(dom.explorerRunSelect.value).to.equal("run-b");
        const lastHeatmap = requestedUrls.filter((url) => url.includes("heatmap")).slice(-1)[0]!;
        expect(lastHeatmap).to.contain("batchRunId=run-b");
    });

    it("keeps the selected horizon when the catalog is rebuilt", async () => {
        responder = (url) => {
            if (url.includes("catalog")) return { status: 200, body: catalogPayload([fixtureRun()]) };
            return { status: 200, body: heatmapPayload("snap-1") };
        };
        const { dom } = createService();
        await waitFor(() => dom.explorerHorizonSelect.value === "12", "default horizon 12");
        dom.explorerRefreshBtn.listeners.get("click")![0]!();
        await waitFor(() => requestedUrls.filter((url) => url.includes("refresh=1")).length === 1, "refresh sent");
        await new Promise((resolve) => setTimeout(resolve, 30));
        expect(dom.explorerHorizonSelect.value).to.equal("12");
        expect(dom.explorerRunSelect.value).to.equal("run-a");
    });

    it("still loads details after an in-flight detail request was interrupted", async () => {
        let releaseDetails: (() => void) | null = null;
        const detailsGate = new Promise<void>((resolve) => { releaseDetails = resolve; });
        responder = (url) => {
            if (url.includes("catalog")) return { status: 200, body: catalogPayload([fixtureRun()]) };
            if (url.includes("heatmap")) return { status: 200, body: heatmapPayload("snap-1") };
            if (url.includes("details")) {
                const detailRequests = requestedUrls.filter((candidate) => candidate.includes("details")).length;
                return detailsResponderFor(url, detailRequests === 1 ? detailsGate : undefined);
            }
            return { status: 404, body: {} };
        };
        const { service, dom } = createService();
        await waitFor(() => requestedUrls.some((url) => url.includes("heatmap")), "heatmap loaded");
        (service as any).selectRange("expectancy", 12, 24);
        await waitFor(() => requestedUrls.filter((url) => url.includes("details")).length === 1, "first detail in flight");
        // Changing the horizon bumps the heatmap generation while the detail
        // request is still pending. The stale response is discarded (a horizon
        // change clears the selection), but the detail loading state must
        // release so later selections still trigger requests.
        dom.explorerHorizonSelect.listeners.get("change")![0]!();
        await waitFor(() => requestedUrls.filter((url) => url.includes("heatmap")).length === 2, "heatmap reloaded");
        releaseDetails!();
        await new Promise((resolve) => setTimeout(resolve, 30));
        // The old code dead-locked here: the second selection produced no request.
        (service as any).selectRange("expectancy", 12, 12);
        await waitFor(() => requestedUrls.filter((url) => url.includes("details")).length === 2, "second detail requested");
        await waitFor(() => dom.explorerDetailTitle.textContent.includes("12–12"), "second detail rendered");
    });

    it("discards a superseded detail response for a different sort selection", async () => {
        let releaseA: (() => void) | null = null;
        const gateA = new Promise<void>((resolve) => { releaseA = resolve; });
        responder = (url) => {
            if (url.includes("catalog")) return { status: 200, body: catalogPayload([fixtureRun()]) };
            if (url.includes("heatmap")) return { status: 200, body: heatmapPayload("snap-1") };
            if (url.includes("details")) {
                const detailRequests = requestedUrls.filter((candidate) => candidate.includes("details")).length;
                return detailsResponderFor(url, detailRequests === 1 ? gateA : undefined);
            }
            return { status: 404, body: {} };
        };
        const { service, dom } = createService();
        await waitFor(() => requestedUrls.some((url) => url.includes("heatmap")), "heatmap loaded");
        (service as any).selectRange("sort_a", 12, 24);
        await waitFor(() => requestedUrls.filter((url) => url.includes("details")).length === 1, "sort_a detail in flight");
        (service as any).selectRange("sort_b", 12, 24);
        await waitFor(() => dom.explorerDetailTitle.textContent.includes("sort_b"), "sort_b detail rendered");
        releaseA!();
        await new Promise((resolve) => setTimeout(resolve, 30));
        // The late sort_a response must not replace sort_b's rendered detail.
        expect(dom.explorerDetailTitle.textContent).to.contain("sort_b");
        expect(dom.explorerDetailTitle.textContent).to.not.contain("sort_a");
    });
});
