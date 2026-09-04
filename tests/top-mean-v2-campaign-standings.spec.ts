import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { campaignLogSha256 } from "../scripts/top-mean-campaign-log";
import {
    TOP_MEAN_V2_STANDINGS_MAX_BYTES,
    TOP_MEAN_V2_STANDINGS_MAX_LINES,
    buildV2CampaignStandings,
    renderV2CampaignStandings,
} from "../scripts/top-mean-v2-campaign-standings";

interface Fixture {
    root: string;
    miningDir: string;
}

function fixture(lines: readonly string[]): Fixture {
    const root = mkdtempSync(path.join(tmpdir(), "top-mean-v2-standings-"));
    const miningDir = path.join(root, "archive", "top-mean-mining");
    mkdirSync(miningDir, { recursive: true });
    writeFileSync(path.join(miningDir, "idea-log.txt"), `${lines.join("\n")}\n`, "utf8");
    return { root, miningDir };
}

function removeFixture(value: Fixture): void {
    rmSync(value.root, { recursive: true, force: true });
}

function outcome(batch: string, ordinal: number, campaign = "TM-L2-C1", family = "family:base"): string {
    return `I2|${batch}|campaign=${campaign}|ordinal=${ordinal}|family=${family}|primary=0.10pp`;
}

describe("TM-L2-C1 standings state machine", () => {
    it("uses CRLF-stripped hashes and preserves the historical FORMAT6 correction", () => {
        assert.equal(campaignLogSha256("before\r\nFORMAT6\n"), campaignLogSha256("before\nFORMAT6\n"));
        const value = fixture([
            "C6|campaign=TM-L2-C1|NGStart=57|NDsurfaceStart=0",
            "X6|scope=FORMAT6-prefix|canonical=fixture",
        ]);
        try {
            const output = renderV2CampaignStandings(buildV2CampaignStandings({ miningDir: value.miningDir, tail: 1 }));
            assert.match(output, /hashConvention=crlf-stripped/);
            assert.match(output, /^TAIL\|X6\|scope=FORMAT6-prefix\|canonical=fixture$/m);
        } finally {
            removeFixture(value);
        }
    });

    it("counts each successor outcome batch and advances its next label", () => {
        const value = fixture([
            "C6|campaign=TM-L2-C1|NGStart=57|NDsurfaceStart=0",
            outcome("L2D1", 1),
            outcome("L2D2", 2),
            outcome("L2D3", 3),
        ]);
        try {
            const standing = buildV2CampaignStandings({ miningDir: value.miningDir, tail: 0 });
            assert.equal(standing.outcomeBatches, 3);
            assert.equal(standing.nextBatch, "L2D4");
            assert.equal(standing.nextOutcomeOrdinal, 4);
        } finally {
            removeFixture(value);
        }
    });

    it("ignores other campaigns while counting successor records", () => {
        const value = fixture([
            "C6|campaign=TM-L2-C1|NGStart=57|NDsurfaceStart=0",
            outcome("L2D9", 99, "TM-OTHER", "foreign:family"),
            outcome("L2D1", 1),
            "S3|L2V1|campaign=TM-OTHER|window=validation|family=foreign:family",
            "S3|L2V1|campaign=TM-L2-C1|window=validation|family=successor:family",
        ]);
        try {
            const standing = buildV2CampaignStandings({ miningDir: value.miningDir, tail: 0 });
            assert.equal(standing.outcomeBatches, 1);
            assert.equal(standing.nextBatch, "L2D2");
            assert.equal(standing.nextOutcomeOrdinal, 2);
            assert.equal(standing.validationViews, 1);
        } finally {
            removeFixture(value);
        }
    });

    it("fails on a scoped monotonicity regression", () => {
        const value = fixture([
            "C6|campaign=TM-L2-C1|NGStart=57|NDsurfaceStart=0",
            "STATE|campaign=TM-L2-C1|NG=58|NDsurface=1",
            "STATE|campaign=TM-OTHER|NG=1|NDsurface=0",
            "STATE|campaign=TM-L2-C1|NG=57|NDsurface=1",
        ]);
        try {
            assert.throws(
                () => buildV2CampaignStandings({ miningDir: value.miningDir, tail: 0 }),
                /MONOTONICITY VIOLATION\|counter=N_G/,
            );
        } finally {
            removeFixture(value);
        }
    });

    it("fails when outcome ordinals or batch labels move backward", () => {
        const value = fixture([
            "C6|campaign=TM-L2-C1|NGStart=57|NDsurfaceStart=0",
            outcome("L2D2", 2),
            outcome("L2D1", 1),
        ]);
        try {
            assert.throws(
                () => buildV2CampaignStandings({ miningDir: value.miningDir, tail: 0 }),
                /MONOTONICITY VIOLATION\|counter=(outcomeOrdinal|batchSequence)/,
            );
        } finally {
            removeFixture(value);
        }
    });

    it("enters CLOSED state only for the successor campaign", () => {
        const value = fixture([
            "C6|campaign=TM-L2-C1|NGStart=57|NDsurfaceStart=0",
            "CLOSED|campaign=TM-L1-C1|disposition=DONE-NO-PROMOTION",
            "CLOSED|campaign=TM-L2-C1|disposition=DONE-NO-PROMOTION",
        ]);
        try {
            assert.equal(buildV2CampaignStandings({ miningDir: value.miningDir, tail: 0 }).nextBatch, "CLOSED");
        } finally {
            removeFixture(value);
        }
    });

    it("rejects both line-count and byte-count digest overflow", () => {
        const manyFamilies = fixture([
            "C6|campaign=TM-L2-C1|NGStart=57|NDsurfaceStart=0",
            ...Array.from({ length: 38 }, (_, index) => outcome("L2D1", index + 1, "TM-L2-C1", `family:f${index}`)),
        ]);
        try {
            const standing = buildV2CampaignStandings({ miningDir: manyFamilies.miningDir, tail: 0 });
            assert.throws(() => renderV2CampaignStandings(standing), /DIGEST OVERFLOW/);
            assert.ok(TOP_MEAN_V2_STANDINGS_MAX_LINES <= 40);
        } finally {
            removeFixture(manyFamilies);
        }

        const hugeFamily = fixture([
            "C6|campaign=TM-L2-C1|NGStart=57|NDsurfaceStart=0",
            outcome("L2D1", 1, "TM-L2-C1", `family:${"x".repeat(TOP_MEAN_V2_STANDINGS_MAX_BYTES)}`),
        ]);
        try {
            const standing = buildV2CampaignStandings({ miningDir: hugeFamily.miningDir, tail: 0 });
            assert.throws(() => renderV2CampaignStandings(standing), /DIGEST OVERFLOW/);
        } finally {
            removeFixture(hugeFamily);
        }
    });

    it("renders the selected tail lines verbatim and declares the hash convention", () => {
        const value = fixture([
            "C6|campaign=TM-L2-C1|NGStart=57|NDsurfaceStart=0",
            "RAW|payload=preserve|opaque=one|two",
        ]);
        try {
            const output = renderV2CampaignStandings(buildV2CampaignStandings({ miningDir: value.miningDir, tail: 1 }));
            assert.match(output, /hashConvention=crlf-stripped/);
            assert.match(output, /^TAIL\|RAW\|payload=preserve\|opaque=one\|two$/m);
            assert.ok(output.split(/\r?\n/).filter(Boolean).length <= TOP_MEAN_V2_STANDINGS_MAX_LINES);
            assert.ok(Buffer.byteLength(output, "utf8") <= TOP_MEAN_V2_STANDINGS_MAX_BYTES);
        } finally {
            removeFixture(value);
        }
    });
});
