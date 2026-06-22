import { expect } from "chai";
import { describe, it } from "node:test";
import {
    runBootstrapFeatureStage,
    type AppBootstrapFeature,
} from "../lib/bootstrap-feature-registry";
import { debugLogger } from "../lib/debug-logger";

describe("App bootstrap registry", () => {
    it("executes features in array order within a stage", async () => {
        const order: string[] = [];
        const features: AppBootstrapFeature[] = [
            { id: "layout", stage: "pre_restore", init: () => { order.push("layout"); } },
            { id: "charts", stage: "pre_restore", dependsOn: ["layout"], init: () => { order.push("charts"); } },
            { id: "handlers", stage: "pre_restore", dependsOn: ["charts"], init: () => { order.push("handlers"); } },
            { id: "settings", stage: "post_restore", dependsOn: ["handlers"], init: () => { order.push("settings"); } },
            { id: "load-data", stage: "post_restore", dependsOn: ["settings"], init: () => { order.push("load-data"); } },
        ];

        await runBootstrapFeatureStage(features, "pre_restore", "init", {});
        await runBootstrapFeatureStage(features, "post_restore", "init", {});

        expect(order).to.deep.equal(["layout", "charts", "handlers", "settings", "load-data"]);
    });

    it("throws when a same-stage dependency appears later in the array", async () => {
        // WHY: startup order is a product contract here — layout injection,
        // saved-settings restore, event handlers, and lazy feature triggers
        // all rely on declared dependencies initializing first. A same-stage
        // misordering must fail loudly rather than surface as random UI bugs.
        const features: AppBootstrapFeature[] = [
            { id: "handlers", stage: "pre_restore", dependsOn: ["charts"], init: () => {} },
            { id: "charts", stage: "pre_restore", dependsOn: ["layout"], init: () => {} },
            { id: "layout", stage: "pre_restore", init: () => {} },
        ];

        let caught: unknown;
        try {
            await runBootstrapFeatureStage(features, "pre_restore", "init", {});
            caught = null;
        } catch (error) {
            caught = error;
        }

        expect(caught).to.be.instanceOf(Error);
        expect((caught as Error).message).to.contain("Bootstrap ordering violation");
        expect((caught as Error).message).to.contain('"handlers"');
        expect((caught as Error).message).to.contain('"charts"');
    });

    it("allows cross-stage dependencies without ordering violations", async () => {
        // WHY: pre_restore runs before post_restore, so a post_restore feature
        // may legitimately depend on a pre_restore feature. That must not trip
        // the within-stage ordering check.
        const ran: string[] = [];
        const features: AppBootstrapFeature[] = [
            { id: "layout", stage: "pre_restore", init: () => { ran.push("layout"); } },
            { id: "settings", stage: "post_restore", dependsOn: ["layout"], init: () => { ran.push("settings"); } },
        ];

        await runBootstrapFeatureStage(features, "pre_restore", "init", {});
        await runBootstrapFeatureStage(features, "post_restore", "init", {});

        expect(ran).to.deep.equal(["layout", "settings"]);
    });

    it("ignores dependsOn entries that resolve to no known feature", async () => {
        // WHY: a feature may declare an external or future dependency that is
        // intentionally absent in this run. We only enforce ordering when both
        // sides are present in the same stage.
        const ran: string[] = [];
        const features: AppBootstrapFeature[] = [
            { id: "a", stage: "pre_restore", dependsOn: ["external"], init: () => { ran.push("a"); } },
        ];

        await runBootstrapFeatureStage(features, "pre_restore", "init", {});
        expect(ran).to.deep.equal(["a"]);
    });

    it("skips features whose handler is undefined", async () => {
        const order: string[] = [];
        const features: AppBootstrapFeature[] = [
            { id: "a", stage: "pre_restore", init: () => { order.push("a"); } },
            { id: "b", stage: "pre_restore" /* no init */ },
            { id: "c", stage: "pre_restore", init: () => { order.push("c"); } },
        ];

        await runBootstrapFeatureStage(features, "pre_restore", "init", {});
        expect(order).to.deep.equal(["a", "c"]);
    });

    it("does not let bootstrap telemetry listener failures break feature init", async () => {
        let initialized = false;
        const unsubscribe = debugLogger.subscribe(() => {
            throw new Error("debug listener failed");
        });

        try {
            await runBootstrapFeatureStage([{
                id: "safe-feature",
                stage: "pre_restore",
                init: () => {
                    initialized = true;
                },
            }], "pre_restore", "init", {});
        } finally {
            unsubscribe();
        }

        expect(initialized).to.equal(true);
    });

    it("propagates init errors after logging them", async () => {
        const logged: string[] = [];
        const unsubscribe = debugLogger.subscribe((entries) => {
            const latest = entries.at(-1);
            if (latest?.message === "app.bootstrap.feature_failed") {
                logged.push((latest.data as { id: string }).id);
            }
        });

        try {
            await runBootstrapFeatureStage([{
                id: "failing-feature",
                stage: "pre_restore",
                init: () => { throw new Error("boom"); },
            }], "pre_restore", "init", {});
            expect.fail("should have thrown");
        } catch (error) {
            expect((error as Error).message).to.equal("boom");
        } finally {
            unsubscribe();
        }

        expect(logged).to.deep.equal(["failing-feature"]);
    });
});
