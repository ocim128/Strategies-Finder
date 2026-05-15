import { bootstrapApp } from "./lib/app-bootstrap";

void bootstrapApp();

const shouldExposeDebugGlobals =
    typeof window !== "undefined"
    && (import.meta.env.DEV || import.meta.env.VITE_EXPOSE_DEBUG_GLOBALS === "1");

if (shouldExposeDebugGlobals) {
    void Promise.all([
        import("./lib/state"),
        import("./lib/debug-logger"),
        import("./lib/command-palette"),
        import("./lib/scanner"),
    ]).then(([stateModule, debugModule, commandPaletteModule, scannerModule]) => {
        (window as any).__state = stateModule.state;
        (window as any).__debug = debugModule.debugLogger;
        (window as any).__commandPalette = commandPaletteModule.commandPaletteManager;
        (window as any).__scannerPanel = scannerModule.scannerPanel;
        (window as any).__scannerManager = scannerModule.scannerManager;
    }).catch((error: unknown) => {
        console.warn("[debug-globals] Failed to expose debug globals", error);
    });
}
