import { expect } from "chai";
import { afterEach, describe, it } from "node:test";
import {
    getActiveWorkloads,
    releaseIfOwner,
    resetForTests,
    tryAcquire,
} from "../lib/server-research-job-coordinator";

describe("server research job coordinator", () => {
    afterEach(() => resetForTests());

    it("allows Batch and Finder to coexist while rejecting Sweep conflicts", () => {
        const batch = tryAcquire("batch", "batch-1");
        const finder = tryAcquire("finder", "finder-1");
        expect(batch).to.not.equal(null);
        expect(finder).to.not.equal(null);
        expect(tryAcquire("ledger_sweep", "sweep-1")).to.equal(null);
        expect(getActiveWorkloads().map((workload) => workload.kind)).to.deep.equal(["batch", "finder"]);
    });

    it("blocks Batch and Finder while a Sweep owns the interlock", () => {
        const sweep = tryAcquire("ledger_sweep", "sweep-1");
        expect(sweep).to.not.equal(null);
        expect(tryAcquire("batch", "batch-1")).to.equal(null);
        expect(tryAcquire("finder", "finder-1")).to.equal(null);
        expect(tryAcquire("ledger_sweep", "sweep-2")).to.equal(null);
    });

    it("releases only the exact generation token", () => {
        const first = tryAcquire("ledger_sweep", "sweep-1");
        expect(first).to.not.equal(null);
        releaseIfOwner({ ...first!, tokenId: first!.tokenId });
        expect(getActiveWorkloads()).to.have.length(1);
        releaseIfOwner(first!);
        expect(getActiveWorkloads()).to.deep.equal([]);
        const second = tryAcquire("ledger_sweep", "sweep-2");
        expect(second?.tokenId).to.equal("research-2");
        releaseIfOwner(first!);
        expect(getActiveWorkloads()).to.have.length(1);
    });
});
