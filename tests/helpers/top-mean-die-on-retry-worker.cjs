const { isMainThread, parentPort } = require("node:worker_threads");

// Deterministic fixture for the all-workers-die-during-queued-retry hang
// (audit worker-pool finding). Each worker silently exits with code 1 a beat
// after receiving its FIRST task, without posting any message:
//   - both shards dispatch (2 workers, 2 shards);
//   - the first worker to exit fails its in-flight shard, and the driver
//     schedules its retry while the other worker is still busy -> the retry
//     is QUEUED in pendingTasks;
//   - the second worker exits the same way -> its retry queues too;
//   - no worker is left to service either queue entry, so without the
//     drain-on-worker-loss fix the queued retry promises never settle and
//     Promise.race(activePromises) hangs forever.
if (!isMainThread && parentPort) {
    parentPort.on("message", () => {
        setTimeout(() => process.exit(1), 25);
    });
}
