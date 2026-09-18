const { isMainThread, parentPort } = require("node:worker_threads");

// Deterministic fixture for the exit-code-0 hang finding (worker pool audit).
// Each worker exits CLEANLY (code 0) a beat after receiving its FIRST task,
// without posting any message. The old onExit only rejected in-flight tasks
// for NON-ZERO exit codes, so the in-flight shard promise never settled and
// Promise.race(activePromises) hung forever — even while other workers were
// still alive, and even when the drained queued-retry path had nothing left
// to fail.
if (!isMainThread && parentPort) {
    parentPort.on("message", () => {
        setTimeout(() => process.exit(0), 25);
    });
}
