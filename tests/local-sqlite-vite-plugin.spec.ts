import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isTrustedLocalRequest } from "../lib/local-sqlite-vite-plugin";

describe("local sqlite vite plugin", () => {
    it("rejects requests without local origin or referer headers", () => {
        assert.equal(isTrustedLocalRequest({ headers: {} }), false);
    });

    it("allows localhost origin requests without a bearer token", () => {
        assert.equal(isTrustedLocalRequest({
            headers: { origin: "http://localhost:5173" },
        }), true);
    });

    it("allows localhost referer requests without a bearer token", () => {
        assert.equal(isTrustedLocalRequest({
            headers: { referer: "http://127.0.0.1:5173/chart" },
        }), true);
    });

    describe("mine_timing_verdicts SQL parity", () => {
        // Regression guard for the silent 500 caused by an off-by-one between
        // the schema column count and the INSERT placeholder count. The
        // original bug: 33 columns declared, 33 values passed, but only 32
        // `?` placeholders — SQLite rejected the statement, the route threw,
        // and the browser saw HTTP 500 with no in-UI indication.
        //
        // This test parses the plugin source and asserts all three counts
        // agree. It fails loudly the moment someone adds a column without
        // updating the other two sites in lockstep.
        const pluginSource = readFileSync(
            resolve(process.cwd(), "lib", "local-sqlite-vite-plugin.ts"),
            "utf8",
        );

        function extractColumnBlock(statementStart: number): { start: number; end: number; text: string } | null {
            // Find the parens that wrap the column list after a keyword like
            // `INSERT INTO mine_timing_verdicts (` or `CREATE TABLE ... (`.
            const open = pluginSource.indexOf("(", statementStart);
            if (open === -1) return null;
            let depth = 0;
            for (let i = open; i < pluginSource.length; i += 1) {
                const ch = pluginSource[i];
                if (ch === "(") depth += 1;
                else if (ch === ")") {
                    depth -= 1;
                    if (depth === 0) {
                        return { start: open + 1, end: i, text: pluginSource.slice(open + 1, i) };
                    }
                }
            }
            return null;
        }

        function parseColumnNames(blockText: string): string[] {
            // The block is the inside of `(...)`. Two shapes occur:
            //   - CREATE TABLE: one column per line, `<name> <type> ...`,
            //     optionally followed by a trailing `PRIMARY KEY(...)` clause.
            //   - INSERT: comma-separated names, possibly multiple per line.
            //
            // Strip the PRIMARY KEY clause first — its arguments are column
            // names that would otherwise pollute the count. Then split on
            // commas so an INSERT line like `run_id, run_created_at, interval`
            // yields three entries.
            const withoutPrimaryKey = blockText.replace(/PRIMARY\s+KEY\s*\([^)]*\)/gi, "");
            return withoutPrimaryKey
                .split("\n")
                .flatMap((line) => line.split(","))
                .map((entry) => entry.trim())
                .filter((entry) => entry.length > 0 && !entry.toUpperCase().startsWith("PRIMARY"))
                .map((entry) => entry.split(/\s+/)[0])
                .filter((name) => /^[a-z_]+$/i.test(name));
        }

        it("schema column count matches INSERT column count matches placeholder count", () => {
            const createMatch = pluginSource.indexOf("CREATE TABLE IF NOT EXISTS mine_timing_verdicts");
            const insertMatch = pluginSource.indexOf("INSERT INTO mine_timing_verdicts");
            assert.ok(createMatch !== -1 && insertMatch !== -1, "mine_timing_verdicts statements not found");

            const createBlock = extractColumnBlock(createMatch);
            const insertBlock = extractColumnBlock(insertMatch);
            assert.ok(createBlock && insertBlock, "could not extract column blocks");

            const schemaCols = parseColumnNames(createBlock.text);
            const insertCols = parseColumnNames(insertBlock.text);

            // Now find the matching VALUES (...) for the INSERT and count `?`.
            const valuesIdx = pluginSource.indexOf("VALUES", insertMatch);
            assert.ok(valuesIdx !== -1, "VALUES clause not found for INSERT");
            const valuesBlock = extractColumnBlock(valuesIdx);
            assert.ok(valuesBlock, "could not extract VALUES block");
            const placeholderCount = (valuesBlock.text.match(/\?/g) ?? []).length;

            assert.equal(
                schemaCols.length,
                insertCols.length,
                `schema has ${schemaCols.length} columns but INSERT lists ${insertCols.length}`,
            );
            assert.equal(
                insertCols.length,
                placeholderCount,
                `INSERT lists ${insertCols.length} columns but VALUES has ${placeholderCount} placeholders`,
            );
        });
    });
});
