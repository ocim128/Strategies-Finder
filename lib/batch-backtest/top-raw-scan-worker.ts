import { parentPort, isMainThread } from "node:worker_threads";
import { stat } from "node:fs/promises";
import { loadServerBatchDataset } from "./server-batch-data-loader";
import { selectClosedCandleWindow } from "../alert-evaluation-window";
import { parseTimeToUnixSeconds } from "../time-normalization";
import { executeScanPair } from "./top-raw-scan-execution";
import { rustEngine } from "../rust-engine-client";
import type { ScanExecutionRequest, ScanPair, ScanVote } from "./top-raw-scan-contract";

export async function scanSourceRevision(path: string): Promise<string> {
    try { const s = await stat(path); return `${s.size}:${s.mtimeMs}:${s.ctimeMs}`; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing"; throw error; }
}
export type ScanWorkerTask =
    | { type: "engine_identity"; useRust: boolean }
    | { type: "preflight"; asset: string; interval: string; cutoff: number }
    | { type: "pairs"; pairs: ScanPair[]; request: ScanExecutionRequest; asOf: number; cutoff: number; sources: Array<{ path: string; revision: string }>; engineIdentity?: string };
async function engineIdentity(useRust: boolean): Promise<string> {
    if (!useRust || !await rustEngine.checkHealth()) return "typescript_only";
    return JSON.stringify({ version: rustEngine.version, protocol: rustEngine.protocolVersion, capabilities: [...rustEngine.capabilities].sort(), build: rustEngine.buildProfile });
}
export async function processScanWorkerTask(task: ScanWorkerTask): Promise<number[] | ScanVote[] | string> {
    if (task.type === "engine_identity") return engineIdentity(task.useRust);
    if (task.type === "preflight") {
        // A self ratio shares the real pair loader's source interval, alignment,
        // aggregation and history limits, without depending on a standalone CSV.
        const data = await loadServerBatchDataset(`${task.asset}+${task.asset}`, task.interval, undefined, { preferInMemorySyntheticPairs: true });
        const window = selectClosedCandleWindow(data, task.interval, task.cutoff, 1);
        return window?.candles.map(c => parseTimeToUnixSeconds(c.time)!).filter(Number.isFinite) ?? [];
    }
    const check = async () => {
        if (task.engineIdentity && task.engineIdentity !== "typescript_only") {
            const current = await engineIdentity(task.request.useRustEnginePreference === true);
            // Availability loss keeps the ordinary TypeScript fallback. A live
            // Rust producer must still match the frozen version/capabilities.
            if (current !== "typescript_only" && current !== task.engineIdentity) throw new Error("Engine version/capability changed during scan.");
        }
        const revisions = await Promise.all(task.sources.map(source => scanSourceRevision(source.path)));
        if (revisions.some((revision, index) => revision !== task.sources[index]!.revision)) throw new Error("Source revision changed during execution.");
    };
    await check();
    const votes: ScanVote[] = [];
    for (const pair of task.pairs) {
        try { votes.push(await executeScanPair(pair, task.engineIdentity === "typescript_only" ? { ...task.request, useRustEnginePreference: false } : task.request, task.asOf, task.cutoff)); }
        // A failed pair contributes zero to every arm; the error stays on the
        // record for coverage and failure diagnostics.
        catch (error) { votes.push({ key: pair.key, vote: 0, active: 0, engine: "typescript", profitNow: 0, profitNowConf: 0, error: error instanceof Error ? error.message : String(error) }); }
    }
    await check();
    return votes;
}
if (!isMainThread && parentPort) parentPort.on("message", (task: ScanWorkerTask) => {
    void processScanWorkerTask(task).then(
        value => parentPort!.postMessage({ value }),
        error => parentPort!.postMessage({ error: error instanceof Error ? error.message : String(error) }),
    );
});
