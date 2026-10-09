import { Worker } from "node:worker_threads";

/** One persistent worker, one current task, and one termination owner. */
export function createFinderTaskWorker<TTask, TMessage>(
    workerPath: string,
    errorLabel: string,
    onMessage: (message: TMessage, task: TTask | null, takeTask: () => TTask | null) => void,
    onFatal: (task: TTask, error: string) => void,
) {
    const worker = new Worker(workerPath, {});
    let currentTask: TTask | null = null;
    let disposed = false;
    let stopping = false;
    let termination: Promise<number> | null = null;
    const terminateWorker = () => termination ??= worker.terminate();
    const takeCurrentTask = (): TTask | null => {
        const task = currentTask;
        currentTask = null;
        return task;
    };

    worker.on("message", (message: TMessage) => onMessage(message, currentTask, takeCurrentTask));
    worker.on("error", (error: Error) => {
        const task = takeCurrentTask();
        if (task) onFatal(task, `${errorLabel} crashed: ${error.message}`);
    });
    worker.on("exit", (code) => {
        const task = takeCurrentTask();
        // A clean exit during a task is also fatal; otherwise the sweep hangs.
        if (task) onFatal(task, code !== 0
            ? `${errorLabel} exited with code ${code}`
            : `${errorLabel} exited unexpectedly mid-task`);
    });

    return {
        runTask: (task: TTask): void => {
            if (disposed || stopping) {
                onFatal(task, `${errorLabel} was stopped before task start`);
                return;
            }
            currentTask = task;
            worker.postMessage({ type: "run_task", task });
        },
        stop: (): void => {
            if (disposed || stopping) return;
            stopping = true;
            // Termination interrupts synchronous simulations that cannot read Stop.
            void terminateWorker();
        },
        dispose: async (): Promise<void> => {
            if (disposed) return;
            disposed = true;
            stopping = true;
            await terminateWorker();
        },
    };
}
