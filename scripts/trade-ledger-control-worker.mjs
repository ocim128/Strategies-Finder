// Node's worker entrypoint does not apply the parent tsx preload to its first
// module. Load tsx from this JavaScript wrapper before importing the typed
// implementation.
import { register } from "tsx/esm/api";
register();
await import("./trade-ledger-control-worker.ts");
