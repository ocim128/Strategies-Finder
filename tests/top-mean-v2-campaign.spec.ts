import assert from "node:assert/strict";
import { describe, it } from "node:test";
import path from "node:path";
import { auditTmL2C1 } from "../scripts/top-mean-v2-campaign-audit";
import {
    TOP_MEAN_V2_STANDINGS_MAX_BYTES,
    TOP_MEAN_V2_STANDINGS_MAX_LINES,
    buildV2CampaignStandings,
    renderV2CampaignStandings,
} from "../scripts/top-mean-v2-campaign-standings";

const miningDir = path.join(process.cwd(), "archive", "top-mean-mining");

describe("TM-L2-C1 governance scaffolding", () => {
    it("passes the registered campaign audit", () => {
        const result = auditTmL2C1({ miningDir });
        assert.equal(result.passed, true, result.checks.filter((check) => !check.passed).map((check) => `${check.name}: ${check.detail}`).join("\n"));
    });

    it("starts successor standings at L2D ordinal 1 with bounded output", () => {
        const standing = buildV2CampaignStandings({ miningDir });
        assert.equal(standing.nextBatch, "L2D1");
        assert.equal(standing.nextOutcomeOrdinal, 1);
        assert.equal(standing.outcomeBatches, 0);
        assert.equal(standing.discoverySurface, 0);
        assert.equal(standing.lifetimeEvaluations, 57);
        const output = renderV2CampaignStandings(standing);
        assert.match(output, /STATE\|nextBatch=L2D1\|.*NDsurface=0\|NG=57\|L1V=0\/6/);
        assert.ok(output.split(/\r?\n/).filter(Boolean).length <= TOP_MEAN_V2_STANDINGS_MAX_LINES);
        assert.ok(Buffer.byteLength(output, "utf8") <= TOP_MEAN_V2_STANDINGS_MAX_BYTES);
        assert.match(output, /END\|lines=\d+\|bytes=\d+/);
    });
});
