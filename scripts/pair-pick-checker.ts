import { loadPairSelectionArchive, tallyPairSelectionRule } from "../lib/pair-selection/tally";
import { getPairSelectionRule } from "../lib/pair-selection/registry";

function parseDateSec(raw: string, endOfDay = false): number {
    const ms = Date.parse(endOfDay ? `${raw}T23:59:59Z` : `${raw}T00:00:00Z`);
    if (!Number.isFinite(ms)) throw new Error(`Invalid date: ${raw}`);
    return Math.floor(ms / 1000);
}

async function main(): Promise<void> {
    const args = process.argv.slice(2);
    const positional: string[] = [];
    let fromSec: number | null = null;
    let toSec: number | null = null;
    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index]!;
        if (arg === "--from") fromSec = parseDateSec(args[++index]!);
        else if (arg === "--to") toSec = parseDateSec(args[++index]!, true);
        else positional.push(arg);
    }
    const [folderPath, ruleKey, horizonRaw] = positional;
    if (!folderPath || !ruleKey) {
        console.error("Usage: esno scripts/pair-pick-checker.ts <folderPath> <ruleKey> [horizonBars] [--from YYYY-MM-DD] [--to YYYY-MM-DD]");
        process.exitCode = 1;
        return;
    }
    try {
        const rule = getPairSelectionRule(ruleKey);
        if (!rule) throw new Error(`Unknown pair-selection rule: ${ruleKey}`);
        let archive = await loadPairSelectionArchive(folderPath);
        if (fromSec !== null || toSec !== null) {
            const events = archive.events.filter((event) =>
                (fromSec === null || event.context.signalTime >= fromSec)
                && (toSec === null || event.context.signalTime <= toSec));
            if (events.length === 0) throw new Error("Date range matched no pick-events.");
            archive = { ...archive, events };
        }
        const tally = horizonRaw === undefined
            ? tallyPairSelectionRule(archive, rule)
            : (() => {
                const horizonBars = Number(horizonRaw);
                if (!Number.isInteger(horizonBars) || horizonBars <= 0) throw new Error(`Invalid horizonBars: ${horizonRaw}`);
                return tallyPairSelectionRule(archive, rule, undefined, horizonBars);
            })();
        for (const line of tally.reportLines) console.log(line);
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    }
}

void main();
