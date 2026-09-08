import { loadPairSelectionArchive } from "../lib/pair-selection/tally";
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
        const packScales = await computePairFeaturePackScales(folderPath);
        for (const line of formatPairSelectionScales(computePairSelectionScales(archive, packScales))) console.log(line);
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    }
}

void main();
