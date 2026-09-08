import { generatePairFeaturePack } from "../lib/pair-features/generate";

const args = process.argv.slice(2);

async function main(): Promise<void> {
    if (args.length < 3 || args.some((argument) => argument.startsWith("-"))) {
        console.error("Usage: esno scripts/pair-feature-pack.ts <folderPath> <libraryRelease> <featureId>...");
        process.exitCode = 1;
        return;
    }
    const [folderPath, libraryRelease, ...featureIds] = args;
    const startedAt = Date.now();
    let peakRss = 0;
    let peakHeapUsed = 0;
    const sampleMemory = () => {
        const memory = process.memoryUsage();
        peakRss = Math.max(peakRss, memory.rss);
        peakHeapUsed = Math.max(peakHeapUsed, memory.heapUsed);
    };
    sampleMemory();
    const memoryTimer = setInterval(sampleMemory, 100);
    try {
        const result = await generatePairFeaturePack(folderPath!, libraryRelease!, featureIds);
        sampleMemory();
        console.log(`pack: ${result.packPath}`);
        console.log(`release: ${result.releasePath} sha256=${result.releaseSha256}`);
        console.log(`ledger: sha256=${result.ledgerSha256}`);
        console.log(`sourceSnapshot: sha256=${result.sourceSnapshotSha256}`);
        console.log(`columns: computed=${result.computedColumns} reused=${result.reusedColumns}`);
        for (const family of result.families) {
            console.log(
                `family ${family.familyId}: features=${family.featureIds.join(",")} pairs=${family.pairCount}`
                + ` computed=${family.computedColumns} reused=${family.reusedColumns} compressedBytes=${family.compressedBytes}`,
            );
            for (const coverage of family.columnCoverage) {
                console.log(
                    `coverage ${coverage.featureId}: rows=${coverage.rowCount} null=${coverage.nullCount}`
                    + ` nullShare=${coverage.nullShare} observations=${coverage.observationMin}..${coverage.observationMax}`,
                );
            }
        }
        console.log(`wallMs: ${Date.now() - startedAt}`);
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    } finally {
        clearInterval(memoryTimer);
        sampleMemory();
        console.log(`peakMemory: rssBytes=${peakRss} heapUsedBytes=${peakHeapUsed}`);
    }
}

void main();
