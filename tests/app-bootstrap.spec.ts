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
