import { parentPort } from "node:worker_threads";
import {
    generatePairFeatureColumnsForWorker,
} from "../lib/pair-features/generate";
import type { PairFeatureColumnPairManifest, PairFeatureSnapshotPairManifest } from "../lib/pair-features/types";

if (!parentPort) throw new Error("Pair feature generation worker requires parentPort.");

interface PairFeatureWorkerTask {
    taskId: string;
    folder: string;
    libraryRelease: string;
    pair: PairFeatureSnapshotPairManifest;
    featureIds: readonly string[];
}

parentPort.on("message", async (task: PairFeatureWorkerTask) => {
    try {
        const generated = await generatePairFeatureColumnsForWorker(
            task.folder,
            task.libraryRelease,
            task.pair,
            task.featureIds,
        );
        parentPort!.postMessage({
            type: "done",
            taskId: task.taskId,
            generated,
        } satisfies { type: "done"; taskId: string; generated: readonly [string, PairFeatureColumnPairManifest][] });
    } catch (error) {
        parentPort!.postMessage({
            type: "error",
            taskId: task.taskId,
            error: error instanceof Error ? error.message : String(error),
        });
    }
});

parentPort.postMessage({ type: "ready" });
