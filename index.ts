import { bootstrapApp } from "./lib/app-bootstrap";
import { state } from "./lib/state";
import { debugLogger } from "./lib/debug-logger";
import { commandPaletteManager } from "./lib/command-palette";
import { scannerPanel, scannerManager } from "./lib/scanner";

void bootstrapApp();

if (typeof window !== "undefined") {
    (window as any).__state = state;
    (window as any).__debug = debugLogger;
    (window as any).__commandPalette = commandPaletteManager;
    (window as any).__scannerPanel = scannerPanel;
    (window as any).__scannerManager = scannerManager;
}
