import { loadSelectionArchive } from "../lib/selection-rules/tally";
import { computeSelectionScales, formatSelectionScales } from "../lib/selection-rules/scales";

const [folderPath] = process.argv.slice(2);

if (!folderPath) {
    console.error("Usage: esno scripts/selection-scales.ts <folderPath>");
    process.exitCode = 1;
} else {
    try {
        const archive = loadSelectionArchive(folderPath);
        for (const block of computeSelectionScales(archive)) {
            for (const line of formatSelectionScales(block)) console.log(line);
        }
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    }
}
