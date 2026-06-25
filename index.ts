import { bootstrapApp } from "./lib/app-bootstrap";
import { debugLogger } from "./lib/debug-logger";
import { state } from "./lib/state";

void bootstrapApp();

const shouldExposeDebugGlobals =
    typeof window !== "undefined"
    && (import.meta.env.DEV || import.meta.env.VITE_EXPOSE_DEBUG_GLOBALS === "1");

if (shouldExposeDebugGlobals) {
    (window as any).__state = state;
    (window as any).__debug = debugLogger;
    (window as any).__loadScanner = async () => {
        const scannerModule = await import("./lib/scanner");
        (window as any).__scannerPanel = scannerModule.scannerPanel;
        (window as any).__scannerManager = scannerModule.scannerManager;
        return {
            scannerPanel: scannerModule.scannerPanel,
            scannerManager: scannerModule.scannerManager,
        };
    };

    if (import.meta.env.VITE_EXPOSE_DEBUG_GLOBALS === "1") {
        void (window as any).__loadScanner().catch((error: unknown) => {
            console.warn("[debug-globals] Failed to expose debug globals", error);
        });
    }
}
