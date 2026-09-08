// Node's worker entrypoint does not apply the parent esno/tsx preload to its
// first module. Load tsx before importing the typed worker implementation.
import { register } from "tsx/esm/api";
register();
await import("./pair-feature-generation-worker.ts");
