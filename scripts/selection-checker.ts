import { getSelectionRule } from "../lib/selection-rules/registry";
import { loadSelectionArchive, tallySelectionRule } from "../lib/selection-rules/tally";

const [folderPath, ruleKey] = process.argv.slice(2);

if (!folderPath || !ruleKey) {
    console.error("Usage: esno scripts/selection-checker.ts <folderPath> <ruleKey>");
    process.exitCode = 1;
} else {
    try {
        const rule = getSelectionRule(ruleKey);
        if (!rule) throw new Error(`Unknown selection rule: ${ruleKey}`);
        const archive = loadSelectionArchive(folderPath);
        const tally = tallySelectionRule(archive, rule);
        for (const line of tally.reportLines) console.log(line);
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    }
}
