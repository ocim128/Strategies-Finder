import { createHash } from "node:crypto";
import { expect } from "chai";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadLedgerForReplay } from "../lib/batch-backtest/trade-ledger-replay-loader";
import {
    evaluateTradeLedgerRuleWithReport,
    prepareTradeLedgerReplay,
    type LedgerRule,
} from "../lib/batch-backtest/trade-ledger-replay-core";
import { runChecker } from "../scripts/trade-ledger-checker";

const ROOT = process.cwd();
const FOLDER = path.join(ROOT, "tests", "fixtures", "trade-ledger-parity");
const FOLDER_LABEL = "tests/fixtures/trade-ledger-parity";
const RULE_FILE = path.join(FOLDER, "golden-rule.ts");
const EXPECTED_FILE = path.join(FOLDER, "expected-report.txt");
const EXPECTED_SHA256 = "d0976087a804e515d42c6618d63648efbec9c9e6c43f2cbe3ca8041b68fa8736";

describe("trade-ledger independent golden parity", () => {
    it("matches the committed checker output in both sweep engine modes", async () => {
        const expected = await readFile(EXPECTED_FILE, "utf8");
        expect(createHash("sha256").update(expected).digest("hex")).to.equal(EXPECTED_SHA256);
        const expectedReport = expected.endsWith("\n") ? expected.slice(0, -1) : expected;
        const loadedRule = await import(`${pathToFileURL(RULE_FILE).href}?golden-parity`);
        const rule = loadedRule.default as LedgerRule;
        const reports: string[] = [];
        for (const mode of ["load_once", "isolated_per_rule"] as const) {
            const loaded = await loadLedgerForReplay(FOLDER);
            const prepared = mode === "load_once"
                ? prepareTradeLedgerReplay({ rows: loaded.rows, joinedRankCount: loaded.joinedRankCount, replayParams: loaded.replayParams })
                : undefined;
            const result = evaluateTradeLedgerRuleWithReport({
                folder: FOLDER_LABEL,
                ruleName: "golden-rule.ts",
                rows: loaded.rows,
                joinedRankCount: loaded.joinedRankCount,
                rule,
                replay: loaded.replayParams,
                ...(prepared ? { prepared } : {}),
            });
            reports.push(result.reportLines.join("\n"));
        }
        expect(reports[0]).to.equal(expectedReport);
        expect(reports[1]).to.equal(expectedReport);
        expect(reports[0]).to.equal(reports[1]);
        expect(await runChecker(FOLDER_LABEL, RULE_FILE)).to.equal(expectedReport);
    });
});
