import { existsSync } from "node:fs";
import path from "node:path";
import { loadPairSelectionArchive } from "../lib/pair-selection/tally";
import { SOURCE_REQUIRED_MESSAGE } from "../lib/pair-features/generate";
import { computePairFeaturePackScales, computePairSelectionScales, formatPairSelectionScales } from "../lib/pair-selection/scales";

async function main(): Promise<void> {
    const [folderPath] = process.argv.slice(2);
    if (!folderPath) {
        console.error("Usage: esno scripts/pair-pick-scales.ts <folderPath>");
        process.exitCode = 1;
        return;
    }
    try {
        const archive = await loadPairSelectionArchive(folderPath);
        let packScales = {};
        let packNote: string | null = null;
        try {
            packScales = await computePairFeaturePackScales(folderPath);
        } catch (error) {
            const manifestExists = existsSync(path.join(folderPath, "source-snapshot", "manifest.json"));
            if (error instanceof Error && error.message === SOURCE_REQUIRED_MESSAGE && !manifestExists) {
                packNote = "pack-derived scales unavailable: no source snapshot is present; using embedded scales only.";
            } else {
                throw error;
            }
        }
        for (const line of formatPairSelectionScales(computePairSelectionScales(archive, packScales))) console.log(line);
        if (packNote) console.log(packNote);
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    }
}

void main();
