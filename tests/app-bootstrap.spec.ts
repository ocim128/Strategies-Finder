import { expect } from "chai";
import { describe, it } from "node:test";
import {
    resolveBootstrapFeatureStageOrder,
    type AppBootstrapFeature,
} from "../lib/bootstrap-feature-registry";

describe("App bootstrap registry", () => {
    it("keeps stable dependency order within a stage", () => {
        const features: AppBootstrapFeature[] = [
            { id: "layout", stage: "pre_restore" },
            { id: "charts", stage: "pre_restore", dependsOn: ["layout"] },
            { id: "handlers", stage: "pre_restore", dependsOn: ["charts"] },
            { id: "settings", stage: "post_restore", dependsOn: ["handlers"] },
            { id: "load-data", stage: "post_restore", dependsOn: ["settings"] },
        ];

        expect(resolveBootstrapFeatureStageOrder(features, "pre_restore").map((feature) => feature.id))
            .to.deep.equal(["layout", "charts", "handlers"]);
        expect(resolveBootstrapFeatureStageOrder(features, "post_restore").map((feature) => feature.id))
            .to.deep.equal(["settings", "load-data"]);
    });

    it("rejects missing dependencies", () => {
        const features: AppBootstrapFeature[] = [
            { id: "layout", stage: "pre_restore" },
            { id: "finder", stage: "pre_restore", dependsOn: ["missing"] },
        ];

        expect(() => resolveBootstrapFeatureStageOrder(features, "pre_restore"))
            .to.throw('depends on missing feature "missing"');
    });

    it("rejects dependencies on later stages", () => {
        const features: AppBootstrapFeature[] = [
            { id: "settings", stage: "post_restore" },
            { id: "layout", stage: "pre_restore", dependsOn: ["settings"] },
        ];

        expect(() => resolveBootstrapFeatureStageOrder(features, "pre_restore"))
            .to.throw('depends on later-stage feature "settings"');
    });
});
