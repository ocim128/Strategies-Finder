import assert from "node:assert/strict";
import type { Page } from "puppeteer";

/** Isolated browser context; deterministic server transport, real app controls and reload. */
export async function verifyTopRawScanWorkflow(parent: Page): Promise<void> {
    const context = await parent.browser().createBrowserContext(), page = await context.newPage();
    try {
        await page.setViewport({ width: 1440, height: 1000 });
        await page.evaluateOnNewDocument(() => {
            localStorage.setItem("playground_app_settings", JSON.stringify({ schema: "settings.app", version: 1, data: { currentSymbol: "MOCK_STOCK", currentInterval: "1d" } }));
            const original = window.fetch.bind(window);
            window.fetch = async (input, init) => {
                const url = String(input);
                if (!url.includes("/top-raw-scan/")) return original(input, init);
                if (url.endsWith("/run")) {
                    const request = JSON.parse(String(init?.body));
                    localStorage.setItem("e2e_scan_runs", String(Number(localStorage.getItem("e2e_scan_runs") ?? 0) + 1));
                    localStorage.setItem("e2e_scan_request", JSON.stringify(request));
                    if (localStorage.getItem("e2e_scan_complete")) return new Response(JSON.stringify({ type: "done", runId: request.runId, phase: "completed", completed: 1, total: 1, message: "Complete." }) + "\n");
                    if (localStorage.getItem("e2e_scan_preflight_failure")) {
                        const assets = request.assetListText.split("\n");
                        return new Response(JSON.stringify({ type: "done", runId: request.runId, phase: "failed", completed: assets.length, total: assets.length, message: "No common closed candle.",
                            preflight: { schema: "top_raw_scan.preflight.v1", runId: request.runId, interval: "4h", cutoff: 1700014400,
                                requestedAssetCount: assets.length, usableAssetCount: assets.length - 1, referenceAsOf: 1700000000, sourceInterval: "30m",
                                assetsToSync: [{ asset: assets[2], closedBars: 50, firstTime: null, lastTime: 1700000000, reason: "Incompatible local history." }] } }) + "\n");
                    }
                    const status = { runId: request.runId, phase: "discovery", completed: 0, total: 1, message: "sample" };
                    localStorage.setItem("e2e_scan_status", JSON.stringify(status));
                    return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(JSON.stringify({ type: "status", ...status }) + "\n")); } }), { headers: { "Content-Type": "application/x-ndjson" } });
                }
                if (url.endsWith("/stop")) {
                    const request = JSON.parse(String(init?.body));
                    const status = JSON.parse(localStorage.getItem("e2e_scan_status")!);
                    if (request.runId !== status.runId) throw new Error("Stop was not scoped.");
                    localStorage.setItem("e2e_scan_stops", String(Number(localStorage.getItem("e2e_scan_stops") ?? 0) + 1));
                    localStorage.setItem("e2e_scan_status", JSON.stringify({ ...status, phase: "interrupted", message: "Stopped." }));
                    return new Response('{"ok":true,"stopped":true}');
                }
                return new Response(localStorage.getItem("e2e_scan_status"));
            };
        });
        await page.goto(parent.url(), { waitUntil: "domcontentloaded" });
        await page.waitForSelector('.panel-tab[data-tab="batchbacktest"]');
        await page.click('.panel-tab[data-tab="batchbacktest"]');
        await page.waitForSelector("#batchBacktestFastTopRaw", { visible: true });
        await page.click("#batchBacktestFastTopRaw");
        await page.select("#batchBacktestSymbolTemplate", "nasdaq");
        const template = await page.$eval("#batchBacktestSymbols", input => (input as HTMLTextAreaElement).value);
        assert.ok(template.split("\n").length > 1000); assert.ok(!template.includes("+"));
        await page.$eval("#batchBacktestSymbols", input => { (input as HTMLTextAreaElement).value = "AAPL•\nMSFT•\nNVDA•"; input.dispatchEvent(new Event("input", { bubbles: true })); });
        // Delay the real lazy-loader promise while exercising the real Stop control.
        await page.evaluate(async () => {
            const [{ state }, catalog, { builtInStrategyLoaders }] = await Promise.all([
                import(location.origin + "/lib/state.ts"), import(location.origin + "/lib/strategies/built-in-catalog.ts"), import(location.origin + "/lib/strategies/manifest-loaders.ts"),
            ]);
            const key = state.currentStrategyKey, strategy = await catalog.ensureBuiltInStrategyLoaded(key), loader = builtInStrategyLoaders[key];
            catalog.unregisterLoadedBuiltInStrategy(key);
            let finish!: (value: unknown) => void;
            const pending = new Promise(resolve => { finish = resolve; });
            builtInStrategyLoaders[key] = () => { localStorage.setItem("e2e_scan_loader_waiting", "true"); return pending; };
            (window as unknown as { finishScanLoader: () => void }).finishScanLoader = () => { builtInStrategyLoaders[key] = loader; finish(strategy); };
        });
        await page.click("#batchBacktestScanRun");
        await page.waitForFunction(() => localStorage.getItem("e2e_scan_loader_waiting") === "true");
        await page.click("#batchBacktestScanStop");
        await page.evaluate(() => (window as unknown as { finishScanLoader: () => void }).finishScanLoader());
        await page.waitForFunction(() => !(document.getElementById("batchBacktestScanRun") as HTMLButtonElement).disabled);
        assert.equal(await page.evaluate(() => Number(localStorage.getItem("e2e_scan_runs") ?? 0)), 0, "startup Stop prevents submission after lazy load");
        await page.click("#batchBacktestScanRun");
        await page.waitForFunction(() => Boolean(localStorage.getItem("e2e_scan_request")));
        assert.equal(await page.$eval("#batchBacktestFastTopRaw", input => (input as HTMLInputElement).disabled), true);
        const submitted = await page.evaluate(() => JSON.parse(localStorage.getItem("e2e_scan_request")!));
        assert.equal(submitted.assetListText, "AAPL•\nMSFT•\nNVDA•");
        for (const key of ["replayMode", "horizons", "capTiltWeight", "sampleFrom", "maxPairs", "saveArchiveLog"]) assert.ok(!(key in submitted));
        await page.reload({ waitUntil: "domcontentloaded" });
        await page.click('.panel-tab[data-tab="batchbacktest"]');
        await page.waitForFunction(() => (document.getElementById("batchBacktestScanProgress")?.textContent ?? "").includes("discovery"));
        assert.equal(await page.evaluate(() => Number(localStorage.getItem("e2e_scan_stops") ?? 0)), 0, "reload must detach without Stop");
        assert.equal(await page.$eval("#batchBacktestSymbols", input => (input as HTMLTextAreaElement).value), submitted.assetListText);
        await page.click("#batchBacktestScanStop");
        await page.waitForFunction(() => !(document.getElementById("batchBacktestFastTopRaw") as HTMLInputElement).disabled);
        await page.click("#batchBacktestFastTopRaw");
        assert.equal(await page.$eval("#batchBacktestRunBtn", button => (button as HTMLButtonElement).disabled), false);
        assert.equal(await page.$eval("#batchBacktestSymbols", input => (input as HTMLTextAreaElement).value), submitted.assetListText);
        await page.click("#batchBacktestFastTopRaw");
        await page.evaluate(() => localStorage.setItem("e2e_scan_preflight_failure", "true"));
        await page.click("#batchBacktestScanRun");
        await page.waitForSelector("#batchBacktestScanPreflight", { visible: true });
        assert.equal(await page.$eval("#batchBacktestSymbols", input => (input as HTMLTextAreaElement).value), submitted.assetListText, "failed preflight preserves the full input");
        assert.match(await page.$eval("#batchBacktestScanPreflight", panel => panel.textContent ?? ""), /2023-11-14T22:13:20/);
        assert.match(await page.$eval("#batchBacktestScanPreflight", panel => panel.textContent ?? ""), /All 3 requested assets are retained/);
        assert.equal(await page.$eval("#batchBacktestScanDownload", button => (button as HTMLButtonElement).disabled), false);
        assert.equal(await page.$eval("#batchBacktestScanDownload", button => button.textContent), "Download sync report");
        const runs = await page.evaluate(() => localStorage.getItem("e2e_scan_runs"));
        assert.equal(await page.$eval("#batchBacktestSymbols", input => (input as HTMLTextAreaElement).value), submitted.assetListText);
        assert.equal(await page.evaluate(() => localStorage.getItem("e2e_scan_runs")), runs, "preflight must not run a reduced universe");
        await page.evaluate(() => localStorage.setItem("e2e_scan_complete", "true"));
        for (let count = Number(runs) + 1; count <= Number(runs) + 2; count++) {
            await page.click("#batchBacktestScanRun");
            await page.waitForFunction(expected => Number(localStorage.getItem("e2e_scan_runs")) === expected && !(document.getElementById("batchBacktestScanRun") as HTMLButtonElement).disabled, {}, count);
            assert.equal(await page.evaluate(() => localStorage.getItem("playground_top_raw_scan_active") && JSON.parse(localStorage.getItem("playground_top_raw_scan_active")!).data), null);
        }
        console.log("Fast TOP_RAW startup Stop, immediate reuse, template, raw input, reload and full-universe sync diagnostics passed.");
    } finally { await context.close(); }
}
